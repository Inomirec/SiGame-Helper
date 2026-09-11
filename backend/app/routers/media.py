"""Отдача медиафайлов браузеру с поддержкой перемотки (HTTP Range).

Без корректных ответов 206 Partial Content HTML5-плеер не умеет
перематывать длинные файлы — он просто блокирует ползунок. Поэтому
диапазоны обрабатываются вручную, а не через FileResponse.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import re
from pathlib import Path
from typing import AsyncIterator
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from .. import paths
from ..core import fsutil, images
from ..core.probe import probe
from ..models import ImagePreviewRequest

router = APIRouter(prefix="/api/media", tags=["media"])

#: Размер блока при потоковой отдаче.
CHUNK = 512 * 1024
_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


def _disposition(name: str) -> str:
    """Заголовок Content-Disposition, безопасный для нелатинских имён.

    HTTP-заголовки кодируются в latin-1, поэтому «сжатый.avif» в обычном
    ``filename=`` роняет ответ целиком. Правильный способ — ASCII-заглушка
    плюс ``filename*`` в кодировке UTF-8 по RFC 5987.
    """
    ascii_name = name.encode("ascii", "replace").decode("ascii").replace('"', "'")
    return f"inline; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"


async def _iter_file(path: Path, start: int, end: int) -> AsyncIterator[bytes]:
    """Читает файл кусками от start до end включительно."""
    remaining = end - start + 1
    with path.open("rb") as handle:
        handle.seek(start)
        while remaining > 0:
            chunk = handle.read(min(CHUNK, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


def _parse_range(header: str, size: int) -> tuple[int, int] | None:
    match = _RANGE_RE.fullmatch(header.strip())
    if not match:
        return None
    raw_start, raw_end = match.groups()

    if raw_start:
        start = int(raw_start)
        end = int(raw_end) if raw_end else size - 1
    elif raw_end:
        # Форма «bytes=-500»: последние 500 байт.
        length = int(raw_end)
        if length <= 0:
            return None
        start = max(size - length, 0)
        end = size - 1
    else:
        return None

    if start >= size or start > end:
        return None
    return start, min(end, size - 1)


@router.get("/raw")
async def raw(path: str, request: Request) -> Response:
    """Стримит файл целиком или запрошенным диапазоном."""
    try:
        target = fsutil.safe_path(path)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(404, str(exc)) from exc
    if not target.is_file():
        raise HTTPException(404, "Это не файл")

    size = target.stat().st_size
    media_type = fsutil.mime_for(target)
    common = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
        "Content-Disposition": _disposition(target.name),
    }

    range_header = request.headers.get("range")
    if range_header:
        parsed = _parse_range(range_header, size)
        if parsed is None:
            return Response(
                status_code=416,
                headers={"Content-Range": f"bytes */{size}", **common},
            )
        start, end = parsed
        return StreamingResponse(
            _iter_file(target, start, end),
            status_code=206,
            media_type=media_type,
            headers={
                "Content-Range": f"bytes {start}-{end}/{size}",
                "Content-Length": str(end - start + 1),
                **common,
            },
        )

    return StreamingResponse(
        _iter_file(target, 0, size - 1) if size else iter(()),
        media_type=media_type,
        headers={"Content-Length": str(size), **common},
    )


@router.head("/raw")
async def raw_head(path: str) -> Response:
    """Плееры часто сначала спрашивают размер файла отдельным HEAD-запросом."""
    try:
        target = fsutil.safe_path(path)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(404, str(exc)) from exc
    size = target.stat().st_size
    return Response(
        status_code=200,
        media_type=fsutil.mime_for(target),
        headers={"Accept-Ranges": "bytes", "Content-Length": str(size)},
    )


#: Пока идёт один просчёт превью, следующий ждёт. Человек может дёргать
#: ползунок быстрее, чем кодировщик успевает, и без очереди мы просто
#: положим машину десятком параллельных ffmpeg.
_preview_lock = asyncio.Lock()

#: Сколько готовых превью держим на диске.
_PREVIEW_KEEP = 60


def _preview_dir() -> Path:
    directory = paths.data_dir() / "preview"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _prune_previews(directory: Path) -> None:
    files = sorted(directory.iterdir(), key=lambda item: item.stat().st_mtime, reverse=True)
    for stale in files[_PREVIEW_KEEP:]:
        with contextlib.suppress(OSError):
            stale.unlink()


@router.post("/image-preview")
async def image_preview(request: ImagePreviewRequest) -> dict[str, object]:
    """Сжимает картинку теми же настройками, что и экспорт, и отдаёт результат.

    Это не оценка, а настоящий файл: и вид, и вес человек видит честными.
    Одинаковые настройки считаются один раз — возят ползунок туда-сюда часто.
    """
    try:
        source = fsutil.safe_path(request.source)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(404, str(exc)) from exc
    if not source.is_file():
        raise HTTPException(404, "Это не файл")

    options = request.image
    stamp = f"{source}|{source.stat().st_mtime_ns}|{options.model_dump_json()}"
    key = hashlib.sha1(stamp.encode("utf-8")).hexdigest()[:20]
    output = _preview_dir() / f"{key}{images.EXTENSIONS[options.format]}"

    if not output.exists():
        async with _preview_lock:
            # Пока ждали очереди, соседний запрос мог всё посчитать за нас.
            if not output.exists():
                try:
                    await images.compress(source, output, options)
                except Exception as exc:  # кодировщик падает на битых файлах
                    raise HTTPException(500, f"Не удалось собрать превью: {exc}") from exc
                _prune_previews(output.parent)

    info = await probe(output)
    stream = info.video if info else None
    return {
        # Превью лежит в служебной папке, а отдача файлов пускает только
        # рабочие — поэтому у него своя ссылка, а не общий /raw.
        "url": f"/api/media/preview/{output.name}",
        "size": output.stat().st_size,
        "width": stream.width if stream else 0,
        "height": stream.height if stream else 0,
    }


#: Имя превью мы задаём сами — на вход принимаем только такое, иначе через
#: «..» можно было бы вычитать что угодно с диска.
_PREVIEW_NAME = re.compile(r"[0-9a-f]{20}\.(avif|webp|jpg|png)")


@router.get("/preview/{name}")
async def preview_file(name: str) -> Response:
    """Отдаёт просчитанное превью. Только из своей папки и только по имени."""
    if not _PREVIEW_NAME.fullmatch(name):
        raise HTTPException(404, "Нет такого превью")
    target = _preview_dir() / name
    if not target.is_file():
        raise HTTPException(404, "Превью уже удалено")
    return Response(
        content=target.read_bytes(),
        media_type=fsutil.mime_for(target),
        headers={"Cache-Control": "no-cache"},
    )

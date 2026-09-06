"""Отдача медиафайлов браузеру с поддержкой перемотки (HTTP Range).

Без корректных ответов 206 Partial Content HTML5-плеер не умеет
перематывать длинные файлы — он просто блокирует ползунок. Поэтому
диапазоны обрабатываются вручную, а не через FileResponse.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import AsyncIterator
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from ..core import fsutil

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

"""Генерация и кэширование миниатюр для медиатеки."""

from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path

from ..paths import thumbs_dir
from . import binaries, fsutil

#: Ширина миниатюры в пикселях.
THUMB_WIDTH = 320

#: Один замок на файл, чтобы параллельные запросы не гоняли ffmpeg дважды.
_locks: dict[str, asyncio.Lock] = {}


def cache_path(source: Path) -> Path:
    """Имя файла в кэше зависит от пути, времени изменения и размера."""
    try:
        stat = source.stat()
        signature = f"{source}|{stat.st_mtime_ns}|{stat.st_size}"
    except OSError:
        signature = str(source)
    digest = hashlib.sha1(signature.encode("utf-8")).hexdigest()
    return thumbs_dir() / f"{digest}.jpg"


async def get_or_create(source: Path) -> Path | None:
    """Возвращает путь к миниатюре, создавая её при необходимости."""
    kind = fsutil.media_kind(source)
    if kind not in {"video", "image"}:
        return None

    target = cache_path(source)
    if target.exists() and target.stat().st_size > 0:
        return target

    lock = _locks.setdefault(str(target), asyncio.Lock())
    async with lock:
        if target.exists() and target.stat().st_size > 0:
            return target
        target.parent.mkdir(parents=True, exist_ok=True)

        args = [binaries.ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "error", "-y"]
        if kind == "video":
            # Кадр на 10% длительности: заставки и чёрные первые кадры не мешают.
            args += ["-ss", "3", "-i", str(source)]
        else:
            args += ["-i", str(source)]
        args += [
            "-frames:v", "1",
            "-vf", f"scale={THUMB_WIDTH}:-2:flags=bilinear",
            "-q:v", "5",
            str(target),
        ]

        process = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            creationflags=binaries.CREATE_NO_WINDOW,
            env=binaries.subprocess_env(),
        )
        await process.communicate()

        if process.returncode != 0 or not target.exists():
            if kind == "video":
                # Ролик короче трёх секунд — берём самый первый кадр.
                retry = [
                    binaries.ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "error",
                    "-y", "-i", str(source), "-frames:v", "1",
                    "-vf", f"scale={THUMB_WIDTH}:-2:flags=bilinear",
                    "-q:v", "5", str(target),
                ]
                process = await asyncio.create_subprocess_exec(
                    *retry,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                    creationflags=binaries.CREATE_NO_WINDOW,
                    env=binaries.subprocess_env(),
                )
                await process.communicate()
            if not target.exists():
                return None
        return target


def clear_cache() -> int:
    """Чистит кэш миниатюр, возвращает число удалённых файлов."""
    removed = 0
    for file in thumbs_dir().glob("*.jpg"):
        try:
            file.unlink()
            removed += 1
        except OSError:
            continue
    return removed

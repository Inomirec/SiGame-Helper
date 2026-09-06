"""Лента кадров для таймлайна — как дорожка видео в монтажных программах.

Кадры собираются в одну «простыню» (спрайт): ffmpeg вытаскивает нужное
количество кадров и клеит их в ряд одной картинкой. Так браузер грузит один
файл вместо сорока запросов, а фронтенд показывает нужный кадр, сдвигая фон.
"""

from __future__ import annotations

import asyncio
import hashlib
from dataclasses import dataclass
from pathlib import Path

from ..paths import data_dir
from . import binaries
from .probe import probe

#: Высота одного кадра в спрайте. Ширина считается по пропорциям исходника.
TILE_HEIGHT = 72

#: Сколько кадров вытаскивать. Больше — подробнее лента, но дольше и тяжелее.
DEFAULT_FRAMES = 32
MAX_FRAMES = 80

_locks: dict[str, asyncio.Lock] = {}


@dataclass(slots=True)
class Filmstrip:
    path: Path
    frames: int
    tile_width: int
    tile_height: int


def cache_dir() -> Path:
    return data_dir() / "filmstrips"


def _cache_path(source: Path, frames: int) -> Path:
    try:
        stat = source.stat()
        signature = f"{source}|{stat.st_mtime_ns}|{stat.st_size}|{frames}|{TILE_HEIGHT}"
    except OSError:
        signature = f"{source}|{frames}"
    return cache_dir() / f"{hashlib.sha1(signature.encode('utf-8')).hexdigest()}.jpg"


def _meta_path(sprite: Path) -> Path:
    return sprite.with_suffix(".txt")


async def build(source: Path, frames: int = DEFAULT_FRAMES) -> Filmstrip | None:
    """Готовит (или достаёт из кэша) ленту кадров для видеофайла."""
    frames = max(4, min(frames, MAX_FRAMES))
    sprite = _cache_path(source, frames)
    meta = _meta_path(sprite)

    if sprite.exists() and meta.exists():
        stored = _read_meta(meta)
        if stored:
            return Filmstrip(sprite, *stored)

    lock = _locks.setdefault(str(sprite), asyncio.Lock())
    async with lock:
        if sprite.exists() and meta.exists():
            stored = _read_meta(meta)
            if stored:
                return Filmstrip(sprite, *stored)

        info = await probe(source)
        video = info.video
        if not video or not video.width or not video.height or not info.duration:
            return None

        aspect = video.width / video.height
        tile_width = max(2, int(round(TILE_HEIGHT * aspect / 2)) * 2)

        # Раскладываем кадры равномерно по всей длительности.
        rate = frames / info.duration
        sprite.parent.mkdir(parents=True, exist_ok=True)

        args = [
            binaries.ffmpeg(),
            "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
            "-i", str(source),
            "-an", "-sn",
            "-vf",
            f"fps={rate:.6f},scale={tile_width}:{TILE_HEIGHT}:flags=fast_bilinear,"
            f"tile={frames}x1:padding=0:margin=0",
            "-frames:v", "1",
            "-q:v", "4",
            str(sprite),
        ]

        process = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            creationflags=binaries.CREATE_NO_WINDOW,
            env=binaries.subprocess_env(),
        )
        _, err = await process.communicate()

        if process.returncode != 0 or not sprite.exists():
            # Очень короткие ролики не набирают нужное число кадров для tile —
            # пробуем ещё раз с тем количеством, которое реально помещается.
            message = err.decode("utf-8", "replace")[:200]
            if frames > 8:
                return await build(source, frames // 2)
            raise RuntimeError(message or "ffmpeg не смог собрать ленту кадров")

        meta.write_text(f"{frames} {tile_width} {TILE_HEIGHT}", encoding="utf-8")
        return Filmstrip(sprite, frames, tile_width, TILE_HEIGHT)


def _read_meta(meta: Path) -> tuple[int, int, int] | None:
    try:
        parts = meta.read_text("utf-8").split()
        return int(parts[0]), int(parts[1]), int(parts[2])
    except (OSError, ValueError, IndexError):
        return None


def clear_cache() -> int:
    removed = 0
    for file in list(cache_dir().glob("*.jpg")) + list(cache_dir().glob("*.txt")):
        try:
            file.unlink()
            removed += 1
        except OSError:
            continue
    return removed

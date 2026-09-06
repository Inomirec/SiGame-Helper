"""Сжатие изображений через ffmpeg с подбором качества под целевой вес.

Логика подбора: у каждого формата есть «ручка качества» со своим направлением
(у AVIF меньше CRF = лучше, у WebP больше quality = лучше). Мы приводим её к
единой шкале 0..100 «чем больше, тем лучше», делаем двоичный поиск за N проходов
и оставляем самый качественный вариант, который влез в лимит.
"""

from __future__ import annotations

import asyncio
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

from ..models import ImageOptions
from . import binaries
from .probe import MediaInfo, probe

ProgressCb = Callable[[float, str], Awaitable[None] | None]

#: Диапазоны «ручки качества» в родных единицах кодера.
_AVIF_CRF = (20, 63)      # меньше = лучше
_JPEG_QSCALE = (2, 31)    # меньше = лучше
_WEBP_QUALITY = (10, 100)  # больше = лучше

EXTENSIONS = {"avif": ".avif", "webp": ".webp", "jpg": ".jpg", "png": ".png"}


@dataclass(slots=True)
class ImageResult:
    output: Path
    size: int
    width: int
    height: int
    quality_used: int
    attempts: int
    within_target: bool


def _target_dimensions(
    width: int, height: int, max_dimension: int
) -> tuple[int, int] | None:
    """Новые размеры при ограничении длинной стороны. None = ресайз не нужен."""
    if max_dimension <= 0:
        return None
    longest = max(width, height)
    if longest <= max_dimension:
        return None
    ratio = max_dimension / longest
    new_w = max(2, round(width * ratio / 2) * 2)
    new_h = max(2, round(height * ratio / 2) * 2)
    return new_w, new_h


def _quality_to_native(fmt: str, quality: int) -> int:
    """Переводит шкалу 1..100 (больше = лучше) в параметр конкретного кодера."""
    quality = max(1, min(100, quality))
    if fmt == "avif":
        lo, hi = _AVIF_CRF
        return round(hi - (hi - lo) * (quality / 100))
    if fmt == "jpg":
        lo, hi = _JPEG_QSCALE
        return round(hi - (hi - lo) * (quality / 100))
    if fmt == "webp":
        lo, hi = _WEBP_QUALITY
        return round(lo + (hi - lo) * (quality / 100))
    return quality


def build_args(
    source: Path,
    output: Path,
    options: ImageOptions,
    info: MediaInfo | None,
    quality: int,
) -> list[str]:
    """Команда ffmpeg для одной попытки кодирования."""
    fmt = options.format
    native = _quality_to_native(fmt, quality)

    args = [binaries.ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "error", "-y"]
    args += ["-i", str(source)]

    # Порядок фильтров важен: сначала закрашиваем и обрезаем в координатах
    # оригинала (их и рисует пользователь), и только потом уменьшаем.
    chain: list[str] = []
    for box in options.boxes:
        chain.append(
            f"drawbox=x={box.x}:y={box.y}:w={box.width}:h={box.height}"
            f":color={options.box_color}:t=fill"
        )

    source_width = info.video.width if info and info.video else None
    source_height = info.video.height if info and info.video else None

    if options.crop:
        crop = options.crop
        chain.append(f"crop={crop.width}:{crop.height}:{crop.x}:{crop.y}")
        source_width, source_height = crop.width, crop.height

    resize = None
    if source_width and source_height:
        resize = _target_dimensions(source_width, source_height, options.max_dimension)
    if resize:
        chain.append(f"scale={resize[0]}:{resize[1]}:flags=lanczos")

    scale = ",".join(chain) if chain else None

    keep_alpha = bool(info and info.has_alpha) and fmt in {"avif", "webp", "png"}

    if fmt == "avif":
        if keep_alpha:
            # Муксер AVIF хранит прозрачность отдельным потоком, поэтому
            # альфу приходится выдёргивать фильтром и подавать вторым входом.
            prefix = f"{scale}," if scale else ""
            args += [
                "-filter_complex",
                f"[0:v]{prefix}split=2[base][tmp];[tmp]alphaextract[alpha]",
                "-map", "[base]",
                "-map", "[alpha]",
            ]
        else:
            if scale:
                args += ["-vf", scale]
            args += ["-map", "0:v:0"]
        args += [
            "-c:v", "libaom-av1",
            "-still-picture", "1",
            "-crf", str(native),
            "-b:v", "0",
            # cpu-used: 0 — медленно и максимально компактно, 8 — быстро.
            "-cpu-used", str(max(0, min(8, options.effort))),
            "-pix_fmt", "yuv420p",
            "-frames:v", "1",
            "-f", "avif",
        ]
    elif fmt == "webp":
        if scale:
            args += ["-vf", scale]
        args += [
            "-c:v", "libwebp",
            "-quality", str(native),
            "-compression_level", str(max(0, min(6, 6 - options.effort // 2))),
            "-pix_fmt", "yuva420p" if keep_alpha else "yuv420p",
            "-frames:v", "1",
            "-f", "webp",
        ]
    elif fmt == "jpg":
        if scale:
            args += ["-vf", scale]
        args += [
            "-c:v", "mjpeg",
            "-q:v", str(native),
            "-pix_fmt", "yuvj420p",
            "-frames:v", "1",
            "-f", "image2",
        ]
    elif fmt == "png":
        if scale:
            args += ["-vf", scale]
        args += [
            "-c:v", "png",
            "-compression_level", "9",
            "-frames:v", "1",
            "-f", "image2",
        ]
    else:
        raise ValueError(f"Неизвестный формат изображения: {fmt}")

    args.append(str(output))
    return args


async def _run(args: list[str]) -> None:
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=binaries.CREATE_NO_WINDOW,
        env=binaries.subprocess_env(),
    )
    _, err = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(err.decode("utf-8", "replace").strip()[:600] or "ffmpeg упал")


async def compress(
    source: Path,
    output: Path,
    options: ImageOptions,
    progress: ProgressCb | None = None,
) -> ImageResult:
    """Сжимает изображение, при необходимости подбирая качество под лимит веса."""
    info = await probe(source)
    output.parent.mkdir(parents=True, exist_ok=True)

    async def report(value: float, message: str) -> None:
        if progress:
            result = progress(value, message)
            if asyncio.iscoroutine(result):
                await result

    # PNG без потерь — подбирать нечего, делаем один проход.
    if options.target_kb is None or options.format == "png":
        await report(0.1, "Кодирование")
        await _run(build_args(source, output, options, info, options.quality))
        size = output.stat().st_size
        await report(1.0, "Готово")
        return _result(output, size, info, options, options.quality, 1, True)

    target_bytes = options.target_kb * 1024
    workdir = output.parent / f".{output.stem}.tmp"
    workdir.mkdir(parents=True, exist_ok=True)

    low, high = 1, 100
    best_path: Path | None = None
    best_size = 0
    best_quality = 0
    attempts = 0

    try:
        for step in range(options.passes):
            quality = (low + high) // 2
            attempts += 1
            candidate = workdir / f"try{step}{EXTENSIONS[options.format]}"
            await report(
                step / max(options.passes, 1),
                f"Проход {step + 1}/{options.passes}: качество {quality}",
            )
            await _run(build_args(source, output=candidate, options=options,
                                  info=info, quality=quality))
            size = candidate.stat().st_size

            if size <= target_bytes:
                # Влезли — запоминаем и пробуем поднять качество.
                if size > best_size:
                    best_path, best_size, best_quality = candidate, size, quality
                low = quality + 1
            else:
                high = quality - 1

            if low > high:
                break

        if best_path is None:
            # Ни один вариант не влез в лимит — берём самое сильное сжатие.
            attempts += 1
            await report(0.9, "Лимит недостижим, жмём по максимуму")
            candidate = workdir / f"final{EXTENSIONS[options.format]}"
            await _run(build_args(source, candidate, options, info, 1))
            best_path, best_size, best_quality = candidate, candidate.stat().st_size, 1

        if output.exists():
            output.unlink()
        shutil.move(str(best_path), str(output))
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    await report(1.0, "Готово")
    return _result(
        output, best_size, info, options, best_quality, attempts,
        best_size <= target_bytes,
    )


def _result(
    output: Path,
    size: int,
    info: MediaInfo,
    options: ImageOptions,
    quality: int,
    attempts: int,
    within: bool,
) -> ImageResult:
    width = info.video.width if info.video else 0
    height = info.video.height if info.video else 0
    if options.crop:
        width, height = options.crop.width, options.crop.height
    resized = _target_dimensions(width or 0, height or 0, options.max_dimension)
    if resized:
        width, height = resized
    return ImageResult(
        output=output,
        size=size,
        width=width or 0,
        height=height or 0,
        quality_used=quality,
        attempts=attempts,
        within_target=within,
    )

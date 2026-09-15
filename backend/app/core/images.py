"""Сжатие изображений через ffmpeg.

У каждого формата своя «ручка качества», и направление у них разное: у AVIF
меньше CRF — лучше, у WebP больше quality — лучше. Мы приводим её к единой
шкале 1..100 «чем больше, тем лучше», а дальше сжимаем одним проходом с тем
качеством, которое задал человек.

Подбора веса здесь больше нет. Он упирался в один и тот же потолок на любых
обычных картинках и выдавал одинаковый результат, зато занимал четыре прохода
вместо одного.
"""

from __future__ import annotations

import asyncio
import base64
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

from ..models import ImageOptions
from . import binaries
from .jobs import failure_text
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


def _ffmpeg_color(value: str) -> str:
    """Приводит цвет к виду, который ffmpeg понимает однозначно.

    Из палитры браузера цвет приходит как ``#rrggbb``. ffmpeg такую запись
    принимает не везде, а ``0xrrggbb`` — всегда.
    """
    value = (value or "").strip()
    if value.startswith("#") and len(value) in (7, 9):
        return "0x" + value[1:]
    return value or "black"


def build_args(
    source: Path,
    output: Path,
    options: ImageOptions,
    info: MediaInfo | None,
    quality: int,
    alpha_used: bool | None = None,
) -> list[str]:
    """Команда ffmpeg для одной попытки кодирования."""
    fmt = options.format
    native = _quality_to_native(fmt, quality)
    # У движущейся картинки нельзя брать только первый кадр: получился бы
    # стоп-кадр вместо анимации, причём молча — задача считалась бы успешной.
    animated = bool(info and info.animated) and fmt == "webp"
    still = [] if animated else ["-frames:v", "1"]

    args = [binaries.ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "error", "-y"]
    args += ["-i", str(source)]

    # Порядок фильтров важен: сначала закрашиваем и обрезаем в координатах
    # оригинала (их и рисует пользователь), и только потом уменьшаем.
    chain: list[str] = []
    if options.boxes:
        # Маски рисуем в обычном RGB. В «телевизионном» цветовом виде drawbox
        # укладывает цвет в диапазон 16-235, и заданный цвет оседает бледнее:
        # выбранный пипеткой фон переставал совпадать с самим фоном.
        # Именно rgba, а не rgb24: у картинок с прозрачностью rgb24 срезал бы
        # альфа-канал, и прозрачный фон стал бы чёрным.
        chain.append("format=rgba")
    for box in options.boxes:
        chain.append(
            f"drawbox=x={box.x}:y={box.y}:w={box.width}:h={box.height}"
            f":color={_ffmpeg_color(box.color or options.box_color)}:t=fill"
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

    has_alpha = bool(info and info.has_alpha) if alpha_used is None else alpha_used
    keep_alpha = has_alpha and fmt in {"avif", "webp", "png"}

    if fmt == "avif":
        if keep_alpha:
            # Муксер AVIF хранит прозрачность отдельным потоком, поэтому
            # альфу приходится выдёргивать фильтром и подавать вторым входом.
            #
            # setparams обязателен: без него ffmpeg помечает канал
            # прозрачности «тождественной» цветовой матрицей, а с ней libaom
            # требует полной цветности и отказывается кодировать —
            # «Subsampling must be 0 with AOM_CICP_MC_IDENTITY».
            # format=rgba обязателен: у палитровых PNG (а логотипы почти всегда
            # такие) отдельного канала прозрачности нет, и alphaextract падает
            # с «Requested planes not available».
            prefix = f"format=rgba,{scale}," if scale else "format=rgba,"
            alpha = (
                "alphaextract,format=gray,"
                "setparams=colorspace=bt470bg:color_primaries=bt709:color_trc=bt709"
            )
            args += [
                "-filter_complex",
                f"[0:v]{prefix}split=2[base][tmp];[tmp]{alpha}[alpha]",
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
            # Формат пикселей задаём каждому потоку отдельно: у картинки он
            # обычный, а у прозрачности — одноплоскостной серый. Общий
            # -pix_fmt превратил бы альфу в трёхплоскостную, и муксер AVIF
            # отказывался писать файл.
            # Формат пикселей задаём только картинке: у канала прозрачности
            # он уже выставлен фильтром, и общий -pix_fmt его бы испортил.
            *(["-pix_fmt:v:0", "yuv420p"] if keep_alpha else ["-pix_fmt", "yuv420p"]),
            *still,
            "-f", "avif",
        ]
    elif fmt == "webp":
        if scale:
            args += ["-vf", scale]
        args += [
            "-c:v", "libwebp",
            # Именно -qscale:v. Параметр -quality в свежих сборках ffmpeg
            # кодировщиком не читается: файл получался одинаковым при любом
            # значении ползунка, а текст на скриншотах превращался в кашу.
            "-qscale:v", str(native),
            "-compression_level", str(max(0, min(6, 6 - options.effort // 2))),
            "-pix_fmt", "yuva420p" if keep_alpha else "yuv420p",
            *(["-loop", "0"] if animated else []),
            *still,
            "-f", "webp",
        ]
    elif fmt == "jpg":
        if scale:
            args += ["-vf", scale]
        args += [
            "-c:v", "mjpeg",
            "-q:v", str(native),
            "-pix_fmt", "yuvj420p",
            *still,
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
        raise RuntimeError(
            failure_text(err.decode("utf-8", "replace").splitlines(), proc.returncode)
        )


async def alpha_is_used(source: Path) -> bool:
    """Действительно ли картинка что-то скрывает прозрачностью.

    Наличие альфа-канала ещё ничего не значит: у PNG из скриншотов и
    экспортов он сплошь и рядом присутствует, но полностью непрозрачен.
    Хранить его тогда незачем — файл выходит крупнее и сложнее, а для AVIF
    это ещё и второй поток внутри, лишний повод чему-нибудь сломаться.

    Смотрим минимум канала: 255 означает, что прозрачных точек нет вовсе.
    """
    args = [
        binaries.require("ffmpeg"), "-hide_banner", "-nostdin", "-v", "error",
        "-i", str(source),
        # file=- обязателен: без него вывод фильтра идёт в журнал
        # и глохнет на уровне логов "error", а проверка молча
        # начинает всегда отвечать «прозрачность нужна».
        "-vf",
        "format=rgba,alphaextract,signalstats,"
        "metadata=print:key=lavfi.signalstats.YMIN:file=-",
        "-f", "null", "-",
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            creationflags=binaries.CREATE_NO_WINDOW,
            env=binaries.subprocess_env(),
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
    except Exception:
        # Не смогли проверить — считаем, что прозрачность нужна.
        return True

    for line in out.decode("utf-8", "replace").splitlines():
        if "YMIN=" in line:
            try:
                return float(line.split("YMIN=")[1].strip()) < 255
            except ValueError:
                return True
    return True


async def _apply_paint(source: Path, data: str, workdir: Path) -> Path:
    """Накладывает нарисованное кистью поверх картинки отдельным проходом.

    Мазки приходят готовым прозрачным PNG размером с оригинал: прямоугольником
    не закрыть надпись, идущую дугой, а описывать каждый мазок фильтрами
    ffmpeg — бессмысленно сложно.

    Наложение делаем до всего остального, отдельным быстрым шагом в PNG без
    потерь. Так координаты закраски и обрезки остаются в системе оригинала,
    а собранная ниже команда сжатия не усложняется вторым входом.
    """
    workdir.mkdir(parents=True, exist_ok=True)
    layer = workdir / "paint.png"
    payload = data.split(",", 1)[-1] if data.startswith("data:") else data
    layer.write_bytes(base64.b64decode(payload))

    painted = workdir / "painted.png"
    await _run([
        binaries.ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        "-i", str(source),
        "-i", str(layer),
        "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto",
        "-pix_fmt", "rgba",
        "-frames:v", "1",
        str(painted),
    ])
    layer.unlink(missing_ok=True)
    return painted


#: Приписка к имени файла по формату — та же, что предлагает интерфейс.
SUFFIXES = {"avif": "_avif", "jpg": "_jpeg", "webp": "_webp", "png": "_png"}


async def resolve_format(source: Path, options: ImageOptions) -> str:
    """Формат, которым файл получится сжать на самом деле.

    Движение держит только WebP. Человек, который поставил гифку в очередь,
    хочет её сжать, а не выбрать формат — поэтому молча берём тот, который
    это умеет, вместо того чтобы ронять задачу и заставлять начинать заново.
    """
    if options.format == "webp":
        return options.format
    info = await probe(source)
    return "webp" if info and info.animated else options.format


async def compress(
    source: Path,
    output: Path,
    options: ImageOptions,
    progress: ProgressCb | None = None,
) -> ImageResult:
    """Сжимает изображение с заданным качеством."""
    output.parent.mkdir(parents=True, exist_ok=True)

    paint_dir: Path | None = None
    if options.paint_png:
        paint_dir = output.parent / f".{output.stem}.paint"
        source = await _apply_paint(source, options.paint_png, paint_dir)

    info = await probe(source)
    if info and info.animated and options.format != "webp":
        # Молча отдать первый кадр нельзя: задача считалась бы успешной, а от
        # анимации остался бы стоп-кадр — и человек узнал бы об этом, только
        # открыв результат, возможно уже удалив оригинал.
        # Число кадров известно не всегда: у движущегося WebP ffprobe его не
        # сообщает. Писать «None кадров» в таком случае незачем.
        frames = info.video.frames if info.video else None
        count = f" ({frames} кадров)" if frames and frames > 1 else ""
        raise ValueError(
            f"Это движущаяся картинка{count}. "
            f"{options.format.upper()} хранит только один кадр — "
            "выберите формат WebP, он умеет анимацию."
        )
    alpha_used = await alpha_is_used(source) if info and info.has_alpha else False

    async def report(value: float, message: str) -> None:
        if progress:
            result = progress(value, message)
            if asyncio.iscoroutine(result):
                await result

    await report(0.1, "Кодирование")
    try:
        await _run(build_args(source, output, options, info, options.quality, alpha_used))
        size = output.stat().st_size
    finally:
        if paint_dir:
            shutil.rmtree(paint_dir, ignore_errors=True)
    await report(1.0, "Готово")
    return _result(output, size, info, options, options.quality)


def _result(
    output: Path,
    size: int,
    info: MediaInfo,
    options: ImageOptions,
    quality: int,
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
    )

"""Сборка командных строк ffmpeg для видео и аудио.

Здесь нет запуска процессов — только чистая логика построения аргументов,
чтобы её можно было спокойно тестировать и показывать пользователю
(в интерфейсе есть кнопка «показать команду ffmpeg»).
"""

from __future__ import annotations

import shlex
from pathlib import Path
from typing import Any

from ..models import AudioOptions, ExportRequest, Trim, VideoOptions
from .probe import MediaInfo

#: Расширения контейнеров по кодекам, когда пользователь выбрал «auto».
_AUDIO_EXT = {
    "opus": ".opus",
    "aac": ".m4a",
    "mp3": ".mp3",
    "flac": ".flac",
}


def _fmt_time(value: float) -> str:
    """Секунды -> строка с миллисекундной точностью для -ss/-t."""
    return f"{max(value, 0.0):.3f}"


def build_video_filters(
    options: VideoOptions,
    info: MediaInfo | None,
    duration: float | None = None,
) -> list[str]:
    """Цепочка видеофильтров: даунскейл, ограничение fps, темп, затухания."""
    filters: list[str] = []

    if options.tempo and abs(options.tempo - 1.0) > 1e-6:
        # setpts делит длительность кадров: PTS/1.06 = ускорение на 6%.
        filters.append(f"setpts=PTS/{options.tempo:.6g}")

    if options.max_height > 0:
        source_height = info.video.height if info and info.video else None
        if source_height is None or source_height > options.max_height:
            # min(target, ih) гарантирует, что маленькое видео не растянется вверх.
            filters.append(
                "scale=-2:" + f"'min({options.max_height},ih)'" + ":flags=lanczos"
            )

    if options.max_fps > 0:
        source_fps = info.video.fps if info and info.video else None
        # Темп уже умножает фактический fps, учитываем это при сравнении.
        effective = (source_fps or 0) * (options.tempo or 1.0)
        if not source_fps or effective > options.max_fps + 0.01:
            filters.append(f"fps={options.max_fps}")

    # Затухания ставим последними: они должны работать по итоговому времени,
    # уже с учётом изменённого темпа.
    if options.fade_in > 0:
        filters.append(f"fade=t=in:st=0:d={options.fade_in:g}")
    if options.fade_out > 0 and duration and duration > options.fade_out:
        start = max(duration - options.fade_out, 0.0)
        filters.append(f"fade=t=out:st={start:.3f}:d={options.fade_out:g}")

    return filters


def build_audio_filters(
    options: AudioOptions,
    *,
    tempo: float = 1.0,
    duration: float | None = None,
    measured: dict[str, str] | None = None,
) -> list[str]:
    """Цепочка аудиофильтров: темп, нормализация громкости, фейды."""
    filters: list[str] = []

    if tempo and abs(tempo - 1.0) > 1e-6:
        # atempo принимает 0.5-2.0 за проход; для крайних значений цепляем каскад.
        remaining = tempo
        while remaining > 2.0:
            filters.append("atempo=2.0")
            remaining /= 2.0
        while remaining < 0.5:
            filters.append("atempo=0.5")
            remaining /= 0.5
        if abs(remaining - 1.0) > 1e-6:
            filters.append(f"atempo={remaining:.6g}")

    if options.loudnorm:
        params = [
            f"I={options.loudnorm_i:g}",
            f"TP={options.loudnorm_tp:g}",
            f"LRA={options.loudnorm_lra:g}",
        ]
        if measured:
            # Второй проход: подставляем замеры, включаем линейную нормализацию,
            # которая не «дышит» громкостью внутри трека.
            params += [
                f"measured_I={measured['input_i']}",
                f"measured_TP={measured['input_tp']}",
                f"measured_LRA={measured['input_lra']}",
                f"measured_thresh={measured['input_thresh']}",
                f"offset={measured.get('target_offset', '0.0')}",
                "linear=true",
            ]
        filters.append("loudnorm=" + ":".join(params))

    # curve=qsin — четверть синусоиды: громкость по ней уходит равномерно на
    # слух, а не «проваливается» в конце, как при линейном затухании. Именно
    # такую кривую по умолчанию рисуют монтажные программы.
    if options.fade_in > 0:
        filters.append(f"afade=t=in:curve=qsin:st=0:d={options.fade_in:g}")

    if options.fade_out > 0 and duration and duration > options.fade_out:
        start = max(duration - options.fade_out, 0.0)
        filters.append(
            f"afade=t=out:curve=qsin:st={start:.3f}:d={options.fade_out:g}"
        )

    return filters


#: Поправка к CRF в зависимости от итоговой высоты кадра.
#:
#: Одно и то же число CRF на разных разрешениях выглядит по-разному: на мелком
#: кадре артефакты заметнее, потому что зритель видит его растянутым на весь
#: экран. Пресет задаёт качество «как на 720p», а здесь мы приводим его
#: к реальному разрешению — иначе 360p-исходник, сжатый «пресетом 720p»,
#: получался бы неоправданно грязным.
_CRF_BY_HEIGHT: list[tuple[int, int]] = [
    (2160, +7),
    (1440, +5),
    (1080, +3),
    (720, 0),
    (540, -3),
    (360, -5),
    (0, -7),
]


def target_height(options: VideoOptions, info: MediaInfo | None) -> int | None:
    """Какая высота кадра получится на выходе. None, если определить нельзя."""
    source = info.video.height if info and info.video else None
    if options.max_height > 0:
        return min(options.max_height, source) if source else options.max_height
    return source


def _gpu_preset(speed: str) -> str:
    """Пресет скорости для NVENC: p1 — быстро, p7 — качественно."""
    if isinstance(speed, str) and speed.startswith("p"):
        return speed
    return "p5"


def resolve_codec(options: VideoOptions) -> str:
    """Кодек с учётом галочки «на видеокарте».

    Если ускорять нечем, молча остаёмся на процессоре: лучше кодировать
    медленнее, чем уронить задачу непонятной ошибкой.
    """
    from . import binaries

    if not options.use_gpu or options.codec == "copy":
        return options.codec
    if options.codec.endswith(("nvenc", "qsv", "amf")):
        return options.codec
    return binaries.hardware_codec(options.codec) or options.codec


def gpu_quality(codec: str, crf: int) -> int:
    """Переводит CRF в шкалу аппаратного кодировщика.

    У NVENC своя шкала, и то же число даёт совсем другой вес файла. Смещение
    подобрано замером на реальном ролике: для пака важнее предсказуемый
    размер, чем последние проценты качества. Совсем сравнять не получится —
    видеокарта при равном весе всегда рисует чуть хуже процессора.
    """
    if codec.startswith("av1"):
        return max(15, min(51, crf + 4))
    return max(15, min(51, crf + 2))


def effective_crf(options: VideoOptions, info: MediaInfo | None) -> int:
    """CRF пресета, подогнанный под фактическое разрешение."""
    height = target_height(options, info)
    if not height:
        return options.crf
    offset = next(delta for threshold, delta in _CRF_BY_HEIGHT if height >= threshold)
    adjusted = max(0, min(63, options.crf + offset))

    # У аппаратных кодировщиков своя шкала — переводим в неё.
    codec = resolve_codec(options)
    if codec.endswith(("nvenc", "qsv", "amf")):
        return gpu_quality(codec, adjusted)
    return adjusted


def video_codec_args(options: VideoOptions, crf: int | None = None) -> list[str]:
    """Аргументы кодека видео. ``crf`` перебивает значение из пресета."""
    codec = resolve_codec(options)
    if codec == "copy":
        return ["-c:v", "copy"]

    quality = options.crf if crf is None else crf

    if codec == "av1_svt":
        return [
            "-c:v", "libsvtav1",
            "-crf", str(quality),
            "-preset", str(options.speed_preset),
            # tune=0 оптимизирует под субъективное восприятие, а не под PSNR.
            "-svtav1-params", "tune=0",
            "-pix_fmt", "yuv420p",
        ]

    if codec == "av1_nvenc":
        return [
            "-c:v", "av1_nvenc",
            # Пресеты SVT («6») NVENC не понимает — у него своя шкала p1..p7.
            "-preset", _gpu_preset(options.speed_preset),
            "-rc", "vbr",
            "-cq", str(quality),
            "-b:v", "0",
            "-pix_fmt", "yuv420p",
        ]

    if codec in {"av1_qsv", "h264_qsv"}:
        return [
            "-c:v", codec,
            "-global_quality", str(quality),
            "-preset", "medium",
            "-pix_fmt", "yuv420p",
        ]

    if codec in {"av1_amf", "h264_amf"}:
        return [
            "-c:v", codec,
            "-quality", "balanced",
            "-qp_i", str(quality),
            "-qp_p", str(quality),
            "-pix_fmt", "yuv420p",
        ]

    if codec == "h264":
        return [
            "-c:v", "libx264",
            "-crf", str(quality),
            "-preset", str(options.speed_preset or "fast"),
            "-profile:v", "high",
            "-pix_fmt", "yuv420p",
        ]

    if codec == "h264_nvenc":
        return [
            "-c:v", "h264_nvenc",
            "-preset", _gpu_preset(options.speed_preset),
            "-rc", "vbr",
            "-cq", str(quality),
            "-b:v", "0",
            "-pix_fmt", "yuv420p",
        ]

    if codec == "h265":
        return [
            "-c:v", "libx265",
            "-crf", str(quality),
            "-preset", str(options.speed_preset or "medium"),
            # hvc1 нужен, чтобы файл открывался в плеерах Apple.
            "-tag:v", "hvc1",
            "-pix_fmt", "yuv420p",
        ]

    raise ValueError(f"Неизвестный видеокодек: {codec}")


def audio_codec_args(options: AudioOptions) -> list[str]:
    """Аргументы кодека звука."""
    codec = options.codec
    if codec == "none":
        return ["-an"]
    if codec == "copy":
        return ["-c:a", "copy"]

    args: list[str]
    if codec == "opus":
        args = [
            "-c:a", "libopus",
            "-b:a", f"{options.bitrate_kbps}k",
            "-vbr", "on",
            "-application", "audio",
        ]
    elif codec == "aac":
        args = ["-c:a", "aac", "-b:a", f"{options.bitrate_kbps}k"]
    elif codec == "mp3":
        args = ["-c:a", "libmp3lame", "-b:a", f"{options.bitrate_kbps}k"]
    elif codec == "flac":
        args = ["-c:a", "flac"]
    else:
        raise ValueError(f"Неизвестный аудиокодек: {codec}")

    if options.mono:
        args += ["-ac", "1"]
    return args


def container_extension(request: ExportRequest, info: MediaInfo | None) -> str:
    """Расширение выходного файла."""
    if request.kind == "audio" or request.video.strip_video:
        if request.audio.codec == "copy":
            return Path(request.source).suffix or ".m4a"
        return _AUDIO_EXT.get(request.audio.codec, ".m4a")

    container = request.video.container
    if container == "auto":
        # Opus официально живёт в MP4, но WebM для него — родной дом.
        if request.video.codec.startswith("av1") and request.audio.codec == "opus":
            return ".webm"
        return ".mp4"
    return f".{container}"


def input_args(trim: Trim, source: str, *, accurate: bool) -> list[str]:
    """Аргументы ввода с учётом обрезки.

    ``-ss`` до ``-i`` работает быстро (перемотка по индексу контейнера) и при
    перекодировании остаётся точным: ffmpeg декодирует от ближайшего ключевого
    кадра и отбрасывает лишнее. При ``-c copy`` точность ограничена ключевыми
    кадрами — об этом пользователь предупреждён в интерфейсе.
    """
    args: list[str] = []
    if trim.start:
        args += ["-ss", _fmt_time(trim.start)]

    duration = trim.duration
    if duration is None and trim.end is not None:
        duration = trim.end
    if duration is not None:
        # -t перед -i ограничивает объём читаемого исходника. Это важно при
        # изменении темпа: иначе лимит применился бы к уже ускоренному выходу
        # и хвост фрагмента потерялся бы.
        args += ["-t", _fmt_time(duration)]

    args += ["-i", source]

    if not accurate:
        # Иначе первый кадр среза может получить отрицательную метку времени.
        args += ["-avoid_negative_ts", "make_zero"]
    return args


def build_loudnorm_probe(request: ExportRequest) -> list[str]:
    """Команда первого прохода двухпроходной нормализации (только анализ)."""
    from . import binaries

    options = request.audio
    args = [binaries.ffmpeg(), "-hide_banner", "-nostdin"]
    args += input_args(request.trim, request.source, accurate=True)
    args += [
        "-map", "0:a:0",
        "-af",
        (
            f"loudnorm=I={options.loudnorm_i:g}:TP={options.loudnorm_tp:g}"
            f":LRA={options.loudnorm_lra:g}:print_format=json"
        ),
        "-f", "null", "-",
    ]
    return args


def build_command(
    request: ExportRequest,
    output: Path,
    info: MediaInfo | None,
    *,
    measured: dict[str, str] | None = None,
    crf: int | None = None,
) -> list[str]:
    """Полная команда ffmpeg для одного задания экспорта."""
    from . import binaries

    audio_only = request.kind == "audio" or request.video.strip_video
    stream_copy = request.stream_copy or (
        request.video.codec == "copy" and request.audio.codec == "copy"
    )

    args = [
        binaries.ffmpeg(),
        "-hide_banner",
        "-nostdin",
        "-loglevel", "error",
        "-y",
    ]
    args += input_args(request.trim, request.source, accurate=not stream_copy)

    if audio_only:
        args += ["-vn", "-map", "0:a:0?"]
    else:
        # Берём первую видео- и первую аудиодорожку; субтитры и данные отбрасываем.
        args += ["-map", "0:v:0", "-map", "0:a:0?"]

    duration = request.trim.duration or (info.duration if info else None)
    if request.trim.start and request.trim.duration is None and info and info.duration:
        duration = max(info.duration - request.trim.start, 0.0)

    if stream_copy:
        args += ["-c", "copy"]
    else:
        if not audio_only:
            args += video_codec_args(
                request.video, crf if crf is not None else effective_crf(request.video, info)
            )
            # Длительность результата с поправкой на темп — по ней ставится затухание.
            tempo = request.video.tempo or 1.0
            visible = (duration / tempo) if duration else None
            video_filters = build_video_filters(request.video, info, visible)
            if video_filters:
                args += ["-vf", ",".join(video_filters)]

        has_audio = info.has_audio if info else True
        if has_audio:
            args += audio_codec_args(request.audio)
            if request.audio.codec not in {"copy", "none"}:
                audio_filters = build_audio_filters(
                    request.audio,
                    tempo=1.0 if audio_only else request.video.tempo,
                    duration=duration,
                    measured=measured,
                )
                if audio_filters:
                    args += ["-af", ",".join(audio_filters)]
        else:
            args += ["-an"]

    suffix = output.suffix.lower()
    if suffix in {".mp4", ".m4a", ".mov"} and request.video.faststart:
        args += ["-movflags", "+faststart"]
    if suffix == ".mp4" and request.audio.codec == "opus" and not stream_copy:
        # Opus в MP4 официально разрешён, но ffmpeg просит явного согласия.
        args += ["-strict", "-2"]

    # Прогресс машиночитаемым потоком в stdout — его парсит планировщик задач.
    args += ["-progress", "pipe:1", "-nostats", str(output)]
    return args


def to_display_string(args: list[str]) -> str:
    """Команда в виде строки — для показа в интерфейсе и в логах."""
    return " ".join(shlex.quote(part) for part in args)


def describe(request: ExportRequest) -> dict[str, Any]:
    """Краткое человекочитаемое описание того, что произойдёт с файлом."""
    if request.kind == "image":
        image = request.image
        limit = (
            f"лимит {image.target_kb} КБ"
            if image.target_kb
            else f"качество {image.quality}"
        )
        parts = [image.format.upper(), limit]
        if image.max_dimension:
            parts.append(f"до {image.max_dimension}px")
        return {"summary": " · ".join(parts)}

    if request.stream_copy:
        return {"summary": "Копирование потока без перекодирования"}

    if request.kind == "audio" or request.video.strip_video:
        parts = [request.audio.codec.upper(), f"{request.audio.bitrate_kbps} кбит/с"]
        if request.audio.loudnorm:
            parts.append("нормализация")
        return {"summary": " · ".join(parts)}

    parts = [resolve_codec(request.video).replace("_", " ").upper(), f"CRF {request.video.crf}"]
    if request.video.max_height:
        parts.append(f"{request.video.max_height}p")
    if request.video.max_fps:
        parts.append(f"{request.video.max_fps} к/с")
    if abs(request.video.tempo - 1.0) > 1e-6:
        parts.append(f"×{request.video.tempo:g}")
    parts.append(f"{request.audio.codec.upper()} {request.audio.bitrate_kbps}k")
    return {"summary": " · ".join(parts)}

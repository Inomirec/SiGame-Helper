"""Чтение технических данных о медиафайле через ffprobe."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import binaries

#: Кэш ответов ffprobe: путь + mtime + размер -> результат.
_cache: dict[tuple[str, float, int], "MediaInfo"] = {}
_CACHE_LIMIT = 512


@dataclass(slots=True)
class StreamInfo:
    index: int
    kind: str          # video | audio | subtitle | ...
    codec: str | None
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    channels: int | None = None
    sample_rate: int | None = None
    bit_rate: int | None = None
    language: str | None = None
    pix_fmt: str | None = None
    #: Сколько кадров в потоке. У GIF и WebP по этому числу видно анимацию.
    frames: int | None = None


@dataclass(slots=True)
class MediaInfo:
    path: str
    size: int
    duration: float | None
    container: str | None
    bit_rate: int | None
    streams: list[StreamInfo] = field(default_factory=list)
    tags: dict[str, str] = field(default_factory=dict)

    @property
    def video(self) -> StreamInfo | None:
        return next((s for s in self.streams if s.kind == "video"), None)

    @property
    def audio(self) -> StreamInfo | None:
        return next((s for s in self.streams if s.kind == "audio"), None)

    @property
    def animated(self) -> bool:
        """Движущаяся картинка: GIF или WebP из нескольких кадров.

        Такой файл нельзя молча сжать в AVIF или JPEG: в них помещается один
        кадр, и от анимации осталась бы первая картинка — потеря, о которой
        человек узнал бы только открыв результат.
        """
        video = self.video
        return bool(video and video.frames and video.frames > 1)

    @property
    def has_audio(self) -> bool:
        return self.audio is not None

    @property
    def has_alpha(self) -> bool:
        """Есть ли в картинке/видео альфа-канал (важно при конвертации в AVIF)."""
        video = self.video
        if not video or not video.pix_fmt:
            return False
        return video.pix_fmt.startswith(
            ("yuva", "rgba", "bgra", "argb", "abgr", "gbrap", "ya", "pal8")
        )

    def to_dict(self) -> dict[str, Any]:
        video, audio = self.video, self.audio
        return {
            "path": self.path,
            "size": self.size,
            "duration": self.duration,
            "container": self.container,
            "bitRate": self.bit_rate,
            "width": video.width if video else None,
            "height": video.height if video else None,
            "fps": video.fps if video else None,
            "videoCodec": video.codec if video else None,
            "audioCodec": audio.codec if audio else None,
            "audioChannels": audio.channels if audio else None,
            "sampleRate": audio.sample_rate if audio else None,
            "hasAudio": self.has_audio,
            "hasAlpha": self.has_alpha,
            "animated": self.animated,
            "pixFmt": video.pix_fmt if video else None,
            "tags": self.tags,
            "streams": [
                {
                    "index": s.index,
                    "kind": s.kind,
                    "codec": s.codec,
                    "width": s.width,
                    "height": s.height,
                    "fps": s.fps,
                    "channels": s.channels,
                    "sampleRate": s.sample_rate,
                    "bitRate": s.bit_rate,
                    "language": s.language,
                    "pixFmt": s.pix_fmt,
                }
                for s in self.streams
            ],
        }


def _parse_fps(value: str | None) -> float | None:
    """``30000/1001`` -> 29.97."""
    if not value or value in {"0/0", "0/1"}:
        return None
    try:
        if "/" in value:
            num, den = value.split("/", 1)
            denominator = float(den)
            return round(float(num) / denominator, 3) if denominator else None
        return float(value)
    except ValueError:
        return None


def _to_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _to_float(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if result >= 0 else None


#: Расширения, у которых поворот хранится меткой EXIF, а не в самих данных.
_EXIF_SUFFIXES = {".jpg", ".jpeg", ".jpe", ".tif", ".tiff"}

#: Метка поворота в EXIF.
_ORIENTATION_TAG = 0x0112

#: Значения метки, при которых стороны кадра меняются местами.
TURNED = (5, 6, 7, 8)


def _orientation_from_tiff(block: bytes) -> int:
    """Достаёт метку поворота из блока TIFF внутри EXIF."""
    if len(block) < 8:
        return 1
    if block[:2] == b"II":
        endian = "little"
    elif block[:2] == b"MM":
        endian = "big"
    else:
        return 1

    start = int.from_bytes(block[4:8], endian)
    if start + 2 > len(block):
        return 1

    count = int.from_bytes(block[start : start + 2], endian)
    for index in range(count):
        at = start + 2 + index * 12
        if at + 12 > len(block):
            break
        if int.from_bytes(block[at : at + 2], endian) == _ORIENTATION_TAG:
            return int.from_bytes(block[at + 8 : at + 10], endian) or 1
    return 1


def exif_orientation(path: Path) -> int:
    """Метка поворота фотографии: 1 — как есть, 5-8 — повёрнута на бок.

    Телефон снимает всегда одинаково, а поворот дописывает меткой. ffmpeg
    её применяет при обработке, но ffprobe отдаёт размеры до поворота —
    поэтому вертикальное фото программа считала бы горизонтальным: маски
    ложились бы мимо, а уменьшение плющило бы кадр.
    """
    if path.suffix.lower() not in _EXIF_SUFFIXES:
        return 1
    try:
        with path.open("rb") as handle:
            if handle.read(2) != bytes((0xFF, 0xD8)):
                return 1
            while True:
                marker = handle.read(2)
                if len(marker) < 2 or marker[0] != 0xFF:
                    return 1
                kind = marker[1]
                # Дошли до самих данных картинки — метки уже не будет.
                if kind in (0xD8, 0xD9, 0xDA):
                    return 1
                size = int.from_bytes(handle.read(2), "big") - 2
                if size < 0:
                    return 1
                block = handle.read(size)
                if kind == 0xE1 and block[:4] == b"Exif":
                    return _orientation_from_tiff(block[6:])
    except OSError:
        return 1


async def probe(path: str | Path, use_cache: bool = True) -> MediaInfo:
    """Запускает ffprobe и возвращает разобранную информацию о файле."""
    file = Path(path)
    stat = file.stat()
    key = (str(file), stat.st_mtime, stat.st_size)
    if use_cache and key in _cache:
        return _cache[key]

    args = [
        binaries.ffprobe(),
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        str(file),
    ]
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=binaries.CREATE_NO_WINDOW,
        env=binaries.subprocess_env(),
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(
            # Режем щедро: причина обычно в первой строке, но обрывать её
            # на половине слова незачем — читать всё равно человеку.
            f"ffprobe не смог прочитать файл: {err.decode('utf-8', 'replace').strip()[:2000]}"
        )

    data = json.loads(out.decode("utf-8", "replace") or "{}")
    fmt = data.get("format", {}) or {}

    streams: list[StreamInfo] = []
    for raw in data.get("streams", []) or []:
        streams.append(
            StreamInfo(
                index=_to_int(raw.get("index")) or 0,
                kind=raw.get("codec_type", "unknown"),
                codec=raw.get("codec_name"),
                width=_to_int(raw.get("width")),
                height=_to_int(raw.get("height")),
                fps=_parse_fps(raw.get("avg_frame_rate") or raw.get("r_frame_rate")),
                channels=_to_int(raw.get("channels")),
                sample_rate=_to_int(raw.get("sample_rate")),
                bit_rate=_to_int(raw.get("bit_rate")),
                language=(raw.get("tags") or {}).get("language"),
                pix_fmt=raw.get("pix_fmt"),
                frames=_to_int(raw.get("nb_frames")),
            )
        )

    # Повёрнутое меткой фото ffmpeg развернёт сам, а ffprobe отдаёт размеры
    # до поворота — приводим их к тому, что человек видит на экране.
    if exif_orientation(file) in TURNED:
        for stream in streams:
            if stream.kind == "video" and stream.width and stream.height:
                stream.width, stream.height = stream.height, stream.width

    info = MediaInfo(
        path=str(file),
        size=stat.st_size,
        duration=_to_float(fmt.get("duration")),
        container=fmt.get("format_name"),
        bit_rate=_to_int(fmt.get("bit_rate")),
        streams=streams,
        tags={k: str(v) for k, v in (fmt.get("tags") or {}).items()},
    )

    if len(_cache) > _CACHE_LIMIT:
        _cache.clear()
    _cache[key] = info
    return info


async def duration_of(path: str | Path) -> float:
    """Длительность в секундах (0, если определить не удалось)."""
    try:
        info = await probe(path)
    except (OSError, RuntimeError, json.JSONDecodeError):
        return 0.0
    return info.duration or 0.0

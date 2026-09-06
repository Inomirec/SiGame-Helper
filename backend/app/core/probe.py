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
            f"ffprobe не смог прочитать файл: {err.decode('utf-8', 'replace')[:300]}"
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
            )
        )

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

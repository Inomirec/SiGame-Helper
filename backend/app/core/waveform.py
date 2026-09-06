"""Построение осциллограммы (звуковой волны) для таймлайна.

ffmpeg декодирует звук в сырой моно-PCM с низкой частотой дискретизации, а мы
сворачиваем его в несколько сотен «пиков» — по одному на пиксель дорожки.
Считать волну в браузере через Web Audio нельзя: пришлось бы качать весь файл
целиком, а видеовопрос легко весит сотни мегабайт.

Результат кэшируется на диске: повторное открытие файла отдаёт готовый JSON.
"""

from __future__ import annotations

import array
import asyncio
import contextlib
import hashlib
import json
import sys
from pathlib import Path

from ..paths import data_dir
from . import binaries
from .probe import probe

#: Частота дискретизации для анализа. Для огибающей этого с запасом хватает,
#: а объём данных выходит в десятки раз меньше исходного.
SAMPLE_RATE = 4000

#: Сколько столбиков рисуем на дорожке.
DEFAULT_BUCKETS = 900

#: Файлы длиннее этого разбираем на пониженной частоте, чтобы не тратить время.
LONG_FILE_SECONDS = 1800

_locks: dict[str, asyncio.Lock] = {}


def cache_dir() -> Path:
    return data_dir() / "waveforms"


def _cache_path(source: Path, buckets: int) -> Path:
    try:
        stat = source.stat()
        signature = f"{source}|{stat.st_mtime_ns}|{stat.st_size}|{buckets}"
    except OSError:
        signature = f"{source}|{buckets}"
    return cache_dir() / f"{hashlib.sha1(signature.encode('utf-8')).hexdigest()}.json"


async def peaks(source: Path, buckets: int = DEFAULT_BUCKETS) -> dict[str, object]:
    """Возвращает ``{peaks: [0..1], duration, buckets}`` для файла."""
    cache = _cache_path(source, buckets)
    if cache.exists():
        try:
            return json.loads(cache.read_text("utf-8"))
        except (OSError, json.JSONDecodeError):
            cache.unlink(missing_ok=True)

    lock = _locks.setdefault(str(cache), asyncio.Lock())
    async with lock:
        if cache.exists():
            try:
                return json.loads(cache.read_text("utf-8"))
            except (OSError, json.JSONDecodeError):
                pass

        info = await probe(source)
        if not info.has_audio:
            result = {"peaks": [], "duration": info.duration or 0.0, "hasAudio": False}
            _store(cache, result)
            return result

        duration = info.duration or 0.0
        rate = SAMPLE_RATE if duration <= LONG_FILE_SECONDS else SAMPLE_RATE // 2
        values = await _decode(source, rate, buckets)

        result = {
            "peaks": values,
            "duration": duration,
            "buckets": len(values),
            "hasAudio": True,
        }
        _store(cache, result)
        return result


def _store(cache: Path, payload: dict[str, object]) -> None:
    cache.parent.mkdir(parents=True, exist_ok=True)
    with contextlib.suppress(OSError):
        cache.write_text(json.dumps(payload), encoding="utf-8")


async def _decode(source: Path, rate: int, buckets: int) -> list[float]:
    """Гоняет звук через ffmpeg и сворачивает его в список пиков 0..1."""
    args = [
        binaries.ffmpeg(),
        "-hide_banner", "-nostdin", "-loglevel", "error",
        "-i", str(source),
        "-vn",
        "-map", "0:a:0",
        "-ac", "1",
        "-ar", str(rate),
        "-f", "s16le",
        "-",
    ]

    process = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        limit=1024 * 1024,
        creationflags=binaries.CREATE_NO_WINDOW,
        env=binaries.subprocess_env(),
    )
    assert process.stdout is not None

    raw = bytearray()
    while True:
        chunk = await process.stdout.read(1 << 18)
        if not chunk:
            break
        raw += chunk
    await process.wait()

    # Один отсчёт — два байта; нечётный хвост отбрасываем.
    if len(raw) % 2:
        del raw[-1]

    samples = array.array("h")
    samples.frombytes(bytes(raw))
    if sys.byteorder == "big":
        samples.byteswap()

    total = len(samples)
    if not total:
        return []

    # Пики считаем срезами: max()/min() над array работают на скорости C,
    # а поштучный цикл по миллионам отсчётов заметно тормозил бы на часовых файлах.
    per_bucket = max(total // max(buckets, 1), 1)
    result: list[float] = []
    for start in range(0, total, per_bucket):
        segment = samples[start : start + per_bucket]
        if not segment:
            continue
        peak = max(max(segment), -min(segment))
        result.append(round(peak / 32768, 4))

    # Нормируем по максимуму: тихая запись должна быть видна так же хорошо,
    # как громкая, — дорожка нужна для навигации, а не для замера уровня.
    loudest = max(result, default=0.0)
    if loudest > 0:
        result = [round(min(value / loudest, 1.0), 4) for value in result]
    return result


def clear_cache() -> int:
    removed = 0
    for file in cache_dir().glob("*.json"):
        try:
            file.unlink()
            removed += 1
        except OSError:
            continue
    return removed

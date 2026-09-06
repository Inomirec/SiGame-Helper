"""Проверка обновлений yt-dlp и gallery-dl.

Эти два инструмента приходится обновлять регулярно: сайты меняют вёрстку и
ломают их парсеры. Но постоянно висящая кнопка «Обновить» бесполезна — нужно
знать, есть ли вообще смысл жать. Поэтому спрашиваем у PyPI последнюю версию
и сравниваем с установленной.

ffmpeg и Deno сюда не входят: они не зависят от сайтов и не «протухают».
"""

from __future__ import annotations

import asyncio
import json
import re
import time
import urllib.request
from typing import Any

from . import binaries

#: Что умеем проверять.
TRACKED = ("yt-dlp", "gallery-dl")

#: Ответ PyPI кэшируем — незачем ходить в сеть на каждое открытие настроек.
CACHE_TTL = 3600
_cache: dict[str, tuple[float, str | None]] = {}


def _version_key(raw: str | None) -> tuple[int, ...]:
    """Версия в виде кортежа чисел для сравнения.

    Пакеты нумеруются датой (``2026.8.19``), а ночные сборки добавляют время
    (``2026.08.30.232658``). Простое сравнение строк тут врёт: «2026.8.19»
    больше «2026.08.30» лексикографически. Числа сравнивать надёжнее.
    """
    if not raw:
        return ()
    numbers = re.findall(r"\d+", raw)
    return tuple(int(item) for item in numbers[:5])


def _fetch_latest(package: str) -> str | None:
    """Последняя стабильная версия пакета по данным PyPI."""
    url = f"https://pypi.org/pypi/{package}/json"
    request = urllib.request.Request(url, headers={"User-Agent": "SiGameHelper"})
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            data = json.loads(response.read().decode("utf-8", "replace"))
    except Exception:
        return None
    return (data.get("info") or {}).get("version")


async def check(refresh: bool = False) -> dict[str, dict[str, Any]]:
    """Сравнивает установленные версии загрузчиков с последними на PyPI."""
    detected = binaries.detect_all()
    loop = asyncio.get_running_loop()
    result: dict[str, dict[str, Any]] = {}

    for tool in TRACKED:
        info = detected.get(tool)
        current = info.version if info and info.available else None

        cached = _cache.get(tool)
        if cached and not refresh and time.time() - cached[0] < CACHE_TTL:
            latest = cached[1]
        else:
            latest = await loop.run_in_executor(None, _fetch_latest, tool)
            _cache[tool] = (time.time(), latest)

        if not current:
            state = "missing"
        elif not latest:
            state = "unknown"
        elif _version_key(current) >= _version_key(latest):
            state = "current"
        else:
            state = "outdated"

        result[tool] = {
            "current": current,
            "latest": latest,
            "state": state,
        }

    return result

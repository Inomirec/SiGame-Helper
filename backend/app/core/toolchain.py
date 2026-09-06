"""Автоматическая установка внешних инструментов: ffmpeg и Deno.

Самый неприятный шаг установки для обычного пользователя — раздобыть ffmpeg:
официальный сайт предлагает архивы .7z, которые Windows не открывает без
стороннего архиватора. Поэтому берём готовую сборку BtbN в обычном .zip —
её распаковывает стандартная библиотека Python, и от пользователя не требуется
вообще ничего.

Deno нужен ради YouTube. Сайт защищается задачками на JavaScript, и без
движка, который их решает, yt-dlp отвечает «The page needs to be reloaded» или
«Sign in to confirm you're not a bot» даже с правильными куками. Сам решатель
приезжает Python-пакетом ``yt-dlp-ejs``, а движок для него — это Deno.

Обновлять эти два инструмента, в отличие от yt-dlp, регулярно не нужно: они не
зависят от вёрстки сайтов и не «протухают».
"""

from __future__ import annotations

import asyncio
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Awaitable, Callable

from ..paths import _project_root
from . import binaries

#: Полная статическая сборка под Windows x64: внутри libsvtav1, libaom (AVIF),
#: libopus, libwebp, libx264/x265 — всё, на чём держатся пресеты приложения.
FFMPEG_URL = (
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/"
    "ffmpeg-master-latest-win64-gpl.zip"
)
FFMPEG_WANTED = ("ffmpeg.exe", "ffprobe.exe")

#: Deno — движок JavaScript, на котором yt-dlp решает защиту YouTube.
DENO_URL = (
    "https://github.com/denoland/deno/releases/latest/download/"
    "deno-x86_64-pc-windows-msvc.zip"
)
DENO_WANTED = ("deno.exe",)

ProgressCb = Callable[[float, str], Awaitable[None] | None]


def target_dir() -> Path:
    return _project_root() / "bin"


def _download(url: str, destination: Path, report) -> None:
    """Скачивание блокирующим кодом — вызывается в отдельном потоке."""
    import urllib.request

    request = urllib.request.Request(url, headers={"User-Agent": "SiGameHelper"})
    with urllib.request.urlopen(request, timeout=60) as response:
        total = int(response.headers.get("Content-Length") or 0)
        done = 0
        with destination.open("wb") as handle:
            while True:
                chunk = response.read(1024 * 256)
                if not chunk:
                    break
                handle.write(chunk)
                done += len(chunk)
                if total:
                    report(done / total, done, total)


def _extract(archive: Path, destination: Path, wanted: tuple[str, ...]) -> list[Path]:
    """Достаёт из архива только нужные .exe, игнорируя структуру папок."""
    destination.mkdir(parents=True, exist_ok=True)
    extracted: list[Path] = []

    with zipfile.ZipFile(archive) as bundle:
        for entry in bundle.infolist():
            name = Path(entry.filename).name.lower()
            if name not in wanted:
                continue
            target = destination / name
            # Заменяем файл через временное имя: работающий ffmpeg может
            # держать старый .exe открытым, и прямая перезапись упадёт.
            staging = destination / f"{name}.new"
            with bundle.open(entry) as source, staging.open("wb") as handle:
                shutil.copyfileobj(source, handle)
            if target.exists():
                target.unlink(missing_ok=True)
            staging.replace(target)
            extracted.append(target)

    return extracted


async def _install(
    *,
    url: str,
    wanted: tuple[str, ...],
    label: str,
    prefix: str,
    progress: ProgressCb | None,
) -> list[Path]:
    """Общий сценарий: скачать zip, достать нужные файлы, положить в bin."""

    async def report(value: float, message: str) -> None:
        if progress:
            result = progress(value, message)
            if asyncio.iscoroutine(result):
                await result

    loop = asyncio.get_running_loop()
    workdir = Path(tempfile.mkdtemp(prefix=prefix))
    archive = workdir / "bundle.zip"

    def on_chunk(ratio: float, done: int, total: int) -> None:
        # Колбэк приходит из рабочего потока, поэтому в цикл событий
        # возвращаемся через call_soon_threadsafe.
        megabytes = f"{done / 1048576:.0f} из {total / 1048576:.0f} МБ"
        loop.call_soon_threadsafe(
            lambda: asyncio.ensure_future(
                report(ratio * 0.9, f"Скачивание {label} · {megabytes}")
            )
        )

    try:
        await report(0.0, "Подключение к серверу загрузок")
        await loop.run_in_executor(None, _download, url, archive, on_chunk)

        await report(0.92, "Распаковка")
        extracted = await loop.run_in_executor(
            None, _extract, archive, target_dir(), wanted
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    if len(extracted) < len(wanted):
        raise RuntimeError(
            f"В архиве не нашлось {', '.join(wanted)} — возможно, сборка изменилась. "
            f"Установите {label} вручную."
        )
    return extracted


async def install_ffmpeg(progress: ProgressCb | None = None) -> dict[str, object]:
    """Скачивает и распаковывает ffmpeg. Возвращает сведения об установленном."""
    extracted = await _install(
        url=FFMPEG_URL,
        wanted=FFMPEG_WANTED,
        label="ffmpeg",
        prefix="sgh-ffmpeg-",
        progress=progress,
    )

    if progress:
        result = progress(0.97, "Проверка")
        if asyncio.iscoroutine(result):
            await result

    binaries.invalidate()
    info = binaries.detect_all(refresh=True).get("ffmpeg")
    if not info or not info.available:
        raise RuntimeError(
            f"ffmpeg установлен, но не запускается: {info.error if info else 'неизвестно'}"
        )

    if progress:
        result = progress(1.0, f"Готово · ffmpeg {info.version}")
        if asyncio.iscoroutine(result):
            await result

    return {
        "path": info.path,
        "version": info.version,
        "features": info.features,
        "files": [str(item) for item in extracted],
    }


async def install_deno(progress: ProgressCb | None = None) -> dict[str, object]:
    """Скачивает Deno — без него YouTube отказывается отдавать ссылки."""
    extracted = await _install(
        url=DENO_URL,
        wanted=DENO_WANTED,
        label="Deno",
        prefix="sgh-deno-",
        progress=progress,
    )

    if progress:
        result = progress(0.97, "Проверка")
        if asyncio.iscoroutine(result):
            await result

    binaries.invalidate()
    info = binaries.detect_all(refresh=True).get("deno")
    if not info or not info.available:
        raise RuntimeError(
            f"Deno установлен, но не запускается: {info.error if info else 'неизвестно'}"
        )

    if progress:
        result = progress(1.0, f"Готово · Deno {info.version}")
        if asyncio.iscoroutine(result):
            await result

    return {
        "path": info.path,
        "version": info.version,
        "files": [str(item) for item in extracted],
    }

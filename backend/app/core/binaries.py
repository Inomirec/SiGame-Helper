"""Поиск и проверка внешних бинарников (ffmpeg, ffprobe, yt-dlp, gallery-dl).

Порядок поиска для каждого инструмента:
1. Явный путь из настроек.
2. Папка ``bin`` рядом с проектом (портативный режим).
3. Скрипты внутри виртуального окружения (там живут yt-dlp и gallery-dl).
4. Системный PATH.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

from .. import config
from ..paths import _project_root, is_frozen

#: На Windows нельзя допустить всплывающих консольных окон при запуске утилит.
CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

_EXE = ".exe" if sys.platform == "win32" else ""


@dataclass(slots=True)
class BinaryInfo:
    name: str
    path: str | None
    version: str | None = None
    available: bool = False
    #: Список возможностей ffmpeg (кодеки), нужен фронтенду для скрытия пресетов.
    features: dict[str, bool] = field(default_factory=dict)
    error: str | None = None


def _venv_scripts_dir() -> Path | None:
    """Папка Scripts/bin активного venv."""
    base = Path(sys.executable).parent
    if (base / f"yt-dlp{_EXE}").exists() or (base / "yt-dlp").exists():
        return base
    return None


def _portable_bin_dirs() -> list[Path]:
    """Папки рядом с приложением, куда мы кладём скачанные инструменты.

    Родительскую папку намеренно не просматриваем: приложение может лежать
    где угодно, и подхватывать чужой ``bin`` по соседству — неприятный сюрприз.
    """
    root = _project_root()
    return [root / "bin", root / "tools"]


def _lookup(tool: str, override: str | None) -> str | None:
    """Ищет исполняемый файл ``tool``, возвращая абсолютный путь либо None."""
    if override:
        candidate = Path(override).expanduser()
        if candidate.exists():
            return str(candidate)
        # Переопределение может быть просто именем команды в PATH.
        found = shutil.which(override)
        if found:
            return found

    for directory in _portable_bin_dirs():
        candidate = directory / f"{tool}{_EXE}"
        if candidate.exists():
            return str(candidate)

    scripts = _venv_scripts_dir()
    if scripts:
        candidate = scripts / f"{tool}{_EXE}"
        if candidate.exists():
            return str(candidate)

    return shutil.which(tool)


def _run(args: list[str], timeout: float = 20.0) -> tuple[int, str]:
    """Синхронный запуск утилиты для быстрых проверок версии."""
    try:
        proc = subprocess.run(
            args,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return 1, str(exc)
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def _ffmpeg_features(path: str) -> dict[str, bool]:
    """Определяет, какие кодеки собраны в найденном ffmpeg."""
    code, out = _run([path, "-hide_banner", "-encoders"])
    if code != 0:
        return {}
    encoders = out
    wanted = {
        "av1_svt": "libsvtav1",
        "av1_aom": "libaom-av1",
        "h264": "libx264",
        "h265": "libx265",
        "opus": "libopus",
        "aac": " aac ",
        "webp": "libwebp",
        "nvenc_h264": "h264_nvenc",
        "nvenc_av1": "av1_nvenc",
        "qsv_av1": "av1_qsv",
        "amf_av1": "av1_amf",
    }
    return {key: (needle in encoders) for key, needle in wanted.items()}


def detect_all(refresh: bool = False) -> dict[str, BinaryInfo]:
    """Проверяет наличие всех внешних инструментов."""
    global _cache
    if _cache is not None and not refresh:
        return _cache

    overrides = config.load().binaries
    result: dict[str, BinaryInfo] = {}

    ffmpeg_path = _lookup("ffmpeg", overrides.ffmpeg)
    info = BinaryInfo("ffmpeg", ffmpeg_path)
    if ffmpeg_path:
        code, out = _run([ffmpeg_path, "-version"])
        if code == 0:
            info.available = True
            match = re.search(r"ffmpeg version (\S+)", out)
            info.version = match.group(1) if match else "unknown"
            info.features = _ffmpeg_features(ffmpeg_path)
        else:
            info.error = out.strip()[:400]
    else:
        info.error = "ffmpeg не найден ни в PATH, ни в папке bin"
    result["ffmpeg"] = info

    ffprobe_path = _lookup("ffprobe", overrides.ffprobe)
    info = BinaryInfo("ffprobe", ffprobe_path)
    if ffprobe_path:
        code, out = _run([ffprobe_path, "-version"])
        info.available = code == 0
        match = re.search(r"ffprobe version (\S+)", out)
        info.version = match.group(1) if match else None
        if code != 0:
            info.error = out.strip()[:400]
    else:
        info.error = "ffprobe не найден (обычно лежит рядом с ffmpeg)"
    result["ffprobe"] = info

    deno_path = _lookup("deno", getattr(overrides, "deno", None))
    info = BinaryInfo("deno", deno_path)
    if deno_path:
        code, out = _run([deno_path, "--version"])
        info.available = code == 0
        # deno --version печатает три строки; нам нужен только номер версии.
        first = out.strip().splitlines()[0] if out.strip() else ""
        info.version = first.replace("deno ", "").split(" ")[0] or None
        if code != 0:
            info.error = out.strip()[:400]
    else:
        info.error = "Deno не найден — YouTube без него не отдаёт ссылки"
    result["deno"] = info

    for tool, label in (("yt-dlp", "yt_dlp"), ("gallery-dl", "gallery_dl")):
        path = _lookup(tool, getattr(overrides, label))
        info = BinaryInfo(tool, path)
        if path:
            code, out = _run([path, "--version"])
            info.available = code == 0
            info.version = out.strip().splitlines()[0] if out.strip() else None
            if code != 0:
                info.error = out.strip()[:400]
        else:
            info.error = f"{tool} не установлен (pip install {tool})"
        result[tool] = info

    _cache = result
    return result


_cache: dict[str, BinaryInfo] | None = None


def invalidate() -> None:
    global _cache, _hardware
    _cache = None
    _hardware = None


def require(name: str) -> str:
    """Возвращает путь к инструменту или бросает понятную ошибку."""
    info = detect_all().get(name)
    if not info or not info.available or not info.path:
        raise RuntimeError(
            f"Инструмент «{name}» недоступен. {info.error if info else ''}".strip()
        )
    return info.path


def ffmpeg() -> str:
    return require("ffmpeg")


def ffprobe() -> str:
    return require("ffprobe")


#: Аппаратные кодировщики, которые мы умеем использовать.
#: Ключ — как это называется у нас, значение — имя кодека в ffmpeg.
HARDWARE_ENCODERS = {
    "av1_nvenc": "av1_nvenc",
    "h264_nvenc": "h264_nvenc",
    "av1_qsv": "av1_qsv",
    "h264_qsv": "h264_qsv",
    "av1_amf": "av1_amf",
    "h264_amf": "h264_amf",
}

_hardware: dict[str, bool] | None = None


def probe_hardware() -> dict[str, bool]:
    """Проверяет, какие аппаратные кодировщики реально работают.

    Наличие кодировщика в сборке ffmpeg ещё ничего не значит: полная сборка
    умеет и NVENC, и QSV, и AMF, а видеокарта в компьютере — какая-то одна.
    Единственный надёжный способ — попробовать закодировать пару кадров.
    """
    global _hardware
    if _hardware is not None:
        return _hardware

    result: dict[str, bool] = {}
    try:
        ffmpeg_path = ffmpeg()
    except RuntimeError:
        _hardware = {name: False for name in HARDWARE_ENCODERS}
        return _hardware

    for name, codec in HARDWARE_ENCODERS.items():
        code, _ = _run(
            [
                ffmpeg_path, "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10:duration=0.4",
                "-c:v", codec, "-f", "null", "-",
            ],
            timeout=45.0,
        )
        result[name] = code == 0

    _hardware = result
    return result


def hardware_codec(codec: str) -> str | None:
    """Подбирает аппаратную замену программному кодеку.

    Возвращает None, если на этом компьютере ускорять нечем.
    """
    family = "av1" if codec.startswith("av1") else "h264"
    available = probe_hardware()
    # NVIDIA первой: у неё качество на единицу настройки заметно лучше,
    # чем у встроенной графики Intel и у AMF.
    for vendor in ("nvenc", "qsv", "amf"):
        name = f"{family}_{vendor}"
        if available.get(name):
            return name
    return None


def has(name: str) -> bool:
    info = detect_all().get(name)
    return bool(info and info.available)


def supports(feature: str) -> bool:
    """Проверка кодека в текущей сборке ffmpeg (например ``av1_svt``)."""
    info = detect_all().get("ffmpeg")
    return bool(info and info.features.get(feature))


async def upgrade_downloader(tool: str) -> tuple[bool, str]:
    """Обновляет yt-dlp/gallery-dl через pip того же интерпретатора."""
    if tool not in {"yt-dlp", "gallery-dl"}:
        raise ValueError(f"Обновление не поддерживается для {tool}")
    if is_frozen():
        # В собранном .exe pip недоступен — у yt-dlp есть встроенный self-update.
        path = _lookup(tool, None)
        if not path:
            return False, f"{tool} не найден"
        args = [path, "-U"]
    else:
        args = [sys.executable, "-m", "pip", "install", "--upgrade", tool]

    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        creationflags=CREATE_NO_WINDOW,
    )
    raw, _ = await proc.communicate()
    invalidate()
    text = raw.decode("utf-8", "replace")
    return proc.returncode == 0, text[-4000:]


def subprocess_env() -> dict[str, str]:
    """Окружение для дочерних процессов.

    Кроме UTF-8 в выводе добавляем нашу папку ``bin`` в начало PATH: yt-dlp
    ищет движок JavaScript (Deno) именно там, а системного Deno у пользователя
    обычно нет.
    """
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"

    extra = [str(folder) for folder in _portable_bin_dirs() if folder.exists()]
    if extra:
        env["PATH"] = os.pathsep.join([*extra, env.get("PATH", "")])
    return env

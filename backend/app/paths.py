r"""Пути приложения: где лежит конфиг, кэш превью и куда складывать результат.

Приложение задумано портативным: если рядом с исполняемым файлом есть папка
``data``, всё хранится там (удобно носить на флешке). Иначе используется
стандартный ``%APPDATA%\SiGameHelper``.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

APP_NAME = "SiGameHelper"


def _project_root() -> Path:
    """Корень репозитория (на два уровня выше этого файла)."""
    return Path(__file__).resolve().parents[2]


def is_frozen() -> bool:
    """True, если приложение запущено из собранного PyInstaller .exe."""
    return getattr(sys, "frozen", False)


def bundle_dir() -> Path:
    """Папка с ресурсами (статика фронтенда) — отличается в .exe и в исходниках."""
    if is_frozen():
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent


def data_dir() -> Path:
    """Каталог для конфига, логов и кэша превью."""
    portable = _project_root() / "data"
    if portable.exists():
        return portable

    base = os.environ.get("APPDATA") or os.environ.get("XDG_CONFIG_HOME")
    if base:
        return Path(base) / APP_NAME
    return Path.home() / f".{APP_NAME.lower()}"


def ensure_dirs() -> None:
    for path in (data_dir(), thumbs_dir(), logs_dir()):
        path.mkdir(parents=True, exist_ok=True)


def config_file() -> Path:
    return data_dir() / "config.json"


def thumbs_dir() -> Path:
    return data_dir() / "thumbnails"


def logs_dir() -> Path:
    return data_dir() / "logs"


def default_workspace() -> Path:
    """Рабочая папка по умолчанию — ``Видео/SiGame Helper`` в профиле пользователя."""
    for candidate in ("Videos", "Видео"):
        folder = Path.home() / candidate
        if folder.exists():
            return folder / "SiGame Helper"
    return Path.home() / "SiGame Helper"


def static_dir() -> Path:
    """Собранный фронтенд."""
    return bundle_dir() / "static"

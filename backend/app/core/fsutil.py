"""Работа с файловой системой: определение типа медиа, безопасные пути, имена."""

from __future__ import annotations

import os
import re
import unicodedata
from pathlib import Path

from .. import config

VIDEO_EXT = {
    ".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".flv", ".wmv",
    ".mpg", ".mpeg", ".ts", ".m2ts", ".ogv", ".3gp",
}
AUDIO_EXT = {
    ".mp3", ".m4a", ".aac", ".opus", ".ogg", ".oga", ".flac", ".wav",
    ".wma", ".aiff", ".alac", ".weba",
}
IMAGE_EXT = {
    ".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif", ".bmp", ".tif",
    ".tiff", ".heic", ".heif", ".jxl", ".ico",
}
MEDIA_EXT = VIDEO_EXT | AUDIO_EXT | IMAGE_EXT

#: Служебные папки, которые не показываем в медиатеке.
SKIP_DIRS = {
    ".git", "__pycache__", "node_modules", ".venv", "venv",
    ".thumbnails", ".tmp", "$RECYCLE.BIN", "System Volume Information",
}

#: Типы, которые браузерный <video>/<audio>/<img> открывает напрямую.
MIME_TYPES = {
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
    ".webm": "video/webm", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
    ".ogv": "video/ogg", ".ts": "video/mp2t", ".flv": "video/x-flv",
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac",
    ".opus": "audio/ogg", ".ogg": "audio/ogg", ".oga": "audio/ogg",
    ".flac": "audio/flac", ".wav": "audio/wav", ".weba": "audio/webm",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif",
    ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
    ".svg": "image/svg+xml", ".ico": "image/x-icon", ".jxl": "image/jxl",
    ".heic": "image/heic", ".heif": "image/heif",
}


def media_kind(path: str | Path) -> str:
    """video | audio | image | other по расширению файла."""
    suffix = Path(path).suffix.lower()
    if suffix in VIDEO_EXT:
        return "video"
    if suffix in AUDIO_EXT:
        return "audio"
    if suffix in IMAGE_EXT:
        return "image"
    return "other"


def mime_for(path: str | Path) -> str:
    return MIME_TYPES.get(Path(path).suffix.lower(), "application/octet-stream")


def browser_playable(path: str | Path) -> bool:
    """Откроет ли встроенный плеер браузера этот файл без перекодирования."""
    return Path(path).suffix.lower() in {
        ".mp4", ".m4v", ".webm", ".mp3", ".m4a", ".opus", ".ogg", ".oga",
        ".flac", ".wav", ".weba", ".jpg", ".jpeg", ".png", ".webp", ".avif",
        ".gif", ".bmp", ".svg", ".ico",
    }


def allowed_roots() -> list[Path]:
    """Папки, к которым разрешён доступ через API."""
    settings = config.load()
    roots: list[Path] = []
    for item in settings.workspaces:
        try:
            roots.append(Path(item).expanduser().resolve())
        except OSError:
            continue
    if settings.download.directory:
        try:
            roots.append(Path(settings.download.directory).expanduser().resolve())
        except OSError:
            pass
    return roots


def is_allowed(path: Path) -> bool:
    """Защита от выхода за пределы рабочих папок (path traversal)."""
    try:
        resolved = path.expanduser().resolve()
    except OSError:
        return False
    for root in allowed_roots():
        try:
            resolved.relative_to(root)
            return True
        except ValueError:
            continue
    return False


def safe_path(raw: str, *, must_exist: bool = True) -> Path:
    """Проверяет путь и возвращает его абсолютную форму."""
    path = Path(raw).expanduser()
    try:
        path = path.resolve()
    except OSError as exc:
        raise ValueError(f"Некорректный путь: {raw}") from exc
    if not is_allowed(path):
        raise PermissionError(
            "Путь вне рабочих папок. Добавьте его в настройках, если это ваша папка."
        )
    if must_exist and not path.exists():
        raise FileNotFoundError(f"Файл не найден: {path}")
    return path


def sanitize_name(name: str, *, fallback: str = "file") -> str:
    """Убирает символы, запрещённые в именах файлов Windows."""
    name = unicodedata.normalize("NFC", name).strip()
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    # Зарезервированные имена устройств DOS до сих пор недопустимы в Windows.
    if re.fullmatch(r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?", name):
        name = f"_{name}"
    return name[:180] or fallback


def unique_path(path: Path, *, overwrite: bool = False) -> Path:
    """Возвращает свободное имя, добавляя ``(2)``, ``(3)`` и т.д."""
    if overwrite or not path.exists():
        return path
    stem, suffix, parent = path.stem, path.suffix, path.parent
    for index in range(2, 1000):
        candidate = parent / f"{stem} ({index}){suffix}"
        if not candidate.exists():
            return candidate
    raise FileExistsError(f"Не удалось подобрать свободное имя для {path}")


#: Человеческие имена папок по типу медиа.
KIND_FOLDERS = {"video": "Видео", "audio": "Аудио", "image": "Картинки"}


def kind_folder(kind: str) -> str:
    """Имя подпапки для типа медиа. Пустая строка = раскладка выключена."""
    if not config.load().export.sort_into_folders:
        return ""
    return KIND_FOLDERS.get(kind, "")


def sorted_dir(base: Path, kind: str) -> Path:
    """Добавляет к папке подпапку по типу, если раскладка включена."""
    folder = kind_folder(kind)
    return base / folder if folder else base


def default_output_dir(source: Path, kind: str | None = None) -> Path:
    """Подпапка для результатов рядом с исходником.

    Внутри неё файлы дополнительно раскладываются по типу — иначе через месяц
    работы над паком в одной куче лежат сотни файлов, и найти нужный тяжело.
    """
    folder = config.load().export.output_folder or "_processed"
    base = source.parent / folder
    # Если исходник уже лежит в папке-по-типу, второй раз её не создаём.
    if kind and base.name != KIND_FOLDERS.get(kind, ""):
        return sorted_dir(base, kind)
    return base


def human_size(size: int) -> str:
    value = float(size)
    for unit in ("Б", "КБ", "МБ", "ГБ", "ТБ"):
        if value < 1024 or unit == "ТБ":
            return f"{value:.0f} {unit}" if unit == "Б" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} ТБ"


def scan_directory(
    root: Path,
    *,
    recursive: bool = True,
    kinds: set[str] | None = None,
    limit: int = 20000,
) -> list[dict]:
    """Обходит папку и возвращает список медиафайлов."""
    files: list[dict] = []
    root = root.expanduser()
    if not root.exists():
        return files

    walker = os.walk(root) if recursive else [(str(root), [], os.listdir(root))]
    for dirpath, dirnames, filenames in walker:
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for filename in filenames:
            suffix = Path(filename).suffix.lower()
            if suffix not in MEDIA_EXT:
                continue
            kind = media_kind(filename)
            if kinds and kind not in kinds:
                continue
            full = Path(dirpath) / filename
            try:
                stat = full.stat()
            except OSError:
                continue
            files.append(
                {
                    "path": str(full),
                    "name": filename,
                    "kind": kind,
                    "size": stat.st_size,
                    "modified": stat.st_mtime,
                    "ext": suffix.lstrip("."),
                    "relative": str(full.relative_to(root)) if full.is_relative_to(root) else filename,
                    "folder": str(Path(dirpath)),
                    "playable": browser_playable(filename),
                }
            )
            if len(files) >= limit:
                return files
    return files


def list_folders(root: Path, limit: int = 300) -> list[dict]:
    """Непосредственные подпапки, в которых есть медиа.

    Нужна медиатеке: когда исходников сотни, показывать их одной кучей
    неудобно — человек и так разложил всё по папкам, и программа должна
    эту раскладку сохранять.
    """
    root = root.expanduser()
    if not root.exists():
        return []

    folders: list[dict] = []
    try:
        entries = sorted(
            (e for e in os.scandir(root) if e.is_dir(follow_symlinks=False)),
            key=lambda e: e.name.lower(),
        )
    except OSError:
        return []

    for entry in entries[:limit]:
        if entry.name in SKIP_DIRS or entry.name.startswith("."):
            continue
        count = 0
        for _, dirnames, filenames in os.walk(entry.path):
            dirnames[:] = [
                d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")
            ]
            count += sum(
                1 for name in filenames if Path(name).suffix.lower() in MEDIA_EXT
            )
            if count > 9999:
                break
        if count:
            folders.append({"name": entry.name, "path": entry.path, "count": count})
    return folders

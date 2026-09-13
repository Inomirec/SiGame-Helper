"""Настройки приложения и выбор папок."""

from __future__ import annotations

import contextlib
import os
import string
import subprocess
import sys
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, HTTPException, UploadFile

from .. import config
from ..core import binaries
from ..core.events import bus
from ..models import PathRequest, SettingsPatch
from ..paths import data_dir, default_workspace

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("")
async def get_settings() -> dict[str, Any]:
    settings = config.load()
    data = settings.model_dump(mode="json")
    data["resolvedWorkspace"] = settings.resolved_workspace()
    data["defaultWorkspace"] = str(default_workspace())
    return data


@router.patch("")
async def patch_settings(patch: SettingsPatch) -> dict[str, Any]:
    try:
        settings = config.update(patch.as_dict())
    except ValueError as exc:
        raise HTTPException(422, f"Некорректные настройки: {exc}") from exc
    # Пути к бинарникам могли поменяться — сбрасываем кэш определения.
    binaries.invalidate()
    data = settings.model_dump(mode="json")
    data["resolvedWorkspace"] = settings.resolved_workspace()
    return data


@router.post("/workspaces/add")
async def add_workspace(payload: PathRequest) -> dict[str, Any]:
    """Добавляет рабочую папку (создаёт её, если не существует)."""
    path = Path(payload.path).expanduser()
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HTTPException(400, f"Не удалось открыть папку: {exc}") from exc

    settings = config.load()
    resolved = str(path.resolve())
    # Список нужен не пользователю, а проверке путей: файлы, обработанные в
    # прежней папке, должны оставаться доступными. Поэтому держим его коротким
    # и не показываем в интерфейсе.
    workspaces = [w for w in settings.workspaces if w != resolved]
    workspaces.insert(0, resolved)
    workspaces = workspaces[:8]
    return (
        await patch_settings(
            SettingsPatch.model_validate(
                {"workspaces": workspaces, "active_workspace": resolved}
            )
        )
    )


@router.post("/workspaces/remove")
async def remove_workspace(payload: PathRequest) -> dict[str, Any]:
    settings = config.load()
    workspaces = [w for w in settings.workspaces if w != payload.path]
    active = settings.active_workspace
    if active == payload.path:
        active = workspaces[0] if workspaces else None
    return await patch_settings(
        SettingsPatch.model_validate({"workspaces": workspaces, "active_workspace": active})
    )


@router.get("/browse")
async def browse(path: str | None = None) -> dict[str, Any]:
    """Простой обозреватель папок — работает и в браузере, и в окне приложения."""
    if not path:
        return {
            "path": None,
            "parent": None,
            "drives": _drives(),
            "entries": [
                {"name": name, "path": str(folder)}
                for name, folder in _shortcuts()
                if folder.exists()
            ],
        }

    current = Path(path).expanduser()
    if not current.exists() or not current.is_dir():
        raise HTTPException(404, "Папка не найдена")

    entries: list[dict[str, str]] = []
    try:
        with os.scandir(current) as it:
            for entry in it:
                if entry.is_dir(follow_symlinks=False) and not entry.name.startswith("."):
                    entries.append({"name": entry.name, "path": entry.path})
    except PermissionError as exc:
        raise HTTPException(403, "Нет доступа к этой папке") from exc

    entries.sort(key=lambda item: item["name"].lower())
    parent = str(current.parent) if current.parent != current else None
    return {"path": str(current), "parent": parent, "drives": _drives(), "entries": entries}


@router.post("/pick-folder")
async def pick_folder() -> dict[str, Any]:
    """Нативный диалог выбора папки. Доступен только в оконном режиме."""
    try:
        import webview  # type: ignore[import-not-found]
    except ImportError:
        return {"supported": False, "path": None}

    windows = getattr(webview, "windows", [])
    if not windows:
        return {"supported": False, "path": None}

    result = windows[0].create_file_dialog(webview.FOLDER_DIALOG)
    if not result:
        return {"supported": True, "path": None}
    return {"supported": True, "path": str(result[0])}


@router.post("/reveal")
async def reveal(payload: PathRequest) -> dict[str, bool]:
    """Открывает файл или папку в системном файловом менеджере."""
    target = Path(payload.path).expanduser()
    if not target.exists():
        raise HTTPException(404, "Путь не найден")
    try:
        if sys.platform == "win32":
            # Через вспомогательный скрипт, а не напрямую: "explorer /select"
            # всегда открывает НОВОЕ окно, и после проверки десятка скачанных
            # файлов человек закрывает десяток проводников.
            helper = Path(__file__).resolve().parents[3] / "scripts" / "reveal.ps1"
            if helper.exists():
                subprocess.Popen(
                    [
                        "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                        "-WindowStyle", "Hidden", "-File", str(helper),
                        "-Path", str(target),
                    ],
                    creationflags=binaries.CREATE_NO_WINDOW,
                )
            elif target.is_dir():
                os.startfile(str(target))  # noqa: S606 - открытие проводника
            else:
                subprocess.Popen(["explorer", "/select,", str(target)])
        elif sys.platform == "darwin":
            args = ["open"] + (["-R"] if target.is_file() else []) + [str(target)]
            subprocess.Popen(args)
        else:
            subprocess.Popen(["xdg-open", str(target if target.is_dir() else target.parent)])
    except OSError as exc:
        raise HTTPException(500, f"Не удалось открыть проводник: {exc}") from exc
    return {"ok": True}


def _drives() -> list[str]:
    if sys.platform != "win32":
        return ["/"]
    return [
        f"{letter}:\\"
        for letter in string.ascii_uppercase
        if Path(f"{letter}:\\").exists()
    ]


def _shortcuts() -> list[tuple[str, Path]]:
    home = Path.home()
    candidates = [
        ("Рабочий стол", home / "Desktop"),
        ("Рабочий стол", home / "Рабочий стол"),
        ("Загрузки", home / "Downloads"),
        ("Загрузки", home / "Загрузки"),
        ("Видео", home / "Videos"),
        ("Видео", home / "Видео"),
        ("Музыка", home / "Music"),
        ("Изображения", home / "Pictures"),
        ("Документы", home / "Documents"),
        ("Домашняя папка", home),
    ]
    seen: set[str] = set()
    result: list[tuple[str, Path]] = []
    for name, folder in candidates:
        key = str(folder)
        if key in seen:
            continue
        seen.add(key)
        result.append((name, folder))
    return result


#: Больше настоящий файл с куками не бывает — защита от случайного видео.
_COOKIES_LIMIT = 5 * 1024 * 1024


def _looks_like_cookies(text: str) -> bool:
    """Похоже ли содержимое на файл кук в формате Netscape.

    Проверяем не ради строгости, а чтобы человек сразу понял, что выбрал не
    тот файл: иначе ошибка вылезет позже и будет выглядеть как «скачивание
    сломалось».
    """
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # Строка куки — семь полей, разделённых табуляцией.
        if len(line.split("\t")) >= 6:
            return True
    return False


@router.post("/cookies")
async def upload_cookies(file: UploadFile = File(...)) -> dict[str, Any]:
    """Принимает файл с куками, выгруженный расширением браузера."""
    raw = await file.read(_COOKIES_LIMIT + 1)
    if len(raw) > _COOKIES_LIMIT:
        raise HTTPException(400, "Файл слишком большой — это точно файл с куками?")
    if not raw.strip():
        raise HTTPException(400, "Файл пустой")

    text = raw.decode("utf-8", "replace")
    if not _looks_like_cookies(text):
        raise HTTPException(
            400,
            "Не похоже на файл с куками. Нужен файл в формате Netscape — "
            "его сохраняет расширение «Get cookies.txt LOCALLY».",
        )

    target = data_dir() / "cookies.txt"
    target.write_text(text, encoding="utf-8")

    settings = config.load()
    settings.download.cookies_file = str(target)
    # Файл надёжнее чтения браузера, поэтому второй способ выключаем,
    # чтобы не гадать, какой из них сработал.
    settings.download.cookies_from_browser = None
    config.save(settings)
    return {"ok": True, "path": str(target), "size": len(raw)}


@router.post("/cookies/clear")
async def clear_cookies() -> dict[str, Any]:
    """Забывает загруженный файл с куками и удаляет его с диска."""
    settings = config.load()
    settings.download.cookies_file = None
    config.save(settings)
    target = data_dir() / "cookies.txt"
    with contextlib.suppress(OSError):
        target.unlink()
    return {"ok": True}

"""Настройки приложения и выбор папок."""

from __future__ import annotations

import os
import string
import subprocess
import sys
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

from .. import config
from ..core import binaries
from ..models import PathRequest, SettingsPatch
from ..paths import default_workspace

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
            if target.is_dir():
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

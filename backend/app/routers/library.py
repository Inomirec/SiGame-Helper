"""Медиатека: обход рабочей папки, сведения о файлах, миниатюры."""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import quote
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from .. import config
from ..core import filmstrip, fsutil, thumbs, waveform
from ..core.events import bus
from ..core.probe import probe
from ..models import PathRequest, RenameRequest

router = APIRouter(prefix="/api/library", tags=["library"])


@router.get("")
async def list_library(
    root: str | None = None,
    kind: str = Query(default="all", pattern="^(all|video|audio|image)$"),
    recursive: bool = True,
    search: str | None = None,
) -> dict[str, Any]:
    """Список медиафайлов рабочей папки."""
    settings = config.load()
    target = Path(root or settings.resolved_workspace()).expanduser()

    if not target.exists():
        return {
            "root": str(target),
            "workspace": settings.resolved_workspace(),
            "relative": "",
            "parent": None,
            "folders": [],
            "exists": False,
            "files": [],
            "counts": {"all": 0, "video": 0, "audio": 0, "image": 0},
            "totalSize": 0,
        }

    kinds = None if kind == "all" else {kind}
    files = fsutil.scan_directory(target, recursive=recursive, kinds=kinds)
    # Подпапки нужны только в режиме навигации: в «плоском» виде файлы из них
    # и так все показаны.
    folders = [] if recursive else fsutil.list_folders(target)

    if search:
        needle = search.casefold()
        files = [f for f in files if needle in f["name"].casefold()]

    files.sort(key=lambda item: item["modified"], reverse=True)

    # Счётчики считаем по всей папке, чтобы вкладки фильтра не «прыгали».
    everything = files if kind == "all" and not search else fsutil.scan_directory(target)
    counts = {"all": len(everything), "video": 0, "audio": 0, "image": 0}
    for item in everything:
        counts[item["kind"]] = counts.get(item["kind"], 0) + 1

    workspace = Path(settings.resolved_workspace()).expanduser()
    try:
        relative = str(target.relative_to(workspace))
    except ValueError:
        relative = ""

    return {
        "root": str(target),
        "workspace": str(workspace),
        "relative": "" if relative == "." else relative,
        "parent": str(target.parent) if target != workspace and target.parent != target else None,
        "folders": folders,
        "exists": True,
        "files": files,
        "counts": counts,
        "totalSize": sum(item["size"] for item in files),
    }


@router.get("/info")
async def file_info(path: str) -> dict[str, Any]:
    """Технические характеристики одного файла."""
    try:
        target = fsutil.safe_path(path)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(404, str(exc)) from exc

    kind = fsutil.media_kind(target)
    payload: dict[str, Any] = {
        "path": str(target),
        "name": target.name,
        "kind": kind,
        "size": target.stat().st_size,
        "modified": target.stat().st_mtime,
        "ext": target.suffix.lstrip(".").lower(),
        "playable": fsutil.browser_playable(target),
        "folder": str(target.parent),
    }
    try:
        info = await probe(target)
        payload["media"] = info.to_dict()
    except (RuntimeError, OSError) as exc:
        payload["media"] = None
        payload["probeError"] = str(exc)
    return payload


@router.get("/thumbnail")
async def thumbnail(path: str) -> FileResponse:
    """Миниатюра файла (генерируется и кэшируется на диске)."""
    try:
        target = fsutil.safe_path(path)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(404, str(exc)) from exc

    generated = await thumbs.get_or_create(target)
    if not generated:
        raise HTTPException(404, "Миниатюра недоступна для этого файла")
    return FileResponse(
        generated,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/filmstrip")
async def video_filmstrip(path: str, frames: int = filmstrip.DEFAULT_FRAMES) -> dict[str, Any]:
    """Лента кадров для видеодорожки таймлайна."""
    try:
        target = fsutil.safe_path(path)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(404, str(exc)) from exc

    if fsutil.media_kind(target) != "video":
        raise HTTPException(400, "Лента кадров есть только у видео")

    try:
        strip = await filmstrip.build(target, frames)
    except (RuntimeError, OSError) as exc:
        raise HTTPException(500, f"Не удалось собрать ленту кадров: {exc}") from exc
    if not strip:
        raise HTTPException(404, "У файла нет видеодорожки")

    return {
        "url": f"/api/library/filmstrip/image?path={quote(str(target))}&frames={strip.frames}",
        "frames": strip.frames,
        "tileWidth": strip.tile_width,
        "tileHeight": strip.tile_height,
    }


@router.get("/filmstrip/image")
async def video_filmstrip_image(path: str, frames: int = filmstrip.DEFAULT_FRAMES) -> FileResponse:
    """Сам спрайт с кадрами (одна картинка на всю дорожку)."""
    try:
        target = fsutil.safe_path(path)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(404, str(exc)) from exc

    strip = await filmstrip.build(target, frames)
    if not strip:
        raise HTTPException(404, "Лента кадров недоступна")
    return FileResponse(
        strip.path,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/waveform")
async def audio_waveform(path: str, buckets: int = waveform.DEFAULT_BUCKETS) -> dict[str, Any]:
    """Огибающая звука для таймлайна: список пиков от 0 до 1."""
    try:
        target = fsutil.safe_path(path)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(404, str(exc)) from exc

    if fsutil.media_kind(target) not in {"audio", "video"}:
        raise HTTPException(400, "У этого файла нет звуковой дорожки")

    try:
        return await waveform.peaks(target, max(120, min(buckets, 4000)))
    except (RuntimeError, OSError) as exc:
        raise HTTPException(500, f"Не удалось построить звуковую волну: {exc}") from exc


@router.post("/delete")
async def delete_file(payload: PathRequest) -> dict[str, Any]:
    """Удаляет файл (безвозвратно — подтверждение спрашивает интерфейс)."""
    try:
        target = fsutil.safe_path(payload.path)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(404, str(exc)) from exc
    if target.is_dir():
        raise HTTPException(400, "Удаление папок через интерфейс не поддерживается")
    try:
        os.remove(target)
    except OSError as exc:
        raise HTTPException(500, f"Не удалось удалить файл: {exc}") from exc
    bus.publish("library.changed", {"path": str(target.parent)})
    return {"ok": True}


@router.post("/rename")
async def rename_file(payload: RenameRequest) -> dict[str, Any]:
    try:
        target = fsutil.safe_path(payload.path)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(404, str(exc)) from exc

    name = fsutil.sanitize_name(payload.new_name, fallback=target.stem)
    if not name:
        raise HTTPException(400, "Пустое имя файла")
    if not Path(name).suffix:
        name = f"{name}{target.suffix}"

    destination = fsutil.unique_path(target.parent / name)
    try:
        target.rename(destination)
    except OSError as exc:
        raise HTTPException(500, f"Не удалось переименовать: {exc}") from exc
    bus.publish("library.changed", {"path": str(destination.parent)})
    return {"ok": True, "path": str(destination)}

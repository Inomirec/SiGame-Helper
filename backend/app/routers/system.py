"""Служебные эндпоинты: состояние окружения, пресеты, поток событий."""

from __future__ import annotations

import platform
import sys

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from .. import __version__
from ..core import binaries, filmstrip, pipeline, presets, thumbs, updates, waveform
from ..core.events import bus

router = APIRouter(prefix="/api", tags=["system"])


def _hardware_known() -> bool:
    """Проверяли ли уже видеокарту в этом запуске."""
    return getattr(binaries, "_hardware", None) is not None


@router.get("/status")
async def status(refresh: bool = False) -> dict:
    """Наличие и версии внешних инструментов + возможности ffmpeg."""
    detected = binaries.detect_all(refresh=refresh)
    tools = {
        name: {
            "name": info.name,
            "path": info.path,
            "version": info.version,
            "available": info.available,
            "features": info.features,
            "error": info.error,
        }
        for name, info in detected.items()
    }
    ffmpeg = detected.get("ffmpeg")
    # Проверять видеокарту при каждом запросе дорого — только по явной просьбе.
    hardware = binaries.probe_hardware() if refresh or _hardware_known() else {}
    return {
        "version": __version__,
        "hardware": hardware,
        "gpuAvailable": any(hardware.values()),
        "python": sys.version.split()[0],
        "platform": f"{platform.system()} {platform.release()}",
        "tools": tools,
        "ready": bool(
            detected.get("ffmpeg") and detected["ffmpeg"].available
            and detected.get("ffprobe") and detected["ffprobe"].available
        ),
        "capabilities": ffmpeg.features if ffmpeg else {},
    }


@router.post("/tools/{tool}/update")
async def update_tool(tool: str) -> dict:
    """Обновляет yt-dlp или gallery-dl до свежей версии."""
    if tool not in {"yt-dlp", "gallery-dl"}:
        raise HTTPException(400, "Обновлять можно только yt-dlp и gallery-dl")
    try:
        ok, output = await binaries.upgrade_downloader(tool)
    except (RuntimeError, ValueError, OSError) as exc:
        raise HTTPException(500, str(exc)) from exc
    info = binaries.detect_all(refresh=True).get(tool)
    return {"ok": ok, "output": output, "version": info.version if info else None}


@router.post("/tools/ffmpeg/install")
async def install_ffmpeg() -> dict:
    """Скачивает готовую сборку ffmpeg в папку bin рядом с приложением.

    Обновлять ffmpeg регулярно не нужно — он не зависит от вёрстки сайтов и
    не ломается сам по себе. Кнопка нужна для первой установки и на случай,
    когда понадобился более свежий кодек.
    """
    if sys.platform != "win32":
        raise HTTPException(400, "Автоустановка ffmpeg сделана только для Windows")
    job = pipeline.submit_ffmpeg_install()
    return job.to_dict()


@router.get("/tools/updates")
async def tool_updates(refresh: bool = False) -> dict:
    """Есть ли смысл жать «Обновить» у загрузчиков."""
    return await updates.check(refresh=refresh)


@router.get("/presets")
async def preset_catalog() -> dict:
    """Каталог пресетов сжатия с пометкой о доступности кодеков."""
    catalog = presets.catalog()
    features = binaries.detect_all().get("ffmpeg")
    available = features.features if features else {}

    requirements = {
        "av1_svt": "av1_svt",
        "h264": "h264",
        "h265": "h265",
    }
    for group in catalog.values():
        for preset in group:
            codec = preset.get("options", {}).get("video", {}).get("codec")
            feature = requirements.get(codec) if codec else None
            preset["available"] = available.get(feature, True) if feature else True
    return catalog


@router.get("/events")
async def events() -> StreamingResponse:
    """Единый поток server-sent events: прогресс задач, изменения медиатеки."""
    return StreamingResponse(
        bus.stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            # Отключает буферизацию, если приложение когда-нибудь окажется за nginx.
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/cache/thumbnails/clear")
async def clear_thumbnails() -> dict:
    """Чистит миниатюры, ленты кадров и разобранные звуковые волны."""
    return {
        "removed": thumbs.clear_cache() + waveform.clear_cache() + filmstrip.clear_cache()
    }

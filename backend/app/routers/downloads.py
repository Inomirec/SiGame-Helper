"""Загрузка медиа по ссылкам."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from ..core import download, pipeline, streamproxy
from ..models import DownloadRequest, ProbeGalleryRequest

router = APIRouter(prefix="/api/download", tags=["download"])


@router.post("")
async def start_download(request: DownloadRequest) -> dict[str, Any]:
    """Ставит все переданные ссылки в очередь скачивания."""
    jobs: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []

    for item in request.items:
        url = item.url.strip()
        if not url:
            continue
        if not url.lower().startswith(("http://", "https://")):
            errors.append({"url": url, "error": "Ссылка должна начинаться с http:// или https://"})
            continue
        try:
            jobs.append(pipeline.submit_download(request, item).to_dict())
        except (RuntimeError, ValueError, OSError) as exc:
            errors.append({"url": url, "error": str(exc)})

    if not jobs and errors:
        raise HTTPException(400, errors[0]["error"])
    if not jobs:
        raise HTTPException(400, "Не указано ни одной ссылки")
    return {"jobs": jobs, "errors": errors}


#: Признаки того, что сайт требует авторизации, а не сломался.
_COOKIE_HINTS = ("sign in", "cookies", "login required", "private video", "age")


def _friendly(message: str) -> str:
    """Переводит типовые жалобы yt-dlp на человеческий язык."""
    lowered = message.lower()
    if any(hint in lowered for hint in _COOKIE_HINTS):
        return (
            "Сайт просит авторизацию. Откройте «Настройки» → «Брать куки из браузера» "
            "и выберите тот браузер, где вы залогинены на этом сайте "
            f"(браузер при этом лучше закрыть). Ответ сайта: {message}"
        )
    return message


@router.post("/resolve")
async def resolve_link(payload: ProbeGalleryRequest) -> dict[str, Any]:
    """Готовит ссылку к предпросмотру: разбирает её и открывает поток."""
    try:
        return await streamproxy.resolve(payload.url)
    except (RuntimeError, ValueError, OSError) as exc:
        raise HTTPException(422, _friendly(str(exc))) from exc


@router.post("/probe")
async def probe_link(payload: ProbeGalleryRequest) -> dict[str, Any]:
    """Справка по ссылке до скачивания: название, длительность, обложка."""
    try:
        return await download.probe_url(payload.url)
    except (RuntimeError, ValueError, OSError) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/gallery")
async def probe_gallery(payload: ProbeGalleryRequest) -> dict[str, Any]:
    """Список картинок в посте — чтобы выбрать нужные до скачивания."""
    try:
        items = await download.probe_gallery(payload.url)
    except (RuntimeError, ValueError, OSError) as exc:
        raise HTTPException(422, str(exc)) from exc
    return {
        "url": payload.url,
        "host": download.host_of(payload.url),
        "items": items,
        "count": len(items),
    }

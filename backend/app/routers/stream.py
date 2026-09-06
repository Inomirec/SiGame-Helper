"""Прокси удалённого видеопотока для предпросмотра до скачивания."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from ..core import streamproxy

router = APIRouter(prefix="/api/stream", tags=["stream"])

#: Заголовки источника, которые имеет смысл передать браузеру.
_PASS_THROUGH = {
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "last-modified",
    "etag",
}


@router.get("/{token}")
async def proxy(token: str, request: Request) -> Response:
    """Отдаёт браузеру чужой поток от нашего имени, сохраняя перемотку."""
    stream = streamproxy.get(token)
    if not stream:
        raise HTTPException(404, "Ссылка на поток устарела — разберите её заново")

    try:
        response, headers, status = streamproxy.open_upstream(
            stream, request.headers.get("range")
        )
    except OSError as exc:
        raise HTTPException(502, f"Источник недоступен: {exc}") from exc

    if response is None:
        # Источник ответил ошибкой — передаём её как есть, без тела.
        return Response(status_code=status)

    forwarded = {
        key: value for key, value in headers.items() if key.lower() in _PASS_THROUGH
    }
    forwarded.setdefault("Accept-Ranges", "bytes")
    forwarded["Cache-Control"] = "no-store"

    return StreamingResponse(
        streamproxy.iter_response(response),
        status_code=status,
        headers=forwarded,
        media_type=forwarded.get("content-type") or forwarded.get("Content-Type") or "video/mp4",
    )

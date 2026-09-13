"""Прокси удалённого видеопотока для предпросмотра до скачивания."""

from __future__ import annotations

import asyncio

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

    range_header = request.headers.get("range")

    # Ходить за файлом синхронно прямо здесь нельзя: пока источник думает,
    # сервер не отвечает вообще никому. Именно из-за этого «разбор ссылки»
    # мог висеть минуту, стоило подтормозить одному запросу за куском видео.
    try:
        response, headers, status = await asyncio.to_thread(
            streamproxy.open_upstream, stream, range_header
        )
    except OSError as exc:
        raise HTTPException(502, f"Источник недоступен: {exc}") from exc

    # 403 обычно значит не «нельзя», а «ссылка протухла»: у YouTube она живёт
    # считаные часы. Добываем её заново и пробуем ещё раз — человеку об этом
    # знать незачем.
    if response is None and status in (403, 410) and await streamproxy.refresh(stream):
        try:
            response, headers, status = await asyncio.to_thread(
                streamproxy.open_upstream, stream, range_header
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
        streamproxy.iter_response(stream, response, headers),
        status_code=status,
        headers=forwarded,
        media_type=forwarded.get("content-type") or forwarded.get("Content-Type") or "video/mp4",
    )

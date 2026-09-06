"""Шина событий: один канал SSE, через который сервер шлёт фронтенду прогресс.

Каждый подключённый клиент получает собственную очередь. Если клиент
не успевает читать (например, вкладка свёрнута), очередь ограничена, и
самые старые события отбрасываются — прогресс всё равно перезаписывается
следующим сообщением.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from typing import Any, AsyncIterator

#: Сколько событий держим в буфере одного клиента.
_QUEUE_SIZE = 512


class EventBus:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[str]] = set()
        self._lock = asyncio.Lock()

    async def subscribe(self) -> asyncio.Queue[str]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=_QUEUE_SIZE)
        async with self._lock:
            self._subscribers.add(queue)
        return queue

    async def unsubscribe(self, queue: asyncio.Queue[str]) -> None:
        async with self._lock:
            self._subscribers.discard(queue)

    def publish(self, event: str, payload: dict[str, Any]) -> None:
        """Отправляет событие всем подписчикам. Безопасно вызывать из любого места."""
        message = json.dumps(
            {"event": event, "ts": time.time(), "data": payload},
            ensure_ascii=False,
            default=str,
        )
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                # Освобождаем место, выбрасывая самое старое событие.
                with contextlib.suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
                with contextlib.suppress(asyncio.QueueFull):
                    queue.put_nowait(message)

    async def stream(self) -> AsyncIterator[str]:
        """Генератор для ``StreamingResponse`` в формате text/event-stream."""
        queue = await self.subscribe()
        try:
            # Сразу подтверждаем соединение, чтобы фронтенд снял «Подключение…».
            yield _sse({"event": "hello", "ts": time.time(), "data": {}})
            while True:
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=20.0)
                except asyncio.TimeoutError:
                    # Keep-alive комментарий: не даёт прокси/браузеру закрыть поток.
                    yield ": keep-alive\n\n"
                    continue
                yield f"data: {message}\n\n"
        finally:
            await self.unsubscribe(queue)


def _sse(obj: dict[str, Any]) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


bus = EventBus()

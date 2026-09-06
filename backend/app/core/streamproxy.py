"""Проигрывание удалённого видео до скачивания.

yt-dlp умеет отдать прямую ссылку на поток, но браузер по ней обычно ничего
не покажет: чужой сайт не разрешает воспроизведение с нашей страницы (CORS),
а многие плееры дополнительно проверяют заголовок Referer. Поэтому поток
идёт через наш же сервер — он подставляет нужные заголовки и честно
поддерживает Range, чтобы работала перемотка.

Ссылки не принимаются от браузера напрямую: сначала ``resolve`` разбирает
пользовательскую страницу и кладёт результат в реестр, а фронтенд получает
только короткий токен. Так через прокси нельзя попросить произвольный адрес.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Iterator

from . import binaries, download
from .download import _common_args

#: Сколько живёт выданный токен потока.
TOKEN_TTL = 6 * 3600

#: Размер блока при перекачке.
CHUNK = 256 * 1024

#: Предпросмотр не обязан быть в исходном качестве — берём поток полегче,
#: чтобы перемотка не тормозила.
PREVIEW_MAX_HEIGHT = 720


@dataclass(slots=True)
class Stream:
    url: str
    headers: dict[str, str] = field(default_factory=dict)
    created: float = field(default_factory=time.time)
    title: str = ""
    duration: float | None = None


_registry: dict[str, Stream] = {}


def _prune() -> None:
    deadline = time.time() - TOKEN_TTL
    for token in [t for t, s in _registry.items() if s.created < deadline]:
        _registry.pop(token, None)


def register(stream: Stream) -> str:
    _prune()
    token = secrets.token_urlsafe(16)
    _registry[token] = stream
    return token


def get(token: str) -> Stream | None:
    _prune()
    return _registry.get(token)


def _pick_progressive(formats: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Ищет дорожку, где видео и звук уже вместе.

    Раздельные потоки (как у YouTube) один тег <video> не проиграет, а HLS
    браузер без сторонней библиотеки тоже не понимает. Поэтому для
    предпросмотра годится только «слитный» файл по обычному HTTP.
    """
    #: Контейнеры, которые встроенный плеер браузера открывает сам.
    playable_ext = {"mp4", "m4v", "webm", "mov", "ogv"}

    candidates: list[dict[str, Any]] = []
    for item in formats:
        protocol = str(item.get("protocol") or "")
        if not protocol.startswith("http") or "m3u8" in protocol or "dash" in protocol:
            continue
        if not item.get("url"):
            continue

        vcodec = item.get("vcodec")
        acodec = item.get("acodec")
        if vcodec == "none" or acodec == "none":
            # Явно раздельные дорожки: один тег <video> их не сведёт.
            continue
        if vcodec in (None, "unknown") or acodec in (None, "unknown"):
            # Обычная прямая ссылка на файл: yt-dlp не разбирал его содержимое,
            # но по расширению видно, что браузер справится.
            if str(item.get("ext") or "").lower() not in playable_ext:
                continue

        candidates.append(item)

    if not candidates:
        return None

    def rank(item: dict[str, Any]) -> tuple[int, int]:
        height = item.get("height") or 0
        # Сначала то, что не выше потолка предпросмотра, — от большего к меньшему.
        within = 0 if height <= PREVIEW_MAX_HEIGHT else 1
        return (within, -height if within == 0 else height)

    candidates.sort(key=rank)
    return candidates[0]


async def resolve(url: str) -> dict[str, Any]:
    """Разбирает ссылку и, если получится, готовит поток для предпросмотра."""
    args = [
        binaries.require("yt-dlp"),
        "--dump-single-json",
        "--no-warnings",
        "--ignore-config",
        "--no-playlist",
        *_common_args(url),
        url,
    ]
    process = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=binaries.CREATE_NO_WINDOW,
        env=binaries.subprocess_env(),
    )
    out, err = await process.communicate()
    if process.returncode != 0:
        message = err.decode("utf-8", "replace").strip()
        raise RuntimeError(message.splitlines()[-1] if message else "yt-dlp не понял ссылку")

    data = json.loads(out.decode("utf-8", "replace") or "{}")
    formats = data.get("formats") or []
    chosen = _pick_progressive(formats)

    result: dict[str, Any] = {
        "url": url,
        "title": data.get("title") or url,
        "uploader": data.get("uploader") or data.get("channel"),
        "duration": data.get("duration"),
        "thumbnail": data.get("thumbnail"),
        "extractor": data.get("extractor_key"),
        "previewToken": None,
        "previewHeight": None,
        "previewNote": None,
    }

    if not chosen:
        has_hls = any("m3u8" in str(f.get("protocol") or "") for f in formats)
        result["previewNote"] = (
            "У этой ссылки нет слитного потока, который открывает браузер"
            + (" (только HLS)." if has_hls else ".")
            + " Скачайте черновик — и размечайте отрезок в обычном редакторе."
        )
        return result

    headers = {
        str(key): str(value)
        for key, value in (chosen.get("http_headers") or data.get("http_headers") or {}).items()
    }
    # Прокси ходит за файлом сам, поэтому Referer нужен и ему.
    referer = download.referer_for(url)
    if referer:
        headers.setdefault("Referer", referer)
    token = register(
        Stream(
            url=str(chosen["url"]),
            headers=headers,
            title=str(result["title"]),
            duration=data.get("duration"),
        )
    )
    result["previewToken"] = token
    result["previewHeight"] = chosen.get("height")
    return result


from .certs import ipv4_opener


def open_upstream(stream: Stream, range_header: str | None) -> tuple[Any, dict[str, str], int]:
    """Открывает соединение с источником, пробрасывая Range."""
    headers = dict(stream.headers)
    headers.setdefault("User-Agent", "Mozilla/5.0")
    # Заголовки от yt-dlp предназначены для загрузки страницы, а не файла:
    # с ними часть CDN отдаёт HTML вместо видео.
    headers.pop("Sec-Fetch-Mode", None)
    headers["Accept"] = "*/*"
    if range_header:
        headers["Range"] = range_header

    request = urllib.request.Request(stream.url, headers=headers)
    try:
        response = ipv4_opener().open(request, timeout=30)
    except urllib.error.HTTPError as exc:
        # 416 и подобное осмысленно передать клиенту как есть.
        return None, dict(exc.headers or {}), exc.code
    return response, dict(response.headers), response.status


def iter_response(response: Any) -> Iterator[bytes]:
    """Перекачивает тело ответа блоками."""
    try:
        while True:
            chunk = response.read(CHUNK)
            if not chunk:
                break
            yield chunk
    finally:
        response.close()

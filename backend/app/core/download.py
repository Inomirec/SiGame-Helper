"""Скачивание медиа: yt-dlp для видео/аудио, gallery-dl для картинок из соцсетей.

Разделение неслучайное: yt-dlp прекрасно тащит видео и звук, но посты
X/Twitter и Instagram с несколькими картинками он разбирает плохо. gallery-dl
создан ровно для этого и умеет отдавать список файлов заранее (``-j``),
чтобы пользователь мог выбрать нужные кадры до скачивания.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .. import config
from . import binaries
from .jobs import JobContext

#: Маркер, по которому мы отличаем строки прогресса от обычного вывода yt-dlp.
_MARK = "[SGH]"
_PROGRESS_TEMPLATE = (
    "download:" + _MARK +
    "%(progress.downloaded_bytes)s;%(progress.total_bytes)s;"
    "%(progress.total_bytes_estimate)s;%(progress.speed)s;%(progress.eta)s;"
    "%(progress.status)s"
)

#: Домены, где почти всегда лежат картинки, а не видео.
_GALLERY_HOSTS = {
    "x.com", "twitter.com", "instagram.com", "pixiv.net", "danbooru.donmai.us",
    "gelbooru.com", "deviantart.com", "artstation.com", "flickr.com",
    "imgur.com", "reddit.com", "redd.it", "tumblr.com", "pinterest.com",
    "vk.com", "boosty.to",
}


def host_of(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower().removeprefix("www.")
    except ValueError:
        return ""


def looks_like_gallery(url: str) -> bool:
    host = host_of(url)
    return any(host == item or host.endswith("." + item) for item in _GALLERY_HOSTS)


def _to_float(value: str) -> float | None:
    if not value or value in {"NA", "None", "N/A"}:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def referer_for(url: str) -> str | None:
    """Заголовок Referer для прямых ссылок на файлы.

    Часть видеохостингов (тот же Sibnet) отдаёт 403, если запрос пришёл
    «ниоткуда». Подставляем адрес самого сайта — именно так ведёт себя
    браузер, когда файл играется во встроенном плеере.
    """
    try:
        parts = urlparse(url)
    except ValueError:
        return None
    if not parts.scheme or not parts.hostname:
        return None
    # Ссылке на обычную страницу Referer не нужен — там его выставит экстрактор.
    if not Path(parts.path).suffix:
        return None
    return f"{parts.scheme}://{parts.hostname}/"


def is_network_failure(text: str) -> str | None:
    """Похожа ли ошибка загрузчика на обрыв связи, а не на неподходящую ссылку.

    Нужно, чтобы не подсовывать gallery-dl видеоссылку только потому, что
    у человека не открылся сервер видео: он ответит «Unsupported URL»
    и запутает и без того длинный лог.
    """
    low = text.lower()
    for mark in (
        "timed out", "connection reset", "recv failure", "operation too slow",
        "connection aborted", "remotedisconnected", "connection refused",
        "temporary failure in name resolution", "giving up after",
    ):
        if mark in low:
            return mark
    return None


def _common_args(url: str | None = None) -> list[str]:
    """Общие флаги, зависящие от настроек (куки, прокси, Referer)."""
    settings = config.load().download
    args: list[str] = []
    if settings.proxy_enabled and settings.proxy:
        args += ["--proxy", settings.proxy]
    else:
        # Без прокси идём строго напрямую и только по IPv4.
        #
        # Обходы блокировок вроде Zapret и GoodbyeDPI перехватывают трафик
        # на уровне пакетов и умеют только IPv4. Если googlevideo.com
        # отвечает по IPv6, обход к нему не применяется: страница YouTube
        # открывается, а сам видеофайл виснет на «Read timed out».
        #
        # Пустой --proxy заставляет yt-dlp игнорировать системный прокси,
        # который иначе может увести трафик мимо обхода.
        args += ["--proxy", "", "--force-ipv4"]
    if settings.cookies_from_browser:
        args += ["--cookies-from-browser", settings.cookies_from_browser]
    if url:
        referer = referer_for(url)
        if referer:
            args += ["--referer", referer]
    return args


def _mark(seconds: float | None, fallback: str) -> str:
    """Время для имени файла: 95.5 -> «1-35»."""
    if seconds is None:
        return fallback
    total = int(round(seconds))
    return f"{total // 60}-{total % 60:02d}"


def section_template(template: str, start: float | None, end: float | None) -> str:
    """Дописывает в шаблон имени границы отрезка.

    Без этого два куска одного ролика метят в один и тот же файл: yt-dlp
    видит, что он уже скачан, и молча ничего не делает. Человек при этом
    уверен, что качает второй фрагмент.
    """
    mark = f" [{_mark(start, '0-00')}..{_mark(end, 'конец')}]"
    tail = ".%(ext)s"
    if template.endswith(tail):
        return template[: -len(tail)] + mark + tail
    return template + mark


def build_ytdlp_args(
    url: str,
    output_dir: Path,
    *,
    mode: str,
    max_height: int,
    audio_format: str,
    print_file: Path,
    section: tuple[float | None, float | None] | None = None,
) -> list[str]:
    """Аргументы yt-dlp для одной ссылки."""
    settings = config.load().download
    args = [
        binaries.require("yt-dlp"),
        "--newline",
        "--no-color",
        "--progress",
        "--progress-template", _PROGRESS_TEMPLATE,
        "--no-warnings",
        "--ignore-config",
        # Windows не любит длинные имена и запрещённые символы.
        "--windows-filenames",
        "--trim-filenames", "180",
        # Фильтры провайдеров чаще не блокируют наглухо, а «подвешивают»
        # соединение: одна попытка из нескольких проходит. Поэтому лучше
        # быстро сдаваться и пробовать снова, чем ждать по 20 секунд:
        # раньше пять попыток съедали полторы минуты, теперь за то же время
        # их будет вдвое больше.
        "--socket-timeout", "8",
        "--retries", "10",
        "--fragment-retries", "15",
        # Фильтры провайдеров душат именно длинные соединения: файл начинает
        # качаться и замирает. Отдельный запрос на каждые 10 МБ переживает
        # это лучше — оборвался кусок, повторяется только он.
        "--http-chunk-size", "10M",
        "--concurrent-fragments", "4",
        "-P", str(output_dir),
        "-o", (
            section_template(settings.filename_template, *section)
            if section
            else settings.filename_template
        ),
        # Итоговые пути пишем в отдельный файл, чтобы не мешать их с прогрессом.
        "--print-to-file", "after_move:filepath", str(print_file),
        "--no-simulate",
    ]
    args += _common_args(url)

    if section:
        start, end = section
        # yt-dlp скачает только нужный кусок, а не весь файл. Ключевые кадры
        # на границах нужны, чтобы срез не начинался с рассыпающейся картинки.
        left = f"{start:.3f}" if start is not None else "0"
        right = f"{end:.3f}" if end is not None else "inf"
        args += ["--download-sections", f"*{left}-{right}", "--force-keyframes-at-cuts"]

    if settings.download_playlists:
        args += ["--yes-playlist"]
        if settings.playlist_limit:
            args += ["--playlist-items", f"1:{settings.playlist_limit}"]
    else:
        args += ["--no-playlist"]

    if mode == "audio":
        args += ["-f", "bestaudio/best", "-x"]
        if audio_format != "best":
            args += ["--audio-format", audio_format]
        args += ["--audio-quality", "0"]
        if settings.embed_metadata:
            args += ["--embed-metadata", "--embed-thumbnail"]
    else:
        height_filter = f"[height<={max_height}]" if max_height else ""
        if settings.force_mp4:
            # Дорожки, которые штатно живут в MP4 (H.264/AV1 + AAC), — гарантия
            # того, что файл откроется во встроенном плеере со звуком.
            selector = (
                f"bv*[ext=mp4]{height_filter}+ba[ext=m4a]/"
                f"bv*{height_filter}+ba/b{height_filter}/b"
            )
            args += ["-f", selector, "--merge-output-format", "mp4"]
            # Если исходник всё же оказался в другом контейнере — переупакуем
            # без перекодирования.
            args += ["--remux-video", "mp4"]
        else:
            selector = f"bv*{height_filter}+ba/b{height_filter}/b"
            args += ["-f", selector]
        if settings.embed_metadata:
            args += ["--embed-metadata"]

    args.append(url)
    return args


def _readable_args(args: list[str]) -> str:
    """Строка запуска для журнала: без пути к самому загрузчику и без плюмбинга.

    Служебные ключи (шаблон прогресса, временный файл с путями) занимают
    полстроки и человеку ничего не говорят, поэтому их прячем. Всё, что
    влияет на результат — сеть, куки, формат, отрезок — остаётся.
    """
    # Ключ -> сколько значений за ним съесть.
    hidden = {
        "--progress-template": 1, "-P": 1, "-o": 1, "--trim-filenames": 1,
        "--print-to-file": 2,
    }
    parts: list[str] = []
    skip = 0
    for item in args[1:]:
        if skip:
            skip -= 1
            continue
        if item in hidden:
            skip = hidden[item]
            continue
        parts.append(f'"{item}"' if " " in item else item or '""')
    return " ".join(parts)


async def run_ytdlp(
    ctx: JobContext,
    url: str,
    output_dir: Path,
    *,
    mode: str = "video",
    max_height: int = 0,
    audio_format: str = "opus",
    section: tuple[float | None, float | None] | None = None,
) -> list[Path]:
    """Скачивает ссылку через yt-dlp, отдавая прогресс в задачу."""
    output_dir.mkdir(parents=True, exist_ok=True)
    handle, tmp_name = tempfile.mkstemp(suffix=".txt", prefix="sgh-dl-")
    os.close(handle)
    print_file = Path(tmp_name)

    args = build_ytdlp_args(
        url, output_dir,
        mode=mode, max_height=max_height,
        audio_format=audio_format, print_file=print_file,
        section=section,
    )
    # Пишем команду целиком, а не только ссылку: когда что-то не качается,
    # первый вопрос — с какими флагами запустился загрузчик. Без этой строки
    # по журналу нельзя отличить старую версию программы от новой.
    ctx.log("$ yt-dlp " + _readable_args(args))

    process = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=binaries.CREATE_NO_WINDOW,
        env=binaries.subprocess_env(),
    )
    ctx.track(process)

    async def read_stdout() -> None:
        assert process.stdout is not None
        async for raw in process.stdout:
            line = raw.decode("utf-8", "replace").rstrip()
            if not line:
                continue
            if line.startswith(_MARK):
                _handle_progress(ctx, line[len(_MARK):])
            else:
                ctx.log(line)

    errors: list[str] = []

    async def read_stderr() -> None:
        assert process.stderr is not None
        async for raw in process.stderr:
            line = raw.decode("utf-8", "replace").rstrip()
            if line:
                errors.append(line)
                ctx.log(line)

    try:
        await asyncio.gather(read_stdout(), read_stderr())
        code = await process.wait()
    finally:
        ctx.untrack(process)

    files: list[Path] = []
    try:
        for line in print_file.read_text("utf-8", errors="replace").splitlines():
            candidate = Path(line.strip())
            if line.strip() and candidate.exists():
                files.append(candidate)
    except OSError:
        pass
    finally:
        print_file.unlink(missing_ok=True)

    if code != 0 and not files:
        tail = "\n".join(errors[-4:]) or f"yt-dlp завершился с кодом {code}"
        raise RuntimeError(tail)
    return files


def explain_failure(text: str) -> str:
    """Переводит типовые ошибки загрузчиков на человеческий язык.

    Пользователю без разбора в сетях строка вида «HTTPSConnectionPool(...):
    Read timed out» ничего не говорит и выглядит как поломка программы.
    Чаще всего это провайдер: сам сайт отвечает, а сервер с видеофайлами
    недоступен.
    """
    low = text.lower()

    blocked_host = any(
        host in low for host in ("googlevideo.com", "ytimg.com", "youtube.com")
    )
    if blocked_host and is_network_failure(text):
        return (
            "YouTube не отдаёт сам видеофайл: сайт отвечает, а сервер с видео — нет.\n"
            "Это блокировка у провайдера, и программа обойти её не может.\n\n"
            "Что делать:\n"
            "  1. Включить VPN — помогает всегда.\n"
            "  2. Либо прописать прокси в настройках программы.\n"
            "  3. Если пользуетесь Zapret или GoodbyeDPI — попробуйте у них "
            "другую стратегию обхода: часть роликов проходит не при всякой.\n\n"
            "На другие сайты это не влияет: VK, Rutube и остальные качаются "
            "как обычно.\n\n"
            + text
        )

    if "unsupported url" in low and "gallery-dl" in low:
        return (
            "Это ссылка на видео, а не на пост с картинками.\n"
            "Выберите режим «Видео» вместо «Картинки» и попробуйте снова.\n\n"
            + text
        )

    return text


def _handle_progress(ctx: JobContext, payload: str) -> None:
    parts = payload.split(";")
    if len(parts) < 6:
        return
    downloaded = _to_float(parts[0]) or 0.0
    total = _to_float(parts[1]) or _to_float(parts[2])
    speed = _to_float(parts[3])
    eta = _to_float(parts[4])
    status = parts[5]

    if status == "finished":
        ctx.progress(0.98, "Постобработка (склейка дорожек)")
        return

    ratio = (downloaded / total) if total else 0.0
    bits: list[str] = []
    if speed:
        bits.append(f"{speed / 1024 / 1024:.1f} МБ/с")
    if eta:
        bits.append(f"осталось {int(eta)} с")
    suffix = " · ".join(bits)
    # 0.95 — потолок для стадии скачивания: остаток отдан склейке и ремуксу.
    ctx.progress(min(ratio, 1.0) * 0.95, f"Скачивание{' · ' + suffix if suffix else ''}")


async def probe_url(url: str) -> dict[str, Any]:
    """Быстрая справка о ссылке: название, длительность, обложка, тип."""
    args = [
        binaries.require("yt-dlp"),
        "--dump-single-json",
        "--no-warnings",
        "--ignore-config",
        "--no-playlist",
        "--flat-playlist",
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
        raise RuntimeError(
            err.decode("utf-8", "replace").strip().splitlines()[-1]
            if err else "yt-dlp не смог разобрать ссылку"
        )

    data = json.loads(out.decode("utf-8", "replace") or "{}")
    return {
        "url": url,
        "title": data.get("title") or url,
        "uploader": data.get("uploader") or data.get("channel"),
        "duration": data.get("duration"),
        "thumbnail": data.get("thumbnail"),
        "extractor": data.get("extractor_key"),
        "isPlaylist": data.get("_type") == "playlist",
        "entries": len(data.get("entries") or []) if data.get("entries") else 0,
        "hasVideo": any(
            f.get("vcodec") not in (None, "none")
            for f in (data.get("formats") or [])
        ),
    }


# --- gallery-dl ---------------------------------------------------------

async def probe_gallery(url: str) -> list[dict[str, Any]]:
    """Список файлов в посте/галерее без скачивания."""
    args = [
        binaries.require("gallery-dl"),
        "--dump-json",
        "--quiet",
        *_gallery_common_args(),
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
    if process.returncode != 0 and not out:
        message = err.decode("utf-8", "replace").strip()
        raise RuntimeError(message.splitlines()[-1] if message else "gallery-dl не смог открыть ссылку")

    try:
        payload = json.loads(out.decode("utf-8", "replace") or "[]")
    except json.JSONDecodeError:
        return []

    items: list[dict[str, Any]] = []
    index = 0
    for entry in payload:
        # Формат gallery-dl: [3, "<url>", {...метаданные}] для каждого файла.
        if not isinstance(entry, list) or len(entry) < 2 or entry[0] != 3:
            continue
        index += 1
        meta = entry[2] if len(entry) > 2 and isinstance(entry[2], dict) else {}
        file_url = entry[1]
        items.append(
            {
                "index": index,
                "url": file_url,
                "extension": meta.get("extension") or Path(str(file_url)).suffix.lstrip("."),
                "width": meta.get("width"),
                "height": meta.get("height"),
                "filename": meta.get("filename"),
                "author": (meta.get("author") or {}).get("name") if isinstance(meta.get("author"), dict) else meta.get("author"),
                "description": meta.get("content") or meta.get("description"),
            }
        )
    return items


def _gallery_common_args() -> list[str]:
    settings = config.load().download
    args: list[str] = []
    if settings.proxy_enabled and settings.proxy:
        args += ["--proxy", settings.proxy]
    if settings.cookies_from_browser:
        args += ["--cookies-from-browser", settings.cookies_from_browser]
    return args


async def run_gallery_dl(
    ctx: JobContext,
    url: str,
    output_dir: Path,
    *,
    selection: list[int] | None = None,
) -> list[Path]:
    """Скачивает картинки из поста. ``selection`` — номера с 1, как в предпросмотре."""
    output_dir.mkdir(parents=True, exist_ok=True)
    args = [
        binaries.require("gallery-dl"),
        "--directory", str(output_dir),
        "--no-part",
        *_gallery_common_args(),
    ]
    if selection:
        args += ["--range", ",".join(str(i) for i in sorted(set(selection)))]
    args.append(url)

    # Запоминаем содержимое папки, чтобы отличить новые файлы от старых.
    before = {p for p in output_dir.rglob("*") if p.is_file()}

    ctx.log(f"$ gallery-dl {url}")
    process = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=binaries.CREATE_NO_WINDOW,
        env=binaries.subprocess_env(),
    )
    ctx.track(process)

    files: list[Path] = []
    expected = len(selection) if selection else 0

    async def read_stdout() -> None:
        assert process.stdout is not None
        async for raw in process.stdout:
            line = raw.decode("utf-8", "replace").rstrip()
            if not line:
                continue
            ctx.log(line)
            # gallery-dl печатает путь каждого сохранённого файла отдельной строкой.
            candidate = Path(re.sub(r"^# ", "", line).strip())
            if candidate.exists() and candidate.is_file():
                files.append(candidate)
                ratio = len(files) / expected if expected else min(len(files) / 10, 0.9)
                ctx.progress(min(ratio, 0.95), f"Скачано файлов: {len(files)}")

    errors: list[str] = []

    async def read_stderr() -> None:
        assert process.stderr is not None
        async for raw in process.stderr:
            line = raw.decode("utf-8", "replace").rstrip()
            if line:
                errors.append(line)
                ctx.log(line)

    try:
        await asyncio.gather(read_stdout(), read_stderr())
        code = await process.wait()
    finally:
        ctx.untrack(process)

    if not files:
        # На часть сайтов gallery-dl молча кладёт файлы, не печатая пути, —
        # добираем их сравнением снимков папки.
        files = sorted({p for p in output_dir.rglob("*") if p.is_file()} - before)

    if code != 0 and not files:
        tail = "\n".join(errors[-4:]) or f"gallery-dl завершился с кодом {code}"
        raise RuntimeError(tail)
    return files

"""Склейка всего вместе: превращает запросы API в фоновые задачи."""

from __future__ import annotations

import asyncio
import json
import re
import time
from pathlib import Path

from .. import config
from ..models import (
    DownloadItem,
    DownloadRequest,
    ExportRequest,
    FrameGrabRequest,
    RawCommandRequest,
)
from . import binaries, download, encode, fsutil, images, presets, toolchain, trash
from .events import bus
from .jobs import Job, JobContext, manager, run_ffmpeg
from .probe import probe


# --- экспорт / сжатие ---------------------------------------------------

def resolve_output(request: ExportRequest, extension: str) -> Path:
    source = Path(request.source)
    directory = (
        Path(request.output_dir).expanduser()
        if request.output_dir
        else fsutil.default_output_dir(source, request.kind)
    )
    stem = request.output_name or f"{source.stem}{request.suffix}"
    stem = fsutil.sanitize_name(stem, fallback=source.stem or "output")
    candidate = directory / f"{stem}{extension}"
    if candidate.resolve() == source.resolve():
        candidate = directory / f"{stem}_1{extension}"
    return fsutil.unique_path(candidate, overwrite=request.overwrite)


async def _measure_loudness(ctx: JobContext, request: ExportRequest) -> dict[str, str] | None:
    """Первый проход loudnorm: снимаем реальные показатели громкости."""
    args = encode.build_loudnorm_probe(request)
    ctx.progress(0.02, "Анализ громкости (1/2)")

    process = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=binaries.CREATE_NO_WINDOW,
        env=binaries.subprocess_env(),
    )
    ctx.track(process)
    try:
        _, err = await process.communicate()
    finally:
        ctx.untrack(process)

    text = err.decode("utf-8", "replace")
    match = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", text, re.DOTALL)
    if not match:
        ctx.log("Не удалось снять показатели громкости, используется одиночный проход")
        return None
    try:
        return {k: str(v) for k, v in json.loads(match.group(0)).items()}
    except json.JSONDecodeError:
        return None


def submit_export(request: ExportRequest) -> Job:
    """Ставит один файл в очередь обработки."""
    source = fsutil.safe_path(request.source)
    request.source = str(source)

    async def runner(ctx: JobContext) -> None:
        size_before = source.stat().st_size
        started = time.monotonic()
        ctx.meta(sizeBefore=size_before)

        if request.kind == "image":
            extension = images.EXTENSIONS[request.image.format]
            output = resolve_output(request, extension)
            ctx.job.output = str(output)

            async def report(value: float, message: str) -> None:
                ctx.progress(value, message)

            result = await images.compress(source, output, request.image, report)
            ctx.meta(
                sizeAfter=result.size,
                width=result.width,
                height=result.height,
                qualityUsed=result.quality_used,
            )
        else:
            info = await probe(source)
            extension = encode.container_extension(request, info)
            output = resolve_output(request, extension)
            ctx.job.output = str(output)
            output.parent.mkdir(parents=True, exist_ok=True)

            measured = None
            base = 0.0
            if request.audio.loudnorm and request.audio.loudnorm_two_pass and not request.stream_copy:
                measured = await _measure_loudness(ctx, request)
                base = 0.35 if measured else 0.0

            duration = request.trim.duration
            if duration is None:
                total = info.duration or 0.0
                duration = max(total - (request.trim.start or 0.0), 0.0)
                if request.trim.end is not None:
                    duration = request.trim.end - (request.trim.start or 0.0)
            # Ускорение сокращает итоговую длительность — прогресс считаем по ней.
            tempo = request.video.tempo if request.kind == "video" else 1.0
            effective = duration / tempo if tempo else duration

            args = encode.build_command(request, output, info, measured=measured)
            ctx.log("$ " + encode.to_display_string(args))
            # Смещение и скорость нужны окну «До и после»: результат обрезан
            # и может идти быстрее, поэтому напрямую с исходником он
            # не совпадает — без этих чисел половинки разъезжаются.
            ctx.meta(
                command=encode.to_display_string(args),
                trimStart=request.trim.start or 0.0,
                tempo=tempo or 1.0,
            )

            await run_ffmpeg(
                ctx, args,
                total_duration=effective or None,
                base=base, span=1.0 - base,
                label="Кодирование" if not request.stream_copy else "Нарезка",
            )
            ctx.meta(sizeAfter=output.stat().st_size if output.exists() else 0)

        # Исходник убираем только после того, как результат оказался на диске
        # и весит больше нуля: иначе неудачная задача унесла бы оригинал.
        size_after = ctx.job.meta.get("sizeAfter") or 0
        if request.replace_original and size_after and output.exists():
            # В корзину, а не насовсем: галочка запоминается между файлами,
            # и человек легко забудет, что она включена.
            try:
                trash.to_trash(source)
                ctx.log(f"Исходник убран в корзину: {source.name}")
                # Пометка для очереди: сравнивать «до и после» больше не с чем,
                # и кнопку сравнения у такой задачи показывать нечестно.
                ctx.meta(sourceRemoved=True)
            except OSError as exc:
                # Обработка уже прошла, результат на месте — ронять из-за
                # занятого исходника всю задачу незачем.
                ctx.log(f"Исходник не удалось убрать в корзину: {exc}")

        if size_before and size_after:
            ctx.meta(
                ratio=round(size_after / size_before, 4),
                saved=size_before - size_after,
            )
        ctx.meta(elapsed=round(time.monotonic() - started, 1))
        ctx.progress(1.0, "Готово")
        bus.publish("library.changed", {"path": str(Path(ctx.job.output or "").parent)})

    label = request.preset_label or encode.describe(request)["summary"]
    return manager.submit(
        kind="image" if request.kind == "image" else "encode",
        title=source.name,
        runner=runner,
        pool="image" if request.kind == "image" else "encode",
        source=str(source),
        meta={"preset": label, "kind": request.kind},
    )


# --- команда, отредактированная вручную ---------------------------------

def submit_raw_command(request: RawCommandRequest) -> Job:
    """Запускает команду ffmpeg, которую пользователь поправил сам.

    Запускать разрешено только наш же ffmpeg: строка приходит из интерфейса,
    но подменять в ней исполняемый файл на что угодно — плохая идея даже для
    локальной программы.
    """
    import shlex

    try:
        args = shlex.split(request.command.strip())
    except ValueError as exc:
        raise ValueError(f"Не удалось разобрать команду: {exc}") from exc

    if len(args) < 2:
        raise ValueError("Команда слишком короткая")

    first = Path(args[0]).name.lower()
    if first not in {"ffmpeg", "ffmpeg.exe"}:
        raise ValueError(
            "Запускать можно только ffmpeg. Первым словом команды должен быть он."
        )

    # Подставляем найденный нами ffmpeg — путь в строке мог устареть.
    args[0] = binaries.ffmpeg()
    output = Path(args[-1])

    # Длительность из -t, если она есть: по ней считается прогресс.
    total: float | None = None
    if "-t" in args:
        try:
            total = float(args[args.index("-t") + 1])
        except (ValueError, IndexError):
            total = None

    async def runner(ctx: JobContext) -> None:
        output.parent.mkdir(parents=True, exist_ok=True)
        ctx.job.output = str(output)
        ctx.log("$ " + encode.to_display_string(args))

        source = Path(request.source) if request.source else None
        if source and source.exists():
            ctx.meta(sizeBefore=source.stat().st_size)

        # Свой -progress добавляем, только если пользователь его не оставил.
        command = list(args)
        if "-progress" not in command:
            command = command[:-1] + ["-progress", "pipe:1", "-nostats", command[-1]]

        await run_ffmpeg(ctx, command, total_duration=total, label="Ручная команда")

        if output.exists():
            ctx.meta(sizeAfter=output.stat().st_size)
        ctx.progress(1.0, "Готово")
        bus.publish("library.changed", {"path": str(output.parent)})

    return manager.submit(
        kind="encode",
        title=f"Ручная команда · {output.name}",
        runner=runner,
        pool="encode",
        source=request.source,
        meta={"preset": "команда отредактирована вручную"},
    )

# --- стоп-кадр из видео -------------------------------------------------

def submit_frame_grab(request: FrameGrabRequest) -> Job:
    """Сохраняет кадр из видео как есть, без сжатия.

    Кнопка нужна, чтобы забрать картинку из ролика — в том же разрешении и
    том же качестве, что и сам ролик. Если её потом нужно сжать, для этого
    есть обычная панель картинок: сжимать дважды подряд смысла нет.
    """
    source = fsutil.safe_path(request.source)

    async def runner(ctx: JobContext) -> None:
        directory = (
            Path(request.output_dir).expanduser()
            if request.output_dir
            else fsutil.default_output_dir(source, "image")
        )
        directory.mkdir(parents=True, exist_ok=True)

        stamp = f"{int(request.time // 60):02d}-{request.time % 60:05.2f}".replace(".", "_")
        stem = fsutil.sanitize_name(f"{source.stem}{request.suffix} {stamp}", fallback="кадр")
        output = fsutil.unique_path(directory / f"{stem}.png")
        ctx.job.output = str(output)

        ctx.progress(0.15, "Достаю кадр")
        args = [
            binaries.ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
            "-ss", f"{request.time:.3f}",
            "-i", str(source),
            "-frames:v", "1",
            "-c:v", "png",
            str(output),
        ]
        ctx.log("$ " + encode.to_display_string(args))
        process = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            creationflags=binaries.CREATE_NO_WINDOW,
            env=binaries.subprocess_env(),
        )
        ctx.track(process)
        try:
            _, err = await process.communicate()
        finally:
            ctx.untrack(process)

        if process.returncode != 0 or not output.exists():
            raise RuntimeError(
                err.decode("utf-8", "replace").strip()[:300] or "не удалось получить кадр"
            )

        info = await probe(output)
        stream = info.video if info else None
        ctx.meta(
            sizeAfter=output.stat().st_size,
            width=stream.width if stream else 0,
            height=stream.height if stream else 0,
        )
        ctx.progress(1.0, "Готово")
        bus.publish("library.changed", {"path": str(directory)})

    return manager.submit(
        kind="image",
        title=f"Кадр из «{source.name}»",
        runner=runner,
        pool="image",
        source=str(source),
        meta={"preset": "стоп-кадр · PNG", "kind": "image"},
    )


# --- скачивание ---------------------------------------------------------

def _download_dir(request: DownloadRequest) -> Path:
    """Куда качать: выбор человека важнее умолчания программы."""
    settings = config.load()
    if request.output_dir:
        return Path(request.output_dir).expanduser()
    if settings.download.directory:
        return Path(settings.download.directory).expanduser()
    return Path(settings.resolved_workspace()) / "Скачанное"


def submit_download(request: DownloadRequest, item: DownloadItem) -> Job:
    """Ставит одну ссылку в очередь скачивания."""
    base = _download_dir(request)
    url = item.url
    section = (item.start, item.end) if item.has_section else None

    # Раскладку по типам убрали: имена подпапок навязывались всем, а разложить
    # скачанное под свои нужды человек может и сам.
    target = base

    async def runner(ctx: JobContext) -> None:
        mode = request.mode
        if mode == "auto":
            mode = "images" if download.looks_like_gallery(url) else "video"

        files: list[Path] = []
        if mode == "images":
            try:
                files = await download.run_gallery_dl(
                    ctx, url, target, selection=request.selection
                )
            except RuntimeError as exc:
                if request.mode != "auto":
                    raise
                # В посте могло не быть картинок — пробуем как видео.
                ctx.log(f"gallery-dl: {exc}. Пробую yt-dlp…")
                try:
                    files = await download.run_ytdlp(
                        ctx, url, target,
                        mode="video", max_height=request.max_height,
                        audio_format=request.audio_format, section=section,
                    )
                except RuntimeError:
                    # Для таких ссылок главный загрузчик — gallery-dl, и
                    # рассказывать надо про его беду. Иначе человек видит
                    # «в посте нет видео» и ищет несуществующую проблему,
                    # хотя на самом деле сайт просил войти в аккаунт.
                    raise exc from None
        else:
            try:
                files = await download.run_ytdlp(
                    ctx, url, target,
                    mode=mode, max_height=request.max_height,
                    audio_format=request.audio_format, section=section,
                )
            except RuntimeError as exc:
                if request.mode != "auto" or download.is_network_failure(str(exc)):
                    raise
                ctx.log(f"yt-dlp: {exc}. Пробую gallery-dl…")
                files = await download.run_gallery_dl(
                    ctx, url, target, selection=request.selection
                )

        if not files:
            raise RuntimeError("Скачивание завершилось, но новых файлов не появилось")

        total = sum(f.stat().st_size for f in files if f.exists())
        ctx.job.output = str(files[0])
        ctx.meta(
            files=[str(f) for f in files],
            count=len(files),
            sizeAfter=total,
        )
        ctx.progress(1.0, f"Готово · {len(files)} файл(ов) · {fsutil.human_size(total)}")
        bus.publish("library.changed", {"path": str(target)})

        if request.auto_process_preset:
            _chain_processing(files, request.auto_process_preset)

    title = url
    if section:
        from ..core.encode import _fmt_time  # локально, чтобы не тянуть цикл импортов

        title = f"{url}  [{_fmt_time(item.start or 0)} — {_fmt_time(item.end) if item.end else 'конец'}]"

    return manager.submit(
        kind="download",
        title=title,
        runner=runner,
        pool="download",
        source=url,
        meta={
            "mode": request.mode,
            "target": str(target),
            "section": [item.start, item.end] if section else None,
        },
    )


def _chain_processing(files: list[Path], preset_id: str) -> None:
    """Автоматически ставит скачанные файлы в очередь сжатия."""
    preset = presets.get(preset_id)
    if not preset:
        return
    for file in files:
        kind = fsutil.media_kind(file)
        if kind == "other":
            continue
        if preset["kind"] != kind:
            continue
        payload = {"source": str(file), "kind": kind, "preset_label": preset["label"]}
        options = preset.get("options", {})
        for section in ("video", "audio", "image"):
            if section in options:
                payload[section] = options[section]
        if options.get("stream_copy"):
            payload["stream_copy"] = True
        submit_export(ExportRequest.model_validate(payload))


# --- установка инструментов ------------------------------------------------

def submit_ffmpeg_install() -> Job:
    """Скачивание и распаковку ffmpeg показываем обычной задачей в очереди."""

    async def runner(ctx: JobContext) -> None:
        async def report(value: float, message: str) -> None:
            ctx.progress(value, message)

        result = await toolchain.install_ffmpeg(report)
        ctx.meta(**result)
        ctx.job.output = str(result.get("path") or "")
        ctx.log(f"ffmpeg {result.get('version')} -> {result.get('path')}")

    return manager.submit(
        kind="download",
        title="Установка ffmpeg",
        runner=runner,
        pool="download",
        meta={"tool": "ffmpeg"},
    )


def submit_deno_install() -> Job:
    """Ставит Deno — движок JavaScript, без которого YouTube не отдаёт ссылки."""

    async def runner(ctx: JobContext) -> None:
        async def report(value: float, message: str) -> None:
            ctx.progress(value, message)

        result = await toolchain.install_deno(report)
        ctx.meta(**{key: value for key, value in result.items() if key != "files"})
        ctx.job.output = str(result.get("path") or "")
        ctx.log(f"Deno {result.get('version')} -> {result.get('path')}")

    return manager.submit(
        kind="download",
        title="Установка Deno (нужен для YouTube)",
        runner=runner,
        pool="download",
        meta={"tool": "deno"},
    )

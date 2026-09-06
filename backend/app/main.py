"""Точка сборки FastAPI-приложения."""

from __future__ import annotations

import asyncio
import logging
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, config
from .core import binaries
from .core.events import bus
from .core.jobs import manager
from .paths import ensure_dirs, static_dir
from .routers import downloads, jobs, library, media, settings, stream, system

logger = logging.getLogger("sigame-helper")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    ensure_dirs()
    current = config.load()
    # Рабочая папка должна существовать, иначе медиатека покажет пустоту без объяснений.
    Path(current.resolved_workspace()).mkdir(parents=True, exist_ok=True)

    detected = binaries.detect_all()
    for name, info in detected.items():
        state = f"OK ({info.version})" if info.available else f"НЕ НАЙДЕН — {info.error}"
        logger.info("%s: %s", name, state)

    await manager.start()

    # Проверка видеокарты занимает пару секунд — делаем её в фоне, чтобы
    # окно открывалось сразу, а галочка «на видеокарте» появилась чуть позже.
    async def probe_gpu() -> None:
        loop = asyncio.get_running_loop()
        found = await loop.run_in_executor(None, binaries.probe_hardware)
        working = [name for name, ok in found.items() if ok]
        logger.info("аппаратные кодировщики: %s", ", ".join(working) or "нет")
        bus.publish("tools.changed", {"hardware": found})

    asyncio.create_task(probe_gpu())

    # Заставлять человека искать кнопку в настройках — плохая встреча.
    # Чего не хватает, доустанавливаем сами и сразу.
    if sys.platform == "win32":
        from .core import pipeline

        ffmpeg = detected.get("ffmpeg")
        if not (ffmpeg and ffmpeg.available):
            logger.info("ffmpeg не найден — запускаю автоматическую установку")
            pipeline.submit_ffmpeg_install()

        deno = detected.get("deno")
        if not (deno and deno.available):
            logger.info("Deno не найден — запускаю автоматическую установку")
            pipeline.submit_deno_install()
    try:
        yield
    finally:
        await manager.stop()


def create_app() -> FastAPI:
    app = FastAPI(
        title="SiGame Helper",
        version=__version__,
        description="Локальный комбайн для скачивания, нарезки и сжатия медиа под паки SIGame",
        lifespan=lifespan,
    )

    # Нужно только для режима разработки, когда фронтенд крутится на Vite (5173).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173", "http://127.0.0.1:5173",
            "http://localhost:4173", "http://127.0.0.1:4173",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
    )

    @app.middleware("http")
    async def no_api_cache(request, call_next):
        """Запрещает кэшировать ответы API.

        У JSON-ответов не было заголовков кэширования, и встроенный браузер
        имел полное право оставить их у себя. Из-за этого медиатека могла
        показывать вес файла, каким он был на момент первого запроса, —
        например, недокачанным. Помогал только перезапуск программы.

        Картинки (миниатюры, ленты кадров) свой заголовок ставят сами: их
        имена содержат размер и время файла, поэтому они кэшируются надолго
        и остаются верными.
        """
        response = await call_next(request)
        path = request.url.path
        if path.startswith("/api") and "cache-control" not in response.headers:
            response.headers["Cache-Control"] = "no-store"
        return response

    app.include_router(system.router)
    app.include_router(settings.router)
    app.include_router(library.router)
    app.include_router(media.router)
    app.include_router(jobs.router)
    app.include_router(downloads.router)
    app.include_router(stream.router)

    @app.exception_handler(PermissionError)
    async def permission_handler(_: Request, exc: PermissionError) -> JSONResponse:
        return JSONResponse(status_code=403, content={"detail": str(exc)})

    @app.exception_handler(FileNotFoundError)
    async def missing_handler(_: Request, exc: FileNotFoundError) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    _mount_frontend(app)
    return app


def _mount_frontend(app: FastAPI) -> None:
    """Отдаёт собранный React-фронтенд, если он есть."""
    static = static_dir()
    index = static / "index.html"

    if not index.exists():
        @app.get("/")
        async def missing_build() -> JSONResponse:
            return JSONResponse(
                status_code=503,
                content={
                    "detail": "Фронтенд не собран.",
                    "hint": "Выполните: cd frontend && npm install && npm run build",
                },
            )
        return

    assets = static / "assets"
    if assets.exists():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    # Файлы в /assets получают уникальные имена при каждой сборке, поэтому их
    # можно кэшировать вечно. А вот index.html ссылается на них по имени: если
    # браузер оставит его в кэше, после обновления программы человек увидит
    # старый интерфейс, который просит несуществующие файлы.
    no_cache = {"Cache-Control": "no-store, must-revalidate"}

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str) -> FileResponse:
        """Любой неизвестный путь отдаём в React — маршрутизация на стороне клиента."""
        candidate = static / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(index, headers=no_cache)


app = create_app()

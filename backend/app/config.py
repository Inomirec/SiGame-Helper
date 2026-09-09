"""Пользовательские настройки: загрузка, сохранение, значения по умолчанию."""

from __future__ import annotations

import json
import threading
from typing import Any, Literal

from pydantic import BaseModel, Field

from .paths import config_file, default_workspace, ensure_dirs

_lock = threading.Lock()


class BinaryOverrides(BaseModel):
    """Ручные пути к бинарникам. Пусто = искать в PATH и в venv."""

    ffmpeg: str | None = None
    ffprobe: str | None = None
    yt_dlp: str | None = None
    gallery_dl: str | None = None
    deno: str | None = None


class DownloadSettings(BaseModel):
    #: Куда складывать скачанное (пусто = подпапка ``_downloads`` в рабочей папке).
    directory: str | None = None
    #: Шаблон имени файла в синтаксисе yt-dlp.
    filename_template: str = "%(title).150B [%(id)s].%(ext)s"
    #: Всегда приводить контейнер к MP4, чтобы браузерный плеер точно открыл файл.
    force_mp4: bool = True
    #: Ограничение высоты кадра при скачивании (0 = максимальное качество).
    max_height: int = 0
    #: Брать куки из браузера — нужно для приватных/возрастных видео и Instagram.
    cookies_from_browser: str | None = None
    #: Прокси в формате ``socks5://127.0.0.1:1080`` или ``http://...``.
    #: Адрес сохраняется всегда, а включается отдельным переключателем —
    #: чтобы не приходилось стирать и вбивать его заново.
    proxy: str | None = None
    proxy_enabled: bool = False
    #: Встраивать обложку и метаданные в аудиофайлы.
    embed_metadata: bool = True
    #: Скачивать плейлист целиком, если ссылка ведёт на него.
    download_playlists: bool = False
    #: Ограничение на число элементов плейлиста (0 = без ограничения).
    playlist_limit: int = 25


class ExportSettings(BaseModel):
    #: Имя подпапки для результатов обработки.
    output_folder: str = "Обработанное"
    #: Раскладывать файлы по папкам «Видео», «Аудио», «Картинки».
    sort_into_folders: bool = True
    #: Сколько задач кодирования выполнять одновременно.
    concurrency: int = Field(default=2, ge=1, le=8)
    #: Пресет видео, выбранный по умолчанию.
    default_video_preset: str = "av1_720_balanced"
    #: Пресет аудио, выбранный по умолчанию.
    default_audio_preset: str = "opus_96"
    #: Пресет изображений, выбранный по умолчанию.
    default_image_preset: str = "avif_100kb"


class Settings(BaseModel):
    """Полный конфиг приложения (файл ``config.json``)."""

    #: Рабочие папки, которые показываются в медиатеке.
    workspaces: list[str] = Field(default_factory=lambda: [str(default_workspace())])
    #: Активная рабочая папка.
    active_workspace: str | None = None
    theme: Literal["dark", "light"] = "dark"
    language: Literal["ru", "en"] = "ru"
    download: DownloadSettings = Field(default_factory=DownloadSettings)
    export: ExportSettings = Field(default_factory=ExportSettings)
    binaries: BinaryOverrides = Field(default_factory=BinaryOverrides)

    def resolved_workspace(self) -> str:
        if self.active_workspace:
            return self.active_workspace
        if self.workspaces:
            return self.workspaces[0]
        return str(default_workspace())


_cache: Settings | None = None


def load() -> Settings:
    """Читает конфиг с диска (с кэшированием в памяти)."""
    global _cache
    with _lock:
        if _cache is not None:
            return _cache
        ensure_dirs()
        path = config_file()
        if path.exists():
            try:
                raw: dict[str, Any] = json.loads(path.read_text("utf-8"))
                _cache = Settings.model_validate(raw)
            except (json.JSONDecodeError, ValueError):
                # Битый конфиг не должен мешать запуску: откатываемся к дефолтам,
                # но сохраняем сломанный файл рядом для разбора.
                path.replace(path.with_suffix(".json.broken"))
                _cache = Settings()
        else:
            _cache = Settings()
        return _cache


def save(settings: Settings) -> Settings:
    """Записывает конфиг на диск атомарно и обновляет кэш."""
    global _cache
    with _lock:
        ensure_dirs()
        path = config_file()
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(settings.model_dump(mode="json"), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        tmp.replace(path)
        _cache = settings
        return settings


def update(patch: dict[str, Any]) -> Settings:
    """Частичное обновление: сливает переданные поля с текущим конфигом."""
    current = load().model_dump(mode="json")
    merged = _deep_merge(current, patch)
    return save(Settings.model_validate(merged))


def _deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    result = dict(base)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result

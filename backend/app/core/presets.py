"""Каталог пресетов сжатия.

Пресет — это просто именованный набор значений для ``VideoOptions`` /
``AudioOptions`` / ``ImageOptions``. Пользователь выбирает пресет, а затем
может подкрутить любой параметр вручную.

Ориентиры по качеству для SVT-AV1 (CRF):
  38-40 — высокое качество, файл крупнее
  42-45 — золотая середина для паков
  50+   — максимальная экономия, видны артефакты
"""

from __future__ import annotations

from typing import Any, Literal

PresetKind = Literal["video", "audio", "image"]


class Preset(dict):
    """Словарь вида ``{id, label, hint, kind, options}``."""


def _video(
    ident: str,
    label: str,
    hint: str,
    *,
    codec: str = "av1_svt",
    crf: int = 43,
    speed_preset: str = "6",
    max_height: int = 720,
    max_fps: int = 30,
    audio_codec: str = "opus",
    audio_bitrate: int = 96,
    loudnorm: bool = True,
    container: str = "mp4",
    accent: str = "violet",
) -> dict[str, Any]:
    return {
        "id": ident,
        "kind": "video",
        "label": label,
        "hint": hint,
        "accent": accent,
        "options": {
            "video": {
                "codec": codec,
                "crf": crf,
                "speed_preset": speed_preset,
                "max_height": max_height,
                "max_fps": max_fps,
                "tempo": 1.0,
                "container": container,
                "faststart": True,
                "strip_video": False,
            },
            "audio": {
                "codec": audio_codec,
                "bitrate_kbps": audio_bitrate,
                "loudnorm": loudnorm,
            },
        },
    }


def _audio(
    ident: str,
    label: str,
    hint: str,
    *,
    codec: str = "opus",
    bitrate: int = 96,
    loudnorm: bool = True,
    fade_out: float = 0.0,
    mono: bool = False,
    accent: str = "emerald",
) -> dict[str, Any]:
    return {
        "id": ident,
        "kind": "audio",
        "label": label,
        "hint": hint,
        "accent": accent,
        "options": {
            "audio": {
                "codec": codec,
                "bitrate_kbps": bitrate,
                "loudnorm": loudnorm,
                "fade_out": fade_out,
                "mono": mono,
            }
        },
    }


def _image(
    ident: str,
    label: str,
    hint: str,
    *,
    fmt: str = "avif",
    target_kb: int | None = 100,
    quality: int = 80,
    max_dimension: int = 1920,
    effort: int = 4,
    accent: str = "amber",
) -> dict[str, Any]:
    return {
        "id": ident,
        "kind": "image",
        "label": label,
        "hint": hint,
        "accent": accent,
        "options": {
            "image": {
                "format": fmt,
                "target_kb": target_kb,
                "quality": quality,
                "max_dimension": max_dimension,
                "effort": effort,
                "passes": 4,
            }
        },
    }


VIDEO_PRESETS: list[dict[str, Any]] = [
    _video(
        "pack_balanced",
        "Пак · Баланс",
        "Рабочая лошадка для SIGame. Разницу с оригиналом видно, только если "
        "приглядываться.",
        crf=43,
    ),
    _video(
        "pack_quality",
        "Пак · Качество",
        "Когда важна картинка: мелкий текст, детали, скриншоты игр. Файл крупнее.",
        crf=38,
        speed_preset="5",
        audio_bitrate=128,
    ),
    _video(
        "pack_economy",
        "Пак · Экономия",
        "Когда пак не влезает в лимит. Артефакты заметны, но смотреть можно.",
        crf=50,
        speed_preset="8",
        audio_bitrate=64,
    ),
    _video(
        "pack_h264",
        "Пак · H.264",
        "То же сжатие под пак, но старым кодеком — на случай, если чей-то SIGame "
        "не проигрывает AV1. Файл примерно вдвое тяжелее.",
        codec="h264",
        crf=25,
        speed_preset="fast",
        audio_codec="aac",
        audio_bitrate=128,
        accent="sky",
    ),
    _video(
        "remux_mp4",
        "Перегнать в обычный MP4",
        "Не для пака. Чинит капризные файлы — например, записи OBS, которые "
        "тормозят в монтажке. Качество остаётся исходным, файл будет крупным.",
        codec="h264",
        crf=17,
        speed_preset="medium",
        max_height=0,
        max_fps=0,
        audio_codec="aac",
        audio_bitrate=192,
        accent="emerald",
    ),
    {
        "id": "stream_copy",
        "kind": "video",
        "label": "Без сжатия · быстрый срез",
        "hint": "Только обрезать, ничего не перекодируя. Мгновенно, но границы среза "
                "прыгнут к ближайшим ключевым кадрам.",
        "accent": "slate",
        "options": {
            "video": {"codec": "copy", "max_height": 0, "max_fps": 0},
            "audio": {"codec": "copy", "loudnorm": False},
            "stream_copy": True,
        },
    },
]

AUDIO_PRESETS: list[dict[str, Any]] = [
    _audio(
        "opus_96",
        "Пак · Opus 96k",
        "Стандарт для вопросов: по качеству ≈ MP3 160k, вес втрое меньше.",
    ),
    _audio(
        "opus_128_music",
        "Музыка · Opus 128k",
        "Если в вопросе играет музыка и слышны артефакты на 96k.",
        bitrate=128,
    ),
    _audio(
        "opus_64_voice",
        "Речь · Opus 64k моно",
        "Голос, подкасты, цитаты. Минимальный вес без потери разборчивости.",
        bitrate=64,
        mono=True,
    ),
    _audio(
        "mp3_192_compat",
        "Совместимость · MP3 192k",
        "Для старых плееров и сайтов, которые не понимают Opus.",
        codec="mp3",
        bitrate=192,
        accent="sky",
    ),
]

IMAGE_PRESETS: list[dict[str, Any]] = [
    _image(
        "avif_light",
        "AVIF · Лёгкое сжатие",
        "Картинка почти не отличается от оригинала. Для схем, карт и скриншотов "
        "с мелким текстом.",
        target_kb=300,
        max_dimension=1920,
        effort=4,
    ),
    _image(
        "avif_medium",
        "AVIF · Среднее сжатие",
        "Рабочий вариант для большинства вопросов: постеры, кадры, фотографии. "
        "Разницу на глаз почти не видно.",
        target_kb=120,
        max_dimension=1600,
        effort=3,
    ),
    _image(
        "avif_extreme",
        "AVIF · Экстремальное сжатие",
        "Когда пак не влезает в лимит. Картинка заметно мягче, но узнаваема.",
        target_kb=50,
        max_dimension=1280,
        effort=2,
    ),
    _image(
        "webp_q85",
        "WebP",
        "Для сайтов и программ, которые ещё не переварили AVIF.",
        fmt="webp",
        target_kb=None,
        quality=85,
        accent="sky",
    ),
    _image(
        "jpg_q85",
        "JPEG",
        "Универсальный вариант на все случаи жизни.",
        fmt="jpg",
        target_kb=None,
        quality=85,
        accent="sky",
    ),
    _image(
        "png_lossless",
        "PNG без потерь",
        "Только ресайз, без потери качества. Для пиксель-арта и прозрачности.",
        fmt="png",
        target_kb=None,
        max_dimension=0,
        accent="slate",
    ),
]

ALL: list[dict[str, Any]] = VIDEO_PRESETS + AUDIO_PRESETS + IMAGE_PRESETS
_BY_ID = {preset["id"]: preset for preset in ALL}


def get(preset_id: str) -> dict[str, Any] | None:
    return _BY_ID.get(preset_id)


def catalog() -> dict[str, list[dict[str, Any]]]:
    return {"video": VIDEO_PRESETS, "audio": AUDIO_PRESETS, "image": IMAGE_PRESETS}

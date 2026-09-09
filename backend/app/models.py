"""Pydantic-схемы запросов и ответов API."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

MediaKind = Literal["video", "audio", "image", "other"]
VideoCodec = Literal[
    "av1_svt", "av1_nvenc", "av1_qsv", "h264", "h264_nvenc", "h265", "copy"
]
AudioCodec = Literal["opus", "aac", "mp3", "flac", "copy", "none"]
ImageFormat = Literal["avif", "webp", "jpg", "png"]
Container = Literal["mp4", "webm", "mkv", "auto"]


class Trim(BaseModel):
    """Фрагмент исходника. ``None`` = от начала / до конца."""

    start: float | None = Field(default=None, ge=0)
    end: float | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _check_order(self) -> "Trim":
        if self.start is not None and self.end is not None and self.end <= self.start:
            raise ValueError("Точка Out должна быть позже точки In")
        return self

    @property
    def is_set(self) -> bool:
        return self.start is not None or self.end is not None

    @property
    def duration(self) -> float | None:
        if self.start is not None and self.end is not None:
            return self.end - self.start
        return None


class AudioOptions(BaseModel):
    codec: AudioCodec = "opus"
    #: Битрейт в кбит/с. Для ``flac``/``copy`` игнорируется.
    bitrate_kbps: int = Field(default=96, ge=16, le=512)
    #: Приводить громкость к единому уровню (EBU R128).
    loudnorm: bool = True
    #: Целевая интегральная громкость, LUFS.
    loudnorm_i: float = -16.0
    #: Максимальный истинный пик, dBTP.
    loudnorm_tp: float = -1.5
    #: Диапазон громкости, LU.
    loudnorm_lra: float = 11.0
    #: Двухпроходная нормализация: точнее, но требует полного анализа файла.
    loudnorm_two_pass: bool = False
    fade_in: float = Field(default=0.0, ge=0, le=30)
    fade_out: float = Field(default=0.0, ge=0, le=30)
    #: Привести к моно (заметно экономит вес для речи).
    mono: bool = False


class VideoOptions(BaseModel):
    codec: VideoCodec = "av1_svt"
    #: Постоянное качество. Для AV1 ~ 20-63, для x264/x265 ~ 0-51.
    crf: int = Field(default=43, ge=0, le=63)
    #: Скорость кодирования: для SVT-AV1 это 0-13, для x264 — имя пресета.
    speed_preset: str = "6"
    #: Ограничение по высоте кадра (0 = не менять).
    max_height: int = Field(default=720, ge=0, le=4320)
    #: Ограничение по кадровой частоте (0 = не менять).
    max_fps: int = Field(default=30, ge=0, le=240)
    #: Ускорение воспроизведения: 1.0 = как в оригинале, 1.06 = +6%.
    tempo: float = Field(default=1.0, ge=0.5, le=2.0)
    #: Кодировать на видеокарте вместо процессора. Подходящий аппаратный
    #: кодировщик подбирается сам — какой есть в этом компьютере.
    use_gpu: bool = False
    container: Container = "mp4"
    #: Перемещать индекс в начало файла — обязательно для быстрого старта.
    faststart: bool = True
    #: Плавное появление из чёрного и уход в чёрный, в секундах.
    fade_in: float = Field(default=0.0, ge=0, le=30)
    fade_out: float = Field(default=0.0, ge=0, le=30)
    #: Убрать видеодорожку целиком (получить только звук).
    strip_video: bool = False


class Rect(BaseModel):
    """Прямоугольник в пикселях исходного изображения."""

    x: int = Field(ge=0)
    y: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class ImageOptions(BaseModel):
    format: ImageFormat = "avif"
    #: Закрашиваемые области (бренды, надписи, спойлеры). Координаты — в пикселях
    #: оригинала, до кадрирования и масштабирования.
    boxes: list[Rect] = Field(default_factory=list)
    #: Цвет закраски. По умолчанию непрозрачный чёрный.
    box_color: str = "black"
    #: Нарисованное кистью — прозрачный PNG размером с оригинал, в base64.
    #: Прямоугольником не закрыть надпись, идущую дугой, поэтому мазки
    #: приходят готовой картинкой и просто накладываются сверху.
    paint_png: str | None = None
    #: Обрезка кадра. ``None`` = оставить как есть.
    crop: Rect | None = None
    #: Целевой вес файла в килобайтах. ``None`` = использовать ``quality``.
    target_kb: int | None = Field(default=100, ge=5, le=20000)
    #: Сколько итераций подбора качества делать при заданном ``target_kb``.
    passes: int = Field(default=4, ge=1, le=8)
    #: Качество 1-100, когда целевой вес не задан.
    quality: int = Field(default=80, ge=1, le=100)
    #: Ограничение по длинной стороне в пикселях (0 = не менять).
    max_dimension: int = Field(default=1920, ge=0, le=16384)
    #: Усилие кодера: 0 = медленно и качественно, 8 = быстро.
    effort: int = Field(default=4, ge=0, le=9)
    #: Удалить исходник после успешного сжатия.
    replace_original: bool = False


class ExportRequest(BaseModel):
    """Задание на обработку одного файла."""

    source: str
    kind: MediaKind
    trim: Trim = Field(default_factory=Trim)
    video: VideoOptions = Field(default_factory=VideoOptions)
    audio: AudioOptions = Field(default_factory=AudioOptions)
    image: ImageOptions = Field(default_factory=ImageOptions)
    #: Куда сохранить. ``None`` = подпапка ``Обработанное`` рядом с исходником.
    output_dir: str | None = None
    #: Имя файла без расширения. ``None`` = имя исходника + суффикс.
    output_name: str | None = None
    #: Суффикс, добавляемый к имени по умолчанию.
    suffix: str = "_sig"
    #: Быстрая нарезка потока без перекодирования (режет по ключевым кадрам).
    stream_copy: bool = False
    #: Человекочитаемое имя пресета — только для отображения в очереди.
    preset_label: str | None = None
    #: Перезаписывать существующий файл вместо добавления номера.
    overwrite: bool = False


class BatchExportRequest(BaseModel):
    items: list[ExportRequest]


class DownloadItem(BaseModel):
    """Одна ссылка в очереди загрузки, с необязательным отрезком."""

    url: str
    #: Начало и конец нужного фрагмента в секундах. Пусто = скачать целиком.
    start: float | None = Field(default=None, ge=0)
    end: float | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _check_order(self) -> "DownloadItem":
        if self.start is not None and self.end is not None and self.end <= self.start:
            raise ValueError("Конец отрезка должен быть позже начала")
        return self

    @property
    def has_section(self) -> bool:
        return self.start is not None or self.end is not None


class DownloadRequest(BaseModel):
    items: list[DownloadItem] = Field(min_length=1)
    #: ``auto`` сам решает по ссылке; остальные режимы принудительные.
    mode: Literal["auto", "video", "audio", "images"] = "auto"
    output_dir: str | None = None
    #: Ограничение высоты кадра при скачивании (0 = максимум).
    max_height: int = 0
    #: Для режима ``images``: индексы (с 1) выбранных картинок галереи.
    selection: list[int] | None = None
    #: Извлекать только звук (для режима ``audio``).
    audio_format: Literal["mp3", "opus", "m4a", "best"] = "opus"
    #: Сразу поставить скачанный файл в очередь сжатия с этим пресетом.
    auto_process_preset: str | None = None


class ProbeGalleryRequest(BaseModel):
    url: str


class SettingsPatch(BaseModel):
    """Свободная форма — валидируется при слиянии с текущим конфигом."""

    model_config = {"extra": "allow"}

    def as_dict(self) -> dict[str, Any]:
        return self.model_dump(exclude_unset=True)


class FrameGrabRequest(BaseModel):
    """Сохранение стоп-кадра из видео в отдельную картинку."""

    source: str
    #: Момент в секундах, с которого берём кадр.
    time: float = Field(ge=0)
    image: ImageOptions = Field(default_factory=ImageOptions)
    output_dir: str | None = None
    suffix: str = "_кадр"


class RawCommandRequest(BaseModel):
    """Запуск отредактированной вручную команды ffmpeg."""

    command: str
    #: Исходник — нужен только для подписи задачи в очереди.
    source: str | None = None


class PathRequest(BaseModel):
    path: str


class RenameRequest(BaseModel):
    path: str
    new_name: str

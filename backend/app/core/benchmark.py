"""Подбор числа одновременных задач под конкретный компьютер.

Сколько файлов обрабатывать разом — вопрос без общего ответа: он зависит от
процессора, а угадывать за человека не стоит. Поэтому просто меряем: гоняем
одну и ту же небольшую пачку при разных значениях и смотрим, где кривая
упирается в полку.

Очереди программы здесь не участвуют — мы запускаем кодировщик напрямую и
ограничиваем число одновременных запусков сами. Измеряем ровно то, что потом
и настраиваем: сколько ffmpeg-ов машина тянет одновременно.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import time
from pathlib import Path
from typing import Callable, Iterable

from . import binaries
from .jobs import JobContext
from ..paths import data_dir, ensure_dirs

#: Сколько роликов и картинок в пробной пачке.
CLIPS = 4
IMAGES = 12

#: Какие значения проверяем. Выше числа потоков процессора не лезем.
VIDEO_LEVELS = (1, 2, 3, 4)
IMAGE_LEVELS = (1, 2, 4, 6, 8)

#: Насколько результат должен быть лучше, чтобы ради него поднимать число
#: задач. Прирост меньше этого — уже погрешность, а машина занята сильнее.
#: Десять процентов подобраны замером: при пяти ответ прыгал между «2» и «4»
#: от прогона к прогону, при десяти три прогона подряд дали одно и то же.
MEANINGFUL = 0.10

#: Пробное видео рисуем на ходу и сразу отдаём кодировщику — промежуточный
#: файл занял бы под двести мегабайт на диске. Зерно обязательно: на гладкой
#: картинке кодировщику нечего делать, и замер выходит не про настоящую
#: работу.
VIDEO_SOURCE = "testsrc2=size=1920x1080:rate=30:duration=6,noise=alls=28:allf=t+u"


def _levels(levels: Iterable[int]) -> list[int]:
    """Отсекает значения, которым на этой машине не хватит потоков."""
    threads = os.cpu_count() or 1
    kept = [value for value in levels if value <= threads]
    return kept or [1]


def workdir() -> Path:
    ensure_dirs()
    return data_dir() / "benchmark"


async def _spawn(ctx: JobContext, args: list[str]) -> None:
    """Запускает ffmpeg и ждёт его. Ошибку показываем целиком: без материала
    мерить нечего, и молча выдать «рекомендуем 1» было бы обманом."""
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
    if process.returncode != 0:
        tail = err.decode("utf-8", "replace").strip().splitlines()[-3:]
        raise RuntimeError("\n".join(tail) or "ffmpeg завершился с ошибкой")


def _video_args(source: Path, output: Path) -> list[str]:
    """Кодирование ролика теми же настройками, что у пресета «Баланс».

    ``source`` здесь не читается: видео рисуется на ходу. Подпись оставлена
    ради общего вида с картинками, чтобы обе проверки гонял один и тот же код.
    """
    return [
        binaries.ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", VIDEO_SOURCE,
        "-vf", "scale=-2:720,fps=30",
        "-c:v", "libsvtav1", "-crf", "43", "-preset", "6",
        "-pix_fmt", "yuv420p", "-an",
        str(output),
    ]


def _image_args(source: Path, output: Path) -> list[str]:
    """Сжатие картинки теми же настройками, что у «Рекомендуемого сжатия»."""
    return [
        binaries.ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        "-i", str(source),
        "-vf", "scale=1600:-2:flags=lanczos",
        "-c:v", "libaom-av1", "-still-picture", "1",
        "-crf", "23", "-b:v", "0", "-cpu-used", "4",
        "-pix_fmt", "yuv420p", "-frames:v", "1", "-f", "avif",
        str(output),
    ]


async def _prepare(ctx: JobContext, folder: Path) -> Path:
    """Готовит пробную картинку.

    Берём рисованный источник, а не файлы человека: результат должен зависеть
    только от машины, а не от того, что у него лежит в рабочей папке.
    """
    picture = folder / "frame.png"
    ctx.progress(0.02, "Готовлю пробный материал")
    await _spawn(ctx, [
        binaries.ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=1920x1440",
        "-vf", "noise=alls=18:allf=t+u",
        "-frames:v", "1", str(picture),
    ])
    return picture


async def _sweep(
    ctx: JobContext,
    sources: list[Path],
    build: Callable[[Path, Path], list[str]],
    levels: list[int],
    folder: Path,
    label: str,
    base: float,
    span: float,
) -> list[dict]:
    """Гоняет одну и ту же пачку при каждом значении и засекает время."""
    rows: list[dict] = []
    for index, level in enumerate(levels):
        ctx.progress(
            base + span * index / len(levels),
            f"{label}: по {level} за раз",
        )
        gate = asyncio.Semaphore(level)
        out = folder / f"out-{level}"
        shutil.rmtree(out, ignore_errors=True)
        out.mkdir(parents=True, exist_ok=True)

        async def one(number: int, source: Path) -> None:
            async with gate:
                await _spawn(ctx, build(source, out / f"{number}{source.suffix}"))

        started = time.monotonic()
        await asyncio.gather(*(one(i, src) for i, src in enumerate(sources)))
        seconds = time.monotonic() - started

        shutil.rmtree(out, ignore_errors=True)
        rows.append({"level": level, "seconds": round(seconds, 2)})
        ctx.log(f"{label}: по {level} за раз — {seconds:.1f} с")
    return rows


def best_level(rows: list[dict]) -> int:
    """Где кривая выходит на полку.

    Берём не самое быстрое значение, а самое маленькое из тех, что почти не
    уступают лучшему: разница в пару процентов не стоит того, чтобы занимать
    машину сильнее.
    """
    if not rows:
        return 1
    fastest = min(row["seconds"] for row in rows)
    for row in sorted(rows, key=lambda item: item["level"]):
        if row["seconds"] <= fastest * (1 + MEANINGFUL):
            return int(row["level"])
    return int(rows[0]["level"])


async def run(ctx: JobContext) -> dict:
    """Полный замер. Возвращает таблицу и рекомендованные значения."""
    folder = workdir()
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True, exist_ok=True)

    try:
        picture = await _prepare(ctx, folder)

        video_levels = _levels(VIDEO_LEVELS)
        image_levels = _levels(IMAGE_LEVELS)

        video = await _sweep(
            ctx, [folder / "clip.mp4"] * CLIPS, _video_args, video_levels, folder,
            "Видео", base=0.08, span=0.55,
        )
        image = await _sweep(
            ctx, [picture] * IMAGES, _image_args, image_levels, folder,
            "Картинки", base=0.63, span=0.35,
        )

        result = {
            "video": video,
            "image": image,
            "videoBest": best_level(video),
            "imageBest": best_level(image),
            "threads": os.cpu_count() or 1,
            "clips": CLIPS,
            "images": IMAGES,
        }
        ctx.meta(**result)
        ctx.progress(
            1.0,
            f"Готово: видео по {result['videoBest']}, "
            f"картинки по {result['imageBest']}",
        )
        return result
    finally:
        shutil.rmtree(folder, ignore_errors=True)

"""Очередь задач: постановка экспорта, статус, отмена."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from ..core import encode, fsutil, pipeline, presets
from ..core.jobs import manager
from ..models import (
    BatchExportRequest,
    ExportRequest,
    FrameGrabRequest,
    RawCommandRequest,
)
from ..core.probe import probe

router = APIRouter(prefix="/api", tags=["jobs"])


@router.get("/jobs")
async def list_jobs() -> dict[str, Any]:
    jobs = manager.list()
    active = [j for j in jobs if j["status"] in {"queued", "running"}]
    return {"jobs": jobs, "active": len(active)}


@router.get("/jobs/{job_id}")
async def job_detail(job_id: str) -> dict[str, Any]:
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404, "Задача не найдена")
    return job.to_dict(with_log=True)


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str) -> dict[str, bool]:
    if not manager.cancel(job_id):
        raise HTTPException(409, "Задачу уже нельзя отменить")
    return {"ok": True}


@router.post("/jobs/clear")
async def clear_jobs() -> dict[str, int]:
    return {"removed": manager.clear_finished()}


@router.post("/export")
async def export(request: ExportRequest) -> dict[str, Any]:
    """Ставит один файл в очередь обработки."""
    try:
        job = pipeline.submit_export(request)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return job.to_dict()


@router.post("/export/batch")
async def export_batch(request: BatchExportRequest) -> dict[str, Any]:
    """Пакетная постановка: все файлы уходят в одну очередь."""
    created: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    for item in request.items:
        try:
            created.append(pipeline.submit_export(item).to_dict())
        except (PermissionError, FileNotFoundError, ValueError) as exc:
            errors.append({"source": item.source, "error": str(exc)})
    if not created and errors:
        raise HTTPException(400, errors[0]["error"])
    return {"jobs": created, "errors": errors}


@router.post("/export/frame")
async def export_frame(request: FrameGrabRequest) -> dict[str, Any]:
    """Сохраняет стоп-кадр из видео как отдельную сжатую картинку."""
    try:
        job = pipeline.submit_frame_grab(request)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return job.to_dict()


@router.post("/export/raw")
async def export_raw(request: RawCommandRequest) -> dict[str, Any]:
    """Запускает вручную отредактированную команду ffmpeg."""
    try:
        job = pipeline.submit_raw_command(request)
    except (PermissionError, FileNotFoundError, ValueError, RuntimeError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return job.to_dict()


@router.post("/export/preview")
async def preview(request: ExportRequest) -> dict[str, Any]:
    """Показывает, что именно будет запущено, — без постановки в очередь."""
    try:
        source = fsutil.safe_path(request.source)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc

    request.source = str(source)
    if request.kind == "image":
        return {
            "summary": (
                f"{request.image.format.upper()} · "
                + (f"лимит {request.image.target_kb} КБ"
                   if request.image.target_kb else f"качество {request.image.quality}")
            ),
            "command": None,
        }

    info = await probe(source)
    extension = encode.container_extension(request, info)
    # Тот же путь, что и у настоящего экспорта: команду теперь можно запускать,
    # и она должна писать результат туда же, куда обычная кнопка.
    output = pipeline.resolve_output(request, extension)
    args = encode.build_command(
        request, output, info, crf=encode.effective_crf(request.video, info)
    )
    return {
        "summary": encode.describe(request)["summary"],
        "command": encode.to_display_string(args),
        "output": str(output),
    }


@router.post("/export/preset/{preset_id}")
async def export_with_preset(preset_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Постановка задач по пресету — используется кнопкой пакетной обработки."""
    preset = presets.get(preset_id)
    if not preset:
        raise HTTPException(404, "Пресет не найден")

    sources: list[str] = payload.get("sources") or []
    if not sources:
        raise HTTPException(400, "Не выбрано ни одного файла")

    created: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    for raw in sources:
        kind = fsutil.media_kind(raw)
        if kind != preset["kind"]:
            skipped.append({"source": raw, "reason": f"пресет не подходит для типа «{kind}»"})
            continue
        request_data: dict[str, Any] = {
            "source": raw,
            "kind": kind,
            "preset_label": preset["label"],
        }
        options = preset.get("options", {})
        for section in ("video", "audio", "image"):
            if section in options:
                request_data[section] = options[section]
        if options.get("stream_copy"):
            request_data["stream_copy"] = True
        request_data.update(payload.get("overrides") or {})
        try:
            created.append(pipeline.submit_export(ExportRequest.model_validate(request_data)).to_dict())
        except (PermissionError, FileNotFoundError, ValueError) as exc:
            skipped.append({"source": raw, "reason": str(exc)})

    return {"jobs": created, "skipped": skipped}

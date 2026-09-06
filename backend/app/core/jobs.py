"""Очередь фоновых задач.

Кодирование и загрузка выполняются в отдельных пулах воркеров, поэтому
HTTP-эндпоинты никогда не блокируются: запрос ставит задачу в очередь и
сразу отвечает, а прогресс уходит клиенту через SSE.

Пулов два, потому что нагрузка разная: кодирование упирается в процессор
(1-2 параллельных задачи), а скачивание — в сеть (можно больше).
"""

from __future__ import annotations

import asyncio
import contextlib
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Awaitable, Callable

from .. import config
from .events import bus

#: Сколько строк лога держим в памяти на задачу.
_LOG_LIMIT = 400
#: Сколько завершённых задач храним в истории.
_HISTORY_LIMIT = 300


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    ERROR = "error"
    CANCELED = "canceled"


@dataclass
class Job:
    id: str
    kind: str                       # encode | image | download
    title: str
    status: JobStatus = JobStatus.QUEUED
    progress: float = 0.0           # 0..1
    message: str = "В очереди"
    source: str | None = None
    output: str | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    meta: dict[str, Any] = field(default_factory=dict)
    log: deque[str] = field(default_factory=lambda: deque(maxlen=_LOG_LIMIT))

    def to_dict(self, *, with_log: bool = False) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": self.id,
            "kind": self.kind,
            "title": self.title,
            "status": self.status.value,
            "progress": round(self.progress, 4),
            "message": self.message,
            "source": self.source,
            "output": self.output,
            "error": self.error,
            "createdAt": self.created_at,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "meta": self.meta,
        }
        if with_log:
            data["log"] = list(self.log)
        return data


class JobContext:
    """Ручки, которые доступны выполняющейся задаче."""

    def __init__(self, job: Job, manager: "JobManager") -> None:
        self.job = job
        self._manager = manager
        self._processes: set[asyncio.subprocess.Process] = set()
        self._last_emit = 0.0

    # --- прогресс -------------------------------------------------------
    def progress(self, value: float, message: str | None = None) -> None:
        """Обновляет прогресс. События throttle-ятся, чтобы не залить SSE."""
        self.job.progress = max(0.0, min(1.0, value))
        if message:
            self.job.message = message
        now = time.monotonic()
        if now - self._last_emit >= 0.15 or self.job.progress >= 1.0:
            self._last_emit = now
            self._manager.emit(self.job)

    def log(self, line: str) -> None:
        line = line.rstrip()
        if not line:
            return
        self.job.log.append(line)
        bus.publish("job.log", {"id": self.job.id, "line": line})

    def meta(self, **values: Any) -> None:
        self.job.meta.update(values)

    # --- дочерние процессы ---------------------------------------------
    def track(self, process: asyncio.subprocess.Process) -> None:
        self._processes.add(process)

    def untrack(self, process: asyncio.subprocess.Process) -> None:
        self._processes.discard(process)

    def kill_all(self) -> None:
        for process in list(self._processes):
            with contextlib.suppress(ProcessLookupError, OSError):
                process.kill()


Runner = Callable[[JobContext], Awaitable[None]]


class JobManager:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._order: deque[str] = deque()
        self._runners: dict[str, Runner] = {}
        self._contexts: dict[str, JobContext] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._queues: dict[str, asyncio.Queue[str]] = {}
        self._workers: list[asyncio.Task[None]] = []
        self._started = False

    # --- жизненный цикл --------------------------------------------------
    async def start(self) -> None:
        if self._started:
            return
        self._started = True
        settings = config.load()
        pools = {
            "encode": max(1, settings.export.concurrency),
            "download": 3,
        }
        for pool, size in pools.items():
            self._queues[pool] = asyncio.Queue()
            for index in range(size):
                self._workers.append(
                    asyncio.create_task(self._worker(pool, index), name=f"{pool}-{index}")
                )

    async def stop(self) -> None:
        for task in self._workers:
            task.cancel()
        for task in self._tasks.values():
            task.cancel()
        for ctx in self._contexts.values():
            ctx.kill_all()
        await asyncio.gather(*self._workers, return_exceptions=True)
        self._workers.clear()
        self._started = False

    # --- публичный API ---------------------------------------------------
    def submit(
        self,
        *,
        kind: str,
        title: str,
        runner: Runner,
        pool: str = "encode",
        source: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> Job:
        job = Job(
            id=uuid.uuid4().hex[:12],
            kind=kind,
            title=title,
            source=source,
            meta=meta or {},
        )
        self._jobs[job.id] = job
        self._order.append(job.id)
        self._runners[job.id] = runner
        self._trim_history()
        self._queues[pool if pool in self._queues else "encode"].put_nowait(job.id)
        self.emit(job, event="job.created")
        return job

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def list(self) -> list[dict[str, Any]]:
        return [self._jobs[jid].to_dict() for jid in self._order if jid in self._jobs]

    def cancel(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if not job or job.status in {JobStatus.DONE, JobStatus.ERROR, JobStatus.CANCELED}:
            return False
        ctx = self._contexts.get(job_id)
        if ctx:
            ctx.kill_all()
        task = self._tasks.get(job_id)
        if task:
            task.cancel()
        else:
            # Задача ещё не стартовала — помечаем отменённой, воркер её пропустит.
            job.status = JobStatus.CANCELED
            job.message = "Отменено"
            job.finished_at = time.time()
            self.emit(job)
        return True

    def clear_finished(self) -> int:
        removed = 0
        for job_id in list(self._order):
            job = self._jobs.get(job_id)
            if job and job.status in {JobStatus.DONE, JobStatus.ERROR, JobStatus.CANCELED}:
                self._forget(job_id)
                removed += 1
        bus.publish("jobs.cleared", {"removed": removed})
        return removed

    def emit(self, job: Job, event: str = "job.updated") -> None:
        bus.publish(event, job.to_dict())

    # --- внутреннее ------------------------------------------------------
    def _forget(self, job_id: str) -> None:
        self._jobs.pop(job_id, None)
        self._runners.pop(job_id, None)
        self._contexts.pop(job_id, None)
        self._tasks.pop(job_id, None)
        with contextlib.suppress(ValueError):
            self._order.remove(job_id)

    def _trim_history(self) -> None:
        finished = [
            jid for jid in self._order
            if (job := self._jobs.get(jid))
            and job.status in {JobStatus.DONE, JobStatus.ERROR, JobStatus.CANCELED}
        ]
        while len(self._order) > _HISTORY_LIMIT and finished:
            self._forget(finished.pop(0))

    async def _worker(self, pool: str, index: int) -> None:
        queue = self._queues[pool]
        while True:
            job_id = await queue.get()
            try:
                job = self._jobs.get(job_id)
                runner = self._runners.get(job_id)
                if not job or not runner or job.status is JobStatus.CANCELED:
                    continue
                await self._execute(job, runner)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # воркер не должен умирать из-за одной задачи
                bus.publish("job.error", {"id": job_id, "error": str(exc)})
            finally:
                queue.task_done()

    async def _execute(self, job: Job, runner: Runner) -> None:
        ctx = JobContext(job, self)
        self._contexts[job.id] = ctx
        job.status = JobStatus.RUNNING
        job.started_at = time.time()
        job.message = "Выполняется"
        self.emit(job)

        task = asyncio.current_task()
        if task:
            self._tasks[job.id] = task

        try:
            await runner(ctx)
            if job.status is JobStatus.RUNNING:
                job.status = JobStatus.DONE
                job.progress = 1.0
                job.message = "Готово"
        except asyncio.CancelledError:
            job.status = JobStatus.CANCELED
            job.message = "Отменено"
            ctx.kill_all()
            # Отмена конкретной задачи не должна ронять воркер, поэтому
            # исключение дальше не пробрасываем.
        except Exception as exc:
            job.status = JobStatus.ERROR
            job.error = str(exc)
            job.message = "Ошибка"
            ctx.log(str(exc))
        finally:
            job.finished_at = time.time()
            self._tasks.pop(job.id, None)
            self._contexts.pop(job.id, None)
            self.emit(job, event="job.finished")


manager = JobManager()


# --- утилита запуска ffmpeg с разбором прогресса -------------------------

async def run_ffmpeg(
    ctx: JobContext,
    args: list[str],
    *,
    total_duration: float | None,
    base: float = 0.0,
    span: float = 1.0,
    label: str = "Кодирование",
) -> None:
    """Запускает ffmpeg и транслирует прогресс из ``-progress pipe:1``."""
    from . import binaries

    process = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=binaries.CREATE_NO_WINDOW,
        env=binaries.subprocess_env(),
    )
    ctx.track(process)

    async def read_progress() -> None:
        assert process.stdout is not None
        speed = ""
        async for raw in process.stdout:
            line = raw.decode("utf-8", "replace").strip()
            if not line or "=" not in line:
                continue
            key, _, value = line.partition("=")
            if key == "speed":
                speed = value.strip()
            elif key in {"out_time_us", "out_time_ms"}:
                try:
                    micros = float(value)
                except ValueError:
                    continue
                # out_time_ms в ffmpeg исторически тоже в микросекундах.
                seconds = micros / 1_000_000
                if total_duration and total_duration > 0:
                    ratio = min(seconds / total_duration, 1.0)
                    suffix = f" · {speed}" if speed and speed != "N/A" else ""
                    ctx.progress(base + span * ratio, f"{label}{suffix}")
            elif key == "progress" and value == "end":
                ctx.progress(base + span, label)

    stderr_lines: list[str] = []

    async def read_stderr() -> None:
        assert process.stderr is not None
        async for raw in process.stderr:
            line = raw.decode("utf-8", "replace").rstrip()
            if line:
                stderr_lines.append(line)
                ctx.log(line)

    try:
        await asyncio.gather(read_progress(), read_stderr())
        code = await process.wait()
    finally:
        ctx.untrack(process)

    if code != 0:
        tail = "\n".join(stderr_lines[-6:]) or f"ffmpeg завершился с кодом {code}"
        raise RuntimeError(tail)

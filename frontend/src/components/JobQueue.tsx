import { useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  FolderOpen,
  Columns2,
  Image as ImageIcon,
  Loader2,
  ScrollText,
  Trash2,
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import { fileName, humanSize, savings } from '../lib/format'
import type { Job } from '../lib/types'
import { useStore } from '../store'
import { CompareModal } from './CompareModal'
import { IconButton } from './ui'

export function JobQueue() {
  const jobs = useStore((state) => state.jobs)
  const open = useStore((state) => state.queueOpen)
  const setOpen = useStore((state) => state.setQueueOpen)
  const toast = useStore((state) => state.toast)
  const refreshJobs = useStore((state) => state.refreshJobs)

  const [expanded, setExpanded] = useState<string | null>(null)
  const [compare, setCompare] = useState<Job | null>(null)

  const active = jobs.filter((job) => job.status === 'queued' || job.status === 'running')
  const finished = jobs.filter((job) => job.status !== 'queued' && job.status !== 'running')
  const overall = active.length
    ? active.reduce((sum, job) => sum + job.progress, 0) / active.length
    : 0

  const ordered = [...active].reverse().concat([...finished].reverse())

  return (
    <div
      className={`flex shrink-0 flex-col border-t border-line-soft bg-surface transition-[height] duration-200 ${
        open ? 'h-[290px]' : 'h-[42px]'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex h-[42px] shrink-0 items-center gap-3 px-4 text-left hover:bg-surface-2"
      >
        {active.length ? (
          <Loader2 size={14} className="animate-spin text-accent-soft" />
        ) : (
          <ScrollText size={14} className="text-ink-faint" />
        )}
        <span className="text-[12.5px] font-medium">
          Очередь
          {active.length > 0 && (
            <span className="ml-2 rounded bg-accent/20 px-1.5 py-0.5 text-[11px] text-accent-soft">
              {active.length} в работе
            </span>
          )}
        </span>

        {active.length > 0 && (
          <div className="h-1 w-40 overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300"
              style={{ width: `${overall * 100}%` }}
            />
          </div>
        )}

        <span className="ml-auto flex items-center gap-2 text-[11px] text-ink-faint">
          {finished.length > 0 && `выполнено: ${finished.length}`}
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </span>
      </button>

      {open && (
        <>
          <div className="flex items-center gap-2 border-y border-line-soft px-4 py-1.5">
            <button
              type="button"
              className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-ink-faint hover:bg-surface-3 hover:text-ink-dim"
              onClick={async () => {
                await api.clearJobs()
                void refreshJobs()
              }}
            >
              <Trash2 size={12} />
              Очистить завершённые
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {ordered.length === 0 && (
              <p className="px-3 py-8 text-center text-[12px] text-ink-faint">
                Очередь пуста. Обработанные файлы появятся здесь.
              </p>
            )}
            <ul className="space-y-1">
              {ordered.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  expanded={expanded === job.id}
                  onToggle={() => setExpanded(expanded === job.id ? null : job.id)}
                  onCancel={async () => {
                    try {
                      await api.cancelJob(job.id)
                    } catch (error) {
                      toast((error as Error).message, 'error')
                    }
                  }}
                  onCompare={() => setCompare(job)}
                />
              ))}
            </ul>
          </div>
        </>
      )}

      {compare && compare.source && compare.output && (
        <CompareModal
          open
          onClose={() => setCompare(null)}
          before={compare.source}
          after={compare.output}
          kind={compare.kind === 'image' ? 'image' : 'video'}
          sizeBefore={compare.meta?.sizeBefore}
          sizeAfter={compare.meta?.sizeAfter}
        />
      )}
    </div>
  )
}

function JobRow({
  job,
  expanded,
  onToggle,
  onCancel,
  onCompare,
}: {
  job: Job
  expanded: boolean
  onToggle: () => void
  onCancel: () => void
  onCompare: () => void
}) {
  const toast = useStore((state) => state.toast)
  const running = job.status === 'running' || job.status === 'queued'
  const compression = savings(job.meta?.sizeBefore, job.meta?.sizeAfter)
  // Сравнивать есть смысл только там, где остались оба файла: у скачивания
  // «до» просто не существует.
  const canCompare =
    job.status === 'done' &&
    job.kind !== 'download' &&
    Boolean(job.source) &&
    Boolean(job.output)

  const statusIcon = {
    queued: <Loader2 size={13} className="text-ink-faint" />,
    running: <Loader2 size={13} className="animate-spin text-accent-soft" />,
    done: <CheckCircle2 size={13} className="text-ok" />,
    error: <AlertCircle size={13} className="text-danger" />,
    canceled: <X size={13} className="text-ink-faint" />,
  }[job.status]

  const kindIcon = {
    download: <Download size={12} />,
    image: <ImageIcon size={12} />,
    encode: <ScrollText size={12} />,
  }[job.kind]

  return (
    <li className="rounded-lg bg-surface-2 px-3 py-2">
      <div className="flex items-center gap-2.5">
        <span className="shrink-0">{statusIcon}</span>
        <span className="shrink-0 text-ink-faint">{kindIcon}</span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px]">{job.title}</p>
          <p className="truncate text-[11px] text-ink-faint">
            {job.status === 'error' ? job.error : job.message}
            {job.meta?.preset ? ` · ${job.meta.preset}` : ''}
          </p>
        </div>

        {compression && job.status === 'done' && (
          <span
            className="chip shrink-0 bg-ok/15 text-ok"
            title={`${humanSize(job.meta.sizeBefore)} → ${humanSize(job.meta.sizeAfter)}`}
          >
            {compression}
          </span>
        )}
        {job.meta?.withinTarget === false && (
          <span className="chip shrink-0 bg-warn/15 text-warn" title="Не удалось уложиться в лимит веса">
            лимит не достигнут
          </span>
        )}

        {running && (
          <span className="w-24 shrink-0">
            <span className="block h-1 overflow-hidden rounded-full bg-surface-3">
              <span
                className="block h-full rounded-full bg-accent transition-all duration-300"
                style={{ width: `${job.progress * 100}%` }}
              />
            </span>
          </span>
        )}

        <div className="flex shrink-0 items-center">
          {canCompare && (
            <IconButton className="h-7 w-7" title="Сравнить до и после" onClick={onCompare}>
              <Columns2 size={13} />
            </IconButton>
          )}
          {job.output && job.status === 'done' && (
            <IconButton
              className="h-7 w-7"
              title="Показать в проводнике"
              onClick={async () => {
                try {
                  await api.reveal(job.output!)
                } catch (error) {
                  toast((error as Error).message, 'error')
                }
              }}
            >
              <FolderOpen size={13} />
            </IconButton>
          )}
          {running && (
            <IconButton className="h-7 w-7" title="Отменить" onClick={onCancel}>
              <X size={13} />
            </IconButton>
          )}
          <IconButton className="h-7 w-7" title="Журнал" onClick={onToggle} active={expanded}>
            <ScrollText size={13} />
          </IconButton>
        </div>
      </div>

      {expanded && <JobLog job={job} />}
    </li>
  )
}

function JobLog({ job }: { job: Job }) {
  const [lines, setLines] = useState<string[] | null>(job.log ?? null)

  // Полный журнал держится на сервере — подтягиваем его при первом раскрытии.
  useEffect(() => {
    if (job.log?.length) {
      setLines(job.log)
      return
    }
    let cancelled = false
    api
      .job(job.id)
      .then((detail) => !cancelled && setLines(detail.log ?? []))
      .catch(() => !cancelled && setLines([]))
    return () => {
      cancelled = true
    }
  }, [job.id, job.log])

  return (
    <div className="mt-2 space-y-2">
      {job.output && (
        <p className="truncate font-mono text-[10.5px] text-ink-faint" title={job.output}>
          → {fileName(job.output)}
        </p>
      )}
      <pre className="max-h-36 overflow-auto rounded-lg bg-base p-2.5 font-mono text-[10.5px] leading-relaxed text-ink-faint">
        {lines?.length ? lines.join('\n') : 'Записей пока нет.'}
      </pre>
    </div>
  )
}

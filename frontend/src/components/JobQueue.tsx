import { memo, useCallback, useEffect, useRef, useState } from 'react'
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
import { fileName, humanSize, plural, savings, shrinkRatio } from '../lib/format'
import type { Job } from '../lib/types'
import { useStore } from '../store'
import { CompareModal } from './CompareModal'
import { Button, IconButton, Modal } from './ui'

//: Сколько строк очереди показываем разом.
const ROW_LIMIT = 200

export function JobQueue() {
  const jobs = useStore((state) => state.jobs)
  const open = useStore((state) => state.queueOpen)
  const setOpen = useStore((state) => state.setQueueOpen)
  const toast = useStore((state) => state.toast)
  const refreshJobs = useStore((state) => state.refreshJobs)

  const expanded = useStore((state) => state.logJobId)
  const setExpanded = useStore((state) => state.setLogJob)
  const [compare, setCompare] = useState<Job | null>(null)
  const [errorsOpen, setErrorsOpen] = useState(false)

  const active = jobs.filter((job) => job.status === 'queued' || job.status === 'running')
  const finished = jobs.filter((job) => job.status !== 'queued' && job.status !== 'running')
  const done = jobs.filter((job) => job.status === 'done').length
  const failed = jobs.filter((job) => job.status === 'error').length
  const working = active.length > 0

  const ordered = [...active].reverse().concat([...finished].reverse())
  // Больше двух сотен строк разом не рисуем: при очереди в полтысячи файлов
  // каждая новость от задачи заставляла перерисовывать весь список, и окно
  // переставало отзываться до конца обработки.
  const shown = ordered.slice(0, ROW_LIMIT)

  // Полоса считается по всей пачке, а не по тем задачам, что идут прямо
  // сейчас. Среднее по активным стояло на месте: при сотне файлов и одной
  // задаче за раз девяносто девять из них всегда лежат с нулём, а готовые
  // из счёта уходят — полоса так и не трогалась с места.
  const waveStart = useRef(finished.length)
  if (!working) waveStart.current = finished.length
  const behind = Math.max(0, finished.length - waveStart.current)
  const total = active.length + behind
  const overall = total
    ? (behind + active.reduce((sum, job) => sum + job.progress, 0)) / total
    : 0

  // Счётчик готовых мигает на каждом новом файле. Раньше о том же говорила
  // всплывающая плашка, но она закрывала собой кнопки этой же строки, а при
  // длинной очереди — и полэкрана. Сигнал нужен там, где и так смотрят.
  const [blink, setBlink] = useState(0)
  const seenDone = useRef(done)
  useEffect(() => {
    if (done > seenDone.current) setBlink((value) => value + 1)
    seenDone.current = done
  }, [done])

  async function clearHistory() {
    try {
      await api.clearJobs()
      await refreshJobs()
    } catch (error) {
      toast((error as Error).message, 'error')
    }
  }

  return (
    <div
      className={`flex shrink-0 flex-col border-t border-line-soft bg-surface transition-[height] duration-200 ${
        open ? 'h-[290px]' : 'h-[42px]'
      }`}
    >
      <div className="flex h-[42px] shrink-0 items-center gap-3 px-4">
        {/* Разворот и очистка — разные действия, поэтому строка не может быть
            одной большой кнопкой: кнопку внутрь кнопки не положить. */}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="-mx-2 flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2"
        >
          {working ? (
            <Loader2 size={14} className="shrink-0 animate-spin text-accent-soft" />
          ) : (
            <ScrollText size={14} className="shrink-0 text-ink-faint" />
          )}
          <span className="shrink-0 text-[12.5px] font-medium">
            Очередь
            {working && (
              <span className="ml-2 rounded bg-accent/20 px-1.5 py-0.5 text-[11px] text-accent-soft">
                {active.length} в работе
              </span>
            )}
          </span>

          {working && (
            <>
              <div className="h-1 w-40 shrink-0 overflow-hidden rounded-full bg-surface-3">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-300"
                  style={{ width: `${overall * 100}%` }}
                />
              </div>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">
                {Math.round(overall * 100)}%
              </span>
            </>
          )}
        </button>

        {done > 0 && (
          <span
            key={`${blink}-${working}`}
            className={`shrink-0 rounded-md px-2 py-1 text-[11.5px] font-medium ring-1 ${
              working
                ? 'animate-blink bg-ok/12 text-ok ring-ok/25'
                : 'bg-surface-2 text-ink-dim ring-line-soft'
            }`}
          >
            Готово: {done} {plural(done, ['файл', 'файла', 'файлов'])}
          </span>
        )}

        {failed > 0 && (
          <button
            type="button"
            onClick={() => setErrorsOpen(true)}
            title="Показать, какие файлы не прошли и почему"
            className="shrink-0 rounded-md bg-danger/12 px-2 py-1 text-[11.5px] font-medium text-danger ring-1 ring-danger/25 hover:bg-danger/20"
          >
            {failed === 1 ? '1 ошибка' : `Ошибок: ${failed}`}
          </button>
        )}

        {finished.length > 0 && (
          <button
            type="button"
            onClick={clearHistory}
            title="Очистить историю очереди — списка обработанных файлов, сами файлы останутся на месте"
            className="shrink-0 rounded-lg p-1.5 text-ink-faint hover:bg-surface-3 hover:text-ink-dim"
          >
            <Trash2 size={14} />
          </button>
        )}

        <button
          type="button"
          onClick={() => setOpen(!open)}
          title={open ? 'Свернуть очередь' : 'Развернуть очередь'}
          className="shrink-0 rounded-lg p-1.5 text-ink-faint hover:bg-surface-3 hover:text-ink-dim"
        >
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>

      {open && (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {ordered.length === 0 && (
              <p className="px-3 py-8 text-center text-[12px] text-ink-faint">
                Очередь пуста. Обработанные файлы появятся здесь.
              </p>
            )}
            <ul className="space-y-1">
              {shown.map((job) => (
                <JobRow key={job.id} job={job} expanded={expanded === job.id} onCompare={setCompare} />
              ))}
            </ul>
            {ordered.length > shown.length && (
              <p className="px-3 py-3 text-center text-[11px] text-ink-faint">
                Показаны первые {shown.length} из {ordered.length}. Остальные видны по мере
                того, как список разбирается, — или очистите историю.
              </p>
            )}
          </div>
        </>
      )}

      <ErrorsModal
        open={errorsOpen}
        onClose={() => setErrorsOpen(false)}
        jobs={jobs.filter((job) => job.status === 'error')}
      />

      {compare && compare.source && compare.output && (
        <CompareModal
          open
          onClose={() => setCompare(null)}
          before={compare.source}
          after={compare.output}
          kind={compare.kind === 'image' ? 'image' : 'video'}
          sizeBefore={compare.meta?.sizeBefore}
          sizeAfter={compare.meta?.sizeAfter}
          trimStart={compare.meta?.trimStart}
          tempo={compare.meta?.tempo}
        />
      )}
    </div>
  )
}

/**
 * Строка очереди.
 *
 * Обёрнута в memo, а обработчики берёт из хранилища сама: если передавать их
 * сверху, на каждый рендер создавались бы новые функции, и memo не спасал бы
 * от перерисовки всего списка на каждую новость от задачи.
 */
const JobRow = memo(function JobRow({
  job,
  expanded,
  onCompare,
}: {
  job: Job
  expanded: boolean
  onCompare: (job: Job) => void
}) {
  const toast = useStore((state) => state.toast)
  const setExpanded = useStore((state) => state.setLogJob)
  const onToggle = useCallback(
    () => setExpanded(expanded ? null : job.id),
    [expanded, job.id, setExpanded],
  )
  const onCancel = useCallback(async () => {
    try {
      await api.cancelJob(job.id)
    } catch (error) {
      toast((error as Error).message, 'error')
    }
  }, [job.id, toast])
  const running = job.status === 'running' || job.status === 'queued'
  const compression = savings(job.meta?.sizeBefore, job.meta?.sizeAfter)
  // Файл мог и потяжелеть. Зелёным такое показывать нельзя: цвет читается
  // как «всё хорошо», а тут ровно наоборот.
  const grew = Boolean(
    job.meta?.sizeBefore && job.meta?.sizeAfter && job.meta.sizeAfter >= job.meta.sizeBefore,
  )
  // Сравнивать есть смысл только там, где остались оба файла: у скачивания
  // «до» просто не существует.
  const canCompare =
    job.status === 'done' &&
    job.kind !== 'download' &&
    Boolean(job.source) &&
    Boolean(job.output) &&
    // Исходник ушёл в корзину — сравнивать не с чем. Раньше кнопка
    // оставалась, а в окне сквозь пустую половину просвечивал сжатый файл,
    // и выходило, будто разницы нет вовсе.
    !job.meta?.sourceRemoved

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
            {job.status === 'error'
              ? // В строке очереди помещается одна строка — берём первую фразу
                // объяснения, а весь вывод лежит в списке ошибок и в журнале.
                (job.hint ?? job.error ?? '').split('\n')[0]
              : job.message}
            {job.meta?.preset ? ` · ${job.meta.preset}` : ''}
          </p>
        </div>

        {compression && job.status === 'done' && (
          <span
            className={`chip shrink-0 ${grew ? 'bg-warn/15 text-warn' : 'bg-ok/15 text-ok'}`}
            title={[
              `${humanSize(job.meta.sizeBefore)} → ${humanSize(job.meta.sizeAfter)}`,
              shrinkRatio(job.meta.sizeBefore, job.meta.sizeAfter),
            ]
              .filter(Boolean)
              .join(' · ')}
          >
            {compression}
          </span>
        )}

        {job.meta?.keptOriginal && (
          <span
            className="chip shrink-0 bg-warn/15 text-warn"
            title="Результат оказался тяжелее исходника, поэтому оригинал остался на месте"
          >
            оригинал оставлен
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
            <IconButton
              className="h-7 w-7"
              title="Сравнить до и после"
              onClick={() => onCompare(job)}
            >
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
})

/**
 * Разбор ошибок пачки.
 *
 * При очереди в несколько сотен файлов «5 ошибок» в строке очереди ничего не
 * говорят: искать их глазами по всему списку — занятие на полчаса. Здесь
 * сразу видно, что не прошло, где лежит и что сказала программа.
 */
/**
 * Текст ошибки: понятное объяснение и под ним вывод ffmpeg.
 *
 * Объяснение приходит отдельным полем, а не склеенным с выводом: иначе
 * пришлось бы угадывать, где кончается одно и начинается другое — а в самом
 * объяснении тоже есть пустые строки. Показывать оба куска одинаково красным
 * нельзя: самое полезное тонет в наборе английских строк, из-за которых
 * человек сюда и пришёл.
 */
function ErrorText({ hint, text }: { hint?: string | null; text: string | null }) {
  if (!hint && !text) {
    return (
      <p className="mt-1 text-[11.5px] leading-snug text-ink-dim">
        Причина неизвестна — загляните в журнал задачи.
      </p>
    )
  }
  return (
    <div className="mt-1 space-y-1.5">
      {hint && (
        <p className="whitespace-pre-wrap break-words text-[12px] leading-snug text-ink">
          {hint}
        </p>
      )}
      {text && (
        <p
          className={`whitespace-pre-wrap break-words font-mono text-[10.5px] leading-snug ${
            hint ? 'text-ink-faint' : 'text-danger'
          }`}
        >
          {text}
        </p>
      )}
    </div>
  )
}

function ErrorsModal({
  open,
  onClose,
  jobs,
}: {
  open: boolean
  onClose: () => void
  jobs: Job[]
}) {
  const toast = useStore((state) => state.toast)

  const asText = jobs
    .map((job) =>
      [job.source ?? job.title, job.hint, job.error ?? 'причина неизвестна']
        .filter(Boolean)
        .join('\n\n'),
    )
    .join('\n\n———\n\n')

  return (
    <Modal open={open} onClose={onClose} title={`Не удалось обработать: ${jobs.length}`} wide>
      <div className="space-y-2">
        {jobs.length === 0 && (
          <p className="py-6 text-center text-[12px] text-ink-faint">Ошибок нет.</p>
        )}
        {jobs.map((job) => (
          <div key={job.id} className="rounded-xl bg-surface-2 px-3 py-2.5">
            <div className="flex items-start gap-2">
              <AlertCircle size={14} className="mt-0.5 shrink-0 text-danger" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px] text-ink" title={job.title}>
                  {job.title}
                </p>
                {job.source && (
                  <p className="truncate font-mono text-[10.5px] text-ink-faint" title={job.source}>
                    {job.source}
                  </p>
                )}
                <ErrorText hint={job.hint} text={job.error} />
              </div>
              {job.source && (
                <IconButton
                  className="h-7 w-7 shrink-0"
                  title="Показать в проводнике"
                  onClick={async () => {
                    try {
                      await api.reveal(job.source!)
                    } catch (error) {
                      toast((error as Error).message, 'error')
                    }
                  }}
                >
                  <FolderOpen size={13} />
                </IconButton>
              )}
            </div>
          </div>
        ))}
      </div>

      {jobs.length > 0 && (
        <div className="mt-3 flex justify-end">
          <Button
            tone="ghost"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(asText)
                toast('Список скопирован', 'ok')
              } catch {
                toast('Не удалось скопировать список', 'error')
              }
            }}
          >
            Скопировать список
          </Button>
        </div>
      )}
    </Modal>
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

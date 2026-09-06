import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Download, Pause, Play, Scissors, Volume2, VolumeX } from 'lucide-react'
import { api } from '../lib/api'
import { humanDuration, timecode } from '../lib/format'
import type { ResolvedLink } from '../lib/types'
import { useStore } from '../store'
import { Timeline } from './Timeline'
import { Button, IconButton, Modal, Spinner } from './ui'

/**
 * Просмотр видео по ссылке до скачивания.
 *
 * Поток идёт через наш прокси, поэтому обычный тег <video> его открывает и
 * умеет перематывать. Пользователь размечает отрезок метками In/Out — и
 * скачивается только он, а не вся серия целиком.
 */
export function LinkPreview({
  url,
  open,
  onClose,
  onApply,
}: {
  url: string
  open: boolean
  onClose: () => void
  onApply: (start: number | null, end: number | null) => void
}) {
  const toast = useStore((state) => state.toast)
  const setQueueOpen = useStore((state) => state.setQueueOpen)

  const videoRef = useRef<HTMLVideoElement>(null)
  const [info, setInfo] = useState<ResolvedLink | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [trim, setTrim] = useState<{ in: number | null; out: number | null }>({
    in: null,
    out: null,
  })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open || !url) return
    let cancelled = false
    setInfo(null)
    setError(null)
    setTrim({ in: null, out: null })
    setTime(0)
    setDuration(0)
    setLoading(true)

    api
      .resolveLink(url)
      .then((data) => {
        if (cancelled) return
        setInfo(data)
        if (data.duration) setDuration(data.duration)
      })
      .catch((err) => !cancelled && setError((err as Error).message))
      .finally(() => !cancelled && setLoading(false))

    return () => {
      cancelled = true
    }
  }, [open, url])

  const seek = useCallback((value: number) => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = Math.max(0, Math.min(value, video.duration || value))
    setTime(video.currentTime)
  }, [])

  const togglePlay = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play().catch(() => setError('Поток не проигрывается'))
    else video.pause()
  }

  const ensureTrim = (total: number) => {
    if (total > 0 && trim.in === null && trim.out === null) setTrim({ in: 0, out: total })
  }

  /** Скачивает лёгкую копию целиком — для сайтов, чей поток браузер не открыл. */
  async function downloadDraft() {
    setBusy(true)
    try {
      await api.download({
        items: [{ url }],
        mode: 'video',
        max_height: 360,
      })
      toast('Черновик добавлен в очередь — потом разметьте его в медиатеке', 'ok')
      setQueueOpen(true)
      onClose()
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function downloadSection() {
    setBusy(true)
    try {
      await api.download({
        items: [{ url, start: trim.in, end: trim.out }],
        mode: 'video',
        max_height: 0,
      })
      toast('Отрезок добавлен в очередь скачивания', 'ok')
      setQueueOpen(true)
      onClose()
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const canPreview = Boolean(info?.previewToken)
  const selection =
    trim.in !== null && trim.out !== null ? Math.max(trim.out - trim.in, 0) : null

  return (
    <Modal open={open} onClose={onClose} title="Разметка до скачивания" wide>
      {loading && (
        <div className="flex items-center justify-center gap-3 py-16 text-ink-dim">
          <Spinner size={18} />
          Разбираю ссылку…
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2.5 rounded-xl border border-danger/40 bg-danger/10 px-3.5 py-3 text-[12.5px] leading-relaxed text-danger">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {info && (
        <div className="space-y-4">
          <div>
            <p className="text-[14px] font-medium">{info.title}</p>
            <p className="mt-0.5 text-[11.5px] text-ink-faint">
              {[info.uploader, info.extractor, humanDuration(info.duration)]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>

          {canPreview ? (
            <>
              <div className="relative flex min-h-[220px] items-center justify-center overflow-hidden rounded-xl bg-black">
                <video
                  ref={videoRef}
                  src={`/api/stream/${info.previewToken}`}
                  className="max-h-[46vh] max-w-full"
                  onLoadedMetadata={(event) => {
                    const total = event.currentTarget.duration || info.duration || 0
                    setDuration(total)
                    ensureTrim(total)
                  }}
                  onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onError={() =>
                    setError('Источник оборвал поток. Попробуйте скачать черновик.')
                  }
                  onClick={togglePlay}
                  playsInline
                />
              </div>

              <div className="px-1 pb-1">
                <Timeline
                  duration={duration}
                  currentTime={time}
                  inPoint={trim.in}
                  outPoint={trim.out}
                  onSeek={seek}
                  onChangeIn={(value) => setTrim({ ...trim, in: value })}
                  onChangeOut={(value) => setTrim({ ...trim, out: value })}
                  hasVideo={false}
                  hasAudio
                  playing={playing}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-2 px-3 py-2">
                <button
                  type="button"
                  onClick={togglePlay}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white hover:bg-accent-soft"
                >
                  {playing ? <Pause size={15} /> : <Play size={15} className="ml-0.5" />}
                </button>
                <span className="font-mono text-[12px] tabular-nums text-ink-dim">
                  {timecode(time, true)}{' '}
                  <span className="text-ink-faint">/ {timecode(duration)}</span>
                </span>
                <IconButton
                  onClick={() => {
                    const video = videoRef.current
                    if (!video) return
                    video.muted = !video.muted
                    setMuted(video.muted)
                  }}
                  title="Звук"
                >
                  {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
                </IconButton>

                <div className="mx-1 h-5 w-px bg-line" />

                <button
                  type="button"
                  onClick={() => setTrim({ ...trim, in: time })}
                  className="w-[92px] rounded-lg bg-surface-3 px-2.5 py-1.5 text-[12px] font-medium hover:bg-line"
                >
                  <span className="text-accent-soft">In</span>{' '}
                  <span className="tabular-nums text-ink-faint">
                    {trim.in !== null ? timecode(trim.in, true) : '—'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setTrim({ ...trim, out: time })}
                  className="w-[104px] rounded-lg bg-surface-3 px-2.5 py-1.5 text-[12px] font-medium hover:bg-line"
                >
                  <span className="text-accent-soft">Out</span>{' '}
                  <span className="tabular-nums text-ink-faint">
                    {trim.out !== null ? timecode(trim.out, true) : '—'}
                  </span>
                </button>

                {selection !== null && (
                  <span className="chip bg-accent/15 text-accent-soft">
                    <Scissors size={11} />
                    {timecode(selection, true)}
                  </span>
                )}
              </div>

              <p className="text-[11px] leading-snug text-ink-faint">
                Предпросмотр идёт в облегчённом качестве
                {info.previewHeight ? ` (${info.previewHeight}p)` : ''} — скачается всё равно
                максимальное. Скачивается только выбранный отрезок, а не весь ролик.
              </p>

              <div className="flex gap-2">
                <Button
                  tone="primary"
                  className="flex-1 py-2.5"
                  disabled={busy}
                  onClick={() => void downloadSection()}
                >
                  <Download size={15} />
                  Скачать отрезок
                </Button>
                <Button
                  onClick={() => {
                    onApply(trim.in, trim.out)
                    onClose()
                  }}
                  disabled={busy}
                >
                  Перенести тайминги в список
                </Button>
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <div className="flex items-start gap-2.5 rounded-xl border border-warn/35 bg-warn/10 px-3.5 py-3 text-[12.5px] leading-relaxed text-warn">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                <span>{info.previewNote ?? 'Предпросмотр для этой ссылки недоступен.'}</span>
              </div>
              <Button
                tone="primary"
                className="w-full py-2.5"
                disabled={busy}
                onClick={() => void downloadDraft()}
              >
                <Download size={15} />
                Скачать черновик 360p для разметки
              </Button>
              <p className="text-[11px] leading-relaxed text-ink-faint">
                Лёгкая копия целиком: откройте её в медиатеке, разметьте отрезок в обычном
                редакторе, а потом вернитесь сюда и скачайте нужный кусок в полном качестве —
                или просто сожмите черновик, если качества хватает.
              </p>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

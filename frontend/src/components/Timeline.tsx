import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react'
import { timecode } from '../lib/format'
import type { FilmstripInfo } from '../lib/types'

type Drag =
  | { kind: 'playhead' }
  | { kind: 'in' }
  | { kind: 'out' }
  | { kind: 'fade'; lane: Lane; side: 'in' | 'out' }
  | { kind: 'pan'; grabX: number; startAt: number }
  | null

export type Lane = 'video' | 'audio'

/** Затухания по дорожкам, в секундах. */
export interface Fades {
  video: { in: number; out: number }
  audio: { in: number; out: number }
}

export const emptyFades: Fades = { video: { in: 0, out: 0 }, audio: { in: 0, out: 0 } }

const STRIP_HEIGHT = 72
const WAVE_HEIGHT = 56
/** Дальше этой доли отрезка затухание тянуть нельзя — иначе оно съест весь фрагмент. */
const MAX_FADE_RATIO = 0.5
/** Самый мелкий видимый кусок таймлайна. Мельче размечать уже нечего. */
const MIN_VISIBLE_SECONDS = 0.4

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), high)

/**
 * Таймлайн в духе монтажных программ: отдельная дорожка видео с кадрами и
 * отдельная дорожка звука с осциллограммой. Метки In/Out общие, а затухание
 * у каждой дорожки своё — его тянут за уголок, как в Vegas.
 *
 * Дорожку можно приблизить: на часовом видео иначе не поставить метку точнее
 * чем «плюс-минус полминуты». Приближение всегда идёт к игле воспроизведения,
 * а под дорожкой появляется полоса прокрутки.
 */
export function Timeline({
  duration,
  currentTime,
  inPoint,
  outPoint,
  onSeek,
  onChangeIn,
  onChangeOut,
  peaks,
  peaksLoading,
  strip,
  stripLoading,
  hasVideo = true,
  hasAudio = true,
  fades,
  onFadesChange,
  playing = false,
}: {
  duration: number
  currentTime: number
  inPoint: number | null
  outPoint: number | null
  onSeek: (time: number) => void
  onChangeIn: (time: number | null) => void
  onChangeOut: (time: number | null) => void
  peaks?: number[] | null
  peaksLoading?: boolean
  strip?: FilmstripInfo | null
  stripLoading?: boolean
  hasVideo?: boolean
  hasAudio?: boolean
  fades?: Fades
  onFadesChange?: (fades: Fades) => void
  playing?: boolean
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [zoom, setZoom] = useState(1)
  const [viewStart, setViewStart] = useState(0)

  const safeDuration = duration > 0 ? duration : 1
  // Приближать дальше, чем «полсекунды на всю ширину», смысла нет.
  const maxZoom = Math.max(1, safeDuration / MIN_VISIBLE_SECONDS)
  const span = safeDuration / zoom
  const start = clamp(viewStart, 0, Math.max(safeDuration - span, 0))
  const end = start + span

  const toRatio = (time: number) => (time - start) / span

  const from = inPoint ?? 0
  const to = outPoint ?? safeDuration
  const trimSpan = Math.max(to - from, 0.01)
  const activeFades = fades ?? emptyFades

  const timeAt = useCallback(
    (clientX: number) => {
      const track = trackRef.current
      if (!track) return 0
      const rect = track.getBoundingClientRect()
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1)
      return start + ratio * span
    },
    [start, span],
  )

  /** Меняет масштаб, оставляя иглу в центре — размечают именно по ней. */
  const applyZoom = useCallback(
    (next: number, anchor?: number) => {
      const level = clamp(next, 1, maxZoom)
      const nextSpan = safeDuration / level
      const focus = anchor ?? currentTime
      setZoom(level)
      setViewStart(clamp(focus - nextSpan / 2, 0, Math.max(safeDuration - nextSpan, 0)))
    },
    [maxZoom, safeDuration, currentTime],
  )

  // Колесо над дорожкой — привычный способ приближать.
  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      applyZoom(zoom * (event.deltaY < 0 ? 1.35 : 1 / 1.35))
    }
    track.addEventListener('wheel', onWheel, { passive: false })
    return () => track.removeEventListener('wheel', onWheel)
  }, [applyZoom, zoom])

  // При воспроизведении окно едет следом, иначе игла сразу убегает за край.
  useEffect(() => {
    if (!playing || zoom === 1) return
    if (currentTime < start || currentTime > end) {
      setViewStart(clamp(currentTime - span / 2, 0, Math.max(safeDuration - span, 0)))
    }
  }, [playing, currentTime, start, end, span, safeDuration, zoom])

  // Новый файл — новый масштаб.
  useEffect(() => {
    setZoom(1)
    setViewStart(0)
  }, [duration])

  const applyDrag = useCallback(
    (mode: Drag, event: PointerEvent) => {
      if (!mode) return
      if (mode.kind === 'pan') {
        const track = trackRef.current
        if (!track) return
        const rect = track.getBoundingClientRect()
        const moved = ((event.clientX - mode.grabX) / rect.width) * safeDuration
        setViewStart(clamp(mode.startAt + moved, 0, Math.max(safeDuration - span, 0)))
        return
      }

      const time = timeAt(event.clientX)
      if (mode.kind === 'playhead') {
        onSeek(time)
      } else if (mode.kind === 'in') {
        // Точка In не должна перепрыгнуть за Out — оставляем зазор в кадр.
        const limit = outPoint !== null ? Math.max(outPoint - 0.04, 0) : safeDuration
        onChangeIn(Math.min(time, limit))
      } else if (mode.kind === 'out') {
        const limit = inPoint !== null ? inPoint + 0.04 : 0
        onChangeOut(Math.max(time, limit))
      } else if (mode.kind === 'fade' && onFadesChange) {
        const raw = mode.side === 'in' ? time - from : to - time
        const value = clamp(raw, 0, trimSpan * MAX_FADE_RATIO)
        onFadesChange({
          ...activeFades,
          [mode.lane]: {
            ...activeFades[mode.lane],
            [mode.side]: Math.round(value * 100) / 100,
          },
        })
      }
    },
    [
      inPoint, outPoint, onChangeIn, onChangeOut, onSeek, safeDuration, span,
      from, to, trimSpan, activeFades, onFadesChange, timeAt,
    ],
  )

  useEffect(() => {
    if (!drag) return
    const onMove = (event: PointerEvent) => applyDrag(drag, event)
    const onUp = () => setDrag(null)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [drag, applyDrag])

  // Деления шкалы считаем по видимому куску, а не по всей длине.
  const { ticks, tickStep } = useMemo(() => {
    const steps = [
      0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
    ]
    const step = steps.find((candidate) => span / candidate <= 10) ?? 3600
    const result: number[] = []
    for (let time = Math.ceil(start / step) * step; time <= end; time += step) {
      result.push(Math.round(time * 1000) / 1000)
    }
    return { ticks: result, tickStep: step }
  }, [span, start, end])

  const tickLabel = (value: number) =>
    tickStep < 1 ? timecode(value, true) : timecode(value)

  const selection = { from: toRatio(from), to: toRatio(to) }
  const showStrip = hasVideo && Boolean(strip || stripLoading)
  const zoomed = zoom > 1.01

  const startDrag = (event: React.PointerEvent, mode: Drag) => {
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag(mode)
  }

  return (
    <div className="select-none">
      {/* Шкала времени и управление масштабом */}
      <div className="mb-1 flex items-end gap-2">
        <div className="relative h-4 min-w-0 flex-1 overflow-hidden text-[10px] text-ink-faint">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute -translate-x-1/2 whitespace-nowrap tabular-nums"
              style={{ left: `${toRatio(tick) * 100}%` }}
            >
              {tickLabel(tick)}
            </span>
          ))}
        </div>

        <div className="flex shrink-0 items-center gap-0.5 text-ink-faint">
          {zoomed && (
            <span className="mr-1 font-mono text-[10px] tabular-nums">
              ×{zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}
            </span>
          )}
          <button
            type="button"
            onClick={() => applyZoom(zoom / 1.6)}
            disabled={!zoomed}
            title="Отдалить (колесо мыши вниз)"
            className="rounded p-1 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ZoomOut size={13} />
          </button>
          <button
            type="button"
            onClick={() => applyZoom(zoom * 1.6)}
            disabled={zoom >= maxZoom - 0.01}
            title="Приблизить к игле (колесо мыши вверх)"
            className="rounded p-1 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ZoomIn size={13} />
          </button>
          <button
            type="button"
            onClick={() => {
              setZoom(1)
              setViewStart(0)
            }}
            disabled={!zoomed}
            title="Показать целиком"
            className="rounded p-1 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <Maximize size={13} />
          </button>
        </div>
      </div>

      <div
        ref={trackRef}
        className="relative cursor-pointer overflow-hidden rounded-lg bg-surface-2 ring-1 ring-line-soft"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          setDrag({ kind: 'playhead' })
          onSeek(timeAt(event.clientX))
        }}
        onPointerMove={(event) => setHover(timeAt(event.clientX))}
        onPointerLeave={() => setHover(null)}
      >
        {/* Дорожка видео */}
        {showStrip && (
          <TrackLane
            height={STRIP_HEIGHT}
            label="Видео"
            selection={selection}
            fade={activeFades.video}
            trimSpan={trimSpan}
            editable={Boolean(onFadesChange)}
            onFadeDown={(event, side) => startDrag(event, { kind: 'fade', lane: 'video', side })}
          >
            {strip ? (
              <FilmStrip strip={strip} height={STRIP_HEIGHT} view={{ start, span, total: safeDuration }} />
            ) : (
              <div className="h-full w-full animate-pulse-soft bg-surface-3/50" />
            )}
          </TrackLane>
        )}

        {/* Дорожка звука */}
        {hasAudio && (
          <TrackLane
            height={WAVE_HEIGHT}
            label="Звук"
            selection={selection}
            fade={activeFades.audio}
            trimSpan={trimSpan}
            editable={Boolean(onFadesChange)}
            onFadeDown={(event, side) => startDrag(event, { kind: 'fade', lane: 'audio', side })}
          >
            <Waveform
              peaks={peaks}
              loading={peaksLoading}
              view={{ start, span, total: safeDuration }}
            />
          </TrackLane>
        )}

        {!showStrip && !hasAudio && <div style={{ height: WAVE_HEIGHT }} />}

        {/* Затемнение областей вне выделения */}
        <div
          className="pointer-events-none absolute inset-y-0 left-0 bg-base/70"
          style={{ width: `${clamp(selection.from, 0, 1) * 100}%` }}
        />
        <div
          className="pointer-events-none absolute inset-y-0 right-0 bg-base/70"
          style={{ width: `${clamp(1 - selection.to, 0, 1) * 100}%` }}
        />

        {/* Маркеры отрезка */}
        <Handle
          side="in"
          ratio={selection.from}
          onPointerDown={(event) => startDrag(event, { kind: 'in' })}
        />
        <Handle
          side="out"
          ratio={selection.to}
          onPointerDown={(event) => startDrag(event, { kind: 'out' })}
        />

        {/* Позиция курсора мыши */}
        {hover !== null && !drag && (
          <div
            className="pointer-events-none absolute inset-y-0 w-px bg-ink/25"
            style={{ left: `${toRatio(hover) * 100}%` }}
          />
        )}

        {/* Игла воспроизведения */}
        <div
          className="pointer-events-none absolute inset-y-0 z-10 w-[2px] bg-ok"
          style={{ left: `${toRatio(currentTime) * 100}%` }}
        >
          <span className="absolute -top-[1px] left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 rounded-[2px] bg-ok" />
        </div>
      </div>

      {/* Полоса прокрутки — появляется, только когда есть куда ехать */}
      {zoomed && (
        <div
          className="relative mt-1 h-2 cursor-grab rounded-full bg-surface-2"
          onPointerDown={(event) => {
            // Клик мимо ползунка переносит окно туда, куда ткнули.
            const rect = event.currentTarget.getBoundingClientRect()
            const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1)
            setViewStart(
              clamp(ratio * safeDuration - span / 2, 0, Math.max(safeDuration - span, 0)),
            )
          }}
        >
          <div
            className="absolute inset-y-0 rounded-full bg-line transition-colors hover:bg-surface-3"
            style={{
              left: `${(start / safeDuration) * 100}%`,
              width: `${Math.max((span / safeDuration) * 100, 4)}%`,
            }}
            onPointerDown={(event) => {
              event.stopPropagation()
              event.currentTarget.setPointerCapture(event.pointerId)
              setDrag({ kind: 'pan', grabX: event.clientX, startAt: start })
            }}
          />
        </div>
      )}

      {/* Подписи меток */}
      <div className="relative mt-1 h-4 overflow-hidden text-[10px] tabular-nums text-accent-soft">
        <span className="absolute" style={{ left: `${clamp(selection.from, 0, 0.98) * 100}%` }}>
          {timecode(from, true)}
        </span>
        <span
          className="absolute -translate-x-full"
          style={{ left: `${clamp(selection.to, 0.02, 1) * 100}%` }}
        >
          {timecode(to, true)}
        </span>
      </div>
    </div>
  )
}

/**
 * Одна дорожка: содержимое плюс уголки затухания на границах отрезка.
 * Уголок тянут внутрь — ровно как ручку fade в монтажных программах.
 */
function TrackLane({
  height,
  label,
  selection,
  fade,
  trimSpan,
  editable,
  onFadeDown,
  children,
}: {
  height: number
  label: string
  selection: { from: number; to: number }
  fade: { in: number; out: number }
  trimSpan: number
  editable: boolean
  onFadeDown: (event: React.PointerEvent, side: 'in' | 'out') => void
  children: React.ReactNode
}) {
  const width = Math.max(selection.to - selection.from, 0.0001)
  // Длительность затухания в долях видимой дорожки — чтобы рисовать в процентах.
  const fadeInWidth = (fade.in / trimSpan) * width
  const fadeOutWidth = (fade.out / trimSpan) * width

  return (
    <div className="relative border-b border-line-soft/60 last:border-b-0" style={{ height }}>
      {children}

      <span className="pointer-events-none absolute left-1.5 top-1 z-[5] rounded bg-black/45 px-1 text-[9px] font-medium uppercase tracking-wide text-white/60">
        {label}
      </span>

      {/* Наклонная заливка, показывающая само затухание */}
      {fade.in > 0 && (
        <div
          className="pointer-events-none absolute inset-y-0 z-[4] bg-base/85"
          style={{
            left: `${selection.from * 100}%`,
            width: `${fadeInWidth * 100}%`,
            clipPath: 'polygon(0 0, 100% 0, 0 100%)',
          }}
        />
      )}
      {fade.out > 0 && (
        <div
          className="pointer-events-none absolute inset-y-0 z-[4] bg-base/85"
          style={{
            left: `${(selection.to - fadeOutWidth) * 100}%`,
            width: `${fadeOutWidth * 100}%`,
            clipPath: 'polygon(100% 0, 100% 100%, 0 0)',
          }}
        />
      )}

      {editable && (
        <>
          <FadeGrip
            side="in"
            title={`Затухание в начале: ${fade.in.toFixed(2)} с. Тяните вправо.`}
            left={selection.from + fadeInWidth}
            onPointerDown={(event) => onFadeDown(event, 'in')}
            active={fade.in > 0}
          />
          <FadeGrip
            side="out"
            title={`Затухание в конце: ${fade.out.toFixed(2)} с. Тяните влево.`}
            left={selection.to - fadeOutWidth}
            onPointerDown={(event) => onFadeDown(event, 'out')}
            active={fade.out > 0}
          />
        </>
      )}
    </div>
  )
}

/**
 * Уголок затухания. Он растёт внутрь отрезка, а не по центру границы —
 * иначе на самых краях его срезала бы рамка дорожки, а посередине он дрался
 * бы за клик с маркером In/Out. Слой выше маркеров: верхние 16 пикселей
 * дорожки принадлежат затуханию, всё что ниже — обрезке.
 */
function FadeGrip({
  side,
  left,
  onPointerDown,
  title,
  active,
}: {
  side: 'in' | 'out'
  left: number
  onPointerDown: (event: React.PointerEvent) => void
  title: string
  active: boolean
}) {
  return (
    <div
      title={title}
      className="group absolute top-0 z-30 h-4 w-5 cursor-ew-resize"
      style={{
        left: `${left * 100}%`,
        transform: side === 'in' ? 'none' : 'translateX(-100%)',
      }}
      onPointerDown={onPointerDown}
    >
      <span
        className={`absolute top-[4px] h-2.5 w-2.5 rotate-45 rounded-[2px] border transition-all group-hover:scale-125 ${
          side === 'in' ? 'left-[3px]' : 'right-[3px]'
        } ${
          active
            ? 'border-white/70 bg-accent-soft'
            : 'border-white/50 bg-white/30 group-hover:bg-accent-soft'
        }`}
      />
    </div>
  )
}

interface View {
  start: number
  span: number
  total: number
}

/**
 * Лента кадров. Все кадры лежат в одной картинке-спрайте; при приближении
 * лента растягивается и сдвигается вместе с дорожкой, поэтому под иглой
 * остаётся тот же кадр, что и был.
 */
function FilmStrip({
  strip,
  height,
  view,
}: {
  strip: FilmstripInfo
  height: number
  view: View
}) {
  const tileWidth = (height * strip.tileWidth) / strip.tileHeight
  // Лента растягивается во столько раз, во сколько приблизили дорожку...
  const scale = view.total / view.span
  // ...а сдвиг считается в процентах от её собственной (уже растянутой)
  // ширины — поэтому масштаб сюда второй раз умножать не нужно.
  const shift = (view.start / view.total) * 100

  return (
    <div className="h-full w-full overflow-hidden">
      <div
        className="flex h-full origin-left"
        style={{
          width: `${scale * 100}%`,
          transform: `translateX(-${shift}%)`,
        }}
      >
        {Array.from({ length: strip.frames }, (_, index) => (
          <div
            key={index}
            className="h-full min-w-0 flex-1 bg-no-repeat"
            style={{
              backgroundImage: `url(${strip.url})`,
              backgroundSize: `auto ${height}px`,
              backgroundPositionX: `-${index * tileWidth}px`,
            }}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * Осциллограмма одной заливкой: строим верхнюю огибающую слева направо,
 * затем возвращаемся справа налево по нижней — получается симметричная
 * фигура, которую браузер рисует одним путём, а не тысячей прямоугольников.
 */
function Waveform({
  peaks,
  loading,
  view,
}: {
  peaks?: number[] | null
  loading?: boolean
  view: View
}) {
  // При приближении берём только те отсчёты, что попали в видимый кусок —
  // иначе волна остаётся «мелкой» и по ней всё так же не прицелиться.
  const visible = useMemo(() => {
    if (!peaks || peaks.length < 2) return null
    const first = Math.floor((view.start / view.total) * peaks.length)
    const last = Math.ceil(((view.start + view.span) / view.total) * peaks.length)
    const slice = peaks.slice(Math.max(first, 0), Math.min(last, peaks.length))
    return slice.length >= 2 ? slice : peaks
  }, [peaks, view.start, view.span, view.total])

  const path = useMemo(() => {
    if (!visible) return null

    const width = 1000
    const middle = 50
    const amplitude = 46
    const step = width / (visible.length - 1)

    const top: string[] = []
    const bottom: string[] = []
    visible.forEach((value, index) => {
      const x = (index * step).toFixed(2)
      // Совсем тихие места всё равно рисуем ниткой, иначе дорожка «рвётся».
      const height = Math.max(value * amplitude, 0.6)
      top.push(`${x},${(middle - height).toFixed(2)}`)
      bottom.push(`${x},${(middle + height).toFixed(2)}`)
    })

    return `M${top.join('L')}L${bottom.reverse().join('L')}Z`
  }, [visible])

  if (!path) {
    return (
      <div
        className={`pointer-events-none absolute inset-0 opacity-[0.12] ${
          loading ? 'animate-pulse-soft' : ''
        }`}
        style={{
          backgroundImage:
            'repeating-linear-gradient(90deg, var(--color-ink) 0 1px, transparent 1px 6px)',
        }}
      />
    )
  }

  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 1000 100"
      preserveAspectRatio="none"
      aria-hidden
    >
      <path d={path} fill="var(--color-ink-dim)" opacity="0.55" />
    </svg>
  )
}

function Handle({
  side,
  ratio,
  onPointerDown,
}: {
  side: 'in' | 'out'
  ratio: number
  onPointerDown: (event: React.PointerEvent) => void
}) {
  // Метка вне видимого окна не должна ловить клики у самого края.
  if (ratio < -0.02 || ratio > 1.02) return null

  return (
    <div
      className="absolute inset-y-0 z-20 w-4 -translate-x-1/2 cursor-ew-resize"
      style={{ left: `${ratio * 100}%` }}
      onPointerDown={onPointerDown}
    >
      <div className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 bg-accent" />
      <div className="absolute top-1/2 left-1/2 flex h-7 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[4px] bg-accent text-[9px] font-bold text-white shadow">
        {side === 'in' ? 'I' : 'O'}
      </div>
    </div>
  )
}

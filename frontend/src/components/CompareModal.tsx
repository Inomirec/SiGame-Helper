import { useCallback, useEffect, useRef, useState } from 'react'
import { Pause, Play, Volume2, VolumeX } from 'lucide-react'
import { mediaUrl } from '../lib/api'
import { fileName, humanSize, savings, timecode } from '../lib/format'
import { Modal } from './ui'

/**
 * Сравнение «до / после» шторкой.
 *
 * Оба файла лежат друг на друге, верхний обрезан по позиции ползунка. Для
 * видео проигрывание синхронизировано: оба ролика идут с одного места, иначе
 * сравнивать бессмысленно.
 */
export function CompareModal({
  before,
  after,
  kind,
  sizeBefore,
  sizeAfter,
  trimStart = 0,
  tempo = 1,
  open,
  onClose,
}: {
  before: string
  after: string
  kind: 'image' | 'video'
  sizeBefore?: number
  sizeAfter?: number
  /** С какой секунды исходника начинается результат. */
  trimStart?: number
  /** Во сколько раз результат быстрее исходника. */
  tempo?: number
  open: boolean
  onClose: () => void
}) {
  // Результат обрезан и может идти быстрее, поэтому его секунда — это
  // не секунда исходника. Ведущим делаем результат: именно его человек
  // и пришёл оценивать, а исходник подтягиваем к нему по этой формуле.
  const rate = tempo || 1
  const toBefore = (value: number) => trimStart + value * rate

  const shellRef = useRef<HTMLDivElement>(null)
  const leftVideo = useRef<HTMLVideoElement>(null)
  const rightVideo = useRef<HTMLVideoElement>(null)

  const [position, setPosition] = useState(50)
  const [dragging, setDragging] = useState(false)
  // Масштаб и сдвиг. Накладываются на сами кадры, а не на общую обёртку:
  // шторка должна остаться на месте, она живёт в экранных координатах.
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [panning, setPanning] = useState(false)
  const spaceRef = useRef(false)
  const panRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const viewRef = useRef({ zoom: 1, pan: { x: 0, y: 0 } })
  viewRef.current = { zoom, pan }

  /** Одинаковое преобразование для обоих кадров — иначе сравнивать нечего. */
  const frameStyle = { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }

  const resetView = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [failed, setFailed] = useState(false)
  // Исходник могли удалить сразу после обработки — тогда показывать нечего.
  // Раньше на его месте оставался значок битой картинки, который ничего
  // не объяснял.
  const [beforeGone, setBeforeGone] = useState(false)
  // Громкость запоминаем ту же, что и в основном плеере.
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('sgh.volume') ?? '1'))

  useEffect(() => {
    if (open) {
      setPosition(50)
      setPlaying(false)
      setTime(0)
      setFailed(false)
    }
  }, [open, before, after])

  // Звучит только левая (исходная) сторона — правую держим немой,
  // иначе два трека накладываются друг на друга.
  useEffect(() => {
    if (leftVideo.current) leftVideo.current.volume = volume
  }, [volume, open])

  const moveTo = useCallback((clientX: number) => {
    const shell = shellRef.current
    if (!shell) return
    const rect = shell.getBoundingClientRect()
    setPosition(Math.min(Math.max(((clientX - rect.left) / rect.width) * 100, 0), 100))
  }, [])

  useEffect(() => {
    if (!dragging) return
    const onMove = (event: PointerEvent) => moveTo(event.clientX)
    const onUp = () => setDragging(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragging, moveTo])

  // Два отдельных плеера расходятся сами по себе: запускаются они не
  // одновременно, а тяжёлый кодек декодируется медленнее. Держим их вместе
  // на каждом кадре: мелкое расхождение выбираем лёгким изменением скорости
  // (рывка не видно), крупное — перемоткой.
  useEffect(() => {
    if (!open) return

    const tick = () => {
      const left = leftVideo.current
      const right = rightVideo.current
      if (!left || !right || !left.duration) return

      const target = toBefore(right.currentTime)
      const drift = left.currentTime - target
      if (right.paused) {
        left.playbackRate = rate
        // На паузе допуск — меньше кадра: именно здесь человек и всматривается.
        if (Math.abs(drift) > 0.02) left.currentTime = target
        return
      }
      if (Math.abs(drift) > 0.4) {
        left.currentTime = target
        return
      }
      // Отстал — чуть ускоряем, забежал — чуть замедляем.
      left.playbackRate = Math.max(0.5, Math.min(2, rate * (1 - drift * 0.6)))
    }

    // Таймер, а не покадровый вызов: тот замирает, когда окно свернули,
    // и плееры молча разъезжаются.
    const timer = setInterval(tick, 50)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rate, trimStart])

  function togglePlay() {
    const left = leftVideo.current
    const right = rightVideo.current
    if (!left || !right) return
    if (right.paused) {
      left.currentTime = toBefore(right.currentTime)
      // Исходник должен идти быстрее ровно во столько, во сколько
      // результат ускорен, иначе они разъедутся за первые же секунды.
      left.playbackRate = rate
      void left.play()
      void right.play()
    } else {
      left.pause()
      right.pause()
    }
  }

  function seek(value: number) {
    const left = leftVideo.current
    const right = rightVideo.current
    if (!left || !right) return
    right.currentTime = value
    left.currentTime = toBefore(value)
    setTime(value)
  }

  // Колесо приближает к точке под курсором: разглядывают всегда конкретное
  // место кадра, а не его середину.
  useEffect(() => {
    const shell = shellRef.current
    if (!shell || !open) return

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const box = shell.getBoundingClientRect()
      const mx = event.clientX - (box.left + box.width / 2)
      const my = event.clientY - (box.top + box.height / 2)
      const { zoom: current, pan: offset } = viewRef.current
      const next = Math.min(16, Math.max(1, current * (event.deltaY < 0 ? 1.2 : 1 / 1.2)))
      if (next === current) return
      const ratio = next / current
      setZoom(next)
      setPan(
        next === 1
          ? { x: 0, y: 0 }
          : { x: mx - ratio * (mx - offset.x), y: my - ratio * (my - offset.y) },
      )
    }

    shell.addEventListener('wheel', onWheel, { passive: false })
    return () => shell.removeEventListener('wheel', onWheel)
  }, [open])

  // Пробел — временный режим руки: левая кнопка занята шторкой.
  useEffect(() => {
    if (!open) return
    const down = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (event.code !== 'Space') return
      event.preventDefault()
      spaceRef.current = true
      setSpaceHeld(true)
    }
    const up = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return
      spaceRef.current = false
      setSpaceHeld(false)
    }
    const blur = () => {
      spaceRef.current = false
      setSpaceHeld(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [open])

  useEffect(() => {
    if (!panning) return
    const move = (event: PointerEvent) => {
      const start = panRef.current
      if (!start) return
      setPan({ x: start.px + (event.clientX - start.x), y: start.py + (event.clientY - start.y) })
    }
    const stop = () => {
      panRef.current = null
      setPanning(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [panning])

  // Новое сравнение — прежний масштаб ни к чему.
  useEffect(() => {
    if (!open) resetView()
  }, [open, resetView])

  const delta = savings(sizeBefore, sizeAfter)

  return (
    <Modal open={open} onClose={onClose} title="До и после" wide>
      <div className="space-y-3">
        <div
          ref={shellRef}
          className={`relative flex min-h-[240px] select-none items-center overflow-hidden rounded-xl bg-black ${
            panning ? 'cursor-grabbing' : spaceHeld ? 'cursor-grab' : 'cursor-ew-resize'
          }`}
          onPointerDown={(event) => {
            // Средняя кнопка и пробел двигают кадр, левая — тянет шторку.
            if (event.button === 1 || (event.button === 0 && spaceRef.current)) {
              event.preventDefault()
              panRef.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y }
              setPanning(true)
              return
            }
            if (event.button !== 0) return
            setDragging(true)
            moveTo(event.clientX)
          }}
          onAuxClick={(event) => event.preventDefault()}
          onDragStart={(event) => event.preventDefault()}
        >
          {kind === 'image' ? (
            <>
              <img
                src={mediaUrl(after)}
                alt="после"
                className="block max-h-[58vh] w-full object-contain"
                style={frameStyle}
                draggable={false}
                onError={() => setFailed(true)}
              />
              <div
                className="absolute inset-0 overflow-hidden"
                style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
              >
                {beforeGone ? (
                  // Текст прижат к левому краю: по центру шторка разрезала бы
                  // его пополам на любом положении около середины.
                  <div className="flex h-full w-full items-center bg-base px-5">
                    <p className="max-w-[12rem] text-[12px] leading-snug text-ink-faint">
                      Оригинал удалён — сравнивать не с чем.
                    </p>
                  </div>
                ) : (
                  <img
                    src={mediaUrl(before)}
                    alt=""
                    className="block max-h-[58vh] w-full object-contain"
                    style={frameStyle}
                    draggable={false}
                    onError={() => setBeforeGone(true)}
                  />
                )}
              </div>
            </>
          ) : (
            <>
              <video
                ref={rightVideo}
                src={mediaUrl(after)}
                className="block max-h-[58vh] w-full object-contain"
                style={frameStyle}
                muted
                playsInline
                onLoadedMetadata={(event) => {
                  // Пока видео не проиграно ни разу, оно показывает чёрный
                  // прямоугольник. Лёгкий сдвиг заставляет его декодировать
                  // первый кадр — иначе половина сравнения выглядит пустой.
                  const element = event.currentTarget
                  setDuration(element.duration || 0)
                  element.currentTime = 0.04
                }}
                onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
              />
              <div
                className="absolute inset-0 overflow-hidden"
                style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
              >
                <video
                  ref={leftVideo}
                  src={mediaUrl(before)}
                  className="block max-h-[58vh] w-full object-contain"
                style={frameStyle}
                  playsInline
                  onLoadedData={(event) => {
                    event.currentTarget.currentTime = toBefore(0.04)
                  }}
                />
              </div>
            </>
          )}

          {/* Сама шторка */}
          <div
            className="pointer-events-none absolute inset-y-0 w-0.5 bg-white/90"
            style={{ left: `${position}%` }}
          >
            <span className="absolute top-1/2 left-1/2 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-[11px] font-bold text-black shadow-lg">
              ⇔
            </span>
          </div>

          {/* Масштаб: показывает текущий и возвращает исходный вид */}
          {(zoom !== 1 || pan.x !== 0 || pan.y !== 0) && (
            <button
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={resetView}
              title="Вернуть исходный вид. Колесо — приблизить, средняя кнопка или пробел — двигать"
              className="absolute bottom-2 right-2 rounded-lg bg-black/70 px-2 py-1 font-mono text-[11px] tabular-nums text-white/80 ring-1 ring-white/20 hover:text-white"
            >
              {Math.round(zoom * 100)}%
            </button>
          )}

          {failed && (
            <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-[12.5px] leading-relaxed text-warn">
              Не удалось открыть один из файлов — сравнить не получится.
              Сам файл при этом в порядке, откройте его в проводнике.
            </p>
          )}

          {!beforeGone && (
            <span className="pointer-events-none absolute left-3 top-3 rounded-md bg-black/70 px-2 py-1 text-[11px] font-medium text-white">
              до {sizeBefore ? `· ${humanSize(sizeBefore)}` : ''}
            </span>
          )}
          <span className="pointer-events-none absolute right-3 top-3 rounded-md bg-black/70 px-2 py-1 text-[11px] font-medium text-white">
            после {sizeAfter ? `· ${humanSize(sizeAfter)}` : ''}
          </span>
        </div>

        {kind === 'video' && (
          <div className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2">
            <button
              type="button"
              onClick={togglePlay}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white hover:bg-accent-soft"
            >
              {playing ? <Pause size={15} /> : <Play size={15} className="ml-0.5" />}
            </button>
            <span className="font-mono text-[12px] tabular-nums text-ink-dim">
              {timecode(time, true)} <span className="text-ink-faint">/ {timecode(duration)}</span>
            </span>
            <input
              type="range"
              className="flex-1"
              min={0}
              max={duration || 0}
              step={0.05}
              value={time}
              onChange={(event) => seek(Number(event.target.value))}
            />

            <button
              type="button"
              onClick={() => setVolume(volume > 0 ? 0 : 1)}
              className="shrink-0 rounded-lg p-1.5 text-ink-dim transition-colors hover:bg-surface-3 hover:text-ink"
              title="Выключить звук"
            >
              {volume > 0 ? <Volume2 size={15} /> : <VolumeX size={15} />}
            </button>
            <input
              type="range"
              className="w-24 shrink-0"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              title="Громкость"
              onChange={(event) => {
                const value = Number(event.target.value)
                setVolume(value)
                localStorage.setItem('sgh.volume', String(value))
              }}
            />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-faint">
          <span className="truncate">до: {fileName(before)}</span>
          <span className="truncate">после: {fileName(after)}</span>
          {delta && (
            <span className="ml-auto rounded bg-ok/15 px-1.5 py-0.5 font-semibold text-ok">
              {delta}
            </span>
          )}
        </div>

        <p className="text-[11px] leading-snug text-ink-faint">
          Тяните шторку мышью. У видео звук идёт только с левой стороны — так слышно, что
          сделала нормализация громкости.
        </p>
      </div>
    </Modal>
  )
}

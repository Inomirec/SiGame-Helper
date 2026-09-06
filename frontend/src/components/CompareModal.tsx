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
  open,
  onClose,
}: {
  before: string
  after: string
  kind: 'image' | 'video'
  sizeBefore?: number
  sizeAfter?: number
  open: boolean
  onClose: () => void
}) {
  const shellRef = useRef<HTMLDivElement>(null)
  const leftVideo = useRef<HTMLVideoElement>(null)
  const rightVideo = useRef<HTMLVideoElement>(null)

  const [position, setPosition] = useState(50)
  const [dragging, setDragging] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [failed, setFailed] = useState(false)
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

  function togglePlay() {
    const left = leftVideo.current
    const right = rightVideo.current
    if (!left || !right) return
    if (left.paused) {
      right.currentTime = left.currentTime
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
    left.currentTime = value
    right.currentTime = value
    setTime(value)
  }

  const delta = savings(sizeBefore, sizeAfter)

  return (
    <Modal open={open} onClose={onClose} title="До и после" wide>
      <div className="space-y-3">
        <div
          ref={shellRef}
          className="relative flex min-h-[240px] select-none items-center overflow-hidden rounded-xl bg-black"
          onPointerDown={(event) => {
            setDragging(true)
            moveTo(event.clientX)
          }}
        >
          {kind === 'image' ? (
            <>
              <img
                src={mediaUrl(after)}
                alt="после"
                className="block max-h-[58vh] w-full object-contain"
                draggable={false}
                onError={() => setFailed(true)}
              />
              <div
                className="absolute inset-0 overflow-hidden"
                style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
              >
                <img
                  src={mediaUrl(before)}
                  alt="до"
                  className="block max-h-[58vh] w-full object-contain"
                  draggable={false}
                />
              </div>
            </>
          ) : (
            <>
              <video
                ref={rightVideo}
                src={mediaUrl(after)}
                className="block max-h-[58vh] w-full object-contain"
                muted
                playsInline
                onLoadedMetadata={(event) => {
                  // Пока видео не проиграно ни разу, оно показывает чёрный
                  // прямоугольник. Лёгкий сдвиг заставляет его декодировать
                  // первый кадр — иначе половина сравнения выглядит пустой.
                  const element = event.currentTarget
                  element.currentTime = leftVideo.current?.currentTime || 0.04
                }}
              />
              <div
                className="absolute inset-0 overflow-hidden"
                style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
              >
                <video
                  ref={leftVideo}
                  src={mediaUrl(before)}
                  className="block max-h-[58vh] w-full object-contain"
                  playsInline
                  onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
                  onTimeUpdate={(event) => {
                    setTime(event.currentTarget.currentTime)
                    // Правое видео потихоньку уплывает — подтягиваем его назад.
                    const right = rightVideo.current
                    if (right && Math.abs(right.currentTime - event.currentTarget.currentTime) > 0.2) {
                      right.currentTime = event.currentTarget.currentTime
                    }
                  }}
                  onSeeked={(event) => {
                    const right = rightVideo.current
                    if (right) right.currentTime = event.currentTarget.currentTime
                  }}
                  onLoadedData={(event) => {
                    const right = rightVideo.current
                    if (right) right.currentTime = event.currentTarget.currentTime || 0.04
                  }}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
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

          {failed && (
            <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-[12.5px] leading-relaxed text-warn">
              Браузер не смог открыть один из файлов — сравнить не получится.
              Сам файл при этом в порядке, откройте его в проводнике.
            </p>
          )}

          <span className="pointer-events-none absolute left-3 top-3 rounded-md bg-black/70 px-2 py-1 text-[11px] font-medium text-white">
            до {sizeBefore ? `· ${humanSize(sizeBefore)}` : ''}
          </span>
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

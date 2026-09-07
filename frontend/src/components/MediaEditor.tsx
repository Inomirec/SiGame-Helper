import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Camera,
  ChevronsLeft,
  ChevronsRight,
  Maximize2,
  Pause,
  Play,
  Repeat,
  Scissors,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { api, mediaUrl } from '../lib/api'
import { humanSize, timecode } from '../lib/format'
import type { FileInfo, FilmstripInfo } from '../lib/types'
import { useStore } from '../store'
import { Timeline, type Fades } from './Timeline'
import { IconButton } from './ui'

export interface TrimState {
  in: number | null
  out: number | null
}

const VOLUME_KEY = 'sgh.volume'

/**
 * Во сколько раз приглушить дорожку в конкретный момент.
 *
 * Возвращает 1 в середине отрезка и плавно уходит в 0 на краях. Кривая
 * четвертьсинусоидная — та же, что применяется при экспорте, поэтому
 * предпросмотр совпадает с результатом.
 */
function fadeGain(
  time: number,
  from: number,
  to: number,
  fadeIn: number,
  fadeOut: number,
): number {
  let gain = 1
  if (fadeIn > 0 && time < from + fadeIn) {
    gain = Math.min(gain, Math.max((time - from) / fadeIn, 0))
  }
  if (fadeOut > 0 && time > to - fadeOut) {
    gain = Math.min(gain, Math.max((to - time) / fadeOut, 0))
  }
  return Math.sin((Math.PI / 2) * Math.min(Math.max(gain, 0), 1))
}

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2]

/** Плеер с таймлайном и метками In/Out для видео и аудио. */
export function MediaEditor({
  file,
  trim,
  onTrimChange,
  fades,
  onFadesChange,
}: {
  file: FileInfo
  trim: TrimState
  onTrimChange: (trim: TrimState) => void
  fades: Fades
  onFadesChange: (fades: Fades) => void
}) {
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null)
  const shellRef = useRef<HTMLDivElement>(null)

  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(file.media?.duration ?? 0)
  const [volume, setVolume] = useState(() => Number(localStorage.getItem(VOLUME_KEY) ?? '1'))
  const [muted, setMuted] = useState(false)
  const [rate, setRate] = useState(1)
  const [loopSelection, setLoopSelection] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [peaks, setPeaks] = useState<number[] | null>(null)
  const [peaksLoading, setPeaksLoading] = useState(false)
  const [strip, setStrip] = useState<FilmstripInfo | null>(null)
  const [stripLoading, setStripLoading] = useState(false)
  const [grabbing, setGrabbing] = useState(false)
  // Насколько затемнить картинку прямо сейчас — показываем затухание вживую.
  const [dim, setDim] = useState(0)

  const toast = useStore((state) => state.toast)
  const setQueueOpen = useStore((state) => state.setQueueOpen)

  const isVideo = file.kind === 'video'

  /**
   * Метки должны существовать сразу, а не появляться после нажатия I/O:
   * как только известна длительность, ставим их на края файла — тогда
   * ползунки видно на таймлайне с первого кадра и их можно просто тянуть.
   */
  const ensureTrim = useCallback(
    (total: number) => {
      if (total > 0 && trim.in === null && trim.out === null) {
        onTrimChange({ in: 0, out: total })
      }
    },
    [trim.in, trim.out, onTrimChange],
  )

  // ensureTrim пересоздаётся при каждом изменении меток, и если держать его
  // в зависимостях эффекта ниже, тот срабатывает на любое движение границы
  // и сбрасывает время на ноль — игла прыгает в начало прямо во время
  // разметки. Держим функцию в ссылке: эффект должен реагировать только
  // на смену файла.
  const ensureTrimRef = useRef(ensureTrim)
  ensureTrimRef.current = ensureTrim

  // При смене файла сбрасываем состояние плеера, но не трогаем метки:
  // ими управляет родитель, который сам обнуляет их при выборе другого файла.
  useEffect(() => {
    setTime(0)
    setPlaying(false)
    setError(null)
    const total = file.media?.duration ?? 0
    setDuration(total)
    ensureTrimRef.current(total)
  }, [file.path, file.media?.duration])

  // Осциллограмму считает бэкенд и кэширует на диске: во второй раз она
  // появляется мгновенно. Пока считается — на дорожке видна заглушка.
  useEffect(() => {
    if (!file.media?.hasAudio) {
      setPeaks(null)
      return
    }
    let cancelled = false
    setPeaks(null)
    setPeaksLoading(true)
    api
      .waveform(file.path)
      .then((data) => {
        if (!cancelled) setPeaks(data.peaks ?? null)
      })
      .catch(() => {
        // Волна — украшение, а не функциональность: молча остаёмся без неё.
        if (!cancelled) setPeaks(null)
      })
      .finally(() => {
        if (!cancelled) setPeaksLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [file.path, file.media?.hasAudio])

  // Лента кадров для верхней дорожки — её тоже готовит и кэширует бэкенд.
  useEffect(() => {
    if (file.kind !== 'video') {
      setStrip(null)
      return
    }
    let cancelled = false
    setStrip(null)
    setStripLoading(true)
    api
      .filmstrip(file.path)
      .then((data) => {
        if (!cancelled) setStrip(data)
      })
      .catch(() => {
        if (!cancelled) setStrip(null)
      })
      .finally(() => {
        if (!cancelled) setStripLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [file.path, file.kind])

  /** Держит громкость и затемнение в соответствии с нарисованными затуханиями. */
  const applyFades = useCallback(
    (media: HTMLVideoElement | HTMLAudioElement, at: number) => {
      const from = trim.in ?? 0
      const to = trim.out ?? duration ?? 0
      const audioGain = fadeGain(at, from, to, fades.audio.in, fades.audio.out)
      media.volume = muted ? 0 : volume * audioGain
      setDim(1 - fadeGain(at, from, to, fades.video.in, fades.video.out))
    },
    [trim.in, trim.out, duration, fades, volume, muted],
  )

  useEffect(() => {
    const media = mediaRef.current
    if (!media) return
    media.muted = muted
    media.playbackRate = rate
    applyFades(media, media.currentTime)
  }, [volume, muted, rate, file.path, applyFades])

  const seek = useCallback((value: number) => {
    const media = mediaRef.current
    if (!media) return
    const target = Math.min(Math.max(value, 0), media.duration || value)
    media.currentTime = target
    setTime(target)
  }, [])

  const togglePlay = useCallback(() => {
    const media = mediaRef.current
    if (!media) return
    if (media.paused) {
      // Зацикленный предпросмотр всегда стартует с точки In.
      if (loopSelection && trim.in !== null && (media.currentTime < trim.in || (trim.out !== null && media.currentTime >= trim.out))) {
        media.currentTime = trim.in
      }
      void media.play().catch((err) => setError(String(err)))
    } else {
      media.pause()
    }
  }, [loopSelection, trim.in, trim.out])

  const nudge = useCallback(
    (delta: number) => {
      const media = mediaRef.current
      if (!media) return
      seek(media.currentTime + delta)
    },
    [seek],
  )

  const setIn = useCallback(() => {
    const media = mediaRef.current
    if (!media) return
    const value = media.currentTime
    const total = media.duration || duration
    // Если новая метка начала оказалась правее конца — отодвигаем конец в хвост,
    // иначе выделение схлопнулось бы в ноль.
    const end = trim.out !== null && trim.out <= value ? total : trim.out
    onTrimChange({ in: value, out: end ?? total })
  }, [onTrimChange, trim.out, duration])

  const setOut = useCallback(() => {
    const media = mediaRef.current
    if (!media) return
    const value = media.currentTime
    const start = trim.in !== null && trim.in >= value ? 0 : trim.in
    onTrimChange({ in: start ?? 0, out: value })
  }, [onTrimChange, trim.in])

  /** Сохраняет текущий кадр отдельной картинкой — для вопросов-угадаек. */
  const grabFrame = useCallback(async () => {
    const media = mediaRef.current
    if (!media || !isVideo) return
    setGrabbing(true)
    try {
      await api.exportFrame({
        source: file.path,
        time: media.currentTime,
        image: { format: 'avif', target_kb: 100, max_dimension: 1920, effort: 4 },
      })
      toast('Кадр сохранён в очередь — появится в подпапке _processed', 'ok')
      setQueueOpen(true)
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setGrabbing(false)
    }
  }, [file.path, isVideo, toast, setQueueOpen])

  // Горячие клавиши работают, пока фокус не в поле ввода.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (event.ctrlKey || event.metaKey || event.altKey) return

      switch (event.code) {
        case 'Space':
          event.preventDefault()
          togglePlay()
          break
        case 'KeyI':
          event.preventDefault()
          setIn()
          break
        case 'KeyO':
          event.preventDefault()
          setOut()
          break
        case 'KeyL':
          setLoopSelection((value) => !value)
          break
        case 'KeyS':
          event.preventDefault()
          void grabFrame()
          break
        case 'KeyM':
          setMuted((value) => !value)
          break
        case 'ArrowLeft':
          event.preventDefault()
          nudge(event.shiftKey ? -1 / 30 : -5)
          break
        case 'ArrowRight':
          event.preventDefault()
          nudge(event.shiftKey ? 1 / 30 : 5)
          break
        case 'Home':
          seek(0)
          break
        case 'End':
          seek(duration)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, setIn, setOut, nudge, seek, duration, grabFrame])

  const onTimeUpdate = () => {
    const media = mediaRef.current
    if (!media) return
    // Зацикливание выделенного отрезка — предпросмотр будущего среза.
    if (loopSelection && trim.out !== null && media.currentTime >= trim.out) {
      media.currentTime = trim.in ?? 0
      return
    }
    setTime(media.currentTime)
    applyFades(media, media.currentTime)
  }

  const media = file.media
  const selectionLength =
    trim.in !== null || trim.out !== null
      ? (trim.out ?? duration) - (trim.in ?? 0)
      : null

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* Область просмотра */}
      <div
        ref={shellRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl bg-black ring-1 ring-line-soft"
      >
        {!file.playable && (
          <div className="absolute inset-x-0 top-0 z-10 bg-warn/15 px-4 py-2 text-center text-[12px] text-warn">
            Браузер, скорее всего, не откроет «.{file.ext}». Файл можно обработать без предпросмотра —
            или сначала сделать быстрый ремукс в MP4.
          </div>
        )}

        {isVideo ? (
          <video
            key={file.path}
            ref={mediaRef as React.RefObject<HTMLVideoElement>}
            src={mediaUrl(file.path)}
            className="max-h-full max-w-full"
            onLoadedMetadata={(event) => {
              const total = event.currentTarget.duration || 0
              setDuration(total)
              ensureTrim(total)
            }}
            onTimeUpdate={onTimeUpdate}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onError={() => setError('Браузер не смог открыть этот файл')}
            onClick={togglePlay}
            playsInline
          />
        ) : (
          <div className="flex w-full max-w-lg flex-col items-center gap-6 px-8">
            <div
              className={`flex h-28 w-28 items-center justify-center rounded-full bg-accent/12 ring-1 ring-accent/25 ${
                playing ? 'animate-pulse-soft' : ''
              }`}
            >
              <Volume2 size={40} className="text-accent-soft" />
            </div>
            <p className="max-w-full truncate text-center text-[14px] text-ink-dim">{file.name}</p>
            <audio
              key={file.path}
              ref={mediaRef as React.RefObject<HTMLAudioElement>}
              src={mediaUrl(file.path)}
              onLoadedMetadata={(event) => {
              const total = event.currentTarget.duration || 0
              setDuration(total)
              ensureTrim(total)
            }}
              onTimeUpdate={onTimeUpdate}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onError={() => setError('Браузер не смог открыть этот файл')}
            />
          </div>
        )}

        {/* Затухание картинки: чёрная вуаль поверх кадра */}
        {dim > 0.001 && (
          <div
            className="pointer-events-none absolute inset-0 bg-black"
            style={{ opacity: dim }}
          />
        )}

        {error && (
          <div className="absolute inset-x-0 bottom-0 bg-danger/20 px-4 py-2 text-center text-[12px] text-danger">
            {error}
          </div>
        )}
      </div>

      {/* Таймлайн */}
      <div className="px-1 pb-5">
        <Timeline
          duration={duration}
          currentTime={time}
          inPoint={trim.in}
          outPoint={trim.out}
          onSeek={seek}
          onChangeIn={(value) => onTrimChange({ ...trim, in: value })}
          onChangeOut={(value) => onTrimChange({ ...trim, out: value })}
          peaks={peaks}
          peaksLoading={peaksLoading}
          strip={strip}
          stripLoading={stripLoading}
          hasVideo={isVideo}
          hasAudio={file.media?.hasAudio ?? !isVideo}
          fades={fades}
          onFadesChange={onFadesChange}
          playing={playing}
        />
      </div>

      {/* Панель управления */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface px-3 py-2 ring-1 ring-line-soft">
        <IconButton onClick={() => seek(0)} title="В начало (Home)">
          <SkipBack size={16} />
        </IconButton>
        <IconButton onClick={() => nudge(-5)} title="Назад 5 с (←)">
          <ChevronsLeft size={16} />
        </IconButton>
        <button
          type="button"
          onClick={togglePlay}
          title="Воспроизведение / пауза (Пробел)"
          className="mx-1 flex h-9 w-9 items-center justify-center rounded-full bg-accent text-white transition-colors hover:bg-accent-soft"
        >
          {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
        </button>
        <IconButton onClick={() => nudge(5)} title="Вперёд 5 с (→)">
          <ChevronsRight size={16} />
        </IconButton>
        <IconButton onClick={() => seek(duration)} title="В конец (End)">
          <SkipForward size={16} />
        </IconButton>

        <span className="ml-2 font-mono text-[12px] tabular-nums text-ink-dim">
          {timecode(time, true)} <span className="text-ink-faint">/ {timecode(duration)}</span>
        </span>

        <div className="mx-2 h-5 w-px bg-line" />

        <button
          type="button"
          onClick={setIn}
          title="Метка начала (I)"
          className="w-[92px] rounded-lg bg-surface-3 px-2.5 py-1.5 text-[12px] font-medium hover:bg-line"
        >
          <span className="text-accent-soft">In</span>{' '}
          <span className="tabular-nums text-ink-faint">
            {trim.in !== null ? timecode(trim.in, true) : '—'}
          </span>
        </button>
        <button
          type="button"
          onClick={setOut}
          title="Метка конца (O)"
          className="w-[104px] rounded-lg bg-surface-3 px-2.5 py-1.5 text-[12px] font-medium hover:bg-line"
        >
          <span className="text-accent-soft">Out</span>{' '}
          <span className="tabular-nums text-ink-faint">
            {trim.out !== null ? timecode(trim.out, true) : '—'}
          </span>
        </button>
        <IconButton
          onClick={() => setLoopSelection((value) => !value)}
          active={loopSelection}
          title="Зациклить выделение (L)"
        >
          <Repeat size={15} />
        </IconButton>
        {isVideo && (
          <IconButton
            onClick={() => void grabFrame()}
            disabled={grabbing}
            title="Сохранить текущий кадр картинкой"
          >
            <Camera size={15} />
          </IconButton>
        )}
        {selectionLength !== null && (
          <button
            type="button"
            onClick={() => onTrimChange({ in: 0, out: duration })}
            title="Вернуть метки на края файла"
            className="chip bg-accent/15 text-accent-soft hover:bg-accent/25"
          >
            <Scissors size={11} />
            {timecode(Math.max(selectionLength, 0), true)}
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <select
            className="rounded-lg bg-surface-3 px-2 py-1 text-[12px] text-ink-dim outline-none"
            value={rate}
            onChange={(event) => setRate(Number(event.target.value))}
            title="Скорость просмотра (не влияет на экспорт)"
          >
            {RATES.map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>
          <IconButton onClick={() => setMuted((value) => !value)} title="Звук (M)">
            {muted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </IconButton>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            onChange={(event) => {
              const value = Number(event.target.value)
              setVolume(value)
              setMuted(value === 0)
              localStorage.setItem(VOLUME_KEY, String(value))
            }}
            className="w-20"
          />
          {isVideo && (
            <IconButton
              onClick={() => {
                const element = mediaRef.current
                if (document.fullscreenElement) void document.exitFullscreen()
                else void element?.requestFullscreen?.()
              }}
              title="Полный экран"
            >
              <Maximize2 size={15} />
            </IconButton>
          )}
        </div>
      </div>

      {/* Технические данные */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-[11px] text-ink-faint">
        <span>{humanSize(file.size)}</span>
        {media?.width && (
          <span>
            {media.width}×{media.height}
            {media.fps ? ` · ${media.fps.toFixed(media.fps % 1 ? 2 : 0)} к/с` : ''}
          </span>
        )}
        {media?.videoCodec && <span>видео: {media.videoCodec}</span>}
        {media?.audioCodec ? (
          <span>
            звук: {media.audioCodec}
            {media.audioChannels ? ` · ${media.audioChannels} кан.` : ''}
          </span>
        ) : (
          <span className="text-warn">без звуковой дорожки</span>
        )}
        <span className="ml-auto text-ink-faint/70">
          Пробел — играть · I / O — метки · L — зациклить · S — кадр · уголки дорожек тянут затухание
        </span>
      </div>
    </div>
  )
}

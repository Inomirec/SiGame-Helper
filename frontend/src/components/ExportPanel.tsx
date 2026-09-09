import { useEffect, useMemo, useState } from 'react'
import { FolderOpen, Play, Terminal } from 'lucide-react'
import { api } from '../lib/api'
import { FolderPicker } from './FolderPicker'
import { humanSize, plural, timecode } from '../lib/format'
import type { AudioOptions, FileInfo, Preset, VideoOptions } from '../lib/types'
import { useStore } from '../store'
import type { TrimState } from './MediaEditor'
import type { Fades } from './Timeline'
import { Button, Section, Segmented, Toggle } from './ui'

const DEFAULT_VIDEO: VideoOptions = {
  codec: 'av1_svt',
  crf: 43,
  speed_preset: '6',
  max_height: 720,
  max_fps: 30,
  tempo: 1,
  container: 'mp4',
  use_gpu: false,
  faststart: true,
  strip_video: false,
}

const DEFAULT_AUDIO: AudioOptions = {
  codec: 'opus',
  bitrate_kbps: 96,
  loudnorm: true,
  loudnorm_i: -16,
  loudnorm_tp: -1.5,
  loudnorm_lra: 11,
  loudnorm_two_pass: false,
  fade_in: 0,
  fade_out: 0,
  mono: false,
}

/**
 * Панель экспорта видео и звука.
 *
 * Здесь намеренно нет кодеков, CRF и контейнеров: всё это спрятано в пресеты.
 * Наружу вынесено только то, что человек может осмысленно решить сам — что
 * сделать со звуком и как назвать файл.
 */
export function ExportPanel({
  file,
  trim,
  fades,
  onDone,
}: {
  file: FileInfo
  trim: TrimState
  fades: Fades
  onDone?: () => void
}) {
  const presets = useStore((state) => state.presets)
  const checked = useStore((state) => state.checked)
  const files = useStore((state) => state.files)
  const toast = useStore((state) => state.toast)
  const setQueueOpen = useStore((state) => state.setQueueOpen)
  const status = useStore((state) => state.status)

  const isAudio = file.kind === 'audio'
  const kindPresets: Preset[] = useMemo(
    () => (isAudio ? presets.audio : presets.video) ?? [],
    [presets, isAudio],
  )

  const [presetId, setPresetId] = useState<string>('')
  const [video, setVideo] = useState<VideoOptions>(DEFAULT_VIDEO)
  const [audio, setAudio] = useState<AudioOptions>(DEFAULT_AUDIO)
  const [streamCopy, setStreamCopy] = useState(false)
  const [suffix, setSuffix] = useState('_sig')

  // Приписка к имени по основным пресетам: в папке потом сразу видно, чем
  // сжимали, — иначе три версии одного ролика различаются только весом.
  const PRESET_SUFFIX: Record<string, string> = {
    pack_balanced: '_баланс',
    pack_quality: '_качество',
    pack_economy: '_экономия',
  }
  const [busy, setBusy] = useState(false)
  const [command, setCommand] = useState<string | null>(null)
  // Куда класть результат: рядом с исходником или в выбранную папку.
  const [nearSource, setNearSource] = useState(true)
  const [outputDir, setOutputDir] = useState('')
  const [pickingFolder, setPickingFolder] = useState(false)

  // При первом показе (и при смене типа файла) берём пресет по умолчанию.
  useEffect(() => {
    const first = kindPresets.find((preset) => preset.available !== false)
    if (first && !kindPresets.some((preset) => preset.id === presetId)) {
      applyPreset(first)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindPresets])

  function applyPreset(preset: Preset) {
    setPresetId(preset.id)
    if (preset.options.video) {
      // Разрешение выбирает человек отдельно — пресет отвечает только за силу
      // сжатия, поэтому его max_height мы не подхватываем.
      setVideo((current) => ({
        ...DEFAULT_VIDEO,
        ...preset.options.video,
        // Разрешение и выбор «процессор или видеокарта» человек делает сам —
        // пресет отвечает только за силу сжатия.
        max_height: preset.options.stream_copy
          ? 0
          : (preset.options.video?.max_height === 0 ? 0 : current.max_height),
        use_gpu: current.use_gpu,
      } as VideoOptions))
    }
    // Галочки звука пользователь ставит сам — пресет их не перебивает.
    if (preset.options.audio) {
      setAudio((current) => ({
        ...DEFAULT_AUDIO,
        ...preset.options.audio,
        loudnorm: current.loudnorm,
        mono: current.mono,
      } as AudioOptions))
    }
    setStreamCopy(Boolean(preset.options.stream_copy))
    // Имя, которое человек уже поправил руками, не трогаем.
    setSuffix((current) =>
      current === '_sig' || Object.values(PRESET_SUFFIX).includes(current)
        ? PRESET_SUFFIX[preset.id] ?? '_sig'
        : current,
    )
  }

  const activePreset = kindPresets.find((preset) => preset.id === presetId)

  const buildRequest = (source: string, withTrim: boolean) => ({
    source,
    kind: file.kind,
    output_dir: nearSource ? null : outputDir.trim() || null,
    trim: withTrim ? { start: trim.in, end: trim.out } : { start: null, end: null },
    // Затухания нарисованы на дорожках открытого файла — в пакет их не тащим.
    video: {
      ...video,
      fade_in: withTrim ? fades.video.in : 0,
      fade_out: withTrim ? fades.video.out : 0,
    },
    audio: {
      ...audio,
      fade_in: withTrim ? fades.audio.in : 0,
      fade_out: withTrim ? fades.audio.out : 0,
    },
    stream_copy: streamCopy,
    suffix,
    preset_label: activePreset?.label,
  })

  // Отмеченные в медиатеке файлы того же типа обрабатываются одной кнопкой.
  const batch = checked.filter(
    (path) =>
      path !== file.path &&
      (files.find((item) => item.path === path)?.kind ?? '') === file.kind,
  )

  async function run() {
    setBusy(true)
    try {
      if (!batch.length) {
        await api.export(buildRequest(file.path, true))
      } else {
        // Метки и затухания относятся к открытому файлу, к остальным — нет.
        const items = [
          buildRequest(file.path, true),
          ...batch.map((path) => buildRequest(path, false)),
        ]
        const result = await api.exportBatch(items)
        if (result.errors.length) toast(result.errors[0].error, 'error')
        toast(
          `Обрабатываю ${result.jobs.length} ${plural(result.jobs.length, ['файл', 'файла', 'файлов'])}`,
          'ok',
        )
      }
      setQueueOpen(true)
      onDone?.()
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function loadCommand() {
    if (command !== null) {
      setCommand(null)
      return
    }
    try {
      const preview = await api.exportPreview(buildRequest(file.path, true))
      setCommand(preview.command ?? '')
    } catch (error) {
      toast((error as Error).message, 'error')
    }
  }

  // Пока консоль открыта, команда пересобирается под текущие настройки.
  // Это же и способ вернуть всё как было: сломали строку — переключите
  // пресет, и появится рабочая.
  useEffect(() => {
    if (command === null) return
    let cancelled = false
    api
      .exportPreview(buildRequest(file.path, true))
      .then((preview) => !cancelled && setCommand(preview.command ?? ''))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetId, video, audio, streamCopy, trim.in, trim.out, nearSource, outputDir])

  /** Запускает команду в том виде, в каком её оставил пользователь. */
  async function runRaw() {
    if (!command?.trim()) return
    setBusy(true)
    try {
      await api.exportRaw(command, file.path)
      setQueueOpen(true)
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const sourceHeight = file.media?.height ?? 0
  // Программа никогда не растягивает видео вверх, поэтому итог — минимум из двух.
  const outputHeight = video.max_height
    ? sourceHeight
      ? Math.min(video.max_height, sourceHeight)
      : video.max_height
    : sourceHeight

  const total = file.media?.duration ?? 0
  const cutting =
    (trim.in !== null && trim.in > 0.05) ||
    (trim.out !== null && total > 0 && trim.out < total - 0.05)

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
        {!streamCopy && !isAudio && (
          <Section title="Разрешение">
            <Segmented
              columns={3}
              value={String(video.max_height)}
              onChange={(value) => setVideo({ ...video, max_height: Number(value) })}
              options={[
                { value: '0', label: 'Оригинал', title: 'Оставить разрешение исходника' },
                { value: '2160', label: '4K' },
                { value: '1440', label: '1440p' },
                { value: '1080', label: '1080p' },
                { value: '720', label: '720p' },
                { value: '480', label: '480p' },
              ]}
            />
            <p className="text-[11px] leading-snug text-ink-faint">
              {sourceHeight
                ? outputHeight && outputHeight < sourceHeight
                  ? `Исходник ${sourceHeight}p уменьшится до ${outputHeight}p — это сильнее всего режет вес.`
                  : `Исходник ${sourceHeight}p — увеличивать его программа не станет, останется как есть.`
                : 'Мелкое видео растянуто вверх не будет — только уменьшение.'}
            </p>
          </Section>
        )}

        <Section title="Насколько сильно жать">
          <div className="grid gap-1.5">
            {kindPresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                disabled={preset.available === false}
                onClick={() => applyPreset(preset)}
                className={`rounded-xl border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                  presetId === preset.id
                    ? 'border-accent/60 bg-accent/10'
                    : 'border-line-soft bg-surface-2 hover:border-line hover:bg-surface-3'
                }`}
              >
                <span className="block text-[13px] font-medium text-ink">{preset.label}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-ink-faint">
                  {preset.available === false
                    ? 'Этот способ недоступен на вашем компьютере'
                    : preset.hint}
                </span>
                {/* Чем именно жмём — бледной строкой: не мешает, но снимает
                    вопрос «а чем Баланс отличается от Качества». */}
                {preset.tech && preset.available !== false && (
                  <span className="mt-1 block font-mono text-[10px] text-ink-faint/60">
                    {preset.tech}
                  </span>
                )}
              </button>
            ))}
          </div>
        </Section>


        <Section title="Куда складывать результат">
          <div className="space-y-1 rounded-xl bg-surface-2 px-3 py-2.5">
            <Toggle
              checked={nearSource}
              onChange={setNearSource}
              label="В подпапку рядом с исходником"
              hint="Папка «Обработанное» появится там же, где лежит исходный файл. Оригинал не трогаем."
            />
          </div>
          {!nearSource && (
            <div className="flex gap-2">
              <input
                className="field font-mono text-[12px]"
                value={outputDir}
                placeholder="Выберите папку…"
                onChange={(event) => setOutputDir(event.target.value)}
              />
              <Button onClick={() => setPickingFolder(true)}>
                <FolderOpen size={14} />
              </Button>
            </div>
          )}
          <p className="text-[11px] leading-snug text-ink-faint">
            К имени добавится приписка{' '}
            <span className="font-mono text-ink-dim">{suffix}</span> — по названию
            пресета.
          </p>
        </Section>

        <Section title="Остальные настройки">
          <div className="space-y-1 rounded-xl bg-surface-2 px-3 py-2.5">
            {!streamCopy && !isAudio && status?.gpuAvailable && (
              <Toggle
                checked={video.use_gpu}
                onChange={(value) => setVideo({ ...video, use_gpu: value })}
                label="Кодировать на видеокарте"
                hint="Высокая скорость, но в теории могут появиться незначительные артефакты. Полезно для больших видео, когда важно время."
              />
            )}
            <Toggle
              checked={audio.loudnorm}
              onChange={(value) => setAudio({ ...audio, loudnorm: value })}
              disabled={streamCopy}
              label="Выравнивание звука"
              hint="У всех источников с этой настройкой будет одинаковый предел громкости."
            />
            <Toggle
              checked={audio.mono}
              onChange={(value) => setAudio({ ...audio, mono: value })}
              disabled={streamCopy}
              label="Перевести звук в моно"
              hint="Делает звук более плоским, но и понижает вес файла примерно на треть."
            />
            <Toggle
              checked={command !== null}
              onChange={(value) => (value ? void loadCommand() : setCommand(null))}
              label="Задать параметры в консоли ffmpeg"
              hint="Для тех, кто знает ffmpeg: показывает готовую команду, её можно поправить и запустить как есть."
            />
          </div>
          {command !== null && (
          <div className="space-y-2">
            <textarea
              className="field h-40 resize-y font-mono text-[10.5px] leading-relaxed"
              spellCheck={false}
              value={command}
              onChange={(event) => setCommand(event.target.value)}
            />
            <p className="text-[11px] leading-snug text-ink-faint">
              Команду можно править и запускать как есть — это на случай, когда нужна
              тонкая настройка, которой нет в интерфейсе. Последнее слово в строке —
              путь к результату. Запускается только ffmpeg, ничего другого.
            </p>
            <Button onClick={() => void runRaw()} disabled={busy} className="w-full">
              <Terminal size={14} />
              Запустить эту команду
            </Button>
          </div>
        )}
          {streamCopy && (
            <p className="text-[11px] leading-snug text-ink-faint">
              Выбран режим без сжатия — звук копируется как есть, поэтому галочки
              звука ни на что не влияют.
            </p>
          )}
        </Section>


      </div>

      <FolderPicker
        open={pickingFolder}
        onClose={() => setPickingFolder(false)}
        title="Куда складывать результат"
        onPick={(path) => setOutputDir(path)}
      />

      {/* Нижняя панель действий */}
      <div className="space-y-2 border-t border-line-soft bg-surface px-4 py-3">
        <div className="flex items-center justify-between text-[11px] text-ink-faint">
          <span>
            {cutting ? (
              <>
                Отрезок:{' '}
                <span className="tabular-nums text-ink-dim">
                  {timecode(trim.in ?? 0, true)} → {timecode(trim.out ?? total, true)}
                </span>
              </>
            ) : (
              'Весь файл целиком'
            )}
          </span>
          <span>{humanSize(file.size)}</span>
        </div>

        <Button tone="primary" onClick={() => void run()} disabled={busy} className="w-full py-2.5">
          <Play size={15} />
          {batch.length
            ? `Обработать ${batch.length + 1} ${plural(batch.length + 1, ['файл', 'файла', 'файлов'])}`
            : streamCopy
              ? 'Обрезать без сжатия'
              : 'Обрезать и сжать'}
        </Button>

        {batch.length > 0 && (
          <p className="text-center text-[11px] leading-snug text-ink-faint">
            К отмеченным файлам применится тот же пресет, но без обрезки — метки стоят
            только на открытом файле.
          </p>
        )}
      </div>
    </div>
  )
}

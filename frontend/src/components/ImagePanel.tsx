import { useEffect, useMemo, useRef, useState } from 'react'
import { Play } from 'lucide-react'
import { api } from '../lib/api'
import { humanSize, plural } from '../lib/format'
import { strokesToPng } from '../lib/paint'
import type { FileInfo, ImageOptions, ImagePreview, Preset } from '../lib/types'
import { useStore } from '../store'
import type { ImageEdit } from './ImageEditorTop'
import { Button, Section, Segmented, Select, Toggle } from './ui'

const DEFAULT_IMAGE: ImageOptions = {
  format: 'avif',
  // Подбор веса выключен: AVIF влезал во все лимиты сразу, и четыре прохода
  // кодирования уходили впустую — три «разных» пресета давали один файл.
  target_kb: null,
  passes: 4,
  quality: 94,
  max_dimension: 1600,
  effort: 4,
  replace_original: false,
  boxes: [],
  box_color: 'black',
  crop: null,
}

type Format = 'avif' | 'jpg' | 'webp'

const FORMATS: { value: Format; label: string; title: string }[] = [
  { value: 'avif', label: 'AVIF', title: 'Жмёт лучше всех, держит прозрачность' },
  { value: 'jpg', label: 'JPEG', title: 'Открывается везде, прозрачность не держит' },
  { value: 'webp', label: 'WebP', title: 'Середина: жмёт хорошо, поддержки больше' },
]

const SIZES = [
  { value: '0', label: 'Как есть' },
  { value: '1280', label: 'до 1280 px' },
  { value: '1600', label: 'до 1600 px' },
  { value: '1920', label: 'до 1920 px' },
  { value: '2560', label: 'до 2560 px' },
]

/** Слева ползунок не уходит в нечитаемое месиво, справа — в бессмысленный вес. */
const MIN_QUALITY = 20
const MAX_QUALITY = 95

const SUFFIXES: Record<string, string> = { avif: '_avif', jpg: '_jpeg', webp: '_webp' }

/** Настройки, от которых зависит результат: остальные превью не пересчитывают. */
function encodeKey(options: ImageOptions) {
  return [options.format, options.quality, options.max_dimension, options.effort].join('|')
}

/**
 * Панель сжатия изображения.
 *
 * Две кнопки сверху — не отдельная ветка, а именованные положения тех же
 * ручных настроек: выбрали пресет — ползунки встали на его значения, тронули
 * ползунок — подсветка пресета погасла. Рассинхронизации быть не может.
 */
export function ImagePanel({
  file,
  edit,
  onPreview,
}: {
  file: FileInfo
  edit: ImageEdit
  /** Готовое превью уходит наверх: показывает его холст, а не эта панель. */
  onPreview: (preview: ImagePreview | null) => void
}) {
  const presets = useStore((state) => state.presets)
  const checked = useStore((state) => state.checked)
  const files = useStore((state) => state.files)
  const toast = useStore((state) => state.toast)
  const setQueueOpen = useStore((state) => state.setQueueOpen)

  const imagePresets: Preset[] = useMemo(() => presets.image ?? [], [presets])
  const [options, setOptions] = useState<ImageOptions>(DEFAULT_IMAGE)
  const [busy, setBusy] = useState(false)
  const [showPreview, setShowPreview] = useState(true)
  const [preview, setPreview] = useState<ImagePreview | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  // Пресет не хранится отдельно: он вычисляется из настроек. Иначе подсветка
  // рано или поздно разойдётся с тем, что реально уйдёт в кодировщик.
  const activePreset = imagePresets.find((preset) => {
    const values = preset.options.image
    return (
      !!values &&
      values.format === options.format &&
      values.quality === options.quality &&
      values.max_dimension === options.max_dimension
    )
  })

  const hasEdits = Boolean(edit.crop) || edit.boxes.length > 0 || edit.strokes.length > 0

  const editPayload = useMemo(
    () => ({
      crop: edit.crop,
      boxes: edit.boxes,
      // Мазки превращаем в прозрачный PNG размером с оригинал: описывать
      // каждый из них фильтрами ffmpeg сложнее и хуже, чем наложить слой.
      paint_png: edit.strokes.length
        ? strokesToPng(edit.strokes, file.media?.width ?? 0, file.media?.height ?? 0, '#000000')
        : null,
    }),
    [edit, file.media?.width, file.media?.height],
  )

  // Просчёт живёт с задержкой: человек возит ползунок быстрее, чем кодировщик
  // успевает, и без паузы мы бы запускали ffmpeg на каждый пиксель хода.
  const requestId = useRef(0)
  useEffect(() => {
    if (!showPreview) {
      setPreview(null)
      setPreviewError(null)
      onPreview(null)
      return
    }

    const mine = ++requestId.current
    const timer = setTimeout(() => {
      setPreviewBusy(true)
      api
        .imagePreview({ source: file.path, image: { ...options, ...editPayload } })
        .then((result) => {
          if (mine !== requestId.current) return
          setPreview(result)
          setPreviewError(null)
          onPreview(result)
        })
        .catch((error: Error) => {
          if (mine !== requestId.current) return
          setPreview(null)
          setPreviewError(error.message)
          onPreview(null)
        })
        .finally(() => {
          if (mine === requestId.current) setPreviewBusy(false)
        })
    }, 350)

    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path, encodeKey(options), editPayload, showPreview])

  // Панель живёт до конца выбора файла — прибираем превью за собой.
  useEffect(() => () => onPreview(null), [onPreview])

  const buildRequest = (source: string, withEdits: boolean) => ({
    source,
    kind: 'image' as const,
    image: {
      ...options,
      // Правки нарисованы для конкретной картинки — в пакет их не тащим.
      crop: withEdits ? editPayload.crop : null,
      boxes: withEdits ? editPayload.boxes : [],
      paint_png: withEdits ? editPayload.paint_png : null,
    },
    suffix: SUFFIXES[options.format] ?? '_сжатый',
    preset_label: activePreset?.label,
  })

  // Отмеченные в медиатеке картинки обрабатываются той же кнопкой.
  const batch = checked.filter(
    (path) =>
      path !== file.path &&
      (files.find((item) => item.path === path)?.kind ?? '') === 'image',
  )

  async function run() {
    setBusy(true)
    try {
      if (!batch.length) {
        await api.export(buildRequest(file.path, true))
      } else {
        const items = [
          buildRequest(file.path, true),
          ...batch.map((path) => buildRequest(path, false)),
        ]
        const result = await api.exportBatch(items)
        if (result.errors.length) toast(result.errors[0].error, 'error')
        toast(
          `Обрабатываю ${result.jobs.length} ${plural(result.jobs.length, ['картинку', 'картинки', 'картинок'])}`,
          'ok',
        )
      }
      setQueueOpen(true)
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const ratio = preview && preview.size ? file.size / preview.size : 0

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
        <Section title="Пресеты">
          <div className="grid gap-1.5">
            {imagePresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() =>
                  setOptions((current) => ({
                    ...current,
                    ...preset.options.image,
                    // Галочку перезаписи ставит человек — пресет её не трогает.
                    replace_original: current.replace_original,
                  }))
                }
                className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
                  activePreset?.id === preset.id
                    ? 'border-accent/60 bg-accent/10'
                    : 'border-line-soft bg-surface-2 hover:border-line hover:bg-surface-3'
                }`}
              >
                <span className="block text-[13px] font-medium text-ink">{preset.label}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-ink-faint">
                  {preset.hint}
                </span>
                {preset.tech && (
                  <span className="mt-1 block font-mono text-[10px] text-ink-faint/70">
                    {preset.tech}
                  </span>
                )}
              </button>
            ))}
          </div>
        </Section>

        <Section title="Настроить вручную">
          <Segmented<Format>
            value={options.format as Format}
            onChange={(value) => setOptions({ ...options, format: value })}
            options={FORMATS}
          />

          <div>
            <div className="flex items-center justify-between">
              <span className="label">Качество</span>
              <span className="font-mono text-[11px] tabular-nums text-ink-dim">
                {options.quality}
              </span>
            </div>
            <input
              type="range"
              min={MIN_QUALITY}
              max={MAX_QUALITY}
              step={1}
              value={options.quality}
              onChange={(event) =>
                setOptions({ ...options, quality: Number(event.target.value) })
              }
              className="w-full"
            />
            <div className="flex justify-between text-[10px] text-ink-faint">
              <span>Экстрим</span>
              <span>Средне</span>
              <span>Лёгкое</span>
            </div>
          </div>

          <Select
            label="Размер"
            value={String(options.max_dimension)}
            options={SIZES}
            onChange={(value) => setOptions({ ...options, max_dimension: Number(value) })}
            hint="Уменьшает только слишком большие картинки, маленькие не растягивает."
          />
        </Section>

        <Section title="Что получится">
          <div className="rounded-xl bg-surface-2 px-3 py-2.5 ring-1 ring-line-soft">
            {!showPreview ? (
              <p className="text-[12px] text-ink-faint">Превью выключено.</p>
            ) : previewError ? (
              <p className="text-[12px] text-danger">{previewError}</p>
            ) : preview ? (
              <>
                <div className="flex items-baseline gap-2">
                  <span className="text-[12px] text-ink-faint">{humanSize(file.size)} →</span>
                  <span className="text-[18px] font-medium text-ink">
                    {humanSize(preview.size)}
                  </span>
                  {ratio >= 1.05 && (
                    <span className="text-[11px] text-ink-faint">
                      в {ratio.toFixed(1).replace('.0', '')} раза меньше
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[11px] leading-snug text-ink-faint">
                  {preview.width}×{preview.height} px
                  {previewBusy ? ' · считаю…' : ' · кнопка «До / после» над картинкой'}
                </p>
              </>
            ) : (
              <p className="text-[12px] text-ink-faint">Считаю…</p>
            )}
          </div>

          <Toggle
            checked={showPreview}
            onChange={setShowPreview}
            label="Показывать превью"
            hint="Каждое движение ползунка пересчитывает картинку по-настоящему. На слабой машине это заметно — тогда выключите."
          />
          <Toggle
            checked={options.replace_original}
            onChange={(value) => setOptions({ ...options, replace_original: value })}
            label="Удалить оригинал"
            hint="После успешного сжатия исходная картинка будет удалена. По умолчанию выключено."
          />
        </Section>

        {hasEdits && (
          <Section title="Правки кадра">
            <div className="space-y-1.5 rounded-xl bg-accent/10 px-3 py-2.5 text-[12px] text-ink-dim ring-1 ring-accent/25">
              {edit.crop && (
                <p>
                  Обрезка до{' '}
                  <span className="font-mono text-ink">
                    {edit.crop.width}×{edit.crop.height}
                  </span>
                </p>
              )}
              {edit.boxes.length > 0 && (
                <p>
                  Закрашено областей:{' '}
                  <span className="font-mono text-ink">{edit.boxes.length}</span>
                </p>
              )}
              <p className="text-[11px] leading-snug text-ink-faint">
                Применяются только к этой картинке — отмеченные рядом уйдут без правок.
              </p>
            </div>
          </Section>
        )}
      </div>

      <div className="border-t border-line-soft bg-surface px-4 py-3">
        <Button tone="primary" onClick={() => void run()} disabled={busy} className="w-full py-2.5">
          <Play size={15} />
          {batch.length
            ? `Сжать ${batch.length + 1} ${plural(batch.length + 1, ['картинку', 'картинки', 'картинок'])}`
            : hasEdits
              ? 'Применить правки и сжать'
              : 'Сжать изображение'}
        </Button>
        <p className="mt-1.5 text-[11px] leading-snug text-ink-faint">
          Результат ляжет в подпапку <span className="font-mono text-ink-dim">Обработанное</span>{' '}
          рядом с исходником, с припиской{' '}
          <span className="font-mono text-ink-dim">{SUFFIXES[options.format]}</span>.
        </p>
      </div>
    </div>
  )
}

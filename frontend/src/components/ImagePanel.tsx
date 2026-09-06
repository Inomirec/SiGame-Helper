import { useEffect, useMemo, useState } from 'react'
import { Play } from 'lucide-react'
import { api } from '../lib/api'
import { plural } from '../lib/format'
import type { FileInfo, ImageOptions, Preset } from '../lib/types'
import { useStore } from '../store'
import type { ImageEdit } from './ImageEditorTop'
import { Button, Section, Toggle } from './ui'

const DEFAULT_IMAGE: ImageOptions = {
  format: 'avif',
  target_kb: 120,
  passes: 4,
  quality: 80,
  max_dimension: 1600,
  effort: 3,
  replace_original: false,
  boxes: [],
  box_color: 'black',
  crop: null,
}

/**
 * Панель сжатия изображения.
 *
 * Формат и сила сжатия целиком спрятаны в пресеты: обычному человеку не нужно
 * знать, что такое CRF и сколько проходов подбора делать.
 */
export function ImagePanel({ file, edit }: { file: FileInfo; edit: ImageEdit }) {
  const presets = useStore((state) => state.presets)
  const checked = useStore((state) => state.checked)
  const files = useStore((state) => state.files)
  const toast = useStore((state) => state.toast)
  const setQueueOpen = useStore((state) => state.setQueueOpen)

  const imagePresets: Preset[] = useMemo(() => presets.image ?? [], [presets])
  const [presetId, setPresetId] = useState('')
  const [options, setOptions] = useState<ImageOptions>(DEFAULT_IMAGE)
  const [suffix, setSuffix] = useState('_сжатый')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const first = imagePresets[0]
    if (first && !imagePresets.some((preset) => preset.id === presetId)) applyPreset(first)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imagePresets])

  function applyPreset(preset: Preset) {
    setPresetId(preset.id)
    setOptions((current) => ({
      ...DEFAULT_IMAGE,
      ...preset.options.image,
      // Галочку перезаписи ставит человек — пресет её не трогает.
      replace_original: current.replace_original,
    } as ImageOptions))
  }

  const hasEdits = Boolean(edit.crop) || edit.boxes.length > 0

  const buildRequest = (source: string, withEdits: boolean) => ({
    source,
    kind: 'image' as const,
    image: {
      ...options,
      // Правки нарисованы для конкретной картинки — в пакет их не тащим.
      crop: withEdits ? edit.crop : null,
      boxes: withEdits ? edit.boxes : [],
    },
    suffix,
    preset_label: imagePresets.find((preset) => preset.id === presetId)?.label,
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

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
        <Section title="Насколько сильно жать">
          <div className="grid gap-1.5">
            {imagePresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyPreset(preset)}
                className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
                  presetId === preset.id
                    ? 'border-accent/60 bg-accent/10'
                    : 'border-line-soft bg-surface-2 hover:border-line hover:bg-surface-3'
                }`}
              >
                <span className="block text-[13px] font-medium text-ink">{preset.label}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-ink-faint">
                  {preset.hint}
                </span>
              </button>
            ))}
          </div>
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

        <Section title="Имя файла">
          <div>
            <input
              className="field"
              value={suffix}
              onChange={(event) => setSuffix(event.target.value)}
              placeholder="_сжатый"
            />
            <p className="mt-1.5 text-[11px] leading-snug text-ink-faint">
              Это приписка к имени. Результат ляжет в подпапку{' '}
              <span className="font-mono text-ink-dim">_processed</span> рядом с исходником.
            </p>
          </div>
          <Toggle
            checked={options.replace_original}
            onChange={(value) => setOptions({ ...options, replace_original: value })}
            label="Удалить оригинал"
            hint="После успешного сжатия исходная картинка будет удалена. По умолчанию выключено."
          />
        </Section>
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
      </div>
    </div>
  )
}

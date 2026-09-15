import { useEffect, useMemo, useRef, useState } from 'react'
import { Play } from 'lucide-react'
import { api } from '../lib/api'
import { humanSize, parentDir, plural } from '../lib/format'
import { loadPrefs, savePrefs } from '../lib/prefs'
import { strokesToPng } from '../lib/paint'
import type { FileInfo, ImageOptions, ImagePreview, Preset } from '../lib/types'
import { useStore } from '../store'
import type { ImageEdit } from './ImageEditorTop'
import { Button, Modal, Section, Segmented, Select, Toggle } from './ui'

const DEFAULT_IMAGE: ImageOptions = {
  format: 'avif',
  quality: 94,
  max_dimension: 1600,
  effort: 4,
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
const MAX_QUALITY = 100

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
  // Панель пересоздаётся при смене файла, поэтому выбор человека держим
  // в общем хранилище — иначе всё сбрасывалось бы на каждой картинке.
  const [options, setOptions] = useState<ImageOptions>(() => {
    const prefs = loadPrefs()
    return { ...DEFAULT_IMAGE, ...prefs.image } as ImageOptions
  })
  // Удаление исходника — не настройка сжатия, а решение про файл, поэтому
  // живёт отдельно от options и уходит в запрос, а не в параметры кодека.
  const [deleteOriginal, setDeleteOriginal] = useState(() => loadPrefs().imageReplace ?? false)
  const [intoSubfolder, setIntoSubfolder] = useState(
    () => loadPrefs().subfolder ?? localStorage.getItem('sgh.outputSubfolder') !== 'off',
  )
  const [busy, setBusy] = useState(false)
  // Движущуюся картинку умеет сохранить только WebP: в AVIF и JPEG влезает
  // один кадр, и от анимации остался бы стоп-кадр. Формат за человека не
  // меняем — спрашиваем перед самой обработкой.
  const animated = Boolean(file.media?.animated)
  const [askSwitch, setAskSwitch] = useState(false)
  // Превью такой картинки в неподходящем формате не считается: задача на
  // сервере честно откажется, и в панели была бы красная строка вместо
  // объяснения, которое и так стоит рядом с форматами.
  const movingUnsupported = animated && options.format !== 'webp'
  const [showPreview, setShowPreview] = useState(() => loadPrefs().imagePreview ?? true)
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

  // Настройки сжатия храним, а правки кадра — нет: они про конкретную картинку.
  useEffect(() => {
    savePrefs({
      image: {
        format: options.format,
        quality: options.quality,
        max_dimension: options.max_dimension,
      },
    })
  }, [options.format, options.quality, options.max_dimension])

  useEffect(() => {
    savePrefs({ imagePreview: showPreview })
  }, [showPreview])

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
    if (!showPreview || movingUnsupported) {
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

  const buildRequest = (source: string, withEdits: boolean, switchFormats: boolean) => ({
    source,
    kind: 'image' as const,
    image: {
      ...options,
      // Правки нарисованы для конкретной картинки — в пакет их не тащим.
      crop: withEdits ? editPayload.crop : null,
      boxes: withEdits ? editPayload.boxes : [],
      paint_png: withEdits ? editPayload.paint_png : null,
    },
    // Без подпапки результат ложится прямо туда, где лежал оригинал.
    output_dir: intoSubfolder ? null : parentDir(source),
    suffix: SUFFIXES[options.format] ?? '_сжатый',
    preset_label: activePreset?.label,
    replace_original: deleteOriginal,
    allow_format_switch: switchFormats,
  })

  // Отмеченные в медиатеке картинки обрабатываются той же кнопкой.
  const others = checked.filter(
    (path) =>
      path !== file.path &&
      (files.find((item) => item.path === path)?.kind ?? '') === 'image',
  )
  // Снятая галочка означает «эту картинку не трогать» — даже если она открыта.
  const openChecked = checked.includes(file.path)
  const batch = openChecked ? [file.path, ...others] : others
  // Ничего не отмечено — кнопка сжимает открытую картинку.
  const single = batch.length === 0

  // Про движение у отмеченных файлов заранее известно только расширение:
  // читать каждый файл ради этого — лишняя работа на пачке в сотню картинок.
  // Поэтому спрашиваем по расширению, а настоящую проверку делает сервер и
  // меняет формат только у тех, кто и правда движется.
  const MOVING_EXT = ['.gif', '.webp']
  const moving = batch.filter((path) =>
    MOVING_EXT.some((ext) => path.toLowerCase().endsWith(ext)),
  )
  const needsAsking =
    options.format !== 'webp' && (movingUnsupported || (!single && moving.length > 0))

  async function start() {
    if (needsAsking) {
      setAskSwitch(true)
      return
    }
    await run()
  }

  async function run(switchFormats = false) {
    setBusy(true)
    try {
      if (single) {
        await api.export(buildRequest(file.path, true, switchFormats))
      } else {
        // Правки кадра нарисованы для открытой картинки, к остальным их не тащим.
        const items = batch.map((path) =>
          buildRequest(path, path === file.path, switchFormats),
        )
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
          {animated && (
            <p className="rounded-lg bg-surface-2 px-3 py-2 text-[11px] leading-snug text-ink-dim">
              Это движущаяся картинка. Сохранить движение умеет только WebP — в
              остальных форматах остался бы один кадр.
            </p>
          )}

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
            checked={intoSubfolder}
            onChange={(value) => {
              setIntoSubfolder(value)
              savePrefs({ subfolder: value })
            }}
            label="Положить результат в подпапку"
            hint="Программа создаст подпапку «Обработанное», если её ещё нет, и сложит файл туда. Если выключить — результат ляжет в ту же папку, где лежит оригинал."
          />
          <Toggle
            checked={deleteOriginal}
            onChange={(value) => {
              setDeleteOriginal(value)
              savePrefs({ imageReplace: value })
            }}
            label="Удалить оригинал"
            hint="После успешного сжатия исходная картинка уйдёт в корзину Windows — оттуда её можно вернуть. По умолчанию выключено."
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
        <Button tone="primary" onClick={() => void start()} disabled={busy} className="w-full py-2.5">
          <Play size={15} />
          {!single
            ? `Сжать ${batch.length} ${plural(batch.length, ['картинку', 'картинки', 'картинок'])}`
            : hasEdits
              ? 'Применить правки и сжать'
              : 'Сжать изображение'}
        </Button>
        {others.length > 0 && !openChecked && (
          <p className="mt-1.5 text-center text-[11px] leading-snug text-ink-faint">
            Открытая картинка не отмечена — её программа не тронет.
          </p>
        )}

        <Modal
          open={askSwitch}
          onClose={() => setAskSwitch(false)}
          title="Движущиеся картинки"
        >
          <div className="space-y-3 text-[12.5px] leading-snug text-ink-dim">
            <p>
              {single || movingUnsupported
                ? 'Эта картинка движется, а выбранный формат хранит только один кадр — от движения ничего не останется.'
                : `Среди отмеченных есть движущиеся картинки (${moving.length} шт.), а выбранный формат хранит только один кадр.`}
            </p>
            <p>
              Сохранить движение умеет только WebP. Ответ запомнится на всю эту
              пачку: все движущиеся файлы в ней пойдут в WebP, остальные — тем
              форматом, что выбран, как и задумано.
            </p>
            <div className="flex gap-2 pt-1">
              <Button
                tone="primary"
                className="flex-1"
                onClick={() => {
                  setAskSwitch(false)
                  void run(true)
                }}
              >
                Взять WebP для всех таких
              </Button>
              <Button
                onClick={() => {
                  setAskSwitch(false)
                  void run(false)
                }}
              >
                Оставить как есть
              </Button>
            </div>
            <p className="text-[11px] text-ink-faint">
              «Оставить как есть» — движущиеся файлы просто не обработаются, в
              очереди будет видно, какие именно. Что уже обрабатывается сейчас,
              это окно не останавливает.
            </p>
          </div>
        </Modal>
        <p className="mt-1.5 text-[11px] leading-snug text-ink-faint">
          Результат ляжет в подпапку <span className="font-mono text-ink-dim">Обработанное</span>{' '}
          рядом с исходником, с припиской{' '}
          <span className="font-mono text-ink-dim">{SUFFIXES[options.format]}</span>.
        </p>
      </div>
    </div>
  )
}

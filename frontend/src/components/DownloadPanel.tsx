import { useRef, useState } from 'react'
import {
  ClipboardPaste,
  Download,
  Film,
  FolderOpen,
  Images,
  Loader2,
  Plus,
  Scissors,
  Trash2,
} from 'lucide-react'
import { api } from '../lib/api'
import { plural, timecode } from '../lib/format'
import type { GalleryItem } from '../lib/types'
import { useStore } from '../store'
import { FolderPicker } from './FolderPicker'
import { LinkPreview } from './LinkPreview'
import { Button, Section, Segmented, Select } from './ui'

type Mode = 'auto' | 'video' | 'audio' | 'images'

interface Row {
  id: number
  url: string
  start: number | null
  end: number | null
}

let nextId = 1
const emptyRow = (url = ''): Row => ({ id: nextId++, url, start: null, end: null })

/** «1:23» / «83» / «1:02:03» -> секунды. Пустая строка -> null. */
function parseTime(raw: string): number | null {
  const text = raw.trim().replace(',', '.')
  if (!text) return null
  const parts = text.split(':').map((part) => Number(part))
  if (parts.some((part) => !Number.isFinite(part))) return null
  return parts.reduce((total, part) => total * 60 + part, 0)
}

export function DownloadPanel() {
  const settings = useStore((state) => state.settings)
  const presets = useStore((state) => state.presets)
  const toast = useStore((state) => state.toast)
  const setQueueOpen = useStore((state) => state.setQueueOpen)
  const status = useStore((state) => state.status)
  const refreshSettings = useStore((state) => state.refreshSettings)

  const [rows, setRows] = useState<Row[]>([emptyRow()])
  const [mode, setMode] = useState<Mode>('auto')
  const [maxHeight, setMaxHeight] = useState(0)
  const [audioFormat, setAudioFormat] = useState<'opus' | 'mp3' | 'm4a' | 'best'>('opus')
  const [autoPreset, setAutoPreset] = useState('')
  const [busy, setBusy] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewRow, setPreviewRow] = useState<number | null>(null)

  const [gallery, setGallery] = useState<{ url: string; items: GalleryItem[] } | null>(null)
  const [picked, setPicked] = useState<number[]>([])
  const [probing, setProbing] = useState(false)
  const [folderPicker, setFolderPicker] = useState(false)

  const filled = rows.filter((row) => row.url.trim())
  const ytdlpReady = status?.tools['yt-dlp']?.available ?? false
  const galleryReady = status?.tools['gallery-dl']?.available ?? false

  const allPresets = [...(presets.video ?? []), ...(presets.audio ?? []), ...(presets.image ?? [])]

  function patchRow(id: number, patch: Partial<Row>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }

  function removeRow(id: number) {
    setRows((current) => {
      const next = current.filter((row) => row.id !== id)
      return next.length ? next : [emptyRow()]
    })
  }

  /** Вставка нескольких ссылок разом раскладывается по отдельным строкам. */
  function handlePaste(id: number, text: string) {
    const links = text
      .split(/[\r\n]+/)
      .map((line) => line.trim())
      .filter(Boolean)
    if (links.length < 2) return false

    setRows((current) => {
      const index = current.findIndex((row) => row.id === id)
      const inserted = links.map((link) => emptyRow(link))
      const next = [...current]
      next.splice(index, 1, ...inserted)
      return next
    })
    return true
  }

  /** Кладёт ссылки из буфера обмена в свободные строки. */
  async function pasteFromClipboard() {
    let text = ''
    try {
      text = await navigator.clipboard.readText()
    } catch {
      toast('Браузер не дал доступ к буферу — вставьте ссылку через Ctrl+V', 'error')
      return
    }
    const links = text
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => /^https?:\/\//i.test(item))

    if (!links.length) {
      toast('В буфере обмена нет ссылок', 'error')
      return
    }

    setRows((current) => {
      // Сначала заполняем пустые строки, остальные добавляем в конец.
      const next = current.map((row) => ({ ...row }))
      const queue = [...links]
      for (const row of next) {
        if (!row.url.trim() && queue.length) row.url = queue.shift() as string
      }
      return [...next, ...queue.map((link) => emptyRow(link))]
    })
    toast(`Добавлено ссылок: ${links.length}`, 'ok')
  }

  async function start() {
    if (!filled.length) {
      toast('Вставьте хотя бы одну ссылку', 'error')
      return
    }
    setBusy(true)
    try {
      const result = await api.download({
        items: filled.map((row) => ({ url: row.url.trim(), start: row.start, end: row.end })),
        mode,
        max_height: maxHeight,
        audio_format: audioFormat,
        auto_process_preset: autoPreset || null,
      })
      if (result.errors.length) toast(result.errors[0].error, 'error')
      toast(
        `В очередь добавлено ${result.jobs.length} ${plural(result.jobs.length, ['ссылка', 'ссылки', 'ссылок'])}`,
        'ok',
      )
      setQueueOpen(true)
      // Ссылки намеренно оставляем на месте: из одного ролика часто нужно
      // вырезать несколько кусков, и вбивать адрес заново каждый раз —
      // лишняя работа. Ненужную строку можно убрать крестиком.
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function loadGallery(url: string) {
    setProbing(true)
    try {
      const result = await api.probeGallery(url)
      if (!result.items.length) {
        toast('В этом посте не нашлось изображений', 'error')
        return
      }
      setGallery({ url: result.url, items: result.items })
      setPicked(result.items.map((item) => item.index))
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setProbing(false)
    }
  }

  async function downloadGallerySelection() {
    if (!gallery) return
    setBusy(true)
    try {
      await api.download({
        items: [{ url: gallery.url }],
        mode: 'images',
        selection: picked,
        auto_process_preset: autoPreset || null,
      })
      toast('Выбранные картинки добавлены в очередь', 'ok')
      setQueueOpen(true)
      setGallery(null)
      setPicked([])
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-5 overflow-y-auto px-6 py-6">
      <header>
        <h1 className="text-[20px] font-semibold">Загрузка</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-dim">
          Каждая ссылка — своя строка. Нажмите «Разметить», чтобы открыть видео прямо здесь и
          выбрать нужный отрезок: скачается только он, а не весь ролик. Без разметки скачивается
          целиком.
        </p>
      </header>

      {/* Список ссылок */}
      <div className="space-y-2">
        {rows.map((row, index) => (
          <LinkRow
            key={row.id}
            number={index + 1}
            row={row}
            disabled={!ytdlpReady}
            onChange={(patch) => patchRow(row.id, patch)}
            onPasteMany={(text) => handlePaste(row.id, text)}
            onRemove={() => removeRow(row.id)}
            onPreview={() => {
              setPreviewUrl(row.url.trim())
              setPreviewRow(row.id)
            }}
            onGallery={() => void loadGallery(row.url.trim())}
            galleryReady={galleryReady}
            probing={probing}
          />
        ))}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void pasteFromClipboard()}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-dashed border-accent/40 py-2 text-[12px] text-accent-soft transition-colors hover:border-accent hover:bg-accent/10"
          >
            <ClipboardPaste size={13} />
            Вставить из буфера
          </button>
          <button
            type="button"
            onClick={() => setRows((current) => [...current, emptyRow()])}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-dashed border-line py-2 text-[12px] text-ink-faint transition-colors hover:text-ink-dim"
          >
            <Plus size={13} />
            Пустая строка
          </button>
        </div>
      </div>

      {gallery && (
        <div className="animate-in-up space-y-3 rounded-xl bg-surface-2 p-3 ring-1 ring-line-soft">
          <div className="flex items-center justify-between">
            <span className="text-[12.5px] font-medium">Найдено файлов: {gallery.items.length}</span>
            <div className="flex gap-2 text-[11px]">
              <button
                type="button"
                className="text-ink-dim hover:text-ink"
                onClick={() => setPicked(gallery.items.map((item) => item.index))}
              >
                Выбрать все
              </button>
              <button type="button" className="text-ink-dim hover:text-ink" onClick={() => setPicked([])}>
                Снять выбор
              </button>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {gallery.items.map((item) => {
              const active = picked.includes(item.index)
              return (
                <button
                  key={item.index}
                  type="button"
                  onClick={() =>
                    setPicked(
                      active ? picked.filter((i) => i !== item.index) : [...picked, item.index],
                    )
                  }
                  className={`relative aspect-square overflow-hidden rounded-lg ring-2 transition-all ${
                    active ? 'ring-accent' : 'ring-transparent opacity-55 hover:opacity-85'
                  }`}
                >
                  <img
                    src={item.url}
                    alt=""
                    className="h-full w-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                  <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px] font-semibold">
                    {item.index}
                  </span>
                </button>
              )
            })}
          </div>
          <Button
            tone="primary"
            className="w-full"
            disabled={!picked.length || busy}
            onClick={() => void downloadGallerySelection()}
          >
            <Download size={14} />
            Скачать выбранные ({picked.length})
          </Button>
          <p className="text-[11px] text-ink-faint">
            Превью подгружаются напрямую с сайта-источника. Если картинки не отображаются — это
            защита от чужих ссылок, на само скачивание она не влияет.
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <span className="label">Что скачиваем</span>
          <Segmented<Mode>
            value={mode}
            onChange={setMode}
            options={[
              { value: 'auto', label: 'Авто', title: 'Определить по ссылке' },
              { value: 'video', label: 'Видео' },
              { value: 'audio', label: 'Звук' },
              { value: 'images', label: 'Кадры' },
            ]}
          />
        </div>

        {mode === 'audio' ? (
          <Select
            label="Формат звука"
            value={audioFormat}
            onChange={setAudioFormat}
            options={[
              { value: 'opus', label: 'Opus — минимальный вес' },
              { value: 'mp3', label: 'MP3 — совместимость' },
              { value: 'm4a', label: 'M4A / AAC' },
              { value: 'best', label: 'Как на источнике' },
            ]}
          />
        ) : (
          <Select
            label="Максимальное качество"
            value={String(maxHeight)}
            onChange={(value) => setMaxHeight(Number(value))}
            options={[
              { value: '0', label: 'Максимально доступное' },
              { value: '1080', label: 'до 1080p' },
              { value: '720', label: 'до 720p' },
              { value: '480', label: 'до 480p' },
            ]}
          />
        )}
      </div>

      <Section title="После скачивания">
        <Select
          label="Сразу сжать пресетом"
          value={autoPreset}
          onChange={setAutoPreset}
          options={[
            { value: '', label: 'Не сжимать — просто скачать' },
            ...allPresets.map((preset) => ({ value: preset.id, label: preset.label })),
          ]}
          hint="Скачанный файл автоматически уйдёт в очередь обработки с этим пресетом."
        />
      </Section>

      <div className="sticky bottom-0 -mx-6 border-t border-line-soft bg-base/85 px-6 py-3 backdrop-blur">
        <Button
          tone="primary"
          className="w-full py-2.5"
          disabled={!filled.length || busy || !ytdlpReady}
          onClick={() => void start()}
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
          Скачать {filled.length > 1 ? `(${filled.length})` : ''}
        </Button>
        <button
          type="button"
          onClick={() => setFolderPicker(true)}
          className="mt-2 flex w-full items-center justify-center gap-1.5 text-[11px] text-ink-faint transition-colors hover:text-ink-dim"
          title="Выбрать папку для скачанного"
        >
          <FolderOpen size={11} />
          Сохранять в
          <span className="max-w-[420px] truncate font-mono text-ink-dim">
            {settings?.download.directory ?? `${settings?.resolvedWorkspace ?? ''}\\Скачанное`}
          </span>
        </button>
      </div>

      <FolderPicker
        open={folderPicker}
        onClose={() => setFolderPicker(false)}
        title="Папка для скачанного"
        onPick={async (path) => {
          await api.patchSettings({ download: { directory: path } })
          await refreshSettings()
        }}
      />

      <LinkPreview
        url={previewUrl ?? ''}
        open={Boolean(previewUrl)}
        onClose={() => {
          setPreviewUrl(null)
          setPreviewRow(null)
        }}
        onApply={(start, end) => {
          if (previewRow !== null) patchRow(previewRow, { start, end })
        }}
      />
    </div>
  )
}

function LinkRow({
  number,
  row,
  disabled,
  onChange,
  onPasteMany,
  onRemove,
  onPreview,
  onGallery,
  galleryReady,
  probing,
}: {
  number: number
  row: Row
  disabled: boolean
  onChange: (patch: Partial<Row>) => void
  onPasteMany: (text: string) => boolean
  onRemove: () => void
  onPreview: () => void
  onGallery: () => void
  galleryReady: boolean
  probing: boolean
}) {
  const [editingTime, setEditingTime] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  const hasUrl = Boolean(row.url.trim())
  const hasSection = row.start !== null || row.end !== null

  // Поле растёт вниз вместе с длинной ссылкой, но номер строки остаётся один.
  function autoGrow(element: HTMLTextAreaElement) {
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 120)}px`
  }

  return (
    <div className="rounded-xl border border-line-soft bg-surface-2 px-3 py-2.5">
      <div className="flex gap-2.5">
        <span className="mt-1.5 w-5 shrink-0 text-right text-[12px] font-semibold tabular-nums text-ink-faint">
          {number}
        </span>

        <textarea
          ref={areaRef}
          rows={1}
          spellCheck={false}
          value={row.url}
          placeholder="https://…"
          className="field min-h-0 resize-none overflow-hidden break-all py-1.5 font-mono text-[12px] leading-snug"
          onChange={(event) => {
            onChange({ url: event.target.value })
            autoGrow(event.target)
          }}
          onPaste={(event) => {
            const text = event.clipboardData.getData('text')
            if (onPasteMany(text)) event.preventDefault()
          }}
          onInput={(event) => autoGrow(event.currentTarget)}
        />

        <button
          type="button"
          onClick={onRemove}
          title="Убрать строку"
          className="mt-0.5 h-7 w-7 shrink-0 rounded-lg text-ink-faint transition-colors hover:bg-surface-3 hover:text-danger"
        >
          <Trash2 size={13} className="mx-auto" />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-[30px]">
        <button
          type="button"
          disabled={!hasUrl || disabled}
          onClick={onPreview}
          className="inline-flex items-center gap-1.5 rounded-lg bg-surface-3 px-2 py-1 text-[11px] text-ink-dim transition-colors hover:bg-line hover:text-ink disabled:opacity-35"
        >
          <Film size={12} />
          Разметить
        </button>

        <button
          type="button"
          onClick={() => setEditingTime((value) => !value)}
          className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] transition-colors ${
            hasSection
              ? 'bg-accent/15 text-accent-soft hover:bg-accent/25'
              : 'bg-surface-3 text-ink-faint hover:bg-line hover:text-ink-dim'
          }`}
        >
          <Scissors size={11} />
          {hasSection
            ? `${timecode(row.start ?? 0, true)} → ${row.end !== null ? timecode(row.end, true) : 'конец'}`
            : 'весь ролик'}
        </button>

        {hasSection && (
          <button
            type="button"
            onClick={() => onChange({ start: null, end: null })}
            className="rounded px-1.5 py-1 text-[11px] text-ink-faint hover:text-ink"
          >
            сбросить
          </button>
        )}

        {galleryReady && (
          <button
            type="button"
            disabled={!hasUrl || probing}
            onClick={onGallery}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-ink-faint transition-colors hover:bg-surface-3 hover:text-ink-dim disabled:opacity-35"
          >
            <Images size={12} />
            Картинки поста
          </button>
        )}
      </div>

      {editingTime && (
        <div className="mt-2 flex flex-wrap items-center gap-2 pl-[30px]">
          <TimeField
            label="с"
            value={row.start}
            onChange={(value) => onChange({ start: value })}
          />
          <TimeField label="по" value={row.end} onChange={(value) => onChange({ end: value })} />
          <span className="text-[11px] text-ink-faint">
            Формат: <span className="font-mono">1:23</span> или{' '}
            <span className="font-mono">83</span>. Пусто — от начала / до конца.
          </span>
        </div>
      )}
    </div>
  )
}

function TimeField({
  label,
  value,
  onChange,
}: {
  label: string
  value: number | null
  onChange: (value: number | null) => void
}) {
  const [text, setText] = useState(value === null ? '' : timecode(value, true))

  return (
    <label className="flex items-center gap-1.5 text-[11px] text-ink-faint">
      {label}
      <input
        className="field w-24 py-1 text-center font-mono text-[12px]"
        value={text}
        placeholder="—"
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          const parsed = parseTime(text)
          onChange(parsed)
          setText(parsed === null ? '' : timecode(parsed, true))
        }}
      />
    </label>
  )
}

import { useEffect, useRef, useState } from 'react'
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
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import { plural, timecode } from '../lib/format'
import type { GalleryItem } from '../lib/types'
import { useStore } from '../store'
import { FolderPicker } from './FolderPicker'
import { LinkPreview } from './LinkPreview'
import { Button, Section, Segmented, Select, Toggle } from './ui'

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

  // Показываем только те пресеты, которые подходят к выбранному типу
  // загрузки: выбрав «Кадры», человек раньше видел в списке сжатие видео
  // и звука, выбирал его — и не понимал, почему ничего не происходит.
  const autoPresets =
    mode === 'images'
      ? (presets.image ?? [])
      : mode === 'audio'
        ? (presets.audio ?? [])
        // В «Авто» тип заранее неизвестен, поэтому показываем всё:
          // в свёрнутом списке длина не мешает.
          : [...(presets.video ?? []), ...(presets.audio ?? []), ...(presets.image ?? [])]

  // Сменили тип — выбранный пресет мог стать неподходящим, снимаем его.
  useEffect(() => {
    if (autoPreset && !autoPresets.some((preset) => preset.id === autoPreset)) {
      setAutoPreset('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

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

  /** Раскладывает ссылки из текста по строкам. Возвращает, сколько нашлось. */
  function addLinks(text: string): number {
    const links = text
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => /^https?:\/\//i.test(item))

    if (!links.length) return 0

    setRows((current) => {
      const next = current.map((row) => ({ ...row }))
      const queue = [...links]
      for (const row of next) {
        if (!row.url.trim() && queue.length) row.url = queue.shift() as string
      }
      return [...next, ...queue.map((link) => emptyRow(link))]
    })
    return links.length
  }

  // Ctrl+V где угодно на вкладке — ссылка попадает в список. Целиться мышью
  // в узкую строчку каждый раз неудобно, а событие вставки приходит и без
  // разрешения на чтение буфера.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      // В поле ввода вставку обрабатывает само поле.
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return

      const text = event.clipboardData?.getData('text') ?? ''
      const count = addLinks(text)
      if (count) {
        event.preventDefault()
        toast(`Добавлено ссылок: ${count}`, 'ok')
      }
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  // Ссылку стёрли или поменяли — список её картинок больше не про неё.
  useEffect(() => {
    if (gallery && !filled.some((row) => row.url.trim() === gallery.url)) {
      setGallery(null)
      setPicked([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])

  /** Сохраняет настройку загрузки и сразу перечитывает их с сервера. */
  async function patchDownload(value: Record<string, unknown>) {
    try {
      await api.patchSettings({ download: value })
      await refreshSettings()
    } catch (error) {
      toast((error as Error).message, 'error')
    }
  }

  async function start() {
    if (!filled.length) {
      toast('Вставьте хотя бы одну ссылку', 'error')
      return
    }

    // Одна ссылка на пост с несколькими вложениями — сначала спрашиваем,
    // что именно скачивать. Для пачки ссылок так делать нельзя: человек
    // утонет в окнах выбора, поэтому там качаем всё.
    if (filled.length === 1 && galleryReady && mode !== 'video' && mode !== 'audio') {
      setProbing(true)
      try {
        const found = await api.probeGallery(filled[0].url.trim())
        if (found.items.length > 1) {
          setGallery({ url: found.url, items: found.items })
          setPicked(found.items.map((item) => item.index))
          return
        }
      } catch {
        // Не пост с картинками — качаем обычным путём.
      } finally {
        setProbing(false)
      }
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
    // Старый список убираем сразу: иначе он висит на экране, пока грузится
    // новый, и кажется, что кнопка не сработала.
    setGallery(null)
    setPicked([])
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
    <div className="flex h-full min-h-0">
      {/* Слева — ссылки и картинки, справа — настройки и кнопка.
          Так же устроена медиатека, и кнопка «Скачать» перестаёт
          ездить по экрану при прокрутке. */}
      <div className="min-w-0 flex-1 space-y-5 overflow-y-auto px-6 py-6">
      <header>
        <h1 className="text-[20px] font-semibold">Загрузка</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-dim">
          Каждая ссылка — своя строка. Нажмите «Предпросмотр с разметкой», чтобы открыть видео прямо здесь и
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
            <div className="flex items-center gap-2 text-[11px]">
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
              <button
                type="button"
                title="Закрыть выбор"
                className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-ink"
                onClick={() => {
                  setGallery(null)
                  setPicked([])
                }}
              >
                <X size={13} />
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
          <p className="text-[11px] text-ink-faint">
            Превью подгружаются напрямую с сайта-источника. Если картинки не отображаются — это
            защита от чужих ссылок, на само скачивание она не влияет.
          </p>
        </div>
      )}

      </div>

      <aside className="flex w-[340px] shrink-0 flex-col border-l border-line-soft bg-surface">
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5">
          <Section title="Формат">
            <Segmented<Mode>
              value={mode}
              onChange={setMode}
              options={[
                { value: 'auto', label: 'Авто', title: 'Определить по ссылке' },
                { value: 'video', label: 'Видео' },
                { value: 'audio', label: 'Звук' },
                { value: 'images', label: 'Картинки' },
              ]}
            />
          </Section>

          {mode === 'audio' ? (
            <Section title="Формат звука">
              <Segmented
                value={audioFormat}
                onChange={setAudioFormat}
                options={[
                  { value: 'opus', label: 'Opus', title: 'Минимальный вес' },
                  { value: 'mp3', label: 'MP3', title: 'Совместимость со всем' },
                  { value: 'm4a', label: 'M4A', title: 'AAC в контейнере M4A' },
                  { value: 'best', label: 'Авто', title: 'Оставить формат источника' },
                ]}
              />
            </Section>
          ) : (
            <Section title="Качество">
              <Segmented
                value={String(maxHeight)}
                onChange={(value) => setMaxHeight(Number(value))}
                options={[
                  { value: '0', label: 'Макс.', title: 'Максимально доступное' },
                  { value: '1080', label: '1080p' },
                  { value: '720', label: '720p' },
                  { value: '480', label: '480p' },
                ]}
              />
            </Section>
          )}

          <Section title="Пресеты">
            <Select
              value={autoPreset}
              onChange={setAutoPreset}
              options={[
                { value: '', label: 'Не сжимать — просто скачать' },
                // К названию приписываем, чем именно жмём: в выпадающем списке
                // подсказки не покажешь, а выбирать вслепую неудобно.
                ...autoPresets.map((preset) => ({
                  value: preset.id,
                  label: preset.tech ? `${preset.label} — ${preset.tech}` : preset.label,
                })),
              ]}
            />
          </Section>

          <Section title="Куда скачивать">
            {/* Папку меняют часто — значит она должна быть на виду,
                а не строчкой мелким шрифтом под кнопкой. */}
            <button
              type="button"
              onClick={() => setFolderPicker(true)}
              className="flex w-full items-center gap-2 rounded-xl border border-line-soft bg-surface-2 px-3 py-2.5 text-left transition-colors hover:border-line hover:bg-surface-3"
            >
              <FolderOpen size={14} className="shrink-0 text-ink-faint" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-dim">
                {settings?.download.directory ?? `${settings?.resolvedWorkspace ?? ''}\Скачанное`}
              </span>
            </button>
          </Section>

          <Section title="Настройки загрузки">
            {/* Живут здесь, а не в общих настройках: их трогают ради
                конкретной ссылки, и бегать в другое окно неудобно. */}
            <div className="space-y-1 rounded-xl bg-surface-2 px-3 py-2.5">
              <Toggle
                checked={settings?.download.force_mp4 ?? true}
                onChange={(value) => void patchDownload({ force_mp4: value })}
                label="Всегда приводить видео к MP4"
                hint="Гарантирует, что файл откроется во встроенном плеере со звуком."
              />
              <Toggle
                checked={settings?.download.embed_metadata ?? true}
                onChange={(value) => void patchDownload({ embed_metadata: value })}
                label="Встраивать метаданные и обложку"
                hint="Внутрь файла записывается название, автор и картинка-обложка. Плееры показывают их вместо имени файла, а обложка видна в проводнике."
              />
              <Toggle
                checked={settings?.download.download_playlists ?? false}
                onChange={(value) => void patchDownload({ download_playlists: value })}
                label="Скачивать плейлисты целиком"
                hint="По умолчанию из ссылки на плейлист берётся только одно видео."
              />
            </div>
          </Section>

        </div>
        <div className="border-t border-line-soft bg-surface px-4 py-3">
        <Button
          tone="primary"
          className="w-full py-2.5"
          disabled={!filled.length || busy || probing || !ytdlpReady}
          onClick={() => void (gallery ? downloadGallerySelection() : start())}
        >
          {busy || probing ? (
            <Loader2 size={15} className="animate-spin" />
          ) : (
            <Download size={15} />
          )}
          {probing
            ? 'Смотрю, что в посте…'
            : gallery
              ? `Скачать выбранные (${picked.length})`
              : `Скачать ${filled.length > 1 ? `(${filled.length})` : ''}`}
        </Button>
        </div>
      </aside>

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
          Предпросмотр с разметкой
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
            : 'Указать тайминги'}
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

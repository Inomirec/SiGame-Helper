import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clapperboard, Download, FolderTree, Info, Settings as SettingsIcon, WifiOff, X } from 'lucide-react'
import { api } from './lib/api'
import { useEvents } from './hooks/useEvents'
import { useStore } from './store'
import { DownloadPanel } from './components/DownloadPanel'
import { ExportPanel } from './components/ExportPanel'
import { FolderPicker } from './components/FolderPicker'
import { ImageEditor, ImagePanel, emptyImageEdit, type ImageEdit } from './components/ImageEditor'
import type { ImagePreview } from './lib/types'
import { JobQueue } from './components/JobQueue'
import { MediaEditor, type TrimState } from './components/MediaEditor'
import { emptyFades, type Fades } from './components/Timeline'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { TextContextMenu } from './components/TextContextMenu'
import { Empty, Spinner } from './components/ui'

type Tab = 'library' | 'download'

export default function App() {
  useEvents()

  const bootstrap = useStore((state) => state.bootstrap)
  const ready = useStore((state) => state.ready)
  const status = useStore((state) => state.status)
  const connected = useStore((state) => state.connected)
  const activeInfo = useStore((state) => state.activeInfo)
  const activePath = useStore((state) => state.activePath)
  const infoLoading = useStore((state) => state.infoLoading)
  const toasts = useStore((state) => state.toasts)
  const dismissToast = useStore((state) => state.dismissToast)
  const refreshLibrary = useStore((state) => state.refreshLibrary)
  const openExternal = useStore((state) => state.openExternal)
  const toast = useStore((state) => state.toast)
  const refreshSettings = useStore((state) => state.refreshSettings)

  const [tab, setTab] = useState<Tab>('library')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [workspacePicker, setWorkspacePicker] = useState(false)
  const [trim, setTrim] = useState<TrimState>({ in: null, out: null })
  const [imageEdit, setImageEdit] = useState<ImageEdit>(emptyImageEdit)
  // Превью считает панель справа, а показывает холст слева — состояние общее.
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null)
  const [fades, setFades] = useState<Fades>(emptyFades)

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  // Файлы, перетащенные из проводника. Путь приходит от окна программы:
  // сама страница его не видит, браузеры путей не отдают.
  useEffect(() => {
    const onDrop = (event: Event) => {
      const paths = (event as CustomEvent<string[]>).detail
      if (!Array.isArray(paths) || !paths.length) return
      setTab('library')
      void openExternal(paths[0])
      if (paths.length > 1) {
        toast(`Открыт первый файл из ${paths.length} — остальные ищите в медиатеке`, 'info')
      }
    }
    // Пока окно не сказало «беру», Windows рисует перечёркнутый курсор и
    // события броска не будет вовсе. Плюс без этого браузер просто откроет
    // файл вместо страницы.
    const allow = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
    window.addEventListener('sgh:drop', onDrop)
    document.addEventListener('dragenter', allow)
    document.addEventListener('dragover', allow)
    document.addEventListener('drop', allow)
    return () => {
      window.removeEventListener('sgh:drop', onDrop)
      document.removeEventListener('dragenter', allow)
      document.removeEventListener('dragover', allow)
      document.removeEventListener('drop', allow)
    }
  }, [openExternal, toast])

  // Метки In/Out и правки кадра привязаны к конкретному файлу — при смене сбрасываем.
  useEffect(() => {
    setTrim({ in: null, out: null })
    setImageEdit(emptyImageEdit)
    setFades(emptyFades)
  }, [activePath])

  // Выбор файла в медиатеке всегда возвращает на вкладку редактора.
  useEffect(() => {
    if (activePath) setTab('library')
  }, [activePath])

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center gap-3 text-ink-dim">
        <Spinner size={18} />
        Запуск…
      </div>
    )
  }

  const missingTools = Object.values(status?.tools ?? {}).filter((tool) => !tool.available)

  return (
    <div className="flex h-full flex-col">
      {/* Верхняя панель */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line-soft bg-surface px-4">
        <div className="flex items-center gap-2">
          <img src="/icon.png" alt="" className="h-[19px] w-[19px] rounded-[5px]" />
          <span className="text-[14px] font-semibold tracking-tight">SiGame Helper</span>
        </div>

        <nav className="ml-4 flex gap-1">
          <TabButton
            active={tab === 'library'}
            onClick={() => setTab('library')}
            icon={<FolderTree size={14} />}
            label="Медиатека"
          />
          <TabButton
            active={tab === 'download'}
            onClick={() => setTab('download')}
            icon={<Download size={14} />}
            label="Загрузка"
          />
        </nav>

        <div className="ml-auto flex items-center gap-3 text-[11px] text-ink-faint">
          {/* Показываем только то, что требует внимания: когда всё в порядке,
              лишние индикаторы лишь отвлекают. */}
          {missingTools.length > 0 && (
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="flex items-center gap-1.5 rounded-lg bg-warn/12 px-2 py-1 text-warn"
              title={missingTools.map((tool) => `${tool.name}: ${tool.error}`).join(' · ')}
            >
              <AlertTriangle size={12} />
              Не найдено: {missingTools.map((tool) => tool.name).join(', ')}
            </button>
          )}
          {!connected && (
            <span className="flex items-center gap-1.5 text-warn" title="Связь с сервером потеряна — переподключаемся">
              <WifiOff size={12} />
              Нет связи
            </span>
          )}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="rounded-lg p-1.5 text-ink-dim hover:bg-surface-3 hover:text-ink"
            title="Настройки"
          >
            <SettingsIcon size={15} />
          </button>
        </div>
      </header>

      {/* Рабочая область */}
      <div className="flex min-h-0 flex-1">
        <Sidebar onPickWorkspace={() => setWorkspacePicker(true)} />

        <main className="min-w-0 flex-1 overflow-hidden">
          {tab === 'download' ? (
            <DownloadPanel />
          ) : infoLoading ? (
            <div className="flex h-full items-center justify-center">
              <Spinner size={20} />
            </div>
          ) : activeInfo ? (
            <div className="h-full p-4">
              {activeInfo.kind === 'image' ? (
                <ImageEditor
                  file={activeInfo}
                  edit={imageEdit}
                  preview={imagePreview}
                  onEditChange={setImageEdit}
                />
              ) : (
                <MediaEditor
                  file={activeInfo}
                  trim={trim}
                  onTrimChange={setTrim}
                  fades={fades}
                  onFadesChange={setFades}
                />
              )}
            </div>
          ) : (
            <Empty
              icon={<Clapperboard size={44} />}
              title="Выберите файл слева"
              hint="Видео и звук откроются в плеере с таймлайном и метками In/Out, картинки — в панели оптимизации. Нужного файла ещё нет? Загляните на вкладку «Загрузка»."
            />
          )}
        </main>

        {/* Правая панель настроек экспорта */}
        {tab === 'library' && activeInfo && (
          <aside className="flex w-[340px] shrink-0 flex-col border-l border-line-soft bg-surface">
            {activeInfo.kind === 'image' ? (
              <ImagePanel
                key={activeInfo.path}
                file={activeInfo}
                edit={imageEdit}
                onPreview={setImagePreview}
              />
            ) : (
              <ExportPanel key={activeInfo.path} file={activeInfo} trim={trim} fades={fades} />
            )}
          </aside>
        )}
      </div>

      <JobQueue />

      <TextContextMenu />

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <FolderPicker
        open={workspacePicker}
        onClose={() => setWorkspacePicker(false)}
        title="Рабочая папка"
        onPick={async (path) => {
          await api.addWorkspace(path)
          await refreshSettings()
          void refreshLibrary()
        }}
      />

      {/* Всплывающие уведомления */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
        {toasts.map((item) => (
          <div
            key={item.id}
            className={`animate-in-up pointer-events-auto flex items-start gap-2.5 rounded-xl border px-3 py-2.5 shadow-lg backdrop-blur ${
              item.tone === 'error'
                ? 'border-danger/40 bg-danger/12 text-danger'
                : item.tone === 'ok'
                  ? 'border-ok/35 bg-ok/10 text-ok'
                  : 'border-line bg-surface-2 text-ink-dim'
            }`}
          >
            {item.tone === 'error' ? (
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            ) : item.tone === 'ok' ? (
              <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
            ) : (
              <Info size={14} className="mt-0.5 shrink-0" />
            )}
            <p className="min-w-0 flex-1 break-words text-[12px] leading-snug">{item.text}</p>
            <button
              type="button"
              onClick={() => dismissToast(item.id)}
              className="shrink-0 opacity-60 hover:opacity-100"
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
        active ? 'bg-surface-3 text-ink' : 'text-ink-faint hover:bg-surface-2 hover:text-ink-dim'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

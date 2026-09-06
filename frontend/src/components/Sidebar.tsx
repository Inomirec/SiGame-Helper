import { useState } from 'react'
import {
  CheckSquare,
  ChevronRight,
  CornerLeftUp,
  Folder,
  FolderOpen,
  FolderTree,
  LayoutGrid,
  List,
  Image as ImageIcon,
  Music,
  RefreshCw,
  Search,
  Square,
  Trash2,
  Video,
} from 'lucide-react'
import { api, thumbUrl } from '../lib/api'
import { humanSize } from '../lib/format'
import type { LibraryFile } from '../lib/types'
import { useStore, type FilterKind } from '../store'
import { IconButton, Segmented, Spinner } from './ui'

const LAYOUT_KEY = 'sgh.libraryLayout'

export function Sidebar({ onPickWorkspace }: { onPickWorkspace: () => void }) {
  const files = useStore((state) => state.files)
  const counts = useStore((state) => state.counts)
  const filter = useStore((state) => state.filter)
  const search = useStore((state) => state.search)
  const loading = useStore((state) => state.libraryLoading)
  const activePath = useStore((state) => state.activePath)
  const checked = useStore((state) => state.checked)
  const root = useStore((state) => state.libraryRoot)
  const folders = useStore((state) => state.folders)
  const folderPath = useStore((state) => state.folderPath)
  const parentFolder = useStore((state) => state.parentFolder)
  const currentFolder = useStore((state) => state.currentFolder)
  const flat = useStore((state) => state.flat)
  const openFolder = useStore((state) => state.openFolder)
  const setFlat = useStore((state) => state.setFlat)
  const setFilter = useStore((state) => state.setFilter)
  const setSearch = useStore((state) => state.setSearch)
  const select = useStore((state) => state.select)
  const toggleCheck = useStore((state) => state.toggleCheck)
  const setChecked = useStore((state) => state.setChecked)
  const refreshLibrary = useStore((state) => state.refreshLibrary)
  const toast = useStore((state) => state.toast)

  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  // Режим показа запоминаем: большинство файлов узнаются по превью, но кому-то
  // привычнее плотный список.
  const [layout, setLayout] = useState<'list' | 'grid'>(
    () => (localStorage.getItem(LAYOUT_KEY) as 'list' | 'grid') ?? 'list',
  )

  function switchLayout(next: 'list' | 'grid') {
    setLayout(next)
    localStorage.setItem(LAYOUT_KEY, next)
  }

  const allChecked = files.length > 0 && checked.length === files.length
  const totalSize = files.reduce((sum, file) => sum + file.size, 0)

  async function remove(path: string) {
    try {
      await api.deleteFile(path)
      setChecked(checked.filter((item) => item !== path))
      if (activePath === path) void select(null)
      void refreshLibrary()
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setConfirmDelete(null)
    }
  }

  return (
    <aside className="flex w-[336px] shrink-0 flex-col overflow-hidden border-r border-line-soft bg-surface">
      {/* Рабочая папка */}
      <div className="border-b border-line-soft px-3 py-2.5">
        <button
          type="button"
          onClick={onPickWorkspace}
          title={root}
          className="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-3"
        >
          <FolderOpen size={15} className="shrink-0 text-accent-soft" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-medium">
              {root.split(/[\\/]/).pop() || 'Рабочая папка'}
            </span>
            <span className="block truncate text-[10.5px] text-ink-faint">{root}</span>
          </span>
        </button>

        {/* Где мы сейчас внутри пака */}
        {(currentFolder || flat) && (
          <button
            type="button"
            onClick={() => openFolder(null)}
            title="Вернуться в корень рабочей папки"
            className="mt-1 block w-full truncate px-2 text-left text-[11px] text-ink-faint hover:text-ink-dim"
          >
            {flat ? 'Все вложенные папки' : folderPath || 'корень'}
          </button>
        )}
      </div>

      {/* Фильтры */}
      <div className="space-y-2 border-b border-line-soft px-3 py-2.5">
        <Segmented<FilterKind>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'Все', badge: counts.all ?? 0 },
            { value: 'video', label: 'Видео', badge: counts.video ?? 0 },
            { value: 'audio', label: 'Аудио', badge: counts.audio ?? 0 },
            { value: 'image', label: 'Кадры', badge: counts.image ?? 0 },
          ]}
        />
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint"
          />
          <input
            className="field pl-8"
            placeholder="Поиск по имени…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>

      {/* Пакетные действия */}
      <div className="flex items-center gap-1 border-b border-line-soft px-3 py-1.5 text-[11px] text-ink-faint">
        <button
          type="button"
          onClick={() => setChecked(allChecked ? [] : files.map((file) => file.path))}
          className="flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-surface-3 hover:text-ink-dim"
        >
          {allChecked ? <CheckSquare size={13} /> : <Square size={13} />}
          {checked.length ? `Выбрано: ${checked.length}` : 'Выбрать все'}
        </button>
        <span className="ml-auto tabular-nums">{humanSize(totalSize)}</span>
        <IconButton
          onClick={() => setFlat(!flat)}
          active={flat}
          title={
            flat
              ? 'Вернуться к структуре папок'
              : 'Показать все файлы из вложенных папок одним списком'
          }
          className="h-6 w-6"
        >
          <FolderTree size={12} />
        </IconButton>
        <IconButton
          onClick={() => switchLayout(layout === 'list' ? 'grid' : 'list')}
          title={layout === 'list' ? 'Показать плиткой' : 'Показать списком'}
          className="h-6 w-6"
        >
          {layout === 'list' ? <LayoutGrid size={12} /> : <List size={12} />}
        </IconButton>
        <IconButton onClick={() => void refreshLibrary()} title="Обновить список" className="h-6 w-6">
          {loading ? <Spinner size={12} /> : <RefreshCw size={12} />}
        </IconButton>
      </div>

      {/* Папки и файлы */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {files.length === 0 && folders.length === 0 && !loading && (
          <p className="px-3 py-8 text-center text-[12px] leading-relaxed text-ink-faint">
            {search ? 'Ничего не нашлось.' : 'В этой папке пока нет медиафайлов. Скачайте что-нибудь на вкладке «Загрузка» или выберите другую папку.'}
          </p>
        )}

        {/* «Назад» стоит вплотную к содержимому — там, где его ищут глазами */}
        {currentFolder && !flat && (
          <button
            type="button"
            onClick={() => openFolder(parentFolder)}
            className="mb-1 flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface-2"
          >
            <CornerLeftUp size={15} className="shrink-0 text-ink-faint" />
            <span className="text-[12.5px] text-ink-dim">Назад</span>
          </button>
        )}

        {/* Вложенные папки: человек уже разложил исходники — не ломаем это */}
        {folders.length > 0 && (
          <ul className="mb-2 space-y-0.5">
            {folders.map((folder) => (
              <li key={folder.path}>
                <button
                  type="button"
                  onClick={() => openFolder(folder.path)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface-2"
                >
                  <Folder size={15} className="shrink-0 text-accent-soft/80" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-dim">
                    {folder.name}
                  </span>
                  <span className="shrink-0 text-[10.5px] tabular-nums text-ink-faint">
                    {folder.count}
                  </span>
                  <ChevronRight size={13} className="shrink-0 text-ink-faint" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {layout === 'grid' ? (
          <ul className="grid grid-cols-2 gap-2">
            {files.map((file) => (
              <FileTile
                key={file.path}
                file={file}
                active={activePath === file.path}
                checked={checked.includes(file.path)}
                onOpen={() => void select(file.path)}
                onCheck={() => toggleCheck(file.path)}
                onDelete={() =>
                  confirmDelete === file.path ? void remove(file.path) : setConfirmDelete(file.path)
                }
                confirming={confirmDelete === file.path}
              />
            ))}
          </ul>
        ) : (
          <ul className="space-y-0.5">
            {files.map((file) => (
              <FileRow
                key={file.path}
                file={file}
                active={activePath === file.path}
                checked={checked.includes(file.path)}
                confirming={confirmDelete === file.path}
                onOpen={() => void select(file.path)}
                onCheck={() => toggleCheck(file.path)}
                onDelete={() =>
                  confirmDelete === file.path ? void remove(file.path) : setConfirmDelete(file.path)
                }
                onCancelDelete={() => setConfirmDelete(null)}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}

const ICONS = {
  video: Video,
  audio: Music,
  image: ImageIcon,
  other: ImageIcon,
}

function FileRow({
  file,
  active,
  checked,
  confirming,
  onOpen,
  onCheck,
  onDelete,
  onCancelDelete,
}: {
  file: LibraryFile
  active: boolean
  checked: boolean
  confirming: boolean
  onOpen: () => void
  onCheck: () => void
  onDelete: () => void
  onCancelDelete: () => void
}) {
  const [thumbFailed, setThumbFailed] = useState(false)
  const Icon = ICONS[file.kind] ?? ImageIcon
  const showThumb = (file.kind === 'video' || file.kind === 'image') && !thumbFailed

  return (
    <li>
      <div
        className={`group flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors ${
          active ? 'bg-accent/12 ring-1 ring-accent/35' : 'hover:bg-surface-2'
        }`}
        onClick={onOpen}
      >
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onCheck()
          }}
          className={`shrink-0 rounded p-0.5 transition-opacity ${
            checked ? 'text-accent' : 'text-ink-faint opacity-0 group-hover:opacity-100'
          }`}
          title="Отметить для пакетной обработки"
        >
          {checked ? <CheckSquare size={14} /> : <Square size={14} />}
        </button>

        <div className="relative h-9 w-14 shrink-0 overflow-hidden rounded bg-surface-3">
          {showThumb ? (
            <img
              src={thumbUrl(file.path)}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
              onError={() => setThumbFailed(true)}
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-ink-faint">
              <Icon size={15} />
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className={`truncate text-[12.5px] ${active ? 'text-ink' : 'text-ink-dim'}`}>
            {file.name}
          </p>
          <p className="truncate text-[10.5px] text-ink-faint">
            {file.ext.toUpperCase()} · {humanSize(file.size)}
            {file.relative.includes('\\') || file.relative.includes('/')
              ? ` · ${file.relative.split(/[\\/]/).slice(0, -1).join('/')}`
              : ''}
          </p>
        </div>

        {confirming ? (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onDelete()
              }}
              className="rounded bg-danger/20 px-1.5 py-1 text-[10px] font-semibold text-danger"
            >
              Удалить
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onCancelDelete()
              }}
              className="rounded px-1.5 py-1 text-[10px] text-ink-faint hover:text-ink"
            >
              Нет
            </button>
          </div>
        ) : (
          <button
            type="button"
            title="Удалить файл"
            onClick={(event) => {
              event.stopPropagation()
              onDelete()
            }}
            className="shrink-0 rounded p-1 text-ink-faint opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </li>
  )
}


function FileTile({
  file,
  active,
  checked,
  confirming,
  onOpen,
  onCheck,
  onDelete,
}: {
  file: LibraryFile
  active: boolean
  checked: boolean
  confirming: boolean
  onOpen: () => void
  onCheck: () => void
  onDelete: () => void
}) {
  const [thumbFailed, setThumbFailed] = useState(false)
  const Icon = ICONS[file.kind] ?? ImageIcon
  const showThumb = (file.kind === 'video' || file.kind === 'image') && !thumbFailed

  return (
    <li>
      <div
        className={`group relative cursor-pointer overflow-hidden rounded-lg ring-1 transition-colors ${
          active ? 'ring-accent' : 'ring-line-soft hover:ring-line'
        }`}
        onClick={onOpen}
      >
        <div className="relative aspect-video bg-surface-3">
          {showThumb ? (
            <img
              src={thumbUrl(file.path)}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
              onError={() => setThumbFailed(true)}
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-ink-faint">
              <Icon size={22} />
            </span>
          )}

          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onCheck()
            }}
            className={`absolute left-1 top-1 rounded bg-black/55 p-0.5 backdrop-blur-sm transition-opacity ${
              checked ? 'text-accent-soft opacity-100' : 'text-white/80 opacity-0 group-hover:opacity-100'
            }`}
            title="Отметить для пакетной обработки"
          >
            {checked ? <CheckSquare size={13} /> : <Square size={13} />}
          </button>

          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onDelete()
            }}
            title={confirming ? 'Нажмите ещё раз, чтобы удалить' : 'Удалить файл'}
            className={`absolute right-1 top-1 rounded bg-black/55 p-0.5 backdrop-blur-sm transition-opacity ${
              confirming
                ? 'text-danger opacity-100'
                : 'text-white/80 opacity-0 hover:text-danger group-hover:opacity-100'
            }`}
          >
            <Trash2 size={12} />
          </button>
        </div>

        <div className={`px-1.5 py-1 ${active ? 'bg-accent/12' : 'bg-surface-2'}`}>
          <p className="truncate text-[11.5px] text-ink-dim" title={file.name}>
            {file.name}
          </p>
          <p className="truncate text-[10px] text-ink-faint">
            {file.ext.toUpperCase()} · {humanSize(file.size)}
          </p>
        </div>
      </div>
    </li>
  )
}

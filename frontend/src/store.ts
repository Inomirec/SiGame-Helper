import { create } from 'zustand'
import { api } from './lib/api'
import type {
  AppSettings,
  FileInfo,
  Job,
  LibraryFile,
  LibraryFolder,
  Preset,
  SystemStatus,
} from './lib/types'

export type FilterKind = 'all' | 'video' | 'audio' | 'image'
export type Toast = { id: number; text: string; tone: 'info' | 'ok' | 'error' }

interface State {
  ready: boolean
  status: SystemStatus | null
  settings: AppSettings | null
  presets: Record<string, Preset[]>

  files: LibraryFile[]
  folders: LibraryFolder[]
  counts: Record<string, number>
  libraryRoot: string
  /** Папка, в которую человек зашёл. null = корень рабочей папки. */
  currentFolder: string | null
  folderPath: string
  parentFolder: string | null
  libraryLoading: boolean
  /** Показывать всё вложенное одним списком, не заходя в папки. */
  flat: boolean
  filter: FilterKind
  search: string

  activePath: string | null
  activeInfo: FileInfo | null
  infoLoading: boolean
  checked: string[]

  jobs: Job[]
  connected: boolean
  toasts: Toast[]
  queueOpen: boolean

  bootstrap: () => Promise<void>
  refreshStatus: () => Promise<void>
  refreshSettings: () => Promise<void>
  refreshLibrary: () => Promise<void>
  refreshJobs: () => Promise<void>
  setFilter: (filter: FilterKind) => void
  setSearch: (search: string) => void
  openFolder: (path: string | null) => void
  setFlat: (flat: boolean) => void
  select: (path: string | null) => Promise<void>
  toggleCheck: (path: string, additive?: boolean) => void
  setChecked: (paths: string[]) => void
  clearChecked: () => void
  upsertJob: (job: Job) => void
  setConnected: (connected: boolean) => void
  toast: (text: string, tone?: Toast['tone']) => void
  dismissToast: (id: number) => void
  setQueueOpen: (open: boolean) => void
}

let toastId = 0
/** Библиотеку перезагружаем не чаще раза в 400 мс: событий от задач много. */
let libraryTimer: ReturnType<typeof setTimeout> | null = null

export const useStore = create<State>((set, get) => ({
  ready: false,
  status: null,
  settings: null,
  presets: {},

  files: [],
  folders: [],
  counts: { all: 0, video: 0, audio: 0, image: 0 },
  libraryRoot: '',
  currentFolder: null,
  folderPath: '',
  parentFolder: null,
  libraryLoading: false,
  flat: localStorage.getItem('sgh.flatLibrary') === '1',
  filter: 'all',
  search: '',

  activePath: null,
  activeInfo: null,
  infoLoading: false,
  checked: [],

  jobs: [],
  connected: false,
  toasts: [],
  queueOpen: false,

  async bootstrap() {
    try {
      const [status, settings, presets] = await Promise.all([
        api.status(),
        api.settings(),
        api.presets(),
      ])
      set({ status, settings, presets, ready: true })
      await get().refreshLibrary()
      await get().refreshJobs()
    } catch (error) {
      get().toast(`Не удалось связаться с сервером: ${(error as Error).message}`, 'error')
      set({ ready: true })
    }
  },

  async refreshStatus() {
    try {
      set({ status: await api.status(true) })
    } catch (error) {
      get().toast((error as Error).message, 'error')
    }
  },

  async refreshSettings() {
    try {
      set({ settings: await api.settings() })
    } catch (error) {
      get().toast((error as Error).message, 'error')
    }
  },

  async refreshLibrary() {
    const { filter, search, settings, currentFolder, flat } = get()
    set({ libraryLoading: true })
    try {
      // Поиск всегда идёт по всему дереву: иначе непонятно, почему файл
      // «не находится», хотя он лежит в соседней папке.
      const recursive = flat || Boolean(search)
      const data = await api.library({
        root: currentFolder ?? settings?.resolvedWorkspace,
        kind: filter,
        search: search || undefined,
        recursive,
      })
      set({
        files: data.files,
        folders: data.folders ?? [],
        counts: data.counts,
        libraryRoot: data.root,
        folderPath: data.relative ?? '',
        parentFolder: data.parent ?? null,
      })

      // Если открытый файл исчез (удалили, переименовали) — снимаем выбор.
      const active = get().activePath
      if (active && !data.files.some((file) => file.path === active)) {
        const stillExists = await api.fileInfo(active).catch(() => null)
        if (!stillExists) set({ activePath: null, activeInfo: null })
      }
    } catch (error) {
      get().toast((error as Error).message, 'error')
    } finally {
      set({ libraryLoading: false })
    }
  },

  async refreshJobs() {
    try {
      const data = await api.jobs()
      set({ jobs: data.jobs })
    } catch {
      /* очередь подтянется со следующим событием */
    }
  },

  setFilter(filter) {
    set({ filter })
    void get().refreshLibrary()
  },

  setSearch(search) {
    set({ search })
    if (libraryTimer) clearTimeout(libraryTimer)
    libraryTimer = setTimeout(() => void get().refreshLibrary(), 250)
  },

  openFolder(path) {
    set({ currentFolder: path })
    void get().refreshLibrary()
  },

  setFlat(flat) {
    localStorage.setItem('sgh.flatLibrary', flat ? '1' : '0')
    set({ flat })
    void get().refreshLibrary()
  },

  async select(path) {
    if (!path) {
      set({ activePath: null, activeInfo: null })
      return
    }
    set({ activePath: path, infoLoading: true, activeInfo: null })
    try {
      const info = await api.fileInfo(path)
      // Пока грузили — пользователь мог кликнуть другой файл.
      if (get().activePath === path) set({ activeInfo: info })
    } catch (error) {
      get().toast((error as Error).message, 'error')
      set({ activePath: null })
    } finally {
      set({ infoLoading: false })
    }
  },

  toggleCheck(path, additive = true) {
    const { checked } = get()
    if (!additive) {
      set({ checked: [path] })
      return
    }
    set({
      checked: checked.includes(path) ? checked.filter((item) => item !== path) : [...checked, path],
    })
  },

  setChecked(paths) {
    set({ checked: paths })
  },

  clearChecked() {
    set({ checked: [] })
  },

  upsertJob(job) {
    const jobs = get().jobs
    const index = jobs.findIndex((item) => item.id === job.id)
    if (index === -1) {
      set({ jobs: [...jobs, job] })
    } else {
      const next = jobs.slice()
      next[index] = { ...next[index], ...job }
      set({ jobs: next })
    }
  },

  setConnected(connected) {
    set({ connected })
  },

  toast(text, tone = 'info') {
    const id = ++toastId
    set({ toasts: [...get().toasts, { id, text, tone }] })
    setTimeout(() => get().dismissToast(id), tone === 'error' ? 8000 : 4000)
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((item) => item.id !== id) })
  },

  setQueueOpen(open) {
    set({ queueOpen: open })
  },
}))

/** Дебаунс перезагрузки медиатеки — вызывается из обработчика SSE. */
export function scheduleLibraryRefresh() {
  if (libraryTimer) clearTimeout(libraryTimer)
  libraryTimer = setTimeout(() => void useStore.getState().refreshLibrary(), 400)
}

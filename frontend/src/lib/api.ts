import type {
  AppSettings,
  BrowseResponse,
  FileInfo,
  GalleryItem,
  Job,
  LibraryResponse,
  Preset,
  FilmstripInfo,
  ResolvedLink,
  SystemStatus,
  Waveform,
} from './types'

/** Ошибка запроса с человекочитаемым текстом от бэкенда. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (!response.ok) {
    let detail = `Ошибка ${response.status}`
    try {
      const body = await response.json()
      detail = body?.detail ?? detail
      if (Array.isArray(detail)) {
        // Pydantic отдаёт список ошибок валидации — склеиваем в одну строку.
        detail = detail.map((item: any) => item?.msg ?? String(item)).join('; ')
      }
    } catch {
      /* тело может быть пустым — оставляем код статуса */
    }
    throw new ApiError(String(detail), response.status)
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

const post = <T,>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

export const api = {
  status: (refresh = false) => request<SystemStatus>(`/api/status?refresh=${refresh}`),
  presets: () => request<Record<string, Preset[]>>('/api/presets'),
  updateTool: (tool: string) =>
    post<{ ok: boolean; output: string; version: string | null }>(`/api/tools/${tool}/update`),
  installFfmpeg: () => post<Job>('/api/tools/ffmpeg/install'),
  clearThumbnails: () => post<{ removed: number }>('/api/cache/thumbnails/clear'),
  toolUpdates: (refresh = false) =>
    request<Record<string, { current: string | null; latest: string | null; state: string }>>(
      `/api/tools/updates?refresh=${refresh}`,
    ),

  settings: () => request<AppSettings>('/api/settings'),
  patchSettings: (patch: Record<string, unknown>) =>
    request<AppSettings>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  addWorkspace: (path: string) => post<AppSettings>('/api/settings/workspaces/add', { path }),
  removeWorkspace: (path: string) => post<AppSettings>('/api/settings/workspaces/remove', { path }),
  browse: (path?: string | null) =>
    request<BrowseResponse>(`/api/settings/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  pickFolder: () => post<{ supported: boolean; path: string | null }>('/api/settings/pick-folder'),
  reveal: (path: string) => post<{ ok: boolean }>('/api/settings/reveal', { path }),

  library: (params: { root?: string; kind?: string; search?: string; recursive?: boolean }) => {
    const query = new URLSearchParams()
    if (params.root) query.set('root', params.root)
    if (params.kind) query.set('kind', params.kind)
    if (params.search) query.set('search', params.search)
    if (params.recursive === false) query.set('recursive', 'false')
    return request<LibraryResponse>(`/api/library?${query.toString()}`)
  },
  fileInfo: (path: string) => request<FileInfo>(`/api/library/info?path=${encodeURIComponent(path)}`),
  waveform: (path: string) =>
    request<Waveform>(`/api/library/waveform?path=${encodeURIComponent(path)}`),
  filmstrip: (path: string) =>
    request<FilmstripInfo>(`/api/library/filmstrip?path=${encodeURIComponent(path)}`),
  deleteFile: (path: string) => post<{ ok: boolean }>('/api/library/delete', { path }),
  renameFile: (path: string, newName: string) =>
    post<{ ok: boolean; path: string }>('/api/library/rename', { path, new_name: newName }),

  jobs: () => request<{ jobs: Job[]; active: number }>('/api/jobs'),
  job: (id: string) => request<Job>(`/api/jobs/${id}`),
  cancelJob: (id: string) => post<{ ok: boolean }>(`/api/jobs/${id}/cancel`),
  clearJobs: () => post<{ removed: number }>('/api/jobs/clear'),

  export: (payload: unknown) => post<Job>('/api/export', payload),
  exportFrame: (payload: unknown) => post<Job>('/api/export/frame', payload),
  exportRaw: (command: string, source?: string) =>
    post<Job>('/api/export/raw', { command, source }),
  exportBatch: (items: unknown[]) =>
    post<{ jobs: Job[]; errors: { source: string; error: string }[] }>('/api/export/batch', { items }),
  imagePreview: (payload: unknown) =>
    post<{ url: string; size: number; width: number; height: number }>(
      '/api/media/image-preview',
      payload,
    ),

  exportPreview: (payload: unknown) =>
    post<{ summary: string; command: string | null; output?: string }>('/api/export/preview', payload),
  exportPreset: (presetId: string, sources: string[], overrides?: Record<string, unknown>) =>
    post<{ jobs: Job[]; skipped: { source: string; reason: string }[] }>(
      `/api/export/preset/${presetId}`,
      { sources, overrides },
    ),

  download: (payload: unknown) =>
    post<{ jobs: Job[]; errors: { url: string; error: string }[] }>('/api/download', payload),
  probeLink: (url: string) => post<Record<string, any>>('/api/download/probe', { url }),
  resolveLink: (url: string) => post<ResolvedLink>('/api/download/resolve', { url }),
  probeGallery: (url: string) =>
    post<{ url: string; host: string; items: GalleryItem[]; count: number }>('/api/download/gallery', {
      url,
    }),
}

/** URL для тега <video>/<audio>/<img>. */
export const mediaUrl = (path: string) => `/api/media/raw?path=${encodeURIComponent(path)}`

/** URL миниатюры файла. */
export const thumbUrl = (path: string) => `/api/library/thumbnail?path=${encodeURIComponent(path)}`

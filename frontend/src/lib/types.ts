export type MediaKind = 'video' | 'audio' | 'image' | 'other'
export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled'

export interface LibraryFile {
  path: string
  name: string
  kind: MediaKind
  size: number
  modified: number
  ext: string
  relative: string
  folder: string
  playable: boolean
}

export interface LibraryFolder {
  name: string
  path: string
  count: number
}

export interface LibraryResponse {
  root: string
  workspace: string
  /** Путь текущей папки относительно рабочей. */
  relative: string
  parent: string | null
  folders: LibraryFolder[]
  exists: boolean
  files: LibraryFile[]
  counts: Record<string, number>
  totalSize: number
}

export interface MediaInfo {
  path: string
  size: number
  duration: number | null
  container: string | null
  bitRate: number | null
  width: number | null
  height: number | null
  fps: number | null
  videoCodec: string | null
  audioCodec: string | null
  audioChannels: number | null
  sampleRate: number | null
  hasAudio: boolean
  hasAlpha: boolean
  pixFmt: string | null
  tags: Record<string, string>
}

export interface FileInfo {
  path: string
  name: string
  kind: MediaKind
  size: number
  modified: number
  ext: string
  playable: boolean
  folder: string
  media: MediaInfo | null
  probeError?: string
}

export interface Job {
  id: string
  kind: 'encode' | 'image' | 'download'
  title: string
  status: JobStatus
  progress: number
  message: string
  source: string | null
  output: string | null
  error: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  meta: Record<string, any>
  log?: string[]
}

export interface Preset {
  id: string
  kind: 'video' | 'audio' | 'image'
  label: string
  hint: string
  accent: string
  available?: boolean
  options: {
    video?: Partial<VideoOptions>
    audio?: Partial<AudioOptions>
    image?: Partial<ImageOptions>
    stream_copy?: boolean
  }
}

export interface VideoOptions {
  codec: string
  crf: number
  speed_preset: string
  max_height: number
  max_fps: number
  tempo: number
  container: 'mp4' | 'webm' | 'mkv' | 'auto'
  use_gpu: boolean
  faststart: boolean
  strip_video: boolean
}

export interface AudioOptions {
  codec: string
  bitrate_kbps: number
  loudnorm: boolean
  loudnorm_i: number
  loudnorm_tp: number
  loudnorm_lra: number
  loudnorm_two_pass: boolean
  fade_in: number
  fade_out: number
  mono: boolean
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface ImageOptions {
  format: 'avif' | 'webp' | 'jpg' | 'png'
  target_kb: number | null
  passes: number
  quality: number
  max_dimension: number
  effort: number
  replace_original: boolean
  /** Закрашиваемые области в пикселях оригинала. */
  boxes: Rect[]
  box_color: string
  /** Кадрирование в пикселях оригинала. */
  crop: Rect | null
}

export interface ToolInfo {
  name: string
  path: string | null
  version: string | null
  available: boolean
  features: Record<string, boolean>
  error: string | null
}

export interface SystemStatus {
  version: string
  python: string
  platform: string
  tools: Record<string, ToolInfo>
  ready: boolean
  capabilities: Record<string, boolean>
  hardware: Record<string, boolean>
  gpuAvailable: boolean
}

export interface AppSettings {
  workspaces: string[]
  active_workspace: string | null
  theme: 'dark' | 'light'
  language: 'ru' | 'en'
  resolvedWorkspace: string
  defaultWorkspace?: string
  download: {
    directory: string | null
    filename_template: string
    force_mp4: boolean
    max_height: number
    cookies_from_browser: string | null
    proxy: string | null
    proxy_enabled: boolean
    embed_metadata: boolean
    download_playlists: boolean
    playlist_limit: number
  }
  export: {
    output_folder: string
    sort_into_folders: boolean
    concurrency: number
    default_video_preset: string
    default_audio_preset: string
    default_image_preset: string
  }
  binaries: {
    ffmpeg: string | null
    ffprobe: string | null
    yt_dlp: string | null
    gallery_dl: string | null
  }
}

export interface GalleryItem {
  index: number
  url: string
  extension: string | null
  width: number | null
  height: number | null
  filename: string | null
  author: string | null
  description: string | null
}

export interface BrowseResponse {
  path: string | null
  parent: string | null
  drives: string[]
  entries: { name: string; path: string }[]
}

export interface Waveform {
  peaks: number[]
  duration: number
  buckets?: number
  hasAudio: boolean
}

export interface FilmstripInfo {
  url: string
  frames: number
  tileWidth: number
  tileHeight: number
}

export interface ResolvedLink {
  url: string
  title: string
  uploader: string | null
  duration: number | null
  thumbnail: string | null
  extractor: string | null
  previewToken: string | null
  previewHeight: number | null
  previewNote: string | null
}

export interface DownloadItemInput {
  url: string
  start?: number | null
  end?: number | null
}

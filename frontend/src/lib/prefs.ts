/**
 * Настройки, которые человек выставляет под себя, а не под конкретный файл.
 *
 * Панели экспорта пересоздаются при каждой смене файла, поэтому без общего
 * хранилища галочки сбрасывались бы к умолчанию — и «на видеокарте» или
 * «без подпапки» приходилось бы включать заново для каждого ролика.
 */

const PREFS_KEY = 'sgh.exportPrefs'

export interface Prefs {
  use_gpu?: boolean
  max_height?: number
  loudnorm?: boolean
  mono?: boolean
  videoPreset?: string
  audioPreset?: string
  /** Настройки сжатия картинок: формат, качество, предел размера. */
  image?: { format?: string; quality?: number; max_dimension?: number }
  /** Убирать оригинал в корзину после сжатия картинки. */
  imageReplace?: boolean
  /** То же для видео и звука. */
  mediaReplace?: boolean
  /** Показывать живое превью сжатия. */
  imagePreview?: boolean
  /** Складывать результат в подпапку рядом с оригиналом. */
  subfolder?: boolean
}

export function loadPrefs(): Prefs {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') as Prefs
  } catch {
    return {}
  }
}

export function savePrefs(patch: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch }))
  } catch {
    // Приватный режим браузера — тогда просто не запомним.
  }
}

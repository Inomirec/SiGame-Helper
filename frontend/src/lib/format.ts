/** Форматирование чисел и времени для интерфейса. */

const UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']

export function humanSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} Б`
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${UNITS[unit]}`
}

/** Секунды -> `M:SS` или `H:MM:SS`, с сотыми, если нужна точность. */
export function timecode(seconds: number | null | undefined, precise = false): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '--:--'
  const total = Math.max(0, seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = Math.floor(total % 60)
  const hundredths = Math.floor((total % 1) * 100)

  const core = hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`
  return precise ? `${core}.${String(hundredths).padStart(2, '0')}` : core
}

export function humanDuration(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return '—'
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} с`
  return timecode(seconds)
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

/** «Сжато на 87%» — понятнее, чем голое соотношение размеров. */
export function savings(before?: number, after?: number): string | null {
  if (!before || !after) return null
  const delta = 1 - after / before
  if (delta <= 0) return `выросло на ${Math.round(-delta * 100)}%`
  // «−100%» читается так, будто файл исчез, — округляем вниз до 99.
  return `−${Math.min(Math.round(delta * 100), 99)}%`
}

/**
 * Во сколько раз файл стал легче: «в 6.7 раза».
 *
 * Процент отвечает на вопрос «сколько веса ушло», а кратность — «насколько
 * меньше стал файл». Второе понятнее, когда прикидываешь, сколько таких
 * влезет в пак, поэтому показываем оба.
 */
export function shrinkRatio(before?: number, after?: number): string | null {
  if (!before || !after || after >= before) return null
  const times = before / after
  return `в ${times < 10 ? times.toFixed(1) : Math.round(times)} раза меньше`
}

export function fileStem(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function parentDir(path: string): string {
  const parts = path.split(/[\\/]/)
  parts.pop()
  return parts.join('\\')
}

/** Относительное время: «2 мин назад». */
export function ago(timestamp: number): string {
  const delta = Date.now() / 1000 - timestamp
  if (delta < 60) return 'только что'
  if (delta < 3600) return `${Math.floor(delta / 60)} мин назад`
  if (delta < 86400) return `${Math.floor(delta / 3600)} ч назад`
  return `${Math.floor(delta / 86400)} дн назад`
}

/** Склонение существительных: 1 файл, 2 файла, 5 файлов. */
export function plural(count: number, forms: [string, string, string]): string {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return forms[0]
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1]
  return forms[2]
}

/**
 * Короткая подпись версии ffmpeg.
 *
 * Разные сборки называют себя по-разному: у gyan это
 * «2026-04-30-git-cc3ca17127-full_build», у BtbN — «N-126416-g9997fd0606-20260905».
 * Общее у них одно — дата сборки, её и показываем.
 */
export function shortVersion(version?: string | null): string {
  if (!version) return ''
  const date = version.match(/(20\d{2})-?(\d{2})-?(\d{2})/)
  if (date) return `${date[1]}-${date[2]}-${date[3]}`
  return version.split('-').slice(0, 2).join('-')
}

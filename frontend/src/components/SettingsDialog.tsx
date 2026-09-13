import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, RefreshCw, Trash2, XCircle } from 'lucide-react'
import { api } from '../lib/api'
import type { ToolInfo } from '../lib/types'
import { useStore } from '../store'
import { Button, Modal, NumberField, Section, Segmented, Select, Spinner, Toggle } from './ui'

/** Инструменты, которые протухают и требуют обновления. */
const UPDATABLE = new Set(['yt-dlp', 'gallery-dl'])

type UpdateInfo = { current: string | null; latest: string | null; state: string }

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useStore((state) => state.settings)
  const status = useStore((state) => state.status)
  const toast = useStore((state) => state.toast)
  const refreshSettings = useStore((state) => state.refreshSettings)
  const refreshStatus = useStore((state) => state.refreshStatus)
  const refreshLibrary = useStore((state) => state.refreshLibrary)

  const [updating, setUpdating] = useState<string | null>(null)
  const [versions, setVersions] = useState<Record<string, UpdateInfo>>({})
  const [checking, setChecking] = useState(false)

  // Спрашиваем PyPI только когда окно настроек открыли — не на каждом запуске.
  useEffect(() => {
    if (!open) return
    setChecking(true)
    api
      .toolUpdates()
      .then(setVersions)
      .catch(() => setVersions({}))
      .finally(() => setChecking(false))
  }, [open])

  if (!settings) return null

  async function patch(value: Record<string, unknown>) {
    try {
      await api.patchSettings(value)
      await refreshSettings()
      void refreshLibrary()
    } catch (error) {
      toast((error as Error).message, 'error')
    }
  }

  /** Перепроверяет инструменты и версии, а результат озвучивает. */
  async function recheck() {
    setChecking(true)
    try {
      await refreshStatus()
      const fresh = await api.toolUpdates(true)
      setVersions(fresh)

      const outdated = Object.entries(fresh)
        .filter(([, info]) => info.state === 'outdated')
        .map(([name]) => name)
      if (outdated.length) {
        toast(`Есть обновление: ${outdated.join(', ')}`, 'info')
      } else {
        toast('Все инструменты на месте и актуальны', 'ok')
      }
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setChecking(false)
    }
  }

  async function upgrade(tool: string) {
    setUpdating(tool)
    try {
      const result = await api.updateTool(tool)
      toast(
        result.ok ? `${tool} обновлён до ${result.version}` : 'Обновление не удалось',
        result.ok ? 'ok' : 'error',
      )
      await refreshStatus()
      setVersions(await api.toolUpdates(true))
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setUpdating(null)
    }
  }

  return (
    <>
      <Modal open={open} onClose={onClose} title="Настройки" wide>
        <div className="grid gap-7 md:grid-cols-2">
          <div className="space-y-7">
            <Section title="Инструменты">
              <div className="space-y-1.5">
                {Object.entries(status?.tools ?? {}).map(([name, tool]) => (
                  <ToolRow
                    key={name}
                    tool={tool}
                    update={versions[name]}
                    checking={checking && UPDATABLE.has(name)}
                    updating={updating === name}
                    onUpdate={UPDATABLE.has(name) ? () => void upgrade(name) : undefined}
                  />
                ))}
              </div>
              <p className="text-[11px] leading-snug text-ink-faint">
                Сайты постоянно меняются и ломают загрузчики, поэтому у yt-dlp и gallery-dl
                проверяется свежесть. ffmpeg и Deno от сайтов не зависят — их обновлять
                не нужно.
              </p>
              <Button onClick={() => void recheck()} disabled={checking} className="w-full">
                {checking ? <Spinner size={13} /> : <RefreshCw size={13} />}
                Проверить обновления
              </Button>
            </Section>

            <Section title="Обработка">
              <NumberField
                label="Задач одновременно"
                value={settings.export.concurrency}
                min={1}
                max={8}
                suffix="шт."
                onChange={(value) => void patch({ export: { concurrency: value } })}
                hint="Больше — быстрее пакет, но компьютер сильнее занят. Вступит в силу после перезапуска."
              />
              <div>
                <span className="label">Папка для результатов</span>
                <input
                  className="field font-mono text-[12px]"
                  value={settings.export.output_folder}
                  onChange={(event) => void patch({ export: { output_folder: event.target.value } })}
                />
                <p className="mt-1 text-[11px] text-ink-faint">
                  Создаётся рядом с исходником. Оригиналы никогда не перезаписываются, кроме
                  случая, когда это включено вручную для картинок.
                </p>
              </div>
              <Button
                onClick={async () => {
                  const result = await api.clearThumbnails()
                  toast(`Удалено превью: ${result.removed}`, 'ok')
                }}
                className="w-full"
              >
                <Trash2 size={13} />
                Очистить кэш превью
              </Button>
            </Section>
          </div>

          <div className="space-y-7">
            <Section title="Загрузка">
              <p className="text-[11px] leading-snug text-ink-faint">
                Настройки под конкретную ссылку — формат, качество, MP4,
                плейлисты — живут на самой вкладке «Загрузка».
              </p>

              <CookiesField />

              <Toggle
                checked={settings.download.proxy_enabled}
                onChange={(value) => void patch({ download: { proxy_enabled: value } })}
                label="Качать через прокси"
                hint="Адрес сохраняется, даже когда переключатель выключен — стирать его не нужно."
              />
              <input
                className="field font-mono text-[12px]"
                value={settings.download.proxy ?? ''}
                placeholder="Пример: socks5://127.0.0.1:1080"
                disabled={!settings.download.proxy_enabled}
                onChange={(event) => void patch({ download: { proxy: event.target.value || null } })}
              />
            </Section>

          </div>
        </div>
      </Modal>

    </>
  )
}

function ToolRow({
  tool,
  update,
  checking,
  updating,
  onUpdate,
}: {
  tool: ToolInfo
  update?: UpdateInfo
  checking: boolean
  updating: boolean
  onUpdate?: () => void
}) {
  const outdated = update?.state === 'outdated'

  let note: string
  if (!tool.available) note = tool.error ?? 'не найден'
  else if (!onUpdate) note = tool.version ?? ''
  else if (checking) note = `${tool.version} · проверяю свежесть…`
  else if (outdated) note = `${tool.version} → доступна ${update?.latest}`
  else if (update?.state === 'current') note = `${tool.version} · актуальная версия`
  else note = tool.version ?? ''

  return (
    <div className="flex items-center gap-2.5 rounded-lg bg-surface-2 px-3 py-2">
      {tool.available ? (
        <CheckCircle2 size={14} className={`shrink-0 ${outdated ? 'text-warn' : 'text-ok'}`} />
      ) : (
        <XCircle size={14} className="shrink-0 text-danger" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-medium">{tool.name}</p>
        <p
          className={`truncate text-[10.5px] ${outdated ? 'text-warn' : 'text-ink-faint'}`}
          title={tool.path ?? tool.error ?? ''}
        >
          {note}
        </p>
      </div>
      {/* Кнопка появляется только когда обновляться действительно есть куда. */}
      {onUpdate && (outdated || !tool.available) && (
        <button
          type="button"
          onClick={onUpdate}
          disabled={updating}
          className="shrink-0 rounded-lg bg-accent/20 px-2 py-1 text-[11px] text-accent-soft hover:bg-accent/30 disabled:opacity-40"
        >
          {updating ? <Spinner size={11} /> : 'Обновить'}
        </button>
      )}
    </div>
  )
}


/**
 * Доступ к сайтам, которые не отдают файлы кому попало.
 *
 * Слово «куки» человеку знакомо только по всплывашкам «сайт использует
 * cookie», поэтому объясняем не термин, а причину: сайты научились отличать
 * браузер от программы и требуют доказательства, что запрос от вошедшего
 * пользователя. Способа два — прочитать Firefox или взять файл, и они
 * разведены переключателем, а не свалены в один список.
 */
function CookiesField() {
  const settings = useStore((state) => state.settings)
  const refreshSettings = useStore((state) => state.refreshSettings)
  const toast = useStore((state) => state.toast)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  if (!settings) return null
  const file = settings.download.cookies_file
  const browser = settings.download.cookies_from_browser
  const mode: 'off' | 'firefox' | 'file' = file ? 'file' : browser ? 'firefox' : 'off'

  async function choose(next: 'off' | 'firefox' | 'file') {
    if (next === 'file') {
      inputRef.current?.click()
      return
    }
    setBusy(true)
    try {
      if (file) await api.clearCookies()
      await api.patchSettings({
        download: { cookies_from_browser: next === 'firefox' ? 'firefox' : null },
      })
      await refreshSettings()
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function upload(chosen: File) {
    setBusy(true)
    try {
      const result = await api.uploadCookies(chosen)
      await refreshSettings()
      toast(`Файл принят (${Math.round(result.size / 1024)} КБ)`, 'ok')
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div>
      <span className="label">Доступ к сайтам</span>
      <p className="mb-2 text-[11px] leading-snug text-ink-faint">
        YouTube и другие крупные сайты давно не отдают файлы кому попало: они
        проверяют, что запрос идёт из настоящего браузера, где кто-то вошёл в
        аккаунт. Без такого подтверждения часть роликов не скачается вовсе, а
        возрастные и закрытые — тем более. Подтверждение и есть те самые «куки».
      </p>

      <Segmented<'off' | 'firefox' | 'file'>
        value={mode}
        onChange={(value) => void choose(value)}
        options={[
          { value: 'off', label: 'Не нужно', title: 'Пока всё качается — можно не трогать' },
          { value: 'firefox', label: 'Из Firefox', title: 'Программа сама прочитает ваш Firefox' },
          { value: 'file', label: 'Файлом', title: 'Подходит любому браузеру' },
        ]}
      />

      {mode === 'file' && (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-ok/10 px-3 py-2 text-[12px] text-ink-dim ring-1 ring-ok/25">
          <CheckCircle2 size={14} className="shrink-0 text-ok" />
          <span className="min-w-0 flex-1">Файл загружен и используется</span>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="shrink-0 text-ink-faint hover:text-ink disabled:opacity-40"
          >
            Заменить
          </button>
        </div>
      )}

      {mode === 'firefox' && (
        <p className="mt-2 text-[11px] leading-snug text-ink-faint">
          Firefox должен быть установлен, и в нём нужно быть авторизованным.
          Chrome, Edge, Opera и Vivaldi так прочитать нельзя — они шифруют своё
          хранилище. Для них выберите «Файлом».
        </p>
      )}

      <input
        ref={inputRef}
        type="file"
        accept=".txt,text/plain"
        className="hidden"
        onChange={(event) => {
          const chosen = event.target.files?.[0]
          if (chosen) void upload(chosen)
        }}
      />

      <details className="mt-2 text-[11px] leading-snug text-ink-faint" open={mode === 'file' && !file}>
        <summary className="cursor-pointer select-none hover:text-ink-dim">
          Как получить файл
        </summary>
        <ol className="mt-1.5 list-decimal space-y-1.5 pl-4">
          <li>
            Поставьте расширение{' '}
            <button
              type="button"
              onClick={() => void api.openLink('cookies-extension-chrome')}
              className="text-accent-soft underline decoration-dotted underline-offset-2 hover:text-accent"
            >
              Get cookies.txt LOCALLY
            </button>{' '}
            — откроется его страница в магазине Chrome (подойдёт также для Edge,
            Opera и Vivaldi). Для{' '}
            <button
              type="button"
              onClick={() => void api.openLink('cookies-extension-firefox')}
              className="text-accent-soft underline decoration-dotted underline-offset-2 hover:text-accent"
            >
              Firefox
            </button>{' '}
            есть своя версия.
          </li>
          <li>
            Убедитесь, что вы вошли в аккаунт на тех сайтах, откуда собираетесь
            скачивать. Файл сохранит подтверждения сразу для всех открытых вами
            сайтов — отдельный файл под каждый не нужен.
          </li>
          <li>
            Нажмите значок расширения и кнопку <span className="text-ink-dim">Export</span> —
            сохранится <span className="font-mono text-ink-dim">cookies.txt</span>.
          </li>
          <li>Вернитесь сюда, нажмите «Файлом» и выберите этот файл.</li>
        </ol>
        <p className="mt-1.5">
          Файл лежит только на вашем компьютере и никуда не отправляется. Если
          вы вышли из аккаунта или сменили пароль, выгрузите его заново.
        </p>
      </details>
    </div>
  )
}

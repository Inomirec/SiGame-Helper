import { useEffect, useState } from 'react'
import { CheckCircle2, FolderOpen, RefreshCw, Trash2, XCircle } from 'lucide-react'
import { api } from '../lib/api'
import type { ToolInfo } from '../lib/types'
import { useStore } from '../store'
import { Button, Modal, NumberField, Section, Select, Spinner, Toggle } from './ui'
import { FolderPicker } from './FolderPicker'

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

  const [picking, setPicking] = useState<'download' | null>(null)
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
              <Toggle
                checked={settings.export.sort_into_folders}
                onChange={(value) => void patch({ export: { sort_into_folders: value } })}
                label="Раскладывать по папкам"
                hint="Скачанное и обработанное само разложится по «Видео», «Аудио» и «Картинки»."
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
              <div>
                <span className="label">Папка для скачанного</span>
                <div className="flex gap-2">
                  <input
                    className="field font-mono text-[12px]"
                    value={settings.download.directory ?? ''}
                    placeholder="по умолчанию: _downloads в рабочей папке"
                    onChange={(event) =>
                      void patch({ download: { directory: event.target.value || null } })
                    }
                  />
                  <Button onClick={() => setPicking('download')}>
                    <FolderOpen size={14} />
                  </Button>
                </div>
              </div>

              <Toggle
                checked={settings.download.force_mp4}
                onChange={(value) => void patch({ download: { force_mp4: value } })}
                label="Всегда приводить видео к MP4"
                hint="Гарантирует, что файл откроется во встроенном плеере со звуком."
              />
              <Toggle
                checked={settings.download.embed_metadata}
                onChange={(value) => void patch({ download: { embed_metadata: value } })}
                label="Встраивать метаданные и обложку"
              />
              <Toggle
                checked={settings.download.download_playlists}
                onChange={(value) => void patch({ download: { download_playlists: value } })}
                label="Скачивать плейлисты целиком"
                hint="По умолчанию из ссылки на плейлист берётся только одно видео."
              />
              {settings.download.download_playlists && (
                <NumberField
                  label="Не больше элементов плейлиста"
                  value={settings.download.playlist_limit}
                  min={0}
                  max={500}
                  suffix="шт."
                  onChange={(value) => void patch({ download: { playlist_limit: value } })}
                />
              )}

              <Select
                label="Брать куки из браузера"
                value={settings.download.cookies_from_browser ?? ''}
                onChange={(value) =>
                  void patch({ download: { cookies_from_browser: value || null } })
                }
                options={[
                  { value: '', label: 'Не использовать' },
                  { value: 'firefox', label: 'Firefox' },
                ]}
                hint="Нужно для приватных, возрастных и закрытых постов, а также для YouTube. Остальные браузеры в списке нет не по недосмотру: Chrome, Edge, Vivaldi и Opera шифруют свои куки так, что прочитать их снаружи нельзя."
              />
            </Section>

            <Section title="Прокси">
              <Toggle
                checked={settings.download.proxy_enabled}
                onChange={(value) => void patch({ download: { proxy_enabled: value } })}
                label="Качать через прокси"
                hint="Адрес сохраняется, даже когда переключатель выключен — стирать его не нужно."
              />
              <input
                className="field font-mono text-[12px]"
                value={settings.download.proxy ?? ''}
                placeholder="socks5://127.0.0.1:1080"
                disabled={!settings.download.proxy_enabled}
                onChange={(event) => void patch({ download: { proxy: event.target.value || null } })}
              />
            </Section>

            <Section title="Имена скачанных файлов">
              <input
                className="field font-mono text-[11.5px]"
                value={settings.download.filename_template}
                onChange={(event) =>
                  void patch({ download: { filename_template: event.target.value } })
                }
              />
              <p className="text-[11px] text-ink-faint">
                Синтаксис yt-dlp. По умолчанию: название и идентификатор ролика.
              </p>
            </Section>
          </div>
        </div>
      </Modal>

      <FolderPicker
        open={picking === 'download'}
        onClose={() => setPicking(null)}
        title="Папка для скачанного"
        onPick={(path) => void patch({ download: { directory: path } })}
      />
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

import { useEffect, useState } from 'react'
import { ChevronRight, CornerLeftUp, Folder, FolderSearch, HardDrive } from 'lucide-react'
import { api } from '../lib/api'
import type { BrowseResponse } from '../lib/types'
import { Button, Modal, Spinner } from './ui'

/**
 * Выбор папки. В оконном режиме сначала пробуем нативный диалог Windows,
 * а в браузере (где его нет) показываем собственный обозреватель.
 */
export function FolderPicker({
  open,
  onClose,
  onPick,
  title = 'Выбор папки',
}: {
  open: boolean
  onClose: () => void
  onPick: (path: string) => void
  title?: string
}) {
  const [data, setData] = useState<BrowseResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [manual, setManual] = useState('')

  useEffect(() => {
    if (open) void load(null)
  }, [open])

  async function load(path: string | null) {
    setLoading(true)
    try {
      const result = await api.browse(path)
      setData(result)
      setManual(result.path ?? '')
    } finally {
      setLoading(false)
    }
  }

  async function tryNative() {
    const result = await api.pickFolder()
    if (result.supported && result.path) {
      onPick(result.path)
      onClose()
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="space-y-3">
        <div className="flex gap-2">
          <input
            className="field font-mono text-[12px]"
            value={manual}
            placeholder="Или вставьте путь целиком: D:\Паки\Мой пак"
            onChange={(event) => setManual(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && manual.trim()) {
                onPick(manual.trim())
                onClose()
              }
            }}
          />
          <Button
            onClick={() => void tryNative()}
            title="Открыть привычное окно выбора папки Windows"
            className="shrink-0 whitespace-nowrap"
          >
            <FolderSearch size={14} />
            Открыть проводник
          </Button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {data?.drives.map((drive) => (
            <button
              key={drive}
              type="button"
              onClick={() => void load(drive)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[12px] hover:bg-surface-3"
            >
              <HardDrive size={12} className="text-ink-faint" />
              {drive}
            </button>
          ))}
        </div>

        <div className="rounded-xl border border-line-soft bg-surface-2">
          <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-dim">
              {data?.path ?? 'Быстрый доступ'}
            </span>
            {loading && <Spinner size={13} />}
          </div>

          <ul className="max-h-[280px] overflow-y-auto p-1.5">
            {/* «Назад» первой строкой списка — как в обычном проводнике */}
            {data?.parent && (
              <li>
                <button
                  type="button"
                  onClick={() => void load(data.parent)}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] hover:bg-surface-3"
                >
                  <CornerLeftUp size={14} className="shrink-0 text-ink-faint" />
                  <span className="text-ink-dim">Назад</span>
                </button>
              </li>
            )}
            {data?.entries.length === 0 && !data?.parent && (
              <li className="px-3 py-6 text-center text-[12px] text-ink-faint">
                Вложенных папок нет
              </li>
            )}
            {data?.entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  onDoubleClick={() => void load(entry.path)}
                  onClick={() => void load(entry.path)}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] hover:bg-surface-3"
                >
                  <Folder size={14} className="shrink-0 text-accent-soft/70" />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  <ChevronRight size={13} className="shrink-0 text-ink-faint" />
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex gap-2">
          <Button
            tone="primary"
            className="flex-1"
            disabled={!manual.trim()}
            onClick={() => {
              onPick(manual.trim())
              onClose()
            }}
          >
            Выбрать эту папку
          </Button>
          <Button tone="ghost" onClick={onClose}>
            Отмена
          </Button>
        </div>
      </div>
    </Modal>
  )
}

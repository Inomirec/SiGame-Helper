import { useCallback, useEffect, useState } from 'react'
import { Brush, Crop, Eraser, Eye, Square, Trash2, Undo2 } from 'lucide-react'
import { mediaUrl } from '../lib/api'
import { humanSize } from '../lib/format'
import type { FileInfo, Rect, Stroke } from '../lib/types'
import { RectCanvas, type Selection, type Tool } from './RectCanvas'
import { Segmented } from './ui'

export interface ImageEdit {
  crop: Rect | null
  boxes: Rect[]
  /** Мазки кистью и ластиком — для надписей, которые не влезают в прямоугольник. */
  strokes: Stroke[]
}

export const emptyImageEdit: ImageEdit = { crop: null, boxes: [], strokes: [] }

/**
 * Просмотр и правка изображения.
 *
 * Маски и рамка обрезки — редактируемые объекты: их двигают, растягивают за
 * стороны и углы, удаляют клавишей Delete и откатывают через Ctrl+Z.
 */
export function ImageEditor({
  file,
  edit,
  onEditChange,
}: {
  file: FileInfo
  edit: ImageEdit
  onEditChange: (edit: ImageEdit) => void
}) {
  const [tool, setTool] = useState<Tool>('box')
  const [selection, setSelection] = useState<Selection>(null)
  const [history, setHistory] = useState<ImageEdit[]>([])
  const [brushSize, setBrushSize] = useState(40)

  const media = file.media
  const natural = { width: media?.width ?? 0, height: media?.height ?? 0 }

  useEffect(() => {
    setTool('box')
    setSelection(null)
    setHistory([])
  }, [file.path])

  /** Запоминает текущее состояние, чтобы Ctrl+Z вернул именно его. */
  const commit = useCallback(() => {
    setHistory((current) => [...current.slice(-40), edit])
  }, [edit])

  const undo = useCallback(() => {
    setHistory((current) => {
      if (!current.length) return current
      onEditChange(current[current.length - 1])
      setSelection(null)
      return current.slice(0, -1)
    })
  }, [onEditChange])

  const removeSelected = useCallback(() => {
    if (!selection) return
    commit()
    if (selection.type === 'crop') onEditChange({ ...edit, crop: null })
    else onEditChange({ ...edit, boxes: edit.boxes.filter((_, i) => i !== selection.index) })
    setSelection(null)
  }, [selection, edit, onEditChange, commit])

  // Горячие клавиши работают, пока фокус не в поле ввода.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return

      // code не зависит от раскладки (на русской это «я»), но синтетические
      // события иногда его не проставляют — поэтому проверяем и key.
      const isZ = event.code === 'KeyZ' || event.key?.toLowerCase() === 'z'
      if ((event.ctrlKey || event.metaKey) && isZ) {
        event.preventDefault()
        undo()
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selection) {
          event.preventDefault()
          removeSelected()
        }
      } else if (event.key === 'Escape') {
        setSelection(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, removeSelected, selection])

  const hasEdits = Boolean(edit.crop) || edit.boxes.length > 0

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl bg-[#0e1016] p-4 ring-1 ring-line-soft">
        {/* Шахматка под прозрачными картинками */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.035]"
          style={{
            backgroundImage:
              'linear-gradient(45deg, #fff 25%, transparent 25%), linear-gradient(-45deg, #fff 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #fff 75%), linear-gradient(-45deg, transparent 75%, #fff 75%)',
            backgroundSize: '20px 20px',
            backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0',
          }}
        />

        {/* Обёртка обтягивает картинку, поэтому наложения совпадают с ней точно */}
        <div className="relative">
          <img
            key={file.path}
            src={mediaUrl(file.path)}
            alt={file.name}
            className="block max-w-full select-none object-contain"
            draggable={false}
            style={{ maxHeight: 'calc(100vh - 330px)' }}
          />

          {natural.width > 0 && (
            <RectCanvas
              width={natural.width}
              height={natural.height}
              boxes={edit.boxes}
              crop={edit.crop}
              tool={tool}
              selection={selection}
              onSelect={setSelection}
              strokes={edit.strokes}
              brushSize={brushSize}
              paintColor="#000000"
              onBoxesChange={(boxes) => onEditChange({ ...edit, boxes })}
              onCropChange={(crop) => onEditChange({ ...edit, crop })}
              onStrokesChange={(strokes) => onEditChange({ ...edit, strokes })}
              onCommit={commit}
            />
          )}
        </div>
      </div>

      {/* Инструменты */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-surface px-3 py-2 text-[11px] text-ink-faint ring-1 ring-line-soft">
        <Segmented<Tool>
          className="w-[420px]"
          value={tool}
          onChange={(value) => {
            setTool(value)
            setSelection(null)
          }}
          options={[
            { value: 'box', label: 'Закрасить', title: 'Прямоугольник: бренд, надпись, спойлер' },
            { value: 'brush', label: 'Кисть', title: 'Закрасить от руки — для надписей дугой и наискось' },
            { value: 'eraser', label: 'Ластик', title: 'Стереть лишнее, что закрасили кистью' },
            { value: 'crop', label: 'Обрезать', title: 'Отрезать пустые поля и чёрные края' },
            { value: 'view', label: 'Просмотр', title: 'Ничего не менять, просто смотреть' },
          ]}
        />

        {(tool === 'brush' || tool === 'eraser') && (
          <label className="flex items-center gap-2">
            {tool === 'brush' ? <Brush size={12} /> : <Eraser size={12} />}
            Толщина
            <input
              type="range"
              min={4}
              max={200}
              step={2}
              value={brushSize}
              onChange={(event) => setBrushSize(Number(event.target.value))}
              className="w-24"
            />
            <span className="w-8 font-mono tabular-nums text-ink">{brushSize}</span>
          </label>
        )}

        <button
          type="button"
          onClick={undo}
          disabled={!history.length}
          title="Отменить последнее действие (Ctrl+Z)"
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 transition-colors hover:bg-surface-3 hover:text-ink-dim disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Undo2 size={12} />
          Отменить
        </button>

        <button
          type="button"
          onClick={removeSelected}
          disabled={!selection}
          title="Удалить выделенное (Delete)"
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 transition-colors hover:bg-surface-3 hover:text-danger disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Trash2 size={12} />
          Удалить
        </button>

        {hasEdits && (
          <button
            type="button"
            onClick={() => {
              commit()
              onEditChange(emptyImageEdit)
              setSelection(null)
            }}
            className="rounded-lg px-2 py-1 transition-colors hover:bg-surface-3 hover:text-ink-dim"
          >
            Сбросить всё
          </button>
        )}

        <span className="hidden items-center gap-1.5 2xl:inline-flex">
          {tool === 'box' && (
            <>
              <Square size={11} />
              Протяните прямоугольник поверх надписи. Маску можно двигать и тянуть за края.
            </>
          )}
          {tool === 'crop' && (
            <>
              <Crop size={11} />
              Протяните рамку. Её тоже можно двигать и растягивать.
            </>
          )}
          {tool === 'view' && (
            <>
              <Eye size={11} />
              Правки видно поверх картинки, применятся при экспорте.
            </>
          )}
        </span>

        <span className="ml-auto flex shrink-0 items-center gap-3">
          {edit.boxes.length > 0 && (
            <span className="text-accent-soft">масок: {edit.boxes.length}</span>
          )}
          {edit.crop && (
            <span className="text-accent-soft">
              обрезка {edit.crop.width}×{edit.crop.height}
            </span>
          )}
          <span className="text-ink-dim">{humanSize(file.size)}</span>
          {natural.width > 0 && (
            <span>
              {natural.width}×{natural.height} px
            </span>
          )}
          <span>{file.ext.toUpperCase()}</span>
          {media?.hasAlpha && <span className="text-accent-soft">прозрачность</span>}
        </span>
      </div>
    </div>
  )
}

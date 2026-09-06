import { useCallback, useEffect, useRef, useState } from 'react'
import type { Rect } from '../lib/types'

/** Точки, за которые можно тянуть прямоугольник. */
export type Grip = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move'

export type Selection = { type: 'box'; index: number } | { type: 'crop' } | null

export type Tool = 'view' | 'crop' | 'box'

interface DragState {
  grip: Grip
  target: Selection
  /** Прямоугольник на момент начала перетаскивания. */
  origin: Rect
  startX: number
  startY: number
  /** Создаём новый прямоугольник, а не правим существующий. */
  creating: boolean
}

const GRIPS: { id: Grip; x: number; y: number; cursor: string }[] = [
  { id: 'nw', x: 0, y: 0, cursor: 'nwse-resize' },
  { id: 'n', x: 0.5, y: 0, cursor: 'ns-resize' },
  { id: 'ne', x: 1, y: 0, cursor: 'nesw-resize' },
  { id: 'e', x: 1, y: 0.5, cursor: 'ew-resize' },
  { id: 'se', x: 1, y: 1, cursor: 'nwse-resize' },
  { id: 's', x: 0.5, y: 1, cursor: 'ns-resize' },
  { id: 'sw', x: 0, y: 1, cursor: 'nesw-resize' },
  { id: 'w', x: 0, y: 0.5, cursor: 'ew-resize' },
]

/** Минимальная сторона прямоугольника в пикселях оригинала. */
const MIN_SIZE = 8

function clampRect(rect: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.min(rect.x, width - MIN_SIZE))
  const y = Math.max(0, Math.min(rect.y, height - MIN_SIZE))
  return {
    x,
    y,
    width: Math.max(MIN_SIZE, Math.min(rect.width, width - x)),
    height: Math.max(MIN_SIZE, Math.min(rect.height, height - y)),
  }
}

/** Двигает или растягивает прямоугольник в зависимости от схваченной точки. */
function transform(origin: Rect, grip: Grip, dx: number, dy: number): Rect {
  if (grip === 'move') {
    return { ...origin, x: origin.x + dx, y: origin.y + dy }
  }

  let { x, y, width, height } = origin
  if (grip.includes('w')) {
    x = origin.x + dx
    width = origin.width - dx
  }
  if (grip.includes('e')) {
    width = origin.width + dx
  }
  if (grip.includes('n')) {
    y = origin.y + dy
    height = origin.height - dy
  }
  if (grip.includes('s')) {
    height = origin.height + dy
  }

  // Протянули за противоположную сторону — прямоугольник переворачивается.
  if (width < 0) {
    x += width
    width = -width
  }
  if (height < 0) {
    y += height
    height = -height
  }
  return { x, y, width, height }
}

/**
 * Слой поверх картинки, на котором живут маски закраски и рамка обрезки.
 *
 * Прямоугольники здесь — полноценные объекты: их можно выбрать, подвинуть,
 * растянуть за любую сторону или угол и удалить. Всё в координатах оригинала,
 * поэтому правки не зависят от того, как сильно картинка ужата на экране.
 */
export function RectCanvas({
  width,
  height,
  boxes,
  crop,
  tool,
  selection,
  onSelect,
  onBoxesChange,
  onCropChange,
  onCommit,
}: {
  width: number
  height: number
  boxes: Rect[]
  crop: Rect | null
  tool: Tool
  selection: Selection
  onSelect: (selection: Selection) => void
  onBoxesChange: (boxes: Rect[]) => void
  onCropChange: (crop: Rect | null) => void
  /** Вызывается перед каждым изменением — родитель кладёт состояние в историю. */
  onCommit: () => void
}) {
  const shellRef = useRef<HTMLDivElement>(null)
  // Состояние перетаскивания держим в ref: обработчики на window иначе видят
  // снимок из прошлого рендера и считают размеры по устаревшим данным.
  const dragRef = useRef<DragState | null>(null)
  const draftRef = useRef<Rect | null>(null)
  const [draft, setDraft] = useState<Rect | null>(null)
  const [dragging, setDragging] = useState(false)

  const toImage = useCallback(
    (clientX: number, clientY: number) => {
      const shell = shellRef.current
      const rect = shell?.getBoundingClientRect()
      if (!rect || !rect.width || !rect.height || !width || !height) return null
      return {
        x: ((clientX - rect.left) / rect.width) * width,
        y: ((clientY - rect.top) / rect.height) * height,
      }
    },
    [width, height],
  )

  const asStyle = (rect: Rect) => ({
    left: `${(rect.x / width) * 100}%`,
    top: `${(rect.y / height) * 100}%`,
    width: `${(rect.width / width) * 100}%`,
    height: `${(rect.height / height) * 100}%`,
  })

  const begin = (
    event: React.PointerEvent,
    state: Omit<DragState, 'startX' | 'startY'>,
  ) => {
    event.stopPropagation()
    const point = toImage(event.clientX, event.clientY)
    if (!point) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { ...state, startX: point.x, startY: point.y }
    draftRef.current = null
    setDraft(null)
    setDragging(true)
  }

  // Перетаскивание слушаем на окне: курсор часто уезжает за пределы картинки.
  useEffect(() => {
    if (!dragging) return

    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current
      const point = toImage(event.clientX, event.clientY)
      if (!drag || !point) return

      if (drag.creating) {
        const rect = clampRect(
          {
            x: Math.min(drag.startX, point.x),
            y: Math.min(drag.startY, point.y),
            width: Math.abs(point.x - drag.startX),
            height: Math.abs(point.y - drag.startY),
          },
          width,
          height,
        )
        draftRef.current = rect
        setDraft(rect)
        return
      }

      const moved = transform(drag.origin, drag.grip, point.x - drag.startX, point.y - drag.startY)
      const next = clampRect(moved, width, height)
      const rounded: Rect = {
        x: Math.round(next.x),
        y: Math.round(next.y),
        width: Math.round(next.width),
        height: Math.round(next.height),
      }
      if (drag.target?.type === 'crop') {
        onCropChange(rounded)
      } else if (drag.target?.type === 'box') {
        const index = drag.target.index
        onBoxesChange(boxes.map((item, i) => (i === index ? rounded : item)))
      }
    }

    const onUp = () => {
      const drag = dragRef.current
      const pending = draftRef.current
      if (drag?.creating && pending && pending.width > MIN_SIZE && pending.height > MIN_SIZE) {
        const rect: Rect = {
          x: Math.round(pending.x),
          y: Math.round(pending.y),
          width: Math.round(pending.width),
          height: Math.round(pending.height),
        }
        if (tool === 'crop') {
          onCropChange(rect)
          onSelect({ type: 'crop' })
        } else {
          onBoxesChange([...boxes, rect])
          onSelect({ type: 'box', index: boxes.length })
        }
      }
      dragRef.current = null
      draftRef.current = null
      setDraft(null)
      setDragging(false)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragging, boxes, tool, width, height, toImage, onBoxesChange, onCropChange, onSelect])

  const isSelected = (target: Selection) =>
    Boolean(
      selection &&
        target &&
        selection.type === target.type &&
        (selection.type !== 'box' || selection.index === (target as { index: number }).index),
    )

  return (
    <div
      ref={shellRef}
      className={`absolute inset-0 ${tool === 'view' ? '' : 'cursor-crosshair'}`}
      onPointerDown={(event) => {
        if (tool === 'view') return
        // Клик по пустому месту снимает выделение и начинает новый прямоугольник.
        onSelect(null)
        onCommit()
        begin(event, {
          grip: 'se',
          target: null,
          origin: { x: 0, y: 0, width: 0, height: 0 },
          creating: true,
        })
      }}
    >
      {/* Рамка обрезки: всё вне неё притемнено */}
      {crop && (
        <div
          className={`absolute ${
            isSelected({ type: 'crop' }) ? 'ring-2 ring-accent' : 'ring-2 ring-accent/60'
          } ${tool === 'view' ? '' : 'cursor-move'}`}
          style={{ ...asStyle(crop), boxShadow: '0 0 0 9999px rgba(0,0,0,0.6)' }}
          onPointerDown={(event) => {
            if (tool === 'view') return
            onSelect({ type: 'crop' })
            onCommit()
            begin(event, { grip: 'move', target: { type: 'crop' }, origin: crop, creating: false })
          }}
        >
          <span className="pointer-events-none absolute -top-5 left-0 whitespace-nowrap rounded bg-accent px-1.5 text-[10px] font-medium text-white">
            обрезка {crop.width}×{crop.height}
          </span>
          {isSelected({ type: 'crop' }) &&
            tool !== 'view' &&
            GRIPS.map((grip) => (
              <GripDot
                key={grip.id}
                grip={grip}
                onPointerDown={(event) => {
                  onCommit()
                  begin(event, {
                    grip: grip.id,
                    target: { type: 'crop' },
                    origin: crop,
                    creating: false,
                  })
                }}
              />
            ))}
        </div>
      )}

      {/* Маски закраски */}
      {boxes.map((box, index) => {
        const selected = isSelected({ type: 'box', index })
        return (
          <div
            key={index}
            className={`absolute bg-black ${
              selected ? 'ring-2 ring-accent' : 'ring-1 ring-white/25 hover:ring-white/60'
            } ${tool === 'view' ? '' : 'cursor-move'}`}
            style={asStyle(box)}
            onPointerDown={(event) => {
              if (tool === 'view') return
              onSelect({ type: 'box', index })
              onCommit()
              begin(event, {
                grip: 'move',
                target: { type: 'box', index },
                origin: box,
                creating: false,
              })
            }}
          >
            {selected &&
              tool !== 'view' &&
              GRIPS.map((grip) => (
                <GripDot
                  key={grip.id}
                  grip={grip}
                  onPointerDown={(event) => {
                    onCommit()
                    begin(event, {
                      grip: grip.id,
                      target: { type: 'box', index },
                      origin: box,
                      creating: false,
                    })
                  }}
                />
              ))}
          </div>
        )
      })}

      {/* Прямоугольник, который сейчас рисуют */}
      {draft && (
        <div
          className={`pointer-events-none absolute ${
            tool === 'crop' ? 'ring-2 ring-accent' : 'bg-black/75 ring-1 ring-white/40'
          }`}
          style={asStyle(draft)}
        />
      )}
    </div>
  )
}

function GripDot({
  grip,
  onPointerDown,
}: {
  grip: { id: Grip; x: number; y: number; cursor: string }
  onPointerDown: (event: React.PointerEvent) => void
}) {
  return (
    <span
      className="absolute z-10 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-[2px] border border-base bg-accent"
      style={{
        left: `${grip.x * 100}%`,
        top: `${grip.y * 100}%`,
        cursor: grip.cursor,
      }}
      onPointerDown={onPointerDown}
    />
  )
}

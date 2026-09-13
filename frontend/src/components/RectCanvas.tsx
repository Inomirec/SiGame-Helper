import { useCallback, useEffect, useRef, useState } from 'react'
import type { Rect, Stroke } from '../lib/types'
import { drawStrokes } from '../lib/paint'

/** Точки, за которые можно тянуть прямоугольник. */
export type Grip = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move'

export type Selection = { type: 'box'; index: number } | { type: 'crop' } | null

export type Tool = 'view' | 'crop' | 'box' | 'brush' | 'eraser' | 'pick' | 'select'

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
  strokes,
  brushSize,
  paintColor,
  tool,
  selection,
  onSelect,
  onBoxesChange,
  onCropChange,
  onStrokesChange,
  onCommit,
  onPick,
  onBoxMenu,
  marked,
  onMarquee,
}: {
  width: number
  height: number
  boxes: Rect[]
  crop: Rect | null
  strokes: Stroke[]
  brushSize: number
  paintColor: string
  tool: Tool
  selection: Selection
  onSelect: (selection: Selection) => void
  onBoxesChange: (boxes: Rect[]) => void
  onCropChange: (crop: Rect | null) => void
  onStrokesChange: (strokes: Stroke[]) => void
  /** Вызывается перед каждым изменением — родитель кладёт состояние в историю. */
  onCommit: () => void
  /** Пипетка: отдаёт точку в координатах оригинала. */
  onPick?: (point: { x: number; y: number }) => void
  /** Правая кнопка по маске — родитель показывает меню. */
  onBoxMenu?: (index: number, x: number, y: number) => void
  /** Что сейчас выделено рамкой: номера масок и мазков. */
  marked?: { boxes: number[]; strokes: number[] }
  /** Обвели область — родитель решает, что в неё попало. */
  onMarquee?: (rect: Rect) => void
}) {
  const shellRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Текущий мазок держим в ref: обработчики на window иначе увидят снимок
  // из прошлого рендера и потеряют половину точек.
  const strokeRef = useRef<Stroke | null>(null)
  const [liveStroke, setLiveStroke] = useState<Stroke | null>(null)
  // Состояние перетаскивания держим в ref: обработчики на window иначе видят
  // снимок из прошлого рендера и считают размеры по устаревшим данным.
  const dragRef = useRef<DragState | null>(null)
  const draftRef = useRef<Rect | null>(null)
  const [draft, setDraft] = useState<Rect | null>(null)
  const [dragging, setDragging] = useState(false)
  // Где сейчас курсор — по нему рисуем круг размером с кисть.
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)

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

  // Перерисовываем холст на каждое изменение мазков: их немного, а держать
  // отдельный слой «уже нарисованного» — лишняя сложность на ровном месте.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !width || !height) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, width, height)
    drawStrokes(ctx, liveStroke ? [...strokes, liveStroke] : strokes, paintColor)

    // Выделенные мазки подкрашиваем поверх: иначе непонятно, что именно
    // попало в рамку и что сейчас удалится.
    const chosen = (marked?.strokes ?? [])
      .map((index) => strokes[index])
      .filter((stroke): stroke is Stroke => Boolean(stroke) && !stroke.erase)
    if (chosen.length) {
      ctx.save()
      ctx.globalAlpha = 0.55
      drawStrokes(ctx, chosen.map((stroke) => ({ ...stroke, color: undefined })), '#7c5cff')
      ctx.restore()
    }
  }, [strokes, liveStroke, width, height, paintColor, marked])

  const painting = tool === 'brush' || tool === 'eraser'

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
    // Браузер иначе начинает собственное перетаскивание элемента: курсор
    // становится перечёркнутым, а события мыши уходят ему, и маска
    // перестаёт тянуться.
    event.preventDefault()
    const point = toImage(event.clientX, event.clientY)
    if (!point) return
    // Захват вешаем на общий слой, а не на сам прямоугольник: тот при
    // перерисовке заменяется новым узлом, захват теряется вместе со старым,
    // и половина движений мыши до нас не доходит — тянется «по пикселю».
    const holder = shellRef.current ?? event.currentTarget
    try {
      holder.setPointerCapture(event.pointerId)
    } catch {
      // Указатель мог уже отпуститься — тогда обойдёмся без захвата.
    }
    dragRef.current = { ...state, startX: point.x, startY: point.y }
    draftRef.current = null
    setDraft(null)
    setDragging(true)
  }

  // Перетаскивание слушаем на окне: курсор часто уезжает за пределы картинки.
  useEffect(() => {
    if (!dragging) return

    const onMove = (event: PointerEvent) => {
      const point = toImage(event.clientX, event.clientY)
      const stroke = strokeRef.current
      if (stroke && point) {
        stroke.points.push(point)
        setLiveStroke({ ...stroke, points: [...stroke.points] })
        return
      }

      const drag = dragRef.current
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
        // Цвет берём из исходного прямоугольника: пересобирая его заново,
        // легко потерять всё, кроме координат.
        ...drag.origin,
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
      const stroke = strokeRef.current
      if (stroke) {
        strokeRef.current = null
        setLiveStroke(null)
        setDragging(false)
        if (stroke.points.length) onStrokesChange([...strokes, stroke])
        return
      }

      const drag = dragRef.current
      const pending = draftRef.current
      if (drag?.creating && pending && pending.width > MIN_SIZE && pending.height > MIN_SIZE) {
        const rect: Rect = {
          x: Math.round(pending.x),
          y: Math.round(pending.y),
          width: Math.round(pending.width),
          height: Math.round(pending.height),
        }
        if (tool === 'select') {
          onMarquee?.(rect)
        } else if (tool === 'crop') {
          onCropChange(rect)
          onSelect({ type: 'crop' })
        } else {
          onBoxesChange([...boxes, { ...rect, color: paintColor }])
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
  }, [
    dragging, boxes, strokes, tool, width, height, toImage,
    onBoxesChange, onCropChange, onStrokesChange, onSelect,
  ])

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
      className={`absolute inset-0 select-none ${
        tool === 'view' ? '' : painting ? 'cursor-none' : 'cursor-crosshair'
      }`}
      // Страница не должна уметь начинать перетаскивание сама: именно из-за
      // него появлялся перечёркнутый курсор посреди расстановки масок.
      onDragStart={(event) => event.preventDefault()}
      onPointerMove={(event) => {
        if (!painting) return
        setCursor(toImage(event.clientX, event.clientY))
      }}
      onPointerLeave={() => setCursor(null)}
      onPointerDown={(event) => {
        if (tool === 'view' || event.button !== 0) return
        if (tool === 'select') {
          onSelect(null)
          begin(event, {
            grip: 'se',
            target: null,
            origin: { x: 0, y: 0, width: 0, height: 0 },
            creating: true,
          })
          return
        }
        if (tool === 'pick') {
          const point = toImage(event.clientX, event.clientY)
          if (point) onPick?.(point)
          return
        }
        onSelect(null)
        onCommit()

        if (painting) {
          const point = toImage(event.clientX, event.clientY)
          if (!point) return
          event.currentTarget.setPointerCapture(event.pointerId)
          const stroke: Stroke = {
            points: [point],
            size: brushSize,
            erase: tool === 'eraser',
            color: paintColor,
          }
          strokeRef.current = stroke
          setLiveStroke(stroke)
          setDragging(true)
          return
        }

        // Клик по пустому месту снимает выделение и начинает новый прямоугольник.
        begin(event, {
          grip: 'se',
          target: null,
          origin: { x: 0, y: 0, width: 0, height: 0 },
          creating: true,
        })
      }}
    >
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="pointer-events-none absolute inset-0 h-full w-full"
      />

      {/* Рамка обрезки: всё вне неё притемнено */}
      {crop && (
        <div
          className={`absolute ${
            isSelected({ type: 'crop' }) ? 'outline-accent' : 'outline-accent/60'
          } ${tool === 'view' ? '' : 'cursor-move'}`}
          // Толщину делим на масштаб: иначе при увеличении рамка превращается
          // в жирную полосу и закрывает то, что человек пришёл рассмотреть.
          style={{
            ...asStyle(crop),
            outlineStyle: 'solid',
            outlineWidth: 'calc(2px / var(--z, 1))',
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.6)',
          }}
          onPointerDown={(event) => {
            if (tool === 'view' || event.button !== 0) return
            onSelect({ type: 'crop' })
            onCommit()
            begin(event, { grip: 'move', target: { type: 'crop' }, origin: crop, creating: false })
          }}
        >
          <span
            className="pointer-events-none absolute bottom-full left-0 mb-0.5 origin-bottom-left whitespace-nowrap rounded bg-accent px-1.5 text-[10px] font-medium text-white"
            style={{ transform: 'scale(calc(1 / var(--z, 1)))' }}
          >
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
        const inMarquee = Boolean(marked?.boxes.includes(index))
        return (
          <div
            key={index}
            className={`absolute ${
              selected || inMarquee ? 'outline-accent' : 'outline-white/25 hover:outline-white/60'
            } ${tool === 'view' ? '' : 'cursor-move'}`}
            style={{
              ...asStyle(box),
              background: box.color ?? '#000000',
              outlineStyle: inMarquee ? 'dashed' : 'solid',
              outlineWidth: `calc(${selected || inMarquee ? 2 : 1}px / var(--z, 1))`,
            }}
            onContextMenu={(event) => {
              if (tool === 'view' || !onBoxMenu) return
              event.preventDefault()
              event.stopPropagation()
              onSelect({ type: 'box', index })
              onBoxMenu(index, event.clientX, event.clientY)
            }}
            onPointerDown={(event) => {
              if (tool === 'view' || event.button !== 0) return
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

      {/* Круг под курсором: показывает, какой след оставит кисть. Размеры в
          долях холста — значит при увеличении он растёт вместе с картинкой,
          как и сам мазок. */}
      {painting && cursor && (
        <span
          className="pointer-events-none absolute rounded-full border border-white/80"
          style={{
            left: `${(cursor.x / width) * 100}%`,
            top: `${(cursor.y / height) * 100}%`,
            width: `${(brushSize / width) * 100}%`,
            height: `${(brushSize / height) * 100}%`,
            transform: 'translate(-50%, -50%)',
            borderWidth: 'calc(1px / var(--z, 1))',
            boxShadow: 'inset 0 0 0 calc(1px / var(--z, 1)) rgba(0,0,0,0.55)',
            background: tool === 'eraser' ? 'transparent' : `${paintColor}55`,
          }}
        />
      )}

      {/* Прямоугольник, который сейчас рисуют */}
      {draft && (
        <div
          className={`pointer-events-none absolute ${
            tool === 'crop' || tool === 'select' ? 'outline-accent' : 'outline-white/40'
          }`}
          style={{
            ...asStyle(draft),
            background: tool === 'crop' || tool === 'select' ? undefined : paintColor,
            opacity: tool === 'crop' || tool === 'select' ? undefined : 0.75,
            outlineStyle: tool === 'select' ? 'dashed' : 'solid',
            outlineWidth: `calc(${tool === 'crop' || tool === 'select' ? 2 : 1}px / var(--z, 1))`,
          }}
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
      className="absolute z-10 h-3 w-3 rounded-[2px] border border-base bg-accent"
      // Маркер ужимаем обратно по масштабу: иначе при увеличении он закрывает
      // собой тот угол, за который его и тянут.
      style={{
        left: `${grip.x * 100}%`,
        top: `${grip.y * 100}%`,
        transform: 'translate(-50%, -50%) scale(calc(1 / var(--z, 1)))',
        cursor: grip.cursor,
      }}
      onPointerDown={onPointerDown}
    />
  )
}

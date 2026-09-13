import { useCallback, useEffect, useRef, useState } from 'react'
import { Brush, Crop, Eraser, Eye, Maximize2, Palette, Pipette, Square, Trash2, Undo2 } from 'lucide-react'
import { mediaUrl } from '../lib/api'
import { humanSize } from '../lib/format'
import type { FileInfo, ImagePreview, Rect, Stroke } from '../lib/types'
import { RectCanvas, type Selection, type Tool } from './RectCanvas'
import { Segmented } from './ui'

export interface ImageEdit {
  crop: Rect | null
  boxes: Rect[]
  /** Мазки кистью и ластиком — для надписей, которые не влезают в прямоугольник. */
  strokes: Stroke[]
}

export const emptyImageEdit: ImageEdit = { crop: null, boxes: [], strokes: [] }

/** Ключ запомненного цвета закраски. */
const COLOR_KEY = 'sgh.paintColor'

/**
 * Просмотр и правка изображения.
 *
 * Маски и рамка обрезки — редактируемые объекты: их двигают, растягивают за
 * стороны и углы, удаляют клавишей Delete и откатывают через Ctrl+Z.
 */
export function ImageEditor({
  file,
  edit,
  preview,
  onEditChange,
}: {
  file: FileInfo
  edit: ImageEdit
  /** Просчитанный результат сжатия — то, что покажет кнопка «После». */
  preview?: ImagePreview | null
  onEditChange: (edit: ImageEdit) => void
}) {
  const [showAfter, setShowAfter] = useState(false)
  const [tool, setTool] = useState<Tool>('box')
  const [selection, setSelection] = useState<Selection>(null)
  const [history, setHistory] = useState<ImageEdit[]>([])
  const [brushSize, setBrushSize] = useState(40)
  const [paintColor, setPaintColor] = useState(
    () => localStorage.getItem(COLOR_KEY) || '#000000',
  )
  // Что обвели рамкой выделения: номера масок и мазков.
  const [marked, setMarked] = useState<{ boxes: number[]; strokes: number[] }>({
    boxes: [],
    strokes: [],
  })
  // Меню по правой кнопке над маской.
  const [menu, setMenu] = useState<{ index: number; x: number; y: number } | null>(null)
  const colorInputRef = useRef<HTMLInputElement>(null)

  // Масштаб и сдвиг картинки. Сдвиг — в экранных пикселях: так его проще
  // удержать, когда масштаб меняется прямо под курсором.
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [panning, setPanning] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const spaceRef = useRef(false)
  const panRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  // Обработчик колеса живёт вне React, поэтому текущие значения берём из ссылок.
  const viewRef = useRef({ zoom: 1, pan: { x: 0, y: 0 } })
  viewRef.current = { zoom, pan }

  const media = file.media
  const natural = { width: media?.width ?? 0, height: media?.height ?? 0 }

  const resetView = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  useEffect(() => {
    setTool('box')
    setSelection(null)
    setHistory([])
    resetView()
    setShowAfter(false)
    setMenu(null)
    setMarked({ boxes: [], strokes: [] })
  }, [file.path, resetView])

  const applyColor = useCallback(
    (color: string) => {
      setPaintColor(color)
      localStorage.setItem(COLOR_KEY, color)
    },
    [],
  )

  /** Пипетка: берёт цвет ровно того пикселя, по которому щёлкнули. */
  const pickColor = useCallback(
    (point: { x: number; y: number }) => {
      const image = imageRef.current
      if (!image || !image.naturalWidth) return
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      ctx.drawImage(image, 0, 0)
      const x = Math.max(0, Math.min(Math.round(point.x), canvas.width - 1))
      const y = Math.max(0, Math.min(Math.round(point.y), canvas.height - 1))
      const [r, g, b] = ctx.getImageData(x, y, 1, 1).data
      const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
      applyColor(hex)
      setTool('box')
    },
    [applyColor],
  )

  useEffect(() => {
    if (!preview) setShowAfter(false)
  }, [preview])

  // Ушли с выделения — снимаем его: номера объектов после правок сдвигаются,
  // и «убрать выделенное» удалило бы не то.
  useEffect(() => {
    if (tool !== 'select') setMarked({ boxes: [], strokes: [] })
  }, [tool])

  // Колесо приближает к курсору, а не к центру: иначе нужная деталь уезжает
  // за край ровно в тот момент, когда её пытаешься рассмотреть.
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const box = viewport.getBoundingClientRect()
      // Курсор относительно центра: вокруг него и построено преобразование.
      const mx = event.clientX - (box.left + box.width / 2)
      const my = event.clientY - (box.top + box.height / 2)

      const { zoom: current, pan: offset } = viewRef.current
      const next = Math.min(16, Math.max(1, current * (event.deltaY < 0 ? 1.2 : 1 / 1.2)))
      if (next === current) return
      const ratio = next / current

      setZoom(next)
      setPan(
        next === 1
          ? { x: 0, y: 0 }
          : { x: mx - ratio * (mx - offset.x), y: my - ratio * (my - offset.y) },
      )
    }

    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [])

  // Пробел — временный режим руки: левая кнопка занята кистью и рамками.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (event.code !== 'Space') return
      // Иначе пробел нажмёт кнопку, на которой остался фокус, и прокрутит страницу.
      event.preventDefault()
      spaceRef.current = true
      setSpaceHeld(true)
    }
    const up = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return
      spaceRef.current = false
      setSpaceHeld(false)
    }
    // Переключение окна оставляет пробел «залипшим» — сбрасываем.
    const blur = () => {
      spaceRef.current = false
      setSpaceHeld(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  useEffect(() => {
    if (!panning) return
    const move = (event: PointerEvent) => {
      const start = panRef.current
      if (!start) return
      setPan({ x: start.px + (event.clientX - start.x), y: start.py + (event.clientY - start.y) })
    }
    const stop = () => {
      panRef.current = null
      setPanning(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [panning])

  const startPan = (event: React.PointerEvent) => {
    // Средняя кнопка — всегда рука, левая — только с зажатым пробелом.
    if (event.button !== 1 && !(event.button === 0 && spaceRef.current)) return
    event.preventDefault()
    event.stopPropagation()
    panRef.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y }
    setPanning(true)
  }

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

  /** Собирает всё, что попало в обведённую область. */
  const markArea = useCallback(
    (area: Rect) => {
      const right = area.x + area.width
      const bottom = area.y + area.height
      // Берём то, что хотя бы задевает рамку: требовать попадания целиком
      // неудобно — крупный мазок пришлось бы обводить полностью.
      const boxes = edit.boxes
        .map((box, index) => ({ box, index }))
        .filter(
          ({ box }) =>
            box.x < right &&
            box.x + box.width > area.x &&
            box.y < bottom &&
            box.y + box.height > area.y,
        )
        .map(({ index }) => index)

      const strokes = edit.strokes
        .map((stroke, index) => ({ stroke, index }))
        .filter(({ stroke }) =>
          stroke.points.some(
            (point) =>
              point.x >= area.x && point.x <= right && point.y >= area.y && point.y <= bottom,
          ),
        )
        .map(({ index }) => index)

      setMarked({ boxes, strokes })
      setSelection(null)
    },
    [edit.boxes, edit.strokes],
  )

  /** Убирает всё выделенное рамкой одним действием. */
  const removeMarked = useCallback(() => {
    if (!marked.boxes.length && !marked.strokes.length) return
    commit()
    onEditChange({
      ...edit,
      boxes: edit.boxes.filter((_, index) => !marked.boxes.includes(index)),
      strokes: edit.strokes.filter((_, index) => !marked.strokes.includes(index)),
    })
    setMarked({ boxes: [], strokes: [] })
  }, [marked, edit, onEditChange, commit])

  /** Красит выбранную маску, не трогая остальные. */
  const paintSelected = useCallback(
    (index: number, color: string) => {
      commit()
      onEditChange({
        ...edit,
        boxes: edit.boxes.map((box, i) => (i === index ? { ...box, color } : box)),
      })
    },
    [edit, onEditChange, commit],
  )

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
        if (marked.boxes.length || marked.strokes.length) {
          event.preventDefault()
          removeMarked()
        } else if (selection) {
          event.preventDefault()
          removeSelected()
        }
      } else if (event.key === 'Escape') {
        setSelection(null)
        setMarked({ boxes: [], strokes: [] })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, removeSelected, removeMarked, selection, marked])

  const hasEdits = Boolean(edit.crop) || edit.boxes.length > 0

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div
        ref={viewportRef}
        className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl bg-[#0e1016] p-4 ring-1 ring-line-soft ${
          panning ? 'cursor-grabbing' : spaceHeld ? 'cursor-grab' : ''
        }`}
        onPointerDown={startPan}
        // Без этого средняя кнопка включает автопрокрутку вместо руки.
        onAuxClick={(event) => event.preventDefault()}
        onDoubleClick={() => {
          if (tool === 'view' || spaceRef.current) resetView()
        }}
      >
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

        {/* Обёртка обтягивает картинку, поэтому наложения совпадают с ней точно.
            Масштаб задан ей целиком — разметка правок едет вместе с картинкой,
            и пересчитывать координаты не нужно. Переменная --z отдана вниз:
            по ней рамки и маркеры ужимаются обратно, чтобы не пухли при зуме. */}
        <div
          className="relative"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            '--z': zoom,
          } as React.CSSProperties}
        >
          <img
            key={file.path}
            ref={imageRef}
            src={mediaUrl(file.path)}
            alt={file.name}
            className="block max-w-full select-none object-contain"
            draggable={false}
            style={{ maxHeight: 'calc(100vh - 330px)' }}
          />

          {/* Результат сжатия кладём поверх оригинала в ту же рамку: масштаб и
              положение общие, поэтому «до» и «после» можно щёлкать, разглядывая
              одну и ту же деталь. Правки уже вжжены в него, инструменты прячем. */}
          {showAfter && preview && (
            <img
              src={preview.url}
              alt="после сжатия"
              className="absolute inset-0 h-full w-full select-none object-contain"
              draggable={false}
            />
          )}

          {natural.width > 0 && !showAfter && (
            <div
              className="absolute inset-0"
              // Пока двигают картинку, инструменты не должны ловить нажатия.
              style={{ pointerEvents: spaceHeld || panning ? 'none' : undefined }}
            >
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
              paintColor={paintColor}
              onBoxesChange={(boxes) => onEditChange({ ...edit, boxes })}
              onCropChange={(crop) => onEditChange({ ...edit, crop })}
              onStrokesChange={(strokes) => onEditChange({ ...edit, strokes })}
              onCommit={commit}
              onPick={pickColor}
              onBoxMenu={(index, x, y) => setMenu({ index, x, y })}
              marked={marked}
              onMarquee={markArea}
            />
            </div>
          )}
        </div>

        {preview && (
          <div className="absolute bottom-3 left-3 flex overflow-hidden rounded-lg ring-1 ring-line-soft">
            {[
              { value: false, label: 'До', size: file.size },
              { value: true, label: 'После', size: preview.size },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => setShowAfter(item.value)}
                className={`px-2.5 py-1 text-[11px] transition-colors ${
                  showAfter === item.value
                    ? 'bg-accent text-white'
                    : 'bg-surface/90 text-ink-faint hover:text-ink-dim'
                }`}
              >
                {item.label}
                <span className="ml-1.5 font-mono tabular-nums opacity-70">
                  {humanSize(item.size)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Инструменты */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-surface px-3 py-2 text-[11px] text-ink-faint ring-1 ring-line-soft">
        <Segmented<Tool>
          className="w-[580px]"
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
            { value: 'select', label: 'Выделить', title: 'Обвести область и убрать всё лишнее разом' },
            { value: 'pick', label: 'Пипетка', title: 'Взять цвет прямо с картинки' },
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

        {tool !== 'view' && tool !== 'crop' && (
          <button
            type="button"
            onClick={() => colorInputRef.current?.click()}
            title="Цвет закраски — нажмите, чтобы выбрать"
            className="flex items-center gap-1.5 rounded-lg px-2 py-1 transition-colors hover:bg-surface-3"
          >
            <span
              className="h-4 w-4 rounded-[3px] ring-1 ring-line"
              style={{ background: paintColor }}
            />
            <span className="font-mono text-[10px] text-ink-dim">{paintColor}</span>
            {/* Настоящее поле выбора цвета прячем: системное окно открываем
                своей кнопкой, чтобы оно не ломало вид панели. */}
            <input
              ref={colorInputRef}
              type="color"
              value={paintColor}
              onChange={(event) => applyColor(event.target.value)}
              className="h-0 w-0 opacity-0"
              tabIndex={-1}
            />
          </button>
        )}

        <button
          type="button"
          onClick={resetView}
          disabled={zoom === 1 && pan.x === 0 && pan.y === 0}
          title="Вернуть картинку в исходное положение. Колесо — приблизить, средняя кнопка или пробел — двигать"
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 transition-colors hover:bg-surface-3 hover:text-ink-dim disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Maximize2 size={12} />
          Вписать
          <span className="w-9 text-right font-mono tabular-nums text-ink">
            {Math.round(zoom * 100)}%
          </span>
        </button>

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

        {(marked.boxes.length > 0 || marked.strokes.length > 0) && (
          <button
            type="button"
            onClick={removeMarked}
            title="Убрать всё, что попало в рамку (Delete)"
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent/15 px-2 py-1 text-accent-soft transition-colors hover:bg-accent/25"
          >
            <Trash2 size={12} />
            Убрать выделенное: {marked.boxes.length + marked.strokes.length}
          </button>
        )}

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
          {tool === 'select' && (
            <>
              <Square size={11} />
              Обведите область — всё, что в неё попало, можно убрать разом.
            </>
          )}
          {tool === 'pick' && (
            <>
              <Pipette size={11} />
              Щёлкните по картинке — цвет перейдёт в палитру.
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

      {menu && (
        <BoxMenu
          x={menu.x}
          y={menu.y}
          color={edit.boxes[menu.index]?.color ?? '#000000'}
          onClose={() => setMenu(null)}
          onDelete={() => {
            commit()
            onEditChange({
              ...edit,
              boxes: edit.boxes.filter((_, i) => i !== menu.index),
            })
            setSelection(null)
            setMenu(null)
          }}
          onColor={(color) => {
            paintSelected(menu.index, color)
            applyColor(color)
          }}
        />
      )}
    </div>
  )
}

/**
 * Меню по правой кнопке над маской.
 *
 * Держится на своём слое поверх всего: внутри картинки его обрезал бы
 * масштаб, а вместе с ней оно бы ещё и растянулось.
 */
function BoxMenu({
  x,
  y,
  color,
  onClose,
  onDelete,
  onColor,
}: {
  x: number
  y: number
  color: string
  onClose: () => void
  onDelete: () => void
  onColor: (color: string) => void
}) {
  const colorRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest('[data-box-menu]')) onClose()
    }
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    // Ждём следующего события: то, которое открыло меню, ещё не «отпустили».
    const timer = setTimeout(() => {
      window.addEventListener('mousedown', away)
      window.addEventListener('keydown', escape)
    }, 0)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', escape)
    }
  }, [onClose])

  return (
    <div
      data-box-menu
      className="fixed z-50 min-w-[168px] overflow-hidden rounded-lg bg-surface-2 py-1 text-[12px] shadow-lg ring-1 ring-line"
      style={{ left: Math.min(x, window.innerWidth - 180), top: Math.min(y, window.innerHeight - 90) }}
    >
      <button
        type="button"
        onClick={() => colorRef.current?.click()}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-3"
      >
        <span
          className="h-3 w-3 shrink-0 rounded-[3px] ring-1 ring-line"
          style={{ background: color }}
        />
        Поменять цвет
      </button>
      <input
        ref={colorRef}
        type="color"
        value={color}
        onChange={(event) => onColor(event.target.value)}
        className="h-0 w-0 opacity-0"
        tabIndex={-1}
      />
      <button
        type="button"
        onClick={onDelete}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-danger hover:bg-surface-3"
      >
        <Trash2 size={12} />
        Удалить
      </button>
    </div>
  )
}

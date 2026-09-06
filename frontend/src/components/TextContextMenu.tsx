import { useCallback, useEffect, useState } from 'react'
import { ClipboardCopy, ClipboardPaste, Scissors, TextCursorInput } from 'lucide-react'

type Target = HTMLInputElement | HTMLTextAreaElement

interface MenuState {
  x: number
  y: number
  field: Target
  hasSelection: boolean
}

/** Вставляет текст в поле так, чтобы React увидел изменение. */
function setFieldValue(field: Target, value: string) {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  // React перехватывает setter значения, поэтому напрямую менять .value мало —
  // событие не долетит до onChange. Зовём родной setter и шлём input вручную.
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  setter?.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * Меню по правому клику для полей ввода: вырезать, копировать, вставить.
 *
 * В обычном браузере такое меню рисует сам Windows, но в оконном режиме
 * приложения (WebView2) его нет — а вставлять ссылки мышью людям привычно.
 */
export function TextContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null)

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target) return
      const editable =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      if (!editable || target.disabled || target.readOnly) return
      if (target instanceof HTMLInputElement && !/^(text|search|url|email|tel|password|number)$/.test(target.type)) {
        return
      }

      event.preventDefault()
      const field = target as Target
      field.focus()
      setMenu({
        x: event.clientX,
        y: event.clientY,
        field,
        hasSelection: field.selectionStart !== field.selectionEnd,
      })
    }

    const dismiss = () => setMenu(null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null)
    }

    document.addEventListener('contextmenu', onContextMenu)
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('scroll', dismiss, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('contextmenu', onContextMenu)
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const act = useCallback(
    async (action: 'cut' | 'copy' | 'paste' | 'all') => {
      if (!menu) return
      const { field } = menu
      const start = field.selectionStart ?? 0
      const end = field.selectionEnd ?? 0
      const value = field.value

      try {
        if (action === 'all') {
          field.focus()
          field.select()
        } else if (action === 'copy' || action === 'cut') {
          await navigator.clipboard.writeText(value.slice(start, end))
          if (action === 'cut') {
            setFieldValue(field, value.slice(0, start) + value.slice(end))
            field.setSelectionRange(start, start)
          }
        } else {
          const text = await navigator.clipboard.readText()
          const next = value.slice(0, start) + text + value.slice(end)
          setFieldValue(field, next)
          const caret = start + text.length
          field.setSelectionRange(caret, caret)
        }
      } catch {
        // Браузер может не дать доступ к буферу — тогда остаются Ctrl+C/Ctrl+V.
      }
      setMenu(null)
    },
    [menu],
  )

  if (!menu) return null

  const items = [
    { id: 'cut' as const, label: 'Вырезать', icon: <Scissors size={12} />, enabled: menu.hasSelection },
    { id: 'copy' as const, label: 'Копировать', icon: <ClipboardCopy size={12} />, enabled: menu.hasSelection },
    { id: 'paste' as const, label: 'Вставить', icon: <ClipboardPaste size={12} />, enabled: true },
    { id: 'all' as const, label: 'Выделить всё', icon: <TextCursorInput size={12} />, enabled: true },
  ]

  return (
    <div
      className="animate-in-up fixed z-[100] min-w-[168px] overflow-hidden rounded-xl border border-line bg-surface-2 py-1 shadow-2xl"
      style={{
        // Не даём меню вылезти за край окна.
        left: Math.min(menu.x, window.innerWidth - 180),
        top: Math.min(menu.y, window.innerHeight - 150),
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          disabled={!item.enabled}
          onClick={() => void act(item.id)}
          className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px] text-ink-dim transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent"
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  )
}

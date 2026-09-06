import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'

/* Мелкие переиспользуемые элементы интерфейса. */

type ButtonTone = 'primary' | 'ghost' | 'subtle' | 'danger'

export function Button({
  children,
  onClick,
  tone = 'subtle',
  disabled,
  title,
  className = '',
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  tone?: ButtonTone
  disabled?: boolean
  title?: string
  className?: string
  type?: 'button' | 'submit'
}) {
  const tones: Record<ButtonTone, string> = {
    primary:
      'bg-accent text-white hover:bg-accent-soft shadow-[0_2px_14px_-4px_rgba(124,92,255,0.8)]',
    subtle: 'bg-surface-3 text-ink hover:bg-line',
    ghost: 'bg-transparent text-ink-dim hover:bg-surface-3 hover:text-ink',
    danger: 'bg-danger/15 text-danger hover:bg-danger/25',
  }
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${tones[tone]} ${className}`}
    >
      {children}
    </button>
  )
}

export function IconButton({
  children,
  onClick,
  title,
  active,
  disabled,
  className = '',
}: {
  children: ReactNode
  onClick?: () => void
  title?: string
  active?: boolean
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors disabled:opacity-35 ${
        active ? 'bg-accent/20 text-accent-soft' : 'text-ink-dim hover:bg-surface-3 hover:text-ink'
      } ${className}`}
    >
      {children}
    </button>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}) {
  return (
    <label
      className={`flex items-start gap-3 rounded-lg px-1 py-1.5 ${
        disabled ? 'opacity-45' : 'cursor-pointer'
      }`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`relative mt-0.5 h-[18px] w-[32px] shrink-0 rounded-full transition-colors ${
          checked ? 'bg-accent' : 'bg-surface-3'
        }`}
      >
        <span
          className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all ${
            checked ? 'left-[16px]' : 'left-[2px]'
          }`}
        />
      </button>
      <span className="min-w-0">
        <span className="block text-[13px] leading-tight text-ink">{label}</span>
        {hint && <span className="mt-0.5 block text-[11px] leading-snug text-ink-faint">{hint}</span>}
      </span>
    </label>
  )
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
  hint,
  disabled,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  onChange: (value: number) => void
  hint?: string
  disabled?: boolean
}) {
  return (
    <div className={disabled ? 'opacity-45' : ''}>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="label mb-0">{label}</span>
        <span className="font-mono text-[12px] text-ink">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        className="w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint && <p className="mt-1 text-[11px] leading-snug text-ink-faint">{hint}</p>}
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className = '',
  columns: forced,
}: {
  value: T
  options: { value: T; label: string; badge?: ReactNode; title?: string }[]
  onChange: (value: T) => void
  className?: string
  /** Сколько кнопок в ряду. Больше кнопок — перенесутся на следующий ряд. */
  columns?: number
}) {
  // grid вместо flex: колонки одинаковой ширины делятся поровну и не
  // раздуваются под длинную подпись, поэтому переключатель никогда не вылезает
  // за пределы панели — и полосы прокрутки не нужны.
  const perRow = forced ?? options.length
  const columns =
    ['', 'grid-cols-1', 'grid-cols-2', 'grid-cols-3', 'grid-cols-4', 'grid-cols-5', 'grid-cols-6'][
      perRow
    ] ?? 'grid-cols-4'

  return (
    <div className={`grid ${columns} gap-1 rounded-xl bg-surface-2 p-1 ${className}`}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          onClick={() => onChange(option.value)}
          className={`flex min-w-0 items-center justify-center gap-1 rounded-lg px-1 py-1.5 font-medium transition-colors ${
            perRow > 4 ? 'text-[11px]' : 'text-[12px]'
          } ${
            value === option.value
              ? 'bg-surface-3 text-ink shadow-sm'
              : 'text-ink-faint hover:text-ink-dim'
          }`}
        >
          <span className="truncate">{option.label}</span>
          {option.badge !== undefined && (
            <span className="shrink-0 rounded bg-base/60 px-1 text-[10px] tabular-nums">
              {option.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  disabled,
}: {
  label?: string
  value: T
  options: { value: T; label: string; disabled?: boolean }[]
  onChange: (value: T) => void
  hint?: string
  disabled?: boolean
}) {
  return (
    <div>
      {label && <span className="label">{label}</span>}
      <select
        className="field cursor-pointer"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {hint && <p className="mt-1 text-[11px] leading-snug text-ink-faint">{hint}</p>}
    </div>
  )
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  hint,
  disabled,
}: {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  suffix?: string
  hint?: string
  disabled?: boolean
}) {
  return (
    <div className={disabled ? 'opacity-45' : ''}>
      <span className="label">{label}</span>
      <div className="relative">
        <input
          type="number"
          className="field pr-10"
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(event) => {
            const next = Number(event.target.value)
            if (Number.isFinite(next)) onChange(next)
          }}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-ink-faint">
            {suffix}
          </span>
        )}
      </div>
      {hint && <p className="mt-1 text-[11px] leading-snug text-ink-faint">{hint}</p>}
    </div>
  )
}

export function Section({
  title,
  children,
  action,
}: {
  title: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
          {title}
        </h3>
        {action}
      </header>
      {children}
    </section>
  )
}

export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className={`animate-in-up flex max-h-[86vh] w-full flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl ${
          wide ? 'max-w-4xl' : 'max-w-lg'
        }`}
      >
        <header className="flex items-center justify-between border-b border-line-soft px-5 py-3.5">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <IconButton onClick={onClose} title="Закрыть">
            <X size={16} />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  )
}

export function Empty({ icon, title, hint }: { icon: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="text-ink-faint/50">{icon}</div>
      <p className="text-[15px] font-medium text-ink-dim">{title}</p>
      {hint && <p className="max-w-sm text-[13px] leading-relaxed text-ink-faint">{hint}</p>}
    </div>
  )
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-line border-t-accent"
      style={{ width: size, height: size }}
    />
  )
}

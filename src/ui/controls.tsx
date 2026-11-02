import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from './Icon'

/* ── Button: one primary per region; busy state for postings (no optimistic posting) ── */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'link'
  size?: 'md' | 'sm' | 'touch' | 'hero'
  busy?: boolean
  /** Renders the button disabled with a "Coming in phase N" explanation (never a dead button) */
  comingInPhase?: number
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', busy, comingInPhase, disabled, children, title, type = 'button', ...rest },
  ref,
) {
  const { t } = useTranslation()
  const coming = comingInPhase !== undefined ? t('common.comingInPhase', { phase: comingInPhase }) : undefined
  return (
    <button
      ref={ref}
      type={type}
      className="sf-btn"
      data-variant={variant}
      data-size={size === 'md' ? undefined : size}
      data-busy={busy ? 'true' : undefined}
      disabled={disabled || busy || comingInPhase !== undefined}
      aria-busy={busy || undefined}
      title={coming ?? title}
      {...rest}
    >
      {children}
      {coming ? <span className="sr-only">· {coming}</span> : null}
    </button>
  )
})

/* ── Field: label above, errors and warnings next to the field with the rule and next step ── */
export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  label: ReactNode
  error?: ReactNode
  warning?: ReactNode
  help?: ReactNode
  prefix?: ReactNode
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, error, warning, help, prefix, id, className, ...rest },
  ref,
) {
  const auto = useId()
  const inputId = id ?? auto
  const msgId = `${inputId}-msg`
  const helpId = `${inputId}-help`
  const state = error ? 'error' : warning ? 'warning' : undefined
  const describedBy = [state ? msgId : null, help ? helpId : null].filter(Boolean).join(' ') || undefined
  const input = (
    <input
      ref={ref}
      id={inputId}
      className={['sf-input', className ?? ''].join(' ').trim()}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy}
      {...rest}
    />
  )
  return (
    <div className="sf-field" data-state={state}>
      <label className="sf-field__label" htmlFor={inputId}>
        {label}
      </label>
      {prefix ? (
        <div className="sf-field__row">
          <span className="sf-field__prefix" aria-hidden="true">
            {prefix}
          </span>
          {input}
        </div>
      ) : (
        input
      )}
      {state ? (
        <span id={msgId} className="sf-field__msg">
          <Icon name={error ? 'cross' : 'alert'} size={14} />
          {error ?? warning}
        </span>
      ) : null}
      {help ? (
        <span id={helpId} className="sf-field__help">
          {help}
        </span>
      ) : null}
    </div>
  )
})

/* ── Tabs: button tabs (ink fill) or segmented control ── */
export interface TabDef<K extends string> {
  key: K
  label: ReactNode
}

export function Tabs<K extends string>({
  tabs,
  value,
  onChange,
  label,
  variant = 'buttons',
  idBase,
  controls,
}: {
  /** id of the tab panel, when the tabs switch a panel (sets aria-controls) */
  controls?: string
  tabs: TabDef<K>[]
  value: K
  onChange: (k: K) => void
  label: string
  variant?: 'buttons' | 'segmented'
  idBase?: string
}) {
  const auto = useId()
  const base = idBase ?? auto
  function onKey(e: React.KeyboardEvent, index: number) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const next = (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    const tab = tabs[next]
    if (tab) {
      onChange(tab.key)
      document.getElementById(`${base}-tab-${tab.key}`)?.focus()
    }
  }
  return (
    <div className="sf-tabs" role="tablist" aria-label={label} data-variant={variant === 'segmented' ? 'segmented' : undefined}>
      {tabs.map((tab, i) => (
        <button
          key={tab.key}
          id={`${base}-tab-${tab.key}`}
          type="button"
          role="tab"
          className="sf-tab"
          aria-selected={tab.key === value}
          aria-controls={controls}
          tabIndex={tab.key === value ? 0 : -1}
          onClick={() => onChange(tab.key)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

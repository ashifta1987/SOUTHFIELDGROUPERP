import { forwardRef, useId, type FormEvent, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, type InputHTMLAttributes } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useTranslation } from 'react-i18next'
import { Button } from './controls'
import { Icon } from './Icon'

/* ── Select field (native select styled like an input; label above, error linked) ── */
export interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: ReactNode
  error?: ReactNode
  help?: ReactNode
  options: { value: string; label: string }[]
  placeholder?: string
}
export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField({ label, error, help, options, placeholder, id, ...rest }, ref) {
  const auto = useId()
  const sid = id ?? auto
  return (
    <div className="sf-field" data-state={error ? 'error' : undefined}>
      <label className="sf-field__label" htmlFor={sid}>
        {label}
      </label>
      <select ref={ref} id={sid} className="sf-input" aria-invalid={error ? true : undefined} aria-describedby={error ? `${sid}-msg` : help ? `${sid}-help` : undefined} {...rest}>
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error ? (
        <span id={`${sid}-msg`} className="sf-field__msg">
          <Icon name="cross" size={14} />
          {error}
        </span>
      ) : null}
      {help ? (
        <span id={`${sid}-help`} className="sf-field__help">
          {help}
        </span>
      ) : null}
    </div>
  )
})

/* ── Text area ── */
export interface TextAreaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: ReactNode
  error?: ReactNode
}
export const TextAreaField = forwardRef<HTMLTextAreaElement, TextAreaFieldProps>(function TextAreaField({ label, error, id, ...rest }, ref) {
  const auto = useId()
  const tid = id ?? auto
  return (
    <div className="sf-field" data-state={error ? 'error' : undefined}>
      <label className="sf-field__label" htmlFor={tid}>
        {label}
      </label>
      <textarea ref={ref} id={tid} className="sf-input" style={{ height: 'auto', minHeight: 76, padding: '8px 12px' }} aria-invalid={error ? true : undefined} aria-describedby={error ? `${tid}-msg` : undefined} {...rest} />
      {error ? (
        <span id={`${tid}-msg`} className="sf-field__msg">
          <Icon name="cross" size={14} />
          {error}
        </span>
      ) : null}
    </div>
  )
})

/* ── Checkbox with label and hint ── */
export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode
  hint?: ReactNode
}
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox({ label, hint, id, ...rest }, ref) {
  const auto = useId()
  const cid = id ?? auto
  return (
    <label htmlFor={cid} style={{ display: 'flex', gap: 7, alignItems: 'flex-start', minHeight: 24, cursor: rest.disabled ? 'not-allowed' : 'pointer' }}>
      <input ref={ref} id={cid} type="checkbox" style={{ width: 18, height: 18, margin: 3, accentColor: 'var(--sf-primary)', flex: 'none' }} {...rest} />
      <span style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{label}</span>
        {hint ? <span className="k">{hint}</span> : null}
      </span>
    </label>
  )
})

/* ── Form dialog: a modal form with Save / Cancel, busy state and an error area ── */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  submitLabel,
  busy,
  onSubmit,
  error,
  wide,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  submitLabel: ReactNode
  busy?: boolean
  onSubmit: () => void
  error?: ReactNode
  wide?: boolean
}) {
  const { t } = useTranslation()
  function submit(e: FormEvent) {
    e.preventDefault()
    onSubmit()
  }
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="sf-dialog-overlay" />
        <Dialog.Content className="sf-dialog" style={{ width: wide ? 'min(720px, calc(100vw - 32px))' : undefined, maxHeight: 'calc(100vh - 48px)', overflowY: 'auto' }}>
          <form onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Dialog.Title asChild>
              <h2>{title}</h2>
            </Dialog.Title>
            {description ? (
              <Dialog.Description asChild>
                <p>{description}</p>
              </Dialog.Description>
            ) : (
              <Dialog.Description className="sr-only">{title}</Dialog.Description>
            )}
            {children}
            {error}
            <div className="sf-dialog__actions">
              <Dialog.Close asChild>
                <Button>{t('common.cancel')}</Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" busy={busy}>
                {busy ? t('common.saving') : submitLabel}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/* ── Grid of form fields ── */
export function FieldGrid({ children, cols = 2 }: { children: ReactNode; cols?: 1 | 2 | 3 }) {
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${cols === 3 ? 180 : cols === 2 ? 220 : 400}px, 1fr))`, gap: 12 }}>{children}</div>
}

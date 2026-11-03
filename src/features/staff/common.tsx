import { useState, type ReactNode } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { RpcError } from '@/data/rpc'
import type { StaffMe, StaffMeRequest } from '@/data/queries'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { askHelp } from '@/features/help/events'
import { formatDate } from '@/shared/format'
import { Chip, ErrorRef, Icon, StatusChip } from '@/ui'
import type { PhoneOutletContext } from '@/ui/shell/StaffShell'

/** Staff app sub-page header (StaffLeave / StaffAdvance / StaffDetails / StaffPayslip): back, title, one action, Help. */
export function StaffSubHeader({ title, action }: { title: ReactNode; action?: ReactNode }) {
  const { t } = useTranslation()
  const ctx = useOutletContext<PhoneOutletContext | undefined>()
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '14px 12px',
        background: 'var(--sf-surface)',
        borderBottom: '1px solid var(--sf-line)',
        color: 'var(--sf-text)',
      }}
    >
      <Link to="/staff/home" aria-label={t('staffApp.back')} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 44, color: 'var(--sf-text)' }}>
        <span aria-hidden="true" style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>
          <Icon name="chevronRight" size={22} />
        </span>
      </Link>
      <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700, flex: '1 1 0%' }}>{title}</h1>
      {action}
      <button
        type="button"
        aria-label={t('help.open')}
        onClick={() => (ctx ? ctx.openHelp() : askHelp())}
        style={{ width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 0, background: 'transparent', color: 'var(--sf-text-2)', cursor: 'pointer', borderRadius: 10 }}
      >
        <Icon name="help" size={22} />
      </button>
    </header>
  )
}

/** Segmented radio group (large phone targets). Native radios, so arrow keys and screen readers work. */
export function SegRadio<V extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  hint,
  cols,
}: {
  legend: ReactNode
  name: string
  value: V
  options: { value: V; label: ReactNode }[]
  onChange: (v: V) => void
  hint?: ReactNode
  cols?: number
}) {
  const [focused, setFocused] = useState<V | null>(null)
  return (
    <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <legend style={{ fontSize: 14, fontWeight: 600, color: 'var(--sf-text-2)', padding: 0, marginBottom: 6 }}>{legend}</legend>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols ?? options.length}, minmax(0, 1fr))`, gap: 8 }}>
        {options.map((o) => {
          const on = o.value === value
          return (
            <label
              key={o.value}
              style={{
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: 48,
                borderRadius: 10,
                border: on ? '2px solid var(--sf-primary)' : '1px solid var(--sf-border-input)',
                background: on ? 'var(--sf-primary-tint)' : 'var(--sf-surface)',
                fontWeight: on ? 600 : 400,
                fontSize: 15,
                cursor: 'pointer',
                outline: focused === o.value ? '2px solid var(--sf-primary)' : undefined,
                outlineOffset: 2,
              }}
            >
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={on}
                onChange={() => onChange(o.value)}
                onFocus={() => setFocused(o.value)}
                onBlur={() => setFocused(null)}
                style={{ position: 'absolute', opacity: 0, inset: 0, margin: 0, cursor: 'pointer' }}
              />
              {o.label}
            </label>
          )
        })}
      </div>
      {hint ? <span style={{ fontSize: 12.5, color: 'var(--sf-text-muted)' }}>{hint}</span> : null}
    </fieldset>
  )
}

/** Refusals from the staff-request RPC carry their own rule codes; everything else goes through RpcErrorBox. */
export function StaffErrorBox({ error }: { error: RpcError | null | undefined }) {
  const { t } = useTranslation()
  if (!error) return null
  if (error.rule?.startsWith('staff.')) {
    const key = `staffApp.rules.${error.rule.slice(6)}`
    const msg = t(key)
    if (msg !== key) return <ErrorRef message={msg} next={t('errors.nextStep')} refId={error.ref} onAskHelp={() => askHelp({ errorCode: error.ref })} />
  }
  return <RpcErrorBox error={error} />
}

export function RequestStatus({ status }: { status: string }) {
  const { t } = useTranslation()
  if (status === 'approved') return <StatusChip status="approved" />
  if (status === 'refused') return <Chip tone="danger" icon="cross">{t('staffApp.status.refused')}</Chip>
  if (status === 'withdrawn') return <Chip tone="neutral">{t('staffApp.status.withdrawn')}</Chip>
  return <StatusChip status="pending" />
}

/** One line per own request: what, when, status (and the approver's note). */
export function RequestLine({ r }: { r: StaffMeRequest }) {
  const { t } = useTranslation()
  const what =
    r.kind === 'leave'
      ? r.from_date
        ? r.half_day
          ? t('staffApp.leaveHalf', { date: formatDate(r.from_date) })
          : r.from_date === r.to_date || !r.to_date
            ? t('staffApp.leaveOne', { date: formatDate(r.from_date) })
            : t('staffApp.leaveRange', { from: formatDate(r.from_date), to: formatDate(r.to_date) })
        : t('staffApp.kind.leave')
      : t('staffApp.kind.advance')
  return (
    <div className="sf-phone-note" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--sf-text)', fontWeight: 600 }}>
          {what}
          {r.kind === 'leave' && r.leave_type ? ` · ${t(`staffApp.leaveType.${r.leave_type}`)}` : ''}
          {r.kind === 'advance' && r.amount != null ? ' · ' : ''}
          {r.kind === 'advance' && r.amount != null ? <MoneyText value={r.amount} /> : null}
        </span>
        <RequestStatus status={r.status} />
      </span>
      <span style={{ fontSize: 12.5 }}>
        {t('staffApp.sentOn', { date: formatDate(r.created_at) })}
        {r.decision_note ? ` · ${r.decision_note}` : ''}
      </span>
    </div>
  )
}

/** ₹ with Indian grouping, mono digits (no decimals when whole rupees). */
export function MoneyText({ value }: { value: string | number }) {
  const n = Number(value)
  const text = new Intl.NumberFormat('en-IN', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }).format(n)
  return <span className="mono">₹{text}</span>
}

/** staff_me() returns null until Admin links the sign-in to a staff record. */
export function NotLinked() {
  const { t } = useTranslation()
  return (
    <div className="sf-phone-note" role="status">
      {t('staffApp.notLinked')}
    </div>
  )
}

export type { StaffMe }

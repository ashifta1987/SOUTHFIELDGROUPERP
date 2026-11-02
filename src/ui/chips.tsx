import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from './Icon'

type Tone = 'neutral' | 'teal' | 'info' | 'signal' | 'success' | 'danger' | 'transit' | 'navy' | 'outline'

/** Status always shows a word and an icon, never colour alone (§UX-8). */
export type StatusKind =
  | 'draft'
  | 'pending'
  | 'approved'
  | 'posted'
  | 'released'
  | 'onHold'
  | 'inTransit'
  | 'delivered'
  | 'failed'
  | 'blocked'
  | 'overdue'
  | 'check'

const STATUS: Record<StatusKind, { tone: Tone; icon: string }> = {
  draft: { tone: 'info', icon: 'pencil' },
  pending: { tone: 'signal', icon: 'clock' },
  approved: { tone: 'teal', icon: 'check' },
  posted: { tone: 'success', icon: 'check' },
  released: { tone: 'success', icon: 'check' },
  onHold: { tone: 'signal', icon: 'lock' },
  inTransit: { tone: 'transit', icon: 'truck' },
  delivered: { tone: 'success', icon: 'check' },
  failed: { tone: 'danger', icon: 'cross' },
  blocked: { tone: 'danger', icon: 'ban' },
  overdue: { tone: 'danger', icon: 'alert' },
  check: { tone: 'signal', icon: 'alert' },
}

export function Chip({ tone, icon, children }: { tone: Tone; icon?: string; children: ReactNode }) {
  return (
    <span className="sf-chip" data-tone={tone}>
      {icon ? <Icon name={icon} size={12} strokeWidth={2.2} /> : null}
      {children}
    </span>
  )
}

export function StatusChip({ status, label }: { status: StatusKind; label?: ReactNode }) {
  const { t } = useTranslation()
  const s = STATUS[status]
  return (
    <Chip tone={s.tone} icon={s.icon}>
      {label ?? t(`status.${status}`)}
    </Chip>
  )
}

/** Tax classes (§UX-6). "Without GST · reason" appears only in the Admin view; RLS decides who receives those rows. */
export type TaxClass = 'taxable' | 'zeroRated' | 'exempt' | 'nilRated' | 'nonGst' | 'reverseCharge' | 'withoutGst'

const TAX: Record<TaxClass, { tone: Tone; icon: string }> = {
  taxable: { tone: 'teal', icon: 'check' },
  zeroRated: { tone: 'info', icon: 'info' },
  exempt: { tone: 'neutral', icon: 'info' },
  nilRated: { tone: 'neutral', icon: 'info' },
  nonGst: { tone: 'signal', icon: 'alert' },
  reverseCharge: { tone: 'outline', icon: 'info' },
  withoutGst: { tone: 'signal', icon: 'alert' },
}

export function TaxClassChip({ taxClass, reason }: { taxClass: TaxClass; reason?: string | null }) {
  const { t } = useTranslation()
  const s = TAX[taxClass]
  let label = t(`tax.${taxClass}`)
  if (taxClass === 'withoutGst') label = `${label} · ${reason ? reason : t('tax.noReason')}`
  return (
    <Chip tone={s.tone} icon={s.icon}>
      {label}
    </Chip>
  )
}

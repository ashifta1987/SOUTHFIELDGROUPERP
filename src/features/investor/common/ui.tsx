import { useState, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { RpcError } from '@/data/rpc'
import { useApiMutation } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { askHelp } from '@/features/help/events'
import { formatDate, formatIndian, isNegative } from '@/shared/format'
import { Amount, Button, Chip, EmptyState, ErrorRef, Skeleton, StatusChip } from '@/ui'
import { REQUEST_KEYS, type InvestorRequest } from './investor'

/** Phone card used across the portal pages. */
export function PCard({ title, action, children, labelId, testId }: { title?: ReactNode; action?: ReactNode; children: ReactNode; labelId?: string; testId?: string }) {
  return (
    <section className="sf-phone-card" aria-labelledby={title ? labelId : undefined} data-testid={testId} style={{ gap: 10 }}>
      {title || action ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
          {title ? (
            <h2 id={labelId} style={{ color: 'var(--sf-text)', fontSize: 15.5, fontWeight: 700 }}>
              {title}
            </h2>
          ) : (
            <span />
          )}
          {action ? <span className="muted" style={{ fontSize: 13 }}>{action}</span> : null}
        </div>
      ) : null}
      {children}
    </section>
  )
}

/** Page title for portal pages (one h1 per page). */
export function PageTitle({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <div>
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{title}</h1>
      {sub ? <p style={{ margin: '2px 0 0', fontSize: 13.5, color: 'var(--sf-text-muted)' }}>{sub}</p> : null}
    </div>
  )
}

export function Loading() {
  const { t } = useTranslation()
  return (
    <div aria-busy="true" aria-label={t('common.loading')} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Skeleton height={28} width={200} />
      <Skeleton height={120} />
      <Skeleton height={160} />
    </div>
  )
}

/** Read failed: say so, with a way to ask for help. */
export function LoadFailed() {
  const { t } = useTranslation()
  return <EmptyState title={t('investor.loadFailed')} body={t('investor.loadFailedNext')} />
}

/** No partner record linked to this sign-in yet. */
export function NotLinked() {
  const { t } = useTranslation()
  return <EmptyState title={t('investor.notLinked')} body={t('investor.notLinkedNext')} />
}

/** ₹ amount in mono with Indian grouping; null → "—". */
export function Rs({ value, digits = 2, testId }: { value: number | string | null | undefined; digits?: number; testId?: string }) {
  return (
    <span data-testid={testId} data-value={value ?? ''}>
      <Amount value={value === null || value === undefined ? null : String(value)} rupee digits={digits} />
    </span>
  )
}

/** Percent with up to 3 decimals as stored. */
export function Pct({ value, testId }: { value: number | string | null | undefined; testId?: string }) {
  if (value === null || value === undefined) return <span className="mono">—</span>
  const n = Number(value)
  const text = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 }).format(n)
  return (
    <span className="mono" data-testid={testId} data-value={String(value)}>
      {text}%
    </span>
  )
}

/** Whole numbers (shares, counts) with Indian grouping. */
export function Num({ value, testId }: { value: number | string | null | undefined; testId?: string }) {
  if (value === null || value === undefined) return <span className="mono">—</span>
  return (
    <span className="mono" data-testid={testId} data-value={String(value)}>
      {formatIndian(String(value), 0)}
    </span>
  )
}

/** The partner's loan account: a credit balance means the company owes the partner; a debit means the partner owes. */
export function LoanBalance({ value, testId }: { value: number | string | null | undefined; testId?: string }) {
  const { t } = useTranslation()
  if (value === null || value === undefined) return <span className="muted">{t('investor.loan.none')}</span>
  const s = String(value)
  const neg = isNegative(s)
  const abs = neg ? s.replace('-', '') : s
  return (
    <span className="mono" data-testid={testId} data-value={s} style={{ color: neg ? 'var(--sf-danger-ink)' : undefined }}>
      {neg ? t('investor.loan.iOwe', { amount: `₹${formatIndian(abs)}` }) : t('investor.loan.owedToMe', { amount: `₹${formatIndian(abs)}` })}
    </span>
  )
}

/** Simple vertical bars (values from the server; heights are only drawing). */
export function Bars({ items, label, tone = 'navy' }: { items: { key: string; label: string; value: number }[]; label: string; tone?: 'navy' | 'teal' }) {
  const max = Math.max(1, ...items.map((i) => i.value))
  const color = tone === 'navy' ? 'var(--sf-navy)' : 'var(--sf-primary)'
  const first = items[0]
  const last = items[items.length - 1]
  return (
    <figure style={{ margin: 0 }}>
      <div role="img" aria-label={`${label}: ${items.map((i) => `${i.label} ₹${formatIndian(i.value, 0)}`).join(', ')}`} style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 110 }}>
        {items.map((i) => (
          <span
            key={i.key}
            title={`${i.label} · ₹${formatIndian(i.value, 0)}`}
            style={{ flex: '1 1 0%', minWidth: 3, height: `${Math.max(2, (i.value / max) * 100)}%`, background: color, borderRadius: '3px 3px 0 0' }}
          />
        ))}
      </div>
      {first && last ? (
        <figcaption style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--sf-text-muted)', marginTop: 4 }}>
          <span>{first.label}</span>
          <span>{last.label}</span>
        </figcaption>
      ) : null}
    </figure>
  )
}

/** One label–value line inside a phone card. */
export function Line({ label, children, strong }: { label: ReactNode; children: ReactNode; strong?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderTop: '1px solid var(--sf-line-faint)', fontWeight: strong ? 700 : undefined }}>
      <span style={{ color: strong ? 'var(--sf-text)' : 'var(--sf-text-2)' }}>{label}</span>
      <span style={{ textAlign: 'right' }}>{children}</span>
    </div>
  )
}

/**
 * Refusals: partner, request, loan and Companies Act rules are explained by the server's own message (the CA's checks
 * live there); anything else goes through the shared RpcErrorBox.
 */
export function InvestorError({ error }: { error: RpcError | null | undefined }) {
  const { t } = useTranslation()
  if (!error) return null
  const rule = error.rule ?? ''
  if (/^(partner|partner_request|companies_act|loan|sod)\./.test(rule)) {
    const msg = error.message.charAt(0).toUpperCase() + error.message.slice(1)
    return <ErrorRef message={msg} next={t('investor.errorNext')} refId={error.ref} onAskHelp={() => askHelp({ errorCode: error.ref })} />
  }
  return <RpcErrorBox error={error} />
}

export function RequestStatus({ status }: { status: string | null }) {
  const { t } = useTranslation()
  if (status === 'approved') return <StatusChip status="approved" />
  if (status === 'paid') return <StatusChip status="posted" label={t('investor.status.paid')} />
  if (status === 'rejected') return <Chip tone="danger" icon="cross">{t('investor.status.rejected')}</Chip>
  if (status === 'withdrawn') return <Chip tone="neutral">{t('investor.status.withdrawn')}</Chip>
  return <StatusChip status="pending" label={t('investor.status.submitted')} />
}

/** Own requests with their status; a request not yet decided can be taken back by the person who sent it. */
export function RequestList({ rows, kinds, loading, emptyText, title }: { rows: InvestorRequest[]; kinds: string[]; loading?: boolean; emptyText: string; title: string }) {
  const { t } = useTranslation()
  const mine = rows.filter((r) => r.kind && kinds.includes(r.kind))
  const takeBack = useApiMutation<{ p_request_id: string }>('withdraw_partner_request', REQUEST_KEYS)
  const [busyId, setBusyId] = useState<string | null>(null)
  if (loading) return <Skeleton height={60} />
  return (
    <section className="sf-phone-section" aria-labelledby="inv-my-requests" data-testid="investor-requests">
      <h2 id="inv-my-requests">{mine.length ? title : emptyText}</h2>
      <InvestorError error={takeBack.error} />
      {mine.map((r) => (
        <div key={r.id} className="sf-phone-note" data-testid="investor-request" data-doc={r.doc_no ?? ''} data-status={r.status ?? ''} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--sf-text)', fontWeight: 600 }}>
              <span className="mono">{r.doc_no}</span> · {t(`investor.kind.${r.kind ?? 'info'}`)}
            </span>
            <RequestStatus status={r.status} />
          </span>
          <span style={{ fontSize: 13 }}>
            {r.company_name}
            {r.amount != null ? (
              <>
                {' · '}
                <Rs value={r.amount} />
              </>
            ) : null}
            {r.source ? ` · ${t(`investor.source.${r.source}`)}` : ''}
            {r.repay_months ? ` · ${t('investor.repayMonths', { n: r.repay_months })}` : ''}
          </span>
          <span style={{ fontSize: 12.5 }}>
            {r.created_at ? t('investor.sentOn', { date: formatDate(r.created_at) }) : ''}
            {r.decided_at ? ` · ${t('investor.decidedOn', { date: formatDate(r.decided_at) })}` : ''}
            {r.decided_amount != null && r.status !== 'rejected' ? (
              <>
                {' · '}
                {t('investor.decidedAmount')} <Rs value={r.decided_amount} />
              </>
            ) : null}
          </span>
          {r.decision_note ? <span style={{ fontSize: 13, color: 'var(--sf-text)' }}>{t('investor.adminNote', { note: r.decision_note })}</span> : null}
          {r.status === 'submitted' && r.id ? (
            <span>
              <Button
                size="sm"
                variant="link"
                busy={takeBack.isPending && busyId === r.id}
                onClick={() => {
                  setBusyId(r.id)
                  takeBack.mutate({ p_request_id: r.id as string })
                }}
              >
                {t('investor.takeBack')}
                <span className="sr-only"> {r.doc_no}</span>
              </Button>
            </span>
          ) : null}
        </div>
      ))}
    </section>
  )
}

/** Withdraw | Loan switch at the top of the Requests pages (two routes). */
export function RequestTabs() {
  const { t } = useTranslation()
  const tab = (to: string, label: string) => (
    <NavLink
      to={to}
      style={({ isActive }) => ({
        flex: '1 1 0%',
        textAlign: 'center',
        padding: '10px 0',
        minHeight: 24,
        borderRadius: 10,
        textDecoration: 'none',
        fontWeight: isActive ? 700 : 500,
        color: isActive ? 'var(--sf-text)' : 'var(--sf-text-2)',
        background: isActive ? 'var(--sf-surface)' : 'transparent',
        border: isActive ? '1px solid var(--sf-line)' : '1px solid transparent',
      })}
    >
      {label}
    </NavLink>
  )
  return (
    <nav aria-label={t('investor.requestsNav')} style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 12, background: 'var(--sf-line-soft)' }}>
      {tab('/investor/withdraw', t('investor.nav.withdraw'))}
      {tab('/investor/loan', t('investor.nav.loan'))}
    </nav>
  )
}

/** Amount entry: digits with up to 2 decimals (format only; the server decides the rest). */
export function cleanAmount(s: string): { value: string; ok: boolean } {
  const value = s.replace(/[,\s₹]/g, '')
  return { value, ok: /^\d+(\.\d{1,2})?$/.test(value) && Number(value) > 0 }
}

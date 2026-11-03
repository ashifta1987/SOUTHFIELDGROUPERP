import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RpcError } from '@/data/rpc'
import { useApiRpc } from '@/data/queries'
import { formatDate, formatTime } from '@/shared/format'
import { Amount, Button, Field, Skeleton } from '@/ui'
import { FieldErrorBox, Line, sendOrQueue, todayIstIso, useFieldRefresh } from './field'

export interface CustomerAccount {
  scope: 'gst_only' | 'full'
  as_of: string
  balance_due: number | string
  ageing: Record<'not_due' | '0-30' | '31-60' | '61-90' | '90+', number | string>
  overdue: number | string
  credit_limit: number | string
  credit_status: string | null
  available_credit: number | string | null
  credit_blocked: boolean | null
  last_payment: { date: string; amount: number | string } | null
  promises: { id: string; amount: number | string; promised_on: string; status: string }[]
  open_bills: { kind: string; id: string; bill_ref: string | null; bill_date: string; due_date: string | null; amount: number | string; open_amount: number | string; days_overdue: number }[]
}

export function useCustomerAccount(companyId: string | undefined, partyId: string | undefined) {
  return useApiRpc<CustomerAccount>('salesman_customer_account', { p_company_id: companyId, p_party_id: partyId }, Boolean(companyId && partyId))
}

/**
 * The customer's account as the salesman may see it (server computed, "as of"). Under salesman_balance_scope = gst_only
 * (Q-12, until the owner decides) only GST bills appear; the screen says so.
 */
export function AccountSummary({ companyId, partyId, showBills = true }: { companyId: string; partyId: string; showBills?: boolean }) {
  const { t } = useTranslation()
  const q = useCustomerAccount(companyId, partyId)
  if (q.isLoading) return <Skeleton height={120} />
  if (q.error)
    return (
      <p role="alert" className="sf-alert" data-tone="danger" style={{ margin: 0 }}>
        {t('fieldCommon.account.loadFailed')}
      </p>
    )
  const a = q.data?.status === 'ready' ? q.data.data : null
  if (!a) return null
  return (
    <section className="sf-phone-card" aria-labelledby="acct-head">
      <h2 id="acct-head">{t('fieldCommon.account.title')}</h2>
      <span className="k">
        {t('fieldCommon.account.asOf', { date: formatDate(a.as_of), time: formatTime(a.as_of) })}
        {a.scope === 'gst_only' ? ` · ${t('fieldCommon.account.gstOnly')}` : ''}
      </span>
      <div>
        <Line label={t('fieldCommon.account.balance')} value={<Amount value={a.balance_due} rupee />} testId="balance-due" />
        <Line label={t('fieldCommon.account.overdue')} value={<Amount value={a.overdue} rupee />} />
        <Line label={t('fieldCommon.account.age030')} value={<Amount value={a.ageing['0-30']} rupee />} />
        <Line label={t('fieldCommon.account.age3160')} value={<Amount value={a.ageing['31-60']} rupee />} />
        <Line label={t('fieldCommon.account.age6190')} value={<Amount value={a.ageing['61-90']} rupee />} />
        <Line label={t('fieldCommon.account.age90')} value={<Amount value={a.ageing['90+']} rupee />} />
        <Line label={t('fieldCommon.account.limit')} value={<Amount value={a.credit_limit} rupee />} />
        <Line label={t('fieldCommon.account.available')} value={<Amount value={a.available_credit} rupee />} />
        <Line label={t('fieldCommon.account.creditStatus')} value={`${t(`fieldCommon.account.credit.${a.credit_status ?? 'none'}`, { defaultValue: a.credit_status ?? '' })}${a.credit_blocked ? ` · ${t('fieldCommon.account.blocked')}` : ''}`} />
        <Line
          label={t('fieldCommon.account.lastPayment')}
          value={a.last_payment ? <>{formatDate(a.last_payment.date)} · <Amount value={a.last_payment.amount} rupee /></> : t('fieldCommon.account.noPayment')}
        />
      </div>
      {a.promises.length > 0 ? (
        <div>
          <strong>{t('fieldCommon.account.promises')}</strong>
          {a.promises.map((p) => (
            <Line key={p.id} label={formatDate(p.promised_on)} value={<Amount value={p.amount} rupee />} />
          ))}
        </div>
      ) : null}
      {showBills ? (
        <div>
          <strong>{t('fieldCommon.account.openBills')}</strong>
          {a.open_bills.length === 0 ? (
            <p className="k" style={{ margin: '6px 0 0' }}>
              {t('fieldCommon.account.noBills')}
            </p>
          ) : (
            a.open_bills.map((b) => (
              <Line
                key={`${b.kind}-${b.id}`}
                label={
                  <span>
                    <span className="mono">{b.bill_ref ?? '—'}</span>
                    <br />
                    <span className="k">
                      {formatDate(b.bill_date)}
                      {b.due_date ? ` · ${t('fieldCommon.account.due', { date: formatDate(b.due_date) })}` : ''}
                      {b.days_overdue > 0 ? ` · ${t('fieldCommon.account.daysOver', { count: b.days_overdue })}` : ''}
                    </span>
                  </span>
                }
                value={<Amount value={b.open_amount} rupee />}
              />
            ))
          )}
        </div>
      ) : null}
    </section>
  )
}

/** Promise to pay (api.record_promise_to_pay; a past date is refused by the server). */
export function PromiseForm({ companyId, partyId }: { companyId: string; partyId: string }) {
  const { t } = useTranslation()
  const refresh = useFieldRefresh()
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayIstIso())
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<RpcError | null>(null)
  const [done, setDone] = useState<'sent' | 'queued' | null>(null)
  async function save() {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const out = await sendOrQueue('record_promise_to_pay', { p: { company_id: companyId, party_id: partyId, amount: amount.replace(/[,\s]/g, ''), promised_on: date, note: note.trim() || null } }, 'promise')
      setDone(out.queued ? 'queued' : 'sent')
      setAmount('')
      setNote('')
      await refresh()
    } catch (e) {
      setError(e as RpcError)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="sf-phone-card" aria-labelledby="promise-head">
      <h2 id="promise-head">{t('fieldCommon.promise.title')}</h2>
      <Field label={t('fieldCommon.promise.amount')} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} prefix="₹" />
      <Field label={t('fieldCommon.promise.date')} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <Field label={t('fieldCommon.promise.note')} value={note} onChange={(e) => setNote(e.target.value)} />
      <Button size="touch" busy={busy} disabled={!/^\d+(\.\d{1,2})?$/.test(amount.replace(/[,\s]/g, '')) || !date} onClick={() => void save()}>
        {t('fieldCommon.promise.save')}
      </Button>
      {done ? (
        <p role="status" className="sf-alert" data-tone={done === 'sent' ? 'success' : 'signal'} style={{ margin: 0 }}>
          {done === 'sent' ? t('fieldCommon.promise.done') : t('fieldCommon.queued')}
        </p>
      ) : null}
      <FieldErrorBox error={error} />
    </section>
  )
}

/** Statement on WhatsApp, only to the customer's registered consented number (§WA-3); the server decides and may skip. */
export function StatementButton({ companyId, partyId }: { companyId: string; partyId: string }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<RpcError | null>(null)
  const [res, setRes] = useState<{ status: string | null; skip_reason: string | null } | null>(null)
  async function send() {
    setBusy(true)
    setError(null)
    setRes(null)
    try {
      const out = await sendOrQueue<{ status: string | null; skip_reason: string | null }>('send_statement_whatsapp', { p_company_id: companyId, p_party_id: partyId, p_to: todayIstIso() }, 'statement')
      setRes(out.queued ? { status: 'phone', skip_reason: null } : out.result)
    } catch (e) {
      setError(e as RpcError)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Button size="touch" busy={busy} onClick={() => void send()}>
        {t('fieldCommon.statement.send')}
      </Button>
      {res ? (
        <p role="status" className="sf-alert" data-tone={res.status === 'skipped' ? 'signal' : 'success'} style={{ margin: 0 }}>
          {res.status === 'phone'
            ? t('fieldCommon.queued')
            : res.status === 'skipped'
              ? t('fieldCommon.statement.skipped', { reason: res.skip_reason ?? '' })
              : t('fieldCommon.statement.queuedMsg')}
        </p>
      ) : null}
      <FieldErrorBox error={error} />
    </div>
  )
}

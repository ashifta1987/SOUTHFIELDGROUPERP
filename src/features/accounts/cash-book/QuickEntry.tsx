import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { Button, Card, Chip, Field, SelectField, Tabs, TextAreaField } from '@/ui'
import { cleanAmount, MoneyErrorBox, useCompanyAccounts, useCompanyParties, type MoneyAccount } from './money'

type Direction = 'receipt' | 'payment'
interface Posted {
  voucher_id: string
  doc_no: string
  warning: string | null
}

const REFRESH = [['api', 'account_ledger'], ['api', 'vouchers'], ['api', 'receivables'], ['api', 'payables']]

/**
 * Quick cash receipt or payment on the cash book. The server applies the cash limits: a receipt that takes one
 * person to the daily limit is refused; a payment over the limit needs a reason (then posts and is flagged for Admin).
 */
export function QuickEntry({ companyId, account }: { companyId: string; account: MoneyAccount }) {
  const { t } = useTranslation()
  const [dir, setDir] = useState<Direction>('receipt')
  const [date, setDate] = useState(todayIst())
  const [party, setParty] = useState('')
  const [counter, setCounter] = useState('')
  const [amount, setAmount] = useState('')
  const [narration, setNarration] = useState('')
  const [reason, setReason] = useState('')
  const [needReason, setNeedReason] = useState(false)
  const [errors, setErrors] = useState<{ amount?: string; counter?: string; reason?: string }>({})
  const [done, setDone] = useState<Posted | null>(null)
  const parties = useCompanyParties(companyId)
  const accounts = useCompanyAccounts(companyId)
  const receipt = useApiMutation<{ p: Record<string, unknown> }, Posted>('post_receipt', REFRESH)
  const payment = useApiMutation<{ p: Record<string, unknown> }, Posted>('post_payment', REFRESH)
  const m = dir === 'receipt' ? receipt : payment
  const error = m.error as RpcError | null
  const showError = error && !(error.rule === 'cash.payment_over_limit' && needReason)

  function reset(next: Direction) {
    setDir(next)
    setNeedReason(false)
    setReason('')
    setErrors({})
    receipt.reset()
    payment.reset()
  }

  function submit() {
    const amt = cleanAmount(amount)
    const e: typeof errors = {}
    if (!amt || Number(amt) <= 0) e.amount = t('cashBook.entry.errAmount')
    if (!party && !counter) e.counter = t('cashBook.entry.errCounter')
    if (needReason && reason.trim().length < 5) e.reason = t('cashBook.reasonShort')
    setErrors(e)
    if (Object.keys(e).length) return
    setDone(null)
    const p: Record<string, unknown> = {
      company_id: companyId,
      party_id: party || null,
      counter_account_id: party ? null : counter,
      date,
      mode: 'cash',
      account_id: account.id,
      amount: amt,
      allocations: [],
      narration: narration.trim() || null,
    }
    if (needReason) p.cash_reason = reason.trim()
    m.mutate(
      { p },
      {
        onSuccess: (res) => {
          setDone(res)
          setAmount('')
          setNarration('')
          setReason('')
          setNeedReason(false)
        },
        onError: (err) => {
          if (err.rule === 'cash.payment_over_limit') setNeedReason(true)
        },
      },
    )
  }

  return (
    <Card title={t('cashBook.entry.title')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <Tabs
          variant="segmented"
          label={t('cashBook.entry.direction')}
          value={dir}
          onChange={reset}
          tabs={[
            { key: 'receipt', label: t('cashBook.entry.received') },
            { key: 'payment', label: t('cashBook.entry.paid') },
          ]}
        />
        <Field type="date" label={t('cashBook.entry.date')} value={date} max={todayIst()} onChange={(e) => setDate(e.target.value)} />
        <SelectField
          label={dir === 'receipt' ? t('cashBook.entry.from') : t('cashBook.entry.to')}
          value={party}
          onChange={(e) => setParty(e.target.value)}
          placeholder={t('cashBook.entry.noParty')}
          options={parties.list.map((p) => ({ value: p.id, label: p.name }))}
        />
        {!party ? (
          <SelectField
            label={t('cashBook.entry.counter')}
            value={counter}
            onChange={(e) => setCounter(e.target.value)}
            placeholder={t('cashBook.entry.choose')}
            error={errors.counter}
            options={accounts.list.filter((a) => a.id !== account.id).map((a) => ({ value: a.id, label: `${a.name} · ${a.group_name}` }))}
          />
        ) : null}
        <Field label={t('cashBook.entry.amount')} prefix="₹" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} error={errors.amount} />
        <Field label={t('cashBook.entry.narration')} value={narration} onChange={(e) => setNarration(e.target.value)} />
        {needReason ? (
          <div className="sf-alert" data-tone="danger" role="alert" style={{ flexDirection: 'column' }}>
            <strong>{t('cashBook.entry.overLimitTitle')}</strong>
            <span>{t('cashBook.entry.overLimitBody')}</span>
          </div>
        ) : null}
        {needReason ? <TextAreaField label={t('cashBook.entry.reason')} value={reason} onChange={(e) => setReason(e.target.value)} error={errors.reason} /> : null}
        {showError ? <MoneyErrorBox error={error} /> : null}
        {done ? (
          <div role="status" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Chip tone="success" icon="check">
              {t('cashBook.entry.posted', { no: done.doc_no })}
            </Chip>
            {done.warning === 'over_limit' ? (
              <Chip tone="signal" icon="alert">
                {t('cashBook.flagged')}
              </Chip>
            ) : null}
          </div>
        ) : null}
        <Button type="submit" variant="primary" busy={m.isPending}>
          {needReason ? t('cashBook.entry.payAnyway') : dir === 'receipt' ? t('cashBook.entry.postReceipt') : t('cashBook.entry.postPayment')}
        </Button>
      </form>
    </Card>
  )
}

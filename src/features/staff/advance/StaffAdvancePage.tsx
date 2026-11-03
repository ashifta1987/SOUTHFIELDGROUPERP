import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useStaffMe } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { Button, Field, SelectField, Skeleton, TextAreaField } from '@/ui'
import { NotLinked, RequestLine, SegRadio, StaffErrorBox, StaffSubHeader } from '../common'

type Months = '1' | '2' | '3' | '6'
interface Args extends Record<string, unknown> {
  p: { kind: 'advance'; amount: string; repay_months: number; needed_by: string | null; paid_in: 'cash' | 'bank'; reason: string }
}

/**
 * Staff app: request an advance (`StaffAdvance`). Someone else decides it; the cash or bank payment is then recorded on
 * "Cash given to staff" and payroll recovers it. How much can be cut from one month's pay is decided on the server
 * when payroll runs, so this screen shows no limit of its own.
 */
export function StaffAdvancePage() {
  const { t } = useTranslation()
  const me = useStaffMe()
  const data = me.data?.status === 'ready' ? me.data.data : null
  const [amount, setAmount] = useState('')
  const [months, setMonths] = useState<Months>('1')
  const [neededBy, setNeededBy] = useState('')
  const [paidIn, setPaidIn] = useState<'cash' | 'bank'>('cash')
  const [reason, setReason] = useState('')
  const [sent, setSent] = useState(false)
  const submit = useApiMutation<Args, { id: string }>('submit_staff_request', [['api', 'staff_me'], ['api', 'staff_requests']])

  const cleaned = amount.replace(/[,\s₹]/g, '')
  const amountOk = /^\d+(\.\d{1,2})?$/.test(cleaned) && Number(cleaned) > 0

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSent(false)
    submit.mutate(
      { p: { kind: 'advance', amount: cleaned, repay_months: Number(months), needed_by: neededBy || null, paid_in: paidIn, reason: reason.trim() } },
      {
        onSuccess: () => {
          setSent(true)
          setAmount('')
          setReason('')
        },
      },
    )
  }

  const advances = (data?.requests ?? []).filter((r) => r.kind === 'advance')

  return (
    <>
      <StaffSubHeader
        title={t('staffAdvance.title')}
        action={
          <Link to="/staff/leave" style={{ fontSize: 14, fontWeight: 600, padding: '0 6px' }}>
            {t('staffAdvance.leaveLink')}
          </Link>
        }
      />
      <div className="sf-phone-body">
        {me.isLoading ? (
          <Skeleton height={200} />
        ) : !data ? (
          <NotLinked />
        ) : (
          <form onSubmit={onSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Field
              label={t('staffAdvance.amount')}
              prefix="₹"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mono"
              autoComplete="off"
              error={amount && !amountOk ? t('staffAdvance.amountFormat') : undefined}
            />
            <div className="sf-phone-note" style={{ fontSize: 13 }}>
              {t('staffAdvance.cutNote')}
            </div>
            <SegRadio<Months>
              legend={t('staffAdvance.payBack')}
              name="repay"
              value={months}
              onChange={setMonths}
              options={[
                { value: '1', label: t('staffAdvance.oneMonth') },
                { value: '2', label: '2' },
                { value: '3', label: '3' },
                { value: '6', label: '6' },
              ]}
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label={t('staffAdvance.neededBy')} type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} />
              <SelectField
                label={t('staffAdvance.paidIn')}
                value={paidIn}
                onChange={(e) => setPaidIn(e.target.value as 'cash' | 'bank')}
                options={[
                  { value: 'cash', label: t('staffAdvance.cash') },
                  { value: 'bank', label: t('staffAdvance.bank') },
                ]}
              />
            </div>
            <TextAreaField label={t('staffAdvance.reason')} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} />
            <section className="sf-phone-line" style={{ justifyContent: 'space-between' }} aria-label={t('staffApp.goesTo')}>
              <span className="muted">{t('staffApp.goesTo')}</span>
              <span style={{ textAlign: 'right' }}>{t('staffApp.goesToValue')}</span>
            </section>
            <StaffErrorBox error={submit.error} />
            {sent ? (
              <div className="sf-phone-note" role="status">
                {t('staffApp.sent')}
              </div>
            ) : null}
            <Button type="submit" variant="primary" size="hero" busy={submit.isPending} disabled={!amountOk || reason.trim().length < 3}>
              {t('staffApp.send')}
            </Button>
          </form>
        )}
        {advances.length ? (
          <section className="sf-phone-section" aria-labelledby="adv-mine">
            <h2 id="adv-mine">{t('staffAdvance.mine')}</h2>
            {advances.map((r) => (
              <RequestLine key={r.id} r={r} />
            ))}
          </section>
        ) : null}
      </div>
    </>
  )
}

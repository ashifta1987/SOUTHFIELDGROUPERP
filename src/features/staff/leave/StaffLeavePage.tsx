import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useStaffMe } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { Button, Checkbox, Field, Skeleton, TextAreaField } from '@/ui'
import { NotLinked, RequestLine, SegRadio, StaffErrorBox, StaffSubHeader } from '../common'

type LeaveType = 'casual' | 'sick' | 'unpaid'
interface Args extends Record<string, unknown> {
  p: { kind: 'leave'; leave_type: LeaveType; from_date: string; to_date: string; half_day: boolean; reason: string }
}

/**
 * Staff app: request leave (`StaffLeave`). The request goes to someone else to decide (never the person themselves);
 * api.submit_staff_request checks the dates, the half day and the reason. Answers show here and on WhatsApp.
 */
export function StaffLeavePage() {
  const { t } = useTranslation()
  const me = useStaffMe()
  const data = me.data?.status === 'ready' ? me.data.data : null
  const [type, setType] = useState<LeaveType>('casual')
  const [from, setFrom] = useState(todayIst())
  const [to, setTo] = useState(todayIst())
  const [half, setHalf] = useState(false)
  const [reason, setReason] = useState('')
  const [sent, setSent] = useState(false)
  const submit = useApiMutation<Args, { id: string }>('submit_staff_request', [['api', 'staff_me'], ['api', 'staff_requests']])

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSent(false)
    submit.mutate(
      { p: { kind: 'leave', leave_type: type, from_date: from, to_date: half ? from : to, half_day: half, reason: reason.trim() } },
      {
        onSuccess: () => {
          setSent(true)
          setReason('')
        },
      },
    )
  }

  const leaves = (data?.requests ?? []).filter((r) => r.kind === 'leave')
  const leaveThisMonth = data?.attendance?.leave

  return (
    <>
      <StaffSubHeader
        title={t('staffLeave.title')}
        action={
          <Link to="/staff/advance" style={{ fontSize: 14, fontWeight: 600, padding: '0 6px' }}>
            {t('staffLeave.advanceLink')}
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
            <SegRadio<LeaveType>
              legend={t('staffLeave.type')}
              name="leave-type"
              value={type}
              onChange={setType}
              options={[
                { value: 'casual', label: t('staffApp.leaveType.casual') },
                { value: 'sick', label: t('staffApp.leaveType.sick') },
                { value: 'unpaid', label: t('staffApp.leaveType.unpaid') },
              ]}
              hint={t('staffLeave.typeHint')}
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label={t('staffLeave.from')} type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
              <Field label={t('staffLeave.to')} type="date" value={half ? from : to} min={from} onChange={(e) => setTo(e.target.value)} disabled={half} required />
            </div>
            <Checkbox label={t('staffLeave.halfDay')} checked={half} onChange={(e) => setHalf(e.target.checked)} />
            <TextAreaField label={t('staffLeave.reason')} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} />
            <section className="sf-phone-line" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }} aria-label={t('staffLeave.summary')}>
              <span style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="muted">{t('staffLeave.leaveThisMonth')}</span>
                <span className="mono" style={{ fontWeight: 600 }}>
                  {leaveThisMonth != null ? t('staffLeave.days', { n: Number(leaveThisMonth) }) : '—'}
                </span>
              </span>
              <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span className="muted">{t('staffApp.goesTo')}</span>
                <span style={{ textAlign: 'right' }}>{t('staffApp.goesToValue')}</span>
              </span>
            </section>
            <StaffErrorBox error={submit.error} />
            {sent ? (
              <div className="sf-phone-note" role="status">
                {t('staffApp.sent')}
              </div>
            ) : null}
            <Button type="submit" variant="primary" size="hero" busy={submit.isPending} disabled={reason.trim().length < 3}>
              {t('staffApp.send')}
            </Button>
          </form>
        )}
        {leaves.length ? (
          <section className="sf-phone-section" aria-labelledby="leave-mine">
            <h2 id="leave-mine">{t('staffLeave.mine')}</h2>
            {leaves.map((r) => (
              <RequestLine key={r.id} r={r} />
            ))}
          </section>
        ) : null}
      </div>
    </>
  )
}

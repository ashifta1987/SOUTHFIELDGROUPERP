import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useApiRpc, useStaffMe } from '@/data/queries'
import { callApi } from '@/data/rpc'
import { formatIndian } from '@/shared/format'
import { Amount, Button, ErrorRef, Icon, Skeleton } from '@/ui'
import { NotLinked, StaffSubHeader } from '../common'

interface Payslip {
  id: string
  person_id: string
  person_name: string
  company_name: string | null
  month: string
  days_in_month: number
  present: number | string
  half_days: number
  leave_days: number
  weekly_off: number
  payable_days: number | string
  ot_hours: number | string
  basic: number | string
  allowances: number | string
  ot_pay: number | string
  gross: number | string
  advance_recovery: number | string
  deductions: number | string
  round_off: number | string
  net: number | string
  net_in_words: string | null
}

function monthLabel(iso: string, lang: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00+05:30`)
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-IN' : lang, { month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(d)
}

function Line({ label, children, strong, minus }: { label: ReactNode; children: ReactNode; strong?: boolean; minus?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontWeight: strong ? 700 : 400, color: strong ? 'var(--sf-text)' : 'var(--sf-text-2)' }}>
      <span>{label}</span>
      <span className="mono" style={minus ? { color: 'var(--sf-danger-ink)' } : undefined}>
        {children}
      </span>
    </div>
  )
}

/**
 * Staff app: payslip (`StaffPayslip`). Lists only the person's own posted payslips (api.staff_me → payslips) and opens
 * one with api.payslip, which refuses anyone else's slip without the Payroll right. Every figure comes from the payroll
 * run; nothing is worked out on the phone.
 */
export function StaffPayslipPage() {
  const { t, i18n } = useTranslation()
  const me = useStaffMe()
  const data = me.data?.status === 'ready' ? me.data.data : null
  const list = data?.payslips ?? []
  const [chosen, setChosen] = useState<string | null>(null)
  const id = chosen ?? list[0]?.id ?? null
  const slip = useApiRpc<Payslip | null>('payslip', { p_payslip_id: id }, Boolean(id))
  const s = slip.data?.status === 'ready' ? slip.data.data : null
  const selectId = useId()
  const lang = i18n.resolvedLanguage ?? 'en'

  async function printSlip() {
    try {
      await callApi('log_user_event', { p_event: 'print', p_detail: { entity: 'payslip', id } }, { idempotent: false })
    } catch {
      /* printing still works; the event log is best effort */
    }
    window.print()
  }

  return (
    <>
      <StaffSubHeader
        title={t('staffPayslip.title')}
        action={
          list.length > 1 ? (
            <>
              <label htmlFor={selectId} className="sr-only">
                {t('staffPayslip.month')}
              </label>
              <select id={selectId} className="sf-input" style={{ width: 'auto', height: 44 }} value={id ?? ''} onChange={(e) => setChosen(e.target.value)}>
                {list.map((p) => (
                  <option key={p.id} value={p.id}>
                    {monthLabel(p.month, lang)}
                    {p.company_label ? ` · ${p.company_label}` : ''}
                  </option>
                ))}
              </select>
            </>
          ) : null
        }
      />
      <div className="sf-phone-body">
        {me.isLoading ? (
          <Skeleton height={260} />
        ) : !data ? (
          <NotLinked />
        ) : list.length === 0 ? (
          <div className="sf-phone-note">{t('staffPayslip.none')}</div>
        ) : slip.isLoading ? (
          <Skeleton height={260} />
        ) : slip.error || !s ? (
          <ErrorRef message={t('errors.loadFailed')} next={t('errors.tryAgain')} refId="PAYSLIP" />
        ) : (
          <>
            <section className="sf-phone-card" aria-labelledby="slip-h" style={{ gap: 8, fontSize: 15 }}>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <h2 id="slip-h" style={{ margin: 0, fontSize: 17, color: 'var(--sf-text)', fontWeight: 700 }}>
                  {s.person_name}
                </h2>
                <span className="muted" style={{ fontSize: 13 }}>
                  <span className="mono">{data.person_code}</span>
                  {s.company_name ? ` · ${s.company_name}` : ''} · {monthLabel(s.month, lang)}
                </span>
              </div>
              <Line label={t('staffPayslip.daysPaid')}>{t('staffPayslip.of', { a: formatIndian(s.payable_days, 1).replace(/\.0$/, ''), b: s.days_in_month })}</Line>
              <Line label={t('staffPayslip.present')}>{formatIndian(s.present, 1).replace(/\.0$/, '')}</Line>
              {Number(s.half_days) ? <Line label={t('staffPayslip.halfDays')}>{s.half_days}</Line> : null}
              {Number(s.leave_days) ? <Line label={t('staffPayslip.leave')}>{s.leave_days}</Line> : null}
              {Number(s.ot_hours) ? <Line label={t('staffPayslip.otHours')}>{formatIndian(s.ot_hours, 2)}</Line> : null}
              <Line label={t('staffPayslip.earned')}>
                <Amount value={s.basic} />
              </Line>
              {Number(s.allowances) ? (
                <Line label={t('staffPayslip.allowances')}>
                  <Amount value={s.allowances} />
                </Line>
              ) : null}
              {Number(s.ot_pay) ? (
                <Line label={t('staffPayslip.otPay')}>
                  <Amount value={s.ot_pay} />
                </Line>
              ) : null}
              <Line label={t('staffPayslip.gross')} strong>
                <Amount value={s.gross} />
              </Line>
              {Number(s.advance_recovery) ? (
                <Line label={t('staffPayslip.advance')} minus>
                  − {formatIndian(s.advance_recovery, 2)}
                </Line>
              ) : null}
              {Number(s.deductions) ? (
                <Line label={t('staffPayslip.deductions')} minus>
                  − {formatIndian(s.deductions, 2)}
                </Line>
              ) : null}
              {Number(s.round_off) ? (
                <Line label={t('staffPayslip.roundOff')}>
                  {Number(s.round_off) > 0 ? '+ ' : '− '}
                  {formatIndian(Math.abs(Number(s.round_off)), 2)}
                </Line>
              ) : null}
              <div style={{ borderTop: '2px solid var(--sf-text)', marginTop: 6, paddingTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontWeight: 700, fontSize: 17 }}>{t('staffPayslip.paid')}</span>
                <span className="mono" data-testid="payslip-net" style={{ fontWeight: 700, fontSize: 26 }}>
                  ₹{formatIndian(s.net, 0)}
                </span>
              </div>
              {s.net_in_words ? <span className="muted" style={{ fontSize: 13 }}>{s.net_in_words}</span> : null}
            </section>
            <Button size="touch" onClick={() => void printSlip()}>
              <Icon name="file" size={18} />
              {t('staffPayslip.print')}
            </Button>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {t('staffPayslip.source', { month: monthLabel(s.month, lang) })}
            </p>
          </>
        )}
      </div>
    </>
  )
}

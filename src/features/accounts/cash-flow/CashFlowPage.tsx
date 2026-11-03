import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { currentFyStartYear, fyLabel, todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { MoneyErrorBox, useReadRpc } from '@/features/accounts/cash-book/money'
import { formatDate, formatIndian } from '@/shared/format'
import { Amount, Button, Card, EmptyState, KpiTiles, PageHeader, SelectField, Skeleton } from '@/ui'

type Num = number | string
interface CashFlowSummary {
  opening: Num
  closing: Num
  min_balance: Num | null
  accounts: number
  months: { month: string; money_in: Num; money_out: Num; net: Num }[]
  avg_in: Num | null
  avg_out: Num | null
  lowest: { day: string; balance: Num } | null
  days_with_entries: number
  days_below: number | null
  weeks: { week_start: string; due_in: Num; due_out: Num }[]
}

const MONTH_SHORT = new Intl.DateTimeFormat('en-IN', { month: 'short', timeZone: 'UTC' })
function shortMonth(iso: string): string {
  const [y, m] = iso.split('-').map(Number)
  return MONTH_SHORT.format(new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, 1)))
}
function shortDay(iso: string): string {
  return formatDate(iso).slice(0, 5)
}

/** Column pairs (in / out) per month. Heights scale to the largest server figure; the figures are in the table under it. */
function MonthColumns({ months, label }: { months: CashFlowSummary['months']; label: string }) {
  const { t } = useTranslation()
  const max = Math.max(1, ...months.flatMap((m) => [Number(m.money_in), Number(m.money_out)]))
  const H = 180
  return (
    <figure style={{ margin: 0 }} aria-label={label}>
      <div className="sf-legend" aria-hidden="true">
        <span>
          <i className="sf-legend__sw" style={{ background: 'var(--sf-success)' }} />
          {t('cashFlow.chart.in')}
        </span>
        <span>
          <i className="sf-legend__sw" style={{ background: 'var(--sf-danger)' }} />
          {t('cashFlow.chart.out')}
        </span>
      </div>
      <div aria-hidden="true" style={{ display: 'grid', gridTemplateColumns: `repeat(${months.length}, minmax(0, 1fr))`, gap: 12, alignItems: 'end', height: H, borderBottom: '1px solid var(--sf-line)' }}>
        {months.map((m) => (
          <div key={m.month} style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: '100%', justifyContent: 'center' }}>
            <span style={{ width: '45%', maxWidth: 28, background: 'var(--sf-success)', height: `${(Number(m.money_in) / max) * 100}%`, borderRadius: '3px 3px 0 0' }} />
            <span style={{ width: '45%', maxWidth: 28, background: 'var(--sf-danger)', height: `${(Number(m.money_out) / max) * 100}%`, borderRadius: '3px 3px 0 0' }} />
          </div>
        ))}
      </div>
      <figcaption className="sr-only">{label}</figcaption>
    </figure>
  )
}

/**
 * Cash flow and reminders (`CashFlow`): money in and out of the company's cash and bank accounts by month, the lowest
 * combined balance and the days below the minimum set on Settings (api.cash_flow_summary), and what falls due in the
 * next 13 weeks from open receivables and payables. Reminder sending arrives with WhatsApp reminders (Phase 6).
 */
export function CashFlowPage() {
  const { t } = useTranslation()
  const { list, companyId, choose, isLoading } = useCompanyChoice()
  const thisFy = currentFyStartYear()
  const [fy, setFy] = useState(thisFy)
  const from = `${fy}-04-01`
  const to = fy === thisFy ? todayIst() : `${fy + 1}-03-31`
  const q = useReadRpc<CashFlowSummary>('cash_flow_summary', { p_company_id: companyId, p_from: from, p_to: to }, Boolean(companyId))
  const s = q.data
  const lakh = (v: Num | null | undefined) => (v === null || v === undefined ? '—' : `₹${formatIndian(Number(v) / 100000, 2)} L`)

  return (
    <>
      <PageHeader
        title={t('cashFlow.title')}
        subtitle={t('cashFlow.subtitle')}
        actions={
          <>
            <Link to={`/purchase/bills-and-payments?tab=payables${companyId ? `&company=${companyId}` : ''}`} className="sf-btn" data-variant="secondary">
              {t('cashFlow.paymentRun')}
            </Link>
            <Button variant="primary" comingInPhase={6}>
              {t('cashFlow.reminderSettings')}
            </Button>
          </>
        }
      />
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <CompanyPicker list={list} value={companyId} onChange={choose} />
        <div style={{ minWidth: 180 }}>
          <SelectField
            label={t('cashFlow.fy')}
            value={String(fy)}
            onChange={(e) => setFy(Number(e.target.value))}
            options={[thisFy, thisFy - 1].map((y) => ({ value: String(y), label: t('cashFlow.fyLabel', { fy: fyLabel(y) }) }))}
          />
        </div>
      </div>

      {isLoading ? (
        <Card>
          <Skeleton height={80} />
        </Card>
      ) : !companyId ? (
        <Card>
          <EmptyState title={t('cashFlow.noCompany')} />
        </Card>
      ) : q.error ? (
        <Card>
          <MoneyErrorBox error={q.error} />
        </Card>
      ) : (
        <>
          <KpiTiles
            ariaLabel={t('cashFlow.kpis')}
            items={[
              { key: 'in', label: t('cashFlow.kpi.avgIn'), value: s ? <span data-testid="avg-in">{lakh(s.avg_in)}</span> : <Skeleton width={90} />, sub: t('cashFlow.kpi.period', { fy: fyLabel(fy), n: s?.accounts ?? 0 }) },
              { key: 'out', label: t('cashFlow.kpi.avgOut'), value: s ? lakh(s.avg_out) : <Skeleton width={90} />, sub: t('cashFlow.kpi.same') },
              {
                key: 'low',
                label: t('cashFlow.kpi.lowest'),
                value: s ? s.lowest ? <Amount value={s.lowest.balance} rupee /> : '—' : <Skeleton width={90} />,
                sub: s?.lowest ? t('cashFlow.kpi.on', { d: formatDate(s.lowest.day) }) : t('cashFlow.kpi.noEntries'),
              },
              {
                key: 'below',
                label: s?.min_balance !== null && s?.min_balance !== undefined ? t('cashFlow.kpi.below', { min: formatIndian(s.min_balance, 0) }) : t('cashFlow.kpi.belowUnset'),
                value: s ? <span className="mono">{s.days_below ?? '—'}</span> : <Skeleton width={60} />,
                sub: s ? (s.min_balance === null ? t('cashFlow.kpi.setMin') : t('cashFlow.kpi.ofDays', { n: s.days_with_entries })) : undefined,
              },
            ]}
          />

          <Card title={t('cashFlow.chart.title', { fy: fyLabel(fy) })}>
            {q.isLoading ? (
              <Skeleton height={180} />
            ) : !s || s.months.length === 0 ? (
              <EmptyState title={t('cashFlow.chart.emptyTitle')} body={t('cashFlow.chart.emptyBody')} />
            ) : (
              <>
                <MonthColumns months={s.months} label={t('cashFlow.chart.title', { fy: fyLabel(fy) })} />
                <div className="sf-table-wrap" style={{ marginTop: 8 }}>
                  <table className="sf-table">
                    <caption className="sr-only">{t('cashFlow.chart.table')}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('cashFlow.chart.month')}</th>
                        <th scope="col" className="r">
                          {t('cashFlow.chart.in')}
                        </th>
                        <th scope="col" className="r">
                          {t('cashFlow.chart.out')}
                        </th>
                        <th scope="col" className="r">
                          {t('cashFlow.chart.net')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.months.map((m) => (
                        <tr key={m.month}>
                          <td>{shortMonth(m.month)}</td>
                          <td className="r">
                            <Amount value={m.money_in} />
                          </td>
                          <td className="r">
                            <Amount value={m.money_out} />
                          </td>
                          <td className="r">
                            <Amount value={m.net} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="k" style={{ marginBottom: 0 }}>
                  {t('cashFlow.chart.note')}
                </p>
              </>
            )}
          </Card>

          <TableCard title={t('cashFlow.weeks.title', { n: s?.weeks.length ?? 13 })}>
            <p className="k sf-card__pad" style={{ margin: 0, paddingTop: 0 }}>
              {t('cashFlow.weeks.body')}
            </p>
            <div className="sf-table-wrap">
              <table className="sf-table">
                <caption className="sr-only">{t('cashFlow.weeks.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('cashFlow.weeks.week')}</th>
                    <th scope="col" className="r">
                      {t('cashFlow.weeks.dueIn')}
                    </th>
                    <th scope="col" className="r">
                      {t('cashFlow.weeks.dueOut')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {q.isLoading || !s ? (
                    <tr className="sf-table__state">
                      <td colSpan={3}>
                        <Skeleton />
                      </td>
                    </tr>
                  ) : (
                    s.weeks.map((w) => (
                      <tr key={w.week_start}>
                        <td className="mono">{shortDay(w.week_start)}</td>
                        <td className="r">
                          <Amount value={w.due_in} />
                        </td>
                        <td className="r">
                          <Amount value={w.due_out} />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </TableCard>

          <TableCard title={t('cashFlow.reminders.title')} action={<span className="k">{t('cashFlow.reminders.channels')}</span>}>
            <div className="sf-table-wrap">
              <table className="sf-table">
                <caption className="sr-only">{t('cashFlow.reminders.title')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('cashFlow.reminders.what')}</th>
                    <th scope="col">{t('cashFlow.reminders.when')}</th>
                    <th scope="col">{t('cashFlow.reminders.to')}</th>
                    <th scope="col">{t('cashFlow.reminders.then')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(['buyer', 'supplier', 'msme', 'salaries', 'statutory', 'emi', 'low'] as const).map((k) => (
                    <tr key={k}>
                      <th scope="row" style={{ fontWeight: 600 }}>
                        {t(`cashFlow.reminders.rows.${k}.what`)}
                      </th>
                      <td>{t(`cashFlow.reminders.rows.${k}.when`)}</td>
                      <td>{t(`cashFlow.reminders.rows.${k}.to`)}</td>
                      <td>{t(`cashFlow.reminders.rows.${k}.then`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="k sf-card__pad" style={{ margin: 0 }}>
              {t('cashFlow.reminders.note')}
            </p>
          </TableCard>
        </>
      )}
    </>
  )
}

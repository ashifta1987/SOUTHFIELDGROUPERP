import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { CashLimitText, fyStartOf, moneyAccountLabel, MoneyErrorBox, useMoneyAccounts, useReadRpc } from '@/features/accounts/cash-book/money'
import { formatDate } from '@/shared/format'
import { Amount, Card, EmptyState, Field, KpiTiles, PageHeader, SelectField, Skeleton } from '@/ui'

type Num = number | string

interface MonthRow {
  month: string
  days: number
  opening: Num
  received: Num
  paid: Num
  received_lines: number
  paid_lines: number
  closing: Num
}
interface SideRow {
  account_id: string
  account_name: string
  kind: string
  dir: 'in' | 'out'
  amount: Num
  vouchers: number
}
interface CashBookSummary {
  opening: Num
  received: Num
  paid: Num
  received_lines: number
  paid_lines: number
  closing: Num
  months: MonthRow[]
  where: SideRow[]
  into_bank: { amount: Num; times: number }
  flagged: { count: number; amount: Num }
  reversed: number
  cash_given: { count: number; amount: Num }
}

/** Horizontal bars for a list of server amounts (widths only; every figure shown is the server's). */
function Bars({ rows, label }: { rows: { key: string; label: string; amount: Num }[]; label: string }) {
  const max = Math.max(1, ...rows.map((r) => Number(r.amount)))
  return (
    <ul aria-label={label} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.map((r) => (
        <li key={r.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr) 110px', gap: 12, alignItems: 'center', fontSize: 13 }}>
          <span>{r.label}</span>
          <span aria-hidden="true" style={{ background: 'var(--sf-line-faint)', borderRadius: 4, height: 12, display: 'block' }}>
            <span style={{ display: 'block', height: 12, borderRadius: 4, background: 'var(--sf-info)', width: `${Math.max(2, (Number(r.amount) / max) * 100)}%` }} />
          </span>
          <span className="r">
            <Amount value={r.amount} digits={0} />
          </span>
        </li>
      ))}
    </ul>
  )
}

function monthLabel(iso: string): string {
  const [y, m] = iso.split('-').map(Number)
  return new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, 1)))
}

/**
 * Cash book check (`CashBookCheck`): one cash account over a range (default: this financial year), worked out by
 * api.cash_book_summary — month by month, where the cash went, cash paid into the bank, cash given to staff,
 * payments flagged over the cash limit, and reversals. The Tally comparison and the mixer-grinder sheet from the
 * reference need the Tally import of the same books; until then the card says so.
 */
export function CashBookCheckPage() {
  const { t } = useTranslation()
  const { list, companyId, choose, isLoading } = useCompanyChoice()
  const cash = useMoneyAccounts(companyId, 'cash')
  const [pick, setPick] = useState('')
  const account = cash.list.find((a) => a.id === pick) ?? cash.list[0]
  const today = todayIst()
  const [from, setFrom] = useState(fyStartOf(today))
  const [to, setTo] = useState(today)
  const q = useReadRpc<CashBookSummary>('cash_book_summary', { p_account_id: account?.id, p_from: from, p_to: to }, Boolean(account) && Boolean(from) && Boolean(to))
  const s = q.data

  const out = (s?.where ?? []).filter((w) => w.dir === 'out')
  const inn = (s?.where ?? []).filter((w) => w.dir === 'in')
  const money = (v: Num | undefined) => (s && v !== undefined ? <Amount value={v} rupee /> : <Skeleton width={90} />)

  return (
    <>
      <PageHeader
        title={t('cashBookCheck.title')}
        subtitle={account ? t('cashBookCheck.subtitle', { account: moneyAccountLabel(account), from: formatDate(from), to: formatDate(to) }) : t('cashBookCheck.subtitleNone')}
        actions={
          <Link to={`/accounts/cash-book${companyId ? `?company=${companyId}` : ''}`} style={{ fontWeight: 600, fontSize: 13 }}>
            {t('cashBookCheck.dayView')}
          </Link>
        }
      />
      <CompanyPicker list={list} value={companyId} onChange={choose} />

      {isLoading || cash.isLoading ? (
        <Card>
          <Skeleton height={80} />
        </Card>
      ) : !account ? (
        <Card>
          <EmptyState
            title={t('cashBook.noCashTitle')}
            body={t('cashBook.noCashBody')}
            action={
              <Link to="/accounts/bank?tab=setup" style={{ fontWeight: 600, fontSize: 13 }}>
                {t('cashBook.toSetup')}
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 260 }}>
              <SelectField label={t('cashBook.cashAccount')} value={account.id} onChange={(e) => setPick(e.target.value)} options={cash.list.map((a) => ({ value: a.id, label: moneyAccountLabel(a) }))} />
            </div>
            <Field type="date" label={t('common.from')} value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            <Field type="date" label={t('common.to')} value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} />
          </div>

          {q.error ? (
            <Card>
              <MoneyErrorBox error={q.error} />
            </Card>
          ) : (
            <>
              <KpiTiles
                ariaLabel={t('cashBookCheck.kpis')}
                items={[
                  { key: 'in', label: t('cashBookCheck.kpi.received', { n: s?.received_lines ?? 0 }), value: money(s?.received) },
                  { key: 'out', label: t('cashBookCheck.kpi.paid', { n: s?.paid_lines ?? 0 }), value: money(s?.paid) },
                  { key: 'bank', label: t('cashBookCheck.kpi.intoBank', { n: s?.into_bank.times ?? 0 }), value: money(s?.into_bank.amount) },
                  {
                    key: 'staff',
                    label: t('cashBookCheck.kpi.staff', { n: s?.cash_given.count ?? 0 }),
                    value: money(s?.cash_given.amount),
                    sub: <Link to="/hr-and-payroll/cash-given-to-staff">{t('cashBookCheck.kpi.byStaff')}</Link>,
                  },
                  {
                    key: 'box',
                    label: t('cashBookCheck.kpi.box', { d: formatDate(to) }),
                    value: <span data-testid="check-closing">{money(s?.closing)}</span>,
                    sub: s ? (
                      <span>
                        {t('cashBookCheck.kpi.openingWas')} <Amount value={s.opening} rupee />
                      </span>
                    ) : undefined,
                  },
                ]}
              />

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: 16, alignItems: 'start' }}>
                <TableCard title={t('cashBookCheck.months.title')}>
                  <div className="sf-table-wrap">
                    <table className="sf-table">
                      <caption className="sr-only">{t('cashBookCheck.months.title')}</caption>
                      <thead>
                        <tr>
                          <th scope="col">{t('cashBookCheck.months.month')}</th>
                          <th scope="col" className="r">
                            {t('cashBookCheck.months.days')}
                          </th>
                          <th scope="col" className="r">
                            {t('cashBookCheck.months.opening')}
                          </th>
                          <th scope="col" className="r">
                            {t('cashBookCheck.months.received')}
                          </th>
                          <th scope="col" className="r">
                            {t('cashBookCheck.months.paid')}
                          </th>
                          <th scope="col" className="r">
                            {t('cashBookCheck.months.closing')}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {q.isLoading ? (
                          <tr className="sf-table__state">
                            <td colSpan={6}>
                              <Skeleton />
                            </td>
                          </tr>
                        ) : (s?.months.length ?? 0) === 0 ? (
                          <tr className="sf-table__state">
                            <td colSpan={6}>{t('cashBookCheck.months.empty')}</td>
                          </tr>
                        ) : (
                          s?.months.map((m) => (
                            <tr key={m.month}>
                              <td>{monthLabel(m.month)}</td>
                              <td className="r mono">{m.days}</td>
                              <td className="r">
                                <Amount value={m.opening} />
                              </td>
                              <td className="r">
                                <Amount value={m.received} />
                              </td>
                              <td className="r">
                                <Amount value={m.paid} />
                              </td>
                              <td className="r">
                                <Amount value={m.closing} />
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                      {s && s.months.length ? (
                        <tfoot>
                          <tr>
                            <th scope="row">{t('cashBookCheck.months.total')}</th>
                            <td />
                            <td className="r">
                              <Amount value={s.opening} />
                            </td>
                            <td className="r">
                              <Amount value={s.received} />
                            </td>
                            <td className="r">
                              <Amount value={s.paid} />
                            </td>
                            <td className="r">
                              <Amount value={s.closing} />
                            </td>
                          </tr>
                        </tfoot>
                      ) : null}
                    </table>
                  </div>
                </TableCard>

                <Card title={t('cashBookCheck.where.title')}>
                  <p className="k" style={{ marginTop: 0 }}>
                    {t('cashBookCheck.where.sub')} {s ? <Amount value={s.paid} rupee /> : null}
                  </p>
                  {q.isLoading ? (
                    <Skeleton height={60} />
                  ) : out.length === 0 ? (
                    <p className="muted" style={{ margin: 0 }}>
                      {t('cashBookCheck.where.empty')}
                    </p>
                  ) : (
                    <Bars label={t('cashBookCheck.where.title')} rows={out.slice(0, 15).map((w) => ({ key: w.account_id, label: w.account_name, amount: w.amount }))} />
                  )}
                  {inn.length ? (
                    <div style={{ marginTop: 16 }}>
                      <h3 className="sf-field__label" style={{ margin: '0 0 8px' }}>
                        {t('cashBookCheck.where.receivedFrom')}
                      </h3>
                      <Bars label={t('cashBookCheck.where.receivedFrom')} rows={inn.slice(0, 10).map((w) => ({ key: `in-${w.account_id}`, label: w.account_name, amount: w.amount }))} />
                    </div>
                  ) : null}
                </Card>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, alignItems: 'start' }}>
                <Card title={t('cashBookCheck.tally.title')}>
                  <p style={{ marginTop: 0, fontSize: 13 }}>{t('cashBookCheck.tally.body')}</p>
                  <Link to="/admin/import-data" style={{ fontWeight: 600, fontSize: 13 }}>
                    {t('cashBookCheck.tally.link')}
                  </Link>
                </Card>
                <Card title={t('cashBookCheck.limits.title')} accent="signal">
                  <p data-testid="flagged" style={{ marginTop: 0, fontSize: 13, fontWeight: 600 }}>
                    {s ? t('cashBookCheck.limits.flagged', { count: s.flagged.count }) : <Skeleton width={120} />} {s && s.flagged.count ? <Amount value={s.flagged.amount} rupee /> : null}
                  </p>
                  <CashLimitText companyId={companyId} />
                </Card>
                <Card title={t('cashBookCheck.book.title')} accent="signal">
                  <p style={{ marginTop: 0, fontSize: 13 }}>{s ? t('cashBookCheck.book.reversed', { count: s.reversed }) : <Skeleton width={120} />}</p>
                  <p className="k" style={{ margin: 0 }}>
                    {t('cashBookCheck.book.note')}
                  </p>
                </Card>
              </div>

              <Card title={t('cashBookCheck.changes.title')}>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {(['phone', 'staff', 'contra', 'close', 'withoutGst'] as const).map((k) => (
                    <li key={k}>{t(`cashBookCheck.changes.${k}`)}</li>
                  ))}
                </ul>
              </Card>
            </>
          )}
        </>
      )}
    </>
  )
}

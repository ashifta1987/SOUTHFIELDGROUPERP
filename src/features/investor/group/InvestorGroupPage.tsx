import { Fragment, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { formatDate } from '@/shared/format'
import { Card, Chip, EmptyState, Icon } from '@/ui'
import { monthLabel, roleKeys, useGroupSummary, useInvestorMe, useMoneyIn, type GroupCompany, type MoneyInRow } from '../common/investor'
import { Bars, LoadFailed, Loading, LoanBalance, Num, NotLinked, Pct, Rs } from '../common/ui'

const linkBtn = {
  height: 38,
  padding: '0 14px',
  border: '1px solid var(--sf-border-input)',
  borderRadius: 'var(--sf-radius-input)',
  background: 'var(--sf-surface)',
  color: 'var(--sf-text)',
  fontSize: 13,
  fontWeight: 600,
  display: 'inline-flex',
  alignItems: 'center',
  textDecoration: 'none',
} as const

/**
 * Investor portal · whole group, desktop (`InvestorGroup`). Figures from `investor_group_summary`: per company my
 * shares, share %, share capital, investment, the company's book net worth and the value of my shares, profit share
 * posted, my loan account and money in over 12 months; the totals row comes from the server's totals. Money in by
 * month from `v_investor_money_in`. Other shareholders' names and holdings are not shown to an investor.
 */
export function InvestorGroupPage() {
  const { t } = useTranslation()
  const { me, isLoading: meLoading } = useInvestorMe()
  const { summary, isLoading, isError } = useGroupSummary()
  const money = useMoneyIn()
  const [open, setOpen] = useState<string | null>(null)

  if (isLoading || meLoading) return <Loading />
  if (isError || !summary) return <LoadFailed />
  const companies = summary.companies
  const flags = new Set((me?.partners ?? []).flatMap((p) => roleKeys(p)))

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 'var(--sf-fs-page)', fontWeight: 700, letterSpacing: '-0.01em' }}>{t('investorGroup.title')}</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--sf-text-muted)' }}>{t('investorGroup.sub', { count: companies.length, date: formatDate(summary.as_of) })}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {[...flags].map((k) => (
              <Chip key={k} tone={k === 'legal' ? 'navy' : 'teal'}>
                {t(`investor.role.${k}`)}
              </Chip>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link to="/investor/withdraw" style={linkBtn}>
            {t('investorGroup.requestWithdrawal')}
          </Link>
          <Link to="/investor/loan" style={linkBtn}>
            {t('investorGroup.loanRequest')}
          </Link>
        </div>
      </div>

      {companies.length === 0 ? (
        <NotLinked />
      ) : (
        <>
          <section aria-label={t('investorGroup.tiles')} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
            <Tile label={t('investorGroup.asLegal')} accent="var(--sf-navy)" value={<Rs value={summary.totals.share_capital} testId="group-total-share-capital" />} sub={t('investorGroup.asLegalSub')} />
            <Tile label={t('investorGroup.asInvestment')} accent="var(--sf-primary)" value={<Rs value={summary.totals.investment} testId="group-total-investment" />} sub={t('investorGroup.asInvestmentSub')} />
            <Tile label={t('investorGroup.currentValue')} accent="var(--sf-navy)" value={<Rs value={summary.totals.value_of_my_shares} testId="group-total-value" />} sub={t('investorGroup.currentValueSub')} />
          </section>

          <section className="sf-card" aria-labelledby="grp-table">
            <h2 id="grp-table" className="sr-only">
              {t('investorGroup.tableTitle')}
            </h2>
            <div className="sf-table-wrap" tabIndex={0} role="region" aria-label={t('investorGroup.tableTitle')}>
              <table className="sf-table">
                <thead>
                  <tr>
                    <th scope="col">{t('investorGroup.col.company')}</th>
                    <th scope="col" className="r">{t('investorGroup.col.shares')}</th>
                    <th scope="col" className="r">{t('investorGroup.col.pct')}</th>
                    <th scope="col" className="r">{t('investorGroup.col.shareCapital')}</th>
                    <th scope="col" className="r">{t('investorGroup.col.investment')}</th>
                    <th scope="col" className="r">{t('investorGroup.col.netWorth')}</th>
                    <th scope="col" className="r">{t('investorGroup.col.value')}</th>
                    <th scope="col" className="r">{t('investorGroup.col.profitShare')}</th>
                    <th scope="col">
                      <span className="sr-only">{t('investorGroup.col.details')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {companies.map((c) => {
                    const isOpen = open === c.company_id
                    return (
                      <Fragment key={c.company_id}>
                        <tr className="sf-table__group" data-testid="group-row" data-company={c.company ?? ''}>
                          <td style={{ fontWeight: 600 }}>{c.company}</td>
                          <td className="r"><Num value={c.shares} testId="group-shares" /></td>
                          <td className="r"><Pct value={c.share_pct} testId="group-pct" /></td>
                          <td className="r"><Rs value={c.share_capital} testId="group-share-capital" /></td>
                          <td className="r"><Rs value={c.investment} testId="group-investment" /></td>
                          <td className="r"><Rs value={c.net_worth_book} testId="group-net-worth" /></td>
                          <td className="r"><Rs value={c.value_of_my_shares} testId="group-value" /></td>
                          <td className="r">{Number(c.profit_share_posted) ? <Rs value={c.profit_share_posted} testId="group-profit-share" /> : <span className="mono" data-testid="group-profit-share" data-value={String(c.profit_share_posted)}>—</span>}</td>
                          <td>
                            <button
                              type="button"
                              aria-expanded={isOpen}
                              aria-controls={`grp-detail-${c.company_id}`}
                              aria-label={t('investorGroup.toggle', { company: c.company ?? '' })}
                              onClick={() => setOpen(isOpen ? null : c.company_id)}
                              style={{ width: 32, height: 32, border: 0, background: 'transparent', cursor: 'pointer', color: 'var(--sf-text-2)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                            >
                              <span style={{ display: 'inline-flex', transform: isOpen ? 'rotate(180deg)' : undefined }}>
                                <Icon name="chevronDown" size={16} />
                              </span>
                            </button>
                          </td>
                        </tr>
                        {isOpen ? (
                          <tr id={`grp-detail-${c.company_id}`}>
                            <td colSpan={9} style={{ padding: 0 }}>
                              <CompanyDetail c={c} rows={money.rows.filter((r) => r.company_id === c.company_id)} />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td style={{ fontWeight: 700 }}>{t('investorGroup.total')}</td>
                    <td />
                    <td />
                    <td className="r"><Rs value={summary.totals.share_capital} /></td>
                    <td className="r"><Rs value={summary.totals.investment} /></td>
                    <td />
                    <td className="r"><Rs value={summary.totals.value_of_my_shares} /></td>
                    <td />
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, alignItems: 'start' }}>
            <Card title={t('investorGroup.netWorth')} labelledBy="grp-nw">
              <div className="sf-table-wrap" tabIndex={0} role="region" aria-label={t('investorGroup.netWorth')}>
                <table className="sf-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('investorGroup.col.company')}</th>
                      <th scope="col" className="r">{t('investorGroup.nwBook')}</th>
                      <th scope="col" className="r">{t('investorGroup.myPct')}</th>
                      <th scope="col" className="r">{t('investorGroup.col.value')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {companies.map((c) => (
                      <tr key={c.company_id}>
                        <td>{c.company}</td>
                        <td className="r"><Rs value={c.net_worth_book} /></td>
                        <td className="r"><Pct value={c.share_pct} /></td>
                        <td className="r"><Rs value={c.value_of_my_shares} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted" style={{ fontSize: 12.5, margin: '8px 0 0' }}>{t('investorGroup.nwNote')}</p>
            </Card>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <Card title={t('investorGroup.howTitle')} labelledBy="grp-how">
                <p style={{ margin: '0 0 8px' }}>{t('investorGroup.how1')}</p>
                <p style={{ margin: '0 0 8px' }}>{t('investorGroup.how2')}</p>
                <p style={{ margin: '0 0 8px' }}>{t('investorGroup.how3')}</p>
                <p style={{ margin: 0, color: 'var(--sf-signal-ink)' }}>{t('investorGroup.how4')}</p>
              </Card>
              <Card title={t('investorGroup.cantSeeTitle')} labelledBy="grp-cant">
                <p style={{ margin: 0 }}>{t('investorGroup.cantSee')}</p>
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  )
}

function Tile({ label, value, sub, accent }: { label: string; value: React.ReactNode; sub: string; accent: string }) {
  return (
    <div className="sf-card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 2, borderTop: `3px solid ${accent}` }}>
      <span className="k">{label}</span>
      <span style={{ fontSize: 22, fontWeight: 600 }}>{value}</span>
      <span className="k">{sub}</span>
    </div>
  )
}

function CompanyDetail({ c, rows }: { c: GroupCompany; rows: MoneyInRow[] }) {
  const { t } = useTranslation()
  const months = Array.from(new Set(rows.map((r) => r.month ?? ''))).filter(Boolean)
  const bars = months.map((m) => ({ key: m, label: monthLabel(m), value: rows.filter((r) => r.month === m).reduce((s, r) => s + Number(r.amount ?? 0), 0) }))
  const best = bars.reduce<(typeof bars)[number] | null>((b, x) => (!b || x.value > b.value ? x : b), null)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(260px, 1fr)', gap: 20, padding: '14px 18px' }}>
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <strong>{t('investorGroup.moneyIn')}</strong>
          <Rs value={c.money_in_12m} digits={0} />
        </div>
        {bars.length ? <Bars items={bars} label={t('investorGroup.moneyIn')} /> : <EmptyState title={t('investorGroup.noMoney')} />}
      </div>
      <dl style={{ margin: 0 }}>
        <Row label={t('investorGroup.myShares')}>
          <Num value={c.shares} /> · <Pct value={c.share_pct} />
        </Row>
        <Row label={t('investorGroup.myLoan')}>
          <LoanBalance value={c.my_loan_account} />
        </Row>
        <Row label={t('investorGroup.receipts')}>
          <span className="mono">{c.buyers_paying_12m}</span>
        </Row>
        <Row label={t('investorGroup.bestMonth')}>
          {best ? (
            <span className="mono">
              {best.label} · <Rs value={best.value} digits={0} />
            </span>
          ) : (
            '—'
          )}
        </Row>
      </dl>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderTop: '1px solid var(--sf-line-faint)' }}>
      <dt className="muted">{label}</dt>
      <dd style={{ margin: 0, textAlign: 'right' }}>{children}</dd>
    </div>
  )
}

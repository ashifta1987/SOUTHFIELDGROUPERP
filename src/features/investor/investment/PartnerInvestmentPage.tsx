import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDate } from '@/shared/format'
import { Icon } from '@/ui'
import { useGroupSummary, useInvestorMe, useProfitShares } from '../common/investor'
import { Line, LoadFailed, Loading, LoanBalance, NotLinked, Num, PCard, PageTitle, Pct, Rs } from '../common/ui'

/**
 * Investor portal · My investment (`PartnerInvestment`). Share capital, investment and the value of my shares per
 * company (`investor_group_summary`), my loan account, and the profit shares posted to me (`v_investor_profit_shares`).
 * Book values from the company's books, before audit, depreciation and tax.
 */
export function PartnerInvestmentPage() {
  const { t } = useTranslation()
  const { me } = useInvestorMe()
  const { summary, isLoading, isError } = useGroupSummary()
  const shares = useProfitShares()
  const [open, setOpen] = useState<string | null>(null)
  if (isLoading) return <Loading />
  if (isError || !summary) return <LoadFailed />
  const companies = summary.companies
  const openId = open ?? companies[0]?.company_id ?? null

  return (
    <>
      <PageTitle title={t('partnerInvestment.title')} sub={me?.display_name ? t('partnerInvestment.sub', { name: me.display_name, count: companies.length }) : undefined} />
      {companies.length === 0 ? (
        <NotLinked />
      ) : (
        <>
          <section className="sf-phone-card" aria-label={t('partnerInvestment.totals')} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Total label={t('partnerInvestment.shareCapital')} sub={t('partnerInvestment.shareCapitalSub')}>
              <Rs value={summary.totals.share_capital} digits={0} />
            </Total>
            <Total label={t('partnerInvestment.currentValue')} sub={t('partnerInvestment.currentValueSub')}>
              <Rs value={summary.totals.value_of_my_shares} digits={0} />
            </Total>
            <Total label={t('partnerInvestment.investment')} sub={t('partnerInvestment.investmentSub')}>
              <Rs value={summary.totals.investment} digits={0} />
            </Total>
          </section>

          {companies.map((c) => {
            const isOpen = openId === c.company_id
            const mine = shares.rows.filter((s) => s.company_id === c.company_id)
            return (
              <section key={c.company_id} className="sf-phone-card" aria-labelledby={`inv-${c.company_id}`} style={{ gap: 6 }}>
                <h2 id={`inv-${c.company_id}`} style={{ margin: 0 }}>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? '' : c.company_id)}
                    style={{ width: '100%', minHeight: 32, display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: 0, background: 'transparent', padding: 0, cursor: 'pointer', color: 'var(--sf-text)', fontSize: 16, fontWeight: 700, fontFamily: 'inherit' }}
                  >
                    <span>{c.company}</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <Pct value={c.share_pct} />
                      <span style={{ display: 'inline-flex', transform: isOpen ? undefined : 'rotate(-90deg)' }}>
                        <Icon name="chevronDown" size={14} />
                      </span>
                    </span>
                  </button>
                </h2>
                {isOpen ? (
                  <div>
                    <Line label={t('partnerInvestment.sharesHeld')}>
                      <Num value={c.shares} /> · <Pct value={c.share_pct} />
                    </Line>
                    <Line label={t('partnerInvestment.money')}>
                      <Rs value={c.share_capital} digits={0} /> · <Rs value={c.investment} digits={0} />
                    </Line>
                    <Line label={t('partnerInvestment.loan')}>
                      <LoanBalance value={c.my_loan_account} />
                    </Line>
                    <div style={{ background: 'var(--sf-paper)', borderRadius: 10, padding: '8px 10px', margin: '6px 0' }}>
                      <strong style={{ fontSize: 13.5 }}>{t('partnerInvestment.netWorthTitle')}</strong>
                      <Line label={t('partnerInvestment.netWorth')} strong>
                        <Rs value={c.net_worth_book} digits={0} />
                      </Line>
                    </div>
                    <Line label={t('partnerInvestment.valueOfMine')} strong>
                      <Rs value={c.value_of_my_shares} digits={0} />
                    </Line>
                    <h3 style={{ margin: '10px 0 2px', fontSize: 14, fontWeight: 600, color: 'var(--sf-text-2)' }}>{t('partnerInvestment.profitShares')}</h3>
                    {mine.length ? (
                      mine.map((s, i) => (
                        <Line key={i} label={`${s.fy_label ?? ''} · ${t(`partnerInvestment.kind.${s.kind ?? 'share'}`)}${s.minutes_ref ? ` · ${s.minutes_ref}` : ''}`}>
                          <Pct value={s.pct} /> · <Rs value={s.amount} digits={0} />
                          {s.posted_at ? <span className="muted"> · {formatDate(s.posted_at)}</span> : null}
                        </Line>
                      ))
                    ) : (
                      <span className="muted" style={{ fontSize: 13.5 }}>
                        {t('partnerInvestment.noProfitShares')}
                      </span>
                    )}
                  </div>
                ) : null}
              </section>
            )
          })}
          <PCard>
            <span style={{ fontSize: 14, color: 'var(--sf-text-2)' }}>{t('partnerInvestment.note')}</span>
          </PCard>
        </>
      )}
    </>
  )
}

function Total({ label, sub, children }: { label: string; sub: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span className="k">{label}</span>
      <span style={{ fontSize: 19, fontWeight: 600 }}>{children}</span>
      <span className="k">{sub}</span>
    </div>
  )
}

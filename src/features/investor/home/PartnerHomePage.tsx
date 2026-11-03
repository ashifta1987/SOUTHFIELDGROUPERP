import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/ui'
import { currentMonthStart, monthLabel, roleKeys, useGroupSummary, useInvestorMe, useMoneyIn } from '../common/investor'
import { Bars, LoadFailed, Loading, Num, NotLinked, PCard, Pct, Rs } from '../common/ui'

/**
 * Investor portal · Today (`PartnerHome`). Who I am in each company (from `investor_me`), money in from buyers by month
 * for each company (posted receipts, `v_investor_money_in`), and my profit share and open requests. Analytics only.
 */
export function PartnerHomePage() {
  const { t } = useTranslation()
  const { me, isLoading, isError } = useInvestorMe()
  const group = useGroupSummary()
  const money = useMoneyIn()
  if (isLoading) return <Loading />
  if (isError || !me) return <LoadFailed />
  const name = me.display_name ?? ''
  const thisMonth = currentMonthStart()

  return (
    <>
      <div data-testid="investor-me">
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }} data-testid="investor-name">
          {name}
        </h1>
        {me.partners.map((p) => (
          <div key={p.partner_id} className="k" style={{ fontSize: 13.5 }} data-testid="investor-partner" data-company={p.company ?? ''}>
            {roleKeys(p).map((k) => t(`investor.role.${k}`)).join(' · ')}
            {' · '}
            {t('partnerHome.holding', { company: p.company ?? '' })} <Num value={p.shares} testId="investor-shares" /> · <Pct value={p.share_pct} testId="investor-share-pct" />
          </div>
        ))}
      </div>

      {me.partners.length === 0 ? (
        <NotLinked />
      ) : (
        <>
          {(group.summary?.companies ?? []).map((c) => {
            const rows = money.rows.filter((r) => r.company_id === c.company_id)
            const months = Array.from(new Set(rows.map((r) => r.month ?? ''))).filter(Boolean)
            const bars = months.map((m) => ({
              key: m,
              label: monthLabel(m),
              value: rows.filter((r) => r.month === m).reduce((s, r) => s + Number(r.amount ?? 0), 0),
            }))
            const nowRows = rows.filter((r) => r.month === thisMonth)
            const lid = `home-money-${c.company_id}`
            return (
              <PCard key={c.company_id} labelId={lid} title={t('partnerHome.moneyIn', { company: c.company ?? '' })} action={t('partnerHome.last12')} testId="home-money">
                <div>
                  <div style={{ fontSize: 28, fontWeight: 600 }}>
                    <Rs value={c.money_in_12m} digits={0} testId="home-money-12m" />
                  </div>
                  <div className="k">{t('partnerHome.receipts', { n: c.buyers_paying_12m })}</div>
                </div>
                {bars.length ? <Bars items={bars} label={t('partnerHome.byMonth')} tone="teal" /> : <span className="muted">{t('partnerHome.noMoney')}</span>}
                <div>
                  <h3 style={{ margin: '4px 0 2px', fontSize: 14, fontWeight: 600, color: 'var(--sf-text-2)' }}>{t('partnerHome.thisMonth', { month: monthLabel(thisMonth) })}</h3>
                  {nowRows.length ? (
                    nowRows.map((r) => (
                      <div key={`${r.mode}`} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderTop: '1px solid var(--sf-line-faint)', fontSize: 14 }}>
                        <span>{t(`partnerHome.mode.${r.mode ?? 'other'}`, { defaultValue: r.mode ?? '' })}</span>
                        <span>
                          <Rs value={r.amount} digits={0} /> <span className="muted">· {t('partnerHome.receiptsShort', { n: r.receipts ?? 0 })}</span>
                        </span>
                      </div>
                    ))
                  ) : (
                    <span className="muted" style={{ fontSize: 13.5 }}>
                      {t('partnerHome.noMoneyMonth')}
                    </span>
                  )}
                </div>
              </PCard>
            )
          })}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="sf-phone-card" style={{ gap: 4 }}>
              <span className="k">{t('partnerHome.openRequests')}</span>
              <span className="mono" style={{ fontSize: 22, fontWeight: 600 }} data-testid="home-open-requests" data-value={me.open_requests}>
                {me.open_requests}
              </span>
              <Link to="/investor/withdraw" style={{ fontSize: 13 }}>
                {t('partnerHome.seeRequests')}
              </Link>
            </div>
            {(group.summary?.companies ?? []).map((c) => (
              <div key={c.company_id} className="sf-phone-card" style={{ gap: 4 }}>
                <span className="k">{t('partnerHome.profitShare', { company: c.company ?? '' })}</span>
                <span style={{ fontSize: 20, fontWeight: 600 }}>
                  {Number(c.profit_share_posted) ? <Rs value={c.profit_share_posted} digits={0} /> : <span className="mono">—</span>}
                </span>
                <span className="k">{t('partnerHome.whenClosed')}</span>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <Link to="/investor/group">{t('partnerHome.wholeGroup')}</Link>
            {me.partners.some((p) => p.working_partner) ? <Link to="/investor/working-partner">{t('partnerHome.workingPartner')}</Link> : null}
          </div>
          {group.isError ? <EmptyState title={t('investor.loadFailed')} /> : null}
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {t('investor.readOnly')}
          </p>
        </>
      )}
    </>
  )
}

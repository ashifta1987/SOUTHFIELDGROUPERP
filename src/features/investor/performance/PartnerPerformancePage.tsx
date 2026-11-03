import { useTranslation } from 'react-i18next'
import { formatIndian } from '@/shared/format'
import { currentMonthStart, monthLabel, useGroupSummary, useMoneyIn } from '../common/investor'
import { Bars, LoadFailed, Loading, NotLinked, PCard, PageTitle, Pct } from '../common/ui'

const MODE_COLORS: Record<string, string> = {
  bank: 'var(--sf-navy)',
  cheque: 'var(--sf-info)',
  upi: 'var(--sf-primary)',
  cash: 'var(--sf-signal)',
  card: 'var(--sf-transit)',
  other: 'var(--sf-text-faint)',
}

/**
 * Investor portal · Performance (`PartnerPerformance`). How money came in this month by mode, money in by month, and my
 * holding — all from the investor views (posted receipts only; bills without GST excluded unless Admin's policy allows).
 * Shop and container charts in the reference need figures the investor views do not carry yet; they are left out.
 */
export function PartnerPerformancePage() {
  const { t } = useTranslation()
  const money = useMoneyIn()
  const { summary, isLoading, isError } = useGroupSummary()
  if (isLoading || money.isLoading) return <Loading />
  if (isError || money.isError || !summary) return <LoadFailed />
  const month = currentMonthStart()

  return (
    <>
      <PageTitle title={t('partnerPerformance.title')} />
      {summary.companies.length === 0 ? <NotLinked /> : null}
      {summary.companies.map((c) => {
        const rows = money.rows.filter((r) => r.company_id === c.company_id)
        const now = rows.filter((r) => r.month === month && Number(r.amount ?? 0) > 0)
        const total = now.reduce((s, r) => s + Number(r.amount ?? 0), 0)
        const months = Array.from(new Set(rows.map((r) => r.month ?? ''))).filter(Boolean)
        const bars = months.map((m) => ({ key: m, label: monthLabel(m), value: rows.filter((r) => r.month === m).reduce((s, r) => s + Number(r.amount ?? 0), 0) }))
        const id = `perf-${c.company_id}`
        return (
          <PCard key={c.company_id} labelId={id} title={t('partnerPerformance.howCame', { company: c.company ?? '' })} action={monthLabel(month)}>
            {now.length ? (
              <>
                <div role="img" aria-label={now.map((r) => `${t(`partnerHome.mode.${r.mode ?? 'other'}`, { defaultValue: r.mode ?? '' })} ₹${formatIndian(Number(r.amount ?? 0), 0)}`).join(', ')} style={{ display: 'flex', height: 18, borderRadius: 4, overflow: 'hidden' }}>
                  {now.map((r) => (
                    <span key={r.mode} style={{ width: `${(Number(r.amount ?? 0) / total) * 100}%`, background: MODE_COLORS[r.mode ?? 'other'] ?? MODE_COLORS.other }} />
                  ))}
                </div>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 13.5 }}>
                  {now.map((r) => (
                    <li key={r.mode} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: MODE_COLORS[r.mode ?? 'other'] ?? MODE_COLORS.other }} />
                      {t(`partnerHome.mode.${r.mode ?? 'other'}`, { defaultValue: r.mode ?? '' })} <span className="mono">₹{formatIndian(Number(r.amount ?? 0), 0)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <span className="muted" style={{ fontSize: 13.5 }}>
                {t('partnerHome.noMoneyMonth')}
              </span>
            )}
            <h3 style={{ margin: '6px 0 0', fontSize: 14, fontWeight: 600, color: 'var(--sf-text-2)' }}>{t('partnerHome.byMonth')}</h3>
            {bars.length ? <Bars items={bars} label={t('partnerHome.byMonth')} tone="teal" /> : <span className="muted">{t('partnerHome.noMoney')}</span>}
          </PCard>
        )
      })}
      {summary.companies.length ? (
        <PCard labelId="perf-holding" title={t('partnerPerformance.shareholding')}>
          {summary.companies.map((c) => {
            const pct = Math.min(100, Math.max(0, Number(c.share_pct)))
            return (
              <div key={c.company_id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                  <span>{c.company}</span>
                  <span>
                    {t('partnerPerformance.you')} <Pct value={c.share_pct} />
                  </span>
                </span>
                <div aria-hidden="true" style={{ display: 'flex', height: 12, borderRadius: 4, overflow: 'hidden', background: 'var(--sf-line-soft)' }}>
                  <span style={{ width: `${pct}%`, background: 'var(--sf-primary)' }} />
                </div>
              </div>
            )
          })}
          <span className="muted" style={{ fontSize: 12.5 }}>
            {t('partnerPerformance.othersHidden')}
          </span>
        </PCard>
      ) : null}
    </>
  )
}

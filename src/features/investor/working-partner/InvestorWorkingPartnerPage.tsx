import { useTranslation } from 'react-i18next'
import { setLanguage } from '@/i18n'
import { formatDate } from '@/shared/format'
import { EmptyState } from '@/ui'
import { useInvestorMe, useProfitShares } from '../common/investor'
import { Line, LoadFailed, Loading, NotLinked, PCard, Pct, Rs } from '../common/ui'

/**
 * Investor portal · working partner (`InvestorWorkingPartner`), in Malayalam or English. Shows the incentive shares
 * posted to me (`v_investor_profit_shares`, kind incentive). Attendance, duty and payslips stay in the staff app; the
 * section's own sales/cost figures are not in the investor views, so they are not shown.
 */
export function InvestorWorkingPartnerPage() {
  const { t, i18n } = useTranslation()
  const { me, isLoading, isError } = useInvestorMe()
  const shares = useProfitShares()
  if (isLoading) return <Loading />
  if (isError || !me) return <LoadFailed />
  const working = me.partners.filter((p) => p.working_partner)
  const incentives = shares.rows.filter((s) => s.kind === 'incentive' && working.some((p) => p.company_id === s.company_id))
  const lang = i18n.resolvedLanguage

  return (
    <>
      <div role="group" aria-label={t('workingPartner.language')} style={{ display: 'flex', gap: 6, alignSelf: 'flex-end' }}>
        {(
          [
            ['en', 'EN'],
            ['ml', 'മല'],
          ] as const
        ).map(([code, label]) => (
          <button
            key={code}
            type="button"
            lang={code}
            aria-pressed={lang === code}
            onClick={() => setLanguage(code)}
            style={{
              minWidth: 44,
              minHeight: 36,
              borderRadius: 8,
              border: '1px solid var(--sf-border-input)',
              background: lang === code ? 'var(--sf-navy)' : 'var(--sf-surface)',
              color: lang === code ? 'var(--sf-surface)' : 'var(--sf-text)',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{me.display_name}</h1>
        {working.map((p) => (
          <div key={p.partner_id} className="k" style={{ fontSize: 13.5 }}>
            {t('workingPartner.role', { company: p.company ?? '' })}
          </div>
        ))}
      </div>
      {me.partners.length === 0 ? (
        <NotLinked />
      ) : working.length === 0 ? (
        <EmptyState title={t('workingPartner.notWorking')} body={t('workingPartner.notWorkingNext')} />
      ) : (
        <>
          <PCard labelId="wp-share" title={t('workingPartner.myShare')}>
            {incentives.length ? (
              incentives.map((s, i) => (
                <Line key={i} label={`${s.company_name ?? ''} · ${s.fy_label ?? ''}`}>
                  <Pct value={s.pct} /> · <Rs value={s.amount} digits={0} />
                  {s.posted_at ? <span className="muted"> · {formatDate(s.posted_at)}</span> : null}
                </Line>
              ))
            ) : (
              <span style={{ fontSize: 14, color: 'var(--sf-text-2)' }}>{t('workingPartner.none')}</span>
            )}
            <span className="muted" style={{ fontSize: 13 }}>
              {t('workingPartner.how')}
            </span>
          </PCard>
          <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
            {t('workingPartner.staffApp')}
          </p>
        </>
      )}
    </>
  )
}

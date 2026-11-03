import type { ReactNode } from 'react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { useStaffMe } from '@/data/queries'
import { LANGUAGES, setLanguage, type LanguageCode } from '@/i18n'
import { formatDate } from '@/shared/format'
import { Chip, Skeleton } from '@/ui'
import { NotLinked, StaffSubHeader } from '../common'

function Row({ label, value, side }: { label: ReactNode; value: ReactNode; side?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 14px', borderTop: '1px solid var(--sf-line)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13, color: 'var(--sf-text-muted)' }}>{label}</span>
        <span style={{ fontSize: 15 }}>{value}</span>
      </div>
      {side}
    </div>
  )
}

/**
 * Staff app: my details (`StaffDetails`). The person's own record from api.staff_me(), masked: WhatsApp number and bank
 * account show the last 4 digits only; Aadhaar, PAN and salary are never shown here. Details are changed by the office.
 */
export function StaffDetailsPage() {
  const { t, i18n } = useTranslation()
  const me = useStaffMe()
  const data = me.data?.status === 'ready' ? me.data.data : null
  const langId = useId()
  const firstLang = LANGUAGES.find((l) => l.code === data?.language)

  return (
    <>
      <StaffSubHeader
        title={t('staffDetails.title')}
        action={
          data && data.kyc_done != null && data.kyc_needed != null ? (
            <Chip tone={data.kyc_done >= data.kyc_needed ? 'success' : 'signal'}>{t('staffDetails.kyc', { done: data.kyc_done, needed: data.kyc_needed })}</Chip>
          ) : null
        }
      />
      <div className="sf-phone-body">
        {me.isLoading ? (
          <Skeleton height={240} />
        ) : !data ? (
          <NotLinked />
        ) : (
          <>
            <section className="sf-phone-card" style={{ padding: 0, gap: 0 }} aria-label={t('staffDetails.title')}>
              <div style={{ display: 'flex', flexDirection: 'column', padding: '14px 14px' }}>
                <span style={{ fontSize: 13, color: 'var(--sf-text-muted)' }}>{t('staffDetails.staffId')}</span>
                <span className="mono" style={{ fontSize: 15 }}>
                  {data.person_code || '—'}
                </span>
              </div>
              <Row label={t('staffDetails.name')} value={data.display_name} />
              <Row label={t('staffDetails.work')} value={[data.designation, data.company_label].filter(Boolean).join(' · ') || t('staffDetails.notEntered')} />
              {data.join_date ? <Row label={t('staffDetails.joined')} value={<span className="mono">{formatDate(data.join_date)}</span>} /> : null}
              <Row
                label={t('staffDetails.whatsapp')}
                value={data.phone_masked ? <span className="mono">{data.phone_masked}</span> : t('staffDetails.notEntered')}
                side={<span style={{ fontSize: 14, color: 'var(--sf-text-muted)', fontWeight: 600 }}>{t('staffDetails.locked')}</span>}
              />
              <Row label={t('staffDetails.bank')} value={data.bank_masked ? <span className="mono">{data.bank_masked}</span> : t('staffDetails.notEntered')} />
              <Row label={t('staffDetails.firstLanguage')} value={firstLang ? firstLang.name : t('staffDetails.notChosen')} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '14px 14px', borderTop: '1px solid var(--sf-line)' }}>
                <label htmlFor={langId} style={{ fontSize: 13, color: 'var(--sf-text-muted)' }}>
                  {t('staffDetails.appLanguage')}
                </label>
                <select id={langId} className="sf-input" value={i18n.resolvedLanguage ?? 'en'} onChange={(e) => setLanguage(e.target.value as LanguageCode)}>
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>
            </section>
            <div className="sf-phone-note" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span>{t('staffDetails.note1')}</span>
              <span>{t('staffDetails.note2')}</span>
            </div>
          </>
        )}
      </div>
    </>
  )
}

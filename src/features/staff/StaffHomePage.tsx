import { useOutletContext } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthProvider'
import { useStaffMe } from '@/data/queries'
import { formatIndian, initials } from '@/shared/format'
import { ActionTile, Icon, OfflineBadge, PhoneHeader, Skeleton } from '@/ui'
import type { PhoneOutletContext } from '@/ui/shell/StaffShell'

/**
 * Staff app home (`StaffHome`). Pay, attendance and requests come from `api.staff_me()` (hr schema, Phase 3).
 * Staff messages never carry salary on WhatsApp; the figures shown here are the person's own, under RLS.
 */
export function StaffHomePage() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const { openHelp } = useOutletContext<PhoneOutletContext>()
  const me = useStaffMe()
  const data = me.data?.status === 'ready' ? me.data.data : null
  const name = data?.display_name ?? profile?.displayName ?? ''

  return (
    <>
      <PhoneHeader
        initial={initials(name).slice(0, 1)}
        name={name}
        sub={
          data ? (
            <>
              <span className="mono">{data.person_code}</span> · {data.company_label}
            </>
          ) : (
            t('staff.home.subPending')
          )
        }
        extra={<OfflineBadge />}
        onHelp={openHelp}
      />
      <div className="sf-phone-body">
        <section className="sf-phone-card" aria-labelledby="pay-h">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
            <h2 id="pay-h">{data?.pay_month_label ?? t('staff.home.payTitle')}</h2>
            {data?.net_pay ? (
              <a href="/staff/payslip" style={{ fontSize: 14, fontWeight: 600 }}>
                {t('staff.home.payslip')}
              </a>
            ) : null}
          </div>
          {me.isLoading ? (
            <Skeleton height={34} width="50%" />
          ) : data?.net_pay ? (
            <>
              <span className="mono" style={{ fontSize: 30, fontWeight: 600, letterSpacing: '-0.01em' }}>
                ₹{formatIndian(data.net_pay, 0)}
              </span>
              <div className="sf-stat-grid">
                <div className="sf-stat">
                  <span className="muted">{t('staff.home.present')}</span>
                  <span className="mono" style={{ fontSize: 16, fontWeight: 600 }}>
                    {data.present_days ?? '—'} / {data.working_days ?? '—'}
                  </span>
                </div>
                <div className="sf-stat">
                  <span className="muted">{t('staff.home.leave')}</span>
                  <span className="mono" style={{ fontSize: 16, fontWeight: 600 }}>
                    {data.leave_days ?? '—'}
                  </span>
                </div>
                <div className="sf-stat">
                  <span className="muted">{t('staff.home.advanceCut')}</span>
                  <span className="mono" style={{ fontSize: 16, fontWeight: 600 }}>
                    {data.advance_cut ? `₹${formatIndian(data.advance_cut, 0)}` : '—'}
                  </span>
                </div>
              </div>
            </>
          ) : (
            <p style={{ margin: 0, fontSize: 14, color: 'var(--sf-text-2)' }}>{t('staff.home.payEmpty')}</p>
          )}
        </section>

        <section className="sf-phone-line">
          <Icon name="calendar" size={20} />
          <span>{data?.attendance_note ?? t('staff.home.attendancePending')}</span>
        </section>

        <div className="sf-tiles">
          <ActionTile to="/staff/leave" icon="calendar" label={t('staff.home.requestLeave')} />
          <ActionTile to="/staff/advance" icon="rupee" label={t('staff.home.requestAdvance')} />
          <ActionTile to="/staff/details" icon="user" label={t('staff.home.myDetails')} />
          <ActionTile to="/staff/payslip" icon="receipt" label={t('staff.home.payslips')} />
        </div>

        <section className="sf-phone-section" aria-labelledby="req-h">
          <h2 id="req-h">{t('staff.home.myRequests')}</h2>
          {data && data.requests.length > 0 ? (
            data.requests.map((r) => (
              <div key={r.id} className="sf-phone-note">
                {r.kind} · {r.status}
              </div>
            ))
          ) : (
            <div className="sf-phone-note">{t('staff.home.noRequests')}</div>
          )}
        </section>
      </div>
    </>
  )
}


import { Link, useOutletContext } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthProvider'
import { rowsOf, useApiView } from '@/data/queries'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { ProdStatus, useProductionRights, ViewError } from '@/features/production/biochem-common/biochem'
import { initials } from '@/shared/format'
import { OfflineBadge, PhoneHeader, SelectField, Skeleton } from '@/ui'
import type { PhoneOutletContext } from '@/ui/shell/StaffShell'

/**
 * Factory manager home on the phone (`IsmailHome`): what needs the manager today, read from the same views as the
 * desktop screens (RLS decides what is seen) — batches by state, weighings waiting for a second-person check, finished
 * lots waiting for QC release, today's duty board, licences and calibrations that block work — with links to act.
 */
export function FactoryManagerHomePage() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const rights = useProductionRights()
  const ctx = useOutletContext<PhoneOutletContext | undefined>()
  const { list, companyId, choose } = useCompanyChoice()
  const on = Boolean(companyId)
  const batches = useApiView('batches', { eq: { company_id: companyId }, limit: 500, enabled: on })
  const duty = useApiView('factory_workload', { eq: { company_id: companyId, work_date: todayIst() }, enabled: on })
  const lic = useApiView('licences', { eq: { company_id: companyId }, enabled: on })
  const fam = useApiView('process_families', { eq: { company_id: companyId }, enabled: on })
  const assets = useApiView('assets', { eq: { company_id: companyId, status: 'active' }, enabled: on })
  const name = profile?.displayName ?? ''
  const open = rowsOf(batches).filter((b) => !['closed', 'cancelled'].includes(b.status))
  const loading = batches.isLoading
  const n = (v: number) => (loading ? '…' : String(v))
  const toCheck = open.filter((b) => (b.weighings_to_check ?? 0) > 0)
  const toRelease = open.filter((b) => b.status === 'packed_hold')
  const toClose = open.filter((b) => ['released', 'rejected'].includes(b.status))
  const mismatch = open.filter((b) => b.recon_status === 'mismatch')
  const blocked = rowsOf(fam).filter((f) => f.licence_kind && f.status === 'active' && f.licence_ok === false)
  const expiring = rowsOf(lic).filter((l) => l.is_valid && l.days_to_expiry !== null && l.days_to_expiry <= 30)
  const calDue = rowsOf(assets).filter((a) => a.calibration_overdue)
  const q = companyId ? `?company=${companyId}` : ''

  return (
    <>
      <PhoneHeader initial={initials(name).slice(0, 1) || '·'} name={name} sub={t('factoryHome.sub', { code: profile?.personCode ?? '' })} extra={<OfflineBadge />} onHelp={ctx?.openHelp} />
      <main className="sf-phone-body">
        <h1 className="sr-only">{t('factoryHome.title')}</h1>
        {list.length > 1 ? <SelectField label={t('common.company')} value={companyId ?? ''} onChange={(e) => choose(e.target.value)} options={list.map((c) => ({ value: c.id, label: c.short_name || c.name }))} /> : null}
        {!rights.view ? <p className="sf-phone-note">{t('factoryHome.noRight')}</p> : null}
        <ViewError error={batches.error} />
        {loading ? <Skeleton height={100} /> : null}

        {blocked.length ? (
          <section className="sf-phone-card" aria-labelledby="fh-lic" style={{ borderColor: 'var(--sf-danger-border)' }}>
            <h2 id="fh-lic">{t('factoryHome.blocked')}</h2>
            <p style={{ margin: 0 }}>{t('factoryHome.blockedLine', { list: blocked.map((f) => f.name).join(', ') })}</p>
            <Link className="sf-btn" to={`/admin/licences-and-documents${q}`}>
              {t('factoryHome.licences')}
            </Link>
          </section>
        ) : null}

        <section className="sf-phone-card" aria-labelledby="fh-batches">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <h2 id="fh-batches">{t('factoryHome.batches')}</h2>
            <strong className="mono" data-testid="fh-open">
              {n(open.length)}
            </strong>
          </div>
          <p style={{ margin: 0 }}>{t('factoryHome.toCheck', { n: n(toCheck.length) })}</p>
          <p style={{ margin: 0 }}>{t('factoryHome.toRelease', { n: n(toRelease.length) })}</p>
          <p style={{ margin: 0 }}>{t('factoryHome.toClose', { n: n(toClose.length) })}</p>
          {mismatch.length ? <p style={{ margin: 0, color: 'var(--sf-danger-ink)' }}>{t('factoryHome.mismatch', { n: mismatch.length })}</p> : null}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link className="sf-btn" to={`/production/biochem-production-entry${q}`}>
              {t('factoryHome.entry')}
            </Link>
            <Link className="sf-btn" to={`/production/biochem-production-flow${q}`}>
              {t('factoryHome.flow')}
            </Link>
          </div>
        </section>

        {open.length ? (
          <section className="sf-phone-section" aria-labelledby="fh-list">
            <h2 id="fh-list">{t('factoryHome.openList')}</h2>
            {open.slice(0, 8).map((b) => (
              <Link key={b.id} to={`/production/biochem-production-entry?company=${b.company_id}&batch=${b.id}`} className="sf-phone-line">
                <span className="mono">{b.batch_no}</span>
                <span style={{ flex: 1 }}>{b.product_name}</span>
                <ProdStatus status={b.status} />
              </Link>
            ))}
          </section>
        ) : null}

        <section className="sf-phone-card" aria-labelledby="fh-duty">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <h2 id="fh-duty">{t('factoryHome.duty')}</h2>
            <span className="muted">{duty.isLoading ? '…' : t('factoryHome.dutyCount', { n: rowsOf(duty).length })}</span>
          </div>
          {!duty.isLoading && rowsOf(duty).length === 0 ? <p style={{ margin: 0, color: 'var(--sf-signal-ink)' }}>{t('factoryHome.noDuty')}</p> : null}
          <Link className="sf-btn" to={`/production/factory-work-assignment${q}`}>
            {t('factoryHome.assign')}
          </Link>
        </section>

        <section className="sf-phone-card" aria-labelledby="fh-checks">
          <h2 id="fh-checks">{t('factoryHome.checks')}</h2>
          <p style={{ margin: 0 }}>{t('factoryHome.calDue', { n: calDue.length })}</p>
          <p style={{ margin: 0 }}>{t('factoryHome.licExpiring', { n: expiring.length })}</p>
          <Link className="sf-btn" to={`/production/biochem-machines${q}`}>
            {t('factoryHome.machines')}
          </Link>
        </section>
      </main>
    </>
  )
}

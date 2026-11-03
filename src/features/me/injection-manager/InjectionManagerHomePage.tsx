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
 * Injection manager home on the phone (`KrishnaHome`): today's machine checks against the injection machines, machines
 * under repair, today's shift entries, lots waiting for inspection and mould repairs — read from the same views as the
 * desktop screens (RLS decides what is seen), with links to act.
 */
export function InjectionManagerHomePage() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const rights = useProductionRights()
  const ctx = useOutletContext<PhoneOutletContext | undefined>()
  const { list, companyId, choose } = useCompanyChoice()
  const on = Boolean(companyId)
  const today = todayIst()
  const assets = useApiView('assets', { eq: { company_id: companyId, kind: 'injection_machine' }, limit: 500, enabled: on })
  const checks = useApiView('machine_checks', { eq: { company_id: companyId, check_date: today }, limit: 500, enabled: on })
  const shifts = useApiView('injection_shifts', { eq: { company_id: companyId, shift_date: today }, limit: 500, enabled: on })
  const waiting = useApiView('injection_shifts', { eq: { company_id: companyId, lot_status: 'quarantine' }, limit: 500, enabled: on })
  const name = profile?.displayName ?? ''
  const machines = rowsOf(assets).filter((a) => a.status !== 'disposed')
  const checked = new Set(rowsOf(checks).map((c) => c.asset_id))
  const done = machines.filter((m) => checked.has(m.id)).length
  const repair = machines.filter((m) => m.status === 'repair')
  const q = companyId ? `?company=${companyId}` : ''
  const loading = assets.isLoading || checks.isLoading
  return (
    <>
      <PhoneHeader initial={initials(name).slice(0, 1) || '·'} name={name} sub={t('plInjectionHome.sub', { code: profile?.personCode ?? '' })} extra={<OfflineBadge />} onHelp={ctx?.openHelp} />
      <main className="sf-phone-body">
        <h1 className="sr-only">{t('plInjectionHome.title')}</h1>
        {list.length > 1 ? <SelectField label={t('common.company')} value={companyId ?? ''} onChange={(e) => choose(e.target.value)} options={list.map((c) => ({ value: c.id, label: c.short_name || c.name }))} /> : null}
        {!rights.view ? <p className="sf-phone-note">{t('plInjectionHome.noRight')}</p> : null}
        <ViewError error={assets.error ?? checks.error ?? shifts.error} />
        {loading ? <Skeleton height={80} /> : null}

        <section className="sf-phone-card" aria-labelledby="ih-checks">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <h2 id="ih-checks">{t('plInjectionHome.checks')}</h2>
            <strong className="mono" data-testid="ih-checks">
              {loading ? '…' : `${done} / ${machines.length}`}
            </strong>
          </div>
          <p style={{ margin: 0 }} className="muted">
            {machines.length ? t('plInjectionHome.checksBody') : t('plInjectionHome.noMachines')}
          </p>
          <Link className="sf-btn" data-variant="primary" to={`/me/machine-check${q}`}>
            {t('plInjectionHome.doCheck')}
          </Link>
        </section>

        <section className="sf-phone-card" aria-labelledby="ih-repair" style={{ borderLeft: repair.length ? '4px solid var(--sf-danger)' : undefined }}>
          <h2 id="ih-repair">{t('plInjectionHome.repair')}</h2>
          {repair.length ? (
            repair.map((m) => (
              <p key={m.id} style={{ margin: 0 }}>
                <span className="mono">{m.code}</span> · <ProdStatus status={m.status} />
              </p>
            ))
          ) : (
            <p style={{ margin: 0 }} className="muted">
              {t('plInjectionHome.noRepair')}
            </p>
          )}
          <Link className="sf-btn" to={`/production/mould-register${q}`}>
            {t('plInjectionHome.mouldRepair')}
          </Link>
        </section>

        <section className="sf-phone-card" aria-labelledby="ih-shifts">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <h2 id="ih-shifts">{t('plInjectionHome.shifts')}</h2>
            <strong className="mono">{shifts.isLoading ? '…' : rowsOf(shifts).length}</strong>
          </div>
          <p style={{ margin: 0 }}>{t('plInjectionHome.waiting', { n: waiting.isLoading ? '…' : rowsOf(waiting).length })}</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link className="sf-btn" to={`/production/injection-production${q}`}>
              {t('plInjectionHome.entry')}
            </Link>
            <Link className="sf-btn" to={`/production/quality${q}`}>
              {t('plInjectionHome.quality')}
            </Link>
          </div>
        </section>

        <section className="sf-phone-card" aria-labelledby="ih-buy">
          <h2 id="ih-buy">{t('plInjectionHome.requests')}</h2>
          <Link className="sf-btn" to={`/purchase/purchase-requests${q}`}>
            {t('plInjectionHome.buy')}
          </Link>
        </section>
      </main>
    </>
  )
}

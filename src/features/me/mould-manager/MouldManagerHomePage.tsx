import { Link, useOutletContext } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthProvider'
import { rowsOf, useApiView } from '@/data/queries'
import { useCompanyChoice } from '@/features/admin/branches/company'
import { useProductionRights, ViewError } from '@/features/production/biochem-common/biochem'
import { initials } from '@/shared/format'
import { ActionTile, OfflineBadge, PhoneHeader, SelectField, Skeleton } from '@/ui'
import type { PhoneOutletContext } from '@/ui/shell/StaffShell'

/**
 * Mould manager home on the phone (`RaviHome`): moulds sent for repair, moulds due for service, mould projects and
 * where they stand, from the same views as the desktop screens (RLS decides what is seen), with links to act.
 */
export function MouldManagerHomePage() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const rights = useProductionRights()
  const ctx = useOutletContext<PhoneOutletContext | undefined>()
  const { list, companyId, choose } = useCompanyChoice()
  const on = Boolean(companyId)
  const moulds = useApiView('moulds', { eq: { company_id: companyId }, limit: 2000, enabled: on })
  const projects = useApiView('mould_projects', { eq: { company_id: companyId }, limit: 500, enabled: on })
  const name = profile?.displayName ?? ''
  const live = rowsOf(moulds).filter((m) => m.status !== 'retired')
  const repair = live.filter((m) => m.location === 'repair' || m.status === 'repair')
  const due = live.filter((m) => m.service_due)
  const open = rowsOf(projects).filter((p) => !['approved', 'dropped'].includes(p.stage))
  const waiting = open.filter((p) => p.stage === 'approval')
  const q = companyId ? `?company=${companyId}` : ''
  const loading = moulds.isLoading
  return (
    <>
      <PhoneHeader initial={initials(name).slice(0, 1) || '·'} name={name} sub={t('plMouldHome.sub', { code: profile?.personCode ?? '' })} extra={<OfflineBadge />} onHelp={ctx?.openHelp} />
      <main className="sf-phone-body">
        <h1 className="sr-only">{t('plMouldHome.title')}</h1>
        {list.length > 1 ? <SelectField label={t('common.company')} value={companyId ?? ''} onChange={(e) => choose(e.target.value)} options={list.map((c) => ({ value: c.id, label: c.short_name || c.name }))} /> : null}
        {!rights.view ? <p className="sf-phone-note">{t('plMouldHome.noRight')}</p> : null}
        <ViewError error={moulds.error ?? projects.error} />
        {loading ? <Skeleton height={100} /> : null}

        <section className="sf-phone-card" aria-labelledby="mh-repair" style={{ borderLeft: '4px solid var(--sf-signal)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <h2 id="mh-repair">{t('plMouldHome.repair')}</h2>
            <strong className="mono" data-testid="mh-repair">
              {loading ? '…' : repair.length}
            </strong>
          </div>
          {repair.length ? (
            repair.slice(0, 6).map((m) => (
              <p key={m.id} style={{ margin: 0 }}>
                <span className="mono">{m.code}</span> · {m.product_name ?? m.name}
              </p>
            ))
          ) : (
            <p style={{ margin: 0 }} className="muted">
              {t('plMouldHome.noRepair')}
            </p>
          )}
        </section>

        <div className="sf-tiles">
          <ActionTile to={`/production/mould-projects${q}`} icon="clipboard" label={t('plMouldHome.projects')} note={t('plMouldHome.openN', { n: open.length })} />
          <ActionTile to={`/production/mould-register${q}`} icon="file" label={t('plMouldHome.register')} note={t('plMouldHome.mouldsN', { n: live.length })} />
          <ActionTile to={`/purchase/purchase-requests${q}`} icon="receipt" label={t('plMouldHome.buy')} />
          <ActionTile to={`/production/mould-costing${q}`} icon="rupee" label={t('plMouldHome.costing')} />
        </div>

        <section className="sf-phone-card" aria-labelledby="mh-due">
          <h2 id="mh-due">{t('plMouldHome.due')}</h2>
          {due.length ? (
            due.slice(0, 6).map((m) => (
              <p key={m.id} style={{ margin: 0, color: 'var(--sf-signal-ink)' }}>
                <span className="mono">{m.code}</span> · {t('plMouldHome.shotsSince', { n: m.shots_since_service ?? 0 })}
              </p>
            ))
          ) : (
            <p style={{ margin: 0 }} className="muted">
              {t('plMouldHome.noDue')}
            </p>
          )}
        </section>

        {open.length ? (
          <section className="sf-phone-section" aria-labelledby="mh-projects">
            <h2 id="mh-projects">{t('plMouldHome.projectsNow', { n: waiting.length })}</h2>
            {open.slice(0, 8).map((p) => (
              <Link key={p.id} to={`/production/mould-projects${q}`} className="sf-phone-line">
                <span className="mono">{p.code}</span>
                <span style={{ flex: 1 }}>{p.name}</span>
                <span>{t(`plasticsCommon.stage.${p.stage}`, { defaultValue: p.stage })}</span>
              </Link>
            ))}
          </section>
        ) : null}
      </main>
    </>
  )
}

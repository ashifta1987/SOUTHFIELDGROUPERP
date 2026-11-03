import { useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useCompanyChoice } from '@/features/admin/branches/company'
import { CalibrationDialog } from '@/features/production/biochem-labs/CalibrationDialog'
import { ResultPanel } from '@/features/production/biochem-labs/ResultPanel'
import { useProductionRights, ViewError } from '@/features/production/biochem-common/biochem'
import { formatDate, formatLongDate, initials } from '@/shared/format'
import { Button, Chip, OfflineBadge, PhoneHeader, SelectField, Skeleton, Tabs } from '@/ui'
import type { PhoneOutletContext } from '@/ui/shell/StaffShell'

type Work = ViewRow<'my_lab_work'>
type Tab = 'today' | 'sample' | 'stability' | 'calibration'
const TABS: Tab[] = ['today', 'sample', 'stability', 'calibration']

/**
 * Lab panel on the tablet (`LabPanel`): the signed-in chemist's work from api.my_lab_work — samples to test, stability
 * checks due, instruments due for calibration and finished lots waiting for release (marked when the person helped
 * make the batch, so another QC person must release it). Results are recorded here against the formula's limits.
 */
export function LabPanelPage() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const rights = useProductionRights()
  const ctx = useOutletContext<PhoneOutletContext | undefined>()
  const { list, companyId, choose } = useCompanyChoice()
  const q = useApiView('my_lab_work', { eq: { company_id: companyId }, order: 'due_on', limit: 300, enabled: Boolean(companyId) })
  const [tab, setTab] = useState<Tab>('today')
  const [open, setOpen] = useState<Work | null>(null)
  const work = rowsOf(q)
  const count = (k: Tab) => (k === 'today' ? work.length : work.filter((w) => w.kind === k || (k === 'sample' && w.kind === 'release')).length)
  const shown = tab === 'today' ? work : work.filter((w) => w.kind === tab || (tab === 'sample' && w.kind === 'release'))
  const name = profile?.displayName ?? ''

  return (
    <>
      <PhoneHeader initial={initials(name).slice(0, 1) || '·'} name={name} sub={t('labPanel.sub')} extra={<OfflineBadge />} onHelp={ctx?.openHelp} />
      <main className="sf-phone-body">
        <h1 className="sr-only">{t('labPanel.title')}</h1>
        {list.length > 1 ? <SelectField label={t('common.company')} value={companyId ?? ''} onChange={(e) => choose(e.target.value)} options={list.map((c) => ({ value: c.id, label: c.short_name || c.name }))} /> : null}
        {!rights.view ? <p className="sf-phone-note">{t('labPanel.noRight')}</p> : null}
        <Tabs label={t('labPanel.tabs')} value={tab} onChange={setTab} idBase="lp" controls="lp-panel" tabs={TABS.map((k) => ({ key: k, label: t('labPanel.tab', { name: t(`labPanel.tabName.${k}`), n: q.isLoading ? '…' : count(k) }) }))} />
        <section id="lp-panel" role="tabpanel" aria-labelledby={`lp-tab-${tab}`} className="sf-phone-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
            <h2>{t('labPanel.myWork')}</h2>
            <span className="k">{formatLongDate(new Date())}</span>
          </div>
          <ViewError error={q.error} />
          {q.isLoading ? <Skeleton height={80} /> : null}
          {!q.isLoading && shown.length === 0 ? <p className="muted" style={{ margin: 0 }}>{t('labPanel.empty')}</p> : null}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
            {shown.map((w) => (
              <li key={`${w.kind}-${w.id}`} style={{ borderTop: '1px solid var(--sf-line)', padding: '10px 0', display: 'flex', gap: 8, alignItems: 'flex-start', justifyContent: 'space-between' }}>
                <div style={{ minWidth: 0 }}>
                  <strong>{t(`labPanel.kind.${w.kind ?? 'sample'}`, { ref: w.ref ?? '' })}</strong>
                  <div className="k">
                    {[w.detail, w.sub_kind ? t(`biochemEntry.sampleKind.${w.sub_kind}`, { defaultValue: w.sub_kind }) : null, w.due_on ? t('labPanel.due', { date: formatDate(w.due_on) }) : null].filter(Boolean).join(' · ')}
                  </div>
                  {w.kind === 'release' && w.i_made_it ? <div style={{ color: 'var(--sf-danger-ink)' }}>{t('labPanel.youMade')}</div> : null}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                  {w.kind === 'release' && w.i_made_it ? <Chip tone="danger">{t('labPanel.someoneElse')}</Chip> : w.mine ? <Chip tone="signal">{t('labPanel.mine')}</Chip> : <Chip tone="outline">{t('labPanel.toDo')}</Chip>}
                  {w.kind === 'sample' || w.kind === 'calibration' ? (
                    <Button size="sm" onClick={() => setOpen(w)} aria-label={t('labPanel.openOne', { ref: w.ref ?? '' })}>
                      {t('labPanel.open')}
                    </Button>
                  ) : w.kind === 'release' ? (
                    <Link className="sf-btn" data-size="sm" to={`/production/biochem-production-entry?company=${w.company_id ?? ''}&batch=${w.id ?? ''}`} aria-label={t('labPanel.openOne', { ref: w.ref ?? '' })}>
                      {t('labPanel.open')}
                    </Link>
                  ) : (
                    <Link className="sf-btn" data-size="sm" to={`/production/biochem-labs?company=${w.company_id ?? ''}&tab=rnd`} aria-label={t('labPanel.openOne', { ref: w.ref ?? '' })}>
                      {t('labPanel.open')}
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
        {open?.kind === 'sample' && open.id ? <SampleWork id={open.id} onClose={() => setOpen(null)} /> : null}
        {open?.kind === 'calibration' && open.id ? <CalibrationWork id={open.id} onClose={() => setOpen(null)} /> : null}
      </main>
    </>
  )
}

function SampleWork({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useApiView('lab_samples', { eq: { id } })
  const s = rowsOf(q)[0]
  if (q.isLoading) return <Skeleton height={120} />
  return s ? <ResultPanel key={s.id} sample={s} onClose={onClose} compact /> : null
}

function CalibrationWork({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useApiView('assets', { eq: { id } })
  const a = rowsOf(q)[0]
  return a ? <CalibrationDialog asset={a} onClose={onClose} /> : null
}

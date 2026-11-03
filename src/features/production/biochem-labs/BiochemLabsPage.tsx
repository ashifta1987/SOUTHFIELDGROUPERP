import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { formatDate } from '@/shared/format'
import { Button, Card, Chip, DataTable, EmptyState, Field, FieldGrid, FormDialog, KpiTiles, PageHeader, SelectField, Skeleton, Tabs, TextAreaField, type Column } from '@/ui'
import { Done, ProdStatus, ProductionErrorBox, PROD_REFRESH, usePeople, useProductionRights, ViewError } from '../biochem-common/biochem'
import { ResultPanel, type Sample } from './ResultPanel'
import { CalibrationDialog } from './CalibrationDialog'

type Tab = 'testing' | 'rnd' | 'instruments'
const TABS: Tab[] = ['testing', 'rnd', 'instruments']
type Trial = ViewRow<'rnd_trials'>
type Asset = ViewRow<'assets'>

/**
 * Biochem labs (`BiochemLabs`): the testing lab (samples from batches and finished lots; results against the formula's
 * QC limits, refused outside them), the R&D lab (trials, stability checks, trial samples) and the lab instruments with
 * their calibration (an instrument past its date can't be picked for a result).
 */
export function BiochemLabsPage() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const wanted = params.get('tab') as Tab | null
  const tab: Tab = wanted && TABS.includes(wanted) ? wanted : 'testing'
  const choice = useCompanyChoice()
  const companyId = choice.companyId
  const samples = useApiView('lab_samples', { eq: { company_id: companyId }, order: 'taken_at', ascending: false, limit: 500, enabled: Boolean(companyId) })
  const assets = useApiView('assets', { eq: { company_id: companyId }, order: 'code', enabled: Boolean(companyId) })
  const instruments = rowsOf(assets).filter((a) => a.kind === 'lab_instrument' || a.kind === 'scale')
  const all = rowsOf(samples)

  function setTab(k: Tab) {
    const next = new URLSearchParams(params)
    next.set('tab', k)
    setParams(next, { replace: true })
  }

  return (
    <>
      <PageHeader title={t('biochemLabs.title')} subtitle={t('biochemLabs.subtitle')} />
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: 16 }}>
        <Tabs label={t('biochemLabs.tabs')} value={tab} onChange={setTab} idBase="bl" controls="bl-panel" tabs={TABS.map((k) => ({ key: k, label: t(`biochemLabs.tab.${k}`) }))} />
        <CompanyPicker list={choice.list} value={companyId} onChange={choice.choose} />
      </div>
      <div id="bl-panel" role="tabpanel" aria-labelledby={`bl-tab-${tab}`} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {choice.isLoading ? (
        <Card>
          <Skeleton height={80} />
        </Card>
      ) : !companyId ? (
        <Card>
          <EmptyState title={t('biochemCommon.noCompany')} />
        </Card>
      ) : (
        <>
          <KpiTiles
            ariaLabel={t('biochemLabs.kpis')}
            items={[
              { key: 'pend', label: t('biochemLabs.kpi.pending'), value: all.filter((s) => s.status === 'pending' && s.kind !== 'rnd').length, sub: t('biochemLabs.kpi.pendingSub') },
              { key: 'tested', label: t('biochemLabs.kpi.tested'), value: all.filter((s) => s.status === 'tested').length, sub: t('biochemLabs.kpi.testedSub') },
              { key: 'inst', label: t('biochemLabs.kpi.instruments'), value: instruments.length, sub: t('biochemLabs.kpi.instrumentsSub', { n: instruments.filter((a) => a.calibration_overdue).length }) },
              { key: 'ret', label: t('biochemLabs.kpi.retained'), value: all.filter((s) => s.kind === 'retained').length, sub: t('biochemLabs.kpi.retainedSub') },
            ]}
          />
          {tab === 'testing' ? (
            <Testing samples={all.filter((s) => s.kind !== 'rnd')} loading={samples.isLoading} error={samples.error} />
          ) : tab === 'rnd' ? (
            <Rnd key={companyId} companyId={companyId} samples={all.filter((s) => s.kind === 'rnd')} />
          ) : (
            <Instruments key={companyId} companyId={companyId} instruments={instruments} loading={assets.isLoading} />
          )}
        </>
      )}
      </div>
    </>
  )
}

function SampleTable({ rows, loading, error, onOpen, title }: { rows: Sample[]; loading: boolean; error?: unknown; onOpen: (s: Sample) => void; title: string }) {
  const { t } = useTranslation()
  const cols: Column<Sample>[] = [
    {
      key: 'no',
      header: t('biochemLabs.s.sample'),
      render: (s) => (
        <Button size="sm" variant="link" onClick={() => onOpen(s)} aria-label={t('biochemLabs.s.open', { no: s.sample_no })}>
          <span className="mono">{s.sample_no}</span>
        </Button>
      ),
    },
    { key: 'kind', header: t('biochemLabs.s.stage'), render: (s) => t(`biochemEntry.sampleKind.${s.kind}`, { defaultValue: s.kind }) },
    { key: 'what', header: t('biochemLabs.s.what'), render: (s) => <span>{s.product_name ?? s.trial_code ?? '—'} {s.batch_no ? <span className="k mono">{s.batch_no}</span> : null}</span> },
    { key: 'tests', header: t('biochemLabs.s.tests'), align: 'right', render: (s) => s.spec_parameters ?? 0 },
    { key: 'who', header: t('biochemLabs.s.assigned'), render: (s) => s.assigned_to_name ?? '—' },
    { key: 'taken', header: t('biochemLabs.s.taken'), render: (s) => formatDate(s.taken_at) },
    { key: 'status', header: t('common.status'), render: (s) => <span style={{ display: 'inline-flex', gap: 4 }}><ProdStatus status={s.status} />{s.last_result ? <ProdStatus status={s.last_result} /> : null}</span> },
  ]
  return (
    <TableCard title={title}>
      <DataTable caption={title} columns={cols} rows={rows} rowKey={(s) => s.id} loading={loading} minWidth={860} error={error ? <ViewError error={error} /> : undefined} empty={<EmptyState title={t('biochemLabs.s.emptyTitle')} body={t('biochemLabs.s.emptyBody')} />} />
    </TableCard>
  )
}

function Testing({ samples, loading, error }: { samples: Sample[]; loading: boolean; error: unknown }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState<string | null>(null)
  const current = samples.find((s) => s.id === open) ?? null
  const ordered = [...samples].sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1))
  return (
    <>
      {current ? <ResultPanel key={current.id} sample={current} onClose={() => setOpen(null)} /> : null}
      <SampleTable title={t('biochemLabs.s.title')} rows={ordered} loading={loading} error={error} onOpen={(s) => setOpen(s.id)} />
      <Card title={t('biochemLabs.rules.title')}>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <li>{t('biochemLabs.rules.sampled')}</li>
          <li>{t('biochemLabs.rules.independent')}</li>
          <li>{t('biochemLabs.rules.calibrated')}</li>
          <li>{t('biochemLabs.rules.retention')}</li>
        </ul>
      </Card>
    </>
  )
}

/* ───────── R&D ───────── */
function Rnd({ companyId, samples }: { companyId: string; samples: Sample[] }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const trials = useApiView('rnd_trials', { eq: { company_id: companyId }, order: 'created_at', ascending: false })
  const [editing, setEditing] = useState<Trial | 'new' | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [sampleOpen, setSampleOpen] = useState<string | null>(null)
  const current = rowsOf(trials).find((x) => x.id === selected) ?? null
  const cols: Column<Trial>[] = [
    {
      key: 'code',
      header: t('biochemLabs.r.trial'),
      render: (x) => (
        <Button size="sm" variant="link" onClick={() => setSelected(x.id)} aria-label={t('biochemLabs.r.open', { code: x.code })}>
          <span className="mono">{x.code}</span>
        </Button>
      ),
    },
    { key: 'title', header: t('biochemLabs.r.titleCol'), render: (x) => x.title },
    { key: 'family', header: t('biochemLabs.r.family'), render: (x) => x.family_name ?? '—' },
    { key: 'who', header: t('biochemLabs.s.assigned'), render: (x) => x.assigned_to_name ?? '—' },
    { key: 'next', header: t('biochemLabs.r.nextCheck'), render: (x) => (x.next_check_due ? formatDate(x.next_check_due) : '—') },
    { key: 'status', header: t('common.status'), render: (x) => <ProdStatus status={x.status} /> },
  ]
  const sampleCurrent = samples.find((s) => s.id === sampleOpen) ?? null
  return (
    <>
      <TableCard title={t('biochemLabs.r.title')} action={rights.rnd ? <Button variant="primary" onClick={() => setEditing('new')}>{t('biochemLabs.r.add')}</Button> : null}>
        <DataTable caption={t('biochemLabs.r.title')} columns={cols} rows={rowsOf(trials)} rowKey={(x) => x.id} loading={trials.isLoading} minWidth={760} error={trials.error ? <ViewError error={trials.error} /> : undefined} empty={<EmptyState title={t('biochemLabs.r.emptyTitle')} body={t('biochemLabs.r.emptyBody')} />} />
      </TableCard>
      {current ? <TrialPanel key={current.id} trial={current} onEdit={() => setEditing(current)} onClose={() => setSelected(null)} /> : null}
      {sampleCurrent ? <ResultPanel key={sampleCurrent.id} sample={sampleCurrent} onClose={() => setSampleOpen(null)} /> : null}
      <SampleTable title={t('biochemLabs.r.samples')} rows={samples} loading={false} onOpen={(s) => setSampleOpen(s.id)} />
      {editing ? <TrialDialog companyId={companyId} trial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </>
  )
}

function TrialPanel({ trial, onEdit, onClose }: { trial: Trial; onEdit: () => void; onClose: () => void }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const checks = useApiView('stability_checks', { eq: { trial_id: trial.id }, order: 'day_no' })
  const rec = useApiMutation<{ p_trial_id: string; p: Record<string, unknown> }, { id: string }>('record_stability_check', PROD_REFRESH)
  const send = useApiMutation<{ p_trial_id: string; p: Record<string, unknown> }, { sample_no: string }>('send_trial_sample', PROD_REFRESH)
  const [f, setF] = useState({ day_no: '0', condition: '', due_on: todayIst(), result: '', observations: '' })
  const [done, setDone] = useState<string | null>(null)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const cols: Column<ViewRow<'stability_checks'>>[] = [
    { key: 'day', header: t('biochemLabs.st.day'), align: 'right', render: (c) => c.day_no },
    { key: 'cond', header: t('biochemLabs.st.condition'), render: (c) => c.condition ?? '—' },
    { key: 'due', header: t('biochemLabs.st.due'), render: (c) => (c.due_on ? formatDate(c.due_on) : '—') },
    { key: 'res', header: t('biochemLabs.st.result'), render: (c) => (c.result ? <ProdStatus status={c.result} /> : <Chip tone="outline">{t('biochemLabs.st.planned')}</Chip>) },
    { key: 'obs', header: t('biochemLabs.st.observations'), render: (c) => (c.observations && typeof c.observations === 'object' && 'text' in c.observations ? String((c.observations as { text?: unknown }).text ?? '') : '') },
    { key: 'by', header: t('biochemLabs.st.by'), render: (c) => c.recorded_by_name ?? '—' },
  ]
  return (
    <Card
      title={t('biochemLabs.r.panelTitle', { code: trial.code, title: trial.title })}
      action={
        <span style={{ display: 'inline-flex', gap: 8 }}>
          {rights.rnd ? (
            <Button size="sm" onClick={onEdit}>
              {t('common.edit')}
            </Button>
          ) : null}
          <Button size="sm" variant="link" onClick={onClose}>
            {t('common.close')}
          </Button>
        </span>
      }
    >
      <DataTable caption={t('biochemLabs.st.title')} columns={cols} rows={rowsOf(checks)} rowKey={(c) => c.id} loading={checks.isLoading} minWidth={700} empty={<EmptyState title={t('biochemLabs.st.empty')} />} />
      {rights.rnd ? (
        <>
          <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>{t('biochemLabs.st.record')}</h3>
          <FieldGrid cols={3}>
            <Field label={t('biochemLabs.st.day')} inputMode="numeric" value={f.day_no} onChange={set('day_no')} />
            <Field label={t('biochemLabs.st.condition')} value={f.condition} onChange={set('condition')} />
            <Field label={t('biochemLabs.st.due')} type="date" value={f.due_on} onChange={set('due_on')} />
            <SelectField label={t('biochemLabs.st.result')} value={f.result} onChange={set('result')} options={[{ value: '', label: t('biochemLabs.st.planOnly') }, ...['pass', 'watch', 'fail'].map((r) => ({ value: r, label: t(`biochemCommon.status.${r}`) }))]} />
            <Field label={t('biochemLabs.st.observations')} value={f.observations} onChange={set('observations')} />
          </FieldGrid>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <Button
              variant="primary"
              busy={rec.isPending}
              onClick={() => {
                setDone(null)
                send.reset()
                rec.mutate(
                  { p_trial_id: trial.id, p: { day_no: f.day_no.trim(), condition: f.condition.trim() || null, due_on: f.due_on || null, result: f.result || null, observations: f.observations.trim() ? { text: f.observations.trim() } : {} } },
                  { onSuccess: () => setDone(t('biochemLabs.st.saved')) },
                )
              }}
            >
              {t('biochemLabs.st.save')}
            </Button>
            <Button
              busy={send.isPending}
              onClick={() => {
                setDone(null)
                rec.reset()
                send.mutate({ p_trial_id: trial.id, p: {} }, { onSuccess: (r) => setDone(t('biochemLabs.r.sampleSent', { no: r.sample_no })) })
              }}
            >
              {t('biochemLabs.r.sendSample')}
            </Button>
          </div>
        </>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        <ProductionErrorBox error={rec.error ?? send.error} />
        <Done>{done}</Done>
      </div>
    </Card>
  )
}

function TrialDialog({ companyId, trial, onClose }: { companyId: string; trial: Trial | null; onClose: () => void }) {
  const { t } = useTranslation()
  const fam = useApiView('process_families', { eq: { company_id: companyId }, order: 'code' })
  const ver = useApiView('formula_versions', { eq: { company_id: companyId }, order: 'formula_code' })
  const people = usePeople(companyId)
  const [f, setF] = useState({
    code: trial?.code ?? '',
    title: trial?.title ?? '',
    family_id: trial?.family_id ?? '',
    formula_version_id: trial?.formula_version_id ?? '',
    assigned_to: trial?.assigned_to ?? '',
    status: trial?.status ?? 'planned',
    started_on: trial?.started_on ?? '',
    notes: trial?.notes ?? '',
  })
  const save = useApiMutation<{ p: Record<string, unknown> }, { id: string }>('save_rnd_trial', PROD_REFRESH)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  return (
    <FormDialog
      open
      wide
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={trial ? t('biochemLabs.r.editTitle') : t('biochemLabs.r.addTitle')}
      submitLabel={t('common.save')}
      busy={save.isPending}
      error={<ProductionErrorBox error={save.error} />}
      onSubmit={() => save.mutate({ p: { id: trial?.id ?? null, company_id: companyId, ...f, family_id: f.family_id || null, formula_version_id: f.formula_version_id || null, assigned_to: f.assigned_to || null, started_on: f.started_on || null, notes: f.notes.trim() || null } }, { onSuccess: onClose })}
    >
      <FieldGrid cols={2}>
        <Field label={t('biochemLabs.r.code')} value={f.code} onChange={set('code')} required disabled={Boolean(trial)} />
        <Field label={t('biochemLabs.r.titleCol')} value={f.title} onChange={set('title')} required />
        <SelectField label={t('biochemLabs.r.family')} value={f.family_id} onChange={set('family_id')} options={[{ value: '', label: t('common.none') }, ...rowsOf(fam).map((x) => ({ value: x.id, label: x.name }))]} />
        <SelectField label={t('biochemLabs.r.formula')} value={f.formula_version_id} onChange={set('formula_version_id')} options={[{ value: '', label: t('common.none') }, ...rowsOf(ver).map((v) => ({ value: v.id, label: `${v.formula_code} v${v.version}` }))]} />
        <SelectField label={t('biochemLabs.s.assigned')} value={f.assigned_to} onChange={set('assigned_to')} options={[{ value: '', label: t('common.none') }, ...people.list.map((p) => ({ value: p.id, label: p.name }))]} />
        <SelectField label={t('common.status')} value={f.status} onChange={set('status')} options={['planned', 'running', 'stability', 'passed', 'failed', 'dropped'].map((s) => ({ value: s, label: t(`biochemCommon.status.${s}`) }))} />
        <Field label={t('biochemLabs.r.started')} type="date" value={f.started_on} onChange={set('started_on')} />
      </FieldGrid>
      <TextAreaField label={t('biochemLabs.r.notes')} value={f.notes} onChange={set('notes')} rows={2} />
    </FormDialog>
  )
}

/* ───────── Instruments ───────── */
function Instruments({ companyId, instruments, loading }: { companyId: string; instruments: Asset[]; loading: boolean }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const cals = useApiView('calibrations', { eq: { company_id: companyId }, order: 'calibrated_on', ascending: false, limit: 200 })
  const [cal, setCal] = useState<Asset | null>(null)
  const cols: Column<Asset>[] = [
    { key: 'name', header: t('biochemLabs.i.instrument'), render: (a) => <span><strong>{a.name}</strong> <span className="k mono">{a.code}</span></span> },
    { key: 'kind', header: t('biochemLabs.i.kind'), render: (a) => t(`biochemMachines.kind.${a.kind}`, { defaultValue: a.kind }) },
    { key: 'make', header: t('biochemLabs.i.make'), render: (a) => [a.make, a.model, a.serial_no].filter(Boolean).join(' · ') || '—' },
    { key: 'place', header: t('biochemLabs.i.place'), render: (a) => a.place_name ?? '—' },
    { key: 'due', header: t('biochemLabs.i.due'), render: (a) => (a.calibration_due ? formatDate(a.calibration_due) : '—') },
    { key: 'state', header: t('common.status'), render: (a) => (a.calibration_overdue ? <Chip tone="danger" icon="alert">{t('biochemLabs.i.overdue')}</Chip> : <ProdStatus status={a.status} />) },
    { key: 'cal', header: <span className="sr-only">{t('biochemLabs.i.calibrate')}</span>, render: (a) => (rights.assetsManage || rights.qcTest ? <Button size="sm" variant="link" onClick={() => setCal(a)} aria-label={t('biochemLabs.i.calibrateOne', { code: a.code })}>{t('biochemLabs.i.calibrate')}</Button> : null) },
  ]
  const calCols: Column<ViewRow<'calibrations'>>[] = [
    { key: 'asset', header: t('biochemLabs.i.instrument'), render: (c) => `${c.asset_code} · ${c.asset_name}` },
    { key: 'on', header: t('biochemLabs.i.calibratedOn'), render: (c) => formatDate(c.calibrated_on) },
    { key: 'res', header: t('biochemLabs.st.result'), render: (c) => <ProdStatus status={c.result} /> },
    { key: 'next', header: t('biochemLabs.i.due'), render: (c) => (c.next_due ? formatDate(c.next_due) : '—') },
    { key: 'agency', header: t('biochemLabs.i.agency'), render: (c) => c.agency ?? '—' },
    { key: 'by', header: t('biochemLabs.st.by'), render: (c) => c.recorded_by_name ?? '—' },
  ]
  return (
    <>
      <TableCard title={t('biochemLabs.i.title')}>
        <p className="muted" style={{ margin: 0, padding: '0 16px 10px' }}>
          {t('biochemLabs.i.hint')}
        </p>
        <DataTable caption={t('biochemLabs.i.title')} columns={cols} rows={instruments} rowKey={(a) => a.id} loading={loading} minWidth={860} empty={<EmptyState title={t('biochemLabs.i.emptyTitle')} body={t('biochemLabs.i.emptyBody')} />} />
      </TableCard>
      <TableCard title={t('biochemLabs.i.calTitle')}>
        <DataTable caption={t('biochemLabs.i.calTitle')} columns={calCols} rows={rowsOf(cals)} rowKey={(c) => String(c.id)} loading={cals.isLoading} minWidth={760} empty={<EmptyState title={t('biochemLabs.i.calEmpty')} />} />
      </TableCard>
      {cal ? <CalibrationDialog asset={cal} onClose={() => setCal(null)} /> : null}
    </>
  )
}

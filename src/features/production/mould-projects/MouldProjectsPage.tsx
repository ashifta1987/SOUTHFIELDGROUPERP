import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { TableCard } from '@/features/admin/import-data/layout'
import { formatDate } from '@/shared/format'
import { Button, Card, Chip, DataTable, EmptyState, Field, FieldGrid, FormDialog, SelectField, Tabs, TextAreaField, type Column } from '@/ui'
import { CostCell, Done, useCompanyProducts, useProductionRights, ViewError } from '../biochem-common/biochem'
import { detailText, PlasticsErrorBox, PlasticsFrame, PLASTICS_REFRESH } from '../plastics-common/plastics'

type Project = ViewRow<'mould_projects'>
const ORDER = ['design', 'trial', 'approval', 'approved'] as const
type View = 'active' | 'completed' | 'dropped'

/**
 * Mould projects (`Moulds`): each new mould moves design → trial → customer approval → approved, one stage at a time;
 * the last step needs the approve right and someone other than the person who created the project (sod.own_approval,
 * checked by api.advance_mould_project). A project can be dropped with a reason. Estimated cost needs the cost right.
 */
export function MouldProjectsPage() {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const [creating, setCreating] = useState(false)
  return (
    <PlasticsFrame
      step="project"
      title={t('plMouldProjects.title')}
      subtitle={t('plMouldProjects.subtitle')}
      actions={() =>
        rights.edit ? (
          <Button variant="primary" onClick={() => setCreating(true)}>
            {t('plMouldProjects.new')}
          </Button>
        ) : null
      }
    >
      {(companyId) => (
        <>
          <Projects companyId={companyId} />
          {creating ? <ProjectDialog companyId={companyId} onClose={() => setCreating(false)} /> : null}
        </>
      )}
    </PlasticsFrame>
  )
}

function Projects({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const q = useApiView('mould_projects', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 500 })
  const all = rowsOf(q)
  const [view, setView] = useState<View>('active')
  const [selected, setSelected] = useState<string | null>(null)
  const shown = all.filter((p) => (view === 'active' ? !['approved', 'dropped'].includes(p.stage) : view === 'completed' ? p.stage === 'approved' : p.stage === 'dropped'))
  const current = all.find((p) => p.id === selected) ?? shown[0] ?? null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <p className="muted" style={{ margin: 0 }} data-testid="mp-count">
          {t('plMouldProjects.counts', { active: all.filter((p) => !['approved', 'dropped'].includes(p.stage)).length, done: all.filter((p) => p.stage === 'approved').length })}
        </p>
        <Tabs<View>
          variant="segmented"
          label={t('plMouldProjects.viewLabel')}
          value={view}
          onChange={setView}
          tabs={[
            { key: 'active', label: t('plMouldProjects.view.active') },
            { key: 'completed', label: t('plMouldProjects.view.completed') },
            { key: 'dropped', label: t('plMouldProjects.view.dropped') },
          ]}
        />
      </div>
      <ViewError error={q.error} />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 1fr) minmax(0, 2fr)', gap: 16, alignItems: 'start' }}>
        <Card pad={false}>
          {q.isLoading ? (
            <div style={{ padding: 16 }}>
              <EmptyState title={t('common.loading')} />
            </div>
          ) : shown.length === 0 ? (
            <div style={{ padding: 16 }}>
              <EmptyState title={t('plMouldProjects.emptyTitle')} body={t('plMouldProjects.emptyBody')} />
            </div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label={t('plMouldProjects.listLabel')}>
              {shown.map((p) => (
                <li key={p.id} style={{ borderBottom: '1px solid var(--sf-line-soft)' }}>
                  <button
                    type="button"
                    onClick={() => setSelected(p.id)}
                    aria-pressed={current?.id === p.id}
                    style={{ all: 'unset', boxSizing: 'border-box', display: 'block', width: '100%', padding: '14px 16px', cursor: 'pointer', background: current?.id === p.id ? 'var(--sf-primary-tint)' : undefined, borderLeft: current?.id === p.id ? '3px solid var(--sf-primary)' : '3px solid transparent' }}
                  >
                    <span className="sr-only">{t('plMouldProjects.openPrefix')} </span>
                    <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span className="mono" style={{ fontWeight: 600 }}>
                        {p.code}
                      </span>
                      <span className="k">{p.target_date ? t('plMouldProjects.due', { date: formatDate(p.target_date) }) : ''}</span>
                    </span>
                    <span style={{ display: 'block', fontWeight: 600, marginTop: 4 }}>{p.name}</span>
                    <span className="k" style={{ display: 'block' }}>
                      {p.ownership === 'buyer' ? (p.buyer_name ?? t('plasticsCommon.ownership.buyer')) : t('plasticsCommon.ownership.own')}
                    </span>
                    <span style={{ display: 'inline-block', marginTop: 6 }}>
                      <StageChip stage={p.stage} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {current ? <ProjectPanel key={current.id} project={current} /> : <Card><EmptyState title={t('plMouldProjects.pick')} /></Card>}
      </div>
    </div>
  )
}

function StageChip({ stage }: { stage: string }) {
  const { t } = useTranslation()
  const tone = stage === 'approved' ? 'success' : stage === 'dropped' ? 'neutral' : stage === 'approval' ? 'signal' : stage === 'trial' ? 'transit' : 'info'
  return <Chip tone={tone}>{t(`plasticsCommon.stage.${stage}`, { defaultValue: stage })}</Chip>
}

function ProjectPanel({ project }: { project: Project }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const events = useApiView('mould_events', { eq: { project_id: project.id }, order: 'id', ascending: false })
  const moulds = useApiView('moulds', { eq: { project_id: project.id }, order: 'code' })
  const adv = useApiMutation<{ p_project_id: string; p_stage: string; p_note: string | null }, { id: string; stage: string }>('advance_mould_project', PLASTICS_REFRESH)
  const [note, setNote] = useState('')
  const [drop, setDrop] = useState(false)
  const [editing, setEditing] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const idx = ORDER.indexOf(project.stage as (typeof ORDER)[number])
  const next = idx >= 0 && idx < ORDER.length - 1 ? ORDER[idx + 1] : null
  const open = !['approved', 'dropped'].includes(project.stage)
  const canNext = next === 'approved' ? rights.approve : rights.edit
  const evCols: Column<ViewRow<'mould_events'>>[] = [
    { key: 'date', header: t('plMouldProjects.ev.date'), render: (e) => formatDate(e.event_date) },
    { key: 'kind', header: t('plMouldProjects.ev.kind'), render: (e) => t(`plMouldProjects.evKind.${e.kind}`, { defaultValue: e.kind }) },
    { key: 'detail', header: t('plMouldProjects.ev.detail'), render: (e) => detailText(e.detail) || '—' },
    { key: 'by', header: t('plMouldProjects.ev.by'), render: (e) => e.recorded_by_name ?? '—' },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <p className="mono k" style={{ margin: 0 }}>
          {project.code}
          {project.product_code ? ` · ${project.product_code}` : ''}
        </p>
        <h2 style={{ fontSize: 22, margin: '4px 0' }}>{project.name}</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          {[project.product_name, project.ownership === 'buyer' ? (project.buyer_name ?? t('plasticsCommon.ownership.buyer')) : t('plasticsCommon.ownership.own'), project.target_date ? t('plMouldProjects.due', { date: formatDate(project.target_date) }) : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <ol aria-label={t('plMouldProjects.stages')} style={{ listStyle: 'none', margin: '12px 0', padding: 0, display: 'grid', gridTemplateColumns: `repeat(${ORDER.length}, 1fr)`, gap: 8 }}>
          {ORDER.map((s, i) => {
            const here = s === project.stage
            const past = idx >= 0 && i < idx
            return (
              <li key={s} aria-current={here ? 'step' : undefined} style={{ borderTop: `4px solid ${past || (here && s === 'approved') ? 'var(--sf-success)' : here ? 'var(--sf-info)' : 'var(--sf-line)'}`, paddingTop: 6, fontSize: 13, fontWeight: here ? 700 : 500 }}>
                {past ? '✓ ' : here ? '● ' : ''}
                {t(`plasticsCommon.stage.${s}`)}
              </li>
            )
          })}
        </ol>
        <p style={{ margin: '0 0 8px' }} data-testid="mp-stage">
          {t('plMouldProjects.stageNow')} <StageChip stage={project.stage} />
          {project.approved_at ? ` · ${t('plMouldProjects.approvedOn', { date: formatDate(project.approved_at) })}` : ''}
        </p>
        {open && !rights.readOnly ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Field label={t('plMouldProjects.note')} value={note} onChange={(e) => setNote(e.target.value)} />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {next && canNext ? (
                <Button
                  variant="primary"
                  busy={adv.isPending}
                  onClick={() => {
                    setDone(null)
                    adv.mutate({ p_project_id: project.id, p_stage: next, p_note: note.trim() || null }, { onSuccess: (r) => setDone(t('plMouldProjects.moved', { stage: t(`plasticsCommon.stage.${r.stage}`) })) })
                  }}
                >
                  {next === 'approved' ? t('plMouldProjects.approve') : t('plMouldProjects.moveTo', { stage: t(`plasticsCommon.stage.${next}`) })}
                </Button>
              ) : next === 'approved' ? (
                <span className="k">{t('plMouldProjects.needsApprover')}</span>
              ) : null}
              {rights.edit ? (
                <>
                  <Button onClick={() => setEditing(true)}>{t('common.edit')}</Button>
                  <Button variant="danger" onClick={() => setDrop(true)}>
                    {t('plMouldProjects.drop')}
                  </Button>
                </>
              ) : null}
            </div>
            {next === 'approved' ? <p className="k" style={{ margin: 0 }}>{t('plMouldProjects.approveRule')}</p> : null}
          </div>
        ) : null}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <PlasticsErrorBox error={adv.error} />
          <Done>{done}</Done>
        </div>
      </Card>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
        <Card title={t('plMouldProjects.cost.title')}>
          <p style={{ margin: 0, fontSize: 22 }}>
            <CostCell value={project.estimated_cost} />
          </p>
          <p className="k" style={{ margin: '6px 0 0' }}>
            {t('plMouldProjects.cost.body')}
          </p>
        </Card>
        <Card title={t('plMouldProjects.moulds.title')}>
          {rowsOf(moulds).length ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {rowsOf(moulds).map((m) => (
                <li key={m.id}>
                  <span className="mono">{m.code}</span> · {m.name}
                </li>
              ))}
            </ul>
          ) : (
            <p className="k" style={{ margin: 0 }}>
              {t('plMouldProjects.moulds.empty')}
            </p>
          )}
        </Card>
      </div>
      {project.notes ? (
        <Card title={t('plMouldProjects.notes')}>
          <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{project.notes}</p>
        </Card>
      ) : null}
      <TableCard title={t('plMouldProjects.ev.title')}>
        <DataTable caption={t('plMouldProjects.ev.title')} columns={evCols} rows={rowsOf(events)} rowKey={(e) => String(e.id)} loading={events.isLoading} minWidth={560} empty={<EmptyState title={t('plMouldProjects.ev.empty')} />} />
      </TableCard>
      {drop ? <DropDialog project={project} onClose={() => setDrop(false)} /> : null}
      {editing ? <ProjectDialog companyId={project.company_id} project={project} onClose={() => setEditing(false)} /> : null}
    </div>
  )
}

function DropDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const { t } = useTranslation()
  const adv = useApiMutation<{ p_project_id: string; p_stage: string; p_note: string | null }>('advance_mould_project', PLASTICS_REFRESH)
  const [reason, setReason] = useState('')
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('plMouldProjects.dropTitle', { code: project.code })}
      submitLabel={t('plMouldProjects.drop')}
      busy={adv.isPending}
      error={<PlasticsErrorBox error={adv.error} />}
      onSubmit={() => adv.mutate({ p_project_id: project.id, p_stage: 'dropped', p_note: reason.trim() }, { onSuccess: onClose })}
    >
      <TextAreaField label={t('plMouldProjects.reason')} value={reason} onChange={(e) => setReason(e.target.value)} required />
    </FormDialog>
  )
}

function ProjectDialog({ companyId, project, onClose }: { companyId: string; project?: Project; onClose: () => void }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const products = useCompanyProducts(companyId)
  const buyers = useApiView('customers', { eq: { company_id: companyId }, order: 'name', limit: 2000 })
  const save = useApiMutation<{ p: Record<string, unknown> }, { id: string }>('save_mould_project', PLASTICS_REFRESH)
  const [f, setF] = useState({
    code: project?.code ?? '',
    name: project?.name ?? '',
    product_id: project?.product_id ?? '',
    ownership: project?.ownership ?? 'own',
    buyer_party_id: project?.buyer_party_id ?? '',
    target_date: project?.target_date ?? '',
    estimated_cost: project?.estimated_cost !== null && project?.estimated_cost !== undefined ? String(project.estimated_cost) : '',
    notes: project?.notes ?? '',
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const n = (v: string) => (v.trim() ? v.trim() : null)
  return (
    <FormDialog
      open
      wide
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={project ? t('plMouldProjects.editTitle') : t('plMouldProjects.newTitle')}
      description={t('plMouldProjects.dialogHint')}
      submitLabel={t('common.save')}
      busy={save.isPending}
      error={<PlasticsErrorBox error={save.error} />}
      onSubmit={() =>
        save.mutate(
          {
            p: {
              id: project?.id ?? null,
              company_id: companyId,
              code: f.code.trim(),
              name: f.name.trim(),
              product_id: n(f.product_id),
              ownership: f.ownership,
              buyer_party_id: f.ownership === 'buyer' ? n(f.buyer_party_id) : null,
              target_date: n(f.target_date),
              estimated_cost: rights.costs ? n(f.estimated_cost) : (project?.estimated_cost ?? null),
              notes: n(f.notes),
            },
          },
          { onSuccess: onClose },
        )
      }
    >
      <FieldGrid cols={2}>
        <Field label={t('plMouldProjects.f.code')} value={f.code} onChange={set('code')} required disabled={Boolean(project)} />
        <Field label={t('plMouldProjects.f.name')} value={f.name} onChange={set('name')} required />
        <SelectField label={t('plMouldProjects.f.product')} value={f.product_id} onChange={set('product_id')} options={[{ value: '', label: t('plMouldProjects.f.noProduct') }, ...products.list.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))]} />
        <SelectField label={t('plMouldProjects.f.ownership')} value={f.ownership} onChange={set('ownership')} options={['own', 'buyer'].map((o) => ({ value: o, label: t(`plasticsCommon.ownership.${o}`) }))} />
        {f.ownership === 'buyer' ? <SelectField label={t('plMouldProjects.f.buyer')} value={f.buyer_party_id} onChange={set('buyer_party_id')} options={[{ value: '', label: t('plMouldProjects.f.chooseBuyer') }, ...rowsOf(buyers).map((b) => ({ value: b.id, label: b.name }))]} /> : null}
        <Field label={t('plMouldProjects.f.target')} type="date" value={f.target_date} onChange={set('target_date')} />
        {rights.costs ? <Field label={t('plMouldProjects.f.estimate')} inputMode="decimal" value={f.estimated_cost} onChange={set('estimated_cost')} /> : null}
      </FieldGrid>
      <TextAreaField label={t('plMouldProjects.notes')} value={f.notes} onChange={set('notes')} />
    </FormDialog>
  )
}

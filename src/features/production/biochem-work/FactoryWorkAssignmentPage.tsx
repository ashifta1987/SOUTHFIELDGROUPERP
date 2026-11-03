import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { qtyText } from '@/features/inventory/common/inventory'
import { formatDate } from '@/shared/format'
import { Button, Card, DataTable, EmptyState, Field, FieldGrid, PageHeader, SelectField, Skeleton, type Column } from '@/ui'
import { Done, ProdStatus, ProductionErrorBox, PROD_REFRESH, useCompanyPlaces, usePeople, useProductionRights, ViewError } from '../biochem-common/biochem'

const DUTIES = ['batch_maker', 'weigher', 'weigh_checker', 'packer', 'labour', 'supervisor', 'qc_tester', 'qc_releaser', 'rnd', 'operator', 'helper', 'inspector'] as const
type Assignment = ViewRow<'shift_assignments'>
type Load = ViewRow<'factory_workload'>

/**
 * Factory work assignment (`BiochemWork`): who does what on a shift. Duties are assigned to people (optionally on a
 * batch or a machine); the server checks each one against what that person already did on the batch — nobody is QC
 * releaser of a batch they help make, either way round (sod.self_release) — and a making duty stays on record once the
 * batch has started (work.batch_started).
 */
export function FactoryWorkAssignmentPage() {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const choice = useCompanyChoice()
  const companyId = choice.companyId
  const [date, setDate] = useState(todayIst())
  const [shift, setShift] = useState('day')
  const loads = useApiView('factory_workload', { eq: { company_id: companyId, work_date: date }, enabled: Boolean(companyId) })
  const asg = useApiView('shift_assignments', { eq: { company_id: companyId, work_date: date }, order: 'assigned_at', enabled: Boolean(companyId) })
  const batches = useApiView('batches', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 300, enabled: Boolean(companyId) })
  const samples = useApiView('lab_samples', { eq: { company_id: companyId, status: 'pending' }, order: 'taken_at', enabled: Boolean(companyId) })
  const open = rowsOf(batches).filter((b) => !['closed', 'cancelled'].includes(b.status))
  const [prefill, setPrefill] = useState<{ duty: string; batch: string } | null>(null)

  const loadCols: Column<Load>[] = [
    { key: 'who', header: t('biochemWork.load.person'), render: (r) => <strong>{r.user_name ?? '—'}</strong> },
    { key: 'shift', header: t('biochemWork.shift'), render: (r) => t(`biochemEntry.shift.${r.shift}`, { defaultValue: r.shift }) },
    { key: 'duties', header: t('biochemWork.load.duties'), render: (r) => (r.duty_list ?? []).map((d) => t(`biochemWork.duty.${d}`, { defaultValue: d })).join(', ') },
    { key: 'hours', header: t('biochemWork.load.hours'), align: 'right', render: (r) => (r.hours !== null ? <span className="sf-amount">{qtyText(r.hours)}</span> : '—') },
    { key: 'batches', header: t('biochemWork.load.batches'), align: 'right', render: (r) => r.batches ?? 0 },
  ]

  return (
    <>
      <PageHeader title={t('biochemWork.title')} subtitle={t('biochemWork.subtitle')} />
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ width: 180 }}>
            <Field label={t('biochemWork.date')} type="date" value={date} onChange={(e) => setDate(e.target.value || todayIst())} />
          </div>
          <div style={{ width: 180 }}>
            <SelectField label={t('biochemWork.shift')} value={shift} onChange={(e) => setShift(e.target.value)} options={['day', 'night', 'general'].map((s) => ({ value: s, label: t(`biochemEntry.shift.${s}`) }))} />
          </div>
        </div>
        <CompanyPicker list={choice.list} value={companyId} onChange={choice.choose} />
      </div>
      {choice.isLoading ? (
        <Card>
          <Skeleton height={80} />
        </Card>
      ) : !companyId ? (
        <Card>
          <EmptyState title={t('biochemCommon.noCompany')} />
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <TableCard title={t('biochemWork.load.title', { date: formatDate(date) })}>
            <DataTable caption={t('biochemWork.load.title', { date: formatDate(date) })} columns={loadCols} rows={rowsOf(loads)} rowKey={(r) => `${r.user_id}-${r.shift}`} loading={loads.isLoading} minWidth={700} error={loads.error ? <ViewError error={loads.error} /> : undefined} empty={<EmptyState title={t('biochemWork.load.emptyTitle')} body={t('biochemWork.load.emptyBody')} />} />
          </TableCard>
          {rights.edit ? (
            <AssignForm key={`${prefill?.duty ?? ''}-${prefill?.batch ?? ''}`} companyId={companyId} date={date} shift={shift} batches={open} prefill={prefill} />
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              {rights.readOnly ? t('biochemCommon.readOnly') : t('biochemWork.noRight')}
            </p>
          )}
          <Card title={t('biochemWork.board.title', { date: formatDate(date) })}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
              <Board title={t('biochemWork.board.make')} items={open.filter((b) => ['planned', 'reserved', 'weighed', 'in_process'].includes(b.status)).map((b) => ({ id: b.id, title: t('biochemWork.board.makeOne', { no: b.batch_no }), sub: b.product_name, status: b.status, duty: 'batch_maker', batch: b.id }))} onAssign={rights.edit ? setPrefill : undefined} />
              <Board title={t('biochemWork.board.pack')} items={open.filter((b) => ['bulk_passed', 'packing'].includes(b.status)).map((b) => ({ id: b.id, title: t('biochemWork.board.packOne', { no: b.batch_no }), sub: b.product_name, status: b.status, duty: 'packer', batch: b.id }))} onAssign={rights.edit ? setPrefill : undefined} />
              <Board title={t('biochemWork.board.test')} items={rowsOf(samples).map((s) => ({ id: s.id, title: t('biochemWork.board.testOne', { no: s.sample_no }), sub: s.batch_no ?? s.trial_code ?? '', status: s.status, duty: 'qc_tester', batch: s.batch_id ?? '' }))} onAssign={rights.edit ? setPrefill : undefined} />
              <Board title={t('biochemWork.board.release')} items={open.filter((b) => b.status === 'packed_hold').map((b) => ({ id: b.id, title: t('biochemWork.board.releaseOne', { no: b.batch_no }), sub: b.product_name, status: b.status, duty: 'qc_releaser', batch: b.id }))} onAssign={rights.edit ? setPrefill : undefined} />
            </div>
          </Card>
          <Assignments rows={rowsOf(asg)} loading={asg.isLoading} />
          <Card title={t('biochemWork.checks.title')}>
            <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <li>{t('biochemWork.checks.same')}</li>
              <li>{t('biochemWork.checks.role')}</li>
              <li>{t('biochemWork.checks.started')}</li>
              <li>{t('biochemWork.checks.logged')}</li>
            </ul>
          </Card>
        </div>
      )}
    </>
  )
}

function Board({ title, items, onAssign }: { title: string; items: { id: string; title: string; sub: string; status: string; duty: string; batch: string }[]; onAssign?: (p: { duty: string; batch: string }) => void }) {
  const { t } = useTranslation()
  return (
    <section aria-label={title} style={{ border: '1px solid var(--sf-line)', borderRadius: 8, padding: 10, background: 'var(--sf-paper)' }}>
      <h3 style={{ fontSize: 14, margin: '0 0 8px', display: 'flex', justifyContent: 'space-between' }}>
        <span>{title}</span>
        <span className="k mono">{items.length}</span>
      </h3>
      {items.length === 0 ? (
        <p className="k" style={{ margin: 0 }}>
          {t('biochemWork.board.none')}
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((i) => (
            <li key={i.id} className="sf-card sf-card__pad" style={{ padding: 10 }}>
              <strong className="mono">{i.title}</strong>
              <div className="k">{i.sub}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, gap: 6 }}>
                <ProdStatus status={i.status} />
                {onAssign && i.batch ? (
                  <Button size="sm" variant="link" onClick={() => onAssign({ duty: i.duty, batch: i.batch })} aria-label={t('biochemWork.board.assignOne', { what: i.title })}>
                    {t('biochemWork.board.assign')}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function AssignForm({ companyId, date, shift, batches, prefill }: { companyId: string; date: string; shift: string; batches: ViewRow<'batches'>[]; prefill: { duty: string; batch: string } | null }) {
  const { t } = useTranslation()
  const people = usePeople(companyId)
  const places = useCompanyPlaces(companyId)
  const assets = useApiView('assets', { eq: { company_id: companyId, status: 'active' }, order: 'code' })
  const [f, setF] = useState({ user_id: '', duty: prefill?.duty ?? 'batch_maker', batch_id: prefill?.batch ?? '', asset_id: '', hours: '', place_id: '' })
  const [hint, setHint] = useState<string | null>(null)
  const assign = useApiMutation<{ p: Record<string, unknown> }, { ids: string[] }>('assign_shift_duties', PROD_REFRESH)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  return (
    <Card title={t('biochemWork.assign.title')} accent={prefill ? 'signal' : undefined}>
      <FieldGrid cols={3}>
        <SelectField
          label={t('biochemWork.assign.person')}
          value={f.user_id}
          onChange={set('user_id')}
          options={[{ value: '', label: people.isLoading ? t('common.loading') : t('biochemWork.assign.choosePerson') }, ...people.list.map((p) => ({ value: p.id, label: p.name }))]}
          help={people.list.length === 0 && !people.isLoading ? t('biochemWork.assign.noPeople') : undefined}
        />
        <SelectField label={t('biochemWork.assign.duty')} value={f.duty} onChange={set('duty')} options={DUTIES.map((d) => ({ value: d, label: t(`biochemWork.duty.${d}`) }))} />
        <SelectField label={t('biochemWork.assign.batch')} value={f.batch_id} onChange={set('batch_id')} options={[{ value: '', label: t('biochemWork.assign.noBatch') }, ...batches.map((b) => ({ value: b.id, label: `${b.batch_no} · ${b.product_name}` }))]} />
        <SelectField label={t('biochemWork.assign.machine')} value={f.asset_id} onChange={set('asset_id')} options={[{ value: '', label: t('biochemWork.assign.noMachine') }, ...rowsOf(assets).map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))]} />
        <SelectField label={t('biochemWork.assign.place')} value={f.place_id} onChange={set('place_id')} options={[{ value: '', label: t('biochemWork.assign.noPlace') }, ...places.list.map((p) => ({ value: p.id, label: `${p.name} · ${p.branch_name}` }))]} />
        <Field label={t('biochemWork.assign.hours')} inputMode="decimal" value={f.hours} onChange={set('hours')} />
      </FieldGrid>
      <div style={{ marginTop: 12 }}>
        <Button
          variant="primary"
          busy={assign.isPending}
          onClick={() => {
            setHint(null)
            if (!f.user_id) return setHint(t('biochemWork.assign.hint'))
            assign.mutate({ p: { company_id: companyId, place_id: f.place_id || null, work_date: date, shift, assignments: [{ user_id: f.user_id, duty: f.duty, batch_id: f.batch_id || null, asset_id: f.asset_id || null, hours: f.hours.trim() || null }] } })
          }}
        >
          {t('biochemWork.assign.submit')}
        </Button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        {hint ? (
          <p role="alert" className="sf-alert" data-tone="danger" style={{ margin: 0 }}>
            {hint}
          </p>
        ) : null}
        <ProductionErrorBox error={assign.error} />
        <Done>{assign.data ? t('biochemWork.assign.done') : null}</Done>
      </div>
    </Card>
  )
}

function Assignments({ rows, loading }: { rows: Assignment[]; loading: boolean }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const remove = useApiMutation<{ p_assignment_id: string; p_reason: string }>('remove_shift_duty', PROD_REFRESH)
  const [reason, setReason] = useState('')
  const cols: Column<Assignment>[] = [
    { key: 'who', header: t('biochemWork.load.person'), render: (r) => r.user_name ?? '—' },
    { key: 'duty', header: t('biochemWork.assign.duty'), render: (r) => t(`biochemWork.duty.${r.duty}`, { defaultValue: r.duty }) },
    { key: 'shift', header: t('biochemWork.shift'), render: (r) => t(`biochemEntry.shift.${r.shift}`, { defaultValue: r.shift }) },
    { key: 'batch', header: t('biochemWork.assign.batch'), render: (r) => <span className="mono">{r.batch_no ?? '—'}</span> },
    { key: 'machine', header: t('biochemWork.assign.machine'), render: (r) => r.asset_code ?? '—' },
    { key: 'place', header: t('biochemWork.assign.place'), render: (r) => r.place_name ?? '—' },
    { key: 'hours', header: t('biochemWork.load.hours'), align: 'right', render: (r) => (r.hours !== null ? qtyText(r.hours) : '—') },
    {
      key: 'rm',
      header: <span className="sr-only">{t('biochemWork.remove')}</span>,
      render: (r) =>
        rights.edit ? (
          <Button size="sm" variant="link" busy={remove.isPending && remove.variables?.p_assignment_id === r.id} onClick={() => remove.mutate({ p_assignment_id: r.id, p_reason: reason.trim() })} aria-label={t('biochemWork.removeOne', { who: r.user_name ?? '', duty: t(`biochemWork.duty.${r.duty}`) })}>
            {t('biochemWork.remove')}
          </Button>
        ) : null,
    },
  ]
  return (
    <TableCard
      title={t('biochemWork.list.title')}
      action={
        rights.edit ? (
          <div style={{ width: 260 }}>
            <Field label={t('biochemWork.removeReason')} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        ) : null
      }
    >
      <DataTable caption={t('biochemWork.list.title')} columns={cols} rows={rows} rowKey={(r) => r.id} loading={loading} minWidth={860} empty={<EmptyState title={t('biochemWork.list.empty')} />} />
      {remove.error ? (
        <div style={{ padding: 16 }}>
          <ProductionErrorBox error={remove.error} />
        </div>
      ) : null}
    </TableCard>
  )
}

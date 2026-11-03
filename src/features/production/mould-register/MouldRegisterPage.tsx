import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { qtyText } from '@/features/inventory/common/inventory'
import { formatDate } from '@/shared/format'
import { Button, Card, Checkbox, Chip, DataTable, EmptyState, Field, FieldGrid, FormDialog, KpiTiles, SelectField, type Column } from '@/ui'
import { CostCell, Done, ProdStatus, useCompanyPlaces, useCompanyProducts, useProductionRights, ViewError } from '../biochem-common/biochem'
import { detailText, PlasticsErrorBox, PlasticsFrame, PLASTICS_REFRESH, useMachines } from '../plastics-common/plastics'

type Mould = ViewRow<'moulds'>
const LOCATIONS = ['rack', 'machine', 'repair', 'buyer', 'other'] as const

/**
 * Mould register (`MouldRegister`): every mould as an asset — what it makes, whose it is, where it is now and which
 * machine it is on, shots in total and since the last service. Moves (api.move_mould: one mould per machine) and
 * services (api.record_mould_service resets shots since service) are recorded here; shot counts grow only from shift
 * entries. Cost needs the cost right.
 */
export function MouldRegisterPage() {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const [editing, setEditing] = useState<Mould | 'new' | null>(null)
  return (
    <PlasticsFrame
      step="register"
      title={t('plMouldRegister.title')}
      subtitle={t('plMouldRegister.subtitle')}
      actions={() =>
        rights.edit ? (
          <Button variant="primary" onClick={() => setEditing('new')}>
            {t('plMouldRegister.add')}
          </Button>
        ) : null
      }
    >
      {(companyId) => (
        <>
          <Register companyId={companyId} onEdit={setEditing} />
          {editing ? <MouldDialog companyId={companyId} mould={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
        </>
      )}
    </PlasticsFrame>
  )
}

function LocationChip({ m }: { m: Mould }) {
  const { t } = useTranslation()
  const tone = m.location === 'machine' ? 'transit' : m.location === 'repair' ? 'signal' : m.location === 'buyer' ? 'navy' : 'outline'
  return (
    <Chip tone={tone}>
      {t(`plasticsCommon.location.${m.location}`, { defaultValue: m.location })}
      {m.location === 'machine' && m.machine_code ? ` · ${m.machine_code}` : ''}
    </Chip>
  )
}

function Register({ companyId, onEdit }: { companyId: string; onEdit: (m: Mould) => void }) {
  const { t } = useTranslation()
  const q = useApiView('moulds', { eq: { company_id: companyId }, order: 'code', limit: 2000 })
  const all = rowsOf(q)
  const [selected, setSelected] = useState<string | null>(null)
  const current = all.find((m) => m.id === selected) ?? null
  const live = all.filter((m) => m.status !== 'retired')
  const n = (v: number) => (q.isLoading ? '…' : String(v))
  const cols: Column<Mould>[] = [
    {
      key: 'code',
      header: t('plMouldRegister.col.mould'),
      render: (m) => (
        <Button size="sm" variant="link" onClick={() => setSelected(m.id)} aria-label={t('plMouldRegister.openOne', { code: m.code, name: m.name })}>
          {m.code} · {m.name}
        </Button>
      ),
    },
    { key: 'product', header: t('plMouldRegister.col.product'), render: (m) => (m.product_name ? `${m.product_code ?? ''} · ${m.product_name}` : <span className="k">{t('plMouldRegister.toSet')}</span>) },
    { key: 'owner', header: t('plMouldRegister.col.owner'), render: (m) => (m.ownership === 'buyer' ? (m.buyer_name ?? t('plasticsCommon.ownership.buyer')) : t('plasticsCommon.ownership.own')) },
    { key: 'cav', header: t('plMouldRegister.col.cavities'), align: 'right', render: (m) => <span className="sf-amount">{m.cavities}</span> },
    { key: 'cycle', header: t('plMouldRegister.col.cycle'), align: 'right', render: (m) => <span className="sf-amount">{qtyText(m.cycle_time_sec)}</span> },
    { key: 'where', header: t('plMouldRegister.col.where'), render: (m) => <LocationChip m={m} /> },
    { key: 'shots', header: t('plMouldRegister.col.shots'), align: 'right', render: (m) => <span className="sf-amount">{qtyText(m.shot_count)}</span> },
    {
      key: 'since',
      header: t('plMouldRegister.col.since'),
      align: 'right',
      render: (m) => (
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <span className="sf-amount">{qtyText(m.shots_since_service)}</span>
          {m.service_due ? (
            <Chip tone="signal" icon="alert">
              {t('plMouldRegister.serviceDue')}
            </Chip>
          ) : null}
        </span>
      ),
    },
    { key: 'life', header: t('plMouldRegister.col.life'), align: 'right', render: (m) => (m.life_used_pct !== null ? <span className="sf-amount">{qtyText(m.life_used_pct)} %</span> : '—') },
    { key: 'status', header: t('common.status'), render: (m) => <ProdStatus status={m.status} /> },
  ]
  const running = live.filter((m) => m.location === 'machine')
  const runCols: Column<Mould>[] = [
    { key: 'machine', header: t('plMouldRegister.run.machine'), render: (m) => <span className="mono">{m.machine_code ?? '—'}</span> },
    { key: 'unit', header: t('plMouldRegister.run.unit'), render: (m) => m.place_name ?? '—' },
    { key: 'mould', header: t('plMouldRegister.run.mould'), render: (m) => `${m.code} · ${m.product_name ?? m.name}` },
    { key: 'cav', header: t('plMouldRegister.col.cavities'), align: 'right', render: (m) => <span className="sf-amount">{m.cavities}</span> },
    { key: 'since', header: t('plMouldRegister.col.since'), align: 'right', render: (m) => <span className="sf-amount">{qtyText(m.shots_since_service)}</span> },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <KpiTiles
        ariaLabel={t('plMouldRegister.kpis')}
        items={[
          { key: 'all', label: t('plMouldRegister.kpi.all'), value: <span data-testid="mr-total">{n(live.length)}</span>, sub: t('plMouldRegister.kpi.allSub') },
          { key: 'machine', label: t('plMouldRegister.kpi.machine'), value: n(running.length) },
          { key: 'rack', label: t('plMouldRegister.kpi.rack'), value: n(live.filter((m) => m.location === 'rack').length) },
          { key: 'repair', label: t('plMouldRegister.kpi.repair'), value: n(live.filter((m) => m.location === 'repair').length) },
          { key: 'due', label: t('plMouldRegister.kpi.due'), value: n(live.filter((m) => m.service_due).length) },
          { key: 'buyer', label: t('plMouldRegister.kpi.buyer'), value: n(live.filter((m) => m.ownership === 'buyer').length) },
        ]}
      />
      <ViewError error={q.error} />
      {current ? <MouldPanel key={current.id} mould={current} onEdit={() => onEdit(current)} onClose={() => setSelected(null)} /> : null}
      <TableCard title={t('plMouldRegister.run.title')}>
        <DataTable caption={t('plMouldRegister.run.title')} columns={runCols} rows={running} rowKey={(m) => m.id} loading={q.isLoading} minWidth={640} empty={<EmptyState title={t('plMouldRegister.run.empty')} body={t('plMouldRegister.run.emptyBody')} />} />
      </TableCard>
      <TableCard title={t('plMouldRegister.listTitle')}>
        <DataTable caption={t('plMouldRegister.listTitle')} columns={cols} rows={all} rowKey={(m) => m.id} loading={q.isLoading} minWidth={1100} empty={<EmptyState title={t('plMouldRegister.emptyTitle')} body={t('plMouldRegister.emptyBody')} />} />
      </TableCard>
      <Card title={t('plMouldRegister.holds.title')}>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {['id', 'owner', 'where', 'size', 'production', 'value', 'history'].map((k) => (
            <li key={k}>
              <strong>{t(`plMouldRegister.holds.${k}.title`)}</strong> {t(`plMouldRegister.holds.${k}.body`)}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}

function MouldPanel({ mould, onEdit, onClose }: { mould: Mould; onEdit: () => void; onClose: () => void }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const machines = useMachines(mould.company_id, ['injection_machine'])
  const places = useCompanyPlaces(mould.company_id)
  const events = useApiView('mould_events', { eq: { mould_id: mould.id }, order: 'id', ascending: false })
  const move = useApiMutation<{ p_mould_id: string; p: Record<string, unknown> }, { id: string; location: string }>('move_mould', PLASTICS_REFRESH)
  const service = useApiMutation<{ p_mould_id: string; p: Record<string, unknown> }, { id: string; shots_at_service: number }>('record_mould_service', PLASTICS_REFRESH)
  const [mv, setMv] = useState({ location: mould.location === 'machine' ? 'rack' : 'machine', machine_asset_id: '', place_id: '', date: todayIst(), note: '' })
  const [sv, setSv] = useState({ kind: 'service', amount: '', date: todayIst(), note: '' })
  const [done, setDone] = useState<string | null>(null)
  const evCols: Column<ViewRow<'mould_events'>>[] = [
    { key: 'date', header: t('plMouldRegister.ev.date'), render: (e) => formatDate(e.event_date) },
    { key: 'kind', header: t('plMouldRegister.ev.kind'), render: (e) => t(`plMouldRegister.evKind.${e.kind}`, { defaultValue: e.kind }) },
    { key: 'shots', header: t('plMouldRegister.ev.shots'), align: 'right', render: (e) => (e.shots !== null ? <span className="sf-amount">{qtyText(e.shots)}</span> : '—') },
    { key: 'detail', header: t('plMouldRegister.ev.detail'), render: (e) => detailText(e.detail) || '—' },
    { key: 'amount', header: t('plMouldRegister.ev.amount'), align: 'right', render: (e) => (e.kind === 'service' || e.kind === 'repair' ? <CostCell value={e.amount} /> : '—') },
    { key: 'by', header: t('plMouldRegister.ev.by'), render: (e) => e.recorded_by_name ?? '—' },
  ]
  const live = mould.status !== 'retired'
  return (
    <Card
      title={t('plMouldRegister.panelTitle', { code: mould.code, name: mould.name })}
      action={
        <span style={{ display: 'inline-flex', gap: 8 }}>
          {rights.edit ? (
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
      <p className="muted" style={{ marginTop: 0 }} data-testid="mr-where">
        <LocationChip m={mould} /> · {mould.place_name ?? t('plMouldRegister.toSet')} · {t('plMouldRegister.material', { item: mould.material_code ?? '—' })}
      </p>
      {rights.create && live ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
          <section aria-labelledby="mr-move">
            <h3 id="mr-move" style={{ fontSize: 15, margin: '8px 0' }}>
              {t('plMouldRegister.move.title')}
            </h3>
            <FieldGrid cols={2}>
              <SelectField label={t('plMouldRegister.move.to')} value={mv.location} onChange={(e) => setMv({ ...mv, location: e.target.value })} options={LOCATIONS.map((l) => ({ value: l, label: t(`plasticsCommon.location.${l}`) }))} />
              {mv.location === 'machine' ? (
                <SelectField label={t('plMouldRegister.move.machine')} value={mv.machine_asset_id} onChange={(e) => setMv({ ...mv, machine_asset_id: e.target.value })} options={[{ value: '', label: t('plMouldRegister.move.chooseMachine') }, ...machines.list.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}${a.mould_on_machine ? ` (${a.mould_on_machine})` : ''}` }))]} />
              ) : (
                <SelectField label={t('plMouldRegister.move.place')} value={mv.place_id} onChange={(e) => setMv({ ...mv, place_id: e.target.value })} options={[{ value: '', label: t('plMouldRegister.move.samePlace') }, ...places.list.map((p) => ({ value: p.id, label: `${p.name} · ${p.branch_name}` }))]} />
              )}
              <Field label={t('plMouldRegister.move.date')} type="date" value={mv.date} onChange={(e) => setMv({ ...mv, date: e.target.value })} />
              <Field label={t('plMouldRegister.move.note')} value={mv.note} onChange={(e) => setMv({ ...mv, note: e.target.value })} />
            </FieldGrid>
            <div style={{ marginTop: 8 }}>
              <Button
                variant="primary"
                busy={move.isPending}
                onClick={() => {
                  setDone(null)
                  move.mutate(
                    { p_mould_id: mould.id, p: { location: mv.location, machine_asset_id: mv.location === 'machine' ? mv.machine_asset_id || null : null, place_id: mv.location === 'machine' ? null : mv.place_id || null, date: mv.date, note: mv.note.trim() || null } },
                    { onSuccess: (r) => setDone(t('plMouldRegister.move.done', { where: t(`plasticsCommon.location.${r.location}`) })) },
                  )
                }}
              >
                {t('plMouldRegister.move.save')}
              </Button>
            </div>
          </section>
          <section aria-labelledby="mr-service">
            <h3 id="mr-service" style={{ fontSize: 15, margin: '8px 0' }}>
              {t('plMouldRegister.service.title')}
            </h3>
            <FieldGrid cols={2}>
              <SelectField label={t('plMouldRegister.service.kind')} value={sv.kind} onChange={(e) => setSv({ ...sv, kind: e.target.value })} options={['service', 'repair'].map((k) => ({ value: k, label: t(`plMouldRegister.evKind.${k}`) }))} />
              <Field label={t('plMouldRegister.service.date')} type="date" value={sv.date} onChange={(e) => setSv({ ...sv, date: e.target.value })} />
              {rights.costs ? <Field label={t('plMouldRegister.service.amount')} inputMode="decimal" value={sv.amount} onChange={(e) => setSv({ ...sv, amount: e.target.value })} /> : null}
              <Field label={t('plMouldRegister.service.note')} value={sv.note} onChange={(e) => setSv({ ...sv, note: e.target.value })} />
            </FieldGrid>
            <div style={{ marginTop: 8 }}>
              <Button
                busy={service.isPending}
                onClick={() => {
                  setDone(null)
                  service.mutate({ p_mould_id: mould.id, p: { kind: sv.kind, amount: sv.amount.trim() || null, date: sv.date, note: sv.note.trim() || null } }, { onSuccess: (r) => setDone(t('plMouldRegister.service.done', { shots: qtyText(r.shots_at_service) })) })
                }}
              >
                {t('plMouldRegister.service.save')}
              </Button>
            </div>
          </section>
        </div>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        <PlasticsErrorBox error={move.error ?? service.error} />
        <Done>{done}</Done>
      </div>
      <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>{t('plMouldRegister.ev.title')}</h3>
      <DataTable caption={t('plMouldRegister.ev.title')} columns={evCols} rows={rowsOf(events)} rowKey={(e) => String(e.id)} loading={events.isLoading} minWidth={640} empty={<EmptyState title={t('plMouldRegister.ev.empty')} />} />
    </Card>
  )
}

function MouldDialog({ companyId, mould, onClose }: { companyId: string; mould: Mould | null; onClose: () => void }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const products = useCompanyProducts(companyId)
  const places = useCompanyPlaces(companyId)
  const projects = useApiView('mould_projects', { eq: { company_id: companyId }, order: 'code', limit: 500 })
  const buyers = useApiView('customers', { eq: { company_id: companyId }, order: 'name', limit: 2000 })
  const costs = useApiView('mould_costs', { eq: { mould_id: mould?.id }, enabled: Boolean(mould) && rights.costs })
  const oldCost = rowsOf(costs)[0]?.cost ?? null
  const save = useApiMutation<{ p: Record<string, unknown> }, { id: string }>('upsert_mould', PLASTICS_REFRESH)
  const s = (v: number | string | null | undefined) => (v === null || v === undefined ? '' : String(v))
  const [f, setF] = useState({
    code: mould?.code ?? '',
    name: mould?.name ?? '',
    project_id: mould?.project_id ?? '',
    product_id: mould?.product_id ?? '',
    material_product_id: mould?.material_product_id ?? '',
    cavities: s(mould?.cavities),
    cycle_time_sec: s(mould?.cycle_time_sec),
    part_weight_g: s(mould?.part_weight_g),
    runner_weight_g: s(mould?.runner_weight_g),
    ownership: mould?.ownership ?? 'own',
    buyer_party_id: mould?.buyer_party_id ?? '',
    place_id: mould?.place_id ?? '',
    service_interval_shots: s(mould?.service_interval_shots),
    life_shots: s(mould?.life_shots),
    cost: '',
    shot_count: '',
    retire: false,
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const n = (v: string) => (v.trim() ? v.trim().replace(/,/g, '') : null)
  const productOpts = [{ value: '', label: t('plMouldRegister.toSet') }, ...products.list.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))]
  return (
    <FormDialog
      open
      wide
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={mould ? t('plMouldRegister.editTitle') : t('plMouldRegister.addTitle')}
      description={t('plMouldRegister.dialogHint')}
      submitLabel={t('common.save')}
      busy={save.isPending}
      error={<PlasticsErrorBox error={save.error} />}
      onSubmit={() =>
        save.mutate(
          {
            p: {
              id: mould?.id ?? null,
              company_id: companyId,
              code: f.code.trim(),
              name: f.name.trim(),
              project_id: n(f.project_id),
              product_id: n(f.product_id),
              material_product_id: n(f.material_product_id),
              cavities: n(f.cavities),
              cycle_time_sec: n(f.cycle_time_sec),
              part_weight_g: n(f.part_weight_g),
              runner_weight_g: n(f.runner_weight_g),
              ownership: f.ownership,
              buyer_party_id: f.ownership === 'buyer' ? n(f.buyer_party_id) : null,
              place_id: mould ? null : n(f.place_id),
              service_interval_shots: n(f.service_interval_shots),
              life_shots: n(f.life_shots),
              cost: rights.costs ? (n(f.cost) ?? (oldCost !== null ? String(oldCost) : null)) : null,
              shot_count: mould ? null : n(f.shot_count),
              status: f.retire ? 'retired' : null,
            },
          },
          { onSuccess: onClose },
        )
      }
    >
      <FieldGrid cols={3}>
        <Field label={t('plMouldRegister.f.code')} value={f.code} onChange={set('code')} required />
        <Field label={t('plMouldRegister.f.name')} value={f.name} onChange={set('name')} required />
        <SelectField label={t('plMouldRegister.f.project')} value={f.project_id} onChange={set('project_id')} options={[{ value: '', label: t('plMouldRegister.f.noProject') }, ...rowsOf(projects).map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))]} />
        <SelectField label={t('plMouldRegister.f.product')} value={f.product_id} onChange={set('product_id')} options={productOpts} />
        <SelectField label={t('plMouldRegister.f.material')} value={f.material_product_id} onChange={set('material_product_id')} options={productOpts} />
        <Field label={t('plMouldRegister.f.cavities')} inputMode="numeric" value={f.cavities} onChange={set('cavities')} required />
        <Field label={t('plMouldRegister.f.cycle')} inputMode="decimal" value={f.cycle_time_sec} onChange={set('cycle_time_sec')} required />
        <Field label={t('plMouldRegister.f.partWeight')} inputMode="decimal" value={f.part_weight_g} onChange={set('part_weight_g')} />
        <Field label={t('plMouldRegister.f.runnerWeight')} inputMode="decimal" value={f.runner_weight_g} onChange={set('runner_weight_g')} />
        <SelectField label={t('plMouldRegister.f.ownership')} value={f.ownership} onChange={set('ownership')} options={['own', 'buyer'].map((o) => ({ value: o, label: t(`plasticsCommon.ownership.${o}`) }))} />
        {f.ownership === 'buyer' ? <SelectField label={t('plMouldRegister.f.buyer')} value={f.buyer_party_id} onChange={set('buyer_party_id')} options={[{ value: '', label: t('plMouldRegister.f.chooseBuyer') }, ...rowsOf(buyers).map((b) => ({ value: b.id, label: b.name }))]} /> : null}
        {!mould ? <SelectField label={t('plMouldRegister.f.place')} value={f.place_id} onChange={set('place_id')} options={[{ value: '', label: t('plMouldRegister.toSet') }, ...places.list.map((p) => ({ value: p.id, label: `${p.name} · ${p.branch_name}` }))]} /> : null}
        <Field label={t('plMouldRegister.f.interval')} inputMode="numeric" value={f.service_interval_shots} onChange={set('service_interval_shots')} />
        <Field label={t('plMouldRegister.f.life')} inputMode="numeric" value={f.life_shots} onChange={set('life_shots')} />
        {!mould ? <Field label={t('plMouldRegister.f.shots')} inputMode="numeric" value={f.shot_count} onChange={set('shot_count')} /> : null}
        {rights.costs ? <Field label={t('plMouldRegister.f.cost')} inputMode="decimal" value={f.cost} onChange={set('cost')} placeholder={oldCost !== null ? String(oldCost) : undefined} /> : null}
      </FieldGrid>
      {mould && mould.status !== 'retired' ? (
        <Checkbox label={t('plMouldRegister.f.retire')} checked={f.retire} onChange={(e) => setF({ ...f, retire: e.target.checked })} />
      ) : null}
    </FormDialog>
  )
}

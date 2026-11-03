import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { qtyText } from '@/features/inventory/common/inventory'
import { formatDate } from '@/shared/format'
import { Button, Card, DataTable, EmptyState, Field, FieldGrid, KeyValue, SelectField, type Column } from '@/ui'
import { Done, ProdStatus, useCompanyPlaces, useCompanyProducts, useProductionRights, ViewError } from '../biochem-common/biochem'
import { Pct, PlasticsErrorBox, PlasticsFrame, PLASTICS_REFRESH, useCompanyPeople, useMachines } from '../plastics-common/plastics'

type Shift = ViewRow<'injection_shifts'>
const DOWN_KINDS = ['breakdown', 'mould_change', 'no_material', 'no_operator', 'power', 'setting', 'other'] as const

interface ShiftResult {
  id: string
  doc_no: string
  lot_id: string | null
  run_minutes: number
  theoretical_qty: number
  total_qty: number
  shots: number
  availability: number | null
  performance: number | null
  quality: number | null
  oee: number | null
}

/**
 * Injection production (`Production`): the shift entry for one machine and mould — operator, cavities running, planned
 * minutes, downtime, shot counter, good pieces, rejects by reason, granules and regrind used, scrap weighed out. The
 * server (api.record_injection_shift) works out run time, theoretical output, availability, performance, quality and
 * OEE (docs/KPI_DEFINITIONS.md), takes materials out of stock into the consumption ledger and puts good pieces into
 * quarantine until a quality inspection. The screen shows the server's figures, never its own.
 */
export function InjectionProductionPage() {
  const { t } = useTranslation()
  return (
    <PlasticsFrame step="moulding" title={t('plInjection.title')} subtitle={t('plInjection.subtitle')}>
      {(companyId) => <Injection companyId={companyId} />}
    </PlasticsFrame>
  )
}

function Injection({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const machines = useMachines(companyId, ['injection_machine'])
  const shifts = useApiView('injection_shifts', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 300 })
  const today = todayIst()
  const todayRows = rowsOf(shifts).filter((s) => s.shift_date === today)
  const cols: Column<Shift>[] = [
    { key: 'doc', header: t('plInjection.col.doc'), render: (s) => <span className="mono">{s.doc_no}</span> },
    { key: 'when', header: t('plInjection.col.when'), render: (s) => `${formatDate(s.shift_date)} · ${t(`plasticsCommon.shift.${s.shift}`, { defaultValue: s.shift })}` },
    { key: 'machine', header: t('plInjection.col.machine'), render: (s) => <span className="mono">{s.machine_code}</span> },
    { key: 'mould', header: t('plInjection.col.mould'), render: (s) => `${s.mould_code} · ${s.product_name}` },
    { key: 'op', header: t('plInjection.col.operator'), render: (s) => s.operator_name ?? '—' },
    { key: 'good', header: t('plInjection.col.good'), align: 'right', render: (s) => <span className="sf-amount">{qtyText(s.good_qty)}</span> },
    { key: 'rej', header: t('plInjection.col.rejects'), align: 'right', render: (s) => <span className="sf-amount">{qtyText(s.reject_qty)}</span> },
    { key: 'theo', header: t('plInjection.col.theoretical'), align: 'right', render: (s) => <span className="sf-amount">{qtyText(s.theoretical_qty)}</span> },
    { key: 'a', header: t('plInjection.col.availability'), align: 'right', render: (s) => <Pct value={s.availability} /> },
    { key: 'p', header: t('plInjection.col.performance'), align: 'right', render: (s) => <Pct value={s.performance} /> },
    { key: 'q', header: t('plInjection.col.quality'), align: 'right', render: (s) => <Pct value={s.quality} /> },
    { key: 'oee', header: t('plInjection.col.oee'), align: 'right', render: (s) => <strong><Pct value={s.oee} testId={`oee-${s.doc_no}`} /></strong> },
    { key: 'lot', header: t('plInjection.col.lot'), render: (s) => <ProdStatus status={s.lot_status} /> },
  ]
  const machineCols: Column<ViewRow<'assets'>>[] = [
    { key: 'machine', header: t('plInjection.board.machine'), render: (a) => <span><span className="mono">{a.code}</span> · {a.name}</span> },
    { key: 'unit', header: t('plInjection.board.unit'), render: (a) => a.place_name ?? '—' },
    { key: 'mould', header: t('plInjection.board.mould'), render: (a) => a.mould_on_machine ?? <span className="k">{t('plInjection.board.noMould')}</span> },
    { key: 'good', header: t('plInjection.board.good'), align: 'right', render: (a) => <span className="sf-amount">{qtyText(todayRows.filter((s) => s.machine_asset_id === a.id).reduce((n, s) => n + Number(s.good_qty), 0))}</span> },
    { key: 'status', header: t('common.status'), render: (a) => <ProdStatus status={a.status} /> },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <TableCard title={t('plInjection.board.title')}>
        <DataTable caption={t('plInjection.board.title')} columns={machineCols} rows={machines.list} rowKey={(a) => a.id} loading={machines.isLoading} minWidth={720} empty={<EmptyState title={t('plInjection.board.empty')} body={t('plInjection.board.emptyBody')} />} />
      </TableCard>
      {rights.create ? <ShiftEntry companyId={companyId} machines={machines.list} /> : <Card><p className="k" style={{ margin: 0 }}>{t('plInjection.noCreate')}</p></Card>}
      <ViewError error={shifts.error} />
      <TableCard title={t('plInjection.listTitle')}>
        <DataTable caption={t('plInjection.listTitle')} columns={cols} rows={rowsOf(shifts)} rowKey={(s) => s.id} loading={shifts.isLoading} minWidth={1400} empty={<EmptyState title={t('plInjection.emptyTitle')} body={t('plInjection.emptyBody')} />} />
      </TableCard>
      <Card title={t('plInjection.reports.title')}>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {['output', 'hours', 'rejects', 'oee'].map((k) => (
            <li key={k}>{t(`plInjection.reports.${k}`)}</li>
          ))}
        </ul>
      </Card>
    </div>
  )
}

interface Line {
  a: string
  b: string
  c: string
}
const empty = (): Line => ({ a: '', b: '', c: '' })

function ShiftEntry({ companyId, machines }: { companyId: string; machines: ViewRow<'assets'>[] }) {
  const { t } = useTranslation()
  const places = useCompanyPlaces(companyId)
  const products = useCompanyProducts(companyId)
  const people = useCompanyPeople(companyId)
  const mouldsQ = useApiView('moulds', { eq: { company_id: companyId }, order: 'code', limit: 2000 })
  const moulds = rowsOf(mouldsQ).filter((m) => m.status === 'active')
  const save = useApiMutation<{ p: Record<string, unknown> }, ShiftResult>('record_injection_shift', PLASTICS_REFRESH)
  const [f, setF] = useState({ place_id: '', output_place_id: '', date: todayIst(), shift: 'day', machine_asset_id: '', mould_id: '', operator_user_id: '', operator_name: '', cavities_running: '', planned_minutes: '', shot_start: '', shot_end: '', good_qty: '', note: '' })
  const [rejects, setRejects] = useState<Line[]>([empty()])
  const [down, setDown] = useState<Line[]>([{ a: 'breakdown', b: '', c: '' }])
  const [mats, setMats] = useState<Line[]>([empty()])
  const [regrind, setRegrind] = useState<Line[]>([empty()])
  const [scrap, setScrap] = useState<Line>(empty())
  const [hint, setHint] = useState<string | null>(null)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const mould = moulds.find((m) => m.id === f.mould_id)
  const placeOpts = [{ value: '', label: t('plInjection.f.choosePlace') }, ...places.list.map((p) => ({ value: p.id, label: `${p.name} · ${p.branch_name}` }))]
  const itemOpts = [{ value: '', label: t('plInjection.f.chooseItem') }, ...products.list.filter((p) => !p.is_scrap).map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))]
  const scrapOpts = [{ value: '', label: t('plInjection.f.chooseItem') }, ...products.list.filter((p) => p.is_scrap).map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))]
  const num = (v: string) => v.replace(/[,\s]/g, '')
  const res = save.data

  function chooseMachine(id: string) {
    const on = moulds.find((m) => m.machine_asset_id === id && m.location === 'machine')
    const a = machines.find((x) => x.id === id)
    setF({ ...f, machine_asset_id: id, mould_id: on?.id ?? f.mould_id, cavities_running: on ? String(on.cavities) : f.cavities_running, place_id: f.place_id || a?.place_id || '' })
  }

  function submit() {
    setHint(null)
    if (!f.place_id || !f.output_place_id || !f.machine_asset_id || !f.mould_id) return setHint(t('plInjection.f.hintRequired'))
    const person = people.list.find((p) => p.user_id === f.operator_user_id)
    save.mutate({
      p: {
        company_id: companyId,
        place_id: f.place_id,
        output_place_id: f.output_place_id,
        date: f.date,
        shift: f.shift,
        machine_asset_id: f.machine_asset_id,
        mould_id: f.mould_id,
        operator_user_id: f.operator_user_id || null,
        operator_name: person?.display_name ?? (f.operator_name.trim() || null),
        cavities_running: num(f.cavities_running) || null,
        planned_minutes: num(f.planned_minutes) || null,
        shot_start: num(f.shot_start) || null,
        shot_end: num(f.shot_end) || null,
        good_qty: num(f.good_qty) || null,
        rejects: rejects.filter((r) => num(r.b)).map((r) => ({ reason: r.a.trim() || null, qty: num(r.b) })),
        downtime: down.filter((d) => num(d.c)).map((d) => ({ kind: d.a, reason: d.b.trim() || null, minutes: num(d.c) })),
        materials: mats.filter((m) => m.a && num(m.c)).map((m) => ({ product_id: m.a, place_id: m.b || null, qty: num(m.c) })),
        regrind: regrind.filter((m) => m.a && num(m.c)).map((m) => ({ product_id: m.a, place_id: m.b || null, qty: num(m.c) })),
        scrap: scrap.a && num(scrap.c) ? { product_id: scrap.a, place_id: scrap.b || null, qty: num(scrap.c) } : null,
        note: f.note.trim() || null,
      },
    })
  }

  const lineSet = (list: Line[], setList: (l: Line[]) => void, i: number, k: keyof Line) => (e: { target: { value: string } }) => setList(list.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))

  return (
    <Card title={t('plInjection.entry.title')}>
      <p className="k" style={{ marginTop: 0 }}>
        {t('plInjection.entry.sub')}
      </p>
      <FieldGrid cols={3}>
        <Field label={t('plInjection.f.date')} type="date" value={f.date} onChange={set('date')} />
        <SelectField label={t('plInjection.f.shift')} value={f.shift} onChange={set('shift')} options={['day', 'night', 'general'].map((s) => ({ value: s, label: t(`plasticsCommon.shift.${s}`) }))} />
        <SelectField label={t('plInjection.f.machine')} value={f.machine_asset_id} onChange={(e) => chooseMachine(e.target.value)} options={[{ value: '', label: t('plInjection.f.chooseMachine') }, ...machines.filter((a) => a.status === 'active').map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))]} />
        <SelectField
          label={t('plInjection.f.mould')}
          value={f.mould_id}
          onChange={(e) => {
            const m = moulds.find((x) => x.id === e.target.value)
            setF({ ...f, mould_id: e.target.value, cavities_running: m ? String(m.cavities) : f.cavities_running })
          }}
          options={[{ value: '', label: t('plInjection.f.chooseMould') }, ...moulds.map((m) => ({ value: m.id, label: `${m.code} · ${m.product_name ?? m.name}` }))]}
          help={mould ? t('plInjection.f.mouldHelp', { cavities: mould.cavities, cycle: qtyText(mould.cycle_time_sec) }) : undefined}
        />
        <SelectField label={t('plInjection.f.operator')} value={f.operator_user_id} onChange={set('operator_user_id')} options={[{ value: '', label: t('plInjection.f.operatorOther') }, ...people.list.map((p) => ({ value: p.user_id, label: p.display_name ?? '—' }))]} />
        {!f.operator_user_id ? <Field label={t('plInjection.f.operatorName')} value={f.operator_name} onChange={set('operator_name')} /> : <span />}
        <SelectField label={t('plInjection.f.unit')} value={f.place_id} onChange={set('place_id')} options={placeOpts} />
        <SelectField label={t('plInjection.f.output')} value={f.output_place_id} onChange={set('output_place_id')} options={placeOpts} help={t('plInjection.f.outputHelp')} />
        <Field label={t('plInjection.f.cavities')} inputMode="numeric" value={f.cavities_running} onChange={set('cavities_running')} />
        <Field label={t('plInjection.f.planned')} inputMode="numeric" value={f.planned_minutes} onChange={set('planned_minutes')} />
        <Field label={t('plInjection.f.shotStart')} inputMode="numeric" value={f.shot_start} onChange={set('shot_start')} />
        <Field label={t('plInjection.f.shotEnd')} inputMode="numeric" value={f.shot_end} onChange={set('shot_end')} />
        <Field label={t('plInjection.f.good')} inputMode="numeric" value={f.good_qty} onChange={set('good_qty')} />
        <Field label={t('plInjection.f.note')} value={f.note} onChange={set('note')} />
      </FieldGrid>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 16, marginTop: 16 }}>
        <fieldset style={{ border: '1px solid var(--sf-line)', borderRadius: 8, padding: 12 }}>
          <legend>{t('plInjection.rejects.title')}</legend>
          {rejects.map((r, i) => (
            <FieldGrid key={i} cols={2}>
              <Field label={t('plInjection.rejects.reason', { n: i + 1 })} value={r.a} onChange={lineSet(rejects, setRejects, i, 'a')} />
              <Field label={t('plInjection.rejects.qty', { n: i + 1 })} inputMode="numeric" value={r.b} onChange={lineSet(rejects, setRejects, i, 'b')} />
            </FieldGrid>
          ))}
          <Button size="sm" variant="link" onClick={() => setRejects([...rejects, empty()])}>
            {t('plInjection.rejects.add')}
          </Button>
        </fieldset>
        <fieldset style={{ border: '1px solid var(--sf-line)', borderRadius: 8, padding: 12 }}>
          <legend>{t('plInjection.down.title')}</legend>
          {down.map((d, i) => (
            <FieldGrid key={i} cols={3}>
              <SelectField label={t('plInjection.down.kind', { n: i + 1 })} value={d.a} onChange={lineSet(down, setDown, i, 'a')} options={DOWN_KINDS.map((k) => ({ value: k, label: t(`plInjection.downKind.${k}`) }))} />
              <Field label={t('plInjection.down.reason', { n: i + 1 })} value={d.b} onChange={lineSet(down, setDown, i, 'b')} />
              <Field label={t('plInjection.down.minutes', { n: i + 1 })} inputMode="numeric" value={d.c} onChange={lineSet(down, setDown, i, 'c')} />
            </FieldGrid>
          ))}
          <Button size="sm" variant="link" onClick={() => setDown([...down, { a: 'other', b: '', c: '' }])}>
            {t('plInjection.down.add')}
          </Button>
        </fieldset>
        <fieldset style={{ border: '1px solid var(--sf-line)', borderRadius: 8, padding: 12 }}>
          <legend>{t('plInjection.mats.title')}</legend>
          {mats.map((m, i) => (
            <FieldGrid key={i} cols={3}>
              <SelectField label={t('plInjection.mats.item', { n: i + 1 })} value={m.a} onChange={lineSet(mats, setMats, i, 'a')} options={itemOpts} />
              <SelectField label={t('plInjection.mats.from', { n: i + 1 })} value={m.b} onChange={lineSet(mats, setMats, i, 'b')} options={placeOpts} />
              <Field label={t('plInjection.mats.qty', { n: i + 1 })} inputMode="decimal" value={m.c} onChange={lineSet(mats, setMats, i, 'c')} />
            </FieldGrid>
          ))}
          <Button size="sm" variant="link" onClick={() => setMats([...mats, empty()])}>
            {t('plInjection.mats.add')}
          </Button>
        </fieldset>
        <fieldset style={{ border: '1px solid var(--sf-line)', borderRadius: 8, padding: 12 }}>
          <legend>{t('plInjection.regrind.title')}</legend>
          {regrind.map((m, i) => (
            <FieldGrid key={i} cols={3}>
              <SelectField label={t('plInjection.regrind.item', { n: i + 1 })} value={m.a} onChange={lineSet(regrind, setRegrind, i, 'a')} options={scrapOpts} />
              <SelectField label={t('plInjection.regrind.from', { n: i + 1 })} value={m.b} onChange={lineSet(regrind, setRegrind, i, 'b')} options={placeOpts} />
              <Field label={t('plInjection.regrind.qty', { n: i + 1 })} inputMode="decimal" value={m.c} onChange={lineSet(regrind, setRegrind, i, 'c')} />
            </FieldGrid>
          ))}
          <Button size="sm" variant="link" onClick={() => setRegrind([...regrind, empty()])}>
            {t('plInjection.regrind.add')}
          </Button>
          <p className="k" style={{ margin: '12px 0 4px' }}>
            {t('plInjection.scrap.title')}
          </p>
          <FieldGrid cols={3}>
            <SelectField label={t('plInjection.scrap.item')} value={scrap.a} onChange={(e) => setScrap({ ...scrap, a: e.target.value })} options={scrapOpts} />
            <SelectField label={t('plInjection.scrap.to')} value={scrap.b} onChange={(e) => setScrap({ ...scrap, b: e.target.value })} options={placeOpts} />
            <Field label={t('plInjection.scrap.qty')} inputMode="decimal" value={scrap.c} onChange={(e) => setScrap({ ...scrap, c: e.target.value })} />
          </FieldGrid>
        </fieldset>
      </div>

      <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button variant="primary" busy={save.isPending} onClick={submit}>
          {t('plInjection.save')}
        </Button>
        <span className="k">{t('plInjection.saveHint')}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        {hint ? (
          <p role="alert" className="sf-alert" data-tone="danger" style={{ margin: 0 }}>
            {hint}
          </p>
        ) : null}
        <PlasticsErrorBox error={save.error} />
        <Done>{res ? t('plInjection.saved', { doc: res.doc_no }) : null}</Done>
      </div>
      {res ? (
        <section aria-labelledby="shift-result-h" data-testid="shift-result" className="sf-card sf-card__pad" style={{ marginTop: 12, background: 'var(--sf-paper)' }}>
          <h3 id="shift-result-h" style={{ fontSize: 15, margin: '0 0 8px' }}>
            {t('plInjection.result.title', { doc: res.doc_no })}
          </h3>
          <KeyValue
            rows={[
              { label: t('plInjection.result.run'), value: <span className="sf-amount">{qtyText(res.run_minutes)}</span> },
              { label: t('plInjection.result.theoretical'), value: <span className="sf-amount" data-testid="shift-theoretical">{qtyText(res.theoretical_qty)}</span> },
              { label: t('plInjection.result.total'), value: <span className="sf-amount">{qtyText(res.total_qty)}</span> },
              { label: t('plInjection.result.shots'), value: <span className="sf-amount">{qtyText(res.shots)}</span> },
              { label: t('plInjection.col.availability'), value: <Pct value={res.availability} testId="shift-availability" /> },
              { label: t('plInjection.col.performance'), value: <Pct value={res.performance} testId="shift-performance" /> },
              { label: t('plInjection.col.quality'), value: <Pct value={res.quality} testId="shift-quality" /> },
              { label: t('plInjection.col.oee'), value: <Pct value={res.oee} testId="shift-oee" />, total: true },
            ]}
          />
          <p className="k" style={{ margin: '8px 0 0' }}>
            {res.lot_id ? t('plInjection.result.toQuality') : t('plInjection.result.noLot')}
          </p>
        </section>
      ) : null}
    </Card>
  )
}

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { qtyText } from '@/features/inventory/common/inventory'
import { formatDate } from '@/shared/format'
import { Button, Card, DataTable, EmptyState, Field, FieldGrid, SelectField, Skeleton, Tabs, TextAreaField, type Column } from '@/ui'
import { Done, ProdStatus, useProductionRights, ViewError } from '../biochem-common/biochem'
import { PlasticsErrorBox, PlasticsFrame, PLASTICS_REFRESH } from '../plastics-common/plastics'

/** A lot waiting for inspection: from a moulding shift or an assembly order. */
interface Waiting {
  lotId: string
  source: 'shift' | 'assembly'
  doc: string
  date: string
  product: string
  detail: string
  qty: number
  makers: (string | null)[]
}
type Tab = 'open' | 'done'

/**
 * Quality (`Quality`): moulded and assembled lots wait in quarantine until an inspection clears them. Final and assembly
 * inspections decide the whole quarantined quantity (accepted + rejected = quantity in quarantine; accepted → stock,
 * rejected → rejection bucket). The inspector is never the operator, recorder or assembler of the lot
 * (sod.inspector_maker, checked by api.record_quality_inspection) — the screen shows the server's refusal.
 */
export function QualityPage() {
  const { t } = useTranslation()
  return (
    <PlasticsFrame step="quality" title={t('plQuality.title')} subtitle={t('plQuality.subtitle')}>
      {(companyId) => <Quality companyId={companyId} />}
    </PlasticsFrame>
  )
}

function Quality({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const shifts = useApiView('injection_shifts', { eq: { company_id: companyId, lot_status: 'quarantine' }, order: 'created_at', ascending: false, limit: 500 })
  const orders = useApiView('assembly_orders', { eq: { company_id: companyId, lot_status: 'quarantine' }, order: 'created_at', ascending: false, limit: 500 })
  const done = useApiView('quality_inspections', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 300 })
  const [tab, setTab] = useState<Tab>('open')
  const [current, setCurrent] = useState<Waiting | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const waiting: Waiting[] = [
    ...rowsOf(shifts)
      .filter((s) => s.lot_id)
      .map((s) => ({ lotId: s.lot_id ?? '', source: 'shift' as const, doc: s.doc_no, date: s.created_at, product: `${s.product_code} · ${s.product_name}`, detail: `${s.machine_code} · ${t(`plasticsCommon.shift.${s.shift}`, { defaultValue: s.shift })} · ${s.mould_code}`, qty: Number(s.good_qty), makers: [s.operator_user_id, s.recorded_by] })),
    ...rowsOf(orders)
      .filter((o) => o.lot_id)
      .map((o) => ({ lotId: o.lot_id ?? '', source: 'assembly' as const, doc: o.doc_no, date: o.created_at, product: `${o.product_code} · ${o.product_name}`, detail: t('plQuality.assembledBy', { name: o.assembled_by_name ?? '—' }), qty: Number(o.qty), makers: [o.assembled_by] })),
  ]
  const cols: Column<Waiting>[] = [
    {
      key: 'doc',
      header: t('plQuality.col.lot'),
      render: (w) => (
        <Button size="sm" variant="link" onClick={() => { setSaved(null); setCurrent(w) }} aria-label={t('plQuality.openOne', { doc: w.doc })}>
          <span className="mono">{w.doc}</span>
        </Button>
      ),
    },
    { key: 'type', header: t('plQuality.col.type'), render: (w) => t(`plQuality.source.${w.source}`) },
    { key: 'item', header: t('plQuality.col.item'), render: (w) => <span>{w.product}<span className="k" style={{ display: 'block' }}>{w.detail}</span></span> },
    { key: 'qty', header: t('plQuality.col.qty'), align: 'right', render: (w) => <span className="sf-amount">{qtyText(w.qty)}</span> },
    { key: 'since', header: t('plQuality.col.since'), render: (w) => formatDate(w.date) },
    { key: 'status', header: t('common.status'), render: () => <ProdStatus status="quarantine" /> },
  ]
  const doneCols: Column<ViewRow<'quality_inspections'>>[] = [
    { key: 'date', header: t('plQuality.d.date'), render: (r) => formatDate(r.inspection_date) },
    { key: 'lot', header: t('plQuality.col.lot'), render: (r) => <span className="mono">{r.lot_no}</span> },
    { key: 'item', header: t('plQuality.col.item'), render: (r) => `${r.product_code} · ${r.product_name}` },
    { key: 'kind', header: t('plQuality.col.type'), render: (r) => t(`plQuality.kind.${r.kind}`, { defaultValue: r.kind }) },
    { key: 'acc', header: t('plQuality.d.accepted'), align: 'right', render: (r) => <span className="sf-amount">{qtyText(r.accepted_qty)}</span> },
    { key: 'rej', header: t('plQuality.d.rejected'), align: 'right', render: (r) => <span className="sf-amount">{qtyText(r.rejected_qty)}</span> },
    { key: 'res', header: t('plQuality.d.result'), render: (r) => <ProdStatus status={r.result} /> },
    { key: 'by', header: t('plQuality.d.by'), render: (r) => r.inspected_by_name ?? '—' },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <p className="muted" style={{ margin: 0 }} data-testid="qi-open">
        {t('plQuality.openCount', { n: shifts.isLoading || orders.isLoading ? '…' : waiting.length })}
      </p>
      <Tabs<Tab>
        label={t('plQuality.tabs')}
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'open', label: t('plQuality.tab.open') },
          { key: 'done', label: t('plQuality.tab.done') },
        ]}
      />
      <ViewError error={shifts.error ?? orders.error ?? done.error} />
      <Done>{saved}</Done>
      {tab === 'open' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(320px, 2fr)', gap: 16, alignItems: 'start' }}>
          <TableCard title={t('plQuality.openTitle')}>
            <DataTable caption={t('plQuality.openTitle')} columns={cols} rows={waiting} rowKey={(w) => w.lotId} loading={shifts.isLoading || orders.isLoading} minWidth={720} empty={<EmptyState title={t('plQuality.emptyTitle')} body={t('plQuality.emptyBody')} />} />
          </TableCard>
          {current ? <Inspect key={current.lotId} w={current} onSaved={(m) => { setSaved(m); setCurrent(null) }} /> : <NextSteps />}
        </div>
      ) : (
        <TableCard title={t('plQuality.doneTitle')}>
          <DataTable caption={t('plQuality.doneTitle')} columns={doneCols} rows={rowsOf(done)} rowKey={(r) => r.id} loading={done.isLoading} minWidth={900} empty={<EmptyState title={t('plQuality.doneEmpty')} />} />
        </TableCard>
      )}
    </div>
  )
}

function NextSteps() {
  const { t } = useTranslation()
  return (
    <Card title={t('plQuality.next.title')}>
      <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {['accept', 'reject', 'hold', 'who'].map((k) => (
          <li key={k}>
            <strong>{t(`plQuality.next.${k}.title`)}</strong> {t(`plQuality.next.${k}.body`)}
          </li>
        ))}
      </ul>
    </Card>
  )
}

function Inspect({ w, onSaved }: { w: Waiting; onSaved: (msg: string) => void }) {
  const { t } = useTranslation()
  const lotQ = useApiView('lots', { eq: { id: w.lotId } })
  const lot = rowsOf(lotQ)[0]
  if (lotQ.isLoading) {
    return (
      <Card>
        <Skeleton height={120} />
      </Card>
    )
  }
  if (!lot) {
    return (
      <Card>
        <EmptyState title={t('plQuality.lotHidden')} />
      </Card>
    )
  }
  return <InspectForm w={w} lot={lot} onSaved={onSaved} />
}

function InspectForm({ w, lot, onSaved }: { w: Waiting; lot: ViewRow<'lots'>; onSaved: (msg: string) => void }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const save = useApiMutation<{ p: Record<string, unknown> }, { id: string; lot_status: string }>('record_quality_inspection', PLASTICS_REFRESH)
  const inQ = Number(lot.qty_quarantine ?? 0)
  const [f, setF] = useState({ kind: w.source === 'assembly' ? 'assembly' : 'final', sample_qty: '', accepted_qty: String(inQ), rejected_qty: '0', defects: '', remarks: '', date: todayIst() })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const iMadeIt = rights.me !== null && w.makers.includes(rights.me)
  const can = f.kind === 'final' || f.kind === 'assembly' ? rights.qcRelease : rights.qcTest
  const num = (v: string) => v.replace(/[,\s]/g, '')
  function record(result: 'pass' | 'fail' | 'hold') {
    save.mutate(
      {
        p: {
          lot_id: lot.id,
          kind: f.kind,
          sample_qty: num(f.sample_qty) || null,
          accepted_qty: num(f.accepted_qty) || '0',
          rejected_qty: num(f.rejected_qty) || '0',
          result,
          defects: f.defects
            .split(',')
            .map((d) => d.trim())
            .filter(Boolean),
          remarks: f.remarks.trim() || null,
          date: f.date,
        },
      },
      { onSuccess: (r) => onSaved(t('plQuality.saved', { doc: w.doc, status: t(`biochemCommon.status.${r.lot_status}`, { defaultValue: r.lot_status }) })) },
    )
  }
  return (
    <Card title={t('plQuality.panelTitle', { doc: w.doc })}>
      <p className="muted" style={{ marginTop: 0 }}>
        {w.product} · {w.detail}
      </p>
      <p style={{ margin: '0 0 8px' }} data-testid="qi-lot">
        {t('plQuality.inQuarantine', { qty: qtyText(inQ), uom: lot.uom })} · <ProdStatus status={lot.status} />
      </p>
      {iMadeIt ? (
        <p className="sf-alert" data-tone="signal" style={{ margin: '0 0 8px' }}>
          {t('plQuality.youMadeIt')}
        </p>
      ) : null}
      {can ? (
        <>
          <FieldGrid cols={2}>
            <SelectField label={t('plQuality.f.kind')} value={f.kind} onChange={set('kind')} options={['first_piece', 'patrol', 'final', 'assembly'].map((k) => ({ value: k, label: t(`plQuality.kind.${k}`) }))} />
            <Field label={t('plQuality.f.date')} type="date" value={f.date} onChange={set('date')} />
            <Field label={t('plQuality.f.sample')} inputMode="numeric" value={f.sample_qty} onChange={set('sample_qty')} />
            <span />
            <Field label={t('plQuality.f.accepted')} inputMode="decimal" value={f.accepted_qty} onChange={set('accepted_qty')} />
            <Field label={t('plQuality.f.rejected')} inputMode="decimal" value={f.rejected_qty} onChange={set('rejected_qty')} />
          </FieldGrid>
          <Field label={t('plQuality.f.defects')} value={f.defects} onChange={set('defects')} />
          <TextAreaField label={t('plQuality.f.remarks')} value={f.remarks} onChange={set('remarks')} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <Button variant="primary" busy={save.isPending} onClick={() => record('pass')}>
              {t('plQuality.accept')}
            </Button>
            <Button busy={save.isPending} onClick={() => record('hold')}>
              {t('plQuality.hold')}
            </Button>
            <Button variant="danger" busy={save.isPending} onClick={() => record('fail')}>
              {t('plQuality.reject')}
            </Button>
          </div>
          <p className="k" style={{ margin: '8px 0 0' }}>
            {t('plQuality.rule')}
          </p>
        </>
      ) : (
        <p className="k" style={{ margin: 0 }}>
          {t('plQuality.noRight')}
        </p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        <PlasticsErrorBox error={save.error} />
      </div>
    </Card>
  )
}

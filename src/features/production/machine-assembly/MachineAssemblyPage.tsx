import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { qtyText } from '@/features/inventory/common/inventory'
import { formatDate } from '@/shared/format'
import { Button, Card, DataTable, EmptyState, Field, FieldGrid, SelectField, TextAreaField, type Column } from '@/ui'
import { CostCell, Done, ProdStatus, useCompanyPlaces, useCompanyProducts, useProductionRights, ViewError } from '../biochem-common/biochem'
import { PlasticsErrorBox, PlasticsFrame, PLASTICS_REFRESH } from '../plastics-common/plastics'

type Bom = ViewRow<'assembly_boms'>
interface Line {
  product_id: string
  qty_per: string
  note: string
}

/**
 * Machine assembly (`Machines`): the bill of materials for each assembled product (mixer grinder and the like) and the
 * assembly orders that use it. A BOM version is written as a draft and approved by someone other than its writer
 * (api.approve_assembly_bom, sod.own_approval). Assembly (api.post_assembly) uses the approved BOM, refuses when any
 * component is short (prod.components_short lists every short item, and nothing moves), takes components out of stock
 * into the consumption ledger and puts the assembled units into quarantine for an assembly inspection.
 */
export function MachineAssemblyPage() {
  const { t } = useTranslation()
  return (
    <PlasticsFrame step="machines" title={t('plAssembly.title')} subtitle={t('plAssembly.subtitle')}>
      {(companyId) => <Assembly companyId={companyId} />}
    </PlasticsFrame>
  )
}

function Assembly({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const boms = useApiView('assembly_boms', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 500 })
  const orders = useApiView('assembly_orders', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 300 })
  const [selected, setSelected] = useState<string | null>(null)
  const [writing, setWriting] = useState(false)
  const all = rowsOf(boms)
  const current = all.find((b) => b.id === selected) ?? null
  const cols: Column<Bom>[] = [
    {
      key: 'product',
      header: t('plAssembly.col.product'),
      render: (b) => (
        <Button size="sm" variant="link" onClick={() => setSelected(b.id)} aria-label={t('plAssembly.openOne', { code: b.product_code, name: b.product_name, v: b.version })}>
          {b.product_code} · {b.product_name}
        </Button>
      ),
    },
    { key: 'v', header: t('plAssembly.col.version'), align: 'right', render: (b) => <span className="sf-amount">v{b.version}</span> },
    { key: 'lines', header: t('plAssembly.col.lines'), align: 'right', render: (b) => <span className="sf-amount">{b.lines ?? 0}</span> },
    { key: 'status', header: t('common.status'), render: (b) => <ProdStatus status={b.status} /> },
    { key: 'by', header: t('plAssembly.col.writtenBy'), render: (b) => b.created_by_name ?? '—' },
    { key: 'ok', header: t('plAssembly.col.approvedBy'), render: (b) => (b.approved_by_name ? `${b.approved_by_name} · ${b.approved_at ? formatDate(b.approved_at) : ''}` : '—') },
  ]
  const orderCols: Column<ViewRow<'assembly_orders'>>[] = [
    { key: 'doc', header: t('plAssembly.o.doc'), render: (o) => <span className="mono">{o.doc_no}</span> },
    { key: 'date', header: t('plAssembly.o.date'), render: (o) => formatDate(o.order_date) },
    { key: 'product', header: t('plAssembly.col.product'), render: (o) => `${o.product_code} · ${o.product_name} (v${o.bom_version})` },
    { key: 'qty', header: t('plAssembly.o.qty'), align: 'right', render: (o) => <span className="sf-amount">{qtyText(o.qty)}</span> },
    { key: 'by', header: t('plAssembly.o.by'), render: (o) => o.assembled_by_name ?? '—' },
    { key: 'lot', header: t('plAssembly.o.lot'), render: (o) => <ProdStatus status={o.lot_status} /> },
    { key: 'cost', header: t('plAssembly.o.unitCost'), align: 'right', render: (o) => <CostCell value={o.unit_cost} digits={4} /> },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <ViewError error={boms.error ?? orders.error} />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(320px, 2fr)', gap: 16, alignItems: 'start' }}>
        <TableCard
          title={t('plAssembly.bomsTitle')}
          action={
            rights.edit ? (
              <Button size="sm" variant="primary" onClick={() => setWriting(true)}>
                {t('plAssembly.newBom')}
              </Button>
            ) : null
          }
        >
          <DataTable caption={t('plAssembly.bomsTitle')} columns={cols} rows={all} rowKey={(b) => b.id} loading={boms.isLoading} minWidth={760} empty={<EmptyState title={t('plAssembly.bomsEmpty')} body={t('plAssembly.bomsEmptyBody')} />} />
        </TableCard>
        {rights.create ? <PostAssembly companyId={companyId} boms={all.filter((b) => b.status === 'approved')} /> : <Card><p className="k" style={{ margin: 0 }}>{t('plAssembly.noCreate')}</p></Card>}
      </div>
      {writing ? <BomEditor companyId={companyId} onClose={() => setWriting(false)} /> : null}
      {current ? <BomPanel key={current.id} bom={current} onClose={() => setSelected(null)} /> : null}
      <TableCard title={t('plAssembly.ordersTitle')}>
        <DataTable caption={t('plAssembly.ordersTitle')} columns={orderCols} rows={rowsOf(orders)} rowKey={(o) => o.id} loading={orders.isLoading} minWidth={900} empty={<EmptyState title={t('plAssembly.ordersEmpty')} />} />
      </TableCard>
    </div>
  )
}

function BomPanel({ bom, onClose }: { bom: Bom; onClose: () => void }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const lines = useApiView('assembly_bom_lines', { eq: { bom_id: bom.id }, order: 'product_code' })
  const approve = useApiMutation<{ p_bom_id: string }, { id: string; status: string }>('approve_assembly_bom', PLASTICS_REFRESH)
  const cols: Column<ViewRow<'assembly_bom_lines'>>[] = [
    { key: 'item', header: t('plAssembly.l.item'), render: (l) => `${l.product_code} · ${l.product_name}` },
    { key: 'qty', header: t('plAssembly.l.qty'), align: 'right', render: (l) => <span className="sf-amount">{qtyText(l.qty_per)} {l.uom}</span> },
    { key: 'cost', header: t('plAssembly.l.avgCost'), align: 'right', render: (l) => <CostCell value={l.avg_cost} digits={4} /> },
    { key: 'note', header: t('plAssembly.l.note'), render: (l) => l.note ?? '' },
  ]
  return (
    <Card
      title={t('plAssembly.panelTitle', { code: bom.product_code, name: bom.product_name, v: bom.version })}
      action={
        <Button size="sm" variant="link" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <p className="muted" style={{ marginTop: 0 }} data-testid="bom-status">
        <ProdStatus status={bom.status} /> · {t('plAssembly.writtenBy', { name: bom.created_by_name ?? '—' })}
        {bom.approved_by_name ? ` · ${t('plAssembly.approvedBy', { name: bom.approved_by_name })}` : ''}
      </p>
      {bom.notes ? <p style={{ whiteSpace: 'pre-wrap' }}>{bom.notes}</p> : null}
      <DataTable caption={t('plAssembly.l.title')} columns={cols} rows={rowsOf(lines)} rowKey={(l) => l.id} loading={lines.isLoading} minWidth={560} empty={<EmptyState title={t('plAssembly.l.empty')} />} />
      {bom.status === 'draft' ? (
        rights.approve ? (
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button variant="primary" busy={approve.isPending} onClick={() => approve.mutate({ p_bom_id: bom.id })}>
              {t('plAssembly.approve')}
            </Button>
            <span className="k">{t('plAssembly.approveRule')}</span>
          </div>
        ) : (
          <p className="k">{t('plAssembly.needsApprover')}</p>
        )
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
        <PlasticsErrorBox error={approve.error} />
        <Done>{approve.data ? t('plAssembly.approved') : null}</Done>
      </div>
    </Card>
  )
}

function BomEditor({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const products = useCompanyProducts(companyId)
  const save = useApiMutation<{ p: Record<string, unknown> }, { id: string; version: number; status: string }>('save_assembly_bom', PLASTICS_REFRESH)
  const [product, setProduct] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<Line[]>([{ product_id: '', qty_per: '', note: '' }])
  const opts = [{ value: '', label: t('plAssembly.chooseItem') }, ...products.list.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))]
  const setLine = (i: number, k: keyof Line) => (e: { target: { value: string } }) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: e.target.value } : l)))
  return (
    <Card
      title={t('plAssembly.editor.title')}
      action={
        <Button size="sm" variant="link" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <p className="k" style={{ marginTop: 0 }}>
        {t('plAssembly.editor.hint')}
      </p>
      <FieldGrid cols={2}>
        <SelectField label={t('plAssembly.editor.product')} value={product} onChange={(e) => setProduct(e.target.value)} options={opts} />
        <span />
      </FieldGrid>
      {lines.map((l, i) => (
        <FieldGrid key={i} cols={3}>
          <SelectField label={t('plAssembly.editor.component', { n: i + 1 })} value={l.product_id} onChange={setLine(i, 'product_id')} options={opts} />
          <Field label={t('plAssembly.editor.qty', { n: i + 1 })} inputMode="decimal" value={l.qty_per} onChange={setLine(i, 'qty_per')} />
          <Field label={t('plAssembly.editor.note', { n: i + 1 })} value={l.note} onChange={setLine(i, 'note')} />
        </FieldGrid>
      ))}
      <Button size="sm" variant="link" onClick={() => setLines([...lines, { product_id: '', qty_per: '', note: '' }])}>
        {t('plAssembly.editor.addLine')}
      </Button>
      <TextAreaField label={t('plAssembly.editor.notes')} value={notes} onChange={(e) => setNotes(e.target.value)} />
      <div style={{ marginTop: 8 }}>
        <Button
          variant="primary"
          busy={save.isPending}
          onClick={() =>
            save.mutate({
              p: {
                company_id: companyId,
                product_id: product || null,
                notes: notes.trim() || null,
                lines: lines.filter((l) => l.product_id).map((l) => ({ product_id: l.product_id, qty_per: l.qty_per.replace(/[,\s]/g, '') || null, note: l.note.trim() || null })),
              },
            })
          }
        >
          {t('plAssembly.editor.save')}
        </Button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
        <PlasticsErrorBox error={save.error} />
        <Done>{save.data ? t('plAssembly.editor.saved', { v: save.data.version }) : null}</Done>
      </div>
    </Card>
  )
}

function PostAssembly({ companyId, boms }: { companyId: string; boms: Bom[] }) {
  const { t } = useTranslation()
  const places = useCompanyPlaces(companyId)
  const post = useApiMutation<{ p: Record<string, unknown> }, { id: string; doc_no: string; lot_id: string; unit_cost: number | null }>('post_assembly', PLASTICS_REFRESH)
  const [f, setF] = useState({ product_id: '', qty: '', from_place_id: '', to_place_id: '', date: todayIst(), labour_hours: '', note: '' })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const bom = boms.find((b) => b.product_id === f.product_id)
  const lines = useApiView('assembly_bom_lines', { eq: { bom_id: bom?.id }, order: 'product_code', enabled: Boolean(bom) })
  const stock = useApiView('stock_on_hand', { eq: { company_id: companyId, place_id: f.from_place_id, bucket: 'available' }, limit: 3000, enabled: Boolean(f.from_place_id && bom) })
  const onHand = (pid: string) => rowsOf(stock).filter((s) => s.product_id === pid).reduce((n, s) => n + Number(s.qty), 0)
  const placeOpts = [{ value: '', label: t('plAssembly.post.choosePlace') }, ...places.list.map((p) => ({ value: p.id, label: `${p.name} · ${p.branch_name}` }))]
  return (
    <Card title={t('plAssembly.post.title')}>
      <FieldGrid cols={2}>
        <SelectField label={t('plAssembly.post.product')} value={f.product_id} onChange={set('product_id')} options={[{ value: '', label: boms.length ? t('plAssembly.chooseItem') : t('plAssembly.post.noBom') }, ...boms.map((b) => ({ value: b.product_id, label: `${b.product_code} · ${b.product_name} (v${b.version})` }))]} />
        <Field label={t('plAssembly.post.qty')} inputMode="numeric" value={f.qty} onChange={set('qty')} />
        <SelectField label={t('plAssembly.post.from')} value={f.from_place_id} onChange={set('from_place_id')} options={placeOpts} />
        <SelectField label={t('plAssembly.post.to')} value={f.to_place_id} onChange={set('to_place_id')} options={placeOpts} />
        <Field label={t('plAssembly.post.date')} type="date" value={f.date} onChange={set('date')} />
        <Field label={t('plAssembly.post.labour')} inputMode="decimal" value={f.labour_hours} onChange={set('labour_hours')} />
      </FieldGrid>
      <Field label={t('plAssembly.post.note')} value={f.note} onChange={set('note')} />
      {bom && rowsOf(lines).length ? (
        <table className="sf-table" style={{ marginTop: 8 }}>
          <caption className="sr-only">{t('plAssembly.post.partsTitle')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('plAssembly.l.item')}</th>
              <th scope="col" className="r">
                {t('plAssembly.l.qty')}
              </th>
              <th scope="col" className="r">
                {t('plAssembly.post.onHand')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rowsOf(lines).map((l) => (
              <tr key={l.id}>
                <td>
                  {l.product_code} · {l.product_name}
                </td>
                <td className="r">
                  <span className="sf-amount">{qtyText(l.qty_per)}</span>
                </td>
                <td className="r">{f.from_place_id ? <span className="sf-amount">{qtyText(onHand(l.product_id))}</span> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <div style={{ marginTop: 8 }}>
        <Button
          variant="primary"
          busy={post.isPending}
          onClick={() => post.mutate({ p: { product_id: f.product_id || null, qty: f.qty.replace(/[,\s]/g, '') || null, from_place_id: f.from_place_id || null, to_place_id: f.to_place_id || null, date: f.date, labour_hours: f.labour_hours.replace(/[,\s]/g, '') || null, note: f.note.trim() || null } })}
        >
          {t('plAssembly.post.save')}
        </Button>
      </div>
      <p className="k" style={{ margin: '8px 0 0' }}>
        {t('plAssembly.post.rule')}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
        <PlasticsErrorBox error={post.error} />
        <Done>{post.data ? t('plAssembly.post.done', { doc: post.data.doc_no }) : null}</Done>
      </div>
    </Card>
  )
}

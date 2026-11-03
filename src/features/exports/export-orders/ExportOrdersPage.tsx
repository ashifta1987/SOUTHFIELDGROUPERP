import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { formatDate } from '@/shared/format'
import { Amount, Button, Card, Checkbox, DataTable, EmptyState, Field, FieldGrid, KeyValue, SelectField, type Column } from '@/ui'
import { Done, LinesEditor, NoRight, SALES_REFRESH, SalesErrorBox, SalesFrame, SalesStatus, ViewError, linesPayload, newLine, num, productLabel, useCompanyProducts, useCustomers, useSalesRights, type DraftLine, type Product } from '@/features/sales/sales-common/sales'

type ExportOrder = ViewRow<'export_orders'>
type Container = ViewRow<'containers'>
interface PackRow {
  key: string
  product_id: string
  cartons: string
  pieces: string
}
let packSeq = 0
const newPack = (): PackRow => ({ key: `k${++packSeq}`, product_id: '', cartons: '', pieces: '' })

/**
 * Export orders and containers (`ExportOrders`): the order in the buyer's currency with the recorded exchange rate and
 * LUT (api.create_export_order — overseas buyers only), containers with the ISO 6346 check digit (api.add_container),
 * the packing list checked against what was loaded (api.check_packing_list), and the export invoice
 * (api.post_export_invoice): under LUT it is zero-rated without GST and only Admin may post it (open question Q-P6-3);
 * without LUT it carries IGST with place of supply 96.
 */
export function ExportOrdersPage() {
  const { t } = useTranslation()
  return (
    <SalesFrame title={t('exportOrders.title')} subtitle={t('exportOrders.subtitle')}>
      {(companyId) => <Exports companyId={companyId} />}
    </SalesFrame>
  )
}

function Exports({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const rights = useSalesRights()
  const q = useApiView('export_orders', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 300 })
  const products = useCompanyProducts(companyId)
  const [openId, setOpenId] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const list = rowsOf(q)
  const current = list.find((o) => o.id === openId) ?? null
  const cols: Column<ExportOrder>[] = [
    {
      key: 'no',
      header: t('exportOrders.col.no'),
      render: (o) => (
        <Button size="sm" variant="link" aria-label={t('exportOrders.open', { no: o.doc_no })} onClick={() => { setDone(null); setOpenId(o.id) }}>
          <span className="mono">{o.doc_no}</span>
        </Button>
      ),
    },
    { key: 'date', header: t('exportOrders.col.date'), render: (o) => formatDate(o.order_date) },
    { key: 'buyer', header: t('exportOrders.col.buyer'), render: (o) => o.party_name ?? '—' },
    { key: 'to', header: t('exportOrders.col.to'), render: (o) => o.destination ?? '—' },
    { key: 'cur', header: t('exportOrders.col.currency'), render: (o) => o.currency },
    { key: 'cont', header: t('exportOrders.col.containers'), align: 'right', render: (o) => o.containers ?? 0 },
    { key: 'status', header: t('common.status'), render: (o) => <SalesStatus status={o.status} /> },
  ]
  if (!rights.exportsView && !rights.admin) {
    return (
      <Card>
        <NoRight>{t('exportOrders.noView')}</NoRight>
      </Card>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <ViewError error={q.error} />
      <Done testId="export-msg">{done}</Done>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        <TableCard
          title={t('exportOrders.listTitle')}
          action={
            current && rights.exportsCreate ? (
              <Button size="sm" onClick={() => setOpenId(null)}>
                {t('exportOrders.newShort')}
              </Button>
            ) : null
          }
        >
          <DataTable caption={t('exportOrders.listTitle')} columns={cols} rows={list} rowKey={(o) => o.id} loading={q.isLoading} minWidth={680} empty={<EmptyState title={t('exportOrders.empty')} body={t('exportOrders.emptyBody')} />} />
        </TableCard>
        {current ? (
          <OrderDetail key={current.id} order={current} products={products.list} onDone={setDone} />
        ) : rights.exportsCreate ? (
          <NewExport companyId={companyId} products={products.list} onSaved={(m, id) => { setDone(m); setOpenId(id) }} />
        ) : (
          <Card title={t('exportOrders.newTitle')}>
            <NoRight>{t('exportOrders.noCreate')}</NoRight>
          </Card>
        )}
      </div>
      <Card title={t('exportOrders.howTitle')}>
        <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {['order', 'plan', 'assembly', 'packing', 'stuffing', 'documents', 'goods', 'payment'].map((k) => (
            <li key={k}>
              <strong>{t(`exportOrders.how.${k}.title`)}</strong> {t(`exportOrders.how.${k}.body`)}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  )
}

function NewExport({ companyId, products, onSaved }: { companyId: string; products: Product[]; onSaved: (m: string, id: string) => void }) {
  const { t } = useTranslation()
  const customers = useCustomers(companyId)
  const overseas = useApiView('parties', { eq: { gst_status: 'overseas', is_customer: true }, order: 'legal_name', limit: 1000 })
  const save = useApiMutation<{ p: Record<string, unknown> }, { id: string; doc_no: string }>('create_export_order', SALES_REFRESH)
  const overseasIds = new Set(rowsOf(overseas).map((p) => p.id))
  const buyers = customers.list.filter((c) => overseasIds.has(c.id))
  const [f, setF] = useState({ party: '', date: todayIst(), currency: 'USD', fx: '', incoterm: 'FOB', port: '', destination: '', lut: '', lutTo: '' })
  const [lines, setLines] = useState<DraftLine[]>([newLine()])
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  return (
    <Card title={t('exportOrders.newTitle')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {buyers.length === 0 && !customers.isLoading && !overseas.isLoading ? <p className="k" style={{ margin: 0 }}>{t('exportOrders.noBuyers')}</p> : null}
        <FieldGrid cols={2}>
          <SelectField label={t('exportOrders.col.buyer')} value={f.party} onChange={set('party')} placeholder={t('salesCommon.choose')} options={buyers.map((c) => ({ value: c.id, label: c.name }))} />
          <Field label={t('exportOrders.col.date')} type="date" value={f.date} onChange={set('date')} />
          <Field label={t('exportOrders.col.currency')} value={f.currency} maxLength={3} onChange={set('currency')} />
          <Field label={t('exportOrders.f.fx')} inputMode="decimal" value={f.fx} onChange={set('fx')} help={t('exportOrders.f.fxHelp')} />
          <Field label={t('exportOrders.f.incoterm')} value={f.incoterm} onChange={set('incoterm')} />
          <Field label={t('exportOrders.f.port')} value={f.port} onChange={set('port')} />
          <Field label={t('exportOrders.col.to')} value={f.destination} onChange={set('destination')} />
          <span />
          <Field label={t('exportOrders.f.lut')} value={f.lut} onChange={set('lut')} />
          <Field label={t('exportOrders.f.lutTo')} type="date" value={f.lutTo} onChange={set('lutTo')} />
        </FieldGrid>
        <LinesEditor idBase="exp" lines={lines} onChange={setLines} products={products} showDiscount={false} rateLabel={t('exportOrders.f.rateFc')} rateHelp={t('exportOrders.f.rateHelp')} />
        <div>
          <Button
            variant="primary"
            busy={save.isPending}
            onClick={() =>
              save.mutate(
                { p: { company_id: companyId, party_id: f.party, order_date: f.date, currency: f.currency.trim(), fx_rate: num(f.fx), incoterm: f.incoterm.trim() || null, port_of_loading: f.port.trim() || null, destination: f.destination.trim() || null, lut_ref: f.lut.trim() || null, lut_valid_to: f.lutTo || null, lines: linesPayload(lines, { rateKey: 'rate_fc', discount: false }) } },
                { onSuccess: (r) => onSaved(t('exportOrders.created', { no: r.doc_no }), r.id) },
              )
            }
          >
            {t('exportOrders.create')}
          </Button>
        </div>
        <SalesErrorBox error={save.error} />
      </div>
    </Card>
  )
}

interface OrderLine {
  product_id: string
  qty: number | string
  rate_fc: number | string
}

function OrderDetail({ order, products, onDone }: { order: ExportOrder; products: Product[]; onDone: (m: string | null) => void }) {
  const { t } = useTranslation()
  const rights = useSalesRights()
  const containers = useApiView('containers', { eq: { export_order_id: order.id }, order: 'created_at' })
  const invoices = useApiView('export_invoices', { eq: { export_order_id: order.id }, order: 'doc_date' })
  const byId = new Map(products.map((p) => [p.id, p]))
  const name = (id: string) => {
    const p = byId.get(id)
    return p ? productLabel(p) : id
  }
  const lines = (Array.isArray(order.lines) ? order.lines : []) as unknown as OrderLine[]
  const lineCols: Column<OrderLine & { i: number }>[] = [
    { key: 'item', header: t('exportOrders.d.item'), render: (l) => name(l.product_id) },
    { key: 'qty', header: t('exportOrders.d.qty'), align: 'right', render: (l) => <span className="sf-amount">{String(l.qty)}</span> },
    { key: 'rate', header: t('exportOrders.d.rate', { cur: order.currency }), align: 'right', render: (l) => <Amount value={l.rate_fc} /> },
  ]
  const invCols: Column<ViewRow<'export_invoices'>>[] = [
    { key: 'no', header: t('exportOrders.d.invoice'), render: (i) => <span className="mono">{i.doc_no ?? '—'}</span> },
    { key: 'date', header: t('exportOrders.col.date'), render: (i) => formatDate(i.doc_date) },
    { key: 'lut', header: t('exportOrders.d.basis'), render: (i) => (i.lut ? t('exportOrders.d.underLut') : t('exportOrders.d.withIgst')) },
    { key: 'fc', header: t('exportOrders.d.valueFc', { cur: order.currency }), align: 'right', render: (i) => <Amount value={i.value_fc} /> },
    { key: 'inr', header: t('exportOrders.d.valueInr'), align: 'right', render: (i) => <Amount value={i.total_inr} rupee /> },
    { key: 'sb', header: t('exportOrders.d.shippingBill'), render: (i) => i.shipping_bill_no ?? '—' },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card title={t('exportOrders.detailTitle', { no: order.doc_no })}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ margin: 0 }} data-testid="export-status">
            <SalesStatus status={order.status} /> <span className="muted">{order.party_name}</span>
          </p>
          <KeyValue
            rows={[
              { label: t('exportOrders.col.currency'), value: order.currency },
              { label: t('exportOrders.f.fx'), value: <Amount value={order.fx_rate} digits={4} /> },
              { label: t('exportOrders.f.incoterm'), value: order.incoterm ?? '—' },
              { label: t('exportOrders.f.port'), value: order.port_of_loading ?? '—' },
              { label: t('exportOrders.col.to'), value: order.destination ?? '—' },
              { label: t('exportOrders.f.lut'), value: order.lut_ref ? `${order.lut_ref} · ${order.lut_valid_to ? formatDate(order.lut_valid_to) : '—'}` : '—' },
            ]}
          />
          <DataTable caption={t('exportOrders.d.lines')} columns={lineCols} rows={lines.map((l, i) => ({ ...l, i }))} rowKey={(l) => String(l.i)} minWidth={420} empty={<EmptyState title={t('exportOrders.d.noLines')} />} />
        </div>
      </Card>
      <Card title={t('exportOrders.c.title')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rowsOf(containers).length === 0 && !containers.isLoading ? <p className="k" style={{ margin: 0 }}>{t('exportOrders.c.none')}</p> : null}
          {rowsOf(containers).map((c) => (
            <ContainerRow key={c.id} c={c} products={products} name={name} onDone={onDone} />
          ))}
          {rights.exportsEdit ? <AddContainer orderId={order.id} products={products} onDone={onDone} /> : <NoRight>{t('exportOrders.c.noEdit')}</NoRight>}
        </div>
      </Card>
      <Card title={t('exportOrders.i.title')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <DataTable caption={t('exportOrders.i.title')} columns={invCols} rows={rowsOf(invoices)} rowKey={(i) => i.document_id} loading={invoices.isLoading} minWidth={620} empty={<EmptyState title={t('exportOrders.i.none')} />} />
          {rights.exportsCreate && rights.invoices ? <ExportInvoice order={order} onDone={onDone} /> : <NoRight>{t('exportOrders.i.noRight')}</NoRight>}
        </div>
      </Card>
    </div>
  )
}

function PackEditor({ rows, onChange, products, idBase, legend }: { rows: PackRow[]; onChange: (r: PackRow[]) => void; products: Product[]; idBase: string; legend: string }) {
  const { t } = useTranslation()
  const set = (key: string, k: keyof PackRow, v: string) => onChange(rows.map((r) => (r.key === key ? { ...r, [k]: v } : r)))
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <legend className="sf-field__label">{legend}</legend>
      {rows.map((r, i) => (
        <div key={r.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 3fr) 1fr 1fr', gap: 8, alignItems: 'end' }}>
          <SelectField id={`${idBase}-p-${i}`} label={t('exportOrders.c.item', { n: i + 1 })} value={r.product_id} onChange={(e) => set(r.key, 'product_id', e.target.value)} placeholder={t('salesCommon.choose')} options={products.map((p) => ({ value: p.id, label: productLabel(p) }))} />
          <Field id={`${idBase}-c-${i}`} label={t('exportOrders.c.cartons', { n: i + 1 })} inputMode="numeric" value={r.cartons} onChange={(e) => set(r.key, 'cartons', e.target.value)} />
          <Field id={`${idBase}-s-${i}`} label={t('exportOrders.c.pieces', { n: i + 1 })} inputMode="numeric" value={r.pieces} onChange={(e) => set(r.key, 'pieces', e.target.value)} />
        </div>
      ))}
      <div>
        <Button size="sm" onClick={() => onChange([...rows, newPack()])}>
          {t('exportOrders.c.addLine')}
        </Button>
      </div>
    </fieldset>
  )
}

const packPayload = (rows: PackRow[]) => rows.filter((r) => r.product_id).map((r) => ({ product_id: r.product_id, cartons: num(r.cartons) || '0', pieces: num(r.pieces) || '0' }))

function AddContainer({ orderId, products, onDone }: { orderId: string; products: Product[]; onDone: (m: string | null) => void }) {
  const { t } = useTranslation()
  const add = useApiMutation<{ p: Record<string, unknown> }, { container_no: string }>('add_container', SALES_REFRESH)
  const [f, setF] = useState({ no: '', seal: '' })
  const [rows, setRows] = useState<PackRow[]>([newPack()])
  return (
    <section aria-label={t('exportOrders.c.addTitle')} style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--sf-line-faint)', paddingTop: 12 }}>
      <h3 style={{ margin: 0, fontSize: 14 }}>{t('exportOrders.c.addTitle')}</h3>
      <FieldGrid cols={2}>
        <Field label={t('exportOrders.c.no')} value={f.no} onChange={(e) => setF({ ...f, no: e.target.value })} help={t('exportOrders.c.noHelp')} />
        <Field label={t('exportOrders.c.seal')} value={f.seal} onChange={(e) => setF({ ...f, seal: e.target.value })} />
      </FieldGrid>
      <PackEditor idBase="pl" rows={rows} onChange={setRows} products={products} legend={t('exportOrders.c.packingList')} />
      <div>
        <Button busy={add.isPending} onClick={() => add.mutate({ p: { export_order_id: orderId, container_no: f.no, seal_no: f.seal.trim() || null, packing_list: packPayload(rows) } }, { onSuccess: (r) => { setF({ no: '', seal: '' }); setRows([newPack()]); onDone(t('exportOrders.c.added', { no: r.container_no })) } })}>
          {t('exportOrders.c.add')}
        </Button>
      </div>
      <SalesErrorBox error={add.error} />
    </section>
  )
}

interface Diff {
  product_id: string
  list_cartons: number
  loaded_cartons: number
  list_pieces: number
  loaded_pieces: number
}

function ContainerRow({ c, products, name, onDone }: { c: Container; products: Product[]; name: (id: string) => string; onDone: (m: string | null) => void }) {
  const { t } = useTranslation()
  const rights = useSalesRights()
  const check = useApiMutation<{ p_container_id: string; p_loaded: unknown[] }, { status: string }>('check_packing_list', SALES_REFRESH)
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<PackRow[]>([newPack()])
  const diffs = (Array.isArray(c.check_result) ? c.check_result : []) as unknown as Diff[]
  return (
    <div className="sf-card sf-card__pad" style={{ padding: 12 }}>
      <p style={{ margin: 0, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong className="mono">{c.container_no}</strong>
        {c.seal_no ? <span className="k">{t('exportOrders.c.sealIs', { seal: c.seal_no })}</span> : null}
        <span data-testid="container-check">
          <SalesStatus status={c.check_status} />
        </span>
      </p>
      {diffs.length ? (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          {diffs.map((d) => (
            <li key={d.product_id}>{t('exportOrders.c.diff', { item: name(d.product_id), lc: d.list_cartons, dc: d.loaded_cartons, lp: d.list_pieces, dp: d.loaded_pieces })}</li>
          ))}
        </ul>
      ) : null}
      {rights.exportsEdit ? (
        open ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            <PackEditor idBase={`ld-${c.id.slice(0, 6)}`} rows={rows} onChange={setRows} products={products} legend={t('exportOrders.c.loaded')} />
            <div>
              <Button busy={check.isPending} onClick={() => check.mutate({ p_container_id: c.id, p_loaded: packPayload(rows) }, { onSuccess: (r) => { setOpen(false); onDone(r.status === 'matches' ? t('exportOrders.c.matches') : t('exportOrders.c.mismatch')) } })}>
                {t('exportOrders.c.check')}
              </Button>
            </div>
            <SalesErrorBox error={check.error} />
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <Button size="sm" onClick={() => setOpen(true)} aria-label={t('exportOrders.c.checkOne', { no: c.container_no })}>
              {t('exportOrders.c.checkStart')}
            </Button>
          </div>
        )
      ) : null}
    </div>
  )
}

function ExportInvoice({ order, onDone }: { order: ExportOrder; onDone: (m: string | null) => void }) {
  const { t } = useTranslation()
  const rights = useSalesRights()
  const post = useApiMutation<{ p: Record<string, unknown> }, { doc_no: string; total_inr: number; lut: boolean }>('post_export_invoice', SALES_REFRESH)
  const [f, setF] = useState({ date: todayIst(), lut: true, sb: '', sbDate: '', port: '' })
  return (
    <section aria-label={t('exportOrders.i.postTitle')} style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--sf-line-faint)', paddingTop: 12 }}>
      <h3 style={{ margin: 0, fontSize: 14 }}>{t('exportOrders.i.postTitle')}</h3>
      <Checkbox label={t('exportOrders.i.lut')} hint={rights.admin ? t('exportOrders.i.lutHintAdmin') : t('exportOrders.i.lutHint')} checked={f.lut} onChange={(e) => setF({ ...f, lut: e.target.checked })} />
      <FieldGrid cols={2}>
        <Field label={t('exportOrders.i.date')} type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        <Field label={t('exportOrders.i.port')} value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} />
        <Field label={t('exportOrders.i.sb')} value={f.sb} onChange={(e) => setF({ ...f, sb: e.target.value })} />
        <Field label={t('exportOrders.i.sbDate')} type="date" value={f.sbDate} onChange={(e) => setF({ ...f, sbDate: e.target.value })} />
      </FieldGrid>
      <p className="k" style={{ margin: 0 }}>
        {t('exportOrders.i.rule')}
      </p>
      <div>
        <Button
          variant="primary"
          busy={post.isPending}
          onClick={() =>
            post.mutate(
              { p: { export_order_id: order.id, doc_date: f.date, lut: f.lut, shipping_bill_no: f.sb.trim() || null, shipping_bill_date: f.sbDate || null, port_code: f.port.trim() || null } },
              { onSuccess: (r) => onDone(t(r.lut ? 'exportOrders.i.postedLut' : 'exportOrders.i.postedIgst', { no: r.doc_no })) },
            )
          }
        >
          {t('exportOrders.i.post')}
        </Button>
      </div>
      <SalesErrorBox error={post.error} />
    </section>
  )
}

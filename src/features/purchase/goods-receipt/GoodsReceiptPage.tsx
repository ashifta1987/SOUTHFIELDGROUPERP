import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { cleanAmount } from '@/features/accounts/cash-book/money'
import { formatDate } from '@/shared/format'
import { Amount, Button, Card, Chip, ConfirmDialog, DataTable, EmptyState, Field, FieldGrid, KeyValue, PageHeader, SelectField, Skeleton, Tabs, type Column } from '@/ui'
import { cleanQty, DocStatus, PurchaseErrorBox, useCompanyPlaces, useCompanyProducts, useCompanySuppliers, usePurchaseRights } from '../common/purchase'

type Tab = 'new' | 'list'
type Mode = 'order' | 'direct'
type Grn = ViewRow<'goods_receipts'>
interface Line {
  order_line_id: string | null
  product_id: string
  label: string
  hsn: string
  ordered: string
  pending: string
  qty: string
  rate: string
  lot_no: string
  supplier_lot_no: string
  expiry_date: string
  mfg_date: string
}
interface Posted {
  id: string
  doc_no: string
  direct_purchase: boolean
  lots: { line_no: number; lot_id: string; lot_no: string; bucket: string }[]
}
const REFRESH = [['api', 'goods_receipts'], ['api', 'grn_lines'], ['api', 'purchase_orders'], ['api', 'purchase_order_lines'], ['api', 'lots'], ['api', 'stock_on_hand'], ['api', 'item_stock'], ['api', 'warehouse_tasks'], ['api', 'buying_logistics_home']]
const blankLine = (): Line => ({ order_line_id: null, product_id: '', label: '', hsn: '', ordered: '', pending: '', qty: '', rate: '', lot_no: '', supplier_lot_no: '', expiry_date: '', mfg_date: '' })

/**
 * Goods receipt (`GoodsReceipt`): stores count what arrived against an issued purchase order (or, as a direct
 * purchase, without one — the server allows that only with purchase approval) and give lot numbers and expiry dates.
 * api.post_goods_receipt adds the stock under each lot; items that need an incoming test go into QC hold (quarantine)
 * until quality releases them. Over-receipt and lines not on the order are refused by the server.
 */
export function GoodsReceiptPage() {
  const { t } = useTranslation()
  const rights = usePurchaseRights()
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('tab') === 'list' ? 'list' : 'new'
  const choice = useCompanyChoice()
  const companyId = choice.companyId

  function setTab(k: Tab) {
    const next = new URLSearchParams(params)
    next.set('tab', k)
    setParams(next, { replace: true })
  }

  return (
    <>
      <PageHeader title={t('goodsReceipt.title')} subtitle={t('goodsReceipt.subtitle')} />
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: 16 }}>
        <Tabs
          label={t('goodsReceipt.tabs')}
          value={tab}
          onChange={setTab}
          idBase="grn"
          controls="grn-panel"
          tabs={[
            { key: 'new', label: t('goodsReceipt.tabNew') },
            { key: 'list', label: t('goodsReceipt.tabList') },
          ]}
        />
        <CompanyPicker list={choice.list} value={companyId} onChange={choice.choose} />
      </div>
      <div id="grn-panel" role="tabpanel" aria-labelledby={`grn-tab-${tab}`} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {choice.isLoading ? (
          <Card>
            <Skeleton height={80} />
          </Card>
        ) : !companyId ? (
          <Card>
            <EmptyState title={t('goodsReceipt.noCompany')} />
          </Card>
        ) : tab === 'new' ? (
          rights.receive ? (
            <NewReceipt key={companyId} companyId={companyId} orderParam={params.get('order')} canDirect={rights.approve} />
          ) : (
            <p className="muted">{rights.readOnly ? t('goodsReceipt.readOnly') : t('goodsReceipt.noRight')}</p>
          )
        ) : (
          <ReceiptList key={companyId} companyId={companyId} />
        )}
      </div>
    </>
  )
}

function NewReceipt({ companyId, orderParam, canDirect }: { companyId: string; orderParam: string | null; canDirect: boolean }) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<Mode>('order')
  const orders = rowsOf(useApiView('purchase_orders', { eq: { company_id: companyId }, order: 'order_date', ascending: false, limit: 300 })).filter((o) => ['issued', 'confirmed', 'part_received'].includes(o.status))
  const suppliers = useCompanySuppliers(companyId).list
  const products = useCompanyProducts(companyId).list
  const places = useCompanyPlaces(companyId).list
  const stock = rowsOf(useApiView('item_stock', { eq: { company_id: companyId }, limit: 3000 }))
  const needsTest = new Set(stock.filter((s) => s.needs_incoming_test).map((s) => s.product_id))
  const [orderId, setOrderId] = useState(orderParam ?? '')
  const order = orders.find((o) => o.id === orderId) ?? null
  const olq = useApiView('purchase_order_lines', { eq: { order_id: orderId }, order: 'line_no', enabled: Boolean(orderId) && mode === 'order' })
  const [party, setParty] = useState('')
  const [invoiceNo, setInvoiceNo] = useState('')
  const [invoiceDate, setInvoiceDate] = useState('')
  const [eway, setEway] = useState('')
  const [vehicle, setVehicle] = useState('')
  const [placePick, setPlace] = useState('')
  const [date, setDate] = useState(todayIst())
  const [directLines, setDirectLines] = useState<Line[]>([blankLine()])
  const [edits, setEdits] = useState<Record<string, Partial<Line>>>({})
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [confirm, setConfirm] = useState<{ header: Record<string, unknown>; lines: Record<string, unknown>[] } | null>(null)
  const [posted, setPosted] = useState<Posted | null>(null)
  const post = useApiMutation<{ p_header: Record<string, unknown>; p_lines: Record<string, unknown>[] }, Posted>('post_goods_receipt', REFRESH)

  // Against an order: the order's pending lines, with what the user typed over them.
  const orderLines: Line[] = rowsOf(olq)
    .filter((l) => Number(l.qty_pending) > 0)
    .map((l) => ({ ...blankLine(), order_line_id: l.id, product_id: l.product_id ?? '', label: l.product_code ? `${l.product_code} · ${l.description}` : l.description, hsn: l.hsn_code ?? '', ordered: `${l.qty} ${l.uom}`, pending: String(l.qty_pending ?? ''), qty: String(l.qty_pending ?? ''), ...edits[l.id] }))
  const lines = mode === 'order' ? (orderId ? orderLines : []) : directLines
  const place = placePick || order?.place_id || ''

  function switchMode(m: Mode) {
    setMode(m)
    setErrs({})
    setPosted(null)
    post.reset()
    setEdits({})
    setDirectLines([blankLine()])
  }
  function setLine(i: number, patch: Partial<Line>) {
    const l = lines[i]
    if (mode === 'order' && l?.order_line_id) {
      const id = l.order_line_id
      setEdits({ ...edits, [id]: { ...edits[id], ...patch } })
    } else setDirectLines(directLines.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  }

  function review() {
    setPosted(null)
    post.reset()
    const e: Record<string, string> = {}
    if (mode === 'order' && !order) e.order = t('goodsReceipt.err.order')
    if (mode === 'direct' && !party) e.party = t('goodsReceipt.err.party')
    if (!place) e.place = t('goodsReceipt.err.place')
    const out: Record<string, unknown>[] = []
    for (const [i, l] of lines.entries()) {
      if (mode === 'order' && !l.qty.trim()) continue
      if (mode === 'direct' && !l.product_id && !l.qty.trim()) continue
      const qty = cleanQty(l.qty)
      const rate = l.rate.trim() ? cleanAmount(l.rate) : null
      if (!qty || (mode === 'direct' && !l.product_id) || (l.rate.trim() && rate === null)) {
        e.lines = t('goodsReceipt.err.line', { n: i + 1 })
        break
      }
      out.push({
        order_line_id: l.order_line_id,
        product_id: l.product_id || null,
        qty,
        rate,
        lot_no: l.lot_no.trim() || null,
        supplier_lot_no: l.supplier_lot_no.trim() || null,
        expiry_date: l.expiry_date || null,
        mfg_date: l.mfg_date || null,
      })
    }
    if (!e.lines && out.length === 0) e.lines = t('goodsReceipt.err.noLines')
    setErrs(e)
    if (Object.keys(e).length) return
    setConfirm({
      header: {
        company_id: companyId,
        order_id: mode === 'order' ? orderId : null,
        party_id: mode === 'order' ? order?.party_id : party,
        place_id: place,
        receipt_date: date,
        supplier_invoice_no: invoiceNo.trim() || null,
        supplier_invoice_date: invoiceDate || null,
        eway_bill_no: eway.trim() || null,
        vehicle_no: vehicle.trim() || null,
      },
      lines: out,
    })
  }

  const supplierName = mode === 'order' ? (order?.party_name ?? '') : (suppliers.find((s) => s.id === party)?.name ?? '')
  const placeName = places.find((p) => p.id === place)?.name ?? ''

  return (
    <>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Tabs
          variant="segmented"
          label={t('goodsReceipt.mode')}
          value={mode}
          onChange={switchMode}
          tabs={[
            { key: 'order', label: t('goodsReceipt.modeOrder') },
            { key: 'direct', label: t('goodsReceipt.modeDirect') },
          ]}
        />
        {mode === 'direct' ? <span className="k">{canDirect ? t('goodsReceipt.directNote') : t('goodsReceipt.directNoRight')}</span> : null}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16, alignItems: 'start' }}>
        <Card title={t('goodsReceipt.supplierBill')}>
          <FieldGrid cols={2}>
            {mode === 'order' ? (
              <SelectField
                label={t('goodsReceipt.order')}
                value={orderId}
                error={errs.order}
                placeholder={orders.length ? t('goodsReceipt.chooseOrder') : t('goodsReceipt.noOrders')}
                options={orders.map((o) => ({ value: o.id, label: `${o.doc_no ?? ''} · ${o.party_name}` }))}
                onChange={(e) => {
                  setOrderId(e.target.value)
                  setEdits({})
                  setPosted(null)
                }}
              />
            ) : (
              <SelectField label={t('goodsReceipt.supplier')} value={party} error={errs.party} placeholder={t('goodsReceipt.chooseSupplier')} options={suppliers.map((s) => ({ value: s.id, label: s.gstin ? `${s.name} · ${s.gstin}` : s.name }))} onChange={(e) => setParty(e.target.value)} />
            )}
            <Field label={t('goodsReceipt.invoiceNo')} value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
            <Field type="date" label={t('goodsReceipt.invoiceDate')} value={invoiceDate} max={todayIst()} onChange={(e) => setInvoiceDate(e.target.value)} />
            <Field type="date" label={t('goodsReceipt.receiptDate')} value={date} max={todayIst()} onChange={(e) => setDate(e.target.value)} />
          </FieldGrid>
          {mode === 'order' && order ? (
            <div style={{ marginTop: 12 }}>
              <KeyValue
                rows={[
                  { label: t('goodsReceipt.supplier'), value: order.party_name },
                  { label: t('goodsReceipt.orderDate'), value: <span className="mono">{formatDate(order.order_date)}</span> },
                  { label: t('goodsReceipt.deliveryBy'), value: order.delivery_date ? <span className="mono">{formatDate(order.delivery_date)}</span> : '—' },
                ]}
              />
            </div>
          ) : null}
        </Card>
        <Card title={t('goodsReceipt.transport')}>
          <FieldGrid cols={2}>
            <Field label={t('goodsReceipt.eway')} value={eway} onChange={(e) => setEway(e.target.value)} />
            <Field label={t('goodsReceipt.vehicle')} value={vehicle} onChange={(e) => setVehicle(e.target.value.toUpperCase())} />
            <SelectField label={t('goodsReceipt.store')} value={place} error={errs.place} placeholder={places.length ? t('goodsReceipt.chooseStore') : t('goodsReceipt.noStores')} options={places.map((p) => ({ value: p.id, label: `${p.name} · ${p.branch_name}` }))} onChange={(e) => setPlace(e.target.value)} />
          </FieldGrid>
          <p className="k" style={{ marginBottom: 0 }}>
            {mode === 'order' ? (order ? t('goodsReceipt.linkedNote', { no: order.doc_no ?? '' }) : t('goodsReceipt.chooseOrderNote')) : t('goodsReceipt.directNote')}
          </p>
        </Card>
      </div>

      <Card title={t('goodsReceipt.goods')}>
        {mode === 'order' && !order ? (
          <p className="muted" style={{ margin: 0 }}>
            {t('goodsReceipt.chooseOrderNote')}
          </p>
        ) : mode === 'order' && olq.isLoading ? (
          <Skeleton height={60} />
        ) : mode === 'order' && lines.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {t('goodsReceipt.nothingPending')}
          </p>
        ) : (
          <div className="sf-table-wrap" tabIndex={0} role="region" aria-label={t('goodsReceipt.goods')}>
            <table className="sf-table">
              <caption className="sr-only">{t('goodsReceipt.goods')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('goodsReceipt.col.item')}</th>
                  {mode === 'order' ? (
                    <th scope="col" className="r">
                      {t('goodsReceipt.col.ordered')}
                    </th>
                  ) : null}
                  <th scope="col" className="r">
                    {t('goodsReceipt.col.received')}
                  </th>
                  {mode === 'direct' ? (
                    <th scope="col" className="r">
                      {t('goodsReceipt.col.rate')}
                    </th>
                  ) : null}
                  <th scope="col">{t('goodsReceipt.col.lot')}</th>
                  <th scope="col">{t('goodsReceipt.col.supplierLot')}</th>
                  <th scope="col">{t('goodsReceipt.col.expiry')}</th>
                  <th scope="col">{t('goodsReceipt.col.mfg')}</th>
                  <th scope="col">{t('goodsReceipt.col.quality')}</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const n = i + 1
                  const name = mode === 'order' ? l.label : (products.find((p) => p.id === l.product_id)?.name ?? '')
                  return (
                    <tr key={l.order_line_id ?? i}>
                      <td>
                        {mode === 'order' ? (
                          <div>
                            <div style={{ fontWeight: 600 }}>{l.label}</div>
                            {l.hsn ? <div className="k mono">{l.hsn}</div> : null}
                          </div>
                        ) : (
                          <select className="sf-input" style={{ height: 34, minWidth: 200 }} aria-label={t('goodsReceipt.aria.item', { n })} value={l.product_id} onChange={(e) => setLine(i, { product_id: e.target.value })}>
                            <option value="">{t('goodsReceipt.choose')}</option>
                            {products.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.code} · {p.name}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      {mode === 'order' ? (
                        <td className="r mono">
                          {l.ordered}
                          <div className="k">{t('goodsReceipt.pending', { n: l.pending })}</div>
                        </td>
                      ) : null}
                      <td className="r">
                        <input className="sf-input mono" style={{ height: 34, width: 100, textAlign: 'right' }} inputMode="decimal" aria-label={t('goodsReceipt.aria.qty', { n, name })} value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
                      </td>
                      {mode === 'direct' ? (
                        <td className="r">
                          <input className="sf-input mono" style={{ height: 34, width: 100, textAlign: 'right' }} inputMode="decimal" aria-label={t('goodsReceipt.aria.rate', { n })} value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value })} />
                        </td>
                      ) : null}
                      <td>
                        <input className="sf-input mono" style={{ height: 34, width: 130 }} aria-label={t('goodsReceipt.aria.lot', { n, name })} placeholder={t('goodsReceipt.lotPlaceholder')} value={l.lot_no} onChange={(e) => setLine(i, { lot_no: e.target.value })} />
                      </td>
                      <td>
                        <input className="sf-input mono" style={{ height: 34, width: 120 }} aria-label={t('goodsReceipt.aria.supplierLot', { n, name })} value={l.supplier_lot_no} onChange={(e) => setLine(i, { supplier_lot_no: e.target.value })} />
                      </td>
                      <td>
                        <input type="date" className="sf-input" style={{ height: 34 }} aria-label={t('goodsReceipt.aria.expiry', { n, name })} value={l.expiry_date} onChange={(e) => setLine(i, { expiry_date: e.target.value })} />
                      </td>
                      <td>
                        <input type="date" className="sf-input" style={{ height: 34 }} aria-label={t('goodsReceipt.aria.mfg', { n, name })} value={l.mfg_date} max={todayIst()} onChange={(e) => setLine(i, { mfg_date: e.target.value })} />
                      </td>
                      <td>{l.product_id && needsTest.has(l.product_id) ? <Chip tone="signal">{t('goodsReceipt.qcHold')}</Chip> : <span className="k">{t('goodsReceipt.qcAfter')}</span>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {mode === 'direct' ? (
          <div style={{ marginTop: 8 }}>
            <Button size="sm" onClick={() => setDirectLines([...directLines, blankLine()])}>
              {t('goodsReceipt.addLine')}
            </Button>
          </div>
        ) : null}
        {errs.lines ? (
          <p className="sf-field__msg" role="alert" style={{ color: 'var(--sf-danger-ink)', margin: '8px 0 0' }}>
            {errs.lines}
          </p>
        ) : null}
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16, alignItems: 'start' }}>
        <Card title={t('goodsReceipt.whatPosting.title')}>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <li>{t('goodsReceipt.whatPosting.stock')}</li>
            <li>{t('goodsReceipt.whatPosting.qc')}</li>
            <li>{t('goodsReceipt.whatPosting.bill')}</li>
          </ul>
        </Card>
        <Card title={t('goodsReceipt.post')}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <PurchaseErrorBox error={post.error as RpcError | null} />
            {posted ? <PostedResult posted={posted} /> : null}
            <div>
              <Button variant="primary" onClick={review} busy={post.isPending}>
                {t('goodsReceipt.postButton')}
              </Button>
            </div>
          </div>
        </Card>
      </div>

      <ConfirmDialog
        open={Boolean(confirm)}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('goodsReceipt.confirmTitle')}
        effect={confirm ? t('goodsReceipt.confirmEffect', { n: confirm.lines.length, supplier: supplierName, store: placeName }) : ''}
        confirmLabel={t('goodsReceipt.postButton')}
        busy={post.isPending}
        onConfirm={() => {
          if (!confirm) return
          post.mutate(
            { p_header: confirm.header, p_lines: confirm.lines },
            {
              onSuccess: (res) => {
                setConfirm(null)
                setPosted(res)
                setInvoiceNo('')
                setInvoiceDate('')
                setEway('')
                setVehicle('')
                if (mode === 'direct') setDirectLines([blankLine()])
                else setEdits({})
              },
              onError: () => setConfirm(null),
            },
          )
        }}
      />
    </>
  )
}

function PostedResult({ posted }: { posted: Posted }) {
  const { t } = useTranslation()
  const held = posted.lots.filter((l) => l.bucket === 'quarantine').length
  return (
    <div role="status" className="sf-alert" data-tone="success" style={{ flexDirection: 'column', alignItems: 'flex-start', margin: 0 }}>
      <strong>{t('goodsReceipt.posted', { no: posted.doc_no })}</strong>
      <ul style={{ margin: 0, paddingLeft: 18 }} data-testid="grn-lots">
        {posted.lots.map((l) => (
          <li key={l.lot_id}>
            {t('goodsReceipt.lotResult', { line: l.line_no, lot: l.lot_no })} <DocStatus status={l.bucket} />
          </li>
        ))}
      </ul>
      {held ? (
        <span>
          {t('goodsReceipt.heldNote', { n: held })} <Link to="/inventory/warehouse">{t('goodsReceipt.toWarehouse')}</Link>
        </span>
      ) : null}
    </div>
  )
}

function ReceiptList({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const q = useApiView('goods_receipts', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 300 })
  const rows = rowsOf(q)
  const [open, setOpen] = useState<string | null>(null)
  const selected = rows.find((r) => r.id === open) ?? null
  const columns: Column<Grn>[] = [
    { key: 'no', header: t('goodsReceipt.list.no'), render: (r) => <span className="mono">{r.doc_no}</span> },
    { key: 'date', header: t('goodsReceipt.list.date'), render: (r) => <span className="mono">{formatDate(r.receipt_date)}</span> },
    { key: 'party', header: t('goodsReceipt.supplier'), render: (r) => r.party_name },
    { key: 'order', header: t('goodsReceipt.order'), render: (r) => (r.order_no ? <span className="mono">{r.order_no}</span> : <Chip tone="signal">{t('goodsReceipt.list.direct')}</Chip>) },
    { key: 'place', header: t('goodsReceipt.store'), render: (r) => r.place_name },
    { key: 'lines', header: t('goodsReceipt.list.lines'), align: 'right', render: (r) => r.lines ?? 0 },
    { key: 'qc', header: t('goodsReceipt.col.quality'), render: (r) => (Number(r.lines_in_quarantine) > 0 ? <Chip tone="signal">{t('goodsReceipt.list.held', { n: r.lines_in_quarantine })}</Chip> : <DocStatus status="available" />) },
    { key: 'bill', header: t('goodsReceipt.list.bill'), render: (r) => (r.bill_id ? <DocStatus status="posted" /> : <span className="k">{t('goodsReceipt.list.noBill')}</span>) },
    {
      key: 'act',
      header: <span className="sr-only">{t('goodsReceipt.list.actions')}</span>,
      render: (r) => (
        <Button size="sm" variant="link" aria-label={t('goodsReceipt.list.openAria', { no: r.doc_no })} onClick={() => setOpen(r.id)}>
          {t('goodsReceipt.list.open')}
        </Button>
      ),
    },
  ]
  return (
    <>
      {selected ? <ReceiptDetail key={selected.id} grn={selected} onClose={() => setOpen(null)} /> : null}
      <TableCard title={t('goodsReceipt.list.title')}>
        <DataTable caption={t('goodsReceipt.list.title')} columns={columns} rows={rows} rowKey={(r) => r.id} loading={q.isLoading} minWidth={900} empty={<EmptyState title={t('goodsReceipt.list.emptyTitle')} body={t('goodsReceipt.list.emptyBody')} />} />
      </TableCard>
    </>
  )
}

function ReceiptDetail({ grn, onClose }: { grn: Grn; onClose: () => void }) {
  const { t } = useTranslation()
  const lq = useApiView('grn_lines', { eq: { grn_id: grn.id }, order: 'line_no' })
  type L = ViewRow<'grn_lines'>
  const cols: Column<L>[] = [
    { key: 'item', header: t('goodsReceipt.col.item'), render: (l) => `${l.product_code} · ${l.product_name}` },
    { key: 'qty', header: t('goodsReceipt.col.received'), align: 'right', render: (l) => <span className="mono">{`${l.qty} ${l.uom}`}</span> },
    { key: 'rate', header: t('goodsReceipt.col.rate'), align: 'right', render: (l) => <Amount value={l.rate} /> },
    { key: 'lot', header: t('goodsReceipt.col.lot'), render: (l) => <span className="mono">{l.lot_no ?? '—'}</span> },
    { key: 'exp', header: t('goodsReceipt.col.expiry'), render: (l) => (l.expiry_date ? <span className="mono">{formatDate(l.expiry_date)}</span> : '—') },
    { key: 'status', header: t('goodsReceipt.col.quality'), render: (l) => <DocStatus status={l.lot_status ?? l.bucket} /> },
  ]
  return (
    <Card
      title={t('goodsReceipt.detail', { no: grn.doc_no })}
      action={
        <Button size="sm" variant="link" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        {t('goodsReceipt.detailMeta', { supplier: grn.party_name, by: grn.received_by_name ?? '—', date: formatDate(grn.receipt_date) })}
      </p>
      <DataTable caption={t('goodsReceipt.goods')} columns={cols} rows={rowsOf(lq)} rowKey={(l) => l.id} loading={lq.isLoading} minWidth={720} />
    </Card>
  )
}

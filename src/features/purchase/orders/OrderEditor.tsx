import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { cleanAmount, useReadRpc } from '@/features/accounts/cash-book/money'
import { TotalsBlock, useDebounced, type Totals } from '@/features/sales/invoice/taxPanel'
import { formatDate, formatIndian } from '@/shared/format'
import { Amount, Button, Card, Checkbox, ConfirmDialog, DataTable, Field, FieldGrid, FormDialog, KeyValue, SelectField, Skeleton, TextAreaField, type Column } from '@/ui'
import { cleanQty, DocStatus, PurchaseErrorBox, useCompanyPlaces, useCompanyProducts, useCompanySuppliers, usePurchaseRights } from '../common/purchase'

type Order = ViewRow<'purchase_orders'>
type OrderLine = ViewRow<'purchase_order_lines'>
interface Line {
  product_id: string
  description: string
  hsn_code: string
  qty: string
  rate: string
  discount: string
  request_line_id: string | null
}
interface Draft {
  party_id: string
  gstin_id: string
  order_date: string
  delivery_date: string
  place_id: string
  terms_days: string
  notes: string
  request_id: string | null
  quotation_id: string | null
  lines: Line[]
}
interface PriceFlag {
  line_no: number
  last_rate: number | string
  new_rate: number | string
  change_pct: number | string | null
}
const EMPTY_LINE: Line = { product_id: '', description: '', hsn_code: '', qty: '', rate: '', discount: '', request_line_id: null }
const emptyDraft = (): Draft => ({ party_id: '', gstin_id: '', order_date: todayIst(), delivery_date: '', place_id: '', terms_days: '', notes: '', request_id: null, quotation_id: null, lines: [{ ...EMPTY_LINE }] })
export const ORDER_REFRESH = [['api', 'purchase_orders'], ['api', 'purchase_order_lines'], ['api', 'purchase_requests'], ['api', 'msg_outbox'], ['api', 'buying_logistics_home'], ['api', 'price_history']]

function isBlank(l: Line) {
  return !l.product_id && !l.description.trim() && !l.qty.trim() && !l.rate.trim()
}
function payload(lines: Line[]): { lines: Record<string, unknown>[] } | { error: number } {
  const out: Record<string, unknown>[] = []
  for (const [i, l] of lines.entries()) {
    if (isBlank(l)) continue
    const qty = cleanQty(l.qty)
    const rate = cleanAmount(l.rate || '')
    const discount = cleanAmount(l.discount || '0')
    if (!l.product_id || !qty || rate === null || discount === null) return { error: i + 1 }
    out.push({ product_id: l.product_id, description: l.description.trim() || null, hsn_code: l.hsn_code.trim() || null, qty, rate, discount, request_line_id: l.request_line_id })
  }
  return { lines: out }
}

/**
 * One purchase order (§UX-7.3): a draft is edited with the tax worked out by the server (api.preview_tax while typing,
 * api.save_purchase_order when saved); an approver who did not draft it issues it (api.issue_purchase_order — the
 * server refuses the drafter and asks to accept any price increase over the last rate). Issued orders are read-only,
 * with what is received and what is pending, the supplier's WhatsApp status, confirm and cancel.
 */
export function OrderEditor({ companyId, orderId, onSaved, onClose }: { companyId: string; orderId: string | null; onSaved: (id: string) => void; onClose: () => void }) {
  const { t } = useTranslation()
  const oq = useApiView('purchase_orders', { eq: { id: orderId ?? '' }, enabled: Boolean(orderId) })
  const order = rowsOf(oq)[0] ?? null
  if (orderId && oq.isLoading) {
    return (
      <Card>
        <Skeleton height={120} />
      </Card>
    )
  }
  if (orderId && !order) {
    return (
      <Card title={t('purchaseOrders.editor.notFound')}>
        <Button onClick={onClose}>{t('common.close')}</Button>
      </Card>
    )
  }
  if (order && order.status !== 'draft') return <OrderView key={order.id} companyId={companyId} order={order} onClose={onClose} />
  if (order) return <DraftLoader key={order.id} companyId={companyId} order={order} onSaved={onSaved} onClose={onClose} />
  return <DraftEditor key="new" companyId={companyId} order={null} initial={emptyDraft()} onSaved={onSaved} onClose={onClose} />
}

/** Reads a draft order's lines, then hands the order to the editor. */
function DraftLoader({ companyId, order, onSaved, onClose }: { companyId: string; order: Order; onSaved: (id: string) => void; onClose: () => void }) {
  const lq = useApiView('purchase_order_lines', { eq: { order_id: order.id }, order: 'line_no' })
  if (lq.data?.status !== 'ready') {
    return (
      <Card>
        <Skeleton height={120} />
      </Card>
    )
  }
  const ls = rowsOf(lq)
  const initial: Draft = {
    party_id: order.party_id,
    gstin_id: order.gstin_id,
    order_date: order.order_date,
    delivery_date: order.delivery_date ?? '',
    place_id: order.place_id ?? '',
    terms_days: String(order.terms_days ?? ''),
    notes: order.notes ?? '',
    request_id: order.request_id,
    quotation_id: order.quotation_id,
    lines: ls.length
      ? ls.map((l) => ({ product_id: l.product_id ?? '', description: l.description, hsn_code: l.hsn_code ?? '', qty: String(l.qty), rate: String(l.rate), discount: Number(l.discount) ? String(l.discount) : '', request_line_id: l.request_line_id }))
      : [{ ...EMPTY_LINE }],
  }
  return <DraftEditor companyId={companyId} order={order} initial={initial} onSaved={onSaved} onClose={onClose} />
}

function DraftEditor({ companyId, order, initial, onSaved, onClose }: { companyId: string; order: Order | null; initial: Draft; onSaved: (id: string) => void; onClose: () => void }) {
  const { t } = useTranslation()
  const rights = usePurchaseRights()
  const suppliers = useCompanySuppliers(companyId).list
  const products = useCompanyProducts(companyId).list
  const places = useCompanyPlaces(companyId).list
  const gstins = rowsOf(useApiView('gstins', { eq: { company_id: companyId }, order: 'gstin' }))
  const [draft, setDraft] = useState<Draft>(initial)
  const [dirty, setDirty] = useState(false)
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [accept, setAccept] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const save = useApiMutation<{ p: Record<string, unknown> }, { id: string; totals: Totals; price_flags: PriceFlag[] }>('save_purchase_order', ORDER_REFRESH)
  const issue = useApiMutation<{ p_order_id: string; p_accept_price_increase: boolean }, { id: string; doc_no: string; message_id: string | null }>('issue_purchase_order', ORDER_REFRESH)

  const gstinId = draft.gstin_id || gstins.find((g) => g.is_principal)?.id || gstins[0]?.id || ''
  const built = payload(draft.lines)
  const previewLines = 'lines' in built ? built.lines : []
  const args = useDebounced({ p_gstin_id: gstinId, p_party_id: draft.party_id, p_place_of_supply: null, p_date: draft.order_date, p_without_gst: false, p_lines: previewLines }, 400)
  const preview = useReadRpc<Totals & { intra_state: boolean }>('preview_tax', args, rights.create && Boolean(args.p_gstin_id && args.p_party_id && args.p_lines.length))
  const flags = (Array.isArray(order?.price_flags) ? order?.price_flags : []) as unknown as PriceFlag[]
  const needsAccept = Boolean(order?.has_price_increase) || (issue.error as RpcError | null)?.rule === 'purchase.price_increase'

  function change(next: Draft) {
    setDraft(next)
    setDirty(true)
    setSavedMsg(null)
  }
  function setLine(i: number, patch: Partial<Line>) {
    change({ ...draft, lines: draft.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) })
  }
  function addLine() {
    change({ ...draft, lines: [...draft.lines, { ...EMPTY_LINE }] })
    setTimeout(() => document.getElementById(`po-line-${draft.lines.length}-item`)?.focus(), 0)
  }

  function onSave() {
    issue.reset()
    const e: Record<string, string> = {}
    if (!draft.party_id) e.party = t('purchaseOrders.err.party')
    if (!gstinId) e.gstin = t('purchaseOrders.err.gstin')
    if (draft.terms_days.trim() && !/^\d{1,3}$/.test(draft.terms_days.trim())) e.terms = t('purchaseOrders.err.terms')
    if ('error' in built) e.lines = t('purchaseOrders.err.line', { n: built.error })
    else if (built.lines.length === 0) e.lines = t('purchaseOrders.err.noLines')
    setErrs(e)
    if (Object.keys(e).length || !('lines' in built)) return
    save.mutate(
      {
        p: {
          id: order?.id ?? null,
          company_id: companyId,
          gstin_id: gstinId,
          party_id: draft.party_id,
          request_id: draft.request_id,
          quotation_id: draft.quotation_id,
          order_date: draft.order_date,
          delivery_date: draft.delivery_date || null,
          place_id: draft.place_id || null,
          terms_days: draft.terms_days.trim() || null,
          notes: draft.notes.trim() || null,
          lines: built.lines,
        },
      },
      {
        onSuccess: (res) => {
          setDirty(false)
          setSavedMsg(t('purchaseOrders.editor.saved', { total: formatIndian(res.totals.total) }) + (res.price_flags?.length ? ` ${t('purchaseOrders.editor.savedFlags', { n: res.price_flags.length })}` : ''))
          if (!order) onSaved(res.id)
        },
      },
    )
  }

  const supplierName = suppliers.find((s) => s.id === draft.party_id)?.name ?? order?.party_name ?? ''
  const editable = rights.create

  return (
    <Card
      title={order ? t('purchaseOrders.editor.titleDraft') : t('purchaseOrders.editor.titleNew')}
      action={
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <DocStatus status="draft" />
          <Button size="sm" variant="link" onClick={onClose}>
            {t('common.close')}
          </Button>
        </span>
      }
    >
      {(
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            if (editable) onSave()
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          <fieldset disabled={!editable} style={{ border: 0, margin: 0, padding: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <FieldGrid cols={3}>
              <SelectField label={t('purchaseOrders.editor.supplier')} value={draft.party_id} error={errs.party} placeholder={t('purchaseOrders.editor.chooseSupplier')} options={suppliers.map((s) => ({ value: s.id, label: s.gstin ? `${s.name} · ${s.gstin}` : s.name }))} onChange={(e) => change({ ...draft, party_id: e.target.value })} />
              <SelectField label={t('purchaseOrders.editor.gstin')} value={gstinId} error={errs.gstin} options={gstins.map((g) => ({ value: g.id, label: g.gstin }))} onChange={(e) => change({ ...draft, gstin_id: e.target.value })} />
              <SelectField label={t('purchaseOrders.editor.place')} value={draft.place_id} placeholder={t('purchaseOrders.editor.noPlace')} options={places.map((p) => ({ value: p.id, label: `${p.name} · ${p.branch_name}` }))} onChange={(e) => change({ ...draft, place_id: e.target.value })} />
              <Field type="date" label={t('purchaseOrders.editor.orderDate')} value={draft.order_date} max={todayIst()} onChange={(e) => change({ ...draft, order_date: e.target.value })} />
              <Field type="date" label={t('purchaseOrders.editor.deliveryDate')} value={draft.delivery_date} onChange={(e) => change({ ...draft, delivery_date: e.target.value })} />
              <Field label={t('purchaseOrders.editor.terms')} inputMode="numeric" value={draft.terms_days} error={errs.terms} help={t('purchaseOrders.editor.termsHelp')} onChange={(e) => change({ ...draft, terms_days: e.target.value })} />
            </FieldGrid>
            <div className="sf-table-wrap" tabIndex={0} role="region" aria-label={t('purchaseOrders.editor.lines')}>
              <table className="sf-table">
                <caption className="sr-only">{t('purchaseOrders.editor.lines')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('purchaseOrders.editor.col.item')}</th>
                    <th scope="col">{t('purchaseOrders.editor.col.description')}</th>
                    <th scope="col">{t('purchaseOrders.editor.col.hsn')}</th>
                    <th scope="col" className="r">
                      {t('purchaseOrders.editor.col.qty')}
                    </th>
                    <th scope="col" className="r">
                      {t('purchaseOrders.editor.col.rate')}
                    </th>
                    <th scope="col" className="r">
                      {t('purchaseOrders.editor.col.discount')}
                    </th>
                    <th scope="col">
                      <span className="sr-only">{t('purchaseOrders.editor.col.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {draft.lines.map((l, i) => {
                    const n = i + 1
                    return (
                      <tr key={i}>
                        <td>
                          <select id={`po-line-${i}-item`} className="sf-input" style={{ height: 34, minWidth: 200 }} aria-label={t('purchaseOrders.aria.item', { n })} value={l.product_id} onChange={(e) => setLine(i, { product_id: e.target.value })}>
                            <option value="">{t('purchaseOrders.editor.choose')}</option>
                            {products.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.code} · {p.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input className="sf-input" style={{ height: 34 }} aria-label={t('purchaseOrders.aria.description', { n })} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
                        </td>
                        <td>
                          <input className="sf-input mono" style={{ height: 34, width: 100 }} aria-label={t('purchaseOrders.aria.hsn', { n })} value={l.hsn_code} onChange={(e) => setLine(i, { hsn_code: e.target.value.replace(/\D/g, '') })} />
                        </td>
                        <td className="r">
                          <input className="sf-input mono" style={{ height: 34, width: 90, textAlign: 'right' }} inputMode="decimal" aria-label={t('purchaseOrders.aria.qty', { n })} value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
                        </td>
                        <td className="r">
                          <input
                            className="sf-input mono"
                            style={{ height: 34, width: 110, textAlign: 'right' }}
                            inputMode="decimal"
                            aria-label={t('purchaseOrders.aria.rate', { n })}
                            value={l.rate}
                            onChange={(e) => setLine(i, { rate: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && i === draft.lines.length - 1) {
                                e.preventDefault()
                                addLine()
                              }
                            }}
                          />
                        </td>
                        <td className="r">
                          <input className="sf-input mono" style={{ height: 34, width: 90, textAlign: 'right' }} inputMode="decimal" aria-label={t('purchaseOrders.aria.discount', { n })} value={l.discount} onChange={(e) => setLine(i, { discount: e.target.value })} />
                        </td>
                        <td>
                          <Button size="sm" variant="link" aria-label={t('purchaseOrders.aria.remove', { n })} onClick={() => change({ ...draft, lines: draft.lines.length > 1 ? draft.lines.filter((_, j) => j !== i) : [{ ...EMPTY_LINE }] })}>
                            {t('purchaseOrders.editor.remove')}
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div>
                  <Button size="sm" onClick={addLine}>
                    {t('purchaseOrders.editor.addLine')}
                  </Button>
                </div>
                <p className="k" style={{ margin: 0 }}>
                  {t('purchaseOrders.editor.keyboard')}
                </p>
                {errs.lines ? (
                  <p className="sf-field__msg" role="alert" style={{ color: 'var(--sf-danger-ink)', margin: 0 }}>
                    {errs.lines}
                  </p>
                ) : null}
                {preview.error ? <PurchaseErrorBox error={preview.error} /> : null}
              </div>
              <TotalsBlock totals={dirty || !order ? (preview.data ?? null) : { taxable: order.taxable, cgst: order.cgst, sgst: order.sgst, igst: order.igst, round_off: order.round_off, total: order.total, amount_in_words: null }} intra={preview.data ? preview.data.intra_state : order ? Number(order.igst) === 0 : null} />
            </div>
            <TextAreaField label={t('purchaseOrders.editor.notes')} value={draft.notes} onChange={(e) => change({ ...draft, notes: e.target.value })} />
          </fieldset>

          {order && flags.length ? (
            <div className="sf-alert" data-tone="signal" role="note" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
              <strong>{t('purchaseOrders.editor.flagsTitle', { n: flags.length })}</strong>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {flags.map((f) => (
                  <li key={f.line_no}>{t('purchaseOrders.editor.flagLine', { line: f.line_no, last: formatIndian(f.last_rate), now: formatIndian(f.new_rate), pct: f.change_pct === null ? '—' : formatIndian(f.change_pct) })}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <PurchaseErrorBox error={(save.error ?? issue.error) as RpcError | null} />
          {savedMsg ? (
            <p role="status" className="sf-alert" data-tone="success" style={{ margin: 0 }}>
              {savedMsg}
            </p>
          ) : null}
          {order && needsAccept && rights.approve ? <Checkbox label={t('purchaseOrders.editor.accept')} checked={accept} onChange={(e) => setAccept(e.target.checked)} /> : null}
          {order && dirty ? <p className="k" style={{ margin: 0 }}>{t('purchaseOrders.editor.saveFirst')}</p> : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
            {order && rights.cancel ? <Button onClick={() => setCancelling(true)}>{t('purchaseOrders.view.cancel')}</Button> : null}
            {editable ? (
              <Button type="submit" busy={save.isPending}>
                {t('purchaseOrders.editor.save')}
              </Button>
            ) : null}
            {order && rights.approve ? (
              <Button
                variant="primary"
                disabled={dirty}
                onClick={() => {
                  issue.reset()
                  setConfirm(true)
                }}
              >
                {t('purchaseOrders.editor.issue')}
              </Button>
            ) : order ? (
              <span className="muted">{t('purchaseOrders.editor.waitIssuer')}</span>
            ) : null}
          </div>
          <p className="k" style={{ margin: 0 }}>
            {t('purchaseOrders.editor.issueRule')}
          </p>
        </form>
      )}
      {order ? (
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title={t('purchaseOrders.editor.confirmTitle')}
          effect={t('purchaseOrders.editor.confirmEffect', { total: formatIndian(order.total), supplier: supplierName })}
          confirmLabel={t('purchaseOrders.editor.issue')}
          busy={issue.isPending}
          onConfirm={() =>
            issue.mutate(
              { p_order_id: order.id, p_accept_price_increase: accept },
              {
                onSuccess: () => setConfirm(false),
                onError: () => setConfirm(false),
              },
            )
          }
        />
      ) : null}
      {order ? <CancelDialog order={order} open={cancelling} onOpenChange={setCancelling} /> : null}
    </Card>
  )
}

function CancelDialog({ order, open, onOpenChange }: { order: Order; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation()
  const cancel = useApiMutation<{ p_order_id: string; p_reason: string }>('cancel_purchase_order', ORDER_REFRESH)
  const [reason, setReason] = useState('')
  const [err, setErr] = useState<string | null>(null)
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('purchaseOrders.view.cancelTitle', { no: order.doc_no ?? t('purchaseOrders.list.draftNo') })}
      description={t('purchaseOrders.view.cancelBody')}
      submitLabel={t('purchaseOrders.view.cancel')}
      busy={cancel.isPending}
      error={<PurchaseErrorBox error={cancel.error as RpcError | null} />}
      onSubmit={() => {
        if (reason.trim().length < 5) {
          setErr(t('purchaseOrders.view.reasonShort'))
          return
        }
        cancel.mutate({ p_order_id: order.id, p_reason: reason.trim() }, { onSuccess: () => onOpenChange(false) })
      }}
    >
      <TextAreaField label={t('common.reason')} value={reason} error={err ?? undefined} onChange={(e) => setReason(e.target.value)} />
    </FormDialog>
  )
}

/** An issued (or later) order: read-only, with receipts against it, the WhatsApp status, confirm and cancel. */
function OrderView({ companyId, order, onClose }: { companyId: string; order: Order; onClose: () => void }) {
  const { t } = useTranslation()
  const rights = usePurchaseRights()
  const lq = useApiView('purchase_order_lines', { eq: { order_id: order.id }, order: 'line_no' })
  const confirm = useApiMutation<{ p_order_id: string; p_note: string | null }>('confirm_purchase_order', ORDER_REFRESH)
  const [cancelling, setCancelling] = useState(false)
  const cols: Column<OrderLine>[] = [
    { key: 'item', header: t('purchaseOrders.editor.col.item'), render: (l) => (l.product_code ? `${l.product_code} · ${l.description}` : l.description) },
    { key: 'hsn', header: t('purchaseOrders.editor.col.hsn'), render: (l) => <span className="mono">{l.hsn_code ?? '—'}</span> },
    { key: 'qty', header: t('purchaseOrders.editor.col.qty'), align: 'right', render: (l) => <span className="mono">{`${l.qty} ${l.uom}`}</span> },
    { key: 'rate', header: t('purchaseOrders.editor.col.rate'), align: 'right', render: (l) => <Amount value={l.rate} /> },
    { key: 'taxable', header: t('purchaseOrders.view.taxable'), align: 'right', render: (l) => <Amount value={l.taxable} /> },
    { key: 'gst', header: t('purchaseOrders.view.gst'), align: 'right', render: (l) => <span className="mono">{`${l.gst_rate}%`}</span> },
    { key: 'recv', header: t('purchaseOrders.view.received'), align: 'right', render: (l) => <Amount value={l.qty_received} digits={3} /> },
    { key: 'pend', header: t('purchaseOrders.view.pending'), align: 'right', render: (l) => <Amount value={l.qty_pending} digits={3} /> },
  ]
  const open = ['issued', 'confirmed', 'part_received'].includes(order.status)
  return (
    <Card
      title={t('purchaseOrders.view.title', { no: order.doc_no ?? '' })}
      action={
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <DocStatus status={order.status} />
          {order.message_status ? <DocStatus status={order.message_status} /> : null}
          <Button size="sm" variant="link" onClick={onClose}>
            {t('common.close')}
          </Button>
        </span>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
        <KeyValue
          rows={[
            { label: t('purchaseOrders.editor.supplier'), value: order.party_name },
            { label: t('purchaseOrders.editor.gstin'), value: <span className="mono">{order.gstin}</span> },
            { label: t('purchaseOrders.editor.orderDate'), value: <span className="mono">{formatDate(order.order_date)}</span> },
            { label: t('purchaseOrders.editor.deliveryDate'), value: order.delivery_date ? <span className="mono">{formatDate(order.delivery_date)}</span> : '—' },
            { label: t('purchaseOrders.editor.place'), value: order.place_name ?? '—' },
            { label: t('purchaseOrders.editor.terms'), value: t('purchaseOrders.view.days', { n: order.terms_days }) },
            { label: t('purchaseOrders.view.issuedBy'), value: order.issued_by_name ? `${order.issued_by_name} · ${order.issued_at ? formatDate(order.issued_at) : ''}` : '—' },
          ]}
        />
        <TotalsBlock totals={{ taxable: order.taxable, cgst: order.cgst, sgst: order.sgst, igst: order.igst, round_off: order.round_off, total: order.total, amount_in_words: null }} intra={Number(order.igst) === 0} />
      </div>
      <div style={{ marginTop: 16 }}>
        <DataTable caption={t('purchaseOrders.editor.lines')} columns={cols} rows={rowsOf(lq)} rowKey={(l) => l.id} loading={lq.isLoading} minWidth={820} />
      </div>
      {order.message_status === 'skipped' ? <p className="k">{t('purchaseOrders.view.waSkipped')}</p> : order.message_status === 'queued' ? <p className="k">{t('purchaseOrders.view.waQueued')}</p> : null}
      {order.cancel_reason ? <p className="k">{t('purchaseOrders.view.cancelled', { reason: order.cancel_reason })}</p> : null}
      <PurchaseErrorBox error={confirm.error as RpcError | null} />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: 12 }}>
        {order.status === 'issued' && rights.edit ? (
          <Button busy={confirm.isPending} onClick={() => confirm.mutate({ p_order_id: order.id, p_note: null })}>
            {t('purchaseOrders.view.confirm')}
          </Button>
        ) : null}
        {open && rights.cancel && Number(order.qty_received) === 0 ? <Button onClick={() => setCancelling(true)}>{t('purchaseOrders.view.cancel')}</Button> : null}
        {open && rights.receive ? (
          <Link className="sf-btn" data-variant="primary" to={`/purchase/goods-receipt?company=${companyId}&order=${order.id}`}>
            {t('purchaseOrders.view.receive')}
          </Link>
        ) : null}
      </div>
      <CancelDialog order={order} open={cancelling} onOpenChange={setCancelling} />
    </Card>
  )
}

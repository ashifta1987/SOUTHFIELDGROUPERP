import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { callApi, useApiMutation, type RpcError } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { cleanAmount } from '@/features/accounts/cash-book/money'
import { formatDate, formatIndian } from '@/shared/format'
import { Amount, Button, Card, Chip, ConfirmDialog, DataTable, EmptyState, Field, FieldGrid, FormDialog, PageHeader, SelectField, Skeleton, TextAreaField, type Column } from '@/ui'
import { billPhotoUrl, cleanQty, DocStatus, PurchaseErrorBox, uploadBillPhoto, useCompanyProducts, useCompanySuppliers, usePurchaseRights } from '../common/purchase'

type Capture = ViewRow<'bill_captures'>
interface Line {
  product_id: string
  description: string
  hsn_code: string
  qty: string
  rate: string
  discount: string
}
interface Fields {
  party_id: string
  supplier_gstin: string
  invoice_no: string
  invoice_date: string
  irn: string
  taxable: string
  cgst: string
  sgst: string
  igst: string
  total: string
  order_id: string
  grn_id: string
  lines: Line[]
}
interface Check {
  check: string
  ok: boolean
  line?: number
  text?: string
  bill?: unknown
  order?: number | string
  received?: number | string
  expected?: Record<string, number | string>
}
interface Note {
  code: string
  line?: number
  last_rate?: number | string
  bill_rate?: number | string
}
interface MatchResult {
  ok: boolean
  checks: Check[]
  notes: Note[]
}
const EMPTY_LINE: Line = { product_id: '', description: '', hsn_code: '', qty: '', rate: '', discount: '' }
const REFRESH = [['api', 'bill_captures'], ['api', 'purchase_bills'], ['api', 'purchase_bill_lines'], ['api', 'payables'], ['api', 'goods_receipts'], ['api', 'price_history'], ['api', 'price_changes'], ['api', 'buying_logistics_home']]
const TO_REVIEW = ['uploaded', 'read', 'matched', 'mismatch', 'drafted']

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))
function fieldsOf(c: Capture): Fields {
  const ex = (c.extracted && typeof c.extracted === 'object' && !Array.isArray(c.extracted) ? c.extracted : {}) as Record<string, unknown>
  const lines = Array.isArray(ex.lines) ? (ex.lines as Record<string, unknown>[]) : []
  return {
    party_id: c.party_id ?? '',
    supplier_gstin: str(ex.supplier_gstin),
    invoice_no: str(ex.invoice_no),
    invoice_date: str(ex.invoice_date),
    irn: str(ex.irn),
    taxable: str(ex.taxable),
    cgst: str(ex.cgst),
    sgst: str(ex.sgst),
    igst: str(ex.igst),
    total: str(ex.total),
    order_id: c.order_id ?? '',
    grn_id: c.grn_id ?? '',
    lines: lines.length ? lines.map((l) => ({ product_id: str(l.product_id), description: str(l.description), hsn_code: str(l.hsn_code), qty: str(l.qty), rate: str(l.rate), discount: Number(l.discount) ? str(l.discount) : '' })) : [{ ...EMPTY_LINE }],
  }
}

/**
 * Bill photo capture (`BillReview`): bill photos from the phone (or uploaded here) wait in an inbox. Reading the photo
 * automatically arrives when the AI provider is chosen; until then a person types what the bill shows
 * (api.set_bill_capture_fields). api.match_bill_to_po_grn checks it against the order (rate), the goods received (qty)
 * and the tax from the HSN table; api.capture_to_purchase_draft makes the supplier bill draft (a mismatch only by Admin),
 * which is then posted as on Bills & payments (api.post_purchase_bill).
 */
export function BillReviewPage() {
  const { t } = useTranslation()
  const rights = usePurchaseRights()
  const [params, setParams] = useSearchParams()
  const choice = useCompanyChoice()
  const companyId = choice.companyId
  const captureId = params.get('capture')
  const q = useApiView('bill_captures', { eq: { company_id: companyId }, order: 'uploaded_at', ascending: false, limit: 300, enabled: Boolean(companyId) })
  const rows = rowsOf(q)
  const selected = rows.find((r) => r.id === captureId) ?? null
  const inbox = rows.filter((r) => TO_REVIEW.includes(r.status))
  const canWork = rights.create || rights.bills

  function open(id: string | null) {
    const next = new URLSearchParams(params)
    if (id) next.set('capture', id)
    else next.delete('capture')
    setParams(next, { replace: true })
  }

  const columns: Column<Capture>[] = [
    { key: 'when', header: t('billReview.list.uploaded'), render: (r) => <span className="mono">{formatDate(r.uploaded_at)}</span> },
    { key: 'by', header: t('billReview.list.by'), render: (r) => r.uploaded_by_name ?? '—' },
    { key: 'party', header: t('billReview.list.supplier'), render: (r) => r.party_name ?? '—' },
    { key: 'inv', header: t('billReview.list.invoice'), render: (r) => (r.invoice_no ? <span className="mono">{r.invoice_no}</span> : '—') },
    { key: 'total', header: t('billReview.list.total'), align: 'right', render: (r) => <Amount value={r.invoice_total} /> },
    { key: 'status', header: t('common.status'), render: (r) => <DocStatus status={r.status} /> },
    { key: 'bill', header: t('billReview.list.bill'), render: (r) => (r.bill_doc_no ? <span className="mono">{r.bill_doc_no}</span> : '—') },
    {
      key: 'act',
      header: <span className="sr-only">{t('billReview.list.actions')}</span>,
      render: (r) => (
        <Button size="sm" variant="link" aria-label={t('billReview.list.openAria', { when: formatDate(r.uploaded_at), by: r.uploaded_by_name ?? '' })} onClick={() => open(r.id)}>
          {t('billReview.list.open')}
        </Button>
      ),
    },
  ]

  return (
    <>
      <PageHeader title={selected ? t('billReview.titleOne', { name: selected.party_name ?? t('billReview.unknownSupplier'), no: selected.invoice_no ?? '' }) : t('billReview.title')} subtitle={t('billReview.subtitle')} actions={companyId && canWork ? <DesktopUpload companyId={companyId} onUploaded={open} /> : null} />
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }} role="group" aria-label={t('billReview.inbox')}>
          <strong style={{ marginRight: 4 }}>{t('billReview.inbox')}</strong>
          {inbox.length === 0 ? <span className="k">{t('billReview.inboxEmpty')}</span> : null}
          {inbox.slice(0, 8).map((r) => (
            <button key={r.id} type="button" className="sf-chip" data-tone={r.id === captureId ? 'teal' : 'info'} style={{ border: 0, cursor: 'pointer', minHeight: 24 }} aria-pressed={r.id === captureId} onClick={() => open(r.id)}>
              {`${r.party_name ?? t('billReview.unknownSupplier')} · ${t(`purchaseCommon.status.${r.status}`)}`}
            </button>
          ))}
          <Chip tone="neutral">{t('billReview.sources')}</Chip>
        </div>
        <CompanyPicker list={choice.list} value={companyId} onChange={choice.choose} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {choice.isLoading ? (
          <Card>
            <Skeleton height={80} />
          </Card>
        ) : !companyId ? (
          <Card>
            <EmptyState title={t('billReview.noCompany')} />
          </Card>
        ) : (
          <>
            {selected ? <CaptureDetail key={selected.id} capture={selected} companyId={companyId} canWork={canWork} canBills={rights.bills} onClose={() => open(null)} /> : null}
            <TableCard title={t('billReview.list.title')}>
              <DataTable caption={t('billReview.list.title')} columns={columns} rows={rows} rowKey={(r) => r.id} loading={q.isLoading} minWidth={900} empty={<EmptyState title={t('billReview.list.emptyTitle')} body={t('billReview.list.emptyBody')} />} />
            </TableCard>
            <Card>
              <p className="muted" style={{ margin: 0 }}>
                {t('billReview.readingNote')}
              </p>
            </Card>
          </>
        )}
      </div>
    </>
  )
}

/** Upload a bill photo or PDF from the desktop (same private bucket and RPC as the phone). */
function DesktopUpload({ companyId, onUploaded }: { companyId: string; onUploaded: (id: string) => void }) {
  const { t } = useTranslation()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      <input
        ref={input}
        type="file"
        accept="image/*,application/pdf"
        className="sr-only"
        aria-label={t('billReview.upload')}
        tabIndex={-1}
        onChange={async (e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (!file) return
          setBusy(true)
          setErr(null)
          try {
            const path = await uploadBillPhoto(companyId, file)
            const res = await callApi<{ id: string }>('create_bill_capture', { p: { company_id: companyId, photo_path: path, source: file.type === 'application/pdf' ? 'pdf' : 'upload' } })
            onUploaded(res.id)
          } catch (x) {
            setErr(x instanceof Error ? x.message : t('errors.saveFailed'))
          } finally {
            setBusy(false)
          }
        }}
      />
      {err ? (
        <span role="alert" style={{ color: 'var(--sf-danger-ink)' }}>
          {t('billReview.uploadFailed')}
        </span>
      ) : null}
      <Button busy={busy} onClick={() => input.current?.click()}>
        {t('billReview.upload')}
      </Button>
    </span>
  )
}

function CaptureDetail({ capture, companyId, canWork, canBills, onClose }: { capture: Capture; companyId: string; canWork: boolean; canBills: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const suppliers = useCompanySuppliers(companyId).list
  const products = useCompanyProducts(companyId).list
  const orders = rowsOf(useApiView('purchase_orders', { eq: { company_id: companyId }, order: 'order_date', ascending: false, limit: 300 })).filter((o) => o.doc_no && o.status !== 'cancelled')
  const [f, setF] = useState<Fields>(() => fieldsOf(capture))
  const grns = rowsOf(useApiView('goods_receipts', { eq: { company_id: companyId, order_id: f.order_id }, order: 'receipt_date', ascending: false, limit: 100, enabled: Boolean(f.order_id) }))
  const bq = useApiView('purchase_bills', { eq: { id: capture.bill_id ?? '' }, enabled: Boolean(capture.bill_id) })
  const bill = rowsOf(bq)[0] ?? null
  const [url, setUrl] = useState<string | null>(null)
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const setFields = useApiMutation<{ p_capture_id: string; p: Record<string, unknown> }, { id: string; party_id: string | null; status: string }>('set_bill_capture_fields', REFRESH)
  const match = useApiMutation<{ p_capture_id: string }, MatchResult & { status: string }>('match_bill_to_po_grn', REFRESH)
  const draft = useApiMutation<{ p_capture_id: string; p_gstin_id: string | null }, { bill_id: string; totals: { total: number | string } }>('capture_to_purchase_draft', REFRESH)
  const post = useApiMutation<{ p_bill_id: string }, { id: string; doc_no: string }>('post_purchase_bill', REFRESH)
  const reject = useApiMutation<{ p_capture_id: string; p_reason: string }>('reject_bill_capture', REFRESH)
  const locked = ['drafted', 'posted', 'rejected'].includes(capture.status)
  const ro = locked || !canWork
  const result = (match.data ?? capture.match_result) as MatchResult | null
  const busy = setFields.isPending || match.isPending || draft.isPending || post.isPending

  useEffect(() => {
    let live = true
    void billPhotoUrl(capture.photo_path).then((u) => live && setUrl(u))
    return () => {
      live = false
    }
  }, [capture.photo_path])

  function setLine(i: number, patch: Partial<Line>) {
    setF({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) })
  }
  function resetAll() {
    setMsg(null)
    setFields.reset()
    match.reset()
    draft.reset()
    post.reset()
  }

  function saveFields() {
    resetAll()
    const e: Record<string, string> = {}
    const money: Record<string, string | null> = {}
    for (const k of ['taxable', 'cgst', 'sgst', 'igst', 'total'] as const) {
      const v = f[k].trim()
      money[k] = v ? cleanAmount(v) : '0.00'
      if (money[k] === null) e[k] = t('billReview.err.amount')
    }
    if (!f.party_id && !f.supplier_gstin.trim()) e.party = t('billReview.err.party')
    if (!f.invoice_no.trim()) e.invoice_no = t('billReview.err.invoiceNo')
    if (!f.invoice_date) e.invoice_date = t('billReview.err.invoiceDate')
    const lines: Record<string, unknown>[] = []
    for (const [i, l] of f.lines.entries()) {
      if (!l.product_id && !l.description.trim() && !l.qty.trim() && !l.rate.trim()) continue
      const qty = cleanQty(l.qty)
      const rate = cleanAmount(l.rate)
      const discount = cleanAmount(l.discount || '0')
      if (!qty || rate === null || discount === null) {
        e.lines = t('billReview.err.line', { n: i + 1 })
        break
      }
      const uom = products.find((p) => p.id === l.product_id)?.uom ?? null
      lines.push({ product_id: l.product_id || null, description: l.description.trim() || null, hsn_code: l.hsn_code.trim() || null, uom, qty, rate, discount })
    }
    if (!e.lines && lines.length === 0) e.lines = t('billReview.err.noLines')
    setErrs(e)
    if (Object.keys(e).length) return
    setFields.mutate(
      {
        p_capture_id: capture.id,
        p: {
          party_id: f.party_id || null,
          order_id: f.order_id || null,
          grn_id: f.grn_id || null,
          extracted: { supplier_gstin: f.supplier_gstin.trim().toUpperCase() || null, invoice_no: f.invoice_no.trim(), invoice_date: f.invoice_date, irn: f.irn.trim() || null, ...money, lines },
        },
      },
      {
        onSuccess: (res) => {
          if (res.party_id && !f.party_id) setF({ ...f, party_id: res.party_id })
          setMsg(t('billReview.fieldsSaved'))
        },
      },
    )
  }

  const err = (setFields.error ?? match.error ?? draft.error ?? post.error ?? reject.error) as RpcError | null

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 380px) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
      <Card title={t('billReview.photo')} action={<span className="k">{t('billReview.keptWithBill')}</span>}>
        {url ? (
          capture.photo_path.toLowerCase().endsWith('.pdf') ? (
            <a href={url} target="_blank" rel="noreferrer">
              {t('billReview.openPdf')}
            </a>
          ) : (
            <img src={url} alt={t('billReview.photoAlt', { name: capture.party_name ?? t('billReview.unknownSupplier') })} style={{ width: '100%', borderRadius: 8, border: '1px solid var(--sf-line)', background: 'var(--sf-paper)' }} />
          )
        ) : (
          <Skeleton height={320} />
        )}
        <p className="k" style={{ marginBottom: 0 }}>
          {t('billReview.uploadedBy', { by: capture.uploaded_by_name ?? '—', date: formatDate(capture.uploaded_at) })}
        </p>
      </Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Card
          title={t('billReview.header')}
          action={
            <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
              <DocStatus status={capture.status} />
              <Button size="sm" variant="link" onClick={onClose}>
                {t('common.close')}
              </Button>
            </span>
          }
        >
          <p className="sf-alert" data-tone="info" style={{ marginTop: 0 }}>
            {t('billReview.typeNote')}
          </p>
          <fieldset disabled={locked || !canWork} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <FieldGrid cols={3}>
              <SelectField label={t('billReview.f.supplier')} value={f.party_id} error={errs.party} placeholder={t('billReview.f.bySupplierGstin')} options={suppliers.map((s) => ({ value: s.id, label: s.gstin ? `${s.name} · ${s.gstin}` : s.name }))} onChange={(e) => setF({ ...f, party_id: e.target.value })} />
              <Field label={t('billReview.f.gstin')} className="mono" value={f.supplier_gstin} onChange={(e) => setF({ ...f, supplier_gstin: e.target.value.toUpperCase() })} />
              <Field label={t('billReview.f.invoiceNo')} className="mono" value={f.invoice_no} error={errs.invoice_no} onChange={(e) => setF({ ...f, invoice_no: e.target.value })} />
              <Field type="date" label={t('billReview.f.invoiceDate')} value={f.invoice_date} max={todayIst()} error={errs.invoice_date} onChange={(e) => setF({ ...f, invoice_date: e.target.value })} />
              <Field label={t('billReview.f.irn')} className="mono" value={f.irn} onChange={(e) => setF({ ...f, irn: e.target.value })} />
              <SelectField label={t('billReview.f.order')} value={f.order_id} placeholder={t('billReview.f.noOrder')} options={orders.map((o) => ({ value: o.id, label: `${o.doc_no} · ${o.party_name}` }))} onChange={(e) => setF({ ...f, order_id: e.target.value, grn_id: '' })} />
              <SelectField label={t('billReview.f.grn')} value={f.grn_id} placeholder={f.order_id ? t('billReview.f.allGrns') : t('billReview.f.orderFirst')} options={grns.map((g) => ({ value: g.id, label: `${g.doc_no} · ${formatDate(g.receipt_date)}` }))} onChange={(e) => setF({ ...f, grn_id: e.target.value })} />
              <Field label={t('billReview.f.taxable')} inputMode="decimal" className="mono" value={f.taxable} error={errs.taxable} onChange={(e) => setF({ ...f, taxable: e.target.value })} />
              <Field label={t('billReview.f.cgst')} inputMode="decimal" className="mono" value={f.cgst} error={errs.cgst} onChange={(e) => setF({ ...f, cgst: e.target.value })} />
              <Field label={t('billReview.f.sgst')} inputMode="decimal" className="mono" value={f.sgst} error={errs.sgst} onChange={(e) => setF({ ...f, sgst: e.target.value })} />
              <Field label={t('billReview.f.igst')} inputMode="decimal" className="mono" value={f.igst} error={errs.igst} onChange={(e) => setF({ ...f, igst: e.target.value })} />
              <Field label={t('billReview.f.total')} inputMode="decimal" className="mono" value={f.total} error={errs.total} onChange={(e) => setF({ ...f, total: e.target.value })} />
            </FieldGrid>
            </fieldset>
          <div>
            <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>{t('billReview.lines')}</h3>
            <div className="sf-table-wrap" tabIndex={0} role="region" aria-label={t('billReview.lines')}>
              <table className="sf-table">
                <caption className="sr-only">{t('billReview.lines')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('billReview.col.onBill')}</th>
                    <th scope="col">{t('billReview.col.ourItem')}</th>
                    <th scope="col">{t('billReview.col.hsn')}</th>
                    <th scope="col" className="r">
                      {t('billReview.col.qty')}
                    </th>
                    <th scope="col" className="r">
                      {t('billReview.col.rate')}
                    </th>
                    <th scope="col" className="r">
                      {t('billReview.col.discount')}
                    </th>
                    <th scope="col">
                      <span className="sr-only">{t('billReview.list.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {f.lines.map((l, i) => {
                    const n = i + 1
                    return (
                      <tr key={i}>
                        <td>
                          <input disabled={ro} className="sf-input" style={{ height: 34 }} aria-label={t('billReview.aria.description', { n })} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
                        </td>
                        <td>
                          <select disabled={ro} className="sf-input" style={{ height: 34, minWidth: 180 }} aria-label={t('billReview.aria.item', { n })} value={l.product_id} onChange={(e) => setLine(i, { product_id: e.target.value })}>
                            <option value="">{t('billReview.choose')}</option>
                            {products.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.code} · {p.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input disabled={ro} className="sf-input mono" style={{ height: 34, width: 100 }} aria-label={t('billReview.aria.hsn', { n })} value={l.hsn_code} onChange={(e) => setLine(i, { hsn_code: e.target.value.replace(/\D/g, '') })} />
                        </td>
                        <td className="r">
                          <input disabled={ro} className="sf-input mono" style={{ height: 34, width: 90, textAlign: 'right' }} inputMode="decimal" aria-label={t('billReview.aria.qty', { n })} value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
                        </td>
                        <td className="r">
                          <input disabled={ro}
                            className="sf-input mono"
                            style={{ height: 34, width: 100, textAlign: 'right' }}
                            inputMode="decimal"
                            aria-label={t('billReview.aria.rate', { n })}
                            value={l.rate}
                            onChange={(e) => setLine(i, { rate: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && i === f.lines.length - 1) {
                                e.preventDefault()
                                setF({ ...f, lines: [...f.lines, { ...EMPTY_LINE }] })
                              }
                            }}
                          />
                        </td>
                        <td className="r">
                          <input disabled={ro} className="sf-input mono" style={{ height: 34, width: 90, textAlign: 'right' }} inputMode="decimal" aria-label={t('billReview.aria.discount', { n })} value={l.discount} onChange={(e) => setLine(i, { discount: e.target.value })} />
                        </td>
                        <td>
                          <Button size="sm" disabled={ro} variant="link" aria-label={t('billReview.aria.remove', { n })} onClick={() => setF({ ...f, lines: f.lines.length > 1 ? f.lines.filter((_, j) => j !== i) : [{ ...EMPTY_LINE }] })}>
                            {t('billReview.remove')}
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 8 }}>
              <Button size="sm" disabled={ro} onClick={() => setF({ ...f, lines: [...f.lines, { ...EMPTY_LINE }] })}>
                {t('billReview.addLine')}
              </Button>
              <span className="k">{t('billReview.keyboard')}</span>
            </div>
            {errs.lines ? (
              <p className="sf-field__msg" role="alert" style={{ color: 'var(--sf-danger-ink)', margin: '8px 0 0' }}>
                {errs.lines}
              </p>
            ) : null}
          </div>
        </Card>

        <Card title={t('billReview.checks.title')} action={result ? <DocStatus status={result.ok ? 'matched' : 'mismatch'} /> : null}>
          {result ? <Checks result={result} /> : <p className="muted" style={{ margin: 0 }}>{t('billReview.checks.notYet')}</p>}
        </Card>

        <Card title={t('billReview.next')}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <PurchaseErrorBox error={err} />
            {msg ? (
              <p role="status" className="sf-alert" data-tone="success" style={{ margin: 0 }}>
                {msg}
              </p>
            ) : null}
            {capture.bill_id ? (
              <p style={{ margin: 0 }} data-testid="capture-bill">
                {t('billReview.billLine', { no: bill?.doc_no ?? capture.bill_doc_no ?? t('billReview.draftBill'), total: bill ? formatIndian(bill.total) : '—' })} <DocStatus status={capture.bill_status ?? 'draft'} />{' '}
                <Link to={`/purchase/bills-and-payments?company=${companyId}`}>{t('billReview.toBills')}</Link>
              </p>
            ) : null}
            {canWork ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {!locked ? (
                  <>
                    <Button busy={setFields.isPending} disabled={busy} onClick={saveFields}>
                      {t('billReview.saveFields')}
                    </Button>
                    <Button
                      busy={match.isPending}
                      disabled={busy || capture.status === 'uploaded'}
                      onClick={() => {
                        resetAll()
                        match.mutate({ p_capture_id: capture.id })
                      }}
                    >
                      {t('billReview.match')}
                    </Button>
                    {canBills ? (
                      <Button
                        variant="primary"
                        busy={draft.isPending}
                        disabled={busy || !['matched', 'mismatch'].includes(capture.status)}
                        onClick={() => {
                          resetAll()
                          draft.mutate({ p_capture_id: capture.id, p_gstin_id: null }, { onSuccess: (res) => setMsg(t('billReview.drafted', { total: formatIndian(res.totals.total) })) })
                        }}
                      >
                        {t('billReview.makeDraft')}
                      </Button>
                    ) : null}
                    <Button variant="link" onClick={() => setRejecting(true)}>
                      {t('billReview.reject')}
                    </Button>
                  </>
                ) : null}
                {capture.status === 'drafted' && canBills && bill && bill.status === 'draft' ? (
                  <Button variant="primary" busy={post.isPending} onClick={() => setConfirm(true)}>
                    {t('billReview.postBill')}
                  </Button>
                ) : null}
              </div>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                {t('billReview.noRight')}
              </p>
            )}
            <p className="k" style={{ margin: 0 }}>
              {t('billReview.stepsNote')}
            </p>
          </div>
        </Card>
      </div>
      {bill ? (
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title={t('billReview.confirmTitle')}
          effect={t('billReview.confirmEffect', { total: formatIndian(bill.total), supplier: bill.party_name, no: bill.supplier_bill_no })}
          confirmLabel={t('billReview.postBill')}
          busy={post.isPending}
          onConfirm={() =>
            post.mutate(
              { p_bill_id: bill.id },
              {
                onSuccess: (res) => {
                  setConfirm(false)
                  setMsg(t('billReview.posted', { no: res.doc_no }))
                },
                onError: () => setConfirm(false),
              },
            )
          }
        />
      ) : null}
      <FormDialog
        open={rejecting}
        onOpenChange={setRejecting}
        title={t('billReview.rejectTitle')}
        submitLabel={t('billReview.reject')}
        busy={reject.isPending}
        error={<PurchaseErrorBox error={reject.error as RpcError | null} />}
        onSubmit={() => {
          if (reason.trim().length < 5) return
          reject.mutate({ p_capture_id: capture.id, p_reason: reason.trim() }, { onSuccess: () => setRejecting(false) })
        }}
      >
        <TextAreaField label={t('common.reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormDialog>
    </div>
  )
}

/** The server's 3-way match result, check by check (OK / Check) with notes. */
function Checks({ result }: { result: MatchResult }) {
  const { t } = useTranslation()
  const sentence = (c: Check): string => {
    switch (c.check) {
      case 'duplicate':
        return c.ok ? t('billReview.checks.dupOk') : t('billReview.checks.dupBad')
      case 'order':
        return t('billReview.checks.noOrder')
      case 'item':
        return t('billReview.checks.item', { line: c.line ?? '', text: c.text ?? '' })
      case 'rate':
        return t('billReview.checks.rate', { line: c.line ?? '', bill: formatIndian(str(c.bill) || 0), order: formatIndian(c.order ?? 0) })
      case 'qty':
        return t('billReview.checks.qty', { line: c.line ?? '', bill: str(c.bill), received: str(c.received) })
      case 'tax':
        return c.ok
          ? t('billReview.checks.taxOk', { text: c.text ?? '' })
          : t('billReview.checks.taxBad', {
              taxable: formatIndian(c.expected?.taxable ?? 0),
              cgst: formatIndian(c.expected?.cgst ?? 0),
              sgst: formatIndian(c.expected?.sgst ?? 0),
              igst: formatIndian(c.expected?.igst ?? 0),
            })
      case 'lines':
        return t('billReview.checks.noLines')
      default:
        return c.text ?? c.check
    }
  }
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="match-checks">
      {result.checks.map((c, i) => (
        <li key={i} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
          <Chip tone={c.ok ? 'success' : 'signal'}>{c.ok ? t('billReview.checks.ok') : t('billReview.checks.check')}</Chip>
          <span>{sentence(c)}</span>
        </li>
      ))}
      {result.notes.map((n, i) => (
        <li key={`n${i}`} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
          <Chip tone="info">{t('billReview.checks.note')}</Chip>
          <span>{n.code === 'price.increase' ? t('billReview.checks.priceUp', { line: n.line ?? '', bill: formatIndian(n.bill_rate ?? 0), last: formatIndian(n.last_rate ?? 0) }) : n.code === 'match.tolerance_not_set' ? t('billReview.checks.noTolerance') : n.code}</span>
        </li>
      ))}
    </ul>
  )
}

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { callApi, useApiMutation, type RpcError } from '@/data/rpc'
import { Button, Card, Chip, Field, FieldGrid, FormDialog, ConfirmDialog, PageHeader, SelectField, StatusChip, TextAreaField, Amount, Icon } from '@/ui'
import { formatIndian, formatTime } from '@/shared/format'
import { ADMIN_ONLY_TYPES, DOC_TYPES, GST_STATES, LAWFUL_REASONS, type DocType, type SalesDoc, type SalesDocLine, type TaxPreview } from './docs'
import { RuleErrorBox } from './RuleErrorBox'
import { TaxPanel, TotalsBlock, useDebounced } from './taxPanel'
import { WhatsAppStatus } from './WhatsAppStatus'

export type Product = ViewRow<'products'>

export interface HeaderDraft {
  companyId: string
  gstinId: string
  docType: DocType
  docDate: string
  partyId: string
  pos: string
  lawfulReason: string
  againstId: string
  reason: string
  notes: string
}
export interface LineDraft {
  key: string
  productId: string
  productText: string
  qty: string
  rate: string
  discount: string
}
export interface EditorInitial {
  header: HeaderDraft
  lines: LineDraft[]
}

let lineSeq = 0
export function newLine(): LineDraft {
  lineSeq += 1
  return { key: `l${lineSeq}-${Math.random().toString(36).slice(2, 7)}`, productId: '', productText: '', qty: '', rate: '', discount: '' }
}

export function productLabel(p: Pick<Product, 'code' | 'name'>): string {
  return `${p.code} · ${p.name}`
}

/** Form state for an existing document, from the saved header and lines. */
export function initialFromDoc(doc: SalesDoc, lines: SalesDocLine[], products: Product[]): EditorInitial {
  return {
    header: {
      companyId: doc.company_id,
      gstinId: doc.gstin_id,
      docType: (DOC_TYPES as readonly string[]).includes(doc.doc_type) ? (doc.doc_type as DocType) : 'sales_invoice',
      docDate: doc.doc_date,
      partyId: doc.party_id,
      pos: doc.place_of_supply,
      lawfulReason: doc.lawful_reason ?? '',
      againstId: doc.against_id ?? '',
      reason: doc.reason ?? '',
      notes: doc.notes ?? '',
    },
    lines: lines.length
      ? lines.map((l) => {
          const p = products.find((x) => x.id === l.product_id)
          return { ...newLine(), productId: l.product_id ?? '', productText: p ? productLabel(p) : l.description, qty: String(l.qty), rate: String(l.rate), discount: Number(l.discount) ? String(l.discount) : '' }
        })
      : [newLine()],
  }
}

const QTY_RE = /^\d+(\.\d{1,3})?$/
const AMT_RE = /^\d+(\.\d{1,2})?$/

const cellInput = { height: 34, minWidth: 0, width: '100%' } as const

interface PreviewOut {
  keys: string[]
  result: TaxPreview
}

/**
 * Document entry (§UX-7.3): header, keyboard line entry (Enter adds a line), the server-computed tax panel
 * (api.preview_tax — the same function the posting uses), the state chip and the actions the state allows.
 * Drafts are saved with api.save_sales_draft and autosave after the first save; posting is api.post_sales_document.
 */
export function InvoiceEditor({
  docId,
  doc,
  docLines,
  initial,
  products,
  companies,
  isAdmin,
  canCreate,
  canCancel,
  onCreated,
  onNew,
  onPreview,
  onCompanyChange,
}: {
  docId: string | null
  doc: SalesDoc | undefined
  docLines: SalesDocLine[]
  initial: EditorInitial
  products: Product[]
  companies: ViewRow<'companies'>[]
  isAdmin: boolean
  canCreate: boolean
  canCancel: boolean
  onCreated: (id: string) => void
  onNew: (preset?: Partial<HeaderDraft>) => void
  onPreview: () => void
  onCompanyChange: (id: string) => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const listId = useId()
  const [header, setHeader] = useState<HeaderDraft>(initial.header)
  const [lines, setLines] = useState<LineDraft[]>(initial.lines)
  const [version, setVersion] = useState(0)
  const [savedVersion, setSavedVersion] = useState(0)
  const [createdId, setCreatedId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const [saveError, setSaveError] = useState<RpcError | null>(null)
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [lastTotal, setLastTotal] = useState<number | string | null>(null)
  const [confirmPost, setConfirmPost] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelErr, setCancelErr] = useState<string | undefined>()
  const [custSearch, setCustSearch] = useState('')
  const pending = useRef<Promise<string | null> | null>(null)
  const idRef = useRef<string | null>(docId)
  const productInputs = useRef(new Map<string, HTMLInputElement>())
  const focusNext = useRef<string | null>(null)

  const currentId = docId ?? createdId
  const status = doc?.status ?? 'draft'
  const editable = canCreate && status === 'draft'
  const dirty = version !== savedVersion
  const adminOnly = ADMIN_ONLY_TYPES.includes(header.docType)
  const isCredit = header.docType === 'credit_note'

  const companyId = header.companyId
  const gstins = useApiView('gstins', { eq: { company_id: companyId }, order: 'gstin', enabled: Boolean(companyId) })
  const gstinList = rowsOf(gstins).filter((g) => g.status !== 'inactive' || g.id === header.gstinId)
  const gstinId = header.gstinId || (gstinList.find((g) => g.is_principal) ?? gstinList[0])?.id || ''
  const customers = useApiView('customers', { eq: { company_id: companyId }, order: 'name', limit: 1000, enabled: Boolean(companyId) })
  const custList = rowsOf(customers)
  const customer = custList.find((c) => c.id === header.partyId)
  const invoicesForCredit = useApiView('sales_documents', {
    eq: { party_id: header.partyId, status: 'posted', doc_type: 'sales_invoice', company_id: companyId },
    order: 'doc_date',
    ascending: false,
    limit: 100,
    enabled: isCredit && Boolean(header.partyId),
  })
  const companyProducts = products.filter((p) => p.status === 'active' && (!p.company_ids?.length || p.company_ids.includes(companyId)))

  function touch() {
    setVersion((v) => v + 1)
  }
  function setH<K extends keyof HeaderDraft>(k: K, v: HeaderDraft[K]) {
    setHeader((h) => ({ ...h, [k]: v }))
    touch()
  }
  function setLine(key: string, patch: Partial<LineDraft>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
    touch()
  }
  function onProductText(key: string, text: string) {
    const norm = text.trim().toLowerCase()
    const match = companyProducts.find((p) => productLabel(p).toLowerCase() === norm || p.code.toLowerCase() === norm)
    setLine(key, { productText: text, productId: match?.id ?? '' })
  }
  function addLineAfter(key: string | null) {
    const nl = newLine()
    focusNext.current = nl.key
    setLines((ls) => {
      const i = key ? ls.findIndex((l) => l.key === key) : ls.length - 1
      const copy = [...ls]
      copy.splice(i + 1, 0, nl)
      return copy
    })
  }
  function removeLine(key: string) {
    setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : [newLine()]))
    touch()
  }
  function onLineKey(e: KeyboardEvent<HTMLInputElement>, key: string) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const i = lines.findIndex((l) => l.key === key)
    const next = lines[i + 1]
    if (next) productInputs.current.get(next.key)?.focus()
    else addLineAfter(key)
  }
  function registerInput(key: string, el: HTMLInputElement | null) {
    if (el) {
      productInputs.current.set(key, el)
      if (focusNext.current === key) {
        focusNext.current = null
        el.focus()
      }
    } else productInputs.current.delete(key)
  }

  // Lines the server can price: a product and a valid quantity; rate and discount in rupees with paise.
  const validLines = lines.filter((l) => l.productId && QTY_RE.test(l.qty.trim()) && Number(l.qty) > 0 && (!l.rate.trim() || AMT_RE.test(l.rate.trim())) && (!l.discount.trim() || AMT_RE.test(l.discount.trim())))
  const serverLines = validLines.map((l) => ({ product_id: l.productId, qty: l.qty.trim(), rate: l.rate.trim() || '0', discount: l.discount.trim() || '0' }))
  const previewInput =
    editable && gstinId && header.partyId && serverLines.length
      ? JSON.stringify({
          keys: validLines.map((l) => l.key),
          args: { p_gstin_id: gstinId, p_party_id: header.partyId, p_place_of_supply: header.pos || null, p_date: header.docDate, p_without_gst: adminOnly, p_lines: serverLines },
        })
      : ''
  const debounced = useDebounced(previewInput, 350)
  const preview = useQuery<PreviewOut, RpcError>({
    queryKey: ['api', 'preview_tax', debounced],
    enabled: Boolean(debounced),
    retry: false,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { keys, args } = JSON.parse(debounced) as { keys: string[]; args: Record<string, unknown> }
      const result = await callApi<TaxPreview>('preview_tax', args, { idempotent: false })
      return { keys, result }
    },
  })
  const pv = preview.data && debounced ? preview.data : null
  const pvByKey = new Map<string, TaxPreview['lines'][number]>()
  if (pv) pv.keys.forEach((k, i) => pv.result.lines[i] && pvByKey.set(k, pv.result.lines[i]))

  function validate(): Record<string, string> {
    const e: Record<string, string> = {}
    if (!companyId) e.company = t('invoice.err.company')
    if (!gstinId) e.gstin = t('invoice.err.gstin')
    if (!header.partyId) e.party = t('invoice.err.party')
    if (!header.docDate) e.date = t('invoice.err.date')
    if (serverLines.length === 0) e.lines = t('invoice.err.lines')
    if (lines.some((l) => (l.productText.trim() && !l.productId) || (l.qty.trim() && !QTY_RE.test(l.qty.trim())) || (l.rate.trim() && !AMT_RE.test(l.rate.trim())) || (l.discount.trim() && !AMT_RE.test(l.discount.trim()))))
      e.lines = t('invoice.err.lineFormat')
    if (isCredit && !header.againstId) e.against = t('invoice.err.against')
    if (isCredit && header.reason.trim().length < 5) e.reason = t('invoice.err.reason')
    if (adminOnly && !header.lawfulReason) e.lawful = t('invoice.err.lawful')
    return e
  }

  function payload(id: string | null) {
    return {
      ...(id ? { id } : {}),
      company_id: companyId,
      gstin_id: gstinId,
      doc_type: header.docType,
      doc_date: header.docDate,
      party_id: header.partyId,
      place_of_supply: header.pos || null,
      lawful_reason: adminOnly ? header.lawfulReason || null : null,
      against_id: isCredit ? header.againstId || null : null,
      reason: isCredit ? header.reason.trim() : null,
      notes: header.notes.trim() || null,
      lines: serverLines,
    }
  }

  /** Save the draft (create or replace). Saves never overlap; returns the document id or null on refusal. */
  async function saveNow(): Promise<string | null> {
    while (pending.current) await pending.current
    const v = version
    const body = payload(idRef.current)
    setSaving(true)
    const run = callApi<{ id: string; totals: { total: number | string } }>('save_sales_draft', { p: body })
      .then(async (res) => {
        const isNew = !idRef.current
        idRef.current = res.id
        setSavedVersion(v)
        setSavedAt(new Date())
        setSaveError(null)
        setLastTotal(res.totals?.total ?? null)
        if (isNew) {
          setCreatedId(res.id)
          onCreated(res.id)
        }
        await Promise.all([qc.invalidateQueries({ queryKey: ['api', 'sales_documents'] }), qc.invalidateQueries({ queryKey: ['api', 'sales_document_lines'] })])
        return res.id
      })
      .catch((err: RpcError) => {
        setSaveError(err)
        return null
      })
      .finally(() => {
        pending.current = null
        setSaving(false)
      })
    pending.current = run
    return run
  }

  async function onSave() {
    const e = validate()
    setFormErrors(e)
    if (Object.keys(e).length) return
    await saveNow()
  }

  const post = useApiMutation<{ p_document_id: string }, { doc_no: string }>('post_sales_document', [
    ['api', 'sales_documents'],
    ['api', 'sales_document_lines'],
    ['api', 'msg_outbox'],
    ['api', 'receivables'],
  ])
  async function startPost() {
    post.reset()
    const e = validate()
    setFormErrors(e)
    if (Object.keys(e).length) return
    const id = dirty || !currentId ? await saveNow() : currentId
    if (!id) return
    setConfirmPost(true)
  }
  function confirmPosting() {
    const id = idRef.current ?? currentId
    if (!id) return
    post.mutate({ p_document_id: id }, { onSettled: () => setConfirmPost(false) })
  }

  const cancel = useApiMutation<{ p_document_id: string; p_reason: string }, { deleted_draft?: boolean }>('cancel_sales_document', [
    ['api', 'sales_documents'],
    ['api', 'msg_outbox'],
    ['api', 'receivables'],
  ])
  function submitCancel() {
    const id = idRef.current ?? currentId
    if (!id) return
    if (cancelReason.trim().length < 5) {
      setCancelErr(t('invoice.err.reason'))
      return
    }
    setCancelErr(undefined)
    const wasDraft = status === 'draft'
    cancel.mutate(
      { p_document_id: id, p_reason: cancelReason.trim() },
      {
        onSuccess: () => {
          setCancelOpen(false)
          if (wasDraft) onNew()
        },
      },
    )
  }

  // Autosave: once the draft exists, every change is saved after a short pause.
  useAutosave(editable && Boolean(currentId) && dirty && !saving && Object.keys(validate()).length === 0, version, saveNow)

  const totalsEditable = pv ? pv.result : null
  const totals = editable
    ? totalsEditable
      ? { ...totalsEditable }
      : null
    : doc
      ? { taxable: doc.taxable, cgst: doc.cgst, sgst: doc.sgst, igst: doc.igst, round_off: doc.round_off, total: doc.total, amount_in_words: doc.amount_in_words }
      : null
  const intra = editable ? (pv ? pv.result.intra_state : null) : doc ? doc.our_state === doc.place_of_supply : null
  const postTotal = pv?.result.total ?? lastTotal ?? doc?.total ?? null

  const custOptions = custList
    .filter((c) => {
      const q = custSearch.trim().toLowerCase()
      if (!q || c.id === header.partyId) return true
      return c.name.toLowerCase().includes(q) || (c.gstin ?? '').toLowerCase().includes(q) || (c.trade_name ?? '').toLowerCase().includes(q)
    })
    .map((c) => ({ value: c.id, label: c.gstin ? `${c.name} · ${c.gstin}` : c.name }))
  if (!editable && doc && !custList.some((c) => c.id === doc.party_id)) custOptions.push({ value: doc.party_id, label: doc.party_name })

  const typeOptions = DOC_TYPES.filter((d) => isAdmin || !ADMIN_ONLY_TYPES.includes(d) || d === header.docType).map((d) => ({ value: d, label: t(`invoice.types.${d}`) }))
  const stateChip =
    status === 'posted' ? <StatusChip status="posted" /> : status === 'cancelled' ? <Chip tone="danger" icon="ban">{t('invoice.state.cancelled')}</Chip> : <StatusChip status="draft" />

  return (
    <>
      <PageHeader
        title={t(`invoice.types.${header.docType}`)}
        subtitle={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {doc?.doc_no ? (
              <span className="mono" data-testid="doc-no" style={{ fontSize: 16, color: 'var(--sf-text)' }}>
                {doc.doc_no}
              </span>
            ) : (
              <span data-testid="doc-no" style={{ fontSize: 13 }}>
                {t('invoice.notNumbered')}
              </span>
            )}
            <span data-testid="doc-state">{stateChip}</span>
            {editable ? (
              <span role="status" aria-live="polite" style={{ fontSize: 12.5 }}>
                {saving ? t('invoice.saving') : dirty && currentId ? t('invoice.unsaved') : savedAt ? t('invoice.savedAt', { time: formatTime(savedAt) }) : currentId ? t('invoice.savedDraft') : t('invoice.notSaved')}
              </span>
            ) : null}
          </span>
        }
        actions={
        <>
          <Button onClick={() => onNew()}>{t('invoice.actions.new')}</Button>
          {currentId ? (
            <Button
              onClick={async () => {
                if (editable && dirty) {
                  const id = await saveNow()
                  if (!id) return
                }
                onPreview()
              }}
            >
              {t('invoice.actions.preview')}
            </Button>
          ) : null}
          {status === 'posted' && doc?.doc_type === 'sales_invoice' && canCreate ? (
            <Button onClick={() => onNew({ docType: 'credit_note', companyId, gstinId: doc.gstin_id, partyId: doc.party_id, againstId: doc.id })}>{t('invoice.actions.creditNote')}</Button>
          ) : null}
          {canCancel && currentId && status !== 'cancelled' ? (
            <Button
              variant="danger"
              onClick={() => {
                cancel.reset()
                setCancelReason('')
                setCancelErr(undefined)
                setCancelOpen(true)
              }}
            >
              {status === 'draft' ? t('invoice.actions.deleteDraft') : t('invoice.actions.cancel')}
            </Button>
          ) : null}
          {editable ? (
            <>
              <Button onClick={() => void onSave()} busy={saving}>
                {t('invoice.actions.save')}
              </Button>
              <Button variant="primary" onClick={() => void startPost()} disabled={saving}>
                {t('invoice.actions.post')}
              </Button>
            </>
          ) : null}
        </>
        }
      />

      {!canCreate && status === 'draft' ? <p className="muted">{t('invoice.noRight')}</p> : null}
      <RuleErrorBox error={saveError} />
      <RuleErrorBox error={post.error} />
      <RuleErrorBox error={cancel.error && !cancelOpen ? cancel.error : null} />
      {post.isSuccess && post.data?.doc_no ? (
        <p role="status" style={{ margin: '0 0 12px', color: 'var(--sf-success-ink)' }}>
          {t('invoice.postedAs', { no: post.data.doc_no })}
        </p>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(280px, 340px)', gap: 16, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <Card>
            <FieldGrid cols={3}>
              <SelectField
                label={t('common.company')}
                value={companyId}
                disabled={!editable || Boolean(currentId)}
                error={formErrors.company}
                options={companies.map((c) => ({ value: c.id, label: c.short_name || c.name }))}
                onChange={(e) => {
                  setHeader((h) => ({ ...h, companyId: e.target.value, gstinId: '', partyId: '', againstId: '' }))
                  touch()
                  onCompanyChange(e.target.value)
                }}
              />
              <SelectField
                label={t('invoice.header.gstin')}
                value={gstinId}
                disabled={!editable}
                error={formErrors.gstin ?? (companyId && !gstins.isLoading && gstinList.length === 0 ? t('invoice.err.noGstin') : undefined)}
                placeholder={gstinList.length ? undefined : t('invoice.header.noGstin')}
                options={gstinList.map((g) => ({ value: g.id, label: `${g.gstin} · ${g.state_code ?? ''}` }))}
                onChange={(e) => setH('gstinId', e.target.value)}
              />
              <SelectField
                label={t('invoice.header.docType')}
                value={header.docType}
                disabled={!editable}
                options={typeOptions}
                onChange={(e) => {
                  const v = e.target.value as DocType
                  setHeader((h) => ({ ...h, docType: v, lawfulReason: v === 'delivery_challan' ? 'challan_not_sold' : ADMIN_ONLY_TYPES.includes(v) ? h.lawfulReason : '' }))
                  touch()
                }}
              />
              <Field label={t('invoice.header.date')} type="date" value={header.docDate} disabled={!editable} error={formErrors.date} onChange={(e) => setH('docDate', e.target.value)} />
              {editable ? <Field label={t('invoice.header.findCustomer')} type="search" value={custSearch} onChange={(e) => setCustSearch(e.target.value)} placeholder={t('invoice.header.findCustomerHint')} /> : null}
              <SelectField
                label={t('invoice.header.customer')}
                value={header.partyId}
                disabled={!editable}
                error={formErrors.party}
                placeholder={customers.isLoading ? t('common.loading') : custList.length ? t('invoice.header.chooseCustomer') : t('invoice.header.noCustomers')}
                options={custOptions}
                help={customer && customer.kyc_status !== 'verified' ? t('invoice.header.kycPending') : undefined}
                onChange={(e) => {
                  setHeader((h) => ({ ...h, partyId: e.target.value, againstId: '' }))
                  touch()
                }}
              />
              <Field label={t('invoice.header.customerGstin')} value={customer?.gstin ?? doc?.party_gstin ?? (header.partyId ? t('invoice.header.unregistered') : '')} readOnly className="mono" />
              <SelectField
                label={t('invoice.header.pos')}
                value={header.pos}
                disabled={!editable}
                options={Object.entries(GST_STATES).map(([code, name]) => ({ value: code, label: `${code} · ${name}` }))}
                placeholder={t('invoice.header.posDefault')}
                help={t('invoice.header.posHelp')}
                onChange={(e) => setH('pos', e.target.value)}
              />
              {adminOnly ? (
                <SelectField
                  label={t('invoice.header.lawfulReason')}
                  value={header.lawfulReason}
                  disabled={!editable}
                  error={formErrors.lawful}
                  placeholder={t('invoice.header.chooseReason')}
                  options={LAWFUL_REASONS.filter((r) => (header.docType === 'delivery_challan' ? r === 'challan_not_sold' : r !== 'challan_not_sold')).map((r) => ({ value: r, label: t(`invoice.reasons.${r}`) }))}
                  help={t('invoice.header.lawfulHelp')}
                  onChange={(e) => setH('lawfulReason', e.target.value)}
                />
              ) : null}
              {isCredit ? (
                <>
                  <SelectField
                    label={t('invoice.header.against')}
                    value={header.againstId}
                    disabled={!editable}
                    error={formErrors.against}
                    placeholder={header.partyId ? t('invoice.header.chooseInvoice') : t('invoice.header.customerFirst')}
                    options={rowsOf(invoicesForCredit).map((d) => ({ value: d.id, label: `${d.doc_no ?? ''} · ₹${formatIndian(d.total)}` }))}
                    onChange={(e) => setH('againstId', e.target.value)}
                  />
                  <Field label={t('invoice.header.creditReason')} value={header.reason} disabled={!editable} error={formErrors.reason} onChange={(e) => setH('reason', e.target.value)} />
                </>
              ) : null}
            </FieldGrid>
          </Card>

          <Card pad={false}>
            <div className="sf-card__head sf-card__pad" style={{ paddingBottom: 8, alignItems: 'center' }}>
              <h2 className="sf-card__title">{t('invoice.lines.title')}</h2>
              <span className="muted" style={{ fontSize: 12.5 }}>
                {t('invoice.lines.pricesExclude')}
              </span>
            </div>
            {editable ? (
              <div className="sf-table-wrap" role="region" aria-label={t('invoice.lines.title')} tabIndex={0}>
                <table className="sf-table" style={{ minWidth: 760 }}>
                  <caption className="sr-only">{t('invoice.lines.caption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col" style={{ width: 32 }}>#</th>
                      <th scope="col">{t('invoice.lines.item')}</th>
                      <th scope="col">{t('invoice.lines.hsn')}</th>
                      <th scope="col" className="r" style={{ width: 80 }}>{t('invoice.lines.qty')}</th>
                      <th scope="col" className="r" style={{ width: 96 }}>{t('invoice.lines.rate')}</th>
                      <th scope="col" className="r" style={{ width: 88 }}>{t('invoice.lines.discount')}</th>
                      <th scope="col" className="r">{t('invoice.lines.taxable')}</th>
                      <th scope="col" className="r">{t('invoice.lines.gst')}</th>
                      <th scope="col" className="r">{t('invoice.lines.total')}</th>
                      <th scope="col"><span className="sr-only">{t('invoice.lines.actions')}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => {
                      const p = pvByKey.get(l.key)
                      const n = i + 1
                      const productMissing = Boolean(l.productText.trim() && !l.productId)
                      return (
                        <tr key={l.key} data-testid={`line-${n}`}>
                          <td>{n}</td>
                          <td style={{ minWidth: 200 }}>
                            <input
                              ref={(el) => registerInput(l.key, el)}
                              className="sf-input"
                              style={cellInput}
                              list={listId}
                              aria-label={t('invoice.lines.productAria', { n })}
                              aria-invalid={productMissing || undefined}
                              value={l.productText}
                              placeholder={t('invoice.lines.productHint')}
                              onChange={(e) => onProductText(l.key, e.target.value)}
                              onKeyDown={(e) => onLineKey(e, l.key)}
                            />
                            <span className="muted" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>
                              {productMissing ? t('invoice.lines.noSuchProduct') : p ? `${p.description} · ${p.uom}` : ' '}
                            </span>
                          </td>
                          <td className="mono">{p?.hsn_code ?? '—'}</td>
                          <td className="r">
                            <input className="sf-input mono" style={{ ...cellInput, textAlign: 'right' }} inputMode="decimal" aria-label={t('invoice.lines.qtyAria', { n })} value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} onKeyDown={(e) => onLineKey(e, l.key)} />
                          </td>
                          <td className="r">
                            <input className="sf-input mono" style={{ ...cellInput, textAlign: 'right' }} inputMode="decimal" aria-label={t('invoice.lines.rateAria', { n })} value={l.rate} onChange={(e) => setLine(l.key, { rate: e.target.value })} onKeyDown={(e) => onLineKey(e, l.key)} />
                          </td>
                          <td className="r">
                            <input className="sf-input mono" style={{ ...cellInput, textAlign: 'right' }} inputMode="decimal" aria-label={t('invoice.lines.discountAria', { n })} value={l.discount} onChange={(e) => setLine(l.key, { discount: e.target.value })} onKeyDown={(e) => onLineKey(e, l.key)} />
                          </td>
                          <td className="r">{p ? <Amount value={p.taxable} /> : '—'}</td>
                          <td className="r mono">{p ? `${formatIndian(p.gst_rate, 2)}%` : '—'}</td>
                          <td className="r">{p ? <Amount value={p.total} /> : '—'}</td>
                          <td>
                            <Button size="sm" variant="link" aria-label={t('invoice.lines.removeAria', { n })} onClick={() => removeLine(l.key)}>
                              <Icon name="cross" size={14} />
                            </Button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                <datalist id={listId}>
                  {companyProducts.map((p) => (
                    <option key={p.id} value={productLabel(p)} />
                  ))}
                </datalist>
              </div>
            ) : (
              <div className="sf-table-wrap" role="region" aria-label={t('invoice.lines.title')} tabIndex={0}>
                <table className="sf-table" style={{ minWidth: 760 }}>
                  <caption className="sr-only">{t('invoice.lines.caption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">{t('invoice.lines.item')}</th>
                      <th scope="col">{t('invoice.lines.hsn')}</th>
                      <th scope="col" className="r">{t('invoice.lines.qty')}</th>
                      <th scope="col" className="r">{t('invoice.lines.rate')}</th>
                      <th scope="col" className="r">{t('invoice.lines.discount')}</th>
                      <th scope="col" className="r">{t('invoice.lines.taxable')}</th>
                      <th scope="col" className="r">{t('invoice.lines.gst')}</th>
                      <th scope="col" className="r">{t('invoice.lines.total')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {docLines.map((l) => (
                      <tr key={l.id}>
                        <td>{l.line_no}</td>
                        <td>{l.description}</td>
                        <td className="mono">{l.hsn_code ?? '—'}</td>
                        <td className="r mono">
                          {formatIndian(l.qty, 3)} {l.uom}
                        </td>
                        <td className="r"><Amount value={l.rate} /></td>
                        <td className="r"><Amount value={l.discount} /></td>
                        <td className="r"><Amount value={l.taxable} /></td>
                        <td className="r mono">{formatIndian(l.gst_rate, 2)}%</td>
                        <td className="r"><Amount value={l.total} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="sf-card__pad" style={{ display: 'flex', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {editable ? (
                  <Button onClick={() => addLineAfter(null)}>
                    <Icon name="plus" size={14} /> {t('invoice.lines.add')} <kbd className="sf-kbd">Enter</kbd>
                  </Button>
                ) : null}
                {formErrors.lines ? (
                  <span className="sf-field__msg" style={{ color: 'var(--sf-danger-ink)' }}>
                    {formErrors.lines}
                  </span>
                ) : null}
                {editable ? <span className="muted" style={{ fontSize: 12.5, maxWidth: 360 }}>{t('invoice.lines.keyboardHelp')}</span> : null}
              </div>
              <TotalsBlock totals={totals} intra={intra} />
            </div>
          </Card>

          {editable || header.notes ? (
            <Card>
              <TextAreaField label={t('invoice.header.notes')} value={header.notes} disabled={!editable} onChange={(e) => setH('notes', e.target.value)} />
            </Card>
          ) : null}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card title={t('invoice.tax.title')}>
            <TaxPanel
              withoutGst={editable ? adminOnly : doc?.tax_class === 'without_gst'}
              lawfulReason={editable ? header.lawfulReason || null : (doc?.lawful_reason ?? null)}
              ourState={editable ? (pv?.result.our_state ?? null) : (doc?.our_state ?? null)}
              pos={editable ? (pv?.result.place_of_supply ?? null) : (doc?.place_of_supply ?? null)}
              intra={intra}
              lines={editable ? (pv?.result.lines ?? []) : docLines}
              waiting={preview.isFetching}
            />
            <div style={{ marginTop: 12 }}>
              <RuleErrorBox error={editable && debounced ? preview.error : null} />
            </div>
          </Card>
          <Card title={t('invoice.wa.title')}>
            <WhatsAppStatus docId={status === 'draft' ? null : currentId} />
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={confirmPost}
        onOpenChange={(o) => !post.isPending && setConfirmPost(o)}
        title={t('invoice.confirm.title', { type: t(`invoice.types.${header.docType}`) })}
        effect={t(header.docType === 'delivery_challan' ? 'invoice.confirm.effectChallan' : 'invoice.confirm.effect', {
          type: t(`invoice.types.${header.docType}`),
          amount: postTotal !== null ? `₹${formatIndian(postTotal)}` : '—',
          customer: customer?.name ?? doc?.party_name ?? '',
        })}
        confirmLabel={t('invoice.actions.post')}
        busy={post.isPending}
        onConfirm={confirmPosting}
      />

      <FormDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={status === 'draft' ? t('invoice.cancelDlg.titleDraft') : t('invoice.cancelDlg.title')}
        description={status === 'draft' ? t('invoice.cancelDlg.effectDraft') : t('invoice.cancelDlg.effect')}
        submitLabel={status === 'draft' ? t('invoice.actions.deleteDraft') : t('invoice.actions.cancel')}
        busy={cancel.isPending}
        onSubmit={submitCancel}
        error={<RuleErrorBox error={cancel.error} />}
      >
        <TextAreaField label={t('common.reason')} value={cancelReason} error={cancelErr} onChange={(e) => setCancelReason(e.target.value)} />
      </FormDialog>
    </>
  )
}

/** Save after a pause when `when` holds; the timer restarts on every change (version). */
function useAutosave(when: boolean, version: number, save: () => Promise<string | null>) {
  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  })
  useEffect(() => {
    if (!when) return
    const id = setTimeout(() => void saveRef.current(), 1500)
    return () => clearTimeout(id)
  }, [when, version])
}

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { cleanAmount } from '@/features/accounts/cash-book/money'
import { formatDate } from '@/shared/format'
import { Amount, Button, Card, Checkbox, Chip, DataTable, EmptyState, Field, FieldGrid, FormDialog, SelectField, type Column } from '@/ui'
import { DocStatus, PurchaseErrorBox, useCompanyPlaces, useCompanySuppliers, usePurchaseRights } from '../common/purchase'
import { ORDER_REFRESH } from './OrderEditor'

type Rfq = ViewRow<'rfqs'>
type Quote = ViewRow<'quotations'>
type Cmp = ViewRow<'quotation_compare'>
const RFQ_REFRESH = [['api', 'rfqs'], ['api', 'rfq_lines'], ['api', 'quotations'], ['api', 'quotation_compare'], ...ORDER_REFRESH]

/**
 * Supplier quotes: an approved request becomes a request for quotation to chosen suppliers (api.create_rfq copies its
 * lines), each supplier's rates are recorded (api.record_quotation; MSME terms over 45 days are refused), compared side
 * by side (api.quotation_compare marks the cheapest net rate and shows the last rate paid), and choosing one makes the
 * draft purchase order (api.select_quotation).
 */
export function Quotes({ companyId, requestId, rfqId, setRfq, onOrder }: { companyId: string; requestId: string | null; rfqId: string | null; setRfq: (id: string | null) => void; onOrder: (id: string) => void }) {
  const { t } = useTranslation()
  const rights = usePurchaseRights()
  const rq = useApiView('rfqs', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 200 })
  const rfqs = rowsOf(rq)
  const selected = rfqs.find((r) => r.id === rfqId) ?? null
  const columns: Column<Rfq>[] = [
    { key: 'no', header: t('purchaseOrders.rfq.cols.no'), render: (r) => <span className="mono">{r.doc_no}</span> },
    { key: 'date', header: t('purchaseOrders.rfq.cols.date'), render: (r) => <span className="mono">{formatDate(r.rfq_date)}</span> },
    { key: 'req', header: t('purchaseOrders.rfq.cols.request'), render: (r) => <span className="mono">{r.request_no ?? '—'}</span> },
    { key: 'due', header: t('purchaseOrders.rfq.cols.due'), render: (r) => (r.due_date ? <span className="mono">{formatDate(r.due_date)}</span> : '—') },
    { key: 'sup', header: t('purchaseOrders.rfq.cols.suppliers'), align: 'right', render: (r) => r.suppliers ?? 0 },
    { key: 'quotes', header: t('purchaseOrders.rfq.cols.quotes'), align: 'right', render: (r) => r.quotations ?? 0 },
    { key: 'status', header: t('common.status'), render: (r) => <DocStatus status={r.status} /> },
    {
      key: 'act',
      header: <span className="sr-only">{t('purchaseOrders.list.actions')}</span>,
      render: (r) => (
        <Button size="sm" variant="link" aria-label={t('purchaseOrders.rfq.openAria', { no: r.doc_no })} onClick={() => setRfq(r.id)}>
          {t('purchaseOrders.list.open')}
        </Button>
      ),
    },
  ]
  return (
    <>
      {rights.create ? <NewRfq companyId={companyId} requestId={requestId} onCreated={setRfq} /> : null}
      {selected ? <RfqDetail key={selected.id} rfq={selected} companyId={companyId} onClose={() => setRfq(null)} onOrder={onOrder} /> : null}
      <TableCard title={t('purchaseOrders.rfq.listTitle')}>
        <DataTable caption={t('purchaseOrders.rfq.listTitle')} columns={columns} rows={rfqs} rowKey={(r) => r.id} loading={rq.isLoading} minWidth={820} empty={<EmptyState title={t('purchaseOrders.rfq.empty')} body={t('purchaseOrders.rfq.emptyBody')} />} />
      </TableCard>
    </>
  )
}

function NewRfq({ companyId, requestId, onCreated }: { companyId: string; requestId: string | null; onCreated: (id: string) => void }) {
  const { t } = useTranslation()
  const approved = rowsOf(useApiView('purchase_requests', { eq: { company_id: companyId, status: 'approved' }, order: 'created_at', ascending: false, limit: 200 }))
  const suppliers = useCompanySuppliers(companyId).list
  const [request, setRequest] = useState(requestId ?? '')
  const [due, setDue] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [errs, setErrs] = useState<Record<string, string>>({})
  const create = useApiMutation<{ p: Record<string, unknown> }, { id: string; doc_no: string; lines: number }>('create_rfq', RFQ_REFRESH)
  const req = request || approved[0]?.id || ''

  if (approved.length === 0) {
    return (
      <Card title={t('purchaseOrders.rfq.newTitle')}>
        <p className="muted" style={{ margin: 0 }}>
          {t('purchaseOrders.rfq.noApproved')}
        </p>
      </Card>
    )
  }
  return (
    <Card title={t('purchaseOrders.rfq.newTitle')}>
      <form
        noValidate
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault()
          const er: Record<string, string> = {}
          if (!req) er.request = t('purchaseOrders.rfq.err.request')
          if (picked.length === 0) er.suppliers = t('purchaseOrders.rfq.err.suppliers')
          setErrs(er)
          if (Object.keys(er).length) return
          create.mutate({ p: { company_id: companyId, request_id: req, due_date: due || null, supplier_ids: picked, lines: [] } }, { onSuccess: (res) => onCreated(res.id) })
        }}
      >
        <FieldGrid cols={2}>
          <SelectField label={t('purchaseOrders.rfq.request')} value={req} error={errs.request} options={approved.map((r) => ({ value: r.id, label: `${r.doc_no} · ${r.department}` }))} onChange={(e) => setRequest(e.target.value)} />
          <Field type="date" label={t('purchaseOrders.rfq.dueDate')} value={due} min={todayIst()} onChange={(e) => setDue(e.target.value)} />
        </FieldGrid>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="sf-field__label">{t('purchaseOrders.rfq.suppliers')}</legend>
          {suppliers.length === 0 ? (
            <p className="muted">{t('purchaseOrders.rfq.noSuppliers')}</p>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 6 }}>
              {suppliers.map((s) => (
                <Checkbox key={s.id} label={s.msme_category ? `${s.name} · MSME` : s.name} checked={picked.includes(s.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, s.id] : picked.filter((x) => x !== s.id))} />
              ))}
            </div>
          )}
          {errs.suppliers ? (
            <p className="sf-field__msg" role="alert" style={{ color: 'var(--sf-danger-ink)' }}>
              {errs.suppliers}
            </p>
          ) : null}
        </fieldset>
        <PurchaseErrorBox error={create.error as RpcError | null} />
        <div>
          <Button type="submit" variant="primary" busy={create.isPending}>
            {t('purchaseOrders.rfq.create')}
          </Button>
        </div>
      </form>
    </Card>
  )
}

function RfqDetail({ rfq, companyId, onClose, onOrder }: { rfq: Rfq; companyId: string; onClose: () => void; onOrder: (id: string) => void }) {
  const { t } = useTranslation()
  const rights = usePurchaseRights()
  const lines = rowsOf(useApiView('rfq_lines', { eq: { rfq_id: rfq.id }, order: 'line_no' }))
  const quotes = rowsOf(useApiView('quotations', { eq: { rfq_id: rfq.id }, order: 'created_at' }))
  const cmp = rowsOf(useApiView('quotation_compare', { eq: { rfq_id: rfq.id }, order: 'line_no' }))
  const [choosing, setChoosing] = useState<Quote | null>(null)
  const open = rfq.status === 'open'
  const cell = (lineId: string, quoteId: string): Cmp | undefined => cmp.find((c) => c.rfq_line_id === lineId && c.quotation_id === quoteId)
  const lastRate = (lineId: string) => cmp.find((c) => c.rfq_line_id === lineId)?.last_rate ?? null

  return (
    <Card
      title={t('purchaseOrders.rfq.detailTitle', { no: rfq.doc_no })}
      action={
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <DocStatus status={rfq.status} />
          <Button size="sm" variant="link" onClick={onClose}>
            {t('common.close')}
          </Button>
        </span>
      }
    >
      {open && rights.create ? <RecordQuote rfq={rfq} companyId={companyId} lines={lines} /> : null}
      <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>{t('purchaseOrders.rfq.compareTitle')}</h3>
      {quotes.length === 0 ? (
        <p className="muted">{t('purchaseOrders.rfq.noQuotes')}</p>
      ) : (
        <div className="sf-table-wrap" tabIndex={0} role="region" aria-label={t('purchaseOrders.rfq.compareTitle')}>
          <table className="sf-table" data-testid="quote-compare">
            <caption className="sr-only">{t('purchaseOrders.rfq.compareTitle')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('purchaseOrders.editor.col.item')}</th>
                <th scope="col" className="r">
                  {t('purchaseOrders.editor.col.qty')}
                </th>
                <th scope="col" className="r">
                  {t('purchaseOrders.rfq.lastRate')}
                </th>
                {quotes.map((q) => (
                  <th key={q.id} scope="col" className="r">
                    {q.party_name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.product_code ? `${l.product_code} · ${l.description}` : l.description}</td>
                  <td className="r mono">{`${l.qty} ${l.uom}`}</td>
                  <td className="r">
                    <Amount value={lastRate(l.id)} />
                  </td>
                  {quotes.map((q) => {
                    const c = cell(l.id, q.id)
                    return (
                      <td key={q.id} className="r">
                        {c ? (
                          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end' }}>
                            <Amount value={c.net_rate} />
                            {c.cheapest ? <Chip tone="success">{t('purchaseOrders.rfq.cheapest')}</Chip> : null}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>{t('purchaseOrders.rfq.taxableTotal')}</td>
                {quotes.map((q) => (
                  <td key={q.id} className="r">
                    <Amount value={q.taxable_total} />
                  </td>
                ))}
              </tr>
              <tr>
                <td colSpan={3}>{t('purchaseOrders.rfq.termsDelivery')}</td>
                {quotes.map((q) => (
                  <td key={q.id} className="r k">
                    {t('purchaseOrders.rfq.termsValue', { terms: q.terms_days ?? '—', delivery: q.delivery_days ?? '—' })}
                  </td>
                ))}
              </tr>
              <tr>
                <td colSpan={3} />
                {quotes.map((q) => (
                  <td key={q.id} className="r">
                    {q.status !== 'received' ? (
                      <DocStatus status={q.status} />
                    ) : open && rights.create ? (
                      <Button size="sm" variant="primary" aria-label={t('purchaseOrders.rfq.chooseAria', { name: q.party_name })} onClick={() => setChoosing(q)}>
                        {t('purchaseOrders.rfq.choose')}
                      </Button>
                    ) : null}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {choosing ? <ChooseDialog quote={choosing} companyId={companyId} onClose={() => setChoosing(null)} onOrder={onOrder} /> : null}
    </Card>
  )
}

function RecordQuote({ rfq, companyId, lines }: { rfq: Rfq; companyId: string; lines: ViewRow<'rfq_lines'>[] }) {
  const { t } = useTranslation()
  const suppliers = useCompanySuppliers(companyId).list
  const [party, setParty] = useState('')
  const [ref, setRef] = useState('')
  const [terms, setTerms] = useState('')
  const [delivery, setDelivery] = useState('')
  const [rates, setRates] = useState<Record<string, { rate: string; discount: string }>>({})
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [done, setDone] = useState<string | null>(null)
  const record = useApiMutation<{ p: Record<string, unknown> }, { id: string }>('record_quotation', RFQ_REFRESH)

  function submit() {
    setDone(null)
    const e: Record<string, string> = {}
    if (!party) e.party = t('purchaseOrders.rfq.err.party')
    if (terms.trim() && !/^\d{1,3}$/.test(terms.trim())) e.terms = t('purchaseOrders.err.terms')
    if (delivery.trim() && !/^\d{1,3}$/.test(delivery.trim())) e.delivery = t('purchaseOrders.err.terms')
    const out: Record<string, unknown>[] = []
    for (const l of lines) {
      const r = rates[l.id]
      const rate = cleanAmount(r?.rate ?? '')
      const discount = cleanAmount(r?.discount || '0')
      if (rate === null || discount === null) {
        e.lines = t('purchaseOrders.rfq.err.rate', { n: l.line_no })
        break
      }
      out.push({ rfq_line_id: l.id, rate, discount })
    }
    setErrs(e)
    if (Object.keys(e).length) return
    const name = suppliers.find((s) => s.id === party)?.name ?? ''
    record.mutate(
      { p: { rfq_id: rfq.id, party_id: party, quote_ref: ref.trim() || null, terms_days: terms.trim() || null, delivery_days: delivery.trim() || null, lines: out } },
      {
        onSuccess: () => {
          setDone(t('purchaseOrders.rfq.recorded', { name }))
          setParty('')
          setRef('')
          setTerms('')
          setDelivery('')
          setRates({})
        },
      },
    )
  }

  return (
    <form
      noValidate
      aria-label={t('purchaseOrders.rfq.recordTitle')}
      style={{ display: 'flex', flexDirection: 'column', gap: 12, border: '1px solid var(--sf-line-faint)', borderRadius: 8, padding: 12 }}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <strong>{t('purchaseOrders.rfq.recordTitle')}</strong>
      <FieldGrid cols={3}>
        <SelectField label={t('purchaseOrders.rfq.supplier')} value={party} error={errs.party} placeholder={t('purchaseOrders.editor.chooseSupplier')} options={suppliers.map((s) => ({ value: s.id, label: s.name }))} onChange={(e) => setParty(e.target.value)} />
        <Field label={t('purchaseOrders.rfq.quoteRef')} value={ref} onChange={(e) => setRef(e.target.value)} />
        <Field label={t('purchaseOrders.rfq.terms')} inputMode="numeric" value={terms} error={errs.terms} onChange={(e) => setTerms(e.target.value)} />
        <Field label={t('purchaseOrders.rfq.delivery')} inputMode="numeric" value={delivery} error={errs.delivery} onChange={(e) => setDelivery(e.target.value)} />
      </FieldGrid>
      <div className="sf-table-wrap" tabIndex={0} role="region" aria-label={t('purchaseOrders.rfq.recordTitle')}>
        <table className="sf-table">
          <caption className="sr-only">{t('purchaseOrders.rfq.recordTitle')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('purchaseOrders.editor.col.item')}</th>
              <th scope="col" className="r">
                {t('purchaseOrders.editor.col.qty')}
              </th>
              <th scope="col" className="r">
                {t('purchaseOrders.editor.col.rate')}
              </th>
              <th scope="col" className="r">
                {t('purchaseOrders.editor.col.discount')}
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <td>{l.product_code ? `${l.product_code} · ${l.description}` : l.description}</td>
                <td className="r mono">{`${l.qty} ${l.uom}`}</td>
                <td className="r">
                  <input className="sf-input mono" style={{ height: 34, width: 110, textAlign: 'right' }} inputMode="decimal" aria-label={t('purchaseOrders.rfq.rateAria', { n: l.line_no })} value={rates[l.id]?.rate ?? ''} onChange={(e) => setRates({ ...rates, [l.id]: { rate: e.target.value, discount: rates[l.id]?.discount ?? '' } })} />
                </td>
                <td className="r">
                  <input className="sf-input mono" style={{ height: 34, width: 90, textAlign: 'right' }} inputMode="decimal" aria-label={t('purchaseOrders.rfq.discountAria', { n: l.line_no })} value={rates[l.id]?.discount ?? ''} onChange={(e) => setRates({ ...rates, [l.id]: { rate: rates[l.id]?.rate ?? '', discount: e.target.value } })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {errs.lines ? (
        <p className="sf-field__msg" role="alert" style={{ color: 'var(--sf-danger-ink)', margin: 0 }}>
          {errs.lines}
        </p>
      ) : null}
      <PurchaseErrorBox error={record.error as RpcError | null} />
      {done ? (
        <p role="status" className="sf-alert" data-tone="success" style={{ margin: 0 }}>
          {done}
        </p>
      ) : null}
      <div>
        <Button type="submit" busy={record.isPending}>
          {t('purchaseOrders.rfq.record')}
        </Button>
      </div>
    </form>
  )
}

function ChooseDialog({ quote, companyId, onClose, onOrder }: { quote: Quote; companyId: string; onClose: () => void; onOrder: (id: string) => void }) {
  const { t } = useTranslation()
  const places = useCompanyPlaces(companyId).list
  const [place, setPlace] = useState('')
  const [delivery, setDelivery] = useState('')
  const choose = useApiMutation<{ p_quotation_id: string; p: Record<string, unknown> }, { quotation_id: string; order_id: string }>('select_quotation', RFQ_REFRESH)
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('purchaseOrders.rfq.chooseTitle', { name: quote.party_name })}
      description={t('purchaseOrders.rfq.chooseBody')}
      submitLabel={t('purchaseOrders.rfq.chooseSubmit')}
      busy={choose.isPending}
      error={<PurchaseErrorBox error={choose.error as RpcError | null} />}
      onSubmit={() =>
        choose.mutate(
          { p_quotation_id: quote.id, p: { place_id: place || null, delivery_date: delivery || null } },
          {
            onSuccess: (res) => {
              onClose()
              onOrder(res.order_id)
            },
          },
        )
      }
    >
      <SelectField label={t('purchaseOrders.editor.place')} value={place} placeholder={t('purchaseOrders.editor.noPlace')} options={places.map((p) => ({ value: p.id, label: `${p.name} · ${p.branch_name}` }))} onChange={(e) => setPlace(e.target.value)} />
      <Field type="date" label={t('purchaseOrders.editor.deliveryDate')} value={delivery} min={todayIst()} onChange={(e) => setDelivery(e.target.value)} />
    </FormDialog>
  )
}

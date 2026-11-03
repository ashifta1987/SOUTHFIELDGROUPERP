import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard, TWO_COLS } from '@/features/admin/import-data/layout'
import { formatDate } from '@/shared/format'
import { Amount, Button, Card, DataTable, EmptyState, Field, FieldGrid, KpiTiles, PageHeader, SelectField, Skeleton, Tabs, type Column } from '@/ui'
import { cleanQty, InventoryErrorBox, placeLabel, Qty, STOCK_REFRESH, useInventoryRights, useStockItems, useStockPlaces } from '../common/inventory'

type Scrap = ViewRow<'scrap_stock'>
type Entry = ViewRow<'regrind_entries'>
type Sale = ViewRow<'scrap_sales'>

/**
 * Scrap and regrind (`Scrap`): every kilo from the machines is weighed in as scrap stock by type (api.record_regrind
 * kind scrap_in) or taken back into production as regrind (kind regrind_reuse); scrap is sold only on a GST invoice
 * made on the sales screen, and the stock goes out once against that posted invoice (api.post_scrap_sale). Figures are
 * the database's: scrap stock from api.scrap_stock, entries from api.regrind_entries, sales from api.scrap_sales.
 */
export function ScrapPage() {
  const { t } = useTranslation()
  const rights = useInventoryRights()
  const choice = useCompanyChoice()
  const companyId = choice.companyId
  return (
    <>
      <PageHeader title={t('scrap.title')} subtitle={t('scrap.subtitle')} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <CompanyPicker list={choice.list} value={companyId} onChange={choice.choose} />
      </div>
      {choice.isLoading ? (
        <Card>
          <Skeleton height={80} />
        </Card>
      ) : !companyId ? (
        <Card>
          <EmptyState title={t('inventoryCommon.noCompany')} />
        </Card>
      ) : (
        <ScrapBody key={companyId} companyId={companyId} canCreate={rights.create} readOnly={rights.readOnly} costs={rights.costs} />
      )}
    </>
  )
}

function monthStart(): string {
  return `${todayIst().slice(0, 8)}01`
}

function ScrapBody({ companyId, canCreate, readOnly, costs }: { companyId: string; canCreate: boolean; readOnly: boolean; costs: boolean }) {
  const { t } = useTranslation()
  const sq = useApiView('scrap_stock', { eq: { company_id: companyId }, order: 'product_name', limit: 500 })
  const eq = useApiView('regrind_entries', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 300 })
  const salesQ = useApiView('scrap_sales', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 300 })
  const scrap = rowsOf(sq)
  const entries = rowsOf(eq)
  const sales = rowsOf(salesQ)
  const ms = monthStart()
  const month = entries.filter((e) => e.entry_date >= ms)
  const monthSales = sales.filter((s) => s.doc_date >= ms)
  const sum = (xs: (number | null)[]) => xs.reduce<number>((a, b) => a + Number(b ?? 0), 0)

  const stockCols: Column<Scrap>[] = [
    { key: 'type', header: t('scrap.col.type'), render: (r) => <span><strong>{r.product_name}</strong> <span className="k mono">{r.product_code}</span></span> },
    { key: 'group', header: t('scrap.col.group'), render: (r) => r.group_name ?? '—' },
    { key: 'qty', header: t('scrap.col.inStock'), align: 'right', render: (r) => <Qty value={r.total} uom={r.uom} /> },
    { key: 'rate', header: t('scrap.col.lastRate'), align: 'right', render: (r) => <Amount value={r.last_sold_rate} /> },
    ...(costs ? [{ key: 'value', header: t('scrap.col.value'), align: 'right' as const, render: (r: Scrap) => <Amount value={r.stock_value} /> }] : []),
  ]
  const entryCols: Column<Entry>[] = [
    { key: 'date', header: t('scrap.col.date'), render: (r) => <span className="mono">{formatDate(r.entry_date)}</span> },
    { key: 'kind', header: t('scrap.col.kind'), render: (r) => t(`scrap.kinds.${r.kind}`, { defaultValue: r.kind }) },
    { key: 'item', header: t('scrap.col.type'), render: (r) => r.product_name },
    { key: 'from', header: t('scrap.col.from'), render: (r) => [r.source_product_name, r.machine, r.mould, r.shift].filter(Boolean).join(' · ') || '—' },
    { key: 'place', header: t('scrap.col.place'), render: (r) => r.place_name },
    { key: 'qty', header: t('scrap.col.qty'), align: 'right', render: (r) => <Qty value={r.kind === 'regrind_reuse' ? -Number(r.qty) : r.qty} signed /> },
    { key: 'by', header: t('scrap.col.by'), render: (r) => r.recorded_by_name ?? '—' },
  ]
  const saleCols: Column<Sale>[] = [
    { key: 'date', header: t('scrap.col.date'), render: (r) => <span className="mono">{formatDate(r.doc_date)}</span> },
    { key: 'buyer', header: t('scrap.col.buyer'), render: (r) => r.buyer_name ?? '—' },
    { key: 'qty', header: t('scrap.col.weighbridge'), align: 'right', render: (r) => <Qty value={r.qty} /> },
    { key: 'rate', header: t('scrap.col.rate'), align: 'right', render: (r) => <Amount value={r.rate_per_unit} /> },
    { key: 'amount', header: t('scrap.col.amount'), align: 'right', render: (r) => <Amount value={r.taxable} /> },
    { key: 'inv', header: t('scrap.col.invoice'), render: (r) => <span className="mono">{r.invoice_no ?? '—'}</span> },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <KpiTiles
        ariaLabel={t('scrap.kpis')}
        items={[
          { key: 'in', label: t('scrap.kpiIn'), value: <Qty value={sum(month.filter((e) => e.kind === 'scrap_in').map((e) => e.qty))} />, sub: t('scrap.kpiInSub') },
          { key: 'reuse', label: t('scrap.kpiReuse'), value: <Qty value={sum(month.filter((e) => e.kind === 'regrind_reuse').map((e) => e.qty))} />, sub: t('scrap.kpiReuseSub') },
          { key: 'sold', label: t('scrap.kpiSold'), value: <Qty value={sum(monthSales.map((s) => s.qty))} />, sub: t('scrap.kpiSoldSub') },
          { key: 'amt', label: t('scrap.kpiAmount'), value: <Amount value={sum(monthSales.map((s) => s.taxable))} rupee />, sub: t('scrap.kpiAmountSub') },
        ]}
      />
      <div style={TWO_COLS}>
        <TableCard title={t('scrap.stockTitle')}>
          <DataTable caption={t('scrap.stockTitle')} columns={stockCols} rows={scrap} rowKey={(r) => r.product_id} loading={sq.isLoading} minWidth={520} empty={<EmptyState title={t('scrap.stockEmpty')} body={t('scrap.stockEmptyBody')} />} />
        </TableCard>
        {canCreate ? <WeighIn companyId={companyId} scrapItems={scrap} /> : <Card><p className="muted" style={{ margin: 0 }}>{readOnly ? t('scrap.readOnly') : t('scrap.noRight')}</p></Card>}
      </div>
      <TableCard title={t('scrap.entriesTitle')}>
        <DataTable caption={t('scrap.entriesTitle')} columns={entryCols} rows={entries} rowKey={(r) => r.id} loading={eq.isLoading} minWidth={820} empty={<EmptyState title={t('scrap.entriesEmpty')} body={t('scrap.entriesEmptyBody')} />} />
      </TableCard>
      <TableCard title={t('scrap.salesTitle')}>
        <DataTable caption={t('scrap.salesTitle')} columns={saleCols} rows={sales} rowKey={(r) => r.id} loading={salesQ.isLoading} minWidth={720} empty={<EmptyState title={t('scrap.salesEmpty')} body={t('scrap.salesNote')} />} />
        {canCreate ? <SaleLink companyId={companyId} /> : null}
      </TableCard>
      <div style={TWO_COLS}>
        <Card title={t('scrap.howTitle')}>
          <p style={{ margin: 0 }}>{t('scrap.how')}</p>
        </Card>
        <Card title={t('scrap.revenueTitle')}>
          <p style={{ margin: 0 }}>{t('scrap.revenue')}</p>
        </Card>
      </div>
    </div>
  )
}

function WeighIn({ companyId, scrapItems }: { companyId: string; scrapItems: Scrap[] }) {
  const { t } = useTranslation()
  const items = useStockItems(companyId).list
  const places = useStockPlaces(companyId).list
  const known = new Set(scrapItems.map((s) => s.product_id))
  const ordered = [...items.filter((i) => known.has(i.id)), ...items.filter((i) => !known.has(i.id))]
  const [kind, setKind] = useState<'scrap_in' | 'regrind_reuse'>('scrap_in')
  const [product, setProduct] = useState('')
  const [source, setSource] = useState('')
  const [place, setPlace] = useState('')
  const [qty, setQty] = useState('')
  const [machine, setMachine] = useState('')
  const [mould, setMould] = useState('')
  const [shift, setShift] = useState('')
  const [date, setDate] = useState(todayIst())
  const [note, setNote] = useState('')
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [done, setDone] = useState(false)
  const m = useApiMutation<{ p: Record<string, unknown> }, { id: string }>('record_regrind', STOCK_REFRESH)

  function submit() {
    setDone(false)
    m.reset()
    const e: Record<string, string> = {}
    if (!product) e.product = t('scrap.err.product')
    if (!place) e.place = t('scrap.err.place')
    if (!cleanQty(qty)) e.qty = t('scrap.err.qty')
    setErrs(e)
    if (Object.keys(e).length) return
    m.mutate(
      { p: { company_id: companyId, kind, product_id: product, source_product_id: source || null, place_id: place, qty: cleanQty(qty), machine: machine.trim() || null, mould: mould.trim() || null, shift: shift.trim() || null, date, note: note.trim() || null } },
      {
        onSuccess: () => {
          setDone(true)
          setQty('')
          setNote('')
        },
      },
    )
  }

  return (
    <Card title={t('scrap.weighTitle')}>
      <div style={{ marginBottom: 12 }}>
        <Tabs
          variant="segmented"
          label={t('scrap.kind')}
          value={kind}
          onChange={setKind}
          tabs={[
            { key: 'scrap_in', label: t('scrap.kinds.scrap_in') },
            { key: 'regrind_reuse', label: t('scrap.kinds.regrind_reuse') },
          ]}
        />
      </div>
      <FieldGrid cols={2}>
        <SelectField label={t('scrap.item')} value={product} error={errs.product} placeholder={t('scrap.choose')} options={ordered.map((i) => ({ value: i.id, label: `${i.code} · ${i.name}` }))} onChange={(e) => setProduct(e.target.value)} />
        <SelectField label={t('scrap.source')} value={source} placeholder={t('scrap.none')} options={items.filter((i) => i.id !== product).map((i) => ({ value: i.id, label: `${i.code} · ${i.name}` }))} onChange={(e) => setSource(e.target.value)} />
        <SelectField label={t('scrap.place')} value={place} error={errs.place} placeholder={t('scrap.choose')} options={places.map((p) => ({ value: p.id, label: placeLabel(p) }))} onChange={(e) => setPlace(e.target.value)} />
        <Field label={t('scrap.qty')} inputMode="decimal" value={qty} error={errs.qty} onChange={(e) => setQty(e.target.value)} />
        <Field label={t('scrap.machine')} value={machine} onChange={(e) => setMachine(e.target.value)} />
        <Field label={t('scrap.mould')} value={mould} onChange={(e) => setMould(e.target.value)} />
        <Field label={t('scrap.shift')} value={shift} onChange={(e) => setShift(e.target.value)} />
        <Field type="date" label={t('scrap.date')} value={date} max={todayIst()} onChange={(e) => setDate(e.target.value)} />
      </FieldGrid>
      <div style={{ marginTop: 12 }}>
        <Field label={t('scrap.note')} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <p className="k">{kind === 'scrap_in' ? t('scrap.inNote') : t('scrap.reuseNote')}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <InventoryErrorBox error={m.error as RpcError | null} />
        {done ? (
          <div role="status" className="sf-alert" data-tone="success" style={{ margin: 0 }}>
            {kind === 'scrap_in' ? t('scrap.savedIn') : t('scrap.savedReuse')}
          </div>
        ) : null}
        <div>
          <Button variant="primary" onClick={submit} busy={m.isPending}>
            {kind === 'scrap_in' ? t('scrap.saveIn') : t('scrap.saveReuse')}
          </Button>
        </div>
      </div>
    </Card>
  )
}

function SaleLink({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const places = useStockPlaces(companyId).list
  const dq = useApiView('sales_documents', { eq: { company_id: companyId, doc_type: 'sales_invoice', status: 'posted' }, order: 'doc_date', ascending: false, limit: 200 })
  const docs = rowsOf(dq)
  const [doc, setDoc] = useState('')
  const [place, setPlace] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const m = useApiMutation<{ p: Record<string, unknown> }, { id: string; qty: number }>('post_scrap_sale', STOCK_REFRESH)
  function submit() {
    setDone(null)
    m.reset()
    if (!doc || !place) {
      setErr(t('scrap.err.sale'))
      return
    }
    setErr('')
    m.mutate({ p: { sales_document_id: doc, place_id: place } }, { onSuccess: (r) => setDone(String(r.qty)) })
  }
  return (
    <div className="sf-card__pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h3 style={{ fontSize: 15, margin: 0 }}>{t('scrap.linkTitle')}</h3>
      <p className="k" style={{ margin: 0 }}>{t('scrap.salesNote')}</p>
      <FieldGrid cols={2}>
        <SelectField label={t('scrap.invoice')} value={doc} error={err && !doc ? err : undefined} placeholder={docs.length ? t('scrap.choose') : t('scrap.noInvoices')} options={docs.map((d) => ({ value: d.id, label: `${d.doc_no ?? ''} · ${d.party_name ?? ''} · ${formatDate(d.doc_date)}` }))} onChange={(e) => setDoc(e.target.value)} />
        <SelectField label={t('scrap.fromPlace')} value={place} error={err && !place ? err : undefined} placeholder={t('scrap.choose')} options={places.map((p) => ({ value: p.id, label: placeLabel(p) }))} onChange={(e) => setPlace(e.target.value)} />
      </FieldGrid>
      <InventoryErrorBox error={m.error as RpcError | null} />
      {done ? (
        <div role="status" className="sf-alert" data-tone="success" style={{ margin: 0 }}>
          {t('scrap.saleDone', { qty: done })}
        </div>
      ) : null}
      <div>
        <Button onClick={submit} busy={m.isPending}>
          {t('scrap.linkButton')}
        </Button>
      </div>
    </div>
  )
}

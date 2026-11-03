import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthProvider'
import { rowsOf, useApiView } from '@/data/queries'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { fromPaise, sumPaise, useReadRpc } from '@/features/accounts/cash-book/money'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { formatDate, formatIndian } from '@/shared/format'
import { Amount, Button, Card, Chip, DataTable, EmptyState, Field, KpiTiles, PageHeader, SelectField, Skeleton, Tabs, type Column } from '@/ui'
import { downloadCsv, monthRange, toCsv, type CsvCell } from './csv'

type Num = number | string | null | undefined
interface Heads {
  taxable?: Num
  cgst?: Num
  sgst?: Num
  igst?: Num
  total?: Num
}
interface B2b extends Heads {
  party_gstin: string
  party_name: string | null
  invoices: number
}
interface B2cl extends Heads {
  doc_no: string
  doc_date: string
  pos: string
}
interface B2cs extends Heads {
  pos: string
  rate: Num
}
interface Exp extends Heads {
  doc_no: string
  doc_date: string
  with_payment: boolean
  shipping_bill_no: string | null
  shipping_bill_date: string | null
  port_code: string | null
}
interface Cdn extends Heads {
  doc_no: string
  doc_date: string
  party_gstin?: string | null
  pos?: string | null
}
interface Hsn extends Heads {
  hsn_code: string | null
  uom: string | null
  rate: Num
  qty: Num
}
interface NilRow {
  lawful_reason: string
  inter_state: boolean
  registered: boolean
  documents: number
  value: Num
}
interface DocsRow {
  doc_type: string
  series: string
  from_no: string
  to_no: string
  issued: number
  cancelled: number
}
export interface Gstr1 {
  b2b: B2b[]
  b2cl: B2cl[]
  b2cs: B2cs[]
  exp: Exp[]
  cdnr: Cdn[]
  cdnur: Cdn[]
  hsn: Hsn[]
  nil_exempt_non_gst?: NilRow[]
  docs: DocsRow[]
  totals: Heads
  all_supplies: boolean
  b2cl_threshold_set: boolean
}
export interface Gstr3b {
  outward_taxable: Heads
  outward_zero_rated: Heads
  outward_nil_exempt: { value: Num } | null
  outward_non_gst: { value: Num } | null
  inward_reverse_charge: Heads
  itc_available: Heads & { bills: number }
  itc_ineligible: Heads & { bills: number }
  output_tax: Heads
  net_before_setoff: Heads
  all_supplies: boolean
}
export interface ItcRow {
  bill_id: string
  gstin_id: string | null
  supplier: string
  supplier_gstin: string | null
  supplier_bill_no: string
  supplier_bill_date: string | null
  bill_date: string
  taxable: Num
  cgst: Num
  sgst: Num
  igst: Num
  itc: Num
  itc_eligible: boolean
  reverse_charge: boolean
  match_status: string
}

type TabKey = 'gstr1' | 'gstr3b' | 'itc'
const MONTH = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })
function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return MONTH.format(new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, 1)))
}
const amt = (v: Num) => <Amount value={v ?? null} />
const n = (v: Num): CsvCell => (v === null || v === undefined ? '' : String(v))

/**
 * GST (`GST`, /accounts/gst): per company, GSTIN and month — the GSTR-1 working by section (B2B, B2C large and small,
 * exports, credit notes, HSN summary, documents issued) from api.gstr1_summary, the GSTR-3B summary from
 * api.gstr3b_summary, and the input tax credit register from posted purchase bills (api.itc_register). Every figure
 * is the server's; the CSV download is written from the same rows. Bills without GST never appear in the GST
 * sections; Admin and the CA see them in their own Table 8 card (the server leaves it out for everyone else).
 */
export function GstPage() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const { list, companyId, company, choose, isLoading } = useCompanyChoice()
  const [month, setMonth] = useState(todayIst().slice(0, 7))
  const [gstinId, setGstinId] = useState('')
  const [tab, setTab] = useState<TabKey>('gstr1')
  const gstins = useApiView('gstins', { eq: { company_id: companyId }, order: 'gstin', enabled: Boolean(companyId) })
  const gList = rowsOf(gstins)
  const gstin = gList.find((g) => g.id === gstinId)
  const { from, to } = monthRange(month || todayIst().slice(0, 7))
  const enabled = Boolean(companyId)
  const args = { p_company_id: companyId, p_gstin_id: gstinId || null, p_from: from, p_to: to }
  const g1 = useReadRpc<Gstr1>('gstr1_summary', args, enabled)
  const g3 = useReadRpc<Gstr3b>('gstr3b_summary', args, enabled)
  const itcQ = useReadRpc<ItcRow[]>('itc_register', { p_company_id: companyId, p_from: from, p_to: to }, enabled)
  const itcRows = useMemo(() => (itcQ.data ?? []).filter((r) => !gstinId || r.gstin_id === gstinId), [itcQ.data, gstinId])
  const itcTotal = fromPaise(sumPaise(itcRows, (r) => r.itc))
  const s1 = g1.data
  const s3 = g3.data

  function exportGstr1() {
    if (!s1) return
    const csv = toCsv([
      { title: t('gstReturns.sec.b2b'), header: ['GSTIN', 'Name', 'Invoices', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total'], rows: s1.b2b.map((r) => [r.party_gstin, r.party_name, r.invoices, n(r.taxable), n(r.cgst), n(r.sgst), n(r.igst), n(r.total)]) },
      { title: t('gstReturns.sec.b2cl'), header: ['Invoice', 'Date', 'Place of supply', 'Taxable', 'IGST', 'Total'], rows: s1.b2cl.map((r) => [r.doc_no, r.doc_date, r.pos, n(r.taxable), n(r.igst), n(r.total)]) },
      { title: t('gstReturns.sec.b2cs'), header: ['Place of supply', 'Rate', 'Taxable', 'CGST', 'SGST', 'IGST'], rows: s1.b2cs.map((r) => [r.pos, n(r.rate), n(r.taxable), n(r.cgst), n(r.sgst), n(r.igst)]) },
      { title: t('gstReturns.sec.exp'), header: ['Invoice', 'Date', 'With payment', 'Taxable', 'IGST', 'Total', 'Shipping bill', 'Shipping bill date', 'Port'], rows: s1.exp.map((r) => [r.doc_no, r.doc_date, r.with_payment ? 'yes' : 'no', n(r.taxable), n(r.igst), n(r.total), r.shipping_bill_no, r.shipping_bill_date, r.port_code]) },
      { title: t('gstReturns.sec.cdnr'), header: ['Note', 'Date', 'GSTIN', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total'], rows: s1.cdnr.map((r) => [r.doc_no, r.doc_date, r.party_gstin, n(r.taxable), n(r.cgst), n(r.sgst), n(r.igst), n(r.total)]) },
      { title: t('gstReturns.sec.cdnur'), header: ['Note', 'Date', 'Place of supply', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total'], rows: s1.cdnur.map((r) => [r.doc_no, r.doc_date, r.pos, n(r.taxable), n(r.cgst), n(r.sgst), n(r.igst), n(r.total)]) },
      { title: t('gstReturns.sec.hsn'), header: ['HSN', 'UQC', 'Rate', 'Quantity', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total'], rows: s1.hsn.map((r) => [r.hsn_code, r.uom, n(r.rate), n(r.qty), n(r.taxable), n(r.cgst), n(r.sgst), n(r.igst), n(r.total)]) },
      { title: t('gstReturns.sec.docs'), header: ['Document type', 'Series', 'From', 'To', 'Issued', 'Cancelled'], rows: s1.docs.map((r) => [r.doc_type, r.series, r.from_no, r.to_no, r.issued, r.cancelled]) },
      ...(s1.all_supplies && s1.nil_exempt_non_gst
        ? [{ title: t('gstReturns.sec.nil'), header: ['Reason', 'Inter-state', 'Registered', 'Documents', 'Value'], rows: s1.nil_exempt_non_gst.map((r) => [r.lawful_reason, r.inter_state ? 'yes' : 'no', r.registered ? 'yes' : 'no', r.documents, n(r.value)] as CsvCell[]) }]
        : []),
      { title: t('gstReturns.totals'), header: ['Taxable', 'CGST', 'SGST', 'IGST', 'Total'], rows: [[n(s1.totals.taxable), n(s1.totals.cgst), n(s1.totals.sgst), n(s1.totals.igst), n(s1.totals.total)]] },
    ])
    downloadCsv(`GSTR1-${company?.code ?? 'company'}-${gstin?.gstin ?? 'all'}-${month}.csv`, csv)
  }

  function exportItc() {
    const csv = toCsv([
      {
        title: t('gstReturns.itcTitle'),
        header: ['Supplier', 'Supplier GSTIN', 'Supplier bill', 'Supplier bill date', 'Bill date', 'Taxable', 'CGST', 'SGST', 'IGST', 'Credit', 'Eligible', 'Reverse charge', 'Match'],
        rows: itcRows.map((r) => [r.supplier, r.supplier_gstin, r.supplier_bill_no, r.supplier_bill_date, r.bill_date, n(r.taxable), n(r.cgst), n(r.sgst), n(r.igst), n(r.itc), r.itc_eligible ? 'yes' : 'no', r.reverse_charge ? 'yes' : 'no', r.match_status]),
      },
    ])
    downloadCsv(`ITC-${company?.code ?? 'company'}-${month}.csv`, csv)
  }

  const subtitle = [gstin ? t('gstReturns.gstinLine', { gstin: gstin.gstin }) : t('gstReturns.allGstins', { count: gList.length }), t('gstReturns.subtitle')].join(' · ')

  return (
    <>
      <PageHeader
        title={t('gstReturns.title', { month: monthLabel(month || todayIst().slice(0, 7)) })}
        subtitle={subtitle}
        actions={
          <>
            <Button onClick={exportGstr1} disabled={!s1}>
              {t('gstReturns.exportGstr1')}
            </Button>
            <Button variant="primary" onClick={() => setTab('gstr3b')}>
              {t('gstReturns.open3b')}
            </Button>
          </>
        }
      />

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 }}>
        <CompanyPicker list={list} value={companyId} onChange={choose} />
        <div style={{ width: 260 }}>
          <SelectField
            label={t('gstReturns.gstin')}
            value={gstinId}
            onChange={(e) => setGstinId(e.target.value)}
            options={[{ value: '', label: t('gstReturns.everyGstin') }, ...gList.map((g) => ({ value: g.id ?? '', label: `${g.gstin} · ${g.state_code}` }))]}
          />
        </div>
        <div style={{ width: 200 }}>
          <Field label={t('gstReturns.month')} type="month" value={month} max={todayIst().slice(0, 7)} onChange={(e) => setMonth(e.target.value)} />
        </div>
      </div>

      {isLoading ? <Skeleton height={80} /> : null}
      {!isLoading && list.length === 0 ? <EmptyState title={t('gstReturns.noCompany')} /> : null}
      <RpcErrorBox error={g1.error ?? g3.error ?? itcQ.error} />

      {companyId ? (
        <>
          <div style={{ marginBottom: 16 }}>
            <KpiTiles
              ariaLabel={t('gstReturns.kpis')}
              items={[
                {
                  key: 'out',
                  label: t('gstReturns.kpi.outward'),
                  value: s1 ? <Amount value={s1.totals.taxable ?? 0} rupee /> : <Skeleton width={120} />,
                  sub: s1 ? t('gstReturns.kpi.outwardSub', { cgst: formatIndian(s1.totals.cgst ?? 0), sgst: formatIndian(s1.totals.sgst ?? 0), igst: formatIndian(s1.totals.igst ?? 0) }) : undefined,
                },
                { key: 'itc', label: t('gstReturns.kpi.itc'), value: itcQ.data ? <Amount value={itcTotal} rupee /> : <Skeleton width={120} />, sub: t('gstReturns.kpi.bills', { count: itcRows.length }) },
                {
                  key: 'rc',
                  label: t('gstReturns.kpi.rc'),
                  value: s3 ? <Amount value={s3.inward_reverse_charge.taxable ?? 0} rupee /> : <Skeleton width={120} />,
                  sub: t('gstReturns.kpi.rcSub'),
                },
                { key: '2b', label: t('gstReturns.kpi.match'), value: t('gstReturns.kpi.pending'), sub: t('gstReturns.kpi.matchSub') },
              ]}
            />
          </div>

          <Tabs<TabKey>
            label={t('gstReturns.tabsLabel')}
            value={tab}
            onChange={setTab}
            idBase="gst"
            controls="gst-panel"
            tabs={[
              { key: 'gstr1', label: t('gstReturns.tab.gstr1') },
              { key: 'gstr3b', label: t('gstReturns.tab.gstr3b') },
              { key: 'itc', label: t('gstReturns.tab.itc') },
            ]}
          />
          <div id="gst-panel" role="tabpanel" aria-labelledby={`gst-tab-${tab}`} style={{ marginTop: 12, display: 'grid', gap: 16 }}>
            {tab === 'gstr1' ? <Gstr1Panel s={s1} loading={g1.isLoading} /> : null}
            {tab === 'gstr3b' ? <Gstr3bPanel s={s3} loading={g3.isLoading} /> : null}
            {tab === 'itc' ? <ItcPanel rows={itcRows} loading={itcQ.isLoading} total={itcTotal} onExport={exportItc} /> : null}
          </div>
          {profile?.view !== 'all' && profile?.view !== 'all-readonly' ? (
            <p className="muted" style={{ fontSize: 13, marginTop: 16 }}>
              {t('gstReturns.gstOnlyNote')}
            </p>
          ) : null}
        </>
      ) : null}
    </>
  )
}

/* ─────────── GSTR-1 ─────────── */
function Section<R>({ title, caption, columns, rows, loading, empty, note }: { title: string; caption: string; columns: Column<R>[]; rows: R[] | undefined; loading: boolean; empty: string; note?: string }) {
  return (
    <TableCard title={title}>
      {note ? (
        <p className="muted sf-card__pad" style={{ margin: 0, paddingTop: 0, fontSize: 13 }}>
          {note}
        </p>
      ) : null}
      <DataTable caption={caption} columns={columns} rows={rows} rowKey={(r) => String(rows?.indexOf(r) ?? 0)} loading={loading} empty={<EmptyState title={empty} />} minWidth={760} />
    </TableCard>
  )
}

function headCols<R extends Heads>(t: (k: string) => string, keys: (keyof Heads)[]): Column<R>[] {
  return keys.map((k) => ({ key: k, header: t(`gstReturns.col.${k}`), align: 'right' as const, render: (r: R) => amt(r[k]) }))
}

function Gstr1Panel({ s, loading }: { s: Gstr1 | undefined; loading: boolean }) {
  const { t } = useTranslation()
  const empty = t('gstReturns.none')
  const totalsCols: Column<Heads>[] = headCols<Heads>(t, ['taxable', 'cgst', 'sgst', 'igst', 'total'])
  return (
    <>
      <TableCard title={t('gstReturns.totals')}>
        <p className="muted sf-card__pad" style={{ margin: 0, paddingTop: 0, fontSize: 13 }}>
          {t('gstReturns.totalsNote')}
        </p>
        <DataTable caption={t('gstReturns.totals')} columns={totalsCols} rows={s ? [s.totals] : undefined} rowKey={() => 'totals'} loading={loading} minWidth={560} />
      </TableCard>

      <Section<B2b>
        title={t('gstReturns.sec.b2b')}
        caption={t('gstReturns.sec.b2b')}
        loading={loading}
        empty={empty}
        rows={s?.b2b}
        columns={[
          { key: 'gstin', header: t('gstReturns.col.gstin'), render: (r) => <span className="mono">{r.party_gstin}</span> },
          { key: 'name', header: t('gstReturns.col.party'), render: (r) => r.party_name ?? '' },
          { key: 'inv', header: t('gstReturns.col.invoices'), align: 'right', render: (r) => <span className="mono">{r.invoices}</span> },
          ...headCols<B2b>(t, ['taxable', 'cgst', 'sgst', 'igst', 'total']),
        ]}
      />

      <Section<B2cl>
        title={t('gstReturns.sec.b2cl')}
        caption={t('gstReturns.sec.b2cl')}
        loading={loading}
        empty={s && !s.b2cl_threshold_set ? t('gstReturns.b2clUnset') : empty}
        note={s && !s.b2cl_threshold_set ? t('gstReturns.b2clUnsetNote') : undefined}
        rows={s?.b2cl}
        columns={[
          { key: 'no', header: t('gstReturns.col.docNo'), render: (r) => <span className="mono">{r.doc_no}</span> },
          { key: 'date', header: t('gstReturns.col.date'), render: (r) => <span className="mono">{formatDate(r.doc_date)}</span> },
          { key: 'pos', header: t('gstReturns.col.pos'), render: (r) => <span className="mono">{r.pos}</span> },
          ...headCols<B2cl>(t, ['taxable', 'igst', 'total']),
        ]}
      />

      <Section<B2cs>
        title={t('gstReturns.sec.b2cs')}
        caption={t('gstReturns.sec.b2cs')}
        loading={loading}
        empty={empty}
        rows={s?.b2cs}
        columns={[
          { key: 'pos', header: t('gstReturns.col.pos'), render: (r) => <span className="mono">{r.pos}</span> },
          { key: 'rate', header: t('gstReturns.col.rate'), align: 'right', render: (r) => <span className="mono">{`${formatIndian(r.rate ?? 0, 2)}%`}</span> },
          ...headCols<B2cs>(t, ['taxable', 'cgst', 'sgst', 'igst']),
        ]}
      />

      <Section<Exp>
        title={t('gstReturns.sec.exp')}
        caption={t('gstReturns.sec.exp')}
        loading={loading}
        empty={empty}
        rows={s?.exp}
        columns={[
          { key: 'no', header: t('gstReturns.col.docNo'), render: (r) => <span className="mono">{r.doc_no}</span> },
          { key: 'date', header: t('gstReturns.col.date'), render: (r) => <span className="mono">{formatDate(r.doc_date)}</span> },
          { key: 'pay', header: t('gstReturns.col.withPayment'), render: (r) => (r.with_payment ? <Chip tone="info">{t('gstReturns.withPayment')}</Chip> : <Chip tone="signal">{t('gstReturns.underLut')}</Chip>) },
          { key: 'sb', header: t('gstReturns.col.shippingBill'), render: (r) => <span className="mono">{[r.shipping_bill_no, r.shipping_bill_date ? formatDate(r.shipping_bill_date) : null, r.port_code].filter(Boolean).join(' · ') || '—'}</span> },
          ...headCols<Exp>(t, ['taxable', 'igst', 'total']),
        ]}
      />

      <Section<Cdn>
        title={t('gstReturns.sec.cdnr')}
        caption={t('gstReturns.sec.cdnr')}
        loading={loading}
        empty={empty}
        rows={s?.cdnr}
        columns={[
          { key: 'no', header: t('gstReturns.col.docNo'), render: (r) => <span className="mono">{r.doc_no}</span> },
          { key: 'date', header: t('gstReturns.col.date'), render: (r) => <span className="mono">{formatDate(r.doc_date)}</span> },
          { key: 'gstin', header: t('gstReturns.col.gstin'), render: (r) => <span className="mono">{r.party_gstin}</span> },
          ...headCols<Cdn>(t, ['taxable', 'cgst', 'sgst', 'igst', 'total']),
        ]}
      />

      <Section<Cdn>
        title={t('gstReturns.sec.cdnur')}
        caption={t('gstReturns.sec.cdnur')}
        loading={loading}
        empty={empty}
        rows={s?.cdnur}
        columns={[
          { key: 'no', header: t('gstReturns.col.docNo'), render: (r) => <span className="mono">{r.doc_no}</span> },
          { key: 'date', header: t('gstReturns.col.date'), render: (r) => <span className="mono">{formatDate(r.doc_date)}</span> },
          { key: 'pos', header: t('gstReturns.col.pos'), render: (r) => <span className="mono">{r.pos}</span> },
          ...headCols<Cdn>(t, ['taxable', 'cgst', 'sgst', 'igst', 'total']),
        ]}
      />

      <Section<Hsn>
        title={t('gstReturns.sec.hsn')}
        caption={t('gstReturns.sec.hsn')}
        loading={loading}
        empty={empty}
        rows={s?.hsn}
        columns={[
          { key: 'hsn', header: t('gstReturns.col.hsn'), render: (r) => <span className="mono">{r.hsn_code}</span> },
          { key: 'uom', header: t('gstReturns.col.uom'), render: (r) => <span className="mono">{r.uom}</span> },
          { key: 'rate', header: t('gstReturns.col.rate'), align: 'right', render: (r) => <span className="mono">{`${formatIndian(r.rate ?? 0, 2)}%`}</span> },
          { key: 'qty', header: t('gstReturns.col.qty'), align: 'right', render: (r) => <Amount value={r.qty ?? null} digits={3} /> },
          ...headCols<Hsn>(t, ['taxable', 'cgst', 'sgst', 'igst', 'total']),
        ]}
      />

      <Section<DocsRow>
        title={t('gstReturns.sec.docs')}
        caption={t('gstReturns.sec.docs')}
        loading={loading}
        empty={empty}
        rows={s?.docs}
        columns={[
          { key: 'type', header: t('gstReturns.col.docType'), render: (r) => t(`gstReturns.docType.${r.doc_type}`, { defaultValue: r.doc_type }) },
          { key: 'series', header: t('gstReturns.col.series'), render: (r) => <span className="mono">{r.series}</span> },
          { key: 'from', header: t('common.from'), render: (r) => <span className="mono">{r.from_no}</span> },
          { key: 'to', header: t('common.to'), render: (r) => <span className="mono">{r.to_no}</span> },
          { key: 'issued', header: t('gstReturns.col.issued'), align: 'right', render: (r) => <span className="mono">{r.issued}</span> },
          { key: 'cancelled', header: t('gstReturns.col.cancelled'), align: 'right', render: (r) => <span className="mono">{r.cancelled}</span> },
        ]}
      />

      {s?.all_supplies ? <WithoutGstCard rows={s.nil_exempt_non_gst ?? []} /> : null}
    </>
  )
}

/** Admin and CA only: the supplies without GST that go into Table 8 — the server sends this block only to them. */
function WithoutGstCard({ rows }: { rows: NilRow[] }) {
  const { t } = useTranslation()
  return (
    <Card title={t('gstReturns.withoutTitle')} accent="signal">
      <p style={{ margin: '0 0 8px', fontSize: 13.5 }}>{t('gstReturns.withoutBody')}</p>
      <DataTable<NilRow>
        caption={t('gstReturns.withoutTitle')}
        rows={rows}
        rowKey={(r) => `${r.lawful_reason}-${r.inter_state}-${r.registered}`}
        empty={<EmptyState title={t('gstReturns.withoutNone')} />}
        minWidth={560}
        columns={[
          { key: 'reason', header: t('gstReturns.col.reason'), render: (r) => t(`gstReturns.reason.${r.lawful_reason}`, { defaultValue: r.lawful_reason }) },
          { key: 'inter', header: t('gstReturns.col.supply'), render: (r) => (r.inter_state ? t('gstReturns.interState') : t('gstReturns.intraState')) },
          { key: 'reg', header: t('gstReturns.col.buyer'), render: (r) => (r.registered ? t('gstReturns.registered') : t('gstReturns.unregistered')) },
          { key: 'docs', header: t('gstReturns.col.documents'), align: 'right', render: (r) => <span className="mono">{r.documents}</span> },
          { key: 'value', header: t('gstReturns.col.value'), align: 'right', render: (r) => amt(r.value) },
        ]}
      />
      <p className="muted" style={{ margin: '8px 0 0', fontSize: 12.5 }}>
        {t('gstReturns.withoutFoot')} <Link to="/admin/law-rules">{t('gstReturns.lawLink')}</Link>
      </p>
    </Card>
  )
}

/* ─────────── GSTR-3B ─────────── */
interface Line3b {
  key: string
  label: string
  h: Heads | null
  value?: Num
}

function Gstr3bPanel({ s, loading }: { s: Gstr3b | undefined; loading: boolean }) {
  const { t } = useTranslation()
  const rows: Line3b[] = s
    ? [
        { key: 'a', label: t('gstReturns.r3b.outward'), h: s.outward_taxable },
        { key: 'b', label: t('gstReturns.r3b.zero'), h: s.outward_zero_rated },
        ...(s.all_supplies
          ? [
              { key: 'c', label: t('gstReturns.r3b.nil'), h: null, value: s.outward_nil_exempt?.value ?? 0 },
              { key: 'e', label: t('gstReturns.r3b.nonGst'), h: null, value: s.outward_non_gst?.value ?? 0 },
            ]
          : []),
        { key: 'd', label: t('gstReturns.r3b.rc'), h: s.inward_reverse_charge },
        { key: 'itc', label: t('gstReturns.r3b.itc', { count: s.itc_available.bills }), h: s.itc_available },
        { key: 'inel', label: t('gstReturns.r3b.inel', { count: s.itc_ineligible.bills }), h: s.itc_ineligible },
        { key: 'out', label: t('gstReturns.r3b.outputTax'), h: s.output_tax },
        { key: 'net', label: t('gstReturns.r3b.net'), h: s.net_before_setoff },
      ]
    : []
  return (
    <TableCard title={t('gstReturns.gstr3bTitle')}>
      <p className="muted sf-card__pad" style={{ margin: 0, paddingTop: 0, fontSize: 13 }}>
        {t('gstReturns.gstr3bNote')}
      </p>
      <DataTable<Line3b>
        caption={t('gstReturns.gstr3bTitle')}
        rows={rows}
        rowKey={(r) => r.key}
        loading={loading}
        minWidth={760}
        columns={[
          { key: 'label', header: t('gstReturns.col.line'), render: (r) => (r.key === 'net' || r.key === 'out' ? <strong>{r.label}</strong> : r.label), width: '38%' },
          { key: 'taxable', header: t('gstReturns.col.taxableOrValue'), align: 'right', render: (r) => (r.h ? (r.h.taxable === undefined ? '—' : amt(r.h.taxable)) : amt(r.value)) },
          { key: 'igst', header: t('gstReturns.col.igst'), align: 'right', render: (r) => (r.h ? amt(r.h.igst) : '—') },
          { key: 'cgst', header: t('gstReturns.col.cgst'), align: 'right', render: (r) => (r.h && r.h.cgst !== undefined ? amt(r.h.cgst) : '—') },
          { key: 'sgst', header: t('gstReturns.col.sgst'), align: 'right', render: (r) => (r.h && r.h.sgst !== undefined ? amt(r.h.sgst) : '—') },
        ]}
      />
    </TableCard>
  )
}

/* ─────────── ITC register ─────────── */
function ItcPanel({ rows, loading, total, onExport }: { rows: ItcRow[]; loading: boolean; total: string; onExport: () => void }) {
  const { t } = useTranslation()
  const cols: Column<ItcRow>[] = [
    {
      key: 'sup',
      header: t('gstReturns.col.supplierBill'),
      render: (r) => (
        <span style={{ display: 'flex', flexDirection: 'column' }}>
          <strong>{r.supplier}</strong>
          <span className="mono muted" style={{ fontSize: 12 }}>
            {[r.supplier_gstin, r.supplier_bill_no].filter(Boolean).join(' · ')}
          </span>
        </span>
      ),
    },
    { key: 'date', header: t('gstReturns.col.date'), render: (r) => <span className="mono">{formatDate(r.bill_date)}</span> },
    { key: 'taxable', header: t('gstReturns.col.taxable'), align: 'right', render: (r) => amt(r.taxable) },
    { key: 'cgst', header: t('gstReturns.col.cgst'), align: 'right', render: (r) => amt(r.cgst) },
    { key: 'sgst', header: t('gstReturns.col.sgst'), align: 'right', render: (r) => amt(r.sgst) },
    { key: 'igst', header: t('gstReturns.col.igst'), align: 'right', render: (r) => amt(r.igst) },
    { key: 'itc', header: t('gstReturns.col.credit'), align: 'right', render: (r) => <strong>{amt(r.itc)}</strong> },
    {
      key: 'status',
      header: t('common.status'),
      render: (r) =>
        !r.itc_eligible ? (
          <Chip tone="signal">{t('gstReturns.ineligible')}</Chip>
        ) : r.reverse_charge ? (
          <Chip tone="info">{t('gstReturns.reverseCharge')}</Chip>
        ) : (
          <Chip tone="info">{t('gstReturns.await2b')}</Chip>
        ),
    },
  ]
  return (
    <TableCard
      title={t('gstReturns.itcTitle')}
      action={
        <Button size="sm" onClick={onExport} disabled={rows.length === 0}>
          {t('gstReturns.exportItc')}
        </Button>
      }
    >
      <p className="muted sf-card__pad" style={{ margin: 0, paddingTop: 0, fontSize: 13 }}>
        {t('gstReturns.itcNote')}
      </p>
      <DataTable
        caption={t('gstReturns.itcTitle')}
        columns={cols}
        rows={rows}
        rowKey={(r) => r.bill_id}
        loading={loading}
        empty={<EmptyState title={t('gstReturns.noItc')} body={t('gstReturns.noItcBody')} />}
        minWidth={900}
        footer={
          rows.length ? (
            <tr>
              <th scope="row" colSpan={6} style={{ textAlign: 'left' }}>
                {t('gstReturns.itcTotal')}
              </th>
              <td className="r">
                <strong>
                  <Amount value={total} />
                </strong>
              </td>
              <td />
            </tr>
          ) : undefined
        }
      />
    </TableCard>
  )
}

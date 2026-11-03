import { rowsOf, useApiView, type ViewRow } from '@/data/queries'

/**
 * Shared pieces for the sales document screens (Invoices, Sales register, Document templates, Receipts).
 * Every amount here comes from Postgres (api.preview_tax, api.sales_documents, api.sales_document_lines);
 * the browser only formats and groups figures the server already worked out.
 */

export type SalesDoc = ViewRow<'sales_documents'>
export type SalesDocLine = ViewRow<'sales_document_lines'>

export const DOC_TYPES = ['sales_invoice', 'credit_note', 'bill_of_supply', 'delivery_challan'] as const
export type DocType = (typeof DOC_TYPES)[number]
/** Document types without GST: only Admin, only with a lawful reason (AGENTS.md rule 7). */
export const ADMIN_ONLY_TYPES: DocType[] = ['bill_of_supply', 'delivery_challan']
export const LAWFUL_REASONS = ['exempt_or_nil', 'non_gst', 'export_lut', 'challan_not_sold'] as const

/** GST state codes (CBIC list) for showing the place of supply by name. Reference data, not business data. */
export const GST_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
}

export function stateLabel(code: string | null | undefined): string {
  if (!code) return '—'
  const name = GST_STATES[code]
  return name ? `${name} (${code})` : code
}

/** Result of api.preview_tax — the same function the posting uses. */
export interface TaxPreviewLine {
  line_no: number
  product_id: string | null
  description: string
  hsn_code: string | null
  uom: string
  qty: number
  rate: number
  discount: number
  taxable: number
  gst_rate: number
  tax_class: string
  cgst: number
  sgst: number
  igst: number
  total: number
}
export interface TaxPreview {
  lines: TaxPreviewLine[]
  taxable: number
  cgst: number
  sgst: number
  igst: number
  round_off: number
  total: number
  intra_state: boolean
  amount_in_words: string
  place_of_supply: string
  our_state: string
}

export interface HsnRow {
  key: string
  hsn: string
  rate: number
  taxable: number
  cgst: number
  sgst: number
  igst: number
}

/** Paise arithmetic so grouped server figures never pick up float noise. */
const toPaise = (v: number | string | null | undefined) => Math.round(Number(v ?? 0) * 100)

/** HSN-wise summary of the server-computed lines (grouping only; no tax is worked out here). */
export function hsnSummary(lines: Pick<TaxPreviewLine, 'hsn_code' | 'gst_rate' | 'taxable' | 'cgst' | 'sgst' | 'igst'>[]): HsnRow[] {
  const map = new Map<string, { hsn: string; rate: number; taxable: number; cgst: number; sgst: number; igst: number }>()
  for (const l of lines) {
    const hsn = l.hsn_code ?? '—'
    const key = `${hsn}|${l.gst_rate}`
    const cur = map.get(key) ?? { hsn, rate: Number(l.gst_rate), taxable: 0, cgst: 0, sgst: 0, igst: 0 }
    cur.taxable += toPaise(l.taxable)
    cur.cgst += toPaise(l.cgst)
    cur.sgst += toPaise(l.sgst)
    cur.igst += toPaise(l.igst)
    map.set(key, cur)
  }
  return [...map.entries()].map(([key, v]) => ({ key, hsn: v.hsn, rate: v.rate, taxable: v.taxable / 100, cgst: v.cgst / 100, sgst: v.sgst / 100, igst: v.igst / 100 }))
}

/** Sum of server amounts in paise (for register footers). */
export function sumAmounts(values: (number | string | null | undefined)[]): number {
  return values.reduce<number>((acc, v) => acc + toPaise(v), 0) / 100
}

/** A posted or draft document with everything the A4 layout needs, read through RLS. */
export function useDocBundle(docId: string | null | undefined) {
  const enabled = Boolean(docId)
  const doc = useApiView('sales_documents', { eq: { id: docId ?? '' }, limit: 1, enabled })
  const lines = useApiView('sales_document_lines', { eq: { document_id: docId ?? '' }, order: 'line_no', enabled })
  const row = rowsOf(doc)[0]
  const companies = useApiView('companies', { order: 'code', enabled })
  const gstins = useApiView('gstins', { eq: { company_id: row?.company_id ?? '' }, enabled: Boolean(row) })
  const addresses = useApiView('party_addresses', { eq: { party_id: row?.party_id ?? '' }, enabled: Boolean(row) })
  const against = useApiView('sales_documents', { eq: { id: row?.against_id ?? '' }, limit: 1, enabled: Boolean(row?.against_id) })
  return {
    doc: row,
    lines: rowsOf(lines),
    company: rowsOf(companies).find((c) => c.id === row?.company_id),
    gstin: rowsOf(gstins).find((g) => g.id === row?.gstin_id),
    address: rowsOf(addresses).find((a) => a.kind === 'billing') ?? rowsOf(addresses)[0],
    against: rowsOf(against)[0],
    isLoading: doc.isLoading || lines.isLoading,
    error: doc.error ?? lines.error,
    notFound: enabled && !doc.isLoading && !row,
  }
}
export type DocBundle = ReturnType<typeof useDocBundle>

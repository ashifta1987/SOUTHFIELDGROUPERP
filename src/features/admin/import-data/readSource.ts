import { readSheet } from 'read-excel-file/browser'
import { mapHeaders, readTallyXml, sheetToRows, type ListKind } from '@/features/import/runImport'
import type { StageRow } from '@/features/import/tally/parseTallyXml'

/** The five kinds of upload on the Import data screen. */
export type SourceKey = 'tally_xml' | 'products' | 'parties' | 'employees' | 'tbk'
export const SOURCES: SourceKey[] = ['tally_xml', 'products', 'parties', 'employees', 'tbk']

export const isExcel = (s: SourceKey): s is ListKind => s === 'products' || s === 'parties' || s === 'employees'

/** What the browser read from the file: only a format conversion, every decision is made by api.import_process. */
export interface ReadResult {
  rows: StageRow[]
  counts: Record<string, number>
  kind: string
  totals: Record<string, unknown>
  periodFrom: string | null
  periodTo: string | null
  companyName: string | null
  /** Excel only: ERP field → header text found in the sheet (null when missing) */
  mapping: { field: string; column: string | null }[] | null
}

export class ReadError extends Error {}

const FIELDS: Record<ListKind, string[]> = {
  products: ['name', 'code', 'parent', 'unit', 'hsn', 'mrp'],
  parties: ['name', 'gstin', 'pan', 'phone', 'address', 'parent', 'opening'],
  employees: ['name', 'code', 'pan', 'phone', 'dob', 'aadhaar_last4'],
}

function countRows(rows: StageRow[]): Record<string, number> {
  const c: Record<string, number> = {}
  for (const r of rows) c[r.object_type] = (c[r.object_type] ?? 0) + 1
  return c
}

export async function readSource(source: SourceKey, file: File, partyGroup: string): Promise<ReadResult> {
  if (source === 'tally_xml') {
    let parsed
    try {
      parsed = await readTallyXml(file)
    } catch {
      throw new ReadError('errNotXml')
    }
    if (parsed.rows.length === 0) throw new ReadError('errNoRows')
    const vouchers = parsed.counts.voucher ?? 0
    const masters = parsed.rows.length - vouchers
    const kind = vouchers > 0 && masters > 0 ? 'mixed' : vouchers > 0 ? 'vouchers' : 'masters'
    const totals: Record<string, unknown> = vouchers > 0 ? { period_from: parsed.periodFrom, period_to: parsed.periodTo, voucher_count: vouchers } : {}
    return { rows: parsed.rows, counts: parsed.counts, kind, totals, periodFrom: parsed.periodFrom, periodTo: parsed.periodTo, companyName: parsed.companyName, mapping: null }
  }
  if (isExcel(source)) {
    let table: unknown[][]
    try {
      table = (await readSheet(file)) as unknown[][]
    } catch {
      throw new ReadError('errExcel')
    }
    const head = (table[0] ?? []).map((h) => String(h ?? ''))
    const map = mapHeaders(head)
    if (map.name === undefined) throw new ReadError('errNoName')
    const rows = sheetToRows(source, table, partyGroup)
    if (rows.length === 0) throw new ReadError('errNoRows')
    const mapping = FIELDS[source].map((field) => ({ field, column: map[field] === undefined ? null : (head[map[field] as number] ?? null) }))
    return { rows, counts: countRows(rows), kind: source, totals: {}, periodFrom: null, periodTo: null, companyName: null, mapping }
  }
  return { rows: [], counts: {}, kind: 'mixed', totals: {}, periodFrom: null, periodTo: null, companyName: null, mapping: null }
}

/** Short "under / details" text for the preview table. */
export function rowDetail(r: StageRow): string {
  const p = r.payload
  const parts: string[] = []
  const add = (v: unknown) => {
    if (v !== null && v !== undefined && String(v).trim() !== '') parts.push(String(v))
  }
  if (r.object_type === 'voucher') {
    add(p.date)
    add(p.party)
  } else {
    add(p.parent)
    add(p.gstin)
    add(p.hsn)
    add(p.unit)
    add(p.code)
  }
  return parts.join(' · ')
}

/** Accept attribute for the file input. */
export function acceptFor(source: SourceKey): string {
  if (source === 'tally_xml') return '.xml,text/xml,application/xml'
  if (isExcel(source)) return '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  return '.001,.tbk,.zip,application/zip,application/octet-stream'
}

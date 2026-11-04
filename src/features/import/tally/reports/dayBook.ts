import { companyNameOf, findRow, isBlank, label, parseAmount, parseDate, periodOf, round2, text, ReportReadError, type Table } from './common'

/** One Day Book line, as staged for api.import_stage_rows (object_type 'voucher'). Never posted: a Day Book has one leg per voucher. */
export interface DayBookRow {
  object_type: 'voucher'
  name: string | null
  guid: null
  master_id: null
  alter_id: null
  payload: {
    type: string
    number: string | null
    date: string
    party: string | null
    amount: number
    dc: 'dr' | 'cr' | null
    match_key: string
    seq_in_file: number
  }
}

export interface DayBookSummary {
  rows: DayBookRow[]
  companyName: string | null
  periodFrom: string | null
  periodTo: string | null
  /** first and last voucher date actually found in the lines */
  dateFrom: string | null
  dateTo: string | null
  byType: { type: string; count: number; dr: number; cr: number }[]
  totalDr: number
  totalCr: number
  warnings: { code: string; count: number }[]
}

export const DAYBOOK_CHUNK = 1500

function pad(n: number): string {
  return n.toFixed(2)
}

/**
 * Day Book layout (TallyPrime → Display → Day Book → Export → Excel): a few title lines (company, address, "Day Book",
 * the period), a header row Date | Particulars | Vch Type | Vch No. | Debit Amount | Credit Amount, an optional sub-header
 * ("Inwards Qty" / "Outwards Qty"), then one line per voucher. The header row is found by its column names.
 *
 * match_key = type|no|date|amount|party|dr-or-cr. Two identical lines in one file are two vouchers: the second and later
 * get "|#n" so they both load, while loading the same file again produces the same keys (and is skipped).
 */
export function parseDayBook(table: Table, onProgress?: (done: number, total: number) => void): DayBookSummary {
  const h = findRow(table, (r) => {
    const l = r.map(label)
    return l.includes('date') && l.includes('particulars') && l.some((x) => x.startsWith('vch type') || x === 'voucher type')
  })
  if (h < 0) throw new ReportReadError('errDayBookHeader')
  const head = (table[h] ?? []).map(label)
  const col = (test: (l: string) => boolean) => head.findIndex(test)
  const cDate = col((l) => l === 'date')
  const cPart = col((l) => l === 'particulars')
  const cType = col((l) => l.startsWith('vch type') || l === 'voucher type')
  const cNo = col((l) => l.startsWith('vch no') || l.startsWith('voucher no'))
  const cDr = col((l) => l.startsWith('debit'))
  const cCr = col((l) => l.startsWith('credit'))
  if (cDr < 0 && cCr < 0) throw new ReportReadError('errDayBookHeader')

  const period = periodOf(table, h)
  const rows: DayBookRow[] = []
  const seen = new Map<string, number>()
  const byType = new Map<string, { type: string; count: number; dr: number; cr: number }>()
  const warn = new Map<string, number>()
  const bump = (code: string) => warn.set(code, (warn.get(code) ?? 0) + 1)
  let totalDr = 0
  let totalCr = 0
  let dateFrom: string | null = null
  let dateTo: string | null = null
  const total = table.length - h - 1

  for (let i = h + 1; i < table.length; i++) {
    const r = table[i] ?? []
    if (onProgress && (i - h) % 5000 === 0) onProgress(i - h, total)
    const date = parseDate(r[cDate])
    if (!date) {
      // sub-header ("Inwards Qty"), blank and total rows: nothing to load
      if (!r.every(isBlank) && /total/i.test(text(r[cPart]) + text(r[cDate]))) bump('total_rows_ignored')
      continue
    }
    const type = text(r[cType])
    const party = text(r[cPart]) || null
    if (type === '') {
      bump('no_type')
      continue
    }
    const dr = cDr >= 0 ? parseAmount(r[cDr]) : null
    const cr = cCr >= 0 ? parseAmount(r[cCr]) : null
    let amount = 0
    let dc: 'dr' | 'cr' | null = null
    if (dr && dr.value !== 0) {
      amount = Math.abs(dr.value)
      dc = dr.value < 0 ? 'cr' : 'dr'
    } else if (cr && cr.value !== 0) {
      amount = Math.abs(cr.value)
      dc = cr.value < 0 ? 'dr' : 'cr'
    } else bump('no_amount')
    const no = text(r[cNo]) || null
    const base = [type, no ?? '', date, pad(amount), party ?? '', dc ?? ''].join('|')
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    if (n > 1) bump('identical_lines')
    const key = n === 1 ? base : `${base}|#${n}`
    rows.push({
      object_type: 'voucher',
      name: no ?? type,
      guid: null,
      master_id: null,
      alter_id: null,
      payload: { type, number: no, date, party, amount, dc, match_key: key, seq_in_file: n },
    })
    const t = byType.get(type) ?? { type, count: 0, dr: 0, cr: 0 }
    t.count++
    if (dc === 'dr') {
      t.dr += amount
      totalDr += amount
    } else if (dc === 'cr') {
      t.cr += amount
      totalCr += amount
    }
    byType.set(type, t)
    if (dateFrom === null || date < dateFrom) dateFrom = date
    if (dateTo === null || date > dateTo) dateTo = date
  }
  if (rows.length === 0) throw new ReportReadError('errNoRows')
  onProgress?.(total, total)
  return {
    rows,
    companyName: companyNameOf(table, h),
    periodFrom: period.from,
    periodTo: period.to,
    dateFrom,
    dateTo,
    byType: [...byType.values()].map((t) => ({ ...t, dr: round2(t.dr), cr: round2(t.cr) })).sort((a, b) => b.count - a.count),
    totalDr: round2(totalDr),
    totalCr: round2(totalCr),
    warnings: [...warn.entries()].map(([code, count]) => ({ code, count })),
  }
}

/** Does the company named in the file look like the chosen company? Compared on letters and digits only. */
export function companyNameMatches(fileName: string | null, chosen: string[]): boolean {
  if (!fileName) return true
  const norm = (s: string) => s.toLowerCase().replace(/\b(pvt|private|ltd|limited|p|the)\b\.?/g, ' ').replace(/[^a-z0-9]+/g, '')
  const f = norm(fileName)
  if (f === '') return true
  return chosen.some((c) => {
    const n = norm(c)
    return n !== '' && (f.includes(n) || n.includes(f))
  })
}


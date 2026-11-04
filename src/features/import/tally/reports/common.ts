/**
 * Shared helpers for the Tally report readers (Day Book, Trial Balance, Stock Summary, Balance Sheet).
 * Pure functions on a sheet table (`unknown[][]`, as read-excel-file returns it): no browser APIs, so the Import screen
 * and scripts/import-tally-report.mjs use exactly the same code. They only convert layout; every decision (matching,
 * balance checks, posting) is made by the database RPCs.
 */

export type Table = unknown[][]
export type Cell = unknown

export class ReportReadError extends Error {
  /** i18n key suffix under importData.reports.err* */
  constructor(public code: string, message?: string) {
    super(message ?? code)
  }
}

export function text(v: Cell): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return isoDate(v)
  return String(v).replace(/\u00a0/g, ' ').trim()
}

export function isBlank(v: Cell): boolean {
  return text(v) === ''
}

export function rowIsBlank(r: unknown[] | undefined): boolean {
  return !r || r.every(isBlank)
}

/** Lower-case, single-spaced label for header matching. */
export function label(v: Cell): string {
  return text(v).toLowerCase().replace(/[^a-z0-9 ./&-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

export function isoDate(d: Date): string {
  // read-excel-file returns UTC-midnight dates for date cells
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

function ymd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCMonth() !== m - 1) return null
  return isoDate(dt)
}

function fullYear(y: number): number {
  if (y >= 100) return y
  return y < 70 ? 2000 + y : 1900 + y
}

/** A date cell: Date, Excel serial number, or text like 1-Apr-21, 01-04-2021, 1/4/21, 2021-04-01, 20210401. Null when it is not a date. */
export function parseDate(v: Cell): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : isoDate(v)
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) return isoDate(new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000))
    return null
  }
  const s = text(v)
  let m = /^(\d{1,2})[-/. ]([A-Za-z]{3})[A-Za-z]*[-/. ,]+(\d{2}|\d{4})$/.exec(s)
  if (m) return ymd(fullYear(Number(m[3])), MONTHS[(m[2] ?? '').toLowerCase()] ?? 0, Number(m[1]))
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]))
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s)
  if (m) return ymd(fullYear(Number(m[3])), Number(m[2]), Number(m[1]))
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s)
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]))
  return null
}

/** Find every date written in a text, in order (title lines like "1-Apr-25 to 31-Mar-26"). */
export function datesIn(s: string): string[] {
  const out: string[] = []
  const re = /(\d{1,2}[-/. ][A-Za-z]{3}[A-Za-z]*[-/. ,]+\d{2,4})|(\d{4}-\d{2}-\d{2})|(\d{1,2}[-/.]\d{1,2}[-/.]\d{4})/g
  for (const m of s.matchAll(re)) {
    const d = parseDate(m[0])
    if (d) out.push(d)
  }
  return out
}

export interface Amount {
  value: number
  /** 'D' or 'C' when the cell itself says Dr / Cr */
  dc: 'D' | 'C' | null
}

/** An amount cell: number, "1,23,456.78", "(500)", "-500", "1,234.00 Dr". Null when blank or not a number. */
export function parseAmount(v: Cell): Amount | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? { value: v, dc: null } : null
  let s = text(v)
  if (s === '' || s === '-' || s === '—') return null
  let dc: 'D' | 'C' | null = null
  const m = /\s*(dr|cr|debit|credit)\.?$/i.exec(s)
  if (m) {
    dc = /^d/i.test(m[1] ?? '') ? 'D' : 'C'
    s = s.slice(0, m.index)
  }
  let neg = false
  if (/^\(.*\)$/.test(s)) {
    neg = true
    s = s.slice(1, -1)
  }
  s = s.replace(/[₹,\s]/g, '').replace(/^Rs\.?/i, '')
  if (s.startsWith('-')) {
    neg = !neg
    s = s.slice(1)
  }
  if (!/^\d*\.?\d+$/.test(s)) return null
  const n = Number(s)
  return { value: neg ? -n : n, dc }
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export function round3(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000
}

/** Quantity cell with a unit: "125.500 Kg", "-5 Nos", 12.5 → {qty, unit}. */
export function parseQty(v: Cell): { qty: number; unit: string | null } | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return { qty: v, unit: null }
  const s = text(v)
  if (s === '') return null
  const m = /^\(?(-?)\s*([\d,]*\.?\d+)\)?\s*(.*)$/.exec(s)
  if (!m) return null
  const n = Number((m[2] ?? '').replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  const unit = (m[3] ?? '').trim()
  return { qty: m[1] === '-' || /^\(/.test(s) ? -n : n, unit: unit === '' ? null : unit }
}

/** Rate cell: 250, "250.00", "250.00/Kg" → number (unit part ignored). */
export function parseRate(v: Cell): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return v
  const s = text(v).split('/')[0] ?? ''
  const a = parseAmount(s)
  return a ? a.value : null
}

/** SHA-256 (hex) of the file bytes. Uses Web Crypto, available in browsers and Node 20+. */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data as BufferSource)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** First non-empty cell of the first rows: Tally prints the company name on the first line. */
export function companyNameOf(table: Table, upto: number): string | null {
  for (let i = 0; i < Math.min(upto, table.length); i++) {
    const t = text((table[i] ?? []).find((c) => !isBlank(c)))
    if (t) return t
  }
  return null
}

/** Period or "as at" date read from the title lines above the header. */
export function periodOf(table: Table, upto: number): { from: string | null; to: string | null } {
  for (let i = 0; i < Math.min(upto, table.length); i++) {
    for (const c of table[i] ?? []) {
      const d = datesIn(text(c))
      if (d.length >= 2) return { from: d[0] ?? null, to: d[d.length - 1] ?? null }
    }
  }
  for (let i = 0; i < Math.min(upto, table.length); i++) {
    for (const c of table[i] ?? []) {
      const s = text(c)
      const d = datesIn(s)
      if (d.length === 1 && /\b(as at|as on|as of|closing|upto|up to|till)\b/i.test(s)) return { from: null, to: d[0] ?? null }
    }
  }
  for (let i = 0; i < Math.min(upto, table.length); i++) {
    for (const c of table[i] ?? []) {
      const d = datesIn(text(c))
      if (d.length === 1) return { from: null, to: d[0] ?? null }
    }
  }
  return { from: null, to: null }
}

/** Row index of the first row (within `scan` rows) where `test` is true. */
export function findRow(table: Table, test: (r: unknown[]) => boolean, scan = 30): number {
  for (let i = 0; i < Math.min(scan, table.length); i++) if (test(table[i] ?? [])) return i
  return -1
}

/** Header labels for column `c`: the labels of the header rows, with a merged group label carried to the cells on its right. */
export function columnLabels(table: Table, headerRows: number[], width: number): string[][] {
  const out: string[][] = Array.from({ length: width }, () => [])
  for (const hr of headerRows) {
    let carry = ''
    for (let c = 0; c < width; c++) {
      const l = label(table[hr]?.[c])
      if (l !== '') carry = l
      // only the first header row (group labels such as "Closing Balance") is carried across blanks
      const use = hr === headerRows[0] ? carry : l
      out[c]?.push(use)
    }
  }
  return out
}

/* ───────────────────────── Group rows ─────────────────────────
 * Tally's Excel export loses the bold/indent formatting, so a "group" row is recognised the way an accountant does it:
 * its amount equals the sum of the rows that follow it (its children), and nested groups count once.
 * Leading spaces in the name (when present) are used instead, deterministically. */

export interface HierItem {
  name: string
  /** signed amount used for the sum test (e.g. Dr positive, Cr negative; or the value column) */
  amount: number
  /** this row can never be a group (it has a rate or a unit, or it is a total line) */
  leaf?: boolean
  /** leading spaces in the Particulars cell */
  indent?: number
}

export interface HierResult {
  isGroup: boolean[]
  depth: number[]
  parents: string[][]
}

export type HierMode = 'greedy' | 'min2' | 'flat'

function hierarchyBySums(items: HierItem[], mode: HierMode): { isGroup: boolean[]; end: number[] } {
  const n = items.length
  const isGroup: boolean[] = new Array<boolean>(n).fill(false)
  const end: number[] = new Array<number>(n).fill(-1)
  if (mode === 'flat') return { isGroup, end }
  const eps = 0.005
  const memo = new Map<string, number>()
  const canBeGroup = (j: number) => !items[j]?.leaf && Math.abs(items[j]?.amount ?? 0) > eps
  // consume nodes from i until their sum reaches target; returns the end index (exclusive) or -1
  const seq = (i: number, target: number): number => {
    const key = `${i}|${target}`
    const hit = memo.get(key)
    if (hit !== undefined) return hit
    let sum = 0
    let j = i
    let found = -1
    let nodes = 0
    while (j < n) {
      const amt = items[j]?.amount ?? 0
      let e = -1
      if (canBeGroup(j)) e = seq(j + 1, amt)
      if (e >= 0) {
        sum += amt
        j = e
      } else {
        sum += amt
        j++
      }
      nodes++
      if (Math.abs(sum - target) < eps && (mode !== 'min2' || nodes >= 2 || j - i >= 2)) {
        found = j
        break
      }
    }
    memo.set(key, found)
    return found
  }
  const walk = (a: number, b: number) => {
    let k = a
    while (k < b) {
      const e = canBeGroup(k) ? seq(k + 1, items[k]?.amount ?? 0) : -1
      if (e >= 0 && e <= b && (mode !== 'min2' || e - (k + 1) >= 2)) {
        isGroup[k] = true
        end[k] = e
        walk(k + 1, e)
        k = e
      } else k++
    }
  }
  walk(0, n)
  return { isGroup, end }
}

function hierarchyByIndent(items: HierItem[]): { isGroup: boolean[]; end: number[] } {
  const n = items.length
  const isGroup: boolean[] = new Array<boolean>(n).fill(false)
  const end: number[] = new Array<number>(n).fill(-1)
  for (let i = 0; i < n; i++) {
    const ind = items[i]?.indent ?? 0
    if (i + 1 < n && (items[i + 1]?.indent ?? 0) > ind) {
      isGroup[i] = true
      let j = i + 1
      while (j < n && (items[j]?.indent ?? 0) > ind) j++
      end[i] = j
    }
  }
  return { isGroup, end }
}

export function buildHierarchy(items: HierItem[], mode: HierMode = 'greedy'): HierResult {
  const useIndent = items.some((i) => (i.indent ?? 0) > 0)
  const { isGroup, end } = useIndent ? hierarchyByIndent(items) : hierarchyBySums(items, mode)
  const n = items.length
  const depth: number[] = new Array<number>(n).fill(0)
  const parents: string[][] = Array.from({ length: n }, () => [])
  const stack: { name: string; end: number }[] = []
  for (let i = 0; i < n; i++) {
    while (stack.length > 0 && (stack[stack.length - 1]?.end ?? 0) <= i) stack.pop()
    depth[i] = stack.length
    parents[i] = stack.map((s) => s.name).reverse()
    if (isGroup[i]) stack.push({ name: items[i]?.name ?? '', end: end[i] ?? n })
  }
  return { isGroup, depth, parents }
}

/** Tally's predefined primary and common groups. A flat list made only of these is a group-wise report. */
export const TALLY_PRIMARY_GROUPS = [
  'branch / divisions', 'capital account', 'current assets', 'current liabilities', 'direct expenses', 'direct incomes', 'fixed assets',
  'indirect expenses', 'indirect incomes', 'investments', 'loans (liability)', 'misc expenses (asset)', 'purchase accounts', 'sales accounts',
  'suspense a/c', 'reserves & surplus', 'bank accounts', 'bank od a/c', 'cash-in-hand', 'deposits (asset)', 'duties & taxes', 'loans & advances (asset)',
  'provisions', 'secured loans', 'stock-in-hand', 'sundry creditors', 'sundry debtors', 'unsecured loans', 'retained earnings', 'direct expenses, dr',
  'expenses (direct)', 'expenses (indirect)', 'incomes (direct)', 'incomes (indirect)', 'profit & loss a/c', 'stock-in-hand',
]

export function looksLikeGroupNames(names: string[]): boolean {
  if (names.length === 0) return false
  const known = names.filter((n) => TALLY_PRIMARY_GROUPS.includes(n.trim().toLowerCase())).length
  return known / names.length >= 0.6
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function leadingSpaces(raw: Cell): number {
  if (typeof raw !== 'string') return 0
  const m = /^[ \u00a0\t]*/.exec(raw)
  return m ? m[0].length : 0
}

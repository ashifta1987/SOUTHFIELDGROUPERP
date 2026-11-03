import { readSheet } from 'read-excel-file/browser'

/**
 * Reading a bank statement file in the browser. This is only a format conversion (file → rows); the server stores
 * the lines, skips the ones already imported and does the matching. A password, if a file has one, is never stored.
 */

export type StatementField = 'date' | 'description' | 'ref' | 'debit' | 'credit' | 'amount' | 'balance'
export const FIELDS: StatementField[] = ['date', 'description', 'ref', 'debit', 'credit', 'amount', 'balance']

export interface Sheet {
  headers: string[]
  rows: unknown[][]
}
export type Mapping = Partial<Record<StatementField, number>>
export interface StatementLine {
  date: string
  description: string
  ref: string
  amount: string
  balance: string | null
}

export class StatementReadError extends Error {
  constructor(readonly kind: 'protected' | 'pdf' | 'unreadable' | 'noHeader') {
    super(kind)
  }
}

/** Split CSV text into rows (quotes, doubled quotes, commas/semicolons/tabs inside quotes). */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, '')
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? ''
  const sep = [',', ';', '\t'].reduce((best, s) => (firstLine.split(s).length > firstLine.split(best).length ? s : best), ',')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === sep) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

async function magic(file: File): Promise<number[]> {
  const buf = new Uint8Array(await file.slice(0, 5).arrayBuffer())
  return Array.from(buf)
}

/** Read the file into a header row plus data rows. */
export async function readStatement(file: File): Promise<Sheet> {
  const head = await magic(file)
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) throw new StatementReadError('pdf')
  // OLE2 container: a password-protected .xlsx (or an old .xls) — the browser library can't open it.
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) throw new StatementReadError('protected')
  let table: unknown[][]
  const isZip = head[0] === 0x50 && head[1] === 0x4b
  if (isZip) {
    try {
      table = (await readSheet(file)) as unknown[][]
    } catch {
      throw new StatementReadError('unreadable')
    }
  } else {
    table = parseCsv(await file.text())
  }
  // The header is the first row with at least three filled cells (bank files often start with a few title lines).
  const at = table.findIndex((r) => r.filter((c) => String(c ?? '').trim() !== '').length >= 3)
  if (at < 0) throw new StatementReadError('noHeader')
  const headers = (table[at] ?? []).map((h) => String(h ?? '').trim())
  return { headers, rows: table.slice(at + 1) }
}

const GUESS: Record<StatementField, RegExp> = {
  date: /^(txn |transaction |value |tran )?date|^date/i,
  description: /narration|description|particular|remark|details/i,
  ref: /ref|chq|cheque|utr|instrument/i,
  debit: /debit|withdrawal|^dr\b|paid out/i,
  credit: /credit|deposit|^cr\b|paid in/i,
  amount: /^amount|txn amount|transaction amount/i,
  balance: /balance/i,
}

/** Guess which column holds which field from the header text; the user can change every choice. */
export function guessMapping(headers: string[]): Mapping {
  const m: Mapping = {}
  const used = new Set<number>()
  for (const f of ['balance', 'date', 'debit', 'credit', 'amount', 'ref', 'description'] as StatementField[]) {
    const i = headers.findIndex((h, j) => !used.has(j) && GUESS[f].test(h))
    if (i >= 0) {
      m[f] = i
      used.add(i)
    }
  }
  return m
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

/** A cell → YYYY-MM-DD. Indian files write day first. */
export function toIsoDate(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  }
  const s = String(v ?? '').trim()
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`
  m = s.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})/)
  if (m) {
    const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]
    return `${y}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`
  }
  m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{2,4})/)
  if (m) {
    const mon = MONTHS[m[2]!.toLowerCase()]
    if (!mon) return null
    const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]
    return `${y}-${String(mon).padStart(2, '0')}-${m[1]!.padStart(2, '0')}`
  }
  return null
}

/** A cell → paise (integer), or null when empty. "1,23,456.70", "(500)", "500 Dr" are understood. */
export function toPaiseCell(v: unknown): number | null {
  if (typeof v === 'number') return Math.round(v * 100)
  let s = String(v ?? '').trim()
  if (!s) return null
  let neg = false
  if (/^\(.*\)$/.test(s)) {
    neg = true
    s = s.slice(1, -1)
  }
  if (/\bdr\.?$/i.test(s)) neg = true
  s = s.replace(/(cr|dr)\.?$/i, '').replace(/[,\s₹]/g, '')
  if (s.startsWith('-')) {
    neg = !neg
    s = s.slice(1)
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  const p = Math.round(Number(s) * 100)
  return neg ? -p : p
}

function paiseStr(p: number): string {
  const a = Math.abs(p)
  return `${p < 0 ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`
}

/** Build statement lines: amount = credit − debit (or the signed amount column). Rows without a date or amount are skipped. */
export function buildLines(sheet: Sheet, m: Mapping): { lines: StatementLine[]; skipped: number } {
  const lines: StatementLine[] = []
  let skipped = 0
  const cell = (r: unknown[], f: StatementField) => (m[f] === undefined ? undefined : r[m[f] as number])
  for (const r of sheet.rows) {
    const date = toIsoDate(cell(r, 'date'))
    let amount: number | null = null
    if (m.amount !== undefined) amount = toPaiseCell(cell(r, 'amount'))
    if (amount === null && (m.debit !== undefined || m.credit !== undefined)) {
      const dr = toPaiseCell(cell(r, 'debit')) ?? 0
      const cr = toPaiseCell(cell(r, 'credit')) ?? 0
      amount = dr === 0 && cr === 0 ? null : Math.abs(cr) - Math.abs(dr)
    }
    if (!date || amount === null || amount === 0) {
      skipped++
      continue
    }
    const bal = toPaiseCell(cell(r, 'balance'))
    lines.push({
      date,
      description: String(cell(r, 'description') ?? '').trim(),
      ref: String(cell(r, 'ref') ?? '').trim(),
      amount: paiseStr(amount),
      balance: bal === null ? null : paiseStr(bal),
    })
  }
  return { lines, skipped }
}

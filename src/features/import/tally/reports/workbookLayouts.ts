import { datesIn, findRow, isBlank, label, parseAmount, round2, text, type Table } from './common'
import type { TbLine, TrialBalanceParsed } from './trialBalance'
import { markFlat } from './xmlReports'

/**
 * Tolerant adapters for analysis workbooks that are derived from Tally (not Tally's own Excel export):
 *  - Trial Balance sheet: Ledger | Primary group | Group | Debit | Credit, a "Total" row (label in the Group column) and an optional
 *    "Difference (debit − credit)" row, then a free-text "Source" note.
 *  - Stock Summary sheet: Item | Quantity | Unit | Rate | Value (+ extra columns), a "Total" row (label in the Rate column) and extra
 *    summary rows after it, then a free-text "Source" note.
 * They carry the report date only in free text ("balances at 3-Nov-2026", "closing as on 3-Nov-2026"): it is read from there.
 * The Debit / Credit columns hold plain positive figures (the side is the column), so no sign rule is applied.
 */

const AS_OF = /\b(?:balances?|closing)\s+(?:at|as on|as at|as of)\s+(\d{1,2}[-/. ][A-Za-z]{3}[A-Za-z]*[-/. ,]+\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})/i

/** The report date from a "balances at <date>" / "closing as on <date>" phrase anywhere in the sheet. */
export function asOfFromText(table: Table): string | null {
  for (const r of table) {
    for (const c of r) {
      const m = AS_OF.exec(text(c))
      if (m) return datesIn(m[1] ?? '')[0] ?? null
    }
  }
  return null
}

const headerCols = (r: unknown[]) => r.map((c) => label(c))
const isTotalLabel = (s: string) => /^(grand\s+)?total$/i.test(s.trim())
const isDifferenceLabel = (s: string) => /^diff(erence|\.)?\b/i.test(s.trim())

export function isLedgerGroupTrialBalance(table: Table): boolean {
  const h = findRow(table, (r) => {
    const l = headerCols(r)
    return l.includes('ledger') && l.includes('primary group') && l.some((x) => x.startsWith('debit')) && l.some((x) => x.startsWith('credit'))
  })
  return h >= 0
}

/** Trial Balance sheet with ledger, primary group, group, debit and credit columns. Null when the header is not that layout. */
export function parseLedgerGroupTrialBalance(table: Table): TrialBalanceParsed | null {
  const h = findRow(table, (r) => {
    const l = headerCols(r)
    return l.includes('ledger') && l.includes('primary group') && l.some((x) => x.startsWith('debit')) && l.some((x) => x.startsWith('credit'))
  })
  if (h < 0) return null
  const l = headerCols(table[h] ?? [])
  const col = { name: l.indexOf('ledger'), primary: l.indexOf('primary group'), group: l.indexOf('group'), dr: l.findIndex((x) => x.startsWith('debit')), cr: l.findIndex((x) => x.startsWith('credit')) }
  const lines: TbLine[] = []
  const warnings: TrialBalanceParsed['warnings'] = []
  let tallyDr: number | null = null
  let tallyCr: number | null = null
  let diffDr = 0
  let diffCr = 0
  let ended = false
  for (let i = h + 1; i < table.length && !ended; i++) {
    const r = table[i] ?? []
    if (r.every(isBlank)) {
      // a blank row ends the ledger block; the Total and Difference rows still follow it
      if (lines.length > 0) {
        for (let j = i + 1; j < table.length; j++) {
          const rr = table[j] ?? []
          const tag = text(rr[col.group >= 0 ? col.group : col.primary])
          const d = parseAmount(rr[col.dr])?.value ?? 0
          const c = parseAmount(rr[col.cr])?.value ?? 0
          if (isTotalLabel(tag)) {
            tallyDr = d
            tallyCr = c
          } else if (isDifferenceLabel(tag)) {
            diffDr += d
            diffCr += c
          }
        }
        ended = true
      }
      continue
    }
    const name = text(r[col.name])
    if (name === '') continue
    const d = parseAmount(r[col.dr])?.value ?? 0
    const c = parseAmount(r[col.cr])?.value ?? 0
    if (d === 0 && c === 0) continue
    const parents: string[] = []
    const add = (g: string) => {
      if (g !== '' && g !== name && !parents.includes(g)) parents.push(g)
    }
    if (col.group >= 0) add(text(r[col.group]))
    add(text(r[col.primary]))
    // a negative figure in a column is the opposite side
    lines.push({ name, parents, is_group: false, dr: round2(d < 0 ? 0 : d) + round2(c < 0 ? -c : 0), cr: round2(c < 0 ? 0 : c) + round2(d < 0 ? -d : 0) })
  }
  const dr = round2(lines.reduce((s, x) => s + x.dr, 0))
  const cr = round2(lines.reduce((s, x) => s + x.cr, 0))
  const matches = tallyDr === null || tallyCr === null || (Math.abs(dr - tallyDr) < 0.01 && Math.abs(cr - tallyCr) < 0.01)
  if (!matches) warnings.push({ code: 'grand_total_differs', detail: `${dr} / ${cr}` })
  if (Math.abs(diffDr) > 0.005 || Math.abs(diffCr) > 0.005) warnings.push({ code: 'opening_difference', detail: `${round2(diffDr)} / ${round2(diffCr)}` })
  return {
    lines,
    grain: 'ledger',
    tallyDr,
    tallyCr,
    diffDr: round2(diffDr),
    diffCr: round2(diffCr),
    ledgerDr: dr,
    ledgerCr: cr,
    ledgerCount: lines.length,
    groupCount: 0,
    companyName: null,
    periodFrom: null,
    asOf: asOfFromText(table),
    warnings,
  }
}

/** True when the first rows are Item | Quantity | Unit | Rate | Value. */
export function isItemUnitStockSheet(table: Table): boolean {
  return itemHeaderRow(table) >= 0
}

function itemHeaderRow(table: Table): number {
  return findRow(table, (r) => {
    const l = headerCols(r)
    return l.includes('item') && l.some((x) => x === 'quantity' || x === 'qty') && l.includes('unit') && l.some((x) => x.startsWith('value'))
  })
}

/**
 * Item | Quantity | Unit | Rate | Value → the standard Particulars | Quantity ("125 Kg") | Rate | Value table the stock parser reads,
 * with the title lines, a Grand Total row (from the "Total" row) and the report date added. Null when the header is not that layout.
 */
export function adaptItemUnitStockSheet(table: Table): Table | null {
  const h = itemHeaderRow(table)
  if (h < 0) return null
  const l = headerCols(table[h] ?? [])
  const col = { name: l.indexOf('item'), qty: l.findIndex((x) => x === 'quantity' || x === 'qty'), unit: l.indexOf('unit'), rate: l.findIndex((x) => x.startsWith('rate')), value: l.findIndex((x) => x.startsWith('value')) }
  const out: unknown[][] = [[''], [''], [asOfFromText(table) ? `as at ${asOfFromText(table)}` : ''], ['Particulars', 'Quantity', 'Rate', 'Value']]
  let seenData = false
  for (let i = h + 1; i < table.length; i++) {
    const r = table[i] ?? []
    const name = text(r[col.name])
    if (name === '') {
      // after the items: a row with "Total" in the Rate/Value-label column carries the file total; anything else after a blank ends the block
      const tag = text(r[col.rate])
      if (seenData && isTotalLabel(tag)) {
        out.push(['Grand Total', null, null, parseAmount(r[col.value])?.value ?? null])
        break
      }
      continue
    }
    seenData = true
    const q = parseAmount(r[col.qty])
    const unit = text(r[col.unit])
    const rate = parseAmount(r[col.rate])
    const v = parseAmount(r[col.value])
    if (!q && !rate && !v) continue // a note row
    out.push([name, q ? `${q.value}${unit ? ` ${unit}` : ''}` : null, rate ? rate.value : null, v ? v.value : null])
  }
  return markFlat(out)
}

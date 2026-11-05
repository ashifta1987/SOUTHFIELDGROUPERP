import {
  buildHierarchy, columnLabels, companyNameOf, findRow, label, leadingSpaces, parseAmount, parseQty, parseRate, periodOf, round2, round3, text, ReportReadError,
  type HierMode, type Table,
} from './common'
import { isFlatTable } from './xmlReports'
import { adaptItemUnitStockSheet } from './workbookLayouts'

export interface StockLine {
  name: string
  parents: string[]
  is_group: boolean
  qty: number | null
  unit: string | null
  rate: number | null
  value: number
}

export interface StockSummaryParsed {
  lines: StockLine[]
  tallyQty: number | null
  tallyValue: number | null
  itemQty: number
  itemValue: number
  itemCount: number
  groupCount: number
  negativeOrZero: number
  companyName: string | null
  periodFrom: string | null
  asOf: string | null
  warnings: { code: string; detail?: string }[]
}

interface Cols {
  name: number
  qty: number
  rate: number
  value: number
}

function pick(table: Table, h: number): Cols {
  const width = Math.max(...table.slice(0, h + 4).map((r) => r.length), 0)
  const hdr = [h > 0 && (table[h - 1] ?? []).some((c) => /opening|closing|inwards|outwards/i.test(text(c))) ? h - 1 : -1, h, h + 1].filter((r) => r >= 0 && table[r])
  const labels = columnLabels(table, hdr, width)
  const name = labels.findIndex((l) => l.some((x) => x === 'particulars' || x === 'name of item' || x === 'item'))
  const find = (re: RegExp) => labels.map((l, c) => ({ c, l })).filter(({ l }) => l.some((x) => re.test(x)))
  const qtys = find(/^(closing )?(quantity|qty)$/)
  const rates = find(/^rate$/)
  const values = find(/^(value|amount)$/)
  const isClosing = (x: { l: string[] }) => x.l.some((y) => y.includes('closing'))
  const choose = (list: { c: number; l: string[] }[]) => list.find(isClosing)?.c ?? list[list.length - 1]?.c ?? -1
  const qty = choose(qtys)
  const value = choose(values)
  const rate = choose(rates)
  if (name < 0 || qty < 0 || value < 0) throw new ReportReadError('errStockColumns')
  return { name, qty, rate, value }
}

/**
 * Stock Summary (Display → Stock Summary → Export → Excel): Particulars | Closing Quantity (e.g. "125.500 Kg") | Rate | Value.
 * Item rows carry a rate or a unit; stock-group rows are told by indentation or by their value being the sum of the items below.
 */
export function parseStockSummary(sheet: Table): StockSummaryParsed {
  const table = adaptItemUnitStockSheet(sheet) ?? sheet
  const h = findRow(table, (r) => r.some((c) => label(c) === 'particulars'))
  if (h < 0) throw new ReportReadError('errStockHeader')
  const cols = pick(table, h)
  interface Raw { name: string; qty: number | null; unit: string | null; rate: number | null; value: number; indent: number; item: boolean }
  const raw: Raw[] = []
  let tallyQty: number | null = null
  let tallyValue: number | null = null
  for (let i = h + 1; i < table.length; i++) {
    const r = table[i] ?? []
    const name = text(r[cols.name])
    if (name === '') continue
    const q = parseQty(r[cols.qty])
    const rate = cols.rate >= 0 ? parseRate(r[cols.rate]) : null
    const v = parseAmount(r[cols.value])
    if (/^(grand\s+)?total\b/i.test(name)) {
      tallyQty = q?.qty ?? null
      tallyValue = v?.value ?? null
      continue
    }
    // a row of the stock sheet with no numbers at all is a heading (a group with nothing below it, or a title)
    if (!q && rate === null && !v) continue
    raw.push({ name: name.trim(), qty: q?.qty ?? null, unit: q?.unit ?? null, rate, value: v?.value ?? 0, indent: leadingSpaces(r[cols.name]), item: rate !== null || (q?.unit ?? null) !== null })
  }
  if (raw.length === 0) throw new ReportReadError('errNoRows')
  const items = raw.map((r) => ({ name: r.name, amount: r.value, indent: r.indent, leaf: r.item }))
  const leaf = (isGroup: boolean[]) => round2(raw.reduce((s, r, i) => s + (isGroup[i] ? 0 : r.value), 0))
  const ok = (v: number) => tallyValue === null || Math.abs(v - tallyValue) < 0.01
  let hier = buildHierarchy(items, isFlatTable(table) ? 'flat' : 'greedy')
  if (!isFlatTable(table) && !ok(leaf(hier.isGroup))) {
    for (const mode of ['min2', 'flat'] as HierMode[]) {
      const alt = buildHierarchy(items, mode)
      if (ok(leaf(alt.isGroup))) {
        hier = alt
        break
      }
    }
  }
  const lines: StockLine[] = raw.map((r, i) => ({
    name: r.name,
    parents: hier.parents[i] ?? [],
    is_group: hier.isGroup[i] ?? false,
    qty: r.qty === null ? null : round3(r.qty),
    unit: r.unit,
    rate: r.rate === null ? null : r.rate,
    value: round2(r.value),
  }))
  const itemsOnly = lines.filter((l) => !l.is_group)
  const itemValue = round2(itemsOnly.reduce((s, l) => s + l.value, 0))
  const warnings: StockSummaryParsed['warnings'] = []
  if (!ok(itemValue)) warnings.push({ code: 'grand_total_differs', detail: String(itemValue) })
  const p = periodOf(table, h)
  return {
    lines,
    tallyQty,
    tallyValue,
    itemQty: round3(itemsOnly.reduce((s, l) => s + (l.qty ?? 0), 0)),
    itemValue,
    itemCount: itemsOnly.length,
    groupCount: lines.length - itemsOnly.length,
    negativeOrZero: itemsOnly.filter((l) => (l.qty ?? 0) <= 0).length,
    companyName: companyNameOf(table, h),
    periodFrom: p.from,
    asOf: p.to,
    warnings,
  }
}

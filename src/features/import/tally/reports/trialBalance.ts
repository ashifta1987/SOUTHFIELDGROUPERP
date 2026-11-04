import {
  buildHierarchy, columnLabels, companyNameOf, findRow, isBlank, label, leadingSpaces, looksLikeGroupNames, parseAmount, periodOf, round2, text, ReportReadError,
  type HierMode, type Table,
} from './common'

export interface TbLine {
  name: string
  /** enclosing Tally groups, closest first */
  parents: string[]
  is_group: boolean
  dr: number
  cr: number
}

export interface TrialBalanceParsed {
  lines: TbLine[]
  /** 'ledger' = ledger lines found; 'group' = the sheet lists groups only (ask for the expanded, ledger-wise export) */
  grain: 'ledger' | 'group' | 'unknown'
  /** Grand Total printed in the file */
  tallyDr: number | null
  tallyCr: number | null
  /** "Diff in opening balances" row, when present */
  diffDr: number
  diffCr: number
  ledgerDr: number
  ledgerCr: number
  ledgerCount: number
  groupCount: number
  companyName: string | null
  periodFrom: string | null
  asOf: string | null
  warnings: { code: string; detail?: string }[]
}

function isGrandTotal(n: string): boolean {
  return /^(grand\s+)?total\b/i.test(n.trim())
}

function isDiff(n: string): boolean {
  return /^diff(erence|\.)?\s*(in|of)?\s*opening/i.test(n.trim())
}

interface Cols {
  name: number
  dr: number
  cr: number
  /** a single signed or Dr/Cr-suffixed column */
  single: number
}

/** Pick the closing Debit/Credit columns (or the only pair, or one column with Dr/Cr suffixes). */
function pickColumns(table: Table, h: number): Cols {
  const width = Math.max(...table.slice(0, h + 4).map((r) => r.length), 0)
  const rows = [h, h + 1].filter((r) => table[r])
  // header labels may be on the row above (group labels) and the row itself
  const hdrRows = h > 0 && table[h - 1] && !(table[h - 1] ?? []).every(isBlank) && (table[h - 1] ?? []).some((c) => /opening|closing|transactions/i.test(text(c))) ? [h - 1, h, h + 1] : rows
  const labels = columnLabels(table, hdrRows, width)
  const name = labels.findIndex((l) => l.some((x) => x === 'particulars'))
  const cand = (side: 'debit' | 'credit') =>
    labels.map((l, c) => ({ c, l })).filter(({ l }) => l.some((x) => x.startsWith(side)) || l.some((x) => x === (side === 'debit' ? 'dr' : 'cr')))
  const debits = cand('debit')
  const credits = cand('credit')
  const closing = (x: { l: string[] }) => x.l.some((y) => y.includes('closing'))
  let dr = debits.find(closing)?.c ?? -1
  let cr = credits.find(closing)?.c ?? -1
  if (dr < 0 || cr < 0) {
    const d = debits.filter((x) => !x.l.some((y) => y.includes('opening') || y.includes('transaction')))
    const c = credits.filter((x) => !x.l.some((y) => y.includes('opening') || y.includes('transaction')))
    if (d.length > 0 && c.length > 0) {
      dr = d[d.length - 1]?.c ?? -1
      cr = c[c.length - 1]?.c ?? -1
    } else if (debits.length > 0 && credits.length > 0) {
      dr = debits[debits.length - 1]?.c ?? -1
      cr = credits[credits.length - 1]?.c ?? -1
    }
  }
  if (dr >= 0 && cr >= 0) return { name, dr, cr, single: -1 }
  const single = labels.findIndex((l, c) => c !== name && l.some((x) => x.includes('closing') || x.includes('balance') || x === 'amount'))
  if (single >= 0) return { name, dr: -1, cr: -1, single }
  throw new ReportReadError('errTbColumns')
}

/**
 * Trial Balance from TallyPrime (Display → Trial Balance → Export → Excel, with ledgers expanded, Alt+F5).
 * Columns: Particulars + Closing Balance (Debit, Credit), or plain Debit / Credit columns, or one column with Dr/Cr suffixes.
 * Group rows are told from ledger rows by indentation when the name has leading spaces, otherwise by the group's amount
 * being the sum of the rows below it. The leaf totals are checked against the file's Grand Total.
 */
export function parseTrialBalance(table: Table): TrialBalanceParsed {
  const h = findRow(table, (r) => r.some((c) => label(c) === 'particulars'))
  if (h < 0) throw new ReportReadError('errTbHeader')
  const cols = pickColumns(table, h)
  const warnings: TrialBalanceParsed['warnings'] = []

  interface Raw { name: string; dr: number; cr: number; indent: number }
  const raw: Raw[] = []
  let tallyDr: number | null = null
  let tallyCr: number | null = null
  let diffDr = 0
  let diffCr = 0
  for (let i = h + 1; i < table.length; i++) {
    const r = table[i] ?? []
    const name = text(r[cols.name])
    if (name === '') continue
    let dr = 0
    let cr = 0
    if (cols.single >= 0) {
      const a = parseAmount(r[cols.single])
      if (a) {
        const side = a.dc ?? (a.value < 0 ? 'C' : 'D')
        if (side === 'D') dr = Math.abs(a.value)
        else cr = Math.abs(a.value)
      }
    } else {
      const d = parseAmount(r[cols.dr])
      const c = parseAmount(r[cols.cr])
      dr = d?.value ?? 0
      cr = c?.value ?? 0
      if (dr < 0) {
        cr += -dr
        dr = 0
      }
      if (cr < 0) {
        dr += -cr
        cr = 0
      }
    }
    if (isGrandTotal(name)) {
      tallyDr = dr
      tallyCr = cr
      continue
    }
    if (isDiff(name)) {
      diffDr += dr
      diffCr += cr
      continue
    }
    raw.push({ name: name.trim(), dr, cr, indent: leadingSpaces(r[cols.name]) })
  }
  if (raw.length === 0) throw new ReportReadError('errNoRows')

  const items = raw.map((r) => ({ name: r.name, amount: r.dr - r.cr, indent: r.indent }))
  const leafTotals = (isGroup: boolean[]) => {
    let d = 0
    let c = 0
    raw.forEach((r, i) => {
      if (!isGroup[i]) {
        d += r.dr
        c += r.cr
      }
    })
    return { d: round2(d), c: round2(c) }
  }
  const matches = (t: { d: number; c: number }) => tallyDr === null || tallyCr === null || (Math.abs(t.d - tallyDr) < 0.01 && Math.abs(t.c - tallyCr) < 0.01)

  let hier = buildHierarchy(items, 'greedy')
  if (!matches(leafTotals(hier.isGroup))) {
    for (const mode of ['min2', 'flat'] as HierMode[]) {
      const alt = buildHierarchy(items, mode)
      if (matches(leafTotals(alt.isGroup))) {
        hier = alt
        break
      }
    }
  }
  const lines: TbLine[] = raw.map((r, i) => ({ name: r.name, parents: hier.parents[i] ?? [], is_group: hier.isGroup[i] ?? false, dr: round2(r.dr), cr: round2(r.cr) }))
  const t = leafTotals(hier.isGroup)
  if (!matches(t)) warnings.push({ code: 'grand_total_differs', detail: `${t.d} / ${t.c}` })
  if (Math.abs(diffDr) > 0.005 || Math.abs(diffCr) > 0.005) warnings.push({ code: 'opening_difference', detail: `${round2(diffDr)} / ${round2(diffCr)}` })

  const ledgers = lines.filter((l) => !l.is_group)
  let grain: TrialBalanceParsed['grain'] = 'ledger'
  const anyGroup = lines.some((l) => l.is_group)
  if (!anyGroup && looksLikeGroupNames(ledgers.map((l) => l.name))) grain = 'group'
  const p = periodOf(table, h)
  return {
    lines,
    grain,
    tallyDr,
    tallyCr,
    diffDr: round2(diffDr),
    diffCr: round2(diffCr),
    ledgerDr: t.d,
    ledgerCr: t.c,
    ledgerCount: ledgers.length,
    groupCount: lines.length - ledgers.length,
    companyName: companyNameOf(table, h),
    periodFrom: p.from,
    asOf: p.to,
    warnings,
  }
}

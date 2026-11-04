import {
  buildHierarchy, companyNameOf, findRow, label, leadingSpaces, parseAmount, periodOf, round2, text, ReportReadError, type HierMode, type Table,
} from './common'

export interface BsLine {
  side: 'L' | 'A'
  name: string
  depth: number
  is_group: boolean
  is_total: boolean
  amount: number
}

export interface BalanceSheetParsed {
  lines: BsLine[]
  layout: 'horizontal' | 'vertical'
  liabilitiesTotal: number | null
  assetsTotal: number | null
  companyName: string | null
  asOf: string | null
  periodFrom: string | null
  warnings: { code: string; detail?: string }[]
}

const NAME_LABELS = ['particulars', 'liabilities', 'assets', 'capital & liabilities', 'capital and liabilities', 'sources of funds', 'application of funds']

const isTotal = (n: string) => /^(grand\s+)?total\b/i.test(n.trim())
const isLiabHeading = (n: string) => /^(capital\s*(&|and)\s*)?liabilities$/i.test(n.trim()) || /^sources of funds$/i.test(n.trim())
const isAssetHeading = (n: string) => /^assets$/i.test(n.trim()) || /^application of funds$/i.test(n.trim())

interface Block {
  nameCol: number
  amtCol: number
  side: 'L' | 'A' | null
}

/**
 * Balance Sheet (Display → Balance Sheet → Export → Excel). Horizontal layout = Particulars | Amount | Particulars | Amount
 * (liabilities left, assets right); vertical layout = one Particulars/Amount pair with a "Liabilities" and an "Assets" section.
 * Group rows are told from detail rows by their amount being the sum of the rows below (or by indentation).
 * Stored for reconciliation only; a Balance Sheet never posts anything.
 */
export function parseBalanceSheet(table: Table): BalanceSheetParsed {
  const h = findRow(table, (r) => r.filter((c) => NAME_LABELS.includes(label(c))).length >= 1)
  if (h < 0) throw new ReportReadError('errBsHeader')
  const head = table[h] ?? []
  const nameCols = head.map((c, i) => ({ c, i })).filter(({ c }) => NAME_LABELS.includes(label(c))).map(({ i }) => i)
  const width = Math.max(...table.map((r) => r.length), 0)
  const blocks: Block[] = nameCols.map((nc, k) => {
    const next = nameCols[k + 1] ?? width
    let best = -1
    let bestCount = 0
    for (let c = nc + 1; c < next; c++) {
      let n = 0
      for (let i = h + 1; i < table.length; i++) if (parseAmount(table[i]?.[c])) n++
      if (n > 0 && n >= bestCount * 0.5) {
        best = c
        bestCount = Math.max(bestCount, n)
      }
    }
    const l = label(head[nc])
    const side: 'L' | 'A' | null = l === 'liabilities' || l.startsWith('capital') || l === 'sources of funds' ? 'L' : l === 'assets' || l === 'application of funds' ? 'A' : null
    return { nameCol: nc, amtCol: best, side }
  }).filter((b) => b.amtCol >= 0)
  if (blocks.length === 0) throw new ReportReadError('errBsColumns')

  const horizontal = blocks.length >= 2
  if (horizontal) {
    blocks[0]!.side = blocks[0]!.side ?? 'L'
    blocks[1]!.side = blocks[1]!.side ?? (blocks[0]!.side === 'L' ? 'A' : 'L')
  }

  interface Raw { side: 'L' | 'A'; name: string; amount: number; total: boolean; indent: number }
  const raw: Raw[] = []
  let section: 'L' | 'A' = 'L'
  let sawSection = false
  for (let i = h + 1; i < table.length; i++) {
    const r = table[i] ?? []
    for (const b of blocks) {
      const name = text(r[b.nameCol])
      if (name === '') continue
      if (!horizontal) {
        if (isLiabHeading(name)) {
          section = 'L'
          sawSection = true
          continue
        }
        if (isAssetHeading(name)) {
          section = 'A'
          sawSection = true
          continue
        }
      }
      const a = parseAmount(r[b.amtCol])
      if (!a) continue
      const side = horizontal ? (b.side as 'L' | 'A') : section
      // amounts are shown on their natural side (liabilities credit, assets debit); a Dr/Cr suffix or a minus sign flips them
      let amount = a.value
      if (a.dc) amount = Math.abs(a.value) * (a.dc === (side === 'L' ? 'C' : 'D') ? 1 : -1)
      raw.push({ side, name: name.trim(), amount, total: isTotal(name), indent: leadingSpaces(r[b.nameCol]) })
    }
  }
  if (raw.length === 0) throw new ReportReadError('errNoRows')
  if (!horizontal && !sawSection) throw new ReportReadError('errBsSections')

  const lines: BsLine[] = []
  const warnings: BalanceSheetParsed['warnings'] = []
  let lTot: number | null = null
  let aTot: number | null = null
  for (const side of ['L', 'A'] as const) {
    const mine = raw.filter((r) => r.side === side)
    const total = mine.filter((r) => r.total).pop()?.amount ?? null
    if (side === 'L') lTot = total
    else aTot = total
    const body = mine.filter((r) => !r.total && !/^diff/i.test(r.name))
    const diffs = mine.filter((r) => !r.total && /^diff/i.test(r.name))
    const items = body.map((r) => ({ name: r.name, amount: r.amount, indent: r.indent }))
    const top = (hier: ReturnType<typeof buildHierarchy>) => round2(body.reduce((s, r, i) => s + ((hier.depth[i] ?? 0) === 0 ? r.amount : 0), 0))
    let hier = buildHierarchy(items, 'greedy')
    const diffSum = diffs.reduce((s, r) => s + r.amount, 0)
    const ok = (hh: ReturnType<typeof buildHierarchy>) => total === null || Math.abs(top(hh) + diffSum - total) < 0.01
    if (!ok(hier)) {
      for (const mode of ['min2', 'flat'] as HierMode[]) {
        const alt = buildHierarchy(items, mode)
        if (ok(alt)) {
          hier = alt
          break
        }
      }
    }
    if (!ok(hier)) warnings.push({ code: 'side_total_differs', detail: `${side}: ${top(hier)} / ${total}` })
    body.forEach((r, i) => lines.push({ side, name: r.name, depth: hier.depth[i] ?? 0, is_group: hier.isGroup[i] ?? false, is_total: false, amount: round2(r.amount) }))
    diffs.forEach((r) => lines.push({ side, name: r.name, depth: 0, is_group: false, is_total: false, amount: round2(r.amount) }))
    if (total !== null) lines.push({ side, name: 'Total', depth: 0, is_group: false, is_total: true, amount: round2(total) })
  }
  if (lTot !== null && aTot !== null && Math.abs(lTot - aTot) > 0.01) warnings.push({ code: 'sides_differ', detail: `${lTot} / ${aTot}` })
  const p = periodOf(table, h)
  return {
    lines,
    layout: horizontal ? 'horizontal' : 'vertical',
    liabilitiesTotal: lTot === null ? null : round2(lTot),
    assetsTotal: aTot === null ? null : round2(aTot),
    companyName: companyNameOf(table, h),
    asOf: p.to,
    periodFrom: p.from,
    warnings,
  }
}

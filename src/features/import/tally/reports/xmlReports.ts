import type { Table } from './common'

/**
 * TallyPrime XML exports of the display reports → the same table shape the Excel readers produce, so one parser per
 * report serves both formats. This is a tolerant tag scanner (no DOM, so Node can use it too).
 * Trial Balance: DSPACCNAME + DSPCLDRAMTA / DSPCLCRAMTA. Stock Summary: DSPACCNAME + DSPCLQTY / DSPCLRATE / DSPCLAMTA.
 * Balance Sheet: BSNAME + BSAMT (BSMAINAMT = a group, BSSUBAMT = a line inside the group above it).
 *
 * Real TallyPrime layout notes (all signs are Tally's own: a DEBIT is written negative, a CREDIT positive):
 *  - Trial Balance: a flat list of ledgers (no group rows, no Grand Total, no title/period). DSPCLDRAMTA and DSPCLCRAMTA hold one signed
 *    figure between them (debit = -(DR + CR)), the empty one is blank. Lines with no figures at all (e.g. the "Opening Stock" line) are dropped.
 *  - Stock Summary: a flat list of items; DSPCLQTY is "<qty> <unit>" (negative allowed, blank when none), DSPCLRATE and DSPCLAMTA may be blank;
 *    DSPCLAMTA is negative for stock held (Dr), so the value is -DSPCLAMTA.
 *  - Balance Sheet: one running list, not left/right pairs. Liabilities are positive and assets negative on the group lines, with the group's
 *    ledgers/sub-groups listed after it. The side is told by the group's name (Tally's own groups), else by its sign.
 *  - Names can carry &#13;&#10; and other entities: decoded and whitespace collapsed.
 *  - The table is flat: no hierarchy is inferred from sums (`flat` marker, see isFlatTable).
 */
const FLAT = Symbol.for('southfield.tally.flatTable')

/** True for a table built from a Tally XML display report: it carries no indentation and no group rows, so the parsers must not guess groups from sums. */
export const isFlatTable = (t: Table): boolean => (t as unknown as Record<symbol, unknown>)[FLAT] === true

export const markFlat = (t: Table): Table => {
  Object.defineProperty(t, FLAT, { value: true, enumerable: false })
  return t
}

export type XmlReportKind = 'trial_balance' | 'stock_summary' | 'balance_sheet'

const decodeEntities = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)))

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block)
  return m ? decodeEntities((m[1] ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() : null
}

function num(v: string | null): number | null {
  if (v === null || v === '') return null
  const n = Number(v.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

function head(xml: string): unknown[][] {
  const company = tag(xml, 'SVCURRENTCOMPANY') ?? tag(xml, 'COMPANYNAME') ?? ''
  const f = tag(xml, 'SVFROMDATE')
  const t = tag(xml, 'SVTODATE')
  const iso = (d: string | null) => (d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null)
  const rows: unknown[][] = [[company], ['']]
  if (iso(f) && iso(t)) rows.push([`${iso(f)} to ${iso(t)}`])
  else if (iso(t)) rows.push([`as at ${iso(t)}`])
  return rows
}

/** Tally's own liability-side and asset-side Balance Sheet groups, in lower case. */
const BS_LIAB = ['capital account', 'loans (liability)', 'current liabilities', 'profit & loss a/c', 'reserves & surplus', 'branch / divisions', 'unadjusted forex gain/loss']
const BS_ASSET = ['fixed assets', 'investments', 'current assets', 'working capital', 'misc. expenses (asset)', 'deposits (asset)', 'stock-in-hand']

export function reportXmlToTable(xml: string, kind: XmlReportKind): Table {
  const out: unknown[][] = head(xml)
  if (kind === 'trial_balance') {
    out.push(['Particulars', 'Debit', 'Credit'])
    for (const m of xml.matchAll(/<DSPACCNAME>([\s\S]*?)<\/DSPACCNAME>\s*<DSPACCINFO>([\s\S]*?)<\/DSPACCINFO>/gi)) {
      const name = tag(m[1] ?? '', 'DSPDISPNAME')
      if (!name) continue
      const dr = num(tag(m[2] ?? '', 'DSPCLDRAMTA'))
      const cr = num(tag(m[2] ?? '', 'DSPCLCRAMTA'))
      if (dr === null && cr === null) continue // e.g. the Opening Stock line with no figure
      const netDr = -((dr ?? 0) + (cr ?? 0)) // Tally writes a debit as a negative number
      out.push([name, netDr > 0 ? netDr : null, netDr < 0 ? -netDr : null])
    }
  } else if (kind === 'stock_summary') {
    out.push(['Particulars', 'Quantity', 'Rate', 'Value'])
    for (const m of xml.matchAll(/<DSPACCNAME>([\s\S]*?)<\/DSPACCNAME>\s*<DSPSTKINFO>([\s\S]*?)<\/DSPSTKINFO>/gi)) {
      const name = tag(m[1] ?? '', 'DSPDISPNAME')
      if (!name) continue
      const amt = num(tag(m[2] ?? '', 'DSPCLAMTA'))
      out.push([name, tag(m[2] ?? '', 'DSPCLQTY') || null, tag(m[2] ?? '', 'DSPCLRATE') || null, amt === null ? null : amt === 0 ? 0 : -amt])
    }
  } else {
    // One list: a BSNAME block is followed by its BSAMT block. Liabilities are positive, assets negative (Tally: debit = negative).
    out.push(['Particulars', 'Amount'])
    const re = /<BSNAME>([\s\S]*?)<\/BSNAME>\s*<BSAMT>([\s\S]*?)<\/BSAMT>/gi
    const items: { name: string; main: boolean; amt: number | null }[] = []
    for (const m of xml.matchAll(re)) {
      const name = tag(m[1] ?? '', 'DSPDISPNAME')
      if (!name) continue
      const mainAmt = num(tag(m[2] ?? '', 'BSMAINAMT'))
      const subAmt = num(tag(m[2] ?? '', 'BSSUBAMT'))
      items.push({ name, main: (tag(m[2] ?? '', 'BSMAINAMT') ?? '') !== '', amt: mainAmt ?? subAmt })
    }
    const sideOf = (g: { name: string; amt: number | null }): 'L' | 'A' => {
      const n = g.name.toLowerCase()
      if (BS_LIAB.includes(n)) return 'L'
      if (BS_ASSET.includes(n)) return 'A'
      return (g.amt ?? 0) < 0 ? 'A' : 'L'
    }
    const bySide: Record<'L' | 'A', unknown[][]> = { L: [], A: [] }
    let side: 'L' | 'A' = 'L'
    for (const it of items) {
      if (it.main) side = sideOf(it)
      const amt = it.amt === null ? null : side === 'L' ? it.amt : -it.amt
      bySide[side].push([(it.main ? '' : '  ') + it.name, amt === 0 ? 0 : amt, it.main ? 'G' : null]) // 'G' = a group line, even with no lines below it
    }
    // Tally's XML has no Total lines: each side's total is the sum of its group lines, so a difference between the sides shows as a warning
    const sideTotal = (rows: unknown[][]) => Math.round(rows.filter((r) => r[2] === 'G').reduce((a, r) => a + (typeof r[1] === 'number' ? r[1] : 0), 0) * 100) / 100
    out.push(['Liabilities', null], ...bySide.L, ['Total', sideTotal(bySide.L)], ['Assets', null], ...bySide.A, ['Total', sideTotal(bySide.A)])
  }
  return markFlat(out)
}

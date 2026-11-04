import type { Table } from './common'

/**
 * TallyPrime XML exports of the display reports → the same table shape the Excel readers produce, so one parser per
 * report serves both formats. This is a tolerant tag scanner (no DOM, so Node can use it too).
 * Trial Balance: DSPACCNAME + DSPCLDRAMTA / DSPCLCRAMTA. Stock Summary: DSPACCNAME + DSPCLQTY / DSPCLRATE / DSPCLAMTA.
 * Balance Sheet: BSNAME + BSAMT (BSSUBAMT / BSMAINAMT), liabilities and assets rows side by side.
 */
export type XmlReportKind = 'trial_balance' | 'stock_summary' | 'balance_sheet'

const decodeEntities = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block)
  return m ? decodeEntities((m[1] ?? '').replace(/<[^>]+>/g, '')).trim() : null
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

export function reportXmlToTable(xml: string, kind: XmlReportKind): Table {
  const out: unknown[][] = head(xml)
  if (kind === 'trial_balance') {
    out.push(['Particulars', 'Debit', 'Credit'])
    for (const m of xml.matchAll(/<DSPACCNAME>([\s\S]*?)<\/DSPACCNAME>\s*<DSPACCINFO>([\s\S]*?)<\/DSPACCINFO>/gi)) {
      const name = tag(m[1] ?? '', 'DSPDISPNAME')
      if (!name) continue
      const dr = num(tag(m[2] ?? '', 'DSPCLDRAMTA'))
      const cr = num(tag(m[2] ?? '', 'DSPCLCRAMTA'))
      out.push([name, dr === null ? null : Math.abs(dr), cr === null ? null : Math.abs(cr)])
    }
  } else if (kind === 'stock_summary') {
    out.push(['Particulars', 'Quantity', 'Rate', 'Value'])
    for (const m of xml.matchAll(/<DSPACCNAME>([\s\S]*?)<\/DSPACCNAME>\s*<DSPSTKINFO>([\s\S]*?)<\/DSPSTKINFO>/gi)) {
      const name = tag(m[1] ?? '', 'DSPDISPNAME')
      if (!name) continue
      out.push([name, tag(m[2] ?? '', 'DSPCLQTY'), tag(m[2] ?? '', 'DSPCLRATE'), num(tag(m[2] ?? '', 'DSPCLAMTA'))])
    }
  } else {
    out.push(['Particulars', 'Amount', 'Particulars', 'Amount'])
    const names = [...xml.matchAll(/<BSNAME>([\s\S]*?)<\/BSNAME>/gi)].map((m) => tag(m[1] ?? '', 'DSPDISPNAME') ?? '')
    const amts = [...xml.matchAll(/<BSAMT>([\s\S]*?)<\/BSAMT>/gi)].map((m) => num(tag(m[1] ?? '', 'BSMAINAMT')) ?? num(tag(m[1] ?? '', 'BSSUBAMT')))
    // Tally writes a liabilities entry and an assets entry per printed row
    for (let i = 0; i + 1 < names.length; i += 2) out.push([names[i] || null, amts[i] ?? null, names[i + 1] || null, amts[i + 1] ?? null])
  }
  return out
}

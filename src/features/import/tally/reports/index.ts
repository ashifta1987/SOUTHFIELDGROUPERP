import { ReportReadError, type Table } from './common'
import { parseBalanceSheet, type BalanceSheetParsed } from './balanceSheet'
import { parseStockSummary, type StockSummaryParsed } from './stockSummary'
import { parseTrialBalance, type TrialBalanceParsed } from './trialBalance'

export { parseDayBook, companyNameMatches, DAYBOOK_CHUNK, type DayBookRow, type DayBookSummary } from './dayBook'
export { parseTrialBalance, type TrialBalanceParsed, type TbLine } from './trialBalance'
export { parseStockSummary, type StockSummaryParsed, type StockLine } from './stockSummary'
export { parseBalanceSheet, type BalanceSheetParsed, type BsLine } from './balanceSheet'
export { reportXmlToTable, type XmlReportKind } from './xmlReports'
export { ReportReadError, sha256Hex, type Table } from './common'

export type ReportKind = 'trial_balance' | 'stock_summary' | 'balance_sheet'

/** A parsed display report, ready for api.stage_tally_report. */
export interface ParsedReport {
  kind: ReportKind
  lines: unknown[]
  /** what the file itself declares (Grand Total ...); the server recomputes the rest */
  totals: Record<string, unknown>
  grain: 'ledger' | 'group' | 'unknown'
  asOf: string | null
  periodFrom: string | null
  companyName: string | null
  warnings: { code: string; detail?: string }[]
  detail: TrialBalanceParsed | StockSummaryParsed | BalanceSheetParsed
}

export function parseReport(kind: ReportKind, table: Table): ParsedReport {
  if (kind === 'trial_balance') {
    const d = parseTrialBalance(table)
    // Tally's pseudo-ledgers for the stock valuation sit in the Trial Balance when they have a figure: say so (they are not real ledgers)
    const stockLines = d.lines.filter((l) => /^(opening|closing) stock$/i.test(l.name) && (l.dr !== 0 || l.cr !== 0))
    const warnings = stockLines.length > 0 ? [...d.warnings, { code: 'stock_valuation_line', detail: `${stockLines.length} line(s), Dr ${stockLines.reduce((s, l) => s + l.dr, 0)} / Cr ${stockLines.reduce((s, l) => s + l.cr, 0)}` }] : d.warnings
    return {
      kind,
      lines: d.lines,
      totals: { tally_dr: d.tallyDr, tally_cr: d.tallyCr, diff_dr: d.diffDr, diff_cr: d.diffCr },
      grain: d.grain,
      asOf: d.asOf,
      periodFrom: d.periodFrom,
      companyName: d.companyName,
      warnings,
      detail: d,
    }
  }
  if (kind === 'stock_summary') {
    const d = parseStockSummary(table)
    return { kind, lines: d.lines, totals: { tally_qty: d.tallyQty, tally_value: d.tallyValue }, grain: 'ledger', asOf: d.asOf, periodFrom: d.periodFrom, companyName: d.companyName, warnings: d.warnings, detail: d }
  }
  if (kind === 'balance_sheet') {
    const d = parseBalanceSheet(table)
    return { kind, lines: d.lines, totals: { tally_liabilities: d.liabilitiesTotal, tally_assets: d.assetsTotal }, grain: 'ledger', asOf: d.asOf, periodFrom: d.periodFrom, companyName: d.companyName, warnings: d.warnings, detail: d }
  }
  throw new ReportReadError('errKind')
}

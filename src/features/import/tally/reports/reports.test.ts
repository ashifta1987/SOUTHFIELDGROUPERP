import { describe, expect, it } from 'vitest'
import { readSheet } from 'read-excel-file/node'
import { buildXlsx } from '@/test/xlsxWriter'
import {
  companyNameMatches, parseBalanceSheet, parseDayBook, parseReport, parseStockSummary, parseTrialBalance, reportXmlToTable, ReportReadError, sha256Hex,
} from './index'
import { parseAmount, parseDate, parseQty } from './common'

// Everything here is synthetic: invented company, ledger and item names, round numbers.
const d = (s: string) => new Date(`${s}T00:00:00Z`)

const DAYBOOK_TITLES: unknown[][] = [
  ['Test Books Pvt Ltd'],
  ['1 Test Street'],
  ['Test Town'],
  ['Day Book'],
  ['1-Jan-01 to 3-Nov-26'],
  ['Date', 'Particulars', 'Vch Type', 'Vch No.', 'Debit Amount', 'Credit Amount'],
  [null, null, null, null, 'Inwards Qty', 'Outwards Qty'],
]

describe('cell helpers', () => {
  it('reads dates from datetimes, Excel serials and Tally text', () => {
    expect(parseDate(d('2021-04-01'))).toBe('2021-04-01')
    expect(parseDate('1-Apr-21')).toBe('2021-04-01')
    expect(parseDate('01-04-2021')).toBe('2021-04-01')
    expect(parseDate('2021-04-01')).toBe('2021-04-01')
    expect(parseDate('20210401')).toBe('2021-04-01')
    expect(parseDate(44287)).toBe('2021-04-01')
    expect(parseDate('Inwards Qty')).toBeNull()
    expect(parseDate('31-Feb-21')).toBeNull()
  })
  it('reads Indian amounts, brackets and Dr/Cr suffixes', () => {
    expect(parseAmount('1,23,456.50')?.value).toBe(123456.5)
    expect(parseAmount('(500)')?.value).toBe(-500)
    expect(parseAmount('1,000.00 Dr')).toEqual({ value: 1000, dc: 'D' })
    expect(parseAmount('2,000 Cr')).toEqual({ value: 2000, dc: 'C' })
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('abc')).toBeNull()
  })
  it('reads a quantity with its unit text', () => {
    expect(parseQty('125.500 Kg')).toEqual({ qty: 125.5, unit: 'Kg' })
    expect(parseQty('-5 Nos')).toEqual({ qty: -5, unit: 'Nos' })
    expect(parseQty(12)).toEqual({ qty: 12, unit: null })
    expect(parseQty('')).toBeNull()
  })
})

describe('Day Book', () => {
  const table: unknown[][] = [
    ...DAYBOOK_TITLES,
    [d('2021-04-01'), 'Test Cash', 'Receipt', 'R-1', null, 100],
    [d('2021-04-01'), 'Test Supplier A', 'Payment', 'P-1', 250.5, null],
    [d('2021-04-02'), 'Test Customer', 'SALES WO', '7', 80, null],
    [d('2021-04-02'), 'Test Customer', 'SALES WO', '7', 80, null], // exact duplicate line: a second voucher
    ['3-Apr-21', 'Test Ledger', 'Journal', '', 40, null], // text date, no voucher number
    [d('2021-04-04'), 'Test Item Move', 'Stock Journal', 'S-1', null, null], // no amount
    [null, 'Grand Total', null, null, 1000, 100], // total row
    [],
  ]
  const s = parseDayBook(table)

  it('finds the header by its names, skips title and sub-header rows and reads the company and period', () => {
    expect(s.companyName).toBe('Test Books Pvt Ltd')
    expect(s.periodFrom).toBe('2001-01-01')
    expect(s.periodTo).toBe('2026-11-03')
    expect(s.rows).toHaveLength(6)
    expect(s.dateFrom).toBe('2021-04-01')
    expect(s.dateTo).toBe('2021-04-04')
  })
  it('keeps debit and credit as dr / cr with a positive amount', () => {
    expect(s.rows[0]?.payload).toMatchObject({ type: 'Receipt', number: 'R-1', date: '2021-04-01', amount: 100, dc: 'cr', party: 'Test Cash' })
    expect(s.rows[1]?.payload).toMatchObject({ type: 'Payment', amount: 250.5, dc: 'dr' })
    expect(s.rows[5]?.payload).toMatchObject({ amount: 0, dc: null })
    expect(s.rows[4]?.payload).toMatchObject({ date: '2021-04-03', number: null })
  })
  it('gives two identical lines in one file two different keys, and the same file the same keys', () => {
    const k = s.rows.map((r) => r.payload.match_key)
    expect(new Set(k).size).toBe(k.length)
    expect(k[2]).toBe('SALES WO|7|2021-04-02|80.00|Test Customer|dr')
    expect(k[3]).toBe(`${k[2]}|#2`)
    expect(parseDayBook(table).rows.map((r) => r.payload.match_key)).toEqual(k)
  })
  it('summarises by voucher type with Dr/Cr totals and counts warnings', () => {
    expect(s.totalDr).toBe(450.5)
    expect(s.totalCr).toBe(100)
    expect(s.byType.find((t) => t.type === 'SALES WO')).toMatchObject({ count: 2, dr: 160, cr: 0 })
    expect(s.warnings.find((w) => w.code === 'identical_lines')?.count).toBe(1)
    expect(s.warnings.find((w) => w.code === 'no_amount')?.count).toBe(1)
  })
  it('rejects a sheet without the Day Book header', () => {
    expect(() => parseDayBook([['a', 'b'], [1, 2]])).toThrow(ReportReadError)
  })
  it('reads 45,000+ lines quickly', () => {
    const big: unknown[][] = [...DAYBOOK_TITLES]
    for (let i = 0; i < 46000; i++) big.push([d('2021-04-01'), `Party ${i % 700}`, i % 2 ? 'Payment' : 'Receipt', String(i), i % 2 ? 10 + (i % 90) : null, i % 2 ? null : 10 + (i % 90)])
    const t0 = Date.now()
    const r = parseDayBook(big)
    expect(r.rows).toHaveLength(46000)
    expect(Date.now() - t0).toBeLessThan(5000)
  })
  it('matches the company named in the file against the chosen company', () => {
    expect(companyNameMatches('Test Books Pvt Ltd', ['Test Books Private Limited'])).toBe(true)
    expect(companyNameMatches('Other Works Ltd', ['Test Books Pvt Ltd', 'TB'])).toBe(false)
    expect(companyNameMatches(null, ['x'])).toBe(true)
  })
  it('round-trips through a real .xlsx file (dates stay dates)', async () => {
    const bytes = buildXlsx(table, 'Day Book')
    // Node's reader takes a Buffer (Buffer reached through globalThis: the app tsconfig has no Node types)
    const nodeBuffer = (globalThis as unknown as { Buffer: { from(b: Uint8Array): never } }).Buffer
    const read = (await readSheet(nodeBuffer.from(bytes))) as unknown[][]
    const r = parseDayBook(read)
    expect(r.rows).toHaveLength(6)
    expect(r.rows[0]?.payload.date).toBe('2021-04-01')
    expect(await sha256Hex(bytes)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('Trial Balance', () => {
  const head: unknown[][] = [['Test Books Pvt Ltd'], ['Trial Balance'], ['1-Apr-25 to 31-Mar-26']]
  const twoRowHeader: unknown[][] = [
    ['Particulars', 'Opening Balance', null, 'Transactions', null, 'Closing Balance', null],
    [null, 'Debit', 'Credit', 'Debit', 'Credit', 'Debit', 'Credit'],
  ]
  it('reads a ledger-wise sheet: group rows from sums, closing Dr/Cr columns, grand total and the difference row', () => {
    const t = parseTrialBalance([
      ...head,
      ...twoRowHeader,
      ['Capital Account', null, 500, null, null, null, 500],
      ['Test Partner Capital', null, 500, null, null, null, 500],
      ['Current Assets', 100, null, 50, null, 450, null],
      ['Cash-in-hand', 20, null, 10, null, 30, null],
      ['Test Cash', 20, null, 10, null, 30, null],
      ['Sundry Debtors', 80, null, 40, null, 120, null],
      ['Test Customer One', 50, null, 20, null, 70, null],
      ['Test Customer Two', 30, null, 20, null, 50, null],
      ['Test Fixed Item', null, null, null, null, 300, null],
      ['Diff. in opening balances', null, 400, null, null, null, null],
      ['Grand Total', 100, 900, 50, null, 450, 500],
    ])
    expect(t.asOf).toBe('2026-03-31')
    expect(t.periodFrom).toBe('2025-04-01')
    expect(t.grain).toBe('ledger')
    const byName = Object.fromEntries(t.lines.map((l) => [l.name, l]))
    expect(byName['Capital Account']?.is_group).toBe(true)
    expect(byName['Test Partner Capital']).toMatchObject({ is_group: false, cr: 500, dr: 0, parents: ['Capital Account'] })
    expect(byName['Sundry Debtors']?.is_group).toBe(true)
    expect(byName['Test Customer One']).toMatchObject({ is_group: false, dr: 70, parents: ['Sundry Debtors', 'Current Assets'] })
    expect(byName['Cash-in-hand']?.is_group).toBe(true)
    expect(t.tallyDr).toBe(450)
    expect(t.tallyCr).toBe(500)
    expect(t.diffCr).toBe(0)
    expect(t.warnings.map((w) => w.code)).toEqual(expect.arrayContaining([]))
  })

  it('works on plain Debit / Credit columns and records Grand Total and the opening difference', () => {
    const t = parseTrialBalance([
      ...head,
      ['Particulars', 'Debit', 'Credit'],
      ['Test Ledger A', 600, null],
      ['Test Ledger B', null, 500],
      ['Test Ledger C', null, 90],
      ['Diff in Opening Balances', null, 10],
      ['Grand Total', 600, 600],
    ])
    expect(t.lines.every((l) => !l.is_group)).toBe(true)
    expect(t.ledgerDr).toBe(600)
    expect(t.ledgerCr).toBe(590)
    expect(t.diffCr).toBe(10)
    expect(t.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['opening_difference', 'grand_total_differs']))
  })

  it('uses indentation when the names carry it', () => {
    const t = parseTrialBalance([
      ...head,
      ['Particulars', 'Debit', 'Credit'],
      ['Test Group', 300, null],
      ['  Test One', 100, null],
      ['  Test Two', 200, null],
      ['Test Other', null, 300],
      ['Grand Total', 300, 300],
    ])
    expect(t.lines.find((l) => l.name === 'Test Group')?.is_group).toBe(true)
    expect(t.lines.find((l) => l.name === 'Test Two')?.parents).toEqual(['Test Group'])
    expect(t.ledgerDr).toBe(300)
  })

  it('says so when the sheet lists groups only', () => {
    const t = parseTrialBalance([
      ...head,
      ['Particulars', 'Debit', 'Credit'],
      ['Capital Account', null, 700],
      ['Current Assets', 400, null],
      ['Sundry Debtors', 300, null],
      ['Grand Total', 700, 700],
    ])
    expect(t.grain).toBe('group')
  })

  it('reads one column with Dr / Cr suffixes', () => {
    const t = parseTrialBalance([
      ...head,
      ['Particulars', 'Closing Balance'],
      ['Test A', '100.00 Dr'],
      ['Test B', '100.00 Cr'],
    ])
    expect(t.ledgerDr).toBe(100)
    expect(t.ledgerCr).toBe(100)
  })

  it('rejects a sheet without Particulars', () => {
    expect(() => parseTrialBalance([['x'], ['y']])).toThrow(ReportReadError)
  })
})

describe('Stock Summary', () => {
  const head: unknown[][] = [['Test Plastics Pvt Ltd'], ['Stock Summary'], ['1-Apr-26 to 31-Oct-26']]
  it('reads closing quantity with unit text, rate and value, finds stock groups and as-of', () => {
    const s = parseStockSummary([
      ...head,
      ['Particulars', 'Closing Balance', null, null],
      [null, 'Quantity', 'Rate', 'Value'],
      ['Test Raw Materials', null, null, 3000],
      ['Test Resin', '125.500 Kg', 20, 2510],
      ['Test Pigment', '10 Kg', 49, 490],
      ['Test Finished Goods', null, null, 600],
      ['Test Mixer Jar', '300 Nos', '2.00/Nos', 600],
      ['Test Negative Item', '-5 Nos', 10, -50],
      ['Grand Total', null, null, 3550],
    ])
    expect(s.asOf).toBe('2026-10-31')
    expect(s.itemCount).toBe(4)
    expect(s.groupCount).toBe(2)
    expect(s.lines.find((l) => l.name === 'Test Resin')).toMatchObject({ qty: 125.5, unit: 'Kg', rate: 20, value: 2510, is_group: false, parents: ['Test Raw Materials'] })
    expect(s.lines.find((l) => l.name === 'Test Mixer Jar')?.rate).toBe(2)
    expect(s.negativeOrZero).toBe(1)
    expect(s.tallyValue).toBe(3550)
    expect(s.itemValue).toBe(3550)
    expect(s.warnings).toHaveLength(0)
  })
  it('also reads a plain Quantity | Rate | Value sheet', () => {
    const s = parseStockSummary([...head, ['Particulars', 'Quantity', 'Rate', 'Value'], ['Test A', '2 Nos', 5, 10], ['Test B', '1 Nos', 5, 5]])
    expect(s.itemValue).toBe(15)
    expect(s.groupCount).toBe(0)
  })
  it('reports a missing column', () => {
    expect(() => parseStockSummary([['Particulars', 'Foo'], ['x', 1]])).toThrow(ReportReadError)
  })
})

describe('Balance Sheet', () => {
  const head: unknown[][] = [['Test Books Pvt Ltd'], ['Balance Sheet'], ['as at 31-Mar-26']]
  it('reads the horizontal 4-column layout (liabilities left, assets right) with groups and totals', () => {
    const b = parseBalanceSheet([
      ...head,
      ['Liabilities', 'Amount', 'Assets', 'Amount'],
      ['Capital Account', 500, 'Fixed Assets', 300],
      ['Test Partner Capital', 500, 'Test Machine', 300],
      ['Current Liabilities', 200, 'Current Assets', 400],
      ['Sundry Creditors', 200, 'Sundry Debtors', 400],
      ['Total', 700, 'Total', 700],
    ])
    expect(b.layout).toBe('horizontal')
    expect(b.asOf).toBe('2026-03-31')
    expect(b.liabilitiesTotal).toBe(700)
    expect(b.assetsTotal).toBe(700)
    const l = (side: string, name: string) => b.lines.find((x) => x.side === side && x.name === name)
    expect(l('L', 'Capital Account')).toMatchObject({ is_group: true, depth: 0, amount: 500 })
    expect(l('L', 'Test Partner Capital')).toMatchObject({ is_group: false, depth: 1 })
    expect(l('A', 'Current Assets')).toMatchObject({ is_group: true, amount: 400 })
    expect(b.warnings).toHaveLength(0)
  })
  it('reads the vertical layout with Liabilities and Assets sections', () => {
    const b = parseBalanceSheet([
      ...head,
      ['Particulars', 'Amount'],
      ['Liabilities', null],
      ['Capital Account', 500],
      ['Total', 500],
      ['Assets', null],
      ['Fixed Assets', 500],
      ['Total', 500],
    ])
    expect(b.layout).toBe('vertical')
    expect(b.lines.filter((x) => x.is_total).map((x) => `${x.side}${x.amount}`)).toEqual(['L500', 'A500'])
    expect(b.lines.find((x) => x.name === 'Fixed Assets')?.side).toBe('A')
  })
  it('flags sides that differ', () => {
    const b = parseBalanceSheet([...head, ['Liabilities', 'Amount', 'Assets', 'Amount'], ['Capital Account', 500, 'Fixed Assets', 400], ['Total', 500, 'Total', 400]])
    expect(b.warnings.map((w) => w.code)).toContain('sides_differ')
  })
})

describe('XML exports', () => {
  it('turns a Trial Balance XML into the same table the Excel reader gets', () => {
    const xml = `<ENVELOPE><SVCURRENTCOMPANY>Test Books</SVCURRENTCOMPANY><SVFROMDATE>20250401</SVFROMDATE><SVTODATE>20260331</SVTODATE>
      <DSPACCNAME><DSPDISPNAME>Test A</DSPDISPNAME></DSPACCNAME><DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA>-100.00</DSPCLDRAMTA></DSPCLDRAMT><DSPCLCRAMT><DSPCLCRAMTA></DSPCLCRAMTA></DSPCLCRAMT></DSPACCINFO>
      <DSPACCNAME><DSPDISPNAME>Test &amp; B</DSPDISPNAME></DSPACCNAME><DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA></DSPCLDRAMTA></DSPCLDRAMT><DSPCLCRAMT><DSPCLCRAMTA>100.00</DSPCLCRAMTA></DSPCLCRAMT></DSPACCINFO></ENVELOPE>`
    const p = parseReport('trial_balance', reportXmlToTable(xml, 'trial_balance'))
    expect(p.asOf).toBe('2026-03-31')
    expect(p.companyName).toBe('Test Books')
    expect(p.lines).toMatchObject([{ name: 'Test A', dr: 100, cr: 0 }, { name: 'Test & B', dr: 0, cr: 100 }])
  })
  it('turns a Stock Summary XML into items', () => {
    const xml = `<ENVELOPE><DSPACCNAME><DSPDISPNAME>Test Item</DSPDISPNAME></DSPACCNAME><DSPSTKINFO><DSPSTKCL><DSPCLQTY> 5 Nos</DSPCLQTY><DSPCLRATE>10.00/Nos</DSPCLRATE><DSPCLAMTA>50.00</DSPCLAMTA></DSPSTKCL></DSPSTKINFO></ENVELOPE>`
    const p = parseReport('stock_summary', reportXmlToTable(xml, 'stock_summary'))
    expect(p.lines).toMatchObject([{ name: 'Test Item', qty: 5, unit: 'Nos', rate: 10, value: 50 }])
  })
})

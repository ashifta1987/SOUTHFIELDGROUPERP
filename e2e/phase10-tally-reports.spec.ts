import { expect, test, type Page } from '@playwright/test'
import { buildXlsx } from '../src/test/xlsxWriter'
import { expectNoSeriousA11y, hasCreds, creds, signInWithEmail } from './helpers'
import { createPhase4Company, todayIst } from './phase4-setup'

/** Yesterday in IST: the database's own "today" can still be the previous day just after midnight IST. */
function yesterdayIst(): string {
  const [y, m, d] = todayIst().split('-').map(Number)
  return new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, (d ?? 1) - 1)).toISOString().slice(0, 10)
}

/**
 * Tally reports import (Day Book, Trial Balance, Stock Summary, Balance Sheet) on a fresh synthetic company (E2EK…),
 * never SFB or SFP. Every workbook is generated here from invented names and round numbers (no real data):
 *  - Day Book: pre-load summary and company-name warning, two identical lines both load, the same file again loads nothing
 *  - Trial Balance: a group-wise sheet is refused; a ledger-wise one is stored (twice = once), set as opening balances by
 *    Admin (DB: opening_balance / opening_dc / opening_as_of, no posting), and compares as all-match
 *  - Stock Summary: an unknown item stops the apply, is mapped to an existing product, then the opening stock posts (DB)
 *  - Balance Sheet: stored for reconciliation and compared with the ERP groups
 * axe on every step.
 */
const d = (s: string) => new Date(`${s}T00:00:00Z`)

test.describe('Tally reports import', () => {
  test.skip(!hasCreds, 'needs .env.test.local')
  test.setTimeout(240_000)

  async function chooseSource(page: Page, name: RegExp) {
    await page.getByRole('group', { name: 'What to import' }).getByRole('button', { name }).click()
  }

  test('Day Book, Trial Balance, Stock Summary and Balance Sheet from synthetic Excel files', async ({ page }) => {
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const s = await createPhase4Company(page)
    const tag = s.code.slice(4)
    const api = s.api

    // The Tally groups the Trial Balance and Balance Sheet use are mapped to this company's own groups.
    const groups = await api.view<{ id: string; name: string }>('account_groups', `company_id=eq.${s.companyId}&select=id,name`)
    const gid = (n: string) => groups.find((g) => g.name === n)?.id as string
    await api.rpc('set_tally_group_map', { p_company_id: s.companyId, p_tally_group: 'Sundry Debtors', p_account_group_id: gid('E2E Test Debtors') })
    await api.rpc('set_tally_group_map', { p_company_id: s.companyId, p_tally_group: 'Sundry Creditors', p_account_group_id: gid('E2E Test Creditors') })

    const open = async () => {
      await page.goto(`/admin/import-data?company=${s.companyId}`)
      await expect(page.getByRole('heading', { level: 1, name: 'Import data' })).toBeVisible()
    }
    const fileInput = () => page.getByLabel('Tally report file')
    const xlsx = (name: string, rows: unknown[][]) => ({ name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(buildXlsx(rows, 'Sheet1')) })

    // ───────────── Day Book ─────────────
    const cust = `E2E Cust ${tag}`
    const supp = `E2E Supp ${tag}`
    const dayBook = xlsx(`daybook-${tag}.xlsx`, [
      [`E2E Different Books ${tag}`],
      ['E2E Test Road'],
      ['Day Book'],
      ['1-Apr-21 to 30-Apr-21'],
      ['Date', 'Particulars', 'Vch Type', 'Vch No.', 'Debit Amount', 'Credit Amount'],
      [null, null, null, null, 'Inwards Qty', 'Outwards Qty'],
      [d('2021-04-01'), cust, 'Receipt', 'R-1', null, 100],
      [d('2021-04-02'), cust, 'SALES WO', '7', 80, null],
      [d('2021-04-02'), cust, 'SALES WO', '7', 80, null],
      ['3-Apr-21', supp, 'Payment', 'P-1', 40, null],
      [d('2021-04-04'), 'E2E Stock move', 'Stock Journal', 'S-1', null, null],
    ])
    await open()
    await chooseSource(page, /Day Book/)
    await expect(page.getByText('How to export from TallyPrime')).toBeVisible()
    await fileInput().setInputFiles(dayBook)
    await expect(page.getByRole('heading', { level: 2, name: `${dayBook.name} · 5 lines read` })).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: `E2E Different Books ${tag}` })).toBeVisible() // company-name warning
    const byType = page.getByRole('region', { name: 'By voucher type' })
    await expect(byType.getByRole('row').filter({ hasText: 'SALES WO' })).toContainText('2')
    await expect(page.getByText('Total debit 200.00 · total credit 100.00')).toBeVisible()
    await expectNoSeriousA11y(page)
    await page.getByRole('button', { name: 'Load 5 lines' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Load 5 lines' }).click()
    await expect(page.getByRole('heading', { level: 2, name: /Day Book loaded/ })).toBeVisible({ timeout: 120_000 })
    await expectNoSeriousA11y(page)

    const vouchers = await api.view<{ voucher_type: string; voucher_no: string | null; amount: number; dc: string | null }>('tally_vouchers', `company_id=eq.${s.companyId}&select=voucher_type,voucher_no,amount,dc`)
    expect(vouchers).toHaveLength(5)
    expect(vouchers.filter((v) => v.voucher_type === 'SALES WO')).toHaveLength(2) // both identical lines loaded
    expect(vouchers.find((v) => v.voucher_no === 'R-1')?.dc).toBe('C')
    expect(vouchers.find((v) => v.voucher_no === 'P-1')?.dc).toBe('D')
    expect((await api.view('vouchers', `company_id=eq.${s.companyId}&select=id`).catch(() => []))).toHaveLength(0) // nothing posted to the books

    await open()
    await chooseSource(page, /Day Book/)
    await fileInput().setInputFiles(dayBook)
    await page.getByRole('button', { name: 'Load 5 lines' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Load 5 lines' }).click()
    await expect(page.getByRole('heading', { level: 2, name: /Day Book loaded/ })).toBeVisible({ timeout: 120_000 })
    expect(await api.view('tally_vouchers', `company_id=eq.${s.companyId}&select=id`)).toHaveLength(5) // the same file again adds nothing
    const result = page.getByRole('region', { name: 'Result by type' })
    await expect(result.getByRole('row').nth(1).getByRole('cell').nth(1)).toHaveText('5') // 5 skipped

    // ───────────── Trial Balance ─────────────
    const tbTitle = [[`E2E Test Stock Company ${tag}`], ['Trial Balance'], ['1-Apr-25 to 31-Mar-26']]
    const groupWise = xlsx(`tb-groups-${tag}.xlsx`, [...tbTitle, ['Particulars', 'Debit', 'Credit'], ['Current Assets', 500, null], ['Capital Account', null, 500], ['Grand Total', 500, 500]])
    await open()
    await chooseSource(page, /Trial Balance/)
    await fileInput().setInputFiles(groupWise)
    await expect(page.getByText(/lists groups only/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Store report' })).toBeDisabled()
    await expectNoSeriousA11y(page)

    const ledgerWise = xlsx(`tb-ledgers-${tag}.xlsx`, [
      ...tbTitle,
      ['Particulars', 'Debit', 'Credit'],
      ['Sundry Debtors', 500, null],
      [cust, 500, null],
      ['Sundry Creditors', null, 500],
      [supp, null, 500],
      ['Grand Total', 500, 500],
    ])
    await open()
    await chooseSource(page, /Trial Balance/)
    await fileInput().setInputFiles(ledgerWise)
    await expect(page.getByText('2 ledgers · 2 group lines')).toBeVisible()
    await expect(page.getByText('Debit and credit are equal.')).toBeVisible()
    await expect(page.getByLabel('As of date')).toHaveValue('2026-03-31')
    await expectNoSeriousA11y(page)
    await page.getByRole('button', { name: 'Store report' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Store report' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'Trial Balance stored' })).toBeVisible({ timeout: 60_000 })
    const panel = page.getByRole('heading', { level: 2, name: 'Trial Balance · as of 31-03-2026' })
    await expect(panel).toBeVisible()
    await expectNoSeriousA11y(page)
    const reports = await api.view<{ id: string; status: string }>('tally_reports', `company_id=eq.${s.companyId}&kind=eq.trial_balance&select=id,status`)
    expect(reports).toHaveLength(1)
    expect(reports[0]?.status).toBe('staged')

    // Same file again: recognised, nothing new stored.
    await open()
    await chooseSource(page, /Trial Balance/)
    await fileInput().setInputFiles(ledgerWise)
    await page.getByRole('button', { name: 'Store report' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Store report' }).click()
    await expect(page.getByText(/This exact file was already stored/)).toBeVisible({ timeout: 60_000 })
    expect(await api.view('tally_reports', `company_id=eq.${s.companyId}&kind=eq.trial_balance&select=id`)).toHaveLength(1)

    // Apply as opening balances (Admin).
    await page.getByRole('button', { name: 'Set as opening balances' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Set as opening balances' }).click()
    await expect(page.getByText(/Opening balances set for 2 ledgers/)).toBeVisible({ timeout: 60_000 })
    const accs = await api.view<{ name: string; opening_balance: number; opening_dc: string; opening_as_of: string }>('accounts', `company_id=eq.${s.companyId}&name=in.("${cust}","${supp}")&select=name,opening_balance,opening_dc,opening_as_of`)
    expect(accs.find((a) => a.name === cust)).toMatchObject({ opening_balance: 500, opening_dc: 'D', opening_as_of: '2026-03-31' })
    expect(accs.find((a) => a.name === supp)).toMatchObject({ opening_balance: 500, opening_dc: 'C' })
    expect((await api.view<{ status: string }>('tally_reports', `id=eq.${reports[0]?.id}&select=status`))[0]?.status).toBe('applied')
    await expectNoSeriousA11y(page)

    // Compare with the ERP trial balance: everything agrees.
    await page.getByRole('button', { name: 'Compare', exact: true }).first().click()
    await expect(page.getByRole('region', { name: 'Trial Balance differences' })).toBeVisible()
    await expect(page.getByText('2 match · 0 differ')).toBeVisible()
    await expectNoSeriousA11y(page)

    // ───────────── Stock Summary ─────────────
    const resin = `E2E Test Resin ${tag}`
    const unknown = `E2E Test Unknown ${tag}`
    const stock = xlsx(`stock-${tag}.xlsx`, [
      [`E2E Test Stock Company ${tag}`],
      ['Stock Summary'],
      [`as at ${yesterdayIst()}`],
      ['Particulars', 'Closing Balance', null, null],
      [null, 'Quantity', 'Rate', 'Value'],
      [resin, '10 Kg', 5, 50],
      [unknown, '4 Kg', 5, 20],
      ['Grand Total', null, null, 70],
    ])
    await open()
    await chooseSource(page, /Stock Summary/)
    await fileInput().setInputFiles(stock)
    await expect(page.getByText('2 items · 0 group lines')).toBeVisible()
    await expect(page.getByText('Items add up to value 70.00')).toBeVisible()
    await expectNoSeriousA11y(page)
    await page.getByRole('button', { name: 'Store report' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Store report' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'Stock Summary stored' })).toBeVisible({ timeout: 60_000 })
    await page.getByLabel('Store that receives the stock').selectOption({ label: `S${tag} · ${s.stores.name}` })
    await page.getByRole('button', { name: 'Post opening stock' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Post opening stock' }).click()
    await expect(page.getByText('Items not in the product list')).toBeVisible({ timeout: 60_000 })
    expect(await api.view('stock_on_hand', `company_id=eq.${s.companyId}&select=id`)).toHaveLength(0) // nothing posted yet
    await expectNoSeriousA11y(page)
    await page.getByLabel(`Map to product ${unknown}`).selectOption({ label: `${s.items.plain.code} · ${s.items.plain.name}` })
    await page.getByRole('button', { name: `Map ${unknown}` }).click()
    await expect(page.getByText(`Mapped “${unknown}”.`)).toBeVisible()
    await page.getByRole('button', { name: 'Post opening stock' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Post opening stock' }).click()
    await expect(page.getByText(/Opening stock posted for 2 items/)).toBeVisible({ timeout: 60_000 })
    const onHand = await api.view<{ product_code: string; qty: number; bucket: string }>('stock_on_hand', `company_id=eq.${s.companyId}&select=product_code,qty,bucket`)
    expect(onHand.find((r) => r.product_code === s.items.tested.code)).toMatchObject({ qty: 10 })
    expect(onHand.find((r) => r.product_code === s.items.plain.code)).toMatchObject({ qty: 4 })
    await expect(page.getByRole('button', { name: 'Post opening stock' })).toHaveCount(0) // applied once: the button is gone
    await expectNoSeriousA11y(page)

    // ───────────── Balance Sheet ─────────────
    const bs = xlsx(`bs-${tag}.xlsx`, [
      [`E2E Test Stock Company ${tag}`],
      ['Balance Sheet'],
      ['as at 31-Mar-26'],
      ['Liabilities', 'Amount', 'Assets', 'Amount'],
      ['Sundry Creditors', 500, 'Sundry Debtors', 500],
      ['Total', 500, 'Total', 500],
    ])
    await open()
    await chooseSource(page, /Balance Sheet/)
    await fileInput().setInputFiles(bs)
    await expect(page.getByText(/Liabilities 500.00 · Assets 500.00/)).toBeVisible()
    await expectNoSeriousA11y(page)
    await page.getByRole('button', { name: 'Store report' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Store report' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'Balance Sheet stored' })).toBeVisible({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Compare', exact: true }).first().click()
    await expect(page.getByRole('region', { name: 'Balance Sheet group differences' })).toBeVisible()
    await expect(page.getByText(/· 0 differ/)).toBeVisible()
    await expectNoSeriousA11y(page)
    expect(await api.view('tally_reports', `company_id=eq.${s.companyId}&select=id`)).toHaveLength(3)

    // The history list shows every stored report with its status.
    const list = page.getByRole('region', { name: 'Trial Balance, Stock Summary and Balance Sheet reports' })
    await expect(list.getByRole('row').filter({ hasText: 'Applied' })).toHaveCount(2)
    await expectNoSeriousA11y(page)
  })
})

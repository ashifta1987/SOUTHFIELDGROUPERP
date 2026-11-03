import { expect, test, type Page } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'
import { rand4 } from './phase2-parties-helpers'
import { ensureMoneySetup } from './phase3-money-setup'
import { restAsSignedInUser, type Rest } from './phase3-sales-setup'

/**
 * Phase 3 money screens against the DEV database: Bank → Set-up (a cash account and a posting rule through the
 * screen), the cash book (receipt, payment, the ₹2 lakh refusal, a payment over the cash limit with a reason), the
 * cash book check, bank statement import and matching, a supplier bill posted and paid, cash flow and the phone cash
 * entry — with the database state asserted through the API and an axe check on every screen. Synthetic data only.
 */

function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}
function ddmmyyyy(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d}-${m}-${y}`
}

interface GlLine {
  account_id: string
  party_id: string | null
  dr: number
  cr: number
}

async function voucherByNo(api: Rest, companyId: string, docNo: string) {
  const [v] = await api.view<{ id: string; amount: number; mode: string | null; status: string; cash_reason: string | null; voucher_type: string }>(
    'vouchers',
    `company_id=eq.${companyId}&doc_no=eq.${encodeURIComponent(docNo)}&select=id,amount,mode,status,cash_reason,voucher_type`,
  )
  if (!v) throw new Error(`voucher ${docNo} not found`)
  const lines = await api.view<GlLine>('gl_lines', `voucher_id=eq.${v.id}&select=account_id,party_id,dr,cr`)
  return { v, lines }
}

async function postedNo(page: Page, re: RegExp): Promise<string> {
  const status = page.getByRole('status').filter({ hasText: re })
  await expect(status).toBeVisible({ timeout: 20_000 })
  return ((await status.textContent()) ?? '').match(re)?.[1] ?? ''
}

test.describe('Phase 3 · Money and books', () => {
  test.skip(!hasCreds, 'needs .env.test.local')

  test('Set-up through Bank, then the cash book posts a receipt and a payment, refuses cash at the limit, flags cash over the limit; the check view and phone entry agree', async ({ page }) => {
    test.setTimeout(300_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const s = await ensureMoneySetup(page)
    const api = await restAsSignedInUser(page)

    // ── Bank → Set-up: a new cash account and the purchase posting rule, through the screen ──
    const cashName = `E2E Test Cash ${rand4()}${rand4()}`
    await page.goto(`/accounts/bank?company=${s.companyId}&tab=setup`)
    await expect(page.getByRole('heading', { level: 1, name: 'Bank reconciliation' })).toBeVisible()
    await page.getByRole('button', { name: 'Add cash account' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Account name').fill(cashName)
    await dialog.getByLabel('Account group').selectOption({ label: 'E2E Test Cash and Bank · asset' })
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('table', { name: 'Cash and bank accounts' }).getByRole('row').filter({ hasText: cashName })).toBeVisible({ timeout: 15_000 })
    const [cash] = await api.view<{ id: string; kind: string }>('money_accounts', `company_id=eq.${s.companyId}&name=eq.${encodeURIComponent(cashName)}&select=id,kind`)
    expect(cash?.kind).toBe('cash')
    const cashId = cash?.id ?? ''

    const [rule] = await api.view<{ account_id: string }>('posting_rules', `company_id=eq.${s.companyId}&event=eq.purchase.taxable&select=account_id`)
    const target = s.purchaseAccounts.find((a) => a.id !== rule?.account_id) ?? s.purchaseAccounts[0]
    if (!target) throw new Error('no purchase account')
    await page.getByLabel('Account for Purchases', { exact: true }).selectOption({ label: target.label })
    await expect.poll(async () => (await api.view<{ account_id: string }>('posting_rules', `company_id=eq.${s.companyId}&event=eq.purchase.taxable&select=account_id`))[0]?.account_id, { timeout: 15_000 }).toBe(target.id)
    await expectNoSeriousA11y(page)

    // ── Cash book: receipt from the customer ──
    await page.goto(`/accounts/cash-book?company=${s.companyId}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Cash book' })).toBeVisible()
    await page.getByLabel('Cash account').selectOption({ label: cashName })
    await page.getByLabel('Received from (party)').selectOption({ label: s.customer.name })
    await page.getByLabel('Amount', { exact: true }).fill('15000')
    await page.getByRole('button', { name: 'Post receipt' }).click()
    const receiptNo = await postedNo(page, /Posted (ERC\/[0-9-]+\/[0-9]+)/)
    const rec = await voucherByNo(api, s.companyId, receiptNo)
    expect(rec.v.voucher_type).toBe('receipt')
    expect(rec.v.mode).toBe('cash')
    expect(Number(rec.v.amount)).toBe(15000)
    expect(rec.lines).toHaveLength(2)
    expect(rec.lines.find((l) => l.account_id === cashId && Number(l.dr) === 15000)).toBeTruthy()
    expect(rec.lines.find((l) => l.party_id === s.customer.id && Number(l.cr) === 15000)).toBeTruthy()

    // ── Payment to the supplier ──
    await page.getByRole('tab', { name: 'Paid out' }).click()
    await page.getByLabel('Paid to (party)').selectOption({ label: s.supplier.name })
    await page.getByLabel('Amount', { exact: true }).fill('400')
    await page.getByRole('button', { name: 'Post payment' }).click()
    const paymentNo = await postedNo(page, /Posted (EPY\/[0-9-]+\/[0-9]+)/)
    const pay = await voucherByNo(api, s.companyId, paymentNo)
    expect(pay.v.voucher_type).toBe('payment')
    expect(pay.lines.find((l) => l.account_id === cashId && Number(l.cr) === 400)).toBeTruthy()
    expect(pay.lines.find((l) => l.party_id === s.supplier.id && Number(l.dr) === 400)).toBeTruthy()

    // ── Cash receipt that takes the customer to ₹2 lakh in a day: refused by the database ──
    await page.getByRole('tab', { name: 'Received' }).click()
    await page.getByLabel('Received from (party)').selectOption({ label: s.customer.name })
    await page.getByLabel('Amount', { exact: true }).fill('200000')
    await page.getByRole('button', { name: 'Post receipt' }).click()
    await expect(page.getByText(/Refused: this cash takes one person to the daily cash receipt limit/)).toBeVisible({ timeout: 15_000 })
    const receipts = await api.view<{ id: string }>('vouchers', `company_id=eq.${s.companyId}&party_id=eq.${s.customer.id}&voucher_type=eq.receipt&select=id`)
    expect(receipts).toHaveLength(1)

    // ── Cash payment over the daily limit: needs a reason, then posts flagged ──
    await page.getByRole('tab', { name: 'Paid out' }).click()
    await page.getByLabel('Paid to (party)').selectOption({ label: s.supplier.name })
    await page.getByLabel('Amount', { exact: true }).fill('10000')
    await page.getByRole('button', { name: 'Post payment' }).click()
    await expect(page.getByText('Over the daily cash limit to one person.')).toBeVisible({ timeout: 15_000 })
    await page.getByLabel('Why it must be cash (Admin sees this)').fill('E2E test reason for cash')
    await page.getByRole('button', { name: 'Pay in cash with this reason' }).click()
    const flaggedNo = await postedNo(page, /Posted (EPY\/[0-9-]+\/[0-9]+)/)
    expect(flaggedNo).not.toBe(paymentNo)
    await expect(page.getByRole('status').getByText('Flagged for Admin')).toBeVisible()
    const flagged = await voucherByNo(api, s.companyId, flaggedNo)
    expect(flagged.v.cash_reason).toBe('E2E test reason for cash')
    await expect(page.getByRole('row').filter({ hasText: flaggedNo })).toContainText('Flagged for Admin')
    await expectNoSeriousA11y(page)

    // ── Cash book check: the server's month figures for this cash account ──
    await page.goto(`/accounts/cash-book/cash-book-check?company=${s.companyId}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Cash book check' })).toBeVisible()
    await page.getByLabel('Cash account').selectOption({ label: cashName })
    await expect(page.getByTestId('check-closing')).toContainText('4,600.00', { timeout: 15_000 })
    await expect(page.getByTestId('flagged')).toContainText('1 cash payment over the daily limit')
    await expect(page.getByRole('list', { name: 'Where the cash went' })).toContainText(s.supplier.name)
    await expectNoSeriousA11y(page)

    // ── Cash entry on the phone ──
    await page.goto(`/me/cash-entry?company=${s.companyId}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Cash entry' })).toBeVisible()
    await expect(page.getByTestId('box-balance')).toContainText('₹')
    await expectNoSeriousA11y(page)
  })

  test('A bank statement is imported and its line matched to the bank receipt in the books', async ({ page }) => {
    test.setTimeout(240_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const s = await ensureMoneySetup(page)
    const api = await restAsSignedInUser(page)
    const [bank] = await api.view<{ id: string; name: string; bank_name: string; account_masked: string }>('money_accounts', `company_id=eq.${s.companyId}&kind=eq.bank&select=id,name,bank_name,account_masked&order=name`)
    if (!bank) throw new Error('no bank account')

    // A bank receipt in the books with a unique amount.
    const today = todayIst()
    const amount = `${5000 + Number(rand4())}.${rand4().slice(0, 2)}`
    const posted = await api.rpc<{ voucher_id: string; doc_no: string }>('post_receipt', {
      p: { company_id: s.companyId, party_id: s.customer.id, date: today, mode: 'bank', account_id: bank.id, amount, allocations: [], narration: 'E2E test bank receipt' },
    })

    await page.goto(`/accounts/bank?company=${s.companyId}&tab=reconcile`)
    await expect(page.getByRole('heading', { level: 1, name: 'Bank reconciliation' })).toBeVisible()
    await page.getByLabel('Bank account').selectOption({ label: [bank.name, bank.bank_name, bank.account_masked].join(' · ') })
    const narration = `E2E Test NEFT ${rand4()}${rand4()}`
    const csv = `E2E Test Bank statement\nDate,Narration,Ref,Debit,Credit,Balance\n${ddmmyyyy(today)},${narration},UTR${rand4()},,${amount},\n`
    await page.getByLabel('Statement file').setInputFiles({ name: 'e2e-statement.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
    await expect(page.getByText('1 lines ready to import')).toBeVisible()
    await page.getByRole('button', { name: 'Import 1 lines' }).click()
    await expect(page.getByText('1 lines added · 0 already there')).toBeVisible({ timeout: 15_000 })
    const row = page.getByRole('row').filter({ hasText: narration })
    await expect(row).toContainText('Not matched')
    await expectNoSeriousA11y(page)

    await row.getByRole('button', { name: /^Match line of/ }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('radio', { name: new RegExp(posted.doc_no.replace(/[/]/g, '\\/')) }).check()
    await dialog.getByRole('button', { name: 'Match' }).click()
    await expect(row).toContainText('Matched', { timeout: 15_000 })
    await expect(row).toContainText(posted.doc_no)

    const [line] = await api.view<{ status: string; matched_voucher_id: string }>('bank_lines', `account_id=eq.${bank.id}&description=eq.${encodeURIComponent(narration)}&select=status,matched_voucher_id`)
    expect(line?.status).toBe('matched')
    expect(line?.matched_voucher_id).toBe(posted.voucher_id)
    await expectNoSeriousA11y(page)
  })

  test('A supplier bill is posted with GST from the server, paid by bank against the bill, and cash flow reads the books', async ({ page }) => {
    test.setTimeout(240_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const s = await ensureMoneySetup(page)
    const api = await restAsSignedInUser(page)
    const [a] = s.products
    if (!a) throw new Error('no product')
    // The purchase rule must exist (the first test sets it through the screen; set it here if this test runs alone).
    const [rule] = await api.view<{ account_id: string }>('posting_rules', `company_id=eq.${s.companyId}&event=eq.purchase.taxable&select=account_id`)
    if (!rule) await api.rpc('set_posting_rule', { p_company_id: s.companyId, p_event: 'purchase.taxable', p_account_id: s.purchaseAccounts[0]?.id, p_note: 'E2E test' })

    const billNo = `E2E-${rand4()}${rand4()}`
    await page.goto(`/purchase/bills-and-payments?company=${s.companyId}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Bills and payments' })).toBeVisible()
    await page.getByLabel('Supplier', { exact: true }).selectOption({ label: `${s.supplier.name} · ${s.supplier.gstin}` })
    await page.getByLabel("Supplier's bill number").fill(billNo)
    await page.getByLabel('Item, line 1').selectOption({ label: `${a.code} · ${a.name}` })
    await page.getByLabel('Quantity, line 1').fill('2')
    await page.getByLabel('Rate in rupees, line 1').fill('100')
    await expect(page.getByTestId('tax-taxable')).toContainText('200.00', { timeout: 15_000 })
    await expect(page.getByTestId('tax-cgst')).toContainText('18.00')
    await expect(page.getByTestId('tax-total')).toContainText('236.00')
    await expectNoSeriousA11y(page)

    await page.getByRole('button', { name: 'Post', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('for ₹236.00')
    await dialog.getByRole('button', { name: 'Post', exact: true }).click()
    const docNo = await postedNo(page, /Supplier bill (PB\/[0-9-]+\/[0-9]+) posted/)
    await expect(page.getByRole('row').filter({ hasText: billNo })).toContainText(docNo)

    const [bill] = await api.view<{ id: string; status: string; total: number; voucher_id: string; doc_no: string }>('purchase_bills', `company_id=eq.${s.companyId}&supplier_bill_no=eq.${billNo}&select=id,status,total,voucher_id,doc_no`)
    expect(bill?.status).toBe('posted')
    expect(bill?.doc_no).toBe(docNo)
    expect(Number(bill?.total)).toBe(236)
    const gl = await api.view<GlLine>('gl_lines', `voucher_id=eq.${bill?.voucher_id}&select=account_id,party_id,dr,cr`)
    const dr = gl.reduce((n, l) => n + Math.round(Number(l.dr) * 100), 0)
    const cr = gl.reduce((n, l) => n + Math.round(Number(l.cr) * 100), 0)
    expect(dr).toBe(23600)
    expect(cr).toBe(23600)
    expect(gl.find((l) => l.party_id === s.supplier.id && Number(l.cr) === 236)).toBeTruthy()

    // ── To pay: the bill is open; pay it by bank against the bill ──
    await page.getByRole('tab', { name: 'To pay' }).click()
    await expect(page.getByRole('row').filter({ hasText: billNo })).toBeVisible()
    await expectNoSeriousA11y(page)
    await page.getByRole('button', { name: `Pay bill ${billNo} of ${s.supplier.name}` }).click()
    await expect(page.getByRole('tab', { name: 'Payments' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByLabel('Paid to (supplier)')).toHaveValue(s.supplier.id)
    await page.getByLabel('Paid by').selectOption('bank')
    await page.getByLabel('Amount', { exact: true }).fill('236')
    await page.getByRole('button', { name: 'Fill oldest first' }).click()
    await expect(page.getByLabel(`Pay against bill ${billNo}`)).toHaveValue('236.00')
    await page.getByRole('button', { name: 'Post payment' }).click()
    const payNo = await postedNo(page, /Payment (EPY\/[0-9-]+\/[0-9]+) posted/)
    await expect(page.getByRole('row').filter({ hasText: payNo })).toBeVisible()
    await expect.poll(async () => Number((await api.view<{ open_amount: number }>('payables', `id=eq.${bill?.id}&select=open_amount`))[0]?.open_amount), { timeout: 15_000 }).toBe(0)
    await expectNoSeriousA11y(page)

    // ── Cash flow and reminders ──
    await page.goto(`/accounts/cash-flow-and-reminders?company=${s.companyId}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Cash flow and reminders' })).toBeVisible()
    await expect(page.getByTestId('avg-in')).toContainText('₹', { timeout: 15_000 })
    await expect(page.getByRole('table', { name: 'Money in and out by month' })).toBeVisible()
    await expectNoSeriousA11y(page)
  })
})

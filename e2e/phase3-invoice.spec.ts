import { expect, test } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'
import { ensureSalesSetup, restAsSignedInUser } from './phase3-sales-setup'

test.describe('Phase 3 · Invoice → post → sales register → receipt', () => {
  test.skip(!hasCreds, 'needs .env.test.local')

  test('Admin bills a verified customer in the same state (CGST + SGST), posts it, sees it in the register, and a full receipt settles it', async ({ page }) => {
    test.setTimeout(240_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const s = await ensureSalesSetup(page)
    const [a, b] = s.products
    if (!a || !b) throw new Error('set-up products missing')

    // ── Invoice with two lines, keyboard entry ──
    await page.goto(`/sales/invoices?company=${s.companyId}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Tax invoice' })).toBeVisible()
    await page.getByLabel('Find customer').fill(s.customer.name)
    await page.getByLabel('Customer', { exact: true }).selectOption({ label: `${s.customer.name} · ${s.customer.gstin}` })
    await expect(page.getByLabel('Customer GSTIN')).toHaveValue(s.customer.gstin)

    await page.getByLabel('Product, line 1').fill(`${a.code} · ${a.name}`)
    await page.getByLabel('Quantity, line 1').fill('2')
    await page.getByLabel('Rate in rupees, line 1').fill('100')
    await page.getByLabel('Rate in rupees, line 1').press('Enter')
    await expect(page.getByLabel('Product, line 2')).toBeFocused()
    await page.getByLabel('Product, line 2').fill(`${b.code} · ${b.name}`)
    await page.getByLabel('Quantity, line 2').fill('3')
    await page.getByLabel('Rate in rupees, line 2').fill('50.50')

    // Tax panel from api.preview_tax: same state → CGST + SGST, no IGST.
    await expect(page.getByTestId('pos-rule')).toHaveText(/CGST \+ SGST/)
    await expect(page.getByTestId('tax-cgst')).toBeVisible()
    await expect(page.getByTestId('tax-sgst')).toBeVisible()
    await expect(page.getByTestId('tax-igst')).toHaveCount(0)
    await expect(page.getByTestId('tax-taxable')).toContainText('351.50')
    await expect(page.getByTestId('tax-total')).toContainText('₹')
    await expect(page.getByTestId('tax-words')).toContainText(/Rupees/i)
    await expectNoSeriousA11y(page)

    // ── Post (saves the draft first, then confirms the exact effect) ──
    await page.getByRole('button', { name: 'Post', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Posts the Tax invoice for ₹')
    await dialog.getByRole('button', { name: 'Post', exact: true }).click()
    await expect(page.getByTestId('doc-state')).toContainText('Posted', { timeout: 20_000 })
    await expect(page.getByTestId('doc-no')).toHaveText(/^ESI\/\d{2}-\d{2}\/\d{4}$/)
    const docNo = (await page.getByTestId('doc-no').textContent())?.trim() ?? ''
    const docId = new URL(page.url()).searchParams.get('doc') ?? ''
    expect(docId).not.toBe('')

    // Reload: the number and state come back from the database.
    await page.reload()
    await expect(page.getByTestId('doc-no')).toHaveText(docNo)
    await expect(page.getByTestId('doc-state')).toContainText('Posted')

    // Database state: posted, numbered, intra-state tax split, balanced to the computed total.
    const api = await restAsSignedInUser(page)
    const [doc] = await api.view<{ status: string; doc_no: string; cgst: number; sgst: number; igst: number; taxable: number; total: number }>('sales_documents', `id=eq.${docId}&select=status,doc_no,cgst,sgst,igst,taxable,total`)
    expect(doc?.status).toBe('posted')
    expect(doc?.doc_no).toBe(docNo)
    expect(Number(doc?.taxable)).toBe(351.5)
    expect(Number(doc?.cgst)).toBeGreaterThan(0)
    expect(Number(doc?.sgst)).toBeGreaterThan(0)
    expect(Number(doc?.igst)).toBe(0)
    const total = Number(doc?.total)

    // ── Sales register lists it ──
    await page.goto(`/sales/invoices/sales-register?company=${s.companyId}`)
    await expect(page.getByRole('heading', { level: 1, name: /Sales register/ })).toBeVisible()
    const regRow = page.getByRole('row').filter({ hasText: docNo })
    await expect(regRow).toBeVisible()
    await expect(regRow).toContainText(s.customer.name)
    await expect(regRow.getByTestId('open-amount')).toBeVisible()
    await expectNoSeriousA11y(page)

    // ── Receipt allocating the full amount ──
    await page.goto(`/sales/receipts?company=${s.companyId}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Receipts' })).toBeVisible()
    await page.getByLabel('Find customer').fill(s.customer.name)
    await page.getByLabel('Customer', { exact: true }).selectOption({ label: `${s.customer.name} · ${s.customer.gstin}` })
    await page.getByLabel('Received by').selectOption('bank')
    await page.getByLabel('Amount').fill(total.toFixed(2))
    await expect(page.getByRole('row').filter({ hasText: docNo })).toBeVisible()
    await page.getByRole('button', { name: 'Fill oldest first' }).click()
    await expect(page.getByLabel(`Allocate to bill ${docNo}`)).toHaveValue(total.toFixed(2))
    await expect(page.getByTestId('on-account')).toContainText('₹0.00')
    await page.getByRole('button', { name: 'Post receipt' }).click()
    await expect(page.getByRole('status').filter({ hasText: /Receipt ERC\/.* posted\./ })).toBeVisible({ timeout: 20_000 })

    // Database: nothing left open on the invoice.
    await expect.poll(async () => Number((await api.view<{ open_amount: number }>('receivables', `id=eq.${docId}&select=open_amount`))[0]?.open_amount), { timeout: 15_000 }).toBe(0)

    // Register shows it settled.
    await page.goto(`/sales/invoices/sales-register?company=${s.companyId}`)
    await expect(page.getByRole('row').filter({ hasText: docNo })).toContainText('Settled')

    // Document templates: the same A4 layout for the posted invoice.
    await page.goto(`/admin/document-templates?company=${s.companyId}&doc=${docId}`)
    const sheet = page.getByRole('article', { name: 'A4 preview of the document' })
    await expect(sheet).toContainText(docNo)
    await expect(sheet).toContainText('TAX INVOICE')
    await expect(sheet).toContainText(s.customer.gstin)
    await expectNoSeriousA11y(page)
  })

  test('Cash at the daily limit is refused with the rule; a receipt is reversed; an invoice with receipts cannot be cancelled until they are reversed', async ({ page }) => {
    test.setTimeout(240_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const s = await ensureSalesSetup(page)
    const api = await restAsSignedInUser(page)
    const [a] = s.products
    if (!a) throw new Error('set-up products missing')

    // A posted invoice made through the same RPCs the screen uses.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    const draft = await api.rpc<{ id: string }>('save_sales_draft', {
      p: { company_id: s.companyId, gstin_id: s.gstinId, doc_type: 'sales_invoice', doc_date: today, party_id: s.customer.id, lines: [{ product_id: a.id, qty: '1', rate: '100', discount: '0' }] },
    })
    const posted = await api.rpc<{ doc_no: string; total: number }>('post_sales_document', { p_document_id: draft.id })

    // Cash receipt at the limit → refused, with the way out.
    await page.goto(`/sales/receipts?company=${s.companyId}`)
    await page.getByLabel('Find customer').fill(s.customer.name)
    await page.getByLabel('Customer', { exact: true }).selectOption({ label: `${s.customer.name} · ${s.customer.gstin}` })
    await page.getByLabel('Received by').selectOption('cash')
    await page.getByLabel('Amount').fill('200000')
    await page.getByRole('button', { name: 'Post receipt' }).click()
    await expect(page.getByText(/Refused: this takes the customer to the daily limit/)).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Take it by bank instead' }).click()
    await expect(page.getByLabel('Received by')).toHaveValue('bank')

    // Bank receipt settling the invoice.
    await page.getByLabel('Amount').fill(Number(posted.total).toFixed(2))
    await page.getByRole('button', { name: 'Fill oldest first' }).click()
    await page.getByRole('button', { name: 'Post receipt' }).click()
    const done = page.getByRole('status').filter({ hasText: /Receipt (ERC\/\S+) posted\./ })
    await expect(done).toBeVisible({ timeout: 20_000 })
    const receiptNo = ((await done.textContent()) ?? '').match(/Receipt (\S+) posted/)?.[1] ?? ''
    await expect(page.getByRole('row').filter({ hasText: receiptNo })).toContainText('Posted')
    await expectNoSeriousA11y(page)

    // Cancelling the invoice is refused while the receipt is set against it.
    await page.goto(`/sales/invoices?company=${s.companyId}&doc=${draft.id}`)
    await expect(page.getByTestId('doc-no')).toHaveText(posted.doc_no)
    await page.getByRole('button', { name: 'Cancel and reverse' }).click()
    let dialog = page.getByRole('dialog')
    await dialog.getByLabel('Reason (required)').fill('E2E test cancellation')
    await dialog.getByRole('button', { name: 'Cancel and reverse' }).click()
    await expect(dialog.getByText('Receipts or credit notes are set against this document. Reverse them first.', { exact: false })).toBeVisible({ timeout: 15_000 })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()

    // Reverse the receipt (reason), then the invoice can be cancelled.
    await page.goto(`/sales/receipts?company=${s.companyId}`)
    await page.getByRole('button', { name: `Reverse receipt ${receiptNo}` }).click()
    dialog = page.getByRole('dialog')
    await dialog.getByLabel('Reason (required)').fill('E2E test reversal')
    await dialog.getByRole('button', { name: 'Reverse' }).click()
    await expect(page.getByRole('row').filter({ hasText: receiptNo })).toContainText('Reversed', { timeout: 15_000 })
    await expect.poll(async () => Number((await api.view<{ open_amount: number }>('receivables', `id=eq.${draft.id}&select=open_amount`))[0]?.open_amount), { timeout: 15_000 }).toBe(Number(posted.total))

    await page.goto(`/sales/invoices?company=${s.companyId}&doc=${draft.id}`)
    await page.getByRole('button', { name: 'Cancel and reverse' }).click()
    dialog = page.getByRole('dialog')
    await dialog.getByLabel('Reason (required)').fill('E2E test cancellation')
    await dialog.getByRole('button', { name: 'Cancel and reverse' }).click()
    await expect(page.getByTestId('doc-state')).toContainText('Cancelled', { timeout: 15_000 })
    await page.reload()
    await expect(page.getByTestId('doc-state')).toContainText('Cancelled')
    const [doc] = await api.view<{ status: string; voucher_id: string }>('sales_documents', `id=eq.${draft.id}&select=status,voucher_id`)
    expect(doc?.status).toBe('cancelled')
    const [voucher] = await api.view<{ status: string; reversed_by_id: string | null }>('vouchers', `id=eq.${doc?.voucher_id}&select=status,reversed_by_id`)
    expect(voucher?.status).toBe('reversed')
    expect(voucher?.reversed_by_id).toBeTruthy()
  })
})

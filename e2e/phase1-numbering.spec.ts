import { expect, test, type Page } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'

/** A fresh synthetic company (no financial year yet), created through the Companies screen. */
async function createE2eCompany(page: Page) {
  const code = `E2E${Date.now().toString(36).slice(-4).toUpperCase()}`
  const name = `E2E Test Company ${code}`
  await page.goto('/admin/companies')
  await page.getByRole('button', { name: 'Add company' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Short code').fill(code)
  await dialog.getByLabel('Legal name').fill(name)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible({ timeout: 15_000 })
  return { code, name }
}

async function chooseCompany(page: Page, code: string, name: string) {
  const select = page.getByRole('combobox', { name: 'Company', exact: true })
  // Wait until the company list has loaded and the picker is drawn.
  await expect(select.or(page.getByRole('tab', { name, exact: true }))).toBeVisible()
  if ((await select.count()) > 0) {
    await select.selectOption({ label: `${code} · ${name}` })
  } else {
    await page.getByRole('tab', { name, exact: true }).click()
  }
}

test.describe('Phase 1 · Numbering and IDs', () => {
  test.skip(!hasCreds, 'needs .env.test.local')

  test('Admin opens the financial year and adds number series; the database computes the next number and the length check', async ({ page }) => {
    test.setTimeout(60_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const { code, name } = await createE2eCompany(page)

    await page.goto('/admin/numbering-and-ids')
    await expect(page.getByRole('heading', { level: 1, name: 'Numbering and IDs' })).toBeVisible()
    await chooseCompany(page, code, name)

    // A new company has no financial year: open the current Indian FY (April–March).
    const open = page.getByRole('button', { name: /^Open FY \d{4}-\d{2}$/ })
    await expect(open).toBeVisible()
    const fy = ((await open.textContent()) ?? '').replace('Open FY ', '').trim()
    await open.click()
    await expect(open).toBeHidden()
    await expect(page.getByText(`per financial year ${fy}`)).toBeVisible()
    const yy = `${fy.slice(2, 4)}-${fy.slice(5, 7)}`

    // A sales invoice series that fits the 16-character limit.
    await page.getByRole('button', { name: 'Add series' }).click()
    let dialog = page.getByRole('dialog')
    await dialog.getByLabel('Document').selectOption('sales_invoice')
    await dialog.getByLabel('Prefix').fill('E2ET')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()

    // A credit note series whose numbers would be too long: the database refuses it when saved.
    await page.getByRole('button', { name: 'Add series' }).click()
    dialog = page.getByRole('dialog')
    await dialog.getByLabel('Document').selectOption('credit_note')
    await dialog.getByLabel('Prefix').fill('E2ETESTLONGP')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog.getByRole('alert')).toContainText('longer than 16 characters')
    await dialog.getByRole('button', { name: 'Cancel' }).click()

    // Round trip: reload and read back what api.doc_series computed.
    await page.reload()
    const table = page.getByRole('table', { name: 'Documents' })
    const invoiceRow = table.getByRole('row').filter({ hasText: 'Sales tax invoice' })
    await expect(invoiceRow.getByText(`E2ET/${yy}/0001`)).toBeVisible()
    await expect(invoiceRow.getByText('of 16 characters')).toBeVisible()
    await expect(table.getByText(`E2ETESTLONGP/${yy}/0001`)).toHaveCount(0)
    await expectNoSeriousA11y(page)

    // Edit the counter before any number is issued.
    await invoiceRow.getByRole('button', { name: /^Edit Sales tax invoice/ }).click()
    dialog = page.getByRole('dialog')
    await dialog.getByLabel('Next counter').fill('25')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()
    await page.reload()
    await expect(page.getByRole('table', { name: 'Documents' }).getByText(`E2ET/${yy}/0025`)).toBeVisible()
  })

  test('a staff user cannot add number series', async ({ page }) => {
    await signInWithEmail(page, creds.staff)
    await expect(page).toHaveURL(/\/staff\/home$/)
    await page.goto('/admin/numbering-and-ids')
    await expect(page.getByRole('heading', { level: 1, name: 'Numbering and IDs' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add series' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Open FY/ })).toHaveCount(0)
  })
})

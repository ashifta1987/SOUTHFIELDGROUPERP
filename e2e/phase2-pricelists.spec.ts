import { expect, test, type Page } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'
import { createE2eProduct, ensureE2eHsn, rand, setMrp } from './phase2-products-helpers'

/** Choose a synthetic E2E company on the price list screen (tabs for a few companies, a select for many). Returns its picker label, or null. */
async function chooseE2eCompany(page: Page, wanted?: string): Promise<string | null> {
  const select = page.getByRole('combobox', { name: 'Company', exact: true })
  const tabs = page.getByRole('tablist', { name: 'Company' })
  await expect(select.or(tabs)).toBeVisible()
  if ((await select.count()) > 0) {
    const labels = await select.locator('option').allTextContents()
    const label = wanted ? labels.find((l) => l.endsWith(` · ${wanted}`)) : labels.find((l) => / · E2E Test Company /.test(l))
    if (!label) return null
    await select.selectOption({ label })
    return label.split(' · ').slice(1).join(' · ')
  }
  const names = await tabs.getByRole('tab').allTextContents()
  const name = wanted ? names.find((n) => n === wanted) : names.find((n) => n.startsWith('E2E Test Company'))
  if (!name) return null
  await tabs.getByRole('tab', { name, exact: true }).click()
  return name
}

async function createE2eCompany(page: Page) {
  const code = `E2E${Date.now().toString(36).slice(-4).toUpperCase()}`
  const pan = `EEEEE${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}E`
  const name = `E2E Test Company ${code}`
  await page.goto('/admin/companies')
  await page.getByRole('button', { name: 'Add company' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Short code').fill(code)
  await dialog.getByLabel('Legal name').fill(name)
  await dialog.getByLabel('PAN').fill(pan)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  return name
}

test.describe('Phase 2 · Price lists', () => {
  test.skip(!hasCreds, 'needs .env.test.local')

  test('Admin adds a tax-inclusive list; a price under MRP is saved, one above MRP is refused', async ({ page }) => {
    test.setTimeout(120_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()

    // A synthetic company (reuse one if a previous run made it).
    await page.goto('/sales/price-lists')
    await expect(page.getByRole('heading', { level: 1, name: 'Price lists' })).toBeVisible()
    let company = await chooseE2eCompany(page)
    if (!company) company = await createE2eCompany(page)

    // A product for that company with MRP 10.00.
    await ensureE2eHsn(page)
    const { code, name } = await createE2eProduct(page, { company })
    await setMrp(page, code, name, '10.00')

    // Tax-inclusive price list.
    await page.goto('/sales/price-lists')
    expect(await chooseE2eCompany(page, company)).toBe(company)
    const listName = `E2E Test list ${rand()}`
    await page.getByRole('button', { name: 'New price list' }).first().click()
    let dialog = page.getByRole('dialog')
    await dialog.getByLabel('List name').fill(listName)
    await expect(dialog.getByLabel('Prices include GST')).toBeChecked()
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('heading', { level: 2, name: listName })).toBeVisible()

    // Below MRP: saved.
    await page.getByRole('button', { name: 'Add price' }).click()
    dialog = page.getByRole('dialog')
    await dialog.getByLabel('Product').selectOption({ label: `${code} · ${name}` })
    await dialog.getByLabel('Price including GST').fill('9.50')
    await dialog.getByRole('button', { name: 'Set price' }).click()
    await expect(dialog).toBeHidden()
    const items = page.getByRole('table', { name: `Prices on ${listName}` })
    await expect(items.getByRole('row').filter({ hasText: code }).getByText('9.50', { exact: true })).toBeVisible()

    // Above MRP: refused by the server with the Legal Metrology message.
    await page.getByRole('button', { name: `Change price · ${name}` }).click()
    dialog = page.getByRole('dialog')
    await dialog.getByLabel('Price including GST').fill('12.00')
    await dialog.getByRole('button', { name: 'Set price' }).click()
    await expect(dialog.getByText("This price includes GST and is above the product's MRP.", { exact: false })).toBeVisible()
    await expectNoSeriousA11y(page)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()

    // Round trip: reload and read the list and the price back.
    await page.reload()
    expect(await chooseE2eCompany(page, company)).toBe(company)
    await page.getByRole('button', { name: new RegExp(listName) }).click()
    const row = page.getByRole('table', { name: `Prices on ${listName}` }).getByRole('row').filter({ hasText: code })
    await expect(row.getByText('9.50', { exact: true })).toBeVisible()
    await expect(row.getByText('10.00', { exact: true })).toBeVisible()
    await expect(row.getByText('12.00', { exact: true })).toHaveCount(0)
    await expectNoSeriousA11y(page)
  })
})

import { expect, test } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'
import { chooseCompany, ensureE2eCompany, rand4, randomPan, saveWithForce, syntheticGstin } from './phase2-parties-helpers'

test.describe('Phase 2 · Customers and Customer KYC', () => {
  test.skip(!hasCreds, 'needs .env.test.local')

  test('Admin proposes a customer with a valid GSTIN, sees it as Draft after reload, gets the duplicate warning, and sends it for verification', async ({ page }) => {
    test.setTimeout(120_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const { code, name: companyName } = await ensureE2eCompany(page)

    const pan = randomPan()
    const gstin = syntheticGstin(pan)
    const name = `E2E Test Customer ${rand4()}${rand4()}`

    // New customer through Customer KYC.
    await page.goto('/sales/customers/customer-kyc')
    await expect(page.getByRole('heading', { level: 1, name: 'Buyer KYC' })).toBeVisible()
    await chooseCompany(page, code, companyName)
    await page.getByLabel('GSTIN', { exact: true }).fill(gstin)
    // Live server check: valid check digit, Kerala, PAN filled from characters 3–12.
    await expect(page.getByText('Valid', { exact: true })).toBeVisible()
    await expect(page.getByText(`Kerala (32) · PAN ${pan}`)).toBeVisible()
    await expect(page.getByLabel('PAN', { exact: true })).toHaveValue(pan)
    await page.getByLabel('Legal name').fill(name)
    await page.getByLabel('Bill-to address').fill('E2E Test Address')
    await page.getByLabel('Pin code').fill('680001')
    await page.getByLabel('WhatsApp number', { exact: true }).fill('9000000000')
    await expectNoSeriousA11y(page)

    await saveWithForce(
      page,
      () => page.getByRole('button', { name: 'Save draft' }).click(),
      async () => /party=/.test(page.url()),
    )
    await expect(page).toHaveURL(/party=/)
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(name)

    // Round trip: Customers list after a reload shows it as a draft for KYC.
    await page.goto('/sales/customers')
    await expect(page.getByRole('heading', { level: 1, name: 'Customers' })).toBeVisible()
    await chooseCompany(page, code, companyName)
    await page.reload()
    const row = page.getByRole('row', { name: new RegExp(name) })
    await expect(row).toBeVisible()
    await expect(row.getByText('Draft · KYC')).toBeVisible()
    await expect(row.getByText(gstin)).toBeVisible()
    await expectNoSeriousA11y(page)

    // Same name again: the live duplicate warning names the existing customer.
    await page.goto('/sales/customers/customer-kyc')
    await chooseCompany(page, code, companyName)
    await page.getByLabel('Legal name').fill(name)
    const warning = page.getByRole('status').filter({ hasText: /This looks like/ })
    await expect(warning).toBeVisible()
    await expect(warning.getByRole('link', { name })).toBeVisible()

    // Send it for verification from its KYC page.
    await page.goto('/sales/customers')
    await chooseCompany(page, code, companyName)
    await page.getByRole('link', { name: `Edit ${name}` }).click()
    await expect(page.getByLabel('Legal name')).toHaveValue(name)
    await page.getByRole('button', { name: 'Send for verification' }).click()
    await expect(page.locator('li[aria-current="step"]')).toHaveText('Office verifies')

    await page.goto('/sales/customers')
    await chooseCompany(page, code, companyName)
    await page.reload()
    await expect(page.getByRole('row', { name: new RegExp(name) }).getByText('KYC to verify')).toBeVisible()
  })
})

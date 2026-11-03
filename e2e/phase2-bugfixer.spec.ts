import { expect, test } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'
import { chooseCompany, ensureE2eCompany, rand4, saveWithForce } from './phase2-parties-helpers'

test.describe('Phase 2 · Bug fixer', () => {
  test.skip(!hasCreds, 'needs .env.test.local')

  test('Admin runs the checks, opens a problem, dismisses it with a note, and it stays dismissed after a reload', async ({ page }) => {
    test.setTimeout(120_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const { code, name: companyName } = await ensureE2eCompany(page)

    // A synthetic registered customer with no GSTIN: the checks must flag it.
    const name = `E2E Test Registered ${rand4()}${rand4()}`
    await page.goto('/sales/customers/customer-kyc')
    await expect(page.getByRole('heading', { level: 1, name: 'Buyer KYC' })).toBeVisible()
    await chooseCompany(page, code, companyName)
    await page.getByLabel('GST status').selectOption('registered')
    await page.getByLabel('Legal name').fill(name)
    await saveWithForce(
      page,
      () => page.getByRole('button', { name: 'Save draft' }).click(),
      async () => /party=/.test(page.url()),
    )
    await expect(page).toHaveURL(/party=/)

    // Run checks again for that company.
    await page.goto('/admin/bug-fixer')
    await expect(page.getByRole('heading', { level: 1, name: 'Bug fixer' })).toBeVisible()
    await chooseCompany(page, code, companyName)
    await page.getByRole('button', { name: 'Run checks again' }).first().click()
    await expect(page.getByRole('status').filter({ hasText: /Checks done/ })).toBeVisible()

    // Open the item and dismiss it with a note.
    const title = `Registered party without GSTIN: ${name}`
    await page.getByRole('button', { name: title }).click()
    const detail = page.getByRole('region', { name: title })
    await expect(detail).toBeVisible()
    await expectNoSeriousA11y(page)
    await detail.getByLabel('Reason (required)').fill('E2E test: synthetic party, nothing to fix')
    await detail.getByRole('button', { name: 'Dismiss' }).click()
    await expect(detail.getByText('dismiss: E2E test: synthetic party, nothing to fix')).toBeVisible()

    // Round trip: after a reload it is under Dismissed, not Open.
    await page.reload()
    await chooseCompany(page, code, companyName)
    await expect(page.getByRole('button', { name: title })).toHaveCount(0)
    await page.getByRole('tab', { name: 'Dismissed' }).click()
    await page.getByRole('button', { name: title }).click()
    await expect(page.getByRole('region', { name: title }).getByText('Dismissed', { exact: true })).toBeVisible()
  })
})

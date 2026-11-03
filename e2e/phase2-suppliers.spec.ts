import { expect, test } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'
import { chooseCompany, ensureE2eCompany, rand4, randomPan, saveWithForce } from './phase2-parties-helpers'

test.describe('Phase 2 · Suppliers', () => {
  test.skip(!hasCreds, 'needs .env.test.local')

  test('Admin adds an MSME micro supplier and its first bank account; a bank change cannot be approved by the person who asked for it', async ({ page }) => {
    test.setTimeout(120_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const { code, name: companyName } = await ensureE2eCompany(page)
    const name = `E2E Test Supplier ${rand4()}${rand4()}`

    await page.goto('/purchase/suppliers')
    await expect(page.getByRole('heading', { level: 1, name: 'Suppliers · KYC' })).toBeVisible()
    await chooseCompany(page, code, companyName)

    await page.getByRole('button', { name: 'Add supplier' }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Legal name').fill(name)
    await dialog.getByLabel('PAN', { exact: true }).fill(randomPan())
    await dialog.getByLabel('MSME category').selectOption('micro')
    await dialog.getByLabel('Udyam number').fill(`UDYAM-KL-02-${rand4()}${rand4().slice(0, 3)}`)
    await dialog.getByLabel('What they supply').fill('E2E test packaging')
    await saveWithForce(
      page,
      () => dialog.getByRole('button', { name: 'Save' }).click(),
      async () => !(await dialog.isVisible()),
    )
    await expect(dialog).toBeHidden()

    // Round trip through the database.
    await page.reload()
    await page.getByRole('button', { name: new RegExp(`^${name}`) }).click()
    await expect(page.getByRole('heading', { level: 2, name })).toBeVisible()
    await expect(page.getByText('Pay within 45 days')).toBeVisible()
    await expectNoSeriousA11y(page)

    // First bank account (synthetic numbers).
    await page.getByRole('button', { name: 'Add bank account' }).click()
    let bank = page.getByRole('dialog')
    await bank.getByLabel('Account number').fill('000111222333')
    await bank.getByLabel('IFSC').fill('EEEE0123456')
    await bank.getByLabel('Bank and branch').fill('E2E Test Bank')
    await bank.getByRole('button', { name: 'Save' }).click()
    await expect(bank).toBeHidden()
    await expect(page.getByText('••2333')).toBeVisible()

    // Any later change is a request…
    await page.getByRole('button', { name: 'Request bank change' }).click()
    bank = page.getByRole('dialog')
    await bank.getByLabel('Account number').fill('000444555666')
    await bank.getByLabel('IFSC').fill('EEEE0654321')
    await bank.getByLabel('Reason (required)').fill('E2E test: supplier changed bank')
    await bank.getByRole('button', { name: 'Send request' }).click()
    await expect(bank).toBeHidden()
    const requests = page.getByRole('table', { name: 'Bank change requests' })
    await expect(requests.getByText('Waiting for approval')).toBeVisible()

    // …and the same person can't approve it.
    await requests.getByRole('button', { name: 'Approve' }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'Nobody approves their own request' })).toBeVisible()

    await page.reload()
    await page.getByRole('button', { name: new RegExp(`^${name}`) }).click()
    await expect(page.getByRole('table', { name: 'Bank change requests' }).getByText('Waiting for approval')).toBeVisible()
    await expect(page.getByText('••2333')).toBeVisible()
  })
})

import { expect, test } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'

/** A field key the database accepts (^[a-z_]+$), unique per run so the test can repeat. */
function letters(n: number) {
  return Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')
}

test.describe('Phase 1 · User log, transaction log, forms and fields', () => {
  test.skip(!hasCreds, 'needs .env.test.local')

  test.beforeEach(async ({ page }) => {
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
  })

  test('the User log shows the admin sign-in', async ({ page }) => {
    await page.goto('/admin/user-log')
    await expect(page.getByRole('heading', { level: 1, name: 'User log' })).toBeVisible()
    await page.getByLabel('Action').selectOption('sign_in')
    const table = page.getByRole('table', { name: 'User log entries' })
    const first = table.locator('tbody tr:not(.sf-table__state)').first()
    await expect(first).toContainText('Sign-in')
    await expect(first).toContainText('method')
    await expectNoSeriousA11y(page)
  })

  test('the Transaction log lists changes and opens the history diff', async ({ page }) => {
    await page.goto('/admin/transaction-log')
    await expect(page.getByRole('heading', { level: 1, name: 'Transaction log' })).toBeVisible()
    await expect(page.getByText("This log can't be switched off or edited")).toBeVisible()
    const table = page.getByRole('table', { name: 'Transaction log entries' })
    await expect(table.getByRole('button', { name: /^Open history of / }).first()).toBeVisible()
    await table.getByRole('button', { name: /^Open history of / }).first().click()
    await expect(page.getByText('History of one record')).toBeVisible()
    await expect(page.getByRole('heading', { level: 3, name: /^Version 1 · / })).toBeVisible()
    await expect(page.getByRole('table', { name: /^Fields changed in version/ }).first()).toBeVisible()
    await expectNoSeriousA11y(page)
  })

  test('Admin adds a custom field to the customer form, sees it after reload, then switches it off', async ({ page }) => {
    const key = `e_e_test_field_${letters(6)}`
    await page.goto('/admin/forms-and-fields')
    await expect(page.getByRole('heading', { level: 1, name: 'Forms and fields' })).toBeVisible()
    await page.getByRole('navigation', { name: 'Forms' }).getByRole('button', { name: 'Customer', exact: true }).click()
    const form = page.getByRole('form', { name: 'New field' })
    await form.getByLabel('Label').fill('E2E Test field')
    await form.getByLabel('Field key').fill(key)
    await form.getByRole('button', { name: 'Add field' }).click()
    const row = page.locator(`tr[data-field-key="${key}"]`)
    await expect(row).toBeVisible()

    await page.reload()
    await page.getByRole('navigation', { name: 'Forms' }).getByRole('button', { name: 'Customer', exact: true }).click()
    await expect(row).toContainText('E2E Test field')
    await expect(row).toContainText('Active')
    await expectNoSeriousA11y(page)

    await row.getByRole('button', { name: 'Switch off E2E Test field' }).click()
    await expect(row).toContainText('Inactive')
    await page.reload()
    await expect(page.locator(`tr[data-field-key="${key}"]`)).toContainText('Inactive')
  })
})

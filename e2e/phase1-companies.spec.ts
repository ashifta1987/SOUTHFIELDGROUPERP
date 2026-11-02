import { expect, test } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'

test.describe('Phase 1 · Companies', () => {
  test.skip(!hasCreds, 'needs .env.test.local')

  test('Admin adds a company and it comes back from the database', async ({ page }) => {
    const code = `E2E${Date.now().toString(36).slice(-4).toUpperCase()}`
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    await page.goto('/admin/companies')
    await expect(page.getByRole('heading', { level: 1, name: /companies/ })).toBeVisible()
    await page.getByRole('button', { name: 'Add company' }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Short code').fill(code)
    await dialog.getByLabel('Legal name').fill(`E2E Test Company ${code}`)
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()
    await page.reload()
    await expect(page.getByRole('heading', { level: 2, name: `E2E Test Company ${code}` })).toBeVisible()
    await expectNoSeriousA11y(page)
  })

  test('a staff user has no Admin menu and cannot add companies', async ({ page }) => {
    await signInWithEmail(page, creds.staff)
    await expect(page).toHaveURL(/\/staff\/home$/)
    await page.goto('/admin/companies')
    await expect(page.getByRole('heading', { level: 1, name: /companies/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Admin' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Add company' })).toHaveCount(0)
  })
})

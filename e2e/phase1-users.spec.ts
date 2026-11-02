import { expect, test } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'

// Only the synthetic staff user is ever given roles here.
const STAFF = creds.staff.email

test.describe('Phase 1 · Users and rights', () => {
  test.skip(!hasCreds || !STAFF, 'needs .env.test.local')

  test('Admin adds a role to the staff user with a reason, sees it after reload, then removes it', async ({ page }) => {
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    await page.goto('/admin/users-and-rights')
    await expect(page.getByRole('heading', { level: 1, name: 'Users and rights' })).toBeVisible()

    const row = () => page.getByRole('row').filter({ hasText: STAFF })
    await expect(row()).toHaveCount(1)
    const removeButtons = () => row().getByRole('button', { name: 'Remove Designer role' })
    const before = await removeButtons().count()

    await row().getByRole('button', { name: /^Add role/ }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Role', { exact: true }).selectOption({ label: 'Designer' })
    await dialog.getByLabel('Reason (required)').fill('E2E Test: role check by Playwright')
    await expectNoSeriousA11y(page)
    await dialog.getByRole('button', { name: 'Add role' }).click()
    await expect(dialog).toBeHidden()

    await page.reload()
    await expect(removeButtons()).toHaveCount(before + 1)
    await expect(row()).toContainText('Designer')
    await expectNoSeriousA11y(page)

    await removeButtons().first().click()
    const confirm = page.getByRole('dialog')
    await expect(confirm).toContainText('Removes the Designer role')
    await confirm.getByLabel('Reason (required)').fill('E2E Test: clean up after the role check')
    await confirm.getByRole('button', { name: 'Remove role' }).click()
    await expect(confirm).toBeHidden()

    await page.reload()
    await expect(row()).toHaveCount(1)
    await expect(removeButtons()).toHaveCount(before)
  })

  test('a reason is required before a role is added', async ({ page }) => {
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    await page.goto('/admin/users-and-rights')
    const row = page.getByRole('row').filter({ hasText: STAFF })
    await row.getByRole('button', { name: /^Add role/ }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Role', { exact: true }).selectOption({ label: 'Designer' })
    await dialog.getByRole('button', { name: 'Add role' }).click()
    await expect(dialog.getByText('Say why, in at least 5 characters.')).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
  })
})

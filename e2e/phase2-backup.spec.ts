import { expect, test } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'

test.describe('Phase 2 · Backup', () => {
  test.skip(!hasCreds, 'needs .env.test.local')

  test('Admin records a restore drill in India; a location outside India is refused', async ({ page }) => {
    const note = `E2E Test drill ${Date.now().toString(36)}`
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    await page.goto('/admin/backup')
    await expect(page.getByRole('heading', { level: 1, name: 'Backup' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: 'How long they are kept' })).toBeVisible()

    // Outside India: the server refuses (rule backup.outside_india), nothing is recorded.
    await page.getByRole('button', { name: 'Record a backup / restore drill' }).click()
    let dialog = page.getByRole('dialog')
    await dialog.getByLabel('Location (in India)').fill('Frankfurt')
    await dialog.getByLabel('Note').fill(`${note} refused`)
    await dialog.getByRole('button', { name: 'Record' }).click()
    await expect(dialog.getByRole('alert')).toContainText('only in India')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()

    // In India: recorded and shown after a reload (round trip through api.backup_runs).
    await page.getByRole('button', { name: 'Record a backup / restore drill' }).click()
    dialog = page.getByRole('dialog')
    await dialog.getByLabel('Kind').selectOption('restore_drill')
    await dialog.getByLabel('Location (in India)').fill('Office server, Wadakkanchery (India)')
    await dialog.getByLabel('Note').fill(note)
    await dialog.getByRole('button', { name: 'Record' }).click()
    await expect(dialog).toBeHidden()

    await page.reload()
    const history = page.getByRole('region', { name: 'Backup and restore runs' })
    await expect(history.getByRole('row').filter({ hasText: 'Office server, Wadakkanchery (India)' }).first()).toBeVisible()
    await expect(history.getByRole('row').filter({ hasText: 'Frankfurt' })).toHaveCount(0)
    await expectNoSeriousA11y(page)
  })
})

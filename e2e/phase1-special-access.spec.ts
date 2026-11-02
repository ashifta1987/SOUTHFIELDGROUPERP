import { expect, test } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'

// Only the synthetic staff user is ever given permissions here.
const STAFF = creds.staff.email

/** "YYYY-MM-DDTHH:mm" in IST, as the datetime-local inputs on the screen expect. */
function istInput(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)
  const g = (k: string) => parts.find((p) => p.type === k)?.value ?? '00'
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`
}

test.describe('Phase 1 · Special permissions', () => {
  test.skip(!hasCreds || !STAFF, 'needs .env.test.local')

  test('Admin gives the staff user Export data for 1 hour, sees it Running, stops it, sees Stopped', async ({ page }) => {
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    await page.goto('/admin/special-permissions')
    await expect(page.getByRole('heading', { level: 1, name: 'Special permissions' })).toBeVisible()

    await page.getByRole('button', { name: /^Export data/ }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'Give: Export data' })).toBeVisible()

    const to = page.getByLabel('To', { exact: true })
    const option = to.locator('option', { hasText: STAFF })
    await expect(option).toHaveCount(1)
    await to.selectOption((await option.getAttribute('value')) ?? '')
    const now = Date.now()
    await page.getByLabel('Starts', { exact: true }).fill(istInput(new Date(now - 60_000)))
    await page.getByLabel('Ends', { exact: true }).fill(istInput(new Date(now + 60 * 60_000)))
    await page.getByLabel('Reason (required)').fill('E2E Test: export check by Playwright')
    await expectNoSeriousA11y(page)
    await page.getByRole('button', { name: 'Give permission' }).click()

    const given = page.getByRole('status').filter({ hasText: /Given: SP-/ })
    await expect(given).toBeVisible()
    const code = (await given.textContent())?.match(/SP-[0-9]+-[0-9]+/)?.[0]
    expect(code).toBeTruthy()

    await page.reload()
    const row = page.getByRole('row').filter({ hasText: code! })
    await expect(row).toContainText('Export data')
    await expect(row).toContainText('Running')
    await expectNoSeriousA11y(page)

    await row.getByRole('button', { name: `Stop ${code}` }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText(code!)
    await dialog.getByLabel('Reason (required)').fill('E2E Test: stop after the check')
    await dialog.getByRole('button', { name: 'Stop permission' }).click()
    await expect(dialog).toBeHidden()

    await page.reload()
    await expect(page.getByRole('row').filter({ hasText: code! })).toContainText('Stopped')
  })
})

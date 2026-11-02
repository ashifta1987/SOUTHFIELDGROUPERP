import { expect, test, type Page } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'

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
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible()
  return { code, name }
}

test.describe('Phase 1 · Settings', () => {
  test.skip(!hasCreds, 'needs .env.test.local')

  test('group limits come from the database; a company setting is versioned and keeps its history', async ({ page }) => {
    test.setTimeout(60_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const { code } = await createE2eCompany(page)

    await page.goto('/admin/settings')
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    const limits = page.getByRole('table', { name: 'Limits Admin fixes for everyone' })
    // Undecided limits are shown as not set, never with an invented value.
    for (const key of ['cash.receipt_block_amount', 'cash.payment_warn_amount', 'entries.backdate_days', 'work.hours']) {
      const row = limits.getByRole('row').filter({ hasText: key })
      await expect(row).toHaveCount(1)
    }
    await expect(limits.getByRole('row').filter({ hasText: 'grants.max_days' })).toHaveCount(1)

    // A synthetic company-level setting (never a group limit): set it twice, the second from a later date.
    // Keys are small letters, dots and underscores only.
    const key = `etest.value_${code.toLowerCase().replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)] ?? 'x')}`
    for (const [value, from, note] of [
      ['3', '2026-04-01', 'E2E Test first value'],
      ['5', '2099-04-01', 'E2E Test later value'],
    ] as const) {
      await page.getByRole('button', { name: 'Add a setting' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('Applies to').selectOption({ label: `${code} · E2E Test Company ${code}` })
      await dialog.getByLabel('Key', { exact: true }).fill(key)
      await dialog.getByLabel('Kind of value').selectOption('number')
      await dialog.getByLabel('Value', { exact: true }).fill(value)
      await dialog.getByLabel('In force from').fill(from)
      await dialog.getByLabel('Reason (required)').fill(note)
      await dialog.getByRole('button', { name: 'Save' }).click()
      await expect(dialog).toBeHidden()
    }

    await page.reload()
    const companyTable = page.getByRole('table', { name: 'Company settings' })
    const row = companyTable.getByRole('row').filter({ hasText: key })
    // The current value is the one in force today; the later one waits in the history.
    await expect(row.getByText('01-04-2026')).toBeVisible()
    await expect(row.getByText('E2E Test first value')).toBeVisible()
    await row.getByRole('button', { name: /^History/ }).click()
    const hist = page.getByRole('table', { name: new RegExp(`^History of ${key.replace(/\./g, '\\.')}`) })
    await expect(hist.getByRole('row').filter({ hasText: 'E2E Test later value' }).getByText('Starts later')).toBeVisible()
    await expect(hist.getByRole('row').filter({ hasText: 'E2E Test first value' })).toHaveCount(1)
    await expectNoSeriousA11y(page)
  })
})

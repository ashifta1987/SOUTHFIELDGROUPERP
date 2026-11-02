import { expect, test } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'

test.describe('Phase 1 · Explainers (law rules, views, total workflow)', () => {
  test.skip(!hasCreds, 'needs .env.test.local')

  test.beforeEach(async ({ page }) => {
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
  })

  test('Built to Indian law lists the rules from the database and filters by status', async ({ page }) => {
    await page.goto('/admin/built-to-indian-law')
    await expect(page.getByRole('heading', { level: 1, name: 'Built to Indian law' })).toBeVisible()
    const table = page.getByRole('table', { name: 'Legal rules and how the ERP enforces them' })
    await expect(table.getByRole('row').nth(2)).toBeVisible()
    await expect(page.getByText('not legal advice')).toBeVisible()
    await page.getByLabel('Status').selectOption('built')
    await expect(table.getByText('Planned', { exact: true })).toHaveCount(0)
    await expect(table.getByText('Built', { exact: true }).first()).toBeVisible()
    await expectNoSeriousA11y(page)
  })

  test('How each person sees it shows the three views and the roles from the database', async ({ page }) => {
    await page.goto('/admin/how-each-person-sees-it')
    await expect(page.getByRole('heading', { level: 1, name: 'How each person sees it' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 3, name: 'All transactions', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { level: 3, name: 'GST transactions', exact: true })).toBeVisible()
    const table = page.getByRole('table', { name: 'What each role sees and how it signs in' })
    await expect(table.getByRole('rowheader').first()).toBeVisible()
    expect(await table.getByRole('rowheader').count()).toBeGreaterThan(3)
    await expectNoSeriousA11y(page)
  })

  test('Total workflow shows all 17 workflows with their steps and phases', async ({ page }) => {
    await page.goto('/admin/total-workflow')
    await expect(page.getByRole('heading', { level: 1, name: /Total workflow/ })).toBeVisible()
    await expect(page.getByRole('heading', { level: 3 })).toHaveCount(17)
    await page.getByRole('button', { name: /^Selling/ }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'Selling' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open Tax invoice' })).toBeVisible()
    await expect(page.getByText('Receipts are matched to bills')).toBeVisible()
    await expectNoSeriousA11y(page)
  })
})

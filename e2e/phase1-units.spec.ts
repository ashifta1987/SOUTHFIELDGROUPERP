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

async function chooseCompany(page: Page, code: string, name: string) {
  const select = page.getByRole('combobox', { name: 'Company', exact: true })
  // Wait until the company list has loaded and the picker is drawn.
  await expect(select.or(page.getByRole('tab', { name, exact: true }))).toBeVisible()
  if ((await select.count()) > 0) await select.selectOption({ label: `${code} · ${name}` })
  else await page.getByRole('tab', { name, exact: true }).click()
}

test.describe('Phase 1 · Units', () => {
  test.skip(!hasCreds, 'needs .env.test.local')

  test('Admin adds a unit, a stock place and a department, and they come back from the database', async ({ page }) => {
    test.setTimeout(60_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const { code, name } = await createE2eCompany(page)

    await page.goto('/admin/units')
    await expect(page.getByRole('heading', { level: 1, name: 'Units' })).toBeVisible()
    await chooseCompany(page, code, name)

    await page.getByRole('button', { name: 'Add unit' }).first().click()
    let dialog = page.getByRole('dialog')
    await dialog.getByLabel('Short code').fill('E2EU1')
    await dialog.getByLabel('Name', { exact: true }).fill('E2E Test Unit')
    await dialog.getByLabel('Kind', { exact: true }).selectOption('factory')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()

    await page.getByRole('button', { name: 'Add place · E2E Test Unit' }).click()
    dialog = page.getByRole('dialog')
    await dialog.getByLabel('Place code').fill('E2E-Q')
    await dialog.getByLabel('Place name').fill('E2E Test Quarantine')
    await dialog.getByLabel('Kind of place').selectOption('quarantine')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()

    await page.getByRole('button', { name: 'Add department' }).click()
    dialog = page.getByRole('dialog')
    await dialog.getByLabel('Department name').fill('E2E Test Department')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()

    await page.reload()
    const card = page.getByRole('region', { name: 'E2E Test Unit' })
    await expect(card).toBeVisible()
    await expect(card.getByText('Factory')).toBeVisible()
    await expect(card.getByText('E2E Test Quarantine')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Departments' }).getByText('E2E Test Department')).toBeVisible()
    await expect(page.getByText('1 unit, one company')).toBeVisible()
    await expectNoSeriousA11y(page)
  })
})

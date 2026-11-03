import { expect, type Page } from '@playwright/test'

export const E2E_HSN = '99990001'
export const E2E_HSN_DESC = 'E2E Test HSN'

export function rand(): string {
  return `${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 1296).toString(36)}`.toUpperCase()
}

/** Make sure the synthetic HSN exists with a rate in force (0%, not confirmed by the CA). Skips what already exists. */
export async function ensureE2eHsn(page: Page) {
  await page.goto('/inventory/product-master')
  await expect(page.getByRole('heading', { level: 1, name: 'Product master' })).toBeVisible()
  await page.getByRole('tab', { name: 'HSN and GST rates' }).click()
  const table = page.getByRole('table', { name: 'HSN and GST rates' })
  await expect(table).toBeVisible()
  await expect(table.locator('tbody[aria-busy="true"]')).toHaveCount(0)
  const row = table.getByRole('row').filter({ hasText: E2E_HSN })
  if ((await row.count()) === 0) {
    await page.getByRole('button', { name: 'Add HSN' }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('HSN', { exact: true }).fill(E2E_HSN)
    await dialog.getByLabel('Description').fill(E2E_HSN_DESC)
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()
    await expect(row).toBeVisible()
  }
  if ((await row.getByText('No rate').count()) > 0) {
    await page.getByRole('button', { name: `Add rate · ${E2E_HSN}` }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('GST rate %').fill('0')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()
  }
  await expect(row.getByText('Not confirmed')).toBeVisible()
}

/** Add a synthetic product on Product master (accepting the duplicate warning other E2E products cause). */
export async function createE2eProduct(page: Page, opts: { company?: string } = {}) {
  const r = rand()
  const code = `E2E${r}`
  const name = `E2E Test Product ${r}`
  await page.goto('/inventory/product-master')
  await page.getByRole('button', { name: 'New product · Admin' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Product code').fill(code)
  await dialog.getByLabel('Product name').fill(name)
  await dialog.getByLabel('HSN', { exact: true }).selectOption({ label: `${E2E_HSN} · ${E2E_HSN_DESC}` })
  await dialog.getByLabel('Stock unit').selectOption('NOS')
  if (opts.company) await dialog.getByLabel(opts.company, { exact: true }).check()
  await dialog.getByRole('button', { name: 'Save' }).click()
  const force = dialog.getByRole('button', { name: 'Create anyway' })
  // Earlier E2E products have similar names, so the server may ask first.
  await Promise.race([dialog.waitFor({ state: 'hidden' }), force.waitFor({ state: 'visible' })])
  if (await force.isVisible()) await force.click()
  await expect(dialog).toBeHidden()
  return { code, name }
}

/** Find a product row on the Products tab by its code. */
export async function findProductRow(page: Page, code: string) {
  await page.getByLabel('Search code, name or barcode').fill(code)
  const row = page.getByRole('table', { name: 'Products' }).getByRole('row').filter({ hasText: code })
  await expect(row).toBeVisible()
  return row
}

export async function setMrp(page: Page, code: string, name: string, mrp: string) {
  await findProductRow(page, code)
  await page.getByRole('button', { name: `MRP · ${name}` }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('MRP including all taxes').fill(mrp)
  await dialog.getByRole('button', { name: 'Set MRP' }).click()
  await expect(dialog).toBeHidden()
}

import { expect, test } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'
import { createE2eProduct, ensureE2eHsn, findProductRow, setMrp } from './phase2-products-helpers'

test.describe('Phase 2 · Product master', () => {
  test.skip(!hasCreds, 'needs .env.test.local')

  test('Admin adds an HSN rate and a product with MRP; GST and MRP come back from the database; a near-duplicate is flagged', async ({ page }) => {
    test.setTimeout(90_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()

    // HSN with a 0% rate from today, not confirmed by the CA.
    await ensureE2eHsn(page)
    await expectNoSeriousA11y(page)

    // Product with that HSN, unit NOS, then MRP 10.00 from today.
    const { code, name } = await createE2eProduct(page)
    await setMrp(page, code, name, '10.00')

    // Round trip: reload and read GST % (from the HSN table) and MRP (from the MRP history).
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Product master' })).toBeVisible()
    const row = await findProductRow(page, code)
    await expect(row.getByText('0%', { exact: true })).toBeVisible()
    await expect(row.getByText('10.00', { exact: true })).toBeVisible()
    await expect(row.getByText('E2E Test HSN')).toHaveCount(0)
    await expect(row.getByText('99990001')).toBeVisible()
    await expectNoSeriousA11y(page)

    // MRP history shows the version.
    await page.getByRole('button', { name: `MRP · ${name}` }).click()
    let dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('table', { name: 'MRP history' }).getByText('₹10.00')).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()

    // An almost identical name is stopped with the duplicate warning, listing the existing product.
    await page.getByRole('button', { name: 'New product · Admin' }).click()
    dialog = page.getByRole('dialog')
    await dialog.getByLabel('Product code').fill(`${code}X`)
    await dialog.getByLabel('Product name').fill(`${name}s`)
    await dialog.getByLabel('Stock unit').selectOption('NOS')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog.getByText('This looks like a product that already exists')).toBeVisible()
    // The server returns up to 5 similar products (unordered), so only check that candidates are listed.
    await expect(dialog.getByRole('listitem').first()).toContainText('E2E')
    await expect(dialog.getByRole('button', { name: 'Create anyway' })).toBeVisible()
    await expectNoSeriousA11y(page)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()

    // Nothing was created by the refused save.
    await page.getByLabel('Search code, name or barcode').fill(`${code}X`)
    await expect(page.getByRole('table', { name: 'Products' }).getByText('No product matches these filters')).toBeVisible()
  })
})

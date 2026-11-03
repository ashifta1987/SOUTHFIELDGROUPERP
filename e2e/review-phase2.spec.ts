import { test } from '@playwright/test'
import { creds, hasCreds, signInWithEmail } from './helpers'

/** Phase 2 review screenshots (docs/review/phase-2). Synthetic accounts and E2E rows only. */
const OUT = 'docs/review/phase-2'
const PAGES: [string, string][] = [
  ['DataImport', '/admin/import-data'],
  ['TallyBiochem', '/admin/import-data/tally-biochem'],
  ['BookFixes', '/admin/bug-fixer'],
  ['Backup', '/admin/backup'],
  ['ProductMaster', '/inventory/product-master'],
  ['BiochemProducts', '/sales/biochem-products'],
  ['PriceList', '/sales/price-lists'],
  ['Customers', '/sales/customers'],
  ['CustomerKYC', '/sales/customers/customer-kyc'],
  ['SupplierKYC', '/purchase/suppliers'],
]

test('phase 2 review screenshots', async ({ page }) => {
  test.skip(!process.env.REVIEW_SHOTS || !hasCreds)
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await signInWithEmail(page, creds.admin)
  await page.getByRole('heading', { level: 1, name: 'Today' }).waitFor()
  for (const [name, route] of PAGES) {
    await page.goto(route)
    await page.getByRole('heading', { level: 1 }).waitFor()
    await page.waitForTimeout(1200)
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true })
  }
})

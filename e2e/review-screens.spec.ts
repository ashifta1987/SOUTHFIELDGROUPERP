import { test } from '@playwright/test'
import { creds, hasCreds, signInWithEmail } from './helpers'

/** Phase 0 review screenshots (docs/review/phase-0). Synthetic accounts, empty dev database: no real data. */
const OUT = 'docs/review/phase-0'

test.describe('review screenshots', () => {
  test.skip(!process.env.REVIEW_SHOTS, 'set REVIEW_SHOTS=1 to refresh the review screenshots')

  test('sign-in screens', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 })
    await page.goto('/sign-in')
    await page.screenshot({ path: `${OUT}/Login.png` })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/staff/sign-in')
    await page.screenshot({ path: `${OUT}/StaffSignIn.png` })
  })

  test('admin screens', async ({ page }) => {
    test.skip(!hasCreds)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await signInWithEmail(page, creds.admin)
    await page.getByRole('heading', { level: 1, name: 'Today' }).waitFor()
    await page.waitForTimeout(800)
    await page.screenshot({ path: `${OUT}/Main.png`, fullPage: true })
    await page.goto('/sales/customers')
    await page.getByRole('heading', { level: 1, name: 'Customers' }).waitFor()
    await page.waitForTimeout(800)
    await page.screenshot({ path: `${OUT}/Customers.png`, fullPage: true })
    await page.setViewportSize({ width: 834, height: 1000 })
    await page.goto('/')
    await page.getByRole('button', { name: 'Open menu' }).click()
    await page.screenshot({ path: `${OUT}/Main-834-drawer.png` })
  })

  test('staff home', async ({ page }) => {
    test.skip(!hasCreds)
    await page.setViewportSize({ width: 390, height: 844 })
    await signInWithEmail(page, creds.staff)
    await page.getByText('My requests').waitFor()
    await page.waitForTimeout(800)
    await page.screenshot({ path: `${OUT}/StaffHome.png` })
  })
})

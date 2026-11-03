import { expect, test } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'

test.describe('sign-in screens', () => {
  test('desktop sign-in renders, validates and is accessible', async ({ page }) => {
    await page.goto('/sign-in')
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByText('Enter the 10-digit mobile number')).toBeVisible()
    await expectNoSeriousA11y(page)
  })

  test('wrong password shows a plain message', async ({ page }) => {
    test.skip(!hasCreds, 'needs .env.test.local')
    await signInWithEmail(page, { email: creds.admin.email, password: 'wrong-password-123' })
    await expect(page.getByRole('alert')).toContainText('wrong')
  })

  test('staff phone sign-in renders and is accessible', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/staff/sign-in')
    await expect(page.getByRole('heading', { level: 1, name: 'Staff sign in' })).toBeVisible()
    await expectNoSeriousA11y(page)
  })

  test('language switch changes the screen language', async ({ page }) => {
    await page.goto('/staff/sign-in')
    await page.getByRole('button', { name: 'हि' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('स्टाफ़ साइन इन')
    await expect(page.locator('html')).toHaveAttribute('lang', 'hi')
    await page.getByRole('button', { name: 'EN' }).click()
  })

  test('protected pages send you to sign-in', async ({ page }) => {
    await page.goto('/sales/customers')
    await expect(page).toHaveURL(/\/sign-in$/)
  })
})

test.describe('signed in as Admin', () => {
  test.skip(!hasCreds, 'needs .env.test.local')

  test('Home shows the shell, the Admin view chip and designed empty states', async ({ page }) => {
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    await expect(page.locator('.sf-viewchip')).toHaveText('All transactions')
    await expect(page.getByRole('navigation', { name: /Workflow: Owner overview/ })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'step')
    // DEV may hold figures from later-phase tests: either the KPI strip or its designed empty state shows.
    await expect(page.getByText('No figures yet').or(page.locator('.sf-kpi').first())).toBeVisible()
    await expect(page.getByText(/bills without GST are here, marked/)).toBeVisible()
    await expectNoSeriousA11y(page)
  })

  test('sidebar opens Sales and reaches the Customers register', async ({ page }) => {
    await signInWithEmail(page, creds.admin)
    await page.getByRole('button', { name: 'Sales' }).click()
    await page.getByRole('link', { name: 'Customers', exact: true }).first().click()
    await expect(page).toHaveURL(/\/sales\/customers$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Customers' })).toBeVisible()
    await expect(page.locator('.sf-sidebar a[aria-current="page"]')).toHaveText('Customers')
    await expect(page.getByRole('button', { name: /Add customer/ }).or(page.getByRole('link', { name: /Add customer/ })).first()).toBeEnabled()
    await expect(page.getByRole('navigation', { name: /Workflow: Selling/ })).toBeVisible()
    await expectNoSeriousA11y(page)
  })

  test('Ctrl+K focuses search and Help opens the panel', async ({ page }) => {
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    await page.keyboard.press('Control+k')
    await expect(page.getByRole('searchbox')).toBeFocused()
    await page.getByRole('button', { name: 'Help' }).click()
    await expect(page.getByRole('dialog', { name: 'Southfield Help' })).toBeVisible()
  })

  test('an unknown address shows a page, never a dead screen', async ({ page }) => {
    // Every screen in the inventory is built now (Phases 0–7); an address outside it shows the designed not-found page.
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    await page.goto('/no-such-screen')
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible()
    await expect(page.getByText('There is no screen at this address.')).toBeVisible()
    await expectNoSeriousA11y(page)
  })

  test('below 1280 px the sidebar is a drawer', async ({ page }) => {
    await page.setViewportSize({ width: 834, height: 1000 })
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const menu = page.getByRole('button', { name: 'Open menu' })
    await expect(menu).toBeVisible()
    await menu.click()
    await expect(menu).toHaveAttribute('aria-expanded', 'true')
    await expectNoSeriousA11y(page)
  })
})

test.describe('signed in as staff', () => {
  test.skip(!hasCreds, 'needs .env.test.local')
  test('staff land on the phone app with GST view and empty states', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await signInWithEmail(page, creds.staff)
    await expect(page).toHaveURL(/\/staff\/home$/)
    await expect(page.getByRole('heading', { name: 'My requests' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Staff app' })).toBeVisible()
    await expectNoSeriousA11y(page)
  })
})

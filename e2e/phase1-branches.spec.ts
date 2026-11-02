import { expect, test, type Page } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'

/** Synthetic company with a random PAN (PAN is unique), created through the Companies screen. */
async function createE2eCompany(page: Page) {
  const code = `E2E${Date.now().toString(36).slice(-4).toUpperCase()}`
  const digits = String(Math.floor(Math.random() * 10000)).padStart(4, '0')
  const pan = `EEEEE${digits}E`
  const name = `E2E Test Company ${code}`
  await page.goto('/admin/companies')
  await page.getByRole('button', { name: 'Add company' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Short code').fill(code)
  await dialog.getByLabel('Legal name').fill(name)
  await dialog.getByLabel('PAN').fill(pan)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible()
  return { code, pan, name }
}

/** The set-up screens show a few companies as tabs and many as a select. */
async function chooseCompany(page: Page, code: string, name: string) {
  const select = page.getByRole('combobox', { name: 'Company', exact: true })
  // Wait until the company list has loaded and the picker is drawn.
  await expect(select.or(page.getByRole('tab', { name, exact: true }))).toBeVisible()
  if ((await select.count()) > 0) {
    await select.selectOption({ label: `${code} · ${name}` })
  } else {
    await page.getByRole('tab', { name, exact: true }).click()
  }
}

test.describe('Phase 1 · Branches and GSTINs', () => {
  test.skip(!hasCreds, 'needs .env.test.local')

  test('Admin adds a GSTIN, a branch and a place, and they come back from the database', async ({ page }) => {
    test.setTimeout(60_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const { code, pan, name } = await createE2eCompany(page)
    const gstin = `32${pan}1Z5`

    await page.goto('/admin/branches-and-gstins')
    await expect(page.getByRole('heading', { level: 1, name: 'Branches and GSTINs' })).toBeVisible()
    await chooseCompany(page, code, name)
    await expect(page.getByText(`${name} · one company`)).toBeVisible()

    // GSTIN from the certificate: characters 3–12 carry the company's PAN.
    await page.getByRole('button', { name: 'Add GSTIN from certificate' }).click()
    let dialog = page.getByRole('dialog')
    await dialog.getByLabel('GSTIN', { exact: true }).fill(gstin)
    await dialog.getByLabel('Trade name').fill('E2E Test Trade')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('table', { name: 'GST registrations' }).getByText(gstin)).toBeVisible()

    // Branch under that GSTIN.
    await page.getByRole('button', { name: 'Add branch' }).first().click()
    dialog = page.getByRole('dialog')
    await dialog.getByLabel('Short code').fill('E2EBR')
    await dialog.getByLabel('Name', { exact: true }).fill('E2E Test Branch')
    await dialog.getByLabel('Kind', { exact: true }).selectOption('shop')
    await dialog.getByLabel('GSTIN', { exact: true }).selectOption({ label: `${gstin} · E2E Test Trade` })
    await dialog.getByLabel('Address').fill('E2E Test Address')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()

    // Place inside the branch.
    await page.getByRole('button', { name: 'Add place · E2E Test Branch' }).click()
    dialog = page.getByRole('dialog')
    await dialog.getByLabel('Place code').fill('E2E-ST')
    await dialog.getByLabel('Place name').fill('E2E Test Stores')
    await dialog.getByLabel('Kind of place').selectOption('stores')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()

    // Round trip: reload and read it all back from the database.
    await page.reload()
    const card = page.getByRole('region', { name: 'E2E Test Branch' })
    await expect(card).toBeVisible()
    await expect(card.getByText(gstin)).toBeVisible()
    await expect(card.getByText('Principal place')).toBeVisible()
    await expect(card.getByText('E2E Test Address')).toBeVisible()
    await expect(card.getByText('E2E Test Stores')).toBeVisible()
    await expect(card.getByText('Places · 1')).toBeVisible()
    await expectNoSeriousA11y(page)

    // A GSTIN that doesn't carry the company's PAN is refused before it is sent.
    await page.getByRole('button', { name: 'Add GSTIN from certificate' }).click()
    dialog = page.getByRole('dialog')
    await dialog.getByLabel('GSTIN', { exact: true }).fill('33AAAAA0000A1Z5')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog.getByText(`Characters 3 to 12 must be the company's PAN ${pan}.`)).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
  })

  test('a staff user cannot add branches or GSTINs', async ({ page }) => {
    await signInWithEmail(page, creds.staff)
    await expect(page).toHaveURL(/\/staff\/home$/)
    await page.goto('/admin/branches-and-gstins')
    await expect(page.getByRole('heading', { level: 1, name: 'Branches and GSTINs' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add branch' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Add GSTIN from certificate' })).toHaveCount(0)
  })
})

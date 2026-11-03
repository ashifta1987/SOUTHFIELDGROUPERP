import { expect, type Page } from '@playwright/test'

/** Synthetic test data for the Phase 2 party screens. Nothing here is real business data. */

export function rand4(): string {
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0')
}

export function randomPan(): string {
  return `EEEEE${rand4()}E`
}

/** GSTIN check digit (mod-36, same algorithm as app.gstin_valid in the masters migration). */
export function gstinCheckDigit(first14: string): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let total = 0
  for (let i = 0; i < 14; i++) {
    const v = chars.indexOf(first14.charAt(i))
    const f = (i + 1) % 2 === 0 ? 2 : 1
    const p = v * f
    total += Math.floor(p / 36) + (p % 36)
  }
  return chars.charAt((36 - (total % 36)) % 36)
}

/** A synthetic but valid GSTIN for Kerala (32) around a PAN. */
export function syntheticGstin(pan: string, state = '32'): string {
  const first14 = `${state}${pan}1Z`
  return first14 + gstinCheckDigit(first14)
}

/** Use an existing E2E company, or create one through the Companies screen. Returns its code and name. */
export async function ensureE2eCompany(page: Page): Promise<{ code: string; name: string }> {
  await page.goto('/admin/companies')
  await expect(page.getByRole('heading', { level: 1, name: 'Companies' })).toBeVisible()
  const existing = page.getByRole('heading', { level: 2, name: /^E2E Test Company E2E[A-Z0-9]+$/ }).first()
  const found = await existing
    .waitFor({ timeout: 8000 })
    .then(() => true)
    .catch(() => false)
  if (found) {
    const name = (await existing.textContent())?.trim() ?? ''
    return { code: name.split(' ').pop() ?? '', name }
  }
  const code = `E2E${Date.now().toString(36).slice(-4).toUpperCase()}`
  const name = `E2E Test Company ${code}`
  await page.getByRole('button', { name: 'Add company' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Short code').fill(code)
  await dialog.getByLabel('Legal name').fill(name)
  await dialog.getByLabel('PAN').fill(randomPan())
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible({ timeout: 15_000 })
  return { code, name }
}

/** The company picker shows a few companies as tabs and many as a select. */
export async function chooseCompany(page: Page, code: string, name: string) {
  const select = page.getByRole('combobox', { name: 'Company', exact: true })
  await expect(select.or(page.getByRole('tab', { name, exact: true }))).toBeVisible()
  if ((await select.count()) > 0) {
    await select.selectOption({ label: `${code} · ${name}` })
  } else {
    await page.getByRole('tab', { name, exact: true }).click()
  }
}

/** Save a new party; when the server flags a similar name, choose "Create anyway". */
export async function saveWithForce(page: Page, save: () => Promise<void>, done: () => Promise<boolean>) {
  await save()
  const anyway = page.getByRole('button', { name: 'Create anyway' })
  await expect
    .poll(
      async () => {
        if (await done()) return 'done'
        if (await anyway.isVisible()) return 'dup'
        return 'wait'
      },
      { timeout: 15_000 },
    )
    .not.toBe('wait')
  if (await anyway.isVisible()) await anyway.click()
}

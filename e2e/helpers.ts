import { expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

export const creds = {
  admin: { email: process.env.E2E_ADMIN_EMAIL ?? '', password: process.env.E2E_ADMIN_PASSWORD ?? '' },
  staff: { email: process.env.E2E_STAFF_EMAIL ?? '', password: process.env.E2E_STAFF_PASSWORD ?? '' },
  /** Optional third synthetic login (segregation of duties needing three people, e.g. stock transfers). */
  third: { email: process.env.E2E_THIRD_EMAIL ?? '', password: process.env.E2E_THIRD_PASSWORD ?? '' },
}
export const hasCreds = Boolean(creds.admin.email && creds.admin.password)

export async function signInWithEmail(page: Page, who: { email: string; password: string }) {
  await page.goto('/sign-in')
  await page.getByRole('tab', { name: /Email/ }).click()
  await page.getByLabel('Email', { exact: true }).fill(who.email)
  await page.getByLabel('Password', { exact: true }).fill(who.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

/** Zero serious or critical axe issues (§UX-10). */
export async function expectNoSeriousA11y(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
}

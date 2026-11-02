import { test } from '@playwright/test'
import { creds, hasCreds, signInWithEmail } from './helpers'

/** Phase 1 review screenshots (docs/review/phase-1). Synthetic accounts and E2E rows only. */
const OUT = 'docs/review/phase-1'
const PAGES: [string, string][] = [
  ['Companies', '/admin/companies'],
  ['Branches', '/admin/branches-and-gstins'],
  ['Units', '/admin/units'],
  ['Users', '/admin/users-and-rights'],
  ['SpecialAccess', '/admin/special-permissions'],
  ['UserLog', '/admin/user-log'],
  ['TransactionLog', '/admin/transaction-log'],
  ['Numbering', '/admin/numbering-and-ids'],
  ['FormFields', '/admin/forms-and-fields'],
  ['Settings', '/admin/settings'],
  ['UXOverview', '/admin/how-each-person-sees-it'],
  ['LawRules', '/admin/built-to-indian-law'],
  ['ERPFlow', '/admin/total-workflow'],
]

test('phase 1 review screenshots', async ({ page }) => {
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

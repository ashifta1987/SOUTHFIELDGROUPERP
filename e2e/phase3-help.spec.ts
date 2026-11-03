import { expect, test } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'
import { rand4 } from './phase2-parties-helpers'
import { restAsSignedInUser } from './phase3-sales-setup'

/**
 * Phase 3 Help panel v1 against the DEV database: open from the top bar, the current screen's page, search and open a
 * page, file a problem report (row asserted), Admin answers a report filed by the staff user (row asserted), and the
 * shared error box's "Ask Help about this" opens the panel with that error reference explained from ops.error_log.
 * axe on the open panel. Synthetic data only ("E2E Test" problem texts).
 */
test.describe('Phase 3 · Help panel', () => {
  test.skip(!hasCreds || !creds.staff.email, 'needs .env.test.local')

  test('Search, open a page, report a problem, Admin answers, and an error explained from the error box', async ({ page, browser }) => {
    test.setTimeout(180_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const api = await restAsSignedInUser(page)

    // A report from the staff user for Admin to answer.
    const staffCtx = await browser.newContext()
    const staffPage = await staffCtx.newPage()
    await signInWithEmail(staffPage, creds.staff)
    await expect(staffPage).toHaveURL(/\/staff\/home$/)
    const staffApi = await restAsSignedInUser(staffPage)
    const staffText = `E2E Test staff problem ${rand4()}${rand4()}`
    const staffReport = await staffApi.rpc<{ id: string; code: string }>('create_problem_report', { p: { screen: 'StaffHome', what_happened: staffText } })
    await staffCtx.close()

    // ── Open Help on the Companies screen ──
    await page.goto('/admin/companies')
    await expect(page.getByRole('heading', { level: 1, name: 'Companies' })).toBeVisible()
    await page.getByRole('button', { name: 'Help', exact: true }).click()
    const panel = page.getByRole('dialog', { name: 'Southfield Help' })
    await expect(panel).toBeVisible()
    const ok = panel.getByRole('button', { name: 'I understand' })
    if (await ok.isVisible()) await ok.click()
    await expect(panel.getByRole('heading', { name: 'Help for this screen' })).toBeVisible()
    await expect(panel.getByRole('button', { name: /^Companies/ })).toBeVisible({ timeout: 15_000 })
    await expectNoSeriousA11y(page)

    // ── Search and open a page ──
    await panel.getByLabel('Search help').fill('cash book')
    await panel.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(panel.getByRole('heading', { name: /Results for/ })).toBeVisible()
    await panel.getByRole('button', { name: /^Cash book/ }).click()
    await expect(panel.getByRole('heading', { level: 3, name: 'Cash book' })).toBeVisible({ timeout: 15_000 })
    await expectNoSeriousA11y(page)
    await panel.getByRole('button', { name: '← Back to help' }).click()

    // ── Report a problem ──
    const text = `E2E Test problem from the help panel ${rand4()}${rand4()}`
    await panel.getByRole('button', { name: 'Report a problem' }).click()
    await panel.getByLabel('What happened?').fill(text)
    await panel.getByRole('button', { name: 'Send to Admin' }).click()
    await expect(panel.getByRole('status').filter({ hasText: 'Sent to Admin as' })).toBeVisible({ timeout: 15_000 })
    const [mine] = await api.view<{ code: string; screen: string; status: string; what_happened: string }>('problem_reports', `what_happened=eq.${encodeURIComponent(text)}&select=code,screen,status,what_happened`)
    expect(mine).toMatchObject({ screen: 'Companies', status: 'open' })
    await expect(panel.getByText(mine?.code ?? 'missing').first()).toBeVisible()

    // ── Admin answers the staff user's report ──
    await panel.getByRole('button', { name: `Answer ${staffReport.code}` }).click()
    await panel.getByLabel(`Answer ${staffReport.code}`).fill('E2E Test answer')
    await expectNoSeriousA11y(page)
    await panel.getByRole('button', { name: 'Send answer' }).click()
    await expect
      .poll(async () => (await api.view<{ status: string; reply: string }>('problem_reports', `id=eq.${staffReport.id}&select=status,reply`))[0], { timeout: 15_000 })
      .toEqual({ status: 'closed', reply: 'E2E Test answer' })
    await panel.getByRole('button', { name: 'Close' }).click()
    await expect(panel).toBeHidden()

    // ── An error in the shared error box → Ask Help about this ──
    // A template name with capitals is refused by the database check; the box shows the error reference.
    await page.goto('/admin/whatsapp-and-email')
    await expect(page.getByRole('heading', { level: 1, name: 'WhatsApp, SMS and email' })).toBeVisible()
    await page.getByRole('button', { name: 'Add template' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add template' })
    await dialog.getByLabel('Template name').fill('E2E Bad Name')
    await dialog.getByLabel('Event').fill('sales.e2e_test')
    await dialog.getByLabel('Parameters').fill('customer')
    await dialog.getByLabel('Message body').fill('Dear {{1}}, E2E test.')
    await dialog.getByRole('button', { name: 'Save template' }).click()
    const alert = dialog.getByRole('alert')
    await expect(alert).toBeVisible({ timeout: 15_000 })
    const ref = ((await alert.locator('.mono').textContent()) ?? '').trim()
    expect(ref).toMatch(/^ERR-/)
    await alert.getByRole('button', { name: 'Ask Help about this' }).click()
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('heading', { name: `About ${ref}` })).toBeVisible()
    await expect(panel.getByText(new RegExp(`Checked: ${ref}`))).toBeVisible({ timeout: 15_000 })
    await expect(panel.getByText(/The ERP said:/)).toBeVisible()
  })
})

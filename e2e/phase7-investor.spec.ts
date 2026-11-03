import { expect, test, type Browser, type Page } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'
import { rand4, randomPan } from './phase2-parties-helpers'
import { restAsSignedInUser, type Rest } from './phase3-sales-setup'
import { fyStartYear } from './phase4-setup'
import { userIdByEmail } from './phase5-setup'

/**
 * Phase 7 investor portal against the DEV database, on a fresh synthetic company (E2EV####). Admin, through the
 * sanctioned RPCs, links the synthetic investor login to a partner (upsert_partner with user_id), records synthetic
 * investments and opening balances on the partner's current and loan accounts, adds a second partner with a request
 * of its own, and gives the investor login the `investor` role for this company for one hour (removed in `finally`;
 * the partner rows are made inactive and unlinked afterwards).
 *
 * The investor signs in at /investor/sign-in and lands on /investor/home; an ERP route sends them back to the portal;
 * home and group figures equal api.investor_me / api.investor_group_summary; the other partner's request is not
 * readable as the investor; a withdrawal is sent (row `submitted`); Admin approves it and is refused (partner.over_due,
 * the server's message) when approving one above what the company owes, then rejects that one; the investor sees both
 * decisions. Only request buttons exist in the portal. axe on every portal screen at desktop and phone widths.
 */

const PAGES = ['/investor/home', '/investor/group', '/investor/performance', '/investor/investment', '/investor/working-partner', '/investor/projects', '/investor/withdraw', '/investor/loan']
const ALLOWED_BUTTONS = /^(Sign out of the investor portal|Send to Admin|Take back.*|I'm interested.*|Show or hide details for .*|EN|മല|Ask for help.*|Help.*|Copy.*)$/

async function settled(page: Page) {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 })
}

/** One own request line: document numbers run per company, so match the company too. */
function myRequest(page: Page, doc: string, company: string) {
  return page.locator(`[data-testid="investor-request"][data-doc="${doc}"]`).filter({ hasText: company })
}

async function investorPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await ctx.newPage()
  await page.goto('/investor/sign-in')
  await expect(page.getByRole('heading', { level: 1, name: 'Investor portal' })).toBeVisible()
  await page.getByLabel('WhatsApp number or email').fill(creds.investor.email)
  await page.getByLabel('Investor password').fill(creds.investor.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/investor\/home$/, { timeout: 20_000 })
  return page
}

interface Me {
  display_name: string | null
  open_requests: number
  partners: { partner_id: string; company_id: string; shares: number | null; share_pct: number }[]
}
interface Summary {
  totals: { share_capital: number; investment: number; value_of_my_shares: number }
  companies: { company_id: string; shares: number | null; share_pct: number; share_capital: number; investment: number; net_worth_book: number; value_of_my_shares: number }[]
}

test.describe('Phase 7 · investor portal', () => {
  test.skip(!hasCreds || !creds.investor.email, 'needs .env.test.local with E2E_INVESTOR_*')

  test('separate sign-in, portal-only routing, own figures and requests, Admin decides', async ({ page, browser }) => {
    test.setTimeout(300_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const admin: Rest = await restAsSignedInUser(page)

    // ── Set-up as Admin (synthetic company, accounts, partners, role) ──
    const tag = rand4()
    const code = `E2EV${tag}`
    const shortName = `E2E Inv ${tag}`
    const company = await admin.rpc<{ id: string }>('upsert_company', { p: { code, legal_name: `E2E Test Investor Company ${tag}`, short_name: shortName, pan: randomPan(), registered_address: 'E2E Test Address, Kerala' } })
    const companyId = company.id
    await admin.rpc('open_financial_year', { p_company_id: companyId, p_start_year: fyStartYear() })
    const gEq = (await admin.rpc<{ id: string }>('upsert_account_group', { p: { company_id: companyId, name: 'E2E Test Partners Capital', nature: 'equity', is_party_group: null } })).id
    const gLoan = (await admin.rpc<{ id: string }>('upsert_account_group', { p: { company_id: companyId, name: 'E2E Test Partner Loans', nature: 'liability', is_party_group: null } })).id
    const asOf = `${fyStartYear()}-04-01`
    const current = (await admin.rpc<{ id: string }>('upsert_account', { p: { company_id: companyId, group_id: gEq, name: `E2E Test Partner Current ${tag}`, opening_balance: 50000, opening_dc: 'C', opening_as_of: asOf } })).id
    const loan = (await admin.rpc<{ id: string }>('upsert_account', { p: { company_id: companyId, group_id: gLoan, name: `E2E Test Partner Loan ${tag}`, opening_balance: 20000, opening_dc: 'C', opening_as_of: asOf } })).id
    const investorUserId = await userIdByEmail(admin, creds.investor.email)
    const partnerName = `E2E Test Investor ${tag}`
    const partner = (
      await admin.rpc<{ id: string }>('upsert_partner', {
        p: { company_id: companyId, user_id: investorUserId, display_name: partnerName, is_legal_partner: true, is_investment_partner: true, shares: 1000, share_pct: 10, current_account_id: current, loan_account_id: loan, language: 'en', status: 'active' },
      })
    ).id
    await admin.rpc('record_partner_investment', { p: { partner_id: partner, kind: 'share_capital', amount: 10000, note: 'E2E test' } })
    await admin.rpc('record_partner_investment', { p: { partner_id: partner, kind: 'capital_account', amount: 25000, note: 'E2E test' } })
    const otherName = `E2E Test Other Partner ${tag}`
    const other = (await admin.rpc<{ id: string }>('upsert_partner', { p: { company_id: companyId, display_name: otherName, is_legal_partner: true, shares: 500, share_pct: 5, status: 'active' } })).id
    const otherReq = await admin.rpc<{ id: string; doc_no: string }>('submit_partner_request', { p_kind: 'info', p: { partner_id: other, purpose: 'E2E test question from another partner' } })
    const role = await admin.rpc<{ id: string }>('assign_role', {
      p_user_id: investorUserId,
      p_role: 'investor',
      p_company_id: companyId,
      p_valid_to: new Date(Date.now() + 60 * 60_000).toISOString(),
      p_reason: 'E2E test: investor portal for a synthetic company',
    })

    let inv: Page | null = null
    try {
      // ── Separate sign-in → portal home; ERP routes send the investor back ──
      inv = await investorPage(browser)
      await settled(inv)
      await inv.goto('/sales/customers')
      await expect(inv).toHaveURL(/\/investor\/home$/, { timeout: 15_000 })
      await inv.goto('/')
      await expect(inv).toHaveURL(/\/investor\/home$/, { timeout: 15_000 })
      await expect(inv.locator('nav').getByRole('link', { name: /Customers|Sales/ })).toHaveCount(0)

      // ── Home figures equal investor_me ──
      const invApi = await restAsSignedInUser(inv)
      const me = await invApi.rpc<Me>('investor_me', {}, false)
      const mine = me.partners.find((p) => p.company_id === companyId)
      expect(mine, 'partner row linked to the investor').toBeTruthy()
      await settled(inv)
      await expect(inv.getByTestId('investor-name')).toHaveText(me.display_name ?? '')
      const row = inv.getByTestId('investor-partner').filter({ hasText: shortName })
      await expect(row.getByTestId('investor-shares')).toHaveAttribute('data-value', String(mine!.shares))
      await expect(row.getByTestId('investor-share-pct')).toHaveAttribute('data-value', String(mine!.share_pct))
      await expect(inv.getByTestId('home-open-requests')).toHaveAttribute('data-value', String(me.open_requests))

      // ── Group figures equal investor_group_summary ──
      const sum = await invApi.rpc<Summary>('investor_group_summary', { p_on: null }, false)
      const c = sum.companies.find((x) => x.company_id === companyId)!
      expect(Number(c.share_capital)).toBe(10000)
      expect(Number(c.investment)).toBe(25000)
      await inv.goto('/investor/group')
      await settled(inv)
      await expect(inv.getByTestId('group-total-share-capital')).toHaveAttribute('data-value', String(sum.totals.share_capital))
      await expect(inv.getByTestId('group-total-investment')).toHaveAttribute('data-value', String(sum.totals.investment))
      await expect(inv.getByTestId('group-total-value')).toHaveAttribute('data-value', String(sum.totals.value_of_my_shares))
      const gRow = inv.getByTestId('group-row').filter({ hasText: shortName })
      await expect(gRow.getByTestId('group-shares')).toHaveAttribute('data-value', String(c.shares))
      await expect(gRow.getByTestId('group-pct')).toHaveAttribute('data-value', String(c.share_pct))
      await expect(gRow.getByTestId('group-share-capital')).toHaveAttribute('data-value', String(c.share_capital))
      await expect(gRow.getByTestId('group-investment')).toHaveAttribute('data-value', String(c.investment))
      await expect(gRow.getByTestId('group-net-worth')).toHaveAttribute('data-value', String(c.net_worth_book))
      await expect(gRow.getByTestId('group-value')).toHaveAttribute('data-value', String(c.value_of_my_shares))
      await gRow.getByRole('button', { name: `Show or hide details for ${shortName}` }).click()
      await expect(inv.getByText('Owed to me ₹20,000.00')).toBeVisible()

      // ── Own records only: the other partner's request and partner row are not readable as the investor ──
      const myReqs = await invApi.view<{ id: string }>('v_investor_requests', 'select=id')
      expect(myReqs.map((r) => r.id)).not.toContain(otherReq.id)
      const raw = await invApi.view<{ id: string }>('v_partner_requests', `select=id&id=eq.${otherReq.id}`)
      expect(raw).toHaveLength(0)
      const partners = await invApi.view<{ id: string }>('v_partners', `select=id&company_id=eq.${companyId}`)
      expect(partners.map((p) => p.id)).not.toContain(other)
      const own = await invApi.view<{ partner_id: string }>('v_investor_partners', `select=partner_id&company_id=eq.${companyId}`)
      expect(own.map((p) => p.partner_id)).toEqual([partner])

      // ── Withdrawal request: sent from the portal, row is `submitted` ──
      await inv.goto('/investor/withdraw')
      await settled(inv)
      const companySelect = inv.getByLabel('Company', { exact: true })
      if (await companySelect.count()) await companySelect.selectOption({ label: shortName })
      await inv.getByLabel('Draw from').selectOption({ label: 'Land rent due' })
      await inv.getByLabel('Amount ₹').fill('10000')
      await inv.getByLabel('Note for Admin').fill('E2E test withdrawal')
      await inv.getByRole('button', { name: 'Send to Admin' }).click()
      await expect(inv.getByTestId('investor-sent')).toContainText('Sent to Admin as PRQ/')
      const okDoc = ((await inv.getByTestId('investor-sent').textContent()) ?? '').match(/PRQ\/\S+?(?=\.\s|$)/)?.[0] ?? ''
      // an amount above what the company owes the partner (synthetic: 50,000 on the current account)
      if (await companySelect.count()) await companySelect.selectOption({ label: shortName })
      await inv.getByLabel('Amount ₹').fill('999999')
      await inv.getByRole('button', { name: 'Send to Admin' }).click()
      await expect(inv.getByTestId('investor-sent')).not.toContainText(okDoc)
      const overDoc = ((await inv.getByTestId('investor-sent').textContent()) ?? '').match(/PRQ\/\S+?(?=\.\s|$)/)?.[0] ?? ''
      const rows = await invApi.view<{ id: string; doc_no: string; status: string; amount: number; kind: string; company_id: string }>('v_investor_requests', `select=id,doc_no,status,amount,kind,company_id&company_id=eq.${companyId}&kind=eq.withdraw&order=created_at.asc`)
      expect(rows).toHaveLength(2)
      expect(rows.map((r) => r.status)).toEqual(['submitted', 'submitted'])
      expect(rows.map((r) => r.doc_no)).toEqual([okDoc, overDoc])
      const [okReq, overReq] = rows as [(typeof rows)[number], (typeof rows)[number]]
      await expect(myRequest(inv, okDoc, shortName)).toContainText('With Admin')

      // ── Admin decides (partner-requests screen if built, otherwise the same RPC) ──
      await admin.rpc('decide_partner_request', { p_request_id: okReq.id, p_decision: 'approve', p_amount: null, p_note: null })
      let refusal = ''
      try {
        await admin.rpc('decide_partner_request', { p_request_id: overReq.id, p_decision: 'approve', p_amount: null, p_note: null })
      } catch (e) {
        refusal = String(e)
      }
      expect(refusal).toContain('partner.over_due')
      expect(refusal).toContain('the withdrawal cannot be more')
      await admin.rpc('decide_partner_request', { p_request_id: overReq.id, p_decision: 'reject', p_amount: null, p_note: 'E2E test: more than the amount due' })

      await inv.reload()
      await settled(inv)
      await expect(myRequest(inv, okDoc, shortName)).toHaveAttribute('data-status', 'approved')
      await expect(myRequest(inv, okDoc, shortName)).toContainText('Approved')
      const rejected = myRequest(inv, overDoc, shortName)
      await expect(rejected).toHaveAttribute('data-status', 'rejected')
      await expect(rejected).toContainText('Admin: E2E test: more than the amount due')
      await expect(inv.getByText(otherReq.doc_no)).toHaveCount(0)

      // ── No write buttons other than requests; axe on every screen at desktop and phone widths ──
      for (const width of [1440, 390]) {
        await inv.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
        for (const path of PAGES) {
          await inv.goto(path)
          await settled(inv)
          await expect(inv.locator('h1')).toHaveCount(1)
          const names = await inv.getByRole('button').evaluateAll((els) => els.filter((e) => !e.hasAttribute('aria-expanded')).map((e) => (e.getAttribute('aria-label') ?? e.textContent ?? '').trim()))
          for (const n of names) expect(n, `unexpected button on ${path}`).toMatch(ALLOWED_BUTTONS)
          await expect(inv.locator('a[href^="/sales"], a[href^="/admin"], a[href^="/accounts"]')).toHaveCount(0)
          await expectNoSeriousA11y(inv)
        }
      }
      await inv.setViewportSize({ width: 390, height: 844 })
      await inv.goto('/investor/sign-in')
      await expect(inv).toHaveURL(/\/investor\/home$/)
    } finally {
      if (inv) await inv.context().close()
      await admin.rpc('remove_role', { p_user_role_id: role.id, p_reason: 'E2E test finished' }).catch((e) => console.warn('E2E cleanup failed:', String(e)))
      for (const [id, name] of [
        [partner, partnerName],
        [other, otherName],
      ] as const) {
        await admin.rpc('upsert_partner', { p: { id, company_id: companyId, display_name: name, user_id: null, status: 'left' } }).catch((e) => console.warn('E2E cleanup failed:', String(e)))
      }
    }

    // The sign-in page itself passes axe (signed out).
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const signIn = await ctx.newPage()
    await signIn.goto('/investor/sign-in')
    await expect(signIn.getByRole('heading', { level: 1, name: 'Investor portal' })).toBeVisible()
    await expectNoSeriousA11y(signIn)
    await signIn.setViewportSize({ width: 1440, height: 1000 })
    await expectNoSeriousA11y(signIn)
    // A non-investor opening the portal goes to their own home.
    await page.goto('/investor/home')
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 })
    await ctx.close()
  })
})

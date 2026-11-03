import { expect, test } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'
import { rand4 } from './phase2-parties-helpers'
import { createPayrollCompany } from './phase3-payroll-setup'
import { restAsSignedInUser } from './phase3-sales-setup'

/**
 * Phase 3 staff app against the DEV database, at phone size: the synthetic staff user (linked to a fresh "E2E Test"
 * staff record) asks for leave and an advance — rows asserted in hr.requests through the API — sees their own posted
 * payslip with the same net as the payroll run, is refused another person's payslip, and every staff page passes axe.
 * Payroll is prepared by Admin and approved by the staff user under a 1-hour special permission (as in the payroll spec).
 */

function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}
const PHONE = { width: 390, height: 844 }

test.describe('Phase 3 · Staff app', () => {
  test.skip(!hasCreds || !creds.staff.email, 'needs .env.test.local')

  test('Staff asks for leave and an advance, and sees only their own payslip', async ({ page, browser }) => {
    test.setTimeout(300_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const s = await createPayrollCompany(page)
    const api = await restAsSignedInUser(page)
    const today = todayIst()
    const month = `${today.slice(0, 7)}-01`

    // Two synthetic staff on the new company; the staff user's sign-in is linked to the first.
    const me = await api.rpc<{ person_id: string; person_code: string }>('save_staff', {
      p: { name: `E2E Test Staff Phone ${rand4()}${rand4()}`, designation: 'E2E Test Helper', pay_company_id: s.companyId, pay_basis: 'monthly', monthly_salary: 21000 },
    })
    const other = await api.rpc<{ person_id: string }>('save_staff', {
      p: { name: `E2E Test Other ${rand4()}${rand4()}`, designation: 'E2E Test Packer', pay_company_id: s.companyId, pay_basis: 'monthly', monthly_salary: 19000 },
    })
    const users = await api.rpc<{ user_id: string; sign_in_email: string | null }[]>('list_users', {}, false)
    const staffUser = users.find((u) => u.sign_in_email === creds.staff.email)
    if (!staffUser) throw new Error('staff user not found')
    await api.rpc('link_person_user', { p_person_id: me.person_id, p_user_id: staffUser.user_id })
    await api.rpc('mark_attendance', {
      p_company_id: s.companyId,
      p_date: today,
      p_entries: [
        { person_id: me.person_id, status: 'P', hours: 8, ot_hours: 0 },
        { person_id: other.person_id, status: 'P', hours: 8, ot_hours: 0 },
      ],
    })
    const prepared = await api.rpc<{ run_id: string }>('prepare_payroll', { p_company_id: s.companyId, p_month: month })
    const runId = prepared.run_id

    // ── The staff phone ──
    const ctx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true })
    const phone = await ctx.newPage()
    try {
      await signInWithEmail(phone, creds.staff)
      await expect(phone).toHaveURL(/\/staff\/home$/)
      const staffApi = await restAsSignedInUser(phone)

      // Second approver for the payroll (the preparer may not approve): a 1-hour Payroll permission for this company only.
      const now = new Date()
      const grant = await api.rpc<{ id: string }>('grant_special_permission', {
        p_user_id: staffUser.user_id,
        p_right: 'payroll.run',
        p_company_id: s.companyId,
        p_params: {},
        p_starts_at: new Date(now.getTime() - 60_000).toISOString(),
        p_ends_at: new Date(now.getTime() + 60 * 60_000).toISOString(),
        p_max_uses: null,
        p_reason: 'E2E test: second approver for payroll',
      })
      try {
        await staffApi.rpc('approve_payroll', { p_run_id: runId })
      } finally {
        await api.rpc('revoke_special_permission', { p_grant_id: grant.id, p_reason: 'E2E test finished' })
      }

      // Home
      await phone.reload()
      await expect(phone.getByText(me.person_code).first()).toBeVisible({ timeout: 15_000 })
      await expect(phone.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 })
      await expectNoSeriousA11y(phone)

      // ── Leave: a half day of sick leave ──
      await phone.getByRole('link', { name: 'Request leave' }).click()
      await expect(phone.getByRole('heading', { level: 1, name: 'Request leave' })).toBeVisible()
      await expectNoSeriousA11y(phone)
      await phone.getByRole('radio', { name: 'Sick' }).check()
      await phone.getByLabel('From', { exact: true }).fill(today)
      await phone.getByLabel('Half day only').check()
      await phone.getByLabel('Reason').fill('E2E test leave')
      await phone.getByRole('button', { name: 'Send request' }).click()
      await expect(phone.getByRole('status').filter({ hasText: 'Request sent' })).toBeVisible({ timeout: 15_000 })
      const leaves = await staffApi.view<{ kind: string; leave_type: string; half_day: boolean; from_date: string; to_date: string; status: string; person_id: string; reason: string }>(
        'staff_requests',
        `person_id=eq.${me.person_id}&kind=eq.leave&select=kind,leave_type,half_day,from_date,to_date,status,person_id,reason`,
      )
      expect(leaves).toHaveLength(1)
      expect(leaves[0]).toMatchObject({ leave_type: 'sick', half_day: true, from_date: today, to_date: today, status: 'pending', reason: 'E2E test leave' })
      await expect(phone.getByRole('heading', { name: 'My leave requests' })).toBeVisible()
      await expectNoSeriousA11y(phone)

      // ── Advance ──
      await phone.getByRole('link', { name: 'Advance', exact: true }).click()
      await expect(phone.getByRole('heading', { level: 1, name: 'Request advance' })).toBeVisible()
      await expectNoSeriousA11y(phone)
      await phone.getByLabel('Amount').fill('2500')
      await phone.getByRole('radio', { name: '3' }).check()
      await phone.getByLabel('Paid in').selectOption('bank')
      await phone.getByLabel('Reason').fill('E2E test advance')
      await phone.getByRole('button', { name: 'Send request' }).click()
      await expect(phone.getByRole('status').filter({ hasText: 'Request sent' })).toBeVisible({ timeout: 15_000 })
      const adv = await staffApi.view<{ amount: number; repay_months: number; paid_in: string; status: string; from_date: string | null }>(
        'staff_requests',
        `person_id=eq.${me.person_id}&kind=eq.advance&select=amount,repay_months,paid_in,status,from_date`,
      )
      expect(adv).toHaveLength(1)
      expect(Number(adv[0]?.amount)).toBe(2500)
      expect(adv[0]).toMatchObject({ repay_months: 3, paid_in: 'bank', status: 'pending', from_date: null })
      await expectNoSeriousA11y(phone)

      // ── My details (masked, read-only) ──
      await phone.goto('/staff/details')
      await expect(phone.getByRole('heading', { level: 1, name: 'My details' })).toBeVisible()
      await expect(phone.getByText(me.person_code)).toBeVisible({ timeout: 15_000 })
      await expect(phone.getByText('Locked')).toBeVisible()
      await expectNoSeriousA11y(phone)

      // ── Payslip: own, posted, same net as the run ──
      const [slip] = await api.view<{ id: string; net: number }>('payslips', `run_id=eq.${runId}&person_id=eq.${me.person_id}&select=id,net`)
      const [otherSlip] = await api.view<{ id: string }>('payslips', `run_id=eq.${runId}&person_id=eq.${other.person_id}&select=id`)
      expect(slip?.id).toBeTruthy()
      await phone.goto('/staff/payslip')
      await expect(phone.getByRole('heading', { level: 1, name: 'Payslip' })).toBeVisible()
      const netText = `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(Number(slip?.net)))}`
      await expect(phone.getByTestId('payslip-net')).toHaveText(netText, { timeout: 15_000 })
      await expectNoSeriousA11y(phone)

      // Only their own: the list holds this one payslip, and another person's payslip is refused by the server.
      const mine = await staffApi.rpc<{ payslips: { id: string }[] }>('staff_me', {}, false)
      expect(mine.payslips.map((p) => p.id)).toEqual([slip?.id])
      await expect(staffApi.rpc('payslip', { p_payslip_id: otherSlip?.id }, false)).rejects.toThrow(/42501|rights|right/)
    } finally {
      await ctx.close()
    }
  })
})

import { expect, test, type Page } from '@playwright/test'
import { creds, expectNoSeriousA11y, hasCreds, signInWithEmail } from './helpers'
import { rand4 } from './phase2-parties-helpers'
import { createPayrollCompany } from './phase3-payroll-setup'
import { restAsSignedInUser, type Rest } from './phase3-sales-setup'

/**
 * Phase 3 HR and payroll against the DEV database: add a staff member, mark attendance with overtime, a staff app
 * request decided by another user, cash given against it, payroll prepared and the preparer's approval refused, then
 * approval by a second user with Payroll right (a 1-hour special permission given to the synthetic staff user only),
 * with the payslips, the GL voucher and the advance recovery asserted in the database, and axe on every HR screen.
 * Synthetic data only (a fresh "E2E Test Payroll" company per run).
 */

function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}
function ddmmyyyy(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d}-${m}-${y}`
}
function daysInMonth(iso: string): number {
  const [y, m] = iso.split('-').map(Number)
  return new Date(Date.UTC(y ?? 2000, m ?? 1, 0)).getUTCDate()
}
const paise = (v: number | string | null | undefined) => Math.round(Number(v ?? 0) * 100)

interface KycRow {
  person_id: string
  person_code: string
  name: string
  pay_company_id: string | null
  aadhaar_masked: string | null
  designation: string | null
}

async function staffByName(api: Rest, name: string): Promise<KycRow> {
  const rows = await api.rpc<KycRow[]>('staff_kyc', {}, false)
  const r = rows.find((x) => x.name === name)
  if (!r) throw new Error(`staff ${name} not found`)
  return r
}

async function statusText(page: Page, re: RegExp): Promise<string> {
  const s = page.getByRole('status').filter({ hasText: re })
  await expect(s).toBeVisible({ timeout: 20_000 })
  return ((await s.textContent()) ?? '').match(re)?.[1] ?? ''
}

test.describe('Phase 3 · HR and payroll', () => {
  test.skip(!hasCreds || !creds.staff.email, 'needs .env.test.local')

  test('Add staff, attendance with overtime, a request decided by another user, cash given, payroll refused to its preparer and approved by a second user', async ({ page, browser }) => {
    test.setTimeout(360_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const s = await createPayrollCompany(page)
    const api = await restAsSignedInUser(page)
    const today = todayIst()
    const month = `${today.slice(0, 7)}-01`
    const q = `company=${s.companyId}`

    // ── Add a staff member through the screen ──
    const worker = `E2E Test Worker ${rand4()}${rand4()}`
    await page.goto('/hr-and-payroll/employees-and-kyc/add-staff')
    await expect(page.getByRole('heading', { level: 1, name: 'Add staff member' })).toBeVisible()
    await page.getByLabel('Full name as on ID').fill(worker)
    await page.getByLabel('Aadhaar', { exact: true }).fill('1111 2222 3333')
    await page.getByLabel('Designation', { exact: true }).fill('E2E Test Operator')
    await page.getByLabel('Payslip from').selectOption({ label: s.shortName })
    await page.getByLabel('Pay group').selectOption('monthly')
    await page.getByLabel('Monthly salary').fill('30000')
    await expectNoSeriousA11y(page)
    await page.getByRole('button', { name: 'Save staff member' }).first().click()
    const code = await statusText(page, /Saved as (EMP-\d+)/)
    const w = await staffByName(api, worker)
    expect(w.person_code).toBe(code)
    expect(w.pay_company_id).toBe(s.companyId)
    expect(w.aadhaar_masked).toBe('XXXX XXXX 3333')
    expect(w.designation).toBe('E2E Test Operator')

    // A second person, linked to the synthetic staff user's sign-in (the staff app sends their request).
    const appPerson = `E2E Test Staff App ${rand4()}${rand4()}`
    const saved = await api.rpc<{ person_id: string; person_code: string }>('save_staff', {
      p: { name: appPerson, designation: 'E2E Test Helper', pay_company_id: s.companyId, pay_basis: 'monthly', monthly_salary: 20000 },
    })
    const users = await api.rpc<{ user_id: string; sign_in_email: string | null }[]>('list_users', {}, false)
    const staffUser = users.find((u) => u.sign_in_email === creds.staff.email)
    if (!staffUser) throw new Error('staff user not found')
    await api.rpc('link_person_user', { p_person_id: saved.person_id, p_user_id: staffUser.user_id })

    // ── Employees & KYC: masked Aadhaar in the detail ──
    await page.goto('/hr-and-payroll/employees-and-kyc')
    await expect(page.getByRole('heading', { level: 1, name: 'Employees · KYC' })).toBeVisible()
    await page.getByRole('button', { name: `Open ${worker}` }).click()
    await expect(page.getByText('XXXX XXXX 3333')).toBeVisible()
    await expectNoSeriousA11y(page)

    // ── Attendance with overtime ──
    await page.goto(`/hr-and-payroll/attendance?${q}`)
    await expect(page.getByRole('heading', { level: 1, name: /^Attendance · / })).toBeVisible()
    await page.getByLabel(`Status, ${worker}`).selectOption('P')
    await page.getByLabel(`Overtime hours, ${worker}`).fill('2')
    await page.getByRole('button', { name: 'Mark the rest present' }).click()
    await page.getByRole('button', { name: 'Save attendance' }).click()
    await statusText(page, new RegExp(`(Saved 2 marks for ${ddmmyyyy(today)})`))
    const att = await api.view<{ person_id: string; status: string; ot_hours: number }>('attendance', `company_id=eq.${s.companyId}&work_date=eq.${today}&select=person_id,status,ot_hours`)
    expect(att).toHaveLength(2)
    expect(att.find((a) => a.person_id === w.person_id)).toMatchObject({ status: 'P' })
    expect(Number(att.find((a) => a.person_id === w.person_id)?.ot_hours)).toBe(2)
    await expectNoSeriousA11y(page)

    // ── The staff user asks for an advance; Admin (another user) approves it ──
    const staffCtx = await browser.newContext()
    const staffPage = await staffCtx.newPage()
    await signInWithEmail(staffPage, creds.staff)
    await expect(staffPage).toHaveURL(/\/staff\/home$/)
    const staffApi = await restAsSignedInUser(staffPage)
    const req = await staffApi.rpc<{ id: string }>('submit_staff_request', { p: { kind: 'advance', amount: 1500, reason: 'E2E test advance' } })

    await page.goto('/hr-and-payroll/leave-and-advance-requests')
    await expect(page.getByRole('heading', { level: 1, name: 'Leave and advance requests' })).toBeVisible()
    await expectNoSeriousA11y(page)
    await page.getByRole('button', { name: `Approve Advance request of ${appPerson}` }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Approve' }).click()
    await expect(dialog).toBeHidden({ timeout: 15_000 })
    await expect.poll(async () => (await api.view<{ status: string }>('staff_requests', `id=eq.${req.id}&select=status`))[0]?.status, { timeout: 15_000 }).toBe('approved')

    // ── Cash given against the approved advance ──
    await page.goto(`/hr-and-payroll/cash-given-to-staff?${q}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Cash given to staff' })).toBeVisible()
    await page.getByLabel('Staff member').selectOption({ label: `${appPerson} · ${saved.person_code}` })
    await page.getByLabel('Against an approved advance request').selectOption({ index: 1 })
    await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('1500')
    await page.getByRole('button', { name: 'Give cash', exact: true }).click()
    const payNo = await statusText(page, /Posted (EPP\/\S+)/)
    const [given] = await api.view<{ amount: number; voucher_id: string; recovered: boolean }>('cash_given', `person_id=eq.${saved.person_id}&company_id=eq.${s.companyId}&select=amount,voucher_id,recovered`)
    expect(Number(given?.amount)).toBe(1500)
    expect(given?.recovered).toBe(false)
    const [payV] = await api.view<{ doc_no: string; mode: string; amount: number }>('vouchers', `id=eq.${given?.voucher_id}&select=doc_no,mode,amount`)
    expect(payV).toMatchObject({ doc_no: payNo, mode: 'cash' })
    await expectNoSeriousA11y(page)

    // ── Payroll: prepared by Admin; Admin's own approval is refused with the server's message ──
    await page.goto(`/hr-and-payroll/payroll?${q}`)
    await expect(page.getByRole('heading', { level: 1, name: /^Payroll · / })).toBeVisible()
    await expect(page.getByText(/^No payroll for /)).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Prepare payroll' }).click()
    await statusText(page, /(Payroll prepared)/)
    const [run] = await api.view<{ id: string; status: string; prepared_by: string }>('payroll_runs', `company_id=eq.${s.companyId}&month=eq.${month}&select=id,status,prepared_by`)
    expect(run?.status).toBe('draft')
    const slips = await api.view<{ person_id: string; ot_hours: number; ot_pay: number; basic: number; gross: number; net: number; advance_recovery: number }>(
      'payslips',
      `run_id=eq.${run?.id}&select=person_id,ot_hours,ot_pay,basic,gross,net,advance_recovery`,
    )
    expect(slips).toHaveLength(2)
    const [mult] = await api.view<{ value: number; company_id: string | null }>('settings_current', 'key=eq.payroll.ot_multiplier&company_id=is.null&select=value,company_id')
    const n = daysInMonth(month)
    const ws = slips.find((x) => x.person_id === w.person_id)
    expect(Number(ws?.ot_hours)).toBe(2)
    expect(paise(ws?.ot_pay)).toBe(Math.round(2 * (30000 / n / 8) * Number(mult?.value) * 100))
    await expect(page.getByRole('table', { name: 'Monthly salary' }).getByRole('row').filter({ hasText: worker })).toBeVisible()
    await expectNoSeriousA11y(page)

    await page.getByRole('button', { name: 'Approve and pay' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Approve and pay' }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'the person who prepared the payroll cannot approve it' })).toBeVisible({ timeout: 15_000 })
    expect((await api.view<{ status: string }>('payroll_runs', `id=eq.${run?.id}&select=status`))[0]?.status).toBe('draft')
    await expectNoSeriousA11y(page)

    // ── A second user with the Payroll right (1-hour special permission for this company) approves ──
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
      await staffPage.goto(`/hr-and-payroll/payroll?${q}`)
      await expect(staffPage.getByRole('heading', { level: 1, name: /^Payroll · / })).toBeVisible()
      await staffPage.getByRole('button', { name: 'Approve and pay' }).click()
      await staffPage.getByRole('dialog').getByRole('button', { name: 'Approve and pay' }).click()
      await statusText(staffPage, /(Payroll approved and posted)/)
    } finally {
      await api.rpc('revoke_special_permission', { p_grant_id: grant.id, p_reason: 'E2E test finished' })
      await staffCtx.close()
    }

    const [posted] = await api.view<{ status: string; approved_by: string; voucher_id: string }>('payroll_runs', `id=eq.${run?.id}&select=status,approved_by,voucher_id`)
    expect(posted?.status).toBe('posted')
    expect(posted?.approved_by).toBe(staffUser.user_id)
    expect(posted?.approved_by).not.toBe(run?.prepared_by)
    const [pv] = await api.view<{ voucher_type: string; doc_no: string; source_id: string }>('vouchers', `id=eq.${posted?.voucher_id}&select=voucher_type,doc_no,source_id`)
    expect(pv).toMatchObject({ voucher_type: 'payroll', doc_no: `PAY/${month.slice(0, 7)}`, source_id: run?.id })
    const gl = await api.view<{ account_id: string; dr: number; cr: number }>('gl_lines', `voucher_id=eq.${posted?.voucher_id}&select=account_id,dr,cr`)
    const finalSlips = await api.view<{ gross: number; net: number; advance_recovery: number; run_status: string }>('payslips', `run_id=eq.${run?.id}&select=gross,net,advance_recovery,run_status`)
    const gross = finalSlips.reduce((t, x) => t + paise(x.gross), 0)
    const net = finalSlips.reduce((t, x) => t + paise(x.net), 0)
    const adv = finalSlips.reduce((t, x) => t + paise(x.advance_recovery), 0)
    expect(finalSlips.every((x) => x.run_status === 'posted')).toBe(true)
    expect(gl.reduce((t, l) => t + paise(l.dr), 0)).toBe(gl.reduce((t, l) => t + paise(l.cr), 0))
    expect(paise(gl.find((l) => l.account_id === s.accounts.salary_expense)?.dr)).toBe(gross)
    expect(paise(gl.find((l) => l.account_id === s.accounts.salary_payable)?.cr)).toBe(net)
    expect(adv).toBeGreaterThan(0)
    expect(paise(gl.find((l) => l.account_id === s.accounts.advances)?.cr)).toBe(adv)
    expect((await api.view<{ recovered: boolean }>('cash_given', `person_id=eq.${saved.person_id}&company_id=eq.${s.companyId}&select=recovered`))[0]?.recovered).toBe(true)

    // Admin sees the run posted with its voucher number.
    await page.goto(`/hr-and-payroll/payroll?${q}`)
    await expect(page.getByTestId('payroll-voucher')).toContainText(`PAY/${month.slice(0, 7)}`, { timeout: 15_000 })

    // The approved month is locked for attendance.
    await page.goto(`/hr-and-payroll/attendance?${q}`)
    await page.getByLabel(`Overtime hours, ${worker}`).fill('3')
    await page.getByRole('button', { name: 'Save attendance' }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'locked' })).toBeVisible({ timeout: 15_000 })
  })

  test('Every HR screen renders from the database and passes axe', async ({ page }) => {
    test.setTimeout(240_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const screens: [string, RegExp | string][] = [
      ['/hr-and-payroll/employees-and-kyc', 'Employees · KYC'],
      ['/hr-and-payroll/employees-and-kyc/add-staff', 'Add staff member'],
      ['/hr-and-payroll/attendance', /^Attendance · /],
      ['/hr-and-payroll/workers-and-hours', 'Workers, companies and hours'],
      ['/hr-and-payroll/workers-and-hours/staff-workflow', 'How staff work across Southfield Group'],
      ['/hr-and-payroll/staff-duties', 'Staff duties'],
      ['/hr-and-payroll/staff-rotation', 'Staff rotation'],
      ['/hr-and-payroll/leave-and-advance-requests', 'Leave and advance requests'],
      ['/hr-and-payroll/allowances-and-benefits', 'Allowances and benefits'],
      ['/hr-and-payroll/cash-given-to-staff', 'Cash given to staff'],
      ['/hr-and-payroll/payroll', /^Payroll · /],
      ['/hr-and-payroll/payroll/payroll-biochem', /^Payroll · /],
      ['/hr-and-payroll/payroll/payroll-biochem-trend', /payroll · FY /],
    ]
    for (const [path, title] of screens) {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 })
      await expectNoSeriousA11y(page)
    }
  })

  test('Duties and rotation save through the database', async ({ page }) => {
    test.setTimeout(180_000)
    await signInWithEmail(page, creds.admin)
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible()
    const s = await createPayrollCompany(page)
    const api = await restAsSignedInUser(page)
    const name = `E2E Test Duty ${rand4()}${rand4()}`
    const p = await api.rpc<{ person_id: string }>('save_staff', { p: { name, designation: 'E2E Test Packer', pay_company_id: s.companyId } })
    const today = todayIst()

    await page.goto('/hr-and-payroll/staff-duties')
    await expect(page.getByRole('heading', { level: 1, name: 'Staff duties' })).toBeVisible()
    await page.getByLabel(`Works for, ${name}`).selectOption({ label: s.shortName })
    await page.getByLabel(`Duty, ${name}`).fill('E2E Test Packing')
    await page.getByLabel(`Shift, ${name}`).selectOption('night')
    await page.getByRole('button', { name: 'Save duties' }).click()
    await statusText(page, /(Saved \d+ duties)/)
    const [d] = await api.view<{ company_id: string; duty: string; shift: string }>('duties', `person_id=eq.${p.person_id}&duty_date=eq.${today}&select=company_id,duty,shift`)
    expect(d).toMatchObject({ company_id: s.companyId, duty: 'E2E Test Packing', shift: 'night' })
    await expectNoSeriousA11y(page)

    await page.goto('/hr-and-payroll/staff-rotation')
    await expect(page.getByRole('heading', { level: 1, name: 'Staff rotation' })).toBeVisible()
    await expect(page.getByRole('button', { name: new RegExp(`^Change the duty of ${name} on ${ddmmyyyy(today)}`) })).toContainText('E2E Test Packing')
    await page.getByRole('button', { name: new RegExp(`^Change the duty of ${name} on ${ddmmyyyy(today)}`) }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Duty', { exact: true }).fill('E2E Test Stores')
    await dialog.getByRole('button', { name: 'Save duty' }).click()
    await expect(dialog).toBeHidden({ timeout: 15_000 })
    await expect.poll(async () => (await api.view<{ duty: string }>('duties', `person_id=eq.${p.person_id}&duty_date=eq.${today}&select=duty`))[0]?.duty, { timeout: 15_000 }).toBe('E2E Test Stores')
    await expectNoSeriousA11y(page)
  })
})

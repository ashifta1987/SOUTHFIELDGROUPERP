import { test } from '@playwright/test'
import { creds, hasCreds, signInWithEmail } from './helpers'

/** Phase 3 review screenshots (docs/review/phase-3). Synthetic accounts and E2E rows only. */
const OUT = 'docs/review/phase-3'
const DESKTOP: [string, string][] = [
  ['Main', '/'],
  ['Invoice', '/sales/invoices'],
  ['SalesRegister', '/sales/invoices/sales-register'],
  ['CompanyPortal', '/sales/invoices/company-portal'],
  ['Receipts', '/sales/receipts'],
  ['BillsPayments', '/purchase/bills-and-payments'],
  ['CashBook', '/accounts/cash-book'],
  ['CashBookCheck', '/accounts/cash-book/cash-book-check'],
  ['CashFlow', '/accounts/cash-flow-and-reminders'],
  ['BankReco', '/accounts/bank'],
  ['DocTemplates', '/admin/document-templates'],
  ['WhatsApp', '/admin/whatsapp-and-email'],
  ['StaffKYC', '/hr-and-payroll/employees-and-kyc'],
  ['AddStaff', '/hr-and-payroll/employees-and-kyc/add-staff'],
  ['Attendance', '/hr-and-payroll/attendance'],
  ['WorkerHours', '/hr-and-payroll/workers-and-hours'],
  ['StaffWorkflow', '/hr-and-payroll/workers-and-hours/staff-workflow'],
  ['StaffDuties', '/hr-and-payroll/staff-duties'],
  ['StaffRotation', '/hr-and-payroll/staff-rotation'],
  ['Requests', '/hr-and-payroll/leave-and-advance-requests'],
  ['Allowances', '/hr-and-payroll/allowances-and-benefits'],
  ['CashGiven', '/hr-and-payroll/cash-given-to-staff'],
  ['Payroll', '/hr-and-payroll/payroll'],
  ['PayrollBiochem', '/hr-and-payroll/payroll/payroll-biochem'],
  ['PayrollBiochemTrend', '/hr-and-payroll/payroll/payroll-biochem-trend'],
]
const PHONE: [string, string][] = [
  ['StaffHome', '/staff/home'],
  ['StaffLeave', '/staff/leave'],
  ['StaffAdvance', '/staff/advance'],
  ['StaffDetails', '/staff/details'],
  ['StaffPayslip', '/staff/payslip'],
]

test('phase 3 review screenshots (desktop)', async ({ page }) => {
  test.skip(!process.env.REVIEW_SHOTS || !hasCreds)
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await signInWithEmail(page, creds.admin)
  await page.getByRole('heading', { level: 1, name: 'Today' }).waitFor()
  for (const [name, route] of DESKTOP) {
    await page.goto(route)
    await page.getByRole('heading', { level: 1 }).first().waitFor()
    await page.waitForTimeout(1200)
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/me/cash-entry')
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${OUT}/CashEntry.png`, fullPage: true })
})

test('phase 3 review screenshots (staff phone)', async ({ page }) => {
  test.skip(!process.env.REVIEW_SHOTS || !hasCreds)
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 390, height: 844 })
  await signInWithEmail(page, creds.staff)
  await page.waitForURL(/\/staff\/home$/)
  for (const [name, route] of PHONE) {
    await page.goto(route)
    await page.waitForTimeout(1500)
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true })
  }
})


import type { Page } from '@playwright/test'
import { rand4, randomPan } from './phase2-parties-helpers'
import { restAsSignedInUser } from './phase3-sales-setup'

/**
 * Phase 3 payroll set-up through the same RPCs the screens use (signed-in admin's own token). A fresh synthetic
 * company per run ("E2E Test Payroll …"), because a month's payroll can be approved only once per company: open FY,
 * a payment number series, payroll and round-off ledgers with their posting rules, and a cash account.
 */
export interface PayrollSetup {
  companyId: string
  code: string
  shortName: string
  fyId: string
  cashId: string
  accounts: Record<'salary_expense' | 'salary_payable' | 'advances' | 'deductions' | 'round_off', string>
}

function fyStartYear(): number {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const [y, m] = today.split('-').map(Number)
  return (m ?? 1) >= 4 ? (y ?? 2000) : (y ?? 2000) - 1
}

export async function createPayrollCompany(page: Page): Promise<PayrollSetup> {
  const api = await restAsSignedInUser(page)
  const code = `E2EP${rand4()}`
  const shortName = `E2E Pay ${code.slice(4)}`
  const company = await api.rpc<{ id: string }>('upsert_company', {
    p: { code, legal_name: `E2E Test Payroll Company ${code.slice(4)}`, short_name: shortName, pan: randomPan(), registered_address: 'E2E Test Address, Kerala' },
  })
  const companyId = company.id
  const fy = await api.rpc<{ id: string }>('open_financial_year', { p_company_id: companyId, p_start_year: fyStartYear() })
  await api.rpc('upsert_doc_series', { p: { company_id: companyId, gstin_id: null, doc_type: 'payment', fy_id: fy.id, prefix: 'EPP', pad: 4, next_no: 1 } })

  async function group(name: string, nature: string): Promise<string> {
    return (await api.rpc<{ id: string }>('upsert_account_group', { p: { company_id: companyId, name, nature, is_party_group: null } })).id
  }
  const gExp = await group('E2E Test Salaries', 'expense')
  const gLiab = await group('E2E Test Salary Payable', 'liability')
  const gAsset = await group('E2E Test Staff Advances', 'asset')
  const gCash = await group('E2E Test Cash', 'asset')
  async function account(name: string, groupId: string): Promise<string> {
    return (await api.rpc<{ id: string }>('upsert_account', { p: { company_id: companyId, group_id: groupId, name } })).id
  }
  const accounts = {
    salary_expense: await account('E2E Test Salary Expense', gExp),
    salary_payable: await account('E2E Test Salary Payable', gLiab),
    advances: await account('E2E Test Staff Advances', gAsset),
    deductions: await account('E2E Test Salary Deductions', gLiab),
    round_off: await account('E2E Test Round Off', gExp),
  }
  for (const [event, id] of [
    ['payroll.salary_expense', accounts.salary_expense],
    ['payroll.salary_payable', accounts.salary_payable],
    ['payroll.advances', accounts.advances],
    ['payroll.deductions', accounts.deductions],
    ['round_off', accounts.round_off],
  ] as const) {
    await api.rpc('set_posting_rule', { p_company_id: companyId, p_event: event, p_account_id: id, p_note: 'E2E test' })
  }
  const cash = await api.rpc<{ id: string }>('add_money_account', { p: { company_id: companyId, group_id: gCash, name: 'E2E Test Cash', kind: 'cash' } })
  return { companyId, code, shortName, fyId: fy.id, cashId: cash.id, accounts }
}

import type { Page } from '@playwright/test'
import { rand4, randomPan, syntheticGstin } from './phase2-parties-helpers'
import { ensureSalesSetup, restAsSignedInUser, type SalesSetup } from './phase3-sales-setup'

/**
 * Phase 3 money set-up on top of the sales set-up, through the same RPCs the screens use (signed-in admin's token).
 * Synthetic values only (names "E2E Test …"). Adds: payment / journal / contra number series, a creditors group,
 * purchase and input-GST ledgers (input GST rules set here; the purchase rule is set through the Bank → Set-up
 * screen by the spec), and a new supplier in Kerala.
 */
export interface MoneySetup extends SalesSetup {
  fyId: string
  purchaseAccounts: { id: string; name: string; label: string }[]
  supplier: { id: string; name: string; gstin: string }
}

type Row = Record<string, unknown> & { id: string }

export async function ensureMoneySetup(page: Page): Promise<MoneySetup> {
  const s = await ensureSalesSetup(page)
  const api = await restAsSignedInUser(page)
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const [fy] = await api.view<Row>('financial_years', `company_id=eq.${s.companyId}&starts_on=lte.${today}&ends_on=gte.${today}&select=id`)
  if (!fy) throw new Error('no FY')

  const series = await api.view<{ doc_type: string }>('doc_series', `company_id=eq.${s.companyId}&fy_id=eq.${fy.id}&select=doc_type`)
  for (const [doc_type, prefix] of [
    ['payment', 'EPY'],
    ['journal', 'EJV'],
    ['contra', 'ECT'],
  ] as const) {
    if (!series.some((x) => x.doc_type === doc_type)) {
      await api.rpc('upsert_doc_series', { p: { company_id: s.companyId, gstin_id: null, doc_type, fy_id: fy.id, prefix, pad: 4, next_no: 1 } })
    }
  }

  const groups = await api.view<Row & { name: string }>('account_groups', `company_id=eq.${s.companyId}&select=id,name`)
  async function group(name: string, nature: string, party: string | null): Promise<string> {
    const found = groups.find((x) => x.name === name)
    if (found) return found.id
    const res = await api.rpc<{ id: string }>('upsert_account_group', { p: { company_id: s.companyId, name, nature, is_party_group: party } })
    groups.push({ id: res.id, name })
    return res.id
  }
  await group('E2E Test Creditors', 'liability', 'creditors')
  const gPurch = await group('E2E Test Purchase Accounts', 'expense', null)
  const gDuties = await group('E2E Test Duties and Taxes', 'liability', null)

  const accounts = await api.view<Row & { name: string }>('accounts', `company_id=eq.${s.companyId}&select=id,name`)
  async function account(name: string, groupId: string): Promise<string> {
    const found = accounts.find((x) => x.name === name)
    if (found) return found.id
    const res = await api.rpc<{ id: string }>('upsert_account', { p: { company_id: s.companyId, group_id: groupId, name } })
    accounts.push({ id: res.id, name })
    return res.id
  }
  const purchaseAccounts = [
    { id: await account('E2E Test Purchases A', gPurch), name: 'E2E Test Purchases A', label: 'E2E Test Purchases A · E2E Test Purchase Accounts' },
    { id: await account('E2E Test Purchases B', gPurch), name: 'E2E Test Purchases B', label: 'E2E Test Purchases B · E2E Test Purchase Accounts' },
  ]
  const rules: [string, string][] = [
    ['gst.input_cgst', await account('E2E Test Input CGST', gDuties)],
    ['gst.input_sgst', await account('E2E Test Input SGST', gDuties)],
    ['gst.input_igst', await account('E2E Test Input IGST', gDuties)],
  ]
  const existing = await api.view<{ event: string }>('posting_rules', `company_id=eq.${s.companyId}&select=event`)
  for (const [event, accountId] of rules) {
    if (!existing.some((r) => r.event === event)) await api.rpc('set_posting_rule', { p_company_id: s.companyId, p_event: event, p_account_id: accountId, p_note: 'E2E test' })
  }

  const name = `E2E Test Supplier ${rand4()}${rand4()}`
  const gstin = syntheticGstin(randomPan(), '32')
  const party = await api.rpc<{ id: string }>('upsert_party', {
    p: { company_id: s.companyId, legal_name: name, is_supplier: true, gstin, address: 'E2E Test Road', city: 'Thrissur', pincode: '680001', force: true },
  })
  return { ...s, fyId: fy.id, purchaseAccounts, supplier: { id: party.id, name, gstin } }
}

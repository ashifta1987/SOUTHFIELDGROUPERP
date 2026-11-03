import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { expect, type Page } from '@playwright/test'
import { rand4, randomPan, syntheticGstin } from './phase2-parties-helpers'

/**
 * Phase 3 sales set-up through the Supabase REST API with the signed-in admin's own access token (taken from the
 * browser's session storage after a normal sign-in), so every row is created by the same RPCs the screens use and
 * every right is checked. All values are synthetic (codes start E2E, names "E2E Test …"). Idempotent: an existing
 * E2E sales company, its GSTIN, FY, series, ledgers, posting rules, HSN and products are reused.
 */

function readEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const f of ['.env.local', '.env.test.local']) {
    if (!existsSync(f)) continue
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m && m[1]) env[m[1]] = (m[2] ?? '').trim()
    }
  }
  return env
}

export interface Rest {
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>, idempotent?: boolean): Promise<T>
  view<T = Record<string, unknown>>(name: string, query: string): Promise<T[]>
}

/** REST client that runs as the admin signed in on `page`. */
export async function restAsSignedInUser(page: Page): Promise<Rest> {
  const env = readEnv()
  const url = env.VITE_SUPABASE_URL
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) throw new Error('VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY missing in .env.local')
  await expect.poll(async () => page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('sb-') && k.endsWith('-auth-token'))), { timeout: 15_000 }).toBe(true)
  const token = await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('sb-') && x.endsWith('-auth-token'))
    const raw = k ? localStorage.getItem(k) : null
    return raw ? (JSON.parse(raw) as { access_token: string }).access_token : ''
  })
  const headers = { apikey: key, Authorization: `Bearer ${token}`, 'Accept-Profile': 'api', 'Content-Profile': 'api', 'Content-Type': 'application/json' }
  return {
    async rpc<T>(fn: string, args: Record<string, unknown> = {}, idempotent = true): Promise<T> {
      const body = idempotent ? { p_client_request_id: randomUUID(), ...args } : args
      const r = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(body) })
      const text = await r.text()
      if (!r.ok) throw new Error(`${fn} failed (${r.status}): ${text}`)
      return (text ? JSON.parse(text) : null) as T
    },
    async view<T>(name: string, query: string): Promise<T[]> {
      const r = await fetch(`${url}/rest/v1/${name}?${query}`, { headers })
      const text = await r.text()
      if (!r.ok) throw new Error(`${name} read failed (${r.status}): ${text}`)
      return JSON.parse(text) as T[]
    },
  }
}

function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}
function fyStartYear(): number {
  const [y, m] = todayIst().split('-').map(Number)
  return (m ?? 1) >= 4 ? (y ?? 2000) : (y ?? 2000) - 1
}

export interface SalesSetup {
  companyId: string
  companyName: string
  gstinId: string
  gstin: string
  products: { id: string; code: string; name: string }[]
  customer: { id: string; name: string; gstin: string }
}

const CODE = 'E2ESALES'
const HSN = '99990018'

type Row = Record<string, unknown> & { id: string }

/** Company + GSTIN (Kerala) + open FY + number series + ledgers + posting rules + cash/bank + HSN 18% + 2 products (with MRP) + a new verified customer in Kerala. */
export async function ensureSalesSetup(page: Page): Promise<SalesSetup> {
  const api = await restAsSignedInUser(page)
  const today = todayIst()
  const startYear = fyStartYear()

  // Company (active, with a PAN so the GSTIN can carry it).
  let [company] = await api.view<Row & { pan: string | null; status: string; name: string }>('companies', `code=eq.${CODE}&select=id,name,pan,status`)
  if (!company) {
    const pan = randomPan()
    const res = await api.rpc<{ id: string }>('upsert_company', { p: { code: CODE, legal_name: 'E2E Test Sales Company', short_name: 'E2E Test Sales', pan, registered_address: 'E2E Test Address, Kerala' } })
    company = { id: res.id, name: 'E2E Test Sales Company', pan, status: 'active' }
  } else if (company.status !== 'active' || !company.pan) {
    const pan = company.pan ?? randomPan()
    await api.rpc('upsert_company', { p: { id: company.id, status: 'active', pan } })
    company = { ...company, pan, status: 'active' }
  }
  const companyId = company.id

  // GSTIN in Kerala (32).
  let [g] = await api.view<Row & { gstin: string }>('gstins', `company_id=eq.${companyId}&select=id,gstin`)
  if (!g) {
    const gstin = syntheticGstin(company.pan ?? randomPan(), '32')
    const res = await api.rpc<{ id: string }>('upsert_gstin', { p: { company_id: companyId, gstin, legal_name: 'E2E Test Sales Company', is_principal: true } })
    g = { id: res.id, gstin }
  }

  // Financial year covering today.
  let [fy] = await api.view<Row>('financial_years', `company_id=eq.${companyId}&starts_on=lte.${today}&ends_on=gte.${today}&select=id`)
  if (!fy) {
    const res = await api.rpc<{ id: string }>('open_financial_year', { p_company_id: companyId, p_start_year: startYear })
    fy = { id: res.id }
  }

  // Number series.
  const series = await api.view<{ doc_type: string; gstin_id: string | null }>('doc_series', `company_id=eq.${companyId}&fy_id=eq.${fy.id}&select=doc_type,gstin_id`)
  const wantSeries: { doc_type: string; gstin_id: string | null; prefix: string }[] = [
    { doc_type: 'sales_invoice', gstin_id: g.id, prefix: 'ESI' },
    { doc_type: 'credit_note', gstin_id: g.id, prefix: 'ECN' },
    { doc_type: 'receipt', gstin_id: null, prefix: 'ERC' },
  ]
  for (const s of wantSeries) {
    if (!series.some((x) => x.doc_type === s.doc_type && x.gstin_id === s.gstin_id)) {
      await api.rpc('upsert_doc_series', { p: { company_id: companyId, gstin_id: s.gstin_id, doc_type: s.doc_type, fy_id: fy.id, prefix: s.prefix, pad: 4, next_no: 1 } })
    }
  }

  // Account groups and ledgers.
  const groups = await api.view<Row & { name: string }>('account_groups', `company_id=eq.${companyId}&select=id,name`)
  async function group(name: string, nature: string, party: string | null): Promise<string> {
    const found = groups.find((x) => x.name === name)
    if (found) return found.id
    const res = await api.rpc<{ id: string }>('upsert_account_group', { p: { company_id: companyId, name, nature, is_party_group: party } })
    groups.push({ id: res.id, name })
    return res.id
  }
  const gDebtors = await group('E2E Test Debtors', 'asset', 'debtors')
  const gSales = await group('E2E Test Sales', 'income', null)
  const gDuties = await group('E2E Test Duties and Taxes', 'liability', null)
  const gCash = await group('E2E Test Cash and Bank', 'asset', null)
  const gExp = await group('E2E Test Indirect Expenses', 'expense', null)
  void gDebtors

  const accounts = await api.view<Row & { name: string }>('accounts', `company_id=eq.${companyId}&select=id,name`)
  async function account(name: string, groupId: string): Promise<string> {
    const found = accounts.find((x) => x.name === name)
    if (found) return found.id
    const res = await api.rpc<{ id: string }>('upsert_account', { p: { company_id: companyId, group_id: groupId, name } })
    accounts.push({ id: res.id, name })
    return res.id
  }
  const rules: [string, string][] = [
    ['sales.taxable', await account('E2E Test Sales Account', gSales)],
    ['sales.returns', await account('E2E Test Sales Returns', gSales)],
    ['gst.output_cgst', await account('E2E Test Output CGST', gDuties)],
    ['gst.output_sgst', await account('E2E Test Output SGST', gDuties)],
    ['gst.output_igst', await account('E2E Test Output IGST', gDuties)],
    ['round_off', await account('E2E Test Round Off', gExp)],
  ]
  const existingRules = await api.view<{ event: string }>('posting_rules', `company_id=eq.${companyId}&select=event`)
  for (const [event, accountId] of rules) {
    if (!existingRules.some((r) => r.event === event)) await api.rpc('set_posting_rule', { p_company_id: companyId, p_event: event, p_account_id: accountId, p_note: 'E2E test' })
  }

  // Cash and bank accounts.
  const money = await api.view<Row & { kind: string }>('money_accounts', `company_id=eq.${companyId}&select=id,kind`)
  if (!money.some((m) => m.kind === 'cash')) await api.rpc('add_money_account', { p: { company_id: companyId, group_id: gCash, name: 'E2E Test Cash', kind: 'cash' } })
  if (!money.some((m) => m.kind === 'bank')) await api.rpc('add_money_account', { p: { company_id: companyId, group_id: gCash, name: 'E2E Test Bank Account', kind: 'bank', bank_name: 'E2E Test Bank', account_last4: '0000' } })

  // HSN with an 18% rate (synthetic code) and two products with an MRP.
  const [hsn] = await api.view<{ code: string; current_rate: number | null }>('hsn_codes', `code=eq.${HSN}&select=code,current_rate`)
  if (!hsn) await api.rpc('upsert_hsn', { p: { code: HSN, description: 'E2E Test HSN 18%', kind: 'goods' } })
  if (!hsn || Number(hsn.current_rate) !== 18) {
    await api.rpc('add_hsn_rate', { p_hsn: HSN, p_rate: 18, p_cess: 0, p_tax_class: 'taxable', p_effective_from: hsn ? today : `${startYear}-04-01`, p_ca_confirmed: false, p_note: 'E2E test rate' })
  }
  const products: SalesSetup['products'] = []
  for (const [code, name] of [
    ['E2ESALEA', 'E2E Test Sales Product A'],
    ['E2ESALEB', 'E2E Test Sales Product B'],
  ] as const) {
    let [p] = await api.view<Row & { mrp: number | null; company_ids: string[] | null; status?: string }>('products', `code=eq.${code}&select=id,mrp,company_ids,status`)
    if (!p) {
      const res = await api.rpc<{ id: string }>('upsert_product', { p: { code, name, hsn_code: HSN, uom: 'NOS', kind: 'finished', status: 'active', company_ids: [companyId], force: true } })
      p = { id: res.id, mrp: null, company_ids: [companyId] }
    } else if (!(p.company_ids ?? []).includes(companyId)) {
      await api.rpc('upsert_product', { p: { id: p.id, company_ids: [...(p.company_ids ?? []), companyId] } })
    }
    // A test item set inactive elsewhere (e.g. a clean-up) is switched back on for this spec.
    if (p.status && p.status !== 'active') await api.rpc('upsert_product', { p: { id: p.id, status: 'active' } })
    if (p.mrp === null) await api.rpc('set_product_mrp', { p_product_id: p.id, p_mrp: 500, p_effective_from: `${startYear}-04-01` })
    products.push({ id: p.id, code, name })
  }

  // A new customer in Kerala with KYC verified by Admin.
  const name = `E2E Test Customer ${rand4()}${rand4()}`
  const gstin = syntheticGstin(randomPan(), '32')
  const party = await api.rpc<{ id: string }>('upsert_party', {
    p: { company_id: companyId, legal_name: name, is_customer: true, gstin, address: 'E2E Test Street', city: 'Thrissur', pincode: '680001', force: true },
  })
  await api.rpc('set_party_kyc', { p_party_id: party.id, p_status: 'verified', p_note: 'E2E test' })

  return { companyId, companyName: company.name, gstinId: g.id, gstin: g.gstin, products, customer: { id: party.id, name, gstin } }
}

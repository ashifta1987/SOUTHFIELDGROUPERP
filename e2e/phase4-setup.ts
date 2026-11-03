import type { Page } from '@playwright/test'
import { creds } from './helpers'
import { rand4, randomPan, syntheticGstin } from './phase2-parties-helpers'
import { restAsSignedInUser, type Rest } from './phase3-sales-setup'

/**
 * Phase 4 set-up (inventory and purchase) through the same RPCs the screens use, with the signed-in admin's own token.
 * A fresh synthetic company per run ("E2E Test Stock …", code E2EK####) so documents, stock and price history start
 * empty: Kerala GSTIN, open FY, a factory branch with a stores place and a quarantine place, a department, the books a
 * purchase bill needs (creditors group, purchase and input-GST ledgers, posting rules), an 18% HSN, two items (one that
 * needs an incoming test) and two Kerala suppliers (one with a consented WhatsApp number). Shared by the purchase and
 * inventory specs; every value is synthetic.
 */
export interface Item {
  id: string
  code: string
  name: string
}
export interface Supplier {
  id: string
  name: string
  gstin: string
}
export interface Phase4Setup {
  api: Rest
  companyId: string
  code: string
  shortName: string
  gstinId: string
  gstin: string
  fyId: string
  branchId: string
  stores: { id: string; name: string }
  quarantine: { id: string; name: string }
  department: string
  hsn: string
  items: { tested: Item; plain: Item }
  suppliers: { consented: Supplier; other: Supplier }
  accounts: Record<'purchase' | 'input_cgst' | 'input_sgst' | 'input_igst' | 'round_off', string>
}

export const E2E_HSN = '99990018'

export function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}
export function fyStartYear(): number {
  const [y, m] = todayIst().split('-').map(Number)
  return (m ?? 1) >= 4 ? (y ?? 2000) : (y ?? 2000) - 1
}
export function ddmmyyyy(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d}-${m}-${y}`
}

/** Make the fresh company with everything purchase and stock screens need. */
export async function createPhase4Company(page: Page): Promise<Phase4Setup> {
  const api = await restAsSignedInUser(page)
  const code = `E2EK${rand4()}`
  const tag = code.slice(4)
  const shortName = `E2E Stock ${tag}`
  const pan = randomPan()
  const company = await api.rpc<{ id: string }>('upsert_company', { p: { code, legal_name: `E2E Test Stock Company ${tag}`, short_name: shortName, pan, registered_address: 'E2E Test Address, Kerala' } })
  const companyId = company.id
  const gstin = syntheticGstin(pan, '32')
  const g = await api.rpc<{ id: string }>('upsert_gstin', { p: { company_id: companyId, gstin, legal_name: `E2E Test Stock Company ${tag}`, is_principal: true } })
  const fy = await api.rpc<{ id: string }>('open_financial_year', { p_company_id: companyId, p_start_year: fyStartYear() })

  const branch = await api.rpc<{ id: string }>('upsert_branch', { p: { company_id: companyId, gstin_id: g.id, code: `F${tag}`, name: `E2E Test Factory ${tag}`, kind: 'factory', address: 'E2E Test Road' } })
  const storesName = `E2E Test Stores ${tag}`
  const quarantineName = `E2E Test QC Hold ${tag}`
  const stores = await api.rpc<{ id: string }>('upsert_place', { p: { branch_id: branch.id, code: `S${tag}`, name: storesName, kind: 'stores' } })
  const quarantine = await api.rpc<{ id: string }>('upsert_place', { p: { branch_id: branch.id, code: `Q${tag}`, name: quarantineName, kind: 'quarantine' } })
  const department = `E2E Test Stores Dept ${tag}`
  await api.rpc('upsert_department', { p: { company_id: companyId, name: department } })

  // Books for a purchase bill.
  async function group(name: string, nature: string, party: string | null): Promise<string> {
    return (await api.rpc<{ id: string }>('upsert_account_group', { p: { company_id: companyId, name, nature, is_party_group: party } })).id
  }
  await group('E2E Test Creditors', 'liability', 'creditors')
  await group('E2E Test Debtors', 'asset', 'debtors')
  const gPurch = await group('E2E Test Purchase Accounts', 'expense', null)
  const gDuties = await group('E2E Test Duties and Taxes', 'liability', null)
  const gExp = await group('E2E Test Indirect Expenses', 'expense', null)
  async function account(name: string, groupId: string): Promise<string> {
    return (await api.rpc<{ id: string }>('upsert_account', { p: { company_id: companyId, group_id: groupId, name } })).id
  }
  const accounts = {
    purchase: await account('E2E Test Purchases', gPurch),
    input_cgst: await account('E2E Test Input CGST', gDuties),
    input_sgst: await account('E2E Test Input SGST', gDuties),
    input_igst: await account('E2E Test Input IGST', gDuties),
    round_off: await account('E2E Test Round Off', gExp),
  }
  for (const [event, id] of [
    ['purchase.taxable', accounts.purchase],
    ['gst.input_cgst', accounts.input_cgst],
    ['gst.input_sgst', accounts.input_sgst],
    ['gst.input_igst', accounts.input_igst],
    ['round_off', accounts.round_off],
  ] as const) {
    await api.rpc('set_posting_rule', { p_company_id: companyId, p_event: event, p_account_id: id, p_note: 'E2E test' })
  }

  // HSN with an 18% rate (synthetic code, shared with the Phase 3 specs).
  const [hsn] = await api.view<{ code: string; current_rate: number | null }>('hsn_codes', `code=eq.${E2E_HSN}&select=code,current_rate`)
  if (!hsn) await api.rpc('upsert_hsn', { p: { code: E2E_HSN, description: 'E2E Test HSN 18%', kind: 'goods' } })
  if (!hsn || Number(hsn.current_rate) !== 18) {
    await api.rpc('add_hsn_rate', { p_hsn: E2E_HSN, p_rate: 18, p_cess: 0, p_tax_class: 'taxable', p_effective_from: hsn ? todayIst() : `${fyStartYear()}-04-01`, p_ca_confirmed: false, p_note: 'E2E test rate' })
  }

  // Two items for this company only: one needs an incoming test (goes to QC hold on receipt).
  async function item(suffix: string, name: string, kind: string): Promise<Item> {
    const itemCode = `${code}${suffix}`
    const res = await api.rpc<{ id: string }>('upsert_product', { p: { code: itemCode, name, hsn_code: E2E_HSN, uom: 'KGS', kind, status: 'active', company_ids: [companyId], force: true } })
    return { id: res.id, code: itemCode, name }
  }
  const tested = await item('T', `E2E Test Resin ${tag}`, 'raw_material')
  const plain = await item('P', `E2E Test Spare ${tag}`, 'spares')
  await api.rpc('set_item_stock_settings', { p_product_id: tested.id, p: { needs_incoming_test: true } })

  // Two Kerala suppliers; only the first has a WhatsApp number with consent.
  async function supplier(label: string, whatsapp: string | null): Promise<Supplier> {
    const name = `E2E Test Supplier ${label} ${tag}${rand4()}`
    const sg = syntheticGstin(randomPan(), '32')
    const res = await api.rpc<{ id: string }>('upsert_party', {
      p: {
        company_id: companyId,
        legal_name: name,
        is_supplier: true,
        gstin: sg,
        state_code: '32',
        address: 'E2E Test Road',
        city: 'Thrissur',
        pincode: '680001',
        force: true,
        ...(whatsapp ? { whatsapp, whatsapp_consent: true, contact_name: 'E2E Test Contact' } : {}),
      },
    })
    return { id: res.id, name, gstin: sg }
  }
  const consented = await supplier('A', `+9199${rand4()}${rand4()}`)
  const other = await supplier('B', null)

  return {
    api,
    companyId,
    code,
    shortName,
    gstinId: g.id,
    gstin,
    fyId: fy.id,
    branchId: branch.id,
    stores: { id: stores.id, name: storesName },
    quarantine: { id: quarantine.id, name: quarantineName },
    department,
    hsn: E2E_HSN,
    items: { tested, plain },
    suppliers: { consented, other },
    accounts,
  }
}

/** Post a supplier bill straight through the RPCs (gives an item a last purchase rate). Returns the bill id. */
export async function postBill(s: Phase4Setup, o: { supplierId: string; productId: string; qty: string; rate: string; billNo: string }): Promise<string> {
  const d = await s.api.rpc<{ id: string }>('save_purchase_draft', {
    p: {
      company_id: s.companyId,
      gstin_id: s.gstinId,
      party_id: o.supplierId,
      supplier_bill_no: o.billNo,
      supplier_bill_date: todayIst(),
      bill_date: todayIst(),
      itc_eligible: true,
      reverse_charge: false,
      lines: [{ product_id: o.productId, hsn_code: s.hsn, qty: o.qty, rate: o.rate, discount: '0' }],
    },
  })
  await s.api.rpc('post_purchase_bill', { p_bill_id: d.id })
  return d.id
}

/** The synthetic staff user (the only account specs may give roles to). */
export async function staffUserId(api: Rest): Promise<string> {
  const users = await api.rpc<{ user_id: string; sign_in_email: string | null }[]>('list_users', {}, false)
  const u = users.find((x) => x.sign_in_email === creds.staff.email)
  if (!u) throw new Error('E2E staff user not found')
  return u.user_id
}

/** Give the staff user a role for this company only, ending within the hour; returns the assignment id to remove. */
export async function giveStaffRole(api: Rest, userId: string, role: string, companyId: string): Promise<string> {
  const res = await api.rpc<{ id: string }>('assign_role', { p_user_id: userId, p_role: role, p_company_id: companyId, p_valid_to: new Date(Date.now() + 60 * 60_000).toISOString(), p_reason: 'E2E test: second person for segregation of duties' })
  return res.id
}

export async function removeStaffRole(api: Rest, assignmentId: string): Promise<void> {
  await api.rpc('remove_role', { p_user_role_id: assignmentId, p_reason: 'E2E test finished' })
}

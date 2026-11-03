import { existsSync, readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { addCustomer, addItem, postOpening } from './phase5-setup'
import type { Rest } from './phase3-sales-setup'
import { createPhase4Company, fyStartYear, giveStaffRole, removeStaffRole, todayIst, type Item, type Phase4Setup } from './phase4-setup'

/**
 * Phase 6 field set-up (route sales, salesman app, logistics, driver app) through the same RPCs the screens use, with the
 * signed-in admin's own token, on a fresh synthetic company (Phase 4 company: Kerala GSTIN, open FY, factory branch with
 * stores and quarantine, books, 18% HSN). Adds what selling, collecting and dispatching need: invoice / receipt / contra
 * number series, sales and output-GST ledgers with their posting rules, a counter cash account, a "cash with salesmen"
 * account (field.cash_in_hand) and a bank account (field.collection_bank), a finished item with an MRP and opening stock,
 * a price list with that item, and a KYC-verified customer with a synthetic delivery pin. Every value is synthetic.
 */
export interface FieldSetup extends Phase4Setup {
  tag: string
  product: Item
  priceListId: string
  priceListName: string
  customer: { id: string; name: string }
  pin: { lat: number; lng: number }
  counterCashId: string
  counterCashName: string
}

/** A synthetic pin (somewhere in Kerala, not a real shop). */
const PIN = { lat: 10.52, lng: 76.21 }

export async function createFieldCompany(page: Page): Promise<FieldSetup> {
  const s = await createPhase4Company(page)
  const api = s.api
  const cid = s.companyId
  const tag = s.code.slice(4)

  for (const [doc_type, gstin_id, prefix] of [
    ['sales_invoice', s.gstinId, `F${tag}`],
    ['receipt', null, `R${tag}`],
    ['contra', null, `C${tag}`],
  ] as const) {
    await api.rpc('upsert_doc_series', { p: { company_id: cid, gstin_id, doc_type, fy_id: s.fyId, prefix, pad: 4, next_no: 1 } })
  }

  async function group(name: string, nature: string): Promise<string> {
    return (await api.rpc<{ id: string }>('upsert_account_group', { p: { company_id: cid, name, nature, is_party_group: null } })).id
  }
  async function account(name: string, groupId: string): Promise<string> {
    return (await api.rpc<{ id: string }>('upsert_account', { p: { company_id: cid, group_id: groupId, name } })).id
  }
  const gSales = await group('E2E Test Sales Accounts', 'income')
  const gOut = await group('E2E Test Output Taxes', 'liability')
  const gCash = await group('E2E Test Cash and Bank', 'asset')
  for (const [event, id] of [
    ['sales.taxable', await account('E2E Test Sales', gSales)],
    ['sales.returns', await account('E2E Test Sales Returns', gSales)],
    ['gst.output_cgst', await account('E2E Test Output CGST', gOut)],
    ['gst.output_sgst', await account('E2E Test Output SGST', gOut)],
    ['gst.output_igst', await account('E2E Test Output IGST', gOut)],
  ] as const) {
    await api.rpc('set_posting_rule', { p_company_id: cid, p_event: event, p_account_id: id, p_note: 'E2E test' })
  }
  const counterCashName = `E2E Test Counter Cash ${tag}`
  const counter = await api.rpc<{ id: string }>('add_money_account', { p: { company_id: cid, group_id: gCash, name: counterCashName, kind: 'cash' } })
  const withSalesmen = await api.rpc<{ id: string }>('add_money_account', { p: { company_id: cid, group_id: gCash, name: `E2E Test Cash with Salesmen ${tag}`, kind: 'cash' } })
  const bank = await api.rpc<{ id: string }>('add_money_account', { p: { company_id: cid, group_id: gCash, name: `E2E Test Collection Bank ${tag}`, kind: 'bank', bank_name: 'E2E Test Bank', account_last4: '0000' } })
  await api.rpc('set_posting_rule', { p_company_id: cid, p_event: 'field.cash_in_hand', p_account_id: withSalesmen.id, p_note: 'E2E test' })
  await api.rpc('set_posting_rule', { p_company_id: cid, p_event: 'field.collection_bank', p_account_id: bank.id, p_note: 'E2E test' })

  const product = await addItem(s, { suffix: 'F', name: `E2E Test Soap Bar ${tag}`, uom: 'NOS', kind: 'finished' })
  await api.rpc('set_product_mrp', { p_product_id: product.id, p_mrp: 500, p_effective_from: `${fyStartYear()}-04-01` })
  await postOpening(s, s.stores.id, [{ productId: product.id, qty: '100', unitCost: '50', lotNo: `E2E-LOT-F${tag}` }])

  const priceListName = `E2E Test Wholesale ${tag}`
  const pl = await api.rpc<{ id: string }>('upsert_price_list', { p: { company_id: cid, name: priceListName, kind: 'wholesale' } })
  await api.rpc('set_price', { p_price_list_id: pl.id, p_product_id: product.id, p_price: 100, p_min_qty: 0, p_effective_from: todayIst() })

  const customer = await addCustomer(s)
  await api.rpc('set_party_kyc', { p_party_id: customer.id, p_status: 'verified', p_note: 'E2E test' })
  await api.rpc('upsert_party_address', { p: { party_id: customer.id, kind: 'delivery', line1: 'E2E Test Shop Road', city: 'Thrissur', state_code: '32', pincode: '680001', lat: PIN.lat, lng: PIN.lng } })

  return { ...s, tag, product, priceListId: pl.id, priceListName, customer, pin: PIN, counterCashId: counter.id, counterCashName }
}

/** Metres north of a point as a latitude offset (1° of latitude ≈ 111 195 m). */
export function north(lat: number, metres: number): number {
  return Number((lat + metres / 111_195).toFixed(6))
}

/** Files in a private storage folder, listed as the user signed in on `page` (storage RLS decides). */
export async function storageList(page: Page, bucket: string, prefix: string): Promise<{ name: string }[]> {
  const env: Record<string, string> = {}
  for (const f of ['.env.local', '.env.test.local']) {
    if (!existsSync(f)) continue
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m && m[1]) env[m[1]] = (m[2] ?? '').trim()
    }
  }
  const token = await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('sb-') && x.endsWith('-auth-token'))
    const raw = k ? localStorage.getItem(k) : null
    return raw ? (JSON.parse(raw) as { access_token: string }).access_token : ''
  })
  const r = await fetch(`${env.VITE_SUPABASE_URL}/storage/v1/object/list/${bucket}`, {
    method: 'POST',
    headers: { apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix, limit: 100 }),
  })
  if (!r.ok) throw new Error(`storage list failed (${r.status}): ${await r.text()}`)
  return (await r.json()) as { name: string }[]
}

/**
 * A run that stopped half-way can leave the synthetic salesman on duty (a duty session and maybe an open visit or cash not
 * handed over) in an earlier E2E company, which blocks a new day. This closes such a day the sanctioned way: the staff user
 * gets the salesman role for that company for the hour, checks out, hands over the exact cash, Admin (cashier) confirms
 * on their own login, the staff user ends the day, and the role is removed. Best effort; synthetic data only.
 */
export async function endStaleFieldDay(admin: Rest, staff: Rest, staffId: string): Promise<void> {
  const since = new Date(Date.now() - 36 * 3600_000).toISOString()
  const points = await admin.view<{ company_id: string }>('gps_points', `user_id=eq.${staffId}&at=gte.${since}&select=company_id`)
  const visits = await admin.view<{ id: string; company_id: string }>('visits', `salesman_user_id=eq.${staffId}&check_out_at=is.null&select=id,company_id`)
  const companies = [...new Set([...points.map((p) => p.company_id), ...visits.map((v) => v.company_id)])]
  for (const cid of companies) {
    let roleId = ''
    try {
      roleId = await giveStaffRole(admin, staffId, 'salesman', cid)
      for (const v of visits.filter((x) => x.company_id === cid)) {
        await staff.rpc('check_out_visit', { p_visit_id: v.id, p: { outcome: 'follow_up' } }).catch(() => undefined)
      }
      const open = await admin.view<{ amount: number }>('field_collections', `company_id=eq.${cid}&salesman_user_id=eq.${staffId}&mode=eq.cash&handover_id=is.null&select=amount`)
      const cash = open.reduce((n, r) => n + Number(r.amount), 0)
      if (cash > 0) {
        const h = await staff.rpc<{ id: string }>('cash_handover', { p: { company_id: cid, denominations: { '1': cash }, cheques: 0 } })
        const [acc] = await admin.view<{ id: string }>('money_accounts', `company_id=eq.${cid}&kind=eq.cash&select=id`)
        await admin.rpc('confirm_cash_handover', { p_handover_id: h.id, p: { denominations: { '1': cash }, to_account_id: acc?.id } }).catch(() => undefined)
      }
      await staff.rpc('end_salesman_day', { p: { company_id: cid, unsynced: 0, van_counts: [] } }).catch(() => undefined)
    } catch {
      /* best effort */
    } finally {
      if (roleId) await removeStaffRole(admin, roleId).catch(() => undefined)
    }
  }
}

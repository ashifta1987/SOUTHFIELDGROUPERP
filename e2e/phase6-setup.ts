import type { Page } from '@playwright/test'
import { rand4, randomPan, syntheticGstin } from './phase2-parties-helpers'
import { addItem, createPhase5Company, givePeople, postOpening, todayIst, type Phase5Setup } from './phase5-setup'
import type { Item } from './phase4-setup'

/**
 * Phase 6 set-up (delivery and sales), reusable by the sales-desk spec and the logistics / field-sales spec. Builds on the
 * Phase 5 company (fresh synthetic company, Kerala GSTIN, open FY, factory branch with stores / quarantine / line / FG hold,
 * purchase books, 18% HSN) and adds the sales books (debtors are already there; sales, sales without GST, returns, output
 * GST, cash and bank accounts and their posting rules), number series for invoices, credit notes and receipts, a finished
 * item with an MRP and a released lot in stores, a shop branch with its own stock place, and synthetic customers:
 * a KYC-verified Kerala trade customer, a walk-in customer, an overseas buyer and a marketplace account.
 * Every value is synthetic (E2E…); roles given by specs are time-limited and removed in `finally` (givePeople).
 */
export interface Party {
  id: string
  name: string
}
export interface Phase6Setup extends Phase5Setup {
  product: Item
  lotNo: string
  shopBranch: { id: string; name: string }
  shopPlace: { id: string; name: string }
  customers: { trade: Party; walkIn: Party; overseas: Party; marketplace: Party }
  money: { cash: string; bank: string }
}

export { givePeople, todayIst }

/** A customer for this company (synthetic), KYC verified by Admin unless told otherwise. */
export async function addPartyCustomer(
  s: Phase5Setup,
  o: { label: string; type: string; gstin?: boolean; overseas?: boolean; verify?: boolean },
): Promise<Party> {
  const name = `E2E Test ${o.label} ${s.tag}${rand4()}`
  const res = await s.api.rpc<{ id: string }>('upsert_party', {
    p: {
      company_id: s.companyId,
      legal_name: name,
      is_customer: true,
      customer_type: o.type,
      ...(o.overseas ? { gst_status: 'overseas', address: 'E2E Test Street, Overseas', city: 'E2E Test City' } : { address: 'E2E Test Road', city: 'Thrissur', pincode: '680001', state_code: '32' }),
      ...(o.gstin ? { gstin: syntheticGstin(randomPan(), '32') } : {}),
      force: true,
    },
  })
  if (o.verify !== false) await s.api.rpc('set_party_kyc', { p_party_id: res.id, p_status: 'verified', p_note: 'E2E test' })
  return { id: res.id, name }
}

/** Fresh company with everything the sales desk needs. */
export async function createPhase6Company(page: Page): Promise<Phase6Setup> {
  const s = await createPhase5Company(page)
  const api = s.api
  const cid = s.companyId
  const tag = s.tag

  // Number series (sales invoice and credit note per GSTIN; receipt for the company).
  for (const x of [
    { doc_type: 'sales_invoice', gstin_id: s.gstinId, prefix: 'ESI' },
    { doc_type: 'credit_note', gstin_id: s.gstinId, prefix: 'ECN' },
    { doc_type: 'receipt', gstin_id: null, prefix: 'ERC' },
  ]) {
    await api.rpc('upsert_doc_series', { p: { company_id: cid, gstin_id: x.gstin_id, doc_type: x.doc_type, fy_id: s.fyId, prefix: x.prefix, pad: 4, next_no: 1 } })
  }

  // Sales books.
  async function group(name: string, nature: string): Promise<string> {
    return (await api.rpc<{ id: string }>('upsert_account_group', { p: { company_id: cid, name, nature, is_party_group: null } })).id
  }
  const gSales = await group('E2E Test Sales Income', 'income')
  const gOut = await group('E2E Test Output Taxes', 'liability')
  const gMoney = await group('E2E Test Cash and Bank', 'asset')
  async function account(name: string, groupId: string): Promise<string> {
    return (await api.rpc<{ id: string }>('upsert_account', { p: { company_id: cid, group_id: groupId, name } })).id
  }
  for (const [event, name, g] of [
    ['sales.taxable', 'E2E Test Sales', gSales],
    ['sales.without_gst', 'E2E Test Sales Zero Rated', gSales],
    ['sales.returns', 'E2E Test Sales Returns', gSales],
    ['gst.output_cgst', 'E2E Test Output CGST', gOut],
    ['gst.output_sgst', 'E2E Test Output SGST', gOut],
    ['gst.output_igst', 'E2E Test Output IGST', gOut],
  ] as const) {
    await api.rpc('set_posting_rule', { p_company_id: cid, p_event: event, p_account_id: await account(name, g), p_note: 'E2E test' })
  }
  const cash = await api.rpc<{ id: string }>('add_money_account', { p: { company_id: cid, group_id: gMoney, name: `E2E Test Shop Cash ${tag}`, kind: 'cash' } })
  const bank = await api.rpc<{ id: string }>('add_money_account', { p: { company_id: cid, group_id: gMoney, name: `E2E Test Bank ${tag}`, kind: 'bank', bank_name: 'E2E Test Bank', account_last4: '0000' } })

  // A finished item with an MRP and a released lot in stores.
  const product = await addItem(s, { suffix: 'FG', name: `E2E Test Bath Bar ${tag}`, uom: 'NOS', kind: 'finished' })
  await api.rpc('set_product_mrp', { p_product_id: product.id, p_mrp: 500, p_effective_from: `${todayIst().slice(0, 4)}-01-01` })
  const lotNo = `E2E-LOT-S${tag}`
  await postOpening(s, s.stores.id, [{ productId: product.id, qty: '200', unitCost: '100', lotNo }])

  // A shop branch on the same GSTIN with its own stock (a separate lot so the complaint lot stays in stores).
  const shopName = `E2E Test Shop ${tag}`
  const shopBranch = await api.rpc<{ id: string }>('upsert_branch', { p: { company_id: cid, gstin_id: s.gstinId, code: `H${tag}`, name: shopName, kind: 'shop', address: 'E2E Test Shop Road' } })
  const shopPlaceName = `E2E Test Shop Shelf ${tag}`
  const shopPlace = await api.rpc<{ id: string }>('upsert_place', { p: { branch_id: shopBranch.id, code: `SH${tag}`, name: shopPlaceName, kind: 'stores' } })
  await postOpening(s, shopPlace.id, [{ productId: product.id, qty: '50', unitCost: '100', lotNo: `E2E-LOT-H${tag}` }])

  const trade = await addPartyCustomer(s, { label: 'Trade Customer', type: 'retail_shop', gstin: true })
  const walkIn = await addPartyCustomer(s, { label: 'Walk-in', type: 'retail_shop' })
  const overseas = await addPartyCustomer(s, { label: 'Overseas Buyer', type: 'export_buyer', overseas: true })
  const marketplace = await addPartyCustomer(s, { label: 'Marketplace', type: 'online_marketplace', gstin: true })

  return {
    ...s,
    product,
    lotNo,
    shopBranch: { id: shopBranch.id, name: shopName },
    shopPlace: { id: shopPlace.id, name: shopPlaceName },
    customers: { trade, walkIn, overseas, marketplace },
    money: { cash: cash.id, bank: bank.id },
  }
}

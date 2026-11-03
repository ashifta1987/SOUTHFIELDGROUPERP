import type { Page } from '@playwright/test'
import { creds } from './helpers'
import { rand4, randomPan, syntheticGstin } from './phase2-parties-helpers'
import type { Rest } from './phase3-sales-setup'
import { createPhase4Company, giveStaffRole, removeStaffRole, todayIst, type Item, type Phase4Setup } from './phase4-setup'

/**
 * Phase 5 set-up (production), shared by the Biochem and Plastics specs. Builds on the Phase 4 company (fresh synthetic
 * company, Kerala GSTIN, open FY, factory branch with stores and quarantine, books, 18% HSN) and adds a production line
 * place (wip), a finished-goods hold place (fg_hold), helpers to make items, post opening stock (released lots), find
 * the three synthetic logins and give them roles for this company for one hour. Every value is synthetic (E2E…).
 */
export interface Phase5Setup extends Phase4Setup {
  line: { id: string; name: string }
  fgHold: { id: string; name: string }
  tag: string
}

export { todayIst }

/** Fresh company for production specs. */
export async function createPhase5Company(page: Page): Promise<Phase5Setup> {
  const s = await createPhase4Company(page)
  const tag = s.code.slice(4)
  const lineName = `E2E Test Line ${tag}`
  const fgName = `E2E Test FG Hold ${tag}`
  const line = await s.api.rpc<{ id: string }>('upsert_place', { p: { branch_id: s.branchId, code: `L${tag}`, name: lineName, kind: 'wip' } })
  const fg = await s.api.rpc<{ id: string }>('upsert_place', { p: { branch_id: s.branchId, code: `G${tag}`, name: fgName, kind: 'fg_hold' } })
  return { ...s, tag, line: { id: line.id, name: lineName }, fgHold: { id: fg.id, name: fgName } }
}

/** An item for this company only (synthetic code `<company code><suffix>`). */
export async function addItem(s: Phase4Setup, o: { suffix: string; name: string; uom: string; kind: string; netQty?: number; netQtyUom?: string; hsn?: string }): Promise<Item> {
  const code = `${s.code}${o.suffix}`
  const res = await s.api.rpc<{ id: string }>('upsert_product', {
    p: { code, name: o.name, hsn_code: o.hsn ?? s.hsn, uom: o.uom, kind: o.kind, status: 'active', company_ids: [s.companyId], force: true, ...(o.netQty ? { net_qty: o.netQty, net_qty_uom: o.netQtyUom ?? 'GMS' } : {}) },
  })
  return { id: res.id, code, name: o.name }
}

/** Opening stock (released) at a place; a lot number makes a released lot. */
export async function postOpening(s: Phase4Setup, placeId: string, lines: { productId: string; qty: string; unitCost: string; lotNo?: string }[]): Promise<void> {
  await s.api.rpc('post_opening_stock', {
    p: { company_id: s.companyId, place_id: placeId, date: todayIst(), lines: lines.map((l) => ({ product_id: l.productId, qty: l.qty, unit_cost: l.unitCost, lot_no: l.lotNo ?? null })) },
  })
}

/** A Kerala customer (synthetic GSTIN) for sales-document checks. */
export async function addCustomer(s: Phase4Setup): Promise<{ id: string; name: string }> {
  const name = `E2E Test Customer ${s.code.slice(4)}${rand4()}`
  const res = await s.api.rpc<{ id: string }>('upsert_party', {
    p: { company_id: s.companyId, legal_name: name, is_customer: true, customer_type: 'wholesale', gstin: syntheticGstin(randomPan(), '32'), state_code: '32', address: 'E2E Test Road', city: 'Thrissur', pincode: '680001', force: true },
  })
  return { id: res.id, name }
}

/** User id of a synthetic login. */
export async function userIdByEmail(api: Rest, email: string): Promise<string> {
  const users = await api.rpc<{ user_id: string; sign_in_email: string | null }[]>('list_users', {}, false)
  const u = users.find((x) => x.sign_in_email === email)
  if (!u) throw new Error(`E2E user ${email} not found`)
  return u.user_id
}

/** Give the staff and third logins roles for this company for one hour; returns a cleanup function. */
export async function givePeople(s: Phase4Setup, roles: { staff?: string[]; third?: string[] }): Promise<{ staffId: string; thirdId: string; adminId: string; cleanup: () => Promise<void> }> {
  const adminId = await userIdByEmail(s.api, creds.admin.email)
  const staffId = await userIdByEmail(s.api, creds.staff.email)
  const thirdId = creds.third.email ? await userIdByEmail(s.api, creds.third.email) : ''
  const ids: string[] = []
  for (const r of roles.staff ?? []) ids.push(await giveStaffRole(s.api, staffId, r, s.companyId))
  for (const r of roles.third ?? []) if (thirdId) ids.push(await giveStaffRole(s.api, thirdId, r, s.companyId))
  return {
    adminId,
    staffId,
    thirdId,
    cleanup: async () => {
      for (const id of ids) await removeStaffRole(s.api, id).catch(() => undefined)
    },
  }
}

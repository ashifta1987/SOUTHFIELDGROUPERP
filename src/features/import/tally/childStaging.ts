import type { StageRow } from './parseTallyXml'

/** Header fields of a voucher that travel with its child lists (filled on the voucher only where still empty). */
export const HEADER_KEYS = [
  'narration', 'reference', 'reference_date', 'effective_date', 'persisted_view', 'is_invoice', 'is_post_dated', 'place_of_supply',
  'party_gstin', 'buyer_name', 'voucher_key', 'irn', 'ack_no', 'ack_date', 'eway_bill_no', 'row_hash',
] as const

/** A row without its child lists: this is what api.import_stage_rows receives (the child lists go to api.import_stage_voucher_children). */
export function stripChildren(row: StageRow): StageRow {
  const out = { ...row }
  delete out.children
  return out
}

export interface ChildPayload {
  guid: string
  alter_id: number | null
  header: Record<string, unknown>
  [list: string]: unknown
}

/** The api.import_stage_voucher_children element of a voucher row, or null when it has no GUID or no child at all. */
export function toChildPayload(row: StageRow): ChildPayload | null {
  const c = row.children
  if (row.object_type !== 'voucher' || !c || !row.guid) return null
  if (c.lines.length + c.inventory.length + c.batches.length + c.bills.length + c.costcentres.length + c.banks.length === 0) return null
  const header = Object.fromEntries(HEADER_KEYS.filter((k) => row.payload[k] !== undefined && row.payload[k] !== null).map((k) => [k, row.payload[k]]))
  return { guid: row.guid, alter_id: row.alter_id, header, ...c }
}

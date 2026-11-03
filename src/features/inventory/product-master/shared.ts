import type { RpcError } from '@/data/rpc'

/** Product and group kinds (master.products.kind / master.product_groups.kind check constraints). */
export const KINDS = ['finished', 'perfumery', 'raw_material', 'packaging', 'component', 'consumable', 'spares', 'other'] as const
export const STATUSES = ['to_review', 'active', 'inactive'] as const
export const TAX_CLASSES = ['taxable', 'exempt', 'nil_rated', 'non_gst', 'zero_rated'] as const

export interface DuplicateCandidate {
  id: string
  code: string
  name: string
}

/**
 * api.upsert_product refuses a similar name with rule `masters.possible_duplicate` and puts the candidates
 * (JSON array) in the message after "possible_duplicate: ". Returns them, or null for any other error.
 */
export function duplicateCandidates(err: RpcError | null | undefined): DuplicateCandidate[] | null {
  if (!err || err.rule !== 'masters.possible_duplicate') return null
  const at = err.message.indexOf('[')
  if (at < 0) return []
  try {
    const parsed: unknown = JSON.parse(err.message.slice(at))
    return Array.isArray(parsed) ? (parsed as DuplicateCandidate[]) : []
  } catch {
    return []
  }
}

/** A GST rate as stored (numeric percent) for display, e.g. 18 → "18%", 2.5 → "2.5%". Null → "—". */
export function rateText(rate: number | string | null | undefined): string {
  if (rate === null || rate === undefined || rate === '') return '—'
  return `${Number(rate)}%`
}

/** Text from a product's label jsonb. */
export function labelText(label: unknown, key: string): string {
  if (label && typeof label === 'object' && !Array.isArray(label)) {
    const v = (label as Record<string, unknown>)[key]
    return typeof v === 'string' ? v : ''
  }
  return ''
}

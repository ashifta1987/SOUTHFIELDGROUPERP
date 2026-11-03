import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import type { RpcError } from '@/data/rpc'
import { PurchaseErrorBox } from '@/features/purchase/common/purchase'
import { formatIndian } from '@/shared/format'
import { api } from '@/shared/supabase'
import { Chip, ErrorRef } from '@/ui'

/**
 * Shared helpers for the Phase 4 inventory screens (raw material, component stock, stock movements, scrap and regrind,
 * warehouse, stock transfers). Display only: every stock movement, balance, reservation, test result and transfer state
 * is decided by the database (api.issue_stock … api.close_transfer); the browser formats what it is given.
 */

/** Rule codes these screens explain themselves (nested under inventoryCommon.rules in i18n). */
const OWN_PREFIXES = ['stock.', 'count.', 'qc.', 'scrap.', 'transfer.', 'sod.', 'doc.', 'rights.reason_required']

/** Refusal box: our own sentence for stock rule codes (the server's detail follows), else the purchase/shared box. */
export function InventoryErrorBox({ error }: { error: RpcError | null | undefined }) {
  const { t } = useTranslation()
  if (!error) return null
  if (error.rule && OWN_PREFIXES.some((p) => error.rule?.startsWith(p))) {
    const key = `inventoryCommon.rules.${error.rule}`
    const msg = t(key)
    if (msg !== key) {
      const detail = serverSentence(error.message)
      return <ErrorRef message={detail && detail.toLowerCase() !== msg.toLowerCase() ? `${msg} ${t('inventoryCommon.serverSays', { detail })}` : msg} next={t('errors.nextStep')} refId={error.ref} />
    }
  }
  return <PurchaseErrorBox error={error} />
}

/** The human sentence of a Postgres error (drops a leading "code: " prefix). */
function serverSentence(message: string): string {
  const m = message.trim()
  const i = m.indexOf(': ')
  return i > 0 && /^[a-z_.]+$/.test(m.slice(0, i)) ? m.slice(i + 2) : m
}

/** A quantity from Postgres numeric(18,3), Indian grouping, trailing zeros after the point dropped. */
export function qtyText(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  const s = formatIndian(value, 3)
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

export function Qty({ value, uom, signed }: { value: string | number | null | undefined; uom?: string | null; signed?: boolean }) {
  const n = Number(value)
  const neg = Number.isFinite(n) && n < 0
  const text = qtyText(value)
  const shown = signed && Number.isFinite(n) && n > 0 ? `+${text}` : neg ? `−${text.replace(/^-/, '')}` : text
  return (
    <span className="sf-amount" data-negative={neg ? 'true' : undefined}>
      {shown}
      {uom && text !== '—' ? ` ${uom}` : ''}
    </span>
  )
}

type Tone = 'neutral' | 'teal' | 'info' | 'signal' | 'success' | 'danger' | 'transit' | 'navy' | 'outline'
const TONES: Record<string, Tone> = {
  available: 'success',
  quarantine: 'signal',
  hold: 'signal',
  in_transit: 'transit',
  rejected: 'danger',
  requested: 'info',
  approved: 'teal',
  reserved: 'teal',
  picked: 'teal',
  handed_over: 'transit',
  received: 'signal',
  reconciled: 'success',
  closed: 'neutral',
  cancelled: 'neutral',
  counting: 'info',
  submitted: 'signal',
  posted: 'success',
  pass: 'success',
  fail: 'danger',
}

/** Status word for a stock bucket, lot, transfer, count or test result (never colour alone). */
export function StockStatus({ status }: { status: string | null | undefined }) {
  const { t } = useTranslation()
  if (!status) return <span className="k">—</span>
  const key = `inventoryCommon.status.${status}`
  const label = t(key)
  return <Chip tone={TONES[status] ?? 'neutral'}>{label === key ? status : label}</Chip>
}

/** Movement type in words. */
export function useMoveLabel() {
  const { t } = useTranslation()
  return (m: string) => {
    const key = `inventoryCommon.move.${m}`
    const v = t(key)
    return v === key ? m : v
  }
}

/** What the signed-in user may do on the inventory screens (the server checks again on every call). */
export function useInventoryRights() {
  const can = useCan()
  const { profile } = useAuth()
  const readOnly = profile?.view === 'all-readonly'
  return {
    readOnly,
    view: can('inventory.view'),
    create: !readOnly && can('inventory.create'),
    edit: !readOnly && can('inventory.edit'),
    approve: !readOnly && can('inventory.approve'),
    admin: !readOnly && can('settings.manage'),
    products: !readOnly && can('products.manage'),
    qcTest: !readOnly && can('qc.test'),
    qcRelease: !readOnly && can('qc.release'),
    costs: can('cost.view'),
    transferView: can('transfer.view') || can('inventory.view'),
    transferCreate: !readOnly && can('transfer.create'),
    transferApprove: !readOnly && can('transfer.approve'),
    transferPick: !readOnly && can('transfer.pick'),
    transferCarry: !readOnly && can('transfer.carry'),
    transferReceive: !readOnly && can('transfer.receive'),
    transferClose: !readOnly && can('transfer.close'),
    transferWriteOff: !readOnly && can('transfer.write_off'),
  }
}

export type Place = ViewRow<'places'>

/**
 * True while a transfer is in transit and the viewer is on the receiving side (not the picker or carrier, no approve
 * right): the counts are blind, so dispatched and in-transit quantities are not shown (api.transfer_items hides them
 * the same way).
 */
export function useBlindTransfer() {
  const can = useCan()
  const { session } = useAuth()
  const me = session?.user.id
  return (tr: { status: string; picked_by: string | null; carried_by: string | null }) => tr.status === 'in_transit' && !can('transfer.approve') && me !== tr.picked_by && me !== tr.carried_by
}

/** Active stock places of a company (stores, quarantine, shop …). */
export function useStockPlaces(companyId: string | undefined) {
  const q = useApiView('places', { eq: { company_id: companyId }, order: 'name', enabled: Boolean(companyId) })
  return { ...q, list: rowsOf(q).filter((p) => p.status === 'active') }
}

export function placeLabel(p: Pick<Place, 'name' | 'branch_name'>): string {
  return p.branch_name ? `${p.name} · ${p.branch_name}` : p.name
}

/** Stock items of a company: products used by this company (group-wide products included). */
export function useStockItems(companyId: string | undefined) {
  const q = useApiView('products', { order: 'name', limit: 3000, enabled: Boolean(companyId) })
  const list = rowsOf(q).filter((p) => p.status === 'active' && (!p.company_ids || p.company_ids.length === 0 || (companyId ? p.company_ids.includes(companyId) : false)))
  return { ...q, list }
}

const QTY_RE = /^\d+(\.\d{1,3})?$/
/** Typed quantity → clean decimal string (up to 3 places), or null. `allowZero` for counts. */
export function cleanQty(input: string, allowZero = false): string | null {
  const s = input.replace(/[,\s]/g, '')
  if (!QTY_RE.test(s)) return null
  if (!allowZero && Number(s) <= 0) return null
  return s
}

const COST_RE = /^\d+(\.\d{1,4})?$/
export function cleanCost(input: string): string | null {
  const s = input.replace(/[,\s₹]/g, '')
  return COST_RE.test(s) ? s : null
}

/** Ledger rows of a company with optional filters, read from api.stock_movements (newest first). */
export function useStockMovements(companyId: string | undefined, f: { product?: string; place?: string; type?: string; from?: string; to?: string; limit?: number }) {
  return useQuery({
    queryKey: ['api', 'stock_movements', 'filtered', companyId ?? '', JSON.stringify(f)],
    enabled: Boolean(companyId),
    staleTime: 10_000,
    queryFn: async () => {
      let q = api().from('stock_movements').select('*').eq('company_id', companyId ?? '')
      if (f.product) q = q.eq('product_id', f.product)
      if (f.place) q = q.eq('place_id', f.place)
      if (f.type) q = q.eq('move_type', f.type)
      if (f.from) q = q.gte('move_date', f.from)
      if (f.to) q = q.lte('move_date', f.to)
      const { data, error } = await q.order('id', { ascending: false }).limit(f.limit ?? 300)
      if (error) throw new Error(error.message)
      return (data ?? []) as ViewRow<'stock_movements'>[]
    },
  })
}

/** Query keys to refresh after any stock change. */
export const STOCK_REFRESH: string[][] = [
  ['api', 'stock_on_hand'],
  ['api', 'stock_summary'],
  ['api', 'item_stock'],
  ['api', 'raw_material_stock'],
  ['api', 'component_stock'],
  ['api', 'scrap_stock'],
  ['api', 'stock_movements'],
  ['api', 'stock_issues'],
  ['api', 'lots'],
  ['api', 'lab_tests'],
  ['api', 'warehouse_tasks'],
  ['api', 'stock_counts'],
  ['api', 'stock_count_lines'],
  ['api', 'transfers'],
  ['api', 'transfer_lines'],
  ['api', 'transfer_items'],
  ['api', 'transfer_events'],
  ['api', 'regrind_entries'],
  ['api', 'scrap_sales'],
  ['api', 'reorder_levels'],
  ['api', 'negative_stock_allowances'],
  ['api', 'buying_logistics_home'],
]

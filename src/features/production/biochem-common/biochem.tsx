import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { callApi, type RpcError } from '@/data/rpc'
import { useQuery } from '@tanstack/react-query'
import { InventoryErrorBox } from '@/features/inventory/common/inventory'
import { Amount, Chip, ErrorRef } from '@/ui'

/**
 * Shared helpers for the Phase 5 Biochem production screens (manufacturing, production entry, flow, labs, work
 * assignment, packs, machines, costing, factory manager phone home, lab panel). Display only: every state change,
 * quantity, cost, licence check, QC limit and segregation-of-duties rule is decided by the database (api.plan_batch …
 * api.close_batch); the browser shows what it is given and explains refusals.
 */

export type Batch = ViewRow<'batches'>
export type FormulaVersion = ViewRow<'formula_versions'>

/** Rule-code prefixes these screens explain themselves (biochemCommon.rules.*), with the server's detail. */
const OWN_PREFIXES = ['licence.', 'prod.', 'formula.', 'batch.', 'weighing.', 'asset.', 'pack.', 'rnd.', 'work.', 'cost.', 'sod.', 'qc.', 'stock.', 'doc.', 'rights.reason_required', 'date.', 'period.', 'org.', 'numbering.']

/** The human sentence of a Postgres error (drops a leading "code: " prefix). */
export function serverSentence(message: string): string {
  const m = message.trim()
  const i = m.indexOf(': ')
  return i > 0 && /^[a-z_.]+$/.test(m.slice(0, i)) ? m.slice(i + 2) : m
}

/**
 * Refusal box for production RPCs: our own sentence for the rule plus what the server said (it names the item, batch or
 * licence). A missing or expired licence links to Admin → Licences. Unknown rules fall back to the inventory box.
 */
export function ProductionErrorBox({ error }: { error: RpcError | null | undefined }) {
  const { t } = useTranslation()
  if (!error) return null
  const rule = error.rule ?? ''
  if (rule && OWN_PREFIXES.some((p) => rule.startsWith(p))) {
    const key = `biochemCommon.rules.${rule}`
    const own = t(key)
    const detail = serverSentence(error.message)
    const msg = own !== key ? (detail && detail.toLowerCase() !== own.toLowerCase() ? `${own} ${t('biochemCommon.serverSays', { detail })}` : own) : detail
    const licence = rule === 'licence.missing' || rule === 'licence.expired'
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-rule={rule}>
        <ErrorRef message={msg} next={t('errors.nextStep')} refId={error.ref} />
        {licence ? (
          <Link to="/admin/licences-and-documents" className="sf-btn" data-variant="link">
            {t('biochemCommon.openLicences')}
          </Link>
        ) : null}
      </div>
    )
  }
  return <InventoryErrorBox error={error} />
}

/** Rights of the signed-in person for production (the server checks them again on every call). */
export function useProductionRights() {
  const can = useCan()
  const { profile, session } = useAuth()
  const readOnly = profile?.view === 'all-readonly'
  return {
    me: session?.user.id ?? null,
    readOnly,
    view: can('production.view') || can('qc.test') || can('qc.release') || can('lab.rnd'),
    create: !readOnly && can('production.create'),
    edit: !readOnly && can('production.edit'),
    approve: !readOnly && can('production.approve'),
    qcTest: !readOnly && can('qc.test'),
    qcRelease: !readOnly && can('qc.release'),
    rnd: !readOnly && can('lab.rnd'),
    assetsView: can('assets.view') || can('production.view'),
    assetsManage: !readOnly && can('assets.manage'),
    admin: !readOnly && can('settings.manage'),
    costs: can('cost.view'),
    users: can('users.view'),
  }
}

type Tone = 'neutral' | 'teal' | 'info' | 'signal' | 'success' | 'danger' | 'transit' | 'navy' | 'outline'
const TONES: Record<string, Tone> = {
  planned: 'info',
  reserved: 'teal',
  weighed: 'teal',
  in_process: 'transit',
  sample_sent: 'signal',
  bulk_passed: 'success',
  bulk_failed: 'danger',
  packing: 'transit',
  packed_hold: 'signal',
  released: 'success',
  rejected: 'danger',
  closed: 'neutral',
  cancelled: 'neutral',
  draft: 'info',
  submitted: 'signal',
  approved: 'success',
  superseded: 'neutral',
  withdrawn: 'neutral',
  pending: 'signal',
  tested: 'success',
  retained: 'info',
  disposed: 'neutral',
  pass: 'success',
  fail: 'danger',
  hold: 'signal',
  watch: 'signal',
  adjusted: 'teal',
  active: 'success',
  inactive: 'neutral',
  repair: 'signal',
  out_of_service: 'danger',
  suspended: 'signal',
  verified: 'success',
  balanced: 'success',
  mismatch: 'danger',
  running: 'transit',
  stability: 'signal',
  passed: 'success',
  failed: 'danger',
  dropped: 'neutral',
  available: 'success',
  quarantine: 'signal',
}

/** Status word for a batch, formula version, sample, result, asset or licence (never colour alone). */
export function ProdStatus({ status }: { status: string | null | undefined }) {
  const { t } = useTranslation()
  if (!status) return <span className="k">—</span>
  return <Chip tone={TONES[status] ?? 'neutral'}>{t(`biochemCommon.status.${status}`, { defaultValue: status.replace(/_/g, ' ') })}</Chip>
}

/** The batch states in order (from api.batch_states; labels from i18n). */
export const BATCH_FLOW = ['planned', 'reserved', 'weighed', 'in_process', 'sample_sent', 'bulk_passed', 'packing', 'packed_hold', 'released', 'closed'] as const

/** A row of state chips with the current one marked (aria-current="step"). */
export function BatchStepper({ status }: { status: string }) {
  const { t } = useTranslation()
  const idx = BATCH_FLOW.indexOf(status as (typeof BATCH_FLOW)[number])
  const offPath = idx < 0
  return (
    <ol aria-label={t('biochemCommon.states')} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {BATCH_FLOW.map((s, i) => {
        const current = s === status
        const done = !offPath && i < idx
        return (
          <li
            key={s}
            aria-current={current ? 'step' : undefined}
            className="sf-chip"
            data-tone={current ? 'teal' : done ? 'success' : 'outline'}
            style={{ padding: '4px 10px', fontWeight: current ? 700 : 500 }}
          >
            <span className="mono" style={{ marginRight: 4 }}>
              {i + 1}
            </span>
            {t(`biochemCommon.status.${s}`)}
          </li>
        )
      })}
      {offPath ? (
        <li aria-current="step" className="sf-chip" data-tone={TONES[status] ?? 'neutral'} style={{ padding: '4px 10px', fontWeight: 700 }}>
          {t(`biochemCommon.status.${status}`, { defaultValue: status })}
        </li>
      ) : null}
    </ol>
  )
}

/** Hidden cost: shown as words, never as zero. */
export function CostCell({ value, digits = 2 }: { value: number | string | null | undefined; digits?: number }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  if (!rights.costs) return <span className="k">{t('biochemCommon.costHidden')}</span>
  if (value === null || value === undefined) return <span className="k">—</span>
  return <Amount value={value} rupee digits={digits} />
}

/** A short line for a successful step (role=status so screen readers hear it). */
export function Done({ children }: { children: ReactNode }) {
  if (!children) return null
  return (
    <div role="status" className="sf-alert" data-tone="success" style={{ margin: 0 }}>
      {children}
    </div>
  )
}

/** A read that failed (network or server): say so, never show an empty list as if nothing existed. */
export function ViewError({ error }: { error: unknown }) {
  const { t } = useTranslation()
  if (!error) return null
  return (
    <div role="alert" className="sf-alert" data-tone="danger" style={{ margin: 0 }}>
      {t('errors.loadFailed')} {t('errors.tryAgain')}
    </div>
  )
}

/** Query keys to refresh after any production change. */
export const PROD_REFRESH: string[][] = [
  ['api', 'batches'],
  ['api', 'batch_events'],
  ['api', 'batch_weighings'],
  ['api', 'batch_packaging'],
  ['api', 'material_consumption'],
  ['api', 'batch_costs'],
  ['api', 'lab_samples'],
  ['api', 'lab_tests'],
  ['api', 'my_lab_work'],
  ['api', 'formula_versions'],
  ['api', 'formula_lines'],
  ['api', 'process_families'],
  ['api', 'licences'],
  ['api', 'shift_assignments'],
  ['api', 'factory_workload'],
  ['api', 'rnd_trials'],
  ['api', 'stability_checks'],
  ['api', 'assets'],
  ['api', 'asset_events'],
  ['api', 'calibrations'],
  ['api', 'asset_documents'],
  ['api', 'packs'],
  ['api', 'pack_items'],
  ['api', 'pack_assemblies'],
  ['api', 'cost_rates'],
  ['api', 'lots'],
  ['api', 'stock_on_hand'],
  ['api', 'item_stock'],
  ['api', 'stock_movements'],
]

/** Products of a company (group-wide products included), active only. */
export function useCompanyProducts(companyId: string | undefined) {
  const q = useApiView('products', { order: 'name', limit: 3000, enabled: Boolean(companyId) })
  const list = rowsOf(q).filter((p) => p.status === 'active' && (!p.company_ids || p.company_ids.length === 0 || (companyId ? p.company_ids.includes(companyId) : false)))
  return { ...q, list }
}

export interface UserOption {
  id: string
  name: string
}

/**
 * People who can be given work: from api.list_users when the viewer may see users (Admin), else the people already on
 * this company's duty board (the server checks every assignment again: work.not_staff).
 */
export function usePeople(companyId: string | undefined) {
  const rights = useProductionRights()
  const users = useQuery({
    queryKey: ['api', 'list_users', 'people'],
    enabled: rights.users,
    staleTime: 60_000,
    retry: false,
    queryFn: () => callApi<{ user_id: string; display_name: string | null; status: string; roles: { company_id: string | null }[] | null }[]>('list_users', {}, { idempotent: false }),
  })
  const board = useApiView('factory_workload', { eq: { company_id: companyId }, limit: 500, enabled: Boolean(companyId) && !rights.users })
  let list: UserOption[]
  if (rights.users) {
    list = (users.data ?? [])
      .filter((u) => u.status !== 'disabled' && (u.roles ?? []).some((r) => r.company_id === null || r.company_id === companyId))
      .map((u) => ({ id: u.user_id, name: u.display_name ?? '—' }))
  } else {
    const seen = new Map<string, string>()
    for (const r of rowsOf(board)) seen.set(r.user_id, r.user_name ?? '—')
    list = [...seen.entries()].map(([id, name]) => ({ id, name }))
  }
  return { list, isLoading: users.isLoading || board.isLoading }
}

/** Places of a company that are in use. */
export function useCompanyPlaces(companyId: string | undefined) {
  const q = useApiView('places', { eq: { company_id: companyId }, order: 'name', enabled: Boolean(companyId) })
  return { ...q, list: rowsOf(q).filter((p) => p.status === 'active') }
}

const QTY_RE = /^\d+(\.\d{1,3})?$/
/** Typed quantity → clean decimal string (up to 3 places), or null. */
export function cleanNum(input: string, allowZero = false): string | null {
  const s = input.replace(/[,\s₹]/g, '')
  if (!QTY_RE.test(s)) return null
  if (!allowZero && Number(s) <= 0) return null
  return s
}

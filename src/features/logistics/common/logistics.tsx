import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiRpc, useApiView } from '@/data/queries'
import type { RpcError } from '@/data/rpc'
import { RuleErrorBox } from '@/features/sales/invoice/RuleErrorBox'
import { supabase } from '@/shared/supabase'
import { Chip, ErrorRef } from '@/ui'

/**
 * Shared helpers for the Phase 6 logistics desk (Dispatch board, Trips, Vehicles and drivers, Vehicle file). Display
 * only: invoices, e-way bill checks, credit, stock leaving at trip start, proof of delivery and every refusal are decided
 * by the database (api.create_dispatch … api.close_trip, api.upsert_vehicle …).
 */
export function useLogisticsRights() {
  const can = useCan()
  const { profile } = useAuth()
  const readOnly = profile?.view === 'all-readonly'
  const w = (r: string) => !readOnly && can(r)
  return {
    readOnly,
    view: can('logistics.view') || can('logistics.create') || can('logistics.edit'),
    create: w('logistics.create'),
    edit: w('logistics.edit'),
    invoice: w('sales_invoices.create'),
    admin: profile?.view === 'all' && !readOnly,
  }
}

export const LOGI_REFRESH: string[][] = [
  ['api', 'dispatches'],
  ['api', 'dispatch_lines'],
  ['api', 'trips'],
  ['api', 'trip_stops'],
  ['api', 'pods'],
  ['api', 'sales_orders'],
  ['api', 'sales_order_lines'],
  ['api', 'vehicles'],
  ['api', 'vehicle_documents'],
  ['api', 'vehicle_events'],
  ['api', 'stock_on_hand'],
  ['api', 'sales_documents'],
]

export interface Person {
  user_id: string
  display_name: string
  role_keys: string[] | null
}
/** People with a current role in the company (no personal data), for driver pickers. */
export function useCompanyPeople(companyId: string | undefined) {
  const q = useApiRpc<Person[]>('company_people', { p_company_id: companyId }, Boolean(companyId))
  return q.data?.status === 'ready' ? (q.data.data ?? []) : []
}

export function usePlaces(companyId: string | undefined) {
  const q = useApiView('places', { eq: { company_id: companyId }, order: 'name', enabled: Boolean(companyId) })
  return rowsOf(q).filter((p) => p.status === 'active')
}

const OWN = ['dispatch.', 'trip.', 'pod.', 'vehicle.', 'order.not_confirmed', 'order.missing', 'stock.', 'credit.over_limit', 'rights.reason_required', 'sod.own_request', 'visit.', 'field.', 'party.not_linked', 'price_list.']

function serverSentence(message: string): string {
  const m = message.trim()
  const i = m.indexOf(': ')
  return i > 0 && /^[a-z_.]+$/.test(m.slice(0, i)) ? m.slice(i + 2) : m
}

/** Refusal box for the logistics desk: our sentence for the rule + what the server said; others fall back to the invoice box. */
export function LogisticsErrorBox({ error }: { error: RpcError | null | undefined }) {
  const { t } = useTranslation()
  if (!error) return null
  const rule = error.rule ?? ''
  if (rule && OWN.some((p) => rule.startsWith(p))) {
    const key = `logisticsCommon.rules.${rule}`
    const own = t(key)
    if (own !== key) {
      const detail = serverSentence(error.message)
      const msg = detail && detail.toLowerCase() !== own.toLowerCase() ? `${own} (${detail})` : own
      return (
        <div data-rule={rule}>
          <ErrorRef message={msg} next={t('errors.nextStep')} refId={error.ref} />
        </div>
      )
    }
  }
  return (
    <div data-rule={rule || undefined}>
      <RuleErrorBox error={error} />
    </div>
  )
}

/** Dispatch and trip states as a word + icon chip. */
export function DispatchStatus({ status }: { status: string }) {
  const { t } = useTranslation()
  const tone = status === 'delivered' ? 'success' : status === 'part_delivered' ? 'signal' : status === 'dispatched' || status === 'started' ? 'transit' : status === 'failed' || status === 'cancelled' ? 'danger' : status === 'closed' ? 'success' : 'info'
  const icon = status === 'delivered' || status === 'closed' ? 'check' : status === 'dispatched' || status === 'started' ? 'truck' : status === 'failed' || status === 'cancelled' ? 'cross' : 'clock'
  return (
    <Chip tone={tone} icon={icon}>
      {t(`logisticsCommon.status.${status}`, { defaultValue: status })}
    </Chip>
  )
}

/** A readiness check chip: done (tick), pending (clock) or not needed (dash). */
export function Check({ state, label }: { state: 'done' | 'pending' | 'na'; label: string }) {
  const { t } = useTranslation()
  return (
    <span className="sf-chip" data-tone={state === 'done' ? 'success' : state === 'pending' ? 'signal' : 'neutral'} title={t(`logisticsCommon.check.${state}`)}>
      <span aria-hidden="true">{state === 'done' ? '✓' : state === 'pending' ? '◷' : '–'}</span> {label}
      <span className="sr-only"> · {t(`logisticsCommon.check.${state}`)}</span>
    </span>
  )
}

/** A short-lived link to a private proof-of-delivery file (RLS checks logistics/sales view). */
export async function podUrl(path: string): Promise<string | null> {
  const { data } = await supabase.storage.from('pod').createSignedUrl(path, 300)
  return data?.signedUrl ?? null
}

/** "YYYY-MM-DDTHH:mm" in IST for datetime-local inputs → ISO with +05:30. */
export function istLocalToIso(v: string): string | null {
  if (!v) return null
  return `${v}:00+05:30`
}

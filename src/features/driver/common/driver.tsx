import type { ReactNode } from 'react'
import { NavLink, useOutletContext } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiRpc, useApiView } from '@/data/queries'
import type { RpcError } from '@/data/rpc'
import { RuleErrorBox } from '@/features/sales/invoice/RuleErrorBox'
import { ErrorRef, Icon, useOnline } from '@/ui'
import type { PhoneOutletContext } from '@/ui/shell/StaffShell'

/**
 * Driver app shared pieces: the driver's own current trip (api.my_trip; customer numbers masked), the phone frame with
 * a real h1, and refusals explained (trip.*, pod.*, dispatch.*, stock.*). The trip, stock movement, proof and GPS rules
 * are all decided by the database.
 */
export interface MyTripStop {
  stop_id: string
  seq: number
  status: 'pending' | 'arrived' | 'delivered' | 'part_delivered' | 'failed'
  dispatch_id: string
  dispatch_no: string | null
  customer: string
  scheduled_at: string | null
  address: string | null
  contact_masked: string | null
  lines: { dispatch_line_id: string; product: string; qty: number | string; uom: string | null }[] | null
}
export interface MyTrip {
  trip_id?: string
  doc_no?: string
  status?: 'planned' | 'started'
  trip_date?: string
  vehicle?: string | null
  stops?: MyTripStop[]
}

export function useMyTrip() {
  return useApiRpc<MyTrip>('my_trip', {})
}

/** The trip row (company id for the private `pod` folder, driver name), from api.trips (RLS: the driver's own trips). */
export function useTripRow(tripId: string | undefined) {
  const q = useApiView('trips', { eq: { id: tripId }, limit: 1, enabled: Boolean(tripId) })
  return rowsOf(q)[0]
}

export const DRIVER_REFRESH: string[][] = [['api', 'my_trip'], ['api', 'trips'], ['api', 'trip_stops'], ['api', 'dispatches'], ['api', 'pods']]

export function useDriverRights() {
  const can = useCan()
  const { profile } = useAuth()
  const readOnly = profile?.view === 'all-readonly'
  return { drive: !readOnly && (can('trip.drive') || can('logistics.edit')), readOnly }
}

const OWN = ['trip.', 'pod.', 'dispatch.', 'stock.', 'credit.over_limit', 'vehicle.', 'rights.reason_required', 'gps.']

function serverSentence(message: string): string {
  const m = message.trim()
  const i = m.indexOf(': ')
  return i > 0 && /^[a-z_.]+$/.test(m.slice(0, i)) ? m.slice(i + 2) : m
}

export function DriverErrorBox({ error }: { error: RpcError | null | undefined }) {
  const { t } = useTranslation()
  if (!error) return null
  const rule = error.rule ?? ''
  if (rule && OWN.some((p) => rule.startsWith(p))) {
    const key = `driverCommon.rules.${rule}`
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

/** Dark phone header (trip number, vehicle), online pill, Help, and the bottom tabs. */
export function DriverFrame({ title, sub, back, children }: { title: ReactNode; sub?: ReactNode; back?: string; children: ReactNode }) {
  const { t } = useTranslation()
  const ctx = useOutletContext<PhoneOutletContext | undefined>()
  const online = useOnline()
  return (
    <>
      <header className="sf-phone-head" style={{ background: 'var(--sf-navy)' }}>
        {back ? (
          <NavLink to={back} className="sf-phone-head__btn" aria-label={t('driverCommon.back')}>
            <Icon name="chevronRight" size={24} style={{ transform: 'rotate(180deg)' }} />
          </NavLink>
        ) : null}
        <div className="sf-phone-head__text">
          <h1 className="sf-phone-head__name mono" style={{ margin: 0 }}>
            {title}
          </h1>
          {sub ? <span className="sf-phone-head__sub">{sub}</span> : null}
        </div>
        <span className="sf-pill" data-tone={online ? 'success' : 'signal'}>
          {online ? t('driverCommon.online') : t('driverCommon.offline')}
        </span>
        {ctx?.openHelp ? (
          <button type="button" className="sf-phone-head__btn" aria-label={t('help.open')} onClick={ctx.openHelp}>
            <Icon name="help" size={24} />
          </button>
        ) : null}
      </header>
      {!online ? (
        <div className="sf-alert" data-tone="signal" role="status" style={{ margin: 0, borderRadius: 0 }}>
          <Icon name="wifiOff" size={16} />
          <span>{t('driverCommon.noNetwork')}</span>
        </div>
      ) : null}
      <main className="sf-phone-body">{children}</main>
      <nav className="sf-bottomnav" aria-label={t('driverCommon.tabs')} style={{ ['--cols' as string]: 2 }}>
        <NavLink to="/driver/trip">
          <Icon name="truck" size={22} />
          {t('driverCommon.tab.trip')}
        </NavLink>
        <NavLink to="/driver/pod">
          <Icon name="clipboard" size={22} />
          {t('driverCommon.tab.pod')}
        </NavLink>
      </nav>
    </>
  )
}

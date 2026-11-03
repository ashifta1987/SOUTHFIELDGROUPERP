import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, useOutletContext } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiRpc, useApiView } from '@/data/queries'
import { callApi, RpcError } from '@/data/rpc'
import { RuleErrorBox } from '@/features/sales/invoice/RuleErrorBox'
import { supabase } from '@/shared/supabase'
import { ErrorRef, Icon, Skeleton, useOnline } from '@/ui'
import type { PhoneOutletContext } from '@/ui/shell/StaffShell'

/**
 * Shared pieces of the salesman portal (§15A, phone). Everything is decided by the database (api.start_duty …
 * api.end_salesman_day): geofence, cash limits, prices, credit, the GST-only scope. The phone only shows what comes back,
 * keeps writes it could not send in a local queue with their own client_request_id (so a retry never doubles anything),
 * and reads the location only while the salesman is on duty after accepting the notice (DPDP).
 */

/* ─────────── Company ─────────── */
const COMPANY_KEY = 'sf.field.company'

/** The company the salesman works for today (remembered on this phone; RLS decides the list). */
export function useFieldCompany() {
  const companies = useApiView('companies', { order: 'code' })
  const list = rowsOf(companies).filter((c) => c.status === 'active')
  const [wanted, setWanted] = useState<string | null>(() => (typeof localStorage === 'undefined' ? null : localStorage.getItem(COMPANY_KEY)))
  const current = list.find((c) => c.id === wanted) ?? list[0]
  function choose(id: string) {
    localStorage.setItem(COMPANY_KEY, id)
    setWanted(id)
  }
  return { list, company: current, companyId: current?.id, choose, isLoading: companies.isLoading }
}

/* ─────────── Today in IST ─────────── */
export function todayIstIso(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

/* ─────────── Server reads ─────────── */
export interface MyDay {
  date: string
  on_duty: boolean
  visits_planned: number
  visits_done: number
  orders_total: number | string
  collections_total: number | string
  cash_with_me: number | string
  cheques_with_me: number
}
export function useMyDay(companyId: string | undefined) {
  return useApiRpc<MyDay | null>('my_day', { p_company_id: companyId, p_date: todayIstIso() }, Boolean(companyId))
}

export interface RouteRow {
  beat_id: string
  beat: string
  seq: number
  party_id: string
  name: string
  pin: { lat: number; lng: number } | null
  overdue_gst: number | string
  open_query: boolean
  credit_hold: boolean
  kyc_missing: boolean
  visited: boolean
  last_visit: string | null
  last_order: string | null
}
export function useMyRoute(companyId: string | undefined) {
  return useApiRpc<RouteRow[]>('my_route_today', { p_company_id: companyId, p_date: todayIstIso() }, Boolean(companyId))
}

export interface MyCustomer {
  party_id: string
  name: string
  trade_name: string | null
  gstin: string | null
  kyc_status: string
  credit_status: string | null
  tier: string | null
  overdue_gst: number | string
  open_queries: number
  last_visit: string | null
  last_order: string | null
  pin: { lat: number; lng: number } | null
  phone_masked: string | null
}
export function useMyCustomers(companyId: string | undefined) {
  return useApiRpc<MyCustomer[]>('my_customers', { p_company_id: companyId }, Boolean(companyId))
}

/** The salesman's open visit (one at a time), from api.visits (RLS: own rows). */
export function useOpenVisit(companyId: string | undefined) {
  const { session } = useAuth()
  const me = session?.user.id
  const q = useApiView('visits', { eq: { salesman_user_id: me, company_id: companyId }, order: 'check_in_at', ascending: false, limit: 30, enabled: Boolean(me && companyId) })
  const open = rowsOf(q).find((v) => !v.check_out_at)
  return { open, visits: rowsOf(q), query: q }
}

/** Query keys refreshed after any field change. */
export const FIELD_REFRESH: string[][] = [
  ['api', 'my_day'],
  ['api', 'my_route_today'],
  ['api', 'my_customers'],
  ['api', 'visits'],
  ['api', 'salesman_customer_account'],
  ['api', 'queries'],
  ['api', 'promises_to_pay'],
  ['api', 'field_collections'],
  ['api', 'cash_handovers'],
  ['api', 'day_closes'],
  ['api', 'sales_orders'],
  ['api', 'check_credit_exposure'],
]

export function useFieldRefresh() {
  const qc = useQueryClient()
  return useCallback(async () => {
    await Promise.all(FIELD_REFRESH.map((key) => qc.invalidateQueries({ queryKey: key })))
  }, [qc])
}

/* ─────────── Offline queue (idempotent retries) ─────────── */
const QUEUE_KEY = 'sf.field.queue'
const FAILED_KEY = 'sf.field.queueFailed'
const QUEUE_EVENT = 'sf-field-queue'

export interface QueuedWrite {
  id: string
  fn: string
  args: Record<string, unknown>
  label: string
  at: string
}
export interface FailedWrite extends QueuedWrite {
  rule: string | null
  message: string
}

function readList<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T[]) : []
  } catch {
    return []
  }
}
function writeList<T>(key: string, list: T[]) {
  localStorage.setItem(key, JSON.stringify(list))
  window.dispatchEvent(new Event(QUEUE_EVENT))
}

function isNetworkError(e: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true
  if (e instanceof RpcError) return !e.rule && !e.code && /fetch|network|load failed/i.test(e.message)
  return e instanceof TypeError
}

export type WriteOutcome<T> = { queued: false; result: T } | { queued: true; id: string }

/**
 * Send a changing RPC with its own client_request_id. Offline (or the network drops) → kept on the phone and sent again
 * later with the same id, so the server applies it once. A refusal with a rule is thrown as an RpcError for the screen.
 */
export async function sendOrQueue<T>(fn: string, args: Record<string, unknown>, label: string): Promise<WriteOutcome<T>> {
  const id = crypto.randomUUID()
  const item: QueuedWrite = { id, fn, args, label, at: new Date().toISOString() }
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    writeList(QUEUE_KEY, [...readList<QueuedWrite>(QUEUE_KEY), item])
    return { queued: true, id }
  }
  try {
    const result = await callApi<T>(fn, { p_client_request_id: id, ...args }, { idempotent: false })
    return { queued: false, result }
  } catch (e) {
    if (isNetworkError(e)) {
      writeList(QUEUE_KEY, [...readList<QueuedWrite>(QUEUE_KEY), item])
      return { queued: true, id }
    }
    throw e
  }
}

let flushing = false
/** Send everything waiting on the phone (oldest first). Refusals move to the failed list for the salesman to see. */
export async function flushQueue(): Promise<number> {
  if (flushing || (typeof navigator !== 'undefined' && !navigator.onLine)) return 0
  flushing = true
  let sent = 0
  try {
    for (const item of readList<QueuedWrite>(QUEUE_KEY)) {
      try {
        await callApi(item.fn, { p_client_request_id: item.id, ...item.args }, { idempotent: false })
        sent++
        writeList(QUEUE_KEY, readList<QueuedWrite>(QUEUE_KEY).filter((x) => x.id !== item.id))
      } catch (e) {
        if (isNetworkError(e)) break
        const err = e instanceof RpcError ? e : null
        writeList(QUEUE_KEY, readList<QueuedWrite>(QUEUE_KEY).filter((x) => x.id !== item.id))
        writeList(FAILED_KEY, [...readList<FailedWrite>(FAILED_KEY), { ...item, rule: err?.rule ?? null, message: err?.message ?? String(e) }])
      }
    }
  } finally {
    flushing = false
  }
  return sent
}

/** The queue as React state, flushed when the phone is back online and every half minute. */
export function useFieldQueue() {
  const online = useOnline()
  const refresh = useFieldRefresh()
  const [pending, setPending] = useState<QueuedWrite[]>(() => readList(QUEUE_KEY))
  const [failed, setFailed] = useState<FailedWrite[]>(() => readList(FAILED_KEY))
  useEffect(() => {
    const sync = () => {
      setPending(readList(QUEUE_KEY))
      setFailed(readList(FAILED_KEY))
    }
    window.addEventListener(QUEUE_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(QUEUE_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  useEffect(() => {
    if (!online) return
    let alive = true
    const run = async () => {
      if (readList(QUEUE_KEY).length === 0) return
      const n = await flushQueue()
      if (alive && n > 0) await refresh()
    }
    void run()
    const t = window.setInterval(() => void run(), 30_000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [online, refresh])
  function dismissFailed(id: string) {
    writeList(FAILED_KEY, readList<FailedWrite>(FAILED_KEY).filter((x) => x.id !== id))
  }
  return { pending, failed, count: pending.length, dismissFailed }
}

/* ─────────── Location (only on duty, after the notice) ─────────── */
export interface Position {
  lat: number
  lng: number
  accuracy: number | null
  at: string
}

/** One reading of the phone's location; null when refused or unavailable. Call only while on duty. */
export function readPosition(timeoutMs = 10_000): Promise<Position | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null)
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: Number(p.coords.latitude.toFixed(6)), lng: Number(p.coords.longitude.toFixed(6)), accuracy: p.coords.accuracy ?? null, at: new Date().toISOString() }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    )
  })
}

/**
 * Location pings while on duty only (the server refuses points off duty or outside the duty window). Points are batched
 * and sent with api.record_locations every few minutes; nothing is read when `onDuty` is false.
 */
export function useDutyTracker(onDuty: boolean, everyMs = 300_000) {
  const buffer = useRef<Position[]>([])
  useEffect(() => {
    if (!onDuty || typeof navigator === 'undefined' || !navigator.geolocation) return
    const watch = navigator.geolocation.watchPosition(
      (p) => {
        buffer.current.push({ lat: Number(p.coords.latitude.toFixed(6)), lng: Number(p.coords.longitude.toFixed(6)), accuracy: p.coords.accuracy ?? null, at: new Date().toISOString() })
        if (buffer.current.length > 50) buffer.current = buffer.current.slice(-50)
      },
      () => undefined,
      { enableHighAccuracy: false, maximumAge: 60_000 },
    )
    const send = () => {
      const points = buffer.current.splice(0)
      if (points.length === 0) return
      void sendOrQueue('record_locations', { p_points: points.map((x) => ({ lat: x.lat, lng: x.lng, at: x.at, accuracy_m: x.accuracy === null ? null : Math.round(x.accuracy) })) }, 'location').catch(() => undefined)
    }
    const t = window.setInterval(send, everyMs)
    return () => {
      navigator.geolocation.clearWatch(watch)
      window.clearInterval(t)
      buffer.current = []
    }
  }, [onDuty, everyMs])
}

/* ─────────── Storage (private `field` bucket, company folder first) ─────────── */
export async function uploadFieldPhoto(companyId: string, folder: string, file: File): Promise<string> {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
  const path = `${companyId}/${folder}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from('field').upload(path, file, { upsert: false, contentType: file.type || 'image/jpeg' })
  if (error) throw error
  return path
}

/* ─────────── Refusals ─────────── */
const OWN = ['gps.', 'duty.', 'visit.', 'field.', 'cash.', 'order.', 'money.', 'promise.', 'statement.', 'credit.', 'price.', 'party.not_linked', 'query.', 'sod.own_request', 'rights.missing', 'posting.', 'period.']

function serverSentence(message: string): string {
  const m = message.trim()
  const i = m.indexOf(': ')
  return i > 0 && /^[a-z_.]+$/.test(m.slice(0, i)) ? m.slice(i + 2) : m
}

/** The salesman's refusal box: our sentence for the rule + what the server said (e.g. the distance from the pin). */
export function FieldErrorBox({ error }: { error: RpcError | null | undefined }) {
  const { t } = useTranslation()
  if (!error) return null
  const rule = error.rule ?? ''
  if (rule && OWN.some((p) => rule.startsWith(p))) {
    const key = `fieldCommon.rules.${rule}`
    const own = t(key)
    if (own !== key) {
      const detail = serverSentence(error.message)
      const msg = detail && detail.toLowerCase() !== own.toLowerCase() ? `${own} ${t('fieldCommon.serverSays', { detail })}` : own
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

/* ─────────── Phone frame ─────────── */
export function useFieldRights() {
  const can = useCan()
  const { profile } = useAuth()
  const readOnly = profile?.view === 'all-readonly'
  return { sell: !readOnly && can('field.sell'), readOnly }
}

/**
 * The salesman portal frame: navy header with a real h1, on-duty pill, offline badge with the number of writes waiting
 * on the phone, Help, and the bottom tabs (Today, Customers, Queries, My day).
 */
export function FieldFrame({ title, sub, back, onDuty, children }: { title: ReactNode; sub?: ReactNode; back?: string; onDuty?: boolean; children: ReactNode }) {
  const { t } = useTranslation()
  const ctx = useOutletContext<PhoneOutletContext | undefined>()
  const online = useOnline()
  const queue = useFieldQueue()
  useDutyTracker(Boolean(onDuty))
  return (
    <>
      <header className="sf-phone-head">
        {back ? (
          <Link to={back} className="sf-phone-head__btn" aria-label={t('fieldCommon.back')}>
            <Icon name="chevronRight" size={24} style={{ transform: 'rotate(180deg)' }} />
          </Link>
        ) : null}
        <div className="sf-phone-head__text">
          <h1 className="sf-phone-head__name" style={{ margin: 0 }}>
            {title}
          </h1>
          {sub ? <span className="sf-phone-head__sub">{sub}</span> : null}
        </div>
        {onDuty !== undefined ? (
          <span className="sf-pill" data-tone={onDuty ? 'success' : 'signal'}>
            {onDuty ? t('fieldCommon.onDuty') : t('fieldCommon.offDuty')}
          </span>
        ) : null}
        {ctx?.openHelp ? (
          <button type="button" className="sf-phone-head__btn" aria-label={t('help.open')} onClick={ctx.openHelp}>
            <Icon name="help" size={24} />
          </button>
        ) : null}
      </header>
      {!online || queue.count > 0 ? (
        <div className="sf-alert" data-tone="signal" role="status" style={{ margin: 0, borderRadius: 0 }} data-testid="field-offline">
          <Icon name="wifiOff" size={16} />
          <span>{!online ? t('fieldCommon.offline', { count: queue.count }) : t('fieldCommon.waiting', { count: queue.count })}</span>
        </div>
      ) : null}
      <main className="sf-phone-body">
        {queue.failed.map((f) => (
          <div key={f.id} className="sf-alert" data-tone="danger" role="alert" style={{ margin: 0, flexDirection: 'column', alignItems: 'flex-start' }}>
            <span>{t('fieldCommon.failedWrite', { label: t(`fieldCommon.writes.${f.label}`, { defaultValue: f.label }), message: serverSentence(f.message) })}</span>
            <button type="button" className="sf-btn" data-size="sm" onClick={() => queue.dismissFailed(f.id)}>
              {t('fieldCommon.dismiss')}
            </button>
          </div>
        ))}
        {children}
      </main>
      <nav className="sf-bottomnav" aria-label={t('fieldCommon.tabs')} style={{ ['--cols' as string]: 4 }}>
        <NavLink to="/field/today">
          <Icon name="home" size={22} />
          {t('fieldCommon.tab.today')}
        </NavLink>
        <NavLink to="/field/customers">
          <Icon name="user" size={22} />
          {t('fieldCommon.tab.customers')}
        </NavLink>
        <NavLink to="/field/queries">
          <Icon name="clipboard" size={22} />
          {t('fieldCommon.tab.queries')}
        </NavLink>
        <NavLink to="/field/my-day">
          <Icon name="calendar" size={22} />
          {t('fieldCommon.tab.myDay')}
        </NavLink>
      </nav>
    </>
  )
}

/** Shared "no right" / "no company" / loading states for the salesman screens. */
export function FieldGate({ children, loading, companyId, sell }: { children: ReactNode; loading: boolean; companyId: string | undefined; sell: boolean }) {
  const { t } = useTranslation()
  if (loading) return <Skeleton height={160} />
  if (!companyId)
    return (
      <div className="sf-phone-note" role="status">
        {t('fieldCommon.noCompany')}
      </div>
    )
  if (!sell)
    return (
      <div className="sf-phone-note" role="status">
        <strong>{t('fieldCommon.noRightTitle')}</strong>
        <br />
        {t('fieldCommon.noRight')}
      </div>
    )
  return <>{children}</>
}

/** A label/value line inside a phone card (mono value on the right). */
export function Line({ label, value, testId }: { label: ReactNode; value: ReactNode; testId?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--sf-line)' }}>
      <span>{label}</span>
      <span className="mono" data-testid={testId} style={{ textAlign: 'right' }}>
        {value}
      </span>
    </div>
  )
}

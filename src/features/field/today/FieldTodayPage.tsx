import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthProvider'
import type { RpcError } from '@/data/rpc'
import { formatDate, formatLongDate, formatTime } from '@/shared/format'
import { Amount, Button, Checkbox, SelectField, Skeleton } from '@/ui'
import { CheckInPanel, CheckInResultNote, type CheckInResult } from '../common/CheckInPanel'
import { FieldErrorBox, FieldFrame, FieldGate, Line, readPosition, sendOrQueue, useFieldCompany, useFieldRefresh, useFieldRights, useMyDay, useMyRoute, useOpenVisit } from '../common/field'

/**
 * Salesman app home (`SalesmanApp`, /field/today): start the day after reading the location notice (DPDP: location only
 * on duty, kept 90 days), today's route in visit order with flags, the next shop with Check in (geofence decided by the
 * server), the open visit, quick actions and the day's numbers from api.my_day.
 */
export function FieldTodayPage() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const rights = useFieldRights()
  const { list, companyId, company, choose, isLoading } = useFieldCompany()
  const day = useMyDay(companyId)
  const route = useMyRoute(companyId)
  const { open } = useOpenVisit(companyId)
  const myDay = day.data?.status === 'ready' ? day.data.data : null
  const onDuty = Boolean(myDay?.on_duty)
  const stops = route.data?.status === 'ready' ? (route.data.data ?? []) : []
  const next = stops.find((s) => !s.visited)
  const nextIndex = next ? stops.indexOf(next) + 1 : 0
  const [checkin, setCheckin] = useState<CheckInResult | null>(null)

  return (
    <FieldFrame title={profile?.displayName ?? t('fieldToday.title')} sub={`${company?.short_name ?? company?.name ?? ''} · ${formatLongDate(new Date())}`} onDuty={myDay ? onDuty : undefined}>
      <FieldGate loading={isLoading || day.isLoading} companyId={companyId} sell={rights.sell}>
        {list.length > 1 ? <SelectField label={t('common.company')} value={companyId} onChange={(e) => choose(e.target.value)} options={list.map((c) => ({ value: c.id, label: c.short_name || c.name }))} /> : null}
        {companyId && !onDuty ? <StartDay companyId={companyId} /> : null}
        <CheckInResultNote result={checkin} />
        {companyId && onDuty && open ? (
          <section className="sf-phone-card" aria-labelledby="open-visit">
            <h2 id="open-visit">{t('fieldToday.atShop')}</h2>
            <strong style={{ fontSize: 20 }}>{open.party_name}</strong>
            <span className="k">
              {t('fieldToday.since', { time: formatTime(open.check_in_at) })}
              {open.approval === 'pending' ? ` · ${t('fieldToday.waitingOk')}` : ''}
            </span>
            <Link className="sf-btn" data-variant="primary" data-size="touch" to={`/field/customers/${open.party_id}?tab=visit`}>
              {t('fieldToday.openVisit')}
            </Link>
          </section>
        ) : null}
        {companyId && onDuty && !open && next ? (
          <section className="sf-phone-card" aria-labelledby="next-shop">
            <h2 id="next-shop" className="k" style={{ textTransform: 'uppercase', letterSpacing: '.04em' }}>
              {t('fieldToday.nextShop', { i: nextIndex, n: stops.length })}
            </h2>
            <Link to={`/field/customers/${next.party_id}`} style={{ fontSize: 22, fontWeight: 700, color: 'var(--sf-text)' }}>
              {next.name}
            </Link>
            <span className="k">
              {next.beat}
              {next.last_order ? ` · ${t('fieldToday.lastOrder', { date: formatDate(next.last_order) })}` : ''}
            </span>
            <Flags row={next} />
            <CheckInPanel companyId={companyId} partyId={next.party_id} beatId={next.beat_id} planned onResult={setCheckin} />
            <span className="k">{t('fieldToday.fenceNote')}</span>
          </section>
        ) : null}
        {companyId && onDuty ? (
          <div className="sf-tiles">
            <Tile to={open ? `/field/customers/${open.party_id}/order` : '/field/customers'} title={t('fieldToday.tiles.order')} note={t('fieldToday.tiles.orderNote')} />
            <Tile to={open ? `/field/customers/${open.party_id}/collect` : '/field/customers'} title={t('fieldToday.tiles.collect')} note={t('fieldToday.tiles.collectNote')} />
            <Tile to={open ? `/field/customers/${open.party_id}?tab=visit` : '/field/customers'} title={t('fieldToday.tiles.noOrder')} note={t('fieldToday.tiles.noOrderNote')} />
            <Tile to="/field/library" title={t('fieldToday.tiles.library')} note={t('fieldToday.tiles.libraryNote')} />
          </div>
        ) : null}
        {myDay ? (
          <section className="sf-phone-card" aria-label={t('fieldToday.numbers')}>
            <Line label={t('fieldToday.visited')} value={t('fieldToday.ofN', { done: myDay.visits_done, n: myDay.visits_planned })} testId="visits" />
            <Line label={t('fieldToday.ordersToday')} value={<Amount value={myDay.orders_total} rupee />} />
            <Line label={t('fieldToday.cashWithMe')} value={<Amount value={myDay.cash_with_me} rupee />} testId="cash-with-me" />
            <Line label={t('fieldToday.target')} value={t('fieldToday.targetToSet')} />
          </section>
        ) : null}
        <section className="sf-phone-section" aria-labelledby="route-today">
          <h2 id="route-today">{t('fieldToday.route')}</h2>
          {route.isLoading ? (
            <Skeleton height={60} />
          ) : stops.length === 0 ? (
            <div className="sf-phone-note">{t('fieldToday.noRoute')}</div>
          ) : (
            <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {stops.map((s, i) => (
                <li key={`${s.beat_id}-${s.party_id}`}>
                  <Link to={`/field/customers/${s.party_id}`} className="sf-phone-line" style={{ color: 'var(--sf-text)', textDecoration: 'none', flexDirection: 'column', alignItems: 'flex-start' }}>
                    <span style={{ display: 'flex', justifyContent: 'space-between', width: '100%', gap: 8 }}>
                      <strong>
                        {i + 1} · {s.name}
                      </strong>
                      <span className="sf-chip" data-tone={s.visited ? 'success' : 'neutral'}>
                        {s.visited ? t('fieldToday.done') : t('fieldToday.planned')}
                      </span>
                    </span>
                    <Flags row={s} />
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </section>
        {onDuty ? (
          <Link to="/field/end-day" className="sf-btn" data-size="touch" style={{ justifyContent: 'center' }}>
            {t('fieldToday.endDay')}
          </Link>
        ) : null}
        <p className="k" style={{ margin: 0, textAlign: 'center' }}>
          {t('fieldToday.footnote')}
        </p>
      </FieldGate>
    </FieldFrame>
  )
}

function Tile({ to, title, note }: { to: string; title: string; note: string }) {
  return (
    <Link to={to} className="sf-tile">
      <span>
        {title}
        <br />
        <span className="sf-tile__note">{note}</span>
      </span>
    </Link>
  )
}

function Flags({ row }: { row: { overdue_gst: number | string; open_query: boolean; credit_hold: boolean; kyc_missing: boolean; last_visit: string | null } }) {
  const { t } = useTranslation()
  const items: { key: string; tone: string; text: React.ReactNode }[] = []
  if (Number(row.overdue_gst) > 0) items.push({ key: 'od', tone: 'danger', text: <>{t('fieldToday.flags.overdue')} <Amount value={row.overdue_gst} rupee /></> })
  if (row.open_query) items.push({ key: 'q', tone: 'signal', text: t('fieldToday.flags.query') })
  if (row.credit_hold) items.push({ key: 'c', tone: 'danger', text: t('fieldToday.flags.creditHold') })
  if (row.kyc_missing) items.push({ key: 'k', tone: 'signal', text: t('fieldToday.flags.kyc') })
  if (items.length === 0 && !row.last_visit) return null
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {items.map((x) => (
        <span key={x.key} className="sf-chip" data-tone={x.tone}>
          {x.text}
        </span>
      ))}
      {row.last_visit ? <span className="k">{t('fieldToday.lastVisit', { date: formatDate(row.last_visit) })}</span> : null}
    </span>
  )
}

/** Start of day: the written location notice, the acknowledgement, then api.start_duty with the first point. */
function StartDay({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const refresh = useFieldRefresh()
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<RpcError | null>(null)
  const [queued, setQueued] = useState(false)

  async function start() {
    setBusy(true)
    setError(null)
    try {
      // The location is read only now, after the notice was accepted (DPDP); the day starts even without a fix.
      const pos = ack ? await readPosition(8_000) : null
      const out = await sendOrQueue('start_duty', { p: { company_id: companyId, notice_ack: ack, lat: pos?.lat ?? null, lng: pos?.lng ?? null } }, 'startDuty')
      if (out.queued) setQueued(true)
      await refresh()
    } catch (e) {
      setError(e as RpcError)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="sf-phone-card" aria-labelledby="start-day">
      <h2 id="start-day">{t('fieldToday.notice.title')}</h2>
      <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14 }}>
        <li>{t('fieldToday.notice.when')}</li>
        <li>{t('fieldToday.notice.what')}</li>
        <li>{t('fieldToday.notice.keep')}</li>
        <li>{t('fieldToday.notice.who')}</li>
      </ul>
      <Checkbox label={t('fieldToday.notice.ack')} checked={ack} onChange={(e) => setAck(e.target.checked)} />
      <Button variant="primary" size="hero" busy={busy} onClick={() => void start()}>
        {t('fieldToday.notice.start')}
      </Button>
      {queued ? (
        <p role="status" className="sf-alert" data-tone="signal" style={{ margin: 0 }}>
          {t('fieldToday.notice.queued')}
        </p>
      ) : null}
      <FieldErrorBox error={error} />
    </section>
  )
}

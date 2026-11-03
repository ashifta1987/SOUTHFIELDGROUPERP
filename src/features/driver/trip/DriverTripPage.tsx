import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { callApi, type RpcError } from '@/data/rpc'
import { useDutyTracker } from '@/features/field/common/field'
import { formatDate, formatTime } from '@/shared/format'
import { Button, Checkbox, Field, Skeleton, TextAreaField } from '@/ui'
import { DRIVER_REFRESH, DriverErrorBox, DriverFrame, useDriverRights, useMyTrip, type MyTripStop } from '../common/driver'

/**
 * Driver's current trip (`DriverTrip`, /driver/trip): start the trip after the location notice (the server checks the
 * invoice and e-way bill of every delivery, credit and stock, and takes the stock out), the next stop with I've arrived /
 * Can't deliver / Record delivery, later stops, and Close trip once every stop is done. Location is read only during a
 * started trip whose notice was accepted; closing the trip ends it.
 */
export function DriverTripPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const rights = useDriverRights()
  const q = useMyTrip()
  const trip = q.data?.status === 'ready' ? q.data.data : null
  const stops = trip?.stops ?? []
  const done = stops.filter((s) => ['delivered', 'part_delivered', 'failed'].includes(s.status))
  const next = stops.find((s) => s.status === 'pending' || s.status === 'arrived')
  const later = stops.filter((s) => s !== next && (s.status === 'pending' || s.status === 'arrived'))
  useDutyTracker(trip?.status === 'started')

  async function refresh() {
    await Promise.all(DRIVER_REFRESH.map((k) => qc.invalidateQueries({ queryKey: k })))
  }

  return (
    <DriverFrame title={trip?.doc_no ?? t('driverTrip.title')} sub={trip?.vehicle ?? undefined}>
      {q.isLoading ? (
        <Skeleton height={200} />
      ) : !rights.drive ? (
        <div className="sf-phone-note" role="status">
          <strong>{t('driverCommon.noRightTitle')}</strong>
          <br />
          {t('driverCommon.noRight')}
        </div>
      ) : !trip?.trip_id ? (
        <div className="sf-phone-note" role="status">
          {t('driverTrip.none')}
        </div>
      ) : (
        <>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
              <span>{next ? t('driverTrip.stopOf', { i: next.seq, n: stops.length }) : t('driverTrip.allDone')}</span>
              <span>{t('driverTrip.done', { count: done.length })}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(stops.length, 1)}, 1fr)`, gap: 4, marginTop: 6 }} aria-hidden="true">
              {stops.map((s) => (
                <span key={s.stop_id} style={{ height: 6, borderRadius: 3, background: s.status === 'pending' ? 'var(--sf-line)' : s.status === 'arrived' ? 'var(--sf-info, var(--sf-primary))' : s.status === 'failed' ? 'var(--sf-danger)' : 'var(--sf-success)' }} />
              ))}
            </div>
          </div>
          {trip.status === 'planned' ? <StartTrip tripId={trip.trip_id} onDone={refresh} date={trip.trip_date} /> : null}
          {trip.status === 'started' && next ? <NextStop stop={next} onDone={refresh} /> : null}
          {trip.status === 'started' && !next ? <CloseTrip tripId={trip.trip_id} onDone={refresh} /> : null}
          {later.length > 0 ? (
            <section className="sf-phone-section" aria-labelledby="later">
              <h2 id="later">{t('driverTrip.later')}</h2>
              {later.map((s) => (
                <div key={s.stop_id} className="sf-phone-line" style={{ justifyContent: 'space-between' }}>
                  <span>
                    <strong>{s.seq}</strong> · {s.customer}
                    {s.address ? `, ${s.address}` : ''}
                  </span>
                  <span className="mono">{s.scheduled_at ? formatTime(s.scheduled_at) : ''}</span>
                </div>
              ))}
            </section>
          ) : null}
          {done.length > 0 ? (
            <section className="sf-phone-section" aria-labelledby="done">
              <h2 id="done">{t('driverTrip.doneList')}</h2>
              {done.map((s) => (
                <div key={s.stop_id} className="sf-phone-line" style={{ justifyContent: 'space-between' }}>
                  <span>
                    <strong>{s.seq}</strong> · {s.customer}
                  </span>
                  <span className="sf-chip" data-tone={s.status === 'failed' ? 'danger' : s.status === 'part_delivered' ? 'signal' : 'success'}>
                    {t(`driverTrip.status.${s.status}`)}
                  </span>
                </div>
              ))}
            </section>
          ) : null}
        </>
      )}
    </DriverFrame>
  )
}

function StartTrip({ tripId, date, onDone }: { tripId: string; date?: string; onDone: () => Promise<void> }) {
  const { t } = useTranslation()
  const [ack, setAck] = useState(false)
  const [odo, setOdo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<RpcError | null>(null)
  async function start() {
    setBusy(true)
    setError(null)
    try {
      await callApi('start_trip', { p_trip_id: tripId, p: { odometer_start: odo.trim() || null, gps_notice_ack: ack } })
      await onDone()
    } catch (e) {
      setError(e as RpcError)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="sf-phone-card" aria-labelledby="start-trip">
      <h2 id="start-trip">{t('driverTrip.startTitle', { date: date ? formatDate(date) : '' })}</h2>
      <p style={{ margin: 0, fontSize: 14 }}>{t('driverTrip.notice')}</p>
      <Checkbox label={t('driverTrip.ack')} checked={ack} onChange={(e) => setAck(e.target.checked)} />
      <Field label={t('driverTrip.odoStart')} inputMode="numeric" value={odo} onChange={(e) => setOdo(e.target.value.replace(/\D/g, ''))} />
      <Button variant="primary" size="hero" busy={busy} onClick={() => void start()}>
        {t('driverTrip.start')}
      </Button>
      <p className="k" style={{ margin: 0 }}>
        {t('driverTrip.startNote')}
      </p>
      <DriverErrorBox error={error} />
    </section>
  )
}

function NextStop({ stop, onDone }: { stop: MyTripStop; onDone: () => Promise<void> }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<RpcError | null>(null)
  const [failing, setFailing] = useState(false)
  const [reason, setReason] = useState('')
  async function arrive() {
    setBusy(true)
    setError(null)
    try {
      await callApi('mark_stop_arrived', { p_stop_id: stop.stop_id })
      await onDone()
    } catch (e) {
      setError(e as RpcError)
    } finally {
      setBusy(false)
    }
  }
  async function fail() {
    setBusy(true)
    setError(null)
    try {
      await callApi('record_failed_delivery', { p_stop_id: stop.stop_id, p_reason: reason.trim() })
      setFailing(false)
      setReason('')
      await onDone()
    } catch (e) {
      setError(e as RpcError)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <section className="sf-phone-card" aria-labelledby="next-stop">
        <h2 id="next-stop" style={{ textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--sf-info-ink, var(--sf-primary))' }}>
          {stop.status === 'arrived' ? t('driverTrip.atStop') : t('driverTrip.nextStop')}
          {stop.scheduled_at ? ` · ${formatTime(stop.scheduled_at)}` : ''}
        </h2>
        <strong style={{ fontSize: 24 }}>{stop.customer}</strong>
        {stop.address ? <span>{stop.address}</span> : null}
        <dl style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: '6px 12px', margin: 0, fontSize: 15 }}>
          <dt className="k">{t('driverTrip.delivery')}</dt>
          <dd className="mono" style={{ margin: 0 }}>
            {stop.dispatch_no}
          </dd>
          <dt className="k">{t('driverTrip.load')}</dt>
          <dd style={{ margin: 0 }}>{(stop.lines ?? []).map((l) => `${l.qty} ${l.uom ?? ''} ${l.product}`).join(' · ')}</dd>
          <dt className="k">{t('driverTrip.contact')}</dt>
          <dd style={{ margin: 0 }}>{stop.contact_masked ?? '—'}</dd>
        </dl>
        {stop.address ? (
          <a className="sf-btn" data-size="touch" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${stop.customer}, ${stop.address}`)}`} target="_blank" rel="noreferrer" style={{ justifyContent: 'center' }}>
            {t('driverTrip.directions')}
          </a>
        ) : null}
      </section>
      {stop.status === 'pending' ? (
        <Button variant="primary" size="hero" busy={busy} onClick={() => void arrive()}>
          {t('driverTrip.arrived')}
        </Button>
      ) : (
        <Link to={`/driver/pod?stop=${stop.stop_id}`} className="sf-btn" data-variant="primary" data-size="hero" style={{ justifyContent: 'center' }}>
          {t('driverTrip.recordPod')}
        </Link>
      )}
      {failing ? (
        <section className="sf-phone-card" aria-labelledby="fail-head">
          <h2 id="fail-head">{t('driverTrip.failTitle')}</h2>
          <TextAreaField label={t('driverTrip.failReason')} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
          <Button variant="danger" size="touch" busy={busy} disabled={reason.trim().length < 5} onClick={() => void fail()}>
            {t('driverTrip.failConfirm')}
          </Button>
          <p className="k" style={{ margin: 0 }}>
            {t('driverTrip.failNote')}
          </p>
        </section>
      ) : (
        <Button variant="danger" size="touch" onClick={() => setFailing(true)}>
          {t('driverTrip.cantDeliver')}
        </Button>
      )}
      <DriverErrorBox error={error} />
    </>
  )
}

function CloseTrip({ tripId, onDone }: { tripId: string; onDone: () => Promise<void> }) {
  const { t } = useTranslation()
  const [odo, setOdo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<RpcError | null>(null)
  const [closed, setClosed] = useState(false)
  async function close() {
    setBusy(true)
    setError(null)
    try {
      await callApi('close_trip', { p_trip_id: tripId, p: { odometer_end: odo.trim() || null } })
      setClosed(true)
      await onDone()
    } catch (e) {
      setError(e as RpcError)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="sf-phone-card" aria-labelledby="close-trip">
      <h2 id="close-trip">{t('driverTrip.closeTitle')}</h2>
      <Field label={t('driverTrip.odoEnd')} inputMode="numeric" value={odo} onChange={(e) => setOdo(e.target.value.replace(/\D/g, ''))} />
      <Button variant="primary" size="hero" busy={busy} onClick={() => void close()}>
        {t('driverTrip.close')}
      </Button>
      {closed ? (
        <p role="status" className="sf-alert" data-tone="success" style={{ margin: 0 }}>
          {t('driverTrip.closed')}
        </p>
      ) : null}
      <DriverErrorBox error={error} />
    </section>
  )
}

import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { formatDate, formatTime } from '@/shared/format'
import { Button, Card, Checkbox, DataTable, EmptyState, Field, FieldGrid, FormDialog, PageHeader, SelectField, Skeleton, TextAreaField, type Column } from '@/ui'
import { DispatchStatus, LOGI_REFRESH, LogisticsErrorBox, podUrl, useCompanyPeople, useLogisticsRights } from '../common/logistics'

type Trip = ViewRow<'trips'>
type Stop = ViewRow<'trip_stops'>

/**
 * Trips (`Trip`): create a trip (vehicle or transporter, driver, the scheduled deliveries), start it (the database checks
 * every delivery's posted invoice and e-way bill, credit and stock, and takes the stock out), follow the stops and their
 * proof of delivery (signature and photos from the private `pod` bucket), the e-way bills, the last recorded position
 * (only during the trip, after the driver's notice), and close it when every stop is done.
 */
export function TripsPage() {
  const { t } = useTranslation()
  const rights = useLogisticsRights()
  const choice = useCompanyChoice()
  const companyId = choice.companyId
  const [params, setParams] = useSearchParams()
  const trips = useApiView('trips', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 200, enabled: Boolean(companyId) })
  const list = rowsOf(trips)
  const selectedId = params.get('trip') ?? list[0]?.id
  const trip = list.find((x) => x.id === selectedId)
  const [newOpen, setNewOpen] = useState(false)

  function select(id: string) {
    const next = new URLSearchParams(params)
    next.set('trip', id)
    setParams(next, { replace: true })
  }

  if (!rights.view) {
    return (
      <>
        <PageHeader title={t('tripsPage.title')} />
        <Card>
          <p className="k">{t('tripsPage.noRight')}</p>
        </Card>
      </>
    )
  }

  const columns: Column<Trip>[] = [
    { key: 'doc', header: t('tripsPage.cols.trip'), render: (r) => <span className="mono">{r.doc_no}</span> },
    { key: 'date', header: t('tripsPage.cols.date'), render: (r) => formatDate(r.trip_date) },
    { key: 'veh', header: t('tripsPage.cols.vehicle'), render: (r) => r.vehicle_reg_no ?? r.transporter ?? '—' },
    { key: 'driver', header: t('tripsPage.cols.driver'), render: (r) => r.driver_name ?? '—' },
    { key: 'stops', header: t('tripsPage.cols.stops'), align: 'right', render: (r) => <span className="mono">{`${r.stops_done ?? 0}/${r.stops ?? 0}`}</span> },
    { key: 'status', header: t('common.status'), render: (r) => <DispatchStatus status={r.status} /> },
  ]

  return (
    <>
      <p className="k" style={{ margin: '0 0 6px' }}>
        <Link to={`/logistics/dispatch-board?company=${companyId ?? ''}`}>{t('tripsPage.crumb')}</Link> / {t('tripsPage.title')}
      </p>
      <PageHeader
        title={t('tripsPage.title')}
        subtitle={t('tripsPage.subtitle')}
        actions={
          rights.create ? (
            <Button variant="primary" onClick={() => setNewOpen(true)} disabled={!companyId}>
              {t('tripsPage.new')}
            </Button>
          ) : null
        }
      />
      <div style={{ marginBottom: 12 }}>
        <CompanyPicker list={choice.list} value={companyId} onChange={choice.choose} />
      </div>
      <Card pad={false} style={{ marginBottom: 16 }}>
        <DataTable
          caption={t('tripsPage.listCaption')}
          columns={columns}
          rows={list}
          rowKey={(r) => r.id}
          loading={trips.isLoading}
          onRowClick={(r) => select(r.id)}
          rowTone={(r) => (r.id === selectedId ? 'signal' : undefined)}
          empty={<EmptyState title={t('tripsPage.emptyTitle')} body={t('tripsPage.emptyBody')} />}
        />
      </Card>
      {trip ? <TripDetail trip={trip} /> : null}
      {newOpen && companyId ? <NewTrip companyId={companyId} onClose={() => setNewOpen(false)} onCreated={select} /> : null}
    </>
  )
}

function TripDetail({ trip }: { trip: Trip }) {
  const { t } = useTranslation()
  const rights = useLogisticsRights()
  const stops = useApiView('trip_stops', { eq: { trip_id: trip.id }, order: 'seq' })
  const dispatches = useApiView('dispatches', { eq: { trip_id: trip.id }, order: 'doc_no' })
  const points = useApiView('gps_points', { eq: { user_id: trip.driver_user_id ?? undefined }, order: 'at', ascending: false, limit: 1, enabled: Boolean(trip.driver_user_id) && trip.status === 'started' })
  const start = useApiMutation<{ p_trip_id: string; p: Record<string, unknown> }>('start_trip', LOGI_REFRESH)
  const close = useApiMutation<{ p_trip_id: string; p: Record<string, unknown> }>('close_trip', LOGI_REFRESH)
  const [odo, setOdo] = useState('')
  const last = rowsOf(points)[0]
  const stopRows = rowsOf(stops)

  return (
    <>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <h2 className="mono" style={{ margin: 0, fontSize: 24 }}>
          {trip.doc_no}
        </h2>
        <DispatchStatus status={trip.status} />
        <span className="k">
          {[trip.vehicle_reg_no ?? trip.transporter, trip.driver_name, trip.lr_no ? t('tripsPage.lr', { no: trip.lr_no }) : null, trip.started_at ? t('tripsPage.left', { time: formatTime(trip.started_at) }) : null].filter(Boolean).join(' · ')}
        </span>
      </div>
      <div className="sf-grid-2">
        <div style={{ flex: '2 1 520px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card title={t('tripsPage.stops')}>
            {stops.isLoading ? (
              <Skeleton height={80} />
            ) : stopRows.length === 0 ? (
              <p className="k">{t('tripsPage.noStops')}</p>
            ) : (
              <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
                {stopRows.map((s) => (
                  <StopRow key={s.id} stop={s} tripStarted={trip.status === 'started'} canEdit={rights.edit} />
                ))}
              </ol>
            )}
          </Card>
          <Card title={t('tripsPage.history')}>
            <History trip={trip} stops={stopRows} />
          </Card>
          {rights.edit && (trip.status === 'planned' || trip.status === 'started') ? (
            <Card title={trip.status === 'planned' ? t('tripsPage.startTitle') : t('tripsPage.closeTitle')}>
              <p className="k" style={{ marginTop: 0 }}>
                {trip.status === 'planned' ? t('tripsPage.startHelp') : t('tripsPage.closeHelp')}
              </p>
              <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
                <div style={{ width: 220 }}>
                  <Field label={trip.status === 'planned' ? t('tripsPage.odoStart') : t('tripsPage.odoEnd')} inputMode="numeric" value={odo} onChange={(e) => setOdo(e.target.value.replace(/\D/g, ''))} />
                </div>
                {trip.status === 'planned' ? (
                  <Button variant="primary" busy={start.isPending} onClick={() => start.mutate({ p_trip_id: trip.id, p: { odometer_start: odo || null, gps_notice_ack: false } })}>
                    {t('tripsPage.start')}
                  </Button>
                ) : (
                  <Button variant="primary" busy={close.isPending} onClick={() => close.mutate({ p_trip_id: trip.id, p: { odometer_end: odo || null } })}>
                    {t('tripsPage.close')}
                  </Button>
                )}
              </div>
              <LogisticsErrorBox error={start.error ?? close.error} />
            </Card>
          ) : null}
        </div>
        <div style={{ flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card title={t('tripsPage.position')}>
            {last ? (
              <>
                <p style={{ margin: 0 }} className="mono">
                  {Number(last.lat).toFixed(5)}, {Number(last.lng).toFixed(5)}
                </p>
                <p className="k" style={{ margin: '4px 0 0' }}>
                  {t('tripsPage.lastSeen', { time: formatTime(last.at), date: formatDate(last.at) })}
                </p>
              </>
            ) : (
              <p className="k" style={{ margin: 0 }}>
                {t('tripsPage.noPosition')}
              </p>
            )}
            <p className="k" style={{ margin: '8px 0 0' }}>
              {t('tripsPage.positionNote')}
            </p>
          </Card>
          <Card title={t('tripsPage.eway')}>
            {rowsOf(dispatches).length === 0 ? (
              <p className="k" style={{ margin: 0 }}>
                {t('tripsPage.noStops')}
              </p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {rowsOf(dispatches).map((d) => (
                  <li key={d.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span className="mono">
                      {d.doc_no} · {d.eway_bill_no ?? (d.eway_ready ? t('tripsPage.ewayNotNeeded') : t('tripsPage.ewayNeeded'))}
                    </span>
                    <DispatchStatus status={d.status} />
                  </li>
                ))}
              </ul>
            )}
            <p className="k" style={{ margin: '8px 0 0' }}>
              {t('tripsPage.ewayNote')}
            </p>
          </Card>
        </div>
      </div>
    </>
  )
}

function StopRow({ stop, tripStarted, canEdit }: { stop: Stop; tripStarted: boolean; canEdit: boolean }) {
  const { t } = useTranslation()
  const [showPod, setShowPod] = useState(false)
  const [failOpen, setFailOpen] = useState(false)
  const [reason, setReason] = useState('')
  const arrive = useApiMutation<{ p_stop_id: string }>('mark_stop_arrived', LOGI_REFRESH)
  const fail = useApiMutation<{ p_stop_id: string; p_reason: string }>('record_failed_delivery', LOGI_REFRESH)
  const done = ['delivered', 'part_delivered'].includes(stop.status)
  const open = stop.status === 'pending' || stop.status === 'arrived'
  return (
    <li style={{ display: 'grid', gridTemplateColumns: '28px 1fr', gap: 10 }}>
      <span aria-hidden="true" style={{ width: 24, height: 24, borderRadius: 12, border: '2px solid var(--sf-line)', background: done ? 'var(--sf-success)' : stop.status === 'failed' ? 'var(--sf-danger)' : 'var(--sf-surface)' }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong>
            {stop.seq}. {stop.party_name}
          </strong>
          <span className="mono k">{stop.dispatch_no}</span>
          <DispatchStatus status={stop.status} />
        </span>
        <span className="k">
          {stop.arrived_at ? t('tripsPage.arrivedAt', { time: formatTime(stop.arrived_at) }) : ''}
          {stop.done_at ? ` · ${t('tripsPage.doneAt', { time: formatTime(stop.done_at) })}` : ''}
          {stop.fail_reason ? ` · ${stop.fail_reason}` : ''}
        </span>
        {done ? (
          <Button variant="link" size="sm" onClick={() => setShowPod(!showPod)} aria-expanded={showPod}>
            {showPod ? t('tripsPage.hidePod') : t('tripsPage.viewPod')}
          </Button>
        ) : null}
        {showPod ? <PodView stopId={stop.id} /> : null}
        {canEdit && tripStarted && open ? (
          <div className="sf-row">
            {stop.status === 'pending' ? (
              <Button size="sm" busy={arrive.isPending} onClick={() => arrive.mutate({ p_stop_id: stop.id })}>
                {t('tripsPage.markArrived')}
              </Button>
            ) : null}
            <Button size="sm" variant="danger" onClick={() => setFailOpen(true)}>
              {t('tripsPage.markFailed')}
            </Button>
          </div>
        ) : null}
        <LogisticsErrorBox error={arrive.error} />
        <FormDialog
          open={failOpen}
          onOpenChange={setFailOpen}
          title={t('tripsPage.failTitle', { doc: stop.dispatch_no })}
          description={t('tripsPage.failHelp')}
          submitLabel={t('tripsPage.markFailed')}
          busy={fail.isPending}
          onSubmit={() => fail.mutate({ p_stop_id: stop.id, p_reason: reason.trim() }, { onSuccess: () => setFailOpen(false) })}
          error={<LogisticsErrorBox error={fail.error} />}
        >
          <TextAreaField label={t('common.reason')} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
        </FormDialog>
      </div>
    </li>
  )
}

/** Proof of delivery for a stop: receiver, masked phone, time, remarks, signature and photos (signed links, 5 minutes). */
function PodView({ stopId }: { stopId: string }) {
  const { t } = useTranslation()
  const q = useApiView('pods', { eq: { stop_id: stopId }, limit: 1 })
  const pod = rowsOf(q)[0]
  const [sig, setSig] = useState<string | null>(null)
  const [photos, setPhotos] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    void (async () => {
      if (!pod) return
      const s = pod.signature_path ? await podUrl(pod.signature_path) : null
      const ps = await Promise.all((pod.photo_paths ?? []).map((p) => podUrl(p)))
      if (alive) {
        setSig(s)
        setPhotos(ps.filter((x): x is string => Boolean(x)))
      }
    })()
    return () => {
      alive = false
    }
  }, [pod])
  if (q.isLoading) return <Skeleton height={60} />
  if (!pod) return <p className="k">{t('tripsPage.noPod')}</p>
  return (
    <div className="sf-card sf-card__pad" style={{ background: 'var(--sf-paper)', display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="pod-view">
      <span>
        {t('tripsPage.receivedBy', { name: pod.received_by_name })}
        {pod.receiver_phone_masked ? ` · ${pod.receiver_phone_masked}` : ''} · {formatDate(pod.created_at)} {formatTime(pod.created_at)}
      </span>
      {pod.remarks ? <span className="k">{pod.remarks}</span> : null}
      {sig ? <img src={sig} alt={t('tripsPage.signatureAlt', { name: pod.received_by_name })} style={{ maxWidth: 280, background: 'var(--sf-surface)', border: '1px solid var(--sf-line)', borderRadius: 8 }} /> : null}
      {photos.length > 0 ? (
        <div className="sf-row">
          {photos.map((u, i) => (
            <a key={u} href={u} target="_blank" rel="noreferrer">
              {t('tripsPage.photo', { n: i + 1 })}
            </a>
          ))}
        </div>
      ) : null}
      <span className="k">{pod.lat !== null ? t('tripsPage.placeKept') : t('tripsPage.placeNotKept')}</span>
    </div>
  )
}

function History({ trip, stops }: { trip: Trip; stops: Stop[] }) {
  const { t } = useTranslation()
  const events: { at: string; text: string }[] = [{ at: trip.created_at, text: t('tripsPage.ev.created') }]
  if (trip.started_at) events.push({ at: trip.started_at, text: t('tripsPage.ev.started') })
  for (const s of stops) {
    if (s.arrived_at) events.push({ at: s.arrived_at, text: t('tripsPage.ev.arrived', { n: s.seq, name: s.party_name }) })
    if (s.done_at) events.push({ at: s.done_at, text: t(`tripsPage.ev.${s.status === 'failed' ? 'failed' : 'delivered'}`, { doc: s.dispatch_no }) })
  }
  if (trip.closed_at) events.push({ at: trip.closed_at, text: t('tripsPage.ev.closed') })
  events.sort((a, b) => b.at.localeCompare(a.at))
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {events.map((e, i) => (
        <li key={i} style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--sf-line)' }}>
          <span className="mono">
            {formatDate(e.at)} {formatTime(e.at)}
          </span>
          <span>{e.text}</span>
        </li>
      ))}
    </ul>
  )
}

/** New trip: date, vehicle (or a hired transporter), driver, LR number and the scheduled deliveries not yet on a trip. */
function NewTrip({ companyId, onClose, onCreated }: { companyId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation()
  const vehicles = useApiView('vehicles', { eq: { company_id: companyId, status: 'active' }, order: 'reg_no' })
  const dispatches = useApiView('dispatches', { eq: { company_id: companyId, status: 'planned' }, order: 'doc_no' })
  const people = useCompanyPeople(companyId)
  const drivers = people.filter((p) => (p.role_keys ?? []).includes('driver'))
  const free = rowsOf(dispatches).filter((d) => !d.trip_id)
  const create = useApiMutation<{ p: Record<string, unknown> }, { id: string; doc_no: string }>('create_trip', LOGI_REFRESH)
  const [date, setDate] = useState(todayIst())
  const [vehicleId, setVehicleId] = useState('')
  const [transporter, setTransporter] = useState('')
  const [driver, setDriver] = useState('')
  const [lr, setLr] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  return (
    <FormDialog
      open
      wide
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('tripsPage.newTitle')}
      description={t('tripsPage.newHelp')}
      submitLabel={t('tripsPage.create')}
      busy={create.isPending}
      onSubmit={() =>
        create.mutate(
          { p: { company_id: companyId, trip_date: date, vehicle_id: vehicleId || null, transporter: vehicleId ? null : transporter.trim() || null, driver_user_id: driver || null, lr_no: lr.trim() || null, dispatch_ids: picked } },
          {
            onSuccess: (r) => {
              onCreated(r.id)
              onClose()
            },
          },
        )
      }
      error={<LogisticsErrorBox error={create.error} />}
    >
      <FieldGrid>
        <Field label={t('tripsPage.date')} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <SelectField label={t('tripsPage.vehicle')} value={vehicleId} placeholder={t('tripsPage.hired')} onChange={(e) => setVehicleId(e.target.value)} options={rowsOf(vehicles).map((v) => ({ value: v.id, label: `${v.reg_no}${v.has_expired_papers ? ` · ${t('tripsPage.expired')}` : ''}` }))} />
        {!vehicleId ? <Field label={t('tripsPage.transporter')} value={transporter} onChange={(e) => setTransporter(e.target.value)} /> : null}
        <SelectField label={t('tripsPage.driver')} value={driver} placeholder={drivers.length ? t('tripsPage.choose') : t('tripsPage.noDrivers')} onChange={(e) => setDriver(e.target.value)} options={drivers.map((p) => ({ value: p.user_id, label: p.display_name }))} />
        <Field label={t('tripsPage.lrNo')} value={lr} onChange={(e) => setLr(e.target.value)} />
      </FieldGrid>
      <fieldset style={{ border: '1px solid var(--sf-line)', borderRadius: 8, padding: 12 }}>
        <legend>{t('tripsPage.deliveries')}</legend>
        {free.length === 0 ? (
          <p className="k" style={{ margin: 0 }}>
            {t('tripsPage.noFree')}
          </p>
        ) : (
          free.map((d) => (
            <Checkbox
              key={d.id}
              label={`${d.doc_no} · ${d.party_name ?? ''}${d.invoice_no ? '' : ` · ${t('tripsPage.noInvoiceYet')}`}${d.eway_bill_no ? '' : ` · ${t('tripsPage.noEwayYet')}`}`}
              checked={picked.includes(d.id)}
              onChange={(e) => setPicked(e.target.checked ? [...picked, d.id] : picked.filter((x) => x !== d.id))}
            />
          ))
        )}
      </fieldset>
    </FormDialog>
  )
}

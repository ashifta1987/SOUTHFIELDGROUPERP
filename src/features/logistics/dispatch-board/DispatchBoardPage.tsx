import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { useCompanyChoice } from '@/features/admin/branches/company'
import { formatDate, formatTime } from '@/shared/format'
import { Amount, Button, Card, EmptyState, Field, FieldGrid, FormDialog, PageHeader, SelectField, Skeleton, Tabs } from '@/ui'
import { Check, DispatchStatus, istLocalToIso, LOGI_REFRESH, LogisticsErrorBox, usePlaces, useLogisticsRights } from '../common/logistics'

type Dispatch = ViewRow<'dispatches'>
type View = 'board' | 'list'

const COLUMNS: { key: string; states: string[] }[] = [
  { key: 'scheduled', states: ['planned'] },
  { key: 'transit', states: ['dispatched'] },
  { key: 'delivered', states: ['delivered', 'part_delivered'] },
  { key: 'failed', states: ['failed', 'cancelled'] },
]

/**
 * Dispatch board (`Dispatch`): deliveries made from confirmed orders (api.create_dispatch), each with its readiness
 * checks — posted invoice (api.invoice_dispatch makes and posts it through the Phase 3 GST engine), e-way bill number
 * (api.set_dispatch_eway), trip — then in transit, delivered (proof of delivery) or failed. A delivery leaves only when
 * every check is green; the trip start enforces it in the database. Vehicles today at the bottom.
 */
export function DispatchBoardPage() {
  const { t } = useTranslation()
  const rights = useLogisticsRights()
  const choice = useCompanyChoice()
  const companyId = choice.companyId
  const [view, setView] = useState<View>('board')
  const [newOpen, setNewOpen] = useState(false)
  const dispatches = useApiView('dispatches', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 300, enabled: Boolean(companyId) })
  const vehicles = useApiView('vehicles', { eq: { company_id: companyId }, order: 'reg_no', enabled: Boolean(companyId) })
  const trips = useApiView('trips', { eq: { company_id: companyId, status: 'planned' }, order: 'trip_date', enabled: Boolean(companyId) })
  const rows = rowsOf(dispatches)

  if (!rights.view) {
    return (
      <>
        <PageHeader title={t('dispatchBoard.title')} />
        <Card>
          <p className="k">{t('dispatchBoard.noRight')}</p>
        </Card>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title={t('dispatchBoard.title')}
        subtitle={t('dispatchBoard.subtitle', { count: rows.filter((r) => r.status === 'planned' || r.status === 'dispatched').length })}
        actions={
          <>
            <Tabs
              variant="segmented"
              label={t('dispatchBoard.views')}
              value={view}
              onChange={setView}
              tabs={[
                { key: 'board', label: t('dispatchBoard.board') },
                { key: 'list', label: t('dispatchBoard.list') },
              ]}
            />
            {rights.create ? (
              <Button variant="primary" onClick={() => setNewOpen(true)} disabled={!companyId}>
                {t('dispatchBoard.schedule')}
              </Button>
            ) : null}
          </>
        }
      />
      <div style={{ marginBottom: 12 }}>
        <CompanyPicker list={choice.list} value={companyId} onChange={choice.choose} />
      </div>
      <p className="k" style={{ margin: '0 0 12px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>{t('dispatchBoard.checks')}</strong>
        <Check state="done" label={t('logisticsCommon.check.done')} />
        <Check state="pending" label={t('logisticsCommon.check.pending')} />
        <Check state="na" label={t('logisticsCommon.check.na')} />
      </p>
      {dispatches.isLoading ? (
        <Skeleton height={300} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState title={t('dispatchBoard.emptyTitle')} body={t('dispatchBoard.emptyBody')} />
        </Card>
      ) : view === 'board' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(240px, 1fr))', gap: 14, overflowX: 'auto', alignItems: 'start' }}>
          {COLUMNS.map((c) => {
            const list = rows.filter((r) => c.states.includes(r.status))
            return (
              <section key={c.key} aria-labelledby={`col-${c.key}`} style={{ background: 'var(--sf-line-soft)', borderRadius: 12, padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <h2 id={`col-${c.key}`} style={{ margin: '2px 4px', fontSize: 15, display: 'flex', justifyContent: 'space-between' }}>
                  <span>{t(`dispatchBoard.col.${c.key}`)}</span>
                  <span className="k">{list.length}</span>
                </h2>
                {list.length === 0 ? <p className="k" style={{ margin: 4 }}>{t('dispatchBoard.colEmpty')}</p> : list.map((d) => <DispatchCard key={d.id} d={d} trips={rowsOf(trips)} />)}
              </section>
            )
          })}
        </div>
      ) : (
        <Card pad={false}>
          <div className="sf-table-wrap" role="region" aria-label={t('dispatchBoard.list')} tabIndex={0}>
            <table className="sf-table" style={{ minWidth: 900 }}>
              <caption className="sr-only">{t('dispatchBoard.list')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('dispatchBoard.cols.doc')}</th>
                  <th scope="col">{t('dispatchBoard.cols.customer')}</th>
                  <th scope="col">{t('dispatchBoard.cols.order')}</th>
                  <th scope="col">{t('dispatchBoard.cols.invoice')}</th>
                  <th scope="col">{t('dispatchBoard.cols.eway')}</th>
                  <th scope="col">{t('dispatchBoard.cols.trip')}</th>
                  <th scope="col" style={{ textAlign: 'right' }}>{t('dispatchBoard.cols.value')}</th>
                  <th scope="col">{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td className="mono">{d.doc_no}</td>
                    <td>{d.party_name}</td>
                    <td className="mono">{d.order_no}</td>
                    <td className="mono">{d.invoice_no ?? '—'}</td>
                    <td className="mono">{d.eway_bill_no ?? '—'}</td>
                    <td className="mono">{d.trip_no ? <Link to={`/logistics/trips?company=${companyId}&trip=${d.trip_id}`}>{d.trip_no}</Link> : '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <Amount value={d.value} />
                    </td>
                    <td>
                      <DispatchStatus status={d.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <section aria-labelledby="veh-today" style={{ marginTop: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h2 id="veh-today" style={{ fontSize: 18, margin: '0 0 10px' }}>
            {t('dispatchBoard.vehiclesToday')}
          </h2>
          <Link to={`/logistics/vehicles-and-drivers?company=${companyId ?? ''}`}>{t('dispatchBoard.vehiclesLink')}</Link>
        </div>
        {rowsOf(vehicles).length === 0 ? (
          <p className="k">{t('dispatchBoard.noVehicles')}</p>
        ) : (
          <div className="sf-grid-3">
            {rowsOf(vehicles).map((v) => (
              <Card key={v.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <strong className="mono">{v.reg_no}</strong>
                  <DispatchStatus status={v.status} />
                </div>
                <p className="k" style={{ margin: '6px 0 0' }}>
                  {t(`vehiclesDrivers.kinds.${v.kind}`, { defaultValue: v.kind })}
                  {v.payload_kg ? ` · ${v.payload_kg} kg` : ''}
                  {v.usual_driver_name ? ` · ${v.usual_driver_name}` : ''}
                  {v.has_expired_papers ? ` · ${t('dispatchBoard.expired')}` : v.next_expiry ? ` · ${t('dispatchBoard.nextExpiry', { date: formatDate(v.next_expiry) })}` : ''}
                </p>
              </Card>
            ))}
          </div>
        )}
      </section>
      {newOpen && companyId ? <NewDispatch companyId={companyId} onClose={() => setNewOpen(false)} /> : null}
    </>
  )
}

function DispatchCard({ d, trips }: { d: Dispatch; trips: ViewRow<'trips'>[] }) {
  const { t } = useTranslation()
  const rights = useLogisticsRights()
  const invoice = useApiMutation<{ p_dispatch_id: string; p: Record<string, unknown> }>('invoice_dispatch', LOGI_REFRESH)
  const eway = useApiMutation<{ p_dispatch_id: string; p_eway_bill_no: string }>('set_dispatch_eway', LOGI_REFRESH)
  const assign = useApiMutation<{ p_trip_id: string; p_dispatch_ids: string[] }>('assign_to_trip', LOGI_REFRESH)
  const [ewayOpen, setEwayOpen] = useState(false)
  const [ewayNo, setEwayNo] = useState('')
  const [tripOpen, setTripOpen] = useState(false)
  const [tripId, setTripId] = useState('')
  const err: RpcError | null = invoice.error ?? (eway.error && !ewayOpen ? eway.error : null) ?? (assign.error && !tripOpen ? assign.error : null)
  const planned = d.status === 'planned'
  return (
    <article className="sf-card sf-card__pad" style={{ display: 'flex', flexDirection: 'column', gap: 6 }} aria-label={d.doc_no ?? ''} data-testid={`dispatch-${d.doc_no}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <strong className="mono">{d.doc_no}</strong>
        <span className="k">{d.scheduled_at ? `${formatDate(d.scheduled_at)} ${formatTime(d.scheduled_at)}` : ''}</span>
      </div>
      <strong>{d.party_name}</strong>
      <span className="k">
        <span className="mono">{d.order_no}</span> · {d.place_name}
        {d.trip_no ? (
          <>
            {' · '}
            <Link to={`/logistics/trips?company=${d.company_id}&trip=${d.trip_id}`}>{d.trip_no}</Link>
          </>
        ) : null}
        {d.vehicle_reg_no ? ` · ${d.vehicle_reg_no}` : ''}
      </span>
      <span>
        <Amount value={d.value} rupee />
      </span>
      <div className="sf-row" style={{ gap: 6 }}>
        <Check state={d.invoice_ready ? 'done' : 'pending'} label={d.invoice_no ? `${t('dispatchBoard.invoice')} ${d.invoice_no}` : t('dispatchBoard.invoice')} />
        <Check state={d.eway_bill_no ? 'done' : d.eway_ready ? 'na' : 'pending'} label={t('dispatchBoard.eway')} />
        <Check state={d.trip_id ? 'done' : 'pending'} label={t('dispatchBoard.trip')} />
        {d.status === 'delivered' || d.status === 'part_delivered' ? <Check state={d.pod_recorded ? 'done' : 'pending'} label={t('dispatchBoard.pod')} /> : null}
      </div>
      {d.status === 'part_delivered' ? <p className="sf-alert" data-tone="signal" style={{ margin: 0 }}>{t('dispatchBoard.partNote')}</p> : null}
      {d.status === 'failed' ? <p className="sf-alert" data-tone="danger" style={{ margin: 0 }}>{t('dispatchBoard.failedNote')}</p> : null}
      {planned && (rights.invoice || rights.edit) ? (
        <div className="sf-row" style={{ gap: 6 }}>
          {!d.document_id && rights.invoice ? (
            <Button size="sm" busy={invoice.isPending} onClick={() => invoice.mutate({ p_dispatch_id: d.id, p: {} })}>
              {t('dispatchBoard.makeInvoice')}
            </Button>
          ) : null}
          {rights.edit ? (
            <Button size="sm" onClick={() => setEwayOpen(true)}>
              {d.eway_bill_no ? t('dispatchBoard.changeEway') : t('dispatchBoard.addEway')}
            </Button>
          ) : null}
          {rights.edit && !d.trip_id && trips.length > 0 ? (
            <Button size="sm" onClick={() => setTripOpen(true)}>
              {t('dispatchBoard.addToTrip')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {d.eway_bill_no ? (
        <span className="k">
          {t('dispatchBoard.ewayNo')} <span className="mono">{d.eway_bill_no}</span>
        </span>
      ) : null}
      <LogisticsErrorBox error={err} />
      <FormDialog
        open={ewayOpen}
        onOpenChange={setEwayOpen}
        title={t('dispatchBoard.ewayTitle', { doc: d.doc_no })}
        description={t('dispatchBoard.ewayHelp')}
        submitLabel={t('common.save')}
        busy={eway.isPending}
        onSubmit={() => eway.mutate({ p_dispatch_id: d.id, p_eway_bill_no: ewayNo.replace(/\s/g, '') }, { onSuccess: () => setEwayOpen(false) })}
        error={<LogisticsErrorBox error={eway.error} />}
      >
        <Field label={t('dispatchBoard.ewayNo')} inputMode="numeric" value={ewayNo} onChange={(e) => setEwayNo(e.target.value)} autoFocus />
      </FormDialog>
      <FormDialog
        open={tripOpen}
        onOpenChange={setTripOpen}
        title={t('dispatchBoard.tripTitle', { doc: d.doc_no })}
        submitLabel={t('dispatchBoard.addToTrip')}
        busy={assign.isPending}
        onSubmit={() => assign.mutate({ p_trip_id: tripId, p_dispatch_ids: [d.id] }, { onSuccess: () => setTripOpen(false) })}
        error={<LogisticsErrorBox error={assign.error} />}
      >
        <SelectField label={t('dispatchBoard.trip')} value={tripId} placeholder={t('dispatchBoard.choose')} onChange={(e) => setTripId(e.target.value)} options={trips.map((x) => ({ value: x.id, label: `${x.doc_no} · ${formatDate(x.trip_date)} · ${x.vehicle_reg_no ?? x.transporter ?? ''}` }))} />
      </FormDialog>
    </article>
  )
}

interface DLine {
  order_line_id: string
  label: string
  open: number
  qty: string
}

/** Schedule delivery: a confirmed order, the place goods leave from, the time and the quantities (server checks all). */
function NewDispatch({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const orders = useApiView('sales_orders', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 200 })
  const open = rowsOf(orders).filter((o) => o.status === 'confirmed' || o.status === 'part_dispatched')
  const places = usePlaces(companyId)
  const [orderId, setOrderId] = useState('')
  const [placeId, setPlaceId] = useState('')
  const [when, setWhen] = useState('')
  const [lines, setLines] = useState<DLine[] | null>(null)
  const orderLines = useApiView('sales_order_lines', { eq: { order_id: orderId }, order: 'line_no', enabled: Boolean(orderId) })
  const create = useApiMutation<{ p: Record<string, unknown> }, { id: string; doc_no: string }>('create_dispatch', LOGI_REFRESH)
  const order = open.find((o) => o.id === orderId)
  const shown: DLine[] =
    lines ??
    rowsOf(orderLines)
      .filter((l) => Number(l.qty_to_dispatch ?? 0) > 0)
      .map((l) => ({ order_line_id: l.id, label: `${l.product_code ?? ''} · ${l.description ?? ''}`, open: Number(l.qty_to_dispatch ?? 0), qty: String(l.qty_to_dispatch ?? '') }))

  return (
    <FormDialog
      open
      wide
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('dispatchBoard.newTitle')}
      description={t('dispatchBoard.newHelp')}
      submitLabel={t('dispatchBoard.create')}
      busy={create.isPending}
      onSubmit={() =>
        create.mutate(
          { p: { order_id: orderId, place_id: placeId || null, scheduled_at: istLocalToIso(when), lines: shown.map((l) => ({ order_line_id: l.order_line_id, qty: l.qty.trim() || '0' })) } },
          { onSuccess: onClose },
        )
      }
      error={<LogisticsErrorBox error={create.error} />}
    >
      <FieldGrid>
        <SelectField
          label={t('dispatchBoard.order')}
          value={orderId}
          placeholder={open.length ? t('dispatchBoard.choose') : t('dispatchBoard.noOrders')}
          onChange={(e) => {
            setOrderId(e.target.value)
            setLines(null)
            const o = open.find((x) => x.id === e.target.value)
            if (o?.place_id) setPlaceId(o.place_id)
          }}
          options={open.map((o) => ({ value: o.id, label: `${o.doc_no} · ${o.party_name ?? ''}` }))}
        />
        <SelectField label={t('dispatchBoard.place')} value={placeId} placeholder={t('dispatchBoard.choose')} onChange={(e) => setPlaceId(e.target.value)} options={places.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))} />
        <Field label={t('dispatchBoard.when')} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
      </FieldGrid>
      {order ? (
        <p className="k" style={{ margin: 0 }}>
          {t('dispatchBoard.orderInfo', { date: formatDate(order.order_date), payment: order.payment })} · <Amount value={order.total} rupee />
        </p>
      ) : null}
      {orderId ? (
        shown.length === 0 ? (
          <p className="k">{t('dispatchBoard.nothingOpen')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {shown.map((l, i) => (
              <div key={l.order_line_id} style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: 10, alignItems: 'end' }}>
                <span>
                  {l.label}
                  <br />
                  <span className="k">{t('dispatchBoard.openQty', { qty: l.open })}</span>
                </span>
                <Field label={t('dispatchBoard.qtyFor', { item: l.label })} inputMode="decimal" value={l.qty} onChange={(e) => setLines(shown.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
              </div>
            ))}
          </div>
        )
      ) : null}
    </FormDialog>
  )
}

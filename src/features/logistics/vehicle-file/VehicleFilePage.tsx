import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { formatDate } from '@/shared/format'
import { Amount, Button, Card, DataTable, EmptyState, Field, FieldGrid, FormDialog, KpiTiles, PageHeader, SelectField, TextAreaField, type Column } from '@/ui'
import { LOGI_REFRESH, LogisticsErrorBox, useLogisticsRights } from '../common/logistics'

type Ev = ViewRow<'vehicle_events'>
const DOCS = ['rc', 'insurance', 'fitness', 'permit', 'puc', 'road_tax', 'fastag'] as const
const RUNNING = ['toll', 'parking', 'bata', 'loading', 'washing', 'tyre', 'other'] as const
const SECTIONS: { key: string; kinds: readonly string[]; add: string }[] = [
  { key: 'fuel', kinds: ['fuel'], add: 'fuel' },
  { key: 'repairs', kinds: ['repair', 'service'], add: 'service' },
  { key: 'running', kinds: RUNNING, add: 'toll' },
  { key: 'loan', kinds: ['emi', 'insurance', 'tax'], add: 'emi' },
  { key: 'fines', kinds: ['fine'], add: 'fine' },
  { key: 'accidents', kinds: ['accident'], add: 'accident' },
]

/**
 * Vehicle file (`VehicleFile`): fuel, repairs and service, running costs, loan/EMI, insurance and tax, fines and accidents
 * for each company vehicle — an append-only log (api.record_vehicle_event) — and the papers with their expiry
 * (api.set_vehicle_document; history kept, the latest per kind counts, an expired one blocks new trips unless Admin
 * overrides). Cost per km and fuel efficiency need the trip log over time and are not computed here.
 */
export function VehicleFilePage() {
  const { t } = useTranslation()
  const rights = useLogisticsRights()
  const choice = useCompanyChoice()
  const companyId = choice.companyId
  const [params, setParams] = useSearchParams()
  const vehicles = useApiView('vehicles', { eq: { company_id: companyId }, order: 'reg_no', enabled: Boolean(companyId) })
  const list = rowsOf(vehicles)
  const vehicleId = params.get('vehicle') ?? list[0]?.id
  const vehicle = list.find((v) => v.id === vehicleId)
  const docs = useApiView('vehicle_documents', { eq: { vehicle_id: vehicleId }, enabled: Boolean(vehicleId) })
  const events = useApiView('vehicle_events', { eq: { vehicle_id: vehicleId }, order: 'event_date', ascending: false, limit: 500, enabled: Boolean(vehicleId) })
  const evRows = rowsOf(events)
  const [addKind, setAddKind] = useState<string | null>(null)
  const [docKind, setDocKind] = useState<string | null>(null)
  const month = todayIst().slice(0, 7)
  const expiring = rowsOf(docs).filter((d) => d.days_left !== null && Number(d.days_left) <= 30)

  function choose(id: string) {
    const next = new URLSearchParams(params)
    next.set('vehicle', id)
    setParams(next, { replace: true })
  }

  if (!rights.view) {
    return (
      <>
        <PageHeader title={t('vehicleFile.title')} />
        <Card>
          <p className="k">{t('vehicleFile.noRight')}</p>
        </Card>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title={t('vehicleFile.title')}
        subtitle={t('vehicleFile.subtitle')}
        actions={
          <>
            <div style={{ minWidth: 220 }}>
              <SelectField label={t('vehicleFile.vehicle')} value={vehicleId ?? ''} placeholder={list.length ? undefined : t('vehicleFile.noVehicle')} onChange={(e) => choose(e.target.value)} options={list.map((v) => ({ value: v.id, label: v.reg_no }))} />
            </div>
            <Link className="sf-btn" data-variant="primary" to={`/logistics/vehicles-and-drivers?company=${companyId ?? ''}`}>
              {t('vehicleFile.addVehicle')}
            </Link>
          </>
        }
      />
      <div style={{ marginBottom: 12 }}>
        <CompanyPicker list={choice.list} value={companyId} onChange={choice.choose} />
      </div>
      {!vehicle ? (
        <Card>
          <EmptyState title={t('vehicleFile.emptyTitle')} body={t('vehicleFile.emptyBody')} />
        </Card>
      ) : (
        <>
          <KpiTiles
            ariaLabel={t('vehicleFile.kpis')}
            items={[
              { key: 'fuel', label: t('vehicleFile.kpi.fuel'), value: String(evRows.filter((e) => e.kind === 'fuel' && e.event_date.startsWith(month)).length), sub: t('vehicleFile.kpi.fuelSub') },
              { key: 'service', label: t('vehicleFile.kpi.service'), value: String(evRows.filter((e) => e.kind === 'service' || e.kind === 'repair').length), sub: t('vehicleFile.kpi.serviceSub') },
              { key: 'docs', label: t('vehicleFile.kpi.docs'), value: String(expiring.length), sub: vehicle.next_expiry ? t('vehicleFile.kpi.next', { date: formatDate(vehicle.next_expiry) }) : t('vehicleFile.kpi.noDocs') },
              { key: 'fines', label: t('vehicleFile.kpi.fines'), value: String(evRows.filter((e) => e.kind === 'fine').length), sub: t('vehicleFile.kpi.finesSub') },
              { key: 'status', label: t('vehicleFile.kpi.status'), value: t(`logisticsCommon.status.${vehicle.status}`, { defaultValue: vehicle.status }), sub: vehicle.has_expired_papers ? t('vehicleFile.kpi.blocked') : t('vehicleFile.kpi.ok') },
            ]}
          />
          <div className="sf-grid-2" style={{ marginTop: 16 }}>
            <Card title={t('vehicleFile.documents')} action={<span className="sf-chip" data-tone="neutral">{t('vehicleFile.history')}</span>}>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {DOCS.map((k) => {
                  const d = rowsOf(docs).find((x) => x.kind === k)
                  return (
                    <li key={k} style={{ display: 'grid', gridTemplateColumns: '160px 1fr auto', gap: 10, alignItems: 'center', padding: '9px 0', borderBottom: '1px solid var(--sf-line)' }}>
                      <strong>{t(`vehiclesDrivers.docKinds.${k}`)}</strong>
                      <span className={d ? '' : 'k'}>
                        {d ? (
                          <>
                            <span className="mono">{d.doc_no ?? '—'}</span>
                            {d.valid_to ? ` · ${t('vehicleFile.validTo', { date: formatDate(d.valid_to) })}` : ''}
                            {d.days_left !== null && Number(d.days_left) < 0 ? (
                              <span className="sf-chip" data-tone="danger" style={{ marginLeft: 6 }}>
                                {t('vehicleFile.expired')}
                              </span>
                            ) : d.days_left !== null && Number(d.days_left) <= 30 ? (
                              <span className="sf-chip" data-tone="signal" style={{ marginLeft: 6 }}>
                                {t('vehicleFile.daysLeft', { count: Number(d.days_left) })}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          t('vehicleFile.notEntered')
                        )}
                      </span>
                      {rights.edit ? (
                        <Button size="sm" onClick={() => setDocKind(k)}>
                          {d ? t('vehicleFile.update') : t('vehicleFile.enter')}
                        </Button>
                      ) : (
                        <span />
                      )}
                    </li>
                  )
                })}
              </ul>
              <p className="k" style={{ margin: '10px 0 0' }}>
                {t('vehicleFile.docNote')}
              </p>
            </Card>
            {SECTIONS.map((s) => (
              <EventCard key={s.key} section={s.key} rows={evRows.filter((e) => s.kinds.includes(e.kind))} onAdd={rights.create ? () => setAddKind(s.add) : undefined} />
            ))}
          </div>
          {addKind ? <AddEvent vehicleId={vehicle.id} initialKind={addKind} onClose={() => setAddKind(null)} /> : null}
          {docKind ? <SetDoc vehicleId={vehicle.id} kind={docKind} onClose={() => setDocKind(null)} /> : null}
        </>
      )}
    </>
  )
}

function EventCard({ section, rows, onAdd }: { section: string; rows: Ev[]; onAdd?: () => void }) {
  const { t } = useTranslation()
  const columns: Column<Ev>[] = [
    { key: 'date', header: t('vehicleFile.cols.date'), render: (r) => formatDate(r.event_date) },
    { key: 'kind', header: t('vehicleFile.cols.kind'), render: (r) => t(`vehicleFile.kinds.${r.kind}`, { defaultValue: r.kind }) },
    { key: 'km', header: t('vehicleFile.cols.km'), align: 'right', render: (r) => (r.odometer_km === null ? '—' : <span className="mono">{r.odometer_km}</span>) },
    ...(section === 'fuel' ? [{ key: 'l', header: t('vehicleFile.cols.litres'), align: 'right' as const, render: (r: Ev) => (r.litres === null ? '—' : <Amount value={r.litres} digits={2} />) }] : []),
    { key: 'amount', header: t('vehicleFile.cols.amount'), align: 'right', render: (r) => <Amount value={r.amount} /> },
    { key: 'paid', header: t('vehicleFile.cols.paidBy'), render: (r) => r.paid_by ?? '—' },
    { key: 'note', header: t('vehicleFile.cols.note'), render: (r) => r.note ?? '' },
  ]
  return (
    <Card
      pad={false}
      title={undefined}
      style={{ display: 'flex', flexDirection: 'column' }}
    >
      <div className="sf-card__head sf-card__pad" style={{ alignItems: 'center', paddingBottom: 8 }}>
        <h2 className="sf-card__title">{t(`vehicleFile.sections.${section}`)}</h2>
        {onAdd ? (
          <Button size="sm" onClick={onAdd}>
            {t(`vehicleFile.add.${section}`)}
          </Button>
        ) : null}
      </div>
      <DataTable caption={t(`vehicleFile.sections.${section}`)} columns={columns} rows={rows} rowKey={(r) => String(r.id)} minWidth={480} empty={<p className="k" style={{ margin: 0 }}>{t(`vehicleFile.notes.${section}`)}</p>} />
    </Card>
  )
}

const KINDS = ['fuel', 'repair', 'service', 'emi', 'insurance', 'tax', 'toll', 'parking', 'bata', 'loading', 'washing', 'tyre', 'accident', 'fine', 'other'] as const

function AddEvent({ vehicleId, initialKind, onClose }: { vehicleId: string; initialKind: string; onClose: () => void }) {
  const { t } = useTranslation()
  const m = useApiMutation<{ p: Record<string, unknown> }>('record_vehicle_event', LOGI_REFRESH)
  const [kind, setKind] = useState(initialKind)
  const [date, setDate] = useState(todayIst())
  const [km, setKm] = useState('')
  const [litres, setLitres] = useState('')
  const [amount, setAmount] = useState('')
  const [paidBy, setPaidBy] = useState('')
  const [note, setNote] = useState('')
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('vehicleFile.addTitle')}
      description={t('vehicleFile.addHelp')}
      submitLabel={t('common.save')}
      busy={m.isPending}
      onSubmit={() =>
        m.mutate(
          { p: { vehicle_id: vehicleId, kind, event_date: date, odometer_km: km || null, litres: kind === 'fuel' ? litres || null : null, amount: amount.replace(/[,\s]/g, '') || null, paid_by: paidBy.trim() || null, note: note.trim() || null } },
          { onSuccess: onClose },
        )
      }
      error={<LogisticsErrorBox error={m.error} />}
    >
      <FieldGrid>
        <SelectField label={t('vehicleFile.cols.kind')} value={kind} onChange={(e) => setKind(e.target.value)} options={KINDS.map((k) => ({ value: k, label: t(`vehicleFile.kinds.${k}`) }))} />
        <Field label={t('vehicleFile.cols.date')} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <Field label={t('vehicleFile.cols.km')} inputMode="numeric" value={km} onChange={(e) => setKm(e.target.value.replace(/\D/g, ''))} />
        {kind === 'fuel' ? <Field label={t('vehicleFile.cols.litres')} inputMode="decimal" value={litres} onChange={(e) => setLitres(e.target.value)} /> : null}
        <Field label={t('vehicleFile.cols.amount')} inputMode="decimal" prefix="₹" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <Field label={t('vehicleFile.cols.paidBy')} value={paidBy} onChange={(e) => setPaidBy(e.target.value)} />
      </FieldGrid>
      <TextAreaField label={t('vehicleFile.cols.note')} value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
    </FormDialog>
  )
}

function SetDoc({ vehicleId, kind, onClose }: { vehicleId: string; kind: string; onClose: () => void }) {
  const { t } = useTranslation()
  const m = useApiMutation<{ p: Record<string, unknown> }>('set_vehicle_document', LOGI_REFRESH)
  const [no, setNo] = useState('')
  const [validTo, setValidTo] = useState('')
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('vehicleFile.docTitle', { doc: t(`vehiclesDrivers.docKinds.${kind}`) })}
      description={t('vehicleFile.docHelp')}
      submitLabel={t('common.save')}
      busy={m.isPending}
      onSubmit={() => m.mutate({ p: { vehicle_id: vehicleId, kind, doc_no: no.trim() || null, valid_to: validTo || null } }, { onSuccess: onClose })}
      error={<LogisticsErrorBox error={m.error} />}
    >
      <Field label={t('vehicleFile.docNo')} value={no} onChange={(e) => setNo(e.target.value)} />
      {kind !== 'fastag' ? <Field label={t('vehicleFile.docValid')} type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} /> : null}
    </FormDialog>
  )
}

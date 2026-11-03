import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { rowsOf, useApiView } from '@/data/queries'
import { callApi, type RpcError } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { useCompanyChoice } from '@/features/admin/branches/company'
import { formatDate } from '@/shared/format'
import { Button, Card, Field, PageHeader, SelectField, Skeleton } from '@/ui'
import { DispatchStatus, LOGI_REFRESH, LogisticsErrorBox, useCompanyPeople, useLogisticsRights, usePlaces } from '../common/logistics'

const VEHICLE_KINDS = ['pickup', 'mini_truck', 'truck', 'trailer', 'crane_truck', 'van', 'two_wheeler', 'other'] as const
const DOC_KINDS = ['rc', 'insurance', 'fitness', 'permit', 'puc', 'road_tax'] as const

interface DocInput {
  doc_no: string
  valid_to: string
}

/**
 * Vehicles and drivers (`Vehicles`): company vehicles and hired transporters (api.upsert_vehicle) with their papers and
 * expiry dates (api.set_vehicle_document, history kept, the latest per kind counts). A vehicle with an expired paper
 * cannot be put on a trip — the database refuses it (Admin may override). Drivers are the people with the driver role.
 */
export function VehiclesDriversPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const rights = useLogisticsRights()
  const choice = useCompanyChoice()
  const companyId = choice.companyId
  const vehicles = useApiView('vehicles', { eq: { company_id: companyId }, order: 'reg_no', enabled: Boolean(companyId) })
  const people = useCompanyPeople(companyId)
  const drivers = people.filter((p) => (p.role_keys ?? []).includes('driver'))
  const places = usePlaces(companyId).filter((p) => p.kind === 'van' || p.kind === 'transit' || p.kind === 'stores')
  const regRef = useRef<HTMLInputElement>(null)
  const [reg, setReg] = useState('')
  const [kind, setKind] = useState('')
  const [ownership, setOwnership] = useState<'owned' | 'hired'>('owned')
  const [transporter, setTransporter] = useState('')
  const [payload, setPayload] = useState('')
  const [driver, setDriver] = useState('')
  const [placeId, setPlaceId] = useState('')
  const [docs, setDocs] = useState<Record<string, DocInput>>({})
  const [fastag, setFastag] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<RpcError | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  async function add() {
    if (!companyId) return
    setBusy(true)
    setError(null)
    setSaved(null)
    try {
      const v = await callApi<{ id: string }>('upsert_vehicle', {
        p: { company_id: companyId, reg_no: reg, kind, ownership, transporter: ownership === 'hired' ? transporter.trim() || null : null, payload_kg: payload.trim() || null, usual_driver_user_id: driver || null, place_id: placeId || null },
      })
      for (const k of DOC_KINDS) {
        const d = docs[k]
        if (d && (d.doc_no.trim() || d.valid_to)) await callApi('set_vehicle_document', { p: { vehicle_id: v.id, kind: k, doc_no: d.doc_no.trim() || null, valid_to: d.valid_to || null } })
      }
      if (fastag.trim()) await callApi('set_vehicle_document', { p: { vehicle_id: v.id, kind: 'fastag', doc_no: fastag.trim() } })
      setSaved(reg.toUpperCase().replace(/[^A-Z0-9]/g, ''))
      setReg('')
      setKind('')
      setPayload('')
      setTransporter('')
      setDocs({})
      setFastag('')
      await Promise.all(LOGI_REFRESH.map((k) => qc.invalidateQueries({ queryKey: k })))
    } catch (e) {
      setError(e as RpcError)
    } finally {
      setBusy(false)
    }
  }

  if (!rights.view) {
    return (
      <>
        <PageHeader title={t('vehiclesDrivers.title')} />
        <Card>
          <p className="k">{t('vehiclesDrivers.noRight')}</p>
        </Card>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title={t('vehiclesDrivers.title')}
        subtitle={t('vehiclesDrivers.subtitle')}
        actions={
          rights.create ? (
            <Button
              onClick={() => {
                setOwnership('hired')
                regRef.current?.focus()
              }}
            >
              {t('vehiclesDrivers.addTransporter')}
            </Button>
          ) : null
        }
      />
      <div style={{ marginBottom: 12 }}>
        <CompanyPicker list={choice.list} value={companyId} onChange={choice.choose} />
      </div>
      <div className="sf-grid-2" style={{ marginBottom: 16 }}>
        <Card title={t('vehiclesDrivers.vehicles')}>
          {vehicles.isLoading ? (
            <Skeleton height={60} />
          ) : rowsOf(vehicles).length === 0 ? (
            <p style={{ margin: 0 }}>{t('vehiclesDrivers.noVehicles')}</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {rowsOf(vehicles).map((v) => (
                <li key={v.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }} data-testid={`vehicle-${v.reg_no}`}>
                  <span>
                    <strong className="mono">{v.reg_no}</strong>
                    <br />
                    <span className="k">
                      {t(`vehiclesDrivers.kinds.${v.kind}`, { defaultValue: v.kind })} · {t(`vehiclesDrivers.own.${v.ownership}`)}
                      {v.transporter ? ` · ${v.transporter}` : ''}
                      {v.usual_driver_name ? ` · ${v.usual_driver_name}` : ''}
                    </span>
                  </span>
                  <span className="sf-row">
                    {v.has_expired_papers ? (
                      <span className="sf-chip" data-tone="danger">
                        {t('vehiclesDrivers.expired')}
                      </span>
                    ) : v.next_expiry ? (
                      <span className="sf-chip" data-tone="signal">
                        {t('vehiclesDrivers.nextExpiry', { date: formatDate(v.next_expiry) })}
                      </span>
                    ) : (
                      <span className="sf-chip" data-tone="neutral">
                        {t('vehiclesDrivers.noPapers')}
                      </span>
                    )}
                    <DispatchStatus status={v.status} />
                    <Link to={`/logistics/vehicle-file?company=${companyId}&vehicle=${v.id}`}>{t('vehiclesDrivers.file')}</Link>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={t('vehiclesDrivers.drivers')}>
          {drivers.length === 0 ? (
            <p style={{ margin: 0 }}>{t('vehiclesDrivers.noDrivers')}</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {drivers.map((d) => (
                <li key={d.user_id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <strong>{d.display_name}</strong>
                  <span className="sf-chip" data-tone="signal">
                    {t('vehiclesDrivers.licenceNotEntered')}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="k" style={{ margin: '10px 0 0' }}>
            {t('vehiclesDrivers.licenceNote')}
          </p>
        </Card>
      </div>
      {rights.create ? (
        <Card title={t('vehiclesDrivers.addVehicle')}>
          <div className="sf-grid-2">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <h3 className="k" style={{ margin: 0, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                {t('vehiclesDrivers.vehicle')}
              </h3>
              <Field ref={regRef} label={t('vehiclesDrivers.reg')} value={reg} onChange={(e) => setReg(e.target.value.toUpperCase())} placeholder="KL-08-XX-0000" className="mono" />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <SelectField label={t('vehiclesDrivers.kind')} value={kind} placeholder={t('vehiclesDrivers.choose')} onChange={(e) => setKind(e.target.value)} options={VEHICLE_KINDS.map((k) => ({ value: k, label: t(`vehiclesDrivers.kinds.${k}`) }))} />
                <SelectField
                  label={t('vehiclesDrivers.ownership')}
                  value={ownership}
                  onChange={(e) => setOwnership(e.target.value as 'owned' | 'hired')}
                  options={[
                    { value: 'owned', label: t('vehiclesDrivers.own.owned') },
                    { value: 'hired', label: t('vehiclesDrivers.own.hired') },
                  ]}
                />
                <Field label={t('vehiclesDrivers.payload')} inputMode="decimal" value={payload} onChange={(e) => setPayload(e.target.value)} />
                {ownership === 'hired' ? <Field label={t('vehiclesDrivers.transporter')} value={transporter} onChange={(e) => setTransporter(e.target.value)} /> : null}
              </div>
              <SelectField label={t('vehiclesDrivers.usualDriver')} value={driver} placeholder={drivers.length ? t('vehiclesDrivers.choose') : t('vehiclesDrivers.noDriverRole')} onChange={(e) => setDriver(e.target.value)} options={drivers.map((d) => ({ value: d.user_id, label: d.display_name }))} />
              <SelectField label={t('vehiclesDrivers.vanPlace')} value={placeId} placeholder={t('vehiclesDrivers.none')} onChange={(e) => setPlaceId(e.target.value)} options={places.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <h3 className="k" style={{ margin: 0, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                {t('vehiclesDrivers.docs')}
              </h3>
              {DOC_KINDS.map((k) => (
                <div key={k} style={{ display: 'grid', gridTemplateColumns: '1fr 170px', gap: 8 }}>
                  <Field label={t('vehiclesDrivers.docNo', { doc: t(`vehiclesDrivers.docKinds.${k}`) })} value={docs[k]?.doc_no ?? ''} onChange={(e) => setDocs({ ...docs, [k]: { doc_no: e.target.value, valid_to: docs[k]?.valid_to ?? '' } })} />
                  <Field label={t('vehiclesDrivers.validTo', { doc: t(`vehiclesDrivers.docKinds.${k}`) })} type="date" value={docs[k]?.valid_to ?? ''} onChange={(e) => setDocs({ ...docs, [k]: { doc_no: docs[k]?.doc_no ?? '', valid_to: e.target.value } })} />
                </div>
              ))}
              <Field label={t('vehiclesDrivers.fastag')} value={fastag} onChange={(e) => setFastag(e.target.value)} />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, borderTop: '1px solid var(--sf-line)', marginTop: 16, paddingTop: 12, flexWrap: 'wrap' }}>
            <span className="k">{t('vehiclesDrivers.uploadNote')}</span>
            <Button variant="primary" busy={busy} disabled={!reg.trim() || !kind} onClick={() => void add()}>
              {t('vehiclesDrivers.add')}
            </Button>
          </div>
          {saved ? (
            <p role="status" className="sf-alert" data-tone="success">
              {t('vehiclesDrivers.saved', { reg: saved })}
            </p>
          ) : null}
          <LogisticsErrorBox error={error} />
        </Card>
      ) : null}
    </>
  )
}

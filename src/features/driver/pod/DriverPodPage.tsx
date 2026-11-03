import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { callApi, RpcError } from '@/data/rpc'
import { readPosition } from '@/features/field/common/field'
import { supabase } from '@/shared/supabase'
import { formatDate, formatTime } from '@/shared/format'
import { Button, Field, SelectField, Skeleton, TextAreaField, useOnline } from '@/ui'
import { DRIVER_REFRESH, DriverErrorBox, DriverFrame, useDriverRights, useMyTrip, useTripRow } from '../common/driver'

const SHORT_REASONS = ['damaged', 'rejected', 'short_loaded', 'not_available', 'other'] as const
const QTY = /^\d+(\.\d{1,3})?$/

async function uploadPod(companyId: string, tripId: string, name: string, blob: Blob, contentType: string): Promise<string> {
  const path = `${companyId}/${tripId}/${name}`
  const { error } = await supabase.storage.from('pod').upload(path, blob, { upsert: false, contentType })
  if (error) throw error
  return path
}

/**
 * Proof of delivery (`DriverPOD`, /driver/pod?stop=…): quantity received per line (short goods need a reason and go back
 * to quarantine — server), receiver's name and phone (only the last 4 digits are kept), a signature drawn on the screen
 * and photos, uploaded to the private `pod` bucket under the company's folder, the time and (during the trip only) the
 * place. api.record_pod decides and records everything.
 */
export function DriverPodPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const online = useOnline()
  const rights = useDriverRights()
  const [params] = useSearchParams()
  const q = useMyTrip()
  const trip = q.data?.status === 'ready' ? q.data.data : null
  const stops = trip?.stops ?? []
  const wanted = params.get('stop')
  const stop = stops.find((s) => s.stop_id === wanted) ?? stops.find((s) => s.status === 'arrived') ?? stops.find((s) => s.status === 'pending')
  const tripRow = useTripRow(trip?.trip_id)
  const [delivered, setDelivered] = useState<Record<string, string>>({})
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [remarks, setRemarks] = useState('')
  const [photos, setPhotos] = useState<File[]>([])
  const [signed, setSigned] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<RpcError | null>(null)
  const [uploadErr, setUploadErr] = useState(false)
  const [done, setDone] = useState<{ status: string; short: boolean } | null>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const [now] = useState(() => new Date())

  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--sf-ink').trim() || 'black'
  }, [stop?.stop_id])

  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = canvas.current!
    const r = c.getBoundingClientRect()
    return { x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height }
  }
  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    const ctx = canvas.current?.getContext('2d')
    if (!ctx) return
    drawing.current = true
    canvas.current?.setPointerCapture(e.pointerId)
    const p = point(e)
    ctx.beginPath()
    ctx.moveTo(p.x, p.y)
  }
  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return
    const ctx = canvas.current?.getContext('2d')
    if (!ctx) return
    const p = point(e)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    setSigned(true)
  }
  function up() {
    drawing.current = false
  }
  function clear() {
    const c = canvas.current
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height)
    setSigned(false)
  }

  const lines = stop?.lines ?? []
  const badQty = lines.some((l) => {
    const v = (delivered[l.dispatch_line_id] ?? '').trim()
    return v !== '' && (!QTY.test(v) || Number(v) > Number(l.qty))
  })

  async function confirm() {
    if (!stop || !trip?.trip_id || !tripRow) return
    setBusy(true)
    setError(null)
    setUploadErr(false)
    try {
      let signaturePath: string | null = null
      const photoPaths: string[] = []
      try {
        if (signed && canvas.current) {
          const blob = await new Promise<Blob | null>((resolve) => canvas.current!.toBlob(resolve, 'image/png'))
          if (blob) signaturePath = await uploadPod(tripRow.company_id, trip.trip_id, `${stop.stop_id}-signature-${crypto.randomUUID()}.png`, blob, 'image/png')
        }
        for (const f of photos) {
          const ext = (f.name.split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
          photoPaths.push(await uploadPod(tripRow.company_id, trip.trip_id, `${stop.stop_id}-photo-${crypto.randomUUID()}.${ext}`, f, f.type || 'image/jpeg'))
        }
      } catch {
        setUploadErr(true)
        return
      }
      // The place is read only during the started trip; the server keeps it only on the driver's open trip window.
      const pos = trip.status === 'started' ? await readPosition(8_000) : null
      const res = await callApi<{ status: string; short: boolean }>('record_pod', {
        p_stop_id: stop.stop_id,
        p: {
          received_by_name: name.trim(),
          receiver_phone: phone.trim() || null,
          signature_path: signaturePath,
          photo_paths: photoPaths,
          lat: pos?.lat ?? null,
          lng: pos?.lng ?? null,
          device_at: new Date().toISOString(),
          remarks: remarks.trim() || null,
          lines: lines.map((l) => {
            const v = (delivered[l.dispatch_line_id] ?? '').trim()
            const qty = v === '' ? l.qty : v
            return { dispatch_line_id: l.dispatch_line_id, qty_delivered: qty, short_reason: Number(qty) < Number(l.qty) ? (reasons[l.dispatch_line_id] ?? null) : null }
          }),
        },
      })
      setDone(res)
      await Promise.all(DRIVER_REFRESH.map((k) => qc.invalidateQueries({ queryKey: k })))
    } catch (e) {
      setError(e instanceof RpcError ? e : null)
      if (!(e instanceof RpcError)) setUploadErr(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <DriverFrame title={t('driverPod.title')} sub={stop ? `${stop.customer} · ${stop.dispatch_no ?? ''}` : undefined} back="/driver/trip">
      {q.isLoading ? (
        <Skeleton height={240} />
      ) : !rights.drive ? (
        <div className="sf-phone-note" role="status">
          <strong>{t('driverCommon.noRightTitle')}</strong>
          <br />
          {t('driverCommon.noRight')}
        </div>
      ) : done ? (
        <div role="status" className="sf-alert" data-tone={done.short ? 'signal' : 'success'} style={{ margin: 0, flexDirection: 'column', alignItems: 'flex-start' }} data-testid="pod-done">
          <strong>{done.short ? t('driverPod.doneShort') : t('driverPod.done')}</strong>
          <Link to="/driver/trip">{t('driverPod.back')}</Link>
        </div>
      ) : !stop || trip?.status !== 'started' ? (
        <div className="sf-phone-note" role="status">
          {trip?.status === 'planned' ? t('driverPod.notStarted') : t('driverPod.noStop')} <Link to="/driver/trip">{t('driverPod.back')}</Link>
        </div>
      ) : (
        <>
          <section className="sf-phone-card" aria-labelledby="pod-qty">
            <h2 id="pod-qty">{t('driverPod.qty')}</h2>
            {lines.map((l) => {
              const v = (delivered[l.dispatch_line_id] ?? '').trim()
              const short = v !== '' && QTY.test(v) && Number(v) < Number(l.qty)
              return (
                <div key={l.dispatch_line_id} style={{ display: 'flex', flexDirection: 'column', gap: 8, borderBottom: '1px solid var(--sf-line)', paddingBottom: 12 }}>
                  <span style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <strong>{l.product}</strong>
                    <span className="k">{t('driverPod.sent', { qty: l.qty, uom: l.uom ?? '' })}</span>
                  </span>
                  <Field label={t('driverPod.received', { name: l.product })} inputMode="decimal" placeholder={String(l.qty)} value={delivered[l.dispatch_line_id] ?? ''} onChange={(e) => setDelivered({ ...delivered, [l.dispatch_line_id]: e.target.value })} />
                  {short ? (
                    <div className="sf-alert" data-tone="signal" style={{ margin: 0, flexDirection: 'column', alignItems: 'stretch' }}>
                      <SelectField
                        label={t('driverPod.reason')}
                        value={reasons[l.dispatch_line_id] ?? ''}
                        placeholder={t('driverPod.choose')}
                        onChange={(e) => setReasons({ ...reasons, [l.dispatch_line_id]: e.target.value })}
                        options={SHORT_REASONS.map((r) => ({ value: r, label: t(`driverPod.reasons.${r}`) }))}
                      />
                      <span className="k">{t('driverPod.shortNote')}</span>
                    </div>
                  ) : (
                    <span className="k" style={{ color: 'var(--sf-success-ink)' }}>
                      {v === '' || Number(v) === Number(l.qty) ? t('driverPod.full') : null}
                    </span>
                  )}
                </div>
              )
            })}
            {badQty ? (
              <p role="alert" className="sf-alert" data-tone="danger" style={{ margin: 0 }}>
                {t('driverPod.badQty')}
              </p>
            ) : null}
          </section>
          <section className="sf-phone-card" aria-labelledby="pod-who">
            <h2 id="pod-who">{t('driverPod.receivedBy')}</h2>
            <Field label={t('driverPod.name')} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
            <Field label={t('driverPod.phone')} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^\d]/g, '').slice(0, 10))} help={t('driverPod.phoneHelp')} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="sf-field__label" id="sig-label">
                {t('driverPod.signature')}
              </span>
              <Button variant="link" size="sm" onClick={clear}>
                {t('driverPod.clear')}
              </Button>
            </div>
            <canvas
              ref={canvas}
              width={640}
              height={240}
              role="img"
              aria-labelledby="sig-label"
              data-testid="signature"
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={up}
              onPointerLeave={up}
              style={{ width: '100%', height: 140, border: '1px dashed var(--sf-border-input)', borderRadius: 12, background: 'var(--sf-surface)', touchAction: 'none' }}
            />
            <span className="k">{signed ? t('driverPod.signed') : t('driverPod.signHint')}</span>
          </section>
          <section className="sf-phone-card" aria-labelledby="pod-photos">
            <h2 id="pod-photos">{t('driverPod.photos')}</h2>
            <label className="sf-field">
              <span className="sf-field__label">{t('driverPod.addPhoto')}</span>
              <input type="file" accept="image/*" capture="environment" multiple className="sf-input" data-testid="pod-photo" onChange={(e) => setPhotos(Array.from(e.target.files ?? []))} />
            </label>
            {photos.length > 0 ? <span className="k">{t('driverPod.photoCount', { count: photos.length })}</span> : null}
            <TextAreaField label={t('driverPod.remarks')} value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} />
          </section>
          <p className="k" style={{ margin: 0, textAlign: 'center' }}>
            {formatDate(now)} · {formatTime(now)} · {t('driverPod.auto')}
          </p>
          <Button variant="primary" size="hero" busy={busy} disabled={!online || badQty || !tripRow || name.trim().length < 2} onClick={() => void confirm()}>
            {t('driverPod.confirm')}
          </Button>
          {uploadErr ? (
            <p role="alert" className="sf-alert" data-tone="danger" style={{ margin: 0 }}>
              {t('driverPod.uploadFailed')}
            </p>
          ) : null}
          <DriverErrorBox error={error} />
        </>
      )}
    </DriverFrame>
  )
}

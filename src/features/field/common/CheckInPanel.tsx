import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RpcError } from '@/data/rpc'
import { Button, TextAreaField } from '@/ui'
import { FieldErrorBox, readPosition, sendOrQueue, useFieldRefresh } from './field'

export interface CheckInResult {
  visit_id: string
  geofence_ok: boolean
  distance_m: number | string | null
  radius_m: number | string
  approval: 'none' | 'pending'
}

/** What the server decided at check-in (kept by the page, so it stays after the visit card replaces the button). */
export function CheckInResultNote({ result }: { result: CheckInResult | null }) {
  const { t } = useTranslation()
  if (!result) return null
  return (
    <p role="status" className="sf-alert" data-tone={result.geofence_ok ? 'success' : 'signal'} style={{ margin: 0 }} data-testid="checkin-result" data-geofence={result.geofence_ok ? 'ok' : 'pending'}>
      {result.geofence_ok
        ? t('fieldCommon.checkIn.ok', { distance: Math.round(Number(result.distance_m ?? 0)), radius: Math.round(Number(result.radius_m)) })
        : result.distance_m === null
          ? t('fieldCommon.checkIn.noPin')
          : t('fieldCommon.checkIn.pending', { distance: Math.round(Number(result.distance_m)), radius: Math.round(Number(result.radius_m)) })}
    </p>
  )
}

/**
 * Check in at a shop. The phone sends its location; the database measures the distance to the shop's saved pin
 * (field.geofence_m, 150 m by default). Inside → accepted. Outside or no pin → refused until a reason is given, then the
 * visit is recorded as an exception for the sales manager's OK. The screen only reports what the server decided.
 */
export function CheckInPanel({ companyId, partyId, beatId, planned, label, onResult }: { companyId: string; partyId: string; beatId?: string | null; planned: boolean; label?: string; onResult: (r: CheckInResult) => void }) {
  const { t } = useTranslation()
  const refresh = useFieldRefresh()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<RpcError | null>(null)
  const [needReason, setNeedReason] = useState(false)
  const [reason, setReason] = useState('')
  const [unplannedReason, setUnplannedReason] = useState('')
  const [noFix, setNoFix] = useState(false)
  const [queued, setQueued] = useState(false)

  async function go(withReason: boolean) {
    setBusy(true)
    setError(null)
    setNoFix(false)
    try {
      const pos = await readPosition()
      if (!pos) {
        setNoFix(true)
        return
      }
      const out = await sendOrQueue<CheckInResult>(
        'check_in_visit',
        {
          p: {
            company_id: companyId,
            party_id: partyId,
            lat: pos.lat,
            lng: pos.lng,
            at: pos.at,
            beat_id: beatId ?? null,
            planned,
            unplanned_reason: planned ? null : unplannedReason.trim(),
            reason: withReason ? reason.trim() : null,
          },
        },
        'checkIn',
      )
      if (out.queued) setQueued(true)
      else {
        setNeedReason(false)
        onResult(out.result)
      }
      await refresh()
    } catch (e) {
      const err = e as RpcError
      setError(err)
      if (err.rule === 'visit.out_of_fence') setNeedReason(true)
    } finally {
      setBusy(false)
    }
  }

  if (queued) {
    return (
      <p role="status" className="sf-alert" data-tone="signal" style={{ margin: 0 }}>
        {t('fieldCommon.checkIn.queued')}
      </p>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {!planned ? <TextAreaField label={t('fieldCommon.checkIn.unplannedReason')} value={unplannedReason} onChange={(e) => setUnplannedReason(e.target.value)} rows={2} /> : null}
      {needReason ? (
        <TextAreaField label={t('fieldCommon.checkIn.reason')} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
      ) : null}
      <Button variant="primary" size="hero" busy={busy} disabled={needReason && reason.trim().length < 3} onClick={() => void go(needReason)}>
        {needReason ? t('fieldCommon.checkIn.withReason') : (label ?? t('fieldCommon.checkIn.button'))}
      </Button>
      {noFix ? (
        <p role="alert" className="sf-alert" data-tone="danger" style={{ margin: 0 }}>
          {t('fieldCommon.checkIn.noFix')}
        </p>
      ) : null}
      <FieldErrorBox error={error} />
    </div>
  )
}

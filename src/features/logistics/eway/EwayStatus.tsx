import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { rowsOf, useApiView } from '@/data/queries'
import { RpcError, callApi } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { formatDate, formatTime } from '@/shared/format'
import { Button, Chip, ErrorRef, Field, FormDialog } from '@/ui'

function EwayErrorBox({ error }: { error: RpcError | null }) {
  const { t } = useTranslation()
  if (!error) return null
  if (error.rule) {
    const key = `eway.rules.${error.rule}`
    const msg = t(key)
    if (msg !== key) return <ErrorRef message={msg} next={t('errors.nextStep')} refId={error.ref} />
  }
  return <RpcErrorBox error={error} />
}

/**
 * E-way bill status of one dispatch (api.dispatch_compliance): the e-way bill from the API (valid until, vehicle), the
 * request in flight or given up, and whether the invoice still waits for its IRN. "Get e-way bill" queues
 * api.request_eway_bill (the server checks the invoice is final and the dispatch has not left); Admin may complete a
 * queued request with the mock provider on DEV.
 */
export function EwayStatus({ dispatchId, planned, canEdit, hasInvoice, isAdmin }: { dispatchId: string; planned: boolean; canEdit: boolean; hasInvoice: boolean; isAdmin: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const q = useApiView('dispatch_compliance', { eq: { dispatch_id: dispatchId } })
  const c = rowsOf(q)[0]
  const [open, setOpen] = useState(false)
  const [vehicle, setVehicle] = useState('')
  const [km, setKm] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<RpcError | null>(null)

  async function run(key: string, fn: string, args: Record<string, unknown>) {
    setBusy(key)
    setError(null)
    try {
      await callApi(fn, args)
      setOpen(false)
      await qc.invalidateQueries({ queryKey: ['api', 'dispatch_compliance'] })
      await qc.invalidateQueries({ queryKey: ['api', 'dispatches'] })
    } catch (e) {
      setError(e instanceof RpcError ? e : null)
    } finally {
      setBusy(null)
    }
  }

  if (!c) return null
  const active = c.eway_status === 'active'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid={`eway-${c.doc_no}`}>
      <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {c.eway_bill_id ? (
          <Chip tone={active ? 'success' : 'danger'}>{active ? t('eway.active') : t('eway.cancelled')}</Chip>
        ) : null}
        {c.eway_is_mock ? <Chip tone="danger">{t('eway.mock')}</Chip> : null}
        {c.eway_request_status && c.eway_request_status !== 'done' ? (
          <Chip tone={c.eway_request_status === 'dead' ? 'danger' : 'info'}>{t(`eway.req.${c.eway_request_status}`, { defaultValue: c.eway_request_status })}</Chip>
        ) : null}
        {c.irn_missing ? <Chip tone="signal" icon="alert">{t('eway.irnMissing')}</Chip> : null}
      </span>
      {active && c.eway_valid_until ? (
        <span className="k">{t('eway.validUntil', { when: `${formatDate(c.eway_valid_until)} ${formatTime(c.eway_valid_until)}`, vehicle: c.eway_vehicle_no ?? '—' })}</span>
      ) : null}
      {c.eway_request_error && c.eway_request_status !== 'done' ? <span className="k">{t('eway.lastError', { error: c.eway_request_error })}</span> : null}
      {planned && canEdit && hasInvoice ? (
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {!c.eway_bill_no && (!c.eway_request_status || c.eway_request_status === 'dead' || c.eway_request_status === 'cancelled') ? (
            <Button size="sm" onClick={() => setOpen(true)}>{t('eway.request')}</Button>
          ) : null}
          {isAdmin && c.eway_request_id && c.eway_request_status === 'queued' ? (
            <Button size="sm" busy={busy === 'mock'} onClick={() => run('mock', 'run_mock_integration', { p_request_id: c.eway_request_id, p: {} })}>{t('eway.runMock')}</Button>
          ) : null}
        </span>
      ) : null}
      {!open ? <EwayErrorBox error={error} /> : null}
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={t('eway.title', { doc: c.doc_no })}
        description={t('eway.help')}
        submitLabel={t('eway.submit')}
        busy={busy === 'request'}
        onSubmit={() => run('request', 'request_eway_bill', { p_dispatch_id: dispatchId, p: { vehicle_no: vehicle, distance_km: km || null, transport_mode: 'road' } })}
        error={<EwayErrorBox error={error} />}
      >
        <Field label={t('eway.vehicle')} value={vehicle} onChange={(e) => setVehicle(e.target.value)} autoFocus />
        <Field label={t('eway.distance')} inputMode="numeric" value={km} onChange={(e) => setKm(e.target.value.replace(/[^0-9]/g, ''))} />
      </FormDialog>
    </div>
  )
}

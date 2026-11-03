import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { useApiRpc } from '@/data/queries'
import { RpcError, callApi } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { formatDate, formatTime } from '@/shared/format'
import { Button, Card, Chip, ErrorRef, Field, SelectField, Skeleton } from '@/ui'
import { IrnQr } from './IrnQr'

export interface FinalStatus {
  found: boolean
  document_id?: string
  status?: string
  einvoice_required?: boolean
  final?: boolean
  irn?: { irn?: string; ack_no?: string; ack_date?: string; signed_qr?: string; status?: string; is_mock?: boolean; cancelled_at?: string }
  request?: { id: string; status: string; attempts: number; next_attempt_at: string; last_error: string | null } | null
}

/** Is the document final (posted, and with its IRN when e-invoicing applies)? From api.document_final_status. */
export function useFinalStatus(documentId: string | null | undefined) {
  return useApiRpc<FinalStatus>('document_final_status', { p_document_id: documentId }, Boolean(documentId))
}

/** Our own texts for the Phase 8 rule codes first, then the shared ones. */
export function EinvoiceErrorBox({ error }: { error: RpcError | null | undefined }) {
  const { t } = useTranslation()
  if (!error) return null
  if (error.rule) {
    const key = `einvoice.rules.${error.rule}`
    const msg = t(key)
    if (msg !== key) return <ErrorRef message={msg} next={t('errors.nextStep')} refId={error.ref} />
  }
  return <RpcErrorBox error={error} />
}

/** The IRN block printed on the invoice (IRN, acknowledgement and the QR). */
export function IrnPrintBlock({ irn }: { irn: NonNullable<FinalStatus['irn']> }) {
  const { t } = useTranslation()
  if (!irn.irn || irn.status !== 'active') return null
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      {irn.signed_qr ? <IrnQr value={irn.signed_qr} size={96} label={t('einvoice.qrLabel')} /> : null}
      <div style={{ fontSize: 10, wordBreak: 'break-all' }}>
        <div>
          <strong>{t('einvoice.irn')}:</strong> <span className="mono">{irn.irn}</span>
        </div>
        <div>
          <strong>{t('einvoice.ackNo')}:</strong> <span className="mono">{irn.ack_no}</span> · {irn.ack_date ? `${formatDate(irn.ack_date)} ${formatTime(irn.ack_date)}` : ''}
        </div>
        {irn.is_mock ? <div style={{ color: 'var(--sf-danger)', fontWeight: 700 }}>{t('einvoice.mockWarning')}</div> : null}
      </div>
    </div>
  )
}

const REASONS = ['duplicate', 'data_entry_mistake', 'order_cancelled', 'other'] as const

/**
 * E-invoice status of one posted sales document: not needed / IRN pending (ask for it; retries and failures shown) /
 * IRN with QR (cancel within the IRP window). Every decision is the server's (api.request_einvoice, api.cancel_einvoice);
 * "Run with mock provider" (Admin, DEV only) completes a queued request through api.run_mock_integration.
 */
export function EinvoicePanel({ documentId, canCreate, canCancel, isAdmin }: { documentId: string; canCreate: boolean; canCancel: boolean; isAdmin: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const q = useFinalStatus(documentId)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<RpcError | null>(null)
  const [reason, setReason] = useState('')
  const [remark, setRemark] = useState('')
  const [askCancel, setAskCancel] = useState(false)
  const titleId = useId()

  async function run(key: string, fn: string, args: Record<string, unknown>) {
    setBusy(key)
    setError(null)
    try {
      await callApi(fn, args)
      setAskCancel(false)
      await qc.invalidateQueries({ queryKey: ['api', 'document_final_status'] })
      await qc.invalidateQueries({ queryKey: ['api', 'msg_outbox'] })
    } catch (e) {
      setError(e instanceof RpcError ? e : null)
    } finally {
      setBusy(null)
    }
  }

  const s = q.data?.status === 'ready' ? q.data.data : undefined
  let body
  if (q.isLoading || !s) body = <Skeleton height={40} />
  else if (!s.found || s.status !== 'posted') body = <p className="muted" style={{ margin: 0 }}>{t('einvoice.notPosted')}</p>
  else if (!s.einvoice_required) body = <Chip tone="neutral">{t('einvoice.notRequired')}</Chip>
  else if (s.irn?.status === 'active') {
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Chip tone="success" icon="check">{t('einvoice.final')}</Chip>
          {s.irn.is_mock ? <Chip tone="danger">{t('einvoice.mock')}</Chip> : null}
        </span>
        <IrnPrintBlock irn={s.irn} />
        {canCancel && !askCancel ? (
          <div>
            <Button size="sm" variant="danger" onClick={() => setAskCancel(true)}>{t('einvoice.cancel')}</Button>
          </div>
        ) : null}
        {askCancel ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 420 }}>
            <SelectField label={t('einvoice.cancelReason')} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('einvoice.choose')}
              options={REASONS.map((r) => ({ value: r, label: t(`einvoice.reasons.${r}`) }))} />
            <Field label={t('einvoice.cancelRemark')} value={remark} onChange={(e) => setRemark(e.target.value)} maxLength={100} />
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>{t('einvoice.cancelWindowNote')}</p>
            <span style={{ display: 'flex', gap: 8 }}>
              <Button size="sm" onClick={() => setAskCancel(false)}>{t('einvoice.back')}</Button>
              <Button size="sm" variant="danger" busy={busy === 'cancel'}
                onClick={() => run('cancel', 'cancel_einvoice', { p_document_id: documentId, p_reason: reason || null, p_remark: remark })}>
                {t('einvoice.cancelConfirm')}
              </Button>
            </span>
          </div>
        ) : null}
      </div>
    )
  } else {
    const r = s.request
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Chip tone="signal" icon="alert">{t('einvoice.pending')}</Chip>
          {r ? <Chip tone={r.status === 'dead' ? 'danger' : 'info'}>{t(`einvoice.req.${r.status}`, { defaultValue: r.status })}</Chip> : null}
          {r && r.attempts > 0 ? <span className="muted" style={{ fontSize: 12.5 }}>{t('einvoice.attempts', { n: r.attempts })}</span> : null}
        </span>
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>{s.irn?.status === 'cancelled' ? t('einvoice.cancelledNote') : t('einvoice.pendingNote')}</p>
        {r?.last_error ? <p style={{ margin: 0, fontSize: 12.5 }}>{t('einvoice.lastError', { error: r.last_error })}</p> : null}
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {canCreate && s.irn?.status !== 'cancelled' && (!r || r.status === 'dead' || r.status === 'cancelled') ? (
            <Button size="sm" variant="primary" busy={busy === 'request'} onClick={() => run('request', 'request_einvoice', { p_document_id: documentId })}>
              {t('einvoice.request')}
            </Button>
          ) : null}
          {isAdmin && r && r.status === 'queued' ? (
            <Button size="sm" busy={busy === 'mock'} onClick={() => run('mock', 'run_mock_integration', { p_request_id: r.id, p: {} })}>{t('einvoice.runMock')}</Button>
          ) : null}
        </span>
      </div>
    )
  }

  return (
    <Card title={t('einvoice.title')} labelledBy={titleId}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {body}
        <EinvoiceErrorBox error={error} />
      </div>
    </Card>
  )
}

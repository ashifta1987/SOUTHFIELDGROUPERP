import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView } from '@/data/queries'
import { Chip, Skeleton } from '@/ui'
import { formatDate, formatTime } from '@/shared/format'

const TONE: Record<string, 'info' | 'success' | 'signal' | 'danger' | 'neutral'> = {
  queued: 'info',
  sending: 'info',
  sent: 'success',
  delivered: 'success',
  read: 'success',
  skipped: 'signal',
  failed: 'danger',
  cancelled: 'neutral',
}

/**
 * WhatsApp messages queued for one document (api.msg_outbox). Numbers arrive masked. Sending needs the owner's
 * WhatsApp Business account and the whatsapp-sender Edge Function, which are not live yet — rows stay "queued".
 */
export function WhatsAppStatus({ docId, docTable = 'sales.documents' }: { docId: string | null | undefined; docTable?: string }) {
  const { t } = useTranslation()
  const q = useApiView('msg_outbox', { eq: { doc_id: docId ?? '', doc_type: docTable }, order: 'created_at', ascending: false, enabled: Boolean(docId) })
  const rows = rowsOf(q)
  if (!docId) return <p className="muted" style={{ margin: 0 }}>{t('invoice.wa.notYet')}</p>
  if (q.isLoading) return <Skeleton height={40} />
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>{t('invoice.wa.none')}</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((m) => (
            <li key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Chip tone={TONE[m.status] ?? 'neutral'}>{t(`invoice.wa.status.${m.status}`, { defaultValue: m.status })}</Chip>
                <span className="mono">{m.to_masked ?? t('invoice.wa.noNumber')}</span>
                <span className="muted">{m.template_name}</span>
              </span>
              <span className="muted" style={{ fontSize: 12.5 }}>
                {formatDate(m.created_at)} {formatTime(m.created_at)}
                {m.skip_reason ? ` · ${m.skip_reason}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>{t('invoice.wa.senderNote')}</p>
    </div>
  )
}

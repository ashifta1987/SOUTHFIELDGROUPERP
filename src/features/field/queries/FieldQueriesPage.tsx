import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView } from '@/data/queries'
import { formatDate } from '@/shared/format'
import { Skeleton } from '@/ui'
import { FieldFrame, FieldGate, useFieldCompany, useFieldRights, useMyDay } from '../common/field'

/** Days after which an open query counts as overdue on the inbox (display ordering only; the office owns the reply). */
const OVERDUE_DAYS = 3

/** Queries inbox (§15A.5): open queries across the salesman's customers (RLS), overdue first, then oldest first. */
export function FieldQueriesPage() {
  const { t } = useTranslation()
  const rights = useFieldRights()
  const { companyId, company, isLoading } = useFieldCompany()
  const day = useMyDay(companyId)
  const q = useApiView('queries', { eq: { company_id: companyId }, order: 'created_at', ascending: true, limit: 200, enabled: Boolean(companyId) })
  const open = rowsOf(q).filter((r) => r.status !== 'closed')
  const sorted = [...open.filter((r) => Number(r.age_days ?? 0) > OVERDUE_DAYS), ...open.filter((r) => Number(r.age_days ?? 0) <= OVERDUE_DAYS)]
  const onDuty = day.data?.status === 'ready' ? Boolean(day.data.data?.on_duty) : undefined
  return (
    <FieldFrame title={t('fieldQueries.title')} sub={company?.short_name ?? company?.name} onDuty={onDuty}>
      <FieldGate loading={isLoading} companyId={companyId} sell={rights.sell}>
        {q.isLoading ? (
          <Skeleton height={80} />
        ) : sorted.length === 0 ? (
          <div className="sf-phone-note">{t('fieldQueries.none')}</div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sorted.map((r) => (
              <li key={r.id}>
                <Link to={`/field/customers/${r.party_id}?tab=queries`} className="sf-phone-line" style={{ color: 'var(--sf-text)', textDecoration: 'none', flexDirection: 'column', alignItems: 'flex-start' }}>
                  <span style={{ display: 'flex', justifyContent: 'space-between', width: '100%', gap: 8 }}>
                    <strong>{r.party_name}</strong>
                    {Number(r.age_days ?? 0) > OVERDUE_DAYS ? (
                      <span className="sf-chip" data-tone="danger">
                        {t('fieldQueries.overdue', { count: Number(r.age_days) })}
                      </span>
                    ) : (
                      <span className="sf-chip" data-tone="signal">
                        {t(`fieldQueries.status.${r.status}`, { defaultValue: r.status })}
                      </span>
                    )}
                  </span>
                  <span>{r.description}</span>
                  <span className="k">
                    {formatDate(r.created_at)}
                    {r.next_step ? ` · ${t('fieldQueries.next', { step: r.next_step })}` : ''}
                    {r.reply ? ` · ${t('fieldQueries.replied')}` : ''}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </FieldGate>
    </FieldFrame>
  )
}

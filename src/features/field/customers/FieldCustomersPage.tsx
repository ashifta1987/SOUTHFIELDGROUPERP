import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { formatDate } from '@/shared/format'
import { Amount, Field, Skeleton } from '@/ui'
import { FieldFrame, FieldGate, useFieldCompany, useFieldRights, useMyCustomers, useMyDay } from '../common/field'

/** The salesman's own customers (api.my_customers: only the shops assigned to him) with flags; search is on the phone. */
export function FieldCustomersPage() {
  const { t } = useTranslation()
  const rights = useFieldRights()
  const { companyId, company, isLoading } = useFieldCompany()
  const day = useMyDay(companyId)
  const customers = useMyCustomers(companyId)
  const [q, setQ] = useState('')
  const rows = customers.data?.status === 'ready' ? (customers.data.data ?? []) : []
  const needle = q.trim().toLowerCase()
  const shown = needle ? rows.filter((r) => `${r.name} ${r.trade_name ?? ''} ${r.gstin ?? ''}`.toLowerCase().includes(needle)) : rows
  const onDuty = day.data?.status === 'ready' ? Boolean(day.data.data?.on_duty) : undefined

  return (
    <FieldFrame title={t('fieldCustomers.title')} sub={company?.short_name ?? company?.name} onDuty={onDuty}>
      <FieldGate loading={isLoading} companyId={companyId} sell={rights.sell}>
        <Field label={t('fieldCustomers.search')} type="search" value={q} onChange={(e) => setQ(e.target.value)} />
        {customers.isLoading ? (
          <Skeleton height={80} />
        ) : rows.length === 0 ? (
          <div className="sf-phone-note">{t('fieldCustomers.none')}</div>
        ) : shown.length === 0 ? (
          <div className="sf-phone-note">{t('fieldCustomers.noMatch')}</div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {shown.map((c) => (
              <li key={c.party_id}>
                <Link to={`/field/customers/${c.party_id}`} className="sf-phone-line" style={{ color: 'var(--sf-text)', textDecoration: 'none', flexDirection: 'column', alignItems: 'flex-start' }}>
                  <strong>{c.name}</strong>
                  <span className="k">
                    {c.trade_name ? `${c.trade_name} · ` : ''}
                    {c.last_order ? t('fieldCustomers.lastOrder', { date: formatDate(c.last_order) }) : t('fieldCustomers.noOrder')}
                  </span>
                  <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {Number(c.overdue_gst) > 0 ? (
                      <span className="sf-chip" data-tone="danger">
                        {t('fieldCustomers.overdue')} <Amount value={c.overdue_gst} rupee />
                      </span>
                    ) : null}
                    {c.open_queries > 0 ? (
                      <span className="sf-chip" data-tone="signal">
                        {t('fieldCustomers.queries', { count: c.open_queries })}
                      </span>
                    ) : null}
                    {c.credit_status === 'hold' ? (
                      <span className="sf-chip" data-tone="danger">
                        {t('fieldCustomers.creditHold')}
                      </span>
                    ) : null}
                    {c.kyc_status !== 'verified' ? (
                      <span className="sf-chip" data-tone="signal">
                        {t('fieldCustomers.kyc')}
                      </span>
                    ) : null}
                    {!c.pin ? (
                      <span className="sf-chip" data-tone="neutral">
                        {t('fieldCustomers.noPin')}
                      </span>
                    ) : null}
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

import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthProvider'
import { rowsOf, useApiView } from '@/data/queries'
import { formatDate, formatTime } from '@/shared/format'
import { Amount, Skeleton } from '@/ui'
import { FieldFrame, FieldGate, Line, useFieldCompany, useFieldRights, useMyDay } from '../common/field'

/** My day (§15A.7): visits against plan, orders, collections and cash with me (api.my_day), today's collections, past day ends. */
export function FieldMyDayPage() {
  const { t } = useTranslation()
  const { session } = useAuth()
  const me = session?.user.id
  const rights = useFieldRights()
  const { companyId, company, isLoading } = useFieldCompany()
  const day = useMyDay(companyId)
  const d = day.data?.status === 'ready' ? day.data.data : null
  const coll = useApiView('field_collections', { eq: { company_id: companyId, salesman_user_id: me }, order: 'collected_at', ascending: false, limit: 20, enabled: Boolean(companyId && me) })
  const closes = useApiView('day_closes', { eq: { company_id: companyId, user_id: me }, order: 'close_date', ascending: false, limit: 7, enabled: Boolean(companyId && me) })
  return (
    <FieldFrame title={t('fieldMyDay.title')} sub={company?.short_name ?? company?.name} onDuty={d ? d.on_duty : undefined}>
      <FieldGate loading={isLoading || day.isLoading} companyId={companyId} sell={rights.sell}>
        {d ? (
          <section className="sf-phone-card" aria-labelledby="md-today">
            <h2 id="md-today">{t('fieldMyDay.today', { date: formatDate(d.date) })}</h2>
            <div>
              <Line label={t('fieldMyDay.visits')} value={t('fieldMyDay.ofN', { done: d.visits_done, n: d.visits_planned })} />
              <Line label={t('fieldMyDay.orders')} value={<Amount value={d.orders_total} rupee />} />
              <Line label={t('fieldMyDay.collections')} value={<Amount value={d.collections_total} rupee />} />
              <Line label={t('fieldMyDay.cash')} value={<Amount value={d.cash_with_me} rupee />} />
              <Line label={t('fieldMyDay.cheques')} value={String(d.cheques_with_me)} />
              <Line label={t('fieldMyDay.target')} value={t('fieldMyDay.targetToSet')} />
            </div>
          </section>
        ) : null}
        <section className="sf-phone-section" aria-labelledby="md-coll">
          <h2 id="md-coll">{t('fieldMyDay.recent')}</h2>
          {coll.isLoading ? (
            <Skeleton height={40} />
          ) : rowsOf(coll).length === 0 ? (
            <div className="sf-phone-note">{t('fieldMyDay.noCollections')}</div>
          ) : (
            rowsOf(coll).map((c) => (
              <div key={c.id} className="sf-phone-line" style={{ justifyContent: 'space-between' }}>
                <span>
                  <strong>{c.party_name}</strong>
                  <br />
                  <span className="k">
                    <span className="mono">{c.receipt_no}</span> · {t(`fieldMyDay.modes.${c.mode}`, { defaultValue: c.mode })} · {formatTime(c.collected_at)}
                    {c.mode === 'cash' && !c.handover_id ? ` · ${t('fieldMyDay.withMe')}` : ''}
                  </span>
                </span>
                <Amount value={c.amount} rupee />
              </div>
            ))
          )}
        </section>
        <section className="sf-phone-section" aria-labelledby="md-closes">
          <h2 id="md-closes">{t('fieldMyDay.closes')}</h2>
          {rowsOf(closes).length === 0 ? (
            <div className="sf-phone-note">{t('fieldMyDay.noCloses')}</div>
          ) : (
            rowsOf(closes).map((c) => (
              <div key={c.id} className="sf-phone-line" style={{ justifyContent: 'space-between' }}>
                <span>
                  {formatDate(c.close_date)} · {t('fieldMyDay.ofN', { done: c.visits_done, n: c.visits_planned })}
                </span>
                <Amount value={c.collections_total} rupee />
              </div>
            ))
          )}
        </section>
        {d?.on_duty ? (
          <Link to="/field/end-day" className="sf-btn" data-size="touch" style={{ justifyContent: 'center' }}>
            {t('fieldMyDay.endDay')}
          </Link>
        ) : null}
      </FieldGate>
    </FieldFrame>
  )
}

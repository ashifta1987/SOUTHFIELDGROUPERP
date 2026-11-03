import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthProvider'
import { rowsOf, useApiView } from '@/data/queries'
import { callApi, type RpcError } from '@/data/rpc'
import { formatDate, formatTime } from '@/shared/format'
import { Amount, Button, Field } from '@/ui'
import { FieldErrorBox, FieldFrame, FieldGate, Line, useFieldCompany, useFieldQueue, useFieldRefresh, useFieldRights, useMyDay } from '../common/field'

const DENOMINATIONS = ['500', '200', '100', '50', '20', '10', '5', '2', '1'] as const

interface HandoverResult {
  id: string
  expected: number | string
  counted: number | string
  difference: number | string
}
interface DayEnd {
  id: string
  visits_planned: number
  visits_done: number
  orders_total: number | string
  collections_total: number | string
}

/**
 * End day (§15A.8): count the cash by denomination and hand it over (api.cash_handover: expected comes from the server,
 * the difference is shown), the cashier confirms on their own login; cheques handed over; then api.end_salesman_day,
 * which refuses while anything is unsynced on this phone, a visit is open, cash is not handed over or the cashier has not
 * confirmed. Ending the day closes the duty session, so location stops.
 */
export function FieldEndDayPage() {
  const { t } = useTranslation()
  const { session } = useAuth()
  const me = session?.user.id
  const rights = useFieldRights()
  const refresh = useFieldRefresh()
  const queue = useFieldQueue()
  const { companyId, company, isLoading } = useFieldCompany()
  const day = useMyDay(companyId)
  const d = day.data?.status === 'ready' ? day.data.data : null
  const handovers = useApiView('cash_handovers', { eq: { company_id: companyId, salesman_user_id: me }, order: 'created_at', ascending: false, limit: 5, enabled: Boolean(companyId && me) })
  const latest = rowsOf(handovers)[0]
  const [counts, setCounts] = useState<Record<string, string>>({})
  const [cheques, setCheques] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<RpcError | null>(null)
  const [handed, setHanded] = useState<HandoverResult | null>(null)
  const [ending, setEnding] = useState(false)
  const [endError, setEndError] = useState<RpcError | null>(null)
  const [ended, setEnded] = useState<DayEnd | null>(null)
  const badCount = Object.values(counts).some((v) => v.trim() !== '' && !/^\d+$/.test(v.trim()))

  async function handover() {
    if (!companyId) return
    setBusy(true)
    setError(null)
    try {
      const denominations: Record<string, number> = {}
      for (const k of DENOMINATIONS) {
        const v = (counts[k] ?? '').trim()
        if (v && Number(v) > 0) denominations[k] = Number(v)
      }
      // Handover needs the server (expected cash, cashier's count): not queued offline.
      const res = await callApi<HandoverResult>('cash_handover', { p: { company_id: companyId, denominations, cheques: cheques.trim() ? Number(cheques) : 0 } })
      setHanded(res)
      setCounts({})
      await refresh()
    } catch (e) {
      setError(e as RpcError)
    } finally {
      setBusy(false)
    }
  }

  async function endDay() {
    if (!companyId) return
    setEnding(true)
    setEndError(null)
    try {
      const res = await callApi<DayEnd>('end_salesman_day', { p: { company_id: companyId, unsynced: queue.count, van_counts: [] } })
      setEnded(res)
      await refresh()
    } catch (e) {
      setEndError(e as RpcError)
    } finally {
      setEnding(false)
    }
  }

  return (
    <FieldFrame title={t('fieldEndDay.title')} sub={company?.short_name ?? company?.name} back="/field/today" onDuty={d ? d.on_duty : undefined}>
      <FieldGate loading={isLoading || day.isLoading} companyId={companyId} sell={rights.sell}>
        {d ? (
          <section className="sf-phone-card" aria-labelledby="ed-with">
            <h2 id="ed-with">{t('fieldEndDay.withMe')}</h2>
            <div>
              <Line label={t('fieldEndDay.cash')} value={<Amount value={d.cash_with_me} rupee />} testId="end-cash" />
              <Line label={t('fieldEndDay.cheques')} value={String(d.cheques_with_me)} />
              <Line label={t('fieldEndDay.unsynced')} value={String(queue.count)} />
            </div>
          </section>
        ) : null}
        {latest ? (
          <section className="sf-phone-card" aria-labelledby="ed-last" data-testid="handover-status" data-status={latest.status}>
            <h2 id="ed-last">{t('fieldEndDay.last', { date: formatDate(latest.handover_date) })}</h2>
            <div>
              <Line label={t('fieldEndDay.expected')} value={<Amount value={latest.expected_cash} rupee />} />
              <Line label={t('fieldEndDay.myCount')} value={<Amount value={latest.salesman_total} rupee />} />
              <Line label={t('fieldEndDay.cashierCount')} value={latest.cashier_total === null ? t('fieldEndDay.notYet') : <Amount value={latest.cashier_total} rupee />} />
              <Line label={t('fieldEndDay.status')} value={t(`fieldEndDay.statuses.${latest.status}`, { defaultValue: latest.status })} />
            </div>
            {latest.status === 'pending' ? <p className="k" style={{ margin: 0 }}>{t('fieldEndDay.waitCashier')}</p> : null}
            {latest.status === 'mismatch' ? (
              <p className="sf-alert" data-tone="danger" style={{ margin: 0 }}>
                {t('fieldEndDay.mismatch')}
              </p>
            ) : null}
            {latest.confirmed_at ? <span className="k">{t('fieldEndDay.confirmedAt', { time: formatTime(latest.confirmed_at), name: latest.cashier_name ?? '' })}</span> : null}
          </section>
        ) : null}
        <section className="sf-phone-card" aria-labelledby="ed-count">
          <h2 id="ed-count">{t('fieldEndDay.count')}</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            {DENOMINATIONS.map((k) => (
              <Field key={k} label={t('fieldEndDay.note', { value: k })} inputMode="numeric" value={counts[k] ?? ''} onChange={(e) => setCounts({ ...counts, [k]: e.target.value })} />
            ))}
          </div>
          <Field label={t('fieldEndDay.chequesHanded')} inputMode="numeric" value={cheques} onChange={(e) => setCheques(e.target.value)} />
          {badCount ? (
            <p role="alert" className="sf-alert" data-tone="danger" style={{ margin: 0 }}>
              {t('fieldEndDay.badCount')}
            </p>
          ) : null}
          <Button size="touch" variant="primary" busy={busy} disabled={badCount} onClick={() => void handover()}>
            {t('fieldEndDay.handover')}
          </Button>
          {handed ? (
            <div role="status" className="sf-alert" data-tone={Number(handed.difference) === 0 ? 'success' : 'signal'} style={{ margin: 0, flexDirection: 'column', alignItems: 'flex-start' }} data-testid="handover-result">
              <span>
                {t('fieldEndDay.expected')} <Amount value={handed.expected} rupee /> · {t('fieldEndDay.myCount')} <Amount value={handed.counted} rupee />
              </span>
              <strong>{Number(handed.difference) === 0 ? t('fieldEndDay.matches') : <>{t('fieldEndDay.difference')} <Amount value={handed.difference} rupee /></>}</strong>
              <span>{t('fieldEndDay.nowCashier')}</span>
            </div>
          ) : null}
          <FieldErrorBox error={error} />
        </section>
        <section className="sf-phone-card" aria-labelledby="ed-end">
          <h2 id="ed-end">{t('fieldEndDay.end')}</h2>
          <p style={{ margin: 0 }}>{t('fieldEndDay.endNote')}</p>
          <Button size="hero" variant="primary" busy={ending} onClick={() => void endDay()}>
            {t('fieldEndDay.endButton')}
          </Button>
          {ended ? (
            <div role="status" className="sf-alert" data-tone="success" style={{ margin: 0, flexDirection: 'column', alignItems: 'flex-start' }} data-testid="day-ended">
              <strong>{t('fieldEndDay.ended')}</strong>
              <span>
                {t('fieldEndDay.summary', { done: ended.visits_done, n: ended.visits_planned })} · <Amount value={ended.orders_total} rupee /> · <Amount value={ended.collections_total} rupee />
              </span>
            </div>
          ) : null}
          <FieldErrorBox error={endError} />
        </section>
      </FieldGate>
    </FieldFrame>
  )
}

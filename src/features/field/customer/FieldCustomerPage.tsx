import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiRpc, useApiView } from '@/data/queries'
import type { RpcError } from '@/data/rpc'
import { formatDate, formatTime } from '@/shared/format'
import { Amount, Button, Field, SelectField, Skeleton, Tabs, TextAreaField } from '@/ui'
import { AccountSummary, PromiseForm, StatementButton } from '../common/account'
import { CheckInPanel, CheckInResultNote, type CheckInResult } from '../common/CheckInPanel'
import { FieldErrorBox, FieldFrame, FieldGate, Line, readPosition, sendOrQueue, uploadFieldPhoto, useFieldCompany, useFieldRefresh, useFieldRights, useMyCustomers, useMyDay, useMyRoute, useOpenVisit } from '../common/field'

type Tab = 'account' | 'queries' | 'reference' | 'visit'

export interface CustomerPriceList {
  price_list_id: string | null
  name: string | null
  tax_inclusive: boolean | null
  items: { product_id: string; code: string; name: string; uom: string | null; min_qty: number | string; price: number | string; rate: number | string | null; mrp: number | string | null }[]
}

/**
 * Customer page in the salesman app (/field/customers/:id), four tabs (§15A.2): Account (server figures, GST bills only
 * for the salesman under Q-12), Queries (open queries + new query), Reference (price list, last orders, contact, pin),
 * Visit (check-in with the server's geofence result, then shelf notes, outcome and check-out).
 */
export function FieldCustomerPage() {
  const { t } = useTranslation()
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const tab = (['account', 'queries', 'reference', 'visit'].includes(params.get('tab') ?? '') ? params.get('tab') : 'account') as Tab
  const rights = useFieldRights()
  const { companyId, isLoading } = useFieldCompany()
  const day = useMyDay(companyId)
  const customers = useMyCustomers(companyId)
  const row = (customers.data?.status === 'ready' ? (customers.data.data ?? []) : []).find((c) => c.party_id === id)
  const onDuty = day.data?.status === 'ready' ? Boolean(day.data.data?.on_duty) : undefined

  return (
    <FieldFrame title={row?.name ?? t('fieldCustomer.title')} sub={row?.trade_name ?? undefined} back="/field/customers" onDuty={onDuty}>
      <FieldGate loading={isLoading || customers.isLoading} companyId={companyId} sell={rights.sell}>
        {!row ? (
          <div className="sf-phone-note" role="status">
            {t('fieldCustomer.notMine')}
          </div>
        ) : companyId ? (
          <>
            <Tabs
              label={t('fieldCustomer.tabs')}
              idBase="cust"
              controls="cust-panel"
              value={tab}
              onChange={(k) => setParams({ tab: k }, { replace: true })}
              tabs={[
                { key: 'account', label: t('fieldCustomer.tab.account') },
                { key: 'queries', label: t('fieldCustomer.tab.queries') },
                { key: 'reference', label: t('fieldCustomer.tab.reference') },
                { key: 'visit', label: t('fieldCustomer.tab.visit') },
              ]}
            />
            <div id="cust-panel" role="tabpanel" aria-labelledby={`cust-tab-${tab}`} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {tab === 'account' ? <AccountTab companyId={companyId} partyId={id} /> : null}
              {tab === 'queries' ? <QueriesTab companyId={companyId} partyId={id} /> : null}
              {tab === 'reference' ? <ReferenceTab companyId={companyId} partyId={id} gstin={row.gstin} kyc={row.kyc_status} phone={row.phone_masked} pin={row.pin} /> : null}
              {tab === 'visit' ? <VisitTab companyId={companyId} partyId={id} onDuty={Boolean(onDuty)} /> : null}
            </div>
          </>
        ) : null}
      </FieldGate>
    </FieldFrame>
  )
}

function AccountTab({ companyId, partyId }: { companyId: string; partyId: string }) {
  const { t } = useTranslation()
  return (
    <>
      <AccountSummary companyId={companyId} partyId={partyId} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Link to={`/field/customers/${partyId}/collect`} className="sf-btn" data-variant="primary" data-size="touch" style={{ justifyContent: 'center' }}>
          {t('fieldCustomer.collect')}
        </Link>
        <Link to={`/field/customers/${partyId}/order`} className="sf-btn" data-size="touch" style={{ justifyContent: 'center' }}>
          {t('fieldCustomer.order')}
        </Link>
      </div>
      <StatementButton companyId={companyId} partyId={partyId} />
      <PromiseForm companyId={companyId} partyId={partyId} />
    </>
  )
}

const QUERY_KINDS = ['product_complaint', 'billing', 'delivery', 'price_scheme', 'return', 'other'] as const

function QueriesTab({ companyId, partyId }: { companyId: string; partyId: string }) {
  const { t } = useTranslation()
  const refresh = useFieldRefresh()
  const q = useApiView('queries', { eq: { company_id: companyId, party_id: partyId }, order: 'created_at', ascending: false, limit: 50 })
  const rows = rowsOf(q)
  const [kind, setKind] = useState<string>('billing')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<RpcError | null>(null)
  const [done, setDone] = useState<'sent' | 'queued' | null>(null)
  async function save() {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const out = await sendOrQueue('log_query', { p: { company_id: companyId, party_id: partyId, kind, description: description.trim() } }, 'query')
      setDone(out.queued ? 'queued' : 'sent')
      setDescription('')
      await refresh()
    } catch (e) {
      setError(e as RpcError)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <section className="sf-phone-section" aria-labelledby="q-open">
        <h2 id="q-open">{t('fieldCustomer.queries.title')}</h2>
        {q.isLoading ? (
          <Skeleton height={60} />
        ) : rows.length === 0 ? (
          <div className="sf-phone-note">{t('fieldCustomer.queries.none')}</div>
        ) : (
          rows.map((r) => (
            <div key={r.id} className="sf-phone-card" style={{ gap: 6 }}>
              <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <strong>{t(`fieldCustomer.kinds.${r.kind}`, { defaultValue: r.kind })}</strong>
                <span className="sf-chip" data-tone={r.status === 'closed' ? 'success' : r.status === 'open' ? 'signal' : 'info'}>
                  {t(`fieldCustomer.qstatus.${r.status}`, { defaultValue: r.status })}
                </span>
              </span>
              <span>{r.description}</span>
              <span className="k">
                {formatDate(r.created_at)} · {r.raised_by_name ?? ''}
                {r.next_step ? ` · ${t('fieldCustomer.queries.next', { step: r.next_step })}` : ''}
              </span>
              {r.reply ? <span className="sf-alert" data-tone="info">{t('fieldCustomer.queries.reply', { reply: r.reply })}</span> : null}
            </div>
          ))
        )}
      </section>
      <section className="sf-phone-card" aria-labelledby="q-new">
        <h2 id="q-new">{t('fieldCustomer.queries.new')}</h2>
        <SelectField label={t('fieldCustomer.queries.kind')} value={kind} onChange={(e) => setKind(e.target.value)} options={QUERY_KINDS.map((k) => ({ value: k, label: t(`fieldCustomer.kinds.${k}`) }))} />
        <TextAreaField label={t('fieldCustomer.queries.description')} value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        <Button size="touch" variant="primary" busy={busy} disabled={description.trim().length < 3} onClick={() => void save()}>
          {t('fieldCustomer.queries.save')}
        </Button>
        {done ? (
          <p role="status" className="sf-alert" data-tone={done === 'sent' ? 'success' : 'signal'} style={{ margin: 0 }}>
            {done === 'sent' ? t('fieldCustomer.queries.done') : t('fieldCommon.queued')}
          </p>
        ) : null}
        <FieldErrorBox error={error} />
      </section>
    </>
  )
}

function ReferenceTab({ companyId, partyId, gstin, kyc, phone, pin }: { companyId: string; partyId: string; gstin: string | null; kyc: string; phone: string | null; pin: { lat: number; lng: number } | null }) {
  const { t } = useTranslation()
  const pl = useApiRpc<CustomerPriceList>('customer_price_list', { p_company_id: companyId, p_party_id: partyId })
  const orders = useApiView('sales_orders', { eq: { company_id: companyId, party_id: partyId }, order: 'created_at', ascending: false, limit: 5 })
  const list = pl.data?.status === 'ready' ? pl.data.data : null
  return (
    <>
      <section className="sf-phone-card" aria-labelledby="ref-contact">
        <h2 id="ref-contact">{t('fieldCustomer.ref.contact')}</h2>
        <div>
          <Line label={t('fieldCustomer.ref.gstin')} value={gstin ?? t('fieldCustomer.ref.unregistered')} />
          <Line label={t('fieldCustomer.ref.kyc')} value={t(`fieldCustomer.ref.kycStatus.${kyc}`, { defaultValue: kyc })} />
          <Line label={t('fieldCustomer.ref.phone')} value={phone ?? '—'} />
          <Line label={t('fieldCustomer.ref.pin')} value={pin ? `${Number(pin.lat).toFixed(5)}, ${Number(pin.lng).toFixed(5)}` : t('fieldCustomer.ref.noPin')} />
        </div>
      </section>
      <section className="sf-phone-card" aria-labelledby="ref-pl">
        <h2 id="ref-pl">{list?.name ? t('fieldCustomer.ref.priceListNamed', { name: list.name }) : t('fieldCustomer.ref.priceList')}</h2>
        {pl.isLoading ? (
          <Skeleton height={40} />
        ) : !list?.price_list_id ? (
          <p className="k" style={{ margin: 0 }}>
            {t('fieldCustomer.ref.noPriceList')}
          </p>
        ) : (
          <div>
            {list.items.map((i) => (
              <Line
                key={i.product_id}
                label={
                  <span>
                    {i.name}
                    <br />
                    <span className="k">
                      {i.code}
                      {i.mrp !== null ? ` · ${t('fieldCustomer.ref.mrp')} ` : ''}
                      {i.mrp !== null ? <Amount value={i.mrp} rupee /> : null}
                    </span>
                  </span>
                }
                value={<Amount value={i.rate} rupee />}
              />
            ))}
            <p className="k" style={{ margin: '6px 0 0' }}>
              {t('fieldCustomer.ref.rateNote')}
            </p>
          </div>
        )}
      </section>
      <section className="sf-phone-card" aria-labelledby="ref-orders">
        <h2 id="ref-orders">{t('fieldCustomer.ref.lastOrders')}</h2>
        {orders.isLoading ? (
          <Skeleton height={40} />
        ) : rowsOf(orders).length === 0 ? (
          <p className="k" style={{ margin: 0 }}>
            {t('fieldCustomer.ref.noOrders')}
          </p>
        ) : (
          <div>
            {rowsOf(orders).map((o) => (
              <Line key={o.id} label={<span><span className="mono">{o.doc_no}</span> · {formatDate(o.order_date)} · {t(`fieldCustomer.orderStatus.${o.status}`, { defaultValue: o.status })}</span>} value={<Amount value={o.total} rupee />} />
            ))}
          </div>
        )}
      </section>
    </>
  )
}

const OUTCOMES = ['order', 'no_order', 'collection', 'follow_up'] as const

function VisitTab({ companyId, partyId, onDuty }: { companyId: string; partyId: string; onDuty: boolean }) {
  const { t } = useTranslation()
  const refresh = useFieldRefresh()
  const { open, visits } = useOpenVisit(companyId)
  const route = useMyRoute(companyId)
  const onRoute = (route.data?.status === 'ready' ? (route.data.data ?? []) : []).find((r) => r.party_id === partyId)
  const here = open && open.party_id === partyId ? open : null
  const past = visits.filter((v) => v.party_id === partyId && v.check_out_at).slice(0, 3)
  const [outcome, setOutcome] = useState<string>('order')
  const [noOrderReason, setNoOrderReason] = useState('')
  const [shelf, setShelf] = useState('')
  const [competitor, setCompetitor] = useState('')
  const [nextVisit, setNextVisit] = useState('')
  const [photo, setPhoto] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<RpcError | null>(null)
  const [uploadErr, setUploadErr] = useState(false)
  const [done, setDone] = useState<'sent' | 'queued' | null>(null)
  const [checkin, setCheckin] = useState<CheckInResult | null>(null)

  async function checkOut() {
    if (!here) return
    setBusy(true)
    setError(null)
    setUploadErr(false)
    try {
      let paths: string[] = []
      if (photo) {
        try {
          paths = [await uploadFieldPhoto(companyId, 'shelf', photo)]
        } catch {
          setUploadErr(true)
          return
        }
      }
      const pos = await readPosition(8_000)
      const out = await sendOrQueue(
        'check_out_visit',
        {
          p_visit_id: here.id,
          p: {
            lat: pos?.lat ?? null,
            lng: pos?.lng ?? null,
            at: new Date().toISOString(),
            outcome,
            no_order_reason: outcome === 'no_order' ? noOrderReason.trim() : null,
            shelf: shelf.trim() ? { notes: shelf.trim() } : null,
            competitor_notes: competitor.trim() || null,
            photo_paths: paths,
            next_visit_on: nextVisit || null,
          },
        },
        'checkOut',
      )
      setDone(out.queued ? 'queued' : 'sent')
      await refresh()
    } catch (e) {
      setError(e as RpcError)
    } finally {
      setBusy(false)
    }
  }

  if (!onDuty)
    return (
      <div className="sf-phone-note" role="status">
        {t('fieldCustomer.visit.offDuty')} <Link to="/field/today">{t('fieldCustomer.visit.toToday')}</Link>
      </div>
    )
  return (
    <>
      <CheckInResultNote result={checkin} />
      {done ? (
        <p role="status" className="sf-alert" data-tone={done === 'sent' ? 'success' : 'signal'} style={{ margin: 0 }}>
          {done === 'sent' ? t('fieldCustomer.visit.checkedOut') : t('fieldCommon.queued')}
        </p>
      ) : null}
      {here ? (
        <section className="sf-phone-card" aria-labelledby="visit-now">
          <h2 id="visit-now">{t('fieldCustomer.visit.now')}</h2>
          <span>
            {t('fieldCustomer.visit.checkedIn', { time: formatTime(here.check_in_at) })}
            {here.distance_m !== null ? ` · ${t('fieldCustomer.visit.distance', { m: Math.round(Number(here.distance_m)) })}` : ''}
          </span>
          {here.approval === 'pending' ? (
            <span className="sf-chip" data-tone="signal">
              {t('fieldCustomer.visit.pending')}
            </span>
          ) : here.approval === 'approved' ? (
            <span className="sf-chip" data-tone="success">
              {t('fieldCustomer.visit.approved')}
            </span>
          ) : here.approval === 'refused' ? (
            <span className="sf-chip" data-tone="danger">
              {t('fieldCustomer.visit.refused')}
            </span>
          ) : null}
          <TextAreaField label={t('fieldCustomer.visit.shelf')} value={shelf} onChange={(e) => setShelf(e.target.value)} rows={2} />
          <TextAreaField label={t('fieldCustomer.visit.competitor')} value={competitor} onChange={(e) => setCompetitor(e.target.value)} rows={2} />
          <label className="sf-field">
            <span className="sf-field__label">{t('fieldCustomer.visit.photo')}</span>
            <input type="file" accept="image/*" capture="environment" className="sf-input" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
          </label>
          <SelectField label={t('fieldCustomer.visit.outcome')} value={outcome} onChange={(e) => setOutcome(e.target.value)} options={OUTCOMES.map((o) => ({ value: o, label: t(`fieldCustomer.visit.outcomes.${o}`) }))} />
          {outcome === 'no_order' ? <TextAreaField label={t('fieldCustomer.visit.noOrderReason')} value={noOrderReason} onChange={(e) => setNoOrderReason(e.target.value)} rows={2} /> : null}
          <Field label={t('fieldCustomer.visit.nextVisit')} type="date" value={nextVisit} onChange={(e) => setNextVisit(e.target.value)} />
          <Button size="hero" variant="primary" busy={busy} onClick={() => void checkOut()}>
            {t('fieldCustomer.visit.checkOut')}
          </Button>
          {uploadErr ? (
            <p role="alert" className="sf-alert" data-tone="danger" style={{ margin: 0 }}>
              {t('fieldCustomer.visit.uploadFailed')}
            </p>
          ) : null}
          <FieldErrorBox error={error} />
        </section>
      ) : open ? (
        <div className="sf-phone-note" role="status">
          {t('fieldCustomer.visit.elsewhere', { name: open.party_name ?? '' })}
        </div>
      ) : (
        <section className="sf-phone-card" aria-labelledby="visit-in">
          <h2 id="visit-in">{t('fieldCustomer.visit.checkInTitle')}</h2>
          <CheckInPanel companyId={companyId} partyId={partyId} beatId={onRoute?.beat_id ?? null} planned={Boolean(onRoute)} onResult={setCheckin} />
        </section>
      )}
      {past.length > 0 ? (
        <section className="sf-phone-section" aria-labelledby="visit-past">
          <h2 id="visit-past">{t('fieldCustomer.visit.past')}</h2>
          {past.map((v) => (
            <div key={v.id} className="sf-phone-line" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
              <span>
                {formatDate(v.check_in_at)} · {t(`fieldCustomer.visit.outcomes.${v.outcome ?? 'follow_up'}`, { defaultValue: v.outcome ?? '' })}
              </span>
              {v.competitor_notes ? <span className="k">{v.competitor_notes}</span> : null}
              {v.no_order_reason ? <span className="k">{v.no_order_reason}</span> : null}
            </div>
          ))}
        </section>
      ) : null}
    </>
  )
}

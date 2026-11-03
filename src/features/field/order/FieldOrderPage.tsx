import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApiRpc } from '@/data/queries'
import type { RpcError } from '@/data/rpc'
import { formatDate } from '@/shared/format'
import { Amount, Button, Field, SelectField, Skeleton } from '@/ui'
import type { CustomerPriceList } from '../customer/FieldCustomerPage'
import { FieldErrorBox, FieldFrame, FieldGate, Line, sendOrQueue, todayIstIso, useFieldCompany, useFieldRefresh, useFieldRights, useMyCustomers, useMyDay } from '../common/field'

interface Exposure {
  limit: number | string
  credit_status: string
  receivables: number | string
  open_orders: number | string
  exposure: number | string
  available: number | string
  blocked: boolean
  hidden_items: boolean
}
interface OrderResult {
  id: string
  doc_no: string
  status: 'confirmed' | 'pending_credit' | 'pending_approval'
  totals: { taxable: number | string; cgst: number | string; sgst: number | string; igst: number | string; total: number | string }
  credit: Exposure | null
}

const QTY = /^\d+(\.\d{1,3})?$/

/**
 * Take order (§15A.3): items from the customer's price list only (the salesman never types a price; the server applies
 * the list rate, refuses discounts above authority and prices above MRP), quantities, payment and delivery date. GST and
 * totals come back from the server; a credit order over the limit goes to `pending_credit` for approval. Offline the
 * order is kept on the phone with its request id and the phone's time, and confirmed when it is sent.
 */
export function FieldOrderPage() {
  const { t } = useTranslation()
  const { id = '' } = useParams()
  const rights = useFieldRights()
  const refresh = useFieldRefresh()
  const { companyId, isLoading } = useFieldCompany()
  const day = useMyDay(companyId)
  const customers = useMyCustomers(companyId)
  const row = (customers.data?.status === 'ready' ? (customers.data.data ?? []) : []).find((c) => c.party_id === id)
  const pl = useApiRpc<CustomerPriceList>('customer_price_list', { p_company_id: companyId, p_party_id: id }, Boolean(companyId && id))
  const exp = useApiRpc<Exposure>('check_credit_exposure', { p_company_id: companyId, p_party_id: id, p_extra: 0 }, Boolean(companyId && id))
  const list = pl.data?.status === 'ready' ? pl.data.data : null
  const exposure = exp.data?.status === 'ready' ? exp.data.data : null
  const [qty, setQty] = useState<Record<string, string>>({})
  const [payment, setPayment] = useState<'credit' | 'cash' | 'advance'>(row?.kyc_status === 'verified' ? 'credit' : 'cash')
  const [delivery, setDelivery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<RpcError | null>(null)
  const [result, setResult] = useState<OrderResult | null>(null)
  const [queued, setQueued] = useState(false)
  const onDuty = day.data?.status === 'ready' ? Boolean(day.data.data?.on_duty) : undefined

  const lines = (list?.items ?? []).filter((i) => QTY.test((qty[i.product_id] ?? '').trim()) && Number(qty[i.product_id]) > 0).map((i) => ({ product_id: i.product_id, qty: (qty[i.product_id] ?? '').trim() }))
  const badQty = Object.values(qty).some((v) => v.trim() !== '' && !QTY.test(v.trim()))

  async function confirm() {
    if (!companyId) return
    setBusy(true)
    setError(null)
    setResult(null)
    setQueued(false)
    try {
      const out = await sendOrQueue<OrderResult>(
        'confirm_sales_order',
        {
          p_header: { company_id: companyId, party_id: id, order_date: todayIstIso(), delivery_date: delivery || null, channel: 'field', payment, device_created_at: new Date().toISOString() },
          p_lines: lines,
        },
        'order',
      )
      if (out.queued) setQueued(true)
      else setResult(out.result)
      setQty({})
      await refresh()
    } catch (e) {
      setError(e as RpcError)
    } finally {
      setBusy(false)
    }
  }

  return (
    <FieldFrame title={t('fieldOrder.title')} sub={row?.name} back={`/field/customers/${id}`} onDuty={onDuty}>
      <FieldGate loading={isLoading || customers.isLoading} companyId={companyId} sell={rights.sell}>
        {!row ? (
          <div className="sf-phone-note" role="status">
            {t('fieldOrder.notMine')}
          </div>
        ) : (
          <>
            <section className="sf-phone-card" aria-labelledby="credit-head">
              <h2 id="credit-head">{t('fieldOrder.credit')}</h2>
              {exp.isLoading ? (
                <Skeleton height={40} />
              ) : exposure ? (
                <div>
                  <Line label={t('fieldOrder.limit')} value={<Amount value={exposure.limit} rupee />} />
                  <Line label={t('fieldOrder.exposure')} value={<Amount value={exposure.exposure} rupee />} />
                  <Line label={t('fieldOrder.available')} value={<Amount value={exposure.available} rupee />} />
                  {exposure.blocked ? (
                    <p className="sf-alert" data-tone="signal" style={{ margin: '8px 0 0' }}>
                      {t('fieldOrder.blocked')}
                    </p>
                  ) : null}
                  {exposure.hidden_items ? (
                    <p className="k" style={{ margin: '6px 0 0' }}>
                      {t('fieldOrder.hiddenItems')}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="k" style={{ margin: 0 }}>
                  {t('fieldOrder.noCredit')}
                </p>
              )}
            </section>
            <section className="sf-phone-card" aria-labelledby="items-head">
              <h2 id="items-head">{list?.name ? t('fieldOrder.itemsFrom', { name: list.name }) : t('fieldOrder.items')}</h2>
              {pl.isLoading ? (
                <Skeleton height={80} />
              ) : !list?.price_list_id ? (
                <p className="sf-alert" data-tone="signal" style={{ margin: 0 }}>
                  {t('fieldOrder.noPriceList')}
                </p>
              ) : list.items.length === 0 ? (
                <p className="k" style={{ margin: 0 }}>
                  {t('fieldOrder.emptyList')}
                </p>
              ) : (
                list.items.map((i) => (
                  <div key={i.product_id} style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 10, alignItems: 'end', borderBottom: '1px solid var(--sf-line)', paddingBottom: 10 }}>
                    <span>
                      <strong>{i.name}</strong>
                      <br />
                      <span className="k">
                        {t('fieldOrder.rate')} <Amount value={i.rate} rupee /> / {i.uom ?? ''}
                        {i.mrp !== null ? (
                          <>
                            {' · '}
                            {t('fieldOrder.mrp')} <Amount value={i.mrp} rupee />
                          </>
                        ) : null}
                      </span>
                    </span>
                    <Field label={t('fieldOrder.qtyOf', { name: i.name })} inputMode="decimal" value={qty[i.product_id] ?? ''} onChange={(e) => setQty({ ...qty, [i.product_id]: e.target.value })} />
                  </div>
                ))
              )}
            </section>
            <section className="sf-phone-card" aria-labelledby="terms-head">
              <h2 id="terms-head">{t('fieldOrder.terms')}</h2>
              <SelectField
                label={t('fieldOrder.payment')}
                value={payment}
                onChange={(e) => setPayment(e.target.value as 'credit' | 'cash' | 'advance')}
                options={[
                  { value: 'credit', label: t('fieldOrder.pay.credit') },
                  { value: 'cash', label: t('fieldOrder.pay.cash') },
                  { value: 'advance', label: t('fieldOrder.pay.advance') },
                ]}
              />
              <Field label={t('fieldOrder.delivery')} type="date" value={delivery} min={todayIstIso()} onChange={(e) => setDelivery(e.target.value)} />
              {badQty ? (
                <p className="sf-alert" data-tone="danger" role="alert" style={{ margin: 0 }}>
                  {t('fieldOrder.badQty')}
                </p>
              ) : null}
              <Button variant="primary" size="hero" busy={busy} disabled={lines.length === 0 || badQty} onClick={() => void confirm()}>
                {t('fieldOrder.confirm', { count: lines.length })}
              </Button>
              <p className="k" style={{ margin: 0 }}>
                {t('fieldOrder.serverNote')}
              </p>
            </section>
            {result ? (
              <section role="status" className="sf-alert" data-tone={result.status === 'confirmed' ? 'success' : 'signal'} style={{ margin: 0, flexDirection: 'column', alignItems: 'flex-start' }} data-testid="order-result" data-status={result.status}>
                <strong>
                  {t(`fieldOrder.result.${result.status}`, { doc: result.doc_no })}
                </strong>
                <span>
                  {t('fieldOrder.total')} <Amount value={result.totals.total} rupee /> ({t('fieldOrder.taxable')} <Amount value={result.totals.taxable} rupee />)
                </span>
                {result.status === 'pending_credit' && result.credit ? (
                  <span>
                    {t('fieldOrder.overBy')} <Amount value={result.credit.available} rupee />
                  </span>
                ) : null}
                <span className="k">{delivery ? t('fieldOrder.deliveryOn', { date: formatDate(delivery) }) : null}</span>
                <Link to={`/field/customers/${id}?tab=visit`}>{t('fieldOrder.backToVisit')}</Link>
              </section>
            ) : null}
            {queued ? (
              <p role="status" className="sf-alert" data-tone="signal" style={{ margin: 0 }}>
                {t('fieldOrder.queued')}
              </p>
            ) : null}
            <FieldErrorBox error={error} />
          </>
        )}
      </FieldGate>
    </FieldFrame>
  )
}

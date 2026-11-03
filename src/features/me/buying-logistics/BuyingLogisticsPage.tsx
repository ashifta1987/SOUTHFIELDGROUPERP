import { Link, useOutletContext } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { useCompanyChoice } from '@/features/admin/branches/company'
import { useReadRpc } from '@/features/accounts/cash-book/money'
import { PurchaseErrorBox } from '@/features/purchase/common/purchase'
import { initials } from '@/shared/format'
import { OfflineBadge, PhoneHeader, SelectField, Skeleton } from '@/ui'
import type { PhoneOutletContext } from '@/ui/shell/StaffShell'

interface Home {
  requests_waiting: number
  requests_approved: number
  orders_draft: number
  orders_open: number
  orders_late: number
  receipts_today: number
  lots_in_quarantine: number
  bill_photos_to_review: number
  transfers_in_transit: number
  transfers_to_carry: number
  msme_overdue: number
  msme_due_soon: number
  price_increases_this_month: number
  below_reorder: number
  tasks: { id: string; severity: 'high' | 'medium' | 'low'; title: string; href: string }[]
}

/**
 * Buying, logistics and petty cash home on the phone (`RafeeqHome`): counts from api.buying_logistics_home (RLS decides
 * what the person sees) — requests to buy, bills to confirm, goods received and waiting for a test, transfers to carry,
 * MSME bills due — with links to the screens that act on them.
 */
export function BuyingLogisticsPage() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const can = useCan()
  const ctx = useOutletContext<PhoneOutletContext | undefined>()
  const { list, companyId, choose } = useCompanyChoice()
  const q = useReadRpc<Home>('buying_logistics_home', { p_company_id: companyId ?? null }, Boolean(companyId))
  const h = q.data
  const name = profile?.displayName ?? ''
  const n = (v: number | undefined) => (q.isLoading ? '…' : String(v ?? 0))

  return (
    <>
      <PhoneHeader initial={initials(name).slice(0, 1) || '·'} name={name} sub={t('buyingHome.sub', { code: profile?.personCode ?? '' })} extra={<OfflineBadge />} onHelp={ctx?.openHelp} />
      <main className="sf-phone-body">
        <h1 className="sr-only">{t('buyingHome.title')}</h1>
        {list.length > 1 ? <SelectField label={t('common.company')} value={companyId ?? ''} onChange={(e) => choose(e.target.value)} options={list.map((c) => ({ value: c.id, label: c.short_name || c.name }))} /> : null}
        {q.error ? <PurchaseErrorBox error={q.error} /> : null}
        {q.isLoading && !h ? <Skeleton height={120} /> : null}

        <section className="sf-phone-card" aria-labelledby="bh-buy">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <h2 id="bh-buy">{t('buyingHome.toBuy')}</h2>
            <span className="muted" data-testid="bh-approved">
              {t('buyingHome.approved', { n: n(h?.requests_approved) })}
            </span>
          </div>
          <p style={{ margin: 0 }}>{t('buyingHome.waiting', { n: n(h?.requests_waiting) })}</p>
          <p style={{ margin: 0 }}>{t('buyingHome.orders', { draft: n(h?.orders_draft), open: n(h?.orders_open) })}</p>
          {h && h.orders_late > 0 ? <p style={{ margin: 0, color: 'var(--sf-signal-ink)' }}>{t('buyingHome.late', { n: h.orders_late })}</p> : null}
          {h && h.price_increases_this_month > 0 ? <p style={{ margin: 0, color: 'var(--sf-signal-ink)' }}>{t('buyingHome.priceUp', { n: h.price_increases_this_month })}</p> : null}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {can('purchase.view') ? (
              <Link className="sf-btn" to={`/purchase/purchase-requests?company=${companyId ?? ''}`}>
                {t('buyingHome.requests')}
              </Link>
            ) : null}
            {can('purchase.view') ? (
              <Link className="sf-btn" to={`/purchase/purchase-orders?company=${companyId ?? ''}`}>
                {t('buyingHome.ordersBtn')}
              </Link>
            ) : null}
          </div>
        </section>

        <section className="sf-phone-card" aria-labelledby="bh-bills">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <h2 id="bh-bills">{t('buyingHome.bills')}</h2>
            <strong className="mono" data-testid="bh-bills-count">
              {n(h?.bill_photos_to_review)}
            </strong>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link className="sf-btn" to={`/me/bill-photo?company=${companyId ?? ''}`}>
              {t('buyingHome.photo')}
            </Link>
            {can('purchase.view') || can('purchase_bills.view') ? (
              <Link className="sf-btn" to={`/purchase/bill-photo-capture?company=${companyId ?? ''}`}>
                {t('buyingHome.check')}
              </Link>
            ) : null}
          </div>
        </section>

        <section className="sf-phone-card" aria-labelledby="bh-goods">
          <h2 id="bh-goods">{t('buyingHome.goods')}</h2>
          <p style={{ margin: 0 }}>{t('buyingHome.receipts', { n: n(h?.receipts_today) })}</p>
          <p style={{ margin: 0 }}>{t('buyingHome.quarantine', { n: n(h?.lots_in_quarantine) })}</p>
          {h && h.below_reorder > 0 ? <p style={{ margin: 0, color: 'var(--sf-signal-ink)' }}>{t('buyingHome.reorder', { n: h.below_reorder })}</p> : null}
        </section>

        <section className="sf-phone-card" aria-labelledby="bh-cash">
          <h2 id="bh-cash">{t('buyingHome.cash')}</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link className="sf-btn" to="/me/cash-entry">
              {t('buyingHome.cashEntry')}
            </Link>
          </div>
          <p className="k" style={{ margin: 0 }}>
            {t('buyingHome.cashNote')}
          </p>
        </section>

        <section className="sf-phone-card" aria-labelledby="bh-log">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <h2 id="bh-log">{t('buyingHome.logistics')}</h2>
            <span className="muted">{t('buyingHome.inTransit', { n: n(h?.transfers_in_transit) })}</span>
          </div>
          <p style={{ margin: 0 }}>{t('buyingHome.toCarry', { n: n(h?.transfers_to_carry) })}</p>
          <div>
            <Link className="sf-btn" to="/inventory/stock-transfers">
              {t('buyingHome.dispatch')}
            </Link>
          </div>
        </section>

        {h && (h.msme_overdue > 0 || h.msme_due_soon > 0) ? (
          <section className="sf-phone-card" aria-labelledby="bh-msme">
            <h2 id="bh-msme">{t('buyingHome.msme')}</h2>
            <p style={{ margin: 0 }}>{t('buyingHome.msmeLine', { overdue: h.msme_overdue, soon: h.msme_due_soon })}</p>
          </section>
        ) : null}

        {h && h.tasks.length ? (
          <section className="sf-phone-section" aria-labelledby="bh-tasks">
            <h2 id="bh-tasks">{t('buyingHome.tasks')}</h2>
            {h.tasks.map((task) => (
              <Link key={task.id} to={task.href} className="sf-phone-line">
                <span className="sf-chip" data-tone={task.severity === 'high' ? 'danger' : task.severity === 'medium' ? 'signal' : 'info'}>
                  {t(`buyingHome.severity.${task.severity}`)}
                </span>
                <span>{task.title}</span>
              </Link>
            ))}
          </section>
        ) : null}
      </main>
    </>
  )
}

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { formatDate } from '@/shared/format'
import { Amount, Card, DataTable, EmptyState, Field, type Column } from '@/ui'
import { SalesFrame, ViewError } from '../sales-common/sales'

const SHOP_TYPES = ['retail_shop', 'supermarket_chain', 'wholesale', 'distributor']

/**
 * Shops and supermarkets (`ShopSales`): who buys the retail range, how they pay, and what they still owe. Everything comes
 * from the books: customers (api.customers — payments counted by the server), receipts of the month (api.vouchers),
 * collections by staff (api.field_collections) and open bills (api.receivables). New invoices and receipts are made on
 * their own screens; the counter is on Own shops.
 */
export function ShopsAndSupermarketsPage() {
  const { t } = useTranslation()
  return (
    <SalesFrame
      title={t('shopSales.title')}
      subtitle={t('shopSales.subtitle')}
      actions={() => (
        <>
          <Link to="/sales/receipts" className="sf-btn" data-variant="secondary">
            {t('shopSales.recordCollection')}
          </Link>
          <Link to="/sales/invoices" className="sf-btn" data-variant="primary">
            {t('shopSales.newInvoice')}
          </Link>
        </>
      )}
    >
      {(companyId) => <ShopBuyers companyId={companyId} />}
    </SalesFrame>
  )
}

function ShopBuyers({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const [month, setMonth] = useState(todayIst().slice(0, 7))
  const customers = useApiView('customers', { eq: { company_id: companyId }, order: 'name', limit: 2000 })
  const receipts = useApiView('vouchers', { eq: { company_id: companyId, voucher_type: 'receipt', status: 'posted' }, order: 'voucher_date', ascending: false, limit: 1000 })
  const collections = useApiView('field_collections', { eq: { company_id: companyId }, order: 'collected_at', ascending: false, limit: 300 })
  const open = useApiView('receivables', { eq: { company_id: companyId }, order: 'days_overdue', ascending: false, limit: 500 })
  const buyers = rowsOf(customers).filter((c) => c.customer_type && SHOP_TYPES.includes(c.customer_type))
  const monthReceipts = rowsOf(receipts).filter((v) => v.voucher_date.startsWith(month))
  const buyerIds = new Set(buyers.map((b) => b.id))
  const owed = rowsOf(open).filter((r) => r.party_id && buyerIds.has(r.party_id))
  const buyerCols: Column<ViewRow<'customers'>>[] = [
    { key: 'name', header: t('shopSales.col.buyer'), render: (c) => c.name },
    { key: 'type', header: t('shopSales.col.type'), render: (c) => t(`shopSales.types.${c.customer_type ?? 'none'}`, { defaultValue: c.customer_type ?? '—' }) },
    { key: 'how', header: t('shopSales.col.paidBy'), render: (c) => c.how_paid ?? '—' },
    { key: 'n', header: t('shopSales.col.payments'), align: 'right', render: (c) => c.payments_count ?? 0 },
    { key: 'fy', header: t('shopSales.col.receivedFy'), align: 'right', render: (c) => <Amount value={c.received_fy} /> },
    { key: 'last', header: t('shopSales.col.lastPaid'), render: (c) => (c.last_paid_on ? formatDate(c.last_paid_on) : '—') },
  ]
  const rcptCols: Column<ViewRow<'vouchers'>>[] = [
    { key: 'date', header: t('shopSales.col.date'), render: (v) => formatDate(v.voucher_date) },
    { key: 'no', header: t('shopSales.col.receipt'), render: (v) => <span className="mono">{v.doc_no}</span> },
    { key: 'party', header: t('shopSales.col.buyer'), render: (v) => v.party_name ?? '—' },
    { key: 'mode', header: t('shopSales.col.paidBy'), render: (v) => (v.mode ? t(`shopSales.modes.${v.mode}`, { defaultValue: v.mode }) : '—') },
    { key: 'amt', header: t('shopSales.col.amount'), align: 'right', render: (v) => <Amount value={v.amount} /> },
  ]
  const collCols: Column<ViewRow<'field_collections'>>[] = [
    { key: 'date', header: t('shopSales.col.date'), render: (c) => formatDate(c.collected_at) },
    { key: 'who', header: t('shopSales.col.staff'), render: (c) => c.salesman_name ?? '—' },
    { key: 'party', header: t('shopSales.col.buyer'), render: (c) => c.party_name ?? '—' },
    { key: 'mode', header: t('shopSales.col.paidBy'), render: (c) => t(`shopSales.modes.${c.mode}`, { defaultValue: c.mode }) },
    { key: 'amt', header: t('shopSales.col.amount'), align: 'right', render: (c) => <Amount value={c.amount} /> },
  ]
  const owedCols: Column<ViewRow<'receivables'>>[] = [
    { key: 'party', header: t('shopSales.col.buyer'), render: (r) => r.party_name ?? '—' },
    { key: 'bill', header: t('shopSales.col.bill'), render: (r) => <span className="mono">{r.bill_ref ?? '—'}</span> },
    { key: 'due', header: t('shopSales.col.due'), render: (r) => (r.due_date ? formatDate(r.due_date) : '—') },
    { key: 'days', header: t('shopSales.col.overdue'), align: 'right', render: (r) => r.days_overdue ?? 0 },
    { key: 'open', header: t('shopSales.col.open'), align: 'right', render: (r) => <Amount value={r.open_amount} /> },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <ViewError error={customers.error ?? receipts.error ?? collections.error ?? open.error} />
      <TableCard title={t('shopSales.buyersTitle')}>
        <DataTable caption={t('shopSales.buyersTitle')} columns={buyerCols} rows={buyers} rowKey={(c) => c.id} loading={customers.isLoading} minWidth={760} empty={<EmptyState title={t('shopSales.noBuyers')} body={t('shopSales.noBuyersBody')} />} />
      </TableCard>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: 16, alignItems: 'start' }}>
        <TableCard title={t('shopSales.receiptsTitle')} action={<div style={{ maxWidth: 180 }}><Field label={t('shopSales.month')} type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></div>}>
          <DataTable caption={t('shopSales.receiptsTitle')} columns={rcptCols} rows={monthReceipts} rowKey={(v) => v.id} loading={receipts.isLoading} minWidth={560} empty={<EmptyState title={t('shopSales.noReceipts')} />} />
        </TableCard>
        <TableCard title={t('shopSales.owedTitle')}>
          <DataTable caption={t('shopSales.owedTitle')} columns={owedCols} rows={owed} rowKey={(r) => r.id ?? `${r.bill_ref}`} loading={open.isLoading} minWidth={560} empty={<EmptyState title={t('shopSales.noOwed')} />} />
        </TableCard>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: 16, alignItems: 'start' }}>
        <TableCard title={t('shopSales.staffTitle')}>
          <DataTable caption={t('shopSales.staffTitle')} columns={collCols} rows={rowsOf(collections)} rowKey={(c) => c.id} loading={collections.isLoading} minWidth={560} empty={<EmptyState title={t('shopSales.noCollections')} body={t('shopSales.noCollectionsBody')} />} />
        </TableCard>
        <Card title={t('shopSales.counterTitle')}>
          <p style={{ marginTop: 0 }}>{t('shopSales.counterBody')}</p>
          <p className="k">{t('shopSales.counterClose')}</p>
          <Link to="/sales/own-shops" className="sf-btn" data-variant="secondary">
            {t('shopSales.openShops')}
          </Link>
          <p className="k" style={{ marginBottom: 0 }}>
            {t('shopSales.chequeRule')}
          </p>
        </Card>
      </div>
    </div>
  )
}

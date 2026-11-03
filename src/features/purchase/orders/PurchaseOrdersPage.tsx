import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { formatDate } from '@/shared/format'
import { Amount, Button, Card, Chip, DataTable, EmptyState, PageHeader, Skeleton, Tabs, type Column } from '@/ui'
import { DocStatus, usePurchaseRights } from '../common/purchase'
import { OrderEditor } from './OrderEditor'
import { Quotes } from './Quotes'

type Tab = 'orders' | 'quotes'
type Order = ViewRow<'purchase_orders'>

/**
 * Purchase orders (/purchase/purchase-orders, no reference screen): the order register with its editor, and the
 * supplier quotes step (request for quotation → quotations compared → one chosen → draft order). The URL keeps the
 * company, the tab and the open order (`?order=`), the request (`?request=`) and the RFQ (`?rfq=`).
 */
export function PurchaseOrdersPage() {
  const { t } = useTranslation()
  const rights = usePurchaseRights()
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('tab') === 'quotes' ? 'quotes' : 'orders'
  const orderParam = params.get('order')
  const choice = useCompanyChoice()
  const companyId = choice.companyId

  function patch(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) next.delete(k)
      else next.set(k, v)
    }
    setParams(next, { replace: true })
  }

  return (
    <>
      <PageHeader
        title={t('purchaseOrders.title')}
        subtitle={t('purchaseOrders.subtitle')}
        actions={
          tab === 'orders' && rights.create && orderParam !== 'new' ? (
            <Button variant="primary" onClick={() => patch({ order: 'new' })}>
              {t('purchaseOrders.newOrder')}
            </Button>
          ) : null
        }
      />
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: 16 }}>
        <Tabs
          label={t('purchaseOrders.tabs')}
          value={tab}
          onChange={(k) => patch({ tab: k })}
          idBase="po"
          controls="po-panel"
          tabs={[
            { key: 'orders', label: t('purchaseOrders.tabOrders') },
            { key: 'quotes', label: t('purchaseOrders.tabQuotes') },
          ]}
        />
        <CompanyPicker list={choice.list} value={companyId} onChange={choice.choose} />
      </div>
      <div id="po-panel" role="tabpanel" aria-labelledby={`po-tab-${tab}`} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {choice.isLoading ? (
          <Card>
            <Skeleton height={80} />
          </Card>
        ) : !companyId ? (
          <Card>
            <EmptyState title={t('purchaseOrders.noCompany')} />
          </Card>
        ) : !rights.view && !rights.receive ? (
          <p className="muted">{t('purchaseOrders.noRight')}</p>
        ) : tab === 'quotes' ? (
          <Quotes key={companyId} companyId={companyId} requestId={params.get('request')} rfqId={params.get('rfq')} setRfq={(id) => patch({ rfq: id })} onOrder={(id) => patch({ tab: 'orders', order: id, rfq: null, request: null })} />
        ) : (
          <>
            {orderParam ? (
              <OrderEditor key={orderParam} companyId={companyId} orderId={orderParam === 'new' ? null : orderParam} onSaved={(id) => patch({ order: id })} onClose={() => patch({ order: null })} />
            ) : null}
            <OrderList companyId={companyId} onOpen={(id) => patch({ order: id })} />
          </>
        )}
      </div>
    </>
  )
}

function OrderList({ companyId, onOpen }: { companyId: string; onOpen: (id: string) => void }) {
  const { t } = useTranslation()
  const q = useApiView('purchase_orders', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 300 })
  const rows = rowsOf(q)
  const columns: Column<Order>[] = [
    { key: 'no', header: t('purchaseOrders.list.no'), render: (o) => <span className="mono">{o.doc_no ?? t('purchaseOrders.list.draftNo')}</span> },
    { key: 'date', header: t('purchaseOrders.list.date'), render: (o) => <span className="mono">{formatDate(o.order_date)}</span> },
    { key: 'party', header: t('purchaseOrders.list.supplier'), render: (o) => (o.msme ? `${o.party_name} · MSME` : o.party_name) },
    { key: 'delivery', header: t('purchaseOrders.list.delivery'), render: (o) => (o.delivery_date ? <span className="mono">{formatDate(o.delivery_date)}</span> : '—') },
    { key: 'recv', header: t('purchaseOrders.list.received'), align: 'right', render: (o) => <span className="mono">{`${o.qty_received ?? 0} / ${o.qty_ordered ?? 0}`}</span> },
    { key: 'total', header: t('purchaseOrders.list.total'), align: 'right', render: (o) => <Amount value={o.total} /> },
    {
      key: 'status',
      header: t('common.status'),
      render: (o) => (
        <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
          <DocStatus status={o.status} />
          {o.has_price_increase ? <Chip tone="signal">{t('purchaseOrders.list.priceUp')}</Chip> : null}
          {o.message_status ? <DocStatus status={o.message_status} /> : null}
        </span>
      ),
    },
    {
      key: 'act',
      header: <span className="sr-only">{t('purchaseOrders.list.actions')}</span>,
      render: (o) => (
        <Button size="sm" variant="link" aria-label={t('purchaseOrders.list.openAria', { no: o.doc_no ?? t('purchaseOrders.list.draftOf', { name: o.party_name }) })} onClick={() => onOpen(o.id)}>
          {t('purchaseOrders.list.open')}
        </Button>
      ),
    },
  ]
  return (
    <TableCard title={t('purchaseOrders.list.title')}>
      <DataTable caption={t('purchaseOrders.list.title')} columns={columns} rows={rows} rowKey={(o) => o.id} loading={q.isLoading} minWidth={900} empty={<EmptyState title={t('purchaseOrders.list.emptyTitle')} body={t('purchaseOrders.list.emptyBody')} />} />
    </TableCard>
  )
}

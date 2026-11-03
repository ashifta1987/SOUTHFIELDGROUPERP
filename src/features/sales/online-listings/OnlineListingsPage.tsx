import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { TableCard } from '@/features/admin/import-data/layout'
import { formatDate } from '@/shared/format'
import { Amount, Button, Card, Checkbox, Chip, DataTable, EmptyState, Field, SelectField, type Column } from '@/ui'
import { Done, NoRight, SALES_REFRESH, SalesErrorBox, SalesFrame, SalesStatus, ViewError, num, productLabel, useCompanyProducts, useSalesRights } from '../sales-common/sales'

/**
 * Online store listings (`OnlineListings`): what each store shows for each item, built from the item master. Admin
 * publishes (api.publish_listing); the server lists what stops an item going live — barcode, MRP, price above MRP, no
 * price, item not active — and refuses to publish while anything is missing (listing.blocked).
 */
export function OnlineListingsPage() {
  const { t } = useTranslation()
  return (
    <SalesFrame title={t('onlineListings.title')} subtitle={t('onlineListings.subtitle')}>
      {(companyId) => <Listings companyId={companyId} />}
    </SalesFrame>
  )
}

function Listings({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const q = useApiView('listings', { eq: { company_id: companyId }, order: 'product_code', limit: 2000 })
  const channels = useApiView('online_channels', { eq: { company_id: companyId }, order: 'code' })
  const list = rowsOf(q)
  const cols: Column<ViewRow<'listings'>>[] = [
    { key: 'item', header: t('onlineListings.col.item'), render: (l) => `${l.product_code ?? ''} · ${l.product_name ?? ''}` },
    { key: 'ch', header: t('onlineListings.col.channel'), render: (l) => t(`onlineChannels.names.${l.channel}`, { defaultValue: l.channel }) },
    { key: 'title', header: t('onlineListings.col.title'), render: (l) => l.title ?? '—' },
    { key: 'price', header: t('onlineListings.col.price'), align: 'right', render: (l) => <Amount value={l.price} /> },
    {
      key: 'stops',
      header: t('onlineListings.col.stops'),
      render: (l) =>
        l.blockers.length ? (
          <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {l.blockers.map((b) => (
              <Chip key={b} tone="signal">
                {t(`onlineListings.blockers.${b}`, { defaultValue: b })}
              </Chip>
            ))}
          </span>
        ) : (
          '—'
        ),
    },
    { key: 'status', header: t('common.status'), render: (l) => <SalesStatus status={l.status} /> },
    { key: 'pub', header: t('onlineListings.col.published'), render: (l) => (l.published_at ? formatDate(l.published_at) : '—') },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <ViewError error={q.error ?? channels.error} />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(320px, 2fr)', gap: 16, alignItems: 'start' }}>
        <TableCard title={t('onlineListings.listTitle')}>
          <DataTable caption={t('onlineListings.listTitle')} columns={cols} rows={list} rowKey={(l) => l.id} loading={q.isLoading} minWidth={900} empty={<EmptyState title={t('onlineListings.empty')} body={t('onlineListings.emptyBody')} />} />
        </TableCard>
        <Publish companyId={companyId} channels={rowsOf(channels)} />
      </div>
    </div>
  )
}

function Publish({ companyId, channels }: { companyId: string; channels: ViewRow<'online_channels'>[] }) {
  const { t } = useTranslation()
  const rights = useSalesRights()
  const products = useCompanyProducts(companyId)
  const m = useApiMutation<{ p: Record<string, unknown> }, { status: string; blockers: string[] }>('publish_listing', SALES_REFRESH)
  const [f, setF] = useState({ channel: '', product: '', title: '', price: '', publish: false })
  const [res, setRes] = useState<{ status: string; blockers: string[] } | null>(null)
  if (!rights.admin) {
    return (
      <Card title={t('onlineListings.formTitle')}>
        <NoRight>{t('onlineListings.adminOnly')}</NoRight>
      </Card>
    )
  }
  if (channels.length === 0) {
    return (
      <Card title={t('onlineListings.formTitle')}>
        <EmptyState title={t('onlineListings.noChannel')} body={t('onlineListings.noChannelBody')} />
      </Card>
    )
  }
  return (
    <Card title={t('onlineListings.formTitle')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <SelectField label={t('onlineListings.col.channel')} value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} placeholder={t('salesCommon.choose')} options={channels.map((c) => ({ value: c.id, label: t(`onlineChannels.names.${c.code}`, { defaultValue: c.code }) }))} />
        <SelectField label={t('onlineListings.col.item')} value={f.product} onChange={(e) => setF({ ...f, product: e.target.value })} placeholder={t('salesCommon.choose')} options={products.list.map((p) => ({ value: p.id, label: productLabel(p) }))} />
        <Field label={t('onlineListings.col.title')} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <Field label={t('onlineListings.f.price')} inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
        <Checkbox label={t('onlineListings.f.publish')} checked={f.publish} onChange={(e) => setF({ ...f, publish: e.target.checked })} />
        <div>
          <Button variant="primary" busy={m.isPending} onClick={() => m.mutate({ p: { channel_id: f.channel, product_id: f.product, title: f.title.trim() || null, price: num(f.price) || null, publish: f.publish } }, { onSuccess: (r) => setRes(r) })}>
            {f.publish ? t('onlineListings.publish') : t('onlineListings.saveDraft')}
          </Button>
        </div>
        {res ? (
          <Done>
            {res.status === 'listed' ? t('onlineListings.listed') : res.blockers.length ? t('onlineListings.savedBlocked', { list: res.blockers.map((b) => t(`onlineListings.blockers.${b}`, { defaultValue: b })).join(', ') }) : t('onlineListings.savedReady')}
          </Done>
        ) : null}
        <SalesErrorBox error={m.error} />
        <p className="k" style={{ margin: 0 }}>
          {t('onlineListings.rule')}
        </p>
      </div>
    </Card>
  )
}

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { formatDate } from '@/shared/format'
import { Button, Card, Checkbox, DataTable, EmptyState, Field, FieldGrid, SelectField, type Column } from '@/ui'
import { Done, LinesEditor, NoRight, SALES_REFRESH, SalesErrorBox, SalesFrame, SalesStatus, ViewError, linesPayload, newLine, useCompanyProducts, useCustomers, useSalesRights, type DraftLine } from '../sales-common/sales'

const CHANNELS = ['shopify', 'amazon', 'flipkart', 'jiomart', 'meesho'] as const

/**
 * Online channels (`OnlineSales`): each store or marketplace is a channel with its GSTIN, the marketplace's buyer account,
 * the stock place and whether GST TCS applies (api.upsert_online_channel, Admin settings). A marketplace order becomes a
 * sales order (api.ingest_online_order: paid in advance by the marketplace, place of supply = ship-to state; the same
 * external order twice returns the first result). Orders arrive by the store-webhooks Edge Function in Phase 8; until
 * then an order or a settlement line is entered here.
 */
export function OnlineChannelsPage() {
  const { t } = useTranslation()
  return (
    <SalesFrame title={t('onlineChannels.title')} subtitle={t('onlineChannels.subtitle')}>
      {(companyId) => <Channels companyId={companyId} />}
    </SalesFrame>
  )
}

function Channels({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const channels = useApiView('online_channels', { eq: { company_id: companyId }, order: 'code' })
  const orders = useApiView('online_orders', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 300 })
  const chCols: Column<ViewRow<'online_channels'>>[] = [
    { key: 'code', header: t('onlineChannels.col.channel'), render: (c) => t(`onlineChannels.names.${c.code}`, { defaultValue: c.code }) },
    { key: 'status', header: t('common.status'), render: (c) => <SalesStatus status={c.status} /> },
    { key: 'tcs', header: t('onlineChannels.col.tcs'), render: (c) => (c.tcs_applicable ? t('common.yes') : t('common.no')) },
    { key: 'listed', header: t('onlineChannels.col.listed'), align: 'right', render: (c) => c.listed ?? 0 },
    { key: 'orders', header: t('onlineChannels.col.orders'), align: 'right', render: (c) => c.orders ?? 0 },
  ]
  const ordCols: Column<ViewRow<'online_orders'>>[] = [
    { key: 'date', header: t('onlineChannels.col.date'), render: (o) => formatDate(o.order_date) },
    { key: 'ch', header: t('onlineChannels.col.channel'), render: (o) => t(`onlineChannels.names.${o.channel}`, { defaultValue: o.channel }) },
    { key: 'ext', header: t('onlineChannels.col.external'), render: (o) => <span className="mono">{o.external_order_id}</span> },
    { key: 'state', header: t('onlineChannels.col.shipState'), render: (o) => o.ship_state },
    { key: 'order', header: t('onlineChannels.col.order'), render: (o) => <span className="mono">{o.order_no ?? '—'}</span> },
    { key: 'status', header: t('common.status'), render: (o) => <SalesStatus status={o.order_status ?? o.status} /> },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <p className="sf-alert" data-tone="info" style={{ margin: 0 }}>
        {t('onlineChannels.notConnected')}
      </p>
      <ViewError error={channels.error ?? orders.error} />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(320px, 2fr)', gap: 16, alignItems: 'start' }}>
        <TableCard title={t('onlineChannels.channelsTitle')}>
          <DataTable caption={t('onlineChannels.channelsTitle')} columns={chCols} rows={rowsOf(channels)} rowKey={(c) => c.id} loading={channels.isLoading} minWidth={560} empty={<EmptyState title={t('onlineChannels.noChannels')} body={t('onlineChannels.noChannelsBody')} />} />
        </TableCard>
        <ChannelSetup companyId={companyId} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(320px, 2fr)', gap: 16, alignItems: 'start' }}>
        <TableCard title={t('onlineChannels.ordersTitle')}>
          <DataTable caption={t('onlineChannels.ordersTitle')} columns={ordCols} rows={rowsOf(orders)} rowKey={(o) => o.id} loading={orders.isLoading} minWidth={640} empty={<EmptyState title={t('onlineChannels.noOrders')} />} />
        </TableCard>
        <IngestOrder companyId={companyId} channels={rowsOf(channels)} />
      </div>
      <Card title={t('onlineChannels.booksTitle')}>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {['value', 'fees', 'shipping', 'feeGst', 'tcs', 'tds', 'returns', 'payout'].map((k) => (
            <li key={k}>
              <strong>{t(`onlineChannels.books.${k}.line`)}</strong> → {t(`onlineChannels.books.${k}.books`)}
            </li>
          ))}
        </ul>
        <p className="k" style={{ margin: '10px 0 0' }}>
          {t('onlineChannels.booksNote')}
        </p>
      </Card>
      <Card title={t('onlineChannels.profitTitle')}>
        <EmptyState title={t('onlineChannels.profitEmpty')} body={t('onlineChannels.profitBody')} />
      </Card>
    </div>
  )
}

function ChannelSetup({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const rights = useSalesRights()
  const gstins = useApiView('gstins', { eq: { company_id: companyId }, order: 'gstin' })
  const places = useApiView('places', { eq: { company_id: companyId }, order: 'code', limit: 500 })
  const customers = useCustomers(companyId)
  const save = useApiMutation<{ p: Record<string, unknown> }>('upsert_online_channel', SALES_REFRESH)
  const [f, setF] = useState({ code: 'shopify', gstin: '', party: '', place: '', tcs: false })
  const [done, setDone] = useState<string | null>(null)
  if (!rights.settings) {
    return (
      <Card title={t('onlineChannels.setupTitle')}>
        <NoRight>{t('onlineChannels.noSettings')}</NoRight>
      </Card>
    )
  }
  return (
    <Card title={t('onlineChannels.setupTitle')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <SelectField label={t('onlineChannels.col.channel')} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} options={CHANNELS.map((c) => ({ value: c, label: t(`onlineChannels.names.${c}`) }))} />
        <SelectField label={t('onlineChannels.f.gstin')} value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value })} placeholder={t('salesCommon.choose')} options={rowsOf(gstins).map((g) => ({ value: g.id, label: g.gstin }))} />
        <SelectField label={t('onlineChannels.f.party')} value={f.party} onChange={(e) => setF({ ...f, party: e.target.value })} placeholder={t('salesCommon.choose')} options={customers.list.map((c) => ({ value: c.id, label: c.name }))} />
        <SelectField label={t('onlineChannels.f.place')} value={f.place} onChange={(e) => setF({ ...f, place: e.target.value })} placeholder={t('salesCommon.choose')} options={rowsOf(places).map((p) => ({ value: p.id, label: `${p.name} · ${p.branch_name}` }))} />
        <Checkbox label={t('onlineChannels.f.tcs')} checked={f.tcs} onChange={(e) => setF({ ...f, tcs: e.target.checked })} />
        <div>
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate({ p: { company_id: companyId, code: f.code, gstin_id: f.gstin, party_id: f.party, place_id: f.place || null, tcs_applicable: f.tcs, status: 'not_connected' } }, { onSuccess: () => setDone(t('onlineChannels.saved')) })}>
            {t('onlineChannels.save')}
          </Button>
        </div>
        <Done>{done}</Done>
        <SalesErrorBox error={save.error} />
        <p className="k" style={{ margin: 0 }}>
          {t('onlineChannels.setupRule')}
        </p>
      </div>
    </Card>
  )
}

function IngestOrder({ companyId, channels }: { companyId: string; channels: ViewRow<'online_channels'>[] }) {
  const { t } = useTranslation()
  const rights = useSalesRights()
  const products = useCompanyProducts(companyId)
  const ingest = useApiMutation<{ p: Record<string, unknown> }, { doc_no: string | null; duplicate: boolean }>('ingest_online_order', SALES_REFRESH)
  const [f, setF] = useState({ channel: '', ext: '', date: todayIst(), state: '' })
  const [lines, setLines] = useState<DraftLine[]>([newLine()])
  const [done, setDone] = useState<string | null>(null)
  if (!rights.create) {
    return (
      <Card title={t('onlineChannels.ingestTitle')}>
        <NoRight>{t('onlineChannels.noCreate')}</NoRight>
      </Card>
    )
  }
  return (
    <Card title={t('onlineChannels.ingestTitle')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <FieldGrid cols={2}>
          <SelectField label={t('onlineChannels.col.channel')} value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} placeholder={t('salesCommon.choose')} options={channels.map((c) => ({ value: c.id, label: t(`onlineChannels.names.${c.code}`, { defaultValue: c.code }) }))} />
          <Field label={t('onlineChannels.col.external')} value={f.ext} onChange={(e) => setF({ ...f, ext: e.target.value })} />
          <Field label={t('onlineChannels.col.date')} type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          <Field label={t('onlineChannels.f.state')} inputMode="numeric" maxLength={2} value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} help={t('onlineChannels.f.stateHelp')} />
        </FieldGrid>
        <LinesEditor idBase="online" lines={lines} onChange={setLines} products={products.list} showDiscount={false} rateLabel={t('onlineChannels.f.price')} rateHelp={t('onlineChannels.f.priceHelp')} />
        <div>
          <Button
            variant="primary"
            busy={ingest.isPending}
            onClick={() =>
              ingest.mutate(
                { p: { channel_id: f.channel, external_order_id: f.ext.trim(), order_date: f.date, ship_state: f.state.trim(), lines: linesPayload(lines, { rateKey: 'price_incl_tax', discount: false }) } },
                { onSuccess: (r) => { setLines([newLine()]); setDone(r.duplicate ? t('onlineChannels.duplicate') : t('onlineChannels.ingested', { no: r.doc_no ?? '' })) } },
              )
            }
          >
            {t('onlineChannels.ingest')}
          </Button>
        </div>
        <Done testId="online-msg">{done}</Done>
        <SalesErrorBox error={ingest.error} />
      </div>
    </Card>
  )
}

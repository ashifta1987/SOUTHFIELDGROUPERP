import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { callApi, useApiMutation, type RpcError } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import type { TaxPreview } from '@/features/sales/invoice/docs'
import { TotalsBlock, useDebounced } from '@/features/sales/invoice/taxPanel'
import { formatDate } from '@/shared/format'
import { Amount, Button, Card, DataTable, EmptyState, Field, FieldGrid, KeyValue, SelectField, Tabs, TextAreaField, type Column } from '@/ui'
import {
  Done,
  ExposurePanel,
  LinesEditor,
  MdExceptionForm,
  NoRight,
  ReasonAction,
  SALES_REFRESH,
  SalesErrorBox,
  SalesFrame,
  SalesStatus,
  ViewError,
  Warn,
  linesPayload,
  newLine,
  useCompanyProducts,
  useCustomers,
  useExposure,
  useSalesRights,
  type DraftLine,
  type Exposure,
} from '../sales-common/sales'

type Order = ViewRow<'sales_orders'>
type Tab = 'enquiries' | 'quotations' | 'orders'

/**
 * Quotations and sales orders (`SalesOrders`). Orders are confirmed by api.confirm_sales_order: the server prices the
 * lines (price list or typed rate), works out GST, checks MRP and KYC, and compares the customer's credit exposure with
 * the limit plus live MD exceptions. An order over the limit is held (pending_credit) — it is released by someone other
 * than its creator (api.release_order) once it fits, usually after an MD exception (api.grant_md_exception).
 * Enquiries and quotations have no tables yet: the tabs say so plainly.
 */
export function QuotationsAndOrdersPage() {
  const { t } = useTranslation()
  return (
    <SalesFrame title={t('salesOrders.title')} subtitle={t('salesOrders.subtitle')}>
      {(companyId) => <Orders companyId={companyId} />}
    </SalesFrame>
  )
}

function Orders({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const rights = useSalesRights()
  const [tab, setTab] = useState<Tab>('orders')
  const orders = useApiView('sales_orders', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 300 })
  const [openId, setOpenId] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ kind: 'done' | 'warn'; text: string } | null>(null)
  const list = rowsOf(orders)
  const current = list.find((o) => o.id === openId) ?? null
  const cols: Column<Order>[] = [
    {
      key: 'no',
      header: t('salesOrders.col.no'),
      render: (o) => (
        <Button size="sm" variant="link" aria-label={t('salesOrders.open', { no: o.doc_no ?? '' })} onClick={() => { setMsg(null); setOpenId(o.id) }}>
          <span className="mono">{o.doc_no}</span>
        </Button>
      ),
    },
    { key: 'date', header: t('salesOrders.col.date'), render: (o) => formatDate(o.order_date) },
    { key: 'party', header: t('salesOrders.col.customer'), render: (o) => o.party_name ?? '—' },
    { key: 'channel', header: t('salesOrders.col.channel'), render: (o) => t(`salesOrders.channel.${o.channel}`, { defaultValue: o.channel }) },
    { key: 'pay', header: t('salesOrders.col.payment'), render: (o) => t(`salesOrders.payment.${o.payment}`, { defaultValue: o.payment }) },
    { key: 'total', header: t('salesOrders.col.total'), align: 'right', render: (o) => <Amount value={o.total} rupee /> },
    { key: 'status', header: t('common.status'), render: (o) => <SalesStatus status={o.status} /> },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Tabs<Tab>
        label={t('salesOrders.tabs')}
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'enquiries', label: t('salesOrders.tab.enquiries') },
          { key: 'quotations', label: t('salesOrders.tab.quotations') },
          { key: 'orders', label: t('salesOrders.tab.orders') },
        ]}
      />
      {tab !== 'orders' ? (
        <Card>
          <EmptyState title={t(`salesOrders.notBuilt.${tab}.title`)} body={t(`salesOrders.notBuilt.${tab}.body`)} action={<Button onClick={() => setTab('orders')}>{t('salesOrders.goOrders')}</Button>} />
        </Card>
      ) : (
        <>
          <ViewError error={orders.error} />
          {msg?.kind === 'done' ? <Done testId="order-msg">{msg.text}</Done> : null}
          {msg?.kind === 'warn' ? <Warn testId="order-msg">{msg.text}</Warn> : null}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
            <TableCard
              title={t('salesOrders.listTitle')}
              action={
                rights.create && current ? (
                  <Button size="sm" onClick={() => { setOpenId(null); setMsg(null) }}>
                    {t('salesOrders.newShort')}
                  </Button>
                ) : null
              }
            >
              <DataTable caption={t('salesOrders.listTitle')} columns={cols} rows={list} rowKey={(o) => o.id} loading={orders.isLoading} minWidth={720} empty={<EmptyState title={t('salesOrders.emptyTitle')} body={t('salesOrders.emptyBody')} />} />
            </TableCard>
            {current ? (
              <OrderDetail key={current.id} order={current} onMsg={setMsg} />
            ) : rights.create ? (
              <OrderEditor companyId={companyId} onSaved={(m, id) => { setMsg(m); setOpenId(id) }} />
            ) : (
              <Card title={t('salesOrders.newTitle')}>
                <NoRight>{t('salesOrders.noCreate')}</NoRight>
              </Card>
            )}
          </div>
        </>
      )}
    </div>
  )
}

interface Confirmed {
  id: string
  doc_no: string
  status: string
  credit: Exposure
}

function OrderEditor({ companyId, onSaved }: { companyId: string; onSaved: (m: { kind: 'done' | 'warn'; text: string }, id: string) => void }) {
  const { t } = useTranslation()
  const customers = useCustomers(companyId)
  const products = useCompanyProducts(companyId)
  const gstins = useApiView('gstins', { eq: { company_id: companyId }, order: 'gstin' })
  const places = useApiView('places', { eq: { company_id: companyId }, order: 'code', limit: 500 })
  const save = useApiMutation<{ p_header: Record<string, unknown>; p_lines: unknown[] }, Confirmed>('confirm_sales_order', SALES_REFRESH)
  const gstinList = rowsOf(gstins).filter((g) => g.status === 'active' || !g.status)
  const principal = gstinList.find((g) => g.is_principal) ?? gstinList[0]
  const [h, setH] = useState({ party_id: '', order_date: todayIst(), delivery_date: '', payment: 'credit', channel: 'direct', place_id: '', buyer_po_no: '', buyer_po_date: '', notes: '' })
  const [lines, setLines] = useState<DraftLine[]>([newLine()])
  const set = (k: keyof typeof h) => (e: { target: { value: string } }) => setH({ ...h, [k]: e.target.value })
  const payloadLines = linesPayload(lines)

  // Server tax preview (the same function the posting uses) → the total feeds the credit check.
  const previewKey =
    principal && h.party_id && payloadLines.length && payloadLines.every((l) => l.rate)
      ? JSON.stringify({ p_gstin_id: principal.id, p_party_id: h.party_id, p_place_of_supply: null, p_date: h.order_date, p_without_gst: false, p_lines: payloadLines })
      : ''
  const debounced = useDebounced(previewKey, 350)
  const preview = useQuery<TaxPreview, RpcError>({
    queryKey: ['api', 'preview_tax', 'order', debounced],
    enabled: Boolean(debounced),
    retry: false,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    queryFn: () => callApi<TaxPreview>('preview_tax', JSON.parse(debounced) as Record<string, unknown>, { idempotent: false }),
  })
  const pv = debounced ? (preview.data ?? null) : null
  const exposure = useExposure(companyId, h.party_id || undefined, h.payment === 'credit' && pv ? pv.total : 0)

  function confirm() {
    save.mutate(
      {
        p_header: {
          company_id: companyId,
          gstin_id: principal?.id ?? null,
          party_id: h.party_id,
          order_date: h.order_date,
          delivery_date: h.delivery_date || null,
          channel: h.channel,
          payment: h.payment,
          place_id: h.place_id || null,
          buyer_po_no: h.buyer_po_no.trim() || null,
          buyer_po_date: h.buyer_po_date || null,
          notes: h.notes.trim() || null,
        },
        p_lines: payloadLines,
      },
      {
        onSuccess: (r) => {
          const kind = r.status === 'confirmed' ? 'done' : 'warn'
          onSaved({ kind, text: t(`salesOrders.result.${r.status}`, { no: r.doc_no, defaultValue: r.status }) }, r.id)
          setLines([newLine()])
        },
      },
    )
  }
  const stockPlaces = rowsOf(places).filter((p) => ['stores', 'fg_released', 'fg_hold', 'van', 'agent_consignment'].includes(p.kind) && p.status !== 'inactive')
  return (
    <Card title={t('salesOrders.newTitle')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <FieldGrid cols={2}>
          <SelectField label={t('salesOrders.f.customer')} value={h.party_id} onChange={set('party_id')} placeholder={t('salesCommon.choose')} options={customers.list.map((c) => ({ value: c.id, label: c.name }))} />
          <SelectField
            label={t('salesOrders.f.payment')}
            value={h.payment}
            onChange={set('payment')}
            options={['credit', 'cash', 'advance'].map((k) => ({ value: k, label: t(`salesOrders.payment.${k}`) }))}
          />
          <Field label={t('salesOrders.f.date')} type="date" value={h.order_date} onChange={set('order_date')} />
          <Field label={t('salesOrders.f.delivery')} type="date" value={h.delivery_date} onChange={set('delivery_date')} />
          <SelectField label={t('salesOrders.f.channel')} value={h.channel} onChange={set('channel')} options={['direct', 'field', 'shop'].map((k) => ({ value: k, label: t(`salesOrders.channel.${k}`) }))} />
          <SelectField label={t('salesOrders.f.place')} value={h.place_id} onChange={set('place_id')} placeholder={t('salesOrders.f.placeNone')} options={stockPlaces.map((p) => ({ value: p.id, label: `${p.name} · ${p.branch_name}` }))} />
          <Field label={t('salesOrders.f.po')} value={h.buyer_po_no} onChange={set('buyer_po_no')} />
          <Field label={t('salesOrders.f.poDate')} type="date" value={h.buyer_po_date} onChange={set('buyer_po_date')} />
        </FieldGrid>
        <LinesEditor idBase="so" lines={lines} onChange={setLines} products={products.list} rateHelp={t('salesOrders.rateHelp')} />
        <TextAreaField label={t('salesOrders.f.notes')} value={h.notes} onChange={set('notes')} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
          <section aria-label={t('salesOrders.taxPanel')}>
            <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>{t('salesOrders.taxPanel')}</h3>
            <TotalsBlock totals={pv} intra={pv ? pv.intra_state : null} />
            {preview.error ? <SalesErrorBox error={preview.error} /> : null}
          </section>
          <section aria-label={t('salesOrders.creditPanel')}>
            <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>{t('salesOrders.creditPanel')}</h3>
            {!h.party_id ? <p className="k">{t('salesOrders.creditPick')}</p> : h.payment !== 'credit' ? <p className="k">{t('salesOrders.creditNotNeeded')}</p> : null}
            {h.party_id ? <ExposurePanel data={exposure.data} testId="order-exposure" /> : null}
            {exposure.error ? <SalesErrorBox error={exposure.error} /> : null}
          </section>
        </div>
        <p className="k" style={{ margin: 0 }}>
          {t('salesOrders.overLimitRule')}
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="primary" busy={save.isPending} onClick={confirm} disabled={!h.party_id || payloadLines.length === 0}>
            {t('salesOrders.confirm')}
          </Button>
        </div>
        <SalesErrorBox error={save.error} />
      </div>
    </Card>
  )
}

function OrderDetail({ order, onMsg }: { order: Order; onMsg: (m: { kind: 'done' | 'warn'; text: string } | null) => void }) {
  const { t } = useTranslation()
  const rights = useSalesRights()
  const lines = useApiView('sales_order_lines', { eq: { order_id: order.id }, order: 'line_no' })
  const release = useApiMutation<{ p_order_id: string }, { status: string }>('release_order', SALES_REFRESH)
  const cancel = useApiMutation<{ p_order_id: string; p_reason: string }, { status: string }>('cancel_sales_order', SALES_REFRESH)
  const held = order.status === 'pending_credit' || order.status === 'pending_approval'
  const mine = rights.me !== null && order.created_by === rights.me
  const check = (order.credit_check ?? null) as Exposure | null
  const lineCols: Column<ViewRow<'sales_order_lines'>>[] = [
    { key: 'item', header: t('salesOrders.d.item'), render: (l) => `${l.product_code ?? ''} · ${l.description}` },
    { key: 'qty', header: t('salesOrders.d.qty'), align: 'right', render: (l) => <span className="sf-amount">{`${l.qty} ${l.uom}`}</span> },
    { key: 'rate', header: t('salesOrders.d.rate'), align: 'right', render: (l) => <Amount value={l.rate} /> },
    { key: 'gst', header: t('salesOrders.d.gst'), align: 'right', render: (l) => `${l.gst_rate} %` },
    { key: 'total', header: t('salesOrders.d.total'), align: 'right', render: (l) => <Amount value={l.total} /> },
    { key: 'disp', header: t('salesOrders.d.dispatched'), align: 'right', render: (l) => <span className="sf-amount">{l.qty_dispatched}</span> },
  ]
  return (
    <Card title={t('salesOrders.detailTitle', { no: order.doc_no ?? '' })}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0 }} data-testid="order-status">
          <SalesStatus status={order.status} /> <span className="muted">{order.party_name}</span>
        </p>
        <KeyValue
          rows={[
            { label: t('salesOrders.col.date'), value: formatDate(order.order_date) },
            { label: t('salesOrders.f.delivery'), value: order.delivery_date ? formatDate(order.delivery_date) : '—' },
            { label: t('salesOrders.col.payment'), value: t(`salesOrders.payment.${order.payment}`, { defaultValue: order.payment }) },
            { label: t('salesOrders.d.by'), value: order.created_by_name ?? '—' },
            { label: t('salesOrders.d.taxable'), value: <Amount value={order.taxable} rupee /> },
            ...(Number(order.igst) ? [{ label: t('salesOrders.d.igst'), value: <Amount value={order.igst} rupee /> }] : [
              { label: t('salesOrders.d.cgst'), value: <Amount value={order.cgst} rupee /> },
              { label: t('salesOrders.d.sgst'), value: <Amount value={order.sgst} rupee /> },
            ]),
            { label: t('salesOrders.col.total'), value: <Amount value={order.total} rupee />, total: true },
          ]}
        />
        <DataTable caption={t('salesOrders.d.lines')} columns={lineCols} rows={rowsOf(lines)} rowKey={(l) => l.id} loading={lines.isLoading} minWidth={560} empty={<EmptyState title={t('salesOrders.d.noLines')} />} />
        {check ? (
          <section aria-label={t('salesOrders.d.creditAtOrder')}>
            <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>{t('salesOrders.d.creditAtOrder')}</h3>
            <ExposurePanel data={check} testId="order-credit-check" />
          </section>
        ) : null}
        {held ? (
          <Warn>{t(order.status === 'pending_credit' ? 'salesOrders.d.heldCredit' : 'salesOrders.d.heldApproval')}</Warn>
        ) : null}
        {order.cancel_reason ? <p className="muted" style={{ margin: 0 }}>{t('salesOrders.d.cancelReason', { reason: order.cancel_reason })}</p> : null}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {held && (rights.approve || rights.creditMd) ? (
            <Button
              variant="primary"
              busy={release.isPending}
              onClick={() => release.mutate({ p_order_id: order.id }, { onSuccess: () => onMsg({ kind: 'done', text: t('salesOrders.released', { no: order.doc_no ?? '' }) }) })}
            >
              {t('salesOrders.release')}
            </Button>
          ) : null}
          {['pending_credit', 'pending_approval', 'confirmed'].includes(order.status) && rights.cancel ? (
            <ReasonAction
              label={t('salesOrders.cancel')}
              fieldLabel={t('salesOrders.cancelReason')}
              danger
              busy={cancel.isPending}
              onConfirm={(reason) => cancel.mutate({ p_order_id: order.id, p_reason: reason }, { onSuccess: () => onMsg({ kind: 'done', text: t('salesOrders.cancelled', { no: order.doc_no ?? '' }) }) })}
            />
          ) : null}
        </div>
        {held && mine ? <p className="k" style={{ margin: 0 }}>{t('salesOrders.d.notYours')}</p> : null}
        <SalesErrorBox error={release.error ?? cancel.error} />
        {order.status === 'pending_credit' && rights.creditMd ? (
          <section aria-label={t('salesOrders.d.mdTitle')}>
            <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>{t('salesOrders.d.mdTitle')}</h3>
            <MdExceptionForm companyId={order.company_id} partyId={order.party_id} orderId={order.id} onDone={(text) => onMsg({ kind: 'done', text })} />
          </section>
        ) : null}
      </div>
    </Card>
  )
}

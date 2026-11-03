import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { useCompanyChoice } from '@/features/admin/branches/company'
import { formatDate, formatTime } from '@/shared/format'
import { Amount, Card, Chip, DataTable, EmptyState, KpiTiles, PageHeader, Skeleton, Tabs, type Column } from '@/ui'
import { Qty, StockStatus, useInventoryRights, useMoveLabel, useStockMovements } from './inventory'

type Row = ViewRow<'item_stock'>

/**
 * Item stock register shared by Raw material (`RawMaterial`) and Component stock (`ComponentStock`): per item the
 * total on hand, reserved, QC hold, in transit and what is free to use, with the reorder level and, for people who
 * may see costs, the weighted-average value. Every figure comes from api.raw_material_stock / api.component_stock
 * (sellable = released stock only; free = sellable − reserved). Selecting an item shows its lots and latest movements.
 */
export function ItemStockScreen({ view, title, subtitle, variant }: { view: 'raw_material_stock' | 'component_stock'; title: string; subtitle: string; variant: 'raw' | 'component' }) {
  const { t } = useTranslation()
  const rights = useInventoryRights()
  const choice = useCompanyChoice()
  const companyId = choice.companyId
  const q = useApiView(view, { eq: { company_id: companyId }, order: 'product_name', limit: 3000, enabled: Boolean(companyId) })
  const rows = rowsOf(q) as Row[]
  const kinds = [...new Set(rows.map((r) => r.product_kind))].sort()
  const [kindPick, setKind] = useState<string>('all')
  const kind = kindPick === 'all' || kinds.includes(kindPick) ? kindPick : 'all'
  const shown = kind === 'all' ? rows : rows.filter((r) => r.product_kind === kind)
  const [selected, setSelected] = useState<string | null>(null)
  const sel = shown.find((r) => r.product_id === selected) ?? null
  const qs = companyId ? `?company=${companyId}` : ''

  const below = shown.filter((r) => r.below_reorder).length
  const inQc = shown.filter((r) => Number(r.quarantine) > 0).length
  const reserved = shown.filter((r) => Number(r.reserved) > 0).length
  const values = shown.map((r) => r.stock_value).filter((v): v is number => v !== null && v !== undefined)
  const value = values.length ? values.reduce((a, b) => a + Number(b), 0) : null

  const columns: Column<Row>[] = [
    {
      key: 'item',
      header: t('inventoryCommon.itemStock.col.item'),
      render: (r) => (
        <button type="button" className="sf-btn" data-variant="link" style={{ textAlign: 'left', padding: 0, minHeight: 24, height: 'auto' }} aria-pressed={selected === r.product_id} onClick={() => setSelected(r.product_id)}>
          <span style={{ display: 'flex', flexDirection: 'column' }}>
            <strong>
              <span className="sr-only">{t('inventoryCommon.itemStock.openAria')} </span>
              {r.product_name}
            </strong>
            <span className="k mono">{[r.product_code, r.group_name].filter(Boolean).join(' · ')}</span>
          </span>
        </button>
      ),
    },
    { key: 'total', header: variant === 'raw' ? t('inventoryCommon.itemStock.col.onHand') : t('inventoryCommon.itemStock.col.good'), align: 'right', render: (r) => <Qty value={variant === 'raw' ? r.total : r.sellable} /> },
    ...(variant === 'raw'
      ? [{ key: 'reserved', header: t('inventoryCommon.itemStock.col.reserved'), align: 'right' as const, render: (r: Row) => <Qty value={r.reserved} /> }]
      : []),
    { key: 'qc', header: t('inventoryCommon.itemStock.col.qc'), align: 'right', render: (r) => <Qty value={r.quarantine} /> },
    ...(variant === 'component'
      ? [{ key: 'reserved', header: t('inventoryCommon.itemStock.col.reserved'), align: 'right' as const, render: (r: Row) => <Qty value={r.reserved} /> }]
      : []),
    { key: 'transit', header: t('inventoryCommon.itemStock.col.transit'), align: 'right', render: (r) => <Qty value={r.in_transit} /> },
    { key: 'free', header: t('inventoryCommon.itemStock.col.available'), align: 'right', render: (r) => <strong data-testid={`free-${r.product_code}`}><Qty value={r.free} /></strong> },
    { key: 'min', header: t('inventoryCommon.itemStock.col.minimum'), align: 'right', render: (r) => <span className="k"><Qty value={r.reorder_level} /></span> },
    { key: 'uom', header: t('inventoryCommon.itemStock.col.uom'), render: (r) => <span className="k">{r.uom}</span> },
    {
      key: 'status',
      header: t('inventoryCommon.itemStock.col.status'),
      render: (r) =>
        r.below_reorder ? (
          <Chip tone="danger">{r.reorder_qty ? t('inventoryCommon.itemStock.belowReorder', { qty: r.reorder_qty }) : t('inventoryCommon.itemStock.below')}</Chip>
        ) : Number(r.total) === 0 ? (
          <Chip tone="neutral">{t('inventoryCommon.itemStock.none')}</Chip>
        ) : (
          <Chip tone="success">{t('inventoryCommon.itemStock.ok')}</Chip>
        ),
    },
  ]

  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          rights.create ? (
            <>
              <Link className="sf-btn" to={`/inventory/stock-movements${qs}${qs ? '&' : '?'}tab=issue`}>
                {t('inventoryCommon.itemStock.issue')}
              </Link>
              <Link className="sf-btn" data-variant="primary" to={`/purchase/goods-receipt${qs}`}>
                {t('inventoryCommon.itemStock.receive')}
              </Link>
            </>
          ) : null
        }
      />
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: 16 }}>
        {kinds.length > 1 ? (
          <Tabs
            label={t('inventoryCommon.itemStock.kinds')}
            value={kind}
            onChange={setKind}
            tabs={[{ key: 'all', label: `${t('common.all')} ${rows.length}` }, ...kinds.map((k) => ({ key: k, label: `${t(`inventoryCommon.kind.${k}`, { defaultValue: k })} ${rows.filter((r) => r.product_kind === k).length}` }))]}
          />
        ) : (
          <span />
        )}
        <CompanyPicker list={choice.list} value={companyId} onChange={choice.choose} />
      </div>
      {choice.isLoading ? (
        <Card>
          <Skeleton height={80} />
        </Card>
      ) : !companyId ? (
        <Card>
          <EmptyState title={t('inventoryCommon.noCompany')} />
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <KpiTiles
            ariaLabel={t('inventoryCommon.itemStock.kpis')}
            items={[
              { key: 'below', label: t('inventoryCommon.itemStock.kpiBelow'), value: <span data-negative={below > 0 ? 'true' : undefined} className="sf-amount">{t('inventoryCommon.itemStock.items', { count: below })}</span> },
              { key: 'qc', label: t('inventoryCommon.itemStock.kpiQc'), value: t('inventoryCommon.itemStock.items', { count: inQc }) },
              { key: 'res', label: t('inventoryCommon.itemStock.kpiReserved'), value: t('inventoryCommon.itemStock.items', { count: reserved }) },
              {
                key: 'value',
                label: t('inventoryCommon.itemStock.kpiValue'),
                value: rights.costs && value !== null ? <Amount value={value} rupee /> : '—',
                sub: t('inventoryCommon.itemStock.kpiValueSub'),
              },
            ]}
          />
          <div style={{ display: 'grid', gridTemplateColumns: sel ? 'minmax(0, 2fr) minmax(300px, 1fr)' : 'minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
            <Card pad={false}>
              <DataTable
                caption={title}
                columns={columns}
                rows={shown}
                rowKey={(r) => r.product_id}
                loading={q.isLoading}
                minWidth={860}
                empty={<EmptyState title={t('inventoryCommon.itemStock.emptyTitle')} body={t('inventoryCommon.itemStock.emptyBody')} />}
                rowTone={(r) => (r.below_reorder ? 'signal' : undefined)}
              />
              <p className="k" style={{ margin: 0, padding: '10px 16px' }}>
                {t('inventoryCommon.itemStock.foot')}
              </p>
            </Card>
            {sel && companyId ? <ItemPanel key={sel.product_id} companyId={companyId} item={sel} onClose={() => setSelected(null)} /> : null}
          </div>
        </div>
      )}
    </>
  )
}

function ItemPanel({ companyId, item, onClose }: { companyId: string; item: Row; onClose: () => void }) {
  const { t } = useTranslation()
  const moveLabel = useMoveLabel()
  const lq = useApiView('lots', { eq: { company_id: companyId, product_id: item.product_id }, order: 'received_at', limit: 50 })
  const lots = rowsOf(lq)
    .filter((l) => Number(l.qty_on_hand) > 0)
    .sort((a, b) => (a.expiry_date ?? '9999').localeCompare(b.expiry_date ?? '9999') || a.received_at.localeCompare(b.received_at))
  const oldest = lots.find((l) => l.status === 'available')
  const mq = useStockMovements(companyId, { product: item.product_id, limit: 6 })
  const moves = mq.data ?? []
  return (
    <Card
      title={item.product_name}
      action={
        <button type="button" className="sf-btn" data-variant="link" data-size="sm" onClick={onClose}>
          {t('common.close')}
        </button>
      }
    >
      <p className="k" style={{ marginTop: 0 }}>
        {t('inventoryCommon.itemStock.lotsCount', { code: item.product_code, count: lots.length })}
      </p>
      {lq.isLoading ? (
        <Skeleton height={40} />
      ) : lots.length === 0 ? (
        <p className="muted">{t('inventoryCommon.itemStock.noLots')}</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {lots.map((l) => (
            <li key={l.id} className="sf-card sf-card__pad" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ display: 'flex', flexDirection: 'column' }}>
                <strong className="mono">{l.lot_no}</strong>
                <span className="k">
                  {t('inventoryCommon.itemStock.lotReceived', { date: formatDate(l.received_at) })}
                  {l.grn_no ? ` · ${l.grn_no}` : ''}
                  {l.expiry_date ? ` · ${t('inventoryCommon.itemStock.expires', { date: formatDate(l.expiry_date) })}` : ''}
                </span>
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                <Qty value={l.qty_on_hand} uom={l.uom} />
                <StockStatus status={l.status} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {oldest ? <p className="k">{t('inventoryCommon.itemStock.oldestFirst', { lot: oldest.lot_no })}</p> : null}
      <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>{t('inventoryCommon.itemStock.recent')}</h3>
      {mq.isLoading ? (
        <Skeleton height={40} />
      ) : moves.length === 0 ? (
        <p className="muted">{t('inventoryCommon.itemStock.noMoves')}</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {moves.map((m) => (
            <li key={m.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span className="k">
                <span className="mono">
                  {formatDate(m.move_date)} {formatTime(m.created_at)}
                </span>{' '}
                · {moveLabel(m.move_type)} {m.doc_no ?? ''} · {m.place_name}
              </span>
              <strong>
                <Qty value={m.qty} signed />
              </strong>
            </li>
          ))}
        </ul>
      )}
      <p style={{ marginBottom: 0 }}>
        <Link to={`/inventory/stock-movements?company=${companyId}&product=${item.product_id}`}>{t('inventoryCommon.itemStock.ledger')}</Link>
      </p>
    </Card>
  )
}

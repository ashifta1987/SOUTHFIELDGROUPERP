import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { TableCard } from '@/features/admin/import-data/layout'
import { qtyText } from '@/features/inventory/common/inventory'
import { formatDate } from '@/shared/format'
import { Button, Card, Chip, DataTable, EmptyState, type Column } from '@/ui'
import { CostCell, ProdStatus, useProductionRights, ViewError } from '../biochem-common/biochem'
import { CostHiddenBanner, PlasticsFrame } from '../plastics-common/plastics'

type Bom = ViewRow<'assembly_boms'>
type Cost = ViewRow<'assembly_costs'>

/**
 * Assembled products (`AssemblyCosting`): the cost of each assembled product from its approved BOM — every component at
 * its average stock cost (api.assembly_costs, cost right only), with components that have no cost counted and shown,
 * never guessed — next to its MRP, plus the cost per unit fixed on each assembly order. Without the cost right every
 * money column is hidden, never zero.
 */
export function AssembledProductsPage() {
  const { t } = useTranslation()
  return (
    <PlasticsFrame step="assembly" title={t('plAssembled.title')} subtitle={t('plAssembled.subtitle')}>
      {(companyId) => <Assembled companyId={companyId} />}
    </PlasticsFrame>
  )
}

function Assembled({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const boms = useApiView('assembly_boms', { eq: { company_id: companyId, status: 'approved' }, order: 'product_code', limit: 1000 })
  const costs = useApiView('assembly_costs', { eq: { company_id: companyId }, limit: 1000, enabled: rights.costs })
  const orders = useApiView('assembly_orders', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 200 })
  const byId = new Map<string, Cost>(rowsOf(costs).map((c) => [c.bom_id, c]))
  const [selected, setSelected] = useState<string | null>(null)
  const current = rowsOf(boms).find((b) => b.id === selected) ?? null
  const gaps = rowsOf(costs).filter((c) => (c.components_without_cost ?? 0) > 0)
  const cols: Column<Bom>[] = [
    {
      key: 'product',
      header: t('plAssembled.col.product'),
      render: (b) => (
        <Button size="sm" variant="link" onClick={() => setSelected(b.id)} aria-label={t('plAssembled.openOne', { code: b.product_code, name: b.product_name })}>
          {b.product_code} · {b.product_name}
        </Button>
      ),
    },
    { key: 'v', header: t('plAssembled.col.bom'), align: 'right', render: (b) => <span className="sf-amount">v{b.version}</span> },
    { key: 'lines', header: t('plAssembled.col.parts'), align: 'right', render: (b) => <span className="sf-amount">{b.lines ?? 0}</span> },
    { key: 'cost', header: t('plAssembled.col.components'), align: 'right', render: (b) => <span data-testid={`ap-cost-${b.product_code}`}><CostCell value={byId.get(b.id)?.components_cost} /></span> },
    {
      key: 'gap',
      header: t('plAssembled.col.withoutCost'),
      render: (b) => {
        const n = byId.get(b.id)?.components_without_cost
        return rights.costs && n ? <Chip tone="signal" icon="alert">{t('plAssembled.withoutCost', { n })}</Chip> : <span className="k">—</span>
      },
    },
    { key: 'mrp', header: t('plAssembled.col.mrp'), align: 'right', render: (b) => <CostCell value={byId.get(b.id)?.mrp} /> },
  ]
  const orderCols: Column<ViewRow<'assembly_orders'>>[] = [
    { key: 'doc', header: t('plAssembled.o.doc'), render: (o) => <span className="mono">{o.doc_no}</span> },
    { key: 'date', header: t('plAssembled.o.date'), render: (o) => formatDate(o.order_date) },
    { key: 'product', header: t('plAssembled.col.product'), render: (o) => `${o.product_code} · ${o.product_name}` },
    { key: 'qty', header: t('plAssembled.o.qty'), align: 'right', render: (o) => <span className="sf-amount">{qtyText(o.qty)}</span> },
    { key: 'hours', header: t('plAssembled.o.hours'), align: 'right', render: (o) => <span className="sf-amount">{qtyText(o.labour_hours)}</span> },
    { key: 'lot', header: t('plAssembled.o.lot'), render: (o) => <ProdStatus status={o.lot_status} /> },
    { key: 'unit', header: t('plAssembled.o.unitCost'), align: 'right', render: (o) => <CostCell value={o.unit_cost} digits={4} /> },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card title={t('plAssembled.how.title')}>
        <p className="mono" style={{ margin: '0 0 12px', padding: '10px 12px', background: 'var(--sf-paper)', borderRadius: 6 }}>
          {t('plAssembled.how.formula')}
        </p>
        <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          {['moulding', 'printing', 'assembly', 'packing', 'qc', 'stock'].map((k) => (
            <li key={k}>{t(`plAssembled.how.step.${k}`)}</li>
          ))}
        </ol>
      </Card>
      {!rights.costs ? <CostHiddenBanner /> : null}
      {gaps.length ? (
        <div role="alert" className="sf-alert" data-tone="signal" style={{ margin: 0, flexDirection: 'column' }} data-testid="assembly-cost-gaps">
          <strong>{t('plAssembled.gapsTitle', { n: gaps.length })}</strong>
          <span>{gaps.map((g) => g.product_code).join(', ')}</span>
        </div>
      ) : null}
      <ViewError error={boms.error ?? costs.error ?? orders.error} />
      <TableCard title={t('plAssembled.listTitle')}>
        <DataTable caption={t('plAssembled.listTitle')} columns={cols} rows={rowsOf(boms)} rowKey={(b) => b.id} loading={boms.isLoading} minWidth={900} empty={<EmptyState title={t('plAssembled.emptyTitle')} body={t('plAssembled.emptyBody')} />} />
      </TableCard>
      {current ? <Lines bom={current} onClose={() => setSelected(null)} /> : null}
      <TableCard title={t('plAssembled.ordersTitle')}>
        <DataTable caption={t('plAssembled.ordersTitle')} columns={orderCols} rows={rowsOf(orders)} rowKey={(o) => o.id} loading={orders.isLoading} minWidth={860} empty={<EmptyState title={t('plAssembled.ordersEmpty')} />} />
      </TableCard>
    </div>
  )
}

function Lines({ bom, onClose }: { bom: Bom; onClose: () => void }) {
  const { t } = useTranslation()
  const lines = useApiView('assembly_bom_lines', { eq: { bom_id: bom.id }, order: 'product_code' })
  const cols: Column<ViewRow<'assembly_bom_lines'>>[] = [
    { key: 'item', header: t('plAssembled.l.item'), render: (l) => `${l.product_code} · ${l.product_name}` },
    { key: 'qty', header: t('plAssembled.l.qty'), align: 'right', render: (l) => <span className="sf-amount">{qtyText(l.qty_per)} {l.uom}</span> },
    { key: 'cost', header: t('plAssembled.l.avgCost'), align: 'right', render: (l) => <CostCell value={l.avg_cost} digits={4} /> },
  ]
  return (
    <TableCard
      title={t('plAssembled.l.title', { code: bom.product_code, v: bom.version })}
      action={
        <Button size="sm" variant="link" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <DataTable caption={t('plAssembled.l.title', { code: bom.product_code, v: bom.version })} columns={cols} rows={rowsOf(lines)} rowKey={(l) => l.id} loading={lines.isLoading} minWidth={560} empty={<EmptyState title={t('plAssembled.l.empty')} />} />
    </TableCard>
  )
}

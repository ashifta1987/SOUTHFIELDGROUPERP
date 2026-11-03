import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { TableCard } from '@/features/admin/import-data/layout'
import { qtyText } from '@/features/inventory/common/inventory'
import { Card, DataTable, EmptyState, type Column } from '@/ui'
import { CostCell, useProductionRights, ViewError } from '../biochem-common/biochem'
import { CostHiddenBanner, PlasticsFrame } from '../plastics-common/plastics'

type Mould = ViewRow<'moulds'>
type MouldCost = ViewRow<'mould_costs'>

/**
 * Mould costing (`MouldCosting`): what each mould cost and what it adds to every piece — cost plus upkeep (services and
 * repairs) spread over its life in shots, divided by cavities (computed by api.mould_costs, which needs the cost right).
 * Without the cost right the moulds are listed with every money column hidden, never zero. Quotation cost sheets for a
 * buyer's new mould are not built yet (no tables for steel lines and machining hours).
 */
export function MouldCostingPage() {
  const { t } = useTranslation()
  return (
    <PlasticsFrame step="mouldCosting" title={t('plMouldCosting.title')} subtitle={t('plMouldCosting.subtitle')}>
      {(companyId) => <Costs companyId={companyId} />}
    </PlasticsFrame>
  )
}

function Costs({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const moulds = useApiView('moulds', { eq: { company_id: companyId }, order: 'code', limit: 2000 })
  const costs = useApiView('mould_costs', { eq: { company_id: companyId }, limit: 2000, enabled: rights.costs })
  const byId = new Map<string, MouldCost>(rowsOf(costs).map((c) => [c.mould_id, c]))
  const rows = rowsOf(moulds)
  const noCost = rights.costs ? rows.filter((m) => byId.get(m.id)?.cost === null || !byId.has(m.id)) : []
  const cols: Column<Mould>[] = [
    { key: 'code', header: t('plMouldCosting.col.mould'), render: (m) => <span><span className="mono">{m.code}</span> · {m.name}</span> },
    { key: 'product', header: t('plMouldCosting.col.product'), render: (m) => m.product_name ?? '—' },
    { key: 'cav', header: t('plMouldCosting.col.cavities'), align: 'right', render: (m) => <span className="sf-amount">{m.cavities}</span> },
    { key: 'shots', header: t('plMouldCosting.col.shots'), align: 'right', render: (m) => <span className="sf-amount">{qtyText(m.shot_count)}</span> },
    { key: 'life', header: t('plMouldCosting.col.life'), align: 'right', render: (m) => <span className="sf-amount">{qtyText(m.life_shots)}</span> },
    { key: 'cost', header: t('plMouldCosting.col.cost'), align: 'right', render: (m) => <CostCell value={byId.get(m.id)?.cost} /> },
    { key: 'upkeep', header: t('plMouldCosting.col.upkeep'), align: 'right', render: (m) => <CostCell value={byId.get(m.id)?.upkeep} /> },
    { key: 'shot', header: t('plMouldCosting.col.perShot'), align: 'right', render: (m) => <CostCell value={byId.get(m.id)?.cost_per_shot} digits={4} /> },
    { key: 'piece', header: t('plMouldCosting.col.perPiece'), align: 'right', render: (m) => <span data-testid={`mc-piece-${m.code}`}><CostCell value={byId.get(m.id)?.cost_per_piece} digits={4} /></span> },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card title={t('plMouldCosting.how.title')}>
        <p className="mono" style={{ margin: '0 0 12px', padding: '10px 12px', background: 'var(--sf-paper)', borderRadius: 6 }}>
          {t('plMouldCosting.how.formula')}
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          {['cost', 'upkeep', 'life', 'cavities'].map((k) => (
            <div key={k}>
              <strong>{t(`plMouldCosting.how.${k}.title`)}</strong>
              <div className="muted">{t(`plMouldCosting.how.${k}.body`)}</div>
            </div>
          ))}
        </div>
      </Card>
      {!rights.costs ? <CostHiddenBanner /> : null}
      {noCost.length ? (
        <div role="alert" className="sf-alert" data-tone="signal" style={{ margin: 0, flexDirection: 'column' }} data-testid="mould-cost-missing">
          <strong>{t('plMouldCosting.missingTitle', { n: noCost.length })}</strong>
          <span>{noCost.slice(0, 20).map((m) => m.code).join(', ')}</span>
          <span>{t('plMouldCosting.missingNext')}</span>
        </div>
      ) : null}
      <ViewError error={moulds.error ?? costs.error} />
      <TableCard title={t('plMouldCosting.listTitle')}>
        <DataTable caption={t('plMouldCosting.listTitle')} columns={cols} rows={rows} rowKey={(m) => m.id} loading={moulds.isLoading || (rights.costs && costs.isLoading)} minWidth={1100} empty={<EmptyState title={t('plMouldCosting.emptyTitle')} body={t('plMouldCosting.emptyBody')} />} />
      </TableCard>
      <Card title={t('plMouldCosting.quote.title')}>
        <p className="muted" style={{ margin: 0 }}>
          {t('plMouldCosting.quote.body')}
        </p>
      </Card>
    </div>
  )
}

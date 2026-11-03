import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard, TWO_COLS } from '@/features/admin/import-data/layout'
import { formatDate } from '@/shared/format'
import { Card, Chip, DataTable, EmptyState, PageHeader, Skeleton, Tabs, type Column } from '@/ui'
import { Qty, useInventoryRights, useStockPlaces } from '../common/inventory'
import { Quarantine } from './Quarantine'
import { Counts } from './Counts'
import { NegativeStock, OpeningStock, ReorderLevels } from './Setup'

type Tab = 'tasks' | 'qc' | 'counts' | 'places' | 'reorder' | 'opening' | 'negative'
const TABS: Tab[] = ['tasks', 'qc', 'counts', 'places', 'reorder', 'opening', 'negative']
type Task = ViewRow<'warehouse_tasks'>

/**
 * Warehouse (`Warehouse`): the stores jobs from api.warehouse_tasks (to receive, to test, to put away, to pick, to hand
 * over, counts due), QC quarantine (incoming test and release by someone other than the receiver), blind cycle counts
 * posted by someone who did not count, places and what they hold, reorder levels, opening stock (Admin) and the
 * logged negative-stock allowance (Admin). Every rule is enforced by the database; the screen explains refusals.
 */
export function WarehousePage() {
  const { t } = useTranslation()
  const rights = useInventoryRights()
  const [params, setParams] = useSearchParams()
  const wanted = params.get('tab') as Tab | null
  const tab: Tab = wanted && TABS.includes(wanted) ? wanted : 'tasks'
  const choice = useCompanyChoice()
  const companyId = choice.companyId

  function setTab(k: Tab) {
    const next = new URLSearchParams(params)
    next.set('tab', k)
    setParams(next, { replace: true })
  }

  const tabs = TABS.filter((k) => (k === 'opening' ? rights.approve || rights.readOnly : k === 'negative' ? rights.admin || rights.readOnly : true))

  return (
    <>
      <PageHeader title={t('warehouse.title')} subtitle={t('warehouse.subtitle')} />
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: 16 }}>
        <Tabs label={t('warehouse.tabs')} value={tab} onChange={setTab} idBase="wh" controls="wh-panel" tabs={tabs.map((k) => ({ key: k, label: t(`warehouse.tab.${k}`) }))} />
        <CompanyPicker list={choice.list} value={companyId} onChange={choice.choose} />
      </div>
      <div id="wh-panel" role="tabpanel" aria-labelledby={`wh-tab-${tab}`} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {choice.isLoading ? (
          <Card>
            <Skeleton height={80} />
          </Card>
        ) : !companyId ? (
          <Card>
            <EmptyState title={t('inventoryCommon.noCompany')} />
          </Card>
        ) : tab === 'tasks' ? (
          <Tasks key={companyId} companyId={companyId} />
        ) : tab === 'qc' ? (
          <Quarantine key={companyId} companyId={companyId} />
        ) : tab === 'counts' ? (
          <Counts key={companyId} companyId={companyId} countParam={params.get('count')} />
        ) : tab === 'places' ? (
          <Places key={companyId} companyId={companyId} />
        ) : tab === 'reorder' ? (
          <ReorderLevels key={companyId} companyId={companyId} />
        ) : tab === 'opening' ? (
          <OpeningStock key={companyId} companyId={companyId} />
        ) : (
          <NegativeStock key={companyId} companyId={companyId} />
        )}
      </div>
    </>
  )
}

function Tasks({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const q = useApiView('warehouse_tasks', { eq: { company_id: companyId }, order: 'due_date', limit: 500 })
  const rows = rowsOf(q)
  const kinds = ['receive_order', 'test_lot', 'put_away', 'pick_transfer', 'hand_over_transfer', 'receive_transfer', 'count_due']
  const columns: Column<Task>[] = [
    { key: 'kind', header: t('warehouse.tasks.col.kind'), render: (r) => <Chip tone={r.task_kind === 'test_lot' ? 'signal' : r.task_kind?.includes('transfer') ? 'transit' : 'info'}>{t(`warehouse.tasks.kind.${r.task_kind ?? ''}`, { defaultValue: r.task_kind ?? '' })}</Chip> },
    { key: 'ref', header: t('warehouse.tasks.col.ref'), render: (r) => <span className="mono">{r.ref_no ?? '—'}</span> },
    { key: 'title', header: t('warehouse.tasks.col.title'), render: (r) => r.title ?? '' },
    { key: 'place', header: t('warehouse.tasks.col.place'), render: (r) => r.place_name ?? '—' },
    { key: 'qty', header: t('warehouse.tasks.col.qty'), align: 'right', render: (r) => <Qty value={r.qty} /> },
    { key: 'due', header: t('warehouse.tasks.col.due'), render: (r) => (r.due_date ? <span className="mono">{formatDate(r.due_date)}</span> : '—') },
    {
      key: 'open',
      header: <span className="sr-only">{t('warehouse.tasks.col.open')}</span>,
      render: (r) => {
        const href = r.task_kind === 'test_lot' ? `/inventory/warehouse?company=${companyId}&tab=qc&lot=${r.ref_id ?? ''}` : r.task_kind === 'count_due' ? `/inventory/warehouse?company=${companyId}&tab=counts&count=${r.ref_id ?? ''}` : r.ref_table === 'inv.transfers' ? `/inventory/stock-transfers?company=${companyId}&transfer=${r.ref_id ?? ''}` : r.ref_table === 'purch.orders' ? `/purchase/goods-receipt?company=${companyId}&order=${r.ref_id ?? ''}` : `${r.href ?? '/inventory/warehouse'}?company=${companyId}`
        return (
          <Link to={href} aria-label={t('warehouse.tasks.openAria', { ref: r.ref_no ?? '' })}>
            {t('warehouse.tasks.open')}
          </Link>
        )
      },
    },
  ]
  return (
    <>
      <section className="sf-card sf-kpis" aria-label={t('warehouse.tasks.summary')}>
        {kinds.map((k) => (
          <div key={k} className="sf-kpi">
            <span className="k">{t(`warehouse.tasks.kind.${k}`)}</span>
            <span className="sf-kpi__value">{rows.filter((r) => r.task_kind === k).length}</span>
          </div>
        ))}
      </section>
      <TableCard title={t('warehouse.tasks.title')}>
        <DataTable caption={t('warehouse.tasks.title')} columns={columns} rows={rows} rowKey={(r) => `${r.task_kind}-${r.ref_id}-${r.place_id}`} loading={q.isLoading} minWidth={860} empty={<EmptyState title={t('warehouse.tasks.emptyTitle')} body={t('warehouse.tasks.emptyBody')} />} />
      </TableCard>
      <div style={TWO_COLS}>
        <Card title={t('warehouse.rules.title')}>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {['status', 'expiry', 'once', 'back', 'counts', 'zero'].map((k) => (
              <li key={k}>
                <strong>{t(`warehouse.rules.${k}.title`)}</strong> {t(`warehouse.rules.${k}.body`)}
              </li>
            ))}
          </ul>
        </Card>
        <Card title={t('warehouse.loop.title')}>
          <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {['receive', 'test', 'put', 'pick', 'issue', 'back', 'release', 'order', 'dispatch'].map((k) => (
              <li key={k}>{t(`warehouse.loop.${k}`)}</li>
            ))}
          </ol>
          <p className="k" style={{ marginBottom: 0 }}>
            {t('warehouse.loop.returns')}
          </p>
        </Card>
      </div>
    </>
  )
}

const PLACE_STATUS: Record<string, 'onHold' | 'usable' | 'manufacturing' | 'onTheWay' | 'blocked'> = {
  stores: 'usable',
  quarantine: 'onHold',
  wip: 'manufacturing',
  fg_hold: 'onHold',
  fg_released: 'usable',
  damage: 'blocked',
  transit: 'onTheWay',
  van: 'onTheWay',
  agent_consignment: 'onTheWay',
  other: 'usable',
}

function Places({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const places = useStockPlaces(companyId)
  const sq = useApiView('stock_summary', { eq: { company_id: companyId }, limit: 5000 })
  const summary = rowsOf(sq)
  type P = ViewRow<'places'>
  const columns: Column<P>[] = [
    { key: 'place', header: t('warehouse.places.col.place'), render: (p) => <span style={{ display: 'flex', flexDirection: 'column' }}><strong>{p.name}</strong><span className="k mono">{p.code}</span></span> },
    { key: 'branch', header: t('warehouse.places.col.branch'), render: (p) => p.branch_name },
    { key: 'kind', header: t('warehouse.places.col.holds'), render: (p) => t(`inventoryCommon.placeKind.${p.kind}`, { defaultValue: p.kind }) },
    { key: 'status', header: t('warehouse.places.col.status'), render: (p) => t(`warehouse.places.status.${PLACE_STATUS[p.kind] ?? 'usable'}`) },
    { key: 'items', header: t('warehouse.places.col.items'), align: 'right', render: (p) => summary.filter((s) => s.place_id === p.id && Number(s.total) !== 0).length },
    { key: 'qc', header: t('warehouse.places.col.qc'), align: 'right', render: (p) => summary.filter((s) => s.place_id === p.id && Number(s.quarantine) > 0).length },
    { key: 'transit', header: t('warehouse.places.col.transit'), align: 'right', render: (p) => summary.filter((s) => s.place_id === p.id && Number(s.in_transit) > 0).length },
  ]
  return (
    <TableCard title={t('warehouse.places.title')}>
      <DataTable caption={t('warehouse.places.title')} columns={columns} rows={places.list} rowKey={(p) => p.id} loading={places.isLoading || sq.isLoading} minWidth={820} empty={<EmptyState title={t('warehouse.places.emptyTitle')} body={t('warehouse.places.emptyBody')} />} />
      <p className="k" style={{ margin: 0, padding: '10px 16px' }}>
        {t('warehouse.places.note')}
      </p>
    </TableCard>
  )
}

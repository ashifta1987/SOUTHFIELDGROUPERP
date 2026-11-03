import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { formatDate, formatTime } from '@/shared/format'
import { Amount, Button, Card, ConfirmDialog, DataTable, EmptyState, Field, FieldGrid, PageHeader, SelectField, Skeleton, Tabs, type Column } from '@/ui'
import { cleanQty, InventoryErrorBox, placeLabel, Qty, STOCK_REFRESH, StockStatus, useInventoryRights, useMoveLabel, useStockItems, useStockMovements, useStockPlaces } from '../common/inventory'

type Tab = 'issue' | 'return'
type Move = ViewRow<'stock_movements'>
const MOVE_TYPES = ['opening', 'receipt', 'issue', 'issue_in', 'return', 'release', 'reject', 'adjustment', 'transit_out', 'transit_in', 'transfer_in', 'transfer_return', 'write_off', 'scrap_in', 'regrind', 'scrap_sale', 'reversal']
const TARGETS = ['production', 'batch', 'job', 'cost_centre', 'maintenance', 'other']

/**
 * Stock movements (`StockMovement`): issue material to production, a batch, a job or a cost centre, return unused
 * material, and the full stock ledger with filters. Every movement has a document, a reason and a user; the database
 * takes the earliest-expiry released lot first and refuses anything that would take stock below zero
 * (api.issue_stock, api.return_stock). Transfers, scrap and counts have their own screens.
 */
export function StockMovementsPage() {
  const { t } = useTranslation()
  const rights = useInventoryRights()
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('tab') === 'return' ? 'return' : 'issue'
  const choice = useCompanyChoice()
  const companyId = choice.companyId
  const qs = companyId ? `?company=${companyId}` : ''

  function setTab(k: Tab) {
    const next = new URLSearchParams(params)
    next.set('tab', k)
    setParams(next, { replace: true })
  }

  return (
    <>
      <PageHeader title={t('stockMovements.title')} subtitle={t('stockMovements.subtitle')} />
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <Tabs
            variant="segmented"
            label={t('stockMovements.tabs')}
            value={tab}
            onChange={setTab}
            idBase="mv"
            controls="mv-panel"
            tabs={[
              { key: 'issue', label: t('stockMovements.tabIssue') },
              { key: 'return', label: t('stockMovements.tabReturn') },
            ]}
          />
          <Link to={`/inventory/stock-transfers${qs}`}>{t('stockMovements.toTransfer')}</Link>
          <Link to={`/inventory/scrap-and-regrind${qs}`}>{t('stockMovements.toScrap')}</Link>
          <Link to={`/inventory/warehouse${qs}${qs ? '&' : '?'}tab=counts`}>{t('stockMovements.toCount')}</Link>
        </div>
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
          <div id="mv-panel" role="tabpanel" aria-labelledby={`mv-tab-${tab}`}>
            {!rights.create ? (
              <Card>
                <p className="muted" style={{ margin: 0 }}>
                  {rights.readOnly ? t('stockMovements.readOnly') : t('stockMovements.noRight')}
                </p>
              </Card>
            ) : tab === 'issue' ? (
              <IssueForm key={companyId} companyId={companyId} productParam={params.get('product')} />
            ) : (
              <ReturnForm key={companyId} companyId={companyId} />
            )}
          </div>
          <Ledger key={`l-${companyId}`} companyId={companyId} productParam={params.get('product')} />
        </div>
      )}
    </>
  )
}

/** Released stock of an item at a store, by lot (for the lot picker and the "available here" hint). */
function useAvailableAt(companyId: string, productId: string, placeId: string) {
  const q = useApiView('stock_on_hand', { eq: { company_id: companyId, product_id: productId, place_id: placeId, bucket: 'available' }, limit: 200, enabled: Boolean(productId && placeId) })
  const rows = rowsOf(q)
  return { rows, total: rows.reduce((a, r) => a + Number(r.qty), 0), isLoading: q.isLoading }
}

function IssueForm({ companyId, productParam }: { companyId: string; productParam: string | null }) {
  const { t } = useTranslation()
  const items = useStockItems(companyId).list
  const places = useStockPlaces(companyId).list
  const [product, setProduct] = useState(productParam ?? '')
  const [place, setPlace] = useState('')
  const [lot, setLot] = useState('')
  const [qty, setQty] = useState('')
  const [target, setTarget] = useState('production')
  const [ref, setRef] = useState('')
  const [costCentre, setCostCentre] = useState('')
  const [toPlace, setToPlace] = useState('')
  const [reason, setReason] = useState('')
  const [date, setDate] = useState(todayIst())
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [confirm, setConfirm] = useState(false)
  const [done, setDone] = useState<{ doc_no: string } | null>(null)
  const avail = useAvailableAt(companyId, product, place)
  const m = useApiMutation<Record<string, unknown>, { issue_id: string; doc_no: string; pieces: { lot_id: string | null; qty: number }[] }>('issue_stock', STOCK_REFRESH)
  const item = items.find((i) => i.id === product)
  const lotRows = avail.rows.filter((r) => r.lot_id)

  function review() {
    setDone(null)
    m.reset()
    const e: Record<string, string> = {}
    if (!product) e.product = t('stockMovements.err.product')
    if (!place) e.place = t('stockMovements.err.place')
    if (!cleanQty(qty)) e.qty = t('stockMovements.err.qty')
    if (!ref.trim() && !costCentre.trim()) e.ref = t('stockMovements.err.ref')
    setErrs(e)
    if (Object.keys(e).length === 0) setConfirm(true)
  }

  return (
    <Card title={t('stockMovements.issueTitle')}>
      <FieldGrid cols={3}>
        <SelectField label={t('stockMovements.item')} value={product} error={errs.product} placeholder={t('stockMovements.choose')} options={items.map((i) => ({ value: i.id, label: `${i.code} · ${i.name}` }))} onChange={(e) => { setProduct(e.target.value); setLot('') }} />
        <SelectField label={t('stockMovements.fromStore')} value={place} error={errs.place} placeholder={t('stockMovements.choose')} options={places.map((p) => ({ value: p.id, label: placeLabel(p) }))} onChange={(e) => { setPlace(e.target.value); setLot('') }} />
        <SelectField label={t('stockMovements.lot')} value={lot} placeholder={t('stockMovements.lotAuto')} options={lotRows.map((r) => ({ value: r.lot_id ?? '', label: `${r.lot_no ?? ''} · ${r.qty} ${r.expiry_date ? `· ${formatDate(r.expiry_date)}` : ''}` }))} onChange={(e) => setLot(e.target.value)} />
        <Field label={t('stockMovements.qty')} inputMode="decimal" value={qty} error={errs.qty} help={product && place ? t('stockMovements.availableHere', { qty: avail.total, uom: item?.uom ?? '' }) : undefined} onChange={(e) => setQty(e.target.value)} />
        <SelectField label={t('stockMovements.target')} value={target} options={TARGETS.map((k) => ({ value: k, label: t(`stockMovements.targets.${k}`) }))} onChange={(e) => setTarget(e.target.value)} />
        <Field label={t('stockMovements.ref')} value={ref} error={errs.ref} onChange={(e) => setRef(e.target.value)} />
        <Field label={t('stockMovements.costCentre')} value={costCentre} onChange={(e) => setCostCentre(e.target.value)} />
        <SelectField label={t('stockMovements.toPlace')} value={toPlace} placeholder={t('stockMovements.consume')} options={places.filter((p) => p.id !== place).map((p) => ({ value: p.id, label: placeLabel(p) }))} onChange={(e) => setToPlace(e.target.value)} />
        <Field type="date" label={t('stockMovements.date')} value={date} max={todayIst()} onChange={(e) => setDate(e.target.value)} />
      </FieldGrid>
      <div style={{ marginTop: 12 }}>
        <Field label={t('stockMovements.reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <p className="k">{t('stockMovements.issueNote')}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <InventoryErrorBox error={m.error as RpcError | null} />
        {done ? (
          <div role="status" className="sf-alert" data-tone="success" style={{ margin: 0 }}>
            {t('stockMovements.issued', { no: done.doc_no })}
          </div>
        ) : null}
        <div>
          <Button variant="primary" onClick={review} busy={m.isPending}>
            {t('stockMovements.postIssue')}
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('stockMovements.confirmIssue')}
        effect={t('stockMovements.confirmIssueEffect', { qty, uom: item?.uom ?? '', item: item?.name ?? '', store: places.find((p) => p.id === place)?.name ?? '' })}
        confirmLabel={t('stockMovements.postIssue')}
        busy={m.isPending}
        onConfirm={() =>
          m.mutate(
            {
              p_item_id: product,
              p_lot_id: lot || null,
              p_from_place: place,
              p_qty: cleanQty(qty),
              p_target: { kind: target, ref: ref.trim() || null, cost_centre: costCentre.trim() || null, to_place_id: toPlace || null, date, reason: reason.trim() || null },
            },
            {
              onSuccess: (r) => {
                setConfirm(false)
                setDone({ doc_no: r.doc_no })
                setQty('')
                setRef('')
                setReason('')
              },
              onError: () => setConfirm(false),
            },
          )
        }
      />
    </Card>
  )
}

function ReturnForm({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const places = useStockPlaces(companyId).list
  const iq = useApiView('stock_issues', { eq: { company_id: companyId, kind: 'issue' }, order: 'created_at', ascending: false, limit: 200 })
  const issues = rowsOf(iq).filter((i) => Number(i.qty_still_out) > 0)
  const [issueId, setIssue] = useState('')
  const [toPlace, setToPlace] = useState('')
  const [qty, setQty] = useState('')
  const [bucket, setBucket] = useState('quarantine')
  const [reason, setReason] = useState('')
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [done, setDone] = useState<string | null>(null)
  const m = useApiMutation<Record<string, unknown>, { return_id: string; doc_no: string }>('return_stock', STOCK_REFRESH)
  const issue = issues.find((i) => i.id === issueId)

  function submit() {
    setDone(null)
    m.reset()
    const e: Record<string, string> = {}
    if (!issueId) e.issue = t('stockMovements.err.issue')
    if (!toPlace && !issue?.from_place_id) e.place = t('stockMovements.err.place')
    if (!cleanQty(qty)) e.qty = t('stockMovements.err.qty')
    setErrs(e)
    if (Object.keys(e).length) return
    m.mutate(
      { p: { issue_id: issueId, to_place_id: toPlace || issue?.from_place_id, qty: cleanQty(qty), bucket, reason: reason.trim() || null, date: todayIst() } },
      {
        onSuccess: (r) => {
          setDone(r.doc_no)
          setQty('')
          setReason('')
        },
      },
    )
  }

  return (
    <Card title={t('stockMovements.returnTitle')}>
      <FieldGrid cols={3}>
        <SelectField
          label={t('stockMovements.againstIssue')}
          value={issueId}
          error={errs.issue}
          placeholder={iq.isLoading ? t('common.loading') : issues.length ? t('stockMovements.choose') : t('stockMovements.noIssues')}
          options={issues.map((i) => ({ value: i.id, label: `${i.doc_no} · ${i.product_name} · ${t('stockMovements.stillOut', { qty: i.qty_still_out, uom: i.uom })}` }))}
          onChange={(e) => setIssue(e.target.value)}
        />
        <SelectField label={t('stockMovements.returnTo')} value={toPlace || issue?.from_place_id || ''} error={errs.place} placeholder={t('stockMovements.choose')} options={places.map((p) => ({ value: p.id, label: placeLabel(p) }))} onChange={(e) => setToPlace(e.target.value)} />
        <Field label={t('stockMovements.qty')} inputMode="decimal" value={qty} error={errs.qty} onChange={(e) => setQty(e.target.value)} />
        <SelectField
          label={t('stockMovements.bucket')}
          value={bucket}
          options={[
            { value: 'quarantine', label: t('stockMovements.bucketQc') },
            { value: 'available', label: t('stockMovements.bucketStock') },
          ]}
          onChange={(e) => setBucket(e.target.value)}
        />
        <Field label={t('stockMovements.reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FieldGrid>
      <p className="k">{t('stockMovements.returnNote')}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <InventoryErrorBox error={m.error as RpcError | null} />
        {done ? (
          <div role="status" className="sf-alert" data-tone="success" style={{ margin: 0 }}>
            {t('stockMovements.returned', { no: done })}
          </div>
        ) : null}
        <div>
          <Button variant="primary" onClick={submit} busy={m.isPending}>
            {t('stockMovements.postReturn')}
          </Button>
        </div>
      </div>
    </Card>
  )
}

function Ledger({ companyId, productParam }: { companyId: string; productParam: string | null }) {
  const { t } = useTranslation()
  const rights = useInventoryRights()
  const moveLabel = useMoveLabel()
  const items = useStockItems(companyId).list
  const places = useStockPlaces(companyId).list
  const [product, setProduct] = useState(productParam ?? '')
  const [place, setPlace] = useState('')
  const [type, setType] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const q = useStockMovements(companyId, { product, place, type, from, to, limit: 500 })
  const rows = q.data ?? []
  const columns: Column<Move>[] = [
    {
      key: 'when',
      header: t('stockMovements.col.when'),
      render: (r) => (
        <span className="mono">
          {formatDate(r.move_date)} {formatTime(r.created_at)}
        </span>
      ),
    },
    { key: 'doc', header: t('stockMovements.col.doc'), render: (r) => <span className="mono">{r.doc_no ?? '—'}</span> },
    { key: 'type', header: t('stockMovements.col.type'), render: (r) => moveLabel(r.move_type) },
    {
      key: 'item',
      header: t('stockMovements.col.item'),
      render: (r) => (
        <span>
          {r.product_name}
          {r.lot_no ? <span className="k mono"> · {r.lot_no}</span> : null}
        </span>
      ),
    },
    { key: 'qty', header: t('stockMovements.col.qty'), align: 'right', render: (r) => <Qty value={r.qty} uom={r.uom} signed /> },
    { key: 'place', header: t('stockMovements.col.place'), render: (r) => r.place_name },
    { key: 'bucket', header: t('stockMovements.col.bucket'), render: (r) => <StockStatus status={r.bucket} /> },
    ...(rights.costs ? [{ key: 'value', header: t('stockMovements.col.value'), align: 'right' as const, render: (r: Move) => <Amount value={r.value} /> }] : []),
    { key: 'by', header: t('stockMovements.col.by'), render: (r) => r.created_by_name ?? '—' },
    { key: 'note', header: t('stockMovements.col.note'), render: (r) => <span className="k">{r.note ?? ''}</span> },
  ]
  return (
    <TableCard title={t('stockMovements.ledgerTitle')}>
      <div className="sf-card__pad" style={{ paddingTop: 0 }}>
        <FieldGrid cols={3}>
          <SelectField label={t('stockMovements.filterItem')} value={product} placeholder={t('common.all')} options={items.map((i) => ({ value: i.id, label: `${i.code} · ${i.name}` }))} onChange={(e) => setProduct(e.target.value)} />
          <SelectField label={t('stockMovements.filterPlace')} value={place} placeholder={t('common.all')} options={places.map((p) => ({ value: p.id, label: placeLabel(p) }))} onChange={(e) => setPlace(e.target.value)} />
          <SelectField label={t('stockMovements.filterType')} value={type} placeholder={t('common.all')} options={MOVE_TYPES.map((k) => ({ value: k, label: moveLabel(k) }))} onChange={(e) => setType(e.target.value)} />
          <Field type="date" label={t('stockMovements.filterFrom')} value={from} onChange={(e) => setFrom(e.target.value)} />
          <Field type="date" label={t('stockMovements.filterTo')} value={to} onChange={(e) => setTo(e.target.value)} />
        </FieldGrid>
      </div>
      <DataTable
        caption={t('stockMovements.ledgerTitle')}
        columns={columns}
        rows={rows}
        rowKey={(r) => String(r.id)}
        loading={q.isLoading}
        error={q.error ? <p className="muted">{t('stockMovements.loadError')}</p> : undefined}
        minWidth={1000}
        empty={<EmptyState title={t('stockMovements.emptyTitle')} body={t('stockMovements.emptyBody')} />}
      />
    </TableCard>
  )
}

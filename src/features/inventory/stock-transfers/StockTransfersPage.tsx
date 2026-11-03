import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { formatDate } from '@/shared/format'
import { Button, Card, Chip, DataTable, EmptyState, Field, FieldGrid, PageHeader, SelectField, Skeleton, Tabs, type Column } from '@/ui'
import { cleanQty, InventoryErrorBox, placeLabel, Qty, STOCK_REFRESH, StockStatus, useBlindTransfer, useInventoryRights, useStockItems, useStockPlaces } from '../common/inventory'
import { TransferDetail } from './TransferDetail'

type Tr = ViewRow<'transfers'>
type Tab = 'open' | 'all' | 'new'
interface NLine {
  product_id: string
  qty: string
  note: string
}
const blank = (): NLine => ({ product_id: '', qty: '', note: '' })

/**
 * Stock transfers (`StockTransfer`): moves between places of one company through nine states — requested, approved
 * (by another person), reserved, picked, handed over (picker, then the carrier on their own login), in transit,
 * received (blind count, never by the picker), reconciled and closed (never by the picker or carrier). The balance rule
 * dispatched = accepted + quarantined + returned + approved loss + in transit is kept by the database; a move on the
 * same GSTIN gets a delivery challan at dispatch, a move to another GSTIN needs a posted IGST tax invoice first.
 */
export function StockTransfersPage() {
  const { t } = useTranslation()
  const rights = useInventoryRights()
  const [params, setParams] = useSearchParams()
  const wanted = params.get('tab') as Tab | null
  const tab: Tab = wanted === 'all' || wanted === 'new' ? wanted : 'open'
  const transferId = params.get('transfer')
  const choice = useCompanyChoice()
  const companyId = choice.companyId

  function patch(p: Record<string, string | null>) {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(p)) {
      if (v === null) next.delete(k)
      else next.set(k, v)
    }
    setParams(next, { replace: true })
  }

  return (
    <>
      <PageHeader title={t('stockTransfers.title')} subtitle={t('stockTransfers.subtitle')} />
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: 16 }}>
        <Tabs
          label={t('stockTransfers.tabs')}
          value={tab}
          onChange={(k) => patch({ tab: k, transfer: null })}
          idBase="tr"
          controls="tr-panel"
          tabs={[
            { key: 'open', label: t('stockTransfers.tabOpen') },
            { key: 'all', label: t('stockTransfers.tabAll') },
            ...(rights.transferCreate ? [{ key: 'new' as const, label: t('stockTransfers.tabNew') }] : []),
          ]}
        />
        <CompanyPicker list={choice.list} value={companyId} onChange={choice.choose} />
      </div>
      <div id="tr-panel" role="tabpanel" aria-labelledby={`tr-tab-${tab}`} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {choice.isLoading ? (
          <Card>
            <Skeleton height={80} />
          </Card>
        ) : !companyId ? (
          <Card>
            <EmptyState title={t('inventoryCommon.noCompany')} />
          </Card>
        ) : transferId ? (
          <TransferDetail key={transferId} companyId={companyId} transferId={transferId} onClose={() => patch({ transfer: null })} />
        ) : tab === 'new' ? (
          <NewTransfer key={companyId} companyId={companyId} onCreated={(id) => patch({ tab: 'open', transfer: id })} />
        ) : (
          <TransferList key={`${companyId}-${tab}`} companyId={companyId} openOnly={tab === 'open'} onOpen={(id) => patch({ transfer: id })} />
        )}
        <Explainers />
      </div>
    </>
  )
}

function TransferList({ companyId, openOnly, onOpen }: { companyId: string; openOnly: boolean; onOpen: (id: string) => void }) {
  const { t } = useTranslation()
  const q = useApiView('transfers', { eq: { company_id: companyId }, order: 'requested_at', ascending: false, limit: 500 })
  const rows = rowsOf(q).filter((r) => !openOnly || !['closed', 'cancelled'].includes(r.status))
  const blind = useBlindTransfer()
  const columns: Column<Tr>[] = [
    { key: 'no', header: t('stockTransfers.col.no'), render: (r) => <span className="mono">{r.doc_no}</span> },
    { key: 'date', header: t('stockTransfers.col.date'), render: (r) => <span className="mono">{formatDate(r.transfer_date)}</span> },
    { key: 'route', header: t('stockTransfers.col.route'), render: (r) => `${r.from_place_name} → ${r.to_place_name}` },
    { key: 'status', header: t('stockTransfers.col.status'), render: (r) => <StockStatus status={r.status} /> },
    { key: 'gst', header: t('stockTransfers.col.gst'), render: (r) => (r.gst_doc_kind === 'delivery_challan' ? t('stockTransfers.challan') : t('stockTransfers.taxInvoice')) },
    { key: 'disp', header: t('stockTransfers.col.dispatched'), align: 'right', render: (r) => (blind(r) ? <span className="k">{t('stockTransfers.detail.hidden')}</span> : <Qty value={r.qty_dispatched} />) },
    { key: 'transit', header: t('stockTransfers.col.inTransit'), align: 'right', render: (r) => (blind(r) ? <span className="k">{t('stockTransfers.detail.hidden')}</span> : <Qty value={r.qty_in_transit} />) },
    { key: 'by', header: t('stockTransfers.col.requestedBy'), render: (r) => r.requested_by_name ?? '—' },
    {
      key: 'open',
      header: <span className="sr-only">{t('stockTransfers.col.open')}</span>,
      render: (r) => (
        <Button size="sm" variant="link" aria-label={t('stockTransfers.openAria', { no: r.doc_no })} onClick={() => onOpen(r.id)}>
          {t('stockTransfers.open')}
        </Button>
      ),
    },
  ]
  return (
    <TableCard title={openOnly ? t('stockTransfers.openTitle') : t('stockTransfers.allTitle')}>
      <DataTable caption={openOnly ? t('stockTransfers.openTitle') : t('stockTransfers.allTitle')} columns={columns} rows={rows} rowKey={(r) => r.id} loading={q.isLoading} minWidth={980} empty={<EmptyState title={t('stockTransfers.emptyTitle')} body={t('stockTransfers.emptyBody')} />} />
    </TableCard>
  )
}

function NewTransfer({ companyId, onCreated }: { companyId: string; onCreated: (id: string) => void }) {
  const { t } = useTranslation()
  const places = useStockPlaces(companyId).list
  const items = useStockItems(companyId).list
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [neededBy, setNeededBy] = useState('')
  const [note, setNote] = useState('')
  const [lines, setLines] = useState<NLine[]>([blank()])
  const [errs, setErrs] = useState<Record<string, string>>({})
  const m = useApiMutation<{ p: Record<string, unknown> }, { id: string; doc_no: string; gst_doc_kind: string }>('request_transfer', STOCK_REFRESH)
  const fromPlace = places.find((p) => p.id === from)
  const toPlace = places.find((p) => p.id === to)

  function setLine(i: number, p: Partial<NLine>) {
    setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)))
  }
  function submit() {
    m.reset()
    const e: Record<string, string> = {}
    if (!from) e.from = t('stockTransfers.err.from')
    if (!to) e.to = t('stockTransfers.err.to')
    const out: Record<string, unknown>[] = []
    for (const [i, l] of lines.entries()) {
      if (!l.product_id && !l.qty.trim()) continue
      const q = cleanQty(l.qty)
      if (!l.product_id || !q) {
        e.lines = t('stockTransfers.err.line', { n: i + 1 })
        break
      }
      out.push({ product_id: l.product_id, qty: q, note: l.note.trim() || null })
    }
    if (!e.lines && out.length === 0) e.lines = t('stockTransfers.err.noLines')
    setErrs(e)
    if (Object.keys(e).length) return
    m.mutate({ p: { company_id: companyId, from_place_id: from, to_place_id: to, date: todayIst(), needed_by: neededBy || null, note: note.trim() || null, lines: out } }, { onSuccess: (r) => onCreated(r.id) })
  }
  return (
    <Card title={t('stockTransfers.newTitle')}>
      <FieldGrid cols={2}>
        <SelectField label={t('stockTransfers.from')} value={from} error={errs.from} placeholder={t('stockTransfers.choose')} options={places.map((p) => ({ value: p.id, label: placeLabel(p) }))} onChange={(e) => setFrom(e.target.value)} />
        <SelectField label={t('stockTransfers.to')} value={to} error={errs.to} placeholder={t('stockTransfers.choose')} options={places.filter((p) => p.id !== from).map((p) => ({ value: p.id, label: placeLabel(p) }))} onChange={(e) => setTo(e.target.value)} />
        <Field type="date" label={t('stockTransfers.neededBy')} value={neededBy} min={todayIst()} onChange={(e) => setNeededBy(e.target.value)} />
        <Field label={t('stockTransfers.note')} value={note} onChange={(e) => setNote(e.target.value)} />
      </FieldGrid>
      {fromPlace && toPlace ? (
        <p className="k">
          {fromPlace.branch_id === toPlace.branch_id ? t('stockTransfers.sameBranchNote') : t('stockTransfers.gstNote')}
        </p>
      ) : null}
      <div className="sf-table-wrap" tabIndex={0} role="region" aria-label={t('stockTransfers.linesTitle')} style={{ marginTop: 12 }}>
        <table className="sf-table">
          <caption className="sr-only">{t('stockTransfers.linesTitle')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('stockTransfers.col.item')}</th>
              <th scope="col" className="r">{t('stockTransfers.col.qty')}</th>
              <th scope="col">{t('stockTransfers.col.note')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <select className="sf-input" style={{ height: 34, minWidth: 240 }} aria-label={t('stockTransfers.aria.item', { n: i + 1 })} value={l.product_id} onChange={(e) => setLine(i, { product_id: e.target.value })}>
                    <option value="">{t('stockTransfers.choose')}</option>
                    {items.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.code} · {p.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="r">
                  <input className="sf-input mono" style={{ height: 34, width: 110, textAlign: 'right' }} inputMode="decimal" aria-label={t('stockTransfers.aria.qty', { n: i + 1 })} value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
                </td>
                <td>
                  <input className="sf-input" style={{ height: 34, width: 200 }} aria-label={t('stockTransfers.aria.note', { n: i + 1 })} value={l.note} onChange={(e) => setLine(i, { note: e.target.value })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 8 }}>
        <Button size="sm" onClick={() => setLines([...lines, blank()])}>
          {t('stockTransfers.addLine')}
        </Button>
      </div>
      {errs.lines ? (
        <p className="sf-field__msg" role="alert" style={{ color: 'var(--sf-danger-ink)', margin: '8px 0 0' }}>
          {errs.lines}
        </p>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
        <InventoryErrorBox error={m.error as RpcError | null} />
        <div>
          <Button variant="primary" onClick={submit} busy={m.isPending}>
            {t('stockTransfers.request')}
          </Button>
        </div>
      </div>
    </Card>
  )
}

function Explainers() {
  const { t } = useTranslation()
  const who = ['picker', 'custodian', 'handover', 'receiver', 'same', 'writeOff']
  const alerts = ['late', 'difference', 'extra', 'same', 'other', 'sellable']
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16, alignItems: 'start' }}>
      <Card title={t('stockTransfers.who.title')}>
        <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {who.map((k) => (
            <div key={k}>
              <dt style={{ fontWeight: 600 }}>{t(`stockTransfers.who.${k}.title`)}</dt>
              <dd style={{ margin: 0 }} className="muted">
                {t(`stockTransfers.who.${k}.body`)}
              </dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card title={t('stockTransfers.alerts.title')}>
        <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {alerts.map((k) => (
            <div key={k}>
              <dt style={{ fontWeight: 600 }}>
                {t(`stockTransfers.alerts.${k}.title`)} {k === 'sellable' ? <Chip tone="info">{t('stockTransfers.alerts.rule')}</Chip> : null}
              </dt>
              <dd style={{ margin: 0 }} className="muted">
                {t(`stockTransfers.alerts.${k}.body`)}
              </dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  )
}

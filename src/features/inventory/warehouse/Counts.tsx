import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { formatDate } from '@/shared/format'
import { Button, Card, Checkbox, DataTable, EmptyState, Field, FieldGrid, SelectField, Skeleton, type Column } from '@/ui'
import { cleanQty, InventoryErrorBox, placeLabel, Qty, STOCK_REFRESH, StockStatus, useInventoryRights, useStockItems, useStockPlaces } from '../common/inventory'

type Count = ViewRow<'stock_counts'>
type Line = ViewRow<'stock_count_lines'>

/**
 * Cycle counts (blind): start a count for a place (api.start_stock_count), counters enter what they find without seeing
 * the system quantity (api.stock_count_lines hides it while the count is open), submit it, and someone who neither
 * counted nor submitted posts the differences as adjustment movements (api.post_stock_count, rule sod.own_count).
 */
export function Counts({ companyId, countParam }: { companyId: string; countParam: string | null }) {
  const { t } = useTranslation()
  const rights = useInventoryRights()
  const [params, setParams] = useSearchParams()
  const q = useApiView('stock_counts', { eq: { company_id: companyId }, order: 'count_date', ascending: false, limit: 200 })
  const counts = rowsOf(q)
  const selected = counts.find((c) => c.id === countParam) ?? null

  function choose(id: string | null) {
    const next = new URLSearchParams(params)
    if (id) next.set('count', id)
    else next.delete('count')
    setParams(next, { replace: true })
  }

  const columns: Column<Count>[] = [
    { key: 'no', header: t('warehouse.counts.col.no'), render: (c) => <span className="mono">{c.doc_no}</span> },
    { key: 'date', header: t('warehouse.counts.col.date'), render: (c) => <span className="mono">{formatDate(c.count_date)}</span> },
    { key: 'place', header: t('warehouse.counts.col.place'), render: (c) => c.place_name },
    { key: 'blind', header: t('warehouse.counts.col.blind'), render: (c) => (c.blind ? t('common.yes') : t('common.no')) },
    { key: 'lines', header: t('warehouse.counts.col.counted'), align: 'right', render: (c) => `${c.counted ?? 0} / ${c.lines ?? 0}` },
    { key: 'diff', header: t('warehouse.counts.col.differences'), align: 'right', render: (c) => (c.differences === null ? <span className="k">{t('warehouse.counts.hidden')}</span> : c.differences) },
    { key: 'status', header: t('warehouse.counts.col.status'), render: (c) => <StockStatus status={c.status} /> },
    { key: 'by', header: t('warehouse.counts.col.by'), render: (c) => [c.created_by_name, c.approved_by_name ? t('warehouse.counts.postedBy', { name: c.approved_by_name }) : null].filter(Boolean).join(' · ') },
    {
      key: 'open',
      header: <span className="sr-only">{t('warehouse.counts.col.open')}</span>,
      render: (c) => (
        <Button size="sm" variant="link" aria-label={t('warehouse.counts.openAria', { no: c.doc_no })} onClick={() => choose(c.id)}>
          {t('warehouse.counts.open')}
        </Button>
      ),
    },
  ]

  return (
    <>
      {rights.edit ? <StartCount companyId={companyId} onStarted={choose} /> : null}
      {selected ? <CountDetail key={selected.id} count={selected} onClose={() => choose(null)} /> : null}
      <TableCard title={t('warehouse.counts.title')}>
        <DataTable caption={t('warehouse.counts.title')} columns={columns} rows={counts} rowKey={(c) => c.id} loading={q.isLoading} minWidth={900} empty={<EmptyState title={t('warehouse.counts.emptyTitle')} body={t('warehouse.counts.emptyBody')} />} />
      </TableCard>
    </>
  )
}

function StartCount({ companyId, onStarted }: { companyId: string; onStarted: (id: string) => void }) {
  const { t } = useTranslation()
  const places = useStockPlaces(companyId).list
  const items = useStockItems(companyId).list
  const [place, setPlace] = useState('')
  const [item, setItem] = useState('')
  const [blind, setBlind] = useState(true)
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const m = useApiMutation<{ p: Record<string, unknown> }, { id: string; doc_no: string; lines: number }>('start_stock_count', STOCK_REFRESH)
  return (
    <Card title={t('warehouse.counts.startTitle')}>
      <FieldGrid cols={3}>
        <SelectField label={t('warehouse.counts.place')} value={place} error={err || undefined} placeholder={t('warehouse.choose')} options={places.map((p) => ({ value: p.id, label: placeLabel(p) }))} onChange={(e) => setPlace(e.target.value)} />
        <SelectField label={t('warehouse.counts.onlyItem')} value={item} placeholder={t('warehouse.counts.everyItem')} options={items.map((i) => ({ value: i.id, label: `${i.code} · ${i.name}` }))} onChange={(e) => setItem(e.target.value)} />
        <Field label={t('warehouse.counts.note')} value={note} onChange={(e) => setNote(e.target.value)} />
      </FieldGrid>
      <div style={{ marginTop: 12 }}>
        <Checkbox label={t('warehouse.counts.blind')} hint={t('warehouse.counts.blindHint')} checked={blind} onChange={(e) => setBlind(e.target.checked)} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
        <InventoryErrorBox error={m.error as RpcError | null} />
        <div>
          <Button
            variant="primary"
            busy={m.isPending}
            onClick={() => {
              m.reset()
              if (!place) {
                setErr(t('warehouse.counts.err.place'))
                return
              }
              setErr('')
              m.mutate({ p: { company_id: companyId, place_id: place, product_ids: item ? [item] : null, blind, date: todayIst(), note: note.trim() || null } }, { onSuccess: (r) => onStarted(r.id) })
            }}
          >
            {t('warehouse.counts.start')}
          </Button>
        </div>
      </div>
    </Card>
  )
}

function CountDetail({ count, onClose }: { count: Count; onClose: () => void }) {
  const { t } = useTranslation()
  const rights = useInventoryRights()
  const lq = useApiView('stock_count_lines', { eq: { count_id: count.id }, order: 'product_name', limit: 1000 })
  const lines = rowsOf(lq)
  const [typed, setTyped] = useState<Record<string, { qty?: string; reason?: string }>>({})
  const [reason, setReason] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [lineErr, setLineErr] = useState('')
  const record = useApiMutation<{ p_count_id: string; p_lines: Record<string, unknown>[] }, { id: string; counted: number }>('record_stock_count', STOCK_REFRESH)
  const submit = useApiMutation<{ p_count_id: string }, { id: string; status: string }>('submit_stock_count', STOCK_REFRESH)
  const post = useApiMutation<{ p_count_id: string }, { id: string; adjustments: number }>('post_stock_count', STOCK_REFRESH)
  const cancel = useApiMutation<{ p_count_id: string; p_reason: string }, { id: string; status: string }>('cancel_stock_count', STOCK_REFRESH)
  const err = (record.error ?? submit.error ?? post.error ?? cancel.error) as RpcError | null
  const counting = count.status === 'counting'
  function resetAll() {
    setMsg(null)
    setLineErr('')
    record.reset()
    submit.reset()
    post.reset()
    cancel.reset()
  }

  function saveCounts() {
    resetAll()
    const out: Record<string, unknown>[] = []
    for (const l of lines) {
      const v = typed[l.id]?.qty
      if (v === undefined || v.trim() === '') continue
      const q = cleanQty(v, true)
      if (q === null) {
        setLineErr(t('warehouse.counts.err.qty', { item: l.product_name }))
        return
      }
      out.push({ line_id: l.id, counted_qty: q, reason: typed[l.id]?.reason?.trim() || null })
    }
    if (out.length === 0) {
      setLineErr(t('warehouse.counts.err.none'))
      return
    }
    record.mutate({ p_count_id: count.id, p_lines: out }, { onSuccess: (r) => setMsg(t('warehouse.counts.saved', { n: r.counted })) })
  }

  const columns: Column<Line>[] = [
    { key: 'item', header: t('warehouse.counts.col.item'), render: (l) => <span><strong>{l.product_name}</strong> <span className="k mono">{l.product_code}</span></span> },
    { key: 'lot', header: t('warehouse.counts.col.lot'), render: (l) => <span className="mono">{l.lot_no ?? '—'}</span> },
    { key: 'bucket', header: t('warehouse.counts.col.bucket'), render: (l) => <StockStatus status={l.bucket} /> },
    { key: 'system', header: t('warehouse.counts.col.system'), align: 'right', render: (l) => (l.system_qty === null ? <span className="k">{t('warehouse.counts.hidden')}</span> : <Qty value={l.system_qty} uom={l.uom} />) },
    {
      key: 'counted',
      header: t('warehouse.counts.col.countedQty'),
      align: 'right',
      render: (l) =>
        counting && rights.create ? (
          <input
            className="sf-input mono"
            style={{ height: 34, width: 110, textAlign: 'right' }}
            inputMode="decimal"
            aria-label={t('warehouse.counts.aria.qty', { item: l.product_name, lot: l.lot_no ?? '' })}
            value={typed[l.id]?.qty ?? (l.counted_qty === null ? '' : String(l.counted_qty))}
            onChange={(e) => setTyped({ ...typed, [l.id]: { ...typed[l.id], qty: e.target.value } })}
          />
        ) : (
          <Qty value={l.counted_qty} uom={l.uom} />
        ),
    },
    { key: 'diff', header: t('warehouse.counts.col.difference'), align: 'right', render: (l) => (l.difference === null ? <span className="k">—</span> : <Qty value={l.difference} signed />) },
    {
      key: 'reason',
      header: t('warehouse.counts.col.reason'),
      render: (l) =>
        counting && rights.create ? (
          <input className="sf-input" style={{ height: 34, width: 180 }} aria-label={t('warehouse.counts.aria.reason', { item: l.product_name })} value={typed[l.id]?.reason ?? l.reason ?? ''} onChange={(e) => setTyped({ ...typed, [l.id]: { ...typed[l.id], reason: e.target.value } })} />
        ) : (
          <span className="k">{l.reason ?? ''}</span>
        ),
    },
    { key: 'by', header: t('warehouse.counts.col.countedBy'), render: (l) => l.counted_by_name ?? '—' },
  ]

  return (
    <Card
      title={t('warehouse.counts.detailTitle', { no: count.doc_no, place: count.place_name })}
      action={
        <Button size="sm" variant="link" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <StockStatus status={count.status} />
        <span className="k">{count.blind && counting ? t('warehouse.counts.blindNote') : t('warehouse.counts.openNote')}</span>
      </div>
      {lq.isLoading ? <Skeleton height={60} /> : <DataTable caption={t('warehouse.counts.linesCaption', { no: count.doc_no })} columns={columns} rows={lines} rowKey={(l) => l.id} minWidth={900} empty={<EmptyState title={t('warehouse.counts.noLines')} />} />}
      {lineErr ? (
        <p className="sf-field__msg" role="alert" style={{ color: 'var(--sf-danger-ink)', margin: '8px 0 0' }}>
          {lineErr}
        </p>
      ) : null}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        {counting && rights.create ? (
          <>
            <Button onClick={saveCounts} busy={record.isPending}>
              {t('warehouse.counts.save')}
            </Button>
            <Button variant="primary" busy={submit.isPending} onClick={() => { resetAll(); submit.mutate({ p_count_id: count.id }, { onSuccess: () => setMsg(t('warehouse.counts.submitted')) }) }}>
              {t('warehouse.counts.submit')}
            </Button>
          </>
        ) : null}
        {count.status === 'submitted' && rights.approve ? (
          <Button variant="primary" busy={post.isPending} onClick={() => { resetAll(); post.mutate({ p_count_id: count.id }, { onSuccess: (r) => setMsg(t('warehouse.counts.posted', { n: r.adjustments })) }) }}>
            {t('warehouse.counts.post')}
          </Button>
        ) : null}
      </div>
      {(counting || count.status === 'submitted') && rights.edit ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 12 }}>
          <div style={{ flex: '1 1 240px' }}>
            <Field label={t('warehouse.counts.cancelReason')} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <Button variant="danger" busy={cancel.isPending} onClick={() => { resetAll(); cancel.mutate({ p_count_id: count.id, p_reason: reason.trim() }, { onSuccess: () => setMsg(t('warehouse.counts.cancelled')) }) }}>
            {t('warehouse.counts.cancel')}
          </Button>
        </div>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
        <InventoryErrorBox error={err} />
        {msg ? (
          <div role="status" className="sf-alert" data-tone="success" style={{ margin: 0 }}>
            {msg}
          </div>
        ) : null}
      </div>
    </Card>
  )
}

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard, TWO_COLS } from '@/features/admin/import-data/layout'
import { formatDate } from '@/shared/format'
import { Button, Card, ConfirmDialog, DataTable, EmptyState, Field, FieldGrid, SelectField, type Column } from '@/ui'
import { cleanCost, cleanQty, InventoryErrorBox, placeLabel, Qty, STOCK_REFRESH, useInventoryRights, useStockItems, useStockPlaces } from '../common/inventory'

/** Reorder levels (api.set_reorder_level, inventory.edit): company level (no place) drives "below minimum". */
export function ReorderLevels({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const rights = useInventoryRights()
  const q = useApiView('reorder_levels', { eq: { company_id: companyId }, order: 'product_name', limit: 2000 })
  const items = useStockItems(companyId).list
  const places = useStockPlaces(companyId).list
  const [product, setProduct] = useState('')
  const [place, setPlace] = useState('')
  const [min, setMin] = useState('')
  const [reorder, setReorder] = useState('')
  const [max, setMax] = useState('')
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [done, setDone] = useState(false)
  const m = useApiMutation<{ p: Record<string, unknown> }, { id: string }>('set_reorder_level', [...STOCK_REFRESH, ['api', 'reorder_levels']])
  type R = ViewRow<'reorder_levels'>
  const columns: Column<R>[] = [
    { key: 'item', header: t('warehouse.reorder.col.item'), render: (r) => `${r.product_code} · ${r.product_name}` },
    { key: 'place', header: t('warehouse.reorder.col.place'), render: (r) => r.place_name ?? t('warehouse.reorder.companyLevel') },
    { key: 'min', header: t('warehouse.reorder.col.min'), align: 'right', render: (r) => <Qty value={r.min_qty} /> },
    { key: 'reorder', header: t('warehouse.reorder.col.reorder'), align: 'right', render: (r) => <Qty value={r.reorder_qty} /> },
    { key: 'max', header: t('warehouse.reorder.col.max'), align: 'right', render: (r) => <Qty value={r.max_qty} /> },
    { key: 'set', header: t('warehouse.reorder.col.set'), render: (r) => <span className="mono">{formatDate(r.set_at)}</span> },
  ]
  function submit() {
    setDone(false)
    m.reset()
    const e: Record<string, string> = {}
    if (!product) e.product = t('warehouse.err.product')
    if (cleanQty(min, true) === null) e.min = t('warehouse.err.qtyZero')
    if (reorder.trim() && cleanQty(reorder) === null) e.reorder = t('warehouse.err.qty')
    if (max.trim() && cleanQty(max) === null) e.max = t('warehouse.err.qty')
    setErrs(e)
    if (Object.keys(e).length) return
    m.mutate({ p: { company_id: companyId, product_id: product, place_id: place || null, min_qty: cleanQty(min, true), reorder_qty: reorder.trim() ? cleanQty(reorder) : null, max_qty: max.trim() ? cleanQty(max) : null } }, { onSuccess: () => setDone(true) })
  }
  return (
    <div style={TWO_COLS}>
      <TableCard title={t('warehouse.reorder.title')}>
        <DataTable caption={t('warehouse.reorder.title')} columns={columns} rows={rowsOf(q)} rowKey={(r) => r.id} loading={q.isLoading} minWidth={640} empty={<EmptyState title={t('warehouse.reorder.emptyTitle')} body={t('warehouse.reorder.emptyBody')} />} />
      </TableCard>
      {rights.edit ? (
        <Card title={t('warehouse.reorder.formTitle')}>
          <FieldGrid cols={2}>
            <SelectField label={t('warehouse.reorder.item')} value={product} error={errs.product} placeholder={t('warehouse.choose')} options={items.map((i) => ({ value: i.id, label: `${i.code} · ${i.name}` }))} onChange={(e) => setProduct(e.target.value)} />
            <SelectField label={t('warehouse.reorder.place')} value={place} placeholder={t('warehouse.reorder.companyLevel')} options={places.map((p) => ({ value: p.id, label: placeLabel(p) }))} onChange={(e) => setPlace(e.target.value)} />
            <Field label={t('warehouse.reorder.min')} inputMode="decimal" value={min} error={errs.min} onChange={(e) => setMin(e.target.value)} />
            <Field label={t('warehouse.reorder.reorderQty')} inputMode="decimal" value={reorder} error={errs.reorder} onChange={(e) => setReorder(e.target.value)} />
            <Field label={t('warehouse.reorder.max')} inputMode="decimal" value={max} error={errs.max} onChange={(e) => setMax(e.target.value)} />
          </FieldGrid>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
            <InventoryErrorBox error={m.error as RpcError | null} />
            {done ? (
              <div role="status" className="sf-alert" data-tone="success" style={{ margin: 0 }}>
                {t('warehouse.reorder.saved')}
              </div>
            ) : null}
            <div>
              <Button variant="primary" onClick={submit} busy={m.isPending}>
                {t('warehouse.reorder.save')}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  )
}

interface OLine {
  product_id: string
  qty: string
  unit_cost: string
  lot_no: string
  expiry_date: string
}
const blank = (): OLine => ({ product_id: '', qty: '', unit_cost: '', lot_no: '', expiry_date: '' })

/** Opening stock at go-live (api.post_opening_stock, inventory.approve): counted quantities by place, lot and cost. */
export function OpeningStock({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const rights = useInventoryRights()
  const items = useStockItems(companyId).list
  const places = useStockPlaces(companyId).list
  const [place, setPlace] = useState('')
  const [date, setDate] = useState(todayIst())
  const [lines, setLines] = useState<OLine[]>([blank()])
  const [err, setErr] = useState('')
  const [confirm, setConfirm] = useState<Record<string, unknown>[] | null>(null)
  const [done, setDone] = useState<number | null>(null)
  const m = useApiMutation<{ p: Record<string, unknown> }, { lines: number }>('post_opening_stock', STOCK_REFRESH)
  if (!rights.approve) {
    return (
      <Card>
        <p className="muted" style={{ margin: 0 }}>
          {rights.readOnly ? t('warehouse.readOnly') : t('warehouse.opening.noRight')}
        </p>
      </Card>
    )
  }
  function setLine(i: number, patch: Partial<OLine>) {
    setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  }
  function review() {
    setDone(null)
    m.reset()
    if (!place) {
      setErr(t('warehouse.err.place'))
      return
    }
    const out: Record<string, unknown>[] = []
    for (const [i, l] of lines.entries()) {
      if (!l.product_id && !l.qty.trim()) continue
      const qty = cleanQty(l.qty)
      const cost = l.unit_cost.trim() ? cleanCost(l.unit_cost) : '0'
      if (!l.product_id || !qty || cost === null) {
        setErr(t('warehouse.opening.lineErr', { n: i + 1 }))
        return
      }
      out.push({ product_id: l.product_id, qty, unit_cost: cost, lot_no: l.lot_no.trim() || null, expiry_date: l.expiry_date || null })
    }
    if (out.length === 0) {
      setErr(t('warehouse.opening.noLines'))
      return
    }
    setErr('')
    setConfirm(out)
  }
  return (
    <Card title={t('warehouse.opening.title')}>
      <p className="k" style={{ marginTop: 0 }}>
        {t('warehouse.opening.note')}
      </p>
      <FieldGrid cols={3}>
        <SelectField label={t('warehouse.opening.place')} value={place} placeholder={t('warehouse.choose')} options={places.map((p) => ({ value: p.id, label: placeLabel(p) }))} onChange={(e) => setPlace(e.target.value)} />
        <Field type="date" label={t('warehouse.opening.date')} value={date} max={todayIst()} onChange={(e) => setDate(e.target.value)} />
      </FieldGrid>
      <div className="sf-table-wrap" tabIndex={0} role="region" aria-label={t('warehouse.opening.lines')} style={{ marginTop: 12 }}>
        <table className="sf-table">
          <caption className="sr-only">{t('warehouse.opening.lines')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('warehouse.opening.col.item')}</th>
              <th scope="col" className="r">{t('warehouse.opening.col.qty')}</th>
              <th scope="col" className="r">{t('warehouse.opening.col.cost')}</th>
              <th scope="col">{t('warehouse.opening.col.lot')}</th>
              <th scope="col">{t('warehouse.opening.col.expiry')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const n = i + 1
              return (
                <tr key={i}>
                  <td>
                    <select className="sf-input" style={{ height: 34, minWidth: 220 }} aria-label={t('warehouse.opening.aria.item', { n })} value={l.product_id} onChange={(e) => setLine(i, { product_id: e.target.value })}>
                      <option value="">{t('warehouse.choose')}</option>
                      {items.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.code} · {p.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="r">
                    <input className="sf-input mono" style={{ height: 34, width: 110, textAlign: 'right' }} inputMode="decimal" aria-label={t('warehouse.opening.aria.qty', { n })} value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
                  </td>
                  <td className="r">
                    <input className="sf-input mono" style={{ height: 34, width: 110, textAlign: 'right' }} inputMode="decimal" aria-label={t('warehouse.opening.aria.cost', { n })} value={l.unit_cost} onChange={(e) => setLine(i, { unit_cost: e.target.value })} />
                  </td>
                  <td>
                    <input className="sf-input mono" style={{ height: 34, width: 140 }} aria-label={t('warehouse.opening.aria.lot', { n })} value={l.lot_no} onChange={(e) => setLine(i, { lot_no: e.target.value })} />
                  </td>
                  <td>
                    <input type="date" className="sf-input" style={{ height: 34 }} aria-label={t('warehouse.opening.aria.expiry', { n })} value={l.expiry_date} onChange={(e) => setLine(i, { expiry_date: e.target.value })} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 8 }}>
        <Button size="sm" onClick={() => setLines([...lines, blank()])}>
          {t('warehouse.opening.addLine')}
        </Button>
      </div>
      {err ? (
        <p className="sf-field__msg" role="alert" style={{ color: 'var(--sf-danger-ink)', margin: '8px 0 0' }}>
          {err}
        </p>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
        <InventoryErrorBox error={m.error as RpcError | null} />
        {done !== null ? (
          <div role="status" className="sf-alert" data-tone="success" style={{ margin: 0 }}>
            {t('warehouse.opening.posted', { n: done })}
          </div>
        ) : null}
        <div>
          <Button variant="primary" onClick={review} busy={m.isPending}>
            {t('warehouse.opening.post')}
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={Boolean(confirm)}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('warehouse.opening.confirmTitle')}
        effect={t('warehouse.opening.confirmEffect', { n: confirm?.length ?? 0, place: places.find((p) => p.id === place)?.name ?? '' })}
        confirmLabel={t('warehouse.opening.post')}
        busy={m.isPending}
        onConfirm={() => {
          if (!confirm) return
          m.mutate(
            { p: { company_id: companyId, place_id: place, date, lines: confirm } },
            {
              onSuccess: (r) => {
                setConfirm(null)
                setDone(r.lines)
                setLines([blank()])
              },
              onError: () => setConfirm(null),
            },
          )
        }}
      />
    </Card>
  )
}

/** Negative-stock allowance (Admin, api.set_negative_stock_allowance): never silent; every use is logged. */
export function NegativeStock({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const rights = useInventoryRights()
  const q = useApiView('negative_stock_allowances', { eq: { company_id: companyId }, order: 'granted_at', ascending: false, limit: 500 })
  const items = useStockItems(companyId).list
  const places = useStockPlaces(companyId).list
  const [product, setProduct] = useState('')
  const [place, setPlace] = useState('')
  const [reason, setReason] = useState('')
  const [validTo, setValidTo] = useState('')
  const [revokeReason, setRevokeReason] = useState('')
  const [err, setErr] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const add = useApiMutation<{ p: Record<string, unknown> }, { id: string }>('set_negative_stock_allowance', [['api', 'negative_stock_allowances']])
  const revoke = useApiMutation<{ p_id: string; p_reason: string }, { id: string }>('revoke_negative_stock_allowance', [['api', 'negative_stock_allowances']])
  type A = ViewRow<'negative_stock_allowances'>
  const columns: Column<A>[] = [
    { key: 'item', header: t('warehouse.negative.col.item'), render: (r) => `${r.product_code} · ${r.product_name}` },
    { key: 'place', header: t('warehouse.negative.col.place'), render: (r) => r.place_name ?? t('warehouse.negative.allPlaces') },
    { key: 'reason', header: t('warehouse.negative.col.reason'), render: (r) => r.reason },
    { key: 'by', header: t('warehouse.negative.col.by'), render: (r) => `${r.granted_by_name ?? '—'} · ${formatDate(r.granted_at)}` },
    { key: 'to', header: t('warehouse.negative.col.until'), render: (r) => (r.valid_to ? <span className="mono">{formatDate(r.valid_to)}</span> : '—') },
    { key: 'uses', header: t('warehouse.negative.col.uses'), align: 'right', render: (r) => r.uses ?? 0 },
    { key: 'state', header: t('warehouse.negative.col.state'), render: (r) => (r.active ? t('warehouse.negative.active') : r.revoked_at ? t('warehouse.negative.stopped') : t('warehouse.negative.ended')) },
    {
      key: 'stop',
      header: <span className="sr-only">{t('warehouse.negative.col.stop')}</span>,
      render: (r) =>
        r.active && rights.admin ? (
          <Button size="sm" variant="link" aria-label={t('warehouse.negative.stopAria', { item: r.product_name })} busy={revoke.isPending} onClick={() => { setDone(null); revoke.mutate({ p_id: r.id, p_reason: revokeReason.trim() }, { onSuccess: () => setDone(t('warehouse.negative.stoppedMsg')) }) }}>
            {t('warehouse.negative.stop')}
          </Button>
        ) : null,
    },
  ]
  return (
    <>
      <TableCard title={t('warehouse.negative.title')}>
        <p className="k" style={{ margin: 0, padding: '0 16px 10px' }}>
          {t('warehouse.negative.rule')}
        </p>
        <DataTable caption={t('warehouse.negative.title')} columns={columns} rows={rowsOf(q)} rowKey={(r) => r.id} loading={q.isLoading} minWidth={900} empty={<EmptyState title={t('warehouse.negative.emptyTitle')} body={t('warehouse.negative.emptyBody')} />} />
        {rights.admin ? (
          <div className="sf-card__pad" style={{ maxWidth: 420 }}>
            <Field label={t('warehouse.negative.revokeReason')} value={revokeReason} onChange={(e) => setRevokeReason(e.target.value)} />
          </div>
        ) : null}
      </TableCard>
      {rights.admin ? (
        <Card title={t('warehouse.negative.formTitle')}>
          <FieldGrid cols={2}>
            <SelectField label={t('warehouse.negative.item')} value={product} placeholder={t('warehouse.choose')} options={items.map((i) => ({ value: i.id, label: `${i.code} · ${i.name}` }))} onChange={(e) => setProduct(e.target.value)} />
            <SelectField label={t('warehouse.negative.place')} value={place} placeholder={t('warehouse.negative.allPlaces')} options={places.map((p) => ({ value: p.id, label: placeLabel(p) }))} onChange={(e) => setPlace(e.target.value)} />
            <Field label={t('warehouse.negative.reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
            <Field type="date" label={t('warehouse.negative.validTo')} value={validTo} min={todayIst()} onChange={(e) => setValidTo(e.target.value)} />
          </FieldGrid>
          {err ? (
            <p className="sf-field__msg" role="alert" style={{ color: 'var(--sf-danger-ink)', margin: '8px 0 0' }}>
              {err}
            </p>
          ) : null}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
            <InventoryErrorBox error={(add.error ?? revoke.error) as RpcError | null} />
            {done ? (
              <div role="status" className="sf-alert" data-tone="success" style={{ margin: 0 }}>
                {done}
              </div>
            ) : null}
            <div>
              <Button
                variant="primary"
                busy={add.isPending}
                onClick={() => {
                  setDone(null)
                  add.reset()
                  revoke.reset()
                  if (!product) {
                    setErr(t('warehouse.err.product'))
                    return
                  }
                  setErr('')
                  add.mutate({ p: { company_id: companyId, product_id: product, place_id: place || null, reason: reason.trim(), valid_to: validTo ? `${validTo}T23:59:59+05:30` : null } }, { onSuccess: () => setDone(t('warehouse.negative.savedMsg')) })
                }}
              >
                {t('warehouse.negative.save')}
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        <Card>
          <p className="muted" style={{ margin: 0 }}>
            {rights.readOnly ? t('warehouse.readOnly') : t('warehouse.negative.noRight')}
          </p>
        </Card>
      )}
    </>
  )
}

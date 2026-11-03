import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiRpc, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { formatDate, formatTime } from '@/shared/format'
import { Button, Card, Chip, DataTable, EmptyState, Field, FieldGrid, SelectField, Skeleton, type Column } from '@/ui'
import { cleanQty, InventoryErrorBox, Qty, qtyText, STOCK_REFRESH, StockStatus, useBlindTransfer, useInventoryRights } from '../common/inventory'

type Tr = ViewRow<'transfers'>
type Line = ViewRow<'transfer_lines'>
type Item = ViewRow<'transfer_items'>
type Ev = ViewRow<'transfer_events'>

const STATES = ['requested', 'approved', 'reserved', 'picked', 'handed_over', 'in_transit', 'received', 'reconciled', 'closed'] as const
const REFRESH = [...STOCK_REFRESH, ['api', 'sales_documents']]

/** One transfer: where it stands in the nine states, the balance rule, the GST document and the next step. */
export function TransferDetail({ companyId, transferId, onClose }: { companyId: string; transferId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const q = useApiView('transfers', { eq: { id: transferId }, limit: 1 })
  const tr = rowsOf(q)[0]
  const lq = useApiView('transfer_lines', { eq: { transfer_id: transferId }, order: 'line_no' })
  const iq = useApiView('transfer_items', { eq: { transfer_id: transferId }, order: 'product_code' })
  const eq = useApiView('transfer_events', { eq: { transfer_id: transferId }, order: 'at', ascending: false })
  if (q.isLoading) {
    return (
      <Card>
        <Skeleton height={120} />
      </Card>
    )
  }
  if (!tr || tr.company_id !== companyId) {
    return (
      <Card>
        <EmptyState
          title={t('stockTransfers.detail.missing')}
          action={
            <Button size="sm" onClick={onClose}>
              {t('stockTransfers.detail.back')}
            </Button>
          }
        />
      </Card>
    )
  }
  const lines = rowsOf(lq)
  const items = rowsOf(iq)
  const idx = STATES.indexOf(tr.status as (typeof STATES)[number])

  const lineCols: Column<Line>[] = [
    { key: 'n', header: '#', render: (l) => l.line_no },
    { key: 'item', header: t('stockTransfers.col.item'), render: (l) => `${l.product_code} · ${l.product_name}` },
    { key: 'lot', header: t('stockTransfers.col.lot'), render: (l) => <span className="mono">{l.lot_no ?? '—'}</span> },
    { key: 'req', header: t('stockTransfers.col.requested'), align: 'right', render: (l) => <Qty value={l.qty_requested} uom={l.uom} /> },
    { key: 'app', header: t('stockTransfers.col.approved'), align: 'right', render: (l) => <Qty value={l.qty_approved} /> },
    { key: 'pick', header: t('stockTransfers.col.picked'), align: 'right', render: (l) => <Qty value={l.qty_picked} /> },
  ]
  const itemCols: Column<Item>[] = [
    { key: 'item', header: t('stockTransfers.col.item'), render: (i) => `${i.product_code} · ${i.product_name}` },
    { key: 'lot', header: t('stockTransfers.col.lot'), render: (i) => <span className="mono">{i.lot_no ?? '—'}</span> },
    { key: 'disp', header: t('stockTransfers.col.dispatched'), align: 'right', render: (i) => (i.qty_dispatched === null ? <span className="k">{t('stockTransfers.detail.hidden')}</span> : <Qty value={i.qty_dispatched} uom={i.uom} />) },
    { key: 'acc', header: t('stockTransfers.col.accepted'), align: 'right', render: (i) => <Qty value={i.qty_accepted} /> },
    { key: 'qc', header: t('stockTransfers.col.quarantined'), align: 'right', render: (i) => <Qty value={i.qty_quarantined} /> },
    { key: 'ret', header: t('stockTransfers.col.returned'), align: 'right', render: (i) => <Qty value={i.qty_returned} /> },
    { key: 'lost', header: t('stockTransfers.col.lost'), align: 'right', render: (i) => <Qty value={i.qty_lost} /> },
    { key: 'transit', header: t('stockTransfers.col.inTransit'), align: 'right', render: (i) => (i.qty_in_transit === null ? <span className="k">{t('stockTransfers.detail.hidden')}</span> : <Qty value={i.qty_in_transit} />) },
  ]
  const evCols: Column<Ev>[] = [
    { key: 'at', header: t('stockTransfers.col.when'), render: (e) => <span className="mono">{`${formatDate(e.at)} ${formatTime(e.at)}`}</span> },
    { key: 'action', header: t('stockTransfers.col.action'), render: (e) => t(`stockTransfers.events.${e.action}`, { defaultValue: e.action }) },
    { key: 'to', header: t('stockTransfers.col.status'), render: (e) => <StockStatus status={e.to_status} /> },
    { key: 'by', header: t('stockTransfers.col.by'), render: (e) => e.actor_name ?? '—' },
  ]

  return (
    <>
      <Card
        title={t('stockTransfers.detail.title', { no: tr.doc_no, from: tr.from_place_name, to: tr.to_place_name })}
        action={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <StockStatus status={tr.status} />
            <Button size="sm" variant="link" onClick={onClose}>
              {t('stockTransfers.detail.back')}
            </Button>
          </div>
        }
      >
        <p className="muted" style={{ marginTop: 0 }} data-testid="gst-doc">
          {tr.gst_doc_kind === 'delivery_challan'
            ? tr.gst_doc_no
              ? t('stockTransfers.detail.challanMade', { no: tr.gst_doc_no })
              : t('stockTransfers.detail.challanAtDispatch')
            : tr.gst_doc_no
              ? t('stockTransfers.detail.invoiceLinked', { no: tr.gst_doc_no })
              : t('stockTransfers.detail.invoiceNeeded', { gstin: tr.to_gstin })}
        </p>
        <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>{t('stockTransfers.detail.states')}</h3>
        <ol aria-label={t('stockTransfers.detail.states')} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {STATES.map((s, i) => {
            const done = tr.status !== 'cancelled' && i < idx
            const current = s === tr.status
            return (
              <li
                key={s}
                aria-current={current ? 'step' : undefined}
                className="sf-chip"
                data-tone={current ? 'teal' : done ? 'success' : 'outline'}
                style={{ padding: '6px 12px', display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 96, fontWeight: current ? 700 : 500 }}
              >
                <span className="mono">{i + 1}</span>
                <span>{t(`inventoryCommon.status.${s}`)}</span>
                <span className="k" style={{ fontWeight: 400 }}>
                  {t(`stockTransfers.stateWho.${s}`)}
                </span>
              </li>
            )
          })}
        </ol>
        {tr.status === 'cancelled' ? <p className="k">{t('stockTransfers.detail.cancelled', { reason: tr.cancel_reason ?? '' })}</p> : null}
        <p className="k" style={{ marginBottom: 0 }}>
          {[
            t('stockTransfers.detail.people.requested', { name: tr.requested_by_name ?? '—' }),
            tr.approved_by_name ? t('stockTransfers.detail.people.approved', { name: tr.approved_by_name }) : null,
            tr.picked_by_name ? t('stockTransfers.detail.people.picked', { name: tr.picked_by_name }) : null,
            tr.carried_by_name ? t('stockTransfers.detail.people.carried', { name: tr.carried_by_name }) : null,
            tr.received_by_name ? t('stockTransfers.detail.people.received', { name: tr.received_by_name }) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16, alignItems: 'start' }}>
        <Balance tr={tr} />
        <Actions tr={tr} lines={lines} items={items} />
      </div>

      <TableCard title={t('stockTransfers.detail.lines')}>
        <DataTable caption={t('stockTransfers.detail.lines')} columns={lineCols} rows={lines} rowKey={(l) => l.id} loading={lq.isLoading} minWidth={640} />
      </TableCard>
      <TableCard title={t('stockTransfers.detail.items')}>
        <DataTable caption={t('stockTransfers.detail.items')} columns={itemCols} rows={items} rowKey={(i) => i.id} loading={iq.isLoading} minWidth={860} empty={<EmptyState title={t('stockTransfers.detail.noItems')} />} />
      </TableCard>
      <TableCard title={t('stockTransfers.detail.history')}>
        <DataTable caption={t('stockTransfers.detail.history')} columns={evCols} rows={rowsOf(eq)} rowKey={(e) => String(e.id)} loading={eq.isLoading} minWidth={620} />
      </TableCard>
    </>
  )
}

/** The balance rule, from the database's own totals (api.transfers). */
function Balance({ tr }: { tr: Tr }) {
  const { t } = useTranslation()
  const blind = useBlindTransfer()(tr)
  const rows: [string, number | null][] = [
    ['dispatched', tr.qty_dispatched],
    ['accepted', tr.qty_accepted],
    ['quarantined', tr.qty_quarantined],
    ['returned', tr.qty_returned],
    ['lost', tr.qty_lost],
    ['inTransit', tr.qty_in_transit],
  ]
  if (blind) {
    return (
      <Card title={t('stockTransfers.balance.title')}>
        <p className="muted" style={{ marginTop: 0 }}>
          {t('stockTransfers.balance.blind')}
        </p>
        <p className="k" style={{ marginBottom: 0 }}>
          {t('stockTransfers.balance.rule')}
        </p>
      </Card>
    )
  }
  return (
    <Card title={t('stockTransfers.balance.title')}>
      <div data-testid="balance">
        <dl style={{ margin: 0 }}>
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--sf-line)' }}>
              <dt>{t(`stockTransfers.balance.${k}`, { from: tr.from_place_name, to: tr.to_place_name })}</dt>
              <dd style={{ margin: 0 }}>
                <Qty value={v} />
              </dd>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', fontWeight: 700 }}>
            <dt>{t('stockTransfers.balance.accounted')}</dt>
            <dd style={{ margin: 0 }} className="mono" data-testid="balance-sum">
              {`${qtyText(tr.qty_dispatched)} = ${qtyText(tr.qty_accepted)} + ${qtyText(tr.qty_quarantined)} + ${qtyText(tr.qty_returned)} + ${qtyText(tr.qty_lost)} + ${qtyText(tr.qty_in_transit)}`}
            </dd>
          </div>
        </dl>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {tr.balanced ? <Chip tone="success" icon="check">{t('stockTransfers.balance.balanced')}</Chip> : <Chip tone="danger" icon="alert">{t('stockTransfers.balance.unbalanced')}</Chip>}
          {Number(tr.qty_in_transit) > 0 ? <Chip tone="transit">{t('stockTransfers.balance.stillOpen', { qty: qtyText(tr.qty_in_transit) })}</Chip> : null}
          {tr.can_close ? <Chip tone="teal">{t('stockTransfers.balance.canClose')}</Chip> : null}
        </div>
      </div>
      <p className="k" style={{ marginBottom: 0 }}>
        {t('stockTransfers.balance.rule')}
      </p>
    </Card>
  )
}

interface UserRow {
  user_id: string
  display_name: string | null
  status: string
}

/** The action for the current state. Buttons are shown to anyone with the right; segregation of duties is the server's. */
function Actions({ tr, lines, items }: { tr: Tr; lines: Line[]; items: Item[] }) {
  const { t } = useTranslation()
  const r = useInventoryRights()
  const [err, setErr] = useState<RpcError | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [qtys, setQtys] = useState<Record<string, string>>({})
  const [lots, setLots] = useState<Record<string, string>>({})
  const [good, setGood] = useState<Record<string, string>>({})
  const [damaged, setDamaged] = useState<Record<string, string>>({})
  const [returned, setReturned] = useState<Record<string, string>>({})
  const [lost, setLost] = useState<Record<string, string>>({})
  const [vehicle, setVehicle] = useState('')
  const [carrier, setCarrier] = useState('')
  const [invoice, setInvoice] = useState('')
  const [witness, setWitness] = useState('')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')

  const approve = useApiMutation<Record<string, unknown>, { status: string }>('approve_transfer', REFRESH)
  const reserve = useApiMutation<Record<string, unknown>, { status: string }>('reserve_transfer', REFRESH)
  const pick = useApiMutation<Record<string, unknown>, { status: string }>('pick_transfer', REFRESH)
  const handOver = useApiMutation<Record<string, unknown>, { status: string; gst_doc_no?: string | null }>('hand_over_transfer', REFRESH)
  const receive = useApiMutation<Record<string, unknown>, { status: string; still_in_transit: number }>('receive_transfer', REFRESH)
  const reconcile = useApiMutation<Record<string, unknown>, { status: string; still_in_transit: number }>('reconcile_transfer', REFRESH)
  const writeOff = useApiMutation<Record<string, unknown>, { written_off: number; still_in_transit: number }>('write_off_transfer_shortage', REFRESH)
  const close = useApiMutation<Record<string, unknown>, { status: string }>('close_transfer', REFRESH)
  const cancel = useApiMutation<Record<string, unknown>, { status: string }>('cancel_transfer', REFRESH)
  const busy = [approve, reserve, pick, handOver, receive, reconcile, writeOff, close, cancel].some((m) => m.isPending)

  const stockQ = useApiView('stock_on_hand', { eq: { company_id: tr.company_id, place_id: tr.from_place_id, bucket: 'available' }, limit: 1000, enabled: tr.status === 'reserved' })
  const stock = rowsOf(stockQ)
  const invQ = useApiView('sales_documents', { eq: { company_id: tr.company_id, gstin_id: tr.from_gstin_id, doc_type: 'sales_invoice', status: 'posted' }, order: 'doc_date', ascending: false, limit: 200, enabled: tr.status === 'handed_over' && tr.gst_doc_kind === 'tax_invoice' })
  const usersQ = useApiRpc<UserRow[]>('list_users', {}, tr.status === 'in_transit')
  const users = usersQ.data?.status === 'ready' ? usersQ.data.data.filter((u) => u.status === 'active' && u.user_id !== tr.picked_by) : []

  function run(m: { mutate: (a: Record<string, unknown>, o: { onSuccess: (res: Record<string, unknown>) => void; onError: (e: RpcError) => void }) => void }, args: Record<string, unknown>, ok: (res: Record<string, unknown>) => string) {
    setErr(null)
    setMsg(null)
    m.mutate(
      { p_transfer_id: tr.id, ...args },
      {
        onSuccess: (res) => {
          setMsg(ok(res))
          // Each step starts with empty boxes (a blind count never inherits the last step's figures).
          setQtys({})
          setGood({})
          setDamaged({})
          setReturned({})
          setLost({})
          setNote('')
        },
        onError: (e) => setErr(e),
      },
    )
  }
  const moved = (res: Record<string, unknown>) => t('stockTransfers.act.moved', { no: tr.doc_no, status: t(`inventoryCommon.status.${String(res.status ?? tr.status)}`) })
  type M = Parameters<typeof run>[0]

  const cancelBlock =
    ['requested', 'approved', 'reserved', 'picked', 'handed_over'].includes(tr.status) && (r.transferCreate || r.transferApprove) ? (
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 16 }}>
        <div style={{ flex: '1 1 220px' }}>
          <Field label={t('stockTransfers.act.cancelReason')} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <Button variant="danger" busy={cancel.isPending} disabled={busy} onClick={() => run(cancel as unknown as M, { p_reason: reason.trim() }, moved)}>
          {t('stockTransfers.act.cancel')}
        </Button>
      </div>
    ) : null

  const qtyInput = (label: string, value: string | undefined, set: (v: string) => void) => (
    <input className="sf-input mono" style={{ height: 34, width: 100, textAlign: 'right' }} inputMode="decimal" aria-label={label} value={value ?? ''} onChange={(e) => set(e.target.value)} />
  )
  const parse = (map: Record<string, string>, id: string) => {
    const v = map[id]?.trim()
    if (!v) return null
    return cleanQty(v, true)
  }

  let body: ReactNode
  switch (tr.status) {
    case 'requested':
      body = (
        <>
          <p className="k" style={{ marginTop: 0 }}>{t('stockTransfers.act.approveNote')}</p>
          {r.transferApprove ? (
            <>
              <table className="sf-table">
                <caption className="sr-only">{t('stockTransfers.act.approveQty')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('stockTransfers.col.item')}</th>
                    <th scope="col" className="r">{t('stockTransfers.col.requested')}</th>
                    <th scope="col" className="r">{t('stockTransfers.col.approved')}</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id}>
                      <td>{l.product_name}</td>
                      <td className="r"><Qty value={l.qty_requested} uom={l.uom} /></td>
                      <td className="r">{qtyInput(t('stockTransfers.aria.approve', { item: l.product_name }), qtys[l.id] ?? String(l.qty_requested), (v) => setQtys({ ...qtys, [l.id]: v }))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: 12 }}>
                <Field label={t('stockTransfers.act.note')} value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
              <div style={{ marginTop: 12 }}>
                <Button
                  variant="primary"
                  busy={approve.isPending}
                  disabled={busy}
                  onClick={() => {
                    const p_lines = lines.filter((l) => qtys[l.id] !== undefined).map((l) => ({ line_id: l.id, qty_approved: cleanQty(qtys[l.id] ?? '', true) }))
                    run(approve as unknown as M, { p_lines: p_lines.length ? p_lines : null, p_note: note.trim() || null }, moved)
                  }}
                >
                  {t('stockTransfers.act.approve')}
                </Button>
              </div>
            </>
          ) : (
            <p className="muted">{t('stockTransfers.act.noRight')}</p>
          )}
        </>
      )
      break
    case 'approved':
      body = (
        <>
          <p className="k" style={{ marginTop: 0 }}>{t('stockTransfers.act.reserveNote')}</p>
          {r.edit ? (
            <Button variant="primary" busy={reserve.isPending} disabled={busy} onClick={() => run(reserve as unknown as M, {}, moved)}>
              {t('stockTransfers.act.reserve')}
            </Button>
          ) : (
            <p className="muted">{t('stockTransfers.act.noRight')}</p>
          )}
        </>
      )
      break
    case 'reserved':
      body = (
        <>
          <p className="k" style={{ marginTop: 0 }}>{t('stockTransfers.act.pickNote')}</p>
          {r.transferPick ? (
            <>
              <table className="sf-table">
                <caption className="sr-only">{t('stockTransfers.act.pickTitle')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('stockTransfers.col.item')}</th>
                    <th scope="col">{t('stockTransfers.col.lot')}</th>
                    <th scope="col" className="r">{t('stockTransfers.col.picked')}</th>
                  </tr>
                </thead>
                <tbody>
                  {lines
                    .filter((l) => Number(l.qty_approved) > 0)
                    .map((l) => {
                      const lotRows = stock.filter((s) => s.product_id === l.product_id && s.lot_id && (!l.lot_id || s.lot_id === l.lot_id))
                      return (
                        <tr key={l.id}>
                          <td>
                            {l.product_name} <span className="k">{t('stockTransfers.act.approvedQty', { qty: qtyText(l.qty_approved), uom: l.uom })}</span>
                          </td>
                          <td>
                            {lotRows.length ? (
                              <select className="sf-input" style={{ height: 34 }} aria-label={t('stockTransfers.aria.lot', { item: l.product_name })} value={lots[l.id] ?? l.lot_id ?? ''} onChange={(e) => setLots({ ...lots, [l.id]: e.target.value })}>
                                <option value="">{t('stockTransfers.choose')}</option>
                                {lotRows.map((s) => (
                                  <option key={s.id} value={s.lot_id ?? ''}>
                                    {s.lot_no} · {qtyText(s.qty)} {s.expiry_date ? `· ${formatDate(s.expiry_date)}` : ''}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span className="k">{t('stockTransfers.act.noLots')}</span>
                            )}
                          </td>
                          <td className="r">{qtyInput(t('stockTransfers.aria.pick', { item: l.product_name }), qtys[l.id] ?? String(l.qty_approved ?? ''), (v) => setQtys({ ...qtys, [l.id]: v }))}</td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
              <div style={{ marginTop: 12 }}>
                <Button
                  variant="primary"
                  busy={pick.isPending}
                  disabled={busy}
                  onClick={() => {
                    const p_picks = lines
                      .filter((l) => Number(l.qty_approved) > 0)
                      .map((l) => ({ line_id: l.id, lot_id: lots[l.id] || l.lot_id || null, qty: cleanQty(qtys[l.id] ?? String(l.qty_approved ?? '')) }))
                      .filter((p) => p.qty)
                    run(pick as unknown as M, { p_picks }, moved)
                  }}
                >
                  {t('stockTransfers.act.pick')}
                </Button>
              </div>
            </>
          ) : (
            <p className="muted">{t('stockTransfers.act.noRight')}</p>
          )}
        </>
      )
      break
    case 'picked':
      body = (
        <>
          <p className="k" style={{ marginTop: 0 }}>{t('stockTransfers.act.pickerNote')}</p>
          {r.transferPick ? (
            <Button variant="primary" busy={handOver.isPending} disabled={busy} onClick={() => run(handOver as unknown as M, { p_role: 'picker', p: {} }, moved)}>
              {t('stockTransfers.act.pickerHandOver')}
            </Button>
          ) : (
            <p className="muted">{t('stockTransfers.act.noRight')}</p>
          )}
        </>
      )
      break
    case 'handed_over':
      body = (
        <>
          <p className="k" style={{ marginTop: 0 }}>{tr.gst_doc_kind === 'delivery_challan' ? t('stockTransfers.act.carrierNoteChallan') : t('stockTransfers.act.carrierNoteInvoice', { gstin: tr.to_gstin })}</p>
          {r.transferCarry ? (
            <>
              <FieldGrid cols={2}>
                <Field label={t('stockTransfers.act.vehicle')} value={vehicle} onChange={(e) => setVehicle(e.target.value.toUpperCase())} />
                <Field label={t('stockTransfers.act.carrierName')} value={carrier} onChange={(e) => setCarrier(e.target.value)} />
                {tr.gst_doc_kind === 'tax_invoice' ? (
                  <SelectField
                    label={t('stockTransfers.act.invoice')}
                    value={invoice}
                    placeholder={rowsOf(invQ).length ? t('stockTransfers.choose') : t('stockTransfers.act.noInvoices')}
                    options={rowsOf(invQ).map((d) => ({ value: d.id, label: `${d.doc_no ?? ''} · ${d.party_name ?? ''} · ${d.party_gstin ?? ''}` }))}
                    onChange={(e) => setInvoice(e.target.value)}
                  />
                ) : null}
              </FieldGrid>
              <div style={{ marginTop: 12 }}>
                <Button
                  variant="primary"
                  busy={handOver.isPending}
                  disabled={busy}
                  onClick={() =>
                    run(handOver as unknown as M, { p_role: 'carrier', p: { vehicle_no: vehicle.trim() || null, carrier_name: carrier.trim() || null, sales_document_id: invoice || null, date: todayIst() } }, (res) =>
                      res.gst_doc_no ? t('stockTransfers.act.dispatched', { no: tr.doc_no, doc: String(res.gst_doc_no) }) : moved(res),
                    )
                  }
                >
                  {t('stockTransfers.act.carrierHandOver')}
                </Button>
              </div>
            </>
          ) : (
            <p className="muted">{t('stockTransfers.act.noRight')}</p>
          )}
        </>
      )
      break
    case 'in_transit':
      body = (
        <>
          <p className="k" style={{ marginTop: 0 }}>{t('stockTransfers.act.receiveNote')}</p>
          {r.transferReceive ? (
            <>
              <table className="sf-table">
                <caption className="sr-only">{t('stockTransfers.act.receiveTitle')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('stockTransfers.col.item')}</th>
                    <th scope="col" className="r">{t('stockTransfers.act.good')}</th>
                    <th scope="col" className="r">{t('stockTransfers.act.damaged')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td>
                        {i.product_name} {i.lot_no ? <span className="k mono">· {i.lot_no}</span> : null}
                      </td>
                      <td className="r">{qtyInput(t('stockTransfers.aria.good', { item: i.product_name }), good[i.id], (v) => setGood({ ...good, [i.id]: v }))}</td>
                      <td className="r">{qtyInput(t('stockTransfers.aria.damaged', { item: i.product_name }), damaged[i.id], (v) => setDamaged({ ...damaged, [i.id]: v }))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: 12, maxWidth: 420 }}>
                {users.length ? (
                  <SelectField label={t('stockTransfers.act.witness')} help={t('stockTransfers.act.witnessHelp')} value={witness} placeholder={t('stockTransfers.act.noWitness')} options={users.map((u) => ({ value: u.user_id, label: u.display_name ?? u.user_id }))} onChange={(e) => setWitness(e.target.value)} />
                ) : (
                  <p className="k">{t('stockTransfers.act.witnessNone')}</p>
                )}
              </div>
              <div style={{ marginTop: 12 }}>
                <Button
                  variant="primary"
                  busy={receive.isPending}
                  disabled={busy}
                  onClick={() => {
                    const p_blind_counts = items.map((i) => ({ item_id: i.id, good_qty: parse(good, i.id) ?? '0', damaged_qty: parse(damaged, i.id) ?? '0' }))
                    run(receive as unknown as M, { p_blind_counts, p_witness_id: witness || null }, (res) => t('stockTransfers.act.received', { no: tr.doc_no, left: qtyText(res.still_in_transit as number) }))
                  }}
                >
                  {t('stockTransfers.act.receive')}
                </Button>
              </div>
            </>
          ) : (
            <p className="muted">{t('stockTransfers.act.noRight')}</p>
          )}
        </>
      )
      break
    case 'received':
    case 'reconciled':
      body = (
        <>
          {tr.status === 'received' ? (
            <>
              <p className="k" style={{ marginTop: 0 }}>{t('stockTransfers.act.reconcileNote')}</p>
              <table className="sf-table">
                <caption className="sr-only">{t('stockTransfers.act.reconcileTitle')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('stockTransfers.col.item')}</th>
                    <th scope="col" className="r">{t('stockTransfers.col.inTransit')}</th>
                    <th scope="col" className="r">{t('stockTransfers.act.foundGood')}</th>
                    <th scope="col" className="r">{t('stockTransfers.act.foundDamaged')}</th>
                    <th scope="col" className="r">{t('stockTransfers.act.returnedQty')}</th>
                    <th scope="col" className="r">{t('stockTransfers.act.lostQty')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td>{i.product_name}</td>
                      <td className="r"><Qty value={i.qty_in_transit} /></td>
                      <td className="r">{qtyInput(t('stockTransfers.aria.foundGood', { item: i.product_name }), good[i.id], (v) => setGood({ ...good, [i.id]: v }))}</td>
                      <td className="r">{qtyInput(t('stockTransfers.aria.foundDamaged', { item: i.product_name }), damaged[i.id], (v) => setDamaged({ ...damaged, [i.id]: v }))}</td>
                      <td className="r">{qtyInput(t('stockTransfers.aria.returned', { item: i.product_name }), returned[i.id], (v) => setReturned({ ...returned, [i.id]: v }))}</td>
                      <td className="r">{qtyInput(t('stockTransfers.aria.lost', { item: i.product_name }), lost[i.id], (v) => setLost({ ...lost, [i.id]: v }))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: 12 }}>
                <Field label={t('stockTransfers.act.reconcileReason')} value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                {r.transferApprove ? (
                  <Button
                    variant="primary"
                    busy={reconcile.isPending}
                    disabled={busy}
                    onClick={() => {
                      const found = items.filter((i) => parse(good, i.id) || parse(damaged, i.id)).map((i) => ({ item_id: i.id, good_qty: parse(good, i.id) ?? '0', damaged_qty: parse(damaged, i.id) ?? '0' }))
                      const ret = items.filter((i) => parse(returned, i.id)).map((i) => ({ item_id: i.id, qty: parse(returned, i.id) }))
                      run(reconcile as unknown as M, { p: { found, returned: ret, note: note.trim() || null } }, (res) => (res.status === 'reconciled' ? moved(res) : t('stockTransfers.act.stillLeft', { left: qtyText(res.still_in_transit as number) })))
                    }}
                  >
                    {t('stockTransfers.act.reconcile')}
                  </Button>
                ) : null}
                {r.transferWriteOff ? (
                  <Button
                    busy={writeOff.isPending}
                    disabled={busy}
                    onClick={() => {
                      const p_items = items.filter((i) => parse(lost, i.id)).map((i) => ({ item_id: i.id, qty: parse(lost, i.id) }))
                      run(writeOff as unknown as M, { p_items, p_reason: note.trim() }, (res) => t('stockTransfers.act.writtenOff', { qty: qtyText(res.written_off as number), left: qtyText(res.still_in_transit as number) }))
                    }}
                  >
                    {t('stockTransfers.act.writeOff')}
                  </Button>
                ) : null}
              </div>
            </>
          ) : (
            <p className="k" style={{ marginTop: 0 }}>{t('stockTransfers.act.reconciledNote')}</p>
          )}
          <div style={{ marginTop: 16 }}>
            <p className="k" style={{ marginTop: 0 }}>{t('stockTransfers.act.closeNote')}</p>
            {r.transferClose ? (
              <Button variant="primary" busy={close.isPending} disabled={busy} onClick={() => run(close as unknown as M, {}, moved)}>
                {t('stockTransfers.act.close')}
              </Button>
            ) : (
              <p className="muted">{t('stockTransfers.act.noCloseRight')}</p>
            )}
          </div>
        </>
      )
      break
    default:
      body = <p className="muted" style={{ margin: 0 }}>{tr.status === 'closed' ? t('stockTransfers.act.closedNote') : t('stockTransfers.act.cancelledNote')}</p>
  }

  return (
    <Card title={t('stockTransfers.act.title', { state: t(`inventoryCommon.status.${tr.status}`) })}>
      {r.readOnly ? <p className="muted" style={{ marginTop: 0 }}>{t('stockTransfers.readOnly')}</p> : body}
      {!r.readOnly ? cancelBlock : null}
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

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { Qty, cleanQty, placeLabel, useStockItems, useStockPlaces } from '@/features/inventory/common/inventory'
import { ViewError } from '@/features/production/biochem-common/biochem'
import { PlasticsFrame } from '@/features/production/plastics-common/plastics'
import { OPS_REFRESH, OpsErrorBox, TwoCol, useOpsRights, useSetting } from '@/features/production/ops-common/ops'
import { formatDate } from '@/shared/format'
import { Button, Card, Chip, Code, DataTable, EmptyState, Field, FieldGrid, FormDialog, KeyValue, SelectField, Tabs, TextAreaField, type Column } from '@/ui'

type Order = ViewRow<'v_job_work_orders'>
type Line = ViewRow<'v_job_work_lines'>
type Receipt = ViewRow<'v_job_work_receipts'>

/**
 * Production → Job work (`JobWork`): goods sent to a job worker on a delivery challan (not an invoice) from the sending
 * GSTIN's challan series, with the return-by date from the settings (1 year inputs, 3 years capital goods, no limit for
 * moulds and tools — CGST Act s.143). api.issue_job_work_challan moves the stock to the job worker's place (still ours);
 * api.receive_job_work settles each line (finished, returned, scrap, loss) and refuses more than the balance. Balances,
 * return states and overdue flags come from api.v_job_work_orders / v_job_work_lines.
 */
export function JobWorkPage() {
  const { t } = useTranslation()
  const rights = useOpsRights()
  const [mode, setMode] = useState<'out' | 'in'>('out')
  const [creating, setCreating] = useState(false)
  return (
    <PlasticsFrame
      step="jobWork"
      title={t('jobWork.title')}
      subtitle={t('jobWork.subtitle')}
      actions={() => (
        <>
          <Tabs
            variant="segmented"
            label={t('jobWork.modes')}
            value={mode}
            onChange={setMode}
            tabs={[
              { key: 'out', label: t('jobWork.sentOut') },
              { key: 'in', label: t('jobWork.customerIn') },
            ]}
          />
          {rights.prodCreate ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t('jobWork.new')}
            </Button>
          ) : null}
        </>
      )}
    >
      {(companyId) =>
        mode === 'in' ? (
          <Card>
            <EmptyState title={t('jobWork.customerTitle')} body={t('jobWork.customerBody')} />
          </Card>
        ) : (
          <>
            <SentOut companyId={companyId} />
            {creating ? <NewChallanDialog companyId={companyId} onClose={() => setCreating(false)} /> : null}
          </>
        )
      }
    </PlasticsFrame>
  )
}

function useReturnState() {
  const { t } = useTranslation()
  return (o: Order) => {
    const bal = Number(o.qty_balance ?? 0)
    if (o.return_state === 'returned' || o.status === 'received') return <Chip tone="success" icon="check">{t('jobWork.state.returned')}</Chip>
    if (o.overdue) return <Chip tone="danger" icon="alert">{t('jobWork.state.overdue', { n: Math.abs(Number(o.days_left ?? 0)) })}</Chip>
    if (o.return_by && o.days_left !== null && o.days_left <= 30) return <Chip tone="danger" icon="clock">{t('jobWork.state.dueIn', { n: o.days_left })}</Chip>
    if (o.status === 'part_received') return <Chip tone="signal" icon="clock">{t('jobWork.state.stillOut', { qty: bal.toLocaleString('en-IN', { maximumFractionDigits: 3 }) })}</Chip>
    return <Chip tone="info">{t('jobWork.state.atWorker')}</Chip>
  }
}

function SentOut({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const q = useApiView('v_job_work_orders', { eq: { company_id: companyId }, order: 'sent_on', ascending: false, limit: 500 })
  const orders = rowsOf(q)
  const [openId, setOpenId] = useState<string | null>(null)
  const stateChip = useReturnState()
  const open = orders.find((o) => o.id === openId) ?? null

  // The nearest return deadline with goods still out (server flags: overdue, days_left).
  const urgent = useMemo(
    () =>
      orders
        .filter((o) => o.return_by && Number(o.qty_balance ?? 0) > 0 && o.days_left !== null)
        .sort((a, b) => Number(a.days_left) - Number(b.days_left))[0],
    [orders],
  )

  const columns: Column<Order>[] = [
    {
      key: 'doc',
      header: t('jobWork.col.challan'),
      render: (o) => (
        <div>
          <Button variant="link" size="sm" onClick={() => setOpenId(o.id)} aria-label={t('jobWork.openOne', { no: o.doc_no })}>
            <span className="mono" style={{ fontWeight: 600 }}>
              {o.doc_no}
            </span>
          </Button>
          <div className="mono k">{formatDate(o.sent_on)}</div>
        </div>
      ),
    },
    {
      key: 'who',
      header: t('jobWork.col.worker'),
      render: (o) => (
        <div>
          <strong>{o.job_worker_name}</strong>
          <div className="k">{o.process}</div>
        </div>
      ),
    },
    {
      key: 'goods',
      header: t('jobWork.col.goods'),
      render: (o) => (
        <div>
          {o.goods}
          <div className="k">{t(`jobWork.kind.${o.goods_kind}`)}</div>
        </div>
      ),
    },
    { key: 'sent', header: t('jobWork.col.sent'), align: 'right', render: (o) => <Qty value={o.qty_sent} /> },
    { key: 'back', header: t('jobWork.col.back'), align: 'right', render: (o) => <Qty value={o.qty_back} /> },
    { key: 'by', header: t('jobWork.col.returnBy'), render: (o) => (o.return_by ? formatDate(o.return_by) : o.status === 'received' ? '—' : t('jobWork.noLimit')) },
    { key: 'state', header: t('common.status'), render: stateChip },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {urgent ? (
        <div className="sf-alert" data-tone={urgent.overdue || Number(urgent.days_left) <= 30 ? 'danger' : 'signal'} role="status">
          <strong>{urgent.overdue ? t('jobWork.banner.overdue', { no: urgent.doc_no, n: Math.abs(Number(urgent.days_left)) }) : t('jobWork.banner.due', { no: urgent.doc_no, n: urgent.days_left })}</strong>{' '}
          {t('jobWork.banner.body', { qty: Number(urgent.qty_balance ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 3 }), goods: urgent.goods ?? '', who: urgent.job_worker_name ?? '' })}
        </div>
      ) : null}
      <TwoCol
        main={
          <>
            <TableCard title={t('jobWork.listTitle')}>
              <DataTable
                caption={t('jobWork.listTitle')}
                columns={columns}
                rows={orders}
                rowKey={(o) => o.id}
                loading={q.isLoading}
                minWidth={820}
                error={q.error ? <ViewError error={q.error} /> : undefined}
                empty={<EmptyState title={t('jobWork.emptyTitle')} body={t('jobWork.emptyBody')} />}
              />
            </TableCard>
            {open ? <OrderDetail order={open} onClose={() => setOpenId(null)} /> : null}
          </>
        }
        side={
          <>
            <ReturnLimits companyId={companyId} />
            <Itc04Card orders={orders} />
          </>
        }
      />
    </div>
  )
}

function ReturnLimits({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const s = useSetting(companyId, 'jobwork.return_years')
  const v = (s.value ?? null) as Record<string, number | null> | null
  const years = (k: string) => {
    if (!v) return t('jobWork.limits.notSet')
    const n = v[k]
    return n === null || n === undefined ? t('jobWork.noLimit') : t('jobWork.limits.years', { count: n })
  }
  return (
    <Card title={t('jobWork.limits.title')}>
      <KeyValue
        rows={[
          { label: t('jobWork.kind.inputs'), value: years('inputs') },
          { label: t('jobWork.kind.capital_goods'), value: years('capital_goods') },
          { label: t('jobWork.limits.moulds'), value: years('moulds_tools') },
        ]}
      />
      <p className="k" style={{ margin: '8px 0 0' }}>
        {t('jobWork.limits.note')}
      </p>
    </Card>
  )
}

/** ITC-04 half-year counts from the job-work views (the return file itself is a Phase 8 / CA item). */
function Itc04Card({ orders }: { orders: Order[] }) {
  const { t } = useTranslation()
  const today = todayIst()
  const [y, m] = today.split('-').map(Number)
  const firstHalf = (m ?? 1) >= 4 && (m ?? 1) <= 9
  const fy = (m ?? 1) >= 4 ? (y ?? 2000) : (y ?? 2000) - 1
  const from = firstHalf ? `${fy}-04-01` : `${fy}-10-01`
  const to = firstHalf ? `${fy}-09-30` : `${fy + 1}-03-31`
  const inHalf = orders.filter((o) => o.sent_on >= from && o.sent_on <= to)
  const back = inHalf.filter((o) => Number(o.qty_back ?? 0) > 0).length
  const workers = new Set(inHalf.map((o) => o.job_worker_party_id)).size
  return (
    <Card title={t('jobWork.itc.title', { period: firstHalf ? t('jobWork.itc.h1', { y: fy }) : t('jobWork.itc.h2', { y: fy, y2: fy + 1 }) })}>
      <p style={{ margin: '0 0 10px' }}>{t('jobWork.itc.counts', { sent: inHalf.length, back, workers })}</p>
      <Button comingInPhase={8}>{t('jobWork.itc.export')}</Button>
    </Card>
  )
}

function OrderDetail({ order, onClose }: { order: Order; onClose: () => void }) {
  const { t } = useTranslation()
  const rights = useOpsRights()
  const lq = useApiView('v_job_work_lines', { eq: { order_id: order.id }, order: 'line_no' })
  const rq = useApiView('v_job_work_receipts', { eq: { order_id: order.id }, order: 'created_at' })
  const lines = rowsOf(lq)
  const receipts = rowsOf(rq)
  const [receiving, setReceiving] = useState(false)
  const open = order.status === 'sent' || order.status === 'part_received'

  const lineCols: Column<Line>[] = [
    { key: 'n', header: '#', render: (l) => <span className="mono">{l.line_no}</span> },
    { key: 'item', header: t('jobWork.col.item'), render: (l) => `${l.product_code} · ${l.product_name}` },
    { key: 'lot', header: t('jobWork.col.lot'), render: (l) => l.lot_no ?? '—' },
    { key: 'sent', header: t('jobWork.col.sent'), align: 'right', render: (l) => <Qty value={l.qty_sent} uom={l.uom} /> },
    { key: 'set', header: t('jobWork.col.settled'), align: 'right', render: (l) => <Qty value={l.qty_settled} uom={l.uom} /> },
    {
      key: 'bal',
      header: t('jobWork.col.balance'),
      align: 'right',
      render: (l) => (
        <span data-testid={`jw-balance-${l.line_no}`} data-value={String(l.balance ?? '')}>
          <Qty value={l.balance} uom={l.uom} />
        </span>
      ),
    },
  ]
  const recCols: Column<Receipt>[] = [
    { key: 'on', header: t('jobWork.col.receivedOn'), render: (r) => formatDate(r.received_on) },
    { key: 'kind', header: t('jobWork.col.kind'), render: (r) => t(`jobWork.backKind.${r.kind}`) },
    { key: 'item', header: t('jobWork.col.item'), render: (r) => r.product_name ?? '—' },
    { key: 'qty', header: t('jobWork.col.qty'), align: 'right', render: (r) => <Qty value={r.qty} /> },
    { key: 'in', header: t('jobWork.col.inputUsed'), align: 'right', render: (r) => <Qty value={r.input_qty} /> },
    { key: 'to', header: t('jobWork.col.to'), render: (r) => r.to_place_name ?? '—' },
    { key: 'ref', header: t('jobWork.col.ref'), render: (r) => r.challan_ref ?? '—' },
    { key: 'by', header: t('jobWork.col.by'), render: (r) => r.received_by_name ?? '—' },
  ]

  return (
    <Card
      title={t('jobWork.detail.title', { no: order.doc_no })}
      action={
        <div style={{ display: 'flex', gap: 8 }}>
          {open && rights.prodCreate ? (
            <Button variant="primary" size="sm" disabled={lq.isLoading} onClick={() => setReceiving(true)}>
              {t('jobWork.detail.receive')}
            </Button>
          ) : null}
          <Button size="sm" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <KeyValue
          rows={[
            { label: t('jobWork.detail.challanNo'), value: order.challan_no ? <Code value={order.challan_no} /> : '—' },
            { label: t('jobWork.col.worker'), value: `${order.job_worker_name ?? ''} · ${order.process}` },
            { label: t('jobWork.detail.from'), value: order.from_place_name ?? '—' },
            { label: t('jobWork.col.returnBy'), value: order.return_by ? formatDate(order.return_by) : t('jobWork.noLimit') },
            { label: t('common.status'), value: <span data-testid="jw-status">{t(`jobWork.status.${order.status}`)}</span> },
          ]}
        />
        <DataTable caption={t('jobWork.detail.lines')} columns={lineCols} rows={lines} rowKey={(l) => l.id} loading={lq.isLoading} minWidth={640} error={lq.error ? <ViewError error={lq.error} /> : undefined} />
        <h3 style={{ margin: 0, fontSize: 14 }}>{t('jobWork.detail.receipts')}</h3>
        <DataTable
          caption={t('jobWork.detail.receipts')}
          columns={recCols}
          rows={receipts}
          rowKey={(r) => r.id}
          loading={rq.isLoading}
          minWidth={760}
          empty={<span className="k">{t('jobWork.detail.noReceipts')}</span>}
          error={rq.error ? <ViewError error={rq.error} /> : undefined}
        />
      </div>
      {receiving ? <ReceiveDialog order={order} lines={lines} onClose={() => setReceiving(false)} /> : null}
    </Card>
  )
}

interface ChallanLine {
  product_id: string
  qty: string
}

function NewChallanDialog({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const suppliers = useApiView('suppliers', { eq: { company_id: companyId }, order: 'name', limit: 2000 })
  const places = useStockPlaces(companyId)
  const items = useStockItems(companyId)
  const [f, setF] = useState({ party: '', process: '', kind: 'inputs', from: '', sent_on: todayIst(), note: '' })
  const [lines, setLines] = useState<ChallanLine[]>([{ product_id: '', qty: '' }])
  const [hint, setHint] = useState<string | null>(null)
  const save = useApiMutation<{ p: Record<string, unknown> }, { doc_no: string; challan_no: string }>('issue_job_work_challan', OPS_REFRESH)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const sendPlaces = places.list.filter((p) => p.kind !== 'job_worker')

  function submit() {
    const clean = lines.filter((l) => l.product_id || l.qty)
    const bad = clean.some((l) => !l.product_id || cleanQty(l.qty) === null)
    if (!f.party || !f.from || clean.length === 0 || bad) {
      setHint(t('jobWork.new_.fill'))
      return
    }
    setHint(null)
    save.mutate(
      { p: { company_id: companyId, job_worker_party_id: f.party, process: f.process.trim(), goods_kind: f.kind, from_place_id: f.from, sent_on: f.sent_on, note: f.note.trim() || null, lines: clean.map((l) => ({ product_id: l.product_id, qty: cleanQty(l.qty) })) } },
      { onSuccess: onClose },
    )
  }

  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('jobWork.new_.title')}
      description={t('jobWork.new_.hint')}
      submitLabel={t('jobWork.new_.submit')}
      busy={save.isPending}
      wide
      onSubmit={submit}
      error={
        <>
          {hint ? (
            <p role="alert" className="sf-field__msg" style={{ margin: 0 }}>
              {hint}
            </p>
          ) : null}
          <OpsErrorBox error={save.error} />
        </>
      }
    >
      <FieldGrid cols={2}>
        <SelectField label={t('jobWork.new_.worker')} value={f.party} onChange={set('party')} placeholder={t('jobWork.new_.choose')} options={rowsOf(suppliers).filter((s) => s.status !== 'inactive').map((s) => ({ value: s.id, label: s.name }))} />
        <Field label={t('jobWork.new_.process')} value={f.process} onChange={set('process')} required help={t('jobWork.new_.processHelp')} />
        <SelectField label={t('jobWork.new_.kind')} value={f.kind} onChange={set('kind')} options={['inputs', 'capital_goods', 'moulds_tools'].map((k) => ({ value: k, label: t(`jobWork.kind.${k}`) }))} />
        <SelectField label={t('jobWork.new_.from')} value={f.from} onChange={set('from')} placeholder={t('jobWork.new_.choose')} options={sendPlaces.map((p) => ({ value: p.id, label: placeLabel(p) }))} />
        <Field label={t('jobWork.new_.sentOn')} type="date" value={f.sent_on} onChange={set('sent_on')} required />
      </FieldGrid>
      <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <legend style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>{t('jobWork.new_.goods')}</legend>
        {lines.map((l, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 1fr) auto', gap: 8, alignItems: 'end' }}>
            <SelectField
              label={t('jobWork.new_.item', { n: i + 1 })}
              value={l.product_id}
              onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, product_id: e.target.value } : x)))}
              placeholder={t('jobWork.new_.choose')}
              options={items.list.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))}
            />
            <Field label={t('jobWork.new_.qty', { n: i + 1 })} inputMode="decimal" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
            <Button size="sm" variant="link" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label={t('jobWork.new_.remove', { n: i + 1 })}>
              {t('jobWork.new_.removeShort')}
            </Button>
          </div>
        ))}
        <div>
          <Button size="sm" onClick={() => setLines([...lines, { product_id: '', qty: '' }])}>
            {t('jobWork.new_.addLine')}
          </Button>
        </div>
      </fieldset>
      <TextAreaField label={t('jobWork.new_.note')} value={f.note} onChange={set('note')} rows={2} />
    </FormDialog>
  )
}

interface BackRow {
  kind: string
  qty: string
  input: string
  product: string
}

function ReceiveDialog({ order, lines, onClose }: { order: Order; lines: Line[]; onClose: () => void }) {
  const { t } = useTranslation()
  const places = useStockPlaces(order.company_id)
  const items = useStockItems(order.company_id)
  const open = lines.filter((l) => Number(l.balance ?? 0) > 0)
  const [head, setHead] = useState({ received_on: todayIst(), challan_ref: '', to: order.from_place_id })
  const [rows, setRows] = useState<Record<string, BackRow>>({})
  const rowOf = (id: string): BackRow => rows[id] ?? { kind: 'returned', qty: '', input: '', product: '' }
  const [hint, setHint] = useState<string | null>(null)
  const save = useApiMutation<{ p_order_id: string; p: Record<string, unknown> }>('receive_job_work', OPS_REFRESH)
  const upd = (id: string, k: keyof BackRow, v: string) => setRows({ ...rows, [id]: { ...rowOf(id), [k]: v } })

  function submit() {
    const out: Record<string, unknown>[] = []
    for (const l of open) {
      const r = rowOf(l.id)
      if (!r.qty && !r.input) continue
      const qty = r.kind === 'loss' ? '0' : cleanQty(r.qty)
      const input = r.input ? cleanQty(r.input) : null
      if (qty === null || (r.input && input === null)) {
        setHint(t('jobWork.back.fill'))
        return
      }
      out.push({ line_id: l.id, kind: r.kind, qty, input_qty: input, product_id: r.product || null })
    }
    if (out.length === 0) {
      setHint(t('jobWork.back.fill'))
      return
    }
    setHint(null)
    save.mutate({ p_order_id: order.id, p: { received_on: head.received_on, challan_ref: head.challan_ref.trim() || null, to_place_id: head.to, lines: out } }, { onSuccess: onClose })
  }

  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('jobWork.back.title', { no: order.doc_no })}
      description={t('jobWork.back.hint')}
      submitLabel={t('jobWork.back.submit')}
      busy={save.isPending}
      wide
      onSubmit={submit}
      error={
        <>
          {hint ? (
            <p role="alert" className="sf-field__msg" style={{ margin: 0 }}>
              {hint}
            </p>
          ) : null}
          <OpsErrorBox error={save.error} />
        </>
      }
    >
      <FieldGrid cols={3}>
        <Field label={t('jobWork.back.on')} type="date" value={head.received_on} onChange={(e) => setHead({ ...head, received_on: e.target.value })} />
        <Field label={t('jobWork.back.ref')} value={head.challan_ref} onChange={(e) => setHead({ ...head, challan_ref: e.target.value })} />
        <SelectField label={t('jobWork.back.to')} value={head.to} onChange={(e) => setHead({ ...head, to: e.target.value })} options={places.list.filter((p) => p.kind !== 'job_worker').map((p) => ({ value: p.id, label: placeLabel(p) }))} />
      </FieldGrid>
      {open.map((l) => {
        const r = rowOf(l.id)
        return (
          <fieldset key={l.id} style={{ border: '1px solid var(--sf-line)', borderRadius: 8, padding: 12, margin: 0 }}>
            <legend style={{ fontWeight: 600, fontSize: 13, padding: '0 4px' }}>{t('jobWork.back.line', { n: l.line_no, item: l.product_name, bal: Number(l.balance ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 3 }), uom: l.uom })}</legend>
            <FieldGrid cols={3}>
              <SelectField label={t('jobWork.back.kind', { n: l.line_no })} value={r.kind} onChange={(e) => upd(l.id, 'kind', e.target.value)} options={['returned', 'finished', 'scrap', 'loss'].map((k) => ({ value: k, label: t(`jobWork.backKind.${k}`) }))} />
              {r.kind !== 'loss' ? <Field label={t('jobWork.back.qty', { n: l.line_no })} inputMode="decimal" value={r.qty} onChange={(e) => upd(l.id, 'qty', e.target.value)} /> : null}
              {r.kind === 'finished' || r.kind === 'loss' ? <Field label={t('jobWork.back.input', { n: l.line_no })} inputMode="decimal" value={r.input} onChange={(e) => upd(l.id, 'input', e.target.value)} help={r.kind === 'finished' ? t('jobWork.back.inputHelp') : undefined} /> : null}
              {r.kind === 'finished' || r.kind === 'scrap' ? (
                <SelectField
                  label={t('jobWork.back.item', { n: l.line_no })}
                  value={r.product}
                  onChange={(e) => upd(l.id, 'product', e.target.value)}
                  placeholder={r.kind === 'finished' ? t('jobWork.back.sameItem') : t('jobWork.new_.choose')}
                  options={items.list.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))}
                />
              ) : null}
            </FieldGrid>
          </fieldset>
        )
      })}
    </FormDialog>
  )
}

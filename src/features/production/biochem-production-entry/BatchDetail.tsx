import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { qtyText } from '@/features/inventory/common/inventory'
import { formatDate, formatTime } from '@/shared/format'
import { Button, Card, Chip, ConfirmDialog, DataTable, EmptyState, Field, FieldGrid, KeyValue, SelectField, type Column } from '@/ui'
import { BatchStepper, cleanNum, CostCell, Done, ProdStatus, ProductionErrorBox, PROD_REFRESH, useProductionRights, type Batch } from '../biochem-common/biochem'

type Weighing = ViewRow<'batch_weighings'>
type Pack = ViewRow<'batch_packaging'>

interface Recon {
  balanced: boolean
  packaging_ok: boolean
  bulk: { bulk_qty: number | null; packed_kg: number; scrap_kg: number; left_kg: number; difference: number; tolerance_pct: number | null; tolerance_set: boolean; tolerance_kg: number; ok: boolean }
  items: { product_id: string; product_code: string; product_name: string; issued: number; in_good: number; in_rejected: number; scrapped: number; returned: number; at_line: number; difference: number }[]
  bug_item_id: string | null
}
interface CloseResult {
  cost: { materials: number; packaging: number; labour: number; machine: number; overhead: number; total: number; good_packs: number; cost_per_pack: number | null; rates_missing: string[] }
}

/** One step card: numbered title, open or done, with its own refusal and success line. */
function Step({ n, title, state, children }: { n: number; title: string; state: 'open' | 'done' | 'later'; children?: ReactNode }) {
  const { t } = useTranslation()
  return (
    <Card
      title={`${n} · ${title}`}
      accent={state === 'open' ? 'signal' : undefined}
      action={<Chip tone={state === 'done' ? 'success' : state === 'open' ? 'teal' : 'outline'}>{t(`biochemEntry.stepState.${state}`)}</Chip>}
    >
      {children}
    </Card>
  )
}

const ORDER = ['planned', 'reserved', 'weighed', 'in_process', 'sample_sent', 'bulk_passed', 'packing', 'packed_hold', 'released', 'closed']
function stateOf(status: string, openIn: string[], doneAfter: string): 'open' | 'done' | 'later' {
  if (openIn.includes(status)) return 'open'
  const i = ORDER.indexOf(status)
  const d = ORDER.indexOf(doneAfter)
  if (status === 'rejected' || status === 'bulk_failed') return i >= 0 && i > d ? 'done' : 'later'
  return i > d ? 'done' : 'later'
}

/** A batch through its steps (see BiochemProductionEntryPage). */
export function BatchDetail({ batch: b }: { batch: Batch }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const lines = useApiView('formula_lines', { eq: { version_id: b.formula_version_id }, order: 'line_no' })
  const fv = useApiView('formula_versions', { eq: { id: b.formula_version_id } })
  const version = rowsOf(fv)[0]
  const bulkLines = rowsOf(lines).filter((l) => l.line_kind === 'bulk')
  const packLines = rowsOf(lines).filter((l) => l.line_kind === 'packaging')
  const s = b.status

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)', gap: 16, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        <Card>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <strong className="mono" data-testid="batch-no">
              {b.batch_no}
            </strong>
            <span data-testid="batch-status">
              <ProdStatus status={s} />
            </span>
            {b.i_made_it ? <Chip tone="info">{t('biochemEntry.youMade')}</Chip> : null}
            <span className="k">
              {b.product_name} · {t('biochemEntry.formulaRef', { code: b.formula_code, v: b.formula_version })} · {t('biochemEntry.plannedQty', { qty: qtyText(b.planned_qty) })}
            </span>
          </div>
          <BatchStepper status={s} />
          {b.reject_reason ? <p className="k">{t('biochemEntry.rejectedBecause', { reason: b.reject_reason })}</p> : null}
        </Card>

        <ReserveStep b={b} />
        <WeighStep b={b} bulkLines={bulkLines} batchSize={version?.batch_size ?? null} />
        <StartStep b={b} />
        <SampleStep b={b} />
        <PackagingStep b={b} packLines={packLines} />
        <PackingStep b={b} />
        <ReconStep b={b} />
        <ReleaseStep b={b} />
        <CloseStep b={b} />
        <Consumption b={b} />
        <Events b={b} />
        {rights.readOnly ? <p className="muted">{t('biochemCommon.readOnly')}</p> : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Card title={t('biochemEntry.label.title')}>
          <KeyValue
            rows={[
              { label: t('biochemEntry.label.batchNo'), value: <span className="mono">{b.batch_no}</span> },
              { label: t('biochemEntry.label.mfg'), value: b.mfg_date ? formatDate(b.mfg_date) : t('biochemEntry.label.atPacking') },
              { label: t('biochemEntry.label.expiry'), value: b.expiry_date ? formatDate(b.expiry_date) : '—' },
              { label: t('biochemEntry.label.fill'), value: b.fill_qty_g !== null ? `${qtyText(b.fill_qty_g)} g` : version?.fill_qty_g ? `${qtyText(version.fill_qty_g)} g` : '—' },
              {
                label: t('biochemEntry.label.licence'),
                value: b.licence_no ? (
                  <span className="mono" data-testid="batch-licence">
                    {b.licence_no}
                  </span>
                ) : (
                  <span className="k">{t('biochemEntry.label.noLicence')}</span>
                ),
              },
              { label: t('biochemEntry.label.places'), value: `${b.stores_place_name} → ${b.line_place_name} → ${b.fg_place_name}` },
              { label: t('biochemEntry.label.plannedBy'), value: b.planned_by_name ?? '—' },
            ]}
          />
        </Card>
        <Card title={t('biochemEntry.posts.title')}>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <li>{t('biochemEntry.posts.bulk')}</li>
            <li>{t('biochemEntry.posts.packaging')}</li>
            <li>{t('biochemEntry.posts.fg')}</li>
            <li>{t('biochemEntry.posts.cost')}</li>
          </ul>
          <p className="k" style={{ marginBottom: 0 }}>
            <Link to={`/production/biochem-costing?company=${b.company_id}`}>{t('biochemEntry.posts.costing')}</Link>
          </p>
        </Card>
        <Card title={t('biochemEntry.labRef.title')}>
          <p className="muted" style={{ margin: 0 }}>
            {t('biochemEntry.labRef.body')}
          </p>
          <p style={{ marginBottom: 0 }}>
            <Link to={`/production/biochem-labs?company=${b.company_id}`}>{t('biochemEntry.labRef.link')}</Link>
          </p>
          <KeyValue
            rows={[
              { label: t('biochemEntry.labRef.bulk'), value: <ProdStatus status={b.last_bulk_result} /> },
              { label: t('biochemEntry.labRef.finished'), value: <ProdStatus status={b.last_finished_result} /> },
            ]}
          />
        </Card>
      </div>
    </div>
  )
}

function useStep<A extends Record<string, unknown>, R = unknown>(fn: string) {
  return useApiMutation<A, R>(fn, PROD_REFRESH)
}

function Feedback({ error, done }: { error: RpcError | null; done: string | null }) {
  if (!error && !done) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
      <ProductionErrorBox error={error} />
      <Done>{done}</Done>
    </div>
  )
}

/* 1 · Reserve (and cancel while nothing has gone to the batch) */
function ReserveStep({ b }: { b: Batch }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const reserve = useStep<{ p_batch_id: string }, { lines: number }>('reserve_batch_materials')
  const cancel = useStep<{ p_batch_id: string; p_reason: string }>('cancel_batch')
  const [reason, setReason] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const state = stateOf(b.status, ['planned'], 'planned')
  return (
    <Step n={1} title={t('biochemEntry.reserve.title')} state={b.status === 'cancelled' ? 'done' : state}>
      <p className="muted" style={{ marginTop: 0 }}>
        {t('biochemEntry.reserve.body')}
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {b.status === 'planned' && rights.create ? (
          <Button
            variant="primary"
            busy={reserve.isPending}
            onClick={() => {
              setDone(null)
              cancel.reset()
              reserve.mutate({ p_batch_id: b.id }, { onSuccess: (r) => setDone(t('biochemEntry.reserve.done', { n: r.lines })) })
            }}
          >
            {t('biochemEntry.reserve.submit')}
          </Button>
        ) : null}
        {['planned', 'reserved'].includes(b.status) && rights.edit ? (
          <>
            <div style={{ flex: '1 1 220px' }}>
              <Field label={t('biochemEntry.reserve.cancelReason')} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <Button
              variant="danger"
              busy={cancel.isPending}
              onClick={() => {
                setDone(null)
                reserve.reset()
                cancel.mutate({ p_batch_id: b.id, p_reason: reason.trim() }, { onSuccess: () => setDone(t('biochemEntry.reserve.cancelled')) })
              }}
            >
              {t('biochemEntry.reserve.cancel')}
            </Button>
          </>
        ) : null}
      </div>
      <Feedback error={reserve.error ?? cancel.error} done={done} />
    </Step>
  )
}

/* 2 · Weigh, and a second person checks each weight */
function WeighStep({ b, bulkLines, batchSize }: { b: Batch; bulkLines: ViewRow<'formula_lines'>[]; batchSize: number | null }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const w = useApiView('batch_weighings', { eq: { batch_id: b.id }, order: 'weighed_at' })
  const lots = useApiView('lots', { eq: { company_id: b.company_id, status: 'available' }, order: 'expiry_date', limit: 1000, enabled: ['reserved', 'weighed'].includes(b.status) })
  const scales = useApiView('assets', { eq: { company_id: b.company_id, kind: 'scale', status: 'active' }, order: 'code', enabled: ['reserved', 'weighed'].includes(b.status) })
  const record = useStep<{ p_batch_id: string; p_lines: Record<string, unknown>[] }, { weighing_ids: string[] }>('record_weighing')
  const verify = useStep<{ p_weighing_id: string; p_ok: boolean; p_note: string | null }, { status: string; batch_status: string }>('verify_weighing')
  const [input, setInput] = useState<Record<string, { lot: string; qty: string; scale: string }>>({})
  const [done, setDone] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const open = ['reserved', 'weighed'].includes(b.status)
  const state = stateOf(b.status, ['reserved'], 'reserved')
  const weighings = rowsOf(w)

  const cols: Column<Weighing>[] = [
    { key: 'item', header: t('biochemEntry.weigh.material'), render: (r) => <span>{r.product_name} <span className="k mono">{r.product_code}</span></span> },
    { key: 'lot', header: t('biochemEntry.weigh.lot'), render: (r) => <span className="mono">{r.lot_no ?? t('biochemEntry.weigh.anyLot')}</span> },
    { key: 'planned', header: t('biochemEntry.weigh.planned'), align: 'right', render: (r) => <span className="sf-amount">{qtyText(r.planned_qty)}</span> },
    { key: 'weighed', header: t('biochemEntry.weigh.weighed'), align: 'right', render: (r) => <span className="sf-amount">{qtyText(r.weighed_qty)}</span> },
    { key: 'by', header: t('biochemEntry.weigh.by'), render: (r) => `${r.weighed_by_name ?? '—'}${r.scale_code ? ` · ${r.scale_code}` : ''}` },
    { key: 'check', header: t('biochemEntry.weigh.checkedBy'), render: (r) => (r.verified_by_name ? `${r.verified_by_name} · ${formatTime(r.verified_at ?? '')}` : '—') },
    { key: 'status', header: t('common.status'), render: (r) => <ProdStatus status={r.status} /> },
    {
      key: 'act',
      header: <span className="sr-only">{t('biochemEntry.weigh.check')}</span>,
      render: (r) =>
        r.status === 'weighed' && open && rights.create ? (
          <span style={{ display: 'inline-flex', gap: 4 }}>
            <Button
              size="sm"
              variant="primary"
              busy={verify.isPending && verify.variables?.p_weighing_id === r.id && verify.variables.p_ok}
              aria-label={t('biochemEntry.weigh.okOne', { item: r.product_name })}
              onClick={() => {
                setDone(null)
                record.reset()
                verify.mutate({ p_weighing_id: r.id, p_ok: true, p_note: null }, { onSuccess: (x) => setDone(t('biochemEntry.weigh.verified', { status: t(`biochemCommon.status.${x.batch_status}`) })) })
              }}
            >
              {t('biochemEntry.weigh.ok')}
            </Button>
            <Button
              size="sm"
              aria-label={t('biochemEntry.weigh.notOkOne', { item: r.product_name })}
              onClick={() => {
                setDone(null)
                record.reset()
                verify.mutate({ p_weighing_id: r.id, p_ok: false, p_note: null }, { onSuccess: () => setDone(t('biochemEntry.weigh.rejected')) })
              }}
            >
              {t('biochemEntry.weigh.notOk')}
            </Button>
          </span>
        ) : null,
    },
  ]

  return (
    <Step n={2} title={t('biochemEntry.weigh.title')} state={state}>
      <p className="muted" style={{ marginTop: 0 }}>
        {t('biochemEntry.weigh.body')}
      </p>
      {open && rights.create ? (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {bulkLines.map((l) => {
              const v = input[l.product_id] ?? { lot: '', qty: '', scale: '' }
              const lotOpts = rowsOf(lots).filter((x) => x.product_id === l.product_id)
              return (
                <div key={l.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 1.3fr) 1fr 120px 1fr', gap: 8, alignItems: 'end' }}>
                  <div>
                    <strong>{l.product_name}</strong>
                    <div className="k">{t('biochemEntry.weigh.formulaQty', { qty: qtyText(l.qty), size: batchSize !== null ? qtyText(batchSize) : '—' })}</div>
                  </div>
                  <SelectField
                    label={t('biochemEntry.weigh.lotFor', { item: l.product_name })}
                    value={v.lot}
                    onChange={(e) => setInput({ ...input, [l.product_id]: { ...v, lot: e.target.value } })}
                    options={[{ value: '', label: t('biochemEntry.weigh.anyLot') }, ...lotOpts.map((x) => ({ value: x.id, label: `${x.lot_no}${x.expiry_date ? ` · ${formatDate(x.expiry_date)}` : ''} · ${qtyText(x.qty_on_hand)} ${x.uom}` }))]}
                  />
                  <Field label={t('biochemEntry.weigh.kgFor', { item: l.product_name })} inputMode="decimal" value={v.qty} onChange={(e) => setInput({ ...input, [l.product_id]: { ...v, qty: e.target.value } })} />
                  <SelectField
                    label={t('biochemEntry.weigh.scaleFor', { item: l.product_name })}
                    value={v.scale}
                    onChange={(e) => setInput({ ...input, [l.product_id]: { ...v, scale: e.target.value } })}
                    options={[{ value: '', label: t('biochemEntry.weigh.noScale') }, ...rowsOf(scales).map((a) => ({ value: a.id, label: `${a.code} · ${a.name}${a.calibration_overdue ? ` (${t('biochemEntry.weigh.calDue')})` : ''}` }))]}
                  />
                </div>
              )
            })}
          </div>
          <div style={{ marginTop: 12 }}>
            <Button
              variant="primary"
              busy={record.isPending}
              onClick={() => {
                setDone(null)
                setHint(null)
                verify.reset()
                const out = bulkLines
                  .map((l) => ({ l, v: input[l.product_id] }))
                  .filter((x) => x.v && x.v.qty.trim())
                  .map(({ l, v }) => ({ product_id: l.product_id, lot_id: v?.lot || null, qty: cleanNum(v?.qty ?? ''), scale_asset_id: v?.scale || null }))
                if (out.length === 0 || out.some((x) => !x.qty)) return setHint(t('biochemEntry.weigh.hint'))
                record.mutate(
                  { p_batch_id: b.id, p_lines: out },
                  {
                    onSuccess: (r) => {
                      setInput({})
                      setDone(t('biochemEntry.weigh.recorded', { n: r.weighing_ids.length }))
                    },
                  },
                )
              }}
            >
              {t('biochemEntry.weigh.submit')}
            </Button>
          </div>
        </>
      ) : null}
      {hint ? (
        <p role="alert" className="sf-alert" data-tone="danger" style={{ margin: '12px 0 0' }}>
          {hint}
        </p>
      ) : null}
      <div style={{ marginTop: 12 }}>
        <DataTable caption={t('biochemEntry.weigh.listTitle')} columns={cols} rows={weighings} rowKey={(r) => r.id} loading={w.isLoading} minWidth={900} empty={<EmptyState title={t('biochemEntry.weigh.empty')} />} />
      </div>
      <Feedback error={record.error ?? verify.error} done={done} />
    </Step>
  )
}

/* 3 · Start */
function StartStep({ b }: { b: Batch }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const start = useStep<{ p_batch_id: string }>('start_batch')
  const [done, setDone] = useState<string | null>(null)
  return (
    <Step n={3} title={t('biochemEntry.start.title')} state={stateOf(b.status, ['weighed'], 'weighed')}>
      <p className="muted" style={{ marginTop: 0 }}>
        {b.started_at ? t('biochemEntry.start.started', { date: formatDate(b.started_at), time: formatTime(b.started_at) }) : t('biochemEntry.start.body')}
      </p>
      {b.status === 'weighed' && rights.create ? (
        <Button variant="primary" busy={start.isPending} onClick={() => start.mutate({ p_batch_id: b.id }, { onSuccess: () => setDone(t('biochemEntry.start.done')) })}>
          {t('biochemEntry.start.submit')}
        </Button>
      ) : null}
      <Feedback error={start.error} done={done} />
    </Step>
  )
}

/* 4 · Samples to the lab (bulk with the bulk weight; finished and retained after packing) */
function SampleStep({ b }: { b: Batch }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const samples = useApiView('lab_samples', { eq: { batch_id: b.id }, order: 'taken_at' })
  const send = useStep<{ p_batch_id: string; p: Record<string, unknown> }, { sample_no: string }>('send_sample')
  const [kind, setKind] = useState('bulk')
  const [bulk, setBulk] = useState('')
  const [labour, setLabour] = useState('')
  const [machine, setMachine] = useState('')
  const [retain, setRetain] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const kinds = b.status === 'in_process' ? ['bulk', 'in_process'] : b.status === 'packed_hold' ? ['finished', 'retained'] : ['released', 'closed'].includes(b.status) ? ['retained'] : []
  const effKind = kinds.includes(kind) ? kind : (kinds[0] ?? 'bulk')
  const cols: Column<ViewRow<'lab_samples'>>[] = [
    { key: 'no', header: t('biochemEntry.sample.no'), render: (r) => <span className="mono">{r.sample_no}</span> },
    { key: 'kind', header: t('biochemEntry.sample.kind'), render: (r) => t(`biochemEntry.sampleKind.${r.kind}`, { defaultValue: r.kind }) },
    { key: 'when', header: t('biochemEntry.sample.taken'), render: (r) => `${formatDate(r.taken_at)} · ${r.taken_by_name ?? '—'}` },
    { key: 'status', header: t('common.status'), render: (r) => <ProdStatus status={r.status} /> },
    { key: 'result', header: t('biochemEntry.sample.result'), render: (r) => <ProdStatus status={r.last_result} /> },
  ]
  return (
    <Step n={4} title={t('biochemEntry.sample.title')} state={stateOf(b.status, ['in_process', 'sample_sent'], 'sample_sent')}>
      <p className="muted" style={{ marginTop: 0 }}>
        {t('biochemEntry.sample.body')}
        {b.bulk_qty !== null ? ` ${t('biochemEntry.sample.bulkMade', { qty: qtyText(b.bulk_qty) })}` : ''}
      </p>
      {kinds.length && rights.create ? (
        <>
          <FieldGrid cols={3}>
            <SelectField label={t('biochemEntry.sample.kind')} value={effKind} onChange={(e) => setKind(e.target.value)} options={kinds.map((k) => ({ value: k, label: t(`biochemEntry.sampleKind.${k}`) }))} />
            {effKind === 'bulk' ? (
              <>
                <Field label={t('biochemEntry.sample.bulkQty')} inputMode="decimal" value={bulk} onChange={(e) => setBulk(e.target.value)} />
                <Field label={t('biochemEntry.sample.labour')} inputMode="decimal" value={labour} onChange={(e) => setLabour(e.target.value)} />
                <Field label={t('biochemEntry.sample.machine')} inputMode="decimal" value={machine} onChange={(e) => setMachine(e.target.value)} />
              </>
            ) : null}
            {effKind === 'retained' ? <Field label={t('biochemEntry.sample.retainUntil')} type="date" value={retain} onChange={(e) => setRetain(e.target.value)} /> : null}
          </FieldGrid>
          <div style={{ marginTop: 12 }}>
            <Button
              variant="primary"
              busy={send.isPending}
              onClick={() => {
                setDone(null)
                send.mutate(
                  { p_batch_id: b.id, p: { kind: effKind, bulk_qty: effKind === 'bulk' ? cleanNum(bulk) : null, labour_hours: labour.trim() || null, machine_hours: machine.trim() || null, retain_until: retain || null } },
                  { onSuccess: (r) => setDone(t('biochemEntry.sample.sent', { no: r.sample_no })) },
                )
              }}
            >
              {t('biochemEntry.sample.submit')}
            </Button>
          </div>
        </>
      ) : null}
      <div style={{ marginTop: 12 }}>
        <DataTable caption={t('biochemEntry.sample.listTitle')} columns={cols} rows={rowsOf(samples)} rowKey={(r) => r.id} loading={samples.isLoading} minWidth={640} empty={<EmptyState title={t('biochemEntry.sample.empty')} />} />
      </div>
      <Feedback error={send.error} done={done} />
    </Step>
  )
}

/* 5 · Packaging to the line (Nos, whole numbers) */
function PackagingStep({ b, packLines }: { b: Batch; packLines: ViewRow<'formula_lines'>[] }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const issue = useStep<{ p_batch_id: string; p_lines: Record<string, unknown>[] }, { lines: number }>('issue_batch_packaging')
  const [qty, setQty] = useState<Record<string, string>>({})
  const [done, setDone] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const open = ['bulk_passed', 'packing'].includes(b.status)
  return (
    <Step n={5} title={t('biochemEntry.issue.title')} state={stateOf(b.status, ['bulk_passed'], 'bulk_passed')}>
      <p className="muted" style={{ marginTop: 0 }}>
        {t('biochemEntry.issue.body')}
      </p>
      {open && rights.create ? (
        packLines.length === 0 ? (
          <p className="k">{t('biochemEntry.issue.noLines')}</p>
        ) : (
          <>
            <FieldGrid cols={3}>
              {packLines.map((l) => (
                <Field key={l.id} label={t('biochemEntry.issue.qtyFor', { item: l.product_name, per: qtyText(l.qty) })} inputMode="numeric" value={qty[l.product_id] ?? ''} onChange={(e) => setQty({ ...qty, [l.product_id]: e.target.value })} />
              ))}
            </FieldGrid>
            <div style={{ marginTop: 12 }}>
              <Button
                variant="primary"
                busy={issue.isPending}
                onClick={() => {
                  setDone(null)
                  setHint(null)
                  const out = packLines.filter((l) => (qty[l.product_id] ?? '').trim()).map((l) => ({ product_id: l.product_id, qty: (qty[l.product_id] ?? '').trim() }))
                  if (out.length === 0 || out.some((x) => !/^\d+$/.test(x.qty))) return setHint(t('biochemEntry.issue.hint'))
                  issue.mutate(
                    { p_batch_id: b.id, p_lines: out },
                    {
                      onSuccess: (r) => {
                        setQty({})
                        setDone(t('biochemEntry.issue.done', { n: r.lines }))
                      },
                    },
                  )
                }}
              >
                {t('biochemEntry.issue.submit')}
              </Button>
            </div>
          </>
        )
      ) : null}
      {hint ? (
        <p role="alert" className="sf-alert" data-tone="danger" style={{ margin: '12px 0 0' }}>
          {hint}
        </p>
      ) : null}
      <Feedback error={issue.error} done={done} />
    </Step>
  )
}

/* 6 · Packing (once): good packs into quarantine as lot = batch no; packaging counts at the line */
function PackingStep({ b }: { b: Batch }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const pk = useApiView('batch_packaging', { eq: { batch_id: b.id }, order: 'product_code' })
  const pack = useStep<{ p_batch_id: string; p: Record<string, unknown> }, { recon: Recon }>('record_packing')
  const [f, setF] = useState({ good: '', rejected: '0', scrap: '0', left: '0', labour: '', machine: '', mfg: todayIst(), expiry: '' })
  const [counts, setCounts] = useState<Record<string, { scrapped: string; returned: string; at_line: string }>>({})
  const [done, setDone] = useState<string | null>(null)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const open = b.status === 'packing'
  return (
    <Step n={6} title={t('biochemEntry.pack.title')} state={stateOf(b.status, ['packing'], 'packing')}>
      <p className="muted" style={{ marginTop: 0 }}>
        {b.packed_at ? t('biochemEntry.pack.packed', { good: qtyText(b.good_packs), rejected: qtyText(b.rejected_packs), date: formatDate(b.packed_at) }) : t('biochemEntry.pack.body')}
      </p>
      {open && rights.create ? (
        <>
          <FieldGrid cols={3}>
            <Field label={t('biochemEntry.pack.good')} inputMode="numeric" value={f.good} onChange={set('good')} />
            <Field label={t('biochemEntry.pack.rejected')} inputMode="numeric" value={f.rejected} onChange={set('rejected')} />
            <Field label={t('biochemEntry.pack.scrap')} inputMode="decimal" value={f.scrap} onChange={set('scrap')} />
            <Field label={t('biochemEntry.pack.left')} inputMode="decimal" value={f.left} onChange={set('left')} />
            <Field label={t('biochemEntry.pack.labour')} inputMode="decimal" value={f.labour} onChange={set('labour')} />
            <Field label={t('biochemEntry.pack.machine')} inputMode="decimal" value={f.machine} onChange={set('machine')} />
            <Field label={t('biochemEntry.pack.mfg')} type="date" value={f.mfg} onChange={set('mfg')} />
            <Field label={t('biochemEntry.pack.expiry')} type="date" value={f.expiry} onChange={set('expiry')} />
          </FieldGrid>
          {rowsOf(pk).length ? (
            <>
              <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>{t('biochemEntry.pack.countsTitle')}</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {rowsOf(pk).map((p) => {
                  const c = counts[p.product_id] ?? { scrapped: '0', returned: '0', at_line: '0' }
                  const setC = (k: 'scrapped' | 'returned' | 'at_line') => (e: { target: { value: string } }) => setCounts({ ...counts, [p.product_id]: { ...c, [k]: e.target.value } })
                  return (
                    <div key={p.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 1.4fr) repeat(3, 1fr)', gap: 8, alignItems: 'end' }}>
                      <div>
                        <strong>{p.product_name}</strong>
                        <div className="k">{t('biochemEntry.pack.issued', { n: qtyText(p.issued), uom: p.uom })}</div>
                      </div>
                      <Field label={t('biochemEntry.pack.scrappedFor', { item: p.product_name })} inputMode="numeric" value={c.scrapped} onChange={setC('scrapped')} />
                      <Field label={t('biochemEntry.pack.returnedFor', { item: p.product_name })} inputMode="numeric" value={c.returned} onChange={setC('returned')} />
                      <Field label={t('biochemEntry.pack.atLineFor', { item: p.product_name })} inputMode="numeric" value={c.at_line} onChange={setC('at_line')} />
                    </div>
                  )
                })}
              </div>
            </>
          ) : null}
          <div style={{ marginTop: 12 }}>
            <Button
              variant="primary"
              busy={pack.isPending}
              onClick={() => {
                setDone(null)
                pack.mutate(
                  {
                    p_batch_id: b.id,
                    p: {
                      good_packs: f.good.trim(),
                      rejected_packs: f.rejected.trim() || '0',
                      bulk_scrap_kg: f.scrap.trim() || '0',
                      bulk_left_kg: f.left.trim() || '0',
                      labour_hours: f.labour.trim() || null,
                      machine_hours: f.machine.trim() || null,
                      mfg_date: f.mfg || null,
                      expiry_date: f.expiry || null,
                      packaging: rowsOf(pk).map((p) => ({ product_id: p.product_id, ...(counts[p.product_id] ?? { scrapped: '0', returned: '0', at_line: '0' }) })),
                    },
                  },
                  { onSuccess: (r) => setDone(r.recon.balanced ? t('biochemEntry.pack.doneBalanced') : t('biochemEntry.pack.doneMismatch')) },
                )
              }}
            >
              {t('biochemEntry.pack.submit')}
            </Button>
          </div>
        </>
      ) : null}
      <Feedback error={pack.error} done={done} />
    </Step>
  )
}

/* 7 · Reconciliation: packaging and bulk; a difference opens a Bug fixer item and blocks close */
function ReconStep({ b }: { b: Batch }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const pk = useApiView('batch_packaging', { eq: { batch_id: b.id }, order: 'product_code' })
  const recon = useStep<{ p_batch_id: string; p_counts: Record<string, unknown>[] | null }, Recon>('reconcile_packaging')
  const [counts, setCounts] = useState<Record<string, { scrapped: string; returned: string; at_line: string }>>({})
  const open = ['packed_hold', 'released', 'rejected'].includes(b.status) && Boolean(b.packed_at)
  const cols: Column<Pack>[] = [
    { key: 'item', header: t('biochemEntry.recon.item'), render: (p) => p.product_name },
    { key: 'issued', header: t('biochemEntry.recon.issued'), align: 'right', render: (p) => <span className="sf-amount">{qtyText(p.issued)}</span> },
    { key: 'good', header: t('biochemEntry.recon.inGood'), align: 'right', render: (p) => <span className="sf-amount">{qtyText(p.in_good)}</span> },
    { key: 'rej', header: t('biochemEntry.recon.inRejected'), align: 'right', render: (p) => <span className="sf-amount">{qtyText(p.in_rejected)}</span> },
    { key: 'scr', header: t('biochemEntry.recon.scrapped'), align: 'right', render: (p) => <span className="sf-amount">{qtyText(p.scrapped)}</span> },
    { key: 'ret', header: t('biochemEntry.recon.returned'), align: 'right', render: (p) => <span className="sf-amount">{qtyText(p.returned)}</span> },
    { key: 'line', header: t('biochemEntry.recon.atLine'), align: 'right', render: (p) => <span className="sf-amount">{qtyText(p.at_line)}</span> },
    { key: 'diff', header: t('biochemEntry.recon.difference'), align: 'right', render: (p) => <span className="sf-amount" data-negative={Number(p.difference) !== 0 ? 'true' : undefined}>{qtyText(p.difference)}</span> },
  ]
  const r = recon.data
  return (
    <Step n={7} title={t('biochemEntry.recon.title')} state={b.recon_status === 'balanced' ? 'done' : open ? 'open' : 'later'}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <span>{t('biochemEntry.recon.state')}</span>
        <span data-testid="recon-status">
          <ProdStatus status={b.recon_status === 'pending' ? null : b.recon_status} />
        </span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        {t('biochemEntry.recon.body')}
      </p>
      <DataTable caption={t('biochemEntry.recon.title')} columns={cols} rows={rowsOf(pk)} rowKey={(p) => p.id} loading={pk.isLoading} minWidth={760} empty={<EmptyState title={t('biochemEntry.recon.empty')} />} />
      {b.packed_at ? (
        <p className="k">
          {t('biochemEntry.recon.bulkLine', { bulk: qtyText(b.bulk_qty), scrap: qtyText(b.bulk_scrap_kg), left: qtyText(b.bulk_left_kg), fill: qtyText(b.fill_qty_g) })}
        </p>
      ) : null}
      {open && rights.create ? (
        <>
          {rowsOf(pk).length ? (
            <details style={{ marginTop: 8 }}>
              <summary>{t('biochemEntry.recon.recount')}</summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                {rowsOf(pk).map((p) => {
                  const c = counts[p.product_id] ?? { scrapped: String(p.scrapped), returned: String(p.returned), at_line: String(p.at_line) }
                  const setC = (k: 'scrapped' | 'returned' | 'at_line') => (e: { target: { value: string } }) => setCounts({ ...counts, [p.product_id]: { ...c, [k]: e.target.value } })
                  return (
                    <div key={p.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 1.4fr) repeat(3, 1fr)', gap: 8, alignItems: 'end' }}>
                      <strong>{p.product_name}</strong>
                      <Field label={t('biochemEntry.pack.scrappedFor', { item: p.product_name })} inputMode="numeric" value={c.scrapped} onChange={setC('scrapped')} />
                      <Field label={t('biochemEntry.pack.returnedFor', { item: p.product_name })} inputMode="numeric" value={c.returned} onChange={setC('returned')} />
                      <Field label={t('biochemEntry.pack.atLineFor', { item: p.product_name })} inputMode="numeric" value={c.at_line} onChange={setC('at_line')} />
                    </div>
                  )
                })}
              </div>
            </details>
          ) : null}
          <div style={{ marginTop: 12 }}>
            <Button
              variant="primary"
              busy={recon.isPending}
              onClick={() => {
                const changed = Object.entries(counts).map(([product_id, c]) => ({ product_id, ...c }))
                recon.mutate({ p_batch_id: b.id, p_counts: changed.length ? changed : null })
              }}
            >
              {t('biochemEntry.recon.submit')}
            </Button>
          </div>
        </>
      ) : null}
      {r ? (
        <div role="status" className="sf-alert" data-tone={r.balanced ? 'success' : 'danger'} style={{ margin: '12px 0 0', flexDirection: 'column' }} data-testid="recon-result">
          <strong>{r.balanced ? t('biochemEntry.recon.balanced') : t('biochemEntry.recon.mismatch')}</strong>
          <span>
            {t('biochemEntry.recon.bulkResult', {
              bulk: qtyText(r.bulk.bulk_qty),
              packed: qtyText(r.bulk.packed_kg),
              scrap: qtyText(r.bulk.scrap_kg),
              left: qtyText(r.bulk.left_kg),
              diff: qtyText(r.bulk.difference),
              tol: r.bulk.tolerance_set ? t('biochemEntry.recon.tolerance', { pct: r.bulk.tolerance_pct, kg: qtyText(r.bulk.tolerance_kg) }) : t('biochemEntry.recon.exact'),
            })}
          </span>
          {r.bug_item_id ? (
            <Link to="/admin/bug-fixer">{t('biochemEntry.recon.bug')}</Link>
          ) : null}
        </div>
      ) : null}
      <Feedback error={recon.error} done={null} />
    </Step>
  )
}

/* 8 · QC release or reject — never by someone who made the batch (the server refuses: sod.self_release) */
function ReleaseStep({ b }: { b: Batch }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const release = useStep<{ p_batch_id: string; p_note: string | null }, { released_qty: number }>('qc_release_batch')
  const reject = useStep<{ p_batch_id: string; p_reason: string }, { rejected_qty: number }>('qc_reject_batch')
  const [note, setNote] = useState('')
  const [reason, setReason] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const open = ['packed_hold', 'bulk_failed'].includes(b.status)
  return (
    <Step n={8} title={t('biochemEntry.qc.title')} state={stateOf(b.status, ['packed_hold', 'bulk_failed'], 'packed_hold')}>
      <p className="muted" style={{ marginTop: 0 }}>
        {b.released_by_name ? t('biochemEntry.qc.decidedBy', { name: b.released_by_name, date: formatDate(b.released_at ?? '') }) : t('biochemEntry.qc.body')}
      </p>
      {open && b.i_made_it ? (
        <p className="sf-alert" data-tone="info" style={{ margin: '0 0 8px' }}>
          {t('biochemEntry.qc.youMade')}
        </p>
      ) : null}
      {open && rights.qcRelease ? (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            {b.status === 'packed_hold' ? (
              <>
                <div style={{ flex: '1 1 220px' }}>
                  <Field label={t('biochemEntry.qc.note')} value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
                <Button
                  variant="primary"
                  busy={release.isPending}
                  onClick={() => {
                    setDone(null)
                    reject.reset()
                    release.mutate({ p_batch_id: b.id, p_note: note.trim() || null }, { onSuccess: (r) => setDone(t('biochemEntry.qc.released', { qty: qtyText(r.released_qty) })) })
                  }}
                >
                  {t('biochemEntry.qc.release')}
                </Button>
              </>
            ) : null}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 8 }}>
            <div style={{ flex: '1 1 220px' }}>
              <Field label={t('biochemEntry.qc.reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <Button
              variant="danger"
              busy={reject.isPending}
              onClick={() => {
                setDone(null)
                release.reset()
                reject.mutate({ p_batch_id: b.id, p_reason: reason.trim() }, { onSuccess: (r) => setDone(t('biochemEntry.qc.rejected', { qty: qtyText(r.rejected_qty) })) })
              }}
            >
              {t('biochemEntry.qc.reject')}
            </Button>
          </div>
        </>
      ) : open ? (
        <p className="k">{t('biochemEntry.qc.noRight')}</p>
      ) : null}
      <Feedback error={release.error ?? reject.error} done={done} />
    </Step>
  )
}

/* 9 · Close with the cost sheet */
function CloseStep({ b }: { b: Batch }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const close = useStep<{ p_batch_id: string }, CloseResult>('close_batch')
  const [confirm, setConfirm] = useState(false)
  const open = ['released', 'rejected'].includes(b.status)
  const c = close.data?.cost
  return (
    <Step n={9} title={t('biochemEntry.close.title')} state={b.status === 'closed' ? 'done' : open ? 'open' : 'later'}>
      <p className="muted" style={{ marginTop: 0 }}>
        {b.closed_at ? t('biochemEntry.close.closed', { date: formatDate(b.closed_at) }) : t('biochemEntry.close.body')}
      </p>
      {open && rights.approve ? (
        <Button variant="primary" busy={close.isPending} onClick={() => setConfirm(true)}>
          {t('biochemEntry.close.submit')}
        </Button>
      ) : open ? (
        <p className="k">{t('biochemEntry.close.noRight')}</p>
      ) : null}
      {c ? (
        <div role="status" style={{ marginTop: 12 }} data-testid="close-cost">
          <KeyValue
            rows={[
              { label: t('biochemCosting.col.materials'), value: <CostCell value={c.materials} /> },
              { label: t('biochemCosting.col.packaging'), value: <CostCell value={c.packaging} /> },
              { label: t('biochemCosting.col.labour'), value: <CostCell value={c.labour} /> },
              { label: t('biochemCosting.col.machine'), value: <CostCell value={c.machine} /> },
              { label: t('biochemCosting.col.overhead'), value: <CostCell value={c.overhead} /> },
              { label: t('biochemCosting.col.total'), value: <CostCell value={c.total} />, total: true },
              { label: t('biochemCosting.col.perPack'), value: <CostCell value={c.cost_per_pack} digits={4} /> },
            ]}
          />
          {c.rates_missing.length ? (
            <p className="sf-alert" data-tone="danger" style={{ marginBottom: 0 }}>
              {t('biochemCosting.ratesMissing', { list: c.rates_missing.map((k) => t(`biochemCosting.rate.${k}`)).join(', ') })}
            </p>
          ) : null}
        </div>
      ) : null}
      <Feedback error={close.error} done={null} />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('biochemEntry.close.confirmTitle', { no: b.batch_no })}
        effect={t('biochemEntry.close.effect')}
        confirmLabel={t('biochemEntry.close.submit')}
        busy={close.isPending}
        onConfirm={() => close.mutate({ p_batch_id: b.id }, { onSettled: () => setConfirm(false) })}
      />
    </Step>
  )
}

/* Consumption ledger of the batch (append-only) */
function Consumption({ b }: { b: Batch }) {
  const { t } = useTranslation()
  const q = useApiView('material_consumption', { eq: { batch_id: b.id }, order: 'id' })
  const cols: Column<ViewRow<'material_consumption'>>[] = [
    { key: 'date', header: t('biochemEntry.cons.date'), render: (r) => formatDate(r.consumed_on) },
    { key: 'kind', header: t('biochemEntry.cons.kind'), render: (r) => t(`biochemEntry.consKind.${r.kind}`, { defaultValue: r.kind }) },
    { key: 'item', header: t('biochemEntry.cons.item'), render: (r) => r.product_name },
    { key: 'lot', header: t('biochemEntry.cons.lot'), render: (r) => <span className="mono">{r.lot_no ?? '—'}</span> },
    { key: 'qty', header: t('biochemEntry.cons.qty'), align: 'right', render: (r) => <span className="sf-amount">{qtyText(r.qty)} {r.uom}</span> },
    { key: 'value', header: t('biochemEntry.cons.value'), align: 'right', render: (r) => <CostCell value={r.value} /> },
  ]
  return (
    <TableCard title={t('biochemEntry.cons.title')}>
      <DataTable caption={t('biochemEntry.cons.title')} columns={cols} rows={rowsOf(q)} rowKey={(r) => String(r.id)} loading={q.isLoading} minWidth={700} empty={<EmptyState title={t('biochemEntry.cons.empty')} />} />
    </TableCard>
  )
}

function Events({ b }: { b: Batch }) {
  const { t } = useTranslation()
  const q = useApiView('batch_events', { eq: { batch_id: b.id }, order: 'id' })
  return (
    <Card title={t('biochemEntry.events.title')}>
      {rowsOf(q).length === 0 ? (
        <p className="k" style={{ margin: 0 }}>
          {t('biochemEntry.events.empty')}
        </p>
      ) : (
        <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {rowsOf(q).map((e) => (
            <li key={e.id}>
              <strong>{t(`biochemCommon.status.${e.to_status}`, { defaultValue: e.to_status })}</strong> · {e.by_name ?? '—'} · {formatDate(e.at)} {formatTime(e.at)}
              {e.note ? ` · ${e.note}` : ''}
            </li>
          ))}
        </ol>
      )}
    </Card>
  )
}

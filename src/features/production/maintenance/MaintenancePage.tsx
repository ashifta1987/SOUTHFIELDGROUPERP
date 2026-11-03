import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiRpc, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { Qty, cleanQty, placeLabel, useStockItems, useStockPlaces } from '@/features/inventory/common/inventory'
import { ViewError } from '@/features/production/biochem-common/biochem'
import { PlasticsFrame, useCompanyPeople, useMachines } from '@/features/production/plastics-common/plastics'
import { OPS_REFRESH, OpsErrorBox, TwoCol, useOpsRights } from '@/features/production/ops-common/ops'
import { formatDate, formatIndian, formatTime } from '@/shared/format'
import { Amount, Button, Card, Checkbox, Chip, ConfirmDialog, DataTable, EmptyState, Field, FieldGrid, FormDialog, KeyValue, KpiTiles, SelectField, Skeleton, TextAreaField, type Column } from '@/ui'

type Repair = ViewRow<'v_repair_requests'>
type Spare = ViewRow<'v_spares_issues'>
type Schedule = ViewRow<'v_maintenance_schedules'>
interface Summary {
  machines: number
  checked_today: number
  open_requests: Record<string, number> | null
  done_this_month: number
  breakdown_hours_month: number | string
  schedules_overdue: number
  spend_month: number | string | null
}

/** "YYYY-MM-DDTHH:mm" in the browser's time for a datetime-local input. */
function localNow(): string {
  const d = new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}
function toIso(local: string): string | null {
  if (!local) return null
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
function hoursText(minutes: number | string | null | undefined): string {
  if (minutes === null || minutes === undefined || minutes === '') return '—'
  return formatIndian(Number(minutes) / 60, 2)
}

/**
 * Production → Machine care and maintenance (`Maintenance`): repair requests (from a ✗ on the operator's daily check,
 * or raised here), assignment, spares issued through the stock ledger, closing with the downtime the server computes
 * (breakdown → restored), and planned care schedules. Tiles come from api.maintenance_summary (spend only with cost
 * rights). Every state change is an RPC (api.raise_repair_request … api.record_maintenance_done).
 */
export function MaintenancePage() {
  const { t } = useTranslation()
  const rights = useOpsRights()
  const [raising, setRaising] = useState(false)
  return (
    <PlasticsFrame
      step="maintenance"
      title={t('maintenance.title')}
      subtitle={t('maintenance.subtitle')}
      actions={(cid) => (
        <>
          <Link to={`/admin/asset-register?company=${cid}`} className="sf-btn" data-variant="secondary">
            {t('maintenance.addMachine')}
          </Link>
          {rights.prodCreate || rights.assetsManage ? (
            <Button variant="danger" onClick={() => setRaising(true)}>
              {t('maintenance.report')}
            </Button>
          ) : null}
        </>
      )}
    >
      {(companyId) => (
        <>
          <Body companyId={companyId} />
          {raising ? <RaiseDialog companyId={companyId} onClose={() => setRaising(false)} /> : null}
        </>
      )}
    </PlasticsFrame>
  )
}

function Body({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const rights = useOpsRights()
  const sum = useApiRpc<Summary>('maintenance_summary', { p_company_id: companyId })
  const s = sum.data?.status === 'ready' ? sum.data.data : null
  const rq = useApiView('v_repair_requests', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 300 })
  const reqs = rowsOf(rq)
  const [openId, setOpenId] = useState<string | null>(null)
  const open = reqs.find((r) => r.id === openId) ?? null
  const monthStart = `${todayIst().slice(0, 7)}-01`
  const openCount = s?.open_requests ? Object.values(s.open_requests).reduce((a, b) => a + Number(b), 0) : 0

  const columns: { key: string; status: string[]; filter?: (r: Repair) => boolean }[] = [
    { key: 'new', status: ['new'] },
    { key: 'assigned', status: ['assigned'] },
    { key: 'waiting_parts', status: ['waiting_parts'] },
    { key: 'done', status: ['done'], filter: (r) => (r.closed_at ?? '') >= monthStart },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {sum.isLoading ? (
        <Card>
          <Skeleton height={60} />
        </Card>
      ) : sum.error ? (
        <ViewError error={sum.error} />
      ) : (
        <KpiTiles
          ariaLabel={t('maintenance.kpis')}
          items={[
            { key: 'checked', label: t('maintenance.kpi.checked'), value: s ? `${s.checked_today} / ${s.machines}` : '—', sub: t('maintenance.kpi.checkedSub') },
            { key: 'open', label: t('maintenance.kpi.open'), value: <span data-testid="mt-open">{openCount}</span>, sub: t('maintenance.kpi.openSub') },
            { key: 'hours', label: t('maintenance.kpi.hours'), value: s ? formatIndian(s.breakdown_hours_month, 2) : '—', sub: t('maintenance.kpi.hoursSub') },
            { key: 'overdue', label: t('maintenance.kpi.overdue'), value: s?.schedules_overdue ?? '—', sub: t('maintenance.kpi.overdueSub') },
            { key: 'spend', label: t('maintenance.kpi.spend'), value: rights.costs ? <Amount value={s?.spend_month ?? null} /> : <span className="k">{t('opsCommon.costHidden')}</span>, sub: t('maintenance.kpi.spendSub') },
          ]}
        />
      )}
      <Card title={t('maintenance.requests')} action={<span className="k">{t('maintenance.requestsSub')}</span>}>
        {rq.error ? <ViewError error={rq.error} /> : null}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          {columns.map((c) => {
            const list = reqs.filter((r) => c.status.includes(r.status) && (!c.filter || c.filter(r)))
            return (
              <section key={c.key} aria-labelledby={`mt-col-${c.key}`} style={{ background: 'var(--sf-surface-2, var(--sf-bg))', borderRadius: 8, padding: 10, minHeight: 120 }}>
                <h3 id={`mt-col-${c.key}`} style={{ margin: 0, fontSize: 13, display: 'flex', justifyContent: 'space-between' }}>
                  <span>{t(`maintenance.col.${c.key}`)}</span>
                  <span className="mono">{list.length}</span>
                </h3>
                <p className="k" style={{ margin: '2px 0 8px' }}>
                  {t(`maintenance.colSub.${c.key}`)}
                </p>
                {rq.isLoading ? <Skeleton height={40} /> : null}
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {list.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        className="sf-card sf-card__pad"
                        onClick={() => setOpenId(r.id)}
                        aria-pressed={openId === r.id}
                        style={{ width: '100%', textAlign: 'left', cursor: 'pointer', padding: 10, borderColor: openId === r.id ? 'var(--sf-primary)' : undefined }}
                      >
                        <span className="mono" style={{ fontWeight: 600, display: 'block' }}>
                          {r.doc_no ?? '—'}
                        </span>
                        <span style={{ display: 'block' }}>{r.title}</span>
                        <span className="k" style={{ display: 'block' }}>
                          {r.asset_code ?? r.mould_code ?? ''} {r.asset_name ? `· ${r.asset_name}` : ''}
                        </span>
                        <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                          {r.priority === 'urgent' ? (
                            <Chip tone="danger" icon="alert">
                              {t('maintenance.priority.urgent')}
                            </Chip>
                          ) : null}
                          {r.is_breakdown ? <Chip tone="signal">{t('maintenance.breakdownChip', { h: hoursText(r.downtime_minutes) })}</Chip> : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      </Card>
      {open ? <RequestDetail req={open} onClose={() => setOpenId(null)} /> : null}
      <TwoCol main={<Schedules companyId={companyId} />} side={<SideCards companyId={companyId} summary={s} />} />
    </div>
  )
}

function SideCards({ companyId, summary }: { companyId: string; summary: Summary | null }) {
  const { t } = useTranslation()
  const sq = useApiView('v_spares_issues', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 10 })
  return (
    <>
      <Card title={t('maintenance.daily.title')}>
        <p style={{ margin: '0 0 8px' }}>{summary ? t('maintenance.daily.count', { n: summary.checked_today, of: summary.machines }) : '—'}</p>
        <p className="k" style={{ margin: '0 0 8px' }}>
          {t('maintenance.daily.body')}
        </p>
        <Link to={`/me/machine-check?company=${companyId}`}>{t('maintenance.daily.open')}</Link>
      </Card>
      <Card title={t('maintenance.spares.title')} action={<Link to={`/purchase/purchase-requests?company=${companyId}`}>{t('maintenance.spares.buy')}</Link>}>
        {sq.error ? <ViewError error={sq.error} /> : null}
        {rowsOf(sq).length === 0 && !sq.isLoading ? <p className="k" style={{ margin: 0 }}>{t('maintenance.spares.none')}</p> : null}
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
          {rowsOf(sq).map((x) => (
            <li key={x.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>
                {x.product_name}
                <span className="k"> · {x.asset_code ?? ''} · {formatDate(x.issued_on)}</span>
              </span>
              <Qty value={x.qty} uom={x.uom} />
            </li>
          ))}
        </ul>
      </Card>
      <Card title={t('maintenance.planned.title')}>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
          <li>{t('maintenance.planned.daily')}</li>
          <li>{t('maintenance.planned.schedules')}</li>
          <li>{t('maintenance.planned.moulds')}</li>
        </ul>
      </Card>
    </>
  )
}

function Schedules({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const rights = useOpsRights()
  const q = useApiView('v_maintenance_schedules', { eq: { company_id: companyId }, order: 'next_due_on', limit: 500 })
  const [adding, setAdding] = useState(false)
  const [doing, setDoing] = useState<Schedule | null>(null)
  const cols: Column<Schedule>[] = [
    { key: 'asset', header: t('maintenance.sch.machine'), render: (s) => `${s.asset_code} · ${s.asset_name}` },
    { key: 'title', header: t('maintenance.sch.service'), render: (s) => <strong>{s.title}</strong> },
    { key: 'every', header: t('maintenance.sch.every'), align: 'right', render: (s) => t('maintenance.sch.days', { n: s.interval_days }) },
    { key: 'last', header: t('maintenance.sch.last'), render: (s) => (s.last_done_on ? formatDate(s.last_done_on) : '—') },
    {
      key: 'next',
      header: t('maintenance.sch.next'),
      render: (s) =>
        s.overdue ? (
          <Chip tone="danger" icon="alert">
            {t('maintenance.sch.overdue', { date: formatDate(s.next_due_on) })}
          </Chip>
        ) : (
          formatDate(s.next_due_on)
        ),
    },
    {
      key: 'act',
      header: <span className="sr-only">{t('maintenance.sch.done')}</span>,
      render: (s) =>
        (rights.assetsManage || rights.prodCreate) && s.active ? (
          <Button size="sm" variant="link" onClick={() => setDoing(s)} aria-label={t('maintenance.sch.doneOne', { title: s.title, code: s.asset_code })}>
            {t('maintenance.sch.done')}
          </Button>
        ) : null,
    },
  ]
  return (
    <TableCard
      title={t('maintenance.sch.title')}
      action={
        rights.assetsManage ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            {t('maintenance.sch.add')}
          </Button>
        ) : null
      }
    >
      <DataTable caption={t('maintenance.sch.title')} columns={cols} rows={rowsOf(q)} rowKey={(s) => s.id} loading={q.isLoading} minWidth={720} error={q.error ? <ViewError error={q.error} /> : undefined} empty={<EmptyState title={t('maintenance.sch.emptyTitle')} body={t('maintenance.sch.emptyBody')} />} />
      {adding ? <ScheduleDialog companyId={companyId} onClose={() => setAdding(false)} /> : null}
      {doing ? <DoneDialog schedule={doing} onClose={() => setDoing(null)} /> : null}
    </TableCard>
  )
}

function ScheduleDialog({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const machines = useMachines(companyId, null)
  const [f, setF] = useState({ asset_id: '', title: '', interval_days: '30', next_due_on: '' })
  const save = useApiMutation<{ p: Record<string, unknown> }>('upsert_maintenance_schedule', OPS_REFRESH)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  return (
    <FormDialog open onOpenChange={(o) => (!o ? onClose() : undefined)} title={t('maintenance.sch.addTitle')} submitLabel={t('common.save')} busy={save.isPending} error={<OpsErrorBox error={save.error} />} onSubmit={() => save.mutate({ p: { asset_id: f.asset_id || null, title: f.title.trim(), interval_days: f.interval_days, next_due_on: f.next_due_on || null } }, { onSuccess: onClose })}>
      <SelectField label={t('maintenance.sch.machine')} value={f.asset_id} onChange={set('asset_id')} placeholder={t('maintenance.choose')} options={machines.list.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))} />
      <Field label={t('maintenance.sch.service')} value={f.title} onChange={set('title')} required />
      <FieldGrid cols={2}>
        <Field label={t('maintenance.sch.intervalLabel')} inputMode="numeric" value={f.interval_days} onChange={set('interval_days')} />
        <Field label={t('maintenance.sch.firstDue')} type="date" value={f.next_due_on} onChange={set('next_due_on')} help={t('maintenance.sch.firstDueHelp')} />
      </FieldGrid>
    </FormDialog>
  )
}

function DoneDialog({ schedule, onClose }: { schedule: Schedule; onClose: () => void }) {
  const { t } = useTranslation()
  const [f, setF] = useState({ done_on: todayIst(), note: '', cost: '' })
  const save = useApiMutation<{ p_schedule_id: string; p: Record<string, unknown> }>('record_maintenance_done', OPS_REFRESH)
  return (
    <FormDialog open onOpenChange={(o) => (!o ? onClose() : undefined)} title={t('maintenance.sch.doneTitle', { title: schedule.title, code: schedule.asset_code })} submitLabel={t('maintenance.sch.done')} busy={save.isPending} error={<OpsErrorBox error={save.error} />} onSubmit={() => save.mutate({ p_schedule_id: schedule.id, p: { done_on: f.done_on, note: f.note.trim() || null, cost: f.cost.trim() || null } }, { onSuccess: onClose })}>
      <FieldGrid cols={2}>
        <Field label={t('maintenance.sch.doneOn')} type="date" value={f.done_on} onChange={(e) => setF({ ...f, done_on: e.target.value })} />
        <Field label={t('maintenance.sch.cost')} inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} />
      </FieldGrid>
      <TextAreaField label={t('maintenance.note')} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} rows={2} />
    </FormDialog>
  )
}

function RaiseDialog({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const machines = useMachines(companyId, null)
  const [f, setF] = useState({ asset_id: '', title: '', description: '', priority: 'urgent', breakdown: true, at: localNow() })
  const save = useApiMutation<{ p: Record<string, unknown> }>('raise_repair_request', OPS_REFRESH)
  const set = (k: 'asset_id' | 'title' | 'description' | 'priority' | 'at') => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('maintenance.raise.title')}
      description={t('maintenance.raise.hint')}
      submitLabel={t('maintenance.raise.submit')}
      busy={save.isPending}
      wide
      error={<OpsErrorBox error={save.error} />}
      onSubmit={() =>
        save.mutate(
          { p: { asset_id: f.asset_id || null, title: f.title.trim(), description: f.description.trim() || null, priority: f.priority, is_breakdown: f.breakdown, broke_down_at: f.breakdown ? toIso(f.at) : null } },
          { onSuccess: onClose },
        )
      }
    >
      <FieldGrid cols={2}>
        <SelectField label={t('maintenance.raise.machine')} value={f.asset_id} onChange={set('asset_id')} placeholder={t('maintenance.choose')} options={machines.list.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))} />
        <SelectField label={t('maintenance.raise.priority')} value={f.priority} onChange={set('priority')} options={['urgent', 'normal', 'low'].map((p) => ({ value: p, label: t(`maintenance.priority.${p}`) }))} />
      </FieldGrid>
      <Field label={t('maintenance.raise.what')} value={f.title} onChange={set('title')} required />
      <TextAreaField label={t('maintenance.raise.description')} value={f.description} onChange={set('description')} rows={2} />
      <Checkbox label={t('maintenance.raise.breakdown')} hint={t('maintenance.raise.breakdownHint')} checked={f.breakdown} onChange={(e) => setF({ ...f, breakdown: e.target.checked })} />
      {f.breakdown ? <Field label={t('maintenance.raise.at')} type="datetime-local" value={f.at} onChange={set('at')} /> : null}
    </FormDialog>
  )
}

function RequestDetail({ req, onClose }: { req: Repair; onClose: () => void }) {
  const { t } = useTranslation()
  const rights = useOpsRights()
  const sq = useApiView('v_spares_issues', { eq: { repair_request_id: req.id }, order: 'created_at' })
  const [dlg, setDlg] = useState<'assign' | 'spares' | 'close' | 'cancel' | null>(null)
  const upd = useApiMutation<{ p_request_id: string; p: Record<string, unknown> }>('update_repair_request', OPS_REFRESH)
  const closed = req.status === 'done' || req.status === 'cancelled'
  const spareCols: Column<Spare>[] = [
    { key: 'doc', header: t('maintenance.det.doc'), render: (x) => <span className="mono">{x.doc_no}</span> },
    { key: 'item', header: t('maintenance.det.item'), render: (x) => `${x.product_code} · ${x.product_name}` },
    { key: 'qty', header: t('maintenance.det.qty'), align: 'right', render: (x) => <Qty value={x.qty} uom={x.uom} /> },
    { key: 'val', header: t('maintenance.det.value'), align: 'right', render: (x) => (rights.costs ? <Amount value={x.value} /> : <span className="k">{t('opsCommon.costHidden')}</span>) },
    { key: 'on', header: t('maintenance.det.on'), render: (x) => formatDate(x.issued_on) },
  ]
  return (
    <Card
      title={t('maintenance.det.title', { no: req.doc_no ?? '—' })}
      action={
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {!closed && rights.assetsManage ? (
            <>
              <Button size="sm" onClick={() => setDlg('assign')}>
                {t('maintenance.det.assign')}
              </Button>
              <Button size="sm" busy={upd.isPending} disabled={req.status === 'waiting_parts'} onClick={() => upd.mutate({ p_request_id: req.id, p: { status: 'waiting_parts' } })}>
                {t('maintenance.det.waiting')}
              </Button>
              <Button size="sm" onClick={() => setDlg('spares')}>
                {t('maintenance.det.spares')}
              </Button>
              <Button size="sm" variant="primary" onClick={() => setDlg('close')}>
                {t('maintenance.det.close')}
              </Button>
              <Button size="sm" variant="link" onClick={() => setDlg('cancel')}>
                {t('maintenance.det.cancel')}
              </Button>
            </>
          ) : null}
          <Button size="sm" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <OpsErrorBox error={upd.error} />
        <KeyValue
          rows={[
            { label: t('maintenance.det.machine'), value: `${req.asset_code ?? req.mould_code ?? '—'} ${req.asset_name ? `· ${req.asset_name}` : ''}` },
            { label: t('maintenance.det.what'), value: req.title },
            { label: t('common.status'), value: <span data-testid="mt-status">{t(`maintenance.status.${req.status}`)}</span> },
            { label: t('maintenance.det.source'), value: t(`maintenance.source.${req.source}`) },
            { label: t('maintenance.det.brokeAt'), value: req.broke_down_at ? `${formatDate(req.broke_down_at)} ${formatTime(req.broke_down_at)}` : '—' },
            { label: t('maintenance.det.restoredAt'), value: req.restored_at ? `${formatDate(req.restored_at)} ${formatTime(req.restored_at)}` : '—' },
            {
              label: t('maintenance.det.downtime'),
              value: (
                <span data-testid="mt-downtime" data-value={String(req.downtime_minutes ?? '')}>
                  {req.downtime_minutes === null ? '—' : t('maintenance.det.hours', { h: hoursText(req.downtime_minutes) })}
                  {!closed && req.is_breakdown ? ` ${t('maintenance.det.live')}` : ''}
                </span>
              ),
            },
            { label: t('maintenance.det.assigned'), value: req.assigned_to_name ?? req.outside_vendor ?? '—' },
            { label: t('maintenance.det.resolution'), value: req.resolution ?? '—' },
          ]}
        />
        <h3 style={{ margin: 0, fontSize: 14 }}>{t('maintenance.det.sparesTitle')}</h3>
        <DataTable caption={t('maintenance.det.sparesTitle')} columns={spareCols} rows={rowsOf(sq)} rowKey={(x) => x.id} loading={sq.isLoading} minWidth={600} empty={<span className="k">{t('maintenance.det.noSpares')}</span>} error={sq.error ? <ViewError error={sq.error} /> : undefined} />
      </div>
      {dlg === 'assign' ? <AssignDialog req={req} onClose={() => setDlg(null)} /> : null}
      {dlg === 'spares' ? <SparesDialog req={req} onClose={() => setDlg(null)} /> : null}
      {dlg === 'close' ? <CloseDialog req={req} onClose={() => setDlg(null)} /> : null}
      <ConfirmDialog
        open={dlg === 'cancel'}
        onOpenChange={(o) => (!o ? setDlg(null) : undefined)}
        title={t('maintenance.det.cancelTitle')}
        effect={t('maintenance.det.cancelEffect', { no: req.doc_no ?? '' })}
        confirmLabel={t('maintenance.det.cancel')}
        danger
        busy={upd.isPending}
        onConfirm={() => upd.mutate({ p_request_id: req.id, p: { status: 'cancelled' } }, { onSettled: () => setDlg(null) })}
      />
    </Card>
  )
}

function AssignDialog({ req, onClose }: { req: Repair; onClose: () => void }) {
  const { t } = useTranslation()
  const people = useCompanyPeople(req.company_id)
  const [f, setF] = useState({ assigned_to: req.assigned_to ?? '', outside_vendor: req.outside_vendor ?? '' })
  const save = useApiMutation<{ p_request_id: string; p: Record<string, unknown> }>('update_repair_request', OPS_REFRESH)
  return (
    <FormDialog open onOpenChange={(o) => (!o ? onClose() : undefined)} title={t('maintenance.assign.title')} submitLabel={t('common.save')} busy={save.isPending} error={<OpsErrorBox error={save.error} />} onSubmit={() => save.mutate({ p_request_id: req.id, p: { assigned_to: f.assigned_to || null, outside_vendor: f.outside_vendor.trim() || null } }, { onSuccess: onClose })}>
      <SelectField label={t('maintenance.assign.fitter')} value={f.assigned_to} onChange={(e) => setF({ ...f, assigned_to: e.target.value })} placeholder={t('maintenance.choose')} options={people.list.map((p) => ({ value: p.user_id, label: p.display_name ?? '—' }))} />
      <Field label={t('maintenance.assign.vendor')} value={f.outside_vendor} onChange={(e) => setF({ ...f, outside_vendor: e.target.value })} />
    </FormDialog>
  )
}

function SparesDialog({ req, onClose }: { req: Repair; onClose: () => void }) {
  const { t } = useTranslation()
  const places = useStockPlaces(req.company_id)
  const items = useStockItems(req.company_id)
  const [f, setF] = useState({ place: '', issued_on: todayIst() })
  const [lines, setLines] = useState([{ product_id: '', qty: '' }])
  const [hint, setHint] = useState<string | null>(null)
  const save = useApiMutation<{ p: Record<string, unknown> }>('issue_spares', OPS_REFRESH)
  function submit() {
    const clean = lines.filter((l) => l.product_id || l.qty)
    if (!f.place || clean.length === 0 || clean.some((l) => !l.product_id || cleanQty(l.qty) === null)) {
      setHint(t('maintenance.spares_.fill'))
      return
    }
    setHint(null)
    save.mutate({ p: { repair_request_id: req.id, place_id: f.place, issued_on: f.issued_on, lines: clean.map((l) => ({ product_id: l.product_id, qty: cleanQty(l.qty) })) } }, { onSuccess: onClose })
  }
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('maintenance.spares_.title', { no: req.doc_no ?? '' })}
      description={t('maintenance.spares_.hint')}
      submitLabel={t('maintenance.spares_.submit')}
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
        <SelectField label={t('maintenance.spares_.from')} value={f.place} onChange={(e) => setF({ ...f, place: e.target.value })} placeholder={t('maintenance.choose')} options={places.list.filter((p) => p.kind !== 'job_worker').map((p) => ({ value: p.id, label: placeLabel(p) }))} />
        <Field label={t('maintenance.spares_.on')} type="date" value={f.issued_on} onChange={(e) => setF({ ...f, issued_on: e.target.value })} />
      </FieldGrid>
      {lines.map((l, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 1fr)', gap: 8 }}>
          <SelectField label={t('maintenance.spares_.item', { n: i + 1 })} value={l.product_id} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, product_id: e.target.value } : x)))} placeholder={t('maintenance.choose')} options={items.list.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))} />
          <Field label={t('maintenance.spares_.qty', { n: i + 1 })} inputMode="decimal" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
        </div>
      ))}
      <div>
        <Button size="sm" onClick={() => setLines([...lines, { product_id: '', qty: '' }])}>
          {t('maintenance.spares_.add')}
        </Button>
      </div>
    </FormDialog>
  )
}

function CloseDialog({ req, onClose }: { req: Repair; onClose: () => void }) {
  const { t } = useTranslation()
  const [f, setF] = useState({ resolution: '', restored_at: localNow(), labour: '', outside: '' })
  const save = useApiMutation<{ p_request_id: string; p: Record<string, unknown> }>('close_repair_request', OPS_REFRESH)
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('maintenance.close.title', { no: req.doc_no ?? '' })}
      description={t('maintenance.close.hint')}
      submitLabel={t('maintenance.close.submit')}
      busy={save.isPending}
      error={<OpsErrorBox error={save.error} />}
      onSubmit={() => save.mutate({ p_request_id: req.id, p: { resolution: f.resolution.trim(), restored_at: req.is_breakdown ? toIso(f.restored_at) : null, labour_cost: f.labour.trim() || null, outside_cost: f.outside.trim() || null } }, { onSuccess: onClose })}
    >
      <TextAreaField label={t('maintenance.close.resolution')} value={f.resolution} onChange={(e) => setF({ ...f, resolution: e.target.value })} rows={2} />
      {req.is_breakdown ? <Field label={t('maintenance.close.restoredAt')} type="datetime-local" value={f.restored_at} onChange={(e) => setF({ ...f, restored_at: e.target.value })} /> : null}
      <FieldGrid cols={2}>
        <Field label={t('maintenance.close.labour')} inputMode="decimal" value={f.labour} onChange={(e) => setF({ ...f, labour: e.target.value })} />
        <Field label={t('maintenance.close.outside')} inputMode="decimal" value={f.outside} onChange={(e) => setF({ ...f, outside: e.target.value })} />
      </FieldGrid>
    </FormDialog>
  )
}

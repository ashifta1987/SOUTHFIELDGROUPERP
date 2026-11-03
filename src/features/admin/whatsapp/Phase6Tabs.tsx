import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { formatDate, formatIndian, formatTime } from '@/shared/format'
import { Amount, Button, Card, Chip, DataTable, EmptyState, ErrorRef, Field, FieldGrid, FormDialog, SelectField, TextAreaField, type Column } from '@/ui'

type Task = ViewRow<'msg_tasks'>
type Cap = ViewRow<'msg_cost_caps'>
type Rate = ViewRow<'msg_message_rates'>
type CostRow = ViewRow<'msg_cost_by_month'>
type Outbox = ViewRow<'msg_outbox'>
type CompanyRow = ViewRow<'companies'>

const P6_RULES = new Set(['task.missing', 'task.status', 'task.closed', 'task.finance_only', 'msg.inbound_missing', 'msg.window_closed', 'msg.not_consented', 'msg.empty'])

/** Phase 6 inbox / task / reminder refusals carry their own rule codes; the rest go through the shared box. */
function P6ErrorBox({ error }: { error: RpcError | null | undefined }) {
  const { t } = useTranslation()
  if (!error) return null
  if (error.rule && P6_RULES.has(error.rule)) return <ErrorRef message={t(`whatsapp.p6.rules.${error.rule.replace('.', '_')}`)} next={t('errors.nextStep')} refId={error.ref} />
  return <RpcErrorBox error={error} />
}

const when = (iso: string | null | undefined) => (iso ? <span className="mono">{`${formatDate(iso)} ${formatTime(iso)}`}</span> : '—')
const companyName = (list: CompanyRow[], id: string | null | undefined) => {
  const c = list.find((x) => x.id === id)
  return c ? (c.short_name ?? c.name ?? '') : ''
}

/* ─────────── Inbox and tasks ─────────── */
/**
 * Tasks raised by received messages (api.msg_tasks): a photo, document or "paid" message becomes an urgent payment-proof
 * task for finance (checked against the bank — only finance or Admin closes it); anything else asks for a reply. Replies
 * go only inside the 24-hour window to a consented number (api.reply_inbound). Until the whatsapp-webhook is deployed,
 * Admin can record a received message by hand (api.record_inbound); STOP words opt the number out.
 */
export function InboxTasksTab({ companies, isAdmin, readOnly }: { companies: CompanyRow[]; isAdmin: boolean; readOnly: boolean }) {
  const { t } = useTranslation()
  const [status, setStatus] = useState('open')
  const q = useApiView('msg_tasks', { eq: { status }, order: 'created_at', ascending: false, limit: 200 })
  const rows = rowsOf(q)
  const [resolving, setResolving] = useState<{ task: Task; status: 'done' | 'dismissed' } | null>(null)
  const [replying, setReplying] = useState<Task | null>(null)
  const canAct = !readOnly

  const cols: Column<Task>[] = [
    { key: 'when', header: t('whatsapp.p6.col.received'), render: (r) => when(r.received_at ?? r.created_at) },
    {
      key: 'kind',
      header: t('whatsapp.p6.col.task'),
      render: (r) => (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
          <Chip tone={r.kind === 'payment_proof' ? 'signal' : 'info'}>{t(`whatsapp.p6.kind.${r.kind}`, { defaultValue: r.kind })}</Chip>
          {r.priority === 'urgent' ? <span style={{ fontSize: 12, color: 'var(--sf-danger)' }}>{t('whatsapp.p6.urgent')}</span> : null}
        </span>
      ),
    },
    { key: 'co', header: t('common.company'), render: (r) => companyName(companies, r.company_id) },
    { key: 'party', header: t('whatsapp.col.party'), render: (r) => r.party_name ?? <span className="muted">{t('whatsapp.unmatched')}</span> },
    { key: 'from', header: t('whatsapp.col.from'), render: (r) => <span className="mono">{r.from_masked ?? '—'}</span> },
    { key: 'msg', header: t('whatsapp.col.message'), width: '28%', render: (r) => (r.message_kind && r.message_kind !== 'text' ? t('whatsapp.media', { kind: r.message_kind }) : (r.message_text ?? '')) },
    { key: 'due', header: t('whatsapp.p6.col.due'), render: (r) => when(r.due_at) },
    {
      key: 'status',
      header: t('common.status'),
      render: (r) => (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {r.status === 'open' ? <Chip tone="signal">{t('whatsapp.p6.taskStatus.open')}</Chip> : <Chip tone={r.status === 'done' ? 'success' : 'neutral'}>{t(`whatsapp.p6.taskStatus.${r.status}`)}</Chip>}
          {r.note ? <span className="muted" style={{ fontSize: 12 }}>{r.note}</span> : null}
        </span>
      ),
    },
    ...(canAct
      ? [
          {
            key: 'act',
            header: <span className="sr-only">{t('whatsapp.p6.actions')}</span>,
            render: (r: Task) =>
              r.status === 'open' ? (
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <Button size="sm" variant="primary" aria-label={t('whatsapp.p6.doneFor', { who: r.party_name ?? r.from_masked ?? '' })} onClick={() => setResolving({ task: r, status: 'done' })}>
                    {t('whatsapp.p6.done')}
                  </Button>
                  <Button size="sm" aria-label={t('whatsapp.p6.dismissFor', { who: r.party_name ?? r.from_masked ?? '' })} onClick={() => setResolving({ task: r, status: 'dismissed' })}>
                    {t('whatsapp.p6.dismiss')}
                  </Button>
                  {r.inbound_id && r.window_expires_at && new Date(r.window_expires_at).getTime() > Date.now() ? (
                    <Button size="sm" aria-label={t('whatsapp.p6.replyTo', { who: r.party_name ?? r.from_masked ?? '' })} onClick={() => setReplying(r)}>
                      {t('whatsapp.p6.reply')}
                    </Button>
                  ) : null}
                </span>
              ) : null,
          } satisfies Column<Task>,
        ]
      : []),
  ]

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {isAdmin ? <RecordInboundCard companies={companies} /> : null}
      <TableCard
        title={t('whatsapp.p6.tasksTitle')}
        action={
          <div style={{ width: 200 }}>
            <SelectField
              label={t('common.status')}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              options={[{ value: '', label: t('common.all') }, ...['open', 'done', 'dismissed'].map((s) => ({ value: s, label: t(`whatsapp.p6.taskStatus.${s}`) }))]}
            />
          </div>
        }
      >
        <p className="muted sf-card__pad" style={{ margin: 0, paddingTop: 0, fontSize: 13 }}>
          {t('whatsapp.p6.tasksNote')}
        </p>
        <DataTable
          caption={t('whatsapp.p6.tasksTitle')}
          columns={cols}
          rows={rows}
          rowKey={(r) => r.id}
          loading={q.isLoading}
          error={q.error ? <ErrorRef message={t('errors.loadFailed')} refId="WA-TK" /> : undefined}
          empty={<EmptyState title={t('whatsapp.p6.noTasks')} body={t('whatsapp.p6.noTasksBody')} />}
          minWidth={1100}
        />
      </TableCard>
      {resolving ? <ResolveDialog task={resolving.task} status={resolving.status} onClose={() => setResolving(null)} /> : null}
      {replying ? <ReplyDialog task={replying} onClose={() => setReplying(null)} /> : null}
    </div>
  )
}

function RecordInboundCard({ companies }: { companies: CompanyRow[] }) {
  const { t } = useTranslation()
  const [companyId, setCompanyId] = useState('')
  const [number, setNumber] = useState('')
  const [kind, setKind] = useState('text')
  const [body, setBody] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const m = useApiMutation<{ p: Record<string, unknown> }, { inbound_id?: string; task_id?: string; task_kind?: string; duplicate?: boolean; opted_out?: boolean }>('record_inbound', [
    ['api', 'msg_tasks'],
    ['api', 'msg_inbound'],
    ['api', 'msg_outbox'],
  ])
  const digits = number.replace(/\D/g, '').slice(-10)
  const valid = /^[6-9]\d{9}$/.test(digits) && (kind !== 'text' || body.trim().length > 0)
  return (
    <Card title={t('whatsapp.p6.recordTitle')}>
      <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>
        {t('whatsapp.p6.recordNote')}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setDone(null)
          m.mutate(
            { p: { wa_message_id: `manual-${crypto.randomUUID()}`, from_number: `+91${digits}`, kind, body: body.trim() || null, company_id: companyId || null } },
            {
              onSuccess: (res) => {
                setDone(res.opted_out ? t('whatsapp.p6.recordedStop') : res.duplicate ? t('whatsapp.p6.recordedDuplicate') : t('whatsapp.p6.recorded', { kind: t(`whatsapp.p6.kind.${res.task_kind ?? 'reply_needed'}`) }))
                setNumber('')
                setBody('')
              },
            },
          )
        }}
        style={{ display: 'grid', gap: 12 }}
      >
        <FieldGrid cols={3}>
          <SelectField label={t('common.company')} value={companyId} onChange={(e) => setCompanyId(e.target.value)} options={[{ value: '', label: t('whatsapp.p6.companyFromOutbox') }, ...companies.map((c) => ({ value: c.id ?? '', label: c.short_name ?? c.name ?? '' }))]} />
          <Field label={t('whatsapp.p6.fromNumber')} prefix="+91" inputMode="numeric" value={number} onChange={(e) => setNumber(e.target.value)} className="mono" autoComplete="off" />
          <SelectField label={t('whatsapp.p6.messageKind')} value={kind} onChange={(e) => setKind(e.target.value)} options={['text', 'image', 'document', 'audio'].map((k) => ({ value: k, label: t(`whatsapp.p6.mkind.${k}`) }))} />
        </FieldGrid>
        <TextAreaField label={t('whatsapp.p6.messageText')} value={body} onChange={(e) => setBody(e.target.value)} rows={2} />
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button type="submit" variant="primary" busy={m.isPending} disabled={!valid}>
            {t('whatsapp.p6.record')}
          </Button>
          {done ? (
            <span role="status" style={{ fontSize: 13 }}>
              {done}
            </span>
          ) : null}
        </div>
        <P6ErrorBox error={m.error} />
      </form>
    </Card>
  )
}

function ResolveDialog({ task, status, onClose }: { task: Task; status: 'done' | 'dismissed'; onClose: () => void }) {
  const { t } = useTranslation()
  const [note, setNote] = useState('')
  const m = useApiMutation<{ p_task_id: string; p_status: string; p_note: string | null }>('resolve_task', [['api', 'msg_tasks'], ['api', 'msg_inbound']])
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={status === 'done' ? t('whatsapp.p6.doneTitle') : t('whatsapp.p6.dismissTitle')}
      description={task.kind === 'payment_proof' ? t('whatsapp.p6.proofEffect') : t('whatsapp.p6.replyEffect')}
      submitLabel={status === 'done' ? t('whatsapp.p6.done') : t('whatsapp.p6.dismiss')}
      busy={m.isPending}
      onSubmit={() => m.mutate({ p_task_id: task.id, p_status: status, p_note: note.trim() || null }, { onSuccess: onClose })}
      error={<P6ErrorBox error={m.error} />}
    >
      <TextAreaField label={t('whatsapp.p6.note')} value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
    </FormDialog>
  )
}

function ReplyDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const m = useApiMutation<{ p_inbound_id: string; p_text: string }>('reply_inbound', [['api', 'msg_tasks'], ['api', 'msg_outbox'], ['api', 'msg_inbound']])
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('whatsapp.p6.replyTitle', { who: task.party_name ?? task.from_masked ?? '' })}
      description={t('whatsapp.p6.replyHelp', { until: task.window_expires_at ? `${formatDate(task.window_expires_at)} ${formatTime(task.window_expires_at)}` : '—' })}
      submitLabel={t('whatsapp.p6.sendReply')}
      busy={m.isPending}
      onSubmit={() => task.inbound_id && text.trim() && m.mutate({ p_inbound_id: task.inbound_id, p_text: text.trim() }, { onSuccess: onClose })}
      error={<P6ErrorBox error={m.error} />}
    >
      <TextAreaField label={t('whatsapp.p6.replyText')} value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={1000} />
    </FormDialog>
  )
}

/* ─────────── Cost caps ─────────── */
/**
 * Monthly cost caps per company (api.set_cost_cap, Admin): every outbox row gets an estimated cost from the rate Admin
 * enters per category (api.set_message_rate — the provider's price; none is preset). At the alert % an alert is
 * recorded; at 100 % non-urgent messages (reminders, statements) are skipped with the reason, while documents the
 * customer must have (invoice, receipt, credit note, dispatch, delivery) still go.
 */
export function CostsTab({ companies, isAdmin }: { companies: CompanyRow[]; isAdmin: boolean }) {
  const { t } = useTranslation()
  const caps = useApiView('msg_cost_caps', { order: 'company_id' })
  const rates = useApiView('msg_message_rates', { order: 'effective_from', ascending: false })
  const costs = useApiView('msg_cost_by_month', { order: 'month', ascending: false, limit: 200 })
  const [capCompany, setCapCompany] = useState('')
  const [cap, setCap] = useState('')
  const [alertPct, setAlertPct] = useState('80')
  const [capDone, setCapDone] = useState(false)
  const setCapM = useApiMutation<{ p_company_id: string; p_monthly_cap: string; p_alert_pct: string }>('set_cost_cap', [['api', 'msg_cost_caps']])
  const [category, setCategory] = useState('utility')
  const [est, setEst] = useState('')
  const [from, setFrom] = useState(todayIst())
  const [rateDone, setRateDone] = useState(false)
  const setRateM = useApiMutation<{ p_category: string; p_est_cost: string; p_effective_from: string }>('set_message_rate', [['api', 'msg_message_rates']])
  const capValid = Boolean(capCompany) && /^\d+(\.\d{1,2})?$/.test(cap.replace(/,/g, '')) && /^\d+(\.\d+)?$/.test(alertPct) && Number(alertPct) > 0 && Number(alertPct) <= 100
  const rateValid = /^\d+(\.\d{1,4})?$/.test(est) && Boolean(from)

  const capCols: Column<Cap>[] = [
    { key: 'co', header: t('common.company'), render: (r) => companyName(companies, r.company_id) },
    { key: 'cap', header: t('whatsapp.p6.col.cap'), align: 'right', render: (r) => <Amount value={r.monthly_cap} rupee /> },
    { key: 'alert', header: t('whatsapp.p6.col.alertAt'), align: 'right', render: (r) => <span className="mono">{`${formatIndian(r.alert_pct ?? 0, 0)}%`}</span> },
    { key: 'spent', header: t('whatsapp.p6.col.spent'), align: 'right', render: (r) => <Amount value={r.spent_this_month} rupee /> },
    { key: 'set', header: t('whatsapp.p6.col.setOn'), render: (r) => (r.set_at ? <span className="mono">{formatDate(r.set_at)}</span> : '—') },
  ]
  const rateCols: Column<Rate>[] = [
    { key: 'cat', header: t('whatsapp.p6.col.category'), render: (r) => t(`whatsapp.p6.category.${r.category}`, { defaultValue: r.category ?? '' }) },
    { key: 'cost', header: t('whatsapp.p6.col.perMessage'), align: 'right', render: (r) => <Amount value={r.est_cost} digits={4} rupee /> },
    { key: 'from', header: t('whatsapp.p6.col.from'), render: (r) => (r.effective_from ? <span className="mono">{formatDate(r.effective_from)}</span> : '—') },
  ]
  const costCols: Column<CostRow>[] = [
    { key: 'co', header: t('common.company'), render: (r) => companyName(companies, r.company_id) },
    { key: 'month', header: t('whatsapp.p6.col.month'), render: (r) => <span className="mono">{r.month ? formatDate(r.month).slice(3) : ''}</span> },
    { key: 'event', header: t('whatsapp.col.event'), render: (r) => <span className="mono">{r.event}</span> },
    { key: 'cat', header: t('whatsapp.p6.col.category'), render: (r) => t(`whatsapp.p6.category.${r.category}`, { defaultValue: r.category ?? '' }) },
    { key: 'n', header: t('whatsapp.p6.col.messages'), align: 'right', render: (r) => <span className="mono">{r.messages}</span> },
    { key: 'sent', header: t('whatsapp.p6.col.sent'), align: 'right', render: (r) => <span className="mono">{r.delivered_or_sent}</span> },
    { key: 'skip', header: t('whatsapp.p6.col.skipped'), align: 'right', render: (r) => <span className="mono">{r.skipped}</span> },
    { key: 'cost', header: t('whatsapp.p6.col.estCost'), align: 'right', render: (r) => <Amount value={r.est_cost} rupee /> },
  ]

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <TableCard title={t('whatsapp.p6.capsTitle')}>
        <p className="muted sf-card__pad" style={{ margin: 0, paddingTop: 0, fontSize: 13 }}>
          {t('whatsapp.p6.capsNote')}
        </p>
        {isAdmin ? (
          <form
            className="sf-card__pad"
            style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', paddingTop: 0 }}
            onSubmit={(e) => {
              e.preventDefault()
              setCapDone(false)
              setCapM.mutate({ p_company_id: capCompany, p_monthly_cap: cap.replace(/,/g, ''), p_alert_pct: alertPct }, { onSuccess: () => setCapDone(true) })
            }}
          >
            <div style={{ width: 240 }}>
              <SelectField label={t('common.company')} value={capCompany} onChange={(e) => setCapCompany(e.target.value)} placeholder={t('whatsapp.p6.pickCompany')} options={companies.map((c) => ({ value: c.id ?? '', label: c.short_name ?? c.name ?? '' }))} />
            </div>
            <div style={{ width: 180 }}>
              <Field label={t('whatsapp.p6.monthlyCap')} prefix="₹" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} className="mono" />
            </div>
            <div style={{ width: 140 }}>
              <Field label={t('whatsapp.p6.alertPct')} inputMode="decimal" value={alertPct} onChange={(e) => setAlertPct(e.target.value)} className="mono" />
            </div>
            <Button type="submit" variant="primary" busy={setCapM.isPending} disabled={!capValid}>
              {t('whatsapp.p6.saveCap')}
            </Button>
            {capDone ? (
              <span role="status" style={{ fontSize: 13 }}>
                {t('whatsapp.p6.capSaved')}
              </span>
            ) : null}
          </form>
        ) : null}
        <div className="sf-card__pad" style={{ paddingTop: 0 }}>
          <P6ErrorBox error={setCapM.error} />
        </div>
        <DataTable
          caption={t('whatsapp.p6.capsTitle')}
          columns={capCols}
          rows={rowsOf(caps)}
          rowKey={(r) => r.company_id}
          loading={caps.isLoading}
          error={caps.error ? <ErrorRef message={t('errors.loadFailed')} refId="WA-CC" /> : undefined}
          empty={<EmptyState title={t('whatsapp.p6.noCaps')} body={t('whatsapp.p6.noCapsBody')} />}
          minWidth={720}
        />
      </TableCard>

      <TableCard title={t('whatsapp.p6.ratesTitle')}>
        <p className="muted sf-card__pad" style={{ margin: 0, paddingTop: 0, fontSize: 13 }}>
          {t('whatsapp.p6.ratesNote')}
        </p>
        {isAdmin ? (
          <form
            className="sf-card__pad"
            style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', paddingTop: 0 }}
            onSubmit={(e) => {
              e.preventDefault()
              setRateDone(false)
              setRateM.mutate({ p_category: category, p_est_cost: est, p_effective_from: from }, { onSuccess: () => setRateDone(true) })
            }}
          >
            <div style={{ width: 200 }}>
              <SelectField label={t('whatsapp.p6.col.category')} value={category} onChange={(e) => setCategory(e.target.value)} options={['utility', 'marketing', 'authentication', 'service'].map((c) => ({ value: c, label: t(`whatsapp.p6.category.${c}`) }))} />
            </div>
            <div style={{ width: 180 }}>
              <Field label={t('whatsapp.p6.estCost')} prefix="₹" inputMode="decimal" value={est} onChange={(e) => setEst(e.target.value)} className="mono" />
            </div>
            <div style={{ width: 170 }}>
              <Field label={t('whatsapp.p6.effectiveFrom')} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <Button type="submit" busy={setRateM.isPending} disabled={!rateValid}>
              {t('whatsapp.p6.saveRate')}
            </Button>
            {rateDone ? (
              <span role="status" style={{ fontSize: 13 }}>
                {t('whatsapp.p6.rateSaved')}
              </span>
            ) : null}
          </form>
        ) : null}
        <div className="sf-card__pad" style={{ paddingTop: 0 }}>
          <P6ErrorBox error={setRateM.error} />
        </div>
        <DataTable
          caption={t('whatsapp.p6.ratesTitle')}
          columns={rateCols}
          rows={rowsOf(rates)}
          rowKey={(r) => r.id}
          loading={rates.isLoading}
          error={rates.error ? <ErrorRef message={t('errors.loadFailed')} refId="WA-RT" /> : undefined}
          empty={<EmptyState title={t('whatsapp.p6.noRates')} body={t('whatsapp.p6.noRatesBody')} />}
          minWidth={520}
        />
      </TableCard>

      <TableCard title={t('whatsapp.p6.costTitle')}>
        <DataTable
          caption={t('whatsapp.p6.costTitle')}
          columns={costCols}
          rows={rowsOf(costs)}
          rowKey={(r) => `${r.company_id}-${r.month}-${r.category}-${r.event}`}
          loading={costs.isLoading}
          error={costs.error ? <ErrorRef message={t('errors.loadFailed')} refId="WA-CM" /> : undefined}
          empty={<EmptyState title={t('whatsapp.p6.noCost')} />}
          minWidth={900}
        />
      </TableCard>
    </div>
  )
}

/* ─────────── Payment reminders ─────────── */
function offsetText(t: (k: string, o?: Record<string, unknown>) => string, d: number): string {
  if (d === 0) return t('whatsapp.p6.onDue')
  return d < 0 ? t('whatsapp.p6.daysBefore', { count: -d }) : t('whatsapp.p6.daysAfter', { count: d })
}

/**
 * Payment reminders (§WA-9): the daily job (08:00 IST) queues one summary per customer for the GST bills whose days from
 * the due date are on the schedule in Settings (msg.reminder_days). Only consented contacts get one (others are recorded
 * as skipped); a disputed bill pauses, a pending payment proof holds, a settled bill cancels the queued reminder, and the
 * cost cap stops reminders with the reason. Admin (or accounts with receipts rights) can run it now (api.schedule_reminders).
 */
export function RemindersTab({ companies }: { companies: CompanyRow[] }) {
  const { t } = useTranslation()
  const can = useCan()
  const { profile } = useAuth()
  const canRun = profile?.view !== 'all-readonly' && (profile?.view === 'all' || can('receipts_payments.create'))
  const settings = useApiView('settings_current', { order: 'key' })
  const daysRow = rowsOf(settings).find((r) => r.key === 'msg.reminder_days' && r.company_id === null) ?? rowsOf(settings).find((r) => r.key === 'msg.reminder_days')
  const days = Array.isArray(daysRow?.value) ? (daysRow.value as unknown[]).map(Number).filter((n) => Number.isFinite(n)) : []
  const [companyId, setCompanyId] = useState('')
  const [date, setDate] = useState(todayIst())
  const [result, setResult] = useState<{ queued: number; skipped: number; note?: string } | null>(null)
  const run = useApiMutation<{ p_company_id: string; p_date: string }, { queued: number; skipped: number; note?: string }>('schedule_reminders', [['api', 'msg_outbox'], ['api', 'msg_cost_by_month']])
  const [filterCo, setFilterCo] = useState('')
  const out = useApiView('msg_outbox', { eq: { event: 'sales.payment_reminder', company_id: filterCo }, order: 'created_at', ascending: false, limit: 200 })

  const cols: Column<Outbox>[] = [
    { key: 'when', header: t('common.when'), render: (r) => when(r.created_at) },
    { key: 'co', header: t('common.company'), render: (r) => companyName(companies, r.company_id) },
    { key: 'party', header: t('whatsapp.col.party'), render: (r) => r.party_name ?? '' },
    { key: 'to', header: t('whatsapp.col.to'), render: (r) => <span className="mono">{r.to_masked ?? '—'}</span> },
    { key: 'after', header: t('whatsapp.p6.col.sendAfter'), render: (r) => when(r.send_after) },
    {
      key: 'status',
      header: t('common.status'),
      render: (r) => (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Chip tone={r.status === 'queued' ? 'signal' : r.status === 'skipped' || r.status === 'cancelled' ? 'neutral' : r.status === 'failed' ? 'danger' : 'success'}>{t(`whatsapp.status.${r.status}`, { defaultValue: r.status })}</Chip>
          {r.skip_reason ? <span className="muted" style={{ fontSize: 12 }}>{r.skip_reason}</span> : null}
        </span>
      ),
    },
  ]

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 16, alignItems: 'start' }}>
        <Card title={t('whatsapp.p6.scheduleTitle')}>
          <p style={{ margin: 0, fontSize: 13.5 }}>
            {days.length ? t('whatsapp.p6.scheduleDays', { days: days.map((d) => offsetText(t, d)).join(' · ') }) : t('whatsapp.p6.scheduleUnset')}
          </p>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13 }}>
            <li>{t('whatsapp.p6.ruleConsent')}</li>
            <li>{t('whatsapp.p6.ruleOnce')}</li>
            <li>{t('whatsapp.p6.ruleGst')}</li>
            <li>{t('whatsapp.p6.ruleDisputed')}</li>
            <li>{t('whatsapp.p6.ruleProof')}</li>
            <li>{t('whatsapp.p6.ruleSettled')}</li>
            <li>{t('whatsapp.p6.ruleCap')}</li>
          </ul>
          <p className="muted" style={{ margin: '8px 0 0', fontSize: 12.5 }}>
            {t('whatsapp.p6.scheduleJob')}
          </p>
        </Card>
        <Card title={t('whatsapp.p6.runTitle')}>
          {canRun ? (
            <form
              style={{ display: 'grid', gap: 12 }}
              onSubmit={(e) => {
                e.preventDefault()
                setResult(null)
                run.mutate({ p_company_id: companyId, p_date: date }, { onSuccess: (r) => setResult(r) })
              }}
            >
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                {t('whatsapp.p6.runNote')}
              </p>
              <FieldGrid cols={2}>
                <SelectField label={t('common.company')} value={companyId} onChange={(e) => setCompanyId(e.target.value)} placeholder={t('whatsapp.p6.pickCompany')} options={companies.map((c) => ({ value: c.id ?? '', label: c.short_name ?? c.name ?? '' }))} />
                <Field label={t('whatsapp.p6.runDate')} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </FieldGrid>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <Button type="submit" variant="primary" busy={run.isPending} disabled={!companyId || !date}>
                  {t('whatsapp.p6.runNow')}
                </Button>
                {result ? (
                  <span role="status" style={{ fontSize: 13 }}>
                    {result.note ? t('whatsapp.p6.runNoSchedule') : t('whatsapp.p6.runResult', { queued: result.queued, skipped: result.skipped })}
                  </span>
                ) : null}
              </div>
              <P6ErrorBox error={run.error} />
            </form>
          ) : (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {t('whatsapp.p6.runNoRight')}
            </p>
          )}
        </Card>
      </div>
      <TableCard
        title={t('whatsapp.p6.remindersTitle')}
        action={
          <div style={{ width: 240 }}>
            <SelectField label={t('common.company')} value={filterCo} onChange={(e) => setFilterCo(e.target.value)} options={[{ value: '', label: t('common.all') }, ...companies.map((c) => ({ value: c.id ?? '', label: c.short_name ?? c.name ?? '' }))]} />
          </div>
        }
      >
        <DataTable
          caption={t('whatsapp.p6.remindersTitle')}
          columns={cols}
          rows={rowsOf(out)}
          rowKey={(r) => r.id}
          loading={out.isLoading}
          error={out.error ? <ErrorRef message={t('errors.loadFailed')} refId="WA-RM" /> : undefined}
          empty={<EmptyState title={t('whatsapp.p6.noReminders')} body={t('whatsapp.p6.noRemindersBody')} />}
          minWidth={900}
        />
      </TableCard>
    </div>
  )
}

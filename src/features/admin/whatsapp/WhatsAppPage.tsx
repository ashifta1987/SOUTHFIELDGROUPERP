import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { LoadMore, usePagedRows } from '@/data/paged'
import { api } from '@/shared/supabase'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { askHelp } from '@/features/help/events'
import { formatDate, formatTime } from '@/shared/format'
import {
  Amount,
  Button,
  Card,
  Chip,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorRef,
  Field,
  FieldGrid,
  FormDialog,
  PageHeader,
  SelectField,
  Tabs,
  TextAreaField,
  type Column,
} from '@/ui'
import { TableCard } from '@/features/admin/import-data/layout'
import { CostsTab, InboxTasksTab, RemindersTab } from './Phase6Tabs'

type Channel = ViewRow<'msg_channels'>
type Template = ViewRow<'msg_templates'>
type Outbox = ViewRow<'msg_outbox'>
type Allow = ViewRow<'msg_allow_list'>
type Inbound = ViewRow<'msg_inbound'>
type TabKey = 'templates' | 'allow' | 'outbox' | 'inbound' | 'tasks' | 'reminders' | 'costs' | 'channels'

const MSG_RULES = new Set(['msg.not_consented', 'msg.bad_number', 'msg.staff_template_private', 'msg.template_params', 'msg.template_body', 'msg.template_missing'])

/** Messaging refusals carry their own rule codes; the rest go through the shared box. */
function MsgErrorBox({ error }: { error: RpcError | null | undefined }) {
  const { t } = useTranslation()
  if (!error) return null
  if (error.rule && MSG_RULES.has(error.rule)) {
    return <ErrorRef message={t(`whatsapp.rules.${error.rule.slice(4)}`, { marker: '{{n}}' })} next={t('errors.nextStep')} refId={error.ref} onAskHelp={() => askHelp({ errorCode: error.ref })} />
  }
  return <RpcErrorBox error={error} />
}

/** Template bodies are shown with parameter names in place of {{n}} — never with real values. */
function preview(body: string, params: unknown): string {
  const names = Array.isArray(params) ? (params as unknown[]).map(String) : []
  return body.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => `[${names[Number(n) - 1] ?? n}]`)
}

function outboxTone(status: string | null): { tone: 'success' | 'signal' | 'danger' | 'neutral' | 'info'; icon: string } {
  switch (status) {
    case 'sent':
    case 'delivered':
    case 'read':
      return { tone: 'success', icon: 'check' }
    case 'failed':
      return { tone: 'danger', icon: 'cross' }
    case 'cancelled':
    case 'skipped':
      return { tone: 'neutral', icon: 'ban' }
    case 'sending':
      return { tone: 'info', icon: 'clock' }
    default:
      return { tone: 'signal', icon: 'clock' }
  }
}

/**
 * WhatsApp & email (`WhatsApp`, Admin): channels per company, utility templates, the DEV/preview allow-list (only numbers
 * of contacts who agreed to WhatsApp), the outbox with cancel, and received messages. Sending is off until the owner's
 * WhatsApp Business account is connected and the whatsapp-sender Edge Function is deployed: until then messages stay
 * queued (or skipped with a reason). Message rows never show their parameters, so no amounts, salary, KYC or bank details.
 * Phase 6 adds the inbox tasks (payment proofs, replies), payment reminders (7/3/0/3/7/14 schedule) and cost caps.
 */
export function WhatsAppPage() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const isAdmin = profile?.view === 'all'
  const readOnly = profile?.view === 'all-readonly'
  const [tab, setTab] = useState<TabKey>('templates')
  const channels = useApiView('msg_channels', { order: 'display_name' })
  const companies = useApiView('companies', { order: 'code' })
  const chList = rowsOf(channels)
  const connected = chList.some((c) => c.status === 'active')

  return (
    <>
      <PageHeader title={t('whatsapp.title')} subtitle={t('whatsapp.subtitle')} />
      <div className="sf-banner" data-tone="signal" role="status" style={{ marginBottom: 16 }}>
        {t('whatsapp.sendingOff')}
      </div>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginBottom: 16 }} aria-label={t('whatsapp.setupTitle')}>
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <strong>{t('whatsapp.waCard')}</strong>
            {connected ? <Chip tone="success" icon="check">{t('whatsapp.connected')}</Chip> : <Chip tone="signal">{t('whatsapp.notConnected')}</Chip>}
          </div>
          <ul className="muted" style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
            <li>{t('whatsapp.waStep1')}</li>
            <li>{t('whatsapp.waStep2')}</li>
            <li>{t('whatsapp.waStep3')}</li>
          </ul>
        </Card>
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <strong>{t('whatsapp.smsCard')}</strong>
            <Chip tone="signal">{t('whatsapp.optional')}</Chip>
          </div>
          <ul className="muted" style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
            <li>{t('whatsapp.smsStep1')}</li>
            <li>{t('whatsapp.smsStep2')}</li>
            <li>{t('whatsapp.smsStep3')}</li>
          </ul>
        </Card>
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <strong>{t('whatsapp.emailCard')}</strong>
            <Chip tone="signal">{t('whatsapp.notSet')}</Chip>
          </div>
          <ul className="muted" style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
            <li>{t('whatsapp.emailStep1')}</li>
            <li>{t('whatsapp.emailStep2')}</li>
            <li>{t('whatsapp.emailStep3')}</li>
          </ul>
        </Card>
      </section>

      {!isAdmin && !readOnly ? <p className="muted">{t('whatsapp.adminOnly')}</p> : null}

      <Tabs<TabKey>
        label={t('whatsapp.tabsLabel')}
        value={tab}
        onChange={setTab}
        idBase="wa"
        controls="wa-panel"
        tabs={[
          { key: 'templates', label: t('whatsapp.tab.templates') },
          { key: 'allow', label: t('whatsapp.tab.allow') },
          { key: 'outbox', label: t('whatsapp.tab.outbox') },
          { key: 'inbound', label: t('whatsapp.tab.inbound') },
          { key: 'tasks', label: t('whatsapp.tab.tasks') },
          { key: 'reminders', label: t('whatsapp.tab.reminders') },
          { key: 'costs', label: t('whatsapp.tab.costs') },
          { key: 'channels', label: t('whatsapp.tab.channels') },
        ]}
      />
      <div id="wa-panel" role="tabpanel" aria-labelledby={`wa-tab-${tab}`} style={{ marginTop: 12 }}>
        {tab === 'templates' ? <TemplatesTab canEdit={isAdmin} /> : null}
        {tab === 'allow' ? <AllowTab canEdit={isAdmin} /> : null}
        {tab === 'outbox' ? <OutboxTab canEdit={isAdmin} /> : null}
        {tab === 'inbound' ? <InboundTab /> : null}
        {tab === 'tasks' ? <InboxTasksTab companies={rowsOf(companies)} isAdmin={isAdmin} readOnly={readOnly} /> : null}
        {tab === 'reminders' ? <RemindersTab companies={rowsOf(companies)} /> : null}
        {tab === 'costs' ? <CostsTab companies={rowsOf(companies)} isAdmin={isAdmin} /> : null}
        {tab === 'channels' ? <ChannelsTab canEdit={isAdmin} channels={chList} loading={channels.isLoading} companies={rowsOf(companies)} /> : null}
      </div>
    </>
  )
}

/* ─────────── Templates ─────────── */
interface TemplateForm {
  id?: string
  name: string
  language: string
  category: string
  event: string
  header_type: string
  body: string
  params: string
}
const EMPTY_TEMPLATE: TemplateForm = { name: '', language: 'en', category: 'utility', event: '', header_type: 'none', body: '', params: '' }

function TemplatesTab({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation()
  const q = useApiView('msg_templates', { order: 'name' })
  const rows = rowsOf(q)
  const [form, setForm] = useState<TemplateForm | null>(null)
  const save = useApiMutation<{ p: Record<string, unknown> }>('upsert_template', [['api', 'msg_templates']])

  function submit() {
    if (!form) return
    const params = form.params
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    save.mutate(
      { p: { id: form.id, name: form.name.trim(), language: form.language, category: form.category, event: form.event.trim(), header_type: form.header_type, body: form.body, params } },
      { onSuccess: () => setForm(null) },
    )
  }

  const cols: Column<Template>[] = [
    { key: 'name', header: t('whatsapp.col.template'), render: (r) => <span className="mono">{r.name}</span> },
    { key: 'event', header: t('whatsapp.col.event'), render: (r) => <span className="mono">{r.event}</span> },
    { key: 'lang', header: t('whatsapp.col.language'), render: (r) => r.language?.toUpperCase() },
    { key: 'ver', header: t('whatsapp.col.version'), align: 'right', render: (r) => <span className="mono">v{r.version}</span> },
    { key: 'body', header: t('whatsapp.col.preview'), render: (r) => <span style={{ fontSize: 12.5 }}>{preview(r.body ?? '', r.params)}</span>, width: '40%' },
    {
      key: 'status',
      header: t('whatsapp.col.approval'),
      render: (r) =>
        r.approval_status === 'approved' ? (
          <Chip tone="success" icon="check">{t('whatsapp.approval.approved')}</Chip>
        ) : r.approval_status === 'rejected' || r.approval_status === 'paused' ? (
          <Chip tone="danger" icon="cross">{t(`whatsapp.approval.${r.approval_status}`)}</Chip>
        ) : (
          <Chip tone="info" icon="pencil">{t(`whatsapp.approval.${r.approval_status ?? 'draft'}`)}</Chip>
        ),
    },
    ...(canEdit
      ? [
          {
            key: 'act',
            header: <span className="sr-only">{t('common.edit')}</span>,
            render: (r: Template) => (
              <Button
                size="sm"
                aria-label={t('whatsapp.editTemplate', { name: r.name })}
                onClick={() =>
                  setForm({
                    id: r.id ?? undefined,
                    name: r.name ?? '',
                    language: r.language ?? 'en',
                    category: r.category ?? 'utility',
                    event: r.event ?? '',
                    header_type: r.header_type ?? 'none',
                    body: r.body ?? '',
                    params: Array.isArray(r.params) ? (r.params as unknown[]).map(String).join(', ') : '',
                  })
                }
              >
                {t('common.edit')}
              </Button>
            ),
          } satisfies Column<Template>,
        ]
      : []),
  ]

  return (
    <TableCard
      title={t('whatsapp.templatesTitle')}
      action={
        canEdit ? (
          <Button variant="primary" size="sm" onClick={() => setForm({ ...EMPTY_TEMPLATE })}>
            {t('whatsapp.addTemplate')}
          </Button>
        ) : null
      }
    >
      <p className="muted sf-card__pad" style={{ margin: 0, paddingTop: 0, fontSize: 13 }}>
        {t('whatsapp.templatesNote')}
      </p>
      <DataTable
        caption={t('whatsapp.templatesTitle')}
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id ?? ''}
        loading={q.isLoading}
        error={q.error ? <ErrorRef message={t('errors.loadFailed')} refId="WA-T" /> : undefined}
        empty={<EmptyState title={t('whatsapp.noTemplates')} />}
        minWidth={900}
      />
      <FormDialog
        open={form !== null}
        onOpenChange={(o) => {
          if (!o) setForm(null)
          save.reset()
        }}
        title={form?.id ? t('whatsapp.editTitle') : t('whatsapp.addTemplate')}
        description={t('whatsapp.templateHelp', { p1: '{{1}}', p2: '{{2}}' })}
        submitLabel={t('whatsapp.saveTemplate')}
        busy={save.isPending}
        onSubmit={submit}
        error={<MsgErrorBox error={save.error} />}
        wide
      >
        {form ? (
          <>
            <FieldGrid cols={2}>
              <Field label={t('whatsapp.f.name')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={Boolean(form.id)} className="mono" help={t('whatsapp.f.nameHelp')} />
              <Field label={t('whatsapp.f.event')} value={form.event} onChange={(e) => setForm({ ...form, event: e.target.value })} className="mono" help={t('whatsapp.f.eventHelp')} />
              <SelectField
                label={t('whatsapp.f.language')}
                value={form.language}
                onChange={(e) => setForm({ ...form, language: e.target.value })}
                disabled={Boolean(form.id)}
                options={['en', 'ml', 'ta', 'hi'].map((l) => ({ value: l, label: t(`whatsapp.lang.${l}`) }))}
              />
              <SelectField
                label={t('whatsapp.f.category')}
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                options={[
                  { value: 'utility', label: t('whatsapp.cat.utility') },
                  { value: 'authentication', label: t('whatsapp.cat.authentication') },
                ]}
              />
              <SelectField
                label={t('whatsapp.f.header')}
                value={form.header_type}
                onChange={(e) => setForm({ ...form, header_type: e.target.value })}
                options={[
                  { value: 'none', label: t('whatsapp.header.none') },
                  { value: 'text', label: t('whatsapp.header.text') },
                  { value: 'document', label: t('whatsapp.header.document') },
                ]}
              />
              <Field label={t('whatsapp.f.params')} value={form.params} onChange={(e) => setForm({ ...form, params: e.target.value })} className="mono" help={t('whatsapp.f.paramsHelp')} />
            </FieldGrid>
            <TextAreaField label={t('whatsapp.f.body')} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} rows={4} />
            {form.body ? (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                {t('whatsapp.previewLabel')} {preview(form.body, form.params.split(',').map((s) => s.trim()).filter(Boolean))}
              </p>
            ) : null}
          </>
        ) : null}
      </FormDialog>
    </TableCard>
  )
}

/* ─────────── Allow-list (DEV / preview) ─────────── */
function AllowTab({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation()
  const q = useApiView('msg_allow_list', { order: 'number' })
  const rows = rowsOf(q)
  const [number, setNumber] = useState('')
  const [note, setNote] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Allow | null>(null)
  const set = useApiMutation<{ p_number: string; p_note: string | null; p_remove: boolean }, { number: string }>('set_allow_list', [['api', 'msg_allow_list']])
  const digits = number.replace(/\D/g, '').slice(-10)
  const valid = /^[6-9]\d{9}$/.test(digits)

  const cols: Column<Allow>[] = [
    { key: 'num', header: t('whatsapp.col.number'), render: (r) => <span className="mono">{r.number_masked}</span> },
    {
      key: 'who',
      header: t('whatsapp.col.belongsTo'),
      render: (r) => (r.belongs_to ? `${r.belongs_to} · ${t(`whatsapp.kind.${r.belongs_to_kind ?? 'party'}`)}` : <span className="muted">{t('whatsapp.noLongerConsented')}</span>),
    },
    { key: 'note', header: t('whatsapp.col.note'), render: (r) => r.note ?? '' },
    ...(canEdit
      ? [
          {
            key: 'act',
            header: <span className="sr-only">{t('whatsapp.remove')}</span>,
            render: (r: Allow) => (
              <Button size="sm" variant="danger" aria-label={t('whatsapp.removeNumber', { number: r.number_masked })} onClick={() => setRemoving(r)}>
                {t('whatsapp.remove')}
              </Button>
            ),
          } satisfies Column<Allow>,
        ]
      : []),
  ]

  return (
    <TableCard title={t('whatsapp.allowTitle')}>
      <p className="muted sf-card__pad" style={{ margin: 0, paddingTop: 0, fontSize: 13 }}>
        {t('whatsapp.allowNote')}
      </p>
      {canEdit ? (
        <form
          className="sf-card__pad"
          style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', paddingTop: 0 }}
          onSubmit={(e) => {
            e.preventDefault()
            setDone(null)
            set.mutate(
              { p_number: digits, p_note: note.trim() || null, p_remove: false },
              {
                onSuccess: () => {
                  setDone(`••${digits.slice(-4)}`)
                  setNumber('')
                  setNote('')
                },
              },
            )
          }}
        >
          <div style={{ width: 220 }}>
            <Field label={t('whatsapp.f.number')} prefix="+91" inputMode="numeric" value={number} onChange={(e) => setNumber(e.target.value)} className="mono" autoComplete="off" />
          </div>
          <div style={{ flex: '1 1 220px' }}>
            <Field label={t('whatsapp.f.note')} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <Button type="submit" variant="primary" busy={set.isPending} disabled={!valid}>
            {t('whatsapp.addNumber')}
          </Button>
        </form>
      ) : null}
      <div className="sf-card__pad" style={{ paddingTop: 0 }}>
        <MsgErrorBox error={set.error} />
        {done ? (
          <span role="status" style={{ fontSize: 13 }}>
            {t('whatsapp.added', { number: done })}
          </span>
        ) : null}
      </div>
      <DataTable
        caption={t('whatsapp.allowTitle')}
        columns={cols}
        rows={rows}
        rowKey={(r) => r.number ?? ''}
        loading={q.isLoading}
        error={q.error ? <ErrorRef message={t('errors.loadFailed')} refId="WA-A" /> : undefined}
        empty={<EmptyState title={t('whatsapp.noAllow')} body={t('whatsapp.noAllowBody')} />}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t('whatsapp.removeTitle')}
        effect={t('whatsapp.removeEffect', { number: removing?.number_masked ?? '' })}
        confirmLabel={t('whatsapp.remove')}
        danger
        busy={set.isPending}
        onConfirm={() => removing?.number && set.mutate({ p_number: removing.number, p_note: null, p_remove: true }, { onSuccess: () => setRemoving(null) })}
      />
    </TableCard>
  )
}

/* ─────────── Outbox ─────────── */
function OutboxTab({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation()
  const [status, setStatus] = useState('')
  // Paged on the server (Phase 9): the outbox grows by every invoice, statement and reminder.
  const q = usePagedRows<Outbox>(['api', 'msg_outbox', 'outbox-tab', status], (from, to) => {
    let b = api().from('msg_outbox').select('*')
    if (status) b = b.eq('status', status)
    return b.order('created_at', { ascending: false }).range(from, to) as unknown as PromiseLike<{ data: Outbox[] | null; error: { message: string } | null }>
  })
  const rows = q.rows
  const [cancelling, setCancelling] = useState<Outbox | null>(null)
  const [reason, setReason] = useState('')
  const cancel = useApiMutation<{ p_id: string; p_reason: string }>('cancel_message', [['api', 'msg_outbox']])

  const cols: Column<Outbox>[] = [
    { key: 'when', header: t('common.when'), render: (r) => (r.created_at ? <span className="mono">{`${formatDate(r.created_at)} ${formatTime(r.created_at)}`}</span> : '') },
    { key: 'event', header: t('whatsapp.col.event'), render: (r) => <span className="mono">{r.event}</span> },
    { key: 'tpl', header: t('whatsapp.col.template'), render: (r) => <span className="mono">{r.template_name}</span> },
    { key: 'to', header: t('whatsapp.col.to'), render: (r) => <span className="mono">{r.to_masked ?? '—'}</span> },
    { key: 'party', header: t('whatsapp.col.party'), render: (r) => r.party_name ?? '' },
    {
      key: 'status',
      header: t('common.status'),
      render: (r) => {
        const s = outboxTone(r.status)
        return (
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Chip tone={s.tone} icon={s.icon}>{t(`whatsapp.status.${r.status ?? 'queued'}`)}</Chip>
            {r.skip_reason ? <span className="muted" style={{ fontSize: 12 }}>{r.skip_reason}</span> : null}
          </span>
        )
      },
    },
    { key: 'cost', header: t('whatsapp.col.cost'), align: 'right', render: (r) => (r.est_cost == null ? '—' : <Amount value={r.est_cost} rupee />) },
    ...(canEdit
      ? [
          {
            key: 'act',
            header: <span className="sr-only">{t('whatsapp.cancel')}</span>,
            render: (r: Outbox) =>
              r.status === 'queued' || r.status === 'failed' ? (
                <Button size="sm" aria-label={t('whatsapp.cancelMessage', { template: r.template_name })} onClick={() => { setCancelling(r); setReason('') }}>
                  {t('whatsapp.cancel')}
                </Button>
              ) : null,
          } satisfies Column<Outbox>,
        ]
      : []),
  ]

  return (
    <TableCard
      title={t('whatsapp.outboxTitle')}
      action={
        <div style={{ width: 200 }}>
          <SelectField
            label={t('common.status')}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[{ value: '', label: t('common.all') }, ...['queued', 'skipped', 'sent', 'delivered', 'read', 'failed', 'cancelled'].map((s) => ({ value: s, label: t(`whatsapp.status.${s}`) }))]}
          />
        </div>
      }
    >
      <p className="muted sf-card__pad" style={{ margin: 0, paddingTop: 0, fontSize: 13 }}>
        {t('whatsapp.outboxNote')}
      </p>
      <DataTable
        caption={t('whatsapp.outboxTitle')}
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id ?? ''}
        loading={q.isLoading}
        error={q.error ? <ErrorRef message={t('errors.loadFailed')} refId="WA-O" /> : undefined}
        empty={<EmptyState title={t('whatsapp.noOutbox')} body={t('whatsapp.noOutboxBody')} />}
        minWidth={980}
      />
      <LoadMore shown={rows.length} hasMore={q.hasMore} busy={q.loadingMore} onMore={q.loadMore} />
      <FormDialog
        open={cancelling !== null}
        onOpenChange={(o) => {
          if (!o) setCancelling(null)
          cancel.reset()
        }}
        title={t('whatsapp.cancelTitle')}
        description={t('whatsapp.cancelEffect', { template: cancelling?.template_name ?? '', to: cancelling?.to_masked ?? '—' })}
        submitLabel={t('whatsapp.cancelConfirm')}
        busy={cancel.isPending}
        onSubmit={() => cancelling?.id && reason.trim().length >= 3 && cancel.mutate({ p_id: cancelling.id, p_reason: reason.trim() }, { onSuccess: () => setCancelling(null) })}
        error={<RpcErrorBox error={cancel.error} />}
      >
        <TextAreaField label={t('common.reason')} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
      </FormDialog>
    </TableCard>
  )
}

/* ─────────── Inbound ─────────── */
function InboundTab() {
  const { t } = useTranslation()
  const q = useApiView('msg_inbound', { order: 'received_at', ascending: false, limit: 200 })
  const rows = rowsOf(q)
  const cols: Column<Inbound>[] = [
    { key: 'when', header: t('common.when'), render: (r) => (r.received_at ? <span className="mono">{`${formatDate(r.received_at)} ${formatTime(r.received_at)}`}</span> : '') },
    { key: 'from', header: t('whatsapp.col.from'), render: (r) => <span className="mono">{r.from_masked}</span> },
    { key: 'party', header: t('whatsapp.col.party'), render: (r) => r.party_name ?? <span className="muted">{t('whatsapp.unmatched')}</span> },
    { key: 'body', header: t('whatsapp.col.message'), render: (r) => (r.kind === 'text' ? (r.body ?? '') : t('whatsapp.media', { kind: r.kind })), width: '40%' },
    {
      key: 'window',
      header: t('whatsapp.col.window'),
      render: (r) => (r.window_expires_at ? <span className="mono">{`${formatDate(r.window_expires_at)} ${formatTime(r.window_expires_at)}`}</span> : '—'),
    },
  ]
  return (
    <TableCard title={t('whatsapp.inboundTitle')}>
      <DataTable
        caption={t('whatsapp.inboundTitle')}
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id ?? ''}
        loading={q.isLoading}
        error={q.error ? <ErrorRef message={t('errors.loadFailed')} refId="WA-I" /> : undefined}
        empty={<EmptyState title={t('whatsapp.noInbound')} body={t('whatsapp.noInboundBody')} />}
        minWidth={820}
      />
    </TableCard>
  )
}

/* ─────────── Channels ─────────── */
interface ChannelForm {
  id?: string
  company_id: string
  provider: string
  display_name: string
  phone_number_id: string
  waba_id: string
  status: string
}

function ChannelsTab({ canEdit, channels, loading, companies }: { canEdit: boolean; channels: Channel[]; loading: boolean; companies: ViewRow<'companies'>[] }) {
  const { t } = useTranslation()
  const [form, setForm] = useState<ChannelForm | null>(null)
  const save = useApiMutation<{ p: Record<string, unknown> }>('upsert_channel', [['api', 'msg_channels']])
  const nameOf = (id: string | null) => companies.find((c) => c.id === id)?.short_name ?? companies.find((c) => c.id === id)?.name ?? ''

  const cols: Column<Channel>[] = [
    { key: 'co', header: t('common.company'), render: (r) => nameOf(r.company_id) },
    { key: 'name', header: t('whatsapp.col.displayName'), render: (r) => r.display_name },
    { key: 'prov', header: t('whatsapp.col.provider'), render: (r) => t(`whatsapp.provider.${r.provider ?? 'meta'}`) },
    { key: 'pid', header: t('whatsapp.col.phoneId'), render: (r) => <span className="mono">{r.phone_number_id ?? '—'}</span> },
    {
      key: 'status',
      header: t('common.status'),
      render: (r) =>
        r.status === 'active' ? <Chip tone="success" icon="check">{t('whatsapp.connected')}</Chip> : r.status === 'paused' ? <Chip tone="neutral">{t('whatsapp.paused')}</Chip> : <Chip tone="signal">{t('whatsapp.notConnected')}</Chip>,
    },
    { key: 'q', header: t('whatsapp.col.quality'), render: (r) => r.quality_rating ?? '—' },
    ...(canEdit
      ? [
          {
            key: 'act',
            header: <span className="sr-only">{t('common.edit')}</span>,
            render: (r: Channel) => (
              <Button
                size="sm"
                aria-label={t('whatsapp.editChannel', { name: r.display_name })}
                onClick={() =>
                  setForm({
                    id: r.id ?? undefined,
                    company_id: r.company_id ?? '',
                    provider: r.provider ?? 'meta',
                    display_name: r.display_name ?? '',
                    phone_number_id: r.phone_number_id ?? '',
                    waba_id: r.waba_id ?? '',
                    status: r.status ?? 'not_connected',
                  })
                }
              >
                {t('common.edit')}
              </Button>
            ),
          } satisfies Column<Channel>,
        ]
      : []),
  ]

  return (
    <TableCard
      title={t('whatsapp.channelsTitle')}
      action={
        canEdit ? (
          <Button
            variant="primary"
            size="sm"
            onClick={() => setForm({ company_id: companies[0]?.id ?? '', provider: 'meta', display_name: '', phone_number_id: '', waba_id: '', status: 'not_connected' })}
          >
            {t('whatsapp.addChannel')}
          </Button>
        ) : null
      }
    >
      <p className="muted sf-card__pad" style={{ margin: 0, paddingTop: 0, fontSize: 13 }}>
        {t('whatsapp.channelsNote')}
      </p>
      <DataTable
        caption={t('whatsapp.channelsTitle')}
        columns={cols}
        rows={channels}
        rowKey={(r) => r.id ?? ''}
        loading={loading}
        empty={<EmptyState title={t('whatsapp.noChannels')} body={t('whatsapp.noChannelsBody')} />}
        minWidth={820}
      />
      <FormDialog
        open={form !== null}
        onOpenChange={(o) => {
          if (!o) setForm(null)
          save.reset()
        }}
        title={form?.id ? t('whatsapp.editChannelTitle') : t('whatsapp.addChannel')}
        description={t('whatsapp.channelHelp')}
        submitLabel={t('common.save')}
        busy={save.isPending}
        onSubmit={() => form && save.mutate({ p: { ...form, id: form.id, phone_number_id: form.phone_number_id || null, waba_id: form.waba_id || null } }, { onSuccess: () => setForm(null) })}
        error={<MsgErrorBox error={save.error} />}
      >
        {form ? (
          <FieldGrid cols={2}>
            <SelectField
              label={t('common.company')}
              value={form.company_id}
              disabled={Boolean(form.id)}
              onChange={(e) => setForm({ ...form, company_id: e.target.value })}
              options={companies.map((c) => ({ value: c.id ?? '', label: c.short_name ?? c.name ?? '' }))}
            />
            <SelectField
              label={t('whatsapp.col.provider')}
              value={form.provider}
              onChange={(e) => setForm({ ...form, provider: e.target.value })}
              options={['meta', 'gupshup', 'interakt', 'aisensy', 'wati', 'twilio'].map((p) => ({ value: p, label: t(`whatsapp.provider.${p}`) }))}
            />
            <Field label={t('whatsapp.col.displayName')} value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
            <Field label={t('whatsapp.col.phoneId')} value={form.phone_number_id} onChange={(e) => setForm({ ...form, phone_number_id: e.target.value })} className="mono" />
            <Field label={t('whatsapp.f.waba')} value={form.waba_id} onChange={(e) => setForm({ ...form, waba_id: e.target.value })} className="mono" />
            <SelectField
              label={t('common.status')}
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
              options={[
                ...(form.status === 'active' ? [{ value: 'active', label: t('whatsapp.connected') }] : []),
                { value: 'not_connected', label: t('whatsapp.notConnected') },
                { value: 'paused', label: t('whatsapp.paused') },
              ]}
              help={t('whatsapp.statusHelp')}
            />
          </FieldGrid>
        ) : null}
      </FormDialog>
    </TableCard>
  )
}

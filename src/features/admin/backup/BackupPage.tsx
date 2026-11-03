import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiRpc, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { routeForFile } from '@/app/flows'
import { formatDate, formatIndian, formatTime } from '@/shared/format'
import { Button, Card, Chip, DataTable, EmptyState, Field, FieldGrid, FormDialog, PageHeader, SelectField, Skeleton, TextAreaField, type Column } from '@/ui'
import { TableCard, TWO_COLS } from '@/features/admin/import-data/layout'

type Run = ViewRow<'backup_runs'>
type Batch = ViewRow<'import_batches'>

interface AdminUser {
  user_id: string
  status: string
  roles: { role: string }[] | null
}

const KINDS = ['restore_drill', 'pg_dump', 'storage_sync', 'supabase_daily', 'pitr', 'restore'] as const
const RUN_STATUS = ['ok', 'failed', 'running'] as const

interface Draft {
  kind: string
  status: string
  location: string
  started_at: string
  finished_at: string
  size_bytes: string
  checksum: string
  note: string
}

/** Local date-time for a datetime-local input (the browser's clock, sent with its offset). */
function nowLocal(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** A retention setting as a whole number, or null when Admin has not set it (never invented). */
function settingNumber(rows: ViewRow<'settings_current'>[], key: string): number | null {
  const row = rows.find((r) => r.key === key && r.company_id === null) ?? rows.find((r) => r.key === key)
  if (!row) return null
  const v = row.value as unknown
  const raw = typeof v === 'object' && v !== null && 'value' in v ? (v as { value: unknown }).value : v
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN
  return Number.isFinite(n) ? n : null
}

/**
 * Backup (`Backup`): the backup policy (Part 1 §25), retention from Settings, the recorded backup and
 * restore-drill runs (api.backup_runs) and the Tally files read so far (api.import_batches).
 * Admin records a run through api.record_backup_run; the server refuses locations outside India.
 */
export function BackupPage() {
  const { t } = useTranslation()
  const can = useCan()
  const { profile } = useAuth()
  const isAdmin = profile?.view === 'all'
  const canView = can('backup.view')

  const runs = useApiView('backup_runs', { order: 'started_at', ascending: false, limit: 50, enabled: canView })
  const settings = useApiView('settings_current', { order: 'key' })
  const batches = useApiView('import_batches', { order: 'created_at', ascending: false, limit: 8 })
  const users = useApiRpc<AdminUser[]>('list_users', {}, isAdmin)
  const record = useApiMutation<{ p: Record<string, unknown> }>('record_backup_run', [['api', 'backup_runs']])

  const [draft, setDraft] = useState<Draft | null>(null)
  const [errs, setErrs] = useState<Partial<Record<keyof Draft, string>>>({})

  const runList = rowsOf(runs)
  const settingRows = rowsOf(settings)
  const daily = settingNumber(settingRows, 'backup.daily_days')
  const monthly = settingNumber(settingRows, 'backup.monthly_months')
  const yearEnd = settingNumber(settingRows, 'backup.year_end_years')
  const lastDrill = runList.find((r) => r.kind === 'restore_drill' && r.status === 'ok')
  const lastSecondCopy = runList.find((r) => (r.kind === 'pg_dump' || r.kind === 'storage_sync') && r.status === 'ok')

  const adminCount = useMemo(() => {
    if (users.data?.status !== 'ready') return null
    return (users.data.data ?? []).filter((u) => u.status === 'active' && (u.roles ?? []).some((r) => r.role === 'admin' || r.role === 'owner')).length
  }, [users.data])

  function openRecord() {
    record.reset()
    setErrs({})
    setDraft({ kind: 'restore_drill', status: 'ok', location: '', started_at: nowLocal(), finished_at: '', size_bytes: '', checksum: '', note: '' })
  }

  function submit() {
    if (!draft) return
    const e: Partial<Record<keyof Draft, string>> = {}
    if (draft.location.trim().length < 3) e.location = t('backup.form.errLocation')
    if (draft.size_bytes.trim() && !/^\d+$/.test(draft.size_bytes.trim())) e.size_bytes = t('backup.form.errSize')
    setErrs(e)
    if (Object.keys(e).length) return
    const iso = (v: string) => (v ? new Date(v).toISOString() : null)
    record.mutate(
      {
        p: {
          kind: draft.kind,
          status: draft.status,
          location: draft.location.trim(),
          started_at: iso(draft.started_at),
          finished_at: iso(draft.finished_at),
          size_bytes: draft.size_bytes.trim() || null,
          checksum: draft.checksum.trim() || null,
          note: draft.note.trim() || null,
        },
      },
      { onSuccess: () => setDraft(null) },
    )
  }

  const keepValue = (n: number | null, unit: 'days' | 'months' | 'years') => (n === null ? <span className="muted">{t('backup.keep.notSet')}</span> : t(`backup.keep.${unit}`, { count: n }))

  const columns: Column<Run>[] = [
    { key: 'when', header: t('backup.history.when'), render: (r) => <span className="mono">{`${formatDate(r.started_at)} ${formatTime(r.started_at)}`}</span> },
    { key: 'kind', header: t('backup.history.kind'), render: (r) => t(`backup.kind.${r.kind}`, { defaultValue: r.kind }) },
    { key: 'location', header: t('backup.history.location'), render: (r) => r.location },
    { key: 'size', header: t('backup.history.size'), align: 'right', render: (r) => (r.size_bytes === null ? '—' : <span className="mono">{formatIndian(r.size_bytes, 0)}</span>) },
    {
      key: 'result',
      header: t('backup.history.result'),
      render: (r) => (
        <Chip tone={r.status === 'ok' ? 'success' : r.status === 'failed' ? 'danger' : 'signal'} icon={r.status === 'ok' ? 'check' : r.status === 'failed' ? 'cross' : 'clock'}>
          {t(`backup.runStatus.${r.status}`, { defaultValue: r.status })}
        </Chip>
      ),
    },
    { key: 'by', header: t('backup.history.by'), render: (r) => r.recorded_by_name ?? '—' },
  ]

  const batchList = rowsOf(batches)
  const batchColumns: Column<Batch>[] = [
    { key: 'company', header: t('backup.files.company'), render: (b) => b.company_name },
    { key: 'file', header: t('backup.files.file'), render: (b) => <span style={{ overflowWrap: 'anywhere' }}>{b.file_name ?? b.code}</span> },
    { key: 'what', header: t('backup.files.what'), render: (b) => <span className="muted">{`${b.code} · ${t('backup.files.rows', { count: b.row_count ?? 0 })}`}</span> },
    {
      key: 'status',
      header: t('backup.files.status'),
      render: (b) => (
        <Chip tone={b.status === 'approved' || b.status === 'processed' ? 'success' : b.status === 'failed' ? 'danger' : b.status === 'undone' ? 'neutral' : 'info'} icon={b.status === 'failed' ? 'cross' : b.status === 'awaiting_bridge' ? 'clock' : 'check'}>
          {t(`backup.batchStatus.${b.status}`, { defaultValue: b.status })}
        </Chip>
      ),
    },
  ]

  if (!canView) {
    return (
      <>
        <PageHeader title={t('backup.title')} subtitle={t('backup.subtitle')} />
        <Card>
          <p className="muted" style={{ margin: 0 }}>
            {t('backup.noRight')}
          </p>
        </Card>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title={t('backup.title')}
        subtitle={t('backup.subtitle')}
        actions={
          <>
            <Button comingInPhase={9}>{t('backup.exportAll')}</Button>
            <Button variant="primary" comingInPhase={9}>
              {t('backup.backupNow')}
            </Button>
          </>
        }
      />

      {isAdmin && adminCount !== null && adminCount < 2 ? (
        <Card accent="signal" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <Chip tone="signal" icon="alert">
              {t('backup.secondAdmin.chip')}
            </Chip>
            <span style={{ flex: '1 1 320px' }}>{t('backup.secondAdmin.body')}</span>
            <Link className="sf-btn" data-variant="secondary" to={routeForFile('Users')}>
              {t('backup.secondAdmin.add')}
            </Link>
          </div>
        </Card>
      ) : null}

      <div className="sf-grid-3" style={{ marginBottom: 16 }}>
        <Card title={t('backup.schedule.title')}>
          <InfoList
            rows={[
              { label: t('backup.schedule.daily'), value: t('backup.schedule.dailyValue') },
              { label: t('backup.schedule.pitr'), value: t('backup.schedule.pitrValue') },
              { label: t('backup.schedule.dump'), value: t('backup.schedule.dumpValue') },
              { label: t('backup.schedule.includes'), value: t('backup.schedule.includesValue') },
            ]}
          />
          <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>
            {t('backup.schedule.runner')}
          </p>
        </Card>
        <Card title={t('backup.where.title')}>
          <InfoList
            rows={[
              { label: t('backup.where.copy1'), value: t('backup.where.copy1Value') },
              {
                label: t('backup.where.copy2'),
                value: lastSecondCopy ? lastSecondCopy.location : <span className="muted">{`${t('backup.where.copy2Value')} · ${t('backup.where.copy2Choose')}`}</span>,
              },
              {
                label: t('backup.where.encryption'),
                value: (
                  <Chip tone="success" icon="check">
                    {t('backup.where.on')}
                  </Chip>
                ),
              },
            ]}
          />
          <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>
            {t('backup.where.rule')}
          </p>
        </Card>
        <Card title={t('backup.keep.title')}>
          {settings.isLoading ? (
            <Skeleton height={96} />
          ) : (
            <InfoList
              rows={[
                { label: t('backup.keep.daily'), value: keepValue(daily, 'days') },
                { label: t('backup.keep.monthly'), value: keepValue(monthly, 'months') },
                { label: t('backup.keep.yearEnd'), value: keepValue(yearEnd, 'years') },
                { label: t('backup.keep.drill'), value: t('backup.keep.drillValue') },
                { label: t('backup.keep.lastDrill'), value: lastDrill ? formatDate(lastDrill.started_at) : <span className="muted">{t('backup.keep.never')}</span> },
              ]}
            />
          )}
          {daily === null || monthly === null || yearEnd === null ? (
            <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>
              {t('backup.keep.settingsHint')}
            </p>
          ) : null}
        </Card>
      </div>

      <div style={TWO_COLS}>
        <Card
          title={t('backup.tally.title')}
          action={
            <Chip tone="info" icon="info">
              {t('backup.tally.ready')}
            </Chip>
          }
        >
          <ol style={{ margin: '0 0 8px', paddingLeft: 20, display: 'grid', gap: 4 }}>
            <li>{t('backup.tally.s1')}</li>
            <li>{t('backup.tally.s2')}</li>
            <li>{t('backup.tally.s3')}</li>
            <li>
              {t('backup.tally.s4')} <Link to={routeForFile('BookFixes')}>{t('backup.tally.bugFixer')}</Link>
            </li>
            <li>{t('backup.tally.s5')}</li>
          </ol>
          <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>
            {t('backup.tally.note')}
          </p>
          <Link className="sf-btn" data-variant="primary" to={routeForFile('DataImport')}>
            {t('backup.tally.open')}
          </Link>
        </Card>
        <TableCard title={t('backup.files.title')}>
          {batches.error ? (
            <div className="sf-card__pad">
              <p className="muted" style={{ margin: 0 }}>
                {t('backup.files.noRight')}
              </p>
            </div>
          ) : (
            <DataTable
              caption={t('backup.files.caption')}
              columns={batchColumns}
              rows={batchList}
              rowKey={(b) => b.id}
              loading={batches.isLoading}
              minWidth={480}
              empty={<EmptyState title={t('backup.files.empty')} />}
            />
          )}
        </TableCard>
      </div>

      <div style={{ ...TWO_COLS, marginBottom: 0 }}>
        <Card title={t('backup.restore.title')}>
          <ol style={{ margin: '0 0 8px', paddingLeft: 20, display: 'grid', gap: 4 }}>
            <li>{t('backup.restore.s1')}</li>
            <li>{t('backup.restore.s2')}</li>
            <li>{t('backup.restore.s3')}</li>
            <li>{t('backup.restore.s4')}</li>
          </ol>
          <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>
            {t('backup.restore.note')}
          </p>
          <Button comingInPhase={9}>{t('backup.restore.start')}</Button>
        </Card>
        <TableCard
          title={t('backup.history.title')}
         
          action={
            isAdmin ? (
              <Button size="sm" variant="primary" onClick={openRecord}>
                {t('backup.history.record')}
              </Button>
            ) : null
          }
        >
          <DataTable
            caption={t('backup.history.caption')}
            columns={columns}
            rows={runList}
            rowKey={(r) => r.id}
            loading={runs.isLoading}
            minWidth={560}
            error={runs.error ? t('errors.loadFailed') : undefined}
            empty={<EmptyState title={isAdmin ? t('backup.history.emptyAdmin') : t('backup.history.empty')} />}
          />
        </TableCard>
      </div>

      <FormDialog
        open={draft !== null}
        onOpenChange={(o) => !o && setDraft(null)}
        title={t('backup.form.title')}
        description={t('backup.form.description')}
        submitLabel={t('backup.form.save')}
        busy={record.isPending}
        onSubmit={submit}
        error={<BackupError error={record.error} />}
      >
        {draft ? (
          <>
            <FieldGrid>
              <SelectField label={t('backup.form.kind')} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} options={KINDS.map((k) => ({ value: k, label: t(`backup.kind.${k}`) }))} />
              <SelectField label={t('backup.form.status')} value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })} options={RUN_STATUS.map((k) => ({ value: k, label: t(`backup.runStatus.${k}`) }))} />
            </FieldGrid>
            <Field label={t('backup.form.location')} value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} error={errs.location} help={t('backup.form.locationHelp')} required />
            <FieldGrid>
              <Field label={t('backup.form.startedAt')} type="datetime-local" value={draft.started_at} onChange={(e) => setDraft({ ...draft, started_at: e.target.value })} />
              <Field label={t('backup.form.finishedAt')} type="datetime-local" value={draft.finished_at} onChange={(e) => setDraft({ ...draft, finished_at: e.target.value })} />
              <Field label={t('backup.form.sizeBytes')} inputMode="numeric" value={draft.size_bytes} onChange={(e) => setDraft({ ...draft, size_bytes: e.target.value })} error={errs.size_bytes} />
              <Field label={t('backup.form.checksum')} value={draft.checksum} onChange={(e) => setDraft({ ...draft, checksum: e.target.value })} />
            </FieldGrid>
            <TextAreaField label={t('backup.form.note')} rows={2} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
          </>
        ) : null}
      </FormDialog>
    </>
  )
}

/** RpcErrorBox, with this screen's own rule message for locations outside India. */
function BackupError({ error }: { error: RpcError | null }) {
  const { t } = useTranslation()
  if (!error) return null
  if (error.rule === 'backup.outside_india') {
    return (
      <div className="sf-errorref" role="alert">
        <strong>{t('backup.rules.backup.outside_india')}</strong>
        <span>{t('errors.nextStep')}</span>
        <span>
          {t('common.reference')} <span className="mono">{error.ref}</span>
        </span>
      </div>
    )
  }
  return <RpcErrorBox error={error} />
}

/** Label / value rows for policy text (KeyValue sets values in mono, which is for figures only). */
function InfoList({ rows }: { rows: { label: ReactNode; value: ReactNode }[] }) {
  return (
    <dl style={{ margin: 0 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderTop: i === 0 ? undefined : '1px solid var(--sf-line-faint)' }}>
          <dt className="muted" style={{ flex: '0 0 auto' }}>{r.label}</dt>
          <dd style={{ margin: 0, textAlign: 'right' }}>{r.value}</dd>
        </div>
      ))}
    </dl>
  )
}

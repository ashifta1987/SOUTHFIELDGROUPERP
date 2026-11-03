import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { api } from '@/shared/supabase'
import { formatDate, formatTime } from '@/shared/format'
import { Button, Chip, ConfirmDialog, DataTable, EmptyState, FormDialog, TextAreaField, type Column } from '@/ui'
import type { BatchResult } from '@/features/import/runImport'
import { TableCard } from './layout'

export type Batch = ViewRow<'import_batches'>
type ImportRow = ViewRow<'import_rows'>

export const IMPORT_KEYS = [['api', 'import_batches'], ['api', 'import_rows'], ['api', 'bug_items'], ['api', 'bug_fixer_open_count'], ['api', 'accounts'], ['api', 'open_bills'], ['api', 'source_key_counts'], ['api', 'account_groups']]

type Tone = 'neutral' | 'teal' | 'info' | 'signal' | 'success' | 'danger'
const STATUS_TONE: Record<string, { tone: Tone; icon: string }> = {
  uploaded: { tone: 'info', icon: 'info' },
  awaiting_bridge: { tone: 'signal', icon: 'clock' },
  staged: { tone: 'info', icon: 'info' },
  processed: { tone: 'teal', icon: 'check' },
  approved: { tone: 'success', icon: 'check' },
  undone: { tone: 'neutral', icon: 'cross' },
  failed: { tone: 'danger', icon: 'cross' },
}

export function BatchStatus({ status }: { status: string }) {
  const { t } = useTranslation()
  const s = STATUS_TONE[status] ?? { tone: 'neutral' as Tone, icon: 'info' }
  return (
    <Chip tone={s.tone} icon={s.icon}>
      {t(`importData.status.${status}`, { defaultValue: status })}
    </Chip>
  )
}

/** Refusal message: this screen's own import.* rule codes first, then the shared RpcErrorBox. */
export function ImportError({ error }: { error: RpcError | null | undefined }) {
  const { t } = useTranslation()
  if (!error) return null
  if (error.rule === 'import.locked' || error.rule === 'import.missing') {
    return (
      <div className="sf-errorref" role="alert">
        <strong>{t(`importData.rules.${error.rule}`)}</strong>
        <span>{t('errors.nextStep')}</span>
        <span>
          {t('common.reference')} <span className="mono">{error.ref}</span>
        </span>
      </div>
    )
  }
  return <RpcErrorBox error={error} />
}

/** Rows still waiting for a Tally group mapping, per batch (read from api.import_rows, decided by Postgres). */
export function useWaitingRows(batchIds: string[]) {
  return useQuery({
    queryKey: ['api', 'import_rows', 'waiting_map', batchIds.join(',')],
    enabled: batchIds.length > 0,
    staleTime: 10_000,
    queryFn: async () => {
      const { data, error } = await api().from('import_rows').select('batch_id').eq('message', 'waiting_map').in('batch_id', batchIds).limit(5000)
      if (error) throw new Error(error.message)
      const out: Record<string, number> = {}
      for (const r of (data ?? []) as { batch_id: string }[]) out[r.batch_id] = (out[r.batch_id] ?? 0) + 1
      return out
    },
  })
}

/**
 * Import history: every batch of the chosen company (api.import_batches) with "Check and load" (api.import_process),
 * Approve (Admin, api.import_approve), Undo with a reason (Admin, api.import_undo) and the rows of a batch (api.import_rows).
 */
export function ImportHistory({
  companyId,
  canImport,
  isAdmin,
  onResult,
}: {
  companyId: string | undefined
  canImport: boolean
  isAdmin: boolean
  onResult: (r: BatchResult) => void
}) {
  const { t } = useTranslation()
  const batches = useApiView('import_batches', { order: 'created_at', ascending: false, eq: { company_id: companyId }, limit: 50, enabled: Boolean(companyId) })
  const list = rowsOf(batches)
  const processedIds = useMemo(() => list.filter((b) => b.status === 'processed').map((b) => b.id), [list])
  const waiting = useWaitingRows(processedIds)
  const process = useApiMutation<{ p_batch_id: string }, BatchResult>('import_process', IMPORT_KEYS)
  const approve = useApiMutation<{ p_batch_id: string }>('import_approve', IMPORT_KEYS)
  const undo = useApiMutation<{ p_batch_id: string; p_reason: string }>('import_undo', IMPORT_KEYS)

  const [approving, setApproving] = useState<Batch | null>(null)
  const [undoing, setUndoing] = useState<Batch | null>(null)
  const [reason, setReason] = useState('')
  const [reasonErr, setReasonErr] = useState<string | undefined>()
  const [open, setOpen] = useState<Batch | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  function checkAndLoad(b: Batch) {
    process.reset()
    setBusyId(b.id)
    process.mutate(
      { p_batch_id: b.id },
      {
        onSuccess: (r) => onResult({ ...r, id: b.id, code: b.code }),
        onSettled: () => setBusyId(null),
      },
    )
  }

  const columns: Column<Batch>[] = [
    { key: 'code', header: t('importData.history.code'), render: (b) => <span className="mono">{b.code}</span> },
    { key: 'file', header: t('importData.history.file'), render: (b) => <span style={{ overflowWrap: 'anywhere' }}>{b.file_name ?? '—'}</span> },
    { key: 'source', header: t('importData.history.source'), render: (b) => t(`importData.source.${b.source}`, { defaultValue: b.source }) },
    { key: 'rows', header: t('importData.history.rows'), align: 'right', render: (b) => <span className="mono">{b.row_count ?? 0}</span> },
    {
      key: 'bugs',
      header: t('importData.history.bugs'),
      align: 'right',
      render: (b) => <span className="mono">{b.open_bugs ?? 0}</span>,
    },
    {
      key: 'status',
      header: t('importData.history.status'),
      render: (b) => (
        <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
          <BatchStatus status={b.status} />
          {waiting.data?.[b.id] ? (
            <Chip tone="signal" icon="clock">
              {t('importData.history.waiting', { count: waiting.data[b.id] })}
            </Chip>
          ) : null}
        </span>
      ),
    },
    { key: 'by', header: t('importData.history.when'), render: (b) => <span className="muted">{`${formatDate(b.created_at)} ${formatTime(b.created_at)} · ${b.created_by_name ?? '—'}`}</span> },
    {
      key: 'actions',
      header: t('importData.history.actions'),
      render: (b) => {
        const canLoad = canImport && (b.status === 'staged' || (b.status === 'processed' && (waiting.data?.[b.id] ?? 0) > 0))
        const canUndo = isAdmin && ['staged', 'processed', 'uploaded', 'awaiting_bridge'].includes(b.status)
        return (
          <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
            {canLoad ? (
              <Button size="sm" variant="primary" busy={busyId === b.id} onClick={() => checkAndLoad(b)} aria-label={`${t('importData.history.check')} ${b.code}`}>
                {t('importData.history.check')}
              </Button>
            ) : null}
            {isAdmin && b.status === 'processed' ? (
              <Button size="sm" onClick={() => (approve.reset(), setApproving(b))} aria-label={`${t('importData.history.approve')} ${b.code}`}>
                {t('importData.history.approve')}
              </Button>
            ) : null}
            {canUndo ? (
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  undo.reset()
                  setReason('')
                  setReasonErr(undefined)
                  setUndoing(b)
                }}
                aria-label={`${t('importData.history.undo')} ${b.code}`}
              >
                {t('importData.history.undo')}
              </Button>
            ) : null}
            <Button size="sm" variant="link" onClick={() => setOpen(open?.id === b.id ? null : b)} aria-label={`${t('importData.history.rowsBtn')} ${b.code}`} aria-expanded={open?.id === b.id}>
              {t('importData.history.rowsBtn')}
            </Button>
          </span>
        )
      },
    },
  ]

  return (
    <>
      <TableCard title={t('importData.history.title')}>
        {process.error || approve.error ? (
          <div className="sf-card__pad">
            <ImportError error={process.error ?? approve.error} />
          </div>
        ) : null}
        <DataTable
          caption={t('importData.history.caption')}
          columns={columns}
          rows={list}
          rowKey={(b) => b.id}
          loading={batches.isLoading}
          minWidth={980}
          error={batches.error ? t('errors.loadFailed') : undefined}
          empty={<EmptyState title={t('importData.history.empty')} />}
        />
      </TableCard>

      {open ? <BatchRows batch={open} onClose={() => setOpen(null)} /> : null}

      <ConfirmDialog
        open={approving !== null}
        onOpenChange={(o) => !o && setApproving(null)}
        title={t('importData.history.approveTitle', { code: approving?.code ?? '' })}
        effect={t('importData.history.approveEffect', { code: approving?.code ?? '' })}
        confirmLabel={t('importData.history.approve')}
        busy={approve.isPending}
        onConfirm={() => approving && approve.mutate({ p_batch_id: approving.id }, { onSettled: () => setApproving(null) })}
      />

      <FormDialog
        open={undoing !== null}
        onOpenChange={(o) => !o && setUndoing(null)}
        title={t('importData.history.undoTitle', { code: undoing?.code ?? '' })}
        description={t('importData.history.undoDescription')}
        submitLabel={t('importData.history.undoSave')}
        busy={undo.isPending}
        error={<ImportError error={undo.error} />}
        onSubmit={() => {
          if (!undoing) return
          if (reason.trim().length < 5) {
            setReasonErr(t('importData.history.errReason'))
            return
          }
          setReasonErr(undefined)
          undo.mutate({ p_batch_id: undoing.id, p_reason: reason.trim() }, { onSuccess: () => setUndoing(null) })
        }}
      >
        <TextAreaField label={t('importData.history.undoReason')} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} error={reasonErr} required />
      </FormDialog>
    </>
  )
}

const ROW_LIMIT = 200

function BatchRows({ batch, onClose }: { batch: Batch; onClose: () => void }) {
  const { t } = useTranslation()
  const rows = useApiView('import_rows', { order: 'seq', eq: { batch_id: batch.id }, limit: ROW_LIMIT })
  const list = rowsOf(rows)
  const columns: Column<ImportRow>[] = [
    { key: 'seq', header: t('importData.rows.seq'), align: 'right', render: (r) => <span className="mono">{r.seq}</span> },
    { key: 'type', header: t('importData.rows.type'), render: (r) => t(`importData.object.${r.object_type}`, { defaultValue: r.object_type }) },
    { key: 'name', header: t('importData.rows.name'), render: (r) => r.name ?? '—' },
    { key: 'result', header: t('importData.rows.result'), render: (r) => (r.result ? <ResultChip result={r.result} /> : <span className="muted">{t('importData.result.pending')}</span>) },
    {
      key: 'message',
      header: t('importData.rows.message'),
      render: (r) => (r.message ? <span className="muted">{t(`importData.message.${r.message}`, { defaultValue: r.message })}</span> : null),
    },
  ]
  return (
    <TableCard
      title={t('importData.rows.title', { code: batch.code })}
     
      style={{ marginTop: 16 }}
      action={
        <Button size="sm" onClick={onClose}>
          {t('importData.rows.close')}
        </Button>
      }
    >
      <DataTable
        caption={t('importData.rows.caption')}
        columns={columns}
        rows={list}
        rowKey={(r) => String(r.id)}
        loading={rows.isLoading}
        minWidth={640}
        error={rows.error ? t('errors.loadFailed') : undefined}
        empty={<EmptyState title={t('importData.rows.empty')} />}
      />
      {list.length >= ROW_LIMIT ? (
        <p className="muted sf-card__pad" style={{ margin: 0, fontSize: 13 }}>
          {t('importData.rows.more', { count: ROW_LIMIT })}
        </p>
      ) : null}
    </TableCard>
  )
}

const RESULT_TONE: Record<string, { tone: Tone; icon: string }> = {
  created: { tone: 'success', icon: 'check' },
  linked: { tone: 'teal', icon: 'check' },
  aliased: { tone: 'teal', icon: 'check' },
  skipped: { tone: 'neutral', icon: 'info' },
  bug: { tone: 'signal', icon: 'alert' },
  changed: { tone: 'signal', icon: 'alert' },
  error: { tone: 'danger', icon: 'cross' },
}

export function ResultChip({ result }: { result: string }) {
  const { t } = useTranslation()
  const s = RESULT_TONE[result] ?? { tone: 'neutral' as Tone, icon: 'info' }
  return (
    <Chip tone={s.tone} icon={s.icon}>
      {t(`importData.result.${result}`, { defaultValue: result })}
    </Chip>
  )
}

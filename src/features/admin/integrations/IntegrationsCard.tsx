import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { RpcError, callApi } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { formatDate, formatTime } from '@/shared/format'
import { Button, Card, Chip, DataTable, EmptyState, ErrorRef, Tabs, type Column } from '@/ui'

type Req = ViewRow<'integration_requests'>
type Ev = ViewRow<'webhook_events'>
const FILTERS = ['attention', 'all'] as const
type Filter = (typeof FILTERS)[number]

const TONE: Record<string, 'info' | 'success' | 'danger' | 'neutral' | 'signal'> = { queued: 'info', in_progress: 'signal', done: 'success', dead: 'danger', cancelled: 'neutral' }

function when(v: string | null | undefined) {
  return v ? `${formatDate(v)} ${formatTime(v)}` : '—'
}

function IntegrationErrorBox({ error }: { error: RpcError | null }) {
  const { t } = useTranslation()
  if (!error) return null
  if (error.rule) {
    const key = `integrations.rules.${error.rule}`
    const msg = t(key)
    if (msg !== key) return <ErrorRef message={msg} next={t('errors.nextStep')} refId={error.ref} />
  }
  return <RpcErrorBox error={error} />
}

/**
 * Bug fixer → Integrations (Admin; RLS on ops.integration_requests and ops.webhook_events). Outbound calls with their
 * attempts, back-off and dead letters (each dead letter also opens a Bug fixer item, area "Integrations"), with Retry
 * (api.integration_retry) and, on DEV, "Run with mock provider" (api.run_mock_integration). Below: the latest inbound
 * webhooks — signature result and dedupe status; payloads are never shown here.
 */
export function IntegrationsCard() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [filter, setFilter] = useState<Filter>('attention')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<RpcError | null>(null)
  const titleId = useId()
  const reqs = useApiView('integration_requests', { order: 'created_at', ascending: false, limit: 200 })
  const events = useApiView('webhook_events', { order: 'received_at', ascending: false, limit: 20 })
  const all = rowsOf(reqs)
  const shown = filter === 'attention' ? all.filter((r) => r.status !== 'done' && r.status !== 'cancelled') : all
  const count = (s: string) => all.filter((r) => r.status === s).length

  async function act(key: string, fn: string, args: Record<string, unknown>) {
    setBusy(key)
    setError(null)
    try {
      await callApi(fn, args)
      await qc.invalidateQueries({ queryKey: ['api', 'integration_requests'] })
      await qc.invalidateQueries({ queryKey: ['api', 'bug_items'] })
    } catch (e) {
      setError(e instanceof RpcError ? e : null)
    } finally {
      setBusy(null)
    }
  }

  const columns: Column<Req>[] = [
    { key: 'kind', header: t('integrations.cols.kind'), render: (r) => <span>{t(`integrations.kind.${r.kind}`, { defaultValue: r.kind ?? '' })}<br /><span className="k">{r.company_name ?? '—'} · <span className="mono">{r.provider}</span></span></span> },
    { key: 'status', header: t('integrations.cols.status'), render: (r) => <Chip tone={TONE[r.status ?? ''] ?? 'neutral'}>{t(`integrations.status.${r.status}`, { defaultValue: r.status ?? '' })}</Chip> },
    { key: 'attempts', header: t('integrations.cols.attempts'), align: 'right', render: (r) => <span className="mono">{r.attempts}/{r.max_attempts}</span> },
    { key: 'next', header: t('integrations.cols.next'), render: (r) => (r.status === 'queued' ? when(r.next_attempt_at) : '—') },
    { key: 'error', header: t('integrations.cols.error'), render: (r) => <span className="k">{r.last_error ?? '—'}{r.bug_code ? <><br /><span className="mono">{r.bug_code}</span></> : null}</span> },
    {
      key: 'act', header: <span className="sr-only">{t('integrations.cols.actions')}</span>, render: (r) => (
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {r.status === 'dead' ? <Button size="sm" busy={busy === `retry-${r.id}`} onClick={() => void act(`retry-${r.id}`, 'integration_retry', { p_request_id: r.id })}>{t('integrations.retry')}</Button> : null}
          {r.status === 'queued' && r.provider === 'mock' ? (
            <Button size="sm" busy={busy === `mock-${r.id}`} onClick={() => void act(`mock-${r.id}`, 'run_mock_integration', { p_request_id: r.id, p: {} })}>{t('integrations.runMock')}</Button>
          ) : null}
        </span>
      ),
    },
  ]

  const evColumns: Column<Ev>[] = [
    { key: 'at', header: t('integrations.ev.at'), render: (e) => when(e.received_at) },
    { key: 'provider', header: t('integrations.ev.provider'), render: (e) => <span className="mono">{e.provider}</span> },
    { key: 'topic', header: t('integrations.ev.topic'), render: (e) => e.topic ?? '—' },
    { key: 'sig', header: t('integrations.ev.signature'), render: (e) => <Chip tone={e.signature_ok ? 'success' : 'danger'}>{e.signature_ok ? t('integrations.ev.sigOk') : t('integrations.ev.sigBad')}</Chip> },
    { key: 'status', header: t('integrations.ev.status'), render: (e) => t(`integrations.ev.st.${e.status}`, { defaultValue: e.status ?? '' }) },
  ]

  return (
    <Card title={t('integrations.title')} labelledBy={titleId}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>{t('integrations.intro')}</p>
        <div className="sf-row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Chip tone="info">{t('integrations.count.queued', { n: count('queued') })}</Chip>
          <Chip tone="signal">{t('integrations.count.in_progress', { n: count('in_progress') })}</Chip>
          <Chip tone="danger">{t('integrations.count.dead', { n: count('dead') })}</Chip>
        </div>
        <Tabs label={t('integrations.filter')} value={filter} onChange={setFilter} tabs={FILTERS.map((f) => ({ key: f, label: t(`integrations.filters.${f}`) }))} />
        <IntegrationErrorBox error={error} />
        <DataTable caption={t('integrations.caption')} columns={columns} rows={shown} rowKey={(r) => r.id ?? ''} loading={reqs.isLoading} minWidth={760}
          empty={<EmptyState title={t('integrations.empty')} body={t('integrations.emptyBody')} />} />
        <DataTable caption={t('integrations.ev.caption')} columns={evColumns} rows={rowsOf(events)} rowKey={(e) => String(e.id)} loading={events.isLoading} minWidth={620}
          empty={<EmptyState title={t('integrations.ev.empty')} />} />
      </div>
    </Card>
  )
}

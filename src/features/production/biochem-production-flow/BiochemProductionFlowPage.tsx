import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView } from '@/data/queries'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { formatDate, formatTime } from '@/shared/format'
import { Card, Chip, DataTable, EmptyState, KeyValue, PageHeader, Skeleton, type Column } from '@/ui'
import { ProdStatus, ViewError } from '../biochem-common/biochem'
import type { ViewRow } from '@/data/queries'

/** The steps of a batch, who does each and on which screen (the states and the RPC come from api.batch_states). */
const LANES = ['admin', 'manager', 'stores', 'staff', 'qc', 'packing'] as const
const STEPS: { key: string; lane: (typeof LANES)[number]; status: string | null; route: string; gate?: boolean }[] = [
  { key: 'masters', lane: 'admin', status: null, route: '/admin/licences-and-documents' },
  { key: 'formula', lane: 'manager', status: null, route: '/production/biochem-manufacturing' },
  { key: 'plan', lane: 'manager', status: 'planned', route: '/production/biochem-production-entry' },
  { key: 'reserve', lane: 'stores', status: 'reserved', route: '/production/biochem-production-entry' },
  { key: 'weigh', lane: 'staff', status: 'weighed', route: '/production/biochem-production-entry' },
  { key: 'make', lane: 'staff', status: 'in_process', route: '/production/biochem-production-entry' },
  { key: 'bulk', lane: 'qc', status: 'bulk_passed', route: '/production/biochem-labs', gate: true },
  { key: 'pack', lane: 'packing', status: 'packed_hold', route: '/production/biochem-production-entry' },
  { key: 'release', lane: 'qc', status: 'released', route: '/production/biochem-production-entry', gate: true },
  { key: 'close', lane: 'manager', status: 'closed', route: '/production/biochem-costing' },
]

/**
 * Biochem production flow (`BiochemFlow`): who does each step of a batch and what must be true before the next one,
 * the batch states (api.batch_states) with how many batches of the company stand in each (api.batches), and the latest
 * state changes (api.batch_events).
 */
export function BiochemProductionFlowPage() {
  const { t } = useTranslation()
  const choice = useCompanyChoice()
  const companyId = choice.companyId
  const states = useApiView('batch_states', { order: 'step' })
  const batches = useApiView('batches', { eq: { company_id: companyId }, limit: 1000, enabled: Boolean(companyId) })
  const events = useApiView('batch_events', { eq: { company_id: companyId }, order: 'id', ascending: false, limit: 30, enabled: Boolean(companyId) })
  const [step, setStep] = useState(STEPS[2]?.key ?? 'plan')
  const current = STEPS.find((s) => s.key === step) ?? STEPS[0]
  const count = (status: string | null) => rowsOf(batches).filter((b) => b.status === status).length
  const stateRow = rowsOf(states).find((s) => s.status === current?.status)

  const evCols: Column<ViewRow<'batch_events'>>[] = [
    { key: 'at', header: t('biochemFlow.ev.when'), render: (e) => `${formatDate(e.at)} ${formatTime(e.at)}` },
    { key: 'batch', header: t('biochemFlow.ev.batch'), render: (e) => <Link className="mono" to={`/production/biochem-production-entry?company=${e.company_id}&batch=${e.batch_id}`}>{rowsOf(batches).find((b) => b.id === e.batch_id)?.batch_no ?? t('biochemFlow.ev.open')}</Link> },
    { key: 'from', header: t('biochemFlow.ev.from'), render: (e) => <ProdStatus status={e.from_status} /> },
    { key: 'to', header: t('biochemFlow.ev.to'), render: (e) => <ProdStatus status={e.to_status} /> },
    { key: 'by', header: t('biochemFlow.ev.by'), render: (e) => e.by_name ?? '—' },
    { key: 'note', header: t('biochemFlow.ev.note'), render: (e) => e.note ?? '' },
  ]

  return (
    <>
      <PageHeader title={t('biochemFlow.title')} subtitle={t('biochemFlow.subtitle')} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <CompanyPicker list={choice.list} value={companyId} onChange={choice.choose} />
      </div>
      {choice.isLoading ? (
        <Card>
          <Skeleton height={80} />
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card title={t('biochemFlow.who')} action={<span className="k">{t('biochemFlow.whoHint')}</span>}>
            <div role="list" aria-label={t('biochemFlow.who')} style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {LANES.map((lane) => (
                <div key={lane} role="listitem" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8, alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--sf-line)' }}>
                  <strong>{t(`biochemFlow.lane.${lane}`)}</strong>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {STEPS.map((s, i) =>
                      s.lane === lane ? (
                        <button
                          key={s.key}
                          type="button"
                          className="sf-chip"
                          data-tone={s.key === step ? 'teal' : s.gate ? 'success' : 'outline'}
                          aria-pressed={s.key === step}
                          onClick={() => setStep(s.key)}
                          style={{ padding: '6px 12px', minHeight: 32, cursor: 'pointer', fontWeight: s.key === step ? 700 : 500 }}
                        >
                          <span className="mono" style={{ marginRight: 6 }}>
                            {i}
                          </span>
                          {t(`biochemFlow.step.${s.key}.name`)}
                        </button>
                      ) : null,
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Card>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16, alignItems: 'start' }}>
            {current ? (
              <Card title={t('biochemFlow.stepTitle', { name: t(`biochemFlow.step.${current.key}.name`) })} action={<Link to={`${current.route}${companyId ? `?company=${companyId}` : ''}`}>{t('biochemFlow.openScreen')}</Link>}>
                <KeyValue
                  rows={[
                    { label: t('biochemFlow.k.who'), value: t(`biochemFlow.lane.${current.lane}`) },
                    { label: t('biochemFlow.k.what'), value: t(`biochemFlow.step.${current.key}.what`) },
                    { label: t('biochemFlow.k.after'), value: current.status ? <ProdStatus status={current.status} /> : '—' },
                    { label: t('biochemFlow.k.must'), value: t(`biochemFlow.step.${current.key}.must`) },
                    { label: t('biochemFlow.k.rpc'), value: stateRow?.rpc ? <span className="mono">{stateRow.rpc}</span> : '—' },
                    { label: t('biochemFlow.k.now'), value: current.status ? t('biochemFlow.k.nowValue', { n: count(current.status) }) : '—' },
                  ]}
                />
              </Card>
            ) : null}
            <Card title={t('biochemFlow.states')}>
              {states.isLoading ? (
                <Skeleton height={60} />
              ) : (
                <ol aria-label={t('biochemFlow.states')} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {rowsOf(states).map((s) => (
                    <li key={s.status ?? ''} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <ProdStatus status={s.status} />
                      <span className="k mono" data-testid={`state-count-${s.status ?? ''}`}>
                        {companyId ? count(s.status) : 0}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              <p className="muted" style={{ marginBottom: 0 }}>
                {t('biochemFlow.statesNote')}
              </p>
              <p style={{ marginBottom: 0 }}>
                <Chip tone="success">{t('biochemFlow.gates')}</Chip>
              </p>
            </Card>
          </div>
          <TableCard title={t('biochemFlow.ev.title')}>
            <DataTable caption={t('biochemFlow.ev.title')} columns={evCols} rows={rowsOf(events)} rowKey={(e) => String(e.id)} loading={events.isLoading} minWidth={820} error={events.error ? <ViewError error={events.error} /> : undefined} empty={<EmptyState title={t('biochemFlow.ev.empty')} />} />
          </TableCard>
          <Card title={t('biochemFlow.side.title')}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
              {['receiving', 'rework', 'recall', 'licence', 'waste', 'cost'].map((k) => (
                <div key={k}>
                  <strong>{t(`biochemFlow.side.${k}.title`)}</strong>
                  <p className="muted" style={{ margin: '4px 0 0' }}>
                    {t(`biochemFlow.side.${k}.body`)}
                  </p>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </>
  )
}

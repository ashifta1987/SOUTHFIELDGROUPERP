import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { formatDate } from '@/shared/format'
import { Amount, Button, Card, Chip, DataTable, EmptyState, FormDialog, PageHeader, Skeleton, StatusChip, Tabs, TextAreaField, type Column } from '@/ui'
import { HrErrorBox } from '../common/hr'

type Req = ViewRow<'staff_requests'>
type Filter = 'all' | 'leave' | 'advance'

/**
 * Leave and advance requests (`Requests`): staff send them from the staff app; a person with the HR approve right
 * decides through api.decide_staff_request. Nobody decides their own request — the server refuses it, and the screen
 * says so beside such a request. Approved leave is marked in attendance; an approved advance is paid on Cash given.
 */
export function RequestsPage() {
  const { t } = useTranslation()
  const can = useCan()
  const { profile, session } = useAuth()
  const readOnly = profile?.view === 'all-readonly'
  const q = useApiView('staff_requests', { order: 'created_at', ascending: false, limit: 500 })
  const [filter, setFilter] = useState<Filter>('all')
  const [deciding, setDeciding] = useState<{ r: Req; approve: boolean } | null>(null)
  const all = rowsOf(q)
  const shown = all.filter((r) => filter === 'all' || r.kind === filter)
  const pending = shown.filter((r) => r.status === 'pending')
  const decided = shown.filter((r) => r.status !== 'pending')
  const canDecide = !readOnly && can('hr.approve')
  const me = session?.user.id

  const columns: Column<Req>[] = [
    { key: 'when', header: t('requests.col.sent'), render: (r) => <span className="mono">{formatDate(r.created_at)}</span> },
    { key: 'who', header: t('requests.col.staff'), render: (r) => <strong>{r.person_name}</strong> },
    { key: 'kind', header: t('requests.col.kind'), render: (r) => t(`requests.kind.${r.kind}`) },
    { key: 'what', header: t('requests.col.what'), render: (r) => <What r={r} /> },
    { key: 'status', header: t('requests.col.status'), render: (r) => <ReqStatus status={r.status} /> },
    { key: 'note', header: t('requests.col.note'), render: (r) => r.decision_note ?? '' },
    { key: 'decided', header: t('requests.col.decided'), render: (r) => (r.decided_at ? <span className="mono">{formatDate(r.decided_at)}</span> : '') },
  ]

  return (
    <>
      <PageHeader title={t('requests.title')} subtitle={t('requests.subtitle')} />
      <div style={{ display: 'flex' }}>
        <Tabs
          label={t('requests.filter')}
          value={filter}
          onChange={setFilter}
          tabs={[
            { key: 'all', label: t('requests.tabs.all', { n: all.filter((r) => r.status === 'pending').length }) },
            { key: 'leave', label: t('requests.tabs.leave') },
            { key: 'advance', label: t('requests.tabs.advance') },
          ]}
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', gap: 16, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {q.isLoading ? (
            <Card>
              <Skeleton height={80} />
            </Card>
          ) : q.error ? (
            <Card>
              <div className="sf-alert" data-tone="danger" role="alert">
                {t('hrCommon.readFailed')}
              </div>
            </Card>
          ) : pending.length === 0 ? (
            <Card>
              <EmptyState
                title={t('requests.emptyTitle')}
                body={t('requests.emptyBody')}
                action={
                  <Link to="/staff/leave" style={{ fontWeight: 600, fontSize: 13 }}>
                    {t('requests.toStaffApp')}
                  </Link>
                }
              />
            </Card>
          ) : (
            pending.map((r) => {
              const own = r.requested_by === me
              return (
                <Card key={r.id} as="article" title={t('requests.cardTitle', { kind: t(`requests.kind.${r.kind}`), name: r.person_name })} action={<StatusChip status="pending" label={t('status.pending')} />}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <What r={r} />
                    <p style={{ margin: 0 }}>
                      <span className="k">{t('requests.reason')}</span> {r.reason}
                    </p>
                    <p className="k" style={{ margin: 0 }}>
                      {t('requests.sentOn', { date: formatDate(r.created_at) })}
                    </p>
                    {own ? (
                      <p className="k" style={{ margin: 0 }}>
                        <Chip tone="signal" icon="alert">
                          {t('requests.own')}
                        </Chip>
                      </p>
                    ) : null}
                    {canDecide ? (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <Button variant="primary" onClick={() => setDeciding({ r, approve: true })} aria-label={t('requests.approveNamed', { name: r.person_name, kind: t(`requests.kind.${r.kind}`) })}>
                          {t('requests.approve')}
                        </Button>
                        <Button variant="danger" onClick={() => setDeciding({ r, approve: false })} aria-label={t('requests.rejectNamed', { name: r.person_name, kind: t(`requests.kind.${r.kind}`) })}>
                          {t('requests.reject')}
                        </Button>
                      </div>
                    ) : (
                      <p className="k" style={{ margin: 0 }}>
                        {readOnly ? t('hrCommon.readOnly') : t('requests.noRight')}
                      </p>
                    )}
                  </div>
                </Card>
              )
            })
          )}
          <Card pad={false} title={t('requests.historyTitle')}>
            <DataTable caption={t('requests.historyTitle')} columns={columns} rows={decided} rowKey={(r) => r.id} loading={q.isLoading} empty={<p className="k">{t('requests.historyEmpty')}</p>} />
          </Card>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card title={t('requests.whoTitle')}>
            <p style={{ margin: 0, fontSize: 13 }}>{t('requests.whoBody')}</p>
          </Card>
          <Card title={t('requests.afterTitle')}>
            <p style={{ margin: 0, fontSize: 13 }}>{t('requests.afterBody')}</p>
            <p style={{ margin: '8px 0 0', fontSize: 13 }}>
              <Link to="/hr-and-payroll/cash-given-to-staff">{t('requests.toCash')}</Link>
            </p>
          </Card>
        </div>
      </div>
      {deciding ? <DecideDialog r={deciding.r} approve={deciding.approve} onClose={() => setDeciding(null)} /> : null}
    </>
  )
}

function What({ r }: { r: Req }) {
  const { t } = useTranslation()
  if (r.kind === 'advance') {
    return (
      <span>
        {t('requests.advanceOf')} <Amount value={r.amount} rupee />
      </span>
    )
  }
  return <span>{r.from_date && r.to_date ? t('requests.leaveFromTo', { from: formatDate(r.from_date), to: formatDate(r.to_date) }) : '—'}</span>
}

function ReqStatus({ status }: { status: string }) {
  const { t } = useTranslation()
  if (status === 'approved') return <StatusChip status="approved" label={t('status.approved')} />
  if (status === 'refused')
    return (
      <Chip tone="danger" icon="cross">
        {t('requests.refused')}
      </Chip>
    )
  if (status === 'withdrawn') return <Chip tone="neutral">{t('requests.withdrawn')}</Chip>
  return <StatusChip status="pending" label={t('status.pending')} />
}

function DecideDialog({ r, approve, onClose }: { r: Req; approve: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const [note, setNote] = useState('')
  const m = useApiMutation<{ p_request_id: string; p_approve: boolean; p_note: string | null }>('decide_staff_request', [['api', 'staff_requests'], ['api', 'attendance']])
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={approve ? t('requests.approveTitle', { name: r.person_name }) : t('requests.rejectTitle', { name: r.person_name })}
      description={approve ? (r.kind === 'leave' ? t('requests.approveLeaveEffect') : t('requests.approveAdvanceEffect')) : t('requests.rejectEffect')}
      submitLabel={approve ? t('requests.approve') : t('requests.reject')}
      busy={m.isPending}
      error={<HrErrorBox error={m.error as RpcError | null} />}
      onSubmit={() => m.mutate({ p_request_id: r.id, p_approve: approve, p_note: note.trim() || null }, { onSuccess: onClose })}
    >
      <TextAreaField label={t('requests.note')} value={note} onChange={(e) => setNote(e.target.value)} />
    </FormDialog>
  )
}

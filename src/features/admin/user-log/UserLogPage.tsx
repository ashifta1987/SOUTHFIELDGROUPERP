import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiRpc, useApiView, type ViewRow } from '@/data/queries'
import { routeForFile } from '@/app/flows'
import { formatDate, formatTime } from '@/shared/format'
import { Card, Chip, DataTable, EmptyState, PageHeader, SelectField, type Column } from '@/ui'
import { DetailBlock } from './DetailBlock'
import { EVENTS, type Tone } from './events'

type LogRow = ViewRow<'user_log'>
type ErrRow = ViewRow<'error_log'>

interface ListedUser {
  user_id: string
  display_name: string | null
}

const LIMIT = 200

/**
 * User log (`UserLog`): sign-ins, rights changes, special permissions and setting changes from api.user_log,
 * newest first, plus the error references from api.error_log. Append-only on the server; this screen only reads.
 */
export function UserLogPage() {
  const { t } = useTranslation()
  const can = useCan()
  const readsAll = can('logs.view')
  const [event, setEvent] = useState('')
  const [userId, setUserId] = useState('')

  const log = useApiView('user_log', { order: 'at', ascending: false, eq: { event, user_id: userId }, limit: LIMIT })
  const users = useApiRpc<ListedUser[]>('list_users', {}, readsAll && can('users.view'))
  const errors = useApiView('error_log', { order: 'at', ascending: false, limit: 50, enabled: readsAll })

  const rows = rowsOf(log)
  const listed = users.data?.status === 'ready' ? users.data.data : []
  // Without the users list (no right), offer the people who already appear in the loaded rows.
  const userOptions =
    listed.length > 0
      ? listed.map((u) => ({ value: u.user_id, label: u.display_name ?? u.user_id }))
      : Array.from(new Map(rows.filter((r) => r.user_id).map((r) => [r.user_id as string, r.user_name ?? (r.user_id as string)])).entries()).map(
          ([value, label]) => ({ value, label }),
        )

  const columns: Column<LogRow>[] = [
    {
      key: 'at',
      header: t('userLog.col.time'),
      width: 132,
      render: (r) => (
        <span className="mono" style={{ whiteSpace: 'nowrap' }}>
          {formatDate(r.at)} {formatTime(r.at)}
        </span>
      ),
    },
    { key: 'user', header: t('userLog.col.user'), render: (r) => r.user_name ?? <span className="muted">{t('userLog.noUser')}</span> },
    {
      key: 'event',
      header: t('userLog.col.action'),
      render: (r) => {
        const e = EVENTS[r.event] ?? { tone: 'neutral' as Tone, icon: 'info' }
        return (
          <Chip tone={e.tone} icon={e.icon}>
            {t(`userLog.event.${r.event}`, { defaultValue: r.event })}
          </Chip>
        )
      },
    },
    { key: 'detail', header: t('userLog.col.detail'), render: (r) => <DetailBlock detail={r.detail} /> },
    {
      key: 'grant',
      header: t('userLog.col.grant'),
      render: (r) => (r.grant_code ? <span className="mono" style={{ whiteSpace: 'nowrap' }}>{t('userLog.underGrant', { code: r.grant_code })}</span> : <span className="muted">—</span>),
    },
  ]

  const errColumns: Column<ErrRow>[] = [
    { key: 'ref', header: t('userLog.errors.col.ref'), render: (r) => <span className="mono">{r.ref}</span> },
    { key: 'route', header: t('userLog.errors.col.route'), render: (r) => <span className="mono">{r.route ?? '—'}</span> },
    { key: 'rule', header: t('userLog.errors.col.rule'), render: (r) => <span className="mono">{r.rule_code || '—'}</span> },
    { key: 'message', header: t('userLog.errors.col.message'), render: (r) => r.message },
    {
      key: 'at',
      header: t('userLog.errors.col.time'),
      render: (r) => (
        <span className="mono" style={{ whiteSpace: 'nowrap' }}>
          {formatDate(r.at)} {formatTime(r.at)}
        </span>
      ),
    },
  ]

  const eventOptions = Object.keys(EVENTS).map((k) => ({ value: k, label: t(`userLog.event.${k}`) }))

  return (
    <>
      <PageHeader
        title={t('userLog.title')}
        subtitle={
          <>
            {t('userLog.subtitle')} <Link to={routeForFile('TransactionLog')}>{t('userLog.toTransactionLog')}</Link>
          </>
        }
      />
      {!readsAll ? <p className="muted">{t('userLog.ownOnly')}</p> : null}

      <Card>
        <div role="group" aria-label={t('userLog.filters')} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <SelectField label={t('userLog.user')} value={userId} onChange={(e) => setUserId(e.target.value)} placeholder={t('userLog.allUsers')} options={userOptions} />
          <SelectField label={t('userLog.action')} value={event} onChange={(e) => setEvent(e.target.value)} placeholder={t('userLog.allActions')} options={eventOptions} />
        </div>
      </Card>

      <Card pad={false}>
        <div className="sf-card__pad sf-row" style={{ justifyContent: 'space-between', paddingBottom: 6 }}>
          <h2 className="sf-card__title">{t('userLog.entries', { count: rows.length })}</h2>
          <span className="k">{t('userLog.latestNote', { limit: LIMIT })}</span>
        </div>
        <DataTable
          caption={t('userLog.caption')}
          columns={columns}
          rows={rows}
          rowKey={(r) => String(r.id)}
          loading={log.isLoading}
          minWidth={820}
          error={log.isError ? `${t('errors.loadFailed')} ${t('errors.tryAgain')}` : undefined}
          empty={<EmptyState title={t('userLog.emptyTitle')} body={t('userLog.emptyBody')} />}
        />
      </Card>

      {readsAll ? (
        <Card pad={false}>
          <div className="sf-card__pad" style={{ paddingBottom: 6 }}>
            <h2 className="sf-card__title">{t('userLog.errors.title')}</h2>
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
              {t('userLog.errors.subtitle')}
            </p>
          </div>
          <DataTable
            caption={t('userLog.errors.caption')}
            columns={errColumns}
            rows={rowsOf(errors)}
            rowKey={(r) => r.ref}
            loading={errors.isLoading}
            minWidth={720}
            empty={t('userLog.errors.empty')}
          />
        </Card>
      ) : null}
    </>
  )
}

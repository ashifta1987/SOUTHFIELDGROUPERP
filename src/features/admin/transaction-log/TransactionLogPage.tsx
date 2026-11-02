import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { formatDate, formatTime } from '@/shared/format'
import { Button, Card, Chip, DataTable, EmptyState, Icon, PageHeader, SelectField, type Column } from '@/ui'
import { HistoryDiff } from './HistoryDiff'
import { OP_CHIP, OPS, recordName } from './logShared'

type Row = ViewRow<'transaction_log'>
const PAGE = 50

/**
 * Transaction log (`TransactionLog`): api.transaction_log (audit.row_history, written by triggers, append-only),
 * newest first, filtered on the server by record type and action. Opening a line shows every version of that record.
 */
export function TransactionLogPage() {
  const { t } = useTranslation()
  const can = useCan()
  const readsAll = can('logs.view')
  const [table, setTable] = useState('')
  const [op, setOp] = useState('')
  const [open, setOpen] = useState<{ table: string; pk: string } | null>(null)
  const [limit, setLimit] = useState(PAGE)

  const log = useApiView('transaction_log', { order: 'at', ascending: false, eq: { table_name: table, op }, limit, enabled: readsAll })
  // Record types to filter by, from the latest unfiltered lines (served by the same view).
  const recent = useApiView('transaction_log', { order: 'at', ascending: false, limit: 500, enabled: readsAll })
  const tables = Array.from(new Set(rowsOf(recent).map((r) => r.table_name))).sort()
  const rows = rowsOf(log)

  const columns: Column<Row>[] = [
    {
      key: 'at',
      header: t('transactionLog.col.when'),
      width: 132,
      render: (r) => (
        <span className="mono" style={{ whiteSpace: 'nowrap' }}>
          {formatDate(r.at)} {formatTime(r.at)}
        </span>
      ),
    },
    { key: 'who', header: t('transactionLog.col.who'), render: (r) => r.actor_name ?? <span className="muted">{t('transactionLog.system')}</span> },
    {
      key: 'entry',
      header: t('transactionLog.col.entry'),
      render: (r) => (
        <div>
          <div className="mono" style={{ fontWeight: 600 }}>
            {recordName(r)}
          </div>
          <div className="k mono" style={{ fontSize: 12 }}>
            {r.table_name}
          </div>
        </div>
      ),
    },
    {
      key: 'op',
      header: t('transactionLog.col.action'),
      render: (r) => {
        const c = OP_CHIP[r.op]
        return c ? (
          <Chip tone={c.tone} icon={c.icon}>
            {t(`transactionLog.ops.${r.op}`, { defaultValue: r.op })}
          </Chip>
        ) : (
          r.op
        )
      },
    },
    {
      key: 'grant',
      header: t('transactionLog.col.grant'),
      render: (r) =>
        r.grant_code ? (
          <Chip tone="navy" icon="clock">
            {t('transactionLog.underGrant', { code: r.grant_code })}
          </Chip>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      key: 'open',
      header: <span className="sr-only">{t('transactionLog.col.open')}</span>,
      render: (r) => {
        const active = open?.table === r.table_name && open.pk === r.row_pk
        return (
          <Button
            size="sm"
            variant={active ? 'primary' : 'secondary'}
            aria-pressed={active}
            aria-label={t('transactionLog.openFor', { name: recordName(r) })}
            onClick={() => setOpen({ table: r.table_name, pk: r.row_pk })}
          >
            {t('transactionLog.open')}
          </Button>
        )
      },
    },
  ]

  return (
    <>
      <PageHeader title={t('transactionLog.title')} subtitle={t('transactionLog.subtitle')} />

      <Card>
        <div className="sf-row" style={{ alignItems: 'flex-start', gap: 10 }}>
          <Icon name="lock" size={18} style={{ color: 'var(--sf-primary)', flexShrink: 0, marginTop: 2 }} />
          <div>
            <h2 className="sf-card__title" style={{ margin: 0 }}>
              {t('transactionLog.lawTitle')}
            </h2>
            <p style={{ margin: '4px 0 0', fontSize: 13 }}>{t('transactionLog.lawBody')}</p>
          </div>
        </div>
      </Card>

      {!readsAll ? (
        <p className="muted">{t('transactionLog.noRight')}</p>
      ) : (
        <>
          <Card>
            <div role="group" aria-label={t('transactionLog.filters')} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
              <SelectField
                label={t('transactionLog.table')}
                value={table}
                onChange={(e) => {
                  setTable(e.target.value)
                  setLimit(PAGE)
                }}
                placeholder={t('transactionLog.allTables')}
                options={tables.map((x) => ({ value: x, label: x }))}
              />
              <SelectField
                label={t('transactionLog.op')}
                value={op}
                onChange={(e) => {
                  setOp(e.target.value)
                  setLimit(PAGE)
                }}
                placeholder={t('transactionLog.allOps')}
                options={OPS.map((x) => ({ value: x, label: t(`transactionLog.ops.${x}`) }))}
              />
            </div>
          </Card>

          <Card pad={false}>
            <div className="sf-card__pad sf-row" style={{ justifyContent: 'space-between', paddingBottom: 6 }}>
              <h2 className="sf-card__title">{t('transactionLog.count', { count: rows.length })}</h2>
              <span className="k">{t('transactionLog.latestNote', { limit })}</span>
            </div>
            <DataTable
              caption={t('transactionLog.caption')}
              columns={columns}
              rows={rows}
              rowKey={(r) => String(r.id)}
              loading={log.isLoading}
              minWidth={860}
              error={log.isError ? `${t('errors.loadFailed')} ${t('errors.tryAgain')}` : undefined}
              empty={<EmptyState title={t('transactionLog.emptyTitle')} body={t('transactionLog.emptyBody')} />}
            />
            {rows.length >= limit ? (
              <div className="sf-card__pad" style={{ borderTop: '1px solid var(--sf-line)' }}>
                <Button size="sm" busy={log.isFetching} onClick={() => setLimit(limit + PAGE)}>
                  {t('transactionLog.more', { n: PAGE })}
                </Button>
              </div>
            ) : null}
          </Card>

          {open ? <HistoryDiff tableName={open.table} rowPk={open.pk} onClose={() => setOpen(null)} /> : null}
        </>
      )}
    </>
  )
}

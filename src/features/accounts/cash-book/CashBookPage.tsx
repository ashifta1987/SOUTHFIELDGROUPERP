import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { formatDate } from '@/shared/format'
import { Amount, Button, Card, Chip, DataTable, EmptyState, Field, FormDialog, KpiTiles, PageHeader, SelectField, Skeleton, TextAreaField, type Column } from '@/ui'
import { JournalDialog } from './JournalDialog'
import { addDays, CashLimitText, fromPaise, moneyAccountLabel, MoneyErrorBox, sumPaise, useMoneyAccounts, useReadRpc } from './money'
import { QuickEntry } from './QuickEntry'

export interface LedgerRow {
  entry_date: string | null
  doc_no: string | null
  voucher_type: string
  narration: string | null
  dr: number | null
  cr: number | null
  balance: number | null
  voucher_id: string | null
}

/**
 * Cash book (`CashBook`): one cash account, a date range, the running balance from api.account_ledger, a quick
 * cash receipt / payment (api.post_receipt / api.post_payment — the server applies the cash limits), journal and
 * contra entries (api.post_journal) and reversal of a voucher (api.reverse_voucher). Nothing is worked out here
 * except adding up the rows the server returned.
 */
export function CashBookPage() {
  const { t } = useTranslation()
  const can = useCan()
  const { profile } = useAuth()
  const readOnly = profile?.view === 'all-readonly'
  const { list, companyId, choose, isLoading } = useCompanyChoice()
  const cash = useMoneyAccounts(companyId, 'cash')
  const [accountPick, setAccountPick] = useState('')
  const account = cash.list.find((a) => a.id === accountPick) ?? cash.list[0]
  const [from, setFrom] = useState(todayIst())
  const [to, setTo] = useState(todayIst())
  const ledger = useReadRpc<LedgerRow[]>('account_ledger', { p_account_id: account?.id, p_from: from, p_to: to }, Boolean(account))
  const vouchers = useApiView('vouchers', { eq: { company_id: companyId }, order: 'posted_at', ascending: false, limit: 500, enabled: Boolean(companyId) })
  const status = new Map(rowsOf(vouchers).map((v) => [v.id, v]))
  const [journal, setJournal] = useState(false)
  const [reverse, setReverse] = useState<LedgerRow | null>(null)

  const rows = ledger.data ?? []
  const opening = rows.find((r) => r.voucher_type === 'opening')
  const lines = rows.filter((r) => r.voucher_type !== 'opening')
  const received = lines.filter((r) => (r.dr ?? 0) > 0)
  const paid = lines.filter((r) => (r.cr ?? 0) > 0)
  const closing = lines.length ? lines[lines.length - 1]?.balance : opening?.balance

  function shift(days: number) {
    setFrom(addDays(from, days))
    setTo(addDays(to, days))
  }

  const canCash = !readOnly && can('cash_book.create')
  const canJournal = !readOnly && can('accounts.create')
  const canReverse = !readOnly && can('accounts.cancel')

  const columns: Column<LedgerRow>[] = [
    { key: 'date', header: t('cashBook.col.date'), render: (r) => (r.entry_date ? <span className="mono">{formatDate(r.entry_date)}</span> : '') },
    {
      key: 'doc',
      header: t('cashBook.col.entry'),
      render: (r) =>
        r.voucher_type === 'opening' ? (
          <strong>{t('cashBook.opening')}</strong>
        ) : (
          <div>
            <div style={{ fontWeight: 600 }}>{r.narration || '—'}</div>
            <div className="k mono">{r.doc_no}</div>
          </div>
        ),
    },
    {
      key: 'type',
      header: t('cashBook.col.type'),
      render: (r) => (r.voucher_type === 'opening' ? null : <Chip tone="neutral">{t(`cashBook.types.${r.voucher_type}`, { defaultValue: r.voucher_type })}</Chip>),
    },
    { key: 'in', header: t('cashBook.col.received'), align: 'right', render: (r) => (r.dr ? <Amount value={r.dr} /> : null) },
    { key: 'out', header: t('cashBook.col.paid'), align: 'right', render: (r) => (r.cr ? <Amount value={r.cr} /> : null) },
    { key: 'bal', header: t('cashBook.col.balance'), align: 'right', render: (r) => <Amount value={r.balance} /> },
    {
      key: 'state',
      header: t('cashBook.col.state'),
      render: (r) => {
        if (!r.voucher_id) return null
        const v = status.get(r.voucher_id)
        if (!v) return null
        return (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {v.status === 'reversed' ? (
              <Chip tone="neutral">{t('cashBook.reversed')}</Chip>
            ) : (
              <Chip tone="success" icon="check">
                {t('status.posted')}
              </Chip>
            )}
            {v.cash_reason ? (
              <Chip tone="signal" icon="alert">
                {t('cashBook.flagged')}
              </Chip>
            ) : null}
            {canReverse && v.status === 'posted' && v.voucher_type !== 'reversal' && v.source_table !== 'sales.documents' ? (
              <Button size="sm" variant="link" onClick={() => setReverse(r)} aria-label={t('cashBook.reverseNamed', { no: r.doc_no ?? '' })}>
                {t('cashBook.reverse')}
              </Button>
            ) : null}
          </div>
        )
      },
    },
  ]

  return (
    <>
      <PageHeader
        title={t('cashBook.title')}
        subtitle={t('cashBook.subtitle')}
        actions={
          <>
            <Link to="/accounts/cash-book/cash-book-check" className="sf-btn" data-variant="secondary">
              {t('cashBook.toCheck')}
            </Link>
            {canJournal && companyId ? <Button onClick={() => setJournal(true)}>{t('cashBook.journal')}</Button> : null}
          </>
        }
      />
      <CompanyPicker list={list} value={companyId} onChange={choose} />

      {isLoading || cash.isLoading ? (
        <Card>
          <Skeleton height={80} />
        </Card>
      ) : !companyId || cash.list.length === 0 ? (
        <Card>
          <EmptyState
            title={t('cashBook.noCashTitle')}
            body={t('cashBook.noCashBody')}
            action={
              <Link to="/accounts/bank?tab=setup" style={{ fontWeight: 600, fontSize: 13 }}>
                {t('cashBook.toSetup')}
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 260 }}>
              <SelectField label={t('cashBook.cashAccount')} value={account?.id ?? ''} onChange={(e) => setAccountPick(e.target.value)} options={cash.list.map((a) => ({ value: a.id, label: moneyAccountLabel(a) }))} />
            </div>
            <Button onClick={() => shift(-1)} aria-label={t('cashBook.prevDay')}>
              ‹
            </Button>
            <Field type="date" label={t('common.from')} value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            <Field type="date" label={t('common.to')} value={to} min={from} onChange={(e) => setTo(e.target.value)} />
            <Button onClick={() => shift(1)} aria-label={t('cashBook.nextDay')}>
              ›
            </Button>
          </div>

          <KpiTiles
            ariaLabel={t('cashBook.kpis')}
            items={[
              { key: 'open', label: t('cashBook.kpi.opening'), value: ledger.isLoading ? <Skeleton width={90} /> : <Amount value={opening?.balance ?? null} rupee /> },
              { key: 'in', label: t('cashBook.kpi.received', { n: received.length }), value: <Amount value={fromPaise(sumPaise(received, (r) => r.dr))} rupee /> },
              { key: 'out', label: t('cashBook.kpi.paid', { n: paid.length }), value: <Amount value={fromPaise(sumPaise(paid, (r) => r.cr))} rupee /> },
              { key: 'close', label: t('cashBook.kpi.closing'), value: <Amount value={closing ?? null} rupee /> },
            ]}
          />

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 360px', gap: 16, alignItems: 'start' }}>
            <TableCard title={t('cashBook.tableTitle', { account: account ? moneyAccountLabel(account) : '' })}>
              {ledger.error ? (
                <div className="sf-card__pad">
                  <MoneyErrorBox error={ledger.error} />
                </div>
              ) : (
                <DataTable
                  caption={t('cashBook.tableCaption')}
                  columns={columns}
                  rows={rows}
                  rowKey={(r) => String(rows.indexOf(r))}
                  loading={ledger.isLoading}
                  empty={<EmptyState title={t('cashBook.emptyTitle')} body={t('cashBook.emptyBody')} />}
                  footer={
                    lines.length ? (
                      <tr>
                        <td colSpan={3}>
                          <strong>{t('cashBook.totals')}</strong>
                        </td>
                        <td className="r">
                          <Amount value={fromPaise(sumPaise(received, (r) => r.dr))} />
                        </td>
                        <td className="r">
                          <Amount value={fromPaise(sumPaise(paid, (r) => r.cr))} />
                        </td>
                        <td className="r">
                          <Amount value={closing ?? null} />
                        </td>
                        <td />
                      </tr>
                    ) : undefined
                  }
                />
              )}
            </TableCard>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {canCash && account ? (
                <QuickEntry companyId={companyId} account={account} />
              ) : (
                <Card title={t('cashBook.entry.title')}>
                  <p className="k">{readOnly ? t('cashBook.readOnly') : t('cashBook.noRight')}</p>
                </Card>
              )}
              <Card title={t('cashBook.limits.title')} accent="signal">
                <CashLimitText companyId={companyId} />
              </Card>
            </div>
          </div>
        </>
      )}

      {journal && companyId ? <JournalDialog companyId={companyId} date={to} onClose={() => setJournal(false)} /> : null}
      {reverse ? <ReverseDialog row={reverse} onClose={() => setReverse(null)} /> : null}
    </>
  )
}

function ReverseDialog({ row, onClose }: { row: LedgerRow; onClose: () => void }) {
  const { t } = useTranslation()
  const m = useApiMutation<{ p_voucher_id: string; p_reason: string }>('reverse_voucher', [['api', 'account_ledger'], ['api', 'vouchers']])
  const [reason, setReason] = useState('')
  const [err, setErr] = useState<string | undefined>()
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('cashBook.reverseTitle', { no: row.doc_no ?? '' })}
      description={t('cashBook.reverseEffect')}
      submitLabel={t('cashBook.reverse')}
      busy={m.isPending}
      error={<MoneyErrorBox error={m.error as RpcError | null} />}
      onSubmit={() => {
        if (reason.trim().length < 5) return setErr(t('cashBook.reasonShort'))
        setErr(undefined)
        if (row.voucher_id) m.mutate({ p_voucher_id: row.voucher_id, p_reason: reason.trim() }, { onSuccess: onClose })
      }}
    >
      <TextAreaField label={t('common.reason')} value={reason} onChange={(e) => setReason(e.target.value)} error={err} />
    </FormDialog>
  )
}

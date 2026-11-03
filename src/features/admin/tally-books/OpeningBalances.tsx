import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { formatDate } from '@/shared/format'
import { Amount, Button, Chip, ConfirmDialog, DataTable, EmptyState, type Column } from '@/ui'
import { TableCard } from '@/features/admin/import-data/layout'

type Account = ViewRow<'accounts'>
type Bill = ViewRow<'open_bills'>

const LIMIT = 300
const BUCKETS = ['0-30', '31-60', '61-90', '90+', 'unknown'] as const

/** Accounts with their Tally opening balances (api.accounts), amounts as stored by the import. */
export function AccountsCard({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const accounts = useApiView('accounts', { order: 'name', eq: { company_id: companyId }, limit: LIMIT })
  const list = rowsOf(accounts)
  const cols: Column<Account>[] = [
    { key: 'name', header: t('tallyBooks.accounts.name'), render: (a) => <strong style={{ fontWeight: 600 }}>{a.name}</strong> },
    { key: 'group', header: t('tallyBooks.accounts.group'), render: (a) => a.group_name },
    { key: 'opening', header: t('tallyBooks.accounts.opening'), align: 'right', render: (a) => <Amount value={a.opening_balance} /> },
    { key: 'dc', header: t('tallyBooks.accounts.dc'), render: (a) => (a.opening_dc === 'D' ? t('tallyBooks.accounts.dr') : t('tallyBooks.accounts.cr')) },
    { key: 'asOf', header: t('tallyBooks.accounts.asOf'), render: (a) => (a.opening_as_of ? <span className="mono">{formatDate(a.opening_as_of)}</span> : '—') },
    {
      key: 'status',
      header: t('tallyBooks.accounts.status'),
      render: (a) => (
        <Chip tone={a.status === 'active' ? 'success' : a.status === 'to_review' ? 'signal' : 'neutral'} icon={a.status === 'active' ? 'check' : a.status === 'to_review' ? 'alert' : 'info'}>
          {t(`tallyBooks.accountStatus.${a.status}`, { defaultValue: a.status })}
        </Chip>
      ),
    },
  ]
  return (
    <TableCard title={t('tallyBooks.accounts.title')}>
      <DataTable
        caption={t('tallyBooks.accounts.caption')}
        columns={cols}
        rows={list}
        rowKey={(a) => a.id}
        loading={accounts.isLoading}
        minWidth={720}
        error={accounts.error ? t('errors.loadFailed') : undefined}
        empty={<EmptyState title={t('tallyBooks.accounts.empty')} />}
      />
      {list.length >= LIMIT ? (
        <p className="muted sf-card__pad" style={{ margin: 0, fontSize: 13 }}>
          {t('tallyBooks.accounts.more', { count: LIMIT })}
        </p>
      ) : null}
    </TableCard>
  )
}

/**
 * Opening bills with their ageing bucket (api.open_bills — RLS decides which tax classes arrive; only Admin sees
 * unclassified bills). Admin classifies selected bills through api.classify_open_bills.
 */
export function OpenBillsCard({ companyId, isAdmin }: { companyId: string; isAdmin: boolean }) {
  const { t } = useTranslation()
  const bills = useApiView('open_bills', { order: 'bill_date', eq: { company_id: companyId }, limit: LIMIT })
  const classify = useApiMutation<{ p_bill_ids: string[]; p_tax_class: string }>('classify_open_bills', [['api', 'open_bills'], ['api', 'bug_items']])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [confirmWithout, setConfirmWithout] = useState(false)
  const list = rowsOf(bills)

  const byBucket = useMemo(() => {
    const m: Record<string, number> = {}
    for (const b of list) m[b.ageing_bucket ?? 'unknown'] = (m[b.ageing_bucket ?? 'unknown'] ?? 0) + 1
    return m
  }, [list])

  function toggle(id: string) {
    const next = new Set(picked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setPicked(next)
  }
  function run(taxClass: 'taxable' | 'without_gst') {
    classify.mutate(
      { p_bill_ids: [...picked], p_tax_class: taxClass },
      {
        onSuccess: () => {
          setPicked(new Set())
          setConfirmWithout(false)
        },
        onError: () => setConfirmWithout(false),
      },
    )
  }

  const cols: Column<Bill>[] = []
  if (isAdmin) {
    cols.push({
      key: 'select',
      header: <span className="sr-only">{t('tallyBooks.bills.select')}</span>,
      render: (b) => (
        <input type="checkbox" checked={picked.has(b.id)} onChange={() => toggle(b.id)} aria-label={t('tallyBooks.bills.selectBill', { ref: `${b.account_name} ${b.bill_ref}` })} style={{ width: 18, height: 18 }} />
      ),
      width: 40,
    })
  }
  cols.push(
    { key: 'account', header: t('tallyBooks.bills.account'), render: (b) => b.account_name },
    { key: 'ref', header: t('tallyBooks.bills.ref'), render: (b) => <span className="mono">{b.bill_ref}</span> },
    { key: 'date', header: t('tallyBooks.bills.date'), render: (b) => (b.bill_date ? <span className="mono">{formatDate(b.bill_date)}</span> : '—') },
    { key: 'due', header: t('tallyBooks.bills.due'), render: (b) => (b.due_date ? <span className="mono">{formatDate(b.due_date)}</span> : '—') },
    {
      key: 'amount',
      header: t('tallyBooks.bills.amount'),
      align: 'right',
      render: (b) => (
        <span>
          <Amount value={b.amount} /> <span className="muted">{b.dc === 'D' ? t('tallyBooks.accounts.dr') : t('tallyBooks.accounts.cr')}</span>
        </span>
      ),
    },
    { key: 'age', header: t('tallyBooks.bills.age'), render: (b) => bucketLabel(b.ageing_bucket) },
    {
      key: 'tax',
      header: t('tallyBooks.bills.tax'),
      render: (b) => (
        <Chip tone={b.tax_class === 'taxable' ? 'teal' : 'signal'} icon={b.tax_class === 'taxable' ? 'check' : 'alert'}>
          {t(`tallyBooks.taxClass.${b.tax_class}`, { defaultValue: b.tax_class })}
        </Chip>
      ),
    },
  )

  function bucketLabel(b: string | null) {
    return !b || b === 'unknown' ? t('tallyBooks.bills.unknown') : t('tallyBooks.bills.days', { bucket: b })
  }

  return (
    <TableCard title={t('tallyBooks.bills.title')}>
      <div className="sf-card__pad" style={{ paddingBottom: 0, display: 'grid', gap: 8 }}>
        {list.length > 0 ? (
          <div role="list" aria-label={t('tallyBooks.bills.buckets')} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {BUCKETS.filter((k) => byBucket[k]).map((k) => (
              <span role="listitem" key={k}>
                <Chip tone="neutral">{`${bucketLabel(k)} · ${byBucket[k]}`}</Chip>
              </span>
            ))}
          </div>
        ) : null}
        {isAdmin ? (
          <>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {t('tallyBooks.bills.adminNote')}
            </p>
            {picked.size > 0 ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span>{t('tallyBooks.bills.selected', { count: picked.size })}</span>
                <Button size="sm" variant="primary" busy={classify.isPending} onClick={() => run('taxable')}>
                  {t('tallyBooks.bills.markTaxable')}
                </Button>
                <Button size="sm" onClick={() => setConfirmWithout(true)}>
                  {t('tallyBooks.bills.markWithout')}
                </Button>
              </div>
            ) : null}
            <RpcErrorBox error={classify.error} />
          </>
        ) : null}
      </div>
      <DataTable
        caption={t('tallyBooks.bills.caption')}
        columns={cols}
        rows={list}
        rowKey={(b) => b.id}
        loading={bills.isLoading}
        minWidth={820}
        error={bills.error ? t('errors.loadFailed') : undefined}
        empty={<EmptyState title={t('tallyBooks.bills.empty')} />}
        rowTone={(b) => (b.tax_class === 'taxable' ? undefined : 'signal')}
      />
      {list.length >= LIMIT ? (
        <p className="muted sf-card__pad" style={{ margin: 0, fontSize: 13 }}>
          {t('tallyBooks.bills.more', { count: LIMIT })}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirmWithout}
        onOpenChange={setConfirmWithout}
        title={t('tallyBooks.bills.confirmTitle', { count: picked.size })}
        effect={t('tallyBooks.bills.confirmEffect')}
        confirmLabel={t('tallyBooks.bills.markWithout')}
        busy={classify.isPending}
        onConfirm={() => run('without_gst')}
      />
    </TableCard>
  )
}

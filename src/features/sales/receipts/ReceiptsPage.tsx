import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { useCompanyChoice, todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { RuleErrorBox } from '@/features/sales/invoice/RuleErrorBox'
import { Amount, Button, Card, Chip, DataTable, EmptyState, Field, FieldGrid, FormDialog, PageHeader, SelectField, StatusChip, TextAreaField, type Column } from '@/ui'
import { formatDate, formatIndian } from '@/shared/format'

type Voucher = ViewRow<'vouchers'>
type Bill = ViewRow<'receivables'>

const MODES = ['cash', 'bank', 'upi', 'cheque', 'card'] as const
type Mode = (typeof MODES)[number]
const AMT_RE = /^\d+(\.\d{1,2})?$/
const paise = (v: string | number | null | undefined) => Math.round(Number(v ?? 0) * 100)
const rupees = (p: number) => (p / 100).toFixed(2)

/**
 * Receipts (/sales/receipts): record money received from a customer and set it against their open bills
 * (api.receivables — open amounts worked out by Postgres); the rest stays on account. Posting is api.post_receipt,
 * which checks the cash limit per person per day, the period and the allocations. Reversal is api.reverse_voucher.
 */
export function ReceiptsPage() {
  const { t } = useTranslation()
  const can = useCan()
  const { profile } = useAuth()
  const readOnly = profile?.view === 'all-readonly'
  const canCash = can('cash_book.create') && !readOnly
  const canBank = can('receipts_payments.create') && !readOnly
  const canReverse = can('accounts.cancel') && !readOnly
  const choice = useCompanyChoice()
  const companyId = choice.companyId

  return (
    <>
      <PageHeader title={t('receipts.title')} subtitle={t('receipts.subtitle')} />
      <div style={{ marginBottom: 16 }}>
        <CompanyPicker list={choice.list} value={companyId} onChange={choice.choose} panelId="receipts-panel" />
      </div>
      {choice.list.length === 0 && !choice.isLoading ? (
        <Card>
          <EmptyState title={t('receipts.noCompanyTitle')} body={t('receipts.noCompanyBody')} />
        </Card>
      ) : (
        <div id="receipts-panel" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {canCash || canBank ? companyId ? <ReceiptEntry key={companyId} companyId={companyId} canCash={canCash} canBank={canBank} /> : null : <p className="muted">{t('receipts.noRight')}</p>}
          {companyId ? <ReceiptList companyId={companyId} canReverse={canReverse} /> : null}
        </div>
      )}
    </>
  )
}

function ReceiptEntry({ companyId, canCash, canBank }: { companyId: string; canCash: boolean; canBank: boolean }) {
  const { t } = useTranslation()
  const [partyId, setPartyId] = useState('')
  const [search, setSearch] = useState('')
  const [date, setDate] = useState(todayIst())
  const [mode, setMode] = useState<Mode>(canBank ? 'bank' : 'cash')
  const [accountId, setAccountId] = useState('')
  const [amount, setAmount] = useState('')
  const [narration, setNarration] = useState('')
  const [alloc, setAlloc] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [done, setDone] = useState<{ doc_no: string; on_account: number | string } | null>(null)

  const customers = rowsOf(useApiView('customers', { eq: { company_id: companyId }, order: 'name', limit: 1000 }))
  const accountsQ = useApiView('money_accounts', { eq: { company_id: companyId }, order: 'name' })
  const accounts = rowsOf(accountsQ)
  const billsQ = useApiView('receivables', { eq: { company_id: companyId, party_id: partyId }, order: 'bill_date', limit: 500, enabled: Boolean(partyId) })
  const bills = rowsOf(billsQ).filter((b) => paise(b.open_amount) > 0)
  const kindAccounts = accounts.filter((a) => (mode === 'cash' ? a.kind === 'cash' : a.kind === 'bank'))
  const account = kindAccounts.find((a) => a.id === accountId) ?? kindAccounts[0]

  const amountP = AMT_RE.test(amount.trim()) ? paise(amount) : 0
  const allocP = bills.reduce((s, b) => s + (AMT_RE.test((alloc[b.id ?? ''] ?? '').trim()) ? paise(alloc[b.id ?? '']) : 0), 0)
  const remainderP = amountP - allocP

  const post = useApiMutation<{ p: Record<string, unknown> }, { voucher_id: string; doc_no: string; on_account: number | string; warning: string | null }>('post_receipt', [
    ['api', 'vouchers'],
    ['api', 'receivables'],
    ['api', 'sales_documents'],
    ['api', 'msg_outbox'],
  ])

  function autoFill() {
    let left = amountP
    const next: Record<string, string> = {}
    for (const b of [...bills].sort((x, y) => String(x.bill_date ?? '').localeCompare(String(y.bill_date ?? '')))) {
      const take = Math.min(paise(b.open_amount), Math.max(left, 0))
      if (take > 0) next[b.id ?? ''] = rupees(take)
      left -= take
    }
    setAlloc(next)
  }

  function submit() {
    setDone(null)
    const e: Record<string, string> = {}
    if (!partyId) e.party = t('receipts.err.party')
    if (!account) e.account = mode === 'cash' ? t('receipts.err.noCash') : t('receipts.err.noBank')
    if (!AMT_RE.test(amount.trim()) || amountP <= 0) e.amount = t('receipts.err.amount')
    if (Object.entries(alloc).some(([, v]) => v.trim() && !AMT_RE.test(v.trim()))) e.alloc = t('receipts.err.allocFormat')
    else if (remainderP < 0) e.alloc = t('receipts.err.allocOver')
    setErrors(e)
    if (Object.keys(e).length || !account) return
    const allocations = bills
      .filter((b) => AMT_RE.test((alloc[b.id ?? ''] ?? '').trim()) && paise(alloc[b.id ?? '']) > 0)
      .map((b) => ({ kind: b.kind, id: b.id, amount: (alloc[b.id ?? ''] ?? '').trim() }))
    post.mutate(
      { p: { company_id: companyId, party_id: partyId, date, mode, account_id: account.id, amount: amount.trim(), allocations, narration: narration.trim() || null } },
      {
        onSuccess: (res) => {
          setDone({ doc_no: res.doc_no, on_account: res.on_account })
          setAmount('')
          setAlloc({})
          setNarration('')
        },
      },
    )
  }

  function takeByBank() {
    post.reset()
    setMode('bank')
    setAccountId('')
  }

  const modeOptions = MODES.filter((m) => (m === 'cash' ? canCash : canBank)).map((m) => ({ value: m, label: t(`receipts.modes.${m}`) }))
  const custOptions = customers
    .filter((c) => {
      const q = search.trim().toLowerCase()
      return !q || c.id === partyId || c.name.toLowerCase().includes(q) || (c.gstin ?? '').toLowerCase().includes(q)
    })
    .map((c) => ({ value: c.id, label: c.gstin ? `${c.name} · ${c.gstin}` : c.name }))

  const billCols: Column<Bill>[] = [
    { key: 'ref', header: t('receipts.bills.ref'), render: (b) => <span className="mono">{b.bill_ref ?? '—'}</span> },
    { key: 'date', header: t('receipts.bills.date'), render: (b) => <span className="mono">{b.bill_date ? formatDate(b.bill_date) : '—'}</span> },
    { key: 'due', header: t('receipts.bills.due'), render: (b) => (b.due_date ? <span className="mono">{formatDate(b.due_date)}</span> : '—') },
    { key: 'late', header: t('receipts.bills.overdue'), align: 'right', render: (b) => (Number(b.days_overdue) > 0 ? <Chip tone="danger">{t('receipts.bills.days', { count: Number(b.days_overdue) })}</Chip> : <span className="muted">{t('receipts.bills.notDue')}</span>) },
    { key: 'amount', header: t('receipts.bills.amount'), align: 'right', render: (b) => <Amount value={b.amount} /> },
    { key: 'open', header: t('receipts.bills.open'), align: 'right', render: (b) => <Amount value={b.open_amount} /> },
    {
      key: 'alloc',
      header: t('receipts.bills.allocate'),
      align: 'right',
      render: (b) => (
        <input
          className="sf-input mono"
          style={{ height: 34, width: 130, textAlign: 'right' }}
          inputMode="decimal"
          aria-label={t('receipts.bills.allocateAria', { ref: b.bill_ref ?? '' })}
          value={alloc[b.id ?? ''] ?? ''}
          onChange={(e) => setAlloc((a) => ({ ...a, [b.id ?? '']: e.target.value }))}
        />
      ),
    },
  ]

  return (
    <Card title={t('receipts.entry.title')}>
      <FieldGrid cols={3}>
        <Field label={t('receipts.entry.findCustomer')} type="search" value={search} placeholder={t('receipts.entry.findHint')} onChange={(e) => setSearch(e.target.value)} />
        <SelectField
          label={t('receipts.entry.customer')}
          value={partyId}
          error={errors.party}
          placeholder={customers.length ? t('receipts.entry.chooseCustomer') : t('receipts.entry.noCustomers')}
          options={custOptions}
          onChange={(e) => {
            setPartyId(e.target.value)
            setAlloc({})
          }}
        />
        <Field label={t('receipts.entry.date')} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <SelectField
          label={t('receipts.entry.mode')}
          value={mode}
          options={modeOptions}
          onChange={(e) => {
            setMode(e.target.value as Mode)
            setAccountId('')
          }}
        />
        <SelectField
          label={mode === 'cash' ? t('receipts.entry.cashAccount') : t('receipts.entry.bankAccount')}
          value={account?.id ?? ''}
          error={errors.account}
          placeholder={kindAccounts.length ? undefined : accountsQ.isLoading ? t('common.loading') : t('receipts.entry.noAccount')}
          options={kindAccounts.map((a) => ({ value: a.id, label: a.account_masked ? `${a.name} · ${a.account_masked}` : a.name }))}
          onChange={(e) => setAccountId(e.target.value)}
        />
        <Field label={t('receipts.entry.amount')} prefix="₹" inputMode="decimal" className="mono" value={amount} error={errors.amount} onChange={(e) => setAmount(e.target.value)} />
      </FieldGrid>

      <div style={{ marginTop: 16 }}>
        <div className="sf-card__head" style={{ alignItems: 'center', marginBottom: 8 }}>
          <h3 className="sf-card__title" style={{ fontSize: 15 }}>{t('receipts.bills.title')}</h3>
          <Button size="sm" onClick={autoFill} disabled={!partyId || amountP <= 0 || bills.length === 0}>
            {t('receipts.bills.autoFill')}
          </Button>
        </div>
        {partyId ? (
          <DataTable
            caption={t('receipts.bills.title')}
            columns={billCols}
            rows={bills}
            rowKey={(b) => `${b.kind}-${b.id}`}
            loading={billsQ.isLoading}
            minWidth={760}
            empty={<EmptyState title={t('receipts.bills.emptyTitle')} body={t('receipts.bills.emptyBody')} />}
          />
        ) : (
          <p className="muted" style={{ margin: 0 }}>{t('receipts.bills.chooseFirst')}</p>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, marginTop: 10, flexWrap: 'wrap' }} aria-live="polite">
          <span>
            {t('receipts.bills.allocated')} <span className="mono">₹{formatIndian(rupees(allocP))}</span>
          </span>
          <span data-testid="on-account">
            {t('receipts.bills.onAccount')} <span className="mono">{remainderP < 0 ? `−₹${formatIndian(rupees(-remainderP))}` : `₹${formatIndian(rupees(remainderP))}`}</span>
          </span>
        </div>
        {errors.alloc ? (
          <p className="sf-field__msg" style={{ color: 'var(--sf-danger-ink)', justifyContent: 'flex-end' }}>
            {errors.alloc}
          </p>
        ) : null}
      </div>

      <div style={{ marginTop: 12 }}>
        <TextAreaField label={t('receipts.entry.narration')} value={narration} onChange={(e) => setNarration(e.target.value)} />
      </div>

      {mode === 'cash' ? <p className="muted" style={{ fontSize: 12.5 }}>{t('receipts.entry.cashRule')}</p> : null}
      <RuleErrorBox error={post.error} />
      {post.error?.rule === 'cash.receipt_blocked' && canBank ? (
        <div style={{ marginTop: 8 }}>
          <Button onClick={takeByBank}>{t('receipts.entry.takeByBank')}</Button>
        </div>
      ) : null}
      {done ? (
        <p role="status" style={{ color: 'var(--sf-success-ink)' }}>
          {Number(done.on_account) > 0 ? t('receipts.entry.donePart', { no: done.doc_no, rest: formatIndian(done.on_account) }) : t('receipts.entry.done', { no: done.doc_no })}
        </p>
      ) : null}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
        <Button variant="primary" busy={post.isPending} onClick={submit}>
          {t('receipts.entry.post')}
        </Button>
      </div>
    </Card>
  )
}

function ReceiptList({ companyId, canReverse }: { companyId: string; canReverse: boolean }) {
  const { t } = useTranslation()
  const q = useApiView('vouchers', { eq: { company_id: companyId, voucher_type: 'receipt' }, order: 'posted_at', ascending: false, limit: 100 })
  const rows = rowsOf(q)
  const [target, setTarget] = useState<Voucher | null>(null)
  const [reason, setReason] = useState('')
  const [reasonErr, setReasonErr] = useState<string | undefined>()
  const reverse = useApiMutation<{ p_voucher_id: string; p_reason: string }>('reverse_voucher', [
    ['api', 'vouchers'],
    ['api', 'receivables'],
    ['api', 'sales_documents'],
  ])

  function submit() {
    if (!target) return
    if (reason.trim().length < 5) {
      setReasonErr(t('receipts.err.reason'))
      return
    }
    setReasonErr(undefined)
    reverse.mutate({ p_voucher_id: target.id, p_reason: reason.trim() }, { onSuccess: () => setTarget(null) })
  }

  const columns: Column<Voucher>[] = [
    { key: 'date', header: t('receipts.list.date'), render: (v) => <span className="mono">{formatDate(v.voucher_date)}</span> },
    { key: 'no', header: t('receipts.list.no'), render: (v) => <span className="mono">{v.doc_no}</span> },
    { key: 'party', header: t('receipts.list.customer'), render: (v) => v.party_name ?? '—' },
    { key: 'mode', header: t('receipts.list.mode'), render: (v) => (v.mode ? t(`receipts.modes.${v.mode}`, { defaultValue: v.mode }) : '—') },
    { key: 'amount', header: t('receipts.list.amount'), align: 'right', render: (v) => <Amount value={v.amount} /> },
    { key: 'by', header: t('receipts.list.by'), render: (v) => v.posted_by_name ?? '—' },
    { key: 'status', header: t('common.status'), render: (v) => (v.status === 'reversed' ? <Chip tone="neutral" icon="ban">{t('receipts.list.reversed')}</Chip> : <StatusChip status="posted" />) },
    {
      key: 'act',
      header: <span className="sr-only">{t('receipts.list.actions')}</span>,
      render: (v) =>
        canReverse && v.status === 'posted' ? (
          <Button
            size="sm"
            variant="link"
            aria-label={t('receipts.list.reverseAria', { no: v.doc_no })}
            onClick={() => {
              reverse.reset()
              setReason('')
              setReasonErr(undefined)
              setTarget(v)
            }}
          >
            {t('receipts.list.reverse')}
          </Button>
        ) : null,
    },
  ]

  return (
    <>
      <TableCard title={t('receipts.list.title')}>
        <DataTable
          caption={t('receipts.list.title')}
          columns={columns}
          rows={rows}
          rowKey={(v) => v.id}
          loading={q.isLoading}
          minWidth={820}
          empty={<EmptyState title={t('receipts.list.emptyTitle')} body={t('receipts.list.emptyBody')} />}
        />
      </TableCard>
      <FormDialog
        open={Boolean(target)}
        onOpenChange={(o) => !o && setTarget(null)}
        title={t('receipts.reverseDlg.title', { no: target?.doc_no ?? '' })}
        description={t('receipts.reverseDlg.effect', { amount: target ? formatIndian(target.amount) : '' })}
        submitLabel={t('receipts.list.reverse')}
        busy={reverse.isPending}
        onSubmit={submit}
        error={<RuleErrorBox error={reverse.error} />}
      >
        <TextAreaField label={t('common.reason')} value={reason} error={reasonErr} onChange={(e) => setReason(e.target.value)} />
      </FormDialog>
    </>
  )
}

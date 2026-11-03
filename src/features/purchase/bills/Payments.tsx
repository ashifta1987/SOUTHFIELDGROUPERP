import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { CashLimitText, cleanAmount, fromPaise, moneyAccountLabel, MoneyErrorBox, toPaise, useMoneyAccounts } from '@/features/accounts/cash-book/money'
import { formatDate, formatIndian } from '@/shared/format'
import { Amount, Button, Card, Chip, DataTable, EmptyState, Field, FieldGrid, FormDialog, SelectField, StatusChip, TextAreaField, type Column } from '@/ui'

type Payable = ViewRow<'payables'>
type Voucher = ViewRow<'vouchers'>
const MODES = ['bank', 'upi', 'cheque', 'card', 'cash'] as const
type Mode = (typeof MODES)[number]
const REFRESH = [['api', 'vouchers'], ['api', 'payables'], ['api', 'purchase_bills'], ['api', 'account_ledger']]

/** Open bills of the company (all suppliers or one), oldest due first. */
export function usePayables(companyId: string, partyId?: string) {
  const q = useApiView('payables', { eq: { company_id: companyId, party_id: partyId }, order: 'due_date', limit: 1000, enabled: partyId === undefined || Boolean(partyId) })
  return { ...q, list: rowsOf(q).filter((b) => toPaise(b.open_amount) > 0) }
}

/**
 * Payment to a supplier set against their open bills (api.post_payment). Cash over the daily limit to one person is
 * refused by the server until a reason is given (it then posts and Admin sees it) — the screen offers paying by bank
 * first, as the law intends.
 */
export function PaymentEntry({ companyId, canCash, canBank, partyId, setPartyId }: { companyId: string; canCash: boolean; canBank: boolean; partyId: string; setPartyId: (id: string) => void }) {
  const { t } = useTranslation()
  const suppliers = rowsOf(useApiView('suppliers', { eq: { company_id: companyId }, order: 'name', limit: 1000 }))
  const money = useMoneyAccounts(companyId)
  const [date, setDate] = useState(todayIst())
  const [mode, setMode] = useState<Mode>(canBank ? 'bank' : 'cash')
  const [accountId, setAccountId] = useState('')
  const [amount, setAmount] = useState('')
  const [narration, setNarration] = useState('')
  const [reason, setReason] = useState('')
  const [needReason, setNeedReason] = useState(false)
  const [alloc, setAlloc] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [done, setDone] = useState<{ doc_no: string; warning: string | null } | null>(null)
  const bills = usePayables(companyId, partyId)
  const kindAccounts = money.list.filter((a) => (mode === 'cash' ? a.kind === 'cash' : a.kind === 'bank'))
  const account = kindAccounts.find((a) => a.id === accountId) ?? kindAccounts[0]
  const post = useApiMutation<{ p: Record<string, unknown> }, { voucher_id: string; doc_no: string; warning: string | null; on_account: number | string }>('post_payment', REFRESH)

  const amt = cleanAmount(amount)
  const amountP = amt ? toPaise(amt) : 0
  const allocP = bills.list.reduce((s, b) => s + toPaise(cleanAmount(alloc[b.id ?? ''] ?? '') ?? 0), 0)

  function switchMode(m: Mode) {
    setMode(m)
    setAccountId('')
    setNeedReason(false)
    setReason('')
    post.reset()
  }

  function fillOldest() {
    let left = amountP
    const next: Record<string, string> = {}
    for (const b of bills.list) {
      const take = Math.min(toPaise(b.open_amount), Math.max(left, 0))
      if (take > 0) next[b.id ?? ''] = fromPaise(take)
      left -= take
    }
    setAlloc(next)
  }

  function submit() {
    setDone(null)
    const e: Record<string, string> = {}
    if (!partyId) e.party = t('bills.pay.err.party')
    if (!account) e.account = mode === 'cash' ? t('bills.pay.err.noCash') : t('bills.pay.err.noBank')
    if (!amt || amountP <= 0) e.amount = t('bills.pay.err.amount')
    if (Object.values(alloc).some((v) => v.trim() && cleanAmount(v) === null)) e.alloc = t('bills.pay.err.allocFormat')
    else if (allocP > amountP) e.alloc = t('bills.pay.err.allocOver')
    if (needReason && reason.trim().length < 5) e.reason = t('bills.pay.err.reason')
    setErrors(e)
    if (Object.keys(e).length || !account || !amt) return
    const allocations = bills.list
      .filter((b) => toPaise(cleanAmount(alloc[b.id ?? ''] ?? '') ?? 0) > 0)
      .map((b) => ({ kind: b.kind, id: b.id, amount: cleanAmount(alloc[b.id ?? ''] ?? '') }))
    const p: Record<string, unknown> = { company_id: companyId, party_id: partyId, date, mode, account_id: account.id, amount: amt, allocations, narration: narration.trim() || null }
    if (needReason) p.cash_reason = reason.trim()
    post.mutate(
      { p },
      {
        onSuccess: (res) => {
          setDone({ doc_no: res.doc_no, warning: res.warning })
          setAmount('')
          setAlloc({})
          setNarration('')
          setReason('')
          setNeedReason(false)
        },
        onError: (err) => {
          if (err.rule === 'cash.payment_over_limit') setNeedReason(true)
        },
      },
    )
  }

  const billCols: Column<Payable>[] = [
    { key: 'ref', header: t('bills.payables.ref'), render: (b) => <span className="mono">{b.bill_ref ?? '—'}</span> },
    { key: 'date', header: t('bills.payables.date'), render: (b) => (b.bill_date ? <span className="mono">{formatDate(b.bill_date)}</span> : '—') },
    { key: 'due', header: t('bills.payables.due'), render: (b) => (b.due_date ? <span className="mono">{formatDate(b.due_date)}</span> : '—') },
    { key: 'msme', header: t('bills.payables.msme'), render: (b) => (b.msme_due ? <Chip tone="signal">{t('bills.payables.msmeChip')}</Chip> : null) },
    { key: 'open', header: t('bills.payables.open'), align: 'right', render: (b) => <Amount value={b.open_amount} /> },
    {
      key: 'alloc',
      header: t('bills.pay.allocate'),
      align: 'right',
      render: (b) => (
        <input
          className="sf-input mono"
          style={{ height: 34, width: 130, textAlign: 'right' }}
          inputMode="decimal"
          aria-label={t('bills.pay.allocateAria', { ref: b.bill_ref ?? '' })}
          value={alloc[b.id ?? ''] ?? ''}
          onChange={(e) => setAlloc((a) => ({ ...a, [b.id ?? '']: e.target.value }))}
        />
      ),
    },
  ]

  const overLimit = post.error?.rule === 'cash.payment_over_limit' || needReason

  return (
    <Card title={t('bills.pay.title')}>
      <FieldGrid cols={3}>
        <SelectField
          label={t('bills.pay.supplier')}
          value={partyId}
          error={errors.party}
          placeholder={suppliers.length ? t('bills.editor.chooseSupplier') : t('bills.editor.noSuppliers')}
          options={suppliers.map((s) => ({ value: s.id, label: s.gstin ? `${s.name} · ${s.gstin}` : s.name }))}
          onChange={(e) => {
            setPartyId(e.target.value)
            setAlloc({})
          }}
        />
        <Field type="date" label={t('bills.pay.date')} value={date} max={todayIst()} onChange={(e) => setDate(e.target.value)} />
        <SelectField label={t('bills.pay.mode')} value={mode} options={MODES.filter((m) => (m === 'cash' ? canCash : canBank)).map((m) => ({ value: m, label: t(`bills.modes.${m}`) }))} onChange={(e) => switchMode(e.target.value as Mode)} />
        <SelectField
          label={mode === 'cash' ? t('bills.pay.cashAccount') : t('bills.pay.bankAccount')}
          value={account?.id ?? ''}
          error={errors.account}
          placeholder={kindAccounts.length ? undefined : t('bills.pay.noAccount')}
          options={kindAccounts.map((a) => ({ value: a.id, label: moneyAccountLabel(a) }))}
          onChange={(e) => setAccountId(e.target.value)}
        />
        <Field label={t('bills.pay.amount')} prefix="₹" inputMode="decimal" className="mono" value={amount} error={errors.amount} onChange={(e) => setAmount(e.target.value)} />
        <Field label={t('bills.pay.narration')} value={narration} onChange={(e) => setNarration(e.target.value)} />
      </FieldGrid>

      <div style={{ marginTop: 16 }}>
        <div className="sf-card__head" style={{ alignItems: 'center', marginBottom: 8 }}>
          <h3 className="sf-card__title" style={{ fontSize: 15 }}>
            {t('bills.pay.openBills')}
          </h3>
          <Button size="sm" onClick={fillOldest} disabled={!partyId || amountP <= 0 || bills.list.length === 0}>
            {t('bills.pay.fillOldest')}
          </Button>
        </div>
        {partyId ? (
          <DataTable caption={t('bills.pay.openBills')} columns={billCols} rows={bills.list} rowKey={(b) => `${b.kind}-${b.id}`} loading={bills.isLoading} empty={<EmptyState title={t('bills.pay.noOpenTitle')} body={t('bills.pay.noOpenBody')} />} />
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            {t('bills.pay.chooseFirst')}
          </p>
        )}
        <p data-testid="pay-on-account" aria-live="polite" style={{ textAlign: 'right', margin: '8px 0 0' }}>
          {t('bills.pay.allocated')} <span className="mono">₹{formatIndian(fromPaise(allocP))}</span> · {t('bills.pay.onAccount')} <span className="mono">₹{formatIndian(fromPaise(amountP - allocP))}</span>
        </p>
        {errors.alloc ? (
          <p className="sf-field__msg" role="alert" style={{ color: 'var(--sf-danger-ink)', justifyContent: 'flex-end' }}>
            {errors.alloc}
          </p>
        ) : null}
      </div>

      {mode === 'cash' ? (
        <div style={{ marginTop: 12 }}>
          <CashLimitText companyId={companyId} />
        </div>
      ) : null}

      {overLimit && mode === 'cash' ? (
        <div className="sf-alert" data-tone="danger" role="alert" style={{ flexDirection: 'column', gap: 8, marginTop: 12 }}>
          <strong>{t('bills.pay.overLimitTitle')}</strong>
          <span>{t('bills.pay.overLimitBody')}</span>
          {canBank ? (
            <div>
              <Button variant="primary" onClick={() => switchMode('bank')}>
                {t('bills.pay.payByBank')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <MoneyErrorBox error={post.error as RpcError | null} />
      )}
      {needReason && mode === 'cash' ? (
        <div style={{ marginTop: 12 }}>
          <TextAreaField label={t('bills.pay.reason')} value={reason} error={errors.reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      ) : null}
      {done ? (
        <p role="status" style={{ color: 'var(--sf-success-ink)' }}>
          {t('bills.pay.done', { no: done.doc_no })} {done.warning === 'over_limit' ? t('bills.pay.flagged') : ''}
        </p>
      ) : null}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
        <Button variant={needReason ? 'secondary' : 'primary'} busy={post.isPending} onClick={submit}>
          {needReason && mode === 'cash' ? t('bills.pay.payCashAnyway') : t('bills.pay.post')}
        </Button>
      </div>
    </Card>
  )
}

/** Payment vouchers of the company with reversal (api.reverse_voucher). */
export function PaymentList({ companyId, canReverse }: { companyId: string; canReverse: boolean }) {
  const { t } = useTranslation()
  const q = useApiView('vouchers', { eq: { company_id: companyId, voucher_type: 'payment' }, order: 'posted_at', ascending: false, limit: 100 })
  const [target, setTarget] = useState<Voucher | null>(null)
  const [reason, setReason] = useState('')
  const [reasonErr, setReasonErr] = useState<string | undefined>()
  const reverse = useApiMutation<{ p_voucher_id: string; p_reason: string }>('reverse_voucher', REFRESH)

  const columns: Column<Voucher>[] = [
    { key: 'date', header: t('bills.paylist.date'), render: (v) => <span className="mono">{formatDate(v.voucher_date)}</span> },
    { key: 'no', header: t('bills.paylist.no'), render: (v) => <span className="mono">{v.doc_no}</span> },
    { key: 'party', header: t('bills.paylist.supplier'), render: (v) => v.party_name ?? '—' },
    { key: 'mode', header: t('bills.paylist.mode'), render: (v) => (v.mode ? t(`bills.modes.${v.mode}`, { defaultValue: v.mode }) : '—') },
    { key: 'amount', header: t('bills.paylist.amount'), align: 'right', render: (v) => <Amount value={v.amount} /> },
    {
      key: 'status',
      header: t('common.status'),
      render: (v) => (
        <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
          {v.status === 'reversed' ? <Chip tone="neutral">{t('bills.paylist.reversed')}</Chip> : <StatusChip status="posted" />}
          {v.cash_reason ? (
            <Chip tone="signal" icon="alert">
              {t('bills.pay.flaggedChip')}
            </Chip>
          ) : null}
        </span>
      ),
    },
    {
      key: 'act',
      header: <span className="sr-only">{t('bills.paylist.actions')}</span>,
      render: (v) =>
        canReverse && v.status === 'posted' ? (
          <Button
            size="sm"
            variant="link"
            aria-label={t('bills.paylist.reverseAria', { no: v.doc_no })}
            onClick={() => {
              reverse.reset()
              setReason('')
              setReasonErr(undefined)
              setTarget(v)
            }}
          >
            {t('bills.paylist.reverse')}
          </Button>
        ) : null,
    },
  ]

  return (
    <>
      <TableCard title={t('bills.paylist.title')}>
        <DataTable caption={t('bills.paylist.title')} columns={columns} rows={rowsOf(q)} rowKey={(v) => v.id} loading={q.isLoading} empty={<EmptyState title={t('bills.paylist.emptyTitle')} body={t('bills.paylist.emptyBody')} />} />
      </TableCard>
      <FormDialog
        open={Boolean(target)}
        onOpenChange={(o) => !o && setTarget(null)}
        title={t('bills.paylist.reverseTitle', { no: target?.doc_no ?? '' })}
        description={t('bills.paylist.reverseEffect', { amount: target ? formatIndian(target.amount) : '' })}
        submitLabel={t('bills.paylist.reverse')}
        busy={reverse.isPending}
        error={<MoneyErrorBox error={reverse.error as RpcError | null} />}
        onSubmit={() => {
          if (!target) return
          if (reason.trim().length < 5) return setReasonErr(t('bills.pay.err.reason'))
          setReasonErr(undefined)
          reverse.mutate({ p_voucher_id: target.id, p_reason: reason.trim() }, { onSuccess: () => setTarget(null) })
        }}
      >
        <TextAreaField label={t('common.reason')} value={reason} error={reasonErr} onChange={(e) => setReason(e.target.value)} />
      </FormDialog>
    </>
  )
}

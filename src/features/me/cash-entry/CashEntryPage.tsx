import { useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { cleanAmount, moneyAccountLabel, MoneyErrorBox, useCompanyAccounts, useCompanyParties, useMoneyAccounts, useReadRpc } from '@/features/accounts/cash-book/money'
import { formatDate } from '@/shared/format'
import { Amount, Button, EmptyState, Field, Icon, SelectField, Skeleton, Tabs, TextAreaField } from '@/ui'
import type { PhoneOutletContext } from '@/ui/shell/StaffShell'

type Kind = 'payment' | 'receipt' | 'contra'
interface LedgerRow {
  voucher_type: string
  balance: number | string | null
}
interface Posted {
  doc_no: string
  warning?: string | null
}
const REFRESH = [['api', 'account_ledger'], ['api', 'vouchers'], ['api', 'payables'], ['api', 'receivables'], ['api', 'cash_book_summary']]

/**
 * Cash entry on the phone (`CashEntry`): the cash holder records money paid out, received, or paid into the bank,
 * one line at a time. Paid out → api.post_payment (cash, or bank when "Pay by bank"); received → api.post_receipt;
 * into the bank → api.post_journal (contra). The server applies the cash limits: a receipt that takes one person to
 * the daily limit is refused; cash over the payment limit needs a reason Admin sees, and paying by bank is offered.
 */
export function CashEntryPage() {
  const { t } = useTranslation()
  const can = useCan()
  const { profile } = useAuth()
  const ctx = useOutletContext<PhoneOutletContext | undefined>()
  const readOnly = profile?.view === 'all-readonly'
  const { list, companyId, choose, isLoading } = useCompanyChoice()
  const cash = useMoneyAccounts(companyId, 'cash')
  const banks = useMoneyAccounts(companyId, 'bank')
  const [cashPick, setCashPick] = useState('')
  const account = cash.list.find((a) => a.id === cashPick) ?? cash.list[0]
  const today = todayIst()
  const ledger = useReadRpc<LedgerRow[]>('account_ledger', { p_account_id: account?.id, p_from: today, p_to: today }, Boolean(account))
  const rows = ledger.data ?? []
  const balance = rows.length ? rows[rows.length - 1]?.balance : null

  const canCash = !readOnly && can('cash_book.create')
  const canBank = !readOnly && can('receipts_payments.create')
  const canContra = !readOnly && can('accounts.create')

  return (
    <>
      <header className="sf-phone-head">
        <Link to="/staff" className="sf-phone-head__btn" aria-label={t('cashEntry.back')}>
          <span aria-hidden="true" style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>
            <Icon name="chevronRight" size={24} />
          </span>
        </Link>
        <div className="sf-phone-head__text">
          <h1 className="sf-phone-head__name" style={{ margin: 0 }}>
            {t('cashEntry.title')}
          </h1>
          <span className="sf-phone-head__sub">{account ? `${moneyAccountLabel(account)} · ${formatDate(today)}` : formatDate(today)}</span>
        </div>
        {account ? (
          <span className="sf-pill" data-tone="success" data-testid="box-balance" aria-label={t('cashEntry.balanceAria')}>
            {ledger.isLoading ? '…' : <Amount value={balance ?? null} rupee />}
          </span>
        ) : null}
        {ctx?.openHelp ? (
          <button type="button" className="sf-phone-head__btn" aria-label={t('help.open')} onClick={ctx.openHelp}>
            <Icon name="help" size={24} />
          </button>
        ) : null}
      </header>
      <main className="sf-phone-body">
        {isLoading || cash.isLoading ? (
          <Skeleton height={120} />
        ) : !companyId || !account ? (
          <div className="sf-phone-note">
            <EmptyState title={t('cashBook.noCashTitle')} body={t('cashBook.noCashBody')} />
          </div>
        ) : !canCash ? (
          <div className="sf-phone-note">
            <EmptyState title={t('cashEntry.noRightTitle')} body={readOnly ? t('cashBook.readOnly') : t('cashBook.noRight')} />
          </div>
        ) : (
          <>
            {list.length > 1 ? (
              <SelectField label={t('common.company')} value={companyId} onChange={(e) => choose(e.target.value)} options={list.map((c) => ({ value: c.id, label: c.short_name || c.name }))} />
            ) : null}
            {cash.list.length > 1 ? (
              <SelectField label={t('cashBook.cashAccount')} value={account.id} onChange={(e) => setCashPick(e.target.value)} options={cash.list.map((a) => ({ value: a.id, label: a.name }))} />
            ) : null}
            <EntryForm key={`${companyId}-${account.id}`} companyId={companyId} cashAccountId={account.id} banks={banks.list.map((b) => ({ id: b.id, label: moneyAccountLabel(b) }))} canBank={canBank} canContra={canContra} />
          </>
        )}
      </main>
    </>
  )
}

function EntryForm({ companyId, cashAccountId, banks, canBank, canContra }: { companyId: string; cashAccountId: string; banks: { id: string; label: string }[]; canBank: boolean; canContra: boolean }) {
  const { t } = useTranslation()
  const [kind, setKind] = useState<Kind>('payment')
  const [party, setParty] = useState('')
  const [counter, setCounter] = useState('')
  const [bank, setBank] = useState('')
  const [amount, setAmount] = useState('')
  const [narration, setNarration] = useState('')
  const [reason, setReason] = useState('')
  const [needReason, setNeedReason] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [done, setDone] = useState<Posted | null>(null)
  const parties = useCompanyParties(companyId)
  const accounts = useCompanyAccounts(companyId).list.filter((a) => a.id !== cashAccountId && !a.party_id)
  const payment = useApiMutation<{ p: Record<string, unknown> }, Posted>('post_payment', REFRESH)
  const receipt = useApiMutation<{ p: Record<string, unknown> }, Posted>('post_receipt', REFRESH)
  const contra = useApiMutation<{ p: Record<string, unknown> }, Posted>('post_journal', REFRESH)
  const busy = payment.isPending || receipt.isPending || contra.isPending
  const bankId = bank || banks[0]?.id || ''
  const error = (kind === 'payment' ? payment.error : kind === 'receipt' ? receipt.error : contra.error) as RpcError | null
  const overLimit = kind === 'payment' && (needReason || error?.rule === 'cash.payment_over_limit')

  function switchKind(k: Kind) {
    setKind(k)
    setErrors({})
    setNeedReason(false)
    setReason('')
    setDone(null)
    payment.reset()
    receipt.reset()
    contra.reset()
  }

  function check(): string | null {
    const e: Record<string, string> = {}
    const amt = cleanAmount(amount)
    if (!amt || Number(amt) <= 0) e.amount = t('cashBook.entry.errAmount')
    if (kind !== 'contra' && !party && !counter) e.counter = t('cashBook.entry.errCounter')
    if (kind === 'contra' && !bankId) e.bank = t('cashEntry.err.noBank')
    setErrors(e)
    return Object.keys(e).length ? null : amt
  }

  function after(res: Posted) {
    setDone(res)
    setAmount('')
    setNarration('')
    setReason('')
    setNeedReason(false)
  }

  function pay(byBank: boolean) {
    const amt = check()
    if (!amt) return
    if (!byBank && needReason && reason.trim().length < 5) {
      setErrors({ reason: t('cashBook.reasonShort') })
      return
    }
    if (byBank && !bankId) {
      setErrors({ bank: t('cashEntry.err.noBank') })
      return
    }
    setDone(null)
    const p: Record<string, unknown> = {
      company_id: companyId,
      party_id: party || null,
      counter_account_id: party ? null : counter,
      date: todayIst(),
      mode: byBank ? 'bank' : 'cash',
      account_id: byBank ? bankId : cashAccountId,
      amount: amt,
      allocations: [],
      narration: narration.trim() || null,
    }
    if (!byBank && needReason) p.cash_reason = reason.trim()
    payment.mutate({ p }, { onSuccess: after, onError: (err) => err.rule === 'cash.payment_over_limit' && setNeedReason(true) })
  }

  function receive() {
    const amt = check()
    if (!amt) return
    setDone(null)
    receipt.mutate(
      { p: { company_id: companyId, party_id: party || null, counter_account_id: party ? null : counter, date: todayIst(), mode: 'cash', account_id: cashAccountId, amount: amt, allocations: [], narration: narration.trim() || null } },
      { onSuccess: after },
    )
  }

  function intoBank() {
    const amt = check()
    if (!amt) return
    setDone(null)
    contra.mutate(
      {
        p: {
          company_id: companyId,
          date: todayIst(),
          type: 'contra',
          narration: narration.trim() || t('cashEntry.contraNarration'),
          lines: [
            { account_id: bankId, dr: amt, cr: '0.00' },
            { account_id: cashAccountId, dr: '0.00', cr: amt },
          ],
        },
      },
      { onSuccess: after },
    )
  }

  const tabs: { key: Kind; label: string }[] = [
    { key: 'payment', label: t('cashEntry.paidOut') },
    { key: 'receipt', label: t('cashEntry.received') },
    ...(canContra ? [{ key: 'contra' as const, label: t('cashEntry.intoBank') }] : []),
  ]

  return (
    <form
      noValidate
      style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      onSubmit={(e) => {
        e.preventDefault()
        if (kind === 'payment') pay(false)
        else if (kind === 'receipt') receive()
        else intoBank()
      }}
    >
      <Tabs variant="segmented" label={t('cashEntry.kind')} value={kind} onChange={switchKind} tabs={tabs} />

      {kind === 'contra' ? (
        <SelectField label={t('cashEntry.bank')} value={bankId} error={errors.bank} placeholder={banks.length ? undefined : t('cashEntry.err.noBank')} options={banks.map((b) => ({ value: b.id, label: b.label }))} onChange={(e) => setBank(e.target.value)} />
      ) : (
        <>
          <SelectField
            label={kind === 'payment' ? t('cashEntry.to') : t('cashEntry.from')}
            value={party}
            onChange={(e) => setParty(e.target.value)}
            placeholder={t('cashBook.entry.noParty')}
            options={parties.list.map((p) => ({ value: p.id, label: p.name }))}
          />
          {!party ? (
            <SelectField
              label={t('cashEntry.for')}
              value={counter}
              error={errors.counter}
              placeholder={t('cashBook.entry.choose')}
              options={accounts.map((a) => ({ value: a.id, label: a.name }))}
              onChange={(e) => setCounter(e.target.value)}
            />
          ) : null}
        </>
      )}

      <Field label={t('cashEntry.amount')} prefix="₹" inputMode="decimal" className="mono" value={amount} error={errors.amount} onChange={(e) => setAmount(e.target.value)} />
      <Field label={t('cashBook.entry.narration')} value={narration} onChange={(e) => setNarration(e.target.value)} />

      {overLimit ? (
        <div className="sf-alert" data-tone="danger" role="alert" style={{ flexDirection: 'column' }}>
          <strong>{t('cashEntry.overLimitTitle')}</strong>
          <span>{t('cashEntry.overLimitBody')}</span>
        </div>
      ) : (
        <MoneyErrorBox error={error} />
      )}
      {overLimit && kind === 'payment' ? (
        <TextAreaField label={t('cashBook.entry.reason')} value={reason} error={errors.reason} onChange={(e) => setReason(e.target.value)} />
      ) : null}
      {done ? (
        <p role="status" className="sf-alert" data-tone="success" style={{ margin: 0 }}>
          {t('cashEntry.done', { no: done.doc_no })} {done.warning === 'over_limit' ? t('cashBook.flagged') : ''}
        </p>
      ) : null}

      {kind === 'payment' ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: canBank ? '1fr 1fr' : '1fr', gap: 10 }}>
            <Button type="submit" size="touch" variant={overLimit && canBank ? 'secondary' : 'primary'} busy={payment.isPending && payment.variables?.p.mode === 'cash'} disabled={busy}>
              {overLimit ? t('cashEntry.payCashReason') : t('cashEntry.payCash')}
            </Button>
            {canBank ? (
              <Button size="touch" variant={overLimit ? 'primary' : 'secondary'} busy={payment.isPending && payment.variables?.p.mode === 'bank'} disabled={busy} onClick={() => pay(true)}>
                {t('cashEntry.payBank')}
              </Button>
            ) : null}
          </div>
          <p className="k" style={{ margin: 0, textAlign: 'center' }}>
            {t('cashEntry.footnote')}
          </p>
        </>
      ) : (
        <Button type="submit" size="touch" variant="primary" busy={busy}>
          {kind === 'receipt' ? t('cashEntry.postReceipt') : t('cashEntry.postContra')}
        </Button>
      )}
    </form>
  )
}

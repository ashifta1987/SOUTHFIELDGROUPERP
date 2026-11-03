import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { callApi, RpcError } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { useAuth } from '@/auth/AuthProvider'
import { ErrorRef } from '@/ui'
import { formatIndian } from '@/shared/format'

/**
 * Shared helpers for the money screens (Bank, Cash book, Cash book check, Cash flow, Bills & payments, Cash entry).
 * Display-only: every posted amount, tax, limit and balance is decided by the database.
 */

export type MoneyAccount = ViewRow<'money_accounts'>

/** Rule codes these screens explain themselves (RpcErrorBox maps only errors.rules.*). */
const OWN_RULES = [
  'cash.receipt_blocked',
  'cash.payment_over_limit',
  'cash.limits_not_set',
  'money.over_allocated',
  'money.amount',
  'money.account',
  'money.counter',
  'money.type',
  'posting.rule_missing',
  'posting.no_party_group',
  'posting.unbalanced',
  'posting.already_reversed',
  'posting.use_document',
  'posting.locked',
  'period.no_fy',
  'period.closed',
  'entries.backdate',
  'date.future',
  'date.range',
  'bank.no_match',
  'statement.admin_only',
  'gst.no_rate',
  'doc.qty',
  'doc.discount',
  'doc.no_lines',
  'party.missing',
  'help.describe',
]

/** Refusal box: our own rule text where we have it (keeps the server's detail for posting rules), else the shared box. */
export function MoneyErrorBox({ error }: { error: RpcError | null | undefined }) {
  const { t } = useTranslation()
  if (!error) return null
  if (error.rule && OWN_RULES.includes(error.rule)) {
    const msg = t(`cashBook.rules.${error.rule}`)
    const detail = error.rule === 'posting.rule_missing' || error.rule === 'gst.no_rate' ? ` ${error.message}` : ''
    return <ErrorRef message={msg + detail} next={t('errors.nextStep')} refId={error.ref} />
  }
  return <RpcErrorBox error={error} />
}

/** Active cash or bank accounts of a company (bank numbers arrive masked). */
export function useMoneyAccounts(companyId: string | undefined, kind?: 'cash' | 'bank') {
  const q = useApiView('money_accounts', { eq: { company_id: companyId, kind }, order: 'name', enabled: Boolean(companyId) })
  return { ...q, list: rowsOf(q) }
}

export function moneyAccountLabel(a: MoneyAccount): string {
  return a.kind === 'bank' ? [a.name, a.bank_name, a.account_masked].filter(Boolean).join(' · ') : a.name
}

/** Customers and suppliers of a company, merged by party id (for party pickers). */
export function useCompanyParties(companyId: string | undefined, which: 'customers' | 'suppliers' | 'both' = 'both') {
  const cust = useApiView('customers', { eq: { company_id: companyId }, order: 'name', enabled: Boolean(companyId) && which !== 'suppliers' })
  const supp = useApiView('suppliers', { eq: { company_id: companyId }, order: 'name', enabled: Boolean(companyId) && which !== 'customers' })
  const map = new Map<string, { id: string; name: string; kind: 'customer' | 'supplier' }>()
  if (which !== 'suppliers') for (const c of rowsOf(cust)) map.set(c.id, { id: c.id, name: c.name, kind: 'customer' })
  if (which !== 'customers') for (const s of rowsOf(supp)) if (!map.has(s.id)) map.set(s.id, { id: s.id, name: s.name, kind: 'supplier' })
  return { list: [...map.values()].sort((a, b) => a.name.localeCompare(b.name)), isLoading: cust.isLoading || supp.isLoading }
}

/** Active ledger accounts of a company (for counter accounts, posting rules, journal lines). */
export function useCompanyAccounts(companyId: string | undefined) {
  const q = useApiView('accounts', { eq: { company_id: companyId, status: 'active' }, order: 'name', enabled: Boolean(companyId) })
  return { ...q, list: rowsOf(q) }
}

/**
 * Cash limits as set in the settings table (group value, or the company's own when set). Shown only as a hint;
 * the server applies them on every posting.
 */
export function useCashLimits(companyId: string | undefined) {
  const q = useApiView('settings_current', { order: 'key' })
  const rows = rowsOf(q).filter((r) => r.key === 'cash.receipt_block_amount' || r.key === 'cash.payment_warn_amount')
  const pick = (key: string) => {
    const own = rows.find((r) => r.key === key && r.company_id === companyId)
    const group = rows.find((r) => r.key === key && r.company_id === null)
    const v = (own ?? group)?.value
    return v === undefined || v === null ? null : String(v)
  }
  return { receiptBlock: pick('cash.receipt_block_amount'), paymentWarn: pick('cash.payment_warn_amount') }
}

/** A read RPC that keeps the rule code of a refusal (useApiRpc drops the hint). */
export function useReadRpc<T>(fn: string, args: Record<string, unknown>, enabled = true) {
  const { session } = useAuth()
  return useQuery<T, RpcError>({
    queryKey: ['api', fn, JSON.stringify(args)],
    enabled: Boolean(session) && enabled,
    staleTime: 10_000,
    retry: false,
    queryFn: () => callApi<T>(fn, args, { idempotent: false }),
  })
}

/* ── Small display helpers (dates as YYYY-MM-DD for inputs; sums in paise so no float drift) ── */

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, d ?? 1))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

/** 1 April of the financial year a date falls in. */
export function fyStartOf(iso: string): string {
  const [y, m] = iso.split('-').map(Number)
  const start = (m ?? 1) >= 4 ? (y ?? 2000) : (y ?? 2000) - 1
  return `${start}-04-01`
}

export function toPaise(v: number | string | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

export function fromPaise(p: number): string {
  const neg = p < 0
  const a = Math.abs(p)
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`
}

export function sumPaise<T>(rows: T[], pick: (r: T) => number | string | null | undefined): number {
  return rows.reduce((s, r) => s + toPaise(pick(r)), 0)
}

/** Plain amount typed by a user → a clean decimal string with 2 places, or null when it isn't a number. */
export function cleanAmount(input: string): string | null {
  const s = input.replace(/[,\s₹]/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  return fromPaise(toPaise(s))
}

/** The cash-limit rule in words, with the amounts read from Settings. */
export function CashLimitText({ companyId }: { companyId: string | undefined }) {
  const { t } = useTranslation()
  const { receiptBlock, paymentWarn } = useCashLimits(companyId)
  const fmt = (v: string | null) => (v ? formatIndian(v, 0) : t('cashBook.limits.notSet'))
  return (
    <>
      <p style={{ margin: 0, fontSize: 13 }}>{t('cashBook.limits.receipt', { block: fmt(receiptBlock) })}</p>
      <p style={{ margin: '8px 0 0', fontSize: 13 }}>{t('cashBook.limits.payment', { warn: fmt(paymentWarn) })}</p>
      <p className="k" style={{ margin: '8px 0 0' }}>
        {t('cashBook.limits.source')}
      </p>
    </>
  )
}

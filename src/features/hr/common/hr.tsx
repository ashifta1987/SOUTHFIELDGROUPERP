import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { RpcError } from '@/data/rpc'
import { useReadRpc } from '@/features/accounts/cash-book/money'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { api } from '@/shared/supabase'
import { ErrorRef, Field } from '@/ui'

/**
 * Shared helpers for the HR and payroll screens. Display only: attendance, pay, overtime, advances and the books are
 * worked out by the database (api.save_staff, api.mark_attendance, api.prepare_payroll, api.approve_payroll,
 * api.give_staff_cash …). The browser only formats and adds up rows it was given.
 */

/** One row of api.staff_kyc(): the staff list with KYC completeness. Aadhaar, PAN and bank arrive masked. */
export interface StaffKycRow {
  person_id: string
  person_code: string | null
  name: string
  status: string
  designation: string | null
  department_id: string | null
  department_name: string | null
  pay_company_id: string | null
  pay_company_name: string | null
  pay_basis: string | null
  join_date: string | null
  language: string | null
  active: boolean
  has_login: boolean
  phone_masked: string | null
  dob: string | null
  aadhaar_masked: string | null
  pan_masked: string | null
  bank_masked: string | null
  has_profile: boolean
  kyc_done: number
  kyc_needed: number
}

/** The group staff list (RLS / rights decide who is visible). */
export function useStaffList() {
  const q = useReadRpc<StaffKycRow[]>('staff_kyc', {})
  return { ...q, list: q.data ?? [] }
}

/** Active staff paid by one company. */
export function staffOfCompany(list: StaffKycRow[], companyId: string | undefined): StaffKycRow[] {
  return list.filter((s) => s.has_profile && s.active && s.pay_company_id === companyId)
}

export function staffLabel(s: { name: string; person_code: string | null }): string {
  return s.person_code ? `${s.name} · ${s.person_code}` : s.name
}

/** Rows of a view between two values of one column (useApiView only filters by equality). */
export function useViewRange<V extends 'attendance' | 'duties' | 'payroll_runs' | 'cash_given'>(
  view: V,
  col: string,
  from: string,
  to: string,
  eq: Record<string, string | undefined> = {},
  enabled = true,
) {
  const { session } = useAuth()
  return useQuery<ViewRow<V>[], Error>({
    queryKey: ['api', view, 'range', col, from, to, JSON.stringify(eq)],
    enabled: Boolean(session) && enabled,
    staleTime: 10_000,
    queryFn: async () => {
      let q = api().from(view).select('*').gte(col, from).lte(col, to)
      for (const [k, v] of Object.entries(eq)) if (v) q = q.eq(k, v)
      const { data, error } = await q.order(col).limit(5000)
      if (error) throw new Error(error.message)
      return (data ?? []) as unknown as ViewRow<V>[]
    },
  })
}

/* ── Months and days (YYYY-MM-DD strings, IST calendar) ── */

export function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y ?? 2000, m ?? 1, 0)).getUTCDate()
}

export function monthEnd(month: string): string {
  return `${month.slice(0, 7)}-${String(daysInMonth(month)).padStart(2, '0')}`
}

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1 + by, 1))
  return d.toISOString().slice(0, 10)
}

/** "November 2026" */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, 1)))
}

/** Short weekday for a date, e.g. "Mon". */
export function weekday(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Intl.DateTimeFormat('en-IN', { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, d ?? 1)))
}

/** Monday of the week a date falls in. */
export function mondayOf(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, d ?? 1))
  const back = (dt.getUTCDay() + 6) % 7
  dt.setUTCDate(dt.getUTCDate() - back)
  return dt.toISOString().slice(0, 10)
}

/** A month input (YYYY-MM) that reports the first day of the month. */
export function MonthField({ value, onChange, max, label }: { value: string; onChange: (month: string) => void; max?: string; label?: string }) {
  const { t } = useTranslation()
  return (
    <Field
      type="month"
      label={label ?? t('hrCommon.month')}
      value={value.slice(0, 7)}
      max={max?.slice(0, 7)}
      onChange={(e) => {
        if (/^\d{4}-\d{2}$/.test(e.target.value)) onChange(`${e.target.value}-01`)
      }}
    />
  )
}

/** Rule codes the HR screens explain themselves (RpcErrorBox maps only errors.rules.*). */
const OWN_RULES = [
  'staff.name',
  'staff.designation',
  'staff.pay_company',
  'staff.pay_basis',
  'staff.phone',
  'staff.aadhaar',
  'staff.person',
  'staff.date',
  'staff.duty',
  'staff.request',
  'staff.request_paid',
  'staff.request_missing',
  'payroll.month_locked',
  'cash.payment_over_limit',
  'cash.limits_not_set',
  'money.amount',
  'money.account',
  'posting.rule_missing',
  'posting.unbalanced',
  'period.no_fy',
  'period.closed',
  'entries.backdate',
  'date.future',
]

/**
 * Refusal box for HR screens: our own words for HR rule codes; for a self-approval refusal it also shows the
 * database's own message (the rule as the server applied it).
 */
export function HrErrorBox({ error }: { error: RpcError | null | undefined }) {
  const { t } = useTranslation()
  if (!error) return null
  if (error.rule === 'sod.self_approval') {
    return <ErrorRef message={`${t('errors.rules.sod.self_approval')} ${t('hrCommon.serverSays', { message: error.message })}`} next={t('hrCommon.sodNext')} refId={error.ref} />
  }
  if (error.rule && OWN_RULES.includes(error.rule)) {
    const detail = error.rule === 'posting.rule_missing' ? ` ${error.message}` : ''
    return <ErrorRef message={t(`hrCommon.rules.${error.rule}`) + detail} next={t('errors.nextStep')} refId={error.ref} />
  }
  return <RpcErrorBox error={error} />
}

/** Plain read error (views): a short line with the database message. */
export function ReadError({ error }: { error: Error | null | undefined }) {
  const { t } = useTranslation()
  if (!error) return null
  if (error instanceof RpcError) return <HrErrorBox error={error} />
  return (
    <div className="sf-alert" data-tone="danger" role="alert">
      {t('hrCommon.readFailed')}
    </div>
  )
}

export const ATTENDANCE_CODES = ['P', 'A', 'H', 'L', 'WO'] as const
export const LANGUAGES = ['en', 'ml', 'hi', 'bho'] as const

/** A current setting (the company's own value, else the group value), shown as a hint; the server applies it. */
export function useSettingValue(key: string, companyId: string | undefined): string | null {
  const q = useApiView('settings_current', { order: 'key' })
  const rows = rowsOf(q).filter((r) => r.key === key)
  const v = (rows.find((r) => r.company_id === companyId) ?? rows.find((r) => r.company_id === null))?.value
  return v === undefined || v === null ? null : String(v)
}

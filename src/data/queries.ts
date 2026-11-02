import { useQuery } from '@tanstack/react-query'
import { api, ApiError, isNotReady, type ApiResult } from '@/shared/supabase'
import { useAuth } from '@/auth/AuthProvider'

/**
 * Typed reads from the `api` schema. Every figure on screen comes from these — never from code.
 * Until the phase that builds an object, PostgREST reports it missing and the hook returns `not-ready`,
 * which screens render as a designed empty state ("arrives in Phase N").
 */

async function readView<T>(view: string, build?: (q: ReturnType<ReturnType<typeof api>['from']>) => unknown): Promise<ApiResult<T[]>> {
  const base = api().from(view)
  const q = (build ? build(base) : base.select('*')) as PromiseLike<{ data: T[] | null; error: { code?: string; message: string } | null }>
  const { data, error } = await q
  if (error) {
    if (isNotReady(error)) return { status: 'not-ready' }
    throw new ApiError(error.message, error.code)
  }
  return { status: 'ready', data: data ?? [] }
}

async function callRpc<T>(fn: string, args?: Record<string, unknown>): Promise<ApiResult<T>> {
  const { data, error } = await api().rpc(fn, args ?? {})
  if (error) {
    if (isNotReady(error)) return { status: 'not-ready' }
    throw new ApiError(error.message, error.code)
  }
  return { status: 'ready', data: data as T }
}

const common = { staleTime: 60_000, retry: (n: number, e: unknown) => !(e instanceof ApiError) && n < 2 }

function useSignedIn() {
  const { session } = useAuth()
  return Boolean(session)
}

/* ── Phase 1: group structure (core.companies, core.gstins) via api views ── */
export interface CompanyRow {
  id: string
  name: string
  short_name: string | null
  logo_key: string | null
  gstin_count: number
}

export function useCompanies() {
  const enabled = useSignedIn()
  return useQuery({ queryKey: ['api', 'companies'], queryFn: () => readView<CompanyRow>('companies'), enabled, ...common })
}

/* ── Phase 2: Bug fixer open count (ops.bug_fixer_items) ── */
export function useBugFixerOpenCount() {
  const enabled = useSignedIn()
  return useQuery({ queryKey: ['api', 'bug_fixer_open_count'], queryFn: () => callRpc<number>('bug_fixer_open_count'), enabled, ...common })
}

/* ── Phase 2: customers register (master.parties), server-paged for the user's view ── */
export interface CustomerRow {
  id: string
  company_id: string
  name: string
  how_paid: string | null
  received_fy: string | null
  payments_count: number | null
  last_paid_on: string | null
  status: 'draft' | 'check' | 'active' | 'inactive'
  status_note: string | null
}

export function useCustomers(companyId: string | undefined) {
  const enabled = useSignedIn()
  return useQuery({
    queryKey: ['api', 'customers', companyId ?? 'all'],
    queryFn: () =>
      readView<CustomerRow>('customers', (q) => {
        let s = q.select('*').order('name').limit(100)
        if (companyId) s = s.eq('company_id', companyId)
        return s
      }),
    enabled,
    ...common,
  })
}

/* ── Phase 3: Home dashboard (acct / sales summaries computed in Postgres for the user's view) ── */
export interface HomeKpi {
  key: string
  label: string
  value: string
  sub: string | null
  href: string | null
}
export interface HomeMonth {
  month: string
  with_gst: string
  without_gst: string | null
  total: string
}
export interface HomeTask {
  id: string
  severity: 'high' | 'medium' | 'info'
  title: string
  body: string
  link_label: string
  href: string
}
export interface HomeBill {
  id: string
  bill_date: string
  doc_no: string | null
  party_name: string
  tax_class: 'taxable' | 'withoutGst' | 'exempt' | 'nilRated' | 'nonGst' | 'zeroRated' | 'reverseCharge'
  lawful_reason: string | null
  amount: string
}
export interface HomeSummary {
  kpis: HomeKpi[]
  months: HomeMonth[]
  chart_title: string | null
  tasks: HomeTask[]
  latest_bills: HomeBill[]
  latest_title: string | null
  data_note: string | null
}

export function useHomeSummary() {
  const enabled = useSignedIn()
  return useQuery({ queryKey: ['api', 'home_summary'], queryFn: () => callRpc<HomeSummary>('home_summary'), enabled, ...common })
}

/* ── Phase 3: staff app (hr) ── */
export interface StaffMe {
  person_code: string
  display_name: string
  company_label: string
  pay_month_label: string | null
  net_pay: string | null
  present_days: string | null
  working_days: string | null
  leave_days: string | null
  advance_cut: string | null
  attendance_note: string | null
  requests: { id: string; kind: string; status: string; created_at: string }[]
}

export function useStaffMe() {
  const enabled = useSignedIn()
  return useQuery({ queryKey: ['api', 'staff_me'], queryFn: () => callRpc<StaffMe>('staff_me'), enabled, ...common })
}

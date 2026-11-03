import { useApiRpc, useApiView, rowsOf, type ViewRow } from '@/data/queries'

/**
 * Investor portal data (Phase 7). Every figure comes from the investor RPCs and views, which return only the caller's
 * own partner rows and aggregates (no party names, salaries or bills without GST unless Admin records that policy).
 * The browser formats; it never works out a posted amount.
 */

export interface InvestorPartner {
  partner_id: string
  company_id: string
  company: string | null
  name: string
  legal_partner: boolean
  investment_partner: boolean
  working_partner: boolean
  director: boolean
  shares: number | null
  share_pct: number | string
  language: string | null
}

export interface InvestorMe {
  user_id: string
  display_name: string | null
  portal: boolean
  can_transact: false
  partners: InvestorPartner[]
  open_requests: number
}

export interface GroupCompany {
  partner_id: string
  company_id: string
  company: string | null
  shares: number | null
  share_pct: number | string
  share_capital: number | string
  investment: number | string
  net_worth_book: number | string
  value_of_my_shares: number | string
  profit_share_posted: number | string
  /** Credit balance of the partner's loan account: above 0 the company owes the partner, below 0 the partner owes */
  my_loan_account: number | string | null
  money_in_12m: number | string
  /** Count of posted receipts in 12 months (not distinct buyers) */
  buyers_paying_12m: number
}

export interface GroupSummary {
  as_of: string
  companies: GroupCompany[]
  totals: { share_capital: number | string; investment: number | string; value_of_my_shares: number | string }
}

export type InvestorRequest = ViewRow<'v_investor_requests'>
export type MoneyInRow = ViewRow<'v_investor_money_in'>
export type ProfitShareRow = ViewRow<'v_investor_profit_shares'>
export type InvestorProject = ViewRow<'v_investor_projects'>

export function useInvestorMe() {
  const q = useApiRpc<InvestorMe>('investor_me')
  return { ...q, me: q.data?.status === 'ready' ? q.data.data : null }
}

export function useGroupSummary() {
  const q = useApiRpc<GroupSummary>('investor_group_summary', { p_on: null })
  return { ...q, summary: q.data?.status === 'ready' ? q.data.data : null }
}

export function useMyRequests() {
  const q = useApiView('v_investor_requests', { order: 'created_at', ascending: false, limit: 200 })
  return { ...q, rows: rowsOf(q) }
}

export function useMoneyIn() {
  const q = useApiView('v_investor_money_in', { order: 'month', ascending: true })
  return { ...q, rows: rowsOf(q) }
}

export function useProfitShares() {
  const q = useApiView('v_investor_profit_shares', { order: 'posted_at', ascending: false })
  return { ...q, rows: rowsOf(q) }
}

export function useInvestorProjects() {
  const q = useApiView('v_investor_projects', { order: 'updated_at', ascending: false })
  return { ...q, rows: rowsOf(q) }
}

/** Query keys refreshed after a request is sent or taken back. */
export const REQUEST_KEYS: string[][] = [
  ['api', 'v_investor_requests'],
  ['api', 'investor_me'],
]

/** Month label "Apr 2026" from a YYYY-MM-DD month start (IST calendar month). */
export function monthLabel(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(`${iso.slice(0, 10)}T12:00:00+05:30`)
  return new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(d)
}

/** Current IST month start as YYYY-MM-01. */
export function currentMonthStart(): string {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  return `${s.slice(0, 7)}-01`
}

/** Role flags of a partner row as i18n keys under investor.role.* */
export function roleKeys(p: { legal_partner?: boolean | null; investment_partner?: boolean | null; working_partner?: boolean | null; director?: boolean | null }): string[] {
  const out: string[] = []
  if (p.legal_partner) out.push('legal')
  if (p.investment_partner) out.push('investment')
  if (p.working_partner) out.push('working')
  if (p.director) out.push('director')
  return out
}

import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'

export type CompanyRow = ViewRow<'companies'>

/**
 * The company these set-up screens work on. Kept in the URL (`?company=`) so a reload or a shared link
 * opens the same company. The list comes from api.companies (RLS decides which ones the user sees).
 */
export function useCompanyChoice() {
  const companies = useApiView('companies', { order: 'code' })
  const [params, setParams] = useSearchParams()
  const list = rowsOf(companies)
  const wanted = params.get('company')
  const current = list.find((c) => c.id === wanted) ?? list.find((c) => c.status === 'active') ?? list[0]

  useEffect(() => {
    if (current && wanted !== current.id) {
      const next = new URLSearchParams(params)
      next.set('company', current.id)
      setParams(next, { replace: true })
    }
  }, [current, wanted, params, setParams])

  function choose(id: string) {
    const next = new URLSearchParams(params)
    next.set('company', id)
    setParams(next, { replace: true })
  }

  return {
    list,
    company: current,
    companyId: current?.id,
    choose,
    isLoading: companies.isLoading,
    notReady: companies.data?.status === 'not-ready',
  }
}

/** Today's date in IST as YYYY-MM-DD (for date inputs). */
export function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

/** Start year of the current Indian financial year (April–March, IST). */
export function currentFyStartYear(): number {
  const [y, m] = todayIst().split('-').map(Number)
  return (m ?? 1) >= 4 ? (y ?? 2000) : (y ?? 2000) - 1
}

/** "2026-27" for a start year. */
export function fyLabel(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`
}

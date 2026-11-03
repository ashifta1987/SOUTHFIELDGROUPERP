import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { rowsOf, useApiView } from '@/data/queries'
import { callApi, type RpcError } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { useCompanyChoice } from '@/features/admin/branches/company'
import { Card, EmptyState, ErrorRef, Locked, PageHeader, Skeleton } from '@/ui'
import { PROD_REFRESH, ProductionErrorBox, serverSentence, useProductionRights } from '../biochem-common/biochem'

/**
 * Shared helpers for the Phase 5 Plastics screens (mould projects, mould register, mould costing, injection production,
 * quality, machine assembly, component costing, assembled products, pad printing and the three phone screens). Display
 * only: theoretical output, OEE, stock moves, consumption, costs and every segregation-of-duties rule are decided by the
 * database (api.record_injection_shift … api.record_machine_check); the browser shows what it is given.
 */

/** Rule codes these screens explain themselves (plasticsCommon.rules.*); the server's detail follows. */
const OWN = ['mould.', 'shift.', 'bom.', 'print.', 'check.', 'sod.inspector_maker', 'sod.own_approval', 'prod.components_short', 'qc.qty_mismatch', 'qc.not_inspection_lot', 'qc.not_in_quarantine', 'qc.kind', 'qc.lot_missing', 'scrap.not_scrap_item', 'people.no_access', 'doc.no_lines', 'product.missing']

export function PlasticsErrorBox({ error }: { error: RpcError | null | undefined }) {
  const { t } = useTranslation()
  if (!error) return null
  const rule = error.rule ?? ''
  if (rule && OWN.some((p) => rule.startsWith(p))) {
    const key = `plasticsCommon.rules.${rule}`
    const own = t(key)
    if (own !== key) {
      const detail = serverSentence(error.message)
      const msg = detail && detail.toLowerCase() !== own.toLowerCase() ? `${own} ${t('plasticsCommon.serverSays', { detail })}` : own
      return (
        <div data-rule={rule}>
          <ErrorRef message={msg} next={t('errors.nextStep')} refId={error.ref} />
        </div>
      )
    }
  }
  return <ProductionErrorBox error={error} />
}

/** Query keys to refresh after any Plastics change. */
export const PLASTICS_REFRESH: string[][] = [
  ...PROD_REFRESH,
  ['api', 'mould_projects'],
  ['api', 'moulds'],
  ['api', 'mould_events'],
  ['api', 'mould_costs'],
  ['api', 'injection_shifts'],
  ['api', 'shift_rejects'],
  ['api', 'shift_downtime'],
  ['api', 'quality_inspections'],
  ['api', 'assembly_boms'],
  ['api', 'assembly_bom_lines'],
  ['api', 'assembly_orders'],
  ['api', 'assembly_costs'],
  ['api', 'pad_print_jobs'],
  ['api', 'material_specs'],
  ['api', 'component_costs'],
  ['api', 'machine_checks'],
]

/** The workflow strip of the Plastics screens (reference: "Plastics production · step n"). */
const STEPS: { key: string; route: string | null }[] = [
  { key: 'project', route: '/production/mould-projects' },
  { key: 'register', route: '/production/mould-register' },
  { key: 'mouldCosting', route: '/production/mould-costing' },
  { key: 'machines', route: '/production/machine-assembly' },
  { key: 'moulding', route: '/production/injection-production' },
  { key: 'quality', route: '/production/quality' },
  { key: 'componentCosting', route: '/production/component-costing' },
  { key: 'assembly', route: '/production/assembled-products' },
  { key: 'padPrinting', route: '/production/pad-printing' },
  { key: 'jobWork', route: '/production/job-work' },
  { key: 'maintenance', route: '/production/maintenance' },
]

export function PlasticsSteps({ current }: { current: string }) {
  const { t } = useTranslation()
  const [params] = useSearchParams()
  const company = params.get('company')
  const idx = STEPS.findIndex((s) => s.key === current)
  return (
    <nav aria-label={t('plasticsCommon.flow')} style={{ marginBottom: 16 }}>
      <p className="k" style={{ margin: '0 0 6px' }}>
        <strong style={{ color: 'var(--sf-ink)' }}>{t('plasticsCommon.flow')}</strong> · {t('plasticsCommon.stepOf', { n: idx + 1, total: STEPS.length })}
      </p>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {STEPS.map((s, i) => {
          const here = s.key === current
          const label = (
            <>
              <span className="mono" style={{ marginRight: 4 }}>
                {i + 1}
              </span>
              {t(`plasticsCommon.step.${s.key}`)}
            </>
          )
          return (
            <li key={s.key}>
              {s.route && !here ? (
                <Link to={company ? `${s.route}?company=${company}` : s.route} className="sf-chip" data-tone="outline" style={{ padding: '4px 10px', textDecoration: 'none', display: 'inline-flex', minHeight: 24, alignItems: 'center' }}>
                  {label}
                </Link>
              ) : (
                <span aria-current={here ? 'page' : undefined} className="sf-chip" data-tone={here ? 'teal' : 'outline'} style={{ padding: '4px 10px', fontWeight: here ? 700 : 500, display: 'inline-flex', minHeight: 24, alignItems: 'center' }}>
                  {label}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/** Page frame: title, workflow strip, company picker and the loading / no-company states. */
export function PlasticsFrame({ step, title, subtitle, actions, children }: { step: string; title: ReactNode; subtitle?: ReactNode; actions?: (companyId: string) => ReactNode; children: (companyId: string) => ReactNode }) {
  const { t } = useTranslation()
  const choice = useCompanyChoice()
  const rights = useProductionRights()
  const companyId = choice.companyId
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} actions={companyId && actions ? actions(companyId) : null} />
      <PlasticsSteps current={step} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <span>{rights.readOnly ? <Locked>{t('biochemCommon.readOnly')}</Locked> : !rights.view ? <Locked>{t('plasticsCommon.noView')}</Locked> : null}</span>
        <CompanyPicker list={choice.list} value={companyId} onChange={choice.choose} />
      </div>
      {choice.isLoading ? (
        <Card>
          <Skeleton height={80} />
        </Card>
      ) : !companyId ? (
        <Card>
          <EmptyState title={t('biochemCommon.noCompany')} />
        </Card>
      ) : (
        children(companyId)
      )}
    </>
  )
}

export interface Person {
  user_id: string
  display_name: string | null
  role_keys: string[] | null
}

/** People holding a current role in the company (api.company_people: no phone, email or other personal data). */
export function useCompanyPeople(companyId: string | undefined) {
  const q = useQuery({
    queryKey: ['api', 'company_people', companyId],
    enabled: Boolean(companyId),
    staleTime: 60_000,
    retry: false,
    queryFn: () => callApi<Person[]>('company_people', { p_company_id: companyId }, { idempotent: false }),
  })
  return { list: q.data ?? [], isLoading: q.isLoading, error: q.error }
}

/** Machines of a company of the given kinds (asset register). */
export function useMachines(companyId: string | undefined, kinds: string[] | null) {
  const q = useApiView('assets', { eq: { company_id: companyId }, order: 'code', limit: 1000, enabled: Boolean(companyId) })
  const list = rowsOf(q).filter((a) => a.status !== 'disposed' && (!kinds || kinds.includes(a.kind)))
  return { ...q, list }
}

/** A factor from the server (0–1, four decimals) shown as a percentage; the raw value travels in data-value. */
export function Pct({ value, testId }: { value: number | string | null | undefined; testId?: string }) {
  if (value === null || value === undefined || value === '') {
    return (
      <span className="k" data-testid={testId} data-value="">
        —
      </span>
    )
  }
  const n = Number(value)
  return (
    <span className="sf-amount" data-testid={testId} data-value={String(n)}>
      {(n * 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %
    </span>
  )
}

/** Banner for costing screens when the viewer has no cost right (costs are hidden, never zero). */
export function CostHiddenBanner() {
  const { t } = useTranslation()
  return (
    <Card>
      <span data-testid="cost-hidden">
        <Locked>{t('plasticsCommon.costHiddenBanner')}</Locked>
      </span>
    </Card>
  )
}

/** Detail from a jsonb event column. */
export function detailText(d: unknown): string {
  if (!d || typeof d !== 'object') return ''
  const o = d as Record<string, unknown>
  const parts: string[] = []
  if (o.from && o.to) parts.push(`${String(o.from)} → ${String(o.to)}`)
  if (o.doc_no) parts.push(String(o.doc_no))
  if (o.note) parts.push(String(o.note))
  return parts.join(' · ')
}

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView } from '@/data/queries'
import type { RpcError } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { useCompanyChoice } from '@/features/admin/branches/company'
import { askHelp } from '@/features/help/events'
import { supabase } from '@/shared/supabase'
import { Card, EmptyState, ErrorRef, Locked, PageHeader, Skeleton } from '@/ui'

/**
 * Shared helpers for the Phase 7 operations and accounts screens (job work, maintenance, licences, asset register,
 * directors, partners and profit sharing, partner requests, month-end close). Display only: every quantity, balance,
 * depreciation, Companies Act check, segregation-of-duties rule and period lock is decided by the database (api.* RPCs
 * of 20261103007100 / 7200); the browser shows what it is given and explains refusals.
 */

/** The human sentence of a Postgres error (drops a leading "code: " prefix). */
export function serverSentence(message: string): string {
  const m = message.trim()
  const i = m.indexOf(': ')
  return i > 0 && /^[a-z_.]+$/.test(m.slice(0, i)) ? m.slice(i + 2) : m
}

/**
 * Refusal box for Phase 7 RPCs: our own sentence for the rule (opsCommon.rules.*, then errors.rules.*) followed by what
 * the server said (it names the item, licence, setting or amount). Unknown rules show the server's own sentence.
 */
export function OpsErrorBox({ error }: { error: RpcError | null | undefined }) {
  const { t } = useTranslation()
  if (!error) return null
  const rule = error.rule ?? ''
  const detail = serverSentence(error.message)
  let own: string | null = null
  if (rule) {
    for (const key of [`opsCommon.rules.${rule}`, `errors.rules.${rule}`]) {
      const v = t(key)
      if (v !== key) {
        own = v
        break
      }
    }
  }
  const msg = own ? (detail && detail.toLowerCase() !== own.toLowerCase() ? `${own} ${t('opsCommon.serverSays', { detail })}` : own) : detail || t('errors.saveFailed')
  return (
    <div data-rule={rule || undefined}>
      <ErrorRef message={msg} next={t('errors.nextStep')} refId={error.ref} onAskHelp={() => askHelp({ errorCode: error.ref })} />
    </div>
  )
}

/** What the signed-in person may do on these screens (the server checks again on every call). */
export function useOpsRights() {
  const can = useCan()
  const { profile, session } = useAuth()
  const readOnly = profile?.view === 'all-readonly'
  const admin = !readOnly && profile?.view === 'all'
  return {
    me: session?.user.id ?? null,
    readOnly,
    admin,
    prodView: can('production.view') || can('inventory.view'),
    prodCreate: !readOnly && can('production.create'),
    assetsView: can('assets.view') || can('production.view') || can('accounts.view'),
    assetsManage: !readOnly && can('assets.manage'),
    settings: !readOnly && can('settings.manage'),
    accountsView: can('accounts.view'),
    accountsCreate: !readOnly && can('accounts.create'),
    partnersView: can('partners.view') || can('partners.manage'),
    partnersManage: !readOnly && can('partners.manage'),
    closeManage: !readOnly && can('close.manage'),
    costs: can('cost.view'),
  }
}

/** Query keys refreshed after any Phase 7 change. */
export const OPS_REFRESH: string[][] = [
  ['api', 'process_families'],
  ['api', 'v_job_work_orders'],
  ['api', 'v_job_work_lines'],
  ['api', 'v_job_work_receipts'],
  ['api', 'v_repair_requests'],
  ['api', 'v_spares_issues'],
  ['api', 'v_maintenance_schedules'],
  ['api', 'maintenance_summary'],
  ['api', 'v_licence_register'],
  ['api', 'v_licence_documents'],
  ['api', 'v_licence_renewals'],
  ['api', 'v_licence_reminders'],
  ['api', 'licences'],
  ['api', 'v_asset_register'],
  ['api', 'v_depreciation_runs'],
  ['api', 'v_depreciation_lines'],
  ['api', 'v_asset_disposals'],
  ['api', 'depreciation_readiness'],
  ['api', 'assets'],
  ['api', 'asset_documents'],
  ['api', 'v_partners'],
  ['api', 'v_partner_requests'],
  ['api', 'v_partner_investments'],
  ['api', 'v_partner_projects'],
  ['api', 'v_director_declarations'],
  ['api', 'v_director_loans'],
  ['api', 'v_profit_share_minutes'],
  ['api', 'v_profit_share_runs'],
  ['api', 'v_close_checklists'],
  ['api', 'v_close_tasks'],
  ['api', 'v_period_status'],
  ['api', 'stock_on_hand'],
  ['api', 'item_stock'],
  ['api', 'stock_movements'],
  ['api', 'lots'],
]

/** Page frame for company-scoped screens: title, company picker and the loading / no-company states. */
export function CompanyFrame({ title, subtitle, actions, notice, children }: { title: ReactNode; subtitle?: ReactNode; actions?: (companyId: string) => ReactNode; notice?: ReactNode; children: (companyId: string) => ReactNode }) {
  const { t } = useTranslation()
  const choice = useCompanyChoice()
  const companyId = choice.companyId
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} actions={companyId && actions ? actions(companyId) : null} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <span>{notice ? <Locked>{notice}</Locked> : null}</span>
        <CompanyPicker list={choice.list} value={companyId} onChange={choice.choose} />
      </div>
      {choice.isLoading ? (
        <Card>
          <Skeleton height={80} />
        </Card>
      ) : !companyId ? (
        <Card>
          <EmptyState title={t('opsCommon.noCompany')} />
        </Card>
      ) : (
        children(companyId)
      )}
    </>
  )
}

/** Upload a file to the private `documents` bucket under `<company_id>/<folder>/<uuid>.<ext>`; returns the path. */
export async function uploadDocument(companyId: string, folder: 'licences' | 'assets', file: File): Promise<string> {
  const ext = (file.name.split('.').pop() ?? 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin'
  const path = `${companyId}/${folder}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from('documents').upload(path, file, { upsert: false, contentType: file.type || 'application/octet-stream' })
  if (error) throw new Error(error.message)
  return path
}

/** Open a stored document through a short-lived signed URL (the bucket is private; storage policies decide). */
export async function openDocument(path: string): Promise<void> {
  const { data } = await supabase.storage.from('documents').createSignedUrl(path, 120)
  if (data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener')
}

/** The value of a setting in force for a company (company row first, then the group-wide row). */
export function useSetting(companyId: string | undefined, key: string) {
  const q = useApiView('settings_current', { eq: { key }, limit: 50, enabled: Boolean(companyId) })
  const rows = rowsOf(q)
  const row = rows.find((r) => r.company_id === companyId) ?? rows.find((r) => r.company_id === null)
  return { value: row ? (row.value as unknown) : undefined, isLoading: q.isLoading, set: Boolean(row) }
}

/** "October 2026" for a month start (YYYY-MM-01). */
export function monthName(iso: string): string {
  const [y, m] = iso.split('-').map(Number)
  return new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, 1)))
}

/** Two-column page body: main column and a side column (stacks on narrow screens). */
export function TwoCol({ main, side }: { main: ReactNode; side: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
      <div style={{ flex: '3 1 640px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>{main}</div>
      <aside style={{ flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>{side}</aside>
    </div>
  )
}

/** A short list of explanatory points in a card (rule text from the design, no figures). */
export function NoteCard({ title, items, accent }: { title: ReactNode; items: { head?: ReactNode; body: ReactNode }[]; accent?: boolean }) {
  return (
    <Card title={title} accent={accent ? 'signal' : undefined}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
        {items.map((it, i) => (
          <div key={i} style={{ borderTop: i === 0 ? undefined : '1px solid var(--sf-line-faint)', paddingTop: i === 0 ? 0 : 10 }}>
            {it.head ? <strong style={{ display: 'block', marginBottom: 2 }}>{it.head}</strong> : null}
            <span>{it.body}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

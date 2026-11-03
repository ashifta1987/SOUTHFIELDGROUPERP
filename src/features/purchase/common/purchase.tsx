import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView } from '@/data/queries'
import type { RpcError } from '@/data/rpc'
import { MoneyErrorBox } from '@/features/accounts/cash-book/money'
import { supabase } from '@/shared/supabase'
import { Chip, ErrorRef } from '@/ui'

/**
 * Shared helpers for the Phase 4 purchase screens (requests, orders, goods receipt, bill photos, price changes) and the
 * phone screens that feed them. Display only: every posted amount, tax, stock movement and approval is decided by the
 * database (api.create_purchase_request … api.capture_to_purchase_draft); the browser formats what it is given.
 */

/** Rule codes these screens explain themselves (nested under purchaseCommon.rules in i18n). */
const OWN_PREFIXES = ['purchase.', 'capture.', 'sod.', 'msme.', 'stock.', 'qc.', 'party.', 'product.', 'doc.', 'org.', 'date.', 'period.']

/** Refusal box: our own sentence for purchase rule codes (the server's detail follows), else the money/shared box. */
export function PurchaseErrorBox({ error }: { error: RpcError | null | undefined }) {
  const { t } = useTranslation()
  if (!error) return null
  if (error.rule && OWN_PREFIXES.some((p) => error.rule?.startsWith(p))) {
    const key = `purchaseCommon.rules.${error.rule}`
    const msg = t(key)
    if (msg !== key) {
      const detail = serverSentence(error.message)
      return <ErrorRef message={detail && detail !== msg ? `${msg} ${t('purchaseCommon.serverSays', { detail })}` : msg} next={t('errors.nextStep')} refId={error.ref} />
    }
  }
  return <MoneyErrorBox error={error} />
}

/** The human sentence of a Postgres error (drops a leading "code: " prefix). */
function serverSentence(message: string): string {
  const m = message.trim()
  const i = m.indexOf(': ')
  return i > 0 && /^[a-z_]+$/.test(m.slice(0, i)) ? m.slice(i + 2) : m
}

type Tone = 'neutral' | 'teal' | 'info' | 'signal' | 'success' | 'danger' | 'transit' | 'navy' | 'outline'
const TONES: Record<string, Tone> = {
  draft: 'info',
  submitted: 'signal',
  approved: 'teal',
  refused: 'danger',
  ordered: 'success',
  closed: 'neutral',
  cancelled: 'neutral',
  open: 'info',
  received: 'success',
  selected: 'success',
  rejected: 'neutral',
  issued: 'teal',
  confirmed: 'teal',
  part_received: 'signal',
  posted: 'success',
  uploaded: 'info',
  read: 'info',
  matched: 'success',
  mismatch: 'danger',
  drafted: 'teal',
  quarantine: 'signal',
  available: 'success',
  hold: 'signal',
  queued: 'info',
  skipped: 'neutral',
  sent: 'success',
  failed: 'danger',
}

/** Status of any purchase document as a word (never colour alone). */
export function DocStatus({ status }: { status: string }) {
  const { t } = useTranslation()
  const key = `purchaseCommon.status.${status}`
  const label = t(key)
  return <Chip tone={TONES[status] ?? 'neutral'}>{label === key ? status : label}</Chip>
}

/** What the signed-in user may do on the purchase screens (the server checks again on every call). */
export function usePurchaseRights() {
  const can = useCan()
  const { profile } = useAuth()
  const readOnly = profile?.view === 'all-readonly'
  return {
    readOnly,
    view: can('purchase.view'),
    create: !readOnly && can('purchase.create'),
    edit: !readOnly && can('purchase.edit'),
    approve: !readOnly && can('purchase.approve'),
    cancel: !readOnly && can('purchase.cancel'),
    receive: !readOnly && can('inventory.create'),
    bills: !readOnly && can('purchase_bills.create'),
    billsView: can('purchase_bills.view') || can('purchase.view'),
  }
}

/** Active items usable by a company (products with no company list are group-wide). */
export function useCompanyProducts(companyId: string | undefined) {
  const q = useApiView('products', { order: 'name', limit: 3000, enabled: Boolean(companyId) })
  const list = rowsOf(q).filter((p) => p.status === 'active' && (!p.company_ids || p.company_ids.length === 0 || (companyId ? p.company_ids.includes(companyId) : false)))
  return { ...q, list }
}

export function useCompanySuppliers(companyId: string | undefined) {
  const q = useApiView('suppliers', { eq: { company_id: companyId }, order: 'name', limit: 1000, enabled: Boolean(companyId) })
  return { ...q, list: rowsOf(q) }
}

/** Stock places of a company (stores, quarantine …). */
export function useCompanyPlaces(companyId: string | undefined) {
  const q = useApiView('places', { eq: { company_id: companyId }, order: 'name', enabled: Boolean(companyId) })
  return { ...q, list: rowsOf(q).filter((p) => p.status === 'active') }
}

const QTY_RE = /^\d+(\.\d{1,3})?$/
/** Typed quantity → clean decimal string (up to 3 places), or null. */
export function cleanQty(input: string): string | null {
  const s = input.replace(/[,\s]/g, '')
  if (!QTY_RE.test(s) || Number(s) <= 0) return null
  return s
}

/** Upload a bill photo or PDF to the private `bills` bucket under the company's folder; returns the storage path. */
export async function uploadBillPhoto(companyId: string, file: File): Promise<string> {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase().replace(/[^a-z0-9]/g, '') || (file.type === 'application/pdf' ? 'pdf' : 'jpg')
  const path = `${companyId}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from('bills').upload(path, file, { upsert: false, contentType: file.type || 'application/octet-stream' })
  if (error) throw error
  return path
}

/** A short-lived signed link to a bill photo (the bucket is private; RLS checks the company's purchase rights). */
export async function billPhotoUrl(path: string): Promise<string | null> {
  const { data } = await supabase.storage.from('bills').createSignedUrl(path, 300)
  return data?.signedUrl ?? null
}

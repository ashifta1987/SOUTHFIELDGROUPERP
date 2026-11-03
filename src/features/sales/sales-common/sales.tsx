import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { callApi, useApiMutation, type RpcError } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { useCompanyChoice } from '@/features/admin/branches/company'
import { RuleErrorBox } from '@/features/sales/invoice/RuleErrorBox'
import { Amount, Button, Card, Chip, EmptyState, ErrorRef, Field, FieldGrid, KeyValue, Locked, PageHeader, SelectField, Skeleton } from '@/ui'

/**
 * Shared helpers for the Phase 6 sales desk screens (quotations and orders, credit customers, customer care and agents,
 * shops, own shops, online channels and listings, export orders). Display only: credit exposure, tax, stock, holds,
 * segregation of duties and every refusal are decided by the database (api.confirm_sales_order … api.ingest_online_order);
 * the browser shows what it is given and explains the refusals in plain words.
 */

/** Rule-code prefixes these screens explain themselves (salesCommon.rules.*); the server's own sentence follows. */
const OWN = [
  'order.',
  'credit.',
  'complaint.',
  'coverage.',
  'private_label.',
  'shop.',
  'export.',
  'listing.',
  'online.',
  'query.',
  'promise.',
  'lot.',
  'party.not_linked',
  'party.missing',
  'sod.own_request',
  'stock.lot_on_hold',
  'stock.insufficient',
  'qc.already_on_hold',
  'qc.hold_missing',
  'qc.hold_closed',
  'qc.decision',
  'gst.without_admin_only',
  'rights.reason_required',
  'rights.missing',
  'price.above_mrp',
  'money.account',
  'date.future',
]

/** The human sentence of a Postgres error (drops a leading "code: " prefix). */
export function serverSentence(message: string): string {
  const m = message.trim()
  const i = m.indexOf(': ')
  return i > 0 && /^[a-z_.]+$/.test(m.slice(0, i)) ? m.slice(i + 2) : m
}

/** Refusal box for the sales desk: our sentence for the rule + what the server said. Unknown rules go to the invoice box. */
export function SalesErrorBox({ error }: { error: RpcError | null | undefined }) {
  const { t } = useTranslation()
  if (!error) return null
  const rule = error.rule ?? ''
  if (rule && OWN.some((p) => rule.startsWith(p))) {
    const key = `salesCommon.rules.${rule}`
    const own = t(key)
    if (own !== key) {
      const detail = serverSentence(error.message)
      const msg = detail && detail.toLowerCase() !== own.toLowerCase() ? `${own} ${t('salesCommon.serverSays', { detail })}` : own
      return (
        <div data-rule={rule}>
          <ErrorRef message={msg} next={t('errors.nextStep')} refId={error.ref} />
        </div>
      )
    }
  }
  return (
    <div data-rule={rule || undefined}>
      <RuleErrorBox error={error} />
    </div>
  )
}

/** Query keys to refresh after any sales-desk change. */
export const SALES_REFRESH: string[][] = [
  ['api', 'sales_orders'],
  ['api', 'sales_order_lines'],
  ['api', 'credit_customers'],
  ['api', 'credit_applications'],
  ['api', 'credit_approvals'],
  ['api', 'credit_exceptions'],
  ['api', 'check_credit_exposure'],
  ['api', 'complaints'],
  ['api', 'complaint_events'],
  ['api', 'qc_holds'],
  ['api', 'lots'],
  ['api', 'stock_on_hand'],
  ['api', 'coverage_tiers'],
  ['api', 'coverage_status'],
  ['api', 'contact_attempts'],
  ['api', 'private_label_orders'],
  ['api', 'agents'],
  ['api', 'agent_commissions'],
  ['api', 'queries'],
  ['api', 'shops'],
  ['api', 'shop_days'],
  ['api', 'sales_documents'],
  ['api', 'vouchers'],
  ['api', 'export_orders'],
  ['api', 'containers'],
  ['api', 'export_invoices'],
  ['api', 'online_channels'],
  ['api', 'listings'],
  ['api', 'online_orders'],
  ['api', 'customers'],
]

/** Rights of the signed-in person for the sales desk (the server checks them again on every call). */
export function useSalesRights() {
  const can = useCan()
  const { profile, session } = useAuth()
  const readOnly = profile?.view === 'all-readonly'
  const w = (r: string) => !readOnly && can(r)
  return {
    me: session?.user.id ?? null,
    readOnly,
    /** Admin view: full figures, bills without GST; everyone else sees GST figures only (server decides). */
    fullView: profile?.view === 'all' || profile?.view === 'all-readonly',
    admin: profile?.view === 'all' && !readOnly,
    view: can('sales.view') || can('sales.create') || can('field.manage') || can('credit.approve') || can('credit.recommend') || can('credit.verify'),
    create: w('sales.create'),
    edit: w('sales.edit'),
    approve: w('sales.approve'),
    cancel: w('sales.cancel'),
    creditRequest: w('credit.request'),
    creditEndorse: w('credit.endorse'),
    creditVerify: w('credit.verify'),
    creditRecommend: w('credit.recommend'),
    creditApprove: w('credit.approve'),
    creditMd: w('credit.md_exception'),
    qcTest: w('qc.test'),
    qcRelease: w('qc.release'),
    fieldManage: w('field.manage'),
    shopOperate: w('shop.operate'),
    invoices: w('sales_invoices.create'),
    exportsView: can('exports.view'),
    exportsCreate: w('exports.create'),
    exportsEdit: w('exports.edit'),
    settings: w('settings.manage'),
    accountsCreate: w('accounts.create'),
  }
}

/** Page frame: title, company picker and the loading / no-company states. */
export function SalesFrame({
  title,
  subtitle,
  actions,
  notice,
  children,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: (companyId: string) => ReactNode
  notice?: ReactNode
  children: (companyId: string) => ReactNode
}) {
  const { t } = useTranslation()
  const choice = useCompanyChoice()
  const rights = useSalesRights()
  const companyId = choice.companyId
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} actions={companyId && actions ? actions(companyId) : null} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <span>{rights.readOnly ? <Locked>{t('salesCommon.readOnly')}</Locked> : (notice ?? null)}</span>
        <CompanyPicker list={choice.list} value={companyId} onChange={choice.choose} />
      </div>
      {choice.isLoading ? (
        <Card>
          <Skeleton height={80} />
        </Card>
      ) : !companyId ? (
        <Card>
          <EmptyState title={t('salesCommon.noCompany')} />
        </Card>
      ) : (
        children(companyId)
      )}
    </>
  )
}

type Tone = 'neutral' | 'teal' | 'info' | 'signal' | 'success' | 'danger' | 'transit' | 'navy' | 'outline'
const TONES: Record<string, Tone> = {
  pending_credit: 'danger',
  pending_approval: 'signal',
  confirmed: 'teal',
  part_dispatched: 'transit',
  dispatched: 'transit',
  closed: 'neutral',
  cancelled: 'neutral',
  in_progress: 'signal',
  active: 'success',
  rejected: 'danger',
  none: 'outline',
  hold: 'danger',
  review: 'signal',
  logged: 'info',
  on_hold: 'danger',
  investigating: 'signal',
  resolved: 'success',
  released: 'success',
  submitted: 'signal',
  approved: 'success',
  matches: 'success',
  mismatch: 'danger',
  pending: 'signal',
  shipped: 'transit',
  listed: 'success',
  draft: 'info',
  not_connected: 'outline',
  connected: 'success',
  open: 'signal',
  answered: 'teal',
  verified: 'success',
  review_kyc: 'signal',
  inactive: 'neutral',
  blocked: 'danger',
}

/** Status word with a tone (never colour alone). */
export function SalesStatus({ status }: { status: string | null | undefined }) {
  const { t } = useTranslation()
  const s = status ?? 'none'
  return <Chip tone={TONES[s] ?? 'neutral'}>{t(`salesCommon.status.${s}`, { defaultValue: s.replace(/_/g, ' ') })}</Chip>
}

/** A short line for a successful step (role=status so screen readers hear it). */
export function Done({ children, testId }: { children: ReactNode; testId?: string }) {
  if (!children) return null
  return (
    <div role="status" className="sf-alert" data-tone="success" style={{ margin: 0 }} data-testid={testId}>
      {children}
    </div>
  )
}

/** A warning the server returned as a result (e.g. an order held for credit). */
export function Warn({ children, testId }: { children: ReactNode; testId?: string }) {
  if (!children) return null
  return (
    <div role="alert" className="sf-alert" data-tone="signal" style={{ margin: 0 }} data-testid={testId}>
      {children}
    </div>
  )
}

/** A read that failed: say so, never show an empty list as if nothing existed. */
export function ViewError({ error }: { error: unknown }) {
  const { t } = useTranslation()
  if (!error) return null
  return (
    <div role="alert" className="sf-alert" data-tone="danger" style={{ margin: 0 }}>
      {t('errors.loadFailed')} {t('errors.tryAgain')}
    </div>
  )
}

/** Muted line for a missing right (the server would refuse anyway). */
export function NoRight({ children }: { children: ReactNode }) {
  return (
    <p className="k" style={{ margin: 0 }}>
      <Locked>{children}</Locked>
    </p>
  )
}

/** Customers of a company (api.customers; RLS decides the rows). */
export function useCustomers(companyId: string | undefined) {
  const q = useApiView('customers', { eq: { company_id: companyId }, order: 'name', limit: 2000, enabled: Boolean(companyId) })
  return { ...q, list: rowsOf(q) }
}

/** Active items of a company (api.products; the company list is on the item). */
export function useCompanyProducts(companyId: string | undefined) {
  const q = useApiView('products', { eq: { status: 'active' }, order: 'code', limit: 3000, enabled: Boolean(companyId) })
  const list = rowsOf(q).filter((p) => !p.company_ids || p.company_ids.length === 0 || (companyId ? p.company_ids.includes(companyId) : false))
  return { ...q, list }
}

export type Product = ViewRow<'products'>
export type Customer = ViewRow<'customers'>

/** "code · name" for an item. */
export function productLabel(p: { code: string; name: string }): string {
  return `${p.code} · ${p.name}`
}

/** Strip grouping commas and spaces from a typed number (the server parses and checks it). */
export function num(v: string): string {
  return v.replace(/[,\s₹]/g, '')
}

/** One editable line of an order / sale / export (strings as typed). */
export interface DraftLine {
  key: string
  product_id: string
  qty: string
  rate: string
  discount: string
}

let lineSeq = 0
export function newLine(): DraftLine {
  lineSeq += 1
  return { key: `l${lineSeq}`, product_id: '', qty: '', rate: '', discount: '' }
}

/**
 * Keyboard-friendly line editor: item, quantity, rate (optional where a price list applies) and discount.
 * Enter in the last field adds a line (§UX-7.3). Amounts are not worked out here; the server's panel shows them.
 */
export function LinesEditor({
  lines,
  onChange,
  products,
  rateLabel,
  showDiscount = true,
  rateHelp,
  idBase,
}: {
  lines: DraftLine[]
  onChange: (lines: DraftLine[]) => void
  products: Product[]
  rateLabel?: string
  showDiscount?: boolean
  rateHelp?: string
  idBase: string
}) {
  const { t } = useTranslation()
  const set = (key: string, k: keyof DraftLine, v: string) => onChange(lines.map((l) => (l.key === key ? { ...l, [k]: v } : l)))
  const opts = products.map((p) => ({ value: p.id, label: productLabel(p) }))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {lines.map((l, i) => (
        <div key={l.key} style={{ display: 'grid', gridTemplateColumns: showDiscount ? 'minmax(200px, 3fr) 1fr 1fr 1fr auto' : 'minmax(200px, 3fr) 1fr 1fr auto', gap: 8, alignItems: 'end' }}>
          <SelectField id={`${idBase}-p-${i}`} label={t('salesCommon.line.item', { n: i + 1 })} value={l.product_id} onChange={(e) => set(l.key, 'product_id', e.target.value)} options={opts} placeholder={t('salesCommon.choose')} />
          <Field id={`${idBase}-q-${i}`} label={t('salesCommon.line.qty', { n: i + 1 })} inputMode="decimal" value={l.qty} onChange={(e) => set(l.key, 'qty', e.target.value)} />
          <Field
            id={`${idBase}-r-${i}`}
            label={`${rateLabel ?? t('salesCommon.line.rate')} ${i + 1}`}
            inputMode="decimal"
            value={l.rate}
            onChange={(e) => set(l.key, 'rate', e.target.value)}
            onKeyDown={(e) => {
              if (!showDiscount && e.key === 'Enter' && i === lines.length - 1) {
                e.preventDefault()
                onChange([...lines, newLine()])
              }
            }}
          />
          {showDiscount ? (
            <Field
              id={`${idBase}-d-${i}`}
              label={t('salesCommon.line.discount', { n: i + 1 })}
              inputMode="decimal"
              value={l.discount}
              onChange={(e) => set(l.key, 'discount', e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && i === lines.length - 1) {
                  e.preventDefault()
                  onChange([...lines, newLine()])
                }
              }}
            />
          ) : null}
          <Button size="sm" variant="link" aria-label={t('salesCommon.line.remove', { n: i + 1 })} disabled={lines.length < 2} onClick={() => onChange(lines.filter((x) => x.key !== l.key))}>
            {t('salesCommon.line.removeShort')}
          </Button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button size="sm" onClick={() => onChange([...lines, newLine()])}>
          {t('salesCommon.line.add')}
        </Button>
        <span className="k">{rateHelp ?? t('salesCommon.line.enterHint')}</span>
      </div>
    </div>
  )
}

/** Lines typed → the jsonb the RPCs take (empty rows dropped; numbers as strings for numeric). */
export function linesPayload(lines: DraftLine[], opts: { rateKey?: string; discount?: boolean } = {}): Record<string, string | null>[] {
  const rateKey = opts.rateKey ?? 'rate'
  return lines
    .filter((l) => l.product_id && num(l.qty))
    .map((l) => ({
      product_id: l.product_id,
      qty: num(l.qty),
      [rateKey]: num(l.rate) || null,
      ...(opts.discount === false ? {} : { discount: num(l.discount) || '0' }),
    }))
}

/** Credit exposure as the server returns it (api.check_credit_exposure / sales_orders.credit_check). */
export interface Exposure {
  limit?: number | string | null
  credit_status?: string | null
  terms?: string | null
  receivables?: number | string | null
  open_orders?: number | string | null
  exception?: number | string | null
  exposure?: number | string | null
  available?: number | string | null
  extra?: number | string | null
  blocked?: boolean | null
  hidden_items?: boolean | null
}

/** Live exposure check for a customer (+ an extra amount, e.g. the order being typed). Read RPC, never cached long. */
export function useExposure(companyId: string | undefined, partyId: string | undefined, extra: string | number | null) {
  return useQuery<Exposure, RpcError>({
    queryKey: ['api', 'check_credit_exposure', companyId, partyId, extra ?? 0],
    enabled: Boolean(companyId && partyId),
    retry: false,
    staleTime: 5_000,
    queryFn: () => callApi<Exposure>('check_credit_exposure', { p_company_id: companyId, p_party_id: partyId, p_extra: extra ?? 0 }, { idempotent: false }),
  })
}

/** The exposure card: limit, what is owed, approved orders, live exceptions, available, and the server's decision. */
export function ExposurePanel({ data, testId }: { data: Exposure | null | undefined; testId?: string }) {
  const { t } = useTranslation()
  const rights = useSalesRights()
  if (!data) return null
  const extra = Number(data.extra ?? 0)
  return (
    <div data-testid={testId} data-blocked={data.blocked ? 'true' : 'false'}>
      <KeyValue
        rows={[
          { label: t('salesCommon.exposure.status'), value: <SalesStatus status={data.credit_status} /> },
          { label: t('salesCommon.exposure.limit'), value: <Amount value={data.limit} rupee /> },
          { label: t('salesCommon.exposure.receivables'), value: <Amount value={data.receivables} rupee /> },
          { label: t('salesCommon.exposure.openOrders'), value: <Amount value={data.open_orders} rupee /> },
          { label: t('salesCommon.exposure.exception'), value: <Amount value={data.exception} rupee /> },
          { label: t('salesCommon.exposure.available'), value: <Amount value={data.available} rupee />, total: true },
          ...(extra ? [{ label: t('salesCommon.exposure.extra'), value: <Amount value={data.extra} rupee /> }] : []),
        ]}
      />
      <p style={{ margin: '8px 0 0' }}>
        {data.blocked ? (
          <Chip tone="danger" icon="ban">
            {t('salesCommon.exposure.blocked')}
          </Chip>
        ) : (
          <Chip tone="success" icon="check">
            {t('salesCommon.exposure.fits')}
          </Chip>
        )}
      </p>
      {!rights.fullView ? (
        <p className="k" style={{ margin: '8px 0 0' }}>
          {data.hidden_items ? t('salesCommon.exposure.hiddenItems') : t('salesCommon.exposure.gstOnly')}
        </p>
      ) : null}
      <p className="k" style={{ margin: '8px 0 0' }}>
        {t('salesCommon.exposure.rule')}
      </p>
    </div>
  )
}

/**
 * MD exception (api.grant_md_exception): amount, end time and reason; never by the person who took the order
 * (sod.own_request, checked by the server); logged. For an order it releases the order when it now fits.
 */
export function MdExceptionForm({ companyId, partyId, orderId, onDone }: { companyId: string; partyId: string; orderId?: string; onDone: (msg: string) => void }) {
  const { t } = useTranslation()
  const m = useApiMutation<{ p: Record<string, unknown> }, { id: string; order_status: string | null }>('grant_md_exception', SALES_REFRESH)
  const [f, setF] = useState({ amount: '', until: '', reason: '' })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="md-exception-form">
      <p className="k" style={{ margin: 0 }}>
        {t('salesCommon.md.rule')}
      </p>
      <FieldGrid cols={2}>
        <Field label={t('salesCommon.md.amount')} inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        <Field label={t('salesCommon.md.until')} type="datetime-local" value={f.until} onChange={(e) => setF({ ...f, until: e.target.value })} />
      </FieldGrid>
      <Field label={t('salesCommon.md.reason')} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
      <div>
        <Button
          variant="primary"
          busy={m.isPending}
          onClick={() =>
            m.mutate(
              { p: { company_id: companyId, party_id: partyId, order_id: orderId ?? null, amount: num(f.amount), valid_until: f.until ? new Date(f.until).toISOString() : null, reason: f.reason.trim() } },
              {
                onSuccess: (r) => {
                  setF({ amount: '', until: '', reason: '' })
                  onDone(r.order_status === 'confirmed' ? t('salesCommon.md.grantedReleased') : t('salesCommon.md.granted'))
                },
              },
            )
          }
        >
          {t('salesCommon.md.grant')}
        </Button>
      </div>
      <SalesErrorBox error={m.error} />
    </div>
  )
}

/** Collapsible helper card for rule text from the approved design. */
export function RuleCard({ title, items }: { title: ReactNode; items: { title: ReactNode; body: ReactNode }[] }) {
  return (
    <Card title={title}>
      <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map((it, i) => (
          <li key={i}>
            <strong>{it.title}</strong> {it.body}
          </li>
        ))}
      </ul>
    </Card>
  )
}

/** A reason prompt inline (cancel, reject, hold): typed text + confirm button. */
export function ReasonAction({
  label,
  fieldLabel,
  busy,
  danger,
  onConfirm,
  testId,
}: {
  label: string
  fieldLabel: string
  busy?: boolean
  danger?: boolean
  onConfirm: (reason: string) => void
  testId?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  if (!open) {
    return (
      <Button variant={danger ? 'danger' : 'secondary'} onClick={() => setOpen(true)} data-testid={testId}>
        {label}
      </Button>
    )
  }
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap', width: '100%' }}>
      <div style={{ flex: '1 1 240px' }}>
        <Field label={fieldLabel} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <Button variant={danger ? 'danger' : 'primary'} busy={busy} onClick={() => onConfirm(reason.trim())}>
        {label}
      </Button>
      <Button variant="link" onClick={() => setOpen(false)}>
        {t('common.cancel')}
      </Button>
    </div>
  )
}

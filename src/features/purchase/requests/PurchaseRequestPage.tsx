import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { cleanAmount } from '@/features/accounts/cash-book/money'
import { formatDate } from '@/shared/format'
import { Amount, Button, Card, DataTable, EmptyState, Field, FieldGrid, FormDialog, PageHeader, SelectField, Skeleton, Tabs, TextAreaField, type Column } from '@/ui'
import { cleanQty, DocStatus, PurchaseErrorBox, useCompanyProducts, useCompanySuppliers, usePurchaseRights } from '../common/purchase'

type Tab = 'new' | 'waiting' | 'approved' | 'ordered'
type Req = ViewRow<'purchase_requests'>
interface Line {
  product_id: string
  description: string
  qty: string
  est_rate: string
  suggested_party_id: string
}
interface Draft {
  id: string | null
  department: string
  for_job: string
  needed_by: string
  reason: string
  lines: Line[]
}
const EMPTY_LINE: Line = { product_id: '', description: '', qty: '', est_rate: '', suggested_party_id: '' }
const emptyDraft = (): Draft => ({ id: null, department: '', for_job: '', needed_by: '', reason: '', lines: [{ ...EMPTY_LINE }] })
const REFRESH = [['api', 'purchase_requests'], ['api', 'purchase_request_lines'], ['api', 'buying_logistics_home']]

/**
 * Purchase requests (`PurchaseRequest`): a department asks for items (api.create_purchase_request, draft or sent for
 * approval), another person with purchase approval decides (api.approve_purchase_request — the server refuses the
 * requester), and approved requests go on to supplier quotes on Purchase orders. In stock, on order and last rate come
 * from the database (api.item_stock, api.purchase_request_lines).
 */
export function PurchaseRequestPage() {
  const { t } = useTranslation()
  const rights = usePurchaseRights()
  const [params, setParams] = useSearchParams()
  const tabParam = params.get('tab')
  const tab: Tab = tabParam === 'waiting' || tabParam === 'approved' || tabParam === 'ordered' ? tabParam : 'new'
  const choice = useCompanyChoice()
  const companyId = choice.companyId
  const q = useApiView('purchase_requests', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 500, enabled: Boolean(companyId) })
  const rows = rowsOf(q)
  const count = (s: string) => rows.filter((r) => r.status === s).length

  function setTab(k: Tab) {
    const next = new URLSearchParams(params)
    next.set('tab', k)
    setParams(next, { replace: true })
  }

  return (
    <>
      <PageHeader
        title={t('purchaseRequests.title')}
        subtitle={t('purchaseRequests.subtitle')}
        actions={
          <Tabs
            variant="segmented"
            label={t('purchaseRequests.tabs')}
            value={tab}
            onChange={setTab}
            idBase="pr"
            controls="pr-panel"
            tabs={[
              { key: 'new', label: t('purchaseRequests.tabNew') },
              { key: 'waiting', label: t('purchaseRequests.tabWaiting', { n: count('submitted') }) },
              { key: 'approved', label: t('purchaseRequests.tabApproved', { n: count('approved') }) },
              { key: 'ordered', label: t('purchaseRequests.tabOrdered', { n: count('ordered') }) },
            ]}
          />
        }
      />
      <div style={{ marginBottom: 16 }}>
        <CompanyPicker list={choice.list} value={companyId} onChange={choice.choose} panelId="pr-panel" />
      </div>
      <div id="pr-panel" role="tabpanel" aria-labelledby={`pr-tab-${tab}`} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {choice.isLoading ? (
          <Card>
            <Skeleton height={80} />
          </Card>
        ) : !companyId ? (
          <Card>
            <EmptyState title={t('purchaseRequests.noCompany')} />
          </Card>
        ) : (
          <>
            <DepartmentTiles companyId={companyId} rows={rows} />
            {tab === 'new' ? (
              <NewTab key={companyId} companyId={companyId} rows={rows} canCreate={rights.create} readOnly={rights.readOnly} />
            ) : (
              <ListTab key={`${companyId}-${tab}`} companyId={companyId} tab={tab} all={rows} rows={rows.filter((r) => r.status === (tab === 'waiting' ? 'submitted' : tab))} loading={q.isLoading} />
            )}
          </>
        )}
      </div>
    </>
  )
}

/** Departments of the company (and group-wide ones) with their open requests. */
function useDepartments(companyId: string) {
  const q = useApiView('departments', { order: 'name' })
  return { loading: q.isLoading, list: rowsOf(q).filter((d) => d.status === 'active' && (d.company_id === null || d.company_id === companyId)) }
}

function DepartmentTiles({ companyId, rows }: { companyId: string; rows: Req[] }) {
  const { t } = useTranslation()
  const deps = useDepartments(companyId).list
  if (deps.length === 0) return null
  return (
    <ul aria-label={t('purchaseRequests.departments')} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
      {deps.map((d) => {
        const open = rows.filter((r) => r.department === d.name && ['draft', 'submitted', 'approved'].includes(r.status)).length
        return (
          <li key={d.id} className="sf-card" style={{ padding: '10px 12px', borderTop: '3px solid var(--sf-primary)' }}>
            <div style={{ fontWeight: 600 }}>{d.name}</div>
            <div className="k">{t('purchaseRequests.openCount', { n: open })}</div>
          </li>
        )
      })}
    </ul>
  )
}

function NewTab({ companyId, rows, canCreate, readOnly }: { companyId: string; rows: Req[]; canCreate: boolean; readOnly: boolean }) {
  const { t } = useTranslation()
  const { session } = useAuth()
  const me = session?.user.id
  const [draft, setDraft] = useState<Draft>(emptyDraft())
  const [loading, setLoading] = useState<Req | null>(null)
  const myDrafts = rows.filter((r) => r.status === 'draft' && r.requested_by === me)
  const firstProduct = draft.lines.find((l) => l.product_id)?.product_id ?? ''

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', gap: 16, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {canCreate ? <RequestForm companyId={companyId} draft={draft} setDraft={setDraft} /> : <p className="muted">{readOnly ? t('purchaseRequests.readOnly') : t('purchaseRequests.noRight')}</p>}
        {loading ? (
          <DraftLoader
            req={loading}
            onLoad={(d) => {
              setDraft(d)
              setLoading(null)
            }}
          />
        ) : null}
        {myDrafts.length ? (
          <TableCard title={t('purchaseRequests.myDrafts')}>
            <DataTable
              caption={t('purchaseRequests.myDrafts')}
              rows={myDrafts}
              rowKey={(r) => r.id}
              columns={[
                { key: 'no', header: t('purchaseRequests.cols.no'), render: (r) => <span className="mono">{r.doc_no}</span> },
                { key: 'dep', header: t('purchaseRequests.cols.department'), render: (r) => r.department },
                { key: 'lines', header: t('purchaseRequests.cols.lines'), align: 'right', render: (r) => r.lines ?? 0 },
                {
                  key: 'act',
                  header: <span className="sr-only">{t('purchaseRequests.cols.actions')}</span>,
                  render: (r) => (
                    <Button size="sm" variant="link" aria-label={t('purchaseRequests.editAria', { no: r.doc_no })} onClick={() => setLoading(r)}>
                      {t('purchaseRequests.edit')}
                    </Button>
                  ),
                },
              ]}
            />
          </TableCard>
        ) : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <LastBills companyId={companyId} productId={firstProduct} />
        <Card title={t('purchaseRequests.alsoFrom.title')}>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <li>{t('purchaseRequests.alsoFrom.bom')}</li>
            <li>{t('purchaseRequests.alsoFrom.reorder')}</li>
            <li>{t('purchaseRequests.alsoFrom.maintenance')}</li>
          </ul>
        </Card>
      </div>
    </div>
  )
}

/** Loads a draft's lines (api.purchase_request_lines) into the form. */
function DraftLoader({ req, onLoad }: { req: Req; onLoad: (d: Draft) => void }) {
  const lines = useApiView('purchase_request_lines', { eq: { request_id: req.id }, order: 'line_no' })
  const ready = lines.data?.status === 'ready'
  useEffect(() => {
    if (!ready) return
    const ls = rowsOf(lines)
    onLoad({
      id: req.id,
      department: req.department,
      for_job: req.for_job ?? '',
      needed_by: req.needed_by ?? '',
      reason: req.reason ?? '',
      lines: ls.length
        ? ls.map((l) => ({ product_id: l.product_id ?? '', description: l.product_id ? '' : l.description, qty: String(l.qty), est_rate: l.est_rate === null ? '' : String(l.est_rate), suggested_party_id: l.suggested_party_id ?? '' }))
        : [{ ...EMPTY_LINE }],
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])
  return null
}

function RequestForm({ companyId, draft, setDraft }: { companyId: string; draft: Draft; setDraft: (d: Draft) => void }) {
  const { t } = useTranslation()
  const { list: deps, loading: depsLoading } = useDepartments(companyId)
  const products = useCompanyProducts(companyId).list
  const suppliers = useCompanySuppliers(companyId).list
  const stock = rowsOf(useApiView('item_stock', { eq: { company_id: companyId }, limit: 3000 }))
  const stockBy = new Map(stock.map((s) => [s.product_id, s]))
  const save = useApiMutation<{ p: Record<string, unknown> }, { id: string; doc_no: string; status: string }>('create_purchase_request', REFRESH)
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [done, setDone] = useState<string | null>(null)

  function setLine(i: number, patch: Partial<Line>) {
    setDraft({ ...draft, lines: draft.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) })
  }
  function addLine() {
    setDraft({ ...draft, lines: [...draft.lines, { ...EMPTY_LINE }] })
    setTimeout(() => document.getElementById(`pr-line-${draft.lines.length}-item`)?.focus(), 0)
  }

  function submit(send: boolean) {
    setDone(null)
    const e: Record<string, string> = {}
    if (!draft.department.trim()) e.department = t('purchaseRequests.err.department')
    const lines: Record<string, unknown>[] = []
    for (const [i, l] of draft.lines.entries()) {
      if (!l.product_id && !l.description.trim() && !l.qty.trim()) continue
      const qty = cleanQty(l.qty)
      const rate = l.est_rate.trim() ? cleanAmount(l.est_rate) : null
      if ((!l.product_id && !l.description.trim()) || !qty || (l.est_rate.trim() && rate === null)) {
        e.lines = t('purchaseRequests.err.line', { n: i + 1 })
        break
      }
      lines.push({ product_id: l.product_id || null, description: l.description.trim() || null, qty, est_rate: rate, suggested_party_id: l.suggested_party_id || null })
    }
    if (!e.lines && lines.length === 0) e.lines = t('purchaseRequests.err.noLines')
    setErrs(e)
    if (Object.keys(e).length) return
    save.mutate(
      { p: { id: draft.id, company_id: companyId, department: draft.department.trim(), for_job: draft.for_job.trim() || null, needed_by: draft.needed_by || null, reason: draft.reason.trim() || null, submit: send, lines } },
      {
        onSuccess: (res) => {
          setDone(res.status === 'submitted' ? t('purchaseRequests.sent', { no: res.doc_no }) : t('purchaseRequests.savedDraft', { no: res.doc_no }))
          setDraft(res.status === 'submitted' ? emptyDraft() : { ...draft, id: res.id })
        },
      },
    )
  }

  return (
    <Card title={draft.id ? t('purchaseRequests.form.titleEdit') : t('purchaseRequests.form.title')} action={<DocStatus status="draft" />}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          submit(false)
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <FieldGrid cols={3}>
          {depsLoading ? (
            <Skeleton height={60} />
          ) : deps.length ? (
            <SelectField label={t('purchaseRequests.form.department')} value={draft.department} error={errs.department} placeholder={t('purchaseRequests.form.yourDepartment')} options={deps.map((d) => ({ value: d.name, label: d.name }))} onChange={(e) => setDraft({ ...draft, department: e.target.value })} />
          ) : (
            <Field label={t('purchaseRequests.form.department')} value={draft.department} error={errs.department} help={t('purchaseRequests.form.noDepartments')} onChange={(e) => setDraft({ ...draft, department: e.target.value })} />
          )}
          <Field label={t('purchaseRequests.form.forJob')} value={draft.for_job} onChange={(e) => setDraft({ ...draft, for_job: e.target.value })} />
          <Field type="date" label={t('purchaseRequests.form.neededBy')} value={draft.needed_by} min={todayIst()} onChange={(e) => setDraft({ ...draft, needed_by: e.target.value })} />
        </FieldGrid>

        <div className="sf-table-wrap" tabIndex={0} role="region" aria-label={t('purchaseRequests.form.lines')}>
          <table className="sf-table">
            <caption className="sr-only">{t('purchaseRequests.form.lines')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('purchaseRequests.form.item')}</th>
                <th scope="col" className="r">
                  {t('purchaseRequests.form.qty')}
                </th>
                <th scope="col" className="r">
                  {t('purchaseRequests.form.estRate')}
                </th>
                <th scope="col" className="r">
                  {t('purchaseRequests.form.inStock')}
                </th>
                <th scope="col" className="r">
                  {t('purchaseRequests.form.lastRate')}
                </th>
                <th scope="col">{t('purchaseRequests.form.supplier')}</th>
                <th scope="col">
                  <span className="sr-only">{t('purchaseRequests.cols.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {draft.lines.map((l, i) => {
                const n = i + 1
                const s = l.product_id ? stockBy.get(l.product_id) : undefined
                const uom = products.find((p) => p.id === l.product_id)?.uom ?? ''
                return (
                  <tr key={i}>
                    <td>
                      <select id={`pr-line-${i}-item`} className="sf-input" style={{ height: 34, minWidth: 200 }} aria-label={t('purchaseRequests.aria.item', { n })} value={l.product_id} onChange={(e) => setLine(i, { product_id: e.target.value })}>
                        <option value="">{t('purchaseRequests.form.otherItem')}</option>
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.code} · {p.name}
                          </option>
                        ))}
                      </select>
                      {!l.product_id ? <input className="sf-input" style={{ height: 34, marginTop: 4 }} aria-label={t('purchaseRequests.aria.description', { n })} placeholder={t('purchaseRequests.form.describe')} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /> : null}
                    </td>
                    <td className="r">
                      <input className="sf-input mono" style={{ height: 34, width: 90, textAlign: 'right' }} inputMode="decimal" aria-label={t('purchaseRequests.aria.qty', { n })} value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
                      {uom ? <div className="k">{uom}</div> : null}
                    </td>
                    <td className="r">
                      <input
                        className="sf-input mono"
                        style={{ height: 34, width: 100, textAlign: 'right' }}
                        inputMode="decimal"
                        aria-label={t('purchaseRequests.aria.estRate', { n })}
                        value={l.est_rate}
                        onChange={(e) => setLine(i, { est_rate: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && i === draft.lines.length - 1) {
                            e.preventDefault()
                            addLine()
                          }
                        }}
                      />
                    </td>
                    <td className="r mono">{s ? <Amount value={s.sellable} digits={3} /> : '—'}</td>
                    <td className="r mono">{s?.last_rate !== null && s?.last_rate !== undefined ? <Amount value={s.last_rate} /> : '—'}</td>
                    <td>
                      <select className="sf-input" style={{ height: 34, minWidth: 150 }} aria-label={t('purchaseRequests.aria.supplier', { n })} value={l.suggested_party_id} onChange={(e) => setLine(i, { suggested_party_id: e.target.value })}>
                        <option value="">{t('purchaseRequests.form.anySupplier')}</option>
                        {suppliers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <Button size="sm" variant="link" aria-label={t('purchaseRequests.aria.remove', { n })} onClick={() => setDraft({ ...draft, lines: draft.lines.length > 1 ? draft.lines.filter((_, j) => j !== i) : [{ ...EMPTY_LINE }] })}>
                        {t('purchaseRequests.form.remove')}
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button size="sm" onClick={addLine}>
            {t('purchaseRequests.form.addItem')}
          </Button>
          <span className="k">{t('purchaseRequests.form.keyboard')}</span>
        </div>
        {errs.lines ? (
          <p className="sf-field__msg" role="alert" style={{ color: 'var(--sf-danger-ink)', margin: 0 }}>
            {errs.lines}
          </p>
        ) : null}
        <TextAreaField label={t('purchaseRequests.form.reason')} value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
        <p className="k" style={{ margin: 0, borderTop: '1px solid var(--sf-line-faint)', paddingTop: 12 }}>
          {t('purchaseRequests.form.rule')}
        </p>
        <PurchaseErrorBox error={save.error as RpcError | null} />
        {done ? (
          <p role="status" className="sf-alert" data-tone="success" style={{ margin: 0 }}>
            {done}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: 8 }}>
          <Button type="submit" busy={save.isPending && save.variables?.p.submit === false}>
            {t('purchaseRequests.form.saveDraft')}
          </Button>
          <Button variant="primary" busy={save.isPending && save.variables?.p.submit === true} onClick={() => submit(true)}>
            {t('purchaseRequests.form.send')}
          </Button>
        </div>
      </form>
    </Card>
  )
}

/** The item's last two bill rates (api.price_history, source bill). */
function LastBills({ companyId, productId }: { companyId: string; productId: string }) {
  const { t } = useTranslation()
  const q = useApiView('price_history', { eq: { company_id: companyId, product_id: productId, source: 'bill' }, order: 'rate_date', ascending: false, limit: 2, enabled: Boolean(productId) })
  const rows = rowsOf(q)
  return (
    <Card title={t('purchaseRequests.lastBills.title')}>
      {!productId ? (
        <p className="muted" style={{ margin: 0 }}>
          {t('purchaseRequests.lastBills.pick')}
        </p>
      ) : rows.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          {q.isLoading ? t('common.loading') : t('purchaseRequests.lastBills.none')}
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {rows.map((r) => (
            <li key={r.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderTop: '1px solid var(--sf-line-faint)' }}>
              <span>
                {r.party_name ?? '—'} · <span className="mono">{formatDate(r.rate_date)}</span>
              </span>
              <Amount value={r.rate} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function ListTab({ companyId, tab, rows, all, loading }: { companyId: string; tab: Exclude<Tab, 'new'>; rows: Req[]; all: Req[]; loading: boolean }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState<string | null>(null)
  // From the full list, so a request stays open after it is decided and leaves this tab.
  const selected = all.find((r) => r.id === open) ?? null
  const columns: Column<Req>[] = [
    { key: 'no', header: t('purchaseRequests.cols.no'), render: (r) => <span className="mono">{r.doc_no}</span> },
    { key: 'date', header: t('purchaseRequests.cols.date'), render: (r) => <span className="mono">{formatDate(r.request_date)}</span> },
    { key: 'dep', header: t('purchaseRequests.cols.department'), render: (r) => r.department },
    { key: 'by', header: t('purchaseRequests.cols.by'), render: (r) => r.requested_by_name ?? '—' },
    { key: 'need', header: t('purchaseRequests.cols.neededBy'), render: (r) => (r.needed_by ? <span className="mono">{formatDate(r.needed_by)}</span> : '—') },
    { key: 'lines', header: t('purchaseRequests.cols.lines'), align: 'right', render: (r) => r.lines ?? 0 },
    { key: 'est', header: t('purchaseRequests.cols.estimate'), align: 'right', render: (r) => <Amount value={r.est_total} /> },
    { key: 'status', header: t('common.status'), render: (r) => <DocStatus status={r.status} /> },
    {
      key: 'act',
      header: <span className="sr-only">{t('purchaseRequests.cols.actions')}</span>,
      render: (r) => (
        <Button size="sm" variant="link" aria-label={t('purchaseRequests.openAria', { no: r.doc_no })} onClick={() => setOpen(r.id)}>
          {t('purchaseRequests.open')}
        </Button>
      ),
    },
  ]
  return (
    <>
      {selected ? <RequestDetail key={selected.id} companyId={companyId} req={selected} onClose={() => setOpen(null)} /> : null}
      <TableCard title={t(`purchaseRequests.list.${tab}`)}>
        <DataTable caption={t(`purchaseRequests.list.${tab}`)} columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} minWidth={900} empty={<EmptyState title={t(`purchaseRequests.empty.${tab}`)} />} />
      </TableCard>
    </>
  )
}

function RequestDetail({ companyId, req, onClose }: { companyId: string; req: Req; onClose: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const rights = usePurchaseRights()
  const lines = useApiView('purchase_request_lines', { eq: { request_id: req.id }, order: 'line_no' })
  const decide = useApiMutation<{ p_request_id: string; p_approve: boolean; p_note: string | null }, { id: string; status: string }>('approve_purchase_request', REFRESH)
  const [refusing, setRefusing] = useState(false)
  const [note, setNote] = useState('')
  const [noteErr, setNoteErr] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  type L = ViewRow<'purchase_request_lines'>
  const cols: Column<L>[] = [
    { key: 'item', header: t('purchaseRequests.form.item'), render: (l) => (l.product_code ? `${l.product_code} · ${l.description}` : l.description) },
    { key: 'qty', header: t('purchaseRequests.form.qty'), align: 'right', render: (l) => <span className="mono">{`${l.qty} ${l.uom}`}</span> },
    { key: 'stock', header: t('purchaseRequests.form.inStock'), align: 'right', render: (l) => <Amount value={l.in_stock} digits={3} /> },
    { key: 'order', header: t('purchaseRequests.form.onOrder'), align: 'right', render: (l) => <Amount value={l.on_order} digits={3} /> },
    { key: 'last', header: t('purchaseRequests.form.lastRate'), align: 'right', render: (l) => <Amount value={l.last_rate} /> },
    { key: 'est', header: t('purchaseRequests.form.estRate'), align: 'right', render: (l) => <Amount value={l.est_rate} /> },
    { key: 'sup', header: t('purchaseRequests.form.supplier'), render: (l) => l.suggested_party_name ?? '—' },
  ]
  return (
    <Card
      title={t('purchaseRequests.detail.title', { no: req.doc_no })}
      action={
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <DocStatus status={req.status} />
          <Button size="sm" variant="link" onClick={onClose}>
            {t('common.close')}
          </Button>
        </span>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        {t('purchaseRequests.detail.meta', { department: req.department, by: req.requested_by_name ?? '—', date: formatDate(req.request_date) })}
        {req.reason ? ` · ${req.reason}` : ''}
      </p>
      <DataTable caption={t('purchaseRequests.form.lines')} columns={cols} rows={rowsOf(lines)} rowKey={(l) => l.id} loading={lines.isLoading} minWidth={760} />
      {req.decided_by_name ? (
        <p className="k" style={{ marginBottom: 0 }}>
          {t('purchaseRequests.detail.decided', { by: req.decided_by_name, date: req.decided_at ? formatDate(req.decided_at) : '' })}
          {req.decision_note ? ` · ${req.decision_note}` : ''}
        </p>
      ) : null}
      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {!refusing ? <PurchaseErrorBox error={decide.error as RpcError | null} /> : null}
        {done ? (
          <p role="status" className="sf-alert" data-tone="success" style={{ margin: 0 }}>
            {done}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {req.status === 'submitted' && rights.approve ? (
            <>
              <Button
                variant="primary"
                busy={decide.isPending && decide.variables?.p_approve === true}
                onClick={() => decide.mutate({ p_request_id: req.id, p_approve: true, p_note: null }, { onSuccess: () => setDone(t('purchaseRequests.detail.approved', { no: req.doc_no })) })}
              >
                {t('purchaseRequests.detail.approve')}
              </Button>
              <Button
                onClick={() => {
                  decide.reset()
                  setRefusing(true)
                }}
              >
                {t('purchaseRequests.detail.refuse')}
              </Button>
            </>
          ) : null}
          {req.status === 'submitted' && !rights.approve ? <span className="muted">{t('purchaseRequests.detail.noApprove')}</span> : null}
          {req.status === 'approved' && rights.create ? (
            <Button variant="primary" onClick={() => navigate(`/purchase/purchase-orders?company=${companyId}&tab=quotes&request=${req.id}`)}>
              {t('purchaseRequests.detail.askQuotes')}
            </Button>
          ) : null}
          {req.order_id ? (
            <Button onClick={() => navigate(`/purchase/purchase-orders?company=${companyId}&order=${req.order_id}`)}>{t('purchaseRequests.detail.openOrder')}</Button>
          ) : null}
        </div>
      </div>
      <FormDialog
        open={refusing}
        onOpenChange={(o) => {
          setRefusing(o)
          if (!o) setNoteErr(null)
        }}
        title={t('purchaseRequests.detail.refuseTitle', { no: req.doc_no })}
        submitLabel={t('purchaseRequests.detail.refuse')}
        busy={decide.isPending}
        error={<PurchaseErrorBox error={decide.error as RpcError | null} />}
        onSubmit={() => {
          if (note.trim().length < 5) {
            setNoteErr(t('purchaseRequests.detail.noteShort'))
            return
          }
          decide.mutate(
            { p_request_id: req.id, p_approve: false, p_note: note.trim() },
            {
              onSuccess: () => {
                setRefusing(false)
                setDone(t('purchaseRequests.detail.refused', { no: req.doc_no }))
              },
            },
          )
        }}
      >
        <TextAreaField label={t('common.reason')} value={note} error={noteErr ?? undefined} onChange={(e) => setNote(e.target.value)} />
      </FormDialog>
    </Card>
  )
}

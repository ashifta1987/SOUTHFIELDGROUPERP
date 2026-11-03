import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { cleanAmount, MoneyErrorBox, useCompanyAccounts, useReadRpc } from '@/features/accounts/cash-book/money'
import { TotalsBlock, useDebounced, type Totals } from '@/features/sales/invoice/taxPanel'
import { formatIndian } from '@/shared/format'
import { Button, Card, Checkbox, ConfirmDialog, Field, FieldGrid, SelectField } from '@/ui'

export interface BillLine {
  kind: 'product' | 'account'
  product_id: string
  account_id: string
  description: string
  hsn_code: string
  qty: string
  rate: string
  discount: string
}
export interface BillDraft {
  id: string | null
  party_id: string
  gstin_id: string
  supplier_bill_no: string
  supplier_bill_date: string
  bill_date: string
  itc_eligible: boolean
  reverse_charge: boolean
  lines: BillLine[]
}

export const EMPTY_LINE: BillLine = { kind: 'product', product_id: '', account_id: '', description: '', hsn_code: '', qty: '', rate: '', discount: '' }
export function emptyDraft(): BillDraft {
  return { id: null, party_id: '', gstin_id: '', supplier_bill_no: '', supplier_bill_date: todayIst(), bill_date: todayIst(), itc_eligible: true, reverse_charge: false, lines: [{ ...EMPTY_LINE }] }
}

const QTY_RE = /^\d+(\.\d{1,3})?$/
const REFRESH = [['api', 'purchase_bills'], ['api', 'purchase_bill_lines'], ['api', 'payables'], ['api', 'vouchers']]

/** A line is "typed" when it has something in it; blank trailing lines are ignored. */
function isBlank(l: BillLine) {
  return !l.product_id && !l.account_id && !l.description.trim() && !l.qty.trim() && !l.rate.trim()
}

/** Lines in the shape the RPCs take (numbers as clean decimal strings), or null with the first problem. */
function payloadLines(lines: BillLine[]): { lines: Record<string, unknown>[] } | { error: number } {
  const out: Record<string, unknown>[] = []
  for (const [i, l] of lines.entries()) {
    if (isBlank(l)) continue
    const rate = cleanAmount(l.rate || '0')
    const discount = cleanAmount(l.discount || '0')
    const qty = l.qty.trim()
    const what = l.kind === 'product' ? l.product_id : l.account_id
    if (!what || !QTY_RE.test(qty) || Number(qty) <= 0 || rate === null || discount === null || (l.kind === 'account' && !l.description.trim())) return { error: i + 1 }
    out.push({
      product_id: l.kind === 'product' ? l.product_id : null,
      account_id: l.kind === 'account' ? l.account_id : null,
      description: l.description.trim() || null,
      hsn_code: l.hsn_code.trim() || null,
      qty,
      rate,
      discount,
    })
  }
  return { lines: out }
}

interface Saved {
  id: string
  totals: Totals
}

/**
 * Supplier bill entry (§UX-7.3): header, keyboard lines (Enter on the last rate adds a line), the tax worked out by
 * the server (api.preview_tax while typing; api.save_purchase_draft stores it), then post (api.post_purchase_bill)
 * after a confirmation that states the exact total the server computed.
 */
export function BillEditor({ companyId, draft, setDraft, onDone }: { companyId: string; draft: BillDraft; setDraft: (d: BillDraft) => void; onDone: (docNo: string) => void }) {
  const { t } = useTranslation()
  const suppliers = rowsOf(useApiView('suppliers', { eq: { company_id: companyId }, order: 'name', limit: 1000 }))
  const gstins = rowsOf(useApiView('gstins', { eq: { company_id: companyId }, order: 'gstin' }))
  const products = rowsOf(useApiView('products', { order: 'name', limit: 2000 })).filter((p) => p.status === 'active' && (!p.company_ids || p.company_ids.length === 0 || p.company_ids.includes(companyId)))
  const accounts = useCompanyAccounts(companyId).list.filter((a) => a.nature === 'expense' || a.nature === 'asset')
  const save = useApiMutation<{ p: Record<string, unknown> }, Saved>('save_purchase_draft', REFRESH)
  const post = useApiMutation<{ p_bill_id: string }, { id: string; doc_no: string; voucher_id: string }>('post_purchase_bill', REFRESH)
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [confirm, setConfirm] = useState<Saved | null>(null)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)

  const gstinId = draft.gstin_id || gstins.find((g) => g.is_principal)?.id || gstins[0]?.id || ''
  const built = payloadLines(draft.lines)
  const previewLines = 'lines' in built ? built.lines : []
  const previewArgs = useDebounced({ p_gstin_id: gstinId, p_party_id: draft.party_id, p_place_of_supply: null, p_date: draft.supplier_bill_date, p_without_gst: false, p_lines: previewLines }, 400)
  const preview = useReadRpc<Totals & { intra_state: boolean }>('preview_tax', previewArgs, Boolean(previewArgs.p_gstin_id && previewArgs.p_party_id && previewArgs.p_lines.length))

  function setLine(i: number, patch: Partial<BillLine>) {
    setDraft({ ...draft, lines: draft.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) })
  }
  function addLine() {
    setDraft({ ...draft, lines: [...draft.lines, { ...EMPTY_LINE }] })
    setTimeout(() => document.getElementById(`bill-line-${draft.lines.length}-what`)?.focus(), 0)
  }
  function removeLine(i: number) {
    const next = draft.lines.filter((_, j) => j !== i)
    setDraft({ ...draft, lines: next.length ? next : [{ ...EMPTY_LINE }] })
  }

  function validate(): Record<string, unknown> | null {
    const e: Record<string, string> = {}
    if (!draft.party_id) e.party = t('bills.err.party')
    if (!gstinId) e.gstin = t('bills.err.gstin')
    if (!draft.supplier_bill_no.trim()) e.billNo = t('bills.err.billNo')
    if (!draft.supplier_bill_date) e.billDate = t('bills.err.date')
    if ('error' in built) e.lines = t('bills.err.line', { n: built.error })
    else if (built.lines.length === 0) e.lines = t('bills.err.noLines')
    setErrs(e)
    if (Object.keys(e).length || !('lines' in built)) return null
    return {
      id: draft.id,
      company_id: companyId,
      gstin_id: gstinId,
      party_id: draft.party_id,
      supplier_bill_no: draft.supplier_bill_no.trim(),
      supplier_bill_date: draft.supplier_bill_date,
      bill_date: draft.bill_date || draft.supplier_bill_date,
      itc_eligible: draft.itc_eligible,
      reverse_charge: draft.reverse_charge,
      lines: built.lines,
    }
  }

  async function saveDraft(): Promise<Saved | null> {
    setSavedMsg(null)
    post.reset()
    const p = validate()
    if (!p) return null
    try {
      const res = await save.mutateAsync({ p })
      setDraft({ ...draft, id: res.id, gstin_id: gstinId })
      return res
    } catch {
      return null
    }
  }

  async function onSave() {
    const res = await saveDraft()
    if (res) setSavedMsg(t('bills.editor.saved', { total: formatIndian(res.totals.total) }))
  }

  async function onPost() {
    const res = await saveDraft()
    if (res) setConfirm(res)
  }

  async function doPost() {
    if (!confirm) return
    try {
      const res = await post.mutateAsync({ p_bill_id: confirm.id })
      setConfirm(null)
      onDone(res.doc_no)
    } catch {
      setConfirm(null)
    }
  }

  const supplierName = suppliers.find((s) => s.id === draft.party_id)?.name ?? ''

  return (
    <Card title={draft.id ? t('bills.editor.titleDraft') : t('bills.editor.title')} action={draft.id ? <span className="sf-chip" data-tone="neutral">{t('bills.status.draft')}</span> : null}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void onSave()
        }}
      >
        <FieldGrid cols={3}>
          <SelectField
            label={t('bills.editor.supplier')}
            value={draft.party_id}
            error={errs.party}
            placeholder={suppliers.length ? t('bills.editor.chooseSupplier') : t('bills.editor.noSuppliers')}
            options={suppliers.map((s) => ({ value: s.id, label: s.gstin ? `${s.name} · ${s.gstin}` : s.name }))}
            onChange={(e) => setDraft({ ...draft, party_id: e.target.value })}
          />
          <SelectField label={t('bills.editor.gstin')} value={gstinId} error={errs.gstin} options={gstins.map((g) => ({ value: g.id, label: g.gstin }))} onChange={(e) => setDraft({ ...draft, gstin_id: e.target.value })} />
          <Field label={t('bills.editor.billNo')} value={draft.supplier_bill_no} error={errs.billNo} onChange={(e) => setDraft({ ...draft, supplier_bill_no: e.target.value })} />
          <Field type="date" label={t('bills.editor.billDate')} value={draft.supplier_bill_date} max={todayIst()} error={errs.billDate} onChange={(e) => setDraft({ ...draft, supplier_bill_date: e.target.value })} />
          <Field type="date" label={t('bills.editor.bookDate')} value={draft.bill_date} max={todayIst()} onChange={(e) => setDraft({ ...draft, bill_date: e.target.value })} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, justifyContent: 'flex-end' }}>
            <Checkbox label={t('bills.editor.itc')} checked={draft.itc_eligible} onChange={(e) => setDraft({ ...draft, itc_eligible: e.target.checked })} />
            <Checkbox label={t('bills.editor.rcm')} checked={draft.reverse_charge} onChange={(e) => setDraft({ ...draft, reverse_charge: e.target.checked })} />
          </div>
        </FieldGrid>

        <div className="sf-table-wrap" style={{ marginTop: 16 }}>
          <table className="sf-table">
            <caption className="sr-only">{t('bills.editor.lines')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('bills.editor.col.kind')}</th>
                <th scope="col">{t('bills.editor.col.item')}</th>
                <th scope="col">{t('bills.editor.col.description')}</th>
                <th scope="col">{t('bills.editor.col.hsn')}</th>
                <th scope="col" className="r">
                  {t('bills.editor.col.qty')}
                </th>
                <th scope="col" className="r">
                  {t('bills.editor.col.rate')}
                </th>
                <th scope="col" className="r">
                  {t('bills.editor.col.discount')}
                </th>
                <th scope="col">
                  <span className="sr-only">{t('bills.editor.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {draft.lines.map((l, i) => {
                const n = i + 1
                return (
                  <tr key={i}>
                    <td>
                      <select className="sf-input" style={{ height: 34 }} aria-label={t('bills.editor.aria.kind', { n })} value={l.kind} onChange={(e) => setLine(i, { kind: e.target.value as BillLine['kind'], product_id: '', account_id: '' })}>
                        <option value="product">{t('bills.editor.kind.product')}</option>
                        <option value="account">{t('bills.editor.kind.account')}</option>
                      </select>
                    </td>
                    <td>
                      <select
                        id={`bill-line-${i}-what`}
                        className="sf-input"
                        style={{ height: 34, minWidth: 200 }}
                        aria-label={l.kind === 'product' ? t('bills.editor.aria.product', { n }) : t('bills.editor.aria.account', { n })}
                        value={l.kind === 'product' ? l.product_id : l.account_id}
                        onChange={(e) => setLine(i, l.kind === 'product' ? { product_id: e.target.value } : { account_id: e.target.value })}
                      >
                        <option value="">{t('bills.editor.choose')}</option>
                        {l.kind === 'product'
                          ? products.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.code} · {p.name}
                              </option>
                            ))
                          : accounts.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name} · {a.group_name}
                              </option>
                            ))}
                      </select>
                    </td>
                    <td>
                      <input className="sf-input" style={{ height: 34 }} aria-label={t('bills.editor.aria.description', { n })} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
                    </td>
                    <td>
                      <input className="sf-input mono" style={{ height: 34, width: 100 }} aria-label={t('bills.editor.aria.hsn', { n })} value={l.hsn_code} onChange={(e) => setLine(i, { hsn_code: e.target.value.replace(/\D/g, '') })} />
                    </td>
                    <td className="r">
                      <input className="sf-input mono" style={{ height: 34, width: 90, textAlign: 'right' }} inputMode="decimal" aria-label={t('bills.editor.aria.qty', { n })} value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
                    </td>
                    <td className="r">
                      <input
                        className="sf-input mono"
                        style={{ height: 34, width: 110, textAlign: 'right' }}
                        inputMode="decimal"
                        aria-label={t('bills.editor.aria.rate', { n })}
                        value={l.rate}
                        onChange={(e) => setLine(i, { rate: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && i === draft.lines.length - 1) {
                            e.preventDefault()
                            addLine()
                          }
                        }}
                      />
                    </td>
                    <td className="r">
                      <input className="sf-input mono" style={{ height: 34, width: 90, textAlign: 'right' }} inputMode="decimal" aria-label={t('bills.editor.aria.discount', { n })} value={l.discount} onChange={(e) => setLine(i, { discount: e.target.value })} />
                    </td>
                    <td>
                      <Button size="sm" variant="link" aria-label={t('bills.editor.aria.remove', { n })} onClick={() => removeLine(i)}>
                        {t('bills.editor.remove')}
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginTop: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>
              <Button size="sm" onClick={addLine}>
                {t('bills.editor.addLine')}
              </Button>
            </div>
            <p className="k" style={{ margin: 0 }}>
              {t('bills.editor.keyboard')}
            </p>
            {errs.lines ? (
              <p className="sf-field__msg" role="alert" style={{ color: 'var(--sf-danger-ink)', margin: 0 }}>
                {errs.lines}
              </p>
            ) : null}
            {preview.error ? <MoneyErrorBox error={preview.error} /> : null}
          </div>
          <TotalsBlock totals={preview.data ?? null} intra={preview.data ? preview.data.intra_state : null} />
        </div>

        <MoneyErrorBox error={(save.error ?? post.error) as RpcError | null} />
        {savedMsg ? (
          <p role="status" style={{ color: 'var(--sf-success-ink)' }}>
            {savedMsg}
          </p>
        ) : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <Button
            onClick={() => {
              setErrs({})
              setSavedMsg(null)
              save.reset()
              post.reset()
              setDraft(emptyDraft())
            }}
          >
            {t('bills.editor.clear')}
          </Button>
          <Button type="submit" busy={save.isPending && !confirm}>
            {t('bills.editor.save')}
          </Button>
          <Button variant="primary" busy={save.isPending || post.isPending} onClick={() => void onPost()}>
            {t('bills.editor.post')}
          </Button>
        </div>
      </form>

      <ConfirmDialog
        open={Boolean(confirm)}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('bills.editor.confirmTitle')}
        effect={confirm ? t('bills.editor.confirmEffect', { total: formatIndian(confirm.totals.total), supplier: supplierName, no: draft.supplier_bill_no }) : ''}
        confirmLabel={t('bills.editor.post')}
        busy={post.isPending}
        onConfirm={() => void doPost()}
      />
    </Card>
  )
}

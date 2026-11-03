import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { ViewError } from '@/features/production/biochem-common/biochem'
import { CompanyFrame, NoteCard, OPS_REFRESH, OpsErrorBox, TwoCol, useOpsRights } from '@/features/production/ops-common/ops'
import { formatDate } from '@/shared/format'
import { Amount, Button, Card, Chip, DataTable, EmptyState, Field, FieldGrid, FormDialog, KeyValue, SelectField, Tabs, TextAreaField, type Column } from '@/ui'

type Req = ViewRow<'v_partner_requests'>
type Partner = ViewRow<'v_partners'>

const FILTERS: Record<string, string[] | null> = {
  all: null,
  withdraw: ['withdraw'],
  loans: ['loan_to_partner', 'loan_from_partner'],
  project: ['project_offer'],
  info: ['info'],
}

/**
 * Accounts → Partner requests (`PartnerRequests`): withdrawals, loans, project offers and questions sent from the
 * investor portal or recorded by Admin on a partner's behalf (api.submit_partner_request). Only Admin decides, never
 * their own request (sod.own_request), with the Companies Act checks run by the server (s.185, s.186, the director's
 * declaration) — shown as its messages (api.decide_partner_request). Approved withdrawals are paid from the bank
 * (api.pay_partner_request); loans are recorded on Directors and investment.
 */
export function PartnerRequestsPage() {
  const { t } = useTranslation()
  const rights = useOpsRights()
  const [recording, setRecording] = useState(false)
  return (
    <CompanyFrame
      title={t('partnerRequests.title')}
      subtitle={t('partnerRequests.subtitle')}
      notice={!rights.partnersView ? t('partnerRequests.noView') : rights.readOnly ? t('opsCommon.readOnly') : undefined}
      actions={() =>
        rights.partnersManage ? (
          <Button variant="primary" onClick={() => setRecording(true)}>
            {t('partnerRequests.record')}
          </Button>
        ) : null
      }
    >
      {(companyId) => (
        <>
          <Body companyId={companyId} />
          {recording ? <SubmitDialog companyId={companyId} onClose={() => setRecording(false)} /> : null}
        </>
      )}
    </CompanyFrame>
  )
}

function Body({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const q = useApiView('v_partner_requests', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 300 })
  const pq = useApiView('v_partners', { eq: { company_id: companyId }, order: 'display_name', limit: 200 })
  const all = rowsOf(q)
  const [filter, setFilter] = useState('all')
  const kinds = FILTERS[filter]
  const shown = kinds ? all.filter((r) => kinds.includes(r.kind)) : all
  const count = (k: string) => {
    const ks = FILTERS[k]
    return ks ? all.filter((r) => ks.includes(r.kind)).length : all.length
  }
  const partnerCols: Column<Partner>[] = [
    { key: 'n', header: t('partnerRequests.draw.partner'), render: (p) => <strong>{p.display_name}</strong> },
    { key: 'pct', header: t('partnerRequests.draw.share'), align: 'right', render: (p) => <span className="mono">{p.share_pct} %</span> },
    { key: 'cur', header: t('partnerRequests.draw.current'), align: 'right', render: (p) => (p.current_account_id ? <Amount value={p.current_account_balance} /> : <span className="k">{t('partnerRequests.draw.noAccount')}</span>) },
    { key: 'loan', header: t('partnerRequests.draw.loan'), align: 'right', render: (p) => (p.loan_account_id ? <Amount value={p.loan_account_balance} /> : <span className="k">{t('partnerRequests.draw.noAccount')}</span>) },
    { key: 'dir', header: t('partnerRequests.draw.declaration'), render: (p) => (p.is_director ? (p.declaration_on_file ? t('partnerRequests.draw.onFile') : t('partnerRequests.draw.missing')) : '—') },
  ]
  return (
    <TwoCol
      main={
        <>
          <div style={{ display: 'flex' }}>
            <Tabs variant="segmented" label={t('partnerRequests.filters')} value={filter} onChange={setFilter} tabs={Object.keys(FILTERS).map((k) => ({ key: k, label: `${t(`partnerRequests.filter.${k}`)} · ${count(k)}` }))} />
          </div>
          {q.error ? <ViewError error={q.error} /> : null}
          {!q.isLoading && shown.length === 0 ? (
            <Card>
              <EmptyState title={t('partnerRequests.emptyTitle')} body={t('partnerRequests.emptyBody')} />
            </Card>
          ) : null}
          {shown.map((r) => (
            <RequestCard key={r.id} r={r} />
          ))}
          <TableCard title={t('partnerRequests.draw.title')}>
            <DataTable caption={t('partnerRequests.draw.title')} columns={partnerCols} rows={rowsOf(pq)} rowKey={(p) => p.id} loading={pq.isLoading} minWidth={640} error={pq.error ? <ViewError error={pq.error} /> : undefined} empty={<span className="k">{t('partnerRequests.draw.none')}</span>} />
            <p className="k" style={{ margin: 0, padding: '10px 16px 14px' }}>
              {t('partnerRequests.draw.note')}
            </p>
          </TableCard>
        </>
      }
      side={
        <>
          <NoteCard
            accent
            title={t('partnerRequests.checks.title')}
            items={[
              { head: t('partnerRequests.checks.withdrawHead'), body: t('partnerRequests.checks.withdraw') },
              { head: t('partnerRequests.checks.loanToHead'), body: t('partnerRequests.checks.loanTo') },
              { head: t('partnerRequests.checks.loanFromHead'), body: t('partnerRequests.checks.loanFrom') },
              { head: t('partnerRequests.checks.projectHead'), body: t('partnerRequests.checks.project') },
            ]}
          />
          <NoteCard title={t('partnerRequests.after.title')} items={[{ body: t('partnerRequests.after.one') }, { body: t('partnerRequests.after.two') }, { body: t('partnerRequests.after.three') }]} />
        </>
      }
    />
  )
}

function StatusChip({ s }: { s: string }) {
  const { t } = useTranslation()
  const tone = s === 'approved' ? 'teal' : s === 'paid' ? 'success' : s === 'rejected' ? 'danger' : s === 'submitted' ? 'signal' : 'neutral'
  return <Chip tone={tone}>{t(`partnerRequests.status.${s}`, { defaultValue: s })}</Chip>
}

function RequestCard({ r }: { r: Req }) {
  const { t } = useTranslation()
  const rights = useOpsRights()
  const [dlg, setDlg] = useState<'approve' | 'reject' | 'pay' | null>(null)
  const checks = r.checks && typeof r.checks === 'object' && !Array.isArray(r.checks) ? Object.entries(r.checks as Record<string, unknown>).filter(([, v]) => v !== null && typeof v !== 'object') : []
  return (
    <Card
      title={
        <span>
          <span className="mono">{r.doc_no}</span> · {r.partner_name} · {t(`partnerRequests.kind.${r.kind}`, { defaultValue: r.kind })}
        </span>
      }
      action={<span data-testid={`pr-status-${r.doc_no}`}><StatusChip s={r.status} /></span>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <KeyValue
          rows={[
            ...(r.amount !== null ? [{ label: t('partnerRequests.f.amount'), value: <Amount value={r.amount} rupee /> }] : []),
            ...(r.source ? [{ label: t('partnerRequests.f.source'), value: t(`partnerRequests.source.${r.source}`, { defaultValue: r.source }) }] : []),
            ...(r.repay_months ? [{ label: t('partnerRequests.f.repay'), value: t('partnerRequests.f.repayValue', { n: r.repay_months, from: r.repay_from ? t(`partnerRequests.repayFrom.${r.repay_from}`, { defaultValue: r.repay_from }) : '—' }) }] : []),
            ...(r.purpose || r.note ? [{ label: t('partnerRequests.f.purpose'), value: [r.purpose, r.note].filter(Boolean).join(' · ') }] : []),
            ...(r.kind === 'withdraw' && r.due_to_partner !== null ? [{ label: t('partnerRequests.f.due'), value: <Amount value={r.due_to_partner} rupee /> }] : []),
            { label: t('partnerRequests.f.asked'), value: `${r.requested_by_name ?? '—'} · ${formatDate(r.created_at)}` },
            ...(r.decided_at ? [{ label: t('partnerRequests.f.decided'), value: `${r.decided_by_name ?? '—'} · ${formatDate(r.decided_at)}${r.decided_amount !== null ? ` · ₹${Number(r.decided_amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : ''}${r.decision_note ? ` · ${r.decision_note}` : ''}` }] : []),
            ...(checks.length ? [{ label: t('partnerRequests.f.checks'), value: checks.map(([k, v]) => `${k}: ${String(v)}`).join(' · ') }] : []),
          ]}
        />
        {rights.partnersManage ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {r.status === 'submitted' ? (
              <>
                <Button variant="primary" size="sm" onClick={() => setDlg('approve')} aria-label={t('partnerRequests.approveOne', { no: r.doc_no })}>
                  {t('partnerRequests.approve')}
                </Button>
                <Button size="sm" onClick={() => setDlg('reject')} aria-label={t('partnerRequests.rejectOne', { no: r.doc_no })}>
                  {t('partnerRequests.reject')}
                </Button>
              </>
            ) : null}
            {r.status === 'approved' && r.kind === 'withdraw' ? (
              <Button variant="primary" size="sm" onClick={() => setDlg('pay')} aria-label={t('partnerRequests.payOne', { no: r.doc_no })}>
                {t('partnerRequests.pay')}
              </Button>
            ) : null}
            {r.status === 'approved' && (r.kind === 'loan_to_partner' || r.kind === 'loan_from_partner') ? (
              <Link to={`/accounts/directors-and-investment?company=${r.company_id}`}>{t('partnerRequests.recordLoan')}</Link>
            ) : null}
          </div>
        ) : null}
      </div>
      {dlg === 'approve' || dlg === 'reject' ? <DecideDialog r={r} decision={dlg} onClose={() => setDlg(null)} /> : null}
      {dlg === 'pay' ? <PayDialog r={r} onClose={() => setDlg(null)} /> : null}
    </Card>
  )
}

function DecideDialog({ r, decision, onClose }: { r: Req; decision: 'approve' | 'reject'; onClose: () => void }) {
  const { t } = useTranslation()
  const [f, setF] = useState({ amount: '', note: '' })
  const save = useApiMutation<{ p_request_id: string; p_decision: string; p_amount: string | null; p_note: string | null }>('decide_partner_request', OPS_REFRESH)
  const money = r.kind === 'withdraw' || r.kind === 'loan_to_partner' || r.kind === 'loan_from_partner'
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t(`partnerRequests.decide.${decision}Title`, { no: r.doc_no })}
      description={decision === 'approve' ? (r.kind === 'loan_to_partner' ? t('partnerRequests.decide.loanHint') : t('partnerRequests.decide.approveHint')) : t('partnerRequests.decide.rejectHint')}
      submitLabel={t(`partnerRequests.${decision}`)}
      busy={save.isPending}
      error={<OpsErrorBox error={save.error} />}
      onSubmit={() => save.mutate({ p_request_id: r.id, p_decision: decision, p_amount: decision === 'approve' && money && f.amount.trim() ? f.amount.trim() : null, p_note: f.note.trim() || null }, { onSuccess: onClose })}
    >
      {decision === 'approve' && money ? <Field label={t('partnerRequests.decide.amount')} inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} help={t('partnerRequests.decide.amountHelp')} /> : null}
      <TextAreaField label={decision === 'reject' ? t('partnerRequests.decide.reason') : t('partnerRequests.decide.note')} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} rows={3} />
    </FormDialog>
  )
}

function PayDialog({ r, onClose }: { r: Req; onClose: () => void }) {
  const { t } = useTranslation()
  const banks = useApiView('money_accounts', { eq: { company_id: r.company_id, kind: 'bank' }, order: 'name' })
  const [f, setF] = useState({ bank: '', paid_on: todayIst() })
  const save = useApiMutation<{ p_request_id: string; p: Record<string, unknown> }>('pay_partner_request', OPS_REFRESH)
  return (
    <FormDialog open onOpenChange={(o) => (!o ? onClose() : undefined)} title={t('partnerRequests.payTitle', { no: r.doc_no })} description={t('partnerRequests.payHint')} submitLabel={t('partnerRequests.pay')} busy={save.isPending} error={<OpsErrorBox error={save.error} />} onSubmit={() => save.mutate({ p_request_id: r.id, p: { bank_account_id: f.bank || null, paid_on: f.paid_on } }, { onSuccess: onClose })}>
      <FieldGrid cols={2}>
        <SelectField label={t('partnerRequests.bank')} value={f.bank} onChange={(e) => setF({ ...f, bank: e.target.value })} placeholder={t('partnerRequests.choose')} options={rowsOf(banks).map((b) => ({ value: b.id, label: b.account_masked ? `${b.name} · ${b.account_masked}` : b.name }))} />
        <Field label={t('partnerRequests.paidOn')} type="date" value={f.paid_on} onChange={(e) => setF({ ...f, paid_on: e.target.value })} />
      </FieldGrid>
    </FormDialog>
  )
}

function SubmitDialog({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const partners = useApiView('v_partners', { eq: { company_id: companyId, status: 'active' }, order: 'display_name' })
  const projects = useApiView('v_partner_projects', { eq: { company_id: companyId }, order: 'name' })
  const [f, setF] = useState({ partner: '', kind: 'withdraw', source: 'land_rent', amount: '', repay_months: '', repay_from: '', project: '', purpose: '' })
  const save = useApiMutation<{ p_kind: string; p: Record<string, unknown> }>('submit_partner_request', OPS_REFRESH)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const loan = f.kind === 'loan_to_partner' || f.kind === 'loan_from_partner'
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('partnerRequests.submit.title')}
      description={t('partnerRequests.submit.hint')}
      submitLabel={t('partnerRequests.submit.submit')}
      busy={save.isPending}
      wide
      error={<OpsErrorBox error={save.error} />}
      onSubmit={() =>
        save.mutate(
          {
            p_kind: f.kind,
            p: {
              partner_id: f.partner || null,
              source: f.kind === 'withdraw' ? f.source : null,
              amount: f.amount.trim() || null,
              repay_months: loan && f.repay_months.trim() ? f.repay_months.trim() : null,
              repay_from: loan && f.repay_from ? f.repay_from : null,
              project_id: f.project || null,
              purpose: f.purpose.trim() || null,
            },
          },
          { onSuccess: onClose },
        )
      }
    >
      <FieldGrid cols={2}>
        <SelectField label={t('partnerRequests.submit.partner')} value={f.partner} onChange={set('partner')} placeholder={t('partnerRequests.choose')} options={rowsOf(partners).map((p) => ({ value: p.id, label: p.display_name }))} />
        <SelectField label={t('partnerRequests.submit.kind')} value={f.kind} onChange={set('kind')} options={['withdraw', 'loan_to_partner', 'loan_from_partner', 'project_offer', 'info'].map((k) => ({ value: k, label: t(`partnerRequests.kind.${k}`) }))} />
        {f.kind === 'withdraw' ? <SelectField label={t('partnerRequests.f.source')} value={f.source} onChange={set('source')} options={['land_rent', 'incentive', 'dividend', 'investment'].map((s) => ({ value: s, label: t(`partnerRequests.source.${s}`) }))} /> : null}
        {f.kind !== 'info' ? <Field label={t('partnerRequests.f.amount')} inputMode="decimal" value={f.amount} onChange={set('amount')} /> : null}
        {loan ? <Field label={t('partnerRequests.submit.months')} inputMode="numeric" value={f.repay_months} onChange={set('repay_months')} /> : null}
        {loan ? <SelectField label={t('partnerRequests.submit.repayFrom')} value={f.repay_from} onChange={set('repay_from')} placeholder={t('partnerRequests.choose')} options={['land_rent', 'incentive', 'bank'].map((s) => ({ value: s, label: t(`partnerRequests.repayFrom.${s}`) }))} /> : null}
        {f.kind === 'project_offer' ? <SelectField label={t('partnerRequests.submit.project')} value={f.project} onChange={set('project')} placeholder={t('partnerRequests.submit.noProject')} options={rowsOf(projects).map((p) => ({ value: p.id, label: p.name }))} /> : null}
      </FieldGrid>
      <TextAreaField label={f.kind === 'info' ? t('partnerRequests.submit.question') : t('partnerRequests.f.purpose')} value={f.purpose} onChange={set('purpose')} rows={3} />
    </FormDialog>
  )
}

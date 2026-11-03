import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { TableCard } from '@/features/admin/import-data/layout'
import { formatDate, formatTime } from '@/shared/format'
import { Amount, Button, Card, Chip, DataTable, EmptyState, Field, FieldGrid, KeyValue, SelectField, Tabs, TextAreaField, type Column } from '@/ui'
import { Done, ExposurePanel, MdExceptionForm, NoRight, SALES_REFRESH, SalesErrorBox, SalesFrame, SalesStatus, ViewError, num, useExposure, useSalesRights } from '../sales-common/sales'

type CreditCustomer = ViewRow<'credit_customers'>
type Application = ViewRow<'credit_applications'>
type Tab = 'customers' | 'applications' | 'exceptions'

const STAGES = [1, 2, 3, 4, 5, 6, 7] as const
/** Which right decides each stage (the server checks it again: api.approve_credit_stage). */
const STAGE_RIGHT: Record<number, 'creditEndorse' | 'creditVerify' | 'creditRecommend' | 'creditApprove'> = { 3: 'creditEndorse', 4: 'creditVerify', 5: 'creditRecommend', 6: 'creditApprove' }

/**
 * Credit customers (`CreditControl`): who may buy on credit, how much and who approved it. Credit starts only at stage 7
 * of the application (api.submit_credit_application → api.approve_credit_stage 3…6), each stage decided by a different
 * person who did not ask for it (sod.own_request, credit.same_person — server rules). The exposure check and the MD
 * exception are the server's (api.check_credit_exposure, api.grant_md_exception). Non-Admin users see GST figures only.
 */
export function CreditCustomersPage() {
  const { t } = useTranslation()
  return (
    <SalesFrame title={t('creditCustomers.title')} subtitle={t('creditCustomers.subtitle')}>
      {(companyId) => <Credit companyId={companyId} />}
    </SalesFrame>
  )
}

function StageStrip({ current }: { current?: number }) {
  const { t } = useTranslation()
  return (
    <ol aria-label={t('creditCustomers.stagesLabel')} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8 }}>
      {STAGES.map((s) => {
        const here = current === s
        const done = current !== undefined && s < current
        return (
          <li key={s} aria-current={here ? 'step' : undefined} className="sf-card sf-card__pad" style={{ padding: 10, borderColor: here ? 'var(--sf-primary)' : undefined }}>
            <p style={{ margin: 0, fontWeight: 700 }}>
              <span className="mono" style={{ marginRight: 6 }}>
                {s}
              </span>
              {t(`creditCustomers.stage.${s}.title`)}
              {done ? <span className="sr-only"> · {t('creditCustomers.stageDone')}</span> : null}
            </p>
            <p className="k" style={{ margin: '4px 0 0' }}>
              {t(`creditCustomers.stage.${s}.who`)}
            </p>
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 12.5 }}>
              {t(`creditCustomers.stage.${s}.what`)}
            </p>
          </li>
        )
      })}
    </ol>
  )
}

function Credit({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('customers')
  const [done, setDone] = useState<string | null>(null)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card title={t('creditCustomers.flowTitle')}>
        <StageStrip />
        <p className="k" style={{ margin: '10px 0 0' }}>
          {t('creditCustomers.flowRule')}
        </p>
      </Card>
      <Tabs<Tab>
        label={t('creditCustomers.tabs')}
        value={tab}
        onChange={(k) => { setDone(null); setTab(k) }}
        tabs={[
          { key: 'customers', label: t('creditCustomers.tab.customers') },
          { key: 'applications', label: t('creditCustomers.tab.applications') },
          { key: 'exceptions', label: t('creditCustomers.tab.exceptions') },
        ]}
      />
      <Done testId="credit-msg">{done}</Done>
      {tab === 'customers' ? <Customers companyId={companyId} onDone={setDone} /> : tab === 'applications' ? <Applications companyId={companyId} onDone={setDone} /> : <Exceptions companyId={companyId} />}
    </div>
  )
}

function Customers({ companyId, onDone }: { companyId: string; onDone: (m: string | null) => void }) {
  const { t } = useTranslation()
  const q = useApiView('credit_customers', { eq: { company_id: companyId }, order: 'party_name', limit: 2000 })
  const [openId, setOpenId] = useState<string | null>(null)
  const list = rowsOf(q)
  const current = list.find((c) => c.party_id === openId) ?? null
  const cols: Column<CreditCustomer>[] = [
    {
      key: 'name',
      header: t('creditCustomers.col.customer'),
      render: (c) => (
        <Button size="sm" variant="link" aria-label={t('creditCustomers.openCustomer', { name: c.party_name })} onClick={() => { onDone(null); setOpenId(c.party_id) }}>
          {c.party_name}
        </Button>
      ),
    },
    { key: 'kyc', header: t('creditCustomers.col.kyc'), render: (c) => <Chip tone={c.kyc_status === 'verified' ? 'success' : c.kyc_status === 'rejected' ? 'danger' : 'signal'}>{t(`creditCustomers.kyc.${c.kyc_status}`, { defaultValue: c.kyc_status })}</Chip> },
    { key: 'status', header: t('creditCustomers.col.status'), render: (c) => <SalesStatus status={c.credit_status} /> },
    { key: 'limit', header: t('creditCustomers.col.limit'), align: 'right', render: (c) => <Amount value={c.credit_limit} /> },
    { key: 'terms', header: t('creditCustomers.col.terms'), render: (c) => c.terms ?? '—' },
    { key: 'owed', header: t('creditCustomers.col.owed'), align: 'right', render: (c) => <Amount value={c.receivables} /> },
    { key: 'avail', header: t('creditCustomers.col.available'), align: 'right', render: (c) => <Amount value={c.available} /> },
    { key: 'review', header: t('creditCustomers.col.review'), render: (c) => (c.credit_review_on ? formatDate(c.credit_review_on) : '—') },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(320px, 2fr)', gap: 16, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <ViewError error={q.error} />
        <TableCard title={t('creditCustomers.customersTitle')}>
          <DataTable caption={t('creditCustomers.customersTitle')} columns={cols} rows={list} rowKey={(c) => c.party_id} loading={q.isLoading} minWidth={860} empty={<EmptyState title={t('creditCustomers.emptyTitle')} body={t('creditCustomers.emptyBody')} />} />
        </TableCard>
      </div>
      {current ? <CustomerPanel key={current.party_id} c={current} onDone={onDone} /> : <CleanUp />}
    </div>
  )
}

function CleanUp() {
  const { t } = useTranslation()
  return (
    <Card title={t('creditCustomers.mdTitle')}>
      <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {['names', 'finance', 'ends', 'noBypass', 'law'].map((k) => (
          <li key={k}>
            <strong>{t(`creditCustomers.md.${k}.title`)}</strong> {t(`creditCustomers.md.${k}.body`)}
          </li>
        ))}
      </ul>
      <p className="k" style={{ margin: '10px 0 0' }}>
        {t('creditCustomers.pickHint')}
      </p>
    </Card>
  )
}

function CustomerPanel({ c, onDone }: { c: CreditCustomer; onDone: (m: string | null) => void }) {
  const { t } = useTranslation()
  const rights = useSalesRights()
  const exposure = useExposure(c.company_id, c.party_id, 0)
  const terms = useApiView('credit_terms', { order: 'days' })
  const submit = useApiMutation<{ p: Record<string, unknown> }, { doc_no: string; stage: number }>('submit_credit_application', SALES_REFRESH)
  const status = useApiMutation<{ p_company_id: string; p_party_id: string; p_status: string; p_reason: string }, { ok: boolean }>('set_credit_status', SALES_REFRESH)
  const [f, setF] = useState({ limit: '', term: '', monthly: '', security: '', note: '' })
  const [st, setSt] = useState({ status: 'hold', reason: '' })
  const termList = rowsOf(terms).filter((x) => x.active && (!x.company_id || x.company_id === c.company_id))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card title={t('creditCustomers.exposureTitle', { name: c.party_name })}>
        <ExposurePanel data={exposure.data} testId="credit-exposure" />
        <SalesErrorBox error={exposure.error} />
      </Card>
      <Card title={t('creditCustomers.applyTitle')}>
        {rights.creditRequest ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <FieldGrid cols={2}>
              <Field label={t('creditCustomers.f.limit')} inputMode="decimal" value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} />
              <SelectField label={t('creditCustomers.f.terms')} value={f.term} onChange={(e) => setF({ ...f, term: e.target.value })} placeholder={t('salesCommon.choose')} options={termList.map((x) => ({ value: x.id, label: x.label }))} />
              <Field label={t('creditCustomers.f.monthly')} inputMode="decimal" value={f.monthly} onChange={(e) => setF({ ...f, monthly: e.target.value })} />
              <Field label={t('creditCustomers.f.security')} value={f.security} onChange={(e) => setF({ ...f, security: e.target.value })} />
            </FieldGrid>
            <TextAreaField label={t('creditCustomers.f.note')} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
            <div>
              <Button
                variant="primary"
                busy={submit.isPending}
                onClick={() =>
                  submit.mutate(
                    { p: { company_id: c.company_id, party_id: c.party_id, requested_limit: num(f.limit), requested_term_id: f.term || null, expected_monthly: num(f.monthly) || null, security: f.security.trim() || null, note: f.note.trim() || null } },
                    { onSuccess: (r) => { setF({ limit: '', term: '', monthly: '', security: '', note: '' }); onDone(t('creditCustomers.submitted', { no: r.doc_no })) } },
                  )
                }
              >
                {t('creditCustomers.submit')}
              </Button>
            </div>
            <SalesErrorBox error={submit.error} />
          </div>
        ) : (
          <NoRight>{t('creditCustomers.noRequest')}</NoRight>
        )}
      </Card>
      {rights.creditRecommend || rights.creditApprove ? (
        <Card title={t('creditCustomers.statusTitle')}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <FieldGrid cols={2}>
              <SelectField label={t('creditCustomers.f.newStatus')} value={st.status} onChange={(e) => setSt({ ...st, status: e.target.value })} options={['hold', 'review', 'active'].map((k) => ({ value: k, label: t(`salesCommon.status.${k}`) }))} />
              <Field label={t('creditCustomers.f.reason')} value={st.reason} onChange={(e) => setSt({ ...st, reason: e.target.value })} />
            </FieldGrid>
            <div>
              <Button busy={status.isPending} onClick={() => status.mutate({ p_company_id: c.company_id, p_party_id: c.party_id, p_status: st.status, p_reason: st.reason.trim() }, { onSuccess: () => onDone(t('creditCustomers.statusSet')) })}>
                {t('creditCustomers.setStatus')}
              </Button>
            </div>
            <SalesErrorBox error={status.error} />
          </div>
        </Card>
      ) : null}
      <Card title={t('creditCustomers.mdFormTitle')}>
        {rights.creditMd ? <MdExceptionForm companyId={c.company_id} partyId={c.party_id} onDone={(m) => onDone(m)} /> : <NoRight>{t('creditCustomers.noMd')}</NoRight>}
      </Card>
    </div>
  )
}

function Applications({ companyId, onDone }: { companyId: string; onDone: (m: string | null) => void }) {
  const { t } = useTranslation()
  const q = useApiView('credit_applications', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 500 })
  const [openId, setOpenId] = useState<string | null>(null)
  const list = rowsOf(q)
  const current = list.find((a) => a.id === openId) ?? null
  const cols: Column<Application>[] = [
    {
      key: 'no',
      header: t('creditCustomers.app.no'),
      render: (a) => (
        <Button size="sm" variant="link" aria-label={t('creditCustomers.app.open', { no: a.doc_no })} onClick={() => { onDone(null); setOpenId(a.id) }}>
          <span className="mono">{a.doc_no}</span>
        </Button>
      ),
    },
    { key: 'party', header: t('creditCustomers.col.customer'), render: (a) => a.party_name ?? '—' },
    { key: 'limit', header: t('creditCustomers.app.asked'), align: 'right', render: (a) => <Amount value={a.requested_limit} /> },
    { key: 'stage', header: t('creditCustomers.app.stage'), render: (a) => <span data-testid="app-stage">{t('creditCustomers.app.stageN', { n: a.stage, name: t(`creditCustomers.stage.${a.stage}.title`) })}</span> },
    { key: 'status', header: t('common.status'), render: (a) => <SalesStatus status={a.status} /> },
    { key: 'by', header: t('creditCustomers.app.by'), render: (a) => a.requested_by_name ?? '—' },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(320px, 2fr)', gap: 16, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <ViewError error={q.error} />
        <TableCard title={t('creditCustomers.app.title')}>
          <DataTable caption={t('creditCustomers.app.title')} columns={cols} rows={list} rowKey={(a) => a.id} loading={q.isLoading} minWidth={760} empty={<EmptyState title={t('creditCustomers.app.empty')} body={t('creditCustomers.app.emptyBody')} />} />
        </TableCard>
      </div>
      {current ? (
        <ApplicationPanel key={current.id} a={current} onDone={onDone} />
      ) : (
        <Card>
          <EmptyState title={t('creditCustomers.app.pick')} />
        </Card>
      )}
    </div>
  )
}

function ApplicationPanel({ a, onDone }: { a: Application; onDone: (m: string | null) => void }) {
  const { t } = useTranslation()
  const rights = useSalesRights()
  const approvals = useApiView('credit_approvals', { eq: { application_id: a.id }, order: 'stage' })
  const terms = useApiView('credit_terms', { order: 'days' })
  const decide = useApiMutation<{ p_application_id: string; p_stage: number; p_decision: string; p: Record<string, unknown> }, { status: string; stage: number }>('approve_credit_stage', SALES_REFRESH)
  const [f, setF] = useState({ limit: String(a.requested_limit ?? ''), term: a.requested_term_id ?? '', review: '', note: '' })
  const open = a.status === 'in_progress'
  const rightKey = STAGE_RIGHT[a.stage]
  const hasRight = rightKey ? rights[rightKey] : false
  const mine = rights.me !== null && a.requested_by === rights.me
  const decidedBefore = rowsOf(approvals).some((x) => x.decided_by === rights.me)
  function go(decision: 'approved' | 'rejected') {
    decide.mutate(
      { p_application_id: a.id, p_stage: a.stage, p_decision: decision, p: { limit: num(f.limit) || null, term_id: f.term || null, review_on: f.review || null, note: f.note.trim() || null } },
      { onSuccess: (r) => onDone(r.status === 'rejected' ? t('creditCustomers.app.rejected', { no: a.doc_no }) : r.status === 'active' ? t('creditCustomers.app.active', { no: a.doc_no }) : t('creditCustomers.app.moved', { no: a.doc_no, n: r.stage })) },
    )
  }
  const apCols: Column<ViewRow<'credit_approvals'>>[] = [
    { key: 'stage', header: t('creditCustomers.app.stage'), render: (x) => `${x.stage} · ${t(`creditCustomers.stage.${x.stage}.title`)}` },
    { key: 'dec', header: t('creditCustomers.app.decision'), render: (x) => <SalesStatus status={x.decision} /> },
    { key: 'by', header: t('creditCustomers.app.decidedBy'), render: (x) => x.decided_by_name ?? '—' },
    { key: 'at', header: t('creditCustomers.app.when'), render: (x) => `${formatDate(x.decided_at)} ${formatTime(x.decided_at)}` },
    { key: 'note', header: t('creditCustomers.app.note'), render: (x) => x.note ?? '—' },
  ]
  return (
    <Card title={t('creditCustomers.app.detail', { no: a.doc_no })}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0 }} data-testid="app-detail-stage">
          <SalesStatus status={a.status} /> {t('creditCustomers.app.stageN', { n: a.stage, name: t(`creditCustomers.stage.${a.stage}.title`) })}
        </p>
        <KeyValue
          rows={[
            { label: t('creditCustomers.col.customer'), value: a.party_name ?? '—' },
            { label: t('creditCustomers.app.asked'), value: <Amount value={a.requested_limit} rupee /> },
            { label: t('creditCustomers.f.terms'), value: a.requested_terms ?? '—' },
            { label: t('creditCustomers.f.monthly'), value: <Amount value={a.expected_monthly} rupee /> },
            { label: t('creditCustomers.app.by'), value: a.requested_by_name ?? '—' },
            ...(a.decided_limit !== null ? [{ label: t('creditCustomers.app.decidedLimit'), value: <Amount value={a.decided_limit} rupee /> }] : []),
            ...(a.review_on ? [{ label: t('creditCustomers.col.review'), value: formatDate(a.review_on) }] : []),
          ]}
        />
        {a.reject_reason ? <p className="muted" style={{ margin: 0 }}>{t('creditCustomers.app.rejectReason', { reason: a.reject_reason })}</p> : null}
        <DataTable caption={t('creditCustomers.app.history')} columns={apCols} rows={rowsOf(approvals)} rowKey={(x) => String(x.id)} loading={approvals.isLoading} minWidth={560} empty={<EmptyState title={t('creditCustomers.app.noDecisions')} />} />
        {open ? (
          <section aria-label={t('creditCustomers.app.decideTitle', { n: a.stage })} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>{t('creditCustomers.app.decideTitle', { n: a.stage })}</h3>
            <p className="k" style={{ margin: 0 }}>
              {t(`creditCustomers.stage.${a.stage}.who`)} · {t('creditCustomers.app.sodRule')}
            </p>
            {mine ? <Chip tone="signal">{t('creditCustomers.app.youAsked')}</Chip> : decidedBefore ? <Chip tone="signal">{t('creditCustomers.app.youDecided')}</Chip> : null}
            {a.stage === 6 ? (
              <FieldGrid cols={3}>
                <Field label={t('creditCustomers.f.approvedLimit')} inputMode="decimal" value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} />
                <SelectField label={t('creditCustomers.f.terms')} value={f.term} onChange={(e) => setF({ ...f, term: e.target.value })} placeholder={t('salesCommon.choose')} options={rowsOf(terms).filter((x) => x.active).map((x) => ({ value: x.id, label: x.label }))} />
                <Field label={t('creditCustomers.f.review')} type="date" value={f.review} onChange={(e) => setF({ ...f, review: e.target.value })} />
              </FieldGrid>
            ) : null}
            <Field label={t('creditCustomers.f.decisionNote')} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
            {hasRight ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button variant="primary" busy={decide.isPending} onClick={() => go('approved')}>
                  {t('creditCustomers.app.approve', { n: a.stage })}
                </Button>
                <Button variant="danger" busy={decide.isPending} onClick={() => go('rejected')}>
                  {t('creditCustomers.app.reject')}
                </Button>
              </div>
            ) : (
              <NoRight>{t('creditCustomers.app.noStageRight', { who: t(`creditCustomers.stage.${a.stage}.who`) })}</NoRight>
            )}
            <SalesErrorBox error={decide.error} />
          </section>
        ) : null}
      </div>
    </Card>
  )
}

function Exceptions({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const q = useApiView('credit_exceptions', { eq: { company_id: companyId }, order: 'granted_at', ascending: false, limit: 500 })
  const cols: Column<ViewRow<'credit_exceptions'>>[] = [
    { key: 'party', header: t('creditCustomers.col.customer'), render: (x) => x.party_name ?? '—' },
    { key: 'amount', header: t('creditCustomers.ex.amount'), align: 'right', render: (x) => <Amount value={x.amount} /> },
    { key: 'until', header: t('creditCustomers.ex.until'), render: (x) => `${formatDate(x.valid_until)} ${formatTime(x.valid_until)}` },
    { key: 'reason', header: t('creditCustomers.ex.reason'), render: (x) => x.reason },
    { key: 'by', header: t('creditCustomers.ex.by'), render: (x) => x.granted_by_name ?? '—' },
    { key: 'active', header: t('common.status'), render: (x) => <SalesStatus status={x.active ? 'active' : 'closed'} /> },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <ViewError error={q.error} />
      <TableCard title={t('creditCustomers.ex.title')}>
        <DataTable caption={t('creditCustomers.ex.title')} columns={cols} rows={rowsOf(q)} rowKey={(x) => x.id} loading={q.isLoading} minWidth={760} empty={<EmptyState title={t('creditCustomers.ex.empty')} body={t('creditCustomers.ex.emptyBody')} />} />
      </TableCard>
    </div>
  )
}

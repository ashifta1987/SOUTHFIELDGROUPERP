import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { formatDate, formatTime } from '@/shared/format'
import { Amount, Button, Card, Checkbox, DataTable, EmptyState, Field, FieldGrid, KeyValue, SelectField, Tabs, TextAreaField, type Column } from '@/ui'
import { Done, NoRight, ReasonAction, SALES_REFRESH, SalesErrorBox, SalesFrame, SalesStatus, ViewError, num, useCustomers, useSalesRights } from '../sales-common/sales'

type Tab = 'coverage' | 'reminders' | 'complaints' | 'privateLabel' | 'agents' | 'queries'
type Complaint = ViewRow<'complaints'>

/**
 * Customer care, reminders and agents (`SalesControls`): coverage tiers and the call log (api.set_coverage_tier,
 * api.set_customer_tier, api.log_call), payment reminders (scheduled by the server, shown on WhatsApp & email),
 * complaints with a QC hold on the batch everywhere (api.log_complaint, api.qc_hold_batch, api.qc_release_hold,
 * api.update_complaint, api.close_complaint), private label with three approvals by three other people, agents and their
 * commission on verified collections only (api.upsert_agent, api.accrue_agent_commissions), and customer queries.
 */
export function CustomerCarePage() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('complaints')
  const [done, setDone] = useState<string | null>(null)
  return (
    <SalesFrame title={t('customerCare.title')} subtitle={t('customerCare.subtitle')}>
      {(companyId) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Tabs<Tab>
            label={t('customerCare.tabs')}
            value={tab}
            onChange={(k) => { setDone(null); setTab(k) }}
            tabs={(['coverage', 'reminders', 'complaints', 'privateLabel', 'agents', 'queries'] as Tab[]).map((k) => ({ key: k, label: t(`customerCare.tab.${k}`) }))}
          />
          <Done testId="care-msg">{done}</Done>
          {tab === 'coverage' ? <Coverage companyId={companyId} onDone={setDone} /> : null}
          {tab === 'reminders' ? <Reminders /> : null}
          {tab === 'complaints' ? <Complaints companyId={companyId} onDone={setDone} /> : null}
          {tab === 'privateLabel' ? <PrivateLabel companyId={companyId} onDone={setDone} /> : null}
          {tab === 'agents' ? <Agents companyId={companyId} onDone={setDone} /> : null}
          {tab === 'queries' ? <Queries companyId={companyId} onDone={setDone} /> : null}
        </div>
      )}
    </SalesFrame>
  )
}

const TWO = { display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(320px, 2fr)', gap: 16, alignItems: 'start' } as const

/* ───────── Coverage ───────── */
function Coverage({ companyId, onDone }: { companyId: string; onDone: (m: string | null) => void }) {
  const { t } = useTranslation()
  const rights = useSalesRights()
  const tiers = useApiView('coverage_tiers', { eq: { company_id: companyId }, order: 'tier' })
  const status = useApiView('coverage_status', { eq: { company_id: companyId }, order: 'party_name', limit: 2000 })
  const attempts = useApiView('contact_attempts', { eq: { company_id: companyId }, order: 'at', ascending: false, limit: 100 })
  const customers = useCustomers(companyId)
  const setTier = useApiMutation<{ p: Record<string, unknown> }>('set_coverage_tier', SALES_REFRESH)
  const custTier = useApiMutation<{ p_company_id: string; p_party_id: string; p_tier: string }>('set_customer_tier', SALES_REFRESH)
  const call = useApiMutation<{ p: Record<string, unknown> }>('log_call', SALES_REFRESH)
  const [tf, setTf] = useState({ tier: '', call: '', visit: '', grace: '0' })
  const [ct, setCt] = useState({ party: '', tier: '' })
  const [cf, setCf] = useState({ party: '', outcome: 'reached', note: '', next: '' })
  const tierCols: Column<ViewRow<'coverage_tiers'>>[] = [
    { key: 'tier', header: t('customerCare.cov.tier'), render: (r) => r.tier },
    { key: 'call', header: t('customerCare.cov.call'), align: 'right', render: (r) => (r.call_every_days ? t('customerCare.cov.everyDays', { n: r.call_every_days }) : '—') },
    { key: 'visit', header: t('customerCare.cov.visit'), align: 'right', render: (r) => (r.visit_every_days ? t('customerCare.cov.everyDays', { n: r.visit_every_days }) : '—') },
    { key: 'grace', header: t('customerCare.cov.grace'), align: 'right', render: (r) => r.grace_days },
  ]
  const statusCols: Column<ViewRow<'coverage_status'>>[] = [
    { key: 'name', header: t('customerCare.col.customer'), render: (r) => r.party_name },
    { key: 'tier', header: t('customerCare.cov.tier'), render: (r) => r.tier ?? '—' },
    { key: 'lastCall', header: t('customerCare.cov.lastCall'), render: (r) => (r.last_call ? formatDate(r.last_call) : '—') },
    { key: 'lastVisit', header: t('customerCare.cov.lastVisit'), render: (r) => (r.last_visit ? formatDate(r.last_visit) : '—') },
    { key: 'due', header: t('customerCare.cov.due'), render: (r) => (r.call_missed || r.visit_missed ? <SalesStatus status="blocked" /> : r.call_due || r.visit_due ? <SalesStatus status="open" /> : '—') },
  ]
  const attemptCols: Column<ViewRow<'contact_attempts'>>[] = [
    { key: 'at', header: t('customerCare.col.when'), render: (r) => `${formatDate(r.at)} ${formatTime(r.at)}` },
    { key: 'kind', header: t('customerCare.cov.kind'), render: (r) => t(`customerCare.cov.kinds.${r.kind}`, { defaultValue: r.kind }) },
    { key: 'outcome', header: t('customerCare.cov.outcome'), render: (r) => t(`customerCare.cov.outcomes.${r.outcome}`, { defaultValue: r.outcome }) },
    { key: 'note', header: t('customerCare.cov.note'), render: (r) => r.note ?? '—' },
    { key: 'by', header: t('customerCare.col.by'), render: (r) => r.by_name ?? '—' },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <ViewError error={tiers.error ?? status.error ?? attempts.error} />
      <div style={TWO}>
        <TableCard title={t('customerCare.cov.tiersTitle')}>
          <DataTable caption={t('customerCare.cov.tiersTitle')} columns={tierCols} rows={rowsOf(tiers)} rowKey={(r) => r.tier} loading={tiers.isLoading} minWidth={480} empty={<EmptyState title={t('customerCare.cov.noTiers')} body={t('customerCare.cov.noTiersBody')} />} />
        </TableCard>
        <Card title={t('customerCare.cov.setTitle')}>
          {rights.fieldManage ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <FieldGrid cols={2}>
                <Field label={t('customerCare.cov.tier')} value={tf.tier} onChange={(e) => setTf({ ...tf, tier: e.target.value })} />
                <Field label={t('customerCare.cov.callDays')} inputMode="numeric" value={tf.call} onChange={(e) => setTf({ ...tf, call: e.target.value })} />
                <Field label={t('customerCare.cov.visitDays')} inputMode="numeric" value={tf.visit} onChange={(e) => setTf({ ...tf, visit: e.target.value })} />
                <Field label={t('customerCare.cov.grace')} inputMode="numeric" value={tf.grace} onChange={(e) => setTf({ ...tf, grace: e.target.value })} />
              </FieldGrid>
              <div>
                <Button busy={setTier.isPending} onClick={() => setTier.mutate({ p: { company_id: companyId, tier: tf.tier.trim(), call_every_days: num(tf.call) || null, visit_every_days: num(tf.visit) || null, grace_days: num(tf.grace) || '0' } }, { onSuccess: () => onDone(t('customerCare.cov.tierSaved', { tier: tf.tier })) })}>
                  {t('customerCare.cov.saveTier')}
                </Button>
              </div>
              <SalesErrorBox error={setTier.error} />
              <FieldGrid cols={2}>
                <SelectField label={t('customerCare.col.customer')} value={ct.party} onChange={(e) => setCt({ ...ct, party: e.target.value })} placeholder={t('salesCommon.choose')} options={customers.list.map((c) => ({ value: c.id, label: c.name }))} />
                <SelectField label={t('customerCare.cov.customerTier')} value={ct.tier} onChange={(e) => setCt({ ...ct, tier: e.target.value })} placeholder={t('salesCommon.choose')} options={rowsOf(tiers).map((r) => ({ value: r.tier, label: r.tier }))} />
              </FieldGrid>
              <div>
                <Button busy={custTier.isPending} onClick={() => custTier.mutate({ p_company_id: companyId, p_party_id: ct.party, p_tier: ct.tier }, { onSuccess: () => onDone(t('customerCare.cov.customerTierSaved')) })}>
                  {t('customerCare.cov.setCustomerTier')}
                </Button>
              </div>
              <SalesErrorBox error={custTier.error} />
            </div>
          ) : (
            <NoRight>{t('customerCare.cov.noManage')}</NoRight>
          )}
        </Card>
      </div>
      <div style={TWO}>
        <TableCard title={t('customerCare.cov.statusTitle')}>
          <DataTable caption={t('customerCare.cov.statusTitle')} columns={statusCols} rows={rowsOf(status)} rowKey={(r) => r.party_id} loading={status.isLoading} minWidth={620} empty={<EmptyState title={t('customerCare.cov.noStatus')} />} />
        </TableCard>
        <Card title={t('customerCare.cov.callTitle')}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <SelectField label={t('customerCare.col.customer')} value={cf.party} onChange={(e) => setCf({ ...cf, party: e.target.value })} placeholder={t('salesCommon.choose')} options={customers.list.map((c) => ({ value: c.id, label: c.name }))} />
            <SelectField label={t('customerCare.cov.outcome')} value={cf.outcome} onChange={(e) => setCf({ ...cf, outcome: e.target.value })} options={['reached', 'no_answer', 'deferred'].map((k) => ({ value: k, label: t(`customerCare.cov.outcomes.${k}`) }))} />
            <Field label={t('customerCare.cov.note')} value={cf.note} onChange={(e) => setCf({ ...cf, note: e.target.value })} />
            <Field label={t('customerCare.cov.next')} value={cf.next} onChange={(e) => setCf({ ...cf, next: e.target.value })} />
            <div>
              <Button busy={call.isPending} onClick={() => call.mutate({ p: { company_id: companyId, party_id: cf.party, outcome: cf.outcome, note: cf.note.trim() || null, next_action: cf.next.trim() || null } }, { onSuccess: () => { setCf({ party: '', outcome: 'reached', note: '', next: '' }); onDone(t('customerCare.cov.callSaved')) } })}>
                {t('customerCare.cov.logCall')}
              </Button>
            </div>
            <p className="k" style={{ margin: 0 }}>
              {t('customerCare.cov.callRule')}
            </p>
            <SalesErrorBox error={call.error} />
          </div>
        </Card>
      </div>
      <TableCard title={t('customerCare.cov.attemptsTitle')}>
        <DataTable caption={t('customerCare.cov.attemptsTitle')} columns={attemptCols} rows={rowsOf(attempts)} rowKey={(r) => String(r.id)} loading={attempts.isLoading} minWidth={620} empty={<EmptyState title={t('customerCare.cov.noAttempts')} />} />
      </TableCard>
    </div>
  )
}

/* ───────── Reminders ───────── */
function Reminders() {
  const { t } = useTranslation()
  return (
    <Card title={t('customerCare.rem.title')}>
      <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {['days', 'consent', 'caps', 'admin'].map((k) => (
          <li key={k}>{t(`customerCare.rem.${k}`)}</li>
        ))}
      </ul>
      <p style={{ margin: '12px 0 0' }}>
        <Link to="/admin/whatsapp-and-email" className="sf-btn" data-variant="secondary">
          {t('customerCare.rem.open')}
        </Link>
      </p>
    </Card>
  )
}

/* ───────── Complaints ───────── */
function Complaints({ companyId, onDone }: { companyId: string; onDone: (m: string | null) => void }) {
  const { t } = useTranslation()
  const rights = useSalesRights()
  const q = useApiView('complaints', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 500 })
  const [openId, setOpenId] = useState<string | null>(null)
  const list = rowsOf(q)
  const current = list.find((c) => c.id === openId) ?? null
  const cols: Column<Complaint>[] = [
    {
      key: 'no',
      header: t('customerCare.cmp.no'),
      render: (c) => (
        <Button size="sm" variant="link" aria-label={t('customerCare.cmp.open', { no: c.doc_no })} onClick={() => { onDone(null); setOpenId(c.id) }}>
          <span className="mono">{c.doc_no}</span>
        </Button>
      ),
    },
    { key: 'date', header: t('customerCare.col.when'), render: (c) => formatDate(c.created_at) },
    { key: 'party', header: t('customerCare.col.customer'), render: (c) => c.party_name ?? '—' },
    { key: 'item', header: t('customerCare.cmp.item'), render: (c) => (c.product_name ? `${c.product_name}${c.lot_no ? ` · ${c.lot_no}` : ''}` : '—') },
    { key: 'sev', header: t('customerCare.cmp.severity'), render: (c) => t(`customerCare.cmp.sev.${c.severity}`, { defaultValue: c.severity }) },
    { key: 'status', header: t('common.status'), render: (c) => <SalesStatus status={c.status} /> },
  ]
  return (
    <div style={TWO}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <ViewError error={q.error} />
        <TableCard
          title={t('customerCare.cmp.title')}
          action={
            current && rights.create ? (
              <Button size="sm" onClick={() => setOpenId(null)}>
                {t('customerCare.cmp.newShort')}
              </Button>
            ) : null
          }
        >
          <DataTable caption={t('customerCare.cmp.title')} columns={cols} rows={list} rowKey={(c) => c.id} loading={q.isLoading} minWidth={720} empty={<EmptyState title={t('customerCare.cmp.empty')} body={t('customerCare.cmp.emptyBody')} />} />
        </TableCard>
      </div>
      {current ? <ComplaintPanel key={current.id} c={current} onDone={onDone} /> : <NewComplaint companyId={companyId} onSaved={(m, id) => { onDone(m); setOpenId(id) }} />}
    </div>
  )
}

function NewComplaint({ companyId, onSaved }: { companyId: string; onSaved: (m: string, id: string) => void }) {
  const { t } = useTranslation()
  const rights = useSalesRights()
  const customers = useCustomers(companyId)
  const lots = useApiView('lots', { eq: { company_id: companyId }, order: 'received_at', ascending: false, limit: 1000 })
  const save = useApiMutation<{ p: Record<string, unknown> }, { id: string; doc_no: string }>('log_complaint', SALES_REFRESH)
  const [f, setF] = useState({ party: '', lot: '', kind: 'product', severity: 'medium', description: '' })
  if (!rights.create) {
    return (
      <Card title={t('customerCare.cmp.newTitle')}>
        <NoRight>{t('customerCare.cmp.noCreate')}</NoRight>
      </Card>
    )
  }
  return (
    <Card title={t('customerCare.cmp.newTitle')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <SelectField label={t('customerCare.col.customer')} value={f.party} onChange={(e) => setF({ ...f, party: e.target.value })} placeholder={t('salesCommon.choose')} options={customers.list.map((c) => ({ value: c.id, label: c.name }))} />
        <SelectField label={t('customerCare.cmp.lot')} value={f.lot} onChange={(e) => setF({ ...f, lot: e.target.value })} placeholder={t('customerCare.cmp.noLot')} options={rowsOf(lots).map((l) => ({ value: l.id, label: `${l.lot_no} · ${l.product_code} · ${l.product_name}` }))} />
        <FieldGrid cols={2}>
          <SelectField label={t('customerCare.cmp.kind')} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} options={['product', 'billing', 'delivery', 'price_scheme', 'return', 'other'].map((k) => ({ value: k, label: t(`customerCare.cmp.kinds.${k}`) }))} />
          <SelectField label={t('customerCare.cmp.severity')} value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })} options={['low', 'medium', 'high'].map((k) => ({ value: k, label: t(`customerCare.cmp.sev.${k}`) }))} />
        </FieldGrid>
        <TextAreaField label={t('customerCare.cmp.description')} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <div>
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate({ p: { company_id: companyId, party_id: f.party, lot_id: f.lot || null, kind: f.kind, severity: f.severity, description: f.description.trim() } }, { onSuccess: (r) => onSaved(t('customerCare.cmp.logged', { no: r.doc_no }), r.id) })}>
            {t('customerCare.cmp.log')}
          </Button>
        </div>
        <p className="k" style={{ margin: 0 }}>
          {t('customerCare.cmp.rule')}
        </p>
        <SalesErrorBox error={save.error} />
      </div>
    </Card>
  )
}

function ComplaintPanel({ c, onDone }: { c: Complaint; onDone: (m: string | null) => void }) {
  const { t } = useTranslation()
  const rights = useSalesRights()
  const events = useApiView('complaint_events', { eq: { complaint_id: c.id }, order: 'at' })
  const holdQ = useApiView('qc_holds', { eq: { id: c.qc_hold_id ?? '' }, enabled: Boolean(c.qc_hold_id) })
  const hold = c.qc_hold_id ? rowsOf(holdQ)[0] : undefined
  const holdM = useApiMutation<{ p: Record<string, unknown> }, { hold_id: string; qty_held: number }>('qc_hold_batch', SALES_REFRESH)
  const releaseM = useApiMutation<{ p_hold_id: string; p_decision: string; p_note: string }, { status: string }>('qc_release_hold', SALES_REFRESH)
  const update = useApiMutation<{ p_complaint_id: string; p: Record<string, unknown> }>('update_complaint', SALES_REFRESH)
  const close = useApiMutation<{ p_complaint_id: string; p_resolution: string }>('close_complaint', SALES_REFRESH)
  const [holdReason, setHoldReason] = useState('')
  const [decision, setDecision] = useState({ note: '' })
  const [st, setSt] = useState({ status: 'investigating', note: '' })
  const closed = c.status === 'closed'
  const evCols: Column<ViewRow<'complaint_events'>>[] = [
    { key: 'at', header: t('customerCare.col.when'), render: (e) => `${formatDate(e.at)} ${formatTime(e.at)}` },
    { key: 'to', header: t('common.status'), render: (e) => <SalesStatus status={e.to_status} /> },
    { key: 'note', header: t('customerCare.cov.note'), render: (e) => e.note ?? '—' },
    { key: 'by', header: t('customerCare.col.by'), render: (e) => e.by_name ?? '—' },
  ]
  return (
    <Card title={t('customerCare.cmp.detail', { no: c.doc_no })}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0 }} data-testid="complaint-status">
          <SalesStatus status={c.status} /> <span className="muted">{c.party_name}</span>
        </p>
        <p style={{ margin: 0 }}>{c.description}</p>
        <KeyValue
          rows={[
            { label: t('customerCare.cmp.item'), value: c.product_name ?? '—' },
            { label: t('customerCare.cmp.lot'), value: c.lot_no ?? '—' },
            { label: t('customerCare.cmp.loggedBy'), value: c.logged_by_name ?? '—' },
            { label: t('customerCare.cmp.hold'), value: <span data-testid="complaint-hold">{c.hold_status ? <SalesStatus status={c.hold_status} /> : '—'}</span> },
            ...(hold ? [{ label: t('customerCare.cmp.qtyHeld'), value: <span className="sf-amount">{hold.qty_held}</span> }] : []),
          ]}
        />
        {!closed && c.lot_id && !c.qc_hold_id ? (
          <section aria-label={t('customerCare.cmp.holdTitle')} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>{t('customerCare.cmp.holdTitle')}</h3>
            <p className="k" style={{ margin: 0 }}>
              {t('customerCare.cmp.holdRule')}
            </p>
            {rights.qcTest || rights.qcRelease ? (
              <>
                <Field label={t('customerCare.cmp.holdReason')} value={holdReason} onChange={(e) => setHoldReason(e.target.value)} />
                <div>
                  <Button variant="danger" busy={holdM.isPending} onClick={() => holdM.mutate({ p: { lot_id: c.lot_id, complaint_id: c.id, reason: holdReason.trim() } }, { onSuccess: (r) => onDone(t('customerCare.cmp.held', { qty: r.qty_held })) })}>
                    {t('customerCare.cmp.holdBatch')}
                  </Button>
                </div>
              </>
            ) : (
              <NoRight>{t('customerCare.cmp.noQc')}</NoRight>
            )}
            <SalesErrorBox error={holdM.error} />
          </section>
        ) : null}
        {hold && hold.status === 'on_hold' ? (
          <section aria-label={t('customerCare.cmp.decideTitle')} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>{t('customerCare.cmp.decideTitle')}</h3>
            {rights.qcRelease ? (
              <>
                <Field label={t('customerCare.cmp.finding')} value={decision.note} onChange={(e) => setDecision({ note: e.target.value })} />
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Button variant="primary" busy={releaseM.isPending} onClick={() => releaseM.mutate({ p_hold_id: hold.id, p_decision: 'release', p_note: decision.note.trim() }, { onSuccess: () => onDone(t('customerCare.cmp.releasedMsg')) })}>
                    {t('customerCare.cmp.releaseBatch')}
                  </Button>
                  <Button variant="danger" busy={releaseM.isPending} onClick={() => releaseM.mutate({ p_hold_id: hold.id, p_decision: 'reject', p_note: decision.note.trim() }, { onSuccess: () => onDone(t('customerCare.cmp.rejectedMsg')) })}>
                    {t('customerCare.cmp.rejectBatch')}
                  </Button>
                </div>
              </>
            ) : (
              <NoRight>{t('customerCare.cmp.noRelease')}</NoRight>
            )}
            <SalesErrorBox error={releaseM.error} />
          </section>
        ) : null}
        {!closed ? (
          <section aria-label={t('customerCare.cmp.progressTitle')} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>{t('customerCare.cmp.progressTitle')}</h3>
            <FieldGrid cols={2}>
              <SelectField label={t('customerCare.cmp.newStatus')} value={st.status} onChange={(e) => setSt({ ...st, status: e.target.value })} options={['investigating', 'resolved', 'rejected'].map((k) => ({ value: k, label: t(`salesCommon.status.${k}`) }))} />
              <Field label={t('customerCare.cov.note')} value={st.note} onChange={(e) => setSt({ ...st, note: e.target.value })} />
            </FieldGrid>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button busy={update.isPending} onClick={() => update.mutate({ p_complaint_id: c.id, p: { status: st.status, note: st.note.trim() || null } }, { onSuccess: () => onDone(t('customerCare.cmp.updated')) })}>
                {t('customerCare.cmp.update')}
              </Button>
              {rights.approve ? (
                <ReasonAction label={t('customerCare.cmp.close')} fieldLabel={t('customerCare.cmp.resolution')} busy={close.isPending} onConfirm={(r) => close.mutate({ p_complaint_id: c.id, p_resolution: r }, { onSuccess: () => onDone(t('customerCare.cmp.closedMsg')) })} />
              ) : null}
            </div>
            <p className="k" style={{ margin: 0 }}>
              {t('customerCare.cmp.closeRule')}
            </p>
            <SalesErrorBox error={update.error ?? close.error} />
          </section>
        ) : (
          <p className="muted" style={{ margin: 0 }}>{t('customerCare.cmp.resolutionWas', { text: c.resolution ?? '—' })}</p>
        )}
        <DataTable caption={t('customerCare.cmp.events')} columns={evCols} rows={rowsOf(events)} rowKey={(e) => String(e.id)} loading={events.isLoading} minWidth={480} empty={<EmptyState title={t('customerCare.cmp.noEvents')} />} />
      </div>
    </Card>
  )
}

/* ───────── Private label ───────── */
function PrivateLabel({ companyId, onDone }: { companyId: string; onDone: (m: string | null) => void }) {
  const { t } = useTranslation()
  const rights = useSalesRights()
  const q = useApiView('private_label_orders', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 300 })
  const customers = useCustomers(companyId)
  const submit = useApiMutation<{ p: Record<string, unknown> }>('submit_private_label', SALES_REFRESH)
  const approve = useApiMutation<{ p_id: string; p_stage: string; p_approve: boolean; p_note: string | null }, { status: string }>('approve_private_label', SALES_REFRESH)
  const [f, setF] = useState({ party: '', brand: '', spec: '' })
  const [note, setNote] = useState('')
  const stageCan = { sales: rights.approve, quality: rights.qcRelease, md: rights.creditApprove } as Record<string, boolean>
  const cols: Column<ViewRow<'private_label_orders'>>[] = [
    { key: 'brand', header: t('customerCare.pl.brand'), render: (r) => r.brand_name },
    { key: 'party', header: t('customerCare.col.customer'), render: (r) => r.party_name ?? '—' },
    { key: 'sales', header: t('customerCare.pl.stage.sales'), render: (r) => (r.sales_approved_by ? <SalesStatus status="approved" /> : '—') },
    { key: 'quality', header: t('customerCare.pl.stage.quality'), render: (r) => (r.quality_approved_by ? <SalesStatus status="approved" /> : '—') },
    { key: 'md', header: t('customerCare.pl.stage.md'), render: (r) => (r.md_approved_by ? <SalesStatus status="approved" /> : '—') },
    { key: 'status', header: t('common.status'), render: (r) => <SalesStatus status={r.status} /> },
    {
      key: 'act',
      header: t('customerCare.pl.decide'),
      render: (r) =>
        r.status === 'submitted' ? (
          <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {(['sales', 'quality', 'md'] as const)
              .filter((s) => stageCan[s] && !r[`${s === 'md' ? 'md' : s}_approved_by` as 'sales_approved_by'])
              .map((s) => (
                <Button key={s} size="sm" busy={approve.isPending} onClick={() => approve.mutate({ p_id: r.id, p_stage: s, p_approve: true, p_note: note.trim() || null }, { onSuccess: (x) => onDone(t('customerCare.pl.decided', { status: t(`salesCommon.status.${x.status}`) })) })}>
                  {t('customerCare.pl.approveAs', { stage: t(`customerCare.pl.stage.${s}`) })}
                </Button>
              ))}
          </span>
        ) : (
          '—'
        ),
    },
  ]
  return (
    <div style={TWO}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <ViewError error={q.error} />
        <TableCard title={t('customerCare.pl.title')}>
          <DataTable caption={t('customerCare.pl.title')} columns={cols} rows={rowsOf(q)} rowKey={(r) => r.id} loading={q.isLoading} minWidth={860} empty={<EmptyState title={t('customerCare.pl.empty')} />} />
        </TableCard>
        <Field label={t('customerCare.pl.note')} value={note} onChange={(e) => setNote(e.target.value)} />
        <SalesErrorBox error={approve.error} />
      </div>
      <Card title={t('customerCare.pl.newTitle')}>
        {rights.create ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <SelectField label={t('customerCare.col.customer')} value={f.party} onChange={(e) => setF({ ...f, party: e.target.value })} placeholder={t('salesCommon.choose')} options={customers.list.map((c) => ({ value: c.id, label: c.name }))} />
            <Field label={t('customerCare.pl.brand')} value={f.brand} onChange={(e) => setF({ ...f, brand: e.target.value })} />
            <TextAreaField label={t('customerCare.pl.spec')} value={f.spec} onChange={(e) => setF({ ...f, spec: e.target.value })} />
            <div>
              <Button variant="primary" busy={submit.isPending} onClick={() => submit.mutate({ p: { company_id: companyId, party_id: f.party, brand_name: f.brand.trim(), spec: { note: f.spec.trim() } } }, { onSuccess: () => { setF({ party: '', brand: '', spec: '' }); onDone(t('customerCare.pl.submitted')) } })}>
                {t('customerCare.pl.submit')}
              </Button>
            </div>
            <p className="k" style={{ margin: 0 }}>
              {t('customerCare.pl.rule')}
            </p>
            <SalesErrorBox error={submit.error} />
          </div>
        ) : (
          <NoRight>{t('customerCare.cmp.noCreate')}</NoRight>
        )}
      </Card>
    </div>
  )
}

/* ───────── Agents ───────── */
function Agents({ companyId, onDone }: { companyId: string; onDone: (m: string | null) => void }) {
  const { t } = useTranslation()
  const rights = useSalesRights()
  const agents = useApiView('agents', { eq: { company_id: companyId }, order: 'party_name' })
  const comm = useApiView('agent_commissions', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 300 })
  const customers = useCustomers(companyId)
  const upsert = useApiMutation<{ p: Record<string, unknown> }>('upsert_agent', SALES_REFRESH)
  const accrue = useApiMutation<{ p_company_id: string; p_from: string; p_to: string }, { accrued: number; commission: number }>('accrue_agent_commissions', SALES_REFRESH)
  const [f, setF] = useState<{ party: string; model: string; pct: string; customers: string[] }>({ party: '', model: 'A', pct: '', customers: [] })
  const [period, setPeriod] = useState({ from: `${todayIst().slice(0, 8)}01`, to: todayIst() })
  const agentCols: Column<ViewRow<'agents'>>[] = [
    { key: 'name', header: t('customerCare.ag.agent'), render: (r) => r.party_name ?? '—' },
    { key: 'model', header: t('customerCare.ag.model'), render: (r) => r.model },
    { key: 'pct', header: t('customerCare.ag.pct'), align: 'right', render: (r) => `${r.commission_pct} %` },
    { key: 'cust', header: t('customerCare.ag.customers'), align: 'right', render: (r) => r.customers ?? 0 },
    { key: 'acc', header: t('customerCare.ag.accrued'), align: 'right', render: (r) => <Amount value={r.commission_accrued} /> },
    { key: 'status', header: t('common.status'), render: (r) => <SalesStatus status={r.status} /> },
  ]
  const commCols: Column<ViewRow<'agent_commissions'>>[] = [
    { key: 'inv', header: t('customerCare.ag.invoice'), render: (r) => <span className="mono">{r.invoice_no ?? '—'}</span> },
    { key: 'rcpt', header: t('customerCare.ag.receipt'), render: (r) => <span className="mono">{r.receipt_no ?? '—'}</span> },
    { key: 'coll', header: t('customerCare.ag.collected'), align: 'right', render: (r) => <Amount value={r.collected} /> },
    { key: 'comm', header: t('customerCare.ag.commission'), align: 'right', render: (r) => <Amount value={r.commission} /> },
    { key: 'period', header: t('customerCare.ag.period'), render: (r) => `${formatDate(r.period_from)} – ${formatDate(r.period_to)}` },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <ViewError error={agents.error ?? comm.error} />
      <div style={TWO}>
        <TableCard title={t('customerCare.ag.title')}>
          <DataTable caption={t('customerCare.ag.title')} columns={agentCols} rows={rowsOf(agents)} rowKey={(r) => r.id} loading={agents.isLoading} minWidth={620} empty={<EmptyState title={t('customerCare.ag.empty')} />} />
        </TableCard>
        <Card title={t('customerCare.ag.newTitle')}>
          {rights.approve ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <SelectField label={t('customerCare.ag.agent')} value={f.party} onChange={(e) => setF({ ...f, party: e.target.value })} placeholder={t('salesCommon.choose')} options={customers.list.map((c) => ({ value: c.id, label: c.name }))} />
              <FieldGrid cols={2}>
                <SelectField label={t('customerCare.ag.model')} value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} options={['A', 'B', 'C', 'D'].map((k) => ({ value: k, label: t(`customerCare.ag.models.${k}`) }))} />
                <Field label={t('customerCare.ag.pct')} inputMode="decimal" value={f.pct} onChange={(e) => setF({ ...f, pct: e.target.value })} />
              </FieldGrid>
              <fieldset style={{ border: 0, padding: 0, margin: 0, maxHeight: 180, overflowY: 'auto' }}>
                <legend className="sf-field__label">{t('customerCare.ag.theirCustomers')}</legend>
                {customers.list
                  .filter((c) => c.id !== f.party)
                  .map((c) => (
                    <Checkbox key={c.id} label={c.name} checked={f.customers.includes(c.id)} onChange={(e) => setF({ ...f, customers: e.target.checked ? [...f.customers, c.id] : f.customers.filter((x) => x !== c.id) })} />
                  ))}
              </fieldset>
              <div>
                <Button variant="primary" busy={upsert.isPending} onClick={() => upsert.mutate({ p: { company_id: companyId, party_id: f.party, model: f.model.trim() || 'A', commission_pct: num(f.pct), customers: f.customers } }, { onSuccess: () => onDone(t('customerCare.ag.saved')) })}>
                  {t('customerCare.ag.save')}
                </Button>
              </div>
              <SalesErrorBox error={upsert.error} />
            </div>
          ) : (
            <NoRight>{t('customerCare.ag.noManage')}</NoRight>
          )}
        </Card>
      </div>
      <div style={TWO}>
        <TableCard title={t('customerCare.ag.commTitle')}>
          <DataTable caption={t('customerCare.ag.commTitle')} columns={commCols} rows={rowsOf(comm)} rowKey={(r) => String(r.id)} loading={comm.isLoading} minWidth={620} empty={<EmptyState title={t('customerCare.ag.commEmpty')} />} />
        </TableCard>
        <Card title={t('customerCare.ag.accrueTitle')}>
          {rights.accountsCreate ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <FieldGrid cols={2}>
                <Field label={t('common.from')} type="date" value={period.from} onChange={(e) => setPeriod({ ...period, from: e.target.value })} />
                <Field label={t('common.to')} type="date" value={period.to} onChange={(e) => setPeriod({ ...period, to: e.target.value })} />
              </FieldGrid>
              <div>
                <Button busy={accrue.isPending} onClick={() => accrue.mutate({ p_company_id: companyId, p_from: period.from, p_to: period.to }, { onSuccess: (r) => onDone(t('customerCare.ag.accruedMsg', { n: r.accrued })) })}>
                  {t('customerCare.ag.accrue')}
                </Button>
              </div>
              <p className="k" style={{ margin: 0 }}>
                {t('customerCare.ag.rule')}
              </p>
              <SalesErrorBox error={accrue.error} />
            </div>
          ) : (
            <NoRight>{t('customerCare.ag.noAccrue')}</NoRight>
          )}
        </Card>
      </div>
    </div>
  )
}

/* ───────── Queries ───────── */
function Queries({ companyId, onDone }: { companyId: string; onDone: (m: string | null) => void }) {
  const { t } = useTranslation()
  const rights = useSalesRights()
  const q = useApiView('queries', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 500 })
  const answer = useApiMutation<{ p_query_id: string; p: Record<string, unknown> }>('answer_query', SALES_REFRESH)
  const [openId, setOpenId] = useState<string | null>(null)
  const [f, setF] = useState({ status: 'answered', reply: '', next: '' })
  const list = rowsOf(q)
  const current = list.find((x) => x.id === openId) ?? null
  const cols: Column<ViewRow<'queries'>>[] = [
    {
      key: 'party',
      header: t('customerCare.col.customer'),
      render: (r) => (
        <Button size="sm" variant="link" aria-label={t('customerCare.qr.open', { name: r.party_name ?? '' })} onClick={() => setOpenId(r.id)}>
          {r.party_name ?? '—'}
        </Button>
      ),
    },
    { key: 'kind', header: t('customerCare.cmp.kind'), render: (r) => t(`customerCare.qr.kinds.${r.kind}`, { defaultValue: r.kind }) },
    { key: 'desc', header: t('customerCare.cmp.description'), render: (r) => r.description },
    { key: 'age', header: t('customerCare.qr.age'), align: 'right', render: (r) => t('customerCare.qr.days', { n: r.age_days ?? 0 }) },
    { key: 'status', header: t('common.status'), render: (r) => <SalesStatus status={r.status} /> },
  ]
  return (
    <div style={TWO}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <ViewError error={q.error} />
        <TableCard title={t('customerCare.qr.title')}>
          <DataTable caption={t('customerCare.qr.title')} columns={cols} rows={list} rowKey={(r) => r.id} loading={q.isLoading} minWidth={620} empty={<EmptyState title={t('customerCare.qr.empty')} body={t('customerCare.qr.emptyBody')} />} />
        </TableCard>
      </div>
      <Card title={current ? t('customerCare.qr.answerTitle', { name: current.party_name ?? '' }) : t('customerCare.qr.pickTitle')}>
        {!current ? (
          <p className="k" style={{ margin: 0 }}>{t('customerCare.qr.pick')}</p>
        ) : rights.edit ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <p style={{ margin: 0 }}>{current.description}</p>
            {current.reply ? <p className="muted" style={{ margin: 0 }}>{t('customerCare.qr.lastReply', { text: current.reply })}</p> : null}
            <SelectField label={t('customerCare.cmp.newStatus')} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} options={['open', 'in_progress', 'answered', 'closed'].map((k) => ({ value: k, label: t(`salesCommon.status.${k}`) }))} />
            <TextAreaField label={t('customerCare.qr.reply')} value={f.reply} onChange={(e) => setF({ ...f, reply: e.target.value })} />
            <Field label={t('customerCare.cov.next')} value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} />
            <div>
              <Button variant="primary" busy={answer.isPending} onClick={() => answer.mutate({ p_query_id: current.id, p: { status: f.status, reply: f.reply.trim() || null, next_step: f.next.trim() || null } }, { onSuccess: () => onDone(t('customerCare.qr.saved')) })}>
                {t('customerCare.qr.save')}
              </Button>
            </div>
            <SalesErrorBox error={answer.error} />
          </div>
        ) : (
          <NoRight>{t('customerCare.qr.noEdit')}</NoRight>
        )}
      </Card>
    </div>
  )
}

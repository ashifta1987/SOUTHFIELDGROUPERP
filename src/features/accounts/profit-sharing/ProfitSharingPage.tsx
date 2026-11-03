import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { ViewError } from '@/features/production/biochem-common/biochem'
import { useCompanyPeople } from '@/features/production/plastics-common/plastics'
import { CompanyFrame, NoteCard, OPS_REFRESH, OpsErrorBox, TwoCol, useOpsRights } from '@/features/production/ops-common/ops'
import { formatDate } from '@/shared/format'
import { Amount, Button, Checkbox, Chip, DataTable, Field, FieldGrid, FormDialog, SelectField, TextAreaField, type Column } from '@/ui'

type Partner = ViewRow<'v_partners'>
type Investment = ViewRow<'v_partner_investments'>
type Project = ViewRow<'v_partner_projects'>
type Minutes = ViewRow<'v_profit_share_minutes'>
type Run = ViewRow<'v_profit_share_runs'>

/**
 * Accounts → Partners and profit sharing (`ProfitSharing`): each company's partners and share % (api.upsert_partner;
 * the server refuses a total over 100), recorded investments and projects, and profit sharing by the signed minutes:
 * minutes entered by one Admin are approved by another (sod.own_minutes), the share is computed from the books
 * (api.compute_profit_share: incentives first, the rest by share %) and posted as one journal (api.post_profit_share).
 * Admin only (partners.manage); finance and the MD read with partners.view.
 */
export function ProfitSharingPage() {
  const { t } = useTranslation()
  const rights = useOpsRights()
  const [adding, setAdding] = useState(false)
  return (
    <CompanyFrame
      title={t('profitSharing.title')}
      subtitle={t('profitSharing.subtitle')}
      notice={!rights.partnersView ? t('profitSharing.noView') : rights.readOnly ? t('opsCommon.readOnly') : undefined}
      actions={(cid) => (
        <>
          <Link to={`/accounts/partner-requests?company=${cid}`} className="sf-btn" data-variant="secondary">
            {t('profitSharing.requests')}
          </Link>
          {rights.partnersManage ? (
            <Button variant="primary" onClick={() => setAdding(true)}>
              {t('profitSharing.add')}
            </Button>
          ) : null}
        </>
      )}
    >
      {(companyId) => (
        <>
          <Body companyId={companyId} />
          {adding ? <PartnerDialog companyId={companyId} partner={null} onClose={() => setAdding(false)} /> : null}
        </>
      )}
    </CompanyFrame>
  )
}

function Body({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const rights = useOpsRights()
  const q = useApiView('v_partners', { eq: { company_id: companyId }, order: 'display_name', limit: 200 })
  const partners = rowsOf(q)
  const [editing, setEditing] = useState<Partner | null>(null)
  const totalPct = partners.filter((p) => p.status === 'active').reduce((a, p) => a + Number(p.share_pct), 0)
  const cols: Column<Partner>[] = [
    {
      key: 'n',
      header: t('profitSharing.col.partner'),
      render: (p) => (
        <div>
          <strong>{p.display_name}</strong>
          {p.din ? <div className="k mono">DIN {p.din}</div> : null}
        </div>
      ),
    },
    {
      key: 'roles',
      header: t('profitSharing.col.roles'),
      render: (p) => (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {p.is_legal_partner ? <Chip tone="teal">{t('profitSharing.role.legal')}</Chip> : null}
          {p.is_investment_partner ? <Chip tone="info">{t('profitSharing.role.investment')}</Chip> : null}
          {p.is_working_partner ? <Chip tone="outline">{t('profitSharing.role.working')}</Chip> : null}
          {p.is_director ? <Chip tone="navy">{t('profitSharing.role.director')}</Chip> : null}
          {p.status !== 'active' ? <Chip tone="neutral">{t('profitSharing.inactive')}</Chip> : null}
        </div>
      ),
    },
    { key: 'shares', header: t('profitSharing.col.shares'), align: 'right', render: (p) => (p.shares !== null ? <span className="mono">{Number(p.shares).toLocaleString('en-IN')}</span> : '—') },
    { key: 'pct', header: t('profitSharing.col.pct'), align: 'right', render: (p) => <span className="mono">{p.share_pct} %</span> },
    { key: 'cap', header: t('profitSharing.col.capital'), align: 'right', render: (p) => <Amount value={p.share_capital} /> },
    { key: 'inv', header: t('profitSharing.col.investment'), align: 'right', render: (p) => <Amount value={p.investment} /> },
    { key: 'cur', header: t('profitSharing.col.current'), align: 'right', render: (p) => (p.current_account_id ? <Amount value={p.current_account_balance} /> : <span className="k">{t('profitSharing.notSet')}</span>) },
    { key: 'app', header: t('profitSharing.col.app'), render: (p) => (p.portal_set_up ? <Chip tone="teal">{t('profitSharing.portal')}</Chip> : <Chip tone="neutral">{t('profitSharing.noPortal')}</Chip>) },
    {
      key: 'e',
      header: <span className="sr-only">{t('common.edit')}</span>,
      render: (p) =>
        rights.partnersManage ? (
          <Button size="sm" variant="link" onClick={() => setEditing(p)} aria-label={t('profitSharing.editOne', { name: p.display_name })}>
            {t('common.edit')}
          </Button>
        ) : null,
    },
  ]
  return (
    <TwoCol
      main={
        <>
          <TableCard title={t('profitSharing.partnersTitle')}>
            <DataTable caption={t('profitSharing.partnersTitle')} columns={cols} rows={partners} rowKey={(p) => p.id} loading={q.isLoading} minWidth={1000} error={q.error ? <ViewError error={q.error} /> : undefined} empty={<span className="k">{t('profitSharing.none')}</span>} />
            <p className="k" style={{ margin: 0, padding: '10px 16px 14px' }}>
              <span data-testid="ps-total-pct">{t('profitSharing.totalPct', { pct: totalPct.toLocaleString('en-IN', { maximumFractionDigits: 4 }) })}</span> · {t('profitSharing.partnersNote')}
            </p>
          </TableCard>
          <Minutes companyId={companyId} partners={partners} />
          <Investments companyId={companyId} partners={partners} />
          <Projects companyId={companyId} />
          {editing ? <PartnerDialog companyId={companyId} partner={editing} onClose={() => setEditing(null)} /> : null}
        </>
      }
      side={
        <>
          <NoteCard accent title={t('profitSharing.law.title')} items={[{ body: t('profitSharing.law.one') }, { body: t('profitSharing.law.two') }, { body: t('profitSharing.law.three') }]} />
          <NoteCard title={t('profitSharing.sees.title')} items={[{ body: t('profitSharing.sees.one') }, { body: t('profitSharing.sees.two') }]} />
        </>
      }
    />
  )
}

function Minutes({ companyId, partners }: { companyId: string; partners: Partner[] }) {
  const { t } = useTranslation()
  const rights = useOpsRights()
  const mq = useApiView('v_profit_share_minutes', { eq: { company_id: companyId }, order: 'meeting_date', ascending: false, limit: 50 })
  const rq = useApiView('v_profit_share_runs', { eq: { company_id: companyId }, order: 'computed_at', ascending: false, limit: 50 })
  const approve = useApiMutation<{ p_minutes_id: string }>('approve_profit_share_minutes', OPS_REFRESH)
  const compute = useApiMutation<{ p_minutes_id: string }>('compute_profit_share', OPS_REFRESH)
  const post = useApiMutation<{ p_run_id: string; p_post_date: string }>('post_profit_share', OPS_REFRESH)
  const [adding, setAdding] = useState(false)
  const names = new Map(partners.map((p) => [p.id, p.display_name]))
  const incText = (basis: unknown) => {
    const inc = (basis as { incentives?: { partner_id: string; pct: number }[] } | null)?.incentives ?? []
    return inc.length ? inc.map((i) => `${names.get(i.partner_id) ?? '—'} ${i.pct}%`).join(' · ') : t('profitSharing.min.noIncentives')
  }
  const mcols: Column<Minutes>[] = [
    { key: 'ref', header: t('profitSharing.min.ref'), render: (m) => <strong>{m.minutes_ref}</strong> },
    { key: 'on', header: t('profitSharing.min.on'), render: (m) => formatDate(m.meeting_date) },
    { key: 'fy', header: t('profitSharing.min.fy'), render: (m) => m.fy_label },
    { key: 'inc', header: t('profitSharing.min.incentives'), render: (m) => incText(m.basis) },
    { key: 'st', header: t('common.status'), render: (m) => <Chip tone={m.status === 'approved' ? 'success' : m.status === 'draft' ? 'signal' : 'neutral'}>{t(`profitSharing.min.status.${m.status}`, { defaultValue: m.status })}</Chip> },
    { key: 'who', header: t('profitSharing.min.who'), render: (m) => `${m.created_by_name ?? '—'}${m.approved_by_name ? ` → ${m.approved_by_name}` : ''}` },
    {
      key: 'act',
      header: <span className="sr-only">{t('profitSharing.min.actions')}</span>,
      render: (m) =>
        rights.partnersManage ? (
          m.status === 'draft' ? (
            <Button size="sm" variant="link" busy={approve.isPending} onClick={() => approve.mutate({ p_minutes_id: m.id })} aria-label={t('profitSharing.min.approveOne', { ref: m.minutes_ref })}>
              {t('profitSharing.min.approve')}
            </Button>
          ) : m.status === 'approved' ? (
            <Button size="sm" variant="link" busy={compute.isPending} onClick={() => compute.mutate({ p_minutes_id: m.id })} aria-label={t('profitSharing.min.computeOne', { ref: m.minutes_ref })}>
              {t('profitSharing.min.compute')}
            </Button>
          ) : null
        ) : null,
    },
  ]
  const rcols: Column<Run>[] = [
    { key: 'ref', header: t('profitSharing.min.ref'), render: (r) => r.minutes_ref },
    { key: 'net', header: t('profitSharing.run.net'), align: 'right', render: (r) => <Amount value={r.net_profit} /> },
    { key: 'inc', header: t('profitSharing.run.incentives'), align: 'right', render: (r) => <Amount value={r.incentive_total} /> },
    { key: 'dist', header: t('profitSharing.run.distributable'), align: 'right', render: (r) => <Amount value={r.distributable} /> },
    {
      key: 'lines',
      header: t('profitSharing.run.lines'),
      render: (r) => {
        const lines = Array.isArray(r.lines) ? (r.lines as { partner_name?: string; partner_id?: string; kind?: string; amount?: number }[]) : []
        return lines.map((l) => `${l.partner_name ?? names.get(l.partner_id ?? '') ?? '—'} ₹${Number(l.amount ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`).join(' · ') || '—'
      },
    },
    { key: 'st', header: t('common.status'), render: (r) => <Chip tone={r.status === 'posted' ? 'success' : r.status === 'computed' ? 'signal' : 'neutral'}>{t(`profitSharing.run.status.${r.status}`, { defaultValue: r.status })}</Chip> },
    {
      key: 'act',
      header: <span className="sr-only">{t('profitSharing.run.post')}</span>,
      render: (r) =>
        rights.partnersManage && r.status === 'computed' ? (
          <Button size="sm" variant="link" busy={post.isPending} onClick={() => post.mutate({ p_run_id: r.id, p_post_date: todayIst() })} aria-label={t('profitSharing.run.postOne', { ref: r.minutes_ref })}>
            {t('profitSharing.run.post')}
          </Button>
        ) : r.voucher_no ? (
          <span className="mono">{r.voucher_no}</span>
        ) : null,
    },
  ]
  return (
    <TableCard
      title={t('profitSharing.min.title')}
      action={
        rights.partnersManage ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            {t('profitSharing.min.add')}
          </Button>
        ) : null
      }
    >
      <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <OpsErrorBox error={approve.error ?? compute.error ?? post.error} />
      </div>
      <DataTable caption={t('profitSharing.min.title')} columns={mcols} rows={rowsOf(mq)} rowKey={(m) => m.id} loading={mq.isLoading} minWidth={900} error={mq.error ? <ViewError error={mq.error} /> : undefined} empty={<span className="k">{t('profitSharing.min.none')}</span>} />
      <h3 style={{ margin: 0, padding: '12px 16px 6px', fontSize: 14 }}>{t('profitSharing.run.title')}</h3>
      <DataTable caption={t('profitSharing.run.title')} columns={rcols} rows={rowsOf(rq)} rowKey={(r) => r.id} loading={rq.isLoading} minWidth={900} error={rq.error ? <ViewError error={rq.error} /> : undefined} empty={<span className="k">{t('profitSharing.run.none')}</span>} />
      {adding ? <MinutesDialog companyId={companyId} partners={partners} onClose={() => setAdding(false)} /> : null}
    </TableCard>
  )
}

function MinutesDialog({ companyId, partners, onClose }: { companyId: string; partners: Partner[]; onClose: () => void }) {
  const { t } = useTranslation()
  const fys = useApiView('financial_years', { eq: { company_id: companyId }, order: 'starts_on', ascending: false })
  const [f, setF] = useState({ fy: '', meeting_date: todayIst(), ref: '' })
  const [inc, setInc] = useState<{ partner_id: string; pct: string }[]>([])
  const save = useApiMutation<{ p: Record<string, unknown> }>('save_profit_share_minutes', OPS_REFRESH)
  const fyId = f.fy || rowsOf(fys)[0]?.id || ''
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('profitSharing.min.addTitle')}
      description={t('profitSharing.min.addHint')}
      submitLabel={t('common.save')}
      busy={save.isPending}
      wide
      error={<OpsErrorBox error={save.error} />}
      onSubmit={() => save.mutate({ p: { company_id: companyId, fy_id: fyId, meeting_date: f.meeting_date, minutes_ref: f.ref.trim(), basis: { incentives: inc.filter((i) => i.partner_id).map((i) => ({ partner_id: i.partner_id, pct: i.pct.trim() })) } } }, { onSuccess: onClose })}
    >
      <FieldGrid cols={3}>
        <SelectField label={t('profitSharing.min.fy')} value={fyId} onChange={(e) => setF({ ...f, fy: e.target.value })} options={rowsOf(fys).map((y) => ({ value: y.id, label: y.label }))} />
        <Field label={t('profitSharing.min.on')} type="date" value={f.meeting_date} onChange={(e) => setF({ ...f, meeting_date: e.target.value })} />
        <Field label={t('profitSharing.min.ref')} value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })} required />
      </FieldGrid>
      {inc.map((i, n) => (
        <div key={n} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 8 }}>
          <SelectField label={t('profitSharing.min.incPartner', { n: n + 1 })} value={i.partner_id} onChange={(e) => setInc(inc.map((x, j) => (j === n ? { ...x, partner_id: e.target.value } : x)))} placeholder={t('profitSharing.choose')} options={partners.map((p) => ({ value: p.id, label: p.display_name }))} />
          <Field label={t('profitSharing.min.incPct', { n: n + 1 })} inputMode="decimal" value={i.pct} onChange={(e) => setInc(inc.map((x, j) => (j === n ? { ...x, pct: e.target.value } : x)))} />
        </div>
      ))}
      <div>
        <Button size="sm" onClick={() => setInc([...inc, { partner_id: '', pct: '' }])}>
          {t('profitSharing.min.addIncentive')}
        </Button>
      </div>
    </FormDialog>
  )
}

function Investments({ companyId, partners }: { companyId: string; partners: Partner[] }) {
  const { t } = useTranslation()
  const rights = useOpsRights()
  const q = useApiView('v_partner_investments', { eq: { company_id: companyId }, order: 'invested_on', ascending: false, limit: 300 })
  const [adding, setAdding] = useState(false)
  const cols: Column<Investment>[] = [
    { key: 'p', header: t('profitSharing.col.partner'), render: (i) => i.partner_name },
    { key: 'k', header: t('profitSharing.inv.kind'), render: (i) => t(`profitSharing.inv.kinds.${i.kind}`, { defaultValue: i.kind }) },
    { key: 'a', header: t('profitSharing.inv.amount'), align: 'right', render: (i) => <Amount value={i.amount} /> },
    { key: 'on', header: t('profitSharing.inv.on'), render: (i) => formatDate(i.invested_on) },
    { key: 'ag', header: t('profitSharing.inv.agreement'), render: (i) => i.agreement_ref ?? '—' },
  ]
  return (
    <TableCard
      title={t('profitSharing.inv.title')}
      action={
        rights.partnersManage ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            {t('profitSharing.inv.add')}
          </Button>
        ) : null
      }
    >
      <DataTable caption={t('profitSharing.inv.title')} columns={cols} rows={rowsOf(q)} rowKey={(i) => i.id} loading={q.isLoading} minWidth={640} error={q.error ? <ViewError error={q.error} /> : undefined} empty={<span className="k">{t('profitSharing.inv.none')}</span>} />
      {adding ? <InvestmentDialog companyId={companyId} partners={partners} onClose={() => setAdding(false)} /> : null}
    </TableCard>
  )
}

function InvestmentDialog({ companyId, partners, onClose }: { companyId: string; partners: Partner[]; onClose: () => void }) {
  const { t } = useTranslation()
  const projects = useApiView('v_partner_projects', { eq: { company_id: companyId }, order: 'name' })
  const [f, setF] = useState({ partner: '', kind: 'share_capital', amount: '', on: todayIst(), agreement: '', project: '', note: '' })
  const save = useApiMutation<{ p: Record<string, unknown> }>('record_partner_investment', OPS_REFRESH)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  return (
    <FormDialog open onOpenChange={(o) => (!o ? onClose() : undefined)} title={t('profitSharing.inv.addTitle')} description={t('profitSharing.inv.hint')} submitLabel={t('common.save')} busy={save.isPending} wide error={<OpsErrorBox error={save.error} />} onSubmit={() => save.mutate({ p: { partner_id: f.partner || null, kind: f.kind, amount: f.amount.trim() || null, invested_on: f.on, agreement_ref: f.agreement.trim() || null, project_id: f.project || null, note: f.note.trim() || null } }, { onSuccess: onClose })}>
      <FieldGrid cols={2}>
        <SelectField label={t('profitSharing.col.partner')} value={f.partner} onChange={set('partner')} placeholder={t('profitSharing.choose')} options={partners.map((p) => ({ value: p.id, label: p.display_name }))} />
        <SelectField label={t('profitSharing.inv.kind')} value={f.kind} onChange={set('kind')} options={['share_capital', 'capital_account', 'project', 'other'].map((k) => ({ value: k, label: t(`profitSharing.inv.kinds.${k}`) }))} />
        <Field label={t('profitSharing.inv.amount')} inputMode="decimal" value={f.amount} onChange={set('amount')} />
        <Field label={t('profitSharing.inv.on')} type="date" value={f.on} onChange={set('on')} />
        <Field label={t('profitSharing.inv.agreement')} value={f.agreement} onChange={set('agreement')} />
        {f.kind === 'project' ? <SelectField label={t('profitSharing.proj.name')} value={f.project} onChange={set('project')} placeholder={t('profitSharing.choose')} options={rowsOf(projects).map((p) => ({ value: p.id, label: p.name }))} /> : null}
      </FieldGrid>
      <TextAreaField label={t('profitSharing.note')} value={f.note} onChange={set('note')} rows={2} />
    </FormDialog>
  )
}

function Projects({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const rights = useOpsRights()
  const q = useApiView('v_partner_projects', { eq: { company_id: companyId }, order: 'name', limit: 200 })
  const [editing, setEditing] = useState<Project | 'new' | null>(null)
  const cols: Column<Project>[] = [
    { key: 'n', header: t('profitSharing.proj.name'), render: (p) => <strong>{p.name}</strong> },
    { key: 's', header: t('common.status'), render: (p) => t(`profitSharing.proj.status.${p.status}`, { defaultValue: p.status }) },
    { key: 'on', header: t('profitSharing.proj.started'), render: (p) => (p.started_on ? formatDate(p.started_on) : '—') },
    { key: 'v', header: t('profitSharing.proj.visible'), render: (p) => (p.visible_to_investors ? t('common.yes') : t('common.no')) },
    {
      key: 'e',
      header: <span className="sr-only">{t('common.edit')}</span>,
      render: (p) =>
        rights.partnersManage ? (
          <Button size="sm" variant="link" onClick={() => setEditing(p)} aria-label={t('profitSharing.proj.editOne', { name: p.name })}>
            {t('common.edit')}
          </Button>
        ) : null,
    },
  ]
  return (
    <TableCard
      title={t('profitSharing.proj.title')}
      action={
        rights.partnersManage ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            {t('profitSharing.proj.add')}
          </Button>
        ) : null
      }
    >
      <DataTable caption={t('profitSharing.proj.title')} columns={cols} rows={rowsOf(q)} rowKey={(p) => p.id} loading={q.isLoading} minWidth={560} error={q.error ? <ViewError error={q.error} /> : undefined} empty={<span className="k">{t('profitSharing.proj.none')}</span>} />
      {editing ? <ProjectDialog companyId={companyId} project={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </TableCard>
  )
}

function ProjectDialog({ companyId, project, onClose }: { companyId: string; project: Project | null; onClose: () => void }) {
  const { t } = useTranslation()
  const [f, setF] = useState({ name: project?.name ?? '', status: project?.status ?? 'idea', started_on: project?.started_on ?? '', summary: project?.summary ?? '', visible: project?.visible_to_investors ?? false })
  const save = useApiMutation<{ p: Record<string, unknown> }>('upsert_partner_project', OPS_REFRESH)
  return (
    <FormDialog open onOpenChange={(o) => (!o ? onClose() : undefined)} title={project ? t('profitSharing.proj.editTitle') : t('profitSharing.proj.addTitle')} submitLabel={t('common.save')} busy={save.isPending} error={<OpsErrorBox error={save.error} />} onSubmit={() => save.mutate({ p: { id: project?.id ?? null, company_id: companyId, name: f.name.trim(), status: f.status, started_on: f.started_on || null, summary: f.summary.trim() || null, visible_to_investors: f.visible } }, { onSuccess: onClose })}>
      <Field label={t('profitSharing.proj.name')} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
      <FieldGrid cols={2}>
        <SelectField label={t('common.status')} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} options={['idea', 'being_built', 'running', 'closed'].map((s) => ({ value: s, label: t(`profitSharing.proj.status.${s}`) }))} />
        <Field label={t('profitSharing.proj.started')} type="date" value={f.started_on} onChange={(e) => setF({ ...f, started_on: e.target.value })} />
      </FieldGrid>
      <TextAreaField label={t('profitSharing.proj.summary')} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} rows={3} />
      <Checkbox label={t('profitSharing.proj.visible')} hint={t('profitSharing.proj.visibleHint')} checked={f.visible} onChange={(e) => setF({ ...f, visible: e.target.checked })} />
    </FormDialog>
  )
}

function PartnerDialog({ companyId, partner, onClose }: { companyId: string; partner: Partner | null; onClose: () => void }) {
  const { t } = useTranslation()
  const accounts = useApiView('accounts', { eq: { company_id: companyId }, order: 'name', limit: 3000 })
  const people = useCompanyPeople(companyId)
  const [f, setF] = useState({
    display_name: partner?.display_name ?? '',
    user_id: partner?.user_id ?? '',
    din: partner?.din ?? '',
    shares: partner?.shares !== null && partner?.shares !== undefined ? String(partner.shares) : '',
    share_pct: partner ? String(partner.share_pct) : '',
    capital_account_id: partner?.capital_account_id ?? '',
    current_account_id: partner?.current_account_id ?? '',
    loan_account_id: partner?.loan_account_id ?? '',
    language: partner?.language ?? 'en',
    status: partner?.status ?? 'active',
  })
  const [flags, setFlags] = useState({
    is_legal_partner: partner?.is_legal_partner ?? true,
    is_investment_partner: partner?.is_investment_partner ?? false,
    is_working_partner: partner?.is_working_partner ?? false,
    is_director: partner?.is_director ?? false,
    director_interested: partner?.director_interested ?? false,
  })
  const save = useApiMutation<{ p: Record<string, unknown> }>('upsert_partner', OPS_REFRESH)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const accOpts = rowsOf(accounts).map((a) => ({ value: a.id, label: `${a.name} · ${a.group_name}` }))
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={partner ? t('profitSharing.form.editTitle') : t('profitSharing.form.addTitle')}
      description={t('profitSharing.form.hint')}
      submitLabel={t('common.save')}
      busy={save.isPending}
      wide
      error={<OpsErrorBox error={save.error} />}
      onSubmit={() =>
        save.mutate(
          {
            p: {
              id: partner?.id ?? null,
              company_id: companyId,
              person_id: partner?.person_id ?? null,
              display_name: f.display_name.trim(),
              user_id: f.user_id || null,
              din: f.din.trim() || null,
              shares: f.shares.trim() || null,
              share_pct: f.share_pct.trim() || '0',
              capital_account_id: f.capital_account_id || null,
              current_account_id: f.current_account_id || null,
              loan_account_id: f.loan_account_id || null,
              language: f.language,
              status: f.status,
              ...flags,
            },
          },
          { onSuccess: onClose },
        )
      }
    >
      <FieldGrid cols={2}>
        <Field label={t('profitSharing.form.name')} value={f.display_name} onChange={set('display_name')} required />
        <SelectField label={t('profitSharing.form.portal')} value={f.user_id} onChange={set('user_id')} placeholder={t('profitSharing.form.noPortal')} options={people.list.map((p) => ({ value: p.user_id, label: p.display_name ?? '—' }))} help={t('profitSharing.form.portalHelp')} />
        <Field label={t('profitSharing.col.shares')} inputMode="numeric" value={f.shares} onChange={set('shares')} />
        <Field label={t('profitSharing.col.pct')} inputMode="decimal" value={f.share_pct} onChange={set('share_pct')} />
        <Field label={t('profitSharing.form.din')} value={f.din} onChange={set('din')} />
        <SelectField label={t('profitSharing.form.language')} value={f.language} onChange={set('language')} options={[{ value: 'en', label: 'English' }, { value: 'ml', label: 'മലയാളം' }]} />
        <SelectField label={t('profitSharing.form.capital')} value={f.capital_account_id} onChange={set('capital_account_id')} placeholder={t('profitSharing.notSet')} options={accOpts} />
        <SelectField label={t('profitSharing.form.current')} value={f.current_account_id} onChange={set('current_account_id')} placeholder={t('profitSharing.notSet')} options={accOpts} />
        <SelectField label={t('profitSharing.form.loan')} value={f.loan_account_id} onChange={set('loan_account_id')} placeholder={t('profitSharing.notSet')} options={accOpts} />
        <SelectField label={t('common.status')} value={f.status} onChange={set('status')} options={['active', 'inactive'].map((s) => ({ value: s, label: t(`common.${s}`) }))} />
      </FieldGrid>
      <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
        <legend style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>{t('profitSharing.col.roles')}</legend>
        {(['is_legal_partner', 'is_investment_partner', 'is_working_partner', 'is_director', 'director_interested'] as const).map((k) => (
          <Checkbox key={k} label={t(`profitSharing.form.${k}`)} checked={flags[k]} onChange={(e) => setFlags({ ...flags, [k]: e.target.checked })} />
        ))}
      </fieldset>
    </FormDialog>
  )
}

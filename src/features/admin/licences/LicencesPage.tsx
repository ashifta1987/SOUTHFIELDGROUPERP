import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { ViewError, useProductionRights } from '@/features/production/biochem-common/biochem'
import { OPS_REFRESH, OpsErrorBox, TwoCol, NoteCard, openDocument, uploadDocument, useSetting } from '@/features/production/ops-common/ops'
import { formatDate } from '@/shared/format'
import { Button, Card, Checkbox, Chip, DataTable, EmptyState, Field, FieldGrid, FormDialog, KeyValue, KpiTiles, PageHeader, SelectField, Skeleton, Tabs, TextAreaField, type Column } from '@/ui'

type Licence = ViewRow<'v_licence_register'>
type Doc = ViewRow<'v_licence_documents'>
type Renewal = ViewRow<'v_licence_renewals'>
type Reminder = ViewRow<'v_licence_reminders'>

/** Licence kinds (core.licences.kind) grouped as on the reference. */
const GROUPS: Record<string, string[]> = {
  company: ['gst_registration', 'company_registration', 'pan_tan', 'udyam', 'iec', 'lut'],
  products: ['cosmetics_manufacturing', 'drug_manufacturing', 'legal_metrology', 'weighing_verification', 'trademark', 'spirit_permit', 'bis', 'fssai'],
  factory: ['factory', 'pollution_consent', 'fire', 'trade', 'shops_establishment'],
  people: ['epf', 'esi'],
  quality: ['iso'],
  other: ['other'],
}
const KINDS = Object.values(GROUPS).flat()
const groupOf = (kind: string) => Object.entries(GROUPS).find(([, ks]) => ks.includes(kind))?.[0] ?? 'other'

/**
 * Admin → Licences, certificates and documents (`Licences`): every licence a company holds (api.v_licence_register),
 * its owner, whether it blocks production or packing when lapsed (app.check_blocking_licences), renewals kept as
 * history (api.renew_licence → core.licence_renewals), papers in the private `documents` bucket at
 * `<company_id>/licences/<uuid>.<ext>` (api.add_licence_document), and reminders at the days in licence.reminder_days
 * to the owner, never twice (api.run_licence_reminders; the daily job does the same). Entry is Admin only
 * (settings.manage). Numbers and dates are typed from the original paper, never invented.
 */
export function LicencesPage() {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const choice = useCompanyChoice()
  const companyId = choice.companyId
  const q = useApiView('v_licence_register', { eq: { company_id: companyId }, order: 'valid_to', limit: 500, enabled: Boolean(companyId) })
  const fam = useApiView('process_families', { eq: { company_id: companyId }, order: 'code', enabled: Boolean(companyId) })
  const days = useSetting(companyId, 'licence.reminder_days')
  const rows = rowsOf(q)
  const [editing, setEditing] = useState<Licence | 'new' | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [group, setGroup] = useState<string>('all')
  const run = useApiMutation<{ p_company_id: string }, { reminders: number; superseded: number; expired_items: number }>('run_licence_reminders', OPS_REFRESH)

  const blockingFamilies = rowsOf(fam).filter((f) => f.licence_kind && f.status === 'active' && f.licence_ok === false)
  const blockingNow = rows.filter((r) => r.blocks_something && r.state === 'expired')
  const toAct = rows.filter((r) => r.state === 'expiring' || r.state === 'expired' || r.renewal_status === 'renewal_due' || r.renewal_status === 'lapsed')
  const reminderDays = Array.isArray(days.value) ? (days.value as number[]) : []
  const shown = group === 'all' ? rows : rows.filter((r) => groupOf(r.kind) === group)
  const open = rows.find((r) => r.id === openId) ?? null
  const counts = Object.fromEntries(Object.keys(GROUPS).map((g) => [g, rows.filter((r) => groupOf(r.kind) === g).length]))
  const nameOf = (r: Licence) => r.title || t(`licences.kind.${r.kind}`, { defaultValue: r.label ?? r.kind })

  const columns: Column<Licence>[] = [
    {
      key: 'kind',
      header: t('licences.col.kind'),
      render: (r) => (
        <div>
          <Button variant="link" size="sm" onClick={() => setOpenId(r.id)} aria-label={t('licences.openOne', { name: nameOf(r), no: r.licence_no })}>
            <strong>{nameOf(r)}</strong>
          </Button>
          {r.title ? <div className="k">{t(`licences.kind.${r.kind}`, { defaultValue: r.kind })}</div> : null}
        </div>
      ),
    },
    { key: 'branch', header: t('licences.col.branch'), render: (r) => r.branch_name ?? t('licences.allBranches') },
    {
      key: 'by',
      header: t('licences.col.authority'),
      render: (r) => (
        <div>
          {r.issued_by ?? '—'}
          {r.portal_url ? (
            <div>
              <a href={r.portal_url} target="_blank" rel="noopener noreferrer">
                {t('licences.portal')}
              </a>
            </div>
          ) : null}
        </div>
      ),
    },
    { key: 'no', header: t('licences.col.number'), render: (r) => <span className="mono">{r.licence_no}</span> },
    { key: 'to', header: t('licences.col.to'), render: (r) => (r.valid_to ? formatDate(r.valid_to) : t('licences.noExpiry')) },
    { key: 'owner', header: t('licences.col.owner'), render: (r) => r.owner_name ?? <span className="k">{t('licences.noOwner')}</span> },
    { key: 'state', header: t('licences.col.state'), render: (r) => <LicenceState l={r} /> },
    { key: 'docs', header: t('licences.col.docs'), align: 'right', render: (r) => <span className="mono">{r.documents ?? 0}</span> },
    {
      key: 'edit',
      header: <span className="sr-only">{t('common.edit')}</span>,
      render: (r) =>
        rights.admin ? (
          <Button size="sm" variant="link" onClick={() => setEditing(r)} aria-label={t('licences.editOne', { kind: nameOf(r) })}>
            {t('common.edit')}
          </Button>
        ) : null,
    },
  ]

  return (
    <>
      <PageHeader
        title={t('licences.title')}
        subtitle={t('licences.subtitle')}
        actions={
          rights.admin && companyId ? (
            <>
              <Button busy={run.isPending} onClick={() => run.mutate({ p_company_id: companyId })}>
                {t('licences.runReminders')}
              </Button>
              <Button variant="primary" onClick={() => setEditing('new')}>
                {t('licences.add')}
              </Button>
            </>
          ) : null
        }
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <OpsErrorBox error={run.error} />
          {run.data ? (
            <p role="status" className="sf-alert" data-tone="info" style={{ margin: 0 }}>
              {t('licences.ranReminders', { n: run.data.reminders, s: run.data.superseded, e: run.data.expired_items })}
            </p>
          ) : null}
          <KpiTiles
            ariaLabel={t('licences.kpis')}
            items={[
              { key: 'on', label: t('licences.kpi.onFile'), value: <span data-testid="lic-on-file">{rows.length}</span>, sub: t('licences.kpi.onFileSub') },
              { key: 'act', label: t('licences.kpi.toAct'), value: toAct.length, sub: t('licences.kpi.toActSub') },
              {
                key: 'block',
                label: t('licences.kpi.blocking'),
                value: <span data-testid="lic-blocking">{blockingNow.length + blockingFamilies.length}</span>,
                sub: blockingNow.length + blockingFamilies.length ? [...blockingNow.map((l) => nameOf(l)), ...blockingFamilies.map((f) => f.name)].join(', ') : t('licences.kpi.blockingNone'),
              },
              { key: 'rem', label: t('licences.kpi.reminders'), value: reminderDays.length ? reminderDays.join(' · ') : '—', sub: reminderDays.length ? t('licences.kpi.remindersSub') : t('licences.kpi.remindersUnset') },
            ]}
          />
          {!rights.admin ? <p className="muted" style={{ margin: 0 }}>{rights.readOnly ? t('opsCommon.readOnly') : t('licences.adminOnly')}</p> : null}
          <div style={{ display: 'flex', flexWrap: 'wrap' }}>
            <Tabs
              label={t('licences.groups')}
              value={group}
              onChange={setGroup}
              tabs={[{ key: 'all', label: `${t('licences.group.all')} ${rows.length}` }, ...Object.keys(GROUPS).map((g) => ({ key: g, label: `${t(`licences.group.${g}`)} ${counts[g] ?? 0}` }))]}
            />
          </div>
          <TableCard title={t('licences.listTitle')}>
            <DataTable
              caption={t('licences.listTitle')}
              columns={columns}
              rows={shown}
              rowKey={(r) => r.id}
              loading={q.isLoading}
              minWidth={1080}
              error={q.error ? <ViewError error={q.error} /> : undefined}
              empty={<EmptyState title={t('licences.emptyTitle')} body={t('licences.emptyBody')} />}
            />
            <p className="k" style={{ margin: 0, padding: '10px 16px 14px' }}>
              {t('licences.footnote')}
            </p>
          </TableCard>
          {open ? <LicenceDetail l={open} admin={rights.admin} onClose={() => setOpenId(null)} /> : null}
          <TwoCol
            main={
              <Card title={t('licences.folders.title')}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                  <div className="sf-card sf-card__pad">
                    <strong>{t('licences.folders.licences')}</strong>
                    <div className="k">{t('licences.folders.licencesSub')}</div>
                    <div className="mono k">{t('licences.folders.files', { n: rows.reduce((a, r) => a + Number(r.documents ?? 0), 0) })}</div>
                  </div>
                  <div className="sf-card sf-card__pad">
                    <strong>{t('licences.folders.machines')}</strong>
                    <div className="k">{t('licences.folders.machinesSub')}</div>
                  </div>
                  <div className="sf-card sf-card__pad">
                    <strong>{t('licences.folders.others')}</strong>
                    <div className="k">{t('licences.folders.othersSub')}</div>
                  </div>
                </div>
              </Card>
            }
            side={
              <NoteCard
                title={t('licences.how.title')}
                items={[
                  { head: t('licences.how.oneHead'), body: t('licences.how.one') },
                  { head: t('licences.how.remHead'), body: t('licences.how.rem') },
                  { head: t('licences.how.linkHead'), body: t('licences.how.link') },
                  { head: t('licences.how.whoHead'), body: t('licences.how.who') },
                  { head: t('licences.how.lostHead'), body: t('licences.how.lost') },
                ]}
              />
            }
          />
        </div>
      )}
      {editing && companyId ? <LicenceDialog companyId={companyId} licence={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </>
  )
}

function LicenceState({ l }: { l: Licence }) {
  const { t } = useTranslation()
  switch (l.state) {
    case 'valid':
      return (
        <Chip tone="success" icon="check">
          {t('licences.state.valid')}
        </Chip>
      )
    case 'expiring':
      return (
        <Chip tone="signal" icon="clock">
          {t('licences.expiresIn', { n: l.days_to_expiry })}
        </Chip>
      )
    case 'expired':
      return l.blocks_something ? (
        <Chip tone="danger" icon="ban">
          {t('licences.state.blocking')}
        </Chip>
      ) : (
        <Chip tone="danger" icon="alert">
          {t('licences.state.expired')}
        </Chip>
      )
    case 'no_expiry':
      return <Chip tone="neutral">{t('licences.state.no_expiry')}</Chip>
    default:
      return <Chip tone="neutral">{t(`licences.status.${l.status}`, { defaultValue: l.status })}</Chip>
  }
}

function LicenceDetail({ l, admin, onClose }: { l: Licence; admin: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const dq = useApiView('v_licence_documents', { eq: { licence_id: l.id }, order: 'created_at', ascending: false })
  const rq = useApiView('v_licence_renewals', { eq: { licence_id: l.id }, order: 'renewed_at', ascending: false })
  const mq = useApiView('v_licence_reminders', { eq: { licence_id: l.id }, order: 'run_date', ascending: false })
  const [dlg, setDlg] = useState<'renew' | 'doc' | null>(null)
  const docCols: Column<Doc>[] = [
    { key: 'kind', header: t('licences.doc.kind'), render: (d) => t(`licences.docKind.${d.kind}`, { defaultValue: d.kind }) },
    { key: 'to', header: t('licences.doc.validTo'), render: (d) => (d.valid_to ? formatDate(d.valid_to) : '—') },
    { key: 'by', header: t('licences.doc.by'), render: (d) => `${d.uploaded_by_name ?? '—'} · ${formatDate(d.created_at)}` },
    {
      key: 'open',
      header: <span className="sr-only">{t('opsCommon.open')}</span>,
      render: (d) => (
        <Button size="sm" variant="link" onClick={() => void openDocument(d.path)} aria-label={t('licences.doc.openOne', { kind: t(`licences.docKind.${d.kind}`, { defaultValue: d.kind }), date: formatDate(d.created_at) })}>
          {t('opsCommon.open')}
        </Button>
      ),
    },
  ]
  const renCols: Column<Renewal>[] = [
    { key: 'at', header: t('licences.ren.at'), render: (r) => formatDate(r.renewed_at) },
    { key: 'old', header: t('licences.ren.old'), render: (r) => `${r.old_licence_no} · ${formatDate(r.old_valid_from)} – ${r.old_valid_to ? formatDate(r.old_valid_to) : t('licences.noExpiry')}` },
    { key: 'new', header: t('licences.ren.new'), render: (r) => `${r.new_licence_no} · ${formatDate(r.new_valid_from)} – ${formatDate(r.new_valid_to)}` },
    { key: 'by', header: t('licences.ren.by'), render: (r) => r.renewed_by_name ?? '—' },
  ]
  const remCols: Column<Reminder>[] = [
    { key: 'days', header: t('licences.rem.days'), align: 'right', render: (r) => <span className="mono">{r.days_before}</span> },
    { key: 'due', header: t('licences.rem.due'), render: (r) => formatDate(r.due_on) },
    { key: 'status', header: t('common.status'), render: (r) => t(`licences.remStatus.${r.status}`, { defaultValue: r.status }) },
    { key: 'run', header: t('licences.rem.run'), render: (r) => formatDate(r.run_date) },
  ]
  const name = l.title || t(`licences.kind.${l.kind}`, { defaultValue: l.kind })
  return (
    <Card
      title={t('licences.detail.title', { name })}
      action={
        <div style={{ display: 'flex', gap: 8 }}>
          {admin ? (
            <>
              <Button size="sm" onClick={() => setDlg('doc')}>
                {t('licences.detail.addDoc')}
              </Button>
              <Button size="sm" variant="primary" onClick={() => setDlg('renew')}>
                {t('licences.detail.renew')}
              </Button>
            </>
          ) : null}
          <Button size="sm" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <KeyValue
          rows={[
            { label: t('licences.col.number'), value: <span data-testid="lic-number">{l.licence_no}</span> },
            { label: t('licences.col.from'), value: formatDate(l.valid_from) },
            { label: t('licences.col.to'), value: <span data-testid="lic-valid-to">{l.valid_to ? formatDate(l.valid_to) : t('licences.noExpiry')}</span> },
            { label: t('licences.f.renewal'), value: t(`licences.renewal.${l.renewal_status}`, { defaultValue: l.renewal_status }) },
            { label: t('licences.col.owner'), value: l.owner_name ?? t('licences.noOwner') },
            { label: t('licences.f.blocks'), value: l.is_blocking && l.blocks.length ? l.blocks.map((b) => t(`licences.block.${b}`)).join(', ') : t('licences.blocksNothing') },
          ]}
        />
        <h3 style={{ margin: 0, fontSize: 14 }}>{t('licences.detail.docs')}</h3>
        <DataTable caption={t('licences.detail.docs')} columns={docCols} rows={rowsOf(dq)} rowKey={(d) => d.id} loading={dq.isLoading} minWidth={560} empty={<span className="k">{t('licences.detail.noDocs')}</span>} error={dq.error ? <ViewError error={dq.error} /> : undefined} />
        <h3 style={{ margin: 0, fontSize: 14 }}>{t('licences.detail.renewals')}</h3>
        <DataTable caption={t('licences.detail.renewals')} columns={renCols} rows={rowsOf(rq)} rowKey={(r) => r.id} loading={rq.isLoading} minWidth={640} empty={<span className="k">{t('licences.detail.noRenewals')}</span>} error={rq.error ? <ViewError error={rq.error} /> : undefined} />
        <h3 style={{ margin: 0, fontSize: 14 }}>{t('licences.detail.reminders')}</h3>
        <DataTable caption={t('licences.detail.reminders')} columns={remCols} rows={rowsOf(mq)} rowKey={(r) => String(r.id)} loading={mq.isLoading} minWidth={480} empty={<span className="k">{t('licences.detail.noReminders')}</span>} error={mq.error ? <ViewError error={mq.error} /> : undefined} />
      </div>
      {dlg === 'renew' ? <RenewDialog l={l} onClose={() => setDlg(null)} /> : null}
      {dlg === 'doc' ? <DocDialog l={l} onClose={() => setDlg(null)} /> : null}
    </Card>
  )
}

function FileField({ label, onFile }: { label: string; onFile: (f: File | null) => void }) {
  return <Field label={label} type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
}

function DocDialog({ l, onClose }: { l: Licence; onClose: () => void }) {
  const { t } = useTranslation()
  const [file, setFile] = useState<File | null>(null)
  const [f, setF] = useState({ kind: 'licence_copy', valid_to: l.valid_to ?? '' })
  const [busy, setBusy] = useState(false)
  const [upErr, setUpErr] = useState<string | null>(null)
  const save = useApiMutation<{ p_licence_id: string; p: Record<string, unknown> }>('add_licence_document', OPS_REFRESH)
  async function submit() {
    if (!file) {
      setUpErr(t('licences.doc.needFile'))
      return
    }
    setBusy(true)
    setUpErr(null)
    try {
      const path = await uploadDocument(l.company_id, 'licences', file)
      save.mutate({ p_licence_id: l.id, p: { path, kind: f.kind, valid_to: f.valid_to || null } }, { onSuccess: onClose })
    } catch (e) {
      setUpErr(t('opsCommon.uploadFailed', { detail: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
    }
  }
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('licences.doc.title')}
      description={t('licences.doc.hint')}
      submitLabel={t('licences.doc.submit')}
      busy={busy || save.isPending}
      onSubmit={() => void submit()}
      error={
        <>
          {upErr ? (
            <p role="alert" className="sf-field__msg" style={{ margin: 0 }}>
              {upErr}
            </p>
          ) : null}
          <OpsErrorBox error={save.error} />
        </>
      }
    >
      <FileField label={t('opsCommon.chooseFile')} onFile={setFile} />
      <FieldGrid cols={2}>
        <SelectField label={t('licences.doc.kind')} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} options={['licence_copy', 'application', 'renewal_receipt', 'inspection', 'other'].map((k) => ({ value: k, label: t(`licences.docKind.${k}`) }))} />
        <Field label={t('licences.doc.validTo')} type="date" value={f.valid_to} onChange={(e) => setF({ ...f, valid_to: e.target.value })} />
      </FieldGrid>
    </FormDialog>
  )
}

function RenewDialog({ l, onClose }: { l: Licence; onClose: () => void }) {
  const { t } = useTranslation()
  const [file, setFile] = useState<File | null>(null)
  const [f, setF] = useState({ licence_no: l.licence_no, valid_from: todayIst(), valid_to: '', note: '' })
  const [busy, setBusy] = useState(false)
  const [upErr, setUpErr] = useState<string | null>(null)
  const save = useApiMutation<{ p_licence_id: string; p: Record<string, unknown> }>('renew_licence', OPS_REFRESH)
  async function submit() {
    setBusy(true)
    setUpErr(null)
    try {
      const path = file ? await uploadDocument(l.company_id, 'licences', file) : null
      save.mutate({ p_licence_id: l.id, p: { licence_no: f.licence_no.trim() || null, valid_from: f.valid_from, valid_to: f.valid_to, document_path: path, note: f.note.trim() || null } }, { onSuccess: onClose })
    } catch (e) {
      setUpErr(t('opsCommon.uploadFailed', { detail: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
    }
  }
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('licences.renew.title')}
      description={t('licences.renew.hint')}
      submitLabel={t('licences.renew.submit')}
      busy={busy || save.isPending}
      onSubmit={() => void submit()}
      error={
        <>
          {upErr ? (
            <p role="alert" className="sf-field__msg" style={{ margin: 0 }}>
              {upErr}
            </p>
          ) : null}
          <OpsErrorBox error={save.error} />
        </>
      }
    >
      <Field label={t('licences.renew.number')} value={f.licence_no} onChange={(e) => setF({ ...f, licence_no: e.target.value })} help={t('licences.numberHelp')} />
      <FieldGrid cols={2}>
        <Field label={t('licences.renew.from')} type="date" value={f.valid_from} onChange={(e) => setF({ ...f, valid_from: e.target.value })} />
        <Field label={t('licences.renew.to')} type="date" value={f.valid_to} onChange={(e) => setF({ ...f, valid_to: e.target.value })} />
      </FieldGrid>
      <FileField label={t('licences.renew.file')} onFile={setFile} />
      <TextAreaField label={t('licences.note')} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} rows={2} />
    </FormDialog>
  )
}

function LicenceDialog({ companyId, licence, onClose }: { companyId: string; licence: Licence | null; onClose: () => void }) {
  const { t } = useTranslation()
  const branches = useApiView('branches', { eq: { company_id: companyId }, order: 'name' })
  const people = useApiView('people', { order: 'name', limit: 3000 })
  const [f, setF] = useState({
    kind: licence?.kind ?? 'cosmetics_manufacturing',
    title: licence?.title ?? '',
    branch_id: licence?.branch_id ?? '',
    licence_no: licence?.licence_no ?? '',
    issued_by: licence?.issued_by ?? '',
    portal_url: licence?.portal_url ?? '',
    valid_from: licence?.valid_from ?? todayIst(),
    valid_to: licence?.valid_to ?? '',
    status: licence?.status ?? 'active',
    owner_person_id: licence?.owner_person_id ?? '',
    renewal_status: licence?.renewal_status ?? 'ok',
    renewal_applied_on: licence?.renewal_applied_on ?? '',
    note: licence?.note ?? '',
  })
  const [blocks, setBlocks] = useState<string[]>(licence?.blocks ?? [])
  const save = useApiMutation<{ p: Record<string, unknown> }, { id: string }>('upsert_licence', OPS_REFRESH)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const toggle = (b: string, on: boolean) => setBlocks(on ? [...blocks.filter((x) => x !== b), b] : blocks.filter((x) => x !== b))
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={licence ? t('licences.editTitle') : t('licences.addTitle')}
      description={t('licences.dialogHint')}
      submitLabel={t('common.save')}
      busy={save.isPending}
      wide
      error={<OpsErrorBox error={save.error} />}
      onSubmit={() =>
        save.mutate(
          {
            p: {
              id: licence?.id ?? null,
              company_id: companyId,
              kind: f.kind,
              title: f.title.trim() || null,
              branch_id: f.branch_id || null,
              licence_no: f.licence_no.trim(),
              issued_by: f.issued_by.trim() || null,
              portal_url: f.portal_url.trim() || null,
              valid_from: f.valid_from,
              valid_to: f.valid_to || null,
              status: f.status,
              owner_person_id: f.owner_person_id || null,
              is_blocking: blocks.length > 0,
              blocks,
              renewal_status: f.renewal_status,
              renewal_applied_on: f.renewal_applied_on || null,
              note: f.note.trim() || null,
            },
          },
          { onSuccess: onClose },
        )
      }
    >
      <FieldGrid cols={2}>
        <SelectField label={t('licences.col.kind')} value={f.kind} onChange={set('kind')} options={KINDS.map((k) => ({ value: k, label: t(`licences.kind.${k}`) }))} />
        <Field label={t('licences.f.title')} value={f.title} onChange={set('title')} help={t('licences.f.titleHelp')} />
        <SelectField label={t('licences.col.branch')} value={f.branch_id} onChange={set('branch_id')} options={[{ value: '', label: t('licences.allBranches') }, ...rowsOf(branches).map((b) => ({ value: b.id, label: b.name }))]} />
        <Field label={t('licences.col.number')} value={f.licence_no} onChange={set('licence_no')} required help={t('licences.numberHelp')} />
        <Field label={t('licences.col.issuedBy')} value={f.issued_by} onChange={set('issued_by')} />
        <Field label={t('licences.f.portal')} type="url" value={f.portal_url} onChange={set('portal_url')} />
        <Field label={t('licences.col.from')} type="date" value={f.valid_from} onChange={set('valid_from')} required />
        <Field label={t('licences.col.to')} type="date" value={f.valid_to} onChange={set('valid_to')} help={t('licences.toHelp')} />
        <SelectField label={t('licences.col.owner')} value={f.owner_person_id} onChange={set('owner_person_id')} options={[{ value: '', label: t('licences.noOwner') }, ...rowsOf(people).filter((p) => p.status === 'active').map((p) => ({ value: p.id, label: p.person_code ? `${p.person_code} · ${p.name}` : p.name }))]} help={t('licences.f.ownerHelp')} />
        <SelectField label={t('common.status')} value={f.status} onChange={set('status')} options={['active', 'suspended', 'cancelled'].map((s) => ({ value: s, label: t(`licences.status.${s}`) }))} />
        <SelectField label={t('licences.f.renewal')} value={f.renewal_status} onChange={set('renewal_status')} options={['ok', 'renewal_due', 'applied', 'renewed', 'lapsed'].map((s) => ({ value: s, label: t(`licences.renewal.${s}`) }))} />
        {f.renewal_status === 'applied' ? <Field label={t('licences.f.appliedOn')} type="date" value={f.renewal_applied_on} onChange={set('renewal_applied_on')} /> : null}
      </FieldGrid>
      <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <legend style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{t('licences.f.blocks')}</legend>
        <Checkbox label={t('licences.block.production')} checked={blocks.includes('production')} onChange={(e) => toggle('production', e.target.checked)} />
        <Checkbox label={t('licences.block.packing')} checked={blocks.includes('packing')} onChange={(e) => toggle('packing', e.target.checked)} />
        <span className="k">{t('licences.f.blocksHelp')}</span>
      </fieldset>
      <TextAreaField label={t('licences.note')} value={f.note} onChange={set('note')} rows={2} />
    </FormDialog>
  )
}

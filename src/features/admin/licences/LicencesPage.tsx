import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { ProdStatus, ProductionErrorBox, PROD_REFRESH, useProductionRights, ViewError } from '@/features/production/biochem-common/biochem'
import { formatDate } from '@/shared/format'
import { Button, Card, Chip, DataTable, EmptyState, Field, FieldGrid, FormDialog, KpiTiles, PageHeader, SelectField, Skeleton, TextAreaField, type Column } from '@/ui'

type Licence = ViewRow<'licences'>
const KINDS = ['cosmetics_manufacturing', 'drug_manufacturing', 'factory', 'pollution_consent', 'fire', 'trade', 'fssai', 'legal_metrology', 'other'] as const

/**
 * Admin → Licences and documents (`Licences`): every licence a company holds, with its number, dates and whether it is
 * valid today (api.licences.is_valid / days_to_expiry). A missing or expired licence blocks production entry for the
 * process families that need it (api.process_families.licence_ok; enforced by app.check_licence). Entry is Admin only
 * (api.upsert_licence → settings.manage). Licence numbers are typed from the original paper, never invented.
 */
export function LicencesPage() {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const choice = useCompanyChoice()
  const companyId = choice.companyId
  const q = useApiView('licences', { eq: { company_id: companyId }, order: 'valid_to', limit: 500, enabled: Boolean(companyId) })
  const fam = useApiView('process_families', { eq: { company_id: companyId }, order: 'code', enabled: Boolean(companyId) })
  const rows = rowsOf(q)
  const families = rowsOf(fam)
  const [editing, setEditing] = useState<Licence | 'new' | null>(null)

  const blocking = families.filter((f) => f.licence_kind && f.status === 'active' && f.licence_ok === false)
  const soon = rows.filter((r) => r.is_valid && r.days_to_expiry !== null && r.days_to_expiry <= 30)

  const columns: Column<Licence>[] = [
    { key: 'kind', header: t('licences.col.kind'), render: (r) => <strong>{t(`licences.kind.${r.kind}`, { defaultValue: r.kind })}</strong> },
    { key: 'branch', header: t('licences.col.branch'), render: (r) => r.branch_name ?? t('licences.allBranches') },
    { key: 'no', header: t('licences.col.number'), render: (r) => <span className="mono">{r.licence_no}</span> },
    { key: 'by', header: t('licences.col.issuedBy'), render: (r) => r.issued_by ?? '—' },
    { key: 'from', header: t('licences.col.from'), render: (r) => formatDate(r.valid_from) },
    { key: 'to', header: t('licences.col.to'), render: (r) => (r.valid_to ? formatDate(r.valid_to) : t('licences.noExpiry')) },
    {
      key: 'state',
      header: t('licences.col.state'),
      render: (r) =>
        r.status !== 'active' ? (
          <ProdStatus status={r.status} />
        ) : r.is_valid ? (
          r.days_to_expiry !== null && r.days_to_expiry <= 30 ? (
            <Chip tone="signal" icon="clock">
              {t('licences.expiresIn', { n: r.days_to_expiry })}
            </Chip>
          ) : (
            <Chip tone="success" icon="check">
              {t('licences.valid')}
            </Chip>
          )
        ) : (
          <Chip tone="danger" icon="ban">
            {t('licences.notValid')}
          </Chip>
        ),
    },
    {
      key: 'edit',
      header: <span className="sr-only">{t('common.edit')}</span>,
      render: (r) =>
        rights.admin ? (
          <Button size="sm" variant="link" onClick={() => setEditing(r)} aria-label={t('licences.editOne', { kind: t(`licences.kind.${r.kind}`, { defaultValue: r.kind }) })}>
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
            <Button variant="primary" onClick={() => setEditing('new')}>
              {t('licences.add')}
            </Button>
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
          <EmptyState title={t('biochemCommon.noCompany')} />
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <KpiTiles
            ariaLabel={t('licences.kpis')}
            items={[
              { key: 'on', label: t('licences.kpi.onFile'), value: <span data-testid="lic-on-file">{rows.length}</span>, sub: t('licences.kpi.onFileSub') },
              { key: 'valid', label: t('licences.kpi.valid'), value: rows.filter((r) => r.is_valid).length, sub: t('licences.kpi.validSub') },
              { key: 'soon', label: t('licences.kpi.soon'), value: soon.length, sub: t('licences.kpi.soonSub') },
              { key: 'block', label: t('licences.kpi.blocking'), value: <span data-testid="lic-blocking">{blocking.length}</span>, sub: blocking.length ? blocking.map((f) => f.name).join(', ') : t('licences.kpi.blockingNone') },
            ]}
          />
          {!rights.admin ? <p className="muted" style={{ margin: 0 }}>{rights.readOnly ? t('biochemCommon.readOnly') : t('licences.adminOnly')}</p> : null}
          <TableCard title={t('licences.listTitle')}>
            <DataTable
              caption={t('licences.listTitle')}
              columns={columns}
              rows={rows}
              rowKey={(r) => r.id}
              loading={q.isLoading}
              minWidth={900}
              error={q.error ? <ViewError error={q.error} /> : undefined}
              empty={<EmptyState title={t('licences.emptyTitle')} body={t('licences.emptyBody')} />}
            />
          </TableCard>
          <Card title={t('licences.howTitle')}>
            <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <li>{t('licences.how.block')}</li>
              <li>{t('licences.how.paper')}</li>
              <li>{t('licences.how.renew')}</li>
              <li>{t('licences.how.audit')}</li>
            </ul>
          </Card>
        </div>
      )}
      {editing && companyId ? <LicenceDialog companyId={companyId} licence={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </>
  )
}

function LicenceDialog({ companyId, licence, onClose }: { companyId: string; licence: Licence | null; onClose: () => void }) {
  const { t } = useTranslation()
  const branches = useApiView('branches', { eq: { company_id: companyId }, order: 'name' })
  const [f, setF] = useState({
    kind: licence?.kind ?? 'cosmetics_manufacturing',
    branch_id: licence?.branch_id ?? '',
    licence_no: licence?.licence_no ?? '',
    issued_by: licence?.issued_by ?? '',
    valid_from: licence?.valid_from ?? todayIst(),
    valid_to: licence?.valid_to ?? '',
    status: licence?.status ?? 'active',
    note: licence?.note ?? '',
  })
  const save = useApiMutation<{ p: Record<string, unknown> }, { id: string }>('upsert_licence', PROD_REFRESH)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={licence ? t('licences.editTitle') : t('licences.addTitle')}
      description={t('licences.dialogHint')}
      submitLabel={t('common.save')}
      busy={save.isPending}
      wide
      error={<ProductionErrorBox error={save.error} />}
      onSubmit={() =>
        save.mutate(
          { p: { id: licence?.id ?? null, company_id: companyId, ...f, branch_id: f.branch_id || null, valid_to: f.valid_to || null, issued_by: f.issued_by.trim() || null, note: f.note.trim() || null, licence_no: f.licence_no.trim() } },
          { onSuccess: onClose },
        )
      }
    >
      <FieldGrid cols={2}>
        <SelectField label={t('licences.col.kind')} value={f.kind} onChange={set('kind')} options={KINDS.map((k) => ({ value: k, label: t(`licences.kind.${k}`) }))} />
        <SelectField
          label={t('licences.col.branch')}
          value={f.branch_id}
          onChange={set('branch_id')}
          options={[{ value: '', label: t('licences.allBranches') }, ...rowsOf(branches).map((b) => ({ value: b.id, label: b.name }))]}
        />
        <Field label={t('licences.col.number')} value={f.licence_no} onChange={set('licence_no')} required help={t('licences.numberHelp')} />
        <Field label={t('licences.col.issuedBy')} value={f.issued_by} onChange={set('issued_by')} />
        <Field label={t('licences.col.from')} type="date" value={f.valid_from} onChange={set('valid_from')} required />
        <Field label={t('licences.col.to')} type="date" value={f.valid_to} onChange={set('valid_to')} help={t('licences.toHelp')} />
        <SelectField label={t('common.status')} value={f.status} onChange={set('status')} options={['active', 'suspended', 'cancelled'].map((s) => ({ value: s, label: t(`licences.status.${s}`) }))} />
      </FieldGrid>
      <TextAreaField label={t('licences.note')} value={f.note} onChange={set('note')} rows={2} />
    </FormDialog>
  )
}

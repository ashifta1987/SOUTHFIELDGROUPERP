import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { qtyText } from '@/features/inventory/common/inventory'
import { formatDate } from '@/shared/format'
import { Button, Card, Chip, ConfirmDialog, DataTable, EmptyState, Field, FieldGrid, FormDialog, KpiTiles, PageHeader, SelectField, Skeleton, Tabs, TextAreaField, type Column } from '@/ui'
import { Done, ProdStatus, ProductionErrorBox, PROD_REFRESH, useProductionRights, ViewError, type Batch, type FormulaVersion } from '../biochem-common/biochem'
import { FormulaEditor, type EditorSeed } from './FormulaEditor'

type Tab = 'formulas' | 'families' | 'batches'
const TABS: Tab[] = ['formulas', 'families', 'batches']
type Family = ViewRow<'process_families'>
const LICENCE_KINDS = ['', 'cosmetics_manufacturing', 'drug_manufacturing', 'factory', 'pollution_consent', 'fire', 'trade', 'fssai', 'legal_metrology', 'other']

/**
 * Biochem manufacturing (`BiochemManufacturing`): how each product is made. Process families (steps and the licence
 * they need), formula versions (bulk by weight per batch size, packaging in Nos per pack, QC limits by stage) that are
 * written, sent for approval and approved by another person (api.approve_formula_version refuses the writer:
 * sod.own_formula), and the batches made from them. A work order (batch) opens only from an approved formula in force.
 */
export function BiochemManufacturingPage() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const wanted = params.get('tab') as Tab | null
  const tab: Tab = wanted && TABS.includes(wanted) ? wanted : 'formulas'
  const choice = useCompanyChoice()
  const companyId = choice.companyId
  const fam = useApiView('process_families', { eq: { company_id: companyId }, order: 'code', enabled: Boolean(companyId) })
  const ver = useApiView('formula_versions', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 500, enabled: Boolean(companyId) })
  const bat = useApiView('batches', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 300, enabled: Boolean(companyId) })
  const versions = rowsOf(ver)
  const batches = rowsOf(bat)

  function setTab(k: Tab) {
    const next = new URLSearchParams(params)
    next.set('tab', k)
    setParams(next, { replace: true })
  }

  return (
    <>
      <PageHeader
        title={t('biochemManufacturing.title')}
        subtitle={t('biochemManufacturing.subtitle')}
        actions={
          <Link className="sf-btn" to={`/production/biochem-production-entry${companyId ? `?company=${companyId}` : ''}`}>
            {t('biochemManufacturing.toEntry')}
          </Link>
        }
      />
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: 16 }}>
        <Tabs label={t('biochemManufacturing.tabs')} value={tab} onChange={setTab} idBase="bm" controls="bm-panel" tabs={TABS.map((k) => ({ key: k, label: t(`biochemManufacturing.tab.${k}`) }))} />
        <CompanyPicker list={choice.list} value={companyId} onChange={choice.choose} />
      </div>
      <div id="bm-panel" role="tabpanel" aria-labelledby={`bm-tab-${tab}`} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {choice.isLoading ? (
        <Card>
          <Skeleton height={80} />
        </Card>
      ) : !companyId ? (
        <Card>
          <EmptyState title={t('biochemCommon.noCompany')} />
        </Card>
      ) : (
        <>
          <KpiTiles
            ariaLabel={t('biochemManufacturing.kpis')}
            items={[
              { key: 'fam', label: t('biochemManufacturing.kpi.families'), value: rowsOf(fam).length, sub: t('biochemManufacturing.kpi.familiesSub', { n: rowsOf(fam).filter((f) => f.licence_kind).length }) },
              { key: 'appr', label: t('biochemManufacturing.kpi.approved'), value: versions.filter((v) => v.in_force).length, sub: t('biochemManufacturing.kpi.approvedSub') },
              { key: 'wait', label: t('biochemManufacturing.kpi.waiting'), value: versions.filter((v) => v.status === 'submitted').length, sub: t('biochemManufacturing.kpi.waitingSub') },
              { key: 'open', label: t('biochemManufacturing.kpi.open'), value: batches.filter((b) => !['closed', 'cancelled'].includes(b.status)).length, sub: t('biochemManufacturing.kpi.openSub') },
            ]}
          />
          {tab === 'formulas' ? (
            <Formulas key={companyId} companyId={companyId} versions={versions} loading={ver.isLoading} error={ver.error} families={rowsOf(fam)} />
          ) : tab === 'families' ? (
            <Families key={companyId} companyId={companyId} families={rowsOf(fam)} loading={fam.isLoading} error={fam.error} />
          ) : (
            <Batches companyId={companyId} batches={batches} loading={bat.isLoading} error={bat.error} />
          )}
        </>
      )}
      </div>
    </>
  )
}

/* ───────── Formulas ───────── */
function Formulas({ companyId, versions, loading, error, families }: { companyId: string; versions: FormulaVersion[]; loading: boolean; error: unknown; families: Family[] }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const [selected, setSelected] = useState<string | null>(null)
  const [seed, setSeed] = useState<EditorSeed | null>(null)
  const current = versions.find((v) => v.id === selected) ?? null
  const columns: Column<FormulaVersion>[] = [
    { key: 'code', header: t('biochemManufacturing.f.col.formula'), render: (v) => <span><strong className="mono">{v.formula_code}</strong> <span className="k">v{v.version}</span></span> },
    { key: 'product', header: t('biochemManufacturing.f.col.product'), render: (v) => <span>{v.product_name} <span className="k mono">{v.product_code}</span></span> },
    { key: 'family', header: t('biochemManufacturing.f.col.family'), render: (v) => v.family_name },
    { key: 'size', header: t('biochemManufacturing.f.col.batchSize'), align: 'right', render: (v) => <span className="sf-amount">{qtyText(v.batch_size)} kg</span> },
    { key: 'lines', header: t('biochemManufacturing.f.col.lines'), align: 'right', render: (v) => t('biochemManufacturing.f.linesCount', { bulk: v.bulk_lines ?? 0, pack: v.packaging_lines ?? 0 }) },
    { key: 'eff', header: t('biochemManufacturing.f.col.effective'), render: (v) => (v.effective_from ? `${formatDate(v.effective_from)}${v.effective_to ? ` → ${formatDate(v.effective_to)}` : ''}` : '—') },
    { key: 'status', header: t('biochemManufacturing.f.col.status'), render: (v) => <span style={{ display: 'inline-flex', gap: 4 }}><ProdStatus status={v.status} />{v.in_force ? <Chip tone="teal">{t('biochemManufacturing.f.inForce')}</Chip> : null}</span> },
    {
      key: 'open',
      header: <span className="sr-only">{t('common.details')}</span>,
      render: (v) => (
        <Button size="sm" variant="link" onClick={() => setSelected(v.id)} aria-label={t('biochemManufacturing.f.openOne', { code: v.formula_code, v: v.version })}>
          {t('common.details')}
        </Button>
      ),
    },
  ]
  return (
    <>
      {current ? <VersionPanel key={current.id} v={current} onClose={() => setSelected(null)} onNewVersion={(s) => setSeed(s)} /> : null}
      <TableCard
        title={t('biochemManufacturing.f.title')}
        action={
          rights.create ? (
            <Button variant="primary" onClick={() => setSeed({ mode: 'new' })} disabled={families.length === 0} title={families.length === 0 ? t('biochemManufacturing.f.needFamily') : undefined}>
              {t('biochemManufacturing.f.new')}
            </Button>
          ) : null
        }
      >
        <p className="muted" style={{ margin: 0, padding: '0 16px 10px' }}>
          {families.length === 0 ? t('biochemManufacturing.f.needFamily') : t('biochemManufacturing.f.rule')}
        </p>
        <DataTable
          caption={t('biochemManufacturing.f.title')}
          columns={columns}
          rows={versions}
          rowKey={(v) => v.id}
          loading={loading}
          minWidth={980}
          error={error ? <ViewError error={error} /> : undefined}
          empty={<EmptyState title={t('biochemManufacturing.f.emptyTitle')} body={t('biochemManufacturing.f.emptyBody')} />}
        />
      </TableCard>
      {seed ? <FormulaEditor companyId={companyId} families={families} seed={seed} onClose={() => setSeed(null)} onSaved={(id) => setSelected(id)} /> : null}
    </>
  )
}

function VersionPanel({ v, onClose, onNewVersion }: { v: FormulaVersion; onClose: () => void; onNewVersion: (s: EditorSeed) => void }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const lines = useApiView('formula_lines', { eq: { version_id: v.id }, order: 'line_no' })
  const [done, setDone] = useState<string | null>(null)
  const [eff, setEff] = useState(todayIst())
  const [reason, setReason] = useState('')
  const [confirm, setConfirm] = useState(false)
  const submit = useApiMutation<{ p_version_id: string }, { status: string }>('submit_formula_version', PROD_REFRESH)
  const approve = useApiMutation<{ p_version_id: string; p_effective_from: string }, { status: string; effective_from: string }>('approve_formula_version', PROD_REFRESH)
  const withdraw = useApiMutation<{ p_version_id: string; p_reason: string }, { status: string }>('withdraw_formula_version', PROD_REFRESH)
  const err = submit.error ?? approve.error ?? withdraw.error
  const spec = Array.isArray(v.qc_spec) ? (v.qc_spec as { parameter?: string; min?: number | null; max?: number | null; unit?: string | null; stage?: string | null }[]) : []
  const reset = () => {
    setDone(null)
    submit.reset()
    approve.reset()
    withdraw.reset()
  }
  const lineCols: Column<ViewRow<'formula_lines'>>[] = [
    { key: 'kind', header: t('biochemManufacturing.v.kind'), render: (l) => <Chip tone={l.line_kind === 'bulk' ? 'teal' : 'outline'}>{t(`biochemManufacturing.lineKind.${l.line_kind}`)}</Chip> },
    { key: 'item', header: t('biochemManufacturing.v.item'), render: (l) => <span>{l.product_name} <span className="k mono">{l.product_code}</span></span> },
    { key: 'qty', header: t('biochemManufacturing.v.qty'), align: 'right', render: (l) => <span className="sf-amount">{qtyText(l.qty)} {l.uom}</span> },
    { key: 'basis', header: t('biochemManufacturing.v.basis'), render: (l) => (l.line_kind === 'bulk' ? t('biochemManufacturing.v.perBatch', { size: qtyText(v.batch_size) }) : t('biochemManufacturing.v.perPack')) },
    { key: 'note', header: t('biochemManufacturing.v.note'), render: (l) => l.note ?? '' },
  ]
  return (
    <Card
      title={t('biochemManufacturing.v.title', { code: v.formula_code, v: v.version, product: v.product_name })}
      action={
        <Button size="sm" variant="link" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <ProdStatus status={v.status} />
        <span className="k" data-testid="fv-people">
          {[
            t('biochemManufacturing.v.writtenBy', { name: v.created_by_name ?? '—' }),
            v.submitted_at ? t('biochemManufacturing.v.submittedAt', { date: formatDate(v.submitted_at) }) : null,
            v.approved_by_name ? t('biochemManufacturing.v.approvedBy', { name: v.approved_by_name }) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        {t('biochemManufacturing.v.meta', { size: qtyText(v.batch_size), fill: v.fill_qty_g !== null ? `${qtyText(v.fill_qty_g)} g` : t('biochemManufacturing.v.fillFromItem') })}
        {v.notes ? ` · ${v.notes}` : ''}
      </p>
      <DataTable caption={t('biochemManufacturing.v.linesTitle')} columns={lineCols} rows={rowsOf(lines)} rowKey={(l) => l.id} loading={lines.isLoading} minWidth={640} empty={<EmptyState title={t('biochemManufacturing.v.noLines')} />} />
      <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>{t('biochemManufacturing.v.specTitle')}</h3>
      {spec.length === 0 ? (
        <p className="k" style={{ margin: 0 }}>
          {t('biochemManufacturing.v.noSpec')}
        </p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {spec.map((s, i) => (
            <li key={`${s.parameter ?? ''}-${i}`}>
              <strong>{s.parameter}</strong> · {t(`biochemManufacturing.stage.${s.stage ?? 'any'}`, { defaultValue: s.stage ?? '' })} ·{' '}
              {t('biochemManufacturing.v.limits', { min: s.min ?? '—', max: s.max ?? '—', unit: s.unit ?? '' })}
            </li>
          ))}
        </ul>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 16 }}>
        {v.status === 'draft' && rights.create ? (
          <>
            <Button onClick={() => onNewVersion({ mode: 'edit', version: v })}>{t('biochemManufacturing.v.editDraft')}</Button>
            <Button
              variant="primary"
              busy={submit.isPending}
              onClick={() => {
                reset()
                submit.mutate({ p_version_id: v.id }, { onSuccess: () => setDone(t('biochemManufacturing.v.submitted')) })
              }}
            >
              {t('biochemManufacturing.v.submit')}
            </Button>
          </>
        ) : null}
        {v.status === 'submitted' && rights.approve ? (
          <>
            <div style={{ width: 200 }}>
              <Field label={t('biochemManufacturing.v.effectiveFrom')} type="date" value={eff} onChange={(e) => setEff(e.target.value)} />
            </div>
            <Button variant="primary" busy={approve.isPending} onClick={() => setConfirm(true)}>
              {t('biochemManufacturing.v.approve')}
            </Button>
          </>
        ) : null}
        {['approved', 'superseded', 'withdrawn'].includes(v.status) && rights.create ? <Button onClick={() => onNewVersion({ mode: 'version', version: v })}>{t('biochemManufacturing.v.newVersion')}</Button> : null}
        {['draft', 'submitted', 'approved'].includes(v.status) && rights.approve ? (
          <>
            <div style={{ flex: '1 1 220px' }}>
              <Field label={t('biochemManufacturing.v.withdrawReason')} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <Button
              variant="danger"
              busy={withdraw.isPending}
              onClick={() => {
                reset()
                withdraw.mutate({ p_version_id: v.id, p_reason: reason.trim() }, { onSuccess: () => setDone(t('biochemManufacturing.v.withdrawn')) })
              }}
            >
              {t('biochemManufacturing.v.withdraw')}
            </Button>
          </>
        ) : null}
      </div>
      {v.status === 'submitted' && !rights.approve ? <p className="k">{t('biochemManufacturing.v.needApprover')}</p> : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        <ProductionErrorBox error={err} />
        <Done>{done}</Done>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('biochemManufacturing.v.approveTitle')}
        effect={t('biochemManufacturing.v.approveEffect', { code: v.formula_code, v: v.version, date: formatDate(eff) })}
        confirmLabel={t('biochemManufacturing.v.approve')}
        busy={approve.isPending}
        onConfirm={() => {
          reset()
          approve.mutate(
            { p_version_id: v.id, p_effective_from: eff },
            {
              onSuccess: (r) => setDone(t('biochemManufacturing.v.approved', { date: formatDate(r.effective_from) })),
              onSettled: () => setConfirm(false),
            },
          )
        }}
      />
    </Card>
  )
}

/* ───────── Families ───────── */
function Families({ companyId, families, loading, error }: { companyId: string; families: Family[]; loading: boolean; error: unknown }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const [editing, setEditing] = useState<Family | 'new' | null>(null)
  const columns: Column<Family>[] = [
    { key: 'name', header: t('biochemManufacturing.fam.col.family'), render: (f) => <span><strong>{f.name}</strong> <span className="k mono">{f.code}</span></span> },
    { key: 'steps', header: t('biochemManufacturing.fam.col.steps'), render: (f) => (Array.isArray(f.steps) && f.steps.length ? (f.steps as string[]).join(' → ') : <span className="k">{t('biochemManufacturing.fam.noSteps')}</span>) },
    { key: 'lic', header: t('biochemManufacturing.fam.col.licence'), render: (f) => (f.licence_kind ? t(`licences.kind.${f.licence_kind}`, { defaultValue: f.licence_kind }) : t('biochemManufacturing.fam.noLicence')) },
    {
      key: 'licok',
      header: t('biochemManufacturing.fam.col.licenceState'),
      render: (f) =>
        !f.licence_kind ? (
          <span className="k">—</span>
        ) : f.licence_ok ? (
          <Chip tone="success" icon="check">{t('biochemManufacturing.fam.licenceOk')}</Chip>
        ) : (
          <Link to="/admin/licences-and-documents">
            <Chip tone="danger" icon="ban">{t('biochemManufacturing.fam.licenceBlocking')}</Chip>
          </Link>
        ),
    },
    { key: 'formulas', header: t('biochemManufacturing.fam.col.formulas'), align: 'right', render: (f) => `${f.approved_formulas ?? 0} / ${f.formulas ?? 0}` },
    { key: 'status', header: t('common.status'), render: (f) => <ProdStatus status={f.status} /> },
    { key: 'edit', header: <span className="sr-only">{t('common.edit')}</span>, render: (f) => (rights.edit ? <Button size="sm" variant="link" onClick={() => setEditing(f)} aria-label={t('biochemManufacturing.fam.editOne', { name: f.name })}>{t('common.edit')}</Button> : null) },
  ]
  return (
    <>
      <TableCard title={t('biochemManufacturing.fam.title')} action={rights.edit ? <Button variant="primary" onClick={() => setEditing('new')}>{t('biochemManufacturing.fam.add')}</Button> : null}>
        <DataTable
          caption={t('biochemManufacturing.fam.title')}
          columns={columns}
          rows={families}
          rowKey={(f) => f.id}
          loading={loading}
          minWidth={900}
          error={error ? <ViewError error={error} /> : undefined}
          empty={<EmptyState title={t('biochemManufacturing.fam.emptyTitle')} body={t('biochemManufacturing.fam.emptyBody')} />}
        />
      </TableCard>
      {editing ? <FamilyDialog companyId={companyId} family={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </>
  )
}

function FamilyDialog({ companyId, family, onClose }: { companyId: string; family: Family | null; onClose: () => void }) {
  const { t } = useTranslation()
  const [code, setCode] = useState(family?.code ?? '')
  const [name, setName] = useState(family?.name ?? '')
  const [kind, setKind] = useState(family?.licence_kind ?? '')
  const [steps, setSteps] = useState(Array.isArray(family?.steps) ? (family.steps as string[]).join('\n') : '')
  const [status, setStatus] = useState(family?.status ?? 'active')
  const save = useApiMutation<{ p: Record<string, unknown> }, { id: string }>('upsert_process_family', PROD_REFRESH)
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={family ? t('biochemManufacturing.fam.editTitle') : t('biochemManufacturing.fam.addTitle')}
      submitLabel={t('common.save')}
      busy={save.isPending}
      error={<ProductionErrorBox error={save.error} />}
      onSubmit={() =>
        save.mutate(
          {
            p: {
              id: family?.id ?? null,
              company_id: companyId,
              code: code.trim(),
              name: name.trim(),
              licence_kind: kind || null,
              status,
              steps: steps
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean),
            },
          },
          { onSuccess: onClose },
        )
      }
    >
      <FieldGrid cols={2}>
        <Field label={t('common.code')} value={code} onChange={(e) => setCode(e.target.value)} required />
        <Field label={t('common.name')} value={name} onChange={(e) => setName(e.target.value)} required />
        <SelectField label={t('biochemManufacturing.fam.col.licence')} value={kind} onChange={(e) => setKind(e.target.value)} options={LICENCE_KINDS.map((k) => ({ value: k, label: k ? t(`licences.kind.${k}`) : t('biochemManufacturing.fam.noLicence') }))} />
        <SelectField label={t('common.status')} value={status} onChange={(e) => setStatus(e.target.value)} options={['active', 'inactive'].map((s) => ({ value: s, label: t(`biochemCommon.status.${s}`) }))} />
      </FieldGrid>
      <TextAreaField label={t('biochemManufacturing.fam.stepsLabel')} value={steps} onChange={(e) => setSteps(e.target.value)} rows={5} />
    </FormDialog>
  )
}

/* ───────── Batches ───────── */
function Batches({ companyId, batches, loading, error }: { companyId: string; batches: Batch[]; loading: boolean; error: unknown }) {
  const { t } = useTranslation()
  const [status, setStatus] = useState('')
  const shown = useMemo(() => (status ? batches.filter((b) => b.status === status) : batches), [batches, status])
  const columns: Column<Batch>[] = [
    {
      key: 'no',
      header: t('biochemManufacturing.b.col.batch'),
      render: (b) => (
        <Link className="mono" to={`/production/biochem-production-entry?company=${companyId}&batch=${b.id}`}>
          {b.batch_no}
        </Link>
      ),
    },
    { key: 'date', header: t('biochemManufacturing.b.col.date'), render: (b) => formatDate(b.batch_date) },
    { key: 'product', header: t('biochemManufacturing.b.col.product'), render: (b) => b.product_name },
    { key: 'formula', header: t('biochemManufacturing.b.col.formula'), render: (b) => <span className="mono">{b.formula_code} v{b.formula_version}</span> },
    { key: 'qty', header: t('biochemManufacturing.b.col.planned'), align: 'right', render: (b) => <span className="sf-amount">{qtyText(b.planned_qty)} kg</span> },
    { key: 'packs', header: t('biochemManufacturing.b.col.packs'), align: 'right', render: (b) => (b.good_packs !== null ? <span className="sf-amount">{qtyText(b.good_packs)}</span> : '—') },
    { key: 'status', header: t('common.status'), render: (b) => <ProdStatus status={b.status} /> },
  ]
  return (
    <TableCard
      title={t('biochemManufacturing.b.title')}
      action={
        <div style={{ width: 220 }}>
          <SelectField
            label={t('biochemManufacturing.b.filter')}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[{ value: '', label: t('common.all') }, ...['planned', 'reserved', 'weighed', 'in_process', 'sample_sent', 'bulk_passed', 'bulk_failed', 'packing', 'packed_hold', 'released', 'rejected', 'closed', 'cancelled'].map((s) => ({ value: s, label: t(`biochemCommon.status.${s}`) }))]}
          />
        </div>
      }
    >
      <DataTable
        caption={t('biochemManufacturing.b.title')}
        columns={columns}
        rows={shown}
        rowKey={(b) => b.id}
        loading={loading}
        minWidth={860}
        error={error ? <ViewError error={error} /> : undefined}
        empty={<EmptyState title={t('biochemManufacturing.b.emptyTitle')} body={t('biochemManufacturing.b.emptyBody')} />}
      />
    </TableCard>
  )
}

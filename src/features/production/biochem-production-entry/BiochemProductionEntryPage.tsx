import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { qtyText } from '@/features/inventory/common/inventory'
import { formatDate } from '@/shared/format'
import { Button, Card, DataTable, EmptyState, Field, FieldGrid, PageHeader, SelectField, Skeleton, type Column } from '@/ui'
import { cleanNum, Done, ProdStatus, ProductionErrorBox, PROD_REFRESH, useCompanyPlaces, useCompanyProducts, useProductionRights, ViewError, type Batch } from '../biochem-common/biochem'
import { BatchDetail } from './BatchDetail'

/**
 * Biochem production entry (`BiochemProduction`): one batch from planning to close. Plan (needs an approved formula in
 * force and a valid licence — api.plan_batch refuses with prod.no_approved_formula / licence.missing), reserve, weigh
 * and have a second person check each weight (stock leaves the stores only on the check), start, bulk sample, packaging
 * to the line, packing into quarantine, reconciliation, QC release by someone who did not make the batch, and close
 * with the cost sheet. Every rule is enforced by the database; the screen explains refusals.
 */
export function BiochemProductionEntryPage() {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const [params, setParams] = useSearchParams()
  const choice = useCompanyChoice()
  const companyId = choice.companyId
  const batchId = params.get('batch')
  const q = useApiView('batches', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 300, enabled: Boolean(companyId) })
  const batches = rowsOf(q)
  const current = batches.find((b) => b.id === batchId) ?? null

  function openBatch(id: string | null) {
    const next = new URLSearchParams(params)
    if (id) next.set('batch', id)
    else next.delete('batch')
    setParams(next, { replace: true })
  }

  const open = batches.filter((b) => !['closed', 'cancelled'].includes(b.status))
  const columns: Column<Batch>[] = [
    {
      key: 'no',
      header: t('biochemEntry.list.batch'),
      render: (b) => (
        <Button size="sm" variant="link" onClick={() => openBatch(b.id)} aria-label={t('biochemEntry.list.open', { no: b.batch_no })}>
          <span className="mono">{b.batch_no}</span>
        </Button>
      ),
    },
    { key: 'product', header: t('biochemEntry.list.product'), render: (b) => b.product_name },
    { key: 'date', header: t('biochemEntry.list.date'), render: (b) => formatDate(b.batch_date) },
    { key: 'qty', header: t('biochemEntry.list.planned'), align: 'right', render: (b) => <span className="sf-amount">{qtyText(b.planned_qty)} kg</span> },
    { key: 'status', header: t('common.status'), render: (b) => <ProdStatus status={b.status} /> },
  ]

  return (
    <>
      <PageHeader
        title={current ? t('biochemEntry.titleBatch', { no: current.batch_no }) : t('biochemEntry.title')}
        subtitle={
          <>
            {t('biochemEntry.subtitle')} <Link to={`/production/biochem-production-flow${companyId ? `?company=${companyId}` : ''}`}>{t('biochemEntry.flowLink')}</Link>
          </>
        }
        actions={
          current ? (
            <Button onClick={() => openBatch(null)}>{t('biochemEntry.back')}</Button>
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
      ) : current ? (
        <BatchDetail key={current.id} batch={current} />
      ) : batchId && q.isLoading ? (
        <Card>
          <Skeleton height={120} />
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="sf-alert" data-tone="info" style={{ margin: 0 }}>
            {t('biochemEntry.licenceNote')}
          </div>
          {rights.create ? <PlanBatch companyId={companyId} onPlanned={openBatch} /> : <p className="muted">{rights.readOnly ? t('biochemCommon.readOnly') : t('biochemEntry.noCreate')}</p>}
          <TableCard title={t('biochemEntry.list.title')}>
            <DataTable
              caption={t('biochemEntry.list.title')}
              columns={columns}
              rows={open}
              rowKey={(b) => b.id}
              loading={q.isLoading}
              minWidth={700}
              error={q.error ? <ViewError error={q.error} /> : undefined}
              empty={<EmptyState title={t('biochemEntry.list.emptyTitle')} body={t('biochemEntry.list.emptyBody')} />}
            />
          </TableCard>
        </div>
      )}
    </>
  )
}

function PlanBatch({ companyId, onPlanned }: { companyId: string; onPlanned: (id: string) => void }) {
  const { t } = useTranslation()
  const products = useCompanyProducts(companyId)
  const places = useCompanyPlaces(companyId)
  const versions = useApiView('formula_versions', { eq: { company_id: companyId, in_force: true }, order: 'product_name' })
  const inForce = rowsOf(versions)
  const [f, setF] = useState({ product_id: '', date: todayIst(), shift: 'day', line_place_id: '', stores_place_id: '', fg_place_id: '', planned_qty: '', note: '' })
  const [hint, setHint] = useState<string | null>(null)
  const plan = useApiMutation<{ p: Record<string, unknown> }, { id: string; batch_no: string }>('plan_batch', PROD_REFRESH)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const counted = products.list.filter((p) => ['NOS', 'PCS', 'BOX', 'CTN', 'PAC', 'SET'].includes(p.uom))
  const fv = inForce.find((v) => v.product_id === f.product_id)
  const placeOpts = [{ value: '', label: t('biochemEntry.plan.choosePlace') }, ...places.list.map((p) => ({ value: p.id, label: `${p.name} · ${p.branch_name}` }))]

  return (
    <Card title={t('biochemEntry.plan.title')}>
      <FieldGrid cols={3}>
        <SelectField
          label={t('biochemEntry.plan.product')}
          value={f.product_id}
          onChange={set('product_id')}
          options={[{ value: '', label: t('biochemEntry.plan.chooseProduct') }, ...counted.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))]}
          help={f.product_id ? (fv ? t('biochemEntry.plan.formulaInForce', { code: fv.formula_code, v: fv.version, size: qtyText(fv.batch_size) }) : t('biochemEntry.plan.noFormula')) : undefined}
        />
        <Field label={t('biochemEntry.plan.date')} type="date" value={f.date} onChange={set('date')} />
        <SelectField label={t('biochemEntry.plan.shift')} value={f.shift} onChange={set('shift')} options={['day', 'night', 'general'].map((s) => ({ value: s, label: t(`biochemEntry.shift.${s}`) }))} />
        <SelectField label={t('biochemEntry.plan.line')} value={f.line_place_id} onChange={set('line_place_id')} options={placeOpts} />
        <SelectField label={t('biochemEntry.plan.stores')} value={f.stores_place_id} onChange={set('stores_place_id')} options={placeOpts} />
        <SelectField label={t('biochemEntry.plan.fg')} value={f.fg_place_id} onChange={set('fg_place_id')} options={placeOpts} help={t('biochemEntry.plan.fgHelp')} />
        <Field label={t('biochemEntry.plan.qty')} inputMode="decimal" value={f.planned_qty} onChange={set('planned_qty')} />
        <Field label={t('biochemEntry.plan.note')} value={f.note} onChange={set('note')} />
      </FieldGrid>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button
          variant="primary"
          busy={plan.isPending}
          onClick={() => {
            setHint(null)
            const qty = cleanNum(f.planned_qty)
            if (!f.product_id || !f.line_place_id || !f.stores_place_id || !f.fg_place_id || !qty) return setHint(t('biochemEntry.plan.hint'))
            plan.mutate({ p: { company_id: companyId, ...f, planned_qty: qty, note: f.note.trim() || null } }, { onSuccess: (r) => onPlanned(r.id) })
          }}
        >
          {t('biochemEntry.plan.submit')}
        </Button>
        <span className="k">{t('biochemEntry.plan.numberOnSave')}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        {hint ? (
          <p role="alert" className="sf-alert" data-tone="danger" style={{ margin: 0 }}>
            {hint}
          </p>
        ) : null}
        <ProductionErrorBox error={plan.error} />
        <Done>{plan.data ? t('biochemEntry.plan.done', { no: plan.data.batch_no }) : null}</Done>
      </div>
    </Card>
  )
}

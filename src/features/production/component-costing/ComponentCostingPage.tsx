import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { TableCard } from '@/features/admin/import-data/layout'
import { qtyText } from '@/features/inventory/common/inventory'
import { Button, Card, Chip, DataTable, EmptyState, Field, FieldGrid, FormDialog, SelectField, type Column } from '@/ui'
import { CostCell, useCompanyProducts, useProductionRights, ViewError } from '../biochem-common/biochem'
import { CostHiddenBanner, PlasticsErrorBox, PlasticsFrame, PLASTICS_REFRESH } from '../plastics-common/plastics'

type Spec = ViewRow<'material_specs'>
type Cost = ViewRow<'component_costs'>

/**
 * Component costing (`ComponentCosting`): the material spec of each moulded part (granule, grade, colour, masterbatch %,
 * part and runner weight, cavities, packing per piece) and what one piece costs in granules, masterbatch, packing and
 * mould wear — worked out by api.component_costs at average stock cost (cost right only). A granule with no cost is
 * listed, never guessed. Without the cost right every money column is hidden, never zero.
 */
export function ComponentCostingPage() {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const [editing, setEditing] = useState<Spec | 'new' | null>(null)
  return (
    <PlasticsFrame
      step="componentCosting"
      title={t('plComponentCosting.title')}
      subtitle={t('plComponentCosting.subtitle')}
      actions={() =>
        rights.edit ? (
          <Button variant="primary" onClick={() => setEditing('new')}>
            {t('plComponentCosting.add')}
          </Button>
        ) : null
      }
    >
      {(companyId) => (
        <>
          <Costs companyId={companyId} onEdit={setEditing} />
          {editing ? <SpecDialog companyId={companyId} spec={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
        </>
      )}
    </PlasticsFrame>
  )
}

function Costs({ companyId, onEdit }: { companyId: string; onEdit: (s: Spec) => void }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const specs = useApiView('material_specs', { eq: { company_id: companyId }, order: 'product_code', limit: 2000 })
  const costs = useApiView('component_costs', { eq: { company_id: companyId }, limit: 2000, enabled: rights.costs })
  const byId = new Map<string, Cost>(rowsOf(costs).map((c) => [c.product_id, c]))
  const missing = rowsOf(costs).filter((c) => c.granule_cost_missing)
  const cols: Column<Spec>[] = [
    {
      key: 'part',
      header: t('plComponentCosting.col.part'),
      render: (s) =>
        rights.edit ? (
          <Button size="sm" variant="link" onClick={() => onEdit(s)} aria-label={t('plComponentCosting.editOne', { code: s.product_code, name: s.product_name })}>
            {s.product_code} · {s.product_name}
          </Button>
        ) : (
          `${s.product_code} · ${s.product_name}`
        ),
    },
    { key: 'granule', header: t('plComponentCosting.col.granule'), render: (s) => [s.granule_code, s.grade, s.colour].filter(Boolean).join(' · ') || '—' },
    { key: 'mb', header: t('plComponentCosting.col.masterbatch'), render: (s) => (s.masterbatch_code ? `${s.masterbatch_code} · ${qtyText(s.masterbatch_pct)} %` : '—') },
    { key: 'w', header: t('plComponentCosting.col.weights'), align: 'right', render: (s) => <span className="sf-amount">{qtyText(s.part_weight_g)} + {qtyText(s.runner_weight_g)} g</span> },
    { key: 'cav', header: t('plComponentCosting.col.cavities'), align: 'right', render: (s) => <span className="sf-amount">{s.cavities ?? '—'}</span> },
    { key: 'gc', header: t('plComponentCosting.col.granuleCost'), align: 'right', render: (s) => <CostCell value={byId.get(s.product_id)?.granule_cost} digits={4} /> },
    { key: 'mc', header: t('plComponentCosting.col.mbCost'), align: 'right', render: (s) => <CostCell value={byId.get(s.product_id)?.masterbatch_cost} digits={4} /> },
    { key: 'pc', header: t('plComponentCosting.col.packing'), align: 'right', render: (s) => <CostCell value={byId.get(s.product_id)?.packing_cost} digits={4} /> },
    { key: 'mo', header: t('plComponentCosting.col.mould'), align: 'right', render: (s) => <CostCell value={byId.get(s.product_id)?.mould_cost} digits={4} /> },
    { key: 'flag', header: t('plComponentCosting.col.flag'), render: (s) => (byId.get(s.product_id)?.granule_cost_missing ? <Chip tone="signal" icon="alert">{t('plComponentCosting.noGranuleCost')}</Chip> : <span className="k">—</span>) },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card title={t('plComponentCosting.how.title')}>
        <p className="mono" style={{ margin: '0 0 12px', padding: '10px 12px', background: 'var(--sf-paper)', borderRadius: 6 }}>
          {t('plComponentCosting.how.formula')}
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          {['granule', 'masterbatch', 'packing', 'mould'].map((k) => (
            <div key={k}>
              <strong>{t(`plComponentCosting.how.${k}.title`)}</strong>
              <div className="muted">{t(`plComponentCosting.how.${k}.body`)}</div>
            </div>
          ))}
        </div>
      </Card>
      {!rights.costs ? <CostHiddenBanner /> : null}
      {missing.length ? (
        <div role="alert" className="sf-alert" data-tone="signal" style={{ margin: 0, flexDirection: 'column' }} data-testid="granule-cost-missing">
          <strong>{t('plComponentCosting.missingTitle', { n: missing.length })}</strong>
          <span>{missing.slice(0, 20).map((c) => c.product_code).join(', ')}</span>
        </div>
      ) : null}
      <ViewError error={specs.error ?? costs.error} />
      <TableCard title={t('plComponentCosting.listTitle')}>
        <DataTable caption={t('plComponentCosting.listTitle')} columns={cols} rows={rowsOf(specs)} rowKey={(s) => s.id} loading={specs.isLoading} minWidth={1300} empty={<EmptyState title={t('plComponentCosting.emptyTitle')} body={t('plComponentCosting.emptyBody')} />} />
      </TableCard>
    </div>
  )
}

function SpecDialog({ companyId, spec, onClose }: { companyId: string; spec: Spec | null; onClose: () => void }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const products = useCompanyProducts(companyId)
  const save = useApiMutation<{ p: Record<string, unknown> }, { id: string }>('upsert_material_spec', PLASTICS_REFRESH)
  const s = (v: number | string | null | undefined) => (v === null || v === undefined ? '' : String(v))
  const [f, setF] = useState({
    product_id: spec?.product_id ?? '',
    granule_product_id: spec?.granule_product_id ?? '',
    grade: spec?.grade ?? '',
    colour: spec?.colour ?? '',
    masterbatch_product_id: spec?.masterbatch_product_id ?? '',
    masterbatch_pct: s(spec?.masterbatch_pct),
    part_weight_g: s(spec?.part_weight_g),
    runner_weight_g: s(spec?.runner_weight_g),
    cavities: s(spec?.cavities),
    packing_cost_per_piece: s(spec?.packing_cost_per_piece),
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const n = (v: string) => (v.trim() ? v.trim().replace(/,/g, '') : null)
  const opts = [{ value: '', label: t('plComponentCosting.f.none') }, ...products.list.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))]
  return (
    <FormDialog
      open
      wide
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={spec ? t('plComponentCosting.editTitle') : t('plComponentCosting.addTitle')}
      submitLabel={t('common.save')}
      busy={save.isPending}
      error={<PlasticsErrorBox error={save.error} />}
      onSubmit={() =>
        save.mutate(
          {
            p: {
              company_id: companyId,
              product_id: n(f.product_id),
              granule_product_id: n(f.granule_product_id),
              grade: n(f.grade),
              colour: n(f.colour),
              masterbatch_product_id: n(f.masterbatch_product_id),
              masterbatch_pct: n(f.masterbatch_pct),
              part_weight_g: n(f.part_weight_g),
              runner_weight_g: n(f.runner_weight_g),
              cavities: n(f.cavities),
              packing_cost_per_piece: rights.costs ? n(f.packing_cost_per_piece) : (spec?.packing_cost_per_piece ?? null),
            },
          },
          { onSuccess: onClose },
        )
      }
    >
      <FieldGrid cols={3}>
        <SelectField label={t('plComponentCosting.f.part')} value={f.product_id} onChange={set('product_id')} options={opts} disabled={Boolean(spec)} />
        <SelectField label={t('plComponentCosting.f.granule')} value={f.granule_product_id} onChange={set('granule_product_id')} options={opts} />
        <Field label={t('plComponentCosting.f.grade')} value={f.grade} onChange={set('grade')} />
        <Field label={t('plComponentCosting.f.colour')} value={f.colour} onChange={set('colour')} />
        <SelectField label={t('plComponentCosting.f.masterbatch')} value={f.masterbatch_product_id} onChange={set('masterbatch_product_id')} options={opts} />
        <Field label={t('plComponentCosting.f.mbPct')} inputMode="decimal" value={f.masterbatch_pct} onChange={set('masterbatch_pct')} />
        <Field label={t('plComponentCosting.f.partWeight')} inputMode="decimal" value={f.part_weight_g} onChange={set('part_weight_g')} />
        <Field label={t('plComponentCosting.f.runnerWeight')} inputMode="decimal" value={f.runner_weight_g} onChange={set('runner_weight_g')} />
        <Field label={t('plComponentCosting.f.cavities')} inputMode="numeric" value={f.cavities} onChange={set('cavities')} />
        {rights.costs ? <Field label={t('plComponentCosting.f.packing')} inputMode="decimal" value={f.packing_cost_per_piece} onChange={set('packing_cost_per_piece')} /> : null}
      </FieldGrid>
    </FormDialog>
  )
}

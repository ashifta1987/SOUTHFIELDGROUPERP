import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { qtyText } from '@/features/inventory/common/inventory'
import { formatDate } from '@/shared/format'
import { Button, Card, Chip, DataTable, EmptyState, Field, FieldGrid, Locked, PageHeader, SelectField, Skeleton, type Column } from '@/ui'
import { cleanNum, CostCell, Done, ProdStatus, ProductionErrorBox, PROD_REFRESH, useProductionRights, ViewError } from '../biochem-common/biochem'

type Cost = ViewRow<'batch_costs'>
const RATE_KINDS = ['labour_hour', 'machine_hour', 'overhead_per_kg', 'overhead_per_piece'] as const

/**
 * Biochem costing (`BiochemCosting`): the cost of one saleable pack per batch — materials and packaging at lot rates
 * from the consumption ledger, plus labour and machine hours and overhead per kg at the rates Admin sets (computed by
 * app.batch_cost; fixed on close). Missing rates count as zero and are listed (rates_missing), never invented. Costs
 * need the cost right; without it they are hidden, never shown as zero.
 */
export function BiochemCostingPage() {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const choice = useCompanyChoice()
  const companyId = choice.companyId
  const q = useApiView('batch_costs', { eq: { company_id: companyId }, order: 'batch_no', ascending: false, limit: 500, enabled: Boolean(companyId) && rights.costs })
  const rows = rowsOf(q)
  const missing = rows.filter((r) => (r.rates_missing ?? []).length > 0)

  const cols: Column<Cost>[] = [
    { key: 'batch', header: t('biochemCosting.col.batch'), render: (r) => <Link className="mono" to={`/production/biochem-production-entry?company=${r.company_id}&batch=${r.batch_id}`}>{r.batch_no}</Link> },
    { key: 'product', header: t('biochemCosting.col.product'), render: (r) => <span>{r.product_name} <span className="k mono">{r.product_code}</span></span> },
    { key: 'status', header: t('common.status'), render: (r) => <span style={{ display: 'inline-flex', gap: 4 }}><ProdStatus status={r.status} />{r.final ? <Chip tone="neutral">{t('biochemCosting.final')}</Chip> : <Chip tone="outline">{t('biochemCosting.running')}</Chip>}</span> },
    { key: 'mat', header: t('biochemCosting.col.materials'), align: 'right', render: (r) => <CostCell value={r.materials} /> },
    { key: 'pack', header: t('biochemCosting.col.packaging'), align: 'right', render: (r) => <CostCell value={r.packaging} /> },
    { key: 'lab', header: t('biochemCosting.col.labour'), align: 'right', render: (r) => <CostCell value={r.labour} /> },
    { key: 'mach', header: t('biochemCosting.col.machine'), align: 'right', render: (r) => <CostCell value={r.machine} /> },
    { key: 'ovh', header: t('biochemCosting.col.overhead'), align: 'right', render: (r) => <CostCell value={r.overhead} /> },
    { key: 'total', header: t('biochemCosting.col.total'), align: 'right', render: (r) => <strong><CostCell value={r.total} /></strong> },
    { key: 'packs', header: t('biochemCosting.col.packs'), align: 'right', render: (r) => (r.good_packs !== null ? <span className="sf-amount">{qtyText(r.good_packs)}</span> : '—') },
    { key: 'per', header: t('biochemCosting.col.perPack'), align: 'right', render: (r) => <CostCell value={r.cost_per_pack} digits={4} /> },
    { key: 'mrp', header: t('biochemCosting.col.mrp'), align: 'right', render: (r) => <CostCell value={r.mrp} /> },
    {
      key: 'missing',
      header: t('biochemCosting.col.missing'),
      render: (r) =>
        (r.rates_missing ?? []).length ? (
          <Chip tone="signal" icon="alert">
            {(r.rates_missing ?? []).map((k) => t(`biochemCosting.rate.${k}`, { defaultValue: k })).join(', ')}
          </Chip>
        ) : (
          <span className="k">—</span>
        ),
    },
  ]

  return (
    <>
      <PageHeader title={t('biochemCosting.title')} subtitle={t('biochemCosting.subtitle')} />
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
          <Card title={t('biochemCosting.how.title')}>
            <p className="mono" style={{ margin: '0 0 12px', padding: '10px 12px', background: 'var(--sf-paper)', borderRadius: 6 }}>
              {t('biochemCosting.how.formula')}
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
              {['materials', 'packaging', 'labour', 'overhead'].map((k) => (
                <div key={k}>
                  <strong>{t(`biochemCosting.how.${k}.title`)}</strong>
                  <div className="muted">{t(`biochemCosting.how.${k}.body`)}</div>
                </div>
              ))}
            </div>
          </Card>
          {!rights.costs ? (
            <Card>
              <Locked>{t('biochemCosting.noCostRight')}</Locked>
            </Card>
          ) : (
            <>
              {missing.length ? (
                <div role="alert" className="sf-alert" data-tone="danger" style={{ margin: 0, flexDirection: 'column' }} data-testid="rates-missing">
                  <strong>{t('biochemCosting.missingTitle', { n: missing.length })}</strong>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {missing.slice(0, 20).map((r) => (
                      <li key={r.batch_id}>
                        <span className="mono">{r.batch_no}</span> · {(r.rates_missing ?? []).map((k) => t(`biochemCosting.rate.${k}`, { defaultValue: k })).join(', ')}
                      </li>
                    ))}
                  </ul>
                  <span>{t('biochemCosting.missingNext')}</span>
                </div>
              ) : null}
              <TableCard title={t('biochemCosting.listTitle')}>
                <DataTable caption={t('biochemCosting.listTitle')} columns={cols} rows={rows} rowKey={(r) => r.batch_id} loading={q.isLoading} minWidth={1300} error={q.error ? <ViewError error={q.error} /> : undefined} empty={<EmptyState title={t('biochemCosting.emptyTitle')} body={t('biochemCosting.emptyBody')} />} />
              </TableCard>
              <Rates companyId={companyId} />
            </>
          )}
        </div>
      )}
    </>
  )
}

function Rates({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const q = useApiView('cost_rates', { eq: { company_id: companyId }, order: 'effective_from', ascending: false })
  const save = useApiMutation<{ p: Record<string, unknown> }, { id: string }>('set_cost_rate', PROD_REFRESH)
  const [f, setF] = useState({ kind: 'labour_hour', rate: '', effective_from: todayIst(), note: '' })
  const [hint, setHint] = useState<string | null>(null)
  const cols: Column<ViewRow<'cost_rates'>>[] = [
    { key: 'kind', header: t('biochemCosting.rates.kind'), render: (r) => t(`biochemCosting.rate.${r.kind}`, { defaultValue: r.kind }) },
    { key: 'rate', header: t('biochemCosting.rates.rate'), align: 'right', render: (r) => <CostCell value={r.rate} /> },
    { key: 'from', header: t('biochemCosting.rates.from'), render: (r) => formatDate(r.effective_from) },
    { key: 'note', header: t('biochemCosting.rates.note'), render: (r) => r.note ?? '' },
  ]
  return (
    <TableCard title={t('biochemCosting.rates.title')}>
      <DataTable caption={t('biochemCosting.rates.title')} columns={cols} rows={rowsOf(q)} rowKey={(r) => r.id} loading={q.isLoading} minWidth={600} empty={<EmptyState title={t('biochemCosting.rates.empty')} body={t('biochemCosting.rates.emptyBody')} />} />
      {rights.admin ? (
        <div style={{ padding: 16 }}>
          <FieldGrid cols={3}>
            <SelectField label={t('biochemCosting.rates.kind')} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} options={RATE_KINDS.map((k) => ({ value: k, label: t(`biochemCosting.rate.${k}`) }))} />
            <Field label={t('biochemCosting.rates.rate')} inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />
            <Field label={t('biochemCosting.rates.from')} type="date" value={f.effective_from} onChange={(e) => setF({ ...f, effective_from: e.target.value })} />
            <Field label={t('biochemCosting.rates.note')} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          </FieldGrid>
          <div style={{ marginTop: 8 }}>
            <Button
              variant="primary"
              busy={save.isPending}
              onClick={() => {
                setHint(null)
                const rate = cleanNum(f.rate, true)
                if (rate === null) return setHint(t('biochemCosting.rates.hint'))
                save.mutate({ p: { company_id: companyId, kind: f.kind, rate, effective_from: f.effective_from, note: f.note.trim() || null } })
              }}
            >
              {t('biochemCosting.rates.save')}
            </Button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {hint ? (
              <p role="alert" className="sf-alert" data-tone="danger" style={{ margin: 0 }}>
                {hint}
              </p>
            ) : null}
            <ProductionErrorBox error={save.error} />
            <Done>{save.data ? t('biochemCosting.rates.saved') : null}</Done>
          </div>
        </div>
      ) : (
        <p className="k" style={{ padding: '0 16px 16px', margin: 0 }}>
          {t('biochemCosting.rates.adminOnly')}
        </p>
      )}
    </TableCard>
  )
}

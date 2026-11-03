import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { qtyText } from '@/features/inventory/common/inventory'
import { formatDate } from '@/shared/format'
import { Button, Card, DataTable, EmptyState, Field, FieldGrid, KpiTiles, SelectField, type Column } from '@/ui'
import { CostCell, Done, useCompanyPlaces, useCompanyProducts, useProductionRights, ViewError } from '../biochem-common/biochem'
import { PlasticsErrorBox, PlasticsFrame, PLASTICS_REFRESH, useCompanyPeople, useMachines } from '../plastics-common/plastics'

type Job = ViewRow<'pad_print_jobs'>

/**
 * Pad printing (`PadPrinting`): print jobs — the part, machine, operator, pieces printed and rejected, prints per piece,
 * ink issued from stock into the consumption ledger and labour minutes (api.record_pad_print_job). Ink value and cost
 * per print are worked out by the server and shown only with the cost right.
 */
export function PadPrintingPage() {
  const { t } = useTranslation()
  return (
    <PlasticsFrame step="padPrinting" title={t('plPadPrinting.title')} subtitle={t('plPadPrinting.subtitle')}>
      {(companyId) => <PadPrinting companyId={companyId} />}
    </PlasticsFrame>
  )
}

function PadPrinting({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const jobs = useApiView('pad_print_jobs', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 300 })
  const all = rowsOf(jobs)
  const today = all.filter((j) => j.job_date === todayIst())
  const n = (v: number) => (jobs.isLoading ? '…' : qtyText(v))
  const cols: Column<Job>[] = [
    { key: 'doc', header: t('plPadPrinting.col.doc'), render: (j) => <span className="mono">{j.doc_no}</span> },
    { key: 'date', header: t('plPadPrinting.col.date'), render: (j) => formatDate(j.job_date) },
    { key: 'part', header: t('plPadPrinting.col.part'), render: (j) => `${j.product_code} · ${j.product_name}` },
    { key: 'machine', header: t('plPadPrinting.col.machine'), render: (j) => (j.machine_code ? <span className="mono">{j.machine_code}</span> : '—') },
    { key: 'op', header: t('plPadPrinting.col.operator'), render: (j) => j.operator_name ?? '—' },
    { key: 'printed', header: t('plPadPrinting.col.printed'), align: 'right', render: (j) => <span className="sf-amount">{qtyText(j.qty_printed)}</span> },
    { key: 'rej', header: t('plPadPrinting.col.rejected'), align: 'right', render: (j) => <span className="sf-amount">{qtyText(j.qty_rejected)}</span> },
    { key: 'ppp', header: t('plPadPrinting.col.prints'), align: 'right', render: (j) => <span className="sf-amount">{j.prints_per_piece}</span> },
    { key: 'ink', header: t('plPadPrinting.col.ink'), align: 'right', render: (j) => <span className="sf-amount">{qtyText(j.ink_qty)}</span> },
    { key: 'inkv', header: t('plPadPrinting.col.inkValue'), align: 'right', render: (j) => <CostCell value={j.ink_value} /> },
    { key: 'cpp', header: t('plPadPrinting.col.perPrint'), align: 'right', render: (j) => <CostCell value={j.cost_per_print} digits={4} /> },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <KpiTiles
        ariaLabel={t('plPadPrinting.kpis')}
        items={[
          { key: 'jobs', label: t('plPadPrinting.kpi.jobs'), value: n(today.length), sub: t('plPadPrinting.kpi.today') },
          { key: 'printed', label: t('plPadPrinting.kpi.printed'), value: n(today.reduce((s, j) => s + Number(j.qty_printed), 0)), sub: t('plPadPrinting.kpi.today') },
          { key: 'rejected', label: t('plPadPrinting.kpi.rejected'), value: n(today.reduce((s, j) => s + Number(j.qty_rejected), 0)), sub: t('plPadPrinting.kpi.today') },
          { key: 'labour', label: t('plPadPrinting.kpi.labour'), value: n(today.reduce((s, j) => s + Number(j.labour_minutes), 0)), sub: t('plPadPrinting.kpi.minutes') },
        ]}
      />
      {rights.create ? <NewJob companyId={companyId} /> : <Card><p className="k" style={{ margin: 0 }}>{t('plPadPrinting.noCreate')}</p></Card>}
      <ViewError error={jobs.error} />
      <TableCard title={t('plPadPrinting.listTitle')}>
        <DataTable caption={t('plPadPrinting.listTitle')} columns={cols} rows={all} rowKey={(j) => j.id} loading={jobs.isLoading} minWidth={1200} empty={<EmptyState title={t('plPadPrinting.emptyTitle')} body={t('plPadPrinting.emptyBody')} />} />
      </TableCard>
      <Card title={t('plPadPrinting.cost.title')}>
        <p className="mono" style={{ margin: '0 0 8px', padding: '10px 12px', background: 'var(--sf-paper)', borderRadius: 6 }}>
          {t('plPadPrinting.cost.formula')}
        </p>
        <p className="muted" style={{ margin: 0 }}>
          {t('plPadPrinting.cost.body')}
        </p>
      </Card>
    </div>
  )
}

function NewJob({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const products = useCompanyProducts(companyId)
  const places = useCompanyPlaces(companyId)
  const machines = useMachines(companyId, ['pad_printer'])
  const people = useCompanyPeople(companyId)
  const save = useApiMutation<{ p: Record<string, unknown> }, { id: string; doc_no: string; ink_value: number | null }>('record_pad_print_job', PLASTICS_REFRESH)
  const [f, setF] = useState({ date: todayIst(), product_id: '', machine_asset_id: '', operator_user_id: '', qty_printed: '', qty_rejected: '', prints_per_piece: '1', ink_product_id: '', ink_qty: '', ink_place_id: '', labour_minutes: '', note: '' })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const num = (v: string) => v.replace(/[,\s]/g, '') || null
  const itemOpts = [{ value: '', label: t('plPadPrinting.f.chooseItem') }, ...products.list.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))]
  return (
    <Card title={t('plPadPrinting.new.title')}>
      <FieldGrid cols={3}>
        <Field label={t('plPadPrinting.f.date')} type="date" value={f.date} onChange={set('date')} />
        <SelectField label={t('plPadPrinting.f.part')} value={f.product_id} onChange={set('product_id')} options={itemOpts} />
        <SelectField label={t('plPadPrinting.f.machine')} value={f.machine_asset_id} onChange={set('machine_asset_id')} options={[{ value: '', label: t('plPadPrinting.f.noMachine') }, ...machines.list.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))]} />
        <SelectField label={t('plPadPrinting.f.operator')} value={f.operator_user_id} onChange={set('operator_user_id')} options={[{ value: '', label: t('plPadPrinting.f.noOperator') }, ...people.list.map((p) => ({ value: p.user_id, label: p.display_name ?? '—' }))]} />
        <Field label={t('plPadPrinting.f.printed')} inputMode="numeric" value={f.qty_printed} onChange={set('qty_printed')} />
        <Field label={t('plPadPrinting.f.rejected')} inputMode="numeric" value={f.qty_rejected} onChange={set('qty_rejected')} />
        <Field label={t('plPadPrinting.f.prints')} inputMode="numeric" value={f.prints_per_piece} onChange={set('prints_per_piece')} />
        <SelectField label={t('plPadPrinting.f.ink')} value={f.ink_product_id} onChange={set('ink_product_id')} options={[{ value: '', label: t('plPadPrinting.f.noInk') }, ...itemOpts.slice(1)]} />
        <Field label={t('plPadPrinting.f.inkQty')} inputMode="decimal" value={f.ink_qty} onChange={set('ink_qty')} />
        <SelectField label={t('plPadPrinting.f.inkFrom')} value={f.ink_place_id} onChange={set('ink_place_id')} options={[{ value: '', label: t('plPadPrinting.f.choosePlace') }, ...places.list.map((p) => ({ value: p.id, label: `${p.name} · ${p.branch_name}` }))]} />
        <Field label={t('plPadPrinting.f.labour')} inputMode="numeric" value={f.labour_minutes} onChange={set('labour_minutes')} />
        <Field label={t('plPadPrinting.f.note')} value={f.note} onChange={set('note')} />
      </FieldGrid>
      <div style={{ marginTop: 8 }}>
        <Button
          variant="primary"
          busy={save.isPending}
          onClick={() =>
            save.mutate({
              p: {
                company_id: companyId,
                date: f.date,
                product_id: f.product_id || null,
                machine_asset_id: f.machine_asset_id || null,
                operator_user_id: f.operator_user_id || null,
                qty_printed: num(f.qty_printed),
                qty_rejected: num(f.qty_rejected),
                prints_per_piece: num(f.prints_per_piece),
                ink_product_id: f.ink_product_id || null,
                ink_qty: num(f.ink_qty),
                ink_place_id: f.ink_place_id || null,
                labour_minutes: num(f.labour_minutes),
                note: f.note.trim() || null,
              },
            })
          }
        >
          {t('plPadPrinting.new.save')}
        </Button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
        <PlasticsErrorBox error={save.error} />
        <Done>{save.data ? t('plPadPrinting.new.done', { doc: save.data.doc_no }) : null}</Done>
      </div>
    </Card>
  )
}

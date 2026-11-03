import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { formatDate } from '@/shared/format'
import { Button, Card, Checkbox, Chip, DataTable, EmptyState, Field, FieldGrid, FormDialog, PageHeader, SelectField, Skeleton, type Column } from '@/ui'
import { CostCell, Done, ProdStatus, ProductionErrorBox, PROD_REFRESH, useCompanyPlaces, useProductionRights, ViewError } from '../biochem-common/biochem'
import { CalibrationDialog } from '../biochem-labs/CalibrationDialog'

type Asset = ViewRow<'assets'>
const KINDS = ['mixer', 'scale', 'filling', 'soap_line', 'lab_instrument', 'injection_machine', 'pad_printer', 'assembly_station', 'compressor', 'chiller', 'utility', 'vehicle', 'it', 'other'] as const
const EVENTS = ['moved', 'repair', 'service', 'amc', 'breakdown', 'restored', 'disposed', 'note'] as const

/**
 * Biochem machines (`BiochemAssets`): every machine and asset of the company from the one asset register
 * (core.assets, D-P5-1), grouped by kind, with its place, calibration and AMC dates; events (moved, repair, service,
 * AMC, breakdown, disposed), calibrations (a scale or instrument past its date can't be used in production or a lab
 * result) and documents. Cost is shown only with the cost right.
 */
export function BiochemMachinesPage() {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const choice = useCompanyChoice()
  const companyId = choice.companyId
  const q = useApiView('assets', { eq: { company_id: companyId }, order: 'code', limit: 2000, enabled: Boolean(companyId) })
  const all = rowsOf(q)
  const [kind, setKind] = useState<string>('')
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<Asset | 'new' | null>(null)
  const groups = useMemo(() => {
    const m = new Map<string, { n: number; due: number }>()
    for (const a of all) {
      const g = m.get(a.kind) ?? { n: 0, due: 0 }
      g.n += 1
      if (a.calibration_overdue) g.due += 1
      m.set(a.kind, g)
    }
    return [...m.entries()]
  }, [all])
  const shown = kind ? all.filter((a) => a.kind === kind) : all
  const current = all.find((a) => a.id === selected) ?? null

  const cols: Column<Asset>[] = [
    {
      key: 'name',
      header: t('biochemMachines.col.asset'),
      render: (a) => (
        <Button size="sm" variant="link" onClick={() => setSelected(a.id)} aria-label={t('biochemMachines.openOne', { name: a.name, code: a.code })}>
          {a.name}
        </Button>
      ),
    },
    { key: 'code', header: t('biochemMachines.col.id'), render: (a) => <span className="mono">{a.code}</span> },
    { key: 'kind', header: t('biochemMachines.col.kind'), render: (a) => t(`biochemMachines.kind.${a.kind}`, { defaultValue: a.kind }) },
    { key: 'place', header: t('biochemMachines.col.place'), render: (a) => a.place_name ?? t('biochemMachines.toSet') },
    { key: 'cost', header: t('biochemMachines.col.cost'), align: 'right', render: (a) => <CostCell value={a.cost} /> },
    {
      key: 'next',
      header: t('biochemMachines.col.next'),
      render: (a) =>
        a.needs_calibration ? (
          a.calibration_overdue ? (
            <Chip tone="danger" icon="alert">{t('biochemMachines.calOverdue')}</Chip>
          ) : (
            <Chip tone="signal">{t('biochemMachines.calDue', { date: a.calibration_due ? formatDate(a.calibration_due) : '—' })}</Chip>
          )
        ) : a.amc_until ? (
          <Chip tone="outline">{t('biochemMachines.amcUntil', { date: formatDate(a.amc_until) })}</Chip>
        ) : (
          <span className="k">—</span>
        ),
    },
    { key: 'status', header: t('common.status'), render: (a) => <ProdStatus status={a.status} /> },
  ]

  return (
    <>
      <PageHeader title={t('biochemMachines.title')} subtitle={t('biochemMachines.subtitle')} actions={rights.assetsManage && companyId ? <Button variant="primary" onClick={() => setEditing('new')}>{t('biochemMachines.add')}</Button> : null} />
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
          {groups.length ? (
            <div role="group" aria-label={t('biochemMachines.groups')} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
              <button type="button" className="sf-card sf-card__pad" aria-pressed={kind === ''} onClick={() => setKind('')} style={{ textAlign: 'left', cursor: 'pointer', borderColor: kind === '' ? 'var(--sf-primary)' : undefined }}>
                <strong>{t('biochemMachines.allKinds')}</strong>
                <div className="k">{t('biochemMachines.groupSub', { n: all.length })}</div>
              </button>
              {groups.map(([k, g]) => (
                <button key={k} type="button" className="sf-card sf-card__pad" aria-pressed={kind === k} onClick={() => setKind(k)} style={{ textAlign: 'left', cursor: 'pointer', borderColor: kind === k ? 'var(--sf-primary)' : undefined }}>
                  <strong>{t(`biochemMachines.kind.${k}`, { defaultValue: k })}</strong>
                  <div className="k">
                    {t('biochemMachines.groupSub', { n: g.n })}
                    {g.due ? ` · ${t('biochemMachines.groupDue', { n: g.due })}` : ''}
                  </div>
                </button>
              ))}
            </div>
          ) : null}
          {current ? <AssetPanel key={current.id} asset={current} onEdit={() => setEditing(current)} onClose={() => setSelected(null)} /> : null}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(260px, 1fr)', gap: 16, alignItems: 'start' }}>
            <TableCard title={kind ? t(`biochemMachines.kind.${kind}`, { defaultValue: kind }) : t('biochemMachines.listTitle')}>
              <DataTable caption={t('biochemMachines.listTitle')} columns={cols} rows={shown} rowKey={(a) => a.id} loading={q.isLoading} minWidth={820} error={q.error ? <ViewError error={q.error} /> : undefined} empty={<EmptyState title={t('biochemMachines.emptyTitle')} body={t('biochemMachines.emptyBody')} />} />
            </TableCard>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <Card title={t('biochemMachines.holds.title')}>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {['identity', 'where', 'maintenance', 'calibration', 'depreciation'].map((k) => (
                    <li key={k}>
                      <strong>{t(`biochemMachines.holds.${k}.title`)}</strong> — {t(`biochemMachines.holds.${k}.body`)}
                    </li>
                  ))}
                </ul>
              </Card>
              <Card title={t('biochemMachines.scales.title')} accent="signal">
                <p className="muted" style={{ margin: 0 }}>
                  {t('biochemMachines.scales.body')}
                </p>
              </Card>
            </div>
          </div>
        </div>
      )}
      {editing && companyId ? <AssetDialog companyId={companyId} asset={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </>
  )
}

function AssetPanel({ asset, onEdit, onClose }: { asset: Asset; onEdit: () => void; onClose: () => void }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const events = useApiView('asset_events', { eq: { asset_id: asset.id }, order: 'id', ascending: false })
  const cals = useApiView('calibrations', { eq: { asset_id: asset.id }, order: 'calibrated_on', ascending: false })
  const docs = useApiView('asset_documents', { eq: { asset_id: asset.id }, order: 'created_at', ascending: false })
  const places = useCompanyPlaces(asset.company_id)
  const rec = useApiMutation<{ p_asset_id: string; p: Record<string, unknown> }, { id: number }>('record_asset_event', PROD_REFRESH)
  const [f, setF] = useState({ kind: 'service', date: todayIst(), place_id: '', amc_until: '', note: '', amount: '' })
  const [cal, setCal] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const evCols: Column<ViewRow<'asset_events'>>[] = [
    { key: 'date', header: t('biochemMachines.ev.date'), render: (e) => formatDate(e.event_date) },
    { key: 'kind', header: t('biochemMachines.ev.kind'), render: (e) => t(`biochemMachines.event.${e.kind}`, { defaultValue: e.kind }) },
    { key: 'detail', header: t('biochemMachines.ev.detail'), render: (e) => (e.detail && typeof e.detail === 'object' && 'note' in e.detail ? String((e.detail as { note?: unknown }).note ?? '') : '') },
    { key: 'amount', header: t('biochemMachines.ev.amount'), align: 'right', render: (e) => (e.amount !== null ? <CostCell value={e.amount} /> : '—') },
    { key: 'by', header: t('biochemMachines.ev.by'), render: (e) => e.recorded_by_name ?? '—' },
  ]
  const calCols: Column<ViewRow<'calibrations'>>[] = [
    { key: 'on', header: t('biochemLabs.i.calibratedOn'), render: (c) => formatDate(c.calibrated_on) },
    { key: 'res', header: t('biochemLabs.st.result'), render: (c) => <ProdStatus status={c.result} /> },
    { key: 'next', header: t('biochemLabs.i.due'), render: (c) => (c.next_due ? formatDate(c.next_due) : '—') },
    { key: 'agency', header: t('biochemLabs.i.agency'), render: (c) => c.agency ?? '—' },
  ]
  const docCols: Column<ViewRow<'asset_documents'>>[] = [
    { key: 'kind', header: t('biochemMachines.doc.kind'), render: (d) => t(`biochemMachines.docKind.${d.kind}`, { defaultValue: d.kind }) },
    { key: 'path', header: t('biochemMachines.doc.path'), render: (d) => <span className="mono">{d.path.split('/').pop()}</span> },
    { key: 'valid', header: t('biochemMachines.doc.valid'), render: (d) => (d.valid_to ? formatDate(d.valid_to) : '—') },
  ]
  return (
    <Card
      title={t('biochemMachines.panelTitle', { code: asset.code, name: asset.name })}
      action={
        <span style={{ display: 'inline-flex', gap: 8 }}>
          {rights.assetsManage ? (
            <Button size="sm" onClick={onEdit}>
              {t('common.edit')}
            </Button>
          ) : null}
          {rights.assetsManage || rights.qcTest ? (
            <Button size="sm" onClick={() => setCal(true)}>
              {t('biochemLabs.i.calibrate')}
            </Button>
          ) : null}
          <Button size="sm" variant="link" onClick={onClose}>
            {t('common.close')}
          </Button>
        </span>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        {[asset.make, asset.model, asset.serial_no].filter(Boolean).join(' · ') || t('biochemMachines.noMake')} · {asset.place_name ?? t('biochemMachines.toSet')} · <ProdStatus status={asset.status} />
      </p>
      <h3 style={{ fontSize: 15, margin: '8px 0' }}>{t('biochemMachines.ev.title')}</h3>
      <DataTable caption={t('biochemMachines.ev.title')} columns={evCols} rows={rowsOf(events)} rowKey={(e) => String(e.id)} loading={events.isLoading} minWidth={600} empty={<EmptyState title={t('biochemMachines.ev.empty')} />} />
      {rights.assetsManage && asset.status !== 'disposed' ? (
        <>
          <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>{t('biochemMachines.ev.record')}</h3>
          <FieldGrid cols={3}>
            <SelectField label={t('biochemMachines.ev.kind')} value={f.kind} onChange={set('kind')} options={EVENTS.map((k) => ({ value: k, label: t(`biochemMachines.event.${k}`) }))} />
            <Field label={t('biochemMachines.ev.date')} type="date" value={f.date} onChange={set('date')} />
            {f.kind === 'moved' ? <SelectField label={t('biochemMachines.ev.place')} value={f.place_id} onChange={set('place_id')} options={[{ value: '', label: t('biochemEntry.plan.choosePlace') }, ...places.list.map((p) => ({ value: p.id, label: `${p.name} · ${p.branch_name}` }))]} /> : null}
            {f.kind === 'amc' ? <Field label={t('biochemMachines.ev.amcUntil')} type="date" value={f.amc_until} onChange={set('amc_until')} /> : null}
            <Field label={t('biochemMachines.ev.detail')} value={f.note} onChange={set('note')} />
            <Field label={t('biochemMachines.ev.amount')} inputMode="decimal" value={f.amount} onChange={set('amount')} />
          </FieldGrid>
          <div style={{ marginTop: 8 }}>
            <Button
              busy={rec.isPending}
              onClick={() => {
                setDone(null)
                rec.mutate(
                  { p_asset_id: asset.id, p: { kind: f.kind, date: f.date, place_id: f.place_id || null, amc_until: f.amc_until || null, detail: f.note.trim() ? { note: f.note.trim() } : {}, amount: f.amount.trim() || null } },
                  { onSuccess: () => setDone(t('biochemMachines.ev.saved')) },
                )
              }}
            >
              {t('biochemMachines.ev.save')}
            </Button>
          </div>
        </>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        <ProductionErrorBox error={rec.error} />
        <Done>{done}</Done>
      </div>
      <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>{t('biochemLabs.i.calTitle')}</h3>
      <DataTable caption={t('biochemLabs.i.calTitle')} columns={calCols} rows={rowsOf(cals)} rowKey={(c) => String(c.id)} loading={cals.isLoading} minWidth={480} empty={<EmptyState title={t('biochemLabs.i.calEmpty')} />} />
      <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>{t('biochemMachines.doc.title')}</h3>
      <DataTable caption={t('biochemMachines.doc.title')} columns={docCols} rows={rowsOf(docs)} rowKey={(d) => d.id} loading={docs.isLoading} minWidth={480} empty={<EmptyState title={t('biochemMachines.doc.empty')} body={t('biochemMachines.doc.uploadLater')} />} />
      {cal ? <CalibrationDialog asset={asset} onClose={() => setCal(false)} /> : null}
    </Card>
  )
}

function AssetDialog({ companyId, asset, onClose }: { companyId: string; asset: Asset | null; onClose: () => void }) {
  const { t } = useTranslation()
  const places = useCompanyPlaces(companyId)
  const rights = useProductionRights()
  const [f, setF] = useState({
    code: asset?.code ?? '',
    name: asset?.name ?? '',
    kind: asset?.kind ?? 'mixer',
    place_id: asset?.place_id ?? '',
    make: asset?.make ?? '',
    model: asset?.model ?? '',
    serial_no: asset?.serial_no ?? '',
    purchase_date: asset?.purchase_date ?? '',
    put_to_use_date: asset?.put_to_use_date ?? '',
    cost: asset?.cost !== null && asset?.cost !== undefined ? String(asset.cost) : '',
    calibration_interval_days: asset?.calibration_interval_days ? String(asset.calibration_interval_days) : '',
    calibration_due: asset?.calibration_due ?? '',
    amc_vendor: asset?.amc_vendor ?? '',
    amc_until: asset?.amc_until ?? '',
  })
  const [needsCal, setNeedsCal] = useState(asset?.needs_calibration ?? false)
  const save = useApiMutation<{ p: Record<string, unknown> }, { id: string }>('upsert_asset', PROD_REFRESH)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const n = (v: string) => (v.trim() ? v.trim() : null)
  return (
    <FormDialog
      open
      wide
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={asset ? t('biochemMachines.editTitle') : t('biochemMachines.addTitle')}
      description={t('biochemMachines.dialogHint')}
      submitLabel={t('common.save')}
      busy={save.isPending}
      error={<ProductionErrorBox error={save.error} />}
      onSubmit={() =>
        save.mutate(
          {
            p: {
              id: asset?.id ?? null,
              company_id: companyId,
              code: f.code.trim(),
              name: f.name.trim(),
              kind: f.kind,
              place_id: asset ? null : n(f.place_id),
              make: n(f.make),
              model: n(f.model),
              serial_no: n(f.serial_no),
              purchase_date: n(f.purchase_date),
              put_to_use_date: n(f.put_to_use_date),
              cost: rights.costs ? n(f.cost) : (asset?.cost ?? null),
              needs_calibration: needsCal,
              calibration_interval_days: n(f.calibration_interval_days),
              calibration_due: asset ? null : n(f.calibration_due),
              amc_vendor: n(f.amc_vendor),
              amc_until: n(f.amc_until),
            },
          },
          { onSuccess: onClose },
        )
      }
    >
      <FieldGrid cols={3}>
        <Field label={t('biochemMachines.col.id')} value={f.code} onChange={set('code')} required />
        <Field label={t('biochemMachines.col.asset')} value={f.name} onChange={set('name')} required />
        <SelectField label={t('biochemMachines.col.kind')} value={f.kind} onChange={set('kind')} options={KINDS.map((k) => ({ value: k, label: t(`biochemMachines.kind.${k}`) }))} />
        {!asset ? <SelectField label={t('biochemMachines.col.place')} value={f.place_id} onChange={set('place_id')} options={[{ value: '', label: t('biochemMachines.toSet') }, ...places.list.map((p) => ({ value: p.id, label: `${p.name} · ${p.branch_name}` }))]} /> : null}
        <Field label={t('biochemMachines.f.make')} value={f.make} onChange={set('make')} />
        <Field label={t('biochemMachines.f.model')} value={f.model} onChange={set('model')} />
        <Field label={t('biochemMachines.f.serial')} value={f.serial_no} onChange={set('serial_no')} />
        <Field label={t('biochemMachines.f.purchased')} type="date" value={f.purchase_date} onChange={set('purchase_date')} />
        <Field label={t('biochemMachines.f.putToUse')} type="date" value={f.put_to_use_date} onChange={set('put_to_use_date')} />
        {rights.costs ? <Field label={t('biochemMachines.col.cost')} inputMode="decimal" value={f.cost} onChange={set('cost')} /> : null}
        <Field label={t('biochemMachines.f.interval')} inputMode="numeric" value={f.calibration_interval_days} onChange={set('calibration_interval_days')} />
        {!asset ? <Field label={t('biochemMachines.f.calDue')} type="date" value={f.calibration_due} onChange={set('calibration_due')} /> : null}
        <Field label={t('biochemMachines.f.amcVendor')} value={f.amc_vendor} onChange={set('amc_vendor')} />
        <Field label={t('biochemMachines.f.amcUntil')} type="date" value={f.amc_until} onChange={set('amc_until')} />
      </FieldGrid>
      <Checkbox label={t('biochemMachines.f.needsCal')} checked={needsCal} onChange={(e) => setNeedsCal(e.target.checked)} />
    </FormDialog>
  )
}

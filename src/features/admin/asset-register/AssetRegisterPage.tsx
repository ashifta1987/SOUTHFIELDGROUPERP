import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiRpc, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { placeLabel, useStockPlaces } from '@/features/inventory/common/inventory'
import { ViewError } from '@/features/production/biochem-common/biochem'
import { CompanyFrame, NoteCard, OPS_REFRESH, OpsErrorBox, TwoCol, monthName, openDocument, uploadDocument, useOpsRights } from '@/features/production/ops-common/ops'
import { formatDate } from '@/shared/format'
import { Amount, Button, Card, Chip, DataTable, EmptyState, Field, FieldGrid, FormDialog, KeyValue, SelectField, Skeleton, TextAreaField, type Column } from '@/ui'

type Asset = ViewRow<'v_asset_register'>
type Run = ViewRow<'v_depreciation_runs'>
type Disposal = ViewRow<'v_asset_disposals'>
type AssetDoc = ViewRow<'asset_documents'>
interface Readiness {
  method: string | null
  useful_life_years: Record<string, number> | null
  residual_pct: number | string | null
  assets_without_life: string[]
  assets_without_dates: string[]
  assets_without_residual: string[]
  ready: boolean
}

const KINDS = ['mixer', 'scale', 'filling', 'soap_line', 'lab_instrument', 'injection_machine', 'pad_printer', 'assembly_station', 'compressor', 'chiller', 'utility', 'vehicle', 'it', 'other']

/**
 * Admin → Asset register (`AssetRegister`): every machine with its code, place and papers (api.v_asset_register; cost,
 * accumulated depreciation and WDV only with cost or accounts rights), depreciation by the CA's settings only
 * (api.depreciation_readiness / api.run_depreciation — refused with the missing setting named; no rate is assumed),
 * disposals as a book entry (api.dispose_asset; the sale itself is billed through Sales with GST), and documents in the
 * private `documents` bucket at `<company_id>/assets/<uuid>.<ext>` (api.add_asset_document).
 */
export function AssetRegisterPage() {
  const { t } = useTranslation()
  const rights = useOpsRights()
  const [adding, setAdding] = useState(false)
  return (
    <CompanyFrame
      title={t('assetRegister.title')}
      subtitle={t('assetRegister.subtitle')}
      notice={rights.readOnly ? t('opsCommon.readOnly') : undefined}
      actions={() =>
        rights.assetsManage ? (
          <Button variant="primary" onClick={() => setAdding(true)}>
            {t('assetRegister.add')}
          </Button>
        ) : null
      }
    >
      {(companyId) => (
        <>
          <Body companyId={companyId} />
          {adding ? <AssetDialog companyId={companyId} onClose={() => setAdding(false)} /> : null}
        </>
      )}
    </CompanyFrame>
  )
}

function Body({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const rights = useOpsRights()
  const q = useApiView('v_asset_register', { eq: { company_id: companyId }, order: 'code', limit: 2000 })
  const all = rowsOf(q)
  const [kind, setKind] = useState('')
  const [docs, setDocs] = useState<Asset | null>(null)
  const [disposing, setDisposing] = useState<Asset | null>(null)
  const byKind = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of all) m.set(a.kind, (m.get(a.kind) ?? 0) + 1)
    return m
  }, [all])
  const shown = kind ? all.filter((a) => a.kind === kind) : all
  const money = (v: number | null) => (v === null ? <span className="k">{t('opsCommon.costHidden')}</span> : <Amount value={v} />)

  const columns: Column<Asset>[] = [
    { key: 'code', header: t('assetRegister.col.code'), render: (a) => <span className="mono" style={{ fontWeight: 600 }}>{a.code}</span> },
    {
      key: 'name',
      header: t('assetRegister.col.name'),
      render: (a) => (
        <div>
          <strong>{a.name}</strong>
          <div className="k">{[a.make, a.model, a.serial_no].filter(Boolean).join(' · ') || t(`biochemMachines.kind.${a.kind}`, { defaultValue: a.kind })}</div>
        </div>
      ),
    },
    { key: 'place', header: t('assetRegister.col.place'), render: (a) => a.place_name ?? '—' },
    { key: 'use', header: t('assetRegister.col.putToUse'), render: (a) => (a.put_to_use_date ?? a.purchase_date ? formatDate((a.put_to_use_date ?? a.purchase_date) as string) : '—') },
    { key: 'cost', header: t('assetRegister.col.cost'), align: 'right', render: (a) => money(a.cost) },
    { key: 'acc', header: t('assetRegister.col.accumulated'), align: 'right', render: (a) => money(a.accumulated_depreciation) },
    { key: 'wdv', header: t('assetRegister.col.wdv'), align: 'right', render: (a) => money(a.wdv) },
    { key: 'life', header: t('assetRegister.col.life'), align: 'right', render: (a) => (a.useful_life_years ? t('assetRegister.years', { n: a.useful_life_years }) : <span className="k">{t('assetRegister.bySetting')}</span>) },
    {
      key: 'status',
      header: t('common.status'),
      render: (a) => (
        <Chip tone={a.status === 'active' ? 'success' : a.status === 'disposed' ? 'neutral' : 'signal'}>
          {t(`assetRegister.status.${a.status}`, { defaultValue: a.status })}
          {a.open_repairs ? ` · ${t('assetRegister.repairs', { n: a.open_repairs })}` : ''}
        </Chip>
      ),
    },
    {
      key: 'act',
      header: <span className="sr-only">{t('assetRegister.col.actions')}</span>,
      render: (a) => (
        <div style={{ display: 'flex', gap: 4 }}>
          <Button size="sm" variant="link" onClick={() => setDocs(a)} aria-label={t('assetRegister.docsOne', { code: a.code })}>
            {t('assetRegister.docs', { n: a.documents ?? 0 })}
          </Button>
          {rights.accountsCreate && a.status !== 'disposed' ? (
            <Button size="sm" variant="link" onClick={() => setDisposing(a)} aria-label={t('assetRegister.disposeOne', { code: a.code })}>
              {t('assetRegister.dispose')}
            </Button>
          ) : null}
        </div>
      ),
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10 }} role="group" aria-label={t('assetRegister.kinds')}>
        <button type="button" className="sf-card sf-card__pad" aria-pressed={kind === ''} onClick={() => setKind('')} style={{ textAlign: 'left', cursor: 'pointer', borderColor: kind === '' ? 'var(--sf-primary)' : undefined }}>
          <strong>{t('assetRegister.allKinds')}</strong>
          <span className="k" style={{ display: 'block' }}>
            {t('assetRegister.added', { n: all.length })}
          </span>
        </button>
        {[...byKind.entries()].map(([k, n]) => (
          <button key={k} type="button" className="sf-card sf-card__pad" aria-pressed={kind === k} onClick={() => setKind(k)} style={{ textAlign: 'left', cursor: 'pointer', borderColor: kind === k ? 'var(--sf-primary)' : undefined }}>
            <strong>{t(`biochemMachines.kind.${k}`, { defaultValue: k })}</strong>
            <span className="k" style={{ display: 'block' }}>
              {t('assetRegister.added', { n })}
            </span>
          </button>
        ))}
      </div>
      <TableCard title={kind ? t(`biochemMachines.kind.${kind}`, { defaultValue: kind }) : t('assetRegister.listTitle')}>
        <DataTable caption={t('assetRegister.listTitle')} columns={columns} rows={shown} rowKey={(a) => a.id} loading={q.isLoading} minWidth={1100} error={q.error ? <ViewError error={q.error} /> : undefined} empty={<EmptyState title={t('assetRegister.emptyTitle')} body={t('assetRegister.emptyBody')} />} />
      </TableCard>
      <TwoCol
        main={
          <>
            <Depreciation companyId={companyId} />
            <Disposals companyId={companyId} />
          </>
        }
        side={
          <NoteCard
            title={t('assetRegister.notes.title')}
            items={[
              { head: t('assetRegister.notes.codeHead'), body: t('assetRegister.notes.code') },
              { head: t('assetRegister.notes.depHead'), body: t('assetRegister.notes.dep') },
              { head: t('assetRegister.notes.saleHead'), body: t('assetRegister.notes.sale') },
              { head: t('assetRegister.notes.docsHead'), body: t('assetRegister.notes.docs') },
            ]}
          />
        }
      />
      {docs ? <DocsDialog asset={docs} onClose={() => setDocs(null)} /> : null}
      {disposing ? <DisposeDialog asset={disposing} onClose={() => setDisposing(null)} /> : null}
    </div>
  )
}

function Depreciation({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const rights = useOpsRights()
  const ready = useApiRpc<Readiness>('depreciation_readiness', { p_company_id: companyId })
  const r = ready.data?.status === 'ready' ? ready.data.data : null
  const pq = useApiView('v_period_status', { eq: { company_id: companyId }, order: 'month_start', ascending: false, limit: 48 })
  const rq = useApiView('v_depreciation_runs', { eq: { company_id: companyId }, order: 'month_start', ascending: false, limit: 48 })
  const today = todayIst()
  const ended = rowsOf(pq).filter((p) => {
    const [y, m] = p.month_start.split('-').map(Number)
    const next = new Date(Date.UTC(y ?? 2000, m ?? 1, 1)).toISOString().slice(0, 10)
    return next <= today
  })
  const [period, setPeriod] = useState('')
  const chosen = period || ended[0]?.period_id || ''
  const run = useApiMutation<{ p_company_id: string; p_period_id: string }, { total: number; assets: number; doc_no: string | null }>('run_depreciation', OPS_REFRESH)
  const lives = r?.useful_life_years && typeof r.useful_life_years === 'object' ? Object.entries(r.useful_life_years) : []
  const runCols: Column<Run>[] = [
    { key: 'm', header: t('assetRegister.dep.month'), render: (x) => monthName(x.month_start) },
    { key: 'method', header: t('assetRegister.dep.method'), render: (x) => x.method.toUpperCase() },
    { key: 'n', header: t('assetRegister.dep.assets'), align: 'right', render: (x) => <span className="mono">{x.assets ?? 0}</span> },
    { key: 'total', header: t('assetRegister.dep.total'), align: 'right', render: (x) => <Amount value={x.total} /> },
    { key: 'v', header: t('assetRegister.dep.voucher'), render: (x) => (x.voucher_no ? <span className="mono">{x.voucher_no}</span> : '—') },
    { key: 'by', header: t('assetRegister.dep.by'), render: (x) => `${x.run_by_name ?? '—'} · ${formatDate(x.run_at)}` },
  ]
  return (
    <Card title={t('assetRegister.dep.title')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {ready.isLoading ? <Skeleton height={60} /> : ready.error ? <ViewError error={ready.error} /> : null}
        {r ? (
          <>
            <KeyValue
              rows={[
                { label: t('assetRegister.dep.method'), value: <span data-testid="dep-method">{r.method ? r.method.toUpperCase() : t('assetRegister.dep.notSet')}</span> },
                { label: t('assetRegister.dep.lives'), value: lives.length ? lives.map(([k, v]) => `${t(`biochemMachines.kind.${k}`, { defaultValue: k })} ${v}`).join(' · ') : t('assetRegister.dep.notSet') },
                { label: t('assetRegister.dep.residual'), value: r.residual_pct !== null && r.residual_pct !== undefined ? `${r.residual_pct} %` : t('assetRegister.dep.notSet') },
              ]}
            />
            {r.ready ? (
              <Chip tone="success" icon="check">
                {t('assetRegister.dep.ready')}
              </Chip>
            ) : (
              <div className="sf-alert" role="status" data-tone="info" style={{ margin: 0 }}>
                <strong>{t('assetRegister.dep.notReady')}</strong>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {!r.method ? <li>{t('assetRegister.dep.missingMethod')}</li> : null}
                  {r.assets_without_life.length ? <li>{t('assetRegister.dep.missingLife', { list: r.assets_without_life.join(', ') })}</li> : null}
                  {r.assets_without_dates.length ? <li>{t('assetRegister.dep.missingDates', { list: r.assets_without_dates.join(', ') })}</li> : null}
                  {r.method === 'wdv' && r.assets_without_residual.length ? <li>{t('assetRegister.dep.missingResidual', { list: r.assets_without_residual.join(', ') })}</li> : null}
                </ul>
              </div>
            )}
          </>
        ) : null}
        {rights.accountsCreate ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 220 }}>
              <SelectField label={t('assetRegister.dep.month')} value={chosen} onChange={(e) => setPeriod(e.target.value)} options={ended.map((p) => ({ value: p.period_id, label: `${monthName(p.month_start)}${p.status === 'closed' ? ` · ${t('assetRegister.dep.closed')}` : ''}` }))} placeholder={ended.length ? undefined : t('assetRegister.dep.noMonth')} />
            </div>
            <Button variant="primary" busy={run.isPending} disabled={!chosen} onClick={() => run.mutate({ p_company_id: companyId, p_period_id: chosen })}>
              {t('assetRegister.dep.run')}
            </Button>
          </div>
        ) : null}
        <OpsErrorBox error={run.error} />
        {run.data && !run.error ? (
          <p role="status" className="sf-alert" data-tone="info" style={{ margin: 0 }}>
            {t('assetRegister.dep.done', { n: run.data.assets, no: run.data.doc_no ?? '—' })}
          </p>
        ) : null}
        <DataTable caption={t('assetRegister.dep.runs')} columns={runCols} rows={rowsOf(rq)} rowKey={(x) => x.id} loading={rq.isLoading} minWidth={640} empty={<span className="k">{t('assetRegister.dep.noRuns')}</span>} error={rq.error ? <ViewError error={rq.error} /> : undefined} />
      </div>
    </Card>
  )
}

function Disposals({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const q = useApiView('v_asset_disposals', { eq: { company_id: companyId }, order: 'disposal_date', ascending: false, limit: 200 })
  const cols: Column<Disposal>[] = [
    { key: 'a', header: t('assetRegister.col.code'), render: (d) => <span className="mono">{d.asset_code}</span> },
    { key: 'on', header: t('assetRegister.disp.on'), render: (d) => formatDate(d.disposal_date) },
    { key: 'wdv', header: t('assetRegister.col.wdv'), align: 'right', render: (d) => <Amount value={d.wdv} /> },
    { key: 'p', header: t('assetRegister.disp.proceeds'), align: 'right', render: (d) => <Amount value={d.proceeds} /> },
    { key: 'gl', header: t('assetRegister.disp.gainLoss'), align: 'right', render: (d) => <Amount value={d.gain_loss} /> },
    { key: 'r', header: t('assetRegister.disp.reason'), render: (d) => d.reason },
  ]
  return (
    <TableCard title={t('assetRegister.disp.title')}>
      <DataTable caption={t('assetRegister.disp.title')} columns={cols} rows={rowsOf(q)} rowKey={(d) => d.id} loading={q.isLoading} minWidth={640} empty={<span className="k">{t('assetRegister.disp.none')}</span>} error={q.error ? <ViewError error={q.error} /> : undefined} />
    </TableCard>
  )
}

function AssetDialog({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const places = useStockPlaces(companyId)
  const [f, setF] = useState({ code: '', name: '', kind: 'injection_machine', place_id: '', make: '', model: '', serial_no: '', purchase_date: '', put_to_use_date: '', cost: '', useful_life_years: '', residual_pct: '', amc_until: '' })
  const save = useApiMutation<{ p: Record<string, unknown> }>('upsert_asset', OPS_REFRESH)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const blank = (s: string) => s.trim() || null
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('assetRegister.form.title')}
      description={t('assetRegister.form.hint')}
      submitLabel={t('assetRegister.form.submit')}
      busy={save.isPending}
      wide
      error={<OpsErrorBox error={save.error} />}
      onSubmit={() =>
        save.mutate(
          {
            p: {
              company_id: companyId,
              code: f.code.trim(),
              name: f.name.trim(),
              kind: f.kind,
              place_id: f.place_id || null,
              make: blank(f.make),
              model: blank(f.model),
              serial_no: blank(f.serial_no),
              purchase_date: f.purchase_date || null,
              put_to_use_date: f.put_to_use_date || null,
              cost: blank(f.cost),
              useful_life_years: blank(f.useful_life_years),
              residual_pct: blank(f.residual_pct),
              amc_until: f.amc_until || null,
            },
          },
          { onSuccess: onClose },
        )
      }
    >
      <h3 className="k" style={{ margin: 0 }}>{t('assetRegister.form.identity')}</h3>
      <FieldGrid cols={3}>
        <Field label={t('assetRegister.col.code')} value={f.code} onChange={set('code')} required help={t('assetRegister.form.codeHelp')} />
        <Field label={t('assetRegister.form.name')} value={f.name} onChange={set('name')} required />
        <SelectField label={t('assetRegister.form.kind')} value={f.kind} onChange={set('kind')} options={KINDS.map((k) => ({ value: k, label: t(`biochemMachines.kind.${k}`, { defaultValue: k }) }))} />
        <SelectField label={t('assetRegister.col.place')} value={f.place_id} onChange={set('place_id')} placeholder={t('assetRegister.form.noPlace')} options={places.list.map((p) => ({ value: p.id, label: placeLabel(p) }))} />
        <Field label={t('assetRegister.form.make')} value={f.make} onChange={set('make')} />
        <Field label={t('assetRegister.form.model')} value={f.model} onChange={set('model')} />
        <Field label={t('assetRegister.form.serial')} value={f.serial_no} onChange={set('serial_no')} />
      </FieldGrid>
      <h3 className="k" style={{ margin: 0 }}>{t('assetRegister.form.money')}</h3>
      <FieldGrid cols={3}>
        <Field label={t('assetRegister.form.bought')} type="date" value={f.purchase_date} onChange={set('purchase_date')} />
        <Field label={t('assetRegister.col.putToUse')} type="date" value={f.put_to_use_date} onChange={set('put_to_use_date')} />
        <Field label={t('assetRegister.form.cost')} inputMode="decimal" value={f.cost} onChange={set('cost')} />
        <Field label={t('assetRegister.form.life')} inputMode="decimal" value={f.useful_life_years} onChange={set('useful_life_years')} help={t('assetRegister.form.lifeHelp')} />
        <Field label={t('assetRegister.form.residual')} inputMode="decimal" value={f.residual_pct} onChange={set('residual_pct')} help={t('assetRegister.form.lifeHelp')} />
        <Field label={t('assetRegister.form.amc')} type="date" value={f.amc_until} onChange={set('amc_until')} />
      </FieldGrid>
    </FormDialog>
  )
}

function DocsDialog({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const { t } = useTranslation()
  const rights = useOpsRights()
  const q = useApiView('asset_documents', { eq: { asset_id: asset.id }, order: 'created_at', ascending: false })
  const [file, setFile] = useState<File | null>(null)
  const [f, setF] = useState({ kind: 'invoice', valid_to: '' })
  const [busy, setBusy] = useState(false)
  const [upErr, setUpErr] = useState<string | null>(null)
  const save = useApiMutation<{ p_asset_id: string; p: Record<string, unknown> }>('add_asset_document', OPS_REFRESH)
  async function submit() {
    if (!rights.assetsManage) return onClose()
    if (!file) {
      setUpErr(t('assetRegister.docsDlg.needFile'))
      return
    }
    setBusy(true)
    setUpErr(null)
    try {
      const path = await uploadDocument(asset.company_id, 'assets', file)
      save.mutate({ p_asset_id: asset.id, p: { path, kind: f.kind, valid_to: f.valid_to || null } }, { onSuccess: () => setFile(null) })
    } catch (e) {
      setUpErr(t('opsCommon.uploadFailed', { detail: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
    }
  }
  const cols: Column<AssetDoc>[] = [
    { key: 'k', header: t('assetRegister.docsDlg.kind'), render: (d) => t(`biochemMachines.docKind.${d.kind}`, { defaultValue: d.kind }) },
    { key: 'v', header: t('assetRegister.docsDlg.validTo'), render: (d) => (d.valid_to ? formatDate(d.valid_to) : '—') },
    { key: 'on', header: t('assetRegister.docsDlg.on'), render: (d) => formatDate(d.created_at) },
    {
      key: 'o',
      header: <span className="sr-only">{t('opsCommon.open')}</span>,
      render: (d) => (
        <Button size="sm" variant="link" onClick={() => void openDocument(d.path)} aria-label={t('assetRegister.docsDlg.openOne', { date: formatDate(d.created_at) })}>
          {t('opsCommon.open')}
        </Button>
      ),
    },
  ]
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('assetRegister.docsDlg.title', { code: asset.code })}
      description={t('assetRegister.docsDlg.hint')}
      submitLabel={rights.assetsManage ? t('assetRegister.docsDlg.upload') : t('common.close')}
      busy={busy || save.isPending}
      wide
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
      <DataTable caption={t('assetRegister.docsDlg.list')} columns={cols} rows={rowsOf(q)} rowKey={(d) => d.id} loading={q.isLoading} minWidth={480} empty={<span className="k">{t('assetRegister.docsDlg.none')}</span>} />
      {rights.assetsManage ? (
        <FieldGrid cols={3}>
          <Field label={t('opsCommon.chooseFile')} type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <SelectField label={t('assetRegister.docsDlg.kind')} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} options={['invoice', 'warranty', 'amc', 'manual', 'calibration_certificate', 'photo', 'other'].map((k) => ({ value: k, label: t(`biochemMachines.docKind.${k}`, { defaultValue: k }) }))} />
          <Field label={t('assetRegister.docsDlg.validTo')} type="date" value={f.valid_to} onChange={(e) => setF({ ...f, valid_to: e.target.value })} />
        </FieldGrid>
      ) : null}
    </FormDialog>
  )
}

function DisposeDialog({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const { t } = useTranslation()
  const accounts = useApiView('money_accounts', { eq: { company_id: asset.company_id }, order: 'name' })
  const [f, setF] = useState({ disposal_date: todayIst(), proceeds: '0', account: '', reason: '' })
  const save = useApiMutation<{ p_asset_id: string; p: Record<string, unknown> }>('dispose_asset', OPS_REFRESH)
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('assetRegister.disp.dlgTitle', { code: asset.code })}
      description={t('assetRegister.disp.hint')}
      submitLabel={t('assetRegister.dispose')}
      busy={save.isPending}
      error={<OpsErrorBox error={save.error} />}
      onSubmit={() => save.mutate({ p_asset_id: asset.id, p: { disposal_date: f.disposal_date, proceeds: f.proceeds.trim() || '0', proceeds_account_id: f.account || null, reason: f.reason.trim() } }, { onSuccess: onClose })}
    >
      <FieldGrid cols={2}>
        <Field label={t('assetRegister.disp.on')} type="date" value={f.disposal_date} onChange={(e) => setF({ ...f, disposal_date: e.target.value })} />
        <Field label={t('assetRegister.disp.proceeds')} inputMode="decimal" value={f.proceeds} onChange={(e) => setF({ ...f, proceeds: e.target.value })} />
      </FieldGrid>
      <SelectField label={t('assetRegister.disp.account')} value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} placeholder={t('assetRegister.disp.noAccount')} options={rowsOf(accounts).map((a) => ({ value: a.id, label: a.name }))} />
      <TextAreaField label={t('assetRegister.disp.reason')} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} rows={2} />
    </FormDialog>
  )
}

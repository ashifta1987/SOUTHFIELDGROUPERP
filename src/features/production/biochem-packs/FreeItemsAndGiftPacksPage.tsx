import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { qtyText } from '@/features/inventory/common/inventory'
import { formatDate } from '@/shared/format'
import { Button, Card, Checkbox, Chip, DataTable, EmptyState, Field, FieldGrid, FormDialog, KpiTiles, PageHeader, SelectField, Skeleton, type Column } from '@/ui'
import { cleanNum, CostCell, Done, ProdStatus, ProductionErrorBox, PROD_REFRESH, useCompanyPlaces, useCompanyProducts, useProductionRights, ViewError } from '../biochem-common/biochem'

type Pack = ViewRow<'packs'>
const KINDS = ['free_item_pack', 'gift_pack', 'combo_pack'] as const
const TREATMENTS = ['free_with_sale_single_price', 'gift_without_consideration', 'mixed_supply', 'composite_supply'] as const

/**
 * Free items and gift packs (`BiochemBundles`): packs made of products plus free items, cartons or trays. A pack can't
 * go on a sales document until Admin records its GST treatment with the CA's advice (Q-23; the database refuses the
 * line: pack.gst_treatment_unset). Pack assembly takes the items out of released stock and puts packs into stock at
 * their cost.
 */
export function FreeItemsAndGiftPacksPage() {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const choice = useCompanyChoice()
  const companyId = choice.companyId
  const packs = useApiView('packs', { eq: { company_id: companyId }, order: 'name', enabled: Boolean(companyId) })
  const asm = useApiView('pack_assemblies', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 100, enabled: Boolean(companyId) })
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<Pack | 'new' | null>(null)
  const list = rowsOf(packs)
  const current = list.find((p) => p.id === selected) ?? null

  const cols: Column<Pack>[] = [
    {
      key: 'name',
      header: t('biochemPacks.col.pack'),
      render: (p) => (
        <Button size="sm" variant="link" onClick={() => setSelected(p.id)} aria-label={t('biochemPacks.openOne', { name: p.name })}>
          {p.name}
        </Button>
      ),
    },
    { key: 'product', header: t('biochemPacks.col.product'), render: (p) => <span>{p.product_name} <span className="k mono">{p.product_code}</span></span> },
    { key: 'kind', header: t('biochemPacks.col.kind'), render: (p) => t(`biochemPacks.kind.${p.kind}`) },
    { key: 'items', header: t('biochemPacks.col.items'), align: 'right', render: (p) => t('biochemPacks.itemsCount', { n: p.items ?? 0, free: p.free_items ?? 0 }) },
    { key: 'gst', header: t('biochemPacks.col.gst'), render: (p) => <GstState pack={p} /> },
    { key: 'status', header: t('common.status'), render: (p) => <ProdStatus status={p.status} /> },
  ]
  const asmCols: Column<ViewRow<'pack_assemblies'>>[] = [
    { key: 'no', header: t('biochemPacks.asm.no'), render: (a) => <span className="mono">{a.doc_no}</span> },
    { key: 'date', header: t('biochemPacks.asm.date'), render: (a) => formatDate(a.assembly_date) },
    { key: 'pack', header: t('biochemPacks.col.pack'), render: (a) => a.pack_name },
    { key: 'qty', header: t('biochemPacks.asm.qty'), align: 'right', render: (a) => <span className="sf-amount">{qtyText(a.qty)}</span> },
    { key: 'cost', header: t('biochemPacks.asm.unitCost'), align: 'right', render: (a) => <CostCell value={a.unit_cost} digits={4} /> },
  ]

  return (
    <>
      <PageHeader title={t('biochemPacks.title')} subtitle={t('biochemPacks.subtitle')} actions={rights.edit && companyId ? <Button variant="primary" onClick={() => setEditing('new')}>{t('biochemPacks.add')}</Button> : null} />
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
            ariaLabel={t('biochemPacks.kpis')}
            items={[
              { key: 'packs', label: t('biochemPacks.kpi.packs'), value: list.length, sub: t('biochemPacks.kpi.packsSub') },
              { key: 'unset', label: t('biochemPacks.kpi.unset'), value: <span data-testid="packs-unset">{list.filter((p) => !p.gst_treatment).length}</span>, sub: t('biochemPacks.kpi.unsetSub') },
              { key: 'free', label: t('biochemPacks.kpi.free'), value: list.reduce((n, p) => n + (p.free_items ?? 0), 0), sub: t('biochemPacks.kpi.freeSub') },
              { key: 'asm', label: t('biochemPacks.kpi.assemblies'), value: rowsOf(asm).length, sub: t('biochemPacks.kpi.assembliesSub') },
            ]}
          />
          {current ? <PackPanel key={current.id} pack={current} companyId={companyId} onEdit={() => setEditing(current)} onClose={() => setSelected(null)} /> : null}
          <TableCard title={t('biochemPacks.listTitle')}>
            <DataTable caption={t('biochemPacks.listTitle')} columns={cols} rows={list} rowKey={(p) => p.id} loading={packs.isLoading} minWidth={900} error={packs.error ? <ViewError error={packs.error} /> : undefined} empty={<EmptyState title={t('biochemPacks.emptyTitle')} body={t('biochemPacks.emptyBody')} />} />
          </TableCard>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16, alignItems: 'start' }}>
            <TableCard title={t('biochemPacks.asm.title')}>
              <DataTable caption={t('biochemPacks.asm.title')} columns={asmCols} rows={rowsOf(asm)} rowKey={(a) => a.id} loading={asm.isLoading} minWidth={520} empty={<EmptyState title={t('biochemPacks.asm.empty')} />} />
            </TableCard>
            <Card title={t('biochemPacks.gst.title')} accent="signal">
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {TREATMENTS.map((k) => (
                  <li key={k}>
                    <strong>{t(`biochemPacks.treatment.${k}`)}</strong> — {t(`biochemPacks.treatmentHelp.${k}`)}
                  </li>
                ))}
              </ul>
              <p className="k" style={{ marginBottom: 0 }}>
                {t('biochemPacks.gst.ca')}
              </p>
            </Card>
          </div>
        </div>
      )}
      {editing && companyId ? <PackDialog companyId={companyId} pack={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(id) => setSelected(id)} /> : null}
    </>
  )
}

function GstState({ pack }: { pack: Pack }) {
  const { t } = useTranslation()
  return pack.gst_treatment ? (
    <Chip tone="success" icon="check">
      {t(`biochemPacks.treatment.${pack.gst_treatment}`, { defaultValue: pack.gst_treatment })}
    </Chip>
  ) : (
    <Chip tone="danger" icon="ban">
      {t('biochemPacks.cantBill')}
    </Chip>
  )
}

function PackPanel({ pack, companyId, onEdit, onClose }: { pack: Pack; companyId: string; onEdit: () => void; onClose: () => void }) {
  const { t } = useTranslation()
  const rights = useProductionRights()
  const items = useApiView('pack_items', { eq: { pack_id: pack.id } })
  const places = useCompanyPlaces(companyId)
  const setGst = useApiMutation<{ p_pack_id: string; p_treatment: string; p_note: string }, { gst_treatment: string }>('set_pack_gst_treatment', PROD_REFRESH)
  const assemble = useApiMutation<{ p: Record<string, unknown> }, { doc_no: string; unit_cost: number | null }>('post_pack_assembly', PROD_REFRESH)
  const [treatment, setTreatment] = useState<string>(pack.gst_treatment ?? TREATMENTS[0])
  const [note, setNote] = useState('')
  const [a, setA] = useState({ qty: '', from: '', to: '', date: todayIst() })
  const [done, setDone] = useState<string | null>(null)
  const cols: Column<ViewRow<'pack_items'>>[] = [
    { key: 'item', header: t('biochemPacks.items.item'), render: (i) => <span>{i.product_name} <span className="k mono">{i.product_code}</span></span> },
    { key: 'kind', header: t('biochemPacks.items.kind'), render: (i) => (i.is_free ? <Chip tone="signal">{t('biochemPacks.items.free')}</Chip> : <Chip tone="info">{t('biochemPacks.items.product')}</Chip>) },
    { key: 'qty', header: t('biochemPacks.items.perPack'), align: 'right', render: (i) => <span className="sf-amount">{qtyText(i.qty)} {i.uom}</span> },
    { key: 'note', header: t('biochemPacks.items.note'), render: (i) => i.note ?? '' },
  ]
  const placeOpts = [{ value: '', label: t('biochemEntry.plan.choosePlace') }, ...places.list.map((p) => ({ value: p.id, label: `${p.name} · ${p.branch_name}` }))]
  return (
    <Card
      title={t('biochemPacks.panelTitle', { name: pack.name })}
      action={
        <span style={{ display: 'inline-flex', gap: 8 }}>
          {rights.edit ? (
            <Button size="sm" onClick={onEdit}>
              {t('common.edit')}
            </Button>
          ) : null}
          <Button size="sm" variant="link" onClick={onClose}>
            {t('common.close')}
          </Button>
        </span>
      }
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }} data-testid="pack-gst">
        <GstState pack={pack} />
        {pack.gst_treatment ? (
          <span className="k">
            {t('biochemPacks.setOn', { date: pack.gst_treatment_set_at ? formatDate(pack.gst_treatment_set_at) : '—', note: pack.gst_treatment_note ?? '' })}
          </span>
        ) : (
          <span className="k">{t('biochemPacks.cantBillWhy')}</span>
        )}
      </div>
      <DataTable caption={t('biochemPacks.items.title')} columns={cols} rows={rowsOf(items)} rowKey={(i) => i.id} loading={items.isLoading} minWidth={560} empty={<EmptyState title={t('biochemPacks.items.empty')} />} />
      {rights.admin ? (
        <>
          <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>{t('biochemPacks.gst.setTitle')}</h3>
          <FieldGrid cols={2}>
            <SelectField label={t('biochemPacks.gst.treatment')} value={treatment} onChange={(e) => setTreatment(e.target.value)} options={TREATMENTS.map((k) => ({ value: k, label: t(`biochemPacks.treatment.${k}`) }))} />
            <Field label={t('biochemPacks.gst.note')} value={note} onChange={(e) => setNote(e.target.value)} help={t('biochemPacks.gst.noteHelp')} />
          </FieldGrid>
          <div style={{ marginTop: 8 }}>
            <Button
              variant="primary"
              busy={setGst.isPending}
              onClick={() => {
                setDone(null)
                assemble.reset()
                setGst.mutate({ p_pack_id: pack.id, p_treatment: treatment, p_note: note.trim() }, { onSuccess: () => setDone(t('biochemPacks.gst.saved')) })
              }}
            >
              {t('biochemPacks.gst.save')}
            </Button>
          </div>
        </>
      ) : !pack.gst_treatment ? (
        <p className="k">{t('biochemPacks.gst.adminOnly')}</p>
      ) : null}
      {rights.create ? (
        <>
          <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>{t('biochemPacks.asm.make')}</h3>
          <FieldGrid cols={3}>
            <Field label={t('biochemPacks.asm.qty')} inputMode="numeric" value={a.qty} onChange={(e) => setA({ ...a, qty: e.target.value })} />
            <SelectField label={t('biochemPacks.asm.from')} value={a.from} onChange={(e) => setA({ ...a, from: e.target.value })} options={placeOpts} />
            <SelectField label={t('biochemPacks.asm.to')} value={a.to} onChange={(e) => setA({ ...a, to: e.target.value })} options={placeOpts} />
            <Field label={t('biochemPacks.asm.date')} type="date" value={a.date} onChange={(e) => setA({ ...a, date: e.target.value })} />
          </FieldGrid>
          <div style={{ marginTop: 8 }}>
            <Button
              busy={assemble.isPending}
              onClick={() => {
                setDone(null)
                setGst.reset()
                assemble.mutate({ p: { pack_id: pack.id, qty: a.qty.trim(), from_place_id: a.from || null, to_place_id: a.to || null, date: a.date } }, { onSuccess: (r) => setDone(t('biochemPacks.asm.done', { no: r.doc_no })) })
              }}
            >
              {t('biochemPacks.asm.submit')}
            </Button>
          </div>
        </>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        <ProductionErrorBox error={setGst.error ?? assemble.error} />
        <Done>{done}</Done>
      </div>
    </Card>
  )
}

interface ItemRow {
  key: string
  product_id: string
  qty: string
  is_free: boolean
  note: string
}
let seq = 0
const nk = () => `i${++seq}`

function PackDialog({ companyId, pack, onClose, onSaved }: { companyId: string; pack: Pack | null; onClose: () => void; onSaved: (id: string) => void }) {
  const { t } = useTranslation()
  const products = useCompanyProducts(companyId)
  const existing = useApiView('pack_items', { eq: { pack_id: pack?.id }, enabled: Boolean(pack) })
  const [productId, setProductId] = useState(pack?.product_id ?? '')
  const [kind, setKind] = useState(pack?.kind ?? 'gift_pack')
  const [name, setName] = useState(pack?.name ?? '')
  const [status, setStatus] = useState(pack?.status ?? 'active')
  const [items, setItems] = useState<ItemRow[] | null>(pack ? null : [{ key: nk(), product_id: '', qty: '1', is_free: false, note: '' }])
  const [hint, setHint] = useState<string | null>(null)
  const save = useApiMutation<{ p: Record<string, unknown> }, { id: string }>('upsert_pack', PROD_REFRESH)
  const rows = items ?? rowsOf(existing).map((i) => ({ key: i.id, product_id: i.product_id, qty: String(i.qty), is_free: i.is_free, note: i.note ?? '' }))
  const setRows = (fn: (r: ItemRow[]) => ItemRow[]) => setItems(fn(rows))
  const opts = [{ value: '', label: t('biochemManufacturing.ed.chooseItem') }, ...products.list.map((p) => ({ value: p.id, label: `${p.code} · ${p.name} (${p.uom})` }))]
  return (
    <FormDialog
      open
      wide
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={pack ? t('biochemPacks.editTitle') : t('biochemPacks.addTitle')}
      description={t('biochemPacks.dialogHint')}
      submitLabel={t('common.save')}
      busy={save.isPending}
      error={
        <>
          {hint ? (
            <p role="alert" className="sf-alert" data-tone="danger" style={{ margin: 0 }}>
              {hint}
            </p>
          ) : null}
          <ProductionErrorBox error={save.error} />
        </>
      }
      onSubmit={() => {
        setHint(null)
        const out = rows.filter((r) => r.product_id)
        if (out.some((r) => !cleanNum(r.qty))) return setHint(t('biochemPacks.qtyHint'))
        save.mutate(
          { p: { id: pack?.id ?? null, company_id: companyId, product_id: productId || null, kind, name: name.trim(), status, items: out.map((r) => ({ product_id: r.product_id, qty: cleanNum(r.qty), is_free: r.is_free, note: r.note.trim() || null })) } },
          {
            onSuccess: (r) => {
              onSaved(r.id)
              onClose()
            },
          },
        )
      }}
    >
      <FieldGrid cols={2}>
        <Field label={t('biochemPacks.col.pack')} value={name} onChange={(e) => setName(e.target.value)} required />
        <SelectField label={t('biochemPacks.packItem')} value={productId} onChange={(e) => setProductId(e.target.value)} options={opts} disabled={Boolean(pack)} help={t('biochemPacks.packItemHelp')} />
        <SelectField label={t('biochemPacks.col.kind')} value={kind} onChange={(e) => setKind(e.target.value)} options={KINDS.map((k) => ({ value: k, label: t(`biochemPacks.kind.${k}`) }))} />
        <SelectField label={t('common.status')} value={status} onChange={(e) => setStatus(e.target.value)} options={['active', 'inactive'].map((s) => ({ value: s, label: t(`biochemCommon.status.${s}`) }))} />
      </FieldGrid>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 6 }}>{t('biochemPacks.items.title')}</legend>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((r, i) => (
            <div key={r.key} style={{ display: 'grid', gridTemplateColumns: '1fr 100px 120px 1fr auto', gap: 8, alignItems: 'end' }}>
              <SelectField label={t('biochemPacks.items.itemN', { n: i + 1 })} value={r.product_id} onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, product_id: e.target.value } : x)))} options={opts} />
              <Field label={t('biochemPacks.items.qtyN', { n: i + 1 })} inputMode="decimal" value={r.qty} onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, qty: e.target.value } : x)))} />
              <Checkbox label={t('biochemPacks.items.freeN', { n: i + 1 })} checked={r.is_free} onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, is_free: e.target.checked } : x)))} />
              <Field label={t('biochemPacks.items.noteN', { n: i + 1 })} value={r.note} onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, note: e.target.value } : x)))} />
              <Button size="sm" variant="link" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} aria-label={t('biochemPacks.items.removeN', { n: i + 1 })}>
                {t('biochemManufacturing.ed.remove')}
              </Button>
            </div>
          ))}
        </div>
        <Button size="sm" style={{ marginTop: 8 }} onClick={() => setRows((rs) => [...rs, { key: nk(), product_id: '', qty: '1', is_free: false, note: '' }])}>
          {t('biochemPacks.items.add')}
        </Button>
      </fieldset>
    </FormDialog>
  )
}

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { formatDate, formatIndian } from '@/shared/format'
import { Amount, Button, Card, Checkbox, Chip, DataTable, EmptyState, ErrorRef, Field, FieldGrid, FormDialog, PageHeader, SelectField, Skeleton, type Column } from '@/ui'

type PriceList = ViewRow<'price_lists'>
type Item = ViewRow<'price_list_items'>
type Product = ViewRow<'products'>

const KINDS = ['wholesale', 'retail', 'distributor', 'export', 'online', 'other'] as const

interface ListDraft {
  id?: string
  name: string
  kind: string
  tax_inclusive: boolean
  active: boolean
}

/**
 * Price lists (`PriceList`): the lists of the chosen company (api.price_lists) and the prices in force on the chosen
 * list (api.price_list_items). Admin adds lists (api.upsert_price_list) and sets prices from a date (api.set_price);
 * a tax-inclusive price above MRP is refused by the server (rule price.above_mrp).
 */
export function PriceListPage() {
  const { t } = useTranslation()
  const can = useCan()
  const { profile } = useAuth()
  const canManage = can('products.manage') && profile?.view !== 'all-readonly'
  const { list: companies, company, companyId, choose, isLoading: companiesLoading } = useCompanyChoice()
  const listsQ = useApiView('price_lists', { eq: { company_id: companyId }, order: 'name', enabled: Boolean(companyId) })
  const lists = rowsOf(listsQ)
  const [picked, setPicked] = useState<string | null>(null)
  const current = lists.find((l) => l.id === picked) ?? lists[0]
  const itemsQ = useApiView('price_list_items', { eq: { price_list_id: current?.id }, order: 'product_code', enabled: Boolean(current) })
  const products = rowsOf(useApiView('products', { order: 'code', limit: 2000 }))
  const productById = new Map(products.map((p) => [p.id, p]))
  const [listDraft, setListDraft] = useState<ListDraft | null>(null)
  const [pricing, setPricing] = useState<{ productId?: string } | null>(null)

  const columns: Column<Item>[] = [
    { key: 'code', header: t('priceLists.col.code'), width: 130, render: (i) => <span className="mono">{i.product_code}</span> },
    { key: 'product', header: t('priceLists.col.product'), render: (i) => i.product_name },
    { key: 'mrp', header: t('priceLists.col.mrp'), align: 'right', render: (i) => <Amount value={productById.get(i.product_id)?.mrp ?? null} /> },
    { key: 'price', header: current?.tax_inclusive ? t('priceLists.col.priceIncl') : t('priceLists.col.priceExcl'), align: 'right', render: (i) => <strong><Amount value={i.price} /></strong> },
    { key: 'min', header: t('priceLists.col.minQty'), align: 'right', render: (i) => <span className="mono">{Number(i.min_qty) > 0 ? `${i.min_qty} ${i.uom}` : '—'}</span> },
    { key: 'from', header: t('priceLists.col.from'), render: (i) => <span className="mono">{formatDate(i.effective_from)}</span> },
    {
      key: 'actions',
      header: <span className="sr-only">{t('priceLists.col.actions')}</span>,
      render: (i) =>
        canManage ? (
          <Button size="sm" aria-label={t('priceLists.changeFor', { name: i.product_name })} onClick={() => setPricing({ productId: i.product_id })}>
            {t('priceLists.change')}
          </Button>
        ) : null,
    },
  ]

  return (
    <>
      <PageHeader
        title={t('priceLists.title')}
        subtitle={company ? t('priceLists.subtitle', { company: company.short_name || company.name }) : t('priceLists.subtitleNone')}
        actions={
          canManage && companyId ? (
            <Button variant="primary" onClick={() => setListDraft({ name: '', kind: 'wholesale', tax_inclusive: true, active: true })}>
              {t('priceLists.newList')}
            </Button>
          ) : null
        }
      />
      {!canManage ? (
        <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>
          {t('priceLists.noRight')}
        </p>
      ) : null}

      <div style={{ marginBottom: 16 }}>
        <CompanyPicker list={companies} value={companyId} onChange={(id) => { setPicked(null); choose(id) }} panelId="pl-panel" />
      </div>

      <div id="pl-panel" style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 300px) 1fr', gap: 16, alignItems: 'start' }}>
        <Card pad={false}>
          <div className="sf-card__pad" style={{ paddingBottom: 6 }}>
            <h2 className="sf-card__title">{t('priceLists.lists')}</h2>
          </div>
          {companiesLoading || listsQ.isLoading ? (
            <div className="sf-card__pad">
              <Skeleton height={80} />
            </div>
          ) : lists.length === 0 ? (
            <EmptyState
              title={t('priceLists.noListsTitle')}
              body={canManage ? t('priceLists.noListsAdmin') : t('priceLists.noLists')}
              action={
                canManage && companyId ? (
                  <Button variant="primary" onClick={() => setListDraft({ name: '', kind: 'wholesale', tax_inclusive: true, active: true })}>
                    {t('priceLists.newList')}
                  </Button>
                ) : null
              }
            />
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: '0 8px 8px', display: 'grid', gap: 2 }}>
              {lists.map((l) => (
                <li key={l.id}>
                  <ListButton list={l} active={current?.id === l.id} onClick={() => setPicked(l.id)} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card pad={false} style={{ borderTop: '4px solid var(--sf-navy)' }}>
          {current ? (
            <>
              <div className="sf-card__pad" style={{ paddingBottom: 8 }}>
                <div className="sf-card__head" style={{ alignItems: 'center' }}>
                  <div>
                    <h2 className="sf-card__title">{current.name}</h2>
                    <div className="sf-row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                      <Chip tone="outline">{t(`priceLists.kind.${current.kind}`)}</Chip>
                      <TaxChip incl={current.tax_inclusive} />
                      {!current.active ? <Chip tone="neutral" icon="ban">{t('common.inactive')}</Chip> : null}
                    </div>
                  </div>
                  {canManage ? (
                    <div className="sf-row" style={{ gap: 8 }}>
                      <Button size="sm" onClick={() => setListDraft({ id: current.id, name: current.name, kind: current.kind, tax_inclusive: current.tax_inclusive, active: current.active })}>
                        {t('priceLists.editList')}
                      </Button>
                      <Button size="sm" variant="primary" onClick={() => setPricing({})}>
                        {t('priceLists.addPrice')}
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>
              <DataTable
                caption={t('priceLists.itemsCaption', { name: current.name })}
                columns={columns}
                rows={rowsOf(itemsQ)}
                rowKey={(i) => i.id}
                loading={itemsQ.isLoading}
                minWidth={760}
                empty={<EmptyState title={t('priceLists.noItemsTitle')} body={canManage ? t('priceLists.noItemsAdmin') : t('priceLists.noItems')} />}
              />
              <div className="sf-card__pad k" style={{ fontSize: 12, paddingTop: 10 }}>
                {t('priceLists.note')}
              </div>
            </>
          ) : (
            <EmptyState title={t('priceLists.pickTitle')} body={t('priceLists.pickBody')} />
          )}
        </Card>
      </div>

      {listDraft && companyId ? <ListDialog draft={listDraft} companyId={companyId} onClose={() => setListDraft(null)} onSaved={(id) => id && setPicked(id)} /> : null}
      {pricing && current && companyId ? (
        <PriceDialog list={current} companyId={companyId} products={products} productId={pricing.productId} onClose={() => setPricing(null)} />
      ) : null}
    </>
  )
}

function TaxChip({ incl }: { incl: boolean }) {
  const { t } = useTranslation()
  return incl ? <Chip tone="teal" icon="check">{t('priceLists.incl')}</Chip> : <Chip tone="info" icon="info">{t('priceLists.excl')}</Chip>
}

function ListButton({ list, active, onClick }: { list: PriceList; active: boolean; onClick: () => void }) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        width: '100%',
        display: 'grid',
        gap: 2,
        padding: '8px 10px',
        border: 0,
        borderRadius: 6,
        background: active ? 'var(--sf-primary-tint)' : 'transparent',
        color: 'var(--sf-text)',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 13,
      }}
    >
      <span style={{ fontWeight: 600 }}>{list.name}</span>
      <span style={{ fontSize: 12, color: 'var(--sf-text-muted)' }}>
        {t(`priceLists.kind.${list.kind}`)} · {list.tax_inclusive ? t('priceLists.incl') : t('priceLists.excl')} · {t('priceLists.itemCount', { count: list.item_count ?? 0 })}
      </span>
    </button>
  )
}

function ListDialog({ draft: initial, companyId, onClose, onSaved }: { draft: ListDraft; companyId: string; onClose: () => void; onSaved: (id?: string) => void }) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(initial)
  const [err, setErr] = useState<string | undefined>()
  const save = useApiMutation<{ p: Record<string, unknown> }, { id?: string }>('upsert_price_list', [['api', 'price_lists']])

  function submit() {
    if (draft.name.trim().length < 2) {
      setErr(t('priceLists.errName'))
      return
    }
    setErr(undefined)
    const p: Record<string, unknown> = { company_id: companyId, name: draft.name.trim(), kind: draft.kind, tax_inclusive: draft.tax_inclusive, active: draft.active }
    if (draft.id) p.id = draft.id
    save.mutate(
      { p },
      {
        onSuccess: (res) => {
          onSaved(res?.id)
          onClose()
        },
      },
    )
  }

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={draft.id ? t('priceLists.editListTitle') : t('priceLists.newListTitle')}
      description={t('priceLists.listHelp')}
      submitLabel={t('common.save')}
      busy={save.isPending}
      onSubmit={submit}
      error={<RpcErrorBox error={save.error as RpcError | null} />}
    >
      <FieldGrid>
        <Field label={t('priceLists.f.name')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} error={err} />
        <SelectField
          label={t('priceLists.f.kind')}
          value={draft.kind}
          onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
          options={KINDS.map((k) => ({ value: k, label: t(`priceLists.kind.${k}`) }))}
        />
        <div style={{ gridColumn: '1 / -1', display: 'grid', gap: 8 }}>
          <Checkbox label={t('priceLists.f.incl')} hint={t('priceLists.f.inclHint')} checked={draft.tax_inclusive} onChange={(e) => setDraft({ ...draft, tax_inclusive: e.target.checked })} />
          {draft.id ? <Checkbox label={t('priceLists.f.active')} checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} /> : null}
        </div>
      </FieldGrid>
    </FormDialog>
  )
}

function PriceDialog({ list, companyId, products, productId, onClose }: { list: PriceList; companyId: string; products: Product[]; productId?: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [product, setProduct] = useState(productId ?? '')
  const [price, setPrice] = useState('')
  const [minQty, setMinQty] = useState('')
  const [from, setFrom] = useState(todayIst())
  const [errors, setErrors] = useState<{ product?: string; price?: string; minQty?: string }>({})
  const save = useApiMutation<Record<string, unknown>>('set_price', [['api', 'price_list_items'], ['api', 'price_lists']])
  const forCompany = products.filter((p) => (p.company_ids ?? []).includes(companyId))
  const options = (forCompany.length ? forCompany : products).map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))
  const chosen = products.find((p) => p.id === product)
  const err = save.error as RpcError | null

  function submit() {
    const e: { product?: string; price?: string; minQty?: string } = {}
    if (!product) e.product = t('priceLists.errProduct')
    if (!/^\d+(\.\d{1,2})?$/.test(price.trim())) e.price = t('priceLists.errPrice')
    if (minQty.trim() && !/^\d+(\.\d{1,3})?$/.test(minQty.trim())) e.minQty = t('priceLists.errMinQty')
    setErrors(e)
    if (Object.keys(e).length) return
    save.mutate(
      { p_price_list_id: list.id, p_product_id: product, p_price: price.trim(), p_min_qty: minQty.trim() || '0', p_effective_from: from },
      { onSuccess: onClose },
    )
  }

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('priceLists.priceTitle', { name: list.name })}
      description={list.tax_inclusive ? t('priceLists.priceHelpIncl') : t('priceLists.priceHelpExcl')}
      submitLabel={t('priceLists.setPrice')}
      busy={save.isPending}
      onSubmit={submit}
      error={err?.rule === 'price.above_mrp' ? <ErrorRef message={t('priceLists.rules.aboveMrp')} next={t('priceLists.rules.aboveMrpNext')} refId={err.ref} /> : <RpcErrorBox error={err} />}
    >
      <FieldGrid>
        <div style={{ gridColumn: '1 / -1' }}>
          <SelectField
            label={t('priceLists.f.product')}
            value={product}
            disabled={Boolean(productId)}
            onChange={(e) => setProduct(e.target.value)}
            placeholder={t('priceLists.f.choose')}
            options={options}
            error={errors.product}
            help={chosen ? (chosen.mrp === null ? t('priceLists.f.noMrp') : t('priceLists.f.mrpIs', { mrp: formatIndian(chosen.mrp) })) : undefined}
          />
        </div>
        <Field label={list.tax_inclusive ? t('priceLists.f.priceIncl') : t('priceLists.f.priceExcl')} className="mono" inputMode="decimal" prefix="₹" value={price} onChange={(e) => setPrice(e.target.value)} error={errors.price} />
        <Field label={t('priceLists.f.minQty')} className="mono" inputMode="decimal" value={minQty} onChange={(e) => setMinQty(e.target.value)} error={errors.minQty} help={t('priceLists.f.minQtyHelp')} />
        <Field label={t('priceLists.f.from')} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </FieldGrid>
    </FormDialog>
  )
}

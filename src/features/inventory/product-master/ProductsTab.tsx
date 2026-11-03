import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { Amount, Button, Card, Chip, DataTable, EmptyState, Field, SelectField, Skeleton, Tabs, type Column } from '@/ui'
import { KINDS, rateText, STATUSES } from './shared'

type Product = ViewRow<'products'>
type Group = ViewRow<'product_groups'>

const ALL = '__all'

/** Products tab: groups down the left (with counts), filters and the product register on the right. */
export function ProductsTab({
  canManage,
  onAdd,
  onEdit,
  onMrp,
}: {
  canManage: boolean
  onAdd: (companyId?: string) => void
  onEdit: (p: Product) => void
  onMrp: (p: Product) => void
}) {
  const { t } = useTranslation()
  const products = useApiView('products', { order: 'code', limit: 2000 })
  const groupsQ = useApiView('product_groups', { order: 'name' })
  const companies = rowsOf(useApiView('companies', { order: 'code' }))
  const [company, setCompany] = useState<string>(ALL)
  const [group, setGroup] = useState<string>(ALL)
  const [kind, setKind] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')

  const all = rowsOf(products)
  const groups = rowsOf(groupsQ)
  const companyName = useMemo(() => new Map(companies.map((c) => [c.id, c.short_name || c.name])), [companies])

  const inCompany = company === ALL ? all : all.filter((p) => (p.company_ids ?? []).includes(company))
  const q = search.trim().toLowerCase()
  const rows = inCompany.filter(
    (p) =>
      (group === ALL || (group === '' ? !p.group_id : p.group_id === group)) &&
      (!kind || p.kind === kind) &&
      (!status || p.status === status) &&
      (!q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q) || (p.barcode ?? '').includes(q)),
  )
  const countFor = (gid: string) => inCompany.filter((p) => (gid === '' ? !p.group_id : p.group_id === gid)).length
  const visibleGroups = company === ALL ? groups : groups.filter((g) => !g.company_id || g.company_id === company)
  const byKind = KINDS.map((k) => ({ kind: k, groups: visibleGroups.filter((g) => g.kind === k) })).filter((x) => x.groups.length > 0)
  const ungrouped = countFor('')
  const groupTitle = group === ALL ? t('productMaster.allGroups') : group === '' ? t('productMaster.toBeGrouped') : (groups.find((g) => g.id === group)?.name ?? '')

  const columns: Column<Product>[] = [
    { key: 'code', header: t('productMaster.col.code'), width: 110, render: (p) => <span className="mono">{p.code}</span> },
    {
      key: 'name',
      header: t('productMaster.col.name'),
      render: (p) => (
        <div>
          <div>{p.name}</div>
          {p.pack_size || p.alias_count ? (
            <div className="k" style={{ fontSize: 12 }}>
              {[p.pack_size, p.alias_count ? t('productMaster.aliases', { count: p.alias_count }) : null].filter(Boolean).join(' · ')}
            </div>
          ) : null}
        </div>
      ),
    },
    { key: 'group', header: t('productMaster.col.group'), render: (p) => p.group_name ?? <span className="muted">—</span> },
    { key: 'kind', header: t('productMaster.col.kind'), render: (p) => t(`productMaster.kind.${p.kind}`) },
    { key: 'hsn', header: t('productMaster.col.hsn'), render: (p) => (p.hsn_code ? <span className="mono">{p.hsn_code}</span> : <span className="muted">—</span>) },
    {
      key: 'gst',
      header: t('productMaster.col.gst'),
      align: 'right',
      render: (p) => (p.gst_rate === null ? <span className="muted">—</span> : <Chip tone="teal">{rateText(p.gst_rate)}</Chip>),
    },
    { key: 'uom', header: t('productMaster.col.uom'), render: (p) => <span className="mono">{p.uom}</span> },
    { key: 'mrp', header: t('productMaster.col.mrp'), align: 'right', render: (p) => <Amount value={p.mrp} /> },
    { key: 'status', header: t('productMaster.col.status'), render: (p) => <ProductStatus status={p.status} /> },
    {
      key: 'companies',
      header: t('productMaster.col.companies'),
      render: (p) =>
        (p.company_ids ?? []).length === 0 ? (
          <span className="muted">—</span>
        ) : (
          <span style={{ fontSize: 12 }}>{(p.company_ids ?? []).map((id) => companyName.get(id) ?? '').filter(Boolean).join(', ')}</span>
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">{t('productMaster.col.actions')}</span>,
      render: (p) => (
        <div className="sf-row" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
          <Button size="sm" onClick={() => onMrp(p)} aria-label={t('productMaster.mrpFor', { name: p.name })}>
            {t('productMaster.mrpBtn')}
          </Button>
          {canManage ? (
            <Button size="sm" onClick={() => onEdit(p)} aria-label={t('productMaster.editFor', { name: p.name })}>
              {t('common.edit')}
            </Button>
          ) : null}
        </div>
      ),
    },
  ]

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {companies.length > 1 ? (
        <div style={{ display: 'flex' }}>
          {companies.length <= 4 ? (
            <Tabs
              variant="segmented"
              label={t('common.company')}
              value={company}
              onChange={setCompany}
              tabs={[{ key: ALL, label: t('productMaster.allCompanies') }, ...companies.map((c) => ({ key: c.id, label: c.short_name || c.name }))]}
            />
          ) : (
            <div style={{ minWidth: 320 }}>
              <SelectField
                label={t('common.company')}
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                options={[{ value: ALL, label: t('productMaster.allCompanies') }, ...companies.map((c) => ({ value: c.id, label: `${c.code} · ${c.short_name || c.name}` }))]}
              />
            </div>
          )}
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 260px) 1fr', gap: 16, alignItems: 'start' }}>
        <Card pad={false}>
          <nav aria-label={t('productMaster.groupsNav')} className="sf-card__pad" style={{ display: 'grid', gap: 2 }}>
            {groupsQ.isLoading ? (
              <Skeleton height={120} />
            ) : (
              <>
                <GroupButton label={t('productMaster.allGroups')} count={inCompany.length} active={group === ALL} onClick={() => setGroup(ALL)} />
                {byKind.map((k) => (
                  <div key={k.kind} style={{ marginTop: 10 }}>
                    <div className="k" style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', padding: '0 8px 4px' }}>
                      {t(`productMaster.kind.${k.kind}`)}
                    </div>
                    {k.groups.map((g: Group) => (
                      <GroupButton key={g.id} label={g.name} count={countFor(g.id)} active={group === g.id} onClick={() => setGroup(g.id)} />
                    ))}
                  </div>
                ))}
                {ungrouped > 0 ? (
                  <div style={{ marginTop: 10 }}>
                    <div className="k" style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', padding: '0 8px 4px' }}>
                      {t('productMaster.toBeGroupedHead')}
                    </div>
                    <GroupButton label={t('productMaster.toBeGrouped')} count={ungrouped} active={group === ''} onClick={() => setGroup('')} />
                  </div>
                ) : null}
                {groups.length === 0 ? (
                  <p className="muted" style={{ fontSize: 13, margin: '8px' }}>
                    {t('productMaster.noGroups')}
                  </p>
                ) : null}
              </>
            )}
          </nav>
        </Card>

        <Card pad={false}>
          <div className="sf-card__pad" style={{ paddingBottom: 8, display: 'grid', gap: 12 }}>
            <div className="sf-card__head">
              <h2 className="sf-card__title">{groupTitle}</h2>
              <span className="k" style={{ fontSize: 12 }}>
                {t('productMaster.shown', { count: rows.length })}
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
              <Field label={t('productMaster.search')} type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
              <SelectField
                label={t('productMaster.f.kind')}
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                placeholder={t('common.all')}
                options={KINDS.map((k) => ({ value: k, label: t(`productMaster.kind.${k}`) }))}
              />
              <SelectField
                label={t('productMaster.f.status')}
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                placeholder={t('common.all')}
                options={STATUSES.map((s) => ({ value: s, label: t(`productMaster.status.${s}`) }))}
              />
            </div>
          </div>
          <DataTable
            caption={t('productMaster.tableCaption')}
            columns={columns}
            rows={rows}
            rowKey={(p) => p.id}
            loading={products.isLoading}
            minWidth={1000}
            empty={
              <EmptyState
                title={all.length === 0 ? t('productMaster.emptyTitle') : t('productMaster.noMatch')}
                body={all.length === 0 ? (canManage ? t('productMaster.emptyBodyAdmin') : t('productMaster.emptyBody')) : t('productMaster.noMatchBody')}
                action={
                  canManage && all.length === 0 ? (
                    <Button variant="primary" onClick={() => onAdd(company === ALL ? undefined : company)}>
                      {t('productMaster.newProduct')}
                    </Button>
                  ) : null
                }
              />
            }
          />
          <div className="sf-card__pad k" style={{ fontSize: 12, paddingTop: 10 }}>
            {t('productMaster.tableNote')}
          </div>
        </Card>
      </div>
    </div>
  )
}

function GroupButton({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 8,
        alignItems: 'center',
        minHeight: 28,
        padding: '4px 8px',
        border: 0,
        borderRadius: 6,
        background: active ? 'var(--sf-primary-tint)' : 'transparent',
        color: 'var(--sf-text)',
        fontWeight: active ? 600 : 400,
        fontSize: 13,
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <span>{label}</span>
      <span className="mono" style={{ fontSize: 11, color: 'var(--sf-text-muted)' }}>
        {count}
      </span>
    </button>
  )
}

export function ProductStatus({ status }: { status: string }) {
  const { t } = useTranslation()
  if (status === 'active') return <Chip tone="teal" icon="check">{t('productMaster.status.active')}</Chip>
  if (status === 'inactive') return <Chip tone="neutral" icon="ban">{t('productMaster.status.inactive')}</Chip>
  return <Chip tone="signal" icon="clock">{t('productMaster.status.to_review')}</Chip>
}

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { Button, Card, KpiTiles, PageHeader, Tabs } from '@/ui'
import { GroupsTab, type GroupDraft } from './GroupsTab'
import { HsnTab } from './HsnTab'
import { MrpDialog } from './MrpDialog'
import { ProductDialog } from './ProductDialog'
import { ProductsTab } from './ProductsTab'
import { UnitsTab } from './UnitsTab'

type Product = ViewRow<'products'>
type TabKey = 'products' | 'groups' | 'hsn' | 'units'

/**
 * Product master (`ProductMaster`): every item both companies make, buy or sell, with its group, HSN (and the GST
 * rate in force from api.hsn_codes), unit, MRP history and label data. Admin changes through api.upsert_product,
 * api.set_product_mrp, api.upsert_product_group, api.upsert_hsn and api.add_hsn_rate; everyone else reads.
 */
export function ProductMasterPage() {
  const { t } = useTranslation()
  const can = useCan()
  const { profile } = useAuth()
  const readOnly = profile?.view === 'all-readonly'
  const canManage = can('products.manage') && !readOnly
  const canHsn = can('hsn.manage') && !readOnly
  const [tab, setTab] = useState<TabKey>('products')
  const [editing, setEditing] = useState<{ product: Product | null; company?: string } | null>(null)
  const [mrpFor, setMrpFor] = useState<Product | null>(null)
  const [groupDraft, setGroupDraft] = useState<GroupDraft | null>(null)
  const [addingHsn, setAddingHsn] = useState(false)

  const products = rowsOf(useApiView('products', { order: 'code', limit: 2000 }))
  const hsn = rowsOf(useApiView('hsn_codes', { order: 'code' }))
  const finished = products.filter((p) => p.kind === 'finished' || p.kind === 'perfumery').length
  const toReview = products.filter((p) => p.status === 'to_review').length
  const noHsn = products.filter((p) => !p.hsn_code).length
  const unconfirmed = hsn.filter((h) => h.current_rate !== null && !h.current_ca_confirmed).length
  const noRate = hsn.filter((h) => h.current_rate === null).length

  function newGroup() {
    setTab('groups')
    setGroupDraft({ name: '', kind: 'finished', parent_id: '', company_id: '' })
  }

  return (
    <>
      <PageHeader
        title={t('productMaster.title')}
        subtitle={t('productMaster.subtitle')}
        actions={
          <>
            {canManage ? <Button onClick={newGroup}>{t('productMaster.newGroup')}</Button> : null}
            {canHsn ? (
              <Button
                onClick={() => {
                  setTab('hsn')
                  setAddingHsn(true)
                }}
              >
                {t('productMaster.h.add')}
              </Button>
            ) : null}
            {canManage ? (
              <Button variant="primary" onClick={() => setEditing({ product: null })}>
                {t('productMaster.newProduct')}
              </Button>
            ) : null}
          </>
        }
      />
      {!canManage ? (
        <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>
          {readOnly ? t('productMaster.readOnly') : t('productMaster.noRight')}
        </p>
      ) : null}

      <KpiTiles
        ariaLabel={t('productMaster.kpi.label')}
        items={[
          { key: 'all', label: t('productMaster.kpi.products'), value: products.length, sub: t('productMaster.kpi.productsSub', { count: finished }) },
          { key: 'review', label: t('productMaster.kpi.toReview'), value: toReview, sub: t('productMaster.kpi.toReviewSub') },
          { key: 'hsn', label: t('productMaster.kpi.noHsn'), value: noHsn, sub: t('productMaster.kpi.noHsnSub') },
          { key: 'ca', label: t('productMaster.kpi.unconfirmed'), value: unconfirmed, sub: t('productMaster.kpi.unconfirmedSub', { count: noRate }) },
        ]}
      />

      <div style={{ display: 'flex', margin: '16px 0' }}>
        <Tabs
          label={t('productMaster.tabsLabel')}
          value={tab}
          onChange={setTab}
          idBase="pm"
          controls="pm-panel"
          tabs={[
            { key: 'products', label: t('productMaster.tab.products') },
            { key: 'groups', label: t('productMaster.tab.groups') },
            { key: 'hsn', label: t('productMaster.tab.hsn') },
            { key: 'units', label: t('productMaster.tab.units') },
          ]}
        />
      </div>

      <div id="pm-panel" role="tabpanel" aria-labelledby={`pm-tab-${tab}`} style={{ display: 'grid', gap: 16 }}>
        {tab === 'products' ? (
          <ProductsTab canManage={canManage} onAdd={(company) => setEditing({ product: null, company })} onEdit={(p) => setEditing({ product: p })} onMrp={setMrpFor} />
        ) : tab === 'groups' ? (
          <GroupsTab canManage={canManage} draft={groupDraft} setDraft={setGroupDraft} />
        ) : tab === 'hsn' ? (
          <HsnTab canManage={canHsn} adding={addingHsn} setAdding={setAddingHsn} />
        ) : (
          <UnitsTab />
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16, alignItems: 'start', marginTop: 16 }}>
        <Card title={t('productMaster.holds.title')}>
          <RuleList prefix="productMaster.holds" count={6} />
        </Card>
        <Card title={t('productMaster.rules.title')}>
          <RuleList prefix="productMaster.rules" count={5} />
        </Card>
      </div>

      {editing ? <ProductDialog product={editing.product} defaultCompany={editing.company} onClose={() => setEditing(null)} /> : null}
      {mrpFor ? <MrpDialog product={mrpFor} canManage={canManage} onClose={() => setMrpFor(null)} /> : null}
    </>
  )
}

function RuleList({ prefix, count }: { prefix: string; count: number }) {
  const { t } = useTranslation()
  return (
    <dl style={{ margin: 0, display: 'grid', gap: 0 }}>
      {Array.from({ length: count }, (_, i) => i + 1).map((i) => (
        <div key={i} style={{ padding: '10px 0', borderTop: i > 1 ? '1px solid var(--sf-line-soft)' : undefined }}>
          <dt style={{ fontWeight: 600, fontSize: 13 }}>{t(`${prefix}.t${i}`)}</dt>
          <dd className="k" style={{ margin: '2px 0 0', fontSize: 13 }}>
            {t(`${prefix}.b${i}`)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

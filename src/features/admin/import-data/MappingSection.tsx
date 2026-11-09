import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { Button, Checkbox, Chip, DataTable, EmptyState, Field, SelectField, Tabs, type Column } from '@/ui'
import { GroupMapping } from '@/features/admin/tally-books/ChartOfAccounts'
import { TableCard } from './layout'

/**
 * Mapping (Admin › Import data): every Tally name a voucher uses → its ERP target, in tabs for heads, voucher types, godowns,
 * units and currencies, and item aliases. The server proposes (api.suggest_tally_maps); Admin confirms one by one, or in bulk for exact matches only.
 * Voucher types on the CA review list (bills without GST) can never be bulk-confirmed. Nothing posts until every name a voucher uses is confirmed.
 */
type Kind = 'voucher_type' | 'godown' | 'unit' | 'currency' | 'item' | 'group'
type TabKey = 'heads' | 'voucher_types' | 'godowns' | 'units' | 'items'

const DOC_TYPES = [
  'sales_invoice', 'purchase_bill', 'receipt', 'payment', 'journal', 'contra', 'credit_note', 'debit_note', 'stock_journal',
  'manufacturing_journal', 'delivery_note', 'receipt_note', 'sales_order', 'purchase_order', 'rejection_note', 'memo', 'other',
] as const

interface MapRow {
  key: string
  sub?: string | null
  target: string | null
  status: string
  exact: boolean
  caReview?: boolean
  taxClass?: string
  reason: string | null
}

type Gap = ViewRow<'tally_map_gaps'>

export function MappingSection({ companyId, isAdmin, canImport }: { companyId: string; isAdmin: boolean; canImport: boolean }) {
  const { t } = useTranslation()
  const batches = rowsOf(useApiView('import_batches', { order: 'created_at', ascending: false, eq: { company_id: companyId }, limit: 100 }))
  const [tab, setTab] = useState<TabKey>('voucher_types')
  const suggest = useApiMutation<{ p_company_id: string }, Record<string, number>>('suggest_tally_maps', [
    ['api', 'tally_voucher_type_map'], ['api', 'tally_godown_map'], ['api', 'tally_unit_map'], ['api', 'tally_currency_map'], ['api', 'tally_item_map'], ['api', 'tally_group_suggest'], ['api', 'bug_items'],
  ])

  const vt = rowsOf(useApiView('tally_voucher_type_map', { order: 'tally_type', eq: { company_id: companyId } }))
  const gd = rowsOf(useApiView('tally_godown_map', { order: 'tally_godown', eq: { company_id: companyId } }))
  const un = rowsOf(useApiView('tally_unit_map', { order: 'tally_unit', eq: { company_id: companyId } }))
  const cu = rowsOf(useApiView('tally_currency_map', { order: 'tally_symbol', eq: { company_id: companyId } }))
  const it = rowsOf(useApiView('tally_item_map', { order: 'tally_item', eq: { company_id: companyId } }))
  const gr = rowsOf(useApiView('tally_group_suggest', { order: 'tally_group', eq: { company_id: companyId } }))
  const places = rowsOf(useApiView('places', { order: 'name', eq: { company_id: companyId } }))
  const uoms = rowsOf(useApiView('uoms', { order: 'code' }))
  const products = rowsOf(useApiView('products', { order: 'name', limit: 3000 }))
  const groups = rowsOf(useApiView('account_groups', { order: 'name', eq: { company_id: companyId } }))
  const gaps = rowsOf(useApiView('tally_map_gaps', { eq: { company_id: companyId }, limit: 500 }))

  const docLabel = (d: string) => t(`tallyMaps.doc.${d}`, { defaultValue: d })
  const rows = useMemo(
    () => ({
      voucher_type: vt.map((r): MapRow => ({ key: r.tally_type, sub: r.base_type, target: r.erp_doc_type, status: r.status, exact: r.exact, caReview: r.ca_review, taxClass: r.tax_class, reason: r.reason })),
      godown: gd.map((r): MapRow => ({ key: r.tally_godown, sub: r.tally_parent, target: r.place_id, status: r.status, exact: r.exact, reason: r.reason })),
      unit: un.map((r): MapRow => ({ key: r.tally_unit, sub: r.is_simple === false ? t('tallyMaps.compound') : null, target: r.uom_code, status: r.status, exact: r.exact, reason: r.reason })),
      currency: cu.map((r): MapRow => ({ key: r.tally_symbol, sub: r.mailing_name, target: r.iso_code, status: r.status, exact: r.exact, reason: r.reason })),
      item: it.map((r): MapRow => ({ key: r.tally_item, target: r.product_id, status: r.status, exact: r.exact, reason: r.reason })),
      group: gr.map((r): MapRow => ({ key: r.tally_group, sub: r.tally_parent, target: r.account_group_id, status: r.status, exact: r.exact, reason: r.reason })),
    }),
    [vt, gd, un, cu, it, gr, t],
  )

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'heads', label: t('tallyMaps.tabs.heads') },
    { key: 'voucher_types', label: t('tallyMaps.tabs.voucher_types') },
    { key: 'godowns', label: t('tallyMaps.tabs.godowns') },
    { key: 'units', label: t('tallyMaps.tabs.units') },
    { key: 'items', label: t('tallyMaps.tabs.items') },
  ]

  return (
    <section aria-labelledby="tally-maps-title" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        <h2 id="tally-maps-title" style={{ margin: 0, fontSize: 18 }}>
          {t('tallyMaps.title')}
        </h2>
        {isAdmin ? (
          <Button size="sm" busy={suggest.isPending} onClick={() => suggest.mutate({ p_company_id: companyId })}>
            {t('tallyMaps.suggest')}
          </Button>
        ) : null}
      </div>
      <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>
        {t('tallyMaps.hint')}
      </p>
      {suggest.error ? <RpcErrorBox error={suggest.error} /> : null}
      {suggest.data ? (
        <p role="status" style={{ margin: '0 0 12px', fontSize: 13 }}>
          {t('tallyMaps.suggested', { vt: suggest.data.voucher_types ?? 0, gd: suggest.data.godowns ?? 0, un: suggest.data.units ?? 0, it: suggest.data.items ?? 0, ca: suggest.data.ca_review ?? 0 })}
        </p>
      ) : null}

      <GapsCard gaps={gaps} />

      <Tabs label={t('tallyMaps.tabsLabel')} tabs={tabs} value={tab} onChange={setTab} idBase="tally-maps" controls="tally-maps-panel" />
      <div id="tally-maps-panel" role="tabpanel" aria-labelledby={`tally-maps-tab-${tab}`} style={{ marginTop: 12 }}>
        {tab === 'heads' ? (
          <>
            <GroupMapping companyId={companyId} canManage={isAdmin} canImport={canImport} batches={batches} />
            <MapTable
              kind="group"
              title={t('tallyMaps.heads.suggestions')}
              companyId={companyId}
              rows={rows.group}
              isAdmin={isAdmin}
              options={groups.map((g) => ({ value: g.id, label: g.name }))}
              invalidate={[['api', 'tally_group_suggest'], ['api', 'tally_group_map'], ['api', 'bug_items']]}
            />
          </>
        ) : null}
        {tab === 'voucher_types' ? (
          <MapTable
            kind="voucher_type"
            title={t('tallyMaps.tabs.voucher_types')}
            companyId={companyId}
            rows={rows.voucher_type}
            isAdmin={isAdmin}
            options={DOC_TYPES.map((d) => ({ value: d, label: docLabel(d) }))}
            invalidate={[['api', 'tally_voucher_type_map'], ['api', 'bug_items'], ['api', 'tally_map_gaps']]}
          />
        ) : null}
        {tab === 'godowns' ? (
          <MapTable
            kind="godown"
            title={t('tallyMaps.tabs.godowns')}
            companyId={companyId}
            rows={rows.godown}
            isAdmin={isAdmin}
            options={places.map((p) => ({ value: p.id, label: `${p.name} · ${p.code}` }))}
            invalidate={[['api', 'tally_godown_map'], ['api', 'bug_items'], ['api', 'tally_map_gaps']]}
          />
        ) : null}
        {tab === 'units' ? (
          <>
            <MapTable
              kind="unit"
              title={t('tallyMaps.units.units')}
              companyId={companyId}
              rows={rows.unit}
              isAdmin={isAdmin}
              options={uoms.map((u) => ({ value: u.code, label: `${u.code} · ${u.label}` }))}
              invalidate={[['api', 'tally_unit_map'], ['api', 'bug_items'], ['api', 'tally_map_gaps']]}
            />
            <MapTable
              kind="currency"
              title={t('tallyMaps.units.currencies')}
              companyId={companyId}
              rows={rows.currency}
              isAdmin={isAdmin}
              options={null}
              invalidate={[['api', 'tally_currency_map'], ['api', 'bug_items']]}
            />
          </>
        ) : null}
        {tab === 'items' ? (
          <MapTable
            kind="item"
            title={t('tallyMaps.tabs.items')}
            companyId={companyId}
            rows={rows.item}
            isAdmin={isAdmin}
            options={products.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))}
            invalidate={[['api', 'tally_item_map'], ['api', 'tally_map_gaps'], ['api', 'products']]}
          />
        ) : null}
      </div>
    </section>
  )
}

/** Names used by staged vouchers whose mapping is not confirmed yet (api.tally_map_gaps): each one holds its vouchers back. */
function GapsCard({ gaps }: { gaps: Gap[] }) {
  const { t } = useTranslation()
  const counts = new Map<string, number>()
  for (const g of gaps) counts.set(g.kind ?? '', (counts.get(g.kind ?? '') ?? 0) + 1)
  const cols: Column<Gap>[] = [
    { key: 'kind', header: t('tallyMaps.gaps.kind'), render: (g) => t(`tallyMaps.gaps.kinds.${g.kind}`, { defaultValue: g.kind ?? '' }) },
    { key: 'name', header: t('tallyMaps.gaps.name'), render: (g) => <strong style={{ fontWeight: 600 }}>{g.name}</strong> },
    { key: 'used', header: t('tallyMaps.gaps.used'), align: 'right', render: (g) => <span className="mono">{g.used_count}</span> },
    { key: 'status', header: t('tallyMaps.gaps.status'), render: (g) => <Chip tone={g.status === 'suggested' ? 'signal' : 'danger'}>{t(`tallyMaps.status.${g.status}`, { defaultValue: g.status ?? '' })}</Chip> },
  ]
  return (
    <TableCard
      style={{ marginBottom: 12 }}
      title={t('tallyMaps.gaps.title')}
      action={gaps.length > 0 ? <Chip tone="danger">{t('tallyMaps.gaps.count', { count: gaps.length })}</Chip> : <Chip tone="success" icon="check">{t('tallyMaps.gaps.none')}</Chip>}
    >
      {gaps.length === 0 ? (
        <p className="muted sf-card__pad" style={{ margin: 0, fontSize: 13 }}>
          {t('tallyMaps.gaps.noneBody')}
        </p>
      ) : (
        <DataTable caption={t('tallyMaps.gaps.title')} columns={cols} rows={gaps} rowKey={(g) => `${g.kind}|${g.name}`} minWidth={560} />
      )}
    </TableCard>
  )
}

interface ConfirmArgs extends Record<string, unknown> {
  p_company_id: string
  p_kind: Kind
  p_key: string
  p_target: Record<string, unknown>
  p_ack_ca_review: boolean
}

function targetBody(kind: Kind, value: string): Record<string, unknown> {
  switch (kind) {
    case 'voucher_type':
      return { erp_doc_type: value }
    case 'godown':
      return { place_id: value }
    case 'unit':
      return { uom_code: value }
    case 'currency':
      return { iso_code: value }
    case 'item':
      return { product_id: value }
    default:
      return { account_group_id: value }
  }
}

function MapTable({
  kind, title, companyId, rows, isAdmin, options, invalidate,
}: {
  kind: Kind
  title: string
  companyId: string
  rows: MapRow[]
  isAdmin: boolean
  /** null = free text (currency ISO code) */
  options: { value: string; label: string }[] | null
  invalidate: string[][]
}) {
  const { t } = useTranslation()
  const confirm = useApiMutation<ConfirmArgs>('confirm_tally_map', invalidate)
  const bulk = useApiMutation<{ p_company_id: string; p_kind: Kind }, { confirmed: number; left_for_review: number }>('confirm_tally_maps_bulk', invalidate)
  const [choice, setChoice] = useState<Record<string, string>>({})
  const [ack, setAck] = useState<Record<string, boolean>>({})
  const exactCount = rows.filter((r) => r.status === 'suggested' && r.exact && !r.caReview && r.target).length
  const label = (r: MapRow) => options?.find((o) => o.value === r.target)?.label ?? r.target ?? '—'

  const cols: Column<MapRow>[] = [
    {
      key: 'name',
      header: t('tallyMaps.col.tally'),
      render: (r) => (
        <span>
          <strong style={{ fontWeight: 600 }}>{r.key}</strong>
          {r.sub ? <span className="muted">{` · ${r.sub}`}</span> : null}
        </span>
      ),
    },
    {
      key: 'target',
      header: t('tallyMaps.col.erp'),
      render: (r) => {
        const value = choice[r.key] ?? r.target ?? ''
        if (r.status === 'confirmed' || !isAdmin) return <span>{label(r)}</span>
        if (options === null)
          return (
            <Field
              label={<span className="sr-only">{t('tallyMaps.chooseFor', { name: r.key })}</span>}
              aria-label={t('tallyMaps.chooseFor', { name: r.key })}
              value={choice[r.key] ?? r.target ?? ''}
              maxLength={3}
              placeholder="INR"
              onChange={(e) => setChoice({ ...choice, [r.key]: e.target.value.toUpperCase() })}
            />
          )
        return (
          <SelectField
            label={<span className="sr-only">{t('tallyMaps.chooseFor', { name: r.key })}</span>}
            aria-label={t('tallyMaps.chooseFor', { name: r.key })}
            value={value}
            placeholder={t('tallyMaps.choose')}
            options={options}
            onChange={(e) => setChoice({ ...choice, [r.key]: e.target.value })}
          />
        )
      },
    },
    {
      key: 'flags',
      header: t('tallyMaps.col.note'),
      render: (r) => (
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {r.taxClass === 'without_gst' ? <Chip tone="signal" icon="alert">{t('tallyMaps.withoutGst')}</Chip> : null}
          {r.caReview ? <Chip tone="danger" icon="lock">{t('tallyMaps.caReview')}</Chip> : null}
          {r.exact && r.status === 'suggested' ? <Chip tone="info">{t('tallyMaps.exact')}</Chip> : null}
          {r.reason ? <span className="muted" style={{ fontSize: 12 }}>{r.reason}</span> : null}
        </span>
      ),
    },
    {
      key: 'action',
      header: t('tallyMaps.col.status'),
      render: (r) => {
        if (r.status === 'confirmed') return <Chip tone="success" icon="check">{t('tallyMaps.status.confirmed')}</Chip>
        if (!isAdmin) return <Chip tone="signal">{t('tallyMaps.status.suggested')}</Chip>
        const value = choice[r.key] ?? r.target ?? ''
        const needsAck = Boolean(r.caReview)
        return (
          <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {needsAck ? (
              <Checkbox
                label={t('tallyMaps.ack')}
                checked={ack[r.key] ?? false}
                onChange={(e) => setAck({ ...ack, [r.key]: e.target.checked })}
              />
            ) : null}
            <Button
              size="sm"
              variant="primary"
              disabled={!value || (needsAck && !ack[r.key])}
              busy={confirm.isPending && confirm.variables?.p_key === r.key}
              aria-label={t('tallyMaps.confirmAria', { name: r.key })}
              onClick={() => confirm.mutate({ p_company_id: companyId, p_kind: kind, p_key: r.key, p_target: choice[r.key] ? targetBody(kind, choice[r.key] as string) : {}, p_ack_ca_review: ack[r.key] ?? false })}
            >
              {t('tallyMaps.confirm')}
            </Button>
          </span>
        )
      },
    },
  ]

  return (
    <TableCard
      style={{ marginBottom: 12 }}
      title={title}
      action={
        isAdmin ? (
          <Button
            size="sm"
            disabled={exactCount === 0}
            busy={bulk.isPending}
            onClick={() => bulk.mutate({ p_company_id: companyId, p_kind: kind })}
          >
            {t('tallyMaps.bulk', { count: exactCount })}
          </Button>
        ) : undefined
      }
    >
      {confirm.error ? <div className="sf-card__pad"><RpcErrorBox error={confirm.error} /></div> : null}
      {bulk.error ? <div className="sf-card__pad"><RpcErrorBox error={bulk.error} /></div> : null}
      {bulk.data ? (
        <p role="status" className="sf-card__pad" style={{ margin: 0, fontSize: 13 }}>
          {t('tallyMaps.bulkDone', { confirmed: bulk.data.confirmed, left: bulk.data.left_for_review })}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <div className="sf-card__pad">
          <EmptyState title={t('tallyMaps.empty')} body={t('tallyMaps.emptyBody')} />
        </div>
      ) : (
        <DataTable caption={title} columns={cols} rows={rows} rowKey={(r) => r.key} minWidth={760} rowTone={(r) => (r.caReview && r.status !== 'confirmed' ? 'signal' : undefined)} />
      )}
    </TableCard>
  )
}

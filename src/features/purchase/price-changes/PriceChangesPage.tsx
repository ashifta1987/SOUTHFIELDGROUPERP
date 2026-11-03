import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { formatDate, formatIndian } from '@/shared/format'
import { Amount, Button, Card, Chip, DataTable, EmptyState, PageHeader, Skeleton, type Column } from '@/ui'

type Row = ViewRow<'price_changes'>
const KINDS = ['raw_material', 'packaging', 'component', 'consumable', 'perfumery', 'spares', 'finished', 'other'] as const

/**
 * Price changes (`PriceChanges`): every item's latest bill rate against the previous one (before GST, per unit), from
 * api.price_changes (bill rates are recorded when a purchase bill posts). The chart plots one item's bill rates from
 * api.price_history. The alert threshold comes from the setting purchase.price_alert_pct (unset = every increase).
 */
export function PriceChangesPage() {
  const { t } = useTranslation()
  const choice = useCompanyChoice()
  const companyId = choice.companyId
  const [kind, setKind] = useState('')
  const q = useApiView('price_changes', { eq: { company_id: companyId, product_kind: kind || undefined }, limit: 2000, enabled: Boolean(companyId) })
  const rows = [...rowsOf(q)].sort((a, b) => Math.abs(Number(b.change_pct ?? -1)) - Math.abs(Number(a.change_pct ?? -1)))
  const [picked, setPicked] = useState<string | null>(null)
  const chartItem = rows.find((r) => r.product_id === picked) ?? rows.find((r) => r.is_increase) ?? rows[0] ?? null
  const alertPct = rows.find((r) => r.alert_pct !== null)?.alert_pct ?? null

  const columns: Column<Row>[] = [
    {
      key: 'item',
      header: t('priceChanges.cols.item'),
      render: (r) => (
        <div>
          <div style={{ fontWeight: 600 }}>{r.product_name}</div>
          <div className="k">{t('priceChanges.perUom', { uom: r.uom ?? '' })}</div>
        </div>
      ),
    },
    { key: 'group', header: t('priceChanges.cols.group'), render: (r) => r.group_name ?? t(`priceChanges.kinds.${r.product_kind}`) },
    { key: 'latest', header: t('priceChanges.cols.latest'), render: (r) => `${r.latest_party_name ?? '—'} · ${formatDate(r.latest_date)}` },
    { key: 'lrate', header: t('priceChanges.cols.rate'), align: 'right', render: (r) => <Amount value={r.latest_rate} /> },
    { key: 'prev', header: t('priceChanges.cols.previous'), render: (r) => (r.previous_date ? `${r.previous_party_name ?? '—'} · ${formatDate(r.previous_date)}` : '—') },
    { key: 'prate', header: t('priceChanges.cols.rate'), align: 'right', render: (r) => <Amount value={r.previous_rate} /> },
    {
      key: 'change',
      header: t('priceChanges.cols.change'),
      align: 'right',
      render: (r) =>
        r.first_bill ? (
          <Chip tone="neutral">{t('priceChanges.firstBill')}</Chip>
        ) : (
          <span data-testid={`change-${r.product_code}`}>
            <Chip tone={r.is_increase ? 'danger' : Number(r.change) < 0 ? 'success' : 'neutral'}>{`${Number(r.change_pct) > 0 ? '+' : ''}${formatIndian(r.change_pct ?? 0)}%`}</Chip>
          </span>
        ),
    },
    {
      key: 'act',
      header: <span className="sr-only">{t('priceChanges.cols.actions')}</span>,
      render: (r) => (
        <Button size="sm" variant="link" aria-label={t('priceChanges.chartAria', { name: r.product_name })} onClick={() => setPicked(r.product_id)}>
          {t('priceChanges.chart')}
        </Button>
      ),
    },
  ]

  return (
    <>
      <PageHeader
        title={t('priceChanges.title')}
        subtitle={t('priceChanges.subtitle')}
        actions={
          <>
            <label className="sr-only" htmlFor="pc-kind">
              {t('priceChanges.kind')}
            </label>
            <select id="pc-kind" className="sf-input" style={{ width: 200 }} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">{t('priceChanges.allKinds')}</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`priceChanges.kinds.${k}`)}
                </option>
              ))}
            </select>
            <Button comingInPhase={9}>{t('priceChanges.download')}</Button>
          </>
        }
      />
      <div style={{ marginBottom: 16 }}>
        <CompanyPicker list={choice.list} value={companyId} onChange={choice.choose} />
      </div>
      {choice.isLoading ? (
        <Card>
          <Skeleton height={80} />
        </Card>
      ) : !companyId ? (
        <Card>
          <EmptyState title={t('priceChanges.noCompany')} />
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 16, alignItems: 'start' }}>
            <Card title={chartItem ? t('priceChanges.chartTitle', { name: chartItem.product_name, uom: chartItem.uom ?? '' }) : t('priceChanges.chartEmptyTitle')} action={<Chip tone="teal">{t('priceChanges.fromBills')}</Chip>}>
              {chartItem ? <RateChart companyId={companyId} item={chartItem} /> : <p className="muted" style={{ margin: 0 }}>{t('priceChanges.chartEmpty')}</p>}
            </Card>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <Card title={t('priceChanges.effect.title')}>
                <p className="muted" style={{ margin: 0 }}>
                  {t('priceChanges.effect.body')}
                </p>
              </Card>
              <Card title={t('priceChanges.alerts.title')}>
                <p style={{ marginTop: 0 }}>{alertPct !== null ? t('priceChanges.alerts.pct', { pct: formatIndian(alertPct) }) : t('priceChanges.alerts.unset')}</p>
                <p className="muted" style={{ marginBottom: 0 }}>
                  {t('priceChanges.alerts.monthly')}
                </p>
              </Card>
            </div>
          </div>
          <TableCard title={t('priceChanges.tableTitle')} action={<span className="k">{t('priceChanges.sorted')}</span>}>
            <DataTable caption={t('priceChanges.tableTitle')} columns={columns} rows={rows} rowKey={(r) => r.product_id} loading={q.isLoading} minWidth={960} empty={<EmptyState title={t('priceChanges.emptyTitle')} body={t('priceChanges.emptyBody')} />} />
            <p className="k" style={{ margin: 12 }}>
              {t('priceChanges.footnote')}
            </p>
          </TableCard>
        </div>
      )}
    </>
  )
}

/** Bill rates of one item over time (api.price_history, source bill), drawn as a simple line. */
function RateChart({ companyId, item }: { companyId: string; item: Row }) {
  const { t } = useTranslation()
  const q = useApiView('price_history', { eq: { company_id: companyId, product_id: item.product_id, source: 'bill' }, order: 'rate_date', limit: 60 })
  const pts = rowsOf(q)
  if (q.isLoading) return <Skeleton height={200} />
  if (pts.length === 0) return <p className="muted">{t('priceChanges.chartEmpty')}</p>
  const W = 640
  const H = 220
  const pad = 40
  const rates = pts.map((p) => Number(p.rate))
  const min = Math.min(...rates)
  const max = Math.max(...rates)
  const span = max - min || 1
  const x = (i: number) => (pts.length === 1 ? W / 2 : pad + (i * (W - pad * 2)) / (pts.length - 1))
  const y = (r: number) => H - pad - ((r - min) / span) * (H - pad * 2)
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(Number(p.rate)).toFixed(1)}`).join(' ')
  const summary = pts.map((p) => `${formatDate(p.rate_date)} ₹${formatIndian(p.rate)}`).join(', ')
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={t('priceChanges.chartSummary', { name: item.product_name, points: summary })}>
        <line x1={pad} x2={W - pad} y1={H - pad} y2={H - pad} stroke="var(--sf-line)" />
        <line x1={pad} x2={W - pad} y1={pad} y2={pad} stroke="var(--sf-line-faint)" />
        <text x={4} y={pad + 4} fontSize="11" fill="var(--sf-text-muted)" fontFamily="var(--sf-font-mono)">
          {formatIndian(max)}
        </text>
        <text x={4} y={H - pad + 4} fontSize="11" fill="var(--sf-text-muted)" fontFamily="var(--sf-font-mono)">
          {formatIndian(min)}
        </text>
        <path d={path} fill="none" stroke="var(--sf-primary)" strokeWidth={2.5} />
        {pts.map((p, i) => (
          <g key={p.id}>
            <circle cx={x(i)} cy={y(Number(p.rate))} r={5} fill={i === pts.length - 1 ? 'var(--sf-signal)' : 'var(--sf-primary)'} />
            <text x={x(i)} y={y(Number(p.rate)) - 10} fontSize="11" textAnchor="middle" fill="var(--sf-text-2)">
              {`${formatIndian(p.rate)} · ${p.party_name ?? ''}`}
            </text>
            <text x={x(i)} y={H - pad + 18} fontSize="11" textAnchor="middle" fill="var(--sf-text-muted)">
              {formatDate(p.rate_date)}
            </text>
          </g>
        ))}
      </svg>
    </figure>
  )
}

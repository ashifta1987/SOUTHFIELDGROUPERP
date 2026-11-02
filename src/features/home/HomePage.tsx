import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthProvider'
import { useHomeSummary } from '@/data/queries'
import { formatLongDate, formatDate } from '@/shared/format'
import { Amount, BarList, Card, Chip, DataTable, EmptyState, ErrorRef, KpiTiles, NeedsYouList, PageHeader, Skeleton, TaxClassChip, type Column } from '@/ui'
import { ApiError, makeErrorRef } from '@/shared/supabase'
import type { HomeBill } from '@/data/queries'
import { routeForFile } from '@/app/flows'

/**
 * Home (`Main`): KPI row, the sales-by-month card, "Needs you", latest bills.
 * Every figure comes from `api.home_summary()` computed in Postgres for the signed-in user's view.
 * Phase 0 runs against an empty database, so each card shows a designed empty state.
 */
export function HomePage() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const summary = useHomeSummary()
  const isAll = profile?.view === 'all' || profile?.view === 'all-readonly'
  const ready = summary.data?.status === 'ready' ? summary.data.data : null
  const notReady = summary.data?.status === 'not-ready'
  const errRef = summary.error instanceof ApiError ? summary.error.ref : summary.error ? makeErrorRef() : null

  const billColumns: Column<HomeBill>[] = [
    { key: 'date', header: t('home.bills.date'), render: (r) => <span className="mono">{formatDate(r.bill_date)}</span> },
    { key: 'bill', header: t('home.bills.bill'), render: (r) => <span className="mono">{r.doc_no ?? '—'}</span> },
    { key: 'customer', header: t('home.bills.customer'), render: (r) => r.party_name },
    { key: 'kind', header: t('home.bills.kind'), render: (r) =>
        r.tax_class === 'withoutGst' ? (
          <TaxClassChip taxClass="withoutGst" reason={r.lawful_reason} />
        ) : (
          <Chip tone="info">{t('home.bills.withGst')}</Chip>
        ),
    },
    { key: 'amount', header: t('home.bills.amount'), align: 'right', render: (r) => <Amount value={r.amount} digits={0} /> },
  ]

  const subtitle = ready?.data_note ?? `${formatLongDate(new Date())} · ${notReady ? t('home.subtitleEmpty') : ''}`

  return (
    <>
      <PageHeader title={t('home.title')} subtitle={subtitle} />

      {summary.isLoading ? (
        <section className="sf-card sf-kpis" aria-label={t('home.kpisLabel')} aria-busy="true">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="sf-kpi">
              <Skeleton width="70%" height={12} />
              <Skeleton width="60%" height={22} />
              <Skeleton width="80%" height={12} />
            </div>
          ))}
        </section>
      ) : ready && ready.kpis.length > 0 ? (
        <KpiTiles
          ariaLabel={t('home.kpisLabel')}
          items={ready.kpis.map((k) => ({ key: k.key, label: k.label, value: <Amount value={k.value} rupee digits={0} />, sub: k.sub ?? undefined, href: k.href ?? undefined }))}
        />
      ) : (
        <Card>
          <EmptyState
            title={t('home.kpis.emptyTitle')}
            body={t('home.kpis.emptyBody')}
            action={
              <a href={routeForFile('DataImport')} style={{ fontWeight: 600, fontSize: 13 }}>
                {t('home.kpis.emptyAction')}
              </a>
            }
          />
        </Card>
      )}

      {errRef ? <ErrorRef message={t('errors.loadFailed')} next={t('errors.tryAgain')} refId={errRef} /> : null}

      <div className="sf-grid-2">
        <Card style={{ flex: '999 1 560px' }} title={ready?.chart_title ?? t('home.chart.title')} action={<span className="k">{t('home.chart.unit')}</span>}>
          {isAll ? (
            <div className="sf-legend">
              <span>
                <span className="sf-legend__sw" style={{ background: 'var(--sf-info)' }} />
                {t('home.chart.withGst')}
              </span>
              <span>
                <span className="sf-legend__sw" style={{ background: 'var(--sf-signal)' }} />
                {t('home.chart.withoutGst')}
              </span>
            </div>
          ) : null}
          {summary.isLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} height={16} />
              ))}
            </div>
          ) : ready && ready.months.length > 0 ? (
            <BarList
              showSplit={isAll}
              rows={ready.months.map((m) => ({ key: m.month, label: m.month, withGst: m.with_gst, withoutGst: m.without_gst ?? undefined, total: m.total }))}
            />
          ) : (
            <div style={{ marginTop: 10 }}>
              <EmptyState title={t('home.chart.emptyTitle')} body={t('home.chart.emptyBody')} />
            </div>
          )}
        </Card>

        <Card style={{ flex: '1 1 300px' }} title={t('home.needs.title')}>
          <div style={{ marginTop: 10 }}>
            {summary.isLoading ? (
              <Skeleton height={48} />
            ) : ready && ready.tasks.length > 0 ? (
              <NeedsYouList
                items={ready.tasks.map((x) => ({ id: x.id, severity: x.severity, title: x.title, body: x.body, linkLabel: x.link_label, href: x.href }))}
              />
            ) : (
              <EmptyState title={t('home.needs.emptyTitle')} body={t('home.needs.emptyBody')} />
            )}
          </div>
        </Card>
      </div>

      <Card pad={false}>
        <div style={{ padding: '16px 18px 6px', display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <h2 className="sf-card__title">{ready?.latest_title ?? t('home.bills.title')}</h2>
          <a href={routeForFile('SalesRegister')} style={{ fontSize: 13, fontWeight: 600 }}>
            {t('home.bills.all')}
          </a>
        </div>
        <DataTable
          caption={t('home.bills.title')}
          columns={billColumns}
          rows={ready?.latest_bills}
          rowKey={(r) => r.id}
          loading={summary.isLoading}
          rowTone={(r) => (r.tax_class === 'withoutGst' ? 'signal' : undefined)}
          empty={<EmptyState title={t('home.bills.emptyTitle')} body={t('home.bills.emptyBody')} />}
        />
        <p className="sf-card__foot">{isAll ? t('home.bills.noteAll') : t('home.bills.noteGst')}</p>
      </Card>
    </>
  )
}

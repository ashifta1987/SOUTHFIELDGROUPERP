import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useCan } from '@/auth/AuthProvider'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { currentFyStartYear, fyLabel, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { fromPaise, toPaise } from '@/features/accounts/cash-book/money'
import { Amount, Card, EmptyState, KpiTiles, PageHeader, Skeleton, StatusChip, DataTable, type Column } from '@/ui'
import { monthLabel, ReadError, useViewRange } from '../common/hr'
import type { ViewRow } from '@/data/queries'

type Run = ViewRow<'payroll_runs'>
interface Totals {
  people?: number
  gross?: number | string
  net?: number | string
  advance_recovery?: number | string
}

/**
 * Payroll trend (`PayrollBiochemTrend`): the company's payroll runs for this financial year, month by month, from
 * api.payroll_runs (totals worked out by the server when each run was prepared).
 */
export function PayrollTrendPage() {
  const { t } = useTranslation()
  const can = useCan()
  const { list, company, companyId, choose, isLoading } = useCompanyChoice()
  const fy = currentFyStartYear()
  const runs = useViewRange('payroll_runs', 'month', `${fy}-04-01`, `${fy + 1}-03-01`, { company_id: companyId }, Boolean(companyId))
  const rows = runs.data ?? []
  const tot = (r: Run) => (r.totals ?? {}) as Totals
  const gross = rows.reduce((s, r) => s + toPaise(tot(r).gross), 0)
  const net = rows.reduce((s, r) => s + toPaise(tot(r).net), 0)
  const adv = rows.reduce((s, r) => s + toPaise(tot(r).advance_recovery), 0)
  const max = Math.max(1, ...rows.map((r) => toPaise(tot(r).gross)))

  const columns: Column<Run>[] = [
    { key: 'month', header: t('payrollTrend.col.month'), render: (r) => <strong>{monthLabel(r.month)}</strong> },
    { key: 'people', header: t('payrollTrend.col.people'), align: 'right', render: (r) => <span className="mono">{tot(r).people ?? 0}</span> },
    { key: 'gross', header: t('payrollTrend.col.gross'), align: 'right', render: (r) => <Amount value={tot(r).gross ?? 0} /> },
    { key: 'adv', header: t('payrollTrend.col.advance'), align: 'right', render: (r) => <Amount value={tot(r).advance_recovery ?? 0} /> },
    { key: 'net', header: t('payrollTrend.col.net'), align: 'right', render: (r) => <Amount value={tot(r).net ?? 0} /> },
    { key: 'state', header: t('payrollTrend.col.state'), render: (r) => (r.status === 'draft' ? <StatusChip status="draft" label={t('payrollTrend.draft')} /> : <StatusChip status="posted" label={t('payrollTrend.posted')} />) },
  ]

  return (
    <>
      <PageHeader
        title={t('payrollTrend.title', { company: company?.short_name || company?.name || '', fy: fyLabel(fy) })}
        subtitle={t('payrollTrend.subtitle')}
        actions={
          <Link to={`/hr-and-payroll/payroll/payroll-biochem?company=${companyId ?? ''}`} className="sf-btn" data-variant="secondary">
            {t('payrollTrend.toPayroll')}
          </Link>
        }
      />
      <CompanyPicker list={list} value={companyId} onChange={choose} />
      {!can('payroll.run') ? (
        <Card>
          <p className="k">{t('payrollTrend.noRight')}</p>
        </Card>
      ) : isLoading || runs.isLoading ? (
        <Card>
          <Skeleton height={80} />
        </Card>
      ) : runs.error ? (
        <Card>
          <ReadError error={runs.error} />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState title={t('payrollTrend.emptyTitle')} body={t('payrollTrend.emptyBody')} />
        </Card>
      ) : (
        <>
          <KpiTiles
            ariaLabel={t('payrollTrend.kpis')}
            items={[
              { key: 'gross', label: t('payrollTrend.kpi.gross', { n: rows.length }), value: <Amount value={fromPaise(gross)} rupee />, sub: t('payrollTrend.kpi.avg', { v: fromPaise(Math.round(gross / rows.length)) }) },
              { key: 'net', label: t('payrollTrend.kpi.net'), value: <Amount value={fromPaise(net)} rupee /> },
              { key: 'adv', label: t('payrollTrend.kpi.advance'), value: <Amount value={fromPaise(adv)} rupee /> },
            ]}
          />
          <Card title={t('payrollTrend.chartTitle')}>
            <div aria-hidden="true" style={{ display: 'flex', alignItems: 'flex-end', gap: 12, height: 180, paddingTop: 8 }}>
              {rows.map((r) => (
                <div key={r.id} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, height: '100%', justifyContent: 'flex-end' }}>
                  <div
                    style={{
                      width: '60%',
                      minHeight: 2,
                      height: `${Math.round((toPaise(tot(r).gross) / max) * 100)}%`,
                      background: r.status === 'draft' ? 'var(--sf-primary-tint)' : 'var(--sf-primary)',
                      borderRadius: 'var(--sf-radius-chip)',
                    }}
                  />
                  <span className="k">{monthLabel(r.month).slice(0, 3)}</span>
                </div>
              ))}
            </div>
            <p className="k" style={{ margin: '8px 0 0' }}>
              {t('payrollTrend.chartNote')}
            </p>
          </Card>
          <TableCard title={t('payrollTrend.tableTitle')}>
            <DataTable
              caption={t('payrollTrend.tableTitle')}
              columns={columns}
              rows={rows}
              rowKey={(r) => r.id}
              footer={
                <tr>
                  <td colSpan={2}>
                    <strong>{t('payrollTrend.total')}</strong>
                  </td>
                  <td className="r">
                    <Amount value={fromPaise(gross)} />
                  </td>
                  <td className="r">
                    <Amount value={fromPaise(adv)} />
                  </td>
                  <td className="r">
                    <Amount value={fromPaise(net)} />
                  </td>
                  <td />
                </tr>
              }
            />
          </TableCard>
        </>
      )}
    </>
  )
}

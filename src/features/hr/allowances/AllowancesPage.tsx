import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { fromPaise, sumPaise } from '@/features/accounts/cash-book/money'
import { formatDate } from '@/shared/format'
import { Amount, Card, Chip, DataTable, EmptyState, KpiTiles, PageHeader, Skeleton, type Column } from '@/ui'
import { monthLabel, monthStart } from '../common/hr'

type Row = ViewRow<'staff_allowances'>

/**
 * Allowances and benefits (`Allowances`): read-only list of the allowances and deductions on staff records
 * (api.staff_allowances). Each line shows on the payslip under its own name; payroll adds them for the month.
 */
export function AllowancesPage() {
  const { t } = useTranslation()
  const can = useCan()
  const { list, companyId, choose, isLoading } = useCompanyChoice()
  const q = useApiView('staff_allowances', { eq: { company_id: companyId }, order: 'person_name', enabled: Boolean(companyId) })
  const rows = rowsOf(q)
  const month = monthStart(todayIst())
  const current = rows.filter((r) => r.from_month <= month && (!r.to_month || r.to_month >= month))
  const allow = current.filter((r) => r.kind === 'allowance')
  const ded = current.filter((r) => r.kind === 'deduction')
  const heads = [...new Set(rows.map((r) => r.head))]

  const columns: Column<Row>[] = [
    {
      key: 'who',
      header: t('allowances.col.staff'),
      render: (r) => (
        <div>
          <div style={{ fontWeight: 600 }}>{r.person_name}</div>
          <div className="k mono">{r.person_code}</div>
        </div>
      ),
    },
    { key: 'head', header: t('allowances.col.head'), render: (r) => r.head },
    {
      key: 'kind',
      header: t('allowances.col.kind'),
      render: (r) =>
        r.kind === 'allowance' ? (
          <Chip tone="teal" icon="check">
            {t('allowances.kind.allowance')}
          </Chip>
        ) : (
          <Chip tone="signal" icon="alert">
            {t('allowances.kind.deduction')}
          </Chip>
        ),
    },
    { key: 'amount', header: t('allowances.col.amount'), align: 'right', render: (r) => <Amount value={r.amount} /> },
    { key: 'from', header: t('allowances.col.from'), render: (r) => <span className="mono">{formatDate(r.from_month)}</span> },
    { key: 'to', header: t('allowances.col.to'), render: (r) => (r.to_month ? <span className="mono">{formatDate(r.to_month)}</span> : t('allowances.ongoing')) },
    { key: 'note', header: t('allowances.col.note'), render: (r) => r.note ?? '' },
  ]

  return (
    <>
      <PageHeader
        title={t('allowances.title')}
        subtitle={t('allowances.subtitle')}
        actions={
          <Link to={`/hr-and-payroll/payroll?company=${companyId ?? ''}`} className="sf-btn" data-variant="secondary">
            {t('allowances.toPayroll')}
          </Link>
        }
      />
      <CompanyPicker list={list} value={companyId} onChange={choose} />
      {!can('payroll.run') ? (
        <Card>
          <p className="k">{t('allowances.noRight')}</p>
        </Card>
      ) : isLoading ? (
        <Card>
          <Skeleton height={80} />
        </Card>
      ) : (
        <>
          <KpiTiles
            ariaLabel={t('allowances.kpis')}
            items={[
              { key: 'allow', label: t('allowances.kpi.allow', { month: monthLabel(month), n: allow.length }), value: <Amount value={fromPaise(sumPaise(allow, (r) => r.amount))} rupee /> },
              { key: 'ded', label: t('allowances.kpi.ded', { n: ded.length }), value: <Amount value={fromPaise(sumPaise(ded, (r) => r.amount))} rupee /> },
              { key: 'heads', label: t('allowances.kpi.heads'), value: heads.length },
              { key: 'people', label: t('allowances.kpi.people'), value: new Set(current.map((r) => r.person_id)).size },
            ]}
          />
          <TableCard title={t('allowances.tableTitle')}>
            {q.error ? (
              <div className="sf-card__pad">
                <div className="sf-alert" data-tone="danger" role="alert">
                  {t('hrCommon.readFailed')}
                </div>
              </div>
            ) : (
              <DataTable caption={t('allowances.tableTitle')} columns={columns} rows={rows} rowKey={(r) => r.id} loading={q.isLoading} empty={<EmptyState title={t('allowances.emptyTitle')} body={t('allowances.emptyBody')} />} />
            )}
          </TableCard>
          <Card title={t('allowances.howTitle')}>
            <p style={{ margin: 0, fontSize: 13 }}>{t('allowances.howBody')}</p>
          </Card>
        </>
      )}
    </>
  )
}

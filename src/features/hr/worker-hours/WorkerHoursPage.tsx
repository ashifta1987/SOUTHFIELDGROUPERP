import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useReadRpc } from '@/features/accounts/cash-book/money'
import { todayIst } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { formatIndian } from '@/shared/format'
import { Card, Chip, EmptyState, KpiTiles, PageHeader, Skeleton } from '@/ui'
import { HrErrorBox, MonthField, monthLabel, monthStart, useStaffList } from '../common/hr'

interface HoursRow {
  person_id: string
  person_name: string
  pay_company_id: string | null
  company_id: string
  company_name: string
  days: number
  ot_hours: number | string
}

/**
 * Workers, factories and hours (`WorkerHours`): one staff list across both companies. Days and overtime by the company
 * each person worked for in the month (api.hours_by_company), so hours worked for the company that is not the pay
 * company are visible for the month-end cross-charge.
 */
export function WorkerHoursPage() {
  const { t } = useTranslation()
  const [month, setMonth] = useState(monthStart(todayIst()))
  const hours = useReadRpc<HoursRow[]>('hours_by_company', { p_month: month })
  const staff = useStaffList()
  const rows = hours.data ?? []
  const info = new Map(staff.list.map((s) => [s.person_id, s]))
  const groups = (() => {
    const map = new Map<string, { name: string; rows: HoursRow[] }>()
    for (const r of rows) {
      const g = map.get(r.company_id) ?? { name: r.company_name, rows: [] }
      g.rows.push(r)
      map.set(r.company_id, g)
    }
    return [...map.entries()]
  })()
  const days = rows.reduce((s, r) => s + Number(r.days), 0)
  const ot = rows.reduce((s, r) => s + Math.round(Number(r.ot_hours) * 100), 0)
  const cross = rows.filter((r) => r.pay_company_id && r.pay_company_id !== r.company_id)
  const noDesignation = staff.list.filter((s) => s.has_profile && !s.designation).length
  const caption = t('workerHours.tableCaption', { month: monthLabel(month) })

  return (
    <>
      <PageHeader
        title={t('workerHours.title')}
        subtitle={t('workerHours.subtitle', { month: monthLabel(month) })}
        actions={
          <>
            <Link to="/hr-and-payroll/staff-rotation" className="sf-btn" data-variant="secondary">
              {t('workerHours.plan')}
            </Link>
            <Link to="/hr-and-payroll/staff-duties" className="sf-btn" data-variant="primary">
              {t('workerHours.switch')}
            </Link>
          </>
        }
      />
      <div style={{ width: 200 }}>
        <MonthField value={month} onChange={setMonth} max={todayIst()} />
      </div>
      <KpiTiles
        ariaLabel={t('workerHours.kpis')}
        items={[
          { key: 'people', label: t('workerHours.kpi.people'), value: staff.isLoading ? <Skeleton width={50} /> : staff.list.filter((s) => s.has_profile && s.active).length },
          { key: 'days', label: t('workerHours.kpi.days'), value: formatIndian(String(days), 0) },
          { key: 'ot', label: t('workerHours.kpi.ot'), value: formatIndian(String(ot / 100), 1) },
          { key: 'cross', label: t('workerHours.kpi.cross'), value: cross.length, sub: t('workerHours.kpi.crossSub') },
          { key: 'desig', label: t('workerHours.kpi.designation'), value: noDesignation, sub: t('workerHours.kpi.designationSub') },
        ]}
      />
      <TableCard title={t('workerHours.tableTitle', { month: monthLabel(month) })}>
        {hours.error ? (
          <div className="sf-card__pad">
            <HrErrorBox error={hours.error} />
          </div>
        ) : hours.isLoading ? (
          <div className="sf-card__pad">
            <Skeleton height={60} />
          </div>
        ) : rows.length === 0 ? (
          <div className="sf-card__pad">
            <EmptyState
              title={t('workerHours.emptyTitle')}
              body={t('workerHours.emptyBody')}
              action={
                <Link to="/hr-and-payroll/attendance" style={{ fontWeight: 600, fontSize: 13 }}>
                  {t('workerHours.toAttendance')}
                </Link>
              }
            />
          </div>
        ) : (
          <div className="sf-table-wrap" role="region" aria-label={caption} tabIndex={0}>
            <table className="sf-table" style={{ minWidth: 760 }}>
              <caption className="sr-only">{caption}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('workerHours.col.worker')}</th>
                  <th scope="col">{t('workerHours.col.designation')}</th>
                  <th scope="col">{t('workerHours.col.payslip')}</th>
                  <th scope="col" className="r">
                    {t('workerHours.col.days')}
                  </th>
                  <th scope="col" className="r">
                    {t('workerHours.col.ot')}
                  </th>
                  <th scope="col">{t('workerHours.col.note')}</th>
                </tr>
              </thead>
              {groups.map(([id, g]) => (
                <tbody key={id}>
                  <tr style={{ background: 'var(--sf-row-group)' }}>
                    <th scope="rowgroup" colSpan={3} style={{ fontWeight: 700 }}>
                      {t('workerHours.group', { company: g.name, n: g.rows.length })}
                    </th>
                    <td className="r mono">
                      <strong>{g.rows.reduce((s, r) => s + Number(r.days), 0)}</strong>
                    </td>
                    <td className="r mono">
                      <strong>{formatIndian(String(g.rows.reduce((s, r) => s + Math.round(Number(r.ot_hours) * 100), 0) / 100), 1)}</strong>
                    </td>
                    <td />
                  </tr>
                  {g.rows.map((r) => {
                    const s = info.get(r.person_id)
                    const other = r.pay_company_id && r.pay_company_id !== r.company_id
                    return (
                      <tr key={`${r.person_id}-${r.company_id}`}>
                        <th scope="row">
                          <div style={{ fontWeight: 600 }}>{r.person_name}</div>
                          <div className="k mono">{[s?.person_code, s?.pay_basis ? t(`hrCommon.basis.${s.pay_basis}`) : null].filter(Boolean).join(' · ')}</div>
                        </th>
                        <td>{s?.designation ?? <span className="k">{t('workerHours.notSet')}</span>}</td>
                        <td>{s?.pay_company_name ?? '—'}</td>
                        <td className="r mono">{r.days}</td>
                        <td className="r mono">{Number(r.ot_hours) ? formatIndian(r.ot_hours, 1) : '—'}</td>
                        <td>
                          {other ? (
                            <Chip tone="transit" icon="truck">
                              {t('workerHours.otherCompany')}
                            </Chip>
                          ) : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              ))}
            </table>
          </div>
        )}
      </TableCard>
      <Card title={t('workerHours.howTitle')}>
        <p style={{ margin: 0, fontSize: 13 }}>{t('workerHours.howBody')}</p>
      </Card>
    </>
  )
}

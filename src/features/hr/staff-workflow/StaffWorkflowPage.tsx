import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView } from '@/data/queries'
import { addDays } from '@/features/accounts/cash-book/money'
import { todayIst } from '@/features/admin/branches/company'
import { formatDate } from '@/shared/format'
import { Card, KpiTiles, PageHeader, Skeleton } from '@/ui'
import { monthEnd, monthLabel, monthStart, mondayOf, useStaffList, useViewRange } from '../common/hr'

interface Step {
  key: string
  links: { to: string; label: string }[]
  data: string
}

/**
 * Staff workflow (`StaffWorkflow`): how staff work across Southfield Group, from joining to payslip, with each step's
 * live state read from the database (staff list, duties, attendance, requests, cash given, payroll runs).
 */
export function StaffWorkflowPage() {
  const { t } = useTranslation()
  const today = todayIst()
  const month = monthStart(today)
  const week = mondayOf(today)
  const staff = useStaffList()
  const duties = useViewRange('duties', 'duty_date', week, addDays(week, 6))
  const att = useViewRange('attendance', 'work_date', month, monthEnd(month))
  const requests = useApiView('staff_requests', { eq: { status: 'pending' }, limit: 500 })
  const runs = useApiView('payroll_runs', { eq: { month } })
  const cash = useViewRange('cash_given', 'given_on', month, monthEnd(month))
  const people = staff.list.filter((s) => s.has_profile && s.active)
  const noDesignation = people.filter((s) => !s.designation)
  const crossDays = (att.data ?? []).filter((a) => {
    const s = staff.list.find((x) => x.person_id === a.person_id)
    return s?.pay_company_id && s.pay_company_id !== a.company_id
  }).length
  const runRows = rowsOf(runs)
  const drafts = runRows.filter((r) => r.status === 'draft').length
  const posted = runRows.filter((r) => r.status !== 'draft').length
  const loading = staff.isLoading || duties.isLoading || att.isLoading

  const steps: Step[] = [
    {
      key: 'join',
      links: [
        { to: '/hr-and-payroll/employees-and-kyc/add-staff', label: t('staffWorkflow.links.addStaff') },
        { to: '/hr-and-payroll/employees-and-kyc', label: t('staffWorkflow.links.kyc') },
      ],
      data: noDesignation.length ? t('staffWorkflow.data.join', { n: people.length, k: noDesignation.length, names: noDesignation.slice(0, 6).map((s) => s.name).join(', ') }) : t('staffWorkflow.data.joinAll', { n: people.length }),
    },
    {
      key: 'plan',
      links: [
        { to: '/hr-and-payroll/staff-rotation', label: t('staffWorkflow.links.rotation') },
        { to: '/hr-and-payroll/staff-duties', label: t('staffWorkflow.links.duties') },
      ],
      data: t('staffWorkflow.data.plan', { from: formatDate(week), to: formatDate(addDays(week, 6)), n: (duties.data ?? []).length }),
    },
    {
      key: 'mark',
      links: [
        { to: '/hr-and-payroll/attendance', label: t('staffWorkflow.links.attendance') },
        { to: '/hr-and-payroll/leave-and-advance-requests', label: t('staffWorkflow.links.requests') },
      ],
      data: t('staffWorkflow.data.mark', { month: monthLabel(month), n: (att.data ?? []).length, r: rowsOf(requests).length }),
    },
    {
      key: 'hours',
      links: [{ to: '/hr-and-payroll/workers-and-hours', label: t('staffWorkflow.links.hours') }],
      data: t('staffWorkflow.data.hours', { n: crossDays }),
    },
    {
      key: 'cash',
      links: [{ to: '/hr-and-payroll/cash-given-to-staff', label: t('staffWorkflow.links.cash') }],
      data: t('staffWorkflow.data.cash', { n: (cash.data ?? []).length }),
    },
    {
      key: 'pay',
      links: [
        { to: '/hr-and-payroll/payroll', label: t('staffWorkflow.links.payroll') },
        { to: '/hr-and-payroll/payroll/payroll-biochem-trend', label: t('staffWorkflow.links.trend') },
      ],
      data: t('staffWorkflow.data.pay', { month: monthLabel(month), d: drafts, p: posted }),
    },
  ]

  return (
    <>
      <PageHeader title={t('staffWorkflow.title')} subtitle={t('staffWorkflow.subtitle')} />
      <KpiTiles
        ariaLabel={t('staffWorkflow.kpis')}
        items={[
          { key: 'people', label: t('staffWorkflow.kpi.people'), value: loading ? <Skeleton width={50} /> : people.length },
          { key: 'att', label: t('staffWorkflow.kpi.att', { month: monthLabel(month) }), value: (att.data ?? []).length },
          { key: 'req', label: t('staffWorkflow.kpi.requests'), value: rowsOf(requests).length },
          { key: 'desig', label: t('staffWorkflow.kpi.designation'), value: noDesignation.length, sub: t('staffWorkflow.kpi.designationSub') },
        ]}
      />
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {steps.map((s, i) => (
          <li key={s.key}>
            <Card>
              <div style={{ display: 'grid', gridTemplateColumns: '40px minmax(0, 1fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
                <span className="mono" aria-hidden="true" style={{ fontSize: 20, fontWeight: 700, color: 'var(--sf-primary)' }}>
                  {i + 1}
                </span>
                <div>
                  <h2 className="sf-card__title" style={{ margin: 0 }}>
                    {t(`staffWorkflow.steps.${s.key}.title`)} <span className="k">· {t(`staffWorkflow.steps.${s.key}.who`)}</span>
                  </h2>
                  <p style={{ margin: '6px 0 8px', fontSize: 13 }}>{t(`staffWorkflow.steps.${s.key}.body`)}</p>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    {s.links.map((l) => (
                      <Link key={l.to} to={l.to} style={{ fontWeight: 600, fontSize: 13 }}>
                        {l.label} →
                      </Link>
                    ))}
                  </div>
                </div>
                <div className="sf-alert" data-tone="info" style={{ flexDirection: 'column', fontSize: 13 }}>
                  <strong>{t('staffWorkflow.yourData')}</strong>
                  <span>{loading ? <Skeleton width={120} /> : s.data}</span>
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ol>
      <Card accent="signal" title={t('staffWorkflow.legalTitle')}>
        <p style={{ margin: 0, fontSize: 13 }}>{t('staffWorkflow.legalBody')}</p>
      </Card>
    </>
  )
}

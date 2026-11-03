import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { callApi, type RpcError } from '@/data/rpc'
import { formatDate } from '@/shared/format'
import { Amount, Button, Card, Chip, DataTable, EmptyState, KeyValue, KpiTiles, PageHeader, Skeleton, type Column } from '@/ui'
import { HrErrorBox, useStaffList, type StaffKycRow } from '../common/hr'

interface StaffPay {
  pay_basis: string
  monthly_salary: number | null
  daily_wage: number | null
  bank_masked: string | null
}

/**
 * Employees & KYC (`StaffKYC`): the one group staff list from api.staff_kyc() with KYC completeness. Aadhaar, PAN and
 * bank arrive masked from the server; salary is read only on request with the Payroll right (api.staff_pay, logged).
 */
export function EmployeesPage() {
  const { t } = useTranslation()
  const can = useCan()
  const { profile } = useAuth()
  const readOnly = profile?.view === 'all-readonly'
  const staff = useStaffList()
  const [picked, setPicked] = useState<string | null>(null)
  const list = staff.list
  const current = list.find((s) => s.person_id === picked) ?? null
  const complete = list.filter((s) => s.kyc_done >= s.kyc_needed).length
  const noDesignation = list.filter((s) => !s.designation).length
  const canAdd = !readOnly && can('hr.create')

  const columns: Column<StaffKycRow>[] = [
    { key: 'code', header: t('employees.col.id'), render: (s) => <span className="mono">{s.person_code ?? '—'}</span> },
    {
      key: 'name',
      header: t('employees.col.employee'),
      render: (s) => (
        <div>
          <div style={{ fontWeight: 600 }}>{s.name}</div>
          <div className="k">{s.designation ?? t('employees.noDesignation')}</div>
        </div>
      ),
    },
    {
      key: 'pay',
      header: t('employees.col.payGroup'),
      render: (s) => (s.pay_company_name ? `${s.pay_company_name} · ${t(`hrCommon.basis.${s.pay_basis ?? 'monthly'}`)}` : <span className="k">{t('employees.noPayGroup')}</span>),
    },
    { key: 'phone', header: t('employees.col.phone'), render: (s) => <span className="mono">{s.phone_masked ?? '—'}</span> },
    { key: 'collected', header: t('employees.col.collected'), align: 'right', render: (s) => t('employees.nOfM', { n: s.kyc_done, m: s.kyc_needed }) },
    {
      key: 'kyc',
      header: t('employees.col.kyc'),
      render: (s) =>
        s.kyc_done >= s.kyc_needed ? (
          <Chip tone="success" icon="check">
            {t('employees.kyc.complete')}
          </Chip>
        ) : s.kyc_done > 0 ? (
          <Chip tone="signal" icon="clock">
            {t('employees.kyc.started')}
          </Chip>
        ) : (
          <Chip tone="neutral">{t('employees.kyc.notStarted')}</Chip>
        ),
    },
    {
      key: 'open',
      header: <span className="sr-only">{t('employees.col.open')}</span>,
      render: (s) => (
        <Button size="sm" variant="link" onClick={() => setPicked(s.person_id)} aria-label={t('employees.openNamed', { name: s.name })}>
          {t('employees.open')}
        </Button>
      ),
    },
  ]

  return (
    <>
      <PageHeader
        title={t('employees.title')}
        subtitle={staff.isLoading ? undefined : t('employees.subtitle', { n: list.length, k: complete })}
        actions={
          canAdd ? (
            <Link to="/hr-and-payroll/employees-and-kyc/add-staff" className="sf-btn" data-variant="primary">
              {t('employees.add')}
            </Link>
          ) : null
        }
      />
      <KpiTiles
        ariaLabel={t('employees.kpis')}
        items={[
          { key: 'people', label: t('employees.kpi.people'), value: staff.isLoading ? <Skeleton width={60} /> : list.length },
          { key: 'complete', label: t('employees.kpi.complete'), value: complete },
          { key: 'designation', label: t('employees.kpi.noDesignation'), value: noDesignation, sub: t('employees.kpi.noDesignationSub') },
          { key: 'login', label: t('employees.kpi.login'), value: list.filter((s) => s.has_login).length },
        ]}
      />
      <Card pad={false}>
        {staff.error ? (
          <div className="sf-card__pad">
            <HrErrorBox error={staff.error} />
          </div>
        ) : (
          <DataTable
            caption={t('employees.tableCaption')}
            columns={columns}
            rows={list}
            rowKey={(s) => s.person_id}
            loading={staff.isLoading}
            empty={
              <EmptyState
                title={t('employees.emptyTitle')}
                body={t('employees.emptyBody')}
                action={
                  canAdd ? (
                    <Link to="/hr-and-payroll/employees-and-kyc/add-staff" style={{ fontWeight: 600, fontSize: 13 }}>
                      {t('employees.add')}
                    </Link>
                  ) : undefined
                }
              />
            }
          />
        )}
      </Card>
      {current ? <StaffDetail key={current.person_id} s={current} canEdit={!readOnly && can('hr.edit')} canPay={can('payroll.run')} onClose={() => setPicked(null)} /> : null}
    </>
  )
}

function StaffDetail({ s, canEdit, canPay, onClose }: { s: StaffKycRow; canEdit: boolean; canPay: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const [pay, setPay] = useState<StaffPay | null>(null)
  const [payErr, setPayErr] = useState<RpcError | null>(null)
  const [busy, setBusy] = useState(false)

  async function showPay() {
    setBusy(true)
    setPayErr(null)
    try {
      setPay(await callApi<StaffPay>('staff_pay', { p_person_id: s.person_id }, { idempotent: false }))
    } catch (e) {
      setPayErr(e as RpcError)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title={t('employees.detailTitle', { name: s.name })}
      action={
        <div style={{ display: 'flex', gap: 8 }}>
          {canEdit ? (
            <Link to={`/hr-and-payroll/employees-and-kyc/add-staff?person=${s.person_id}`} className="sf-btn" data-variant="secondary" data-size="sm">
              {t('employees.edit')}
            </Link>
          ) : null}
          <Button size="sm" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 24 }}>
        <div>
          <h3 className="sf-card__title" style={{ fontSize: 14 }}>
            {t('employees.personal')}
          </h3>
          <KeyValue
            rows={[
              { label: t('employees.f.id'), value: <span className="mono">{s.person_code ?? '—'}</span> },
              { label: t('employees.f.phone'), value: <span className="mono">{s.phone_masked ?? t('employees.missing')}</span> },
              { label: t('employees.f.dob'), value: s.dob ? formatDate(s.dob) : t('employees.missing') },
              { label: t('employees.f.language'), value: t(`hrCommon.languages.${s.language ?? 'en'}`) },
              { label: t('employees.f.login'), value: s.has_login ? t('common.yes') : t('common.no') },
            ]}
          />
        </div>
        <div>
          <h3 className="sf-card__title" style={{ fontSize: 14 }}>
            {t('employees.identity')}
          </h3>
          <KeyValue
            rows={[
              { label: t('employees.f.aadhaar'), value: <span className="mono">{s.aadhaar_masked ?? t('employees.missing')}</span> },
              { label: t('employees.f.pan'), value: <span className="mono">{s.pan_masked ?? t('employees.missing')}</span> },
              { label: t('employees.f.bank'), value: <span className="mono">{s.bank_masked ?? t('employees.missing')}</span> },
              { label: t('employees.f.joined'), value: s.join_date ? formatDate(s.join_date) : '—' },
              { label: t('employees.f.department'), value: s.department_name ?? '—' },
            ]}
          />
          <p className="k" style={{ marginTop: 8 }}>
            {t('employees.privacy')}
          </p>
        </div>
        <div>
          <h3 className="sf-card__title" style={{ fontSize: 14 }}>
            {t('employees.salary')}
          </h3>
          {!canPay ? (
            <p className="k">{t('employees.salaryNoRight')}</p>
          ) : pay ? (
            <KeyValue
              rows={[
                { label: t('employees.f.basis'), value: t(`hrCommon.basis.${pay.pay_basis}`) },
                { label: pay.pay_basis === 'daily' ? t('employees.f.dailyWage') : t('employees.f.monthlySalary'), value: <Amount value={pay.pay_basis === 'daily' ? pay.daily_wage : pay.monthly_salary} rupee /> },
              ]}
            />
          ) : (
            <>
              <p className="k">{t('employees.salaryHidden')}</p>
              <Button size="sm" busy={busy} onClick={() => void showPay()}>
                {t('employees.showSalary')}
              </Button>
            </>
          )}
          <HrErrorBox error={payErr} />
        </div>
      </div>
    </Card>
  )
}

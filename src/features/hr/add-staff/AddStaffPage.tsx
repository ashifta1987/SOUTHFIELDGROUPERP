import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { cleanAmount, useReadRpc } from '@/features/accounts/cash-book/money'
import { formatIndian } from '@/shared/format'
import { Button, Card, Chip, DataTable, EmptyState, Field, FieldGrid, PageHeader, SelectField, Skeleton, type Column } from '@/ui'
import { HrErrorBox, LANGUAGES, useStaffList, type StaffKycRow } from '../common/hr'

interface Saved {
  person_id: string
  person_code: string
}

interface Form {
  name: string
  phone: string
  language: string
  join_date: string
  dob: string
  aadhaar: string
  pan: string
  bank_last4: string
  designation: string
  department_id: string
  pay_company_id: string
  pay_basis: 'monthly' | 'daily'
  salary: string
}

const EMPTY: Form = {
  name: '',
  phone: '',
  language: 'en',
  join_date: '',
  dob: '',
  aadhaar: '',
  pan: '',
  bank_last4: '',
  designation: '',
  department_id: '',
  pay_company_id: '',
  pay_basis: 'monthly',
  salary: '',
}

/**
 * Add staff (`AddStaff`): everyone joins Southfield Group once, with a designation and the company that issues the
 * payslip. One call (api.save_staff) creates the person and the staff record together; the app gives the staff ID.
 * Salary is sent only by a user with the Payroll right. `?person=` edits an existing person.
 */
export function AddStaffPage() {
  const { t } = useTranslation()
  const [params] = useSearchParams()
  const editId = params.get('person')
  const staff = useStaffList()
  const editing = editId ? staff.list.find((s) => s.person_id === editId) : undefined
  if (editId && staff.isLoading) {
    return (
      <Card>
        <Skeleton height={80} />
      </Card>
    )
  }
  if (editId && !editing) {
    return (
      <Card>
        <EmptyState title={t('addStaff.notFound')} />
      </Card>
    )
  }
  return <StaffForm key={editing?.person_id ?? 'new'} editing={editing} staffList={staff.list} staffLoading={staff.isLoading} />
}

function StaffForm({ editing, staffList, staffLoading }: { editing: StaffKycRow | undefined; staffList: StaffKycRow[]; staffLoading: boolean }) {
  const { t } = useTranslation()
  const can = useCan()
  const { profile } = useAuth()
  const navigate = useNavigate()
  const editId = editing?.person_id ?? null
  const readOnly = profile?.view === 'all-readonly'
  const companies = useApiView('companies', { order: 'code' })
  const departments = useApiView('departments', { order: 'name' })
  const [form, setForm] = useState<Form>(() =>
    editing
      ? {
          ...EMPTY,
          name: editing.name,
          language: editing.language ?? 'en',
          join_date: editing.join_date ?? '',
          dob: editing.dob ?? '',
          designation: editing.designation ?? '',
          department_id: editing.department_id ?? '',
          pay_company_id: editing.pay_company_id ?? '',
          pay_basis: editing.pay_basis === 'daily' ? 'daily' : 'monthly',
        }
      : EMPTY,
  )
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({})
  const [saved, setSaved] = useState<Saved | null>(null)
  const m = useApiMutation<{ p: Record<string, unknown> }, Saved>('save_staff', [['api', 'staff_kyc'], ['api', 'staff']])
  const canPay = can('payroll.run')
  // Salary on record (Payroll right only; the server logs each view).
  const pay = useReadRpc<{ pay_basis: string; monthly_salary: number | null; daily_wage: number | null } | null>('staff_pay', { p_person_id: editId }, Boolean(editId) && canPay)
  const paySaved = pay.data ? (pay.data.pay_basis === 'daily' ? pay.data.daily_wage : pay.data.monthly_salary) : null
  const canSave = !readOnly && (editId ? can('hr.edit') : can('hr.create'))
  const companyList = rowsOf(companies).filter((c) => c.status === 'active')
  const staff = { list: staffList, isLoading: staffLoading }

  const designations = (() => {
    const map = new Map<string, string[]>()
    for (const s of staff.list) {
      if (!s.designation) continue
      map.set(s.designation, [...(map.get(s.designation) ?? []), s.name])
    }
    return [...map.entries()].map(([designation, people]) => ({ designation, people })).sort((a, b) => a.designation.localeCompare(b.designation))
  })()
  const missing = staff.list.filter((s) => !s.designation)

  function set<K extends keyof Form>(k: K, v: Form[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function submit() {
    const e: typeof errors = {}
    if (form.name.trim().length < 2) e.name = t('addStaff.err.name')
    if (form.designation.trim().length < 2) e.designation = t('addStaff.err.designation')
    if (!form.pay_company_id) e.pay_company_id = t('addStaff.err.company')
    const salary = form.salary.trim() ? cleanAmount(form.salary) : null
    if (form.salary.trim() && salary === null) e.salary = t('addStaff.err.salary')
    setErrors(e)
    if (Object.keys(e).length) return
    setSaved(null)
    const p: Record<string, unknown> = {
      person_id: editId || null,
      name: form.name.trim(),
      phone: form.phone.trim() || null,
      language: form.language,
      join_date: form.join_date || null,
      dob: form.dob || null,
      aadhaar: form.aadhaar.trim() || null,
      pan: form.pan.trim() || null,
      bank_last4: form.bank_last4.trim() || null,
      designation: form.designation.trim(),
      department_id: form.department_id || null,
      pay_company_id: form.pay_company_id,
      pay_basis: form.pay_basis,
    }
    if (canPay && salary !== null) p[form.pay_basis === 'daily' ? 'daily_wage' : 'monthly_salary'] = salary
    m.mutate(
      { p },
      {
        onSuccess: (res) => {
          setSaved(res)
          if (!editId) {
            setForm({ ...EMPTY, pay_company_id: form.pay_company_id })
          } else {
            setForm((f) => ({ ...f, aadhaar: '', pan: '', bank_last4: '', phone: '', salary: '' }))
          }
        },
      },
    )
  }

  const columns: Column<{ designation: string; people: string[] }>[] = [
    { key: 'd', header: t('addStaff.col.designation'), render: (r) => <strong>{r.designation}</strong> },
    { key: 'p', header: t('addStaff.col.people'), render: (r) => r.people.join(', ') },
  ]

  return (
    <>
      <div>
        <Link to="/hr-and-payroll/employees-and-kyc" style={{ fontSize: 13, fontWeight: 600 }}>
          ← {t('addStaff.back')}
        </Link>
      </div>
      <PageHeader
        title={editId ? t('addStaff.editTitle', { name: editing?.name ?? '' }) : t('addStaff.title')}
        subtitle={t('addStaff.subtitle')}
        actions={
          <>
            <Button onClick={() => navigate('/hr-and-payroll/employees-and-kyc')}>{t('common.cancel')}</Button>
            {canSave ? (
              <Button variant="primary" busy={m.isPending} onClick={submit}>
                {t('addStaff.save')}
              </Button>
            ) : null}
          </>
        }
      />
      {!canSave ? (
        <Card>
          <p className="k">{readOnly ? t('hrCommon.readOnly') : t('hrCommon.noRight')}</p>
        </Card>
      ) : null}
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 380px', gap: 16, alignItems: 'start' }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Card title={t('addStaff.person')}>
              <FieldGrid cols={2}>
                <Field label={t('addStaff.f.name')} value={form.name} onChange={(e) => set('name', e.target.value)} error={errors.name} autoComplete="off" />
                <Field label={t('addStaff.f.id')} value={editing?.person_code ?? ''} readOnly placeholder={t('addStaff.f.idAuto')} help={t('addStaff.f.idHelp')} />
                <Field label={t('addStaff.f.phone')} inputMode="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} help={editing?.phone_masked ? t('addStaff.f.current', { v: editing.phone_masked }) : t('addStaff.f.phoneHelp')} />
                <SelectField label={t('addStaff.f.language')} value={form.language} onChange={(e) => set('language', e.target.value)} options={LANGUAGES.map((l) => ({ value: l, label: t(`hrCommon.languages.${l}`) }))} />
                <Field type="date" label={t('addStaff.f.joined')} value={form.join_date} onChange={(e) => set('join_date', e.target.value)} />
                <Field type="date" label={t('addStaff.f.dob')} value={form.dob} onChange={(e) => set('dob', e.target.value)} />
              </FieldGrid>
            </Card>
            <Card title={t('addStaff.identity')}>
              <FieldGrid cols={3}>
                <Field label={t('addStaff.f.aadhaar')} inputMode="numeric" autoComplete="off" value={form.aadhaar} onChange={(e) => set('aadhaar', e.target.value)} help={editing?.aadhaar_masked ? t('addStaff.f.current', { v: editing.aadhaar_masked }) : t('addStaff.f.aadhaarHelp')} />
                <Field label={t('addStaff.f.pan')} autoComplete="off" value={form.pan} onChange={(e) => set('pan', e.target.value.toUpperCase())} help={editing?.pan_masked ? t('addStaff.f.current', { v: editing.pan_masked }) : undefined} />
                <Field label={t('addStaff.f.bank')} inputMode="numeric" autoComplete="off" maxLength={4} value={form.bank_last4} onChange={(e) => set('bank_last4', e.target.value)} help={editing?.bank_masked ? t('addStaff.f.current', { v: editing.bank_masked }) : t('addStaff.f.bankHelp')} />
              </FieldGrid>
            </Card>
            <Card title={t('addStaff.job')}>
              <FieldGrid cols={2}>
                <Field label={t('addStaff.f.designation')} list="sf-designations" value={form.designation} onChange={(e) => set('designation', e.target.value)} error={errors.designation} autoComplete="off" />
                <SelectField
                  label={t('addStaff.f.department')}
                  value={form.department_id}
                  onChange={(e) => set('department_id', e.target.value)}
                  placeholder={t('addStaff.f.none')}
                  options={rowsOf(departments)
                    .filter((d) => d.status === 'active' && (!d.company_id || d.company_id === form.pay_company_id))
                    .map((d) => ({ value: d.id, label: d.name }))}
                />
                <SelectField
                  label={t('addStaff.f.company')}
                  value={form.pay_company_id}
                  onChange={(e) => set('pay_company_id', e.target.value)}
                  placeholder={t('addStaff.f.choose')}
                  error={errors.pay_company_id}
                  options={companyList.map((c) => ({ value: c.id, label: c.short_name || c.name }))}
                />
                <SelectField
                  label={t('addStaff.f.basis')}
                  value={form.pay_basis}
                  onChange={(e) => set('pay_basis', e.target.value === 'daily' ? 'daily' : 'monthly')}
                  options={[
                    { value: 'monthly', label: t('hrCommon.basis.monthly') },
                    { value: 'daily', label: t('hrCommon.basis.daily') },
                  ]}
                />
                {canPay ? (
                  <Field
                    label={form.pay_basis === 'daily' ? t('addStaff.f.dailyWage') : t('addStaff.f.monthlySalary')}
                    prefix="₹"
                    inputMode="decimal"
                    value={form.salary}
                    onChange={(e) => set('salary', e.target.value)}
                    error={errors.salary}
                    help={paySaved !== null ? t('addStaff.f.salaryOnRecord', { v: formatIndian(String(paySaved)) }) : undefined}
                  />
                ) : (
                  <p className="k" style={{ alignSelf: 'end' }}>
                    {t('addStaff.f.salaryNoRight')}
                  </p>
                )}
              </FieldGrid>
              <datalist id="sf-designations">
                {designations.map((d) => (
                  <option key={d.designation} value={d.designation} />
                ))}
              </datalist>
              <p className="k" style={{ marginTop: 12 }}>
                {t('addStaff.allowancesNote')}{' '}
                <Link to="/hr-and-payroll/allowances-and-benefits">{t('addStaff.allowancesLink')}</Link>
              </p>
            </Card>
            <HrErrorBox error={m.error as RpcError | null} />
            {saved ? (
              <div role="status" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Chip tone="success" icon="check">
                  {t('addStaff.saved', { code: saved.person_code })}
                </Chip>
                <Link to="/hr-and-payroll/employees-and-kyc" style={{ fontWeight: 600, fontSize: 13 }}>
                  {t('addStaff.toList')}
                </Link>
              </div>
            ) : null}
            {canSave ? (
              <div>
                <Button type="submit" variant="primary" busy={m.isPending}>
                  {t('addStaff.save')}
                </Button>
              </div>
            ) : null}
          </div>
          <Card pad={false} title={t('addStaff.inUse')}>
            <DataTable caption={t('addStaff.inUse')} columns={columns} rows={designations} rowKey={(r) => r.designation} loading={staff.isLoading} empty={<p className="k sf-card__pad">{t('addStaff.inUseEmpty')}</p>} />
            <p className="k sf-card__pad" style={{ margin: 0 }}>
              {missing.length ? t('addStaff.missing', { n: missing.length, names: missing.slice(0, 8).map((s) => s.name).join(', ') }) : t('addStaff.allSet')}
            </p>
          </Card>
        </form>
    </>
  )
}

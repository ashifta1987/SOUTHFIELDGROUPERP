import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { formatDate, formatIndian } from '@/shared/format'
import { Button, Card, Chip, EmptyState, Field, PageHeader, SelectField, Skeleton } from '@/ui'
import { ATTENDANCE_CODES, daysInMonth, HrErrorBox, monthEnd, MonthField, monthLabel, monthStart, ReadError, staffOfCompany, useSettingValue, useStaffList, useViewRange, weekday, type StaffKycRow } from '../common/hr'

type Att = ViewRow<'attendance'>
interface Entry {
  status: string
  hours: string
  ot: string
}

/**
 * Attendance (`Attendance`): mark one day for a company's staff (status, hours, overtime hours) through
 * api.mark_attendance, and see the month as a grid. Overtime pay is worked out in payroll by the server at the
 * multiplier set in Settings; an approved month is locked by the server.
 */
export function AttendancePage() {
  const { t } = useTranslation()
  const can = useCan()
  const { profile } = useAuth()
  const readOnly = profile?.view === 'all-readonly'
  const { list, companyId, choose, isLoading } = useCompanyChoice()
  const staff = useStaffList()
  const [date, setDate] = useState(todayIst())
  const [month, setMonth] = useState(monthStart(todayIst()))
  const day = useApiView('attendance', { eq: { company_id: companyId, work_date: date }, enabled: Boolean(companyId) })
  const grid = useViewRange('attendance', 'work_date', month, monthEnd(month), { company_id: companyId }, Boolean(companyId))
  const ot = useSettingValue('payroll.ot_multiplier', companyId)
  const people = staffOfCompany(staff.list, companyId)
  const canMark = !readOnly && can('hr.create')

  return (
    <>
      <PageHeader
        title={t('attendance.title', { month: monthLabel(month) })}
        subtitle={t('attendance.subtitle', { days: daysInMonth(month), ot: ot ?? t('attendance.otNotSet') })}
        actions={
          <Link to={`/hr-and-payroll/payroll?company=${companyId ?? ''}`} className="sf-btn" data-variant="secondary">
            {t('attendance.toPayroll')}
          </Link>
        }
      />
      <CompanyPicker list={list} value={companyId} onChange={choose} />
      {isLoading || staff.isLoading ? (
        <Card>
          <Skeleton height={80} />
        </Card>
      ) : !companyId ? (
        <Card>
          <EmptyState title={t('attendance.noCompany')} />
        </Card>
      ) : (
        <>
          <Card title={t('attendance.dayTitle')}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
              <Field type="date" label={t('attendance.date')} value={date} max={todayIst()} onChange={(e) => e.target.value && setDate(e.target.value)} />
              <p className="k" style={{ margin: 0 }}>
                {t('attendance.dayHelp')}
              </p>
            </div>
            {staff.error ? (
              <HrErrorBox error={staff.error} />
            ) : people.length === 0 ? (
              <EmptyState
                title={t('attendance.noStaffTitle')}
                body={t('attendance.noStaffBody')}
                action={
                  <Link to="/hr-and-payroll/employees-and-kyc/add-staff" style={{ fontWeight: 600, fontSize: 13 }}>
                    {t('attendance.addStaff')}
                  </Link>
                }
              />
            ) : day.isLoading ? (
              <Skeleton height={80} />
            ) : (
              <DayForm key={`${companyId}-${date}`} companyId={companyId} date={date} people={people} marked={rowsOf(day)} canMark={canMark} />
            )}
          </Card>
          <MonthGrid month={month} setMonth={setMonth} rows={grid.data ?? []} loading={grid.isLoading} error={grid.error} people={people} />
        </>
      )}
    </>
  )
}

function DayForm({ companyId, date, people, marked, canMark }: { companyId: string; date: string; people: StaffKycRow[]; marked: Att[]; canMark: boolean }) {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<Record<string, Entry>>(() => {
    const init: Record<string, Entry> = {}
    for (const p of people) {
      const a = marked.find((m) => m.person_id === p.person_id)
      init[p.person_id] = { status: a?.status ?? '', hours: a?.hours != null ? String(a.hours) : '', ot: a && Number(a.ot_hours) ? String(a.ot_hours) : '' }
    }
    return init
  })
  const [done, setDone] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const m = useApiMutation<{ p_company_id: string; p_date: string; p_entries: unknown[] }, { marked: number }>('mark_attendance', [['api', 'attendance']])

  function set(id: string, patch: Partial<Entry>) {
    setEntries((e) => ({ ...e, [id]: { ...(e[id] ?? { status: '', hours: '', ot: '' }), ...patch } }))
  }

  function allPresent() {
    setEntries((e) => {
      const next = { ...e }
      for (const p of people) if (!next[p.person_id]?.status) next[p.person_id] = { status: 'P', hours: next[p.person_id]?.hours ?? '', ot: next[p.person_id]?.ot ?? '' }
      return next
    })
  }

  function save() {
    const list = people
      .map((p) => ({ p, e: entries[p.person_id] }))
      .filter((x): x is { p: StaffKycRow; e: Entry } => Boolean(x.e?.status))
    const bad = list.find((x) => (x.e.hours && !/^\d{1,2}(\.\d{1,2})?$/.test(x.e.hours)) || (x.e.ot && !/^\d{1,2}(\.\d{1,2})?$/.test(x.e.ot)))
    if (bad) return setErr(t('attendance.errHours', { name: bad.p.name }))
    if (!list.length) return setErr(t('attendance.errNone'))
    setErr(null)
    setDone(null)
    m.mutate(
      {
        p_company_id: companyId,
        p_date: date,
        p_entries: list.map((x) => ({ person_id: x.p.person_id, status: x.e.status, hours: x.e.hours || null, ot_hours: x.e.ot || 0 })),
      },
      { onSuccess: (r) => setDone(r.marked) },
    )
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <div className="sf-table-wrap" role="region" aria-label={t('attendance.dayCaption', { date: formatDate(date) })} tabIndex={0}>
        <table className="sf-table" style={{ minWidth: 720 }}>
          <caption className="sr-only">{t('attendance.dayCaption', { date: formatDate(date) })}</caption>
          <thead>
            <tr>
              <th scope="col">{t('attendance.col.staff')}</th>
              <th scope="col">{t('attendance.col.status')}</th>
              <th scope="col" className="r">
                {t('attendance.col.hours')}
              </th>
              <th scope="col" className="r">
                {t('attendance.col.ot')}
              </th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => {
              const e = entries[p.person_id] ?? { status: '', hours: '', ot: '' }
              return (
                <tr key={p.person_id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{p.name}</div>
                    <div className="k mono">{p.person_code}</div>
                  </td>
                  <td style={{ minWidth: 180 }}>
                    <SelectField
                      label={<span className="sr-only">{t('attendance.statusFor', { name: p.name })}</span>}
                      aria-label={t('attendance.statusFor', { name: p.name })}
                      value={e.status}
                      disabled={!canMark}
                      onChange={(ev) => set(p.person_id, { status: ev.target.value })}
                      placeholder={t('attendance.notMarked')}
                      options={ATTENDANCE_CODES.map((c) => ({ value: c, label: t(`hrCommon.codes.${c}`) }))}
                    />
                  </td>
                  <td style={{ width: 130 }}>
                    <Field
                      label={<span className="sr-only">{t('attendance.hoursFor', { name: p.name })}</span>}
                      aria-label={t('attendance.hoursFor', { name: p.name })}
                      inputMode="decimal"
                      value={e.hours}
                      disabled={!canMark}
                      onChange={(ev) => set(p.person_id, { hours: ev.target.value })}
                    />
                  </td>
                  <td style={{ width: 130 }}>
                    <Field
                      label={<span className="sr-only">{t('attendance.otFor', { name: p.name })}</span>}
                      aria-label={t('attendance.otFor', { name: p.name })}
                      inputMode="decimal"
                      value={e.ot}
                      disabled={!canMark}
                      onChange={(ev) => set(p.person_id, { ot: ev.target.value })}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {canMark ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
          <Button onClick={allPresent}>{t('attendance.allPresent')}</Button>
          <Button type="submit" variant="primary" busy={m.isPending}>
            {t('attendance.save')}
          </Button>
          {done !== null ? (
            <span role="status">
              <Chip tone="success" icon="check">
                {t('attendance.saved', { n: done, date: formatDate(date) })}
              </Chip>
            </span>
          ) : null}
        </div>
      ) : (
        <p className="k">{t('hrCommon.noRight')}</p>
      )}
      {err ? (
        <div className="sf-alert" data-tone="danger" role="alert" style={{ marginTop: 8 }}>
          {err}
        </div>
      ) : null}
      <div style={{ marginTop: 8 }}>
        <HrErrorBox error={m.error as RpcError | null} />
      </div>
    </form>
  )
}

function MonthGrid({ month, setMonth, rows, loading, error, people }: { month: string; setMonth: (m: string) => void; rows: Att[]; loading: boolean; error: Error | null; people: StaffKycRow[] }) {
  const { t } = useTranslation()
  const n = daysInMonth(month)
  const days = Array.from({ length: n }, (_, i) => `${month.slice(0, 8)}${String(i + 1).padStart(2, '0')}`)
  const byPerson = (() => {
    const map = new Map<string, { name: string; code: string | null; cells: Map<string, Att> }>()
    for (const p of people) map.set(p.person_id, { name: p.name, code: p.person_code, cells: new Map() })
    for (const r of rows) {
      const e = map.get(r.person_id) ?? { name: r.person_name, code: null, cells: new Map<string, Att>() }
      e.cells.set(r.work_date, r)
      map.set(r.person_id, e)
    }
    return [...map.entries()]
  })()
  const caption = t('attendance.gridCaption', { month: monthLabel(month) })

  return (
    <TableCard
      title={t('attendance.gridTitle', { month: monthLabel(month) })}
      action={
        <div style={{ width: 200 }}>
          <MonthField value={month} onChange={setMonth} max={todayIst()} />
        </div>
      }
    >
      {error ? (
        <div className="sf-card__pad">
          <ReadError error={error} />
        </div>
      ) : loading ? (
        <div className="sf-card__pad">
          <Skeleton height={60} />
        </div>
      ) : byPerson.length === 0 ? (
        <div className="sf-card__pad">
          <EmptyState title={t('attendance.gridEmpty')} />
        </div>
      ) : (
        <div className="sf-table-wrap" role="region" aria-label={caption} tabIndex={0}>
          <table className="sf-table" style={{ minWidth: 1200, fontSize: 12 }}>
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr>
                <th scope="col">{t('attendance.col.worker')}</th>
                {days.map((d) => (
                  <th key={d} scope="col" className="r" style={{ padding: '6px 4px', background: weekday(d) === 'Sun' ? 'var(--sf-neutral-tint)' : undefined }}>
                    <abbr title={formatDate(d)} style={{ textDecoration: 'none' }}>
                      {Number(d.slice(8))}
                      <br />
                      <span className="k">{weekday(d).slice(0, 1)}</span>
                    </abbr>
                  </th>
                ))}
                <th scope="col" className="r">
                  {t('attendance.col.present')}
                </th>
                <th scope="col" className="r">
                  {t('attendance.col.leave')}
                </th>
                <th scope="col" className="r">
                  {t('attendance.col.otTotal')}
                </th>
              </tr>
            </thead>
            <tbody>
              {byPerson.map(([id, p]) => {
                const cells = [...p.cells.values()]
                const present = cells.filter((c) => c.status === 'P').length
                const half = cells.filter((c) => c.status === 'H').length
                const leave = cells.filter((c) => c.status === 'L').length
                const otHours = cells.reduce((s, c) => s + Math.round(Number(c.ot_hours) * 100), 0)
                return (
                  <tr key={id}>
                    <th scope="row" style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {p.name}
                    </th>
                    {days.map((d) => {
                      const c = p.cells.get(d)
                      return (
                        <td key={d} className="r mono" style={{ padding: '6px 4px', background: weekday(d) === 'Sun' ? 'var(--sf-neutral-tint)' : undefined, fontWeight: c && Number(c.ot_hours) > 0 ? 700 : undefined }}>
                          {c ? (
                            <abbr title={`${t(`hrCommon.codes.${c.status}`)}${Number(c.ot_hours) > 0 ? ` · ${t('attendance.otShort', { h: formatIndian(c.ot_hours, 1) })}` : ''}`} style={{ textDecoration: 'none' }}>
                              {c.status}
                              {Number(c.ot_hours) > 0 ? '+' : ''}
                            </abbr>
                          ) : (
                            '—'
                          )}
                        </td>
                      )
                    })}
                    <td className="r mono">{half ? t('attendance.presentHalf', { p: present, h: half }) : present}</td>
                    <td className="r mono">{leave}</td>
                    <td className="r mono">{formatIndian(String(otHours / 100), 1)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="k sf-card__pad" style={{ margin: 0 }}>
        {t('attendance.gridNote')}
      </p>
    </TableCard>
  )
}

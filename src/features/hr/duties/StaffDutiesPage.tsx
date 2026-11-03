import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { addDays } from '@/features/accounts/cash-book/money'
import { todayIst } from '@/features/admin/branches/company'
import { formatDate } from '@/shared/format'
import { Button, Card, Chip, EmptyState, Field, PageHeader, SelectField, Skeleton } from '@/ui'
import { HrErrorBox, useStaffList, type StaffKycRow } from '../common/hr'

type Duty = ViewRow<'duties'>
interface Line {
  company_id: string
  place_id: string
  duty: string
  shift: string
}

const SHIFTS = ['day', 'night', 'general'] as const

/**
 * Staff duties (`StaffDuties`): who works where, for which company, on which job, on one day. Saved through
 * api.set_duties (one duty per person per day). Anyone can work for either company; the day's duty decides which
 * company the day belongs to.
 */
export function StaffDutiesPage() {
  const { t } = useTranslation()
  const can = useCan()
  const { profile } = useAuth()
  const readOnly = profile?.view === 'all-readonly'
  const [date, setDate] = useState(todayIst())
  const staff = useStaffList()
  const duties = useApiView('duties', { eq: { duty_date: date } })
  const yesterday = useApiView('duties', { eq: { duty_date: addDays(date, -1) } })
  const att = useApiView('attendance', { eq: { work_date: date } })
  const companies = useApiView('companies', { order: 'code' })
  const places = useApiView('places', { order: 'name' })
  const people = staff.list.filter((s) => s.has_profile && s.active)
  const [copyFrom, setCopyFrom] = useState<Duty[] | null>(null)
  const canEdit = !readOnly && can('hr.create')
  const ready = !staff.isLoading && !duties.isLoading

  return (
    <>
      <PageHeader title={t('duties.title')} subtitle={t('duties.subtitle')} />
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field
          type="date"
          label={t('duties.day')}
          value={date}
          onChange={(e) => {
            if (e.target.value) {
              setDate(e.target.value)
              setCopyFrom(null)
            }
          }}
        />
        {canEdit ? (
          <Button onClick={() => setCopyFrom(rowsOf(yesterday))} disabled={rowsOf(yesterday).length === 0}>
            {t('duties.copyYesterday')}
          </Button>
        ) : null}
        <Link to="/hr-and-payroll/staff-rotation" style={{ fontWeight: 600, fontSize: 13, alignSelf: 'center' }}>
          {t('duties.toRotation')}
        </Link>
      </div>
      {!ready ? (
        <Card>
          <Skeleton height={80} />
        </Card>
      ) : staff.error ? (
        <Card>
          <HrErrorBox error={staff.error} />
        </Card>
      ) : people.length === 0 ? (
        <Card>
          <EmptyState title={t('duties.noStaffTitle')} body={t('duties.noStaffBody')} />
        </Card>
      ) : (
        <DutyForm
          key={`${date}-${copyFrom ? 'copy' : 'own'}`}
          date={date}
          people={people}
          existing={copyFrom ?? rowsOf(duties)}
          attendance={rowsOf(att)}
          companies={rowsOf(companies).filter((c) => c.status === 'active')}
          places={rowsOf(places).filter((p) => p.status === 'active')}
          canEdit={canEdit}
          copied={Boolean(copyFrom)}
        />
      )}
    </>
  )
}

function DutyForm({
  date,
  people,
  existing,
  attendance,
  companies,
  places,
  canEdit,
  copied,
}: {
  date: string
  people: StaffKycRow[]
  existing: Duty[]
  attendance: ViewRow<'attendance'>[]
  companies: ViewRow<'companies'>[]
  places: ViewRow<'places'>[]
  canEdit: boolean
  copied: boolean
}) {
  const { t } = useTranslation()
  const [lines, setLines] = useState<Record<string, Line>>(() => {
    const init: Record<string, Line> = {}
    for (const p of people) {
      const d = existing.find((x) => x.person_id === p.person_id)
      init[p.person_id] = { company_id: d?.company_id ?? p.pay_company_id ?? '', place_id: d?.place_id ?? '', duty: d?.duty ?? '', shift: d?.shift ?? 'day' }
    }
    return init
  })
  const [saved, setSaved] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const m = useApiMutation<{ p_date: string; p_entries: unknown[] }, { saved: number }>('set_duties', [['api', 'duties']])
  const dutyNames = [...new Set(existing.map((d) => d.duty))].sort()
  const byCompany = (() => {
    const map = new Map<string, number>()
    for (const l of Object.values(lines)) if (l.duty.trim() && l.company_id) map.set(l.company_id, (map.get(l.company_id) ?? 0) + 1)
    return map
  })()

  function set(id: string, patch: Partial<Line>) {
    setLines((ls) => ({ ...ls, [id]: { ...(ls[id] ?? { company_id: '', place_id: '', duty: '', shift: 'day' }), ...patch } }))
  }

  function save() {
    const entries = people
      .map((p) => ({ p, l: lines[p.person_id] }))
      .filter((x): x is { p: StaffKycRow; l: Line } => Boolean(x.l?.duty.trim()))
    const bad = entries.find((x) => !x.l.company_id)
    if (bad) return setErr(t('duties.errCompany', { name: bad.p.name }))
    if (!entries.length) return setErr(t('duties.errNone'))
    setErr(null)
    setSaved(null)
    m.mutate(
      { p_date: date, p_entries: entries.map((x) => ({ person_id: x.p.person_id, company_id: x.l.company_id, place_id: x.l.place_id || null, duty: x.l.duty.trim(), shift: x.l.shift || null })) },
      { onSuccess: (r) => setSaved(r.saved) },
    )
  }

  const caption = t('duties.caption', { date: formatDate(date) })
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px', gap: 16, alignItems: 'start' }}>
      <Card pad={false}>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <div className="sf-table-wrap" role="region" aria-label={caption} tabIndex={0}>
            <table className="sf-table" style={{ minWidth: 900 }}>
              <caption className="sr-only">{caption}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('duties.col.staff')}</th>
                  <th scope="col">{t('duties.col.attendance')}</th>
                  <th scope="col">{t('duties.col.company')}</th>
                  <th scope="col">{t('duties.col.place')}</th>
                  <th scope="col">{t('duties.col.duty')}</th>
                  <th scope="col">{t('duties.col.shift')}</th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => {
                  const l = lines[p.person_id] ?? { company_id: '', place_id: '', duty: '', shift: 'day' }
                  const a = attendance.find((x) => x.person_id === p.person_id)
                  return (
                    <tr key={p.person_id}>
                      <th scope="row">
                        <div style={{ fontWeight: 600 }}>{p.name}</div>
                        <div className="k">{[p.person_code, p.designation].filter(Boolean).join(' · ')}</div>
                      </th>
                      <td>{a ? <Chip tone={a.status === 'P' ? 'success' : 'neutral'}>{t(`hrCommon.codes.${a.status}`)}</Chip> : <span className="k">{t('duties.notMarked')}</span>}</td>
                      <td style={{ minWidth: 170 }}>
                        <SelectField
                          label={<span className="sr-only">{t('duties.companyFor', { name: p.name })}</span>}
                          value={l.company_id}
                          disabled={!canEdit}
                          onChange={(e) => set(p.person_id, { company_id: e.target.value, place_id: '' })}
                          placeholder={t('duties.choose')}
                          options={companies.map((c) => ({ value: c.id, label: c.short_name || c.name }))}
                        />
                      </td>
                      <td style={{ minWidth: 170 }}>
                        <SelectField
                          label={<span className="sr-only">{t('duties.placeFor', { name: p.name })}</span>}
                          value={l.place_id}
                          disabled={!canEdit}
                          onChange={(e) => set(p.person_id, { place_id: e.target.value })}
                          placeholder={t('duties.anyPlace')}
                          options={places.filter((pl) => pl.company_id === l.company_id).map((pl) => ({ value: pl.id, label: `${pl.branch_name} · ${pl.name}` }))}
                        />
                      </td>
                      <td style={{ minWidth: 180 }}>
                        <Field label={<span className="sr-only">{t('duties.dutyFor', { name: p.name })}</span>} list="sf-duty-names" value={l.duty} disabled={!canEdit} onChange={(e) => set(p.person_id, { duty: e.target.value })} autoComplete="off" />
                      </td>
                      <td style={{ minWidth: 130 }}>
                        <SelectField
                          label={<span className="sr-only">{t('duties.shiftFor', { name: p.name })}</span>}
                          value={l.shift}
                          disabled={!canEdit}
                          onChange={(e) => set(p.person_id, { shift: e.target.value })}
                          options={SHIFTS.map((s) => ({ value: s, label: t(`duties.shift.${s}`) }))}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <datalist id="sf-duty-names">
            {dutyNames.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
          <div className="sf-card__pad" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {copied ? <p className="k" style={{ margin: 0 }}>{t('duties.copiedNote')}</p> : null}
            {canEdit ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Button type="submit" variant="primary" busy={m.isPending}>
                  {t('duties.save')}
                </Button>
                {saved !== null ? (
                  <span role="status">
                    <Chip tone="success" icon="check">
                      {t('duties.saved', { n: saved, date: formatDate(date) })}
                    </Chip>
                  </span>
                ) : null}
              </div>
            ) : (
              <p className="k" style={{ margin: 0 }}>
                {t('hrCommon.noRight')}
              </p>
            )}
            {err ? (
              <div className="sf-alert" data-tone="danger" role="alert">
                {err}
              </div>
            ) : null}
            <HrErrorBox error={m.error as RpcError | null} />
            <p className="k" style={{ margin: 0 }}>
              {t('duties.note')}
            </p>
          </div>
        </form>
      </Card>
      <Card title={t('duties.byCompanyTitle')}>
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
          {companies.map((c) => (
            <li key={c.id} style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>{c.short_name || c.name}</span>
              <strong className="mono">{t('duties.people', { count: byCompany.get(c.id) ?? 0 })}</strong>
            </li>
          ))}
        </ul>
        <p className="k" style={{ margin: '12px 0 0' }}>
          {t('duties.byCompanyNote')}
        </p>
      </Card>
    </div>
  )
}

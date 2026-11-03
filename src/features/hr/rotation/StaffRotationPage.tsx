import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { callApi, useApiMutation, type RpcError } from '@/data/rpc'
import { addDays } from '@/features/accounts/cash-book/money'
import { todayIst } from '@/features/admin/branches/company'
import { formatDate } from '@/shared/format'
import { Button, Card, Chip, EmptyState, Field, FieldGrid, FormDialog, PageHeader, SelectField, Skeleton } from '@/ui'
import { HrErrorBox, mondayOf, useStaffList, useViewRange, weekday, type StaffKycRow } from '../common/hr'

type Duty = ViewRow<'duties'>
const SHIFTS = ['day', 'night', 'general'] as const

/**
 * Staff rotation (`StaffRotation`): the week's duties for the one group staff list. Each slot names the company, the
 * place, the job and the shift (api.set_duties). Copying last week writes each day through the same RPC.
 */
export function StaffRotationPage() {
  const { t } = useTranslation()
  const can = useCan()
  const { profile } = useAuth()
  const qc = useQueryClient()
  const readOnly = profile?.view === 'all-readonly'
  const [week, setWeek] = useState(mondayOf(todayIst()))
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i))
  const staff = useStaffList()
  const duties = useViewRange('duties', 'duty_date', week, addDays(week, 6))
  const lastWeek = useViewRange('duties', 'duty_date', addDays(week, -7), addDays(week, -1))
  const companies = useApiView('companies', { order: 'code' })
  const places = useApiView('places', { order: 'name' })
  const people = staff.list.filter((s) => s.has_profile && s.active)
  const [slot, setSlot] = useState<{ p: StaffKycRow; date: string; d?: Duty } | null>(null)
  const [copying, setCopying] = useState(false)
  const [copyErr, setCopyErr] = useState<RpcError | null>(null)
  const [copied, setCopied] = useState<number | null>(null)
  const canEdit = !readOnly && can('hr.create')
  const rows = duties.data ?? []
  const prev = lastWeek.data ?? []
  const caption = t('rotation.caption', { from: formatDate(week), to: formatDate(addDays(week, 6)) })

  async function copyLastWeek() {
    setCopying(true)
    setCopyErr(null)
    setCopied(null)
    let n = 0
    try {
      for (let i = 0; i < 7; i++) {
        const src = prev.filter((d) => d.duty_date === addDays(week, i - 7))
        if (!src.length) continue
        const res = await callApi<{ saved: number }>('set_duties', {
          p_date: addDays(week, i),
          p_entries: src.map((d) => ({ person_id: d.person_id, company_id: d.company_id, place_id: d.place_id, duty: d.duty, shift: d.shift })),
        })
        n += res.saved
      }
      setCopied(n)
    } catch (e) {
      setCopyErr(e as RpcError)
    } finally {
      setCopying(false)
      await qc.invalidateQueries({ queryKey: ['api', 'duties'] })
    }
  }

  return (
    <>
      <PageHeader
        title={t('rotation.title')}
        subtitle={t('rotation.subtitle', { from: formatDate(week), to: formatDate(addDays(week, 6)) })}
        actions={
          canEdit ? (
            <Button busy={copying} disabled={prev.length === 0} onClick={() => void copyLastWeek()}>
              {t('rotation.copyLastWeek')}
            </Button>
          ) : null
        }
      />
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Button onClick={() => setWeek(addDays(week, -7))} aria-label={t('rotation.prevWeek')}>
          ‹
        </Button>
        <Field type="date" label={t('rotation.weekOf')} value={week} onChange={(e) => e.target.value && setWeek(mondayOf(e.target.value))} />
        <Button onClick={() => setWeek(addDays(week, 7))} aria-label={t('rotation.nextWeek')}>
          ›
        </Button>
        <Link to="/hr-and-payroll/staff-duties" style={{ fontWeight: 600, fontSize: 13, alignSelf: 'center' }}>
          {t('rotation.toDuties')}
        </Link>
      </div>
      <HrErrorBox error={copyErr} />
      {copied !== null ? (
        <div role="status">
          <Chip tone="success" icon="check">
            {t('rotation.copied', { n: copied })}
          </Chip>
        </div>
      ) : null}
      <Card pad={false}>
        <p className="k sf-card__pad" style={{ margin: 0 }}>
          {rows.length ? t('rotation.legend') : t('rotation.legendEmpty')}
        </p>
        {staff.isLoading || duties.isLoading ? (
          <div className="sf-card__pad">
            <Skeleton height={80} />
          </div>
        ) : people.length === 0 ? (
          <div className="sf-card__pad">
            <EmptyState title={t('rotation.noStaffTitle')} body={t('rotation.noStaffBody')} />
          </div>
        ) : (
          <div className="sf-table-wrap" role="region" aria-label={caption} tabIndex={0}>
            <table className="sf-table" style={{ minWidth: 1100 }}>
              <caption className="sr-only">{caption}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('rotation.col.staff')}</th>
                  <th scope="col">{t('rotation.col.pay')}</th>
                  {days.map((d) => (
                    <th key={d} scope="col">
                      {weekday(d)} {d.slice(8)}
                    </th>
                  ))}
                  <th scope="col" className="r">
                    {t('rotation.col.days')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => {
                  const mine = rows.filter((r) => r.person_id === p.person_id)
                  return (
                    <tr key={p.person_id}>
                      <th scope="row">
                        <div style={{ fontWeight: 600 }}>{p.name}</div>
                        <div className="k">{[p.person_code, p.designation].filter(Boolean).join(' · ')}</div>
                      </th>
                      <td>{p.pay_company_name ?? '—'}</td>
                      {days.map((d) => {
                        const duty = mine.find((r) => r.duty_date === d)
                        return (
                          <td key={d} style={{ minWidth: 110 }}>
                            {canEdit ? (
                              <Button
                                size="sm"
                                variant={duty ? 'secondary' : 'link'}
                                onClick={() => setSlot({ p, date: d, d: duty })}
                                aria-label={duty ? undefined : t('rotation.assignSlot', { name: p.name, day: formatDate(d) })}
                              >
                                {duty ? (
                                  <>
                                    <span className="sr-only">{t('rotation.changeSlot', { name: p.name, day: formatDate(d) })}: </span>
                                    <SlotText d={duty} />
                                  </>
                                ) : (
                                  '+'
                                )}
                              </Button>
                            ) : duty ? (
                              <SlotText d={duty} />
                            ) : (
                              <span className="k">—</span>
                            )}
                          </td>
                        )
                      })}
                      <td className="r mono">{mine.length}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {slot ? (
        <SlotDialog
          key={`${slot.p.person_id}-${slot.date}`}
          person={slot.p}
          date={slot.date}
          duty={slot.d}
          companies={rowsOf(companies).filter((c) => c.status === 'active')}
          places={rowsOf(places).filter((p) => p.status === 'active')}
          onClose={() => setSlot(null)}
        />
      ) : null}
    </>
  )
}

function SlotText({ d }: { d: Duty }) {
  const { t } = useTranslation()
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', fontSize: 12, lineHeight: 1.3 }}>
      <strong>{d.company_name}</strong>
      <span>{d.duty}</span>
      <span className="k">{[d.place_name, d.shift ? t(`rotation.shift.${d.shift}`) : null].filter(Boolean).join(' · ')}</span>
    </span>
  )
}

function SlotDialog({ person, date, duty, companies, places, onClose }: { person: StaffKycRow; date: string; duty?: Duty; companies: ViewRow<'companies'>[]; places: ViewRow<'places'>[]; onClose: () => void }) {
  const { t } = useTranslation()
  const [company, setCompany] = useState(duty?.company_id ?? person.pay_company_id ?? '')
  const [place, setPlace] = useState(duty?.place_id ?? '')
  const [job, setJob] = useState(duty?.duty ?? '')
  const [shift, setShift] = useState<string>(duty?.shift ?? 'day')
  const [errors, setErrors] = useState<{ company?: string; job?: string }>({})
  const m = useApiMutation<{ p_date: string; p_entries: unknown[] }>('set_duties', [['api', 'duties']])
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('rotation.dialogTitle', { name: person.name, day: `${weekday(date)} ${formatDate(date)}` })}
      submitLabel={t('rotation.saveSlot')}
      busy={m.isPending}
      error={<HrErrorBox error={m.error as RpcError | null} />}
      onSubmit={() => {
        const e: typeof errors = {}
        if (!company) e.company = t('rotation.errCompany')
        if (job.trim().length < 2) e.job = t('rotation.errJob')
        setErrors(e)
        if (Object.keys(e).length) return
        m.mutate({ p_date: date, p_entries: [{ person_id: person.person_id, company_id: company, place_id: place || null, duty: job.trim(), shift }] }, { onSuccess: onClose })
      }}
    >
      <FieldGrid cols={2}>
        <SelectField
          label={t('rotation.f.company')}
          value={company}
          onChange={(e) => {
            setCompany(e.target.value)
            setPlace('')
          }}
          placeholder={t('rotation.f.choose')}
          error={errors.company}
          options={companies.map((c) => ({ value: c.id, label: c.short_name || c.name }))}
        />
        <SelectField
          label={t('rotation.f.place')}
          value={place}
          onChange={(e) => setPlace(e.target.value)}
          placeholder={t('rotation.f.anyPlace')}
          options={places.filter((p) => p.company_id === company).map((p) => ({ value: p.id, label: `${p.branch_name} · ${p.name}` }))}
        />
        <Field label={t('rotation.f.duty')} value={job} onChange={(e) => setJob(e.target.value)} error={errors.job} />
        <SelectField label={t('rotation.f.shift')} value={shift} onChange={(e) => setShift(e.target.value)} options={SHIFTS.map((s) => ({ value: s, label: t(`rotation.shift.${s}`) }))} />
      </FieldGrid>
    </FormDialog>
  )
}

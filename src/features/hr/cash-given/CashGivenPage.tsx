import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { cleanAmount, CashLimitText, fromPaise, moneyAccountLabel, sumPaise, useMoneyAccounts } from '@/features/accounts/cash-book/money'
import { formatDate } from '@/shared/format'
import { Amount, Button, Card, Chip, DataTable, EmptyState, Field, KpiTiles, PageHeader, SelectField, Skeleton, TextAreaField, type Column } from '@/ui'
import { HrErrorBox, monthStart, staffLabel, staffOfCompany, useStaffList } from '../common/hr'

type Given = ViewRow<'cash_given'>
interface Posted {
  voucher_id: string
  doc_no: string
  warning: string | null
}

const PURPOSES = ['advance', 'food', 'fuel_travel', 'room_rent', 'other'] as const

/**
 * Cash given to staff (`CashGiven`): every rupee handed to a staff member, by staff ID and purpose. Paying posts a cash
 * payment voucher through api.give_staff_cash (the server applies the daily cash limit; over it, a reason Admin sees,
 * or pay by bank) and payroll recovers advances automatically.
 */
export function CashGivenPage() {
  const { t } = useTranslation()
  const can = useCan()
  const { profile } = useAuth()
  const readOnly = profile?.view === 'all-readonly'
  const { list, companyId, choose, isLoading } = useCompanyChoice()
  const q = useApiView('cash_given', { eq: { company_id: companyId }, order: 'given_on', ascending: false, limit: 1000, enabled: Boolean(companyId) })
  const rows = rowsOf(q)
  const thisMonth = monthStart(todayIst())
  const monthRows = rows.filter((r) => r.given_on >= thisMonth)
  const open = rows.filter((r) => !r.recovered)
  const canPay = !readOnly && can('cash_book.create')

  const byPerson = (() => {
    const map = new Map<string, { name: string; byPurpose: Map<string, number>; total: number }>()
    for (const r of rows) {
      const e = map.get(r.person_id) ?? { name: r.person_name, byPurpose: new Map<string, number>(), total: 0 }
      const paise = Math.round(Number(r.amount) * 100)
      e.byPurpose.set(r.purpose, (e.byPurpose.get(r.purpose) ?? 0) + paise)
      e.total += paise
      map.set(r.person_id, e)
    }
    return [...map.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.total - a.total)
  })()
  const purposes = [...new Set(rows.map((r) => r.purpose))].sort()

  const columns: Column<Given>[] = [
    { key: 'date', header: t('cashGiven.col.date'), render: (r) => <span className="mono">{formatDate(r.given_on)}</span> },
    { key: 'who', header: t('cashGiven.col.staff'), render: (r) => <strong>{r.person_name}</strong> },
    { key: 'purpose', header: t('cashGiven.col.purpose'), render: (r) => t(`cashGiven.purpose.${r.purpose}`, { defaultValue: r.purpose }) },
    { key: 'amount', header: t('cashGiven.col.amount'), align: 'right', render: (r) => <Amount value={r.amount} /> },
    {
      key: 'rec',
      header: t('cashGiven.col.recovered'),
      render: (r) =>
        r.recovered ? (
          <Chip tone="success" icon="check">
            {t('cashGiven.recovered')}
          </Chip>
        ) : (
          <Chip tone="signal" icon="clock">
            {t('cashGiven.toRecover')}
          </Chip>
        ),
    },
  ]

  return (
    <>
      <PageHeader
        title={t('cashGiven.title')}
        subtitle={t('cashGiven.subtitle')}
        actions={
          <Link to={`/accounts/cash-book?company=${companyId ?? ''}`} className="sf-btn" data-variant="secondary">
            {t('cashGiven.toCashBook')}
          </Link>
        }
      />
      <CompanyPicker list={list} value={companyId} onChange={choose} />
      {isLoading ? (
        <Card>
          <Skeleton height={80} />
        </Card>
      ) : !companyId ? (
        <Card>
          <EmptyState title={t('cashGiven.noCompany')} />
        </Card>
      ) : (
        <>
          <KpiTiles
            ariaLabel={t('cashGiven.kpis')}
            items={[
              { key: 'month', label: t('cashGiven.kpi.month', { n: monthRows.length }), value: <Amount value={fromPaise(sumPaise(monthRows, (r) => r.amount))} rupee /> },
              { key: 'open', label: t('cashGiven.kpi.open', { n: open.length }), value: <Amount value={fromPaise(sumPaise(open, (r) => r.amount))} rupee /> },
              { key: 'all', label: t('cashGiven.kpi.all', { n: rows.length }), value: <Amount value={fromPaise(sumPaise(rows, (r) => r.amount))} rupee /> },
            ]}
          />
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 380px', gap: 16, alignItems: 'start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <TableCard title={t('cashGiven.byStaffTitle')}>
                <div className="sf-table-wrap" role="region" aria-label={t('cashGiven.byStaffTitle')} tabIndex={0}>
                  <table className="sf-table" style={{ minWidth: 520 }}>
                    <caption className="sr-only">{t('cashGiven.byStaffTitle')}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('cashGiven.col.staff')}</th>
                        {purposes.map((p) => (
                          <th key={p} scope="col" className="r">
                            {t(`cashGiven.purpose.${p}`, { defaultValue: p })}
                          </th>
                        ))}
                        <th scope="col" className="r">
                          {t('cashGiven.col.total')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {byPerson.length === 0 ? (
                        <tr className="sf-table__state">
                          <td colSpan={purposes.length + 2}>{q.isLoading ? <Skeleton /> : t('cashGiven.empty')}</td>
                        </tr>
                      ) : (
                        byPerson.map((p) => (
                          <tr key={p.id}>
                            <th scope="row" style={{ fontWeight: 600 }}>
                              {p.name}
                            </th>
                            {purposes.map((pu) => (
                              <td key={pu} className="r">
                                {p.byPurpose.get(pu) ? <Amount value={fromPaise(p.byPurpose.get(pu) ?? 0)} /> : '—'}
                              </td>
                            ))}
                            <td className="r">
                              <strong>
                                <Amount value={fromPaise(p.total)} />
                              </strong>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </TableCard>
              <TableCard title={t('cashGiven.linesTitle')}>
                <DataTable caption={t('cashGiven.linesTitle')} columns={columns} rows={rows} rowKey={(r) => r.id} loading={q.isLoading} empty={<EmptyState title={t('cashGiven.empty')} body={t('cashGiven.emptyBody')} />} />
              </TableCard>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {canPay ? (
                <GiveForm key={companyId} companyId={companyId} />
              ) : (
                <Card title={t('cashGiven.form.title')}>
                  <p className="k">{readOnly ? t('hrCommon.readOnly') : t('cashGiven.noRight')}</p>
                </Card>
              )}
              <Card title={t('cashGiven.limitTitle')} accent="signal">
                <CashLimitText companyId={companyId} />
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  )
}

function GiveForm({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const staff = useStaffList()
  const people = staffOfCompany(staff.list, companyId)
  const cash = useMoneyAccounts(companyId, 'cash')
  const requests = useApiView('staff_requests', { eq: { status: 'approved', kind: 'advance' }, order: 'created_at', ascending: false, limit: 200 })
  const [person, setPerson] = useState('')
  const [date, setDate] = useState(todayIst())
  const [amount, setAmount] = useState('')
  const [account, setAccount] = useState('')
  const [purpose, setPurpose] = useState<string>('advance')
  const [requestId, setRequestId] = useState('')
  const [reason, setReason] = useState('')
  const [needReason, setNeedReason] = useState(false)
  const [errors, setErrors] = useState<{ person?: string; amount?: string; account?: string; reason?: string }>({})
  const [done, setDone] = useState<Posted | null>(null)
  const m = useApiMutation<{ p: Record<string, unknown> }, Posted>('give_staff_cash', [['api', 'cash_given'], ['api', 'account_ledger'], ['api', 'vouchers']])
  const accountId = account || cash.list[0]?.id || ''
  const openRequests = rowsOf(requests).filter((r) => r.person_id === person)

  function submit() {
    const amt = cleanAmount(amount)
    const e: typeof errors = {}
    if (!person) e.person = t('cashGiven.form.errPerson')
    if (!amt || Number(amt) <= 0) e.amount = t('cashGiven.form.errAmount')
    if (!accountId) e.account = t('cashGiven.form.errAccount')
    if (needReason && reason.trim().length < 5) e.reason = t('cashGiven.form.errReason')
    setErrors(e)
    if (Object.keys(e).length) return
    setDone(null)
    const p: Record<string, unknown> = { company_id: companyId, person_id: person, date, amount: amt, account_id: accountId, purpose, request_id: requestId || null }
    if (needReason) p.cash_reason = reason.trim()
    m.mutate(
      { p },
      {
        onSuccess: (res) => {
          setDone(res)
          setAmount('')
          setReason('')
          setRequestId('')
          setNeedReason(false)
        },
        onError: (err) => {
          if (err.rule === 'cash.payment_over_limit') setNeedReason(true)
        },
      },
    )
  }

  const error = m.error as RpcError | null
  const showError = error && !(error.rule === 'cash.payment_over_limit' && needReason)

  return (
    <Card title={t('cashGiven.form.title')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <SelectField label={t('cashGiven.form.staff')} value={person} onChange={(e) => setPerson(e.target.value)} placeholder={t('cashGiven.form.choose')} error={errors.person} options={people.map((s) => ({ value: s.person_id, label: staffLabel(s) }))} />
        <Field type="date" label={t('cashGiven.form.date')} value={date} max={todayIst()} onChange={(e) => setDate(e.target.value)} />
        <SelectField label={t('cashGiven.form.purpose')} value={purpose} onChange={(e) => setPurpose(e.target.value)} options={PURPOSES.map((p) => ({ value: p, label: t(`cashGiven.purpose.${p}`) }))} />
        {openRequests.length ? (
          <SelectField
            label={t('cashGiven.form.request')}
            value={requestId}
            onChange={(e) => {
              setRequestId(e.target.value)
              const r = openRequests.find((x) => x.id === e.target.value)
              if (r?.amount) setAmount(String(r.amount))
              if (r) setPurpose('advance')
            }}
            placeholder={t('cashGiven.form.noRequest')}
            options={openRequests.map((r) => ({ value: r.id, label: t('cashGiven.form.requestOption', { date: formatDate(r.created_at), amount: r.amount ?? '' }) }))}
          />
        ) : null}
        <Field label={t('cashGiven.form.amount')} prefix="₹" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} error={errors.amount} />
        <SelectField label={t('cashGiven.form.account')} value={accountId} onChange={(e) => setAccount(e.target.value)} error={errors.account} placeholder={cash.list.length ? undefined : t('cashGiven.form.noCash')} options={cash.list.map((a) => ({ value: a.id, label: moneyAccountLabel(a) }))} />
        {needReason ? (
          <div className="sf-alert" data-tone="danger" role="alert" style={{ flexDirection: 'column' }}>
            <strong>{t('cashGiven.form.overTitle')}</strong>
            <span>{t('cashGiven.form.overBody')}</span>
          </div>
        ) : null}
        {needReason ? <TextAreaField label={t('cashGiven.form.reason')} value={reason} onChange={(e) => setReason(e.target.value)} error={errors.reason} /> : null}
        {showError ? <HrErrorBox error={error} /> : null}
        {done ? (
          <div role="status" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Chip tone="success" icon="check">
              {t('cashGiven.form.posted', { no: done.doc_no })}
            </Chip>
            {done.warning === 'over_limit' ? (
              <Chip tone="signal" icon="alert">
                {t('cashGiven.form.flagged')}
              </Chip>
            ) : null}
          </div>
        ) : null}
        <Button type="submit" variant="primary" busy={m.isPending}>
          {needReason ? t('cashGiven.form.payAnyway') : t('cashGiven.form.pay')}
        </Button>
        <p className="k" style={{ margin: 0 }}>
          {t('cashGiven.form.help')}
        </p>
      </form>
    </Card>
  )
}

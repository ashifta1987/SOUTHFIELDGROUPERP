import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { TableCard } from '@/features/admin/import-data/layout'
import { fromPaise, sumPaise } from '@/features/accounts/cash-book/money'
import { formatDate, formatIndian } from '@/shared/format'
import { Amount, Button, Card, Chip, ConfirmDialog, DataTable, EmptyState, KpiTiles, PageHeader, Skeleton, StatusChip, type Column } from '@/ui'
import { HrErrorBox, MonthField, monthLabel, monthStart, useSettingValue, useStaffList } from '../common/hr'

type Slip = ViewRow<'payslips'>
type Run = ViewRow<'payroll_runs'>
interface Totals {
  people?: number
  gross?: number | string
  net?: number | string
  advance_recovery?: number | string
}

/**
 * Payroll (`Payroll`, `PayrollBiochem`): one run per company and month. api.prepare_payroll works out every payslip
 * from attendance, profiles, allowances and advances (overtime at the Settings multiplier); api.approve_payroll posts
 * it to the books — by a different person from the one who prepared it (the server refuses the preparer).
 */
export function PayrollPage({ variant }: { variant: 'all' | 'company' }) {
  const { t } = useTranslation()
  const can = useCan()
  const { profile, session } = useAuth()
  const readOnly = profile?.view === 'all-readonly'
  const { list, company, companyId, choose, isLoading } = useCompanyChoice()
  const [month, setMonth] = useState(monthStart(todayIst()))
  const runs = useApiView('payroll_runs', { eq: { company_id: companyId, month }, enabled: Boolean(companyId) })
  const run: Run | undefined = rowsOf(runs)[0]
  const slips = useApiView('payslips', { eq: { run_id: run?.id }, order: 'person_name', enabled: Boolean(run) })
  const voucher = useApiView('vouchers', { eq: { id: run?.voucher_id ?? undefined }, enabled: Boolean(run?.voucher_id) })
  const staff = useStaffList()
  const ot = useSettingValue('payroll.ot_multiplier', companyId)
  const [confirm, setConfirm] = useState(false)
  const refresh = [['api', 'payroll_runs'], ['api', 'payslips'], ['api', 'vouchers'], ['api', 'cash_given']]
  const prepare = useApiMutation<{ p_company_id: string; p_month: string }, { run_id: string }>('prepare_payroll', refresh)
  const approve = useApiMutation<{ p_run_id: string }, { run_id: string; voucher_id: string | null }>('approve_payroll', refresh)
  const canRun = !readOnly && can('payroll.run')
  const totals = (run?.totals ?? {}) as Totals
  const rows = rowsOf(slips)
  const basisOf = new Map(staff.list.map((s) => [s.person_id, s]))
  const monthly = rows.filter((r) => basisOf.get(r.person_id)?.pay_basis !== 'daily')
  const daily = rows.filter((r) => basisOf.get(r.person_id)?.pay_basis === 'daily')
  const preparedByMe = Boolean(run && session && run.prepared_by === session.user.id)
  const v = rowsOf(voucher)[0]

  const name = (r: Slip) => (
    <div>
      <div style={{ fontWeight: 600 }}>{r.person_name}</div>
      <div className="k mono">{basisOf.get(r.person_id)?.person_code ?? ''}</div>
    </div>
  )
  const money = (pick: (r: Slip) => number) => (r: Slip) => (Number(pick(r)) ? <Amount value={pick(r)} /> : '—')
  const columns: Column<Slip>[] = [
    { key: 'name', header: t('payroll.col.employee'), render: name },
    { key: 'present', header: t('payroll.col.present'), align: 'right', render: (r) => <span className="mono">{formatIndian(r.present, 1)}</span> },
    { key: 'half', header: t('payroll.col.half'), align: 'right', render: (r) => <span className="mono">{r.half_days}</span> },
    { key: 'leave', header: t('payroll.col.leave'), align: 'right', render: (r) => <span className="mono">{r.leave_days}</span> },
    { key: 'payable', header: t('payroll.col.payable'), align: 'right', render: (r) => <span className="mono">{t('payroll.ofDays', { d: formatIndian(r.payable_days, 1), n: r.days_in_month })}</span> },
    { key: 'ot', header: t('payroll.col.otHours'), align: 'right', render: (r) => <span className="mono">{Number(r.ot_hours) ? formatIndian(r.ot_hours, 1) : '—'}</span> },
    { key: 'basic', header: t('payroll.col.basic'), align: 'right', render: money((r) => r.basic) },
    { key: 'allow', header: t('payroll.col.allowance'), align: 'right', render: money((r) => r.allowances) },
    { key: 'otpay', header: t('payroll.col.otPay'), align: 'right', render: money((r) => r.ot_pay) },
    { key: 'gross', header: t('payroll.col.gross'), align: 'right', render: (r) => <Amount value={r.gross} /> },
    { key: 'adv', header: t('payroll.col.advance'), align: 'right', render: money((r) => r.advance_recovery) },
    { key: 'ded', header: t('payroll.col.deduction'), align: 'right', render: money((r) => r.deductions) },
    {
      key: 'net',
      header: t('payroll.col.net'),
      align: 'right',
      render: (r) => (
        <strong>
          <Amount value={r.net} />
        </strong>
      ),
    },
  ]
  const footer = (group: Slip[]) =>
    group.length ? (
      <tr>
        <td colSpan={6}>
          <strong>{t('payroll.total')}</strong>
        </td>
        <td className="r">
          <Amount value={fromPaise(sumPaise(group, (r) => r.basic))} />
        </td>
        <td className="r">
          <Amount value={fromPaise(sumPaise(group, (r) => r.allowances))} />
        </td>
        <td className="r">
          <Amount value={fromPaise(sumPaise(group, (r) => r.ot_pay))} />
        </td>
        <td className="r">
          <Amount value={fromPaise(sumPaise(group, (r) => r.gross))} />
        </td>
        <td className="r">
          <Amount value={fromPaise(sumPaise(group, (r) => r.advance_recovery))} />
        </td>
        <td className="r">
          <Amount value={fromPaise(sumPaise(group, (r) => r.deductions))} />
        </td>
        <td className="r">
          <strong>
            <Amount value={fromPaise(sumPaise(group, (r) => r.net))} />
          </strong>
        </td>
      </tr>
    ) : undefined

  const status = !run ? null : run.status === 'draft' ? <StatusChip status="draft" label={t('payroll.state.draft')} /> : <StatusChip status="posted" label={t('payroll.state.posted')} />
  const error = (prepare.error ?? approve.error) as RpcError | null

  return (
    <>
      <PageHeader
        title={
          <span style={{ display: 'inline-flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            {variant === 'company' && company ? t('payroll.titleCompany', { company: company.short_name || company.name, month: monthLabel(month) }) : t('payroll.title', { month: monthLabel(month) })}
            {status}
          </span>
        }
        subtitle={t('payroll.subtitle', { ot: ot ?? t('payroll.otNotSet') })}
        actions={
          <>
            <Link to={`/hr-and-payroll/attendance?company=${companyId ?? ''}`} className="sf-btn" data-variant="secondary">
              {t('payroll.attendance')}
            </Link>
            <Link to={`/hr-and-payroll/payroll/payroll-biochem-trend?company=${companyId ?? ''}`} className="sf-btn" data-variant="secondary">
              {t('payroll.trend')}
            </Link>
            {canRun && companyId && !runs.isLoading && (!run || run.status === 'draft') ? (
              <Button busy={prepare.isPending} onClick={() => companyId && prepare.mutate({ p_company_id: companyId, p_month: month })}>
                {run ? t('payroll.prepareAgain') : t('payroll.prepare')}
              </Button>
            ) : null}
            {canRun && run?.status === 'draft' ? (
              <Button variant="primary" busy={approve.isPending} onClick={() => setConfirm(true)}>
                {t('payroll.approve')}
              </Button>
            ) : null}
          </>
        }
      />
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <CompanyPicker list={list} value={companyId} onChange={choose} />
        <div style={{ width: 200 }}>
          <MonthField value={month} onChange={setMonth} />
        </div>
      </div>
      {!can('payroll.run') ? (
        <Card>
          <p className="k">{t('payroll.noRight')}</p>
        </Card>
      ) : isLoading || runs.isLoading ? (
        <Card>
          <Skeleton height={80} />
        </Card>
      ) : !companyId ? (
        <Card>
          <EmptyState title={t('payroll.noCompany')} />
        </Card>
      ) : (
        <>
          <HrErrorBox error={error} />
          {prepare.isSuccess && !error ? (
            <div role="status">
              <Chip tone="success" icon="check">
                {t('payroll.prepared')}
              </Chip>
            </div>
          ) : null}
          {approve.isSuccess && !error ? (
            <div role="status">
              <Chip tone="success" icon="check">
                {t('payroll.approved')}
              </Chip>
            </div>
          ) : null}
          {!run ? (
            <Card>
              <EmptyState title={t('payroll.emptyTitle', { month: monthLabel(month) })} body={t('payroll.emptyBody')} />
            </Card>
          ) : (
            <>
              <KpiTiles
                ariaLabel={t('payroll.kpis')}
                items={[
                  { key: 'people', label: t('payroll.kpi.people'), value: totals.people ?? 0 },
                  { key: 'gross', label: t('payroll.kpi.gross'), value: <Amount value={totals.gross ?? 0} rupee /> },
                  { key: 'adv', label: t('payroll.kpi.advance'), value: <Amount value={totals.advance_recovery ?? 0} rupee /> },
                  { key: 'net', label: t('payroll.kpi.net'), value: <Amount value={totals.net ?? 0} rupee /> },
                ]}
              />
              <Card accent="signal" title={t('payroll.checkTitle')}>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <li>{t('payroll.preparedBy', { who: run.prepared_by_name ?? t('payroll.someone'), when: formatDate(run.prepared_at) })}</li>
                  {run.status === 'draft' ? <li>{preparedByMe ? t('payroll.youPrepared') : t('payroll.otherPrepared')}</li> : null}
                  {run.approved_at ? <li>{t('payroll.approvedBy', { who: run.approved_by_name ?? t('payroll.someone'), when: formatDate(run.approved_at) })}</li> : null}
                  {v ? <li data-testid="payroll-voucher">{t('payroll.postedAs', { no: v.doc_no, date: formatDate(v.voucher_date) })}</li> : null}
                  <li>{t('payroll.pfEsi')}</li>
                </ul>
              </Card>
              <TableCard title={t('payroll.monthlyTitle')} action={<span className="k">{t('payroll.monthlyRule')}</span>}>
                <DataTable caption={t('payroll.monthlyTitle')} columns={columns} rows={monthly} rowKey={(r) => r.id} loading={slips.isLoading} minWidth={1100} empty={<p className="k">{t('payroll.noneInGroup')}</p>} footer={footer(monthly)} />
              </TableCard>
              {daily.length ? (
                <TableCard title={t('payroll.dailyTitle')} action={<span className="k">{t('payroll.dailyRule')}</span>}>
                  <DataTable caption={t('payroll.dailyTitle')} columns={columns} rows={daily} rowKey={(r) => r.id} minWidth={1100} footer={footer(daily)} />
                </TableCard>
              ) : null}
            </>
          )}
        </>
      )}
      {confirm && run ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setConfirm(false)}
          title={t('payroll.confirmTitle', { month: monthLabel(month) })}
          effect={t('payroll.confirmEffect', { net: formatIndian(String(totals.net ?? 0)), people: totals.people ?? 0 })}
          confirmLabel={t('payroll.approve')}
          busy={approve.isPending}
          onConfirm={() => {
            prepare.reset()
            approve.mutate({ p_run_id: run.id }, { onSettled: () => setConfirm(false) })
          }}
        />
      ) : null}
    </>
  )
}

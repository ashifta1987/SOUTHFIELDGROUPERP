import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { rowsOf, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { todayIst } from '@/features/admin/branches/company'
import { ViewError } from '@/features/production/biochem-common/biochem'
import { useCompanyPeople } from '@/features/production/plastics-common/plastics'
import { CompanyFrame, NoteCard, OPS_REFRESH, OpsErrorBox, TwoCol, monthName, useOpsRights } from '@/features/production/ops-common/ops'
import { formatDate, formatTime } from '@/shared/format'
import { Button, Card, Chip, ConfirmDialog, EmptyState, Field, FieldGrid, FormDialog, SelectField, Skeleton, TextAreaField } from '@/ui'

type Period = ViewRow<'v_period_status'>
type Task = ViewRow<'v_close_tasks'>

/** Where each checklist area is worked on. */
const AREA_LINK: Record<string, string> = {
  bank: '/accounts/bank',
  bills: '/purchase/bill-photo-capture',
  payroll: '/hr/payroll',
  exports: '/exports/export-orders',
  stock: '/inventory/stock-transfers',
  depreciation: '/admin/asset-register',
  review: '/sales/sales-register',
  cash: '/accounts/cash-book',
  gst: '/accounts/gst',
}

function monthEnded(monthStart: string, today: string): boolean {
  const [y, m] = monthStart.split('-').map(Number)
  return new Date(Date.UTC(y ?? 2000, m ?? 1, 1)).toISOString().slice(0, 10) <= today
}

/**
 * Accounts → Month-end close (`MonthClose`): the month's checklist (api.open_close_checklist, tasks from
 * close.default_tasks), each task done by one person and checked by another (api.complete_close_task refuses the doer
 * as checker: sod.doer_is_checker), carried to next month with a reason, then the month closed (api.close_period).
 * After that nothing dated in the month can be posted by any route or grant (period.closed). Only Admin reopens, with a
 * reason that goes to the user log (api.reopen_period).
 */
export function MonthClosePage() {
  const { t } = useTranslation()
  const rights = useOpsRights()
  const [reopening, setReopening] = useState(false)
  return (
    <CompanyFrame
      title={t('monthClose.title')}
      subtitle={t('monthClose.subtitle')}
      notice={rights.readOnly ? t('opsCommon.readOnly') : undefined}
      actions={() =>
        rights.admin ? (
          <Button onClick={() => setReopening(true)}>{t('monthClose.reopen')}</Button>
        ) : null
      }
    >
      {(companyId) => (
        <>
          <Body companyId={companyId} />
          {reopening ? <ReopenDialog companyId={companyId} onClose={() => setReopening(false)} /> : null}
        </>
      )}
    </CompanyFrame>
  )
}

function Body({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const rights = useOpsRights()
  const today = todayIst()
  const pq = useApiView('v_period_status', { eq: { company_id: companyId }, order: 'month_start', ascending: false, limit: 60 })
  const periods = rowsOf(pq)
  const ended = periods.filter((p) => monthEnded(p.month_start, today))
  const fallback = ended.find((p) => p.status === 'open') ?? ended[0] ?? periods[periods.length - 1]
  const [chosenId, setChosenId] = useState('')
  const period = periods.find((p) => p.period_id === chosenId) ?? fallback
  const cq = useApiView('v_close_checklists', { eq: { period_id: period?.period_id }, limit: 1, enabled: Boolean(period) })
  const checklist = rowsOf(cq)[0]
  const tq = useApiView('v_close_tasks', { eq: { checklist_id: checklist?.id }, order: 'sort', limit: 200, enabled: Boolean(checklist) })
  const tasks = rowsOf(tq)
  const [opening, setOpening] = useState(false)
  const [closing, setClosing] = useState(false)
  const [adding, setAdding] = useState(false)
  const close = useApiMutation<{ p_company_id: string; p_period_id: string }>('close_period', OPS_REFRESH)

  if (pq.isLoading) {
    return (
      <Card>
        <Skeleton height={80} />
      </Card>
    )
  }
  if (pq.error) return <ViewError error={pq.error} />
  if (!period) {
    return (
      <Card>
        <EmptyState title={t('monthClose.noPeriods')} body={t('monthClose.noPeriodsBody')} />
      </Card>
    )
  }
  const name = monthName(period.month_start)
  const isClosed = period.status === 'closed'
  const open = tasks.filter((x) => x.status === 'open' || x.status === 'done').length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ maxWidth: 320 }}>
        <SelectField
          label={t('monthClose.month')}
          value={period.period_id}
          onChange={(e) => setChosenId(e.target.value)}
          options={periods.map((p) => ({ value: p.period_id, label: `${monthName(p.month_start)} · ${t(`monthClose.pstatus.${p.status}`, { defaultValue: p.status })}` }))}
        />
      </div>
      <Card accent="signal">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 28, alignItems: 'center' }}>
          {isClosed ? (
            <div>
              <span className="k">{t('monthClose.banner.closedLabel', { month: name })}</span>
              <div style={{ fontSize: 24, fontWeight: 700 }} data-testid="mc-period-status">
                {t('monthClose.banner.closed')}
              </div>
              <span className="k">{period.closed_at ? t('monthClose.banner.closedBy', { who: period.closed_by_name ?? '—', when: `${formatDate(period.closed_at)} ${formatTime(period.closed_at)}` }) : ''}</span>
            </div>
          ) : (
            <>
              <div>
                <span className="k">{t('monthClose.banner.dueLabel', { month: name })}</span>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{checklist ? formatDate(checklist.due_on) : t('monthClose.banner.noChecklist')}</div>
                <span className="k" data-testid="mc-period-status">
                  {t(`monthClose.pstatus.${period.status}`, { defaultValue: period.status })}
                </span>
              </div>
              {checklist ? (
                <>
                  <div>
                    <span className="k">{t('monthClose.banner.left')}</span>
                    <div style={{ fontSize: 24, fontWeight: 700 }}>{t('monthClose.banner.days', { n: checklist.days_left ?? 0 })}</div>
                  </div>
                  <div>
                    <span className="k">{t('monthClose.banner.open')}</span>
                    <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--sf-signal-ink, var(--sf-signal))' }} data-testid="mc-open">
                      {open}
                    </div>
                  </div>
                </>
              ) : null}
            </>
          )}
          <p style={{ flex: '1 1 320px', margin: 0 }}>{period.last_action === 'reopened' ? t('monthClose.banner.reopened', { reason: period.last_reason ?? '', when: period.last_action_at ? formatDate(period.last_action_at) : '' }) : t('monthClose.banner.body')}</p>
        </div>
      </Card>
      <TwoCol
        main={
          <Card
            title={t('monthClose.checklist', { month: name })}
            action={
              <div style={{ display: 'flex', gap: 8 }}>
                {checklist && !isClosed && rights.closeManage ? (
                  <>
                    <Button size="sm" onClick={() => setAdding(true)}>
                      {t('monthClose.addTask')}
                    </Button>
                    <Button size="sm" variant="primary" disabled={!monthEnded(period.month_start, today)} onClick={() => setClosing(true)}>
                      {t('monthClose.closeMonth')}
                    </Button>
                  </>
                ) : null}
              </div>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <OpsErrorBox error={close.error} />
              {cq.isLoading || tq.isLoading ? <Skeleton height={60} /> : null}
              {cq.error ? <ViewError error={cq.error} /> : null}
              {!cq.isLoading && !checklist ? (
                <EmptyState
                  title={t('monthClose.noChecklist')}
                  body={isClosed ? t('monthClose.noChecklistClosed') : t('monthClose.noChecklistBody')}
                  action={
                    !isClosed && rights.closeManage ? (
                      <Button variant="primary" onClick={() => setOpening(true)}>
                        {t('monthClose.openChecklist')}
                      </Button>
                    ) : !rights.closeManage ? (
                      <span className="k">{t('monthClose.needRight')}</span>
                    ) : null
                  }
                />
              ) : null}
              {checklist ? (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label={t('monthClose.checklist', { month: name })}>
                  {tasks.map((task, i) => (
                    <TaskRow key={task.id} task={task} first={i === 0} locked={isClosed} />
                  ))}
                </ul>
              ) : null}
            </div>
          </Card>
        }
        side={
          <>
            <Card title={t('monthClose.months')}>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                {periods
                  .slice()
                  .reverse()
                  .map((p) => (
                    <li key={p.period_id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span>{monthName(p.month_start)}</span>
                      <PeriodChip p={p} />
                    </li>
                  ))}
              </ul>
            </Card>
            <NoteCard
              title={t('monthClose.after.title')}
              items={[{ body: t('monthClose.after.one') }, { body: t('monthClose.after.two') }, { body: t('monthClose.after.three') }, { body: t('monthClose.after.four') }]}
            />
          </>
        }
      />
      {opening ? <OpenDialog companyId={companyId} period={period} onClose={() => setOpening(false)} /> : null}
      {adding && checklist ? <AddTaskDialog companyId={companyId} checklistId={checklist.id} onClose={() => setAdding(false)} /> : null}
      <ConfirmDialog
        open={closing}
        onOpenChange={setClosing}
        title={t('monthClose.closeTitle', { month: name })}
        effect={t('monthClose.closeEffect', { month: name })}
        confirmLabel={t('monthClose.closeMonth')}
        busy={close.isPending}
        onConfirm={() => close.mutate({ p_company_id: companyId, p_period_id: period.period_id }, { onSettled: () => setClosing(false) })}
      />
    </div>
  )
}

function PeriodChip({ p }: { p: Period }) {
  const { t } = useTranslation()
  if (p.status === 'closed')
    return (
      <Chip tone="neutral" icon="lock">
        {t('monthClose.pstatus.closed')}
      </Chip>
    )
  if (p.last_action === 'reopened')
    return (
      <Chip tone="signal" icon="alert">
        {t('monthClose.reopenedChip')}
      </Chip>
    )
  return <Chip tone="success">{t('monthClose.pstatus.open')}</Chip>
}

function TaskRow({ task, first, locked }: { task: Task; first: boolean; locked: boolean }) {
  const { t } = useTranslation()
  const rights = useOpsRights()
  const act = useApiMutation<{ p_task_id: string; p_action: string; p_note: string | null }>('complete_close_task', OPS_REFRESH)
  const [dlg, setDlg] = useState<'return' | 'carry' | 'assign' | null>(null)
  const me = rights.me
  const canDo = !locked && task.status === 'open' && (task.doer_user_id ? task.doer_user_id === me : rights.closeManage)
  const canCheck = !locked && task.status === 'done' && (task.checker_user_id ? task.checker_user_id === me : rights.closeManage)
  const tone = task.status === 'checked' ? 'success' : task.status === 'done' ? 'teal' : task.status === 'carried' ? 'neutral' : 'signal'
  const link = AREA_LINK[task.area]
  return (
    <li style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 0', borderTop: first ? undefined : '1px solid var(--sf-line-faint)' }} data-testid={`mc-task-${task.sort}`}>
      <span style={{ minWidth: 92 }}>
        <Chip tone={tone}>{t(`monthClose.tstatus.${task.status}`, { defaultValue: task.status })}</Chip>
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong style={{ display: 'block' }}>{task.title}</strong>
        <span className="k" style={{ display: 'block' }}>
          {t('monthClose.who', { doer: task.doer_name ?? t('monthClose.anyManager'), checker: task.checker_name ?? t('monthClose.anyManager') })}
        </span>
        {task.done_at ? <span className="k" style={{ display: 'block' }}>{t(task.done_by === me ? 'monthClose.doneByMe' : 'monthClose.doneOn', { when: formatDate(task.done_at) })}</span> : null}
        {task.checked_at ? <span className="k" style={{ display: 'block' }}>{t('monthClose.checkedOn', { when: formatDate(task.checked_at) })}</span> : null}
        {task.check_note ? <span className="k" style={{ display: 'block' }}>{t('monthClose.checkNote', { note: task.check_note })}</span> : null}
        {task.carry_reason ? <span className="k" style={{ display: 'block' }}>{t('monthClose.carryNote', { note: task.carry_reason })}</span> : null}
        <OpsErrorBox error={act.error} />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
          {canDo ? (
            <Button size="sm" variant="primary" busy={act.isPending} onClick={() => act.mutate({ p_task_id: task.id, p_action: 'done', p_note: null })} aria-label={t('monthClose.act.doneOne', { title: task.title })}>
              {t('monthClose.act.done')}
            </Button>
          ) : null}
          {canCheck ? (
            <>
              <Button size="sm" variant="primary" busy={act.isPending} onClick={() => act.mutate({ p_task_id: task.id, p_action: 'check', p_note: null })} aria-label={t('monthClose.act.checkOne', { title: task.title })}>
                {t('monthClose.act.check')}
              </Button>
              <Button size="sm" onClick={() => setDlg('return')} aria-label={t('monthClose.act.returnOne', { title: task.title })}>
                {t('monthClose.act.return')}
              </Button>
            </>
          ) : null}
          {!locked && rights.closeManage && (task.status === 'open' || task.status === 'done') ? (
            <>
              <Button size="sm" variant="link" onClick={() => setDlg('carry')} aria-label={t('monthClose.act.carryOne', { title: task.title })}>
                {t('monthClose.act.carry')}
              </Button>
              <Button size="sm" variant="link" onClick={() => setDlg('assign')} aria-label={t('monthClose.act.assignOne', { title: task.title })}>
                {t('monthClose.act.assign')}
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {link ? (
        <Link to={link} style={{ whiteSpace: 'nowrap' }}>
          {t(`monthClose.area.${task.area}`, { defaultValue: task.area })}
        </Link>
      ) : null}
      {dlg === 'return' ? <NoteDialog task={task} kind="return" onClose={() => setDlg(null)} /> : null}
      {dlg === 'carry' ? <NoteDialog task={task} kind="carry" onClose={() => setDlg(null)} /> : null}
      {dlg === 'assign' ? <AssignDialog task={task} onClose={() => setDlg(null)} /> : null}
    </li>
  )
}

function NoteDialog({ task, kind, onClose }: { task: Task; kind: 'return' | 'carry'; onClose: () => void }) {
  const { t } = useTranslation()
  const [note, setNote] = useState('')
  const ret = useApiMutation<{ p_task_id: string; p_action: string; p_note: string }>('complete_close_task', OPS_REFRESH)
  const carry = useApiMutation<{ p_task_id: string; p_reason: string }>('carry_close_task', OPS_REFRESH)
  const m = kind === 'return' ? ret : carry
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t(`monthClose.${kind}.title`, { title: task.title })}
      description={t(`monthClose.${kind}.hint`)}
      submitLabel={t(`monthClose.${kind}.submit`)}
      busy={m.isPending}
      error={<OpsErrorBox error={m.error} />}
      onSubmit={() => (kind === 'return' ? ret.mutate({ p_task_id: task.id, p_action: 'return', p_note: note }, { onSuccess: onClose }) : carry.mutate({ p_task_id: task.id, p_reason: note }, { onSuccess: onClose }))}
    >
      <TextAreaField label={t(`monthClose.${kind}.note`)} value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
    </FormDialog>
  )
}

function AssignDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const { t } = useTranslation()
  const people = useCompanyPeople(task.company_id)
  const [f, setF] = useState({ doer: task.doer_user_id ?? '', checker: task.checker_user_id ?? '' })
  const save = useApiMutation<{ p_task_id: string; p: Record<string, unknown> }>('assign_close_task', OPS_REFRESH)
  const opts = people.list.map((p) => ({ value: p.user_id, label: p.display_name ?? '—' }))
  return (
    <FormDialog open onOpenChange={(o) => (!o ? onClose() : undefined)} title={t('monthClose.assign.title', { title: task.title })} description={t('monthClose.assign.hint')} submitLabel={t('common.save')} busy={save.isPending} error={<OpsErrorBox error={save.error} />} onSubmit={() => save.mutate({ p_task_id: task.id, p: { doer_user_id: f.doer || null, checker_user_id: f.checker || null } }, { onSuccess: onClose })}>
      <FieldGrid cols={2}>
        <SelectField label={t('monthClose.assign.doer')} value={f.doer} onChange={(e) => setF({ ...f, doer: e.target.value })} placeholder={t('monthClose.anyManager')} options={opts} />
        <SelectField label={t('monthClose.assign.checker')} value={f.checker} onChange={(e) => setF({ ...f, checker: e.target.value })} placeholder={t('monthClose.anyManager')} options={opts} />
      </FieldGrid>
    </FormDialog>
  )
}

function OpenDialog({ companyId, period, onClose }: { companyId: string; period: Period; onClose: () => void }) {
  const { t } = useTranslation()
  const people = useCompanyPeople(companyId)
  const [f, setF] = useState({ doer: '', checker: '' })
  const save = useApiMutation<{ p_company_id: string; p_period_id: string; p: Record<string, unknown> }>('open_close_checklist', OPS_REFRESH)
  const opts = people.list.map((p) => ({ value: p.user_id, label: p.display_name ?? '—' }))
  return (
    <FormDialog open onOpenChange={(o) => (!o ? onClose() : undefined)} title={t('monthClose.openTitle', { month: monthName(period.month_start) })} description={t('monthClose.openHint')} submitLabel={t('monthClose.openChecklist')} busy={save.isPending} error={<OpsErrorBox error={save.error} />} onSubmit={() => save.mutate({ p_company_id: companyId, p_period_id: period.period_id, p: { doer_user_id: f.doer || null, checker_user_id: f.checker || null } }, { onSuccess: onClose })}>
      <FieldGrid cols={2}>
        <SelectField label={t('monthClose.assign.doer')} value={f.doer} onChange={(e) => setF({ ...f, doer: e.target.value })} placeholder={t('monthClose.anyManager')} options={opts} />
        <SelectField label={t('monthClose.assign.checker')} value={f.checker} onChange={(e) => setF({ ...f, checker: e.target.value })} placeholder={t('monthClose.anyManager')} options={opts} />
      </FieldGrid>
    </FormDialog>
  )
}

function AddTaskDialog({ companyId, checklistId, onClose }: { companyId: string; checklistId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const people = useCompanyPeople(companyId)
  const [f, setF] = useState({ title: '', doer: '', checker: '' })
  const save = useApiMutation<{ p_checklist_id: string; p: Record<string, unknown> }>('add_close_task', OPS_REFRESH)
  const opts = people.list.map((p) => ({ value: p.user_id, label: p.display_name ?? '—' }))
  return (
    <FormDialog open onOpenChange={(o) => (!o ? onClose() : undefined)} title={t('monthClose.add.title')} submitLabel={t('monthClose.addTask')} busy={save.isPending} error={<OpsErrorBox error={save.error} />} onSubmit={() => save.mutate({ p_checklist_id: checklistId, p: { title: f.title.trim(), doer_user_id: f.doer || null, checker_user_id: f.checker || null } }, { onSuccess: onClose })}>
      <Field label={t('monthClose.add.name')} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required />
      <FieldGrid cols={2}>
        <SelectField label={t('monthClose.assign.doer')} value={f.doer} onChange={(e) => setF({ ...f, doer: e.target.value })} placeholder={t('monthClose.anyManager')} options={opts} />
        <SelectField label={t('monthClose.assign.checker')} value={f.checker} onChange={(e) => setF({ ...f, checker: e.target.value })} placeholder={t('monthClose.anyManager')} options={opts} />
      </FieldGrid>
    </FormDialog>
  )
}

function ReopenDialog({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const pq = useApiView('v_period_status', { eq: { company_id: companyId, status: 'closed' }, order: 'month_start', ascending: false, limit: 60 })
  const closed = rowsOf(pq)
  const [f, setF] = useState({ period: '', reason: '' })
  const save = useApiMutation<{ p_company_id: string; p_period_id: string; p_reason: string }>('reopen_period', OPS_REFRESH)
  const chosen = f.period || closed[0]?.period_id || ''
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('monthClose.reopenTitle')}
      description={t('monthClose.reopenHint')}
      submitLabel={t('monthClose.reopenSubmit')}
      busy={save.isPending}
      error={<OpsErrorBox error={save.error} />}
      onSubmit={() => save.mutate({ p_company_id: companyId, p_period_id: chosen, p_reason: f.reason }, { onSuccess: onClose })}
    >
      {closed.length === 0 && !pq.isLoading ? <p className="k" style={{ margin: 0 }}>{t('monthClose.noClosed')}</p> : null}
      <SelectField label={t('monthClose.month')} value={chosen} onChange={(e) => setF({ ...f, period: e.target.value })} options={closed.map((p) => ({ value: p.period_id, label: monthName(p.month_start) }))} />
      <TextAreaField label={t('monthClose.reason')} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} rows={3} />
    </FormDialog>
  )
}

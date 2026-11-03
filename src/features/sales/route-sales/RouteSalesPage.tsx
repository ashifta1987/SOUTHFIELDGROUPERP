import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiRpc, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation } from '@/data/rpc'
import { CompanyPicker } from '@/features/admin/branches/CompanyPicker'
import { todayIst, useCompanyChoice } from '@/features/admin/branches/company'
import { LogisticsErrorBox, useCompanyPeople } from '@/features/logistics/common/logistics'
import { formatDate, formatTime } from '@/shared/format'
import { Amount, Button, Card, Checkbox, DataTable, EmptyState, Field, FieldGrid, FormDialog, KpiTiles, PageHeader, SelectField, Skeleton, Tabs, TextAreaField, type Column } from '@/ui'

interface BoardVisit {
  visit_id: string
  party: string
  check_in_at: string
  distance_m: number | string | null
  geofence_ok: boolean
  approval: 'none' | 'pending' | 'approved' | 'refused'
  reason: string | null
  outcome: string | null
}
interface BoardRow {
  user_id: string
  name: string
  on_duty: boolean
  visits: BoardVisit[]
  exceptions: number
  orders_total: number | string
  collected: number | string
  cash_with_salesman: number | string
  last_point: { at: string; lat: number; lng: number } | null
}

const REFRESH: string[][] = [
  ['api', 'route_sales_board'],
  ['api', 'beats'],
  ['api', 'beat_customers'],
  ['api', 'cash_handovers'],
  ['api', 'day_closes'],
  ['api', 'visits'],
  ['api', 'customer_price_list'],
  ['api', 'my_customers'],
]
const DENOMINATIONS = ['500', '200', '100', '50', '20', '10', '5', '2', '1'] as const
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const

function isoWeekdayIst(): number {
  const d = new Date(`${todayIst()}T12:00:00+05:30`)
  return ((d.getUTCDay() + 6) % 7) + 1
}

/**
 * Route sales (`RouteSales`, sales manager and Admin): today's board from api.route_sales_board — who is on duty, each
 * salesman's check-ins with the server's distance from the shop pin, out-of-geofence check-ins to approve or refuse
 * (never by the salesman himself), orders and cash with each salesman; beats (api.plan_beat) and customer assignment
 * (api.assign_salesman) with the customer's price list (api.set_customer_price_list); cash handovers counted by the
 * cashier on another login (mismatch → Bug fixer, finance resolves); and day ends. GPS only on duty, kept 90 days.
 */
export function RouteSalesPage() {
  const { t } = useTranslation()
  const can = useCan()
  const choice = useCompanyChoice()
  const companyId = choice.companyId
  const manage = can('field.manage')
  const board = useApiRpc<BoardRow[]>('route_sales_board', { p_company_id: companyId, p_date: todayIst() }, Boolean(companyId && manage))
  const rows = board.data?.status === 'ready' ? (board.data.data ?? []) : []
  const [who, setWho] = useState<string>('')
  const current = rows.find((r) => r.user_id === who) ?? rows[0]

  if (!manage && !can('cash_book.create')) {
    return (
      <>
        <PageHeader title={t('routeSales.title')} />
        <Card>
          <p className="k">{t('routeSales.noRight')}</p>
        </Card>
      </>
    )
  }

  const visited = rows.reduce((n, r) => n + r.visits.length, 0)
  return (
    <>
      <PageHeader title={t('routeSales.title')} subtitle={t('routeSales.subtitle')} />
      <div style={{ marginBottom: 12 }}>
        <CompanyPicker list={choice.list} value={companyId} onChange={choice.choose} />
      </div>
      {manage ? (
        <>
          <KpiTiles
            ariaLabel={t('routeSales.kpis')}
            items={[
              { key: 'duty', label: t('routeSales.kpi.onRoute'), value: String(rows.filter((r) => r.on_duty).length), sub: t('routeSales.kpi.ofSalesmen', { count: rows.length }) },
              { key: 'visits', label: t('routeSales.kpi.visited'), value: String(visited), sub: t('routeSales.kpi.byGps') },
              { key: 'orders', label: t('routeSales.kpi.orders'), value: <Amount value={rows.reduce((n, r) => n + Number(r.orders_total), 0).toFixed(2)} rupee />, sub: t('routeSales.kpi.ordersSub') },
              { key: 'collected', label: t('routeSales.kpi.collected'), value: <Amount value={rows.reduce((n, r) => n + Number(r.collected), 0).toFixed(2)} rupee />, sub: t('routeSales.kpi.collectedSub') },
              { key: 'look', label: t('routeSales.kpi.look'), value: String(rows.reduce((n, r) => n + Number(r.exceptions), 0)), sub: t('routeSales.kpi.lookSub') },
            ]}
          />
          <div className="sf-grid-2" style={{ marginTop: 16 }}>
            <Card title={t('routeSales.board')}>
              {board.isLoading ? (
                <Skeleton height={120} />
              ) : rows.length === 0 ? (
                <EmptyState title={t('routeSales.noSalesmen')} body={t('routeSales.noSalesmenBody')} />
              ) : (
                <>
                  <Tabs label={t('routeSales.salesmen')} value={current?.user_id ?? ''} onChange={setWho} tabs={rows.map((r) => ({ key: r.user_id, label: `${r.name}${r.on_duty ? ` · ${t('routeSales.onDuty')}` : ''}` }))} />
                  {current ? <SalesmanDay row={current} /> : null}
                </>
              )}
            </Card>
            <Card title={t('routeSales.rules')}>
              <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {(['beat', 'gps', 'visit', 'orders', 'cash', 'privacy'] as const).map((k) => (
                  <div key={k}>
                    <dt style={{ fontWeight: 600 }}>{t(`routeSales.rule.${k}.title`)}</dt>
                    <dd style={{ margin: '2px 0 0' }}>{t(`routeSales.rule.${k}.body`)}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          </div>
        </>
      ) : null}
      {companyId ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 16 }}>
          <Handovers companyId={companyId} />
          {manage ? <Beats companyId={companyId} /> : null}
          {manage ? <Assign companyId={companyId} /> : null}
          <DayCloses companyId={companyId} />
        </div>
      ) : null}
    </>
  )
}

function SalesmanDay({ row }: { row: BoardRow }) {
  const { t } = useTranslation()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
      <p className="k" style={{ margin: 0 }}>
        {t('routeSales.cashWith')} <Amount value={row.cash_with_salesman} rupee /> · {t('routeSales.orders')} <Amount value={row.orders_total} rupee />
        {row.last_point ? ` · ${t('routeSales.lastPoint', { time: formatTime(row.last_point.at) })}` : ''}
      </p>
      {row.visits.length === 0 ? (
        <p className="k">{t('routeSales.noVisits')}</p>
      ) : (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {row.visits.map((v, i) => (
            <VisitRow key={v.visit_id} v={v} n={i + 1} />
          ))}
        </ol>
      )}
    </div>
  )
}

function VisitRow({ v, n }: { v: BoardVisit; n: number }) {
  const { t } = useTranslation()
  const m = useApiMutation<{ p_visit_id: string; p_approve: boolean; p_note: string | null }>('approve_out_of_geofence', REFRESH)
  const [note, setNote] = useState('')
  return (
    <li style={{ display: 'grid', gridTemplateColumns: '28px 1fr auto', gap: 10, borderBottom: '1px solid var(--sf-line)', paddingBottom: 10 }} data-testid={`visit-${v.visit_id}`}>
      <span className="mono" aria-hidden="true">
        {n}
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <strong>{v.party}</strong>
        <span className="k">
          {t('routeSales.checkedIn', { time: formatTime(v.check_in_at) })}
          {v.distance_m !== null ? ` · ${t('routeSales.fromPin', { m: Math.round(Number(v.distance_m)) })}` : ` · ${t('routeSales.noPin')}`}
        </span>
        {!v.geofence_ok ? (
          <span style={{ color: 'var(--sf-danger-ink)' }}>
            {t('routeSales.outside')}
            {v.reason ? ` · “${v.reason}”` : ''}
          </span>
        ) : null}
        {v.approval === 'pending' ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 200, flex: 1 }}>
              <Field label={t('routeSales.note')} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <Button size="sm" variant="primary" busy={m.isPending} onClick={() => m.mutate({ p_visit_id: v.visit_id, p_approve: true, p_note: note.trim() || null })}>
              {t('routeSales.approve')}
            </Button>
            <Button size="sm" variant="danger" busy={m.isPending} onClick={() => m.mutate({ p_visit_id: v.visit_id, p_approve: false, p_note: note.trim() || null })}>
              {t('routeSales.refuse')}
            </Button>
          </div>
        ) : null}
        <LogisticsErrorBox error={m.error} />
      </div>
      <span className="sf-chip" data-tone={v.approval === 'pending' ? 'signal' : v.approval === 'refused' ? 'danger' : v.outcome === 'order' ? 'teal' : 'neutral'}>
        {v.approval === 'pending' ? t('routeSales.needsOk') : v.approval === 'approved' ? t('routeSales.approved') : v.approval === 'refused' ? t('routeSales.refused') : v.outcome ? t(`routeSales.outcome.${v.outcome}`, { defaultValue: v.outcome }) : t('routeSales.inShop')}
      </span>
    </li>
  )
}

type Handover = ViewRow<'cash_handovers'>

function Handovers({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const can = useCan()
  const q = useApiView('cash_handovers', { eq: { company_id: companyId }, order: 'created_at', ascending: false, limit: 30 })
  const [confirming, setConfirming] = useState<Handover | null>(null)
  const [resolving, setResolving] = useState<Handover | null>(null)
  const columns: Column<Handover>[] = [
    { key: 'date', header: t('routeSales.ho.date'), render: (r) => formatDate(r.handover_date) },
    { key: 'sm', header: t('routeSales.ho.salesman'), render: (r) => r.salesman_name ?? '—' },
    { key: 'exp', header: t('routeSales.ho.expected'), align: 'right', render: (r) => <Amount value={r.expected_cash} /> },
    { key: 'sc', header: t('routeSales.ho.salesmanCount'), align: 'right', render: (r) => <Amount value={r.salesman_total} /> },
    { key: 'cc', header: t('routeSales.ho.cashierCount'), align: 'right', render: (r) => <Amount value={r.cashier_total} /> },
    { key: 'diff', header: t('routeSales.ho.difference'), align: 'right', render: (r) => <Amount value={r.difference ?? Number(r.salesman_total) - Number(r.expected_cash)} /> },
    { key: 'st', header: t('common.status'), render: (r) => <span className="sf-chip" data-tone={r.status === 'confirmed' || r.status === 'resolved' ? 'success' : r.status === 'mismatch' ? 'danger' : 'signal'}>{t(`routeSales.ho.status.${r.status}`, { defaultValue: r.status })}</span> },
    {
      key: 'act',
      header: <span className="sr-only">{t('routeSales.ho.actions')}</span>,
      render: (r) =>
        r.status === 'pending' && can('cash_book.create') ? (
          <Button size="sm" onClick={() => setConfirming(r)}>
            {t('routeSales.ho.count')}
          </Button>
        ) : r.status === 'mismatch' && can('cash_book.approve') ? (
          <Button size="sm" onClick={() => setResolving(r)}>
            {t('routeSales.ho.resolve')}
          </Button>
        ) : null,
    },
  ]
  return (
    <Card pad={false}>
      <div className="sf-card__head sf-card__pad" style={{ paddingBottom: 8 }}>
        <h2 className="sf-card__title">{t('routeSales.ho.title')}</h2>
      </div>
      <DataTable caption={t('routeSales.ho.title')} columns={columns} rows={rowsOf(q)} rowKey={(r) => r.id} loading={q.isLoading} empty={<EmptyState title={t('routeSales.ho.none')} body={t('routeSales.ho.noneBody')} />} />
      {confirming ? <ConfirmHandover companyId={companyId} h={confirming} onClose={() => setConfirming(null)} /> : null}
      {resolving ? <ResolveHandover h={resolving} onClose={() => setResolving(null)} /> : null}
    </Card>
  )
}

function ConfirmHandover({ companyId, h, onClose }: { companyId: string; h: Handover; onClose: () => void }) {
  const { t } = useTranslation()
  const accounts = useApiView('money_accounts', { eq: { company_id: companyId, kind: 'cash' }, order: 'name' })
  const m = useApiMutation<{ p_handover_id: string; p: Record<string, unknown> }, { status: string; difference: number | string }>('confirm_cash_handover', REFRESH)
  const [counts, setCounts] = useState<Record<string, string>>({})
  const [acc, setAcc] = useState('')
  return (
    <FormDialog
      open
      wide
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('routeSales.ho.countTitle', { name: h.salesman_name ?? '' })}
      description={t('routeSales.ho.countHelp')}
      submitLabel={t('routeSales.ho.confirm')}
      busy={m.isPending}
      onSubmit={() => {
        const denominations: Record<string, number> = {}
        for (const k of DENOMINATIONS) if (Number(counts[k] ?? 0) > 0) denominations[k] = Number(counts[k])
        m.mutate({ p_handover_id: h.id, p: { denominations, to_account_id: acc || null } }, { onSuccess: onClose })
      }}
      error={<LogisticsErrorBox error={m.error} />}
    >
      <SelectField label={t('routeSales.ho.toAccount')} value={acc} placeholder={t('routeSales.choose')} onChange={(e) => setAcc(e.target.value)} options={rowsOf(accounts).map((a) => ({ value: a.id, label: a.name }))} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        {DENOMINATIONS.map((k) => (
          <Field key={k} label={t('routeSales.ho.noteCount', { value: k })} inputMode="numeric" value={counts[k] ?? ''} onChange={(e) => setCounts({ ...counts, [k]: e.target.value.replace(/\D/g, '') })} />
        ))}
      </div>
      <p className="k" style={{ margin: 0 }}>
        {t('routeSales.ho.blind')}
      </p>
    </FormDialog>
  )
}

function ResolveHandover({ h, onClose }: { h: Handover; onClose: () => void }) {
  const { t } = useTranslation()
  const m = useApiMutation<{ p_handover_id: string; p_note: string }>('resolve_cash_handover', REFRESH)
  const [note, setNote] = useState('')
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('routeSales.ho.resolveTitle', { name: h.salesman_name ?? '' })}
      description={t('routeSales.ho.resolveHelp')}
      submitLabel={t('routeSales.ho.resolve')}
      busy={m.isPending}
      onSubmit={() => m.mutate({ p_handover_id: h.id, p_note: note.trim() }, { onSuccess: onClose })}
      error={<LogisticsErrorBox error={m.error} />}
    >
      <p style={{ margin: 0 }}>
        {t('routeSales.ho.expected')} <Amount value={h.expected_cash} rupee /> · {t('routeSales.ho.salesmanCount')} <Amount value={h.salesman_total} rupee /> · {t('routeSales.ho.cashierCount')} <Amount value={h.cashier_total} rupee />
      </p>
      <TextAreaField label={t('routeSales.ho.found')} value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
    </FormDialog>
  )
}

function Beats({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const q = useApiView('beats', { eq: { company_id: companyId }, order: 'code' })
  const [open, setOpen] = useState(false)
  const columns: Column<ViewRow<'beats'>>[] = [
    { key: 'code', header: t('common.code'), render: (r) => <span className="mono">{r.code}</span> },
    { key: 'name', header: t('common.name'), render: (r) => r.name },
    { key: 'sm', header: t('routeSales.beat.salesman'), render: (r) => r.salesman_name ?? '—' },
    { key: 'day', header: t('routeSales.beat.weekday'), render: (r) => (r.weekday ? t(`routeSales.weekday.${r.weekday}`) : '—') },
    { key: 'cust', header: t('routeSales.beat.customers'), align: 'right', render: (r) => <span className="mono">{r.customers ?? 0}</span> },
    { key: 'act', header: t('common.status'), render: (r) => (r.active ? t('common.active') : t('common.inactive')) },
  ]
  return (
    <Card pad={false}>
      <div className="sf-card__head sf-card__pad" style={{ alignItems: 'center', paddingBottom: 8 }}>
        <h2 className="sf-card__title">{t('routeSales.beat.title')}</h2>
        <Button onClick={() => setOpen(true)}>{t('routeSales.beat.plan')}</Button>
      </div>
      <DataTable caption={t('routeSales.beat.title')} columns={columns} rows={rowsOf(q)} rowKey={(r) => r.id} loading={q.isLoading} empty={<EmptyState title={t('routeSales.beat.none')} body={t('routeSales.beat.noneBody')} />} />
      {open ? <PlanBeat companyId={companyId} onClose={() => setOpen(false)} /> : null}
    </Card>
  )
}

function PlanBeat({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const people = useCompanyPeople(companyId)
  const salesmen = people.filter((p) => (p.role_keys ?? []).includes('salesman'))
  const customers = useApiView('customers', { eq: { company_id: companyId }, order: 'name', limit: 500 })
  const m = useApiMutation<{ p: Record<string, unknown> }>('plan_beat', REFRESH)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [sm, setSm] = useState('')
  const [weekday, setWeekday] = useState(String(isoWeekdayIst()))
  const [picked, setPicked] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const list = rowsOf(customers).filter((c) => c.status !== 'inactive' && (!filter.trim() || c.name.toLowerCase().includes(filter.trim().toLowerCase())))
  return (
    <FormDialog
      open
      wide
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('routeSales.beat.planTitle')}
      description={t('routeSales.beat.planHelp')}
      submitLabel={t('routeSales.beat.save')}
      busy={m.isPending}
      onSubmit={() => m.mutate({ p: { company_id: companyId, code: code.trim(), name: name.trim(), salesman_user_id: sm || null, weekday: Number(weekday), active: true, customers: picked } }, { onSuccess: onClose })}
      error={<LogisticsErrorBox error={m.error} />}
    >
      <FieldGrid>
        <Field label={t('common.code')} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        <Field label={t('common.name')} value={name} onChange={(e) => setName(e.target.value)} />
        <SelectField label={t('routeSales.beat.salesman')} value={sm} placeholder={salesmen.length ? t('routeSales.choose') : t('routeSales.noSalesmanRole')} onChange={(e) => setSm(e.target.value)} options={salesmen.map((p) => ({ value: p.user_id, label: p.display_name }))} />
        <SelectField label={t('routeSales.beat.weekday')} value={weekday} onChange={(e) => setWeekday(e.target.value)} options={WEEKDAYS.map((d) => ({ value: String(d), label: t(`routeSales.weekday.${d}`) }))} />
      </FieldGrid>
      <Field label={t('routeSales.beat.find')} type="search" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <fieldset style={{ border: '1px solid var(--sf-line)', borderRadius: 8, padding: 12, maxHeight: 260, overflowY: 'auto' }}>
        <legend>{t('routeSales.beat.order', { count: picked.length })}</legend>
        {list.length === 0 ? (
          <p className="k" style={{ margin: 0 }}>
            {t('routeSales.beat.noCustomers')}
          </p>
        ) : (
          list.map((c) => (
            <Checkbox
              key={c.id}
              label={`${picked.includes(c.id) ? `${picked.indexOf(c.id) + 1}. ` : ''}${c.name}`}
              checked={picked.includes(c.id)}
              onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))}
            />
          ))
        )}
      </fieldset>
    </FormDialog>
  )
}

function Assign({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const people = useCompanyPeople(companyId)
  const salesmen = people.filter((p) => (p.role_keys ?? []).includes('salesman'))
  const customers = useApiView('customers', { eq: { company_id: companyId }, order: 'name', limit: 500 })
  const lists = useApiView('price_lists', { eq: { company_id: companyId, active: true }, order: 'name' })
  const assign = useApiMutation<{ p_company_id: string; p_party_id: string; p_user_id: string | null }>('assign_salesman', REFRESH)
  const setList = useApiMutation<{ p_company_id: string; p_party_id: string; p_price_list_id: string | null }>('set_customer_price_list', REFRESH)
  const [party, setParty] = useState('')
  const [sm, setSm] = useState('')
  const [pl, setPl] = useState('')
  const current = useApiRpc<{ price_list_id: string | null; name: string | null }>('customer_price_list', { p_company_id: companyId, p_party_id: party }, Boolean(party))
  const cur = current.data?.status === 'ready' ? current.data.data : null
  return (
    <Card title={t('routeSales.assign.title')}>
      <p className="k" style={{ marginTop: 0 }}>
        {t('routeSales.assign.help')}
      </p>
      <FieldGrid cols={3}>
        <SelectField label={t('routeSales.assign.customer')} value={party} placeholder={t('routeSales.choose')} onChange={(e) => setParty(e.target.value)} options={rowsOf(customers).map((c) => ({ value: c.id, label: c.name }))} />
        <SelectField label={t('routeSales.assign.salesman')} value={sm} placeholder={salesmen.length ? t('routeSales.choose') : t('routeSales.noSalesmanRole')} onChange={(e) => setSm(e.target.value)} options={salesmen.map((p) => ({ value: p.user_id, label: p.display_name }))} />
        <div style={{ display: 'flex', alignItems: 'end' }}>
          <Button disabled={!party || !sm} busy={assign.isPending} onClick={() => assign.mutate({ p_company_id: companyId, p_party_id: party, p_user_id: sm })}>
            {t('routeSales.assign.assign')}
          </Button>
        </div>
        <SelectField label={t('routeSales.assign.priceList')} value={pl} placeholder={t('routeSales.choose')} onChange={(e) => setPl(e.target.value)} options={rowsOf(lists).map((l) => ({ value: l.id, label: l.name }))} help={party && cur ? (cur.name ? t('routeSales.assign.currentList', { name: cur.name }) : t('routeSales.assign.noList')) : undefined} />
        <div style={{ display: 'flex', alignItems: 'end' }}>
          <Button disabled={!party || !pl} busy={setList.isPending} onClick={() => setList.mutate({ p_company_id: companyId, p_party_id: party, p_price_list_id: pl })}>
            {t('routeSales.assign.setList')}
          </Button>
        </div>
      </FieldGrid>
      {assign.isSuccess ? (
        <p role="status" className="sf-alert" data-tone="success">
          {t('routeSales.assign.assigned')}
        </p>
      ) : null}
      {setList.isSuccess ? (
        <p role="status" className="sf-alert" data-tone="success">
          {t('routeSales.assign.listSet')}
        </p>
      ) : null}
      <LogisticsErrorBox error={assign.error ?? setList.error} />
    </Card>
  )
}

function DayCloses({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const q = useApiView('day_closes', { eq: { company_id: companyId }, order: 'closed_at', ascending: false, limit: 30 })
  const columns: Column<ViewRow<'day_closes'>>[] = [
    { key: 'date', header: t('routeSales.dc.date'), render: (r) => formatDate(r.close_date) },
    { key: 'who', header: t('routeSales.dc.salesman'), render: (r) => r.user_name ?? '—' },
    { key: 'visits', header: t('routeSales.dc.visits'), align: 'right', render: (r) => <span className="mono">{`${r.visits_done}/${r.visits_planned}`}</span> },
    { key: 'orders', header: t('routeSales.dc.orders'), align: 'right', render: (r) => <Amount value={r.orders_total} /> },
    { key: 'coll', header: t('routeSales.dc.collections'), align: 'right', render: (r) => <Amount value={r.collections_total} /> },
    { key: 'at', header: t('routeSales.dc.closedAt'), render: (r) => formatTime(r.closed_at) },
  ]
  return (
    <Card pad={false}>
      <div className="sf-card__head sf-card__pad" style={{ paddingBottom: 8 }}>
        <h2 className="sf-card__title">{t('routeSales.dc.title')}</h2>
      </div>
      <DataTable caption={t('routeSales.dc.title')} columns={columns} rows={rowsOf(q)} rowKey={(r) => r.id} loading={q.isLoading} empty={<EmptyState title={t('routeSales.dc.none')} />} />
    </Card>
  )
}

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiRpc, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { formatDate, formatTime } from '@/shared/format'
import { Button, Card, Chip, ConfirmDialog, DataTable, Field, FieldGrid, FormDialog, Icon, PageHeader, SelectField, Skeleton, StatusChip, type Column } from '@/ui'

type Right = ViewRow<'rights'>
type Grant = ViewRow<'special_grants'>
type Request = ViewRow<'special_grant_requests'>

interface UserLite {
  user_id: string
  display_name: string
  person_code: string | null
  status: string
  sign_in_email: string | null
  sign_in_phone: string | null
  roles: { role: string }[] | null
}

const IST = 'Asia/Kolkata'

/** "YYYY-MM-DDTHH:mm" for a datetime-local input, in IST. */
function istInput(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)
  const g = (k: string) => parts.find((p) => p.type === k)?.value ?? '00'
  const hour = g('hour') === '24' ? '00' : g('hour')
  return `${g('year')}-${g('month')}-${g('day')}T${hour}:${g('minute')}`
}
/** A datetime-local value read as IST, sent as ISO with the +05:30 offset. */
function istIso(v: string): string {
  return `${v}:00+05:30`
}
function stamp(s: string): string {
  return `${formatDate(s)} ${formatTime(s)}`
}

type UsesMode = 'any' | 'once' | 'upto'
interface Draft {
  user_id: string
  company_id: string
  starts: string
  ends: string
  entries_from: string
  entries_to: string
  books: string
  each_use: string
  uses: UsesMode
  max_uses: string
  reason: string
}
function emptyDraft(): Draft {
  return { user_id: '', company_id: '', starts: istInput(new Date()), ends: '', entries_from: '', entries_to: '', books: '', each_use: 'logged', uses: 'any', max_uses: '', reason: '' }
}

const STATE_CHIP: Record<string, { tone: 'info' | 'success' | 'neutral' | 'danger'; icon: string }> = {
  scheduled: { tone: 'info', icon: 'clock' },
  running: { tone: 'success', icon: 'check' },
  ended: { tone: 'neutral', icon: 'lock' },
  stopped: { tone: 'danger', icon: 'ban' },
}

/**
 * Special permissions (`SpecialAccess`): Admin gives a time-limited extra right with limits (api.grant_special_permission),
 * stops it (api.revoke_special_permission) and decides requests (api.decide_special_permission); others ask
 * (api.request_special_permission). Lists come from api.special_grants / api.special_grant_requests under RLS.
 */
export function SpecialAccessPage() {
  const { t } = useTranslation()
  const can = useCan()
  const { profile } = useAuth()
  const readOnly = profile?.view === 'all-readonly'
  const isAdmin = can('users.manage') && !readOnly
  const canAsk = !isAdmin && !readOnly && Boolean(profile)

  const rights = useApiView('rights', { order: 'sort' })
  const grants = useApiView('special_grants', { order: 'granted_at', ascending: false, limit: 200 })
  const requests = useApiView('special_grant_requests', { order: 'created_at', ascending: false, eq: { status: 'pending' } })
  const settings = useApiView('settings_current', { order: 'key' })
  const companies = useApiView('companies', { order: 'code' })
  const users = useApiRpc<UserLite[]>('list_users', {}, isAdmin)

  const rightList = rowsOf(rights)
  const grantable = rightList.filter((r) => r.grantable_by_permission && !r.admin_only && !r.never_grantable)
  const neverList = rightList.filter((r) => r.never_grantable)
  const [pickedKey, setPicked] = useState<string>('')
  const picked = grantable.find((r) => r.key === pickedKey) ?? grantable[0]

  const globalSettings = rowsOf(settings).filter((s) => s.company_id === null)
  const maxDaysRaw = globalSettings.find((s) => s.key === 'grants.max_days')?.value
  const maxDays = typeof maxDaysRaw === 'number' ? maxDaysRaw : typeof maxDaysRaw === 'string' && /^\d+$/.test(maxDaysRaw) ? Number(maxDaysRaw) : null

  const userList = users.data?.status === 'ready' ? (users.data.data ?? []) : []
  const officeAdminSetUp = userList.some((u) => (u.roles ?? []).some((r) => r.role === 'office_admin'))

  // Stop / decide
  const [stop, setStop] = useState<{ g: Grant; reason: string; err?: string } | null>(null)
  const [decide, setDecide] = useState<{ q: Request; approve: boolean } | null>(null)
  const revoke = useApiMutation<{ p_grant_id: string; p_reason: string }>('revoke_special_permission', [['api', 'special_grants']])
  const decideM = useApiMutation<{ p_request_id: string; p_approve: boolean; p_max_uses: number | null }>('decide_special_permission', [['api', 'special_grants'], ['api', 'special_grant_requests']])

  const grantColumns: Column<Grant>[] = [
    {
      key: 'perm',
      header: t('specialAccess.list.permission'),
      render: (g) => (
        <div>
          <div style={{ fontWeight: 600 }}>{g.right_label}</div>
          <div className="k mono">{g.code}</div>
        </div>
      ),
    },
    { key: 'to', header: t('specialAccess.list.to'), render: (g) => g.user_name ?? '—' },
    { key: 'co', header: t('specialAccess.list.company'), render: (g) => g.company_name ?? t('specialAccess.f.allCompanies') },
    {
      key: 'when',
      header: t('specialAccess.list.fromTo'),
      render: (g) => (
        <span className="mono" style={{ fontSize: 12 }}>
          {stamp(g.starts_at)} – {stamp(g.ends_at)}
        </span>
      ),
    },
    {
      key: 'uses',
      header: t('specialAccess.list.uses'),
      render: (g) => <span className="mono">{g.max_uses == null ? t('specialAccess.list.usesAny', { uses: g.uses }) : t('specialAccess.list.usesOf', { uses: g.uses, max: g.max_uses })}</span>,
    },
    {
      key: 'state',
      header: t('specialAccess.list.state'),
      render: (g) => {
        const s = STATE_CHIP[g.state ?? ''] ?? STATE_CHIP.ended!
        return (
          <Chip tone={s.tone} icon={s.icon}>
            {t(`specialAccess.state.${g.state ?? 'ended'}`)}
          </Chip>
        )
      },
    },
  ]
  if (isAdmin) {
    grantColumns.push({
      key: 'act',
      header: <span className="sr-only">{t('specialAccess.list.actions')}</span>,
      render: (g) =>
        g.state === 'running' || g.state === 'scheduled' ? (
          <Button
            size="sm"
            variant="danger"
            aria-label={t('specialAccess.list.stopLabel', { code: g.code })}
            onClick={() => {
              revoke.reset()
              setStop({ g, reason: '' })
            }}
          >
            {t('specialAccess.list.stop')}
          </Button>
        ) : null,
    })
  }

  const reqColumns: Column<Request>[] = [
    { key: 'who', header: t('specialAccess.req.who'), render: (q) => q.requested_by_name ?? '—' },
    { key: 'perm', header: t('specialAccess.req.permission'), render: (q) => q.right_label },
    {
      key: 'when',
      header: t('specialAccess.req.fromTo'),
      render: (q) => (
        <span className="mono" style={{ fontSize: 12 }}>
          {stamp(q.wanted_from)} – {stamp(q.wanted_to)}
        </span>
      ),
    },
    { key: 'reason', header: t('specialAccess.req.reason'), render: (q) => q.reason },
    { key: 'state', header: t('specialAccess.list.state'), render: () => <StatusChip status="pending" /> },
  ]
  if (isAdmin) {
    reqColumns.push({
      key: 'act',
      header: <span className="sr-only">{t('specialAccess.req.actions')}</span>,
      render: (q) => (
        <div className="sf-row" style={{ flexWrap: 'nowrap' }}>
          <Button
            size="sm"
            variant="primary"
            aria-label={t('specialAccess.req.approveLabel', { name: q.requested_by_name ?? '' })}
            onClick={() => {
              decideM.reset()
              setDecide({ q, approve: true })
            }}
          >
            {t('specialAccess.req.approve')}
          </Button>
          <Button
            size="sm"
            aria-label={t('specialAccess.req.refuseLabel', { name: q.requested_by_name ?? '' })}
            onClick={() => {
              decideM.reset()
              setDecide({ q, approve: false })
            }}
          >
            {t('specialAccess.req.refuse')}
          </Button>
        </div>
      ),
    })
  }

  const grantRows = rowsOf(grants)
  const reqRows = rowsOf(requests)

  return (
    <>
      <PageHeader title={t('specialAccess.title')} subtitle={t('specialAccess.subtitle')} />

      {readOnly ? (
        <p className="muted" style={{ margin: 0 }}>
          {t('specialAccess.readOnly')}
        </p>
      ) : isAdmin || canAsk ? (
        <div className="sf-grid-2">
          <section className="sf-card sf-card__pad" style={{ flex: '1 1 280px', maxWidth: 320 }} aria-labelledby="sa-pick">
            <h2 id="sa-pick" className="k" style={{ fontWeight: 600, margin: '0 0 8px', fontSize: 12 }}>
              {t('specialAccess.pick')}
            </h2>
            {rights.isLoading ? (
              <Skeleton height={240} />
            ) : grantable.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                {t('specialAccess.pickNone')}
              </p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {grantable.map((r) => {
                  const on = picked?.key === r.key
                  return (
                    <li key={r.key}>
                      <button
                        type="button"
                        aria-pressed={on}
                        onClick={() => setPicked(r.key)}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          padding: '9px 12px',
                          borderRadius: 6,
                          border: `1px solid ${on ? 'var(--sf-primary)' : 'var(--sf-line)'}`,
                          background: on ? 'var(--sf-primary-tint)' : 'var(--sf-surface)',
                          color: 'var(--sf-text)',
                          cursor: 'pointer',
                          font: 'inherit',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 2,
                        }}
                      >
                        <span style={{ fontWeight: 600, fontSize: 14 }}>{r.label}</span>
                        {r.hint ? <span className="k">{r.hint}</span> : null}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
          {picked ? (
            <GiveForm
              key={picked.key}
              right={picked}
              mode={isAdmin ? 'give' : 'ask'}
              users={userList.filter((u) => u.user_id !== profile?.userId && u.status === 'active')}
              usersLoading={isAdmin && users.isLoading}
              companies={rowsOf(companies).map((c) => ({ value: c.id, label: c.short_name || c.name }))}
              maxDays={maxDays}
            />
          ) : null}
        </div>
      ) : null}

      <div className="sf-grid-2">
        <div style={{ flex: '2 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card pad={false} labelledBy="sa-given">
            <div className="sf-card__pad" style={{ paddingBottom: 6 }}>
              <div className="sf-card__head" style={{ flexWrap: 'wrap', gap: 8 }}>
                <h2 id="sa-given" className="sf-card__title">
                  {t('specialAccess.list.title')}
                </h2>
                <span className="k">{t('specialAccess.list.sub')}</span>
              </div>
            </div>
            <DataTable
              caption={t('specialAccess.list.caption')}
              columns={grantColumns}
              rows={grantRows}
              rowKey={(g) => g.id}
              loading={grants.isLoading}
              minWidth={760}
              error={grants.error ? t('specialAccess.list.loadFailed') : undefined}
              empty={isAdmin ? t('specialAccess.list.empty') : t('specialAccess.list.emptyOwn')}
            />
          </Card>

          {isAdmin || reqRows.length > 0 ? (
            <Card pad={false} labelledBy="sa-req">
              <div className="sf-card__pad" style={{ paddingBottom: 6 }}>
                <div className="sf-card__head" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <h2 id="sa-req" className="sf-card__title">
                    {t('specialAccess.req.title')}
                  </h2>
                  <span className="k">{t('specialAccess.req.sub')}</span>
                </div>
              </div>
              {decideM.error ? (
                <div className="sf-card__pad" style={{ paddingTop: 0 }}>
                  <RpcErrorBox error={decideM.error as RpcError | null} />
                </div>
              ) : null}
              <DataTable caption={t('specialAccess.req.caption')} columns={reqColumns} rows={reqRows} rowKey={(q) => q.id} loading={requests.isLoading} minWidth={700} empty={t('specialAccess.req.empty')} />
            </Card>
          ) : null}
        </div>

        <section className="sf-card sf-card__pad" style={{ flex: '1 1 360px', minWidth: 0 }} aria-labelledby="sa-limits">
          <div className="sf-card__head">
            <h2 id="sa-limits" className="sf-card__title">
              {t('specialAccess.limits.title')}
            </h2>
            {can('settings.manage') && !readOnly ? (
              <Link to="/admin/settings" className="sf-btn" data-size="sm">
                {t('specialAccess.limits.change')}
              </Link>
            ) : null}
          </div>
          {settings.isLoading ? (
            <Skeleton height={160} />
          ) : (
            <dl style={{ margin: '10px 0 0', display: 'flex', flexDirection: 'column' }}>
              <LimitRow label={t('specialAccess.limits.longest')} value={maxDays != null ? t('specialAccess.limits.days', { count: maxDays }) : null} />
              {(['hours', 'backdate', 'approval', 'cashPay', 'cashReceive', 'signInFrom', 'secondOtp'] as const).map((k) => (
                <LimitRow key={k} label={t(`specialAccess.limits.${k}`)} value={null} />
              ))}
            </dl>
          )}
          <p className="k" style={{ margin: '12px 0 0' }}>
            {t('specialAccess.limits.note')}
          </p>
        </section>
      </div>

      <div className="sf-grid-2">
        <section className="sf-card sf-card__pad" style={{ flex: '1 1 420px', minWidth: 0, borderLeft: '4px solid var(--sf-danger)' }} aria-labelledby="sa-never">
          <h2 id="sa-never" className="sf-card__title">
            {t('specialAccess.never.title')}
          </h2>
          {rights.isLoading ? (
            <Skeleton height={120} />
          ) : (
            <ul style={{ listStyle: 'none', margin: '10px 0 0', padding: 0 }}>
              {neverList.map((r) => (
                <li key={r.key} className="sf-row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap', padding: '8px 0', borderTop: '1px solid var(--sf-line)', fontSize: 14 }}>
                  <span>{r.label}</span>
                  <Chip tone="danger" icon={(r.hint ?? '').startsWith('Never') ? 'ban' : 'lock'}>
                    {(r.hint ?? '').startsWith('Never') ? t('specialAccess.never.never') : t('specialAccess.never.adminOnly')}
                  </Chip>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="sf-card sf-card__pad" style={{ flex: '1 1 480px', minWidth: 0, borderLeft: '4px solid var(--sf-primary)' }} aria-labelledby="sa-office">
          <div className="sf-card__head">
            <h2 id="sa-office" className="sf-card__title">
              {t('specialAccess.office.title')}
            </h2>
            {isAdmin && users.data?.status === 'ready' ? (
              officeAdminSetUp ? (
                <Chip tone="success" icon="check">
                  {t('specialAccess.office.setUp')}
                </Chip>
              ) : (
                <Chip tone="neutral" icon="info">
                  {t('specialAccess.office.notSetUp')}
                </Chip>
              )
            ) : null}
          </div>
          <p style={{ margin: '8px 0 6px', fontSize: 14 }}>{t('specialAccess.office.lead')}</p>
          <dl style={{ margin: 0, display: 'flex', flexDirection: 'column' }}>
            {(['sees', 'can', 'cannot', 'topBar', 'every'] as const).map((k) => (
              <div key={k} className="sf-row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap', padding: '7px 0', borderTop: '1px solid var(--sf-line)', fontSize: 14, gap: 16 }}>
                <dt>{t(`specialAccess.office.${k}`)}</dt>
                <dd style={{ margin: 0, textAlign: 'right' }}>{t(`specialAccess.office.${k}V`)}</dd>
              </div>
            ))}
          </dl>
          <p className="k" style={{ margin: '10px 0 0' }}>
            {t('specialAccess.office.foot')}
          </p>
        </section>
      </div>

      <FormDialog
        open={stop !== null}
        onOpenChange={(o) => !o && setStop(null)}
        title={t('specialAccess.stop.title')}
        description={stop ? t('specialAccess.stop.effect', { code: stop.g.code, label: stop.g.right_label, name: stop.g.user_name ?? '' }) : ''}
        submitLabel={t('specialAccess.stop.confirm')}
        busy={revoke.isPending}
        onSubmit={() => {
          if (!stop) return
          if (stop.reason.trim().length < 5) return setStop({ ...stop, err: t('specialAccess.err.reason') })
          revoke.mutate({ p_grant_id: stop.g.id, p_reason: stop.reason.trim() }, { onSuccess: () => setStop(null) })
        }}
        error={<RpcErrorBox error={revoke.error as RpcError | null} />}
      >
        {stop ? <Field label={t('specialAccess.stop.reason')} value={stop.reason} onChange={(e) => setStop({ ...stop, reason: e.target.value, err: undefined })} error={stop.err} /> : null}
      </FormDialog>

      <ConfirmDialog
        open={decide !== null}
        onOpenChange={(o) => !o && setDecide(null)}
        title={decide?.approve ? t('specialAccess.req.approveTitle') : t('specialAccess.req.refuseTitle')}
        effect={
          decide
            ? decide.approve
              ? t('specialAccess.req.approveEffect', { name: decide.q.requested_by_name ?? '', label: decide.q.right_label, from: stamp(decide.q.wanted_from), to: stamp(decide.q.wanted_to) })
              : t('specialAccess.req.refuseEffect', { name: decide.q.requested_by_name ?? '', label: decide.q.right_label })
            : ''
        }
        confirmLabel={decide?.approve ? t('specialAccess.req.approve') : t('specialAccess.req.refuse')}
        danger={!decide?.approve}
        busy={decideM.isPending}
        onConfirm={() => decide && decideM.mutate({ p_request_id: decide.q.id, p_approve: decide.approve, p_max_uses: null }, { onSettled: () => setDecide(null) })}
      />
    </>
  )
}

function LimitRow({ label, value }: { label: string; value: string | null }) {
  const { t } = useTranslation()
  return (
    <div className="sf-row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap', padding: '7px 0', borderTop: '1px solid var(--sf-line)', fontSize: 14, gap: 12 }}>
      <dt>{label}</dt>
      <dd style={{ margin: 0 }} className={value ? 'mono' : 'muted'}>
        {value ?? t('specialAccess.limits.notSet')}
      </dd>
    </div>
  )
}

function GiveForm({
  right,
  mode,
  users,
  usersLoading,
  companies,
  maxDays,
}: {
  right: Right
  mode: 'give' | 'ask'
  users: UserLite[]
  usersLoading: boolean
  companies: { value: string; label: string }[]
  maxDays: number | null
}) {
  const { t } = useTranslation()
  const [d, setD] = useState<Draft>(emptyDraft)
  const [errs, setErrs] = useState<Partial<Record<keyof Draft, string>>>({})
  const give = useApiMutation<Record<string, unknown>, { id: string; code: string }>('grant_special_permission', [['api', 'special_grants']])
  const ask = useApiMutation<Record<string, unknown>, { id: string }>('request_special_permission', [['api', 'special_grant_requests']])
  const m = mode === 'give' ? give : ask
  const [done, setDone] = useState<string | null>(null)

  const userOptions = useMemo(
    () => users.map((u) => ({ value: u.user_id, label: [u.display_name, u.person_code, u.sign_in_email ?? u.sign_in_phone].filter(Boolean).join(' · ') })),
    [users],
  )

  function set<K extends keyof Draft>(k: K, v: Draft[K]) {
    setD((x) => ({ ...x, [k]: v }))
    setDone(null)
  }

  function submit() {
    const e: Partial<Record<keyof Draft, string>> = {}
    if (mode === 'give' && !d.user_id) e.user_id = t('specialAccess.err.user')
    if (!d.starts) e.starts = t('specialAccess.err.starts')
    if (!d.ends || (d.starts && d.ends <= d.starts)) e.ends = t('specialAccess.err.ends')
    if (d.uses === 'upto' && !/^[1-9]\d*$/.test(d.max_uses)) e.max_uses = t('specialAccess.err.maxUses')
    if (d.reason.trim().length < 5) e.reason = t('specialAccess.err.reason')
    setErrs(e)
    if (Object.keys(e).length) return
    const params: Record<string, string> = { each_use: d.each_use }
    if (d.entries_from) params.entries_from = d.entries_from
    if (d.entries_to) params.entries_to = d.entries_to
    if (d.books.trim()) params.books = d.books.trim()
    const maxUses = d.uses === 'any' ? null : d.uses === 'once' ? 1 : Number(d.max_uses)
    if (mode === 'give') {
      give.mutate(
        {
          p_user_id: d.user_id,
          p_right: right.key,
          p_company_id: d.company_id || null,
          p_params: params,
          p_starts_at: istIso(d.starts),
          p_ends_at: istIso(d.ends),
          p_max_uses: maxUses,
          p_reason: d.reason.trim(),
        },
        {
          onSuccess: (res) => {
            setD(emptyDraft())
            setDone(t('specialAccess.given', { code: res?.code ?? '' }))
          },
        },
      )
    } else {
      if (maxUses !== null) params.max_uses = String(maxUses)
      ask.mutate(
        { p_right: right.key, p_company_id: d.company_id || null, p_params: params, p_from: istIso(d.starts), p_to: istIso(d.ends), p_reason: d.reason.trim() },
        {
          onSuccess: () => {
            setD(emptyDraft())
            setDone(t('specialAccess.asked'))
          },
        },
      )
    }
  }

  return (
    <section className="sf-card sf-card__pad" style={{ flex: '3 1 560px', minWidth: 0 }} aria-labelledby="sa-give">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <div className="sf-card__head">
          <h2 id="sa-give" className="sf-card__title" style={{ fontSize: 18 }}>
            {mode === 'give' ? t('specialAccess.give', { label: right.label }) : t('specialAccess.ask', { label: right.label })}
          </h2>
          <StatusChip status="draft" label={t('specialAccess.draft')} />
        </div>
        {mode === 'ask' ? (
          <p className="k" style={{ margin: 0 }}>
            {t('specialAccess.askLead')}
          </p>
        ) : null}
        <FieldGrid cols={3}>
          {mode === 'give' ? (
            <SelectField
              label={t('specialAccess.f.to')}
              value={d.user_id}
              placeholder={usersLoading ? t('common.loading') : t('specialAccess.f.pickUser')}
              options={userOptions}
              onChange={(e) => set('user_id', e.target.value)}
              error={errs.user_id}
            />
          ) : null}
          <SelectField label={t('specialAccess.f.company')} value={d.company_id} options={[{ value: '', label: t('specialAccess.f.allCompanies') }, ...companies]} onChange={(e) => set('company_id', e.target.value)} />
        </FieldGrid>

        <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <legend className="sf-field__label" style={{ padding: 0, marginBottom: 6 }}>
            {t('specialAccess.f.when')}
          </legend>
          <FieldGrid cols={3}>
            <Field label={t('specialAccess.f.starts')} type="datetime-local" value={d.starts} onChange={(e) => set('starts', e.target.value)} error={errs.starts} />
            <Field label={t('specialAccess.f.ends')} type="datetime-local" value={d.ends} min={d.starts || undefined} onChange={(e) => set('ends', e.target.value)} error={errs.ends} />
          </FieldGrid>
          <span className="k">{maxDays != null ? t('specialAccess.f.longest', { count: maxDays }) : t('specialAccess.f.longestUnset')}</span>
        </fieldset>

        <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
          <legend className="sf-field__label" style={{ padding: 0, marginBottom: 6 }}>
            {t('specialAccess.f.limits')}
          </legend>
          <FieldGrid cols={3}>
            <Field label={t('specialAccess.f.entriesFrom')} type="date" value={d.entries_from} onChange={(e) => set('entries_from', e.target.value)} />
            <Field label={t('specialAccess.f.entriesTo')} type="date" value={d.entries_to} onChange={(e) => set('entries_to', e.target.value)} />
            <Field label={t('specialAccess.f.books')} placeholder={t('specialAccess.f.booksPh')} value={d.books} onChange={(e) => set('books', e.target.value)} />
          </FieldGrid>
        </fieldset>

        <FieldGrid cols={3}>
          <SelectField label={t('specialAccess.f.eachUse')} value={d.each_use} onChange={(e) => set('each_use', e.target.value)} options={[{ value: 'logged', label: t('specialAccess.f.eachUseLogged') }]} />
          <SelectField
            label={t('specialAccess.f.canBeUsed')}
            value={d.uses}
            onChange={(e) => set('uses', e.target.value as UsesMode)}
            options={[
              { value: 'any', label: t('specialAccess.f.anyTimes') },
              { value: 'once', label: t('specialAccess.f.once') },
              { value: 'upto', label: t('specialAccess.f.upTo') },
            ]}
          />
          {d.uses === 'upto' ? <Field label={t('specialAccess.f.maxUses')} type="number" inputMode="numeric" min={1} step={1} className="mono" value={d.max_uses} onChange={(e) => set('max_uses', e.target.value)} error={errs.max_uses} /> : null}
        </FieldGrid>

        <Field label={t('specialAccess.f.reason')} placeholder={t('specialAccess.f.reasonPh')} value={d.reason} onChange={(e) => set('reason', e.target.value)} error={errs.reason} />

        <RpcErrorBox error={m.error as RpcError | null} />
        {done ? (
          <span role="status" className="sf-row" style={{ color: 'var(--sf-success-ink)', fontSize: 13, gap: 6 }}>
            <Icon name="check" size={14} />
            {done}
          </span>
        ) : null}
        <div className="sf-row">
          <Button type="submit" variant="primary" busy={m.isPending}>
            {mode === 'give' ? t('specialAccess.f.submitGive') : t('specialAccess.f.submitAsk')}
          </Button>
          {mode === 'give' ? <span className="k">{t('specialAccess.f.otpNote')}</span> : null}
        </div>
        {mode === 'give' ? (
          <span className="k" style={{ marginTop: -6 }}>
            {t('specialAccess.f.whatsappNote')}
          </span>
        ) : null}
      </form>
    </section>
  )
}

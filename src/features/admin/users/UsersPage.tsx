import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth, useCan } from '@/auth/AuthProvider'
import { rowsOf, useApiRpc, useApiView, type ViewRow } from '@/data/queries'
import { useApiMutation, type RpcError } from '@/data/rpc'
import { RpcErrorBox } from '@/features/common/RpcErrorBox'
import { routeForFile } from '@/app/flows'
import { formatDate, formatTime } from '@/shared/format'
import { Button, Card, Chip, DataTable, EmptyState, Field, FieldGrid, FormDialog, Icon, PageHeader, SelectField, Skeleton, type Column } from '@/ui'
import { InfoDialog } from './InfoDialog'

type Role = ViewRow<'roles'>
type Right = ViewRow<'rights'>
type Company = ViewRow<'companies'>

interface UserRole {
  id: string
  role: string
  label: string
  company_id: string | null
  valid_to: string | null
}
export interface UserRow {
  user_id: string
  display_name: string
  person_code: string | null
  language: string
  status: string
  sign_in_email: string | null
  sign_in_phone: string | null
  last_sign_in_at: string | null
  roles: UserRole[] | null
  active_grants: number
}

const ACTIONS = ['view', 'create', 'edit', 'cancel', 'approve', 'export'] as const
const LANGS = ['en', 'ml', 'hi', 'bho'] as const

interface ProfileDraft {
  user_id: string
  display_name: string
  person_code: string
  language: string
  status: string
}
interface AssignDraft {
  user: UserRow
  role: string
  company_id: string
  valid_to: string
  reason: string
}
interface RemoveDraft {
  user: UserRow
  ur: UserRole
  reason: string
}

/**
 * Users and rights (`Users`): every sign-in account with its roles, the starting rights of each GST-view role,
 * and the special-rights catalogue. Reads api.list_users / api.roles / api.rights; Admin changes go through
 * api.update_user_profile, api.assign_role, api.remove_role and api.set_role_rights (each with a reason).
 */
export function UsersPage() {
  const { t } = useTranslation()
  const can = useCan()
  const { profile } = useAuth()
  const readOnly = profile?.view === 'all-readonly'
  const canManage = can('users.manage') && !readOnly
  const users = useApiRpc<UserRow[]>('list_users')
  const roles = useApiView('roles', { order: 'sort' })
  const rights = useApiView('rights', { order: 'sort' })
  const companies = useApiView('companies', { order: 'code' })

  const [info, setInfo] = useState(false)
  const [edit, setEdit] = useState<ProfileDraft | null>(null)
  const [assign, setAssign] = useState<AssignDraft | null>(null)
  const [remove, setRemove] = useState<RemoveDraft | null>(null)
  const [errs, setErrs] = useState<Record<string, string>>({})

  const saveProfile = useApiMutation<{ p_user_id: string; p: Record<string, unknown> }>('update_user_profile', [['api', 'list_users']])
  const assignRole = useApiMutation<{ p_user_id: string; p_role: string; p_company_id: string | null; p_valid_to: string | null; p_reason: string }>('assign_role', [['api', 'list_users']])
  const removeRole = useApiMutation<{ p_user_role_id: string; p_reason: string }>('remove_role', [['api', 'list_users']])

  const roleList = rowsOf(roles)
  const roleByKey = useMemo(() => new Map(roleList.map((r) => [r.key, r])), [roleList])
  const companyList = rowsOf(companies)
  const companyName = (id: string | null) => (id ? (companyList.find((c) => c.id === id)?.short_name ?? companyList.find((c) => c.id === id)?.name ?? '—') : t('users.allCompanies'))
  const userList = users.data?.status === 'ready' ? (users.data.data ?? []) : []
  const notReady = users.data?.status === 'not-ready'
  const loadError = users.error as { code?: string } | null
  const noRight = loadError?.code === '42501'

  function scopeText(ur: UserRole) {
    const parts = [companyName(ur.company_id)]
    if (ur.valid_to) parts.push(t('users.until', { date: formatDate(ur.valid_to) }))
    return parts.join(' · ')
  }

  const columns: Column<UserRow>[] = [
    {
      key: 'user',
      header: t('users.col.user'),
      render: (u) => (
        <div>
          <div style={{ fontWeight: 600 }}>
            {u.display_name}
            {u.user_id === profile?.userId ? <span className="k"> · {t('users.you')}</span> : null}
          </div>
          {u.person_code ? <div className="k mono">{u.person_code}</div> : null}
        </div>
      ),
    },
    {
      key: 'role',
      header: t('users.col.role'),
      render: (u) => {
        const list = u.roles ?? []
        if (list.length === 0) return <span className="muted">{t('users.noRole')}</span>
        return (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {list.map((ur) => (
              <li key={ur.id} className="sf-row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                <span>
                  {ur.label}
                  <span className="k"> · {scopeText(ur)}</span>
                </span>
                {canManage ? (
                  <button
                    type="button"
                    className="sf-btn"
                    data-variant="link"
                    data-size="sm"
                    style={{ minWidth: 24, minHeight: 24, padding: 0, justifyContent: 'center' }}
                    aria-label={t('users.removeRole', { role: ur.label })}
                    title={t('users.removeRole', { role: ur.label })}
                    onClick={() => {
                      removeRole.reset()
                      setErrs({})
                      setRemove({ user: u, ur, reason: '' })
                    }}
                  >
                    <Icon name="close" size={14} />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )
      },
    },
    {
      key: 'signin',
      header: t('users.col.signIn'),
      render: (u) => (u.sign_in_email || u.sign_in_phone ? <span className="mono" style={{ fontSize: 12 }}>{u.sign_in_email ?? u.sign_in_phone}</span> : <span className="muted">{t('users.noSignIn')}</span>),
    },
    {
      key: 'last',
      header: t('users.col.lastActive'),
      render: (u) => (u.last_sign_in_at ? <span className="mono">{`${formatDate(u.last_sign_in_at)} ${formatTime(u.last_sign_in_at)}`}</span> : t('users.never')),
    },
    {
      key: 'special',
      header: t('users.col.special'),
      render: (u) => {
        const all = (u.roles ?? []).some((ur) => roleByKey.get(ur.role)?.view_kind === 'all')
        if (all) return t('users.allRights')
        return u.active_grants > 0 ? t('users.running', { count: u.active_grants }) : '—'
      },
    },
    {
      key: 'status',
      header: t('users.col.status'),
      render: (u) =>
        u.status !== 'active' ? (
          <Chip tone="neutral" icon="ban">
            {t('users.statusDisabled')}
          </Chip>
        ) : (u.roles ?? []).length === 0 ? (
          <Chip tone="signal" icon="alert">
            {t('users.noRole')}
          </Chip>
        ) : (
          <Chip tone="success" icon="check">
            {t('users.statusActive')}
          </Chip>
        ),
    },
  ]
  if (canManage) {
    columns.push({
      key: 'actions',
      header: <span className="sr-only">{t('users.col.actions')}</span>,
      render: (u) => (
        <div className="sf-row" style={{ flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
          <Button
            size="sm"
            aria-label={`${t('users.addRole')} · ${u.display_name}`}
            onClick={() => {
              assignRole.reset()
              setErrs({})
              setAssign({ user: u, role: '', company_id: '', valid_to: '', reason: '' })
            }}
          >
            {t('users.addRole')}
          </Button>
          <Button
            size="sm"
            aria-label={`${t('users.editUser')} · ${u.display_name}`}
            onClick={() => {
              saveProfile.reset()
              setErrs({})
              setEdit({ user_id: u.user_id, display_name: u.display_name, person_code: u.person_code ?? '', language: u.language, status: u.status })
            }}
          >
            {t('users.editUser')}
          </Button>
        </div>
      ),
    })
  }

  function submitEdit() {
    if (!edit) return
    if (edit.display_name.trim().length < 1) return setErrs({ display_name: t('users.edit.nameErr') })
    setErrs({})
    const p: Record<string, unknown> = { display_name: edit.display_name.trim(), person_code: edit.person_code.trim(), language: edit.language }
    if (edit.user_id !== profile?.userId) p.status = edit.status
    saveProfile.mutate({ p_user_id: edit.user_id, p }, { onSuccess: () => setEdit(null) })
  }

  function submitAssign() {
    if (!assign) return
    const e: Record<string, string> = {}
    const r = roleByKey.get(assign.role)
    if (!r) e.role = t('users.assign.roleErr')
    if (r?.view_kind === 'all-readonly' && !assign.valid_to) e.valid_to = t('users.assign.validToErr')
    if (assign.reason.trim().length < 5) e.reason = t('users.assign.reasonErr')
    setErrs(e)
    if (Object.keys(e).length) return
    assignRole.mutate(
      {
        p_user_id: assign.user.user_id,
        p_role: assign.role,
        p_company_id: assign.company_id || null,
        p_valid_to: assign.valid_to ? `${assign.valid_to}T23:59:59+05:30` : null,
        p_reason: assign.reason.trim(),
      },
      { onSuccess: () => setAssign(null) },
    )
  }

  function submitRemove() {
    if (!remove) return
    if (remove.reason.trim().length < 5) return setErrs({ reason: t('users.assign.reasonErr') })
    setErrs({})
    removeRole.mutate({ p_user_role_id: remove.ur.id, p_reason: remove.reason.trim() }, { onSuccess: () => setRemove(null) })
  }

  return (
    <>
      <PageHeader
        title={t('users.title')}
        subtitle={t('users.subtitle')}
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setInfo(true)}>
              <Icon name="plus" size={16} />
              {t('users.add')}
            </Button>
          ) : null
        }
      />

      <Card pad={false}>
        {noRight ? (
          <p className="sf-card__pad muted" style={{ margin: 0 }}>
            {t('users.noAccess')}
          </p>
        ) : (
          <DataTable
            caption={t('users.tableCaption')}
            columns={columns}
            rows={userList}
            rowKey={(u) => u.user_id}
            loading={users.isLoading}
            minWidth={980}
            error={loadError ? t('users.loadFailed') : undefined}
            empty={<EmptyState title={t('users.emptyTitle')} body={notReady ? t('users.notReady') : t('users.emptyBody')} />}
          />
        )}
        <div className="sf-card__pad" style={{ borderTop: '1px solid var(--sf-line)', fontSize: 13, color: 'var(--sf-text-2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="sf-row" style={{ gap: 24 }}>
            <span>
              <strong>{t('users.signInNote.everyone')}</strong> {t('users.signInNote.everyoneText')}
            </span>
            <span>
              <strong>{t('users.signInNote.admin')}</strong> {t('users.signInNote.adminText')}
            </span>
          </div>
          <span>{t('users.signInNote.kyc')}</span>
        </div>
      </Card>

      {roles.isLoading || rights.isLoading ? (
        <Card>
          <Skeleton height={160} />
        </Card>
      ) : (
        <RoleRights roles={roleList} rights={rowsOf(rights)} canManage={canManage} />
      )}

      <InfoDialog open={info} onOpenChange={setInfo} title={t('users.addUser.title')} closeLabel={t('users.addUser.ok')}>
        <span>{t('users.addUser.lead')}</span>
        <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <li>{t('users.addUser.dashboard')}</li>
          <li>{t('users.addUser.edge')}</li>
        </ol>
        <span>{t('users.addUser.after')}</span>
      </InfoDialog>

      <FormDialog
        open={edit !== null}
        onOpenChange={(o) => !o && setEdit(null)}
        title={t('users.edit.title')}
        description={t('users.edit.help')}
        submitLabel={t('common.save')}
        busy={saveProfile.isPending}
        onSubmit={submitEdit}
        error={<RpcErrorBox error={saveProfile.error as RpcError | null} />}
      >
        {edit ? (
          <FieldGrid>
            <Field label={t('users.edit.name')} value={edit.display_name} onChange={(e) => setEdit({ ...edit, display_name: e.target.value })} error={errs.display_name} />
            <Field label={t('users.edit.personCode')} className="mono" value={edit.person_code} onChange={(e) => setEdit({ ...edit, person_code: e.target.value })} help={t('users.edit.personCodeHelp')} />
            <SelectField label={t('users.edit.language')} value={edit.language} onChange={(e) => setEdit({ ...edit, language: e.target.value })} options={LANGS.map((l) => ({ value: l, label: t(`users.lang.${l}`) }))} />
            <SelectField
              label={t('users.edit.status')}
              value={edit.status}
              disabled={edit.user_id === profile?.userId}
              onChange={(e) => setEdit({ ...edit, status: e.target.value })}
              options={[
                { value: 'active', label: t('users.statusActive') },
                { value: 'disabled', label: t('users.statusDisabled') },
              ]}
            />
          </FieldGrid>
        ) : null}
      </FormDialog>

      <FormDialog
        open={assign !== null}
        onOpenChange={(o) => !o && setAssign(null)}
        title={assign ? t('users.assign.title', { name: assign.user.display_name }) : ''}
        description={t('users.assign.help')}
        submitLabel={t('users.addRole')}
        busy={assignRole.isPending}
        onSubmit={submitAssign}
        error={<RpcErrorBox error={assignRole.error as RpcError | null} />}
        wide
      >
        {assign ? (
          <>
            <FieldGrid>
              <SelectField label={t('users.assign.role')} value={assign.role} placeholder={t('users.assign.pick')} onChange={(e) => setAssign({ ...assign, role: e.target.value })} options={roleList.map((r) => ({ value: r.key, label: r.label }))} error={errs.role} />
              <SelectField label={t('users.assign.company')} value={assign.company_id} onChange={(e) => setAssign({ ...assign, company_id: e.target.value })} options={[{ value: '', label: t('users.allCompanies') }, ...companyList.map((c: Company) => ({ value: c.id, label: c.short_name || c.name }))]} />
              <Field label={t('users.assign.validTo')} type="date" value={assign.valid_to} onChange={(e) => setAssign({ ...assign, valid_to: e.target.value })} error={errs.valid_to} help={t('users.assign.validToHelp')} />
            </FieldGrid>
            <Field label={t('users.assign.reason')} value={assign.reason} onChange={(e) => setAssign({ ...assign, reason: e.target.value })} error={errs.reason} />
          </>
        ) : null}
      </FormDialog>

      <FormDialog
        open={remove !== null}
        onOpenChange={(o) => !o && setRemove(null)}
        title={t('users.remove.title')}
        description={remove ? t('users.remove.effect', { role: remove.ur.label, scope: scopeText(remove.ur), name: remove.user.display_name }) : ''}
        submitLabel={t('users.remove.confirm')}
        busy={removeRole.isPending}
        onSubmit={submitRemove}
        error={<RpcErrorBox error={removeRole.error as RpcError | null} />}
      >
        {remove ? <Field label={t('users.assign.reason')} value={remove.reason} onChange={(e) => setRemove({ ...remove, reason: e.target.value })} error={errs.reason} /> : null}
      </FormDialog>
    </>
  )
}

/** Role picker + module × action matrix + special-rights list, saved together through api.set_role_rights. */
function RoleRights({ roles, rights, canManage }: { roles: Role[]; rights: Right[]; canManage: boolean }) {
  const { t } = useTranslation()
  const gstRoles = roles.filter((r) => r.view_kind === 'gst')
  const [roleKey, setRoleKey] = useState<string>(() => gstRoles.find((r) => r.key === 'accountant')?.key ?? gstRoles[0]?.key ?? '')
  const role = gstRoles.find((r) => r.key === roleKey)
  if (!role) {
    return (
      <Card>
        <p className="muted" style={{ margin: 0 }}>
          {t('users.matrix.noRoles')}
        </p>
      </Card>
    )
  }
  return <RoleRightsEditor key={role.key} role={role} roles={gstRoles} onRole={setRoleKey} rights={rights} canManage={canManage} />
}

function RoleRightsEditor({ role, roles, onRole, rights, canManage }: { role: Role; roles: Role[]; onRole: (k: string) => void; rights: Right[]; canManage: boolean }) {
  const { t } = useTranslation()
  const initial = useMemo(() => new Set(role.rights ?? []), [role.rights])
  const [sel, setSel] = useState<Set<string>>(() => new Set(initial))
  const [reason, setReason] = useState('')
  const [reasonErr, setReasonErr] = useState<string | undefined>()
  const save = useApiMutation<{ p_role: string; p_rights: string[]; p_reason: string }>('set_role_rights', [['api', 'roles']])

  const moduleRights = rights.filter((r) => r.kind === 'module')
  const specials = rights.filter((r) => r.kind === 'special')
  const modules: { module: string; label: string; cells: Map<string, Right> }[] = []
  const extras: Right[] = []
  for (const r of moduleRights) {
    if (!(ACTIONS as readonly string[]).includes(r.action)) {
      extras.push(r)
      continue
    }
    let m = modules.find((x) => x.module === r.module)
    if (!m) {
      m = { module: r.module, label: r.label.split(' · ')[0] ?? r.label, cells: new Map() }
      modules.push(m)
    }
    m.cells.set(r.action, r)
  }
  const locked = (r: Right) => r.admin_only || r.never_grantable
  const dirty = sel.size !== initial.size || [...sel].some((k) => !initial.has(k))

  function toggle(key: string, on: boolean) {
    const next = new Set(sel)
    if (on) next.add(key)
    else next.delete(key)
    setSel(next)
    save.reset()
  }
  function submit() {
    if (reason.trim().length < 5) return setReasonErr(t('users.assign.reasonErr'))
    setReasonErr(undefined)
    save.mutate({ p_role: role.key, p_rights: [...sel].sort(), p_reason: reason.trim() })
  }

  const cb = (r: Right) => (
    <label style={{ display: 'inline-flex', padding: 3, cursor: canManage ? 'pointer' : 'default' }}>
      <input
        type="checkbox"
        aria-label={r.label}
        checked={sel.has(r.key)}
        disabled={!canManage || locked(r)}
        onChange={(e) => toggle(r.key, e.target.checked)}
        style={{ width: 18, height: 18, margin: 0, accentColor: 'var(--sf-primary)' }}
      />
    </label>
  )

  return (
    <div className="sf-grid-2">
      <section className="sf-card" style={{ flex: '2 1 560px', minWidth: 0 }} aria-labelledby="role-rights-title">
        <div className="sf-card__pad" style={{ paddingBottom: 8 }}>
          <div className="sf-card__head" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <h2 id="role-rights-title" className="sf-card__title">
                {t('users.matrix.title', { role: role.label })}
              </h2>
              <p className="k" style={{ margin: '4px 0 0' }}>
                {t('users.matrix.sub')}
              </p>
            </div>
            <div style={{ minWidth: 220 }}>
              <SelectField label={t('users.matrix.role')} value={role.key} onChange={(e) => onRole(e.target.value)} options={roles.map((r) => ({ value: r.key, label: r.label }))} />
            </div>
          </div>
          <p className="k" style={{ margin: '8px 0 0' }}>
            {t('users.matrix.fixed')}
          </p>
        </div>
        <div className="sf-table-wrap">
          <table className="sf-table">
            <caption className="sr-only">{t('users.matrix.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('users.matrix.module')}</th>
                {ACTIONS.map((a) => (
                  <th key={a} scope="col" style={{ textAlign: 'center' }}>
                    {t(`users.matrix.action.${a}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {modules.map((m) => (
                <tr key={m.module}>
                  <th scope="row" style={{ fontWeight: 600, textAlign: 'left' }}>
                    {m.label}
                  </th>
                  {ACTIONS.map((a) => {
                    const r = m.cells.get(a)
                    return (
                      <td key={a} style={{ textAlign: 'center' }}>
                        {r ? cb(r) : null}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {extras.length ? (
          <div className="sf-card__pad" style={{ borderTop: '1px solid var(--sf-line)' }}>
            <div className="k" style={{ fontWeight: 600, marginBottom: 6 }}>
              {t('users.matrix.also')}
            </div>
            <div className="sf-row" style={{ gap: 16 }}>
              {extras.map((r) => (
                <span key={r.key} className="sf-row" style={{ gap: 2, flexWrap: 'nowrap', fontSize: 13 }}>
                  {cb(r)}
                  <span aria-hidden="true">{r.label}</span>
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {!canManage ? (
          <p className="sf-card__pad muted" style={{ margin: 0, borderTop: '1px solid var(--sf-line)' }}>
            {t('users.matrix.readOnly')}
          </p>
        ) : null}
      </section>

      <section className="sf-card sf-card__pad" style={{ flex: '1 1 340px', minWidth: 0 }} aria-labelledby="special-rights-title">
        <h2 id="special-rights-title" className="sf-card__title">
          {t('users.special.title')}
        </h2>
        <p className="k" style={{ margin: '4px 0 12px' }}>
          {t('users.special.lead')} <Link to={routeForFile('SpecialAccess')}>{t('users.special.link')}</Link>.
        </p>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {specials.map((r) => (
            <li
              key={r.key}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                padding: '5px 8px',
                borderRadius: 6,
                background: sel.has(r.key) ? 'var(--sf-primary-tint)' : undefined,
              }}
            >
              {cb(r)}
              <span style={{ display: 'flex', flexDirection: 'column', flex: 1, paddingTop: 2 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }} aria-hidden="true">
                  {r.label}
                </span>
                {r.hint ? <span className="k">{r.hint}</span> : null}
              </span>
              {r.never_grantable ? (
                <Chip tone="danger" icon="ban">
                  {(r.hint ?? '').startsWith('Never') ? t('users.special.never') : t('users.special.adminOnly')}
                </Chip>
              ) : r.admin_only ? (
                <Chip tone="neutral" icon="lock">
                  {t('users.special.adminOnly')}
                </Chip>
              ) : null}
            </li>
          ))}
        </ul>
        {canManage ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
            <Field label={t('users.special.reason')} placeholder={t('users.special.reasonPh')} value={reason} onChange={(e) => setReason(e.target.value)} error={reasonErr} />
            <RpcErrorBox error={save.error as RpcError | null} />
            {save.isSuccess && !dirty ? (
              <span role="status" className="sf-row" style={{ color: 'var(--sf-success-ink)', fontSize: 13, gap: 6 }}>
                <Icon name="check" size={14} />
                {t('users.special.saved')}
              </span>
            ) : null}
            <Button variant="primary" onClick={submit} busy={save.isPending} disabled={!dirty}>
              {t('users.special.save')}
            </Button>
            <span className="k">{dirty ? t('users.special.otpNote') : t('users.special.noChange')}</span>
          </div>
        ) : null}
      </section>
    </div>
  )
}

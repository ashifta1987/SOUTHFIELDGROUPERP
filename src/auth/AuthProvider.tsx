import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { useQuery } from '@tanstack/react-query'
import { api, isNotReady, supabase, supabaseConfigured } from '@/shared/supabase'

/**
 * The three views (§6, §UX-5). The view always comes from the server, never from a client toggle:
 * `api.me()` computes it from core.user_roles (Phase 1). Before `api.me()` answers, the server-set
 * `app_metadata.role` is used as a first guess (users cannot edit it).
 */
export type ViewKind = 'all' | 'all-readonly' | 'gst'

export type RoleKey =
  | 'owner'
  | 'admin'
  | 'md'
  | 'gm'
  | 'finance_head'
  | 'accountant'
  | 'office_admin'
  | 'ca'
  | 'auditor'
  | 'staff'
  | string

export interface ActiveGrant {
  id: string
  code: string
  right: string
  label: string
  company_id: string | null
  params: Record<string, unknown>
  ends_at: string
}

export interface MeRole {
  role: string
  label: string
  company_id: string | null
  valid_to: string | null
}

/** Shape returned by api.me() */
export interface Me {
  user_id: string
  display_name: string | null
  person_code: string | null
  language: string | null
  status: string | null
  view: ViewKind
  roles: MeRole[]
  rights: string[]
  grants: ActiveGrant[]
  read_only_until: string | null
  /** Phase 9: the session's assurance level and whether the server wants the second factor now. */
  aal?: 'aal1' | 'aal2' | string
  mfa_required?: boolean
  mfa_enforced?: boolean
  /** True when security.enforce_mfa is on, the account has an MFA role and this session is not aal2. */
  mfa_needed?: boolean
}

export interface Profile {
  userId: string
  displayName: string
  role: RoleKey
  roleLabel: string
  view: ViewKind
  /** ISO date until which a CA/auditor has read-only access */
  readOnlyUntil?: string
  language?: string
  email?: string
  phone?: string
  /** Rights from the server ('*' = everything; '*.view' / '*.export' for read-only) */
  rights: string[]
  grants: ActiveGrant[]
  roles: MeRole[]
  personCode?: string
  /** True once api.me() has answered */
  fromServer: boolean
}

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  md: 'Managing Director',
  gm: 'General Manager',
  finance_head: 'Finance Head',
  accountant: 'Accountant',
  office_admin: 'Office admin',
  ca: 'CA',
  auditor: 'Auditor',
  staff: 'Staff',
}

export function viewForRole(role: RoleKey): ViewKind {
  if (role === 'owner' || role === 'admin') return 'all'
  if (role === 'ca' || role === 'auditor') return 'all-readonly'
  return 'gst'
}

export function profileFromUser(user: User): Profile {
  const app = (user.app_metadata ?? {}) as Record<string, unknown>
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>
  const role = typeof app.role === 'string' ? app.role : 'staff'
  const fullName = typeof meta.full_name === 'string' && meta.full_name.trim() ? meta.full_name.trim() : undefined
  const displayName = fullName ?? user.email?.split('@')[0] ?? (user.phone ? `••${user.phone.slice(-4)}` : 'User')
  return {
    userId: user.id,
    displayName,
    role,
    roleLabel: ROLE_LABELS[role] ?? role,
    view: viewForRole(role),
    readOnlyUntil: typeof app.read_only_until === 'string' ? app.read_only_until : undefined,
    language: typeof meta.language === 'string' ? meta.language : undefined,
    email: user.email ?? undefined,
    phone: user.phone ?? undefined,
    rights: viewForRole(role) === 'all' ? ['*'] : viewForRole(role) === 'all-readonly' ? ['*.view', '*.export'] : ['home.view', 'staff.self'],
    grants: [],
    roles: [],
    fromServer: false,
  }
}

/** Merge api.me() into the profile. The server's view, roles, rights and grants always win. */
export function profileFromMe(user: User, me: Me): Profile {
  const base = profileFromUser(user)
  const top = me.roles[0]
  const role = me.view === 'all' ? (me.roles.find((r) => r.role === 'owner') ? 'owner' : 'admin') : me.view === 'all-readonly' ? (top?.role ?? 'ca') : (top?.role ?? 'staff')
  return {
    ...base,
    displayName: me.display_name ?? base.displayName,
    role,
    roleLabel: me.roles.find((r) => r.role === role)?.label ?? ROLE_LABELS[role] ?? role,
    view: me.view,
    readOnlyUntil: me.read_only_until ?? undefined,
    language: me.language ?? base.language,
    rights: me.rights,
    grants: me.grants,
    roles: me.roles,
    personCode: me.person_code ?? undefined,
    fromServer: true,
  }
}

/** Does a rights list allow this right? Supports '*', '*.view', '*.export'. */
export function rightsAllow(rights: string[], right: string): boolean {
  if (rights.includes('*') || rights.includes(right)) return true
  const action = right.split('.')[1]
  return Boolean(action && rights.includes(`*.${action}`))
}

/**
 * Investor-portal user (Phase 7, §19): every role api.me() returns is `investor`; before a company role exists, the
 * server-set `app_metadata.role` decides. Such users see only the portal; routing only — RLS and RPCs are the security.
 */
export function isInvestorOnly(user: User | null | undefined, profile: Profile | null | undefined): boolean {
  if (!user) return false
  const roles = profile?.fromServer ? profile.roles : []
  if (roles.length) return roles.every((r) => r.role === 'investor')
  return (user.app_metadata as Record<string, unknown> | undefined)?.role === 'investor'
}

interface AuthState {
  loading: boolean
  session: Session | null
  profile: Profile | null
  /** True when the account has a verified MFA factor but this session hasn't passed it yet. */
  needsMfa: boolean
  refreshMfa: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(supabaseConfigured)
  const [session, setSession] = useState<Session | null>(null)
  const [needsMfa, setNeedsMfa] = useState(false)

  async function refreshMfa() {
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    setNeedsMfa(Boolean(data && data.nextLevel === 'aal2' && data.currentLevel !== 'aal2'))
  }

  useEffect(() => {
    if (!supabaseConfigured) return
    let active = true
    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return
      setSession(data.session)
      if (data.session) await refreshMfa()
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      // Defer: calling auth methods inside this callback can deadlock supabase-js.
      // Session and MFA state are set together so guards never see a half-updated state.
      setTimeout(async () => {
        if (!active) return
        if (next) {
          const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
          setNeedsMfa(Boolean(data && data.nextLevel === 'aal2' && data.currentLevel !== 'aal2'))
        } else {
          setNeedsMfa(false)
        }
        setSession(next)
      }, 0)
    })
    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [])

  const me = useQuery({
    // Keyed on the access token too: after the TOTP step the new aal2 token must be re-checked by the server.
    queryKey: ['api', 'me', session?.user.id ?? 'none', session?.access_token ?? ''],
    enabled: Boolean(session),
    // Keep the last answer while a refreshed token is re-checked, but never across users.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === session?.user.id ? prev : undefined),
    staleTime: 60_000,
    refetchInterval: 60_000, // grants start and end on their own; refresh the banner and menus
    queryFn: async (): Promise<Me | null> => {
      const { data, error } = await api().rpc('me')
      if (error) {
        if (isNotReady(error)) return null
        throw error
      }
      return data as Me | null
    },
  })

  const value = useMemo<AuthState>(
    () => ({
      loading: loading || (Boolean(session) && me.isLoading),
      session,
      profile: session?.user ? (me.data ? profileFromMe(session.user, me.data) : profileFromUser(session.user)) : null,
      // The factor check from supabase-js, or the server's MFA enforcement (security.enforce_mfa) via api.me().
      needsMfa: needsMfa || Boolean(me.data?.mfa_needed),
      refreshMfa,
      signOut: async () => {
        await supabase.auth.signOut()
      },
    }),
    [loading, session, needsMfa, me.data, me.isLoading],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

/**
 * Rights check for showing menus and buttons. Hiding is never the security: RLS and RPCs check again.
 * Rights come from api.me(): role rights for the user's companies plus running special permissions.
 */
export function useCan() {
  const { profile } = useAuth()
  return (right: string): boolean => {
    if (!profile) return false
    if (rightsAllow(profile.rights, right)) return true
    return profile.grants.some((g) => g.right === right)
  }
}

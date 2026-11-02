import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase, supabaseConfigured } from '@/shared/supabase'

/**
 * The three views (§6, §UX-5). The view always comes from the server, never from a client toggle.
 * Phase 0: derived from `app_metadata.role`, which only the service role can set (users cannot edit it).
 * Phase 1 replaces this with `api.me()` reading core.user_roles, rights and special-permission grants.
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
  }
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

  const value = useMemo<AuthState>(
    () => ({
      loading,
      session,
      profile: session?.user ? profileFromUser(session.user) : null,
      needsMfa,
      refreshMfa,
      signOut: async () => {
        await supabase.auth.signOut()
      },
    }),
    [loading, session, needsMfa],
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
 * Phase 0: Owner/Admin/CA see every menu (CA read-only); other roles see Home and their phone app.
 * Phase 1 replaces this with the role → rights (module.action) table.
 */
export function useCan() {
  const { profile } = useAuth()
  return (right: string): boolean => {
    if (!profile) return false
    if (profile.view === 'all' || profile.view === 'all-readonly') {
      return profile.view === 'all' || right.endsWith('.view')
    }
    return right === 'home.view' || right.startsWith('staff.')
  }
}

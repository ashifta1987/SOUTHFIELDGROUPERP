import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { isInvestorOnly, useAuth } from './AuthProvider'
import { landingFor } from '@/features/auth/authActions'
import { Skeleton } from '@/ui'

/**
 * Route guard: signed in, MFA passed when the account has a factor. RLS remains the real security.
 * `portal="investor"` marks the investor portal: investors stay inside it, and everyone else is sent to their own home;
 * an investor opening any other route is sent back to /investor/home.
 */
export function RequireAuth({ children, signInPath = '/sign-in', portal }: { children: ReactNode; signInPath?: string; portal?: 'investor' }) {
  const { t } = useTranslation()
  const { loading, session, needsMfa, profile } = useAuth()
  const location = useLocation()
  if (loading) {
    return (
      <div style={{ padding: 32, display: 'flex', flexDirection: 'column', gap: 12 }} aria-busy="true" aria-label={t('common.loading')}>
        <Skeleton width={220} height={28} />
        <Skeleton height={80} />
        <Skeleton height={200} />
      </div>
    )
  }
  if (!session || needsMfa) return <Navigate to={signInPath} replace state={{ from: location.pathname }} />
  const investor = isInvestorOnly(session.user, profile)
  if (portal === 'investor' && !investor) {
    const home = landingFor(profile?.role)
    return <Navigate to={home.startsWith('/investor') ? '/' : home} replace />
  }
  if (portal !== 'investor' && investor) return <Navigate to="/investor/home" replace />
  return <>{children}</>
}

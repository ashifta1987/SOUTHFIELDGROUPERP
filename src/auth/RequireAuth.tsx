import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from './AuthProvider'
import { Skeleton } from '@/ui'

/** Route guard: signed in, MFA passed when the account has a factor. RLS remains the real security. */
export function RequireAuth({ children, signInPath = '/sign-in' }: { children: ReactNode; signInPath?: string }) {
  const { t } = useTranslation()
  const { loading, session, needsMfa } = useAuth()
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
  return <>{children}</>
}

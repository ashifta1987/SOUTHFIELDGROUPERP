import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthProvider'
import { Icon } from '@/ui'

function left(ms: number): string {
  if (ms <= 0) return '0:00'
  const total = Math.floor(ms / 1000)
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (d > 0) return `${d}d ${h}h ${String(m).padStart(2, '0')}m`
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** Slim amber banner while the user acts under a time-limited grant (§UX-5), with a live countdown. */
export function GrantBanner() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const [now, setNow] = useState(() => Date.now())
  const grants = profile?.grants ?? []
  useEffect(() => {
    if (grants.length === 0) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [grants.length])
  if (grants.length === 0) return null
  return (
    <>
      {grants.map((g) => (
        <div key={g.id} className="sf-banner" data-tone="signal" role="status">
          <Icon name="clock" size={14} />
          <span>
            {t('grants.banner', { label: g.label, code: g.code })}
            {Object.keys(g.params ?? {}).length > 0 ? ` · ${Object.entries(g.params).map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}` : ''}
          </span>
          <span className="mono" style={{ marginLeft: 'auto' }} aria-label={t('grants.timeLeft')}>
            {left(new Date(g.ends_at).getTime() - now)}
          </span>
        </div>
      ))}
    </>
  )
}

import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthProvider'
import { initials } from '@/shared/format'
import { BottomNav, Icon, OfflineBadge } from '@/ui'
import { useInvestorMe } from './investor'

/** True when the window is at least `px` wide (desktop investor view, InvestorGroup). */
export function useWide(px = 834): boolean {
  const query = `(min-width: ${px}px)`
  const [wide, setWide] = useState(() => (typeof window === 'undefined' ? false : window.matchMedia(query).matches))
  useEffect(() => {
    const m = window.matchMedia(query)
    const on = () => setWide(m.matches)
    on()
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [query])
  return wide
}

const NAV = [
  { to: '/investor/home', key: 'today', icon: 'home' },
  { to: '/investor/performance', key: 'performance', icon: 'flow' },
  { to: '/investor/investment', key: 'investment', icon: 'rupee' },
  { to: '/investor/projects', key: 'projects', icon: 'file' },
  { to: '/investor/withdraw', key: 'requests', icon: 'clipboard' },
] as const

/**
 * Investor portal shell (§UX-4.2, §19): its own look, no ERP sidebar and no links into the ERP. Phone: header and bottom
 * tabs (Today, Performance, Investment, Projects, Requests). Wide screens: the same tabs plus Group in the header.
 * Analytics only; the one action anywhere in the portal is sending a request to Admin.
 */
export function InvestorShell() {
  const { t } = useTranslation()
  const wide = useWide()
  const { signOut, profile } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { me } = useInvestorMe()
  const name = me?.display_name ?? profile?.displayName ?? ''
  const isGroup = pathname.startsWith('/investor/group')
  const requestsActive = pathname.startsWith('/investor/withdraw') || pathname.startsWith('/investor/loan')

  async function onSignOut() {
    await signOut()
    navigate('/investor/sign-in', { replace: true })
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--sf-paper)', color: 'var(--sf-text)' }}>
      <a href="#investor-main" className="skip-link">
        {t('shell.skip')}
      </a>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: wide ? 24 : 10,
          padding: wide ? '12px 32px' : '12px 14px',
          background: 'var(--sf-surface)',
          borderBottom: '1px solid var(--sf-line)',
          position: 'sticky',
          top: 0,
          zIndex: 5,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
          <img src="/brand/southfield-group-logo.png" alt={t('brand.group')} height={28} style={{ height: 28, width: 'auto', display: 'block' }} />
          <span
            style={{ padding: '2px 8px', borderRadius: 'var(--sf-radius-chip)', background: 'var(--sf-navy)', color: 'var(--sf-surface)', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em' }}
          >
            {t('investor.badge')}
          </span>
        </span>
        {wide ? (
          <nav aria-label={t('investor.nav.label')} style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {[{ to: '/investor/group', key: 'group' }, ...NAV].map((n) => {
              const active = n.key === 'requests' ? requestsActive : pathname.startsWith(n.to)
              return (
                <NavLink
                  key={n.to}
                  to={n.to}
                  aria-current={active ? 'page' : undefined}
                  style={{
                    padding: '8px 12px',
                    minHeight: 24,
                    borderRadius: 'var(--sf-radius-input)',
                    textDecoration: 'none',
                    fontSize: 14,
                    fontWeight: active ? 600 : 500,
                    color: 'var(--sf-text)',
                    background: active ? 'var(--sf-navy-tint)' : 'transparent',
                  }}
                >
                  {t(`investor.nav.${n.key}`)}
                </NavLink>
              )
            })}
          </nav>
        ) : null}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <OfflineBadge />
          <span
            aria-hidden="true"
            style={{
              width: 36,
              height: 36,
              borderRadius: 'var(--sf-radius-chip)',
              background: 'var(--sf-navy-tint)',
              color: 'var(--sf-navy)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            {name ? initials(name) : ''}
          </span>
          {wide ? <span style={{ fontSize: 13 }}>{t('investor.who', { name })}</span> : null}
          <button
            type="button"
            onClick={() => void onSignOut()}
            aria-label={t('investor.signOut')}
            title={t('investor.signOut')}
            style={{ width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 0, background: 'transparent', color: 'var(--sf-text-2)', cursor: 'pointer', borderRadius: 10 }}
          >
            <Icon name="logout" size={20} />
          </button>
        </span>
      </header>
      <main
        id="investor-main"
        tabIndex={-1}
        style={{
          flex: '1 1 0%',
          width: '100%',
          boxSizing: 'border-box',
          margin: '0 auto',
          maxWidth: isGroup ? 'var(--sf-main-max)' : wide ? 640 : 480,
          padding: isGroup && wide ? 'var(--sf-main-pad)' : '14px 14px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          fontSize: isGroup ? 'var(--sf-fs-body)' : 15,
        }}
      >
        <Outlet />
      </main>
      {!wide ? (
        <div style={{ position: 'sticky', bottom: 0 }}>
          <BottomNav label={t('investor.nav.label')} items={NAV.map((n) => ({ to: n.to, label: t(`investor.nav.${n.key}`), icon: n.icon }))} />
        </div>
      ) : null}
    </div>
  )
}

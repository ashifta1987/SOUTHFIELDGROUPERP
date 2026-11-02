import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthProvider'
import { useCompanies } from '@/data/queries'
import { financialYear, initials } from '@/shared/format'
import { Icon } from '@/ui'

function useOutsideClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])
  return ref
}

type Pop = 'company' | 'fy' | 'scope' | 'search' | 'bell' | 'user' | null

/**
 * Top bar (Topbar.html), left to right: company/GSTIN switcher, FY, scope, search (Ctrl K), Help, notifications,
 * user with the view chip. Counts and names come from the database; nothing is hard-coded.
 */
export function Topbar({ onMenu, onHelp, drawerId, drawerOpen }: { onMenu: () => void; onHelp: () => void; drawerId: string; drawerOpen: boolean }) {
  const { t } = useTranslation()
  const { profile, signOut } = useAuth()
  const navigate = useNavigate()
  const companies = useCompanies()
  const [pop, setPop] = useState<Pop>(null)
  const close = () => setPop(null)
  const wrapRef = useOutsideClose(pop !== null, close)
  const searchRef = useRef<HTMLInputElement>(null)
  const fy = financialYear()

  // Ctrl/Cmd + K focuses the global search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const companyRows = companies.data?.status === 'ready' ? companies.data.data : []
  const gstinCount = companyRows.reduce((n, c) => n + (c.gstin_count ?? 0), 0)
  const companyLabel =
    companies.data?.status === 'ready' && companyRows.length > 0
      ? t('topbar.groupScope', { companies: companyRows.length, gstins: gstinCount })
      : t('topbar.noCompanies')

  const view = profile?.view ?? 'gst'
  const viewLabel = t(`views.${view}.chip`)
  const viewTitle = t(`views.${view}.title`)

  return (
    <header className="sf-topbar" ref={wrapRef}>
      <button
        type="button"
        className="sf-topbar__btn sf-topbar__icon sf-topbar__menu"
        aria-label={t('shell.openMenu')}
        aria-controls={drawerId}
        aria-expanded={drawerOpen}
        onClick={onMenu}
      >
        <Icon name="menu" />
      </button>

      <div className="sf-anchor">
        <button type="button" className="sf-topbar__btn" aria-haspopup="dialog" aria-expanded={pop === 'company'} onClick={() => setPop(pop === 'company' ? null : 'company')}>
          <img src="/brand/southfield-group-logo.png" alt={t('brand.group')} width={96} height={24} />
          <span className="mono sf-topbar__hide-sm" style={{ color: 'var(--sf-text-muted)' }}>
            {companyLabel}
          </span>
          <Icon name="chevronDown" size={14} strokeWidth={2} />
        </button>
        {pop === 'company' ? (
          <div className="sf-popover" role="dialog" aria-label={t('topbar.companySwitcher')} style={{ left: 0, right: 'auto' }}>
            {companyRows.length === 0 ? t('topbar.companiesPhase') : companyRows.map((c) => <div key={c.id}>{c.name}</div>)}
          </div>
        ) : null}
      </div>

      <div className="sf-anchor sf-topbar__hide-sm">
        <button type="button" className="sf-topbar__btn" aria-haspopup="dialog" aria-expanded={pop === 'fy'} onClick={() => setPop(pop === 'fy' ? null : 'fy')}>
          {t('topbar.fy', { fy })}
          <Icon name="chevronDown" size={14} strokeWidth={2} />
        </button>
        {pop === 'fy' ? (
          <div className="sf-popover" role="dialog" aria-label={t('topbar.fyLabel')} style={{ left: 0, right: 'auto' }}>
            {t('topbar.fyPhase')}
          </div>
        ) : null}
      </div>

      <div className="sf-anchor sf-topbar__hide-sm">
        <button type="button" className="sf-topbar__btn" aria-haspopup="dialog" aria-expanded={pop === 'scope'} onClick={() => setPop(pop === 'scope' ? null : 'scope')}>
          {t('topbar.scopeGroup')}
          <Icon name="chevronDown" size={14} strokeWidth={2} />
        </button>
        {pop === 'scope' ? (
          <div className="sf-popover" role="dialog" aria-label={t('topbar.scopeLabel')} style={{ left: 0, right: 'auto' }}>
            {t('topbar.scopePhase')}
          </div>
        ) : null}
      </div>

      <form
        className="sf-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault()
          setPop('search')
        }}
      >
        <Icon name="search" size={16} strokeWidth={2} />
        <label className="sr-only" htmlFor="sf-global-search">
          {t('topbar.search')}
        </label>
        <input ref={searchRef} id="sf-global-search" type="search" placeholder={t('topbar.searchPlaceholder')} onFocus={() => pop === 'search' && close()} />
        <span className="sf-kbd" aria-hidden="true">
          Ctrl K
        </span>
        {pop === 'search' ? (
          <div className="sf-popover" role="status" style={{ left: 0, right: 0 }}>
            {t('topbar.searchPhase')}
          </div>
        ) : null}
      </form>

      <button type="button" className="sf-topbar__btn sf-topbar__icon" aria-label={t('help.open')} onClick={onHelp}>
        <Icon name="help" />
      </button>

      <div className="sf-anchor">
        <button type="button" className="sf-topbar__btn sf-topbar__icon" aria-label={t('topbar.notifications')} aria-expanded={pop === 'bell'} onClick={() => setPop(pop === 'bell' ? null : 'bell')}>
          <Icon name="bell" strokeWidth={2} />
        </button>
        {pop === 'bell' ? (
          <div className="sf-popover" role="dialog" aria-label={t('topbar.notifications')}>
            {t('topbar.noNotifications')}
          </div>
        ) : null}
      </div>

      <div className="sf-anchor">
        <button type="button" className="sf-user" title={viewTitle} aria-expanded={pop === 'user'} onClick={() => setPop(pop === 'user' ? null : 'user')}>
          <span className="sf-avatar" aria-hidden="true">
            {initials(profile?.displayName ?? '')}
          </span>
          <span className="sf-user__text">
            <span>
              {profile?.displayName}
              {profile ? ` · ${t(`roles.${profile.role}`, { defaultValue: profile.roleLabel })}` : ''}
            </span>
            <span className="sf-viewchip" data-view={view}>
              <span className="sf-viewchip__dot" aria-hidden="true" />
              {viewLabel}
            </span>
          </span>
        </button>
        {pop === 'user' ? (
          <div className="sf-popover" role="dialog" aria-label={t('topbar.account')}>
            <p style={{ margin: '0 0 8px' }}>{viewTitle}</p>
            <div className="sf-popover__menu">
              <button
                type="button"
                onClick={async () => {
                  await signOut()
                  navigate('/sign-in', { replace: true })
                }}
              >
                {t('auth.signOut')}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </header>
  )
}

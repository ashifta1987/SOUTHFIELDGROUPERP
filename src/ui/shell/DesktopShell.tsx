import { useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { SCREENS } from '@/app/screens'
import { useAuth } from '@/auth/AuthProvider'
import { formatDate } from '@/shared/format'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { FlowStrip } from './FlowStrip'
import { HelpPanel } from './HelpPanel'
import { GrantBanner } from './GrantBanner'

/** Find the reference screen for the current path (exact route match). */
export function useCurrentScreenFile(): string | undefined {
  const { pathname } = useLocation()
  return SCREENS.find((s) => s.route === pathname)?.file
}

/**
 * Desktop ERP shell (§UX-4.1): sidebar + main column (top bar, workflow strip, page).
 * Below 1280 px the sidebar becomes a drawer opened from the top bar.
 */
export function DesktopShell() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const file = useCurrentScreenFile()
  const [drawer, setDrawer] = useState(false)
  const [help, setHelp] = useState(false)

  return (
    <div className="sf-shell" data-drawer={drawer ? 'open' : undefined}>
      <a href="#main" className="skip-link">
        {t('shell.skip')}
      </a>
      <Sidebar id="sf-sidebar" onNavigate={() => setDrawer(false)} />
      <button type="button" className="sf-drawer-backdrop" aria-label={t('shell.closeMenu')} tabIndex={-1} onClick={() => setDrawer(false)} />
      <div className="sf-main-col">
        <Topbar onMenu={() => setDrawer((d) => !d)} onHelp={() => setHelp(true)} drawerId="sf-sidebar" drawerOpen={drawer} />
        {file ? <FlowStrip file={file} /> : null}
        <GrantBanner />
        {profile?.view === 'all-readonly' ? (
          <div className="sf-banner" data-tone="navy" role="status">
            {profile.readOnlyUntil ? t('views.readOnlyUntil', { date: formatDate(profile.readOnlyUntil) }) : t('views.readOnly')}
          </div>
        ) : null}
        <main id="main" className="sf-main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      <HelpPanel open={help} onClose={() => setHelp(false)} />
    </div>
  )
}

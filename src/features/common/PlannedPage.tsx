import { Link, useLocation, useOutletContext } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { SCREENS } from '@/app/screens'
import { NAV } from '@/app/nav'
import { routeForFile } from '@/app/flows'
import { useAuth } from '@/auth/AuthProvider'
import { initials } from '@/shared/format'
import { Card, ComingInPhase, EmptyState, PageHeader, PhoneHeader } from '@/ui'
import type { PhoneOutletContext } from '@/ui/shell/StaffShell'

function useScreenInfo() {
  const { pathname } = useLocation()
  const screen = SCREENS.find((s) => s.route === pathname)
  const navItem = NAV.flatMap((g) => g.items).find((i) => i.route === pathname)
  return { screen, navItem, phase: screen?.phase ?? navItem?.phase ?? 9 }
}

/**
 * Every route in PAGE_INVENTORY exists from Phase 0 so the sidebar and workflow strip never lead nowhere.
 * Until its phase, a screen says plainly what it will do and when (never a dead page).
 */
export function PlannedPage() {
  const { t } = useTranslation()
  const { screen, navItem, phase } = useScreenInfo()
  const title = navItem ? t(navItem.labelKey) : screen ? t(`screens.${screen.file}`, { defaultValue: screen.label }) : t('planned.title')
  return (
    <>
      <PageHeader title={title} subtitle={t('planned.subtitle', { phase })} />
      <Card>
        <EmptyState
          title={t('planned.emptyTitle', { phase })}
          body={t('planned.emptyBody')}
          action={
            <Link to={routeForFile('Main')} style={{ fontWeight: 600, fontSize: 13 }}>
              {t('planned.backHome')}
            </Link>
          }
        />
        <div style={{ marginTop: 12 }}>
          <ComingInPhase phase={phase} />
        </div>
      </Card>
    </>
  )
}

export function PlannedPhonePage() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const { screen, phase } = useScreenInfo()
  const ctx = useOutletContext<PhoneOutletContext | undefined>()
  const name = profile?.displayName ?? ''
  return (
    <>
      <PhoneHeader initial={initials(name).slice(0, 1)} name={screen ? t(`screens.${screen.file}`, { defaultValue: screen.label }) : name} onHelp={ctx?.openHelp} />
      <div className="sf-phone-body">
        <div className="sf-phone-note">
          <EmptyState title={t('planned.emptyTitle', { phase })} body={t('planned.phoneBody')} />
        </div>
        <Link to="/staff/home" className="sf-btn" data-variant="primary" data-size="touch">
          {t('planned.backStaffHome')}
        </Link>
      </div>
    </>
  )
}

export function NotFoundPage() {
  const { t } = useTranslation()
  return (
    <>
      <PageHeader title={t('notFound.title')} />
      <Card>
        <EmptyState
          title={t('notFound.body')}
          action={
            <Link to="/" style={{ fontWeight: 600 }}>
              {t('planned.backHome')}
            </Link>
          }
        />
      </Card>
    </>
  )
}

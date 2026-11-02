import { useEffect, useState, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Icon } from './Icon'

/** Online/offline status for phone screens. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine)
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  return online
}

/** Clear offline indicator: drafts are kept on the phone and "send when back in signal". */
export function OfflineBadge({ forceOffline }: { forceOffline?: boolean }) {
  const { t } = useTranslation()
  const online = useOnline()
  if (online && !forceOffline) return null
  return (
    <span className="sf-offline" role="status" aria-live="polite">
      <Icon name="wifiOff" size={14} />
      {t('phone.offline')}
    </span>
  )
}

/** Navy phone header: avatar, name 18/700, sub-line, state pill, help (48 px target). */
export function PhoneHeader({
  initial,
  name,
  sub,
  pill,
  onHelp,
  extra,
}: {
  initial: string
  name: ReactNode
  sub?: ReactNode
  pill?: ReactNode
  onHelp?: () => void
  extra?: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <header className="sf-phone-head">
      <span className="sf-phone-head__avatar" aria-hidden="true">
        {initial}
      </span>
      <div className="sf-phone-head__text">
        <span className="sf-phone-head__name">{name}</span>
        {sub ? <span className="sf-phone-head__sub">{sub}</span> : null}
      </div>
      {pill}
      {extra}
      {onHelp ? (
        <button type="button" className="sf-phone-head__btn" aria-label={t('help.open')} onClick={onHelp}>
          <Icon name="help" size={24} />
        </button>
      ) : null}
    </header>
  )
}

export interface BottomNavItem {
  to: string
  label: ReactNode
  icon: string
  end?: boolean
}

export function BottomNav({ items, label }: { items: BottomNavItem[]; label: string }) {
  return (
    <nav className="sf-bottomnav" aria-label={label} style={{ ['--cols' as string]: items.length }}>
      {items.map((it) => (
        <NavLink key={it.to} to={it.to} end={it.end}>
          <Icon name={it.icon} size={22} />
          {it.label}
        </NavLink>
      ))}
    </nav>
  )
}

/** Secondary action tile (two-column grid on phone). */
export function ActionTile({ to, icon, label, note, disabled }: { to: string; icon: string; label: ReactNode; note?: ReactNode; disabled?: boolean }) {
  if (disabled) {
    return (
      <span className="sf-tile" aria-disabled="true">
        <Icon name={icon} size={24} />
        <span>
          {label}
          {note ? <span className="sf-tile__note"> · {note}</span> : null}
        </span>
      </span>
    )
  }
  return (
    <NavLink to={to} className="sf-tile">
      <Icon name={icon} size={24} />
      <span>
        {label}
        {note ? (
          <>
            <br />
            <span className="sf-tile__note">{note}</span>
          </>
        ) : null}
      </span>
    </NavLink>
  )
}

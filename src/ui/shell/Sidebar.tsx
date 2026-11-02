import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { NAV, NAV_ICONS, findNavForPath } from '@/app/nav'
import { useCan } from '@/auth/AuthProvider'
import { Icon } from '@/ui'

/** Desktop sidebar (Sidebar.html): logo plate, collapsible groups (several may be open), rights-filtered items. */
export function Sidebar({ id, onNavigate }: { id: string; onNavigate?: () => void }) {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const can = useCan()
  const current = findNavForPath(pathname)
  const [open, setOpen] = useState<Record<string, boolean>>(() => (current.group ? { [current.group.key]: true } : {}))

  // The group holding the current page opens by itself (state adjusted during render, not in an effect).
  const currentKey = current.group?.key
  const [seenKey, setSeenKey] = useState(currentKey)
  if (currentKey !== seenKey) {
    setSeenKey(currentKey)
    if (currentKey && !open[currentKey]) setOpen({ ...open, [currentKey]: true })
  }

  return (
    <nav id={id} className="sf-sidebar" aria-label={t('shell.mainMenu')}>
      <div className="sf-sidebar__logo">
        <div className="sf-sidebar__plate">
          <img src="/brand/southfield-group-logo.png" alt={t('brand.group')} width={184} height={46} />
        </div>
      </div>
      {NAV.map((group) => {
        if (group.route) {
          if (!can(`${group.key}.view`)) return null
          const active = pathname === group.route
          return (
            <div key={group.key} className="sf-sidebar__group">
              <Link to={group.route} className="sf-sidebar__link" aria-current={active ? 'page' : undefined} onClick={onNavigate}>
                <Icon path={NAV_ICONS[group.icon]} name={group.icon} />
                <span>{t(group.labelKey)}</span>
              </Link>
            </div>
          )
        }
        const visible = group.items.filter((i) => can(i.right))
        if (visible.length === 0) return null
        const isOpen = Boolean(open[group.key])
        const subId = `${id}-${group.key}`
        return (
          <div key={group.key} className="sf-sidebar__group">
            <button
              type="button"
              className="sf-sidebar__toggle"
              aria-expanded={isOpen}
              aria-controls={subId}
              data-open={isOpen ? 'true' : undefined}
              onClick={() => setOpen((o) => ({ ...o, [group.key]: !isOpen }))}
            >
              <Icon path={NAV_ICONS[group.icon]} name={group.icon} />
              <span className="grow">{t(group.labelKey)}</span>
              <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={14} strokeWidth={2.2} />
            </button>
            {isOpen ? (
              <div id={subId} className="sf-sidebar__sub">
                {visible.map((item) => (
                  <Link
                    key={item.key}
                    to={item.route}
                    className="sf-sidebar__link"
                    aria-current={current.item?.key === item.key && current.group?.key === group.key ? 'page' : undefined}
                    onClick={onNavigate}
                  >
                    {t(item.labelKey)}
                  </Link>
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
      <div className="sf-sidebar__spacer" />
      <div className="sf-sidebar__foot">
        {t('shell.footPlace')}
        <br />
        {t('shell.footRights')}
      </div>
    </nav>
  )
}

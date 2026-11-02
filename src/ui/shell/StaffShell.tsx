import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { BottomNav } from '@/ui'
import { HelpPanel } from './HelpPanel'

export interface PhoneOutletContext {
  openHelp: () => void
}

/** Staff phone app shell (§UX-4.2): page body + bottom tabs Home, Requests, Payslips, My details (StaffNav.html). */
export function StaffShell() {
  const { t } = useTranslation()
  const [help, setHelp] = useState(false)
  return (
    <div className="sf-phone">
      <Outlet context={{ openHelp: () => setHelp(true) } satisfies PhoneOutletContext} />
      <BottomNav
        label={t('staff.nav.label')}
        items={[
          { to: '/staff/home', label: t('staff.nav.home'), icon: 'home' },
          { to: '/staff/leave', label: t('staff.nav.requests'), icon: 'clipboard' },
          { to: '/staff/payslip', label: t('staff.nav.payslips'), icon: 'receipt', end: true },
          { to: '/staff/details', label: t('staff.nav.details'), icon: 'user' },
        ]}
      />
      <HelpPanel open={help} onClose={() => setHelp(false)} />
    </div>
  )
}

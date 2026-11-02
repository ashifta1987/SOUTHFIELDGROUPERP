import { lazy, Suspense, useState } from 'react'
import { createBrowserRouter, Outlet, type RouteObject } from 'react-router-dom'
import { SCREENS } from './screens'
import { ROUTES_WITHOUT_REFERENCE } from './nav'
import { RequireAuth } from '@/auth/RequireAuth'
import { DesktopShell } from '@/ui/shell/DesktopShell'
import { StaffShell, type PhoneOutletContext } from '@/ui/shell/StaffShell'
import { HelpPanel } from '@/ui/shell/HelpPanel'
import { SignInPage } from '@/features/auth/SignInPage'
import { StaffSignInPage } from '@/features/auth/StaffSignInPage'
import { HomePage } from '@/features/home/HomePage'
import { CustomersPage } from '@/features/sales/CustomersPage'
import { StaffHomePage } from '@/features/staff/StaffHomePage'
import { NotFoundPage, PlannedPage, PlannedPhonePage } from '@/features/common/PlannedPage'

/** Screens built so far. Everything else in PAGE_INVENTORY renders its planned page until its phase. */
const BUILT: Record<string, React.ReactNode> = {
  Main: <HomePage />,
  Customers: <CustomersPage />,
  StaffHome: <StaffHomePage />,
}

const SPECIAL = new Set(['Login', 'StaffSignIn'])

/** Phone screens outside the staff app (job screens, driver, salesman, investor): no bottom tabs yet. */
function PhoneOnlyShell() {
  const [help, setHelp] = useState(false)
  return (
    <div className="sf-phone">
      <Outlet context={{ openHelp: () => setHelp(true) } satisfies PhoneOutletContext} />
      <HelpPanel open={help} onClose={() => setHelp(false)} />
    </div>
  )
}

const desktop: RouteObject[] = []
const staff: RouteObject[] = []
const otherPhone: RouteObject[] = []

for (const s of SCREENS) {
  if (SPECIAL.has(s.file)) continue
  const element = BUILT[s.file] ?? (s.device === 'desktop' ? <PlannedPage /> : <PlannedPhonePage />)
  const route: RouteObject = s.route === '/' ? { index: true, element } : { path: s.route.slice(1), element }
  if (s.device === 'desktop' && !s.route.startsWith('/investor')) desktop.push(route)
  else if (s.route.startsWith('/staff/')) staff.push(route)
  else otherPhone.push(route)
}
for (const item of ROUTES_WITHOUT_REFERENCE) {
  desktop.push({ path: item.route.slice(1), element: <PlannedPage /> })
}

const UiGalleryPage = import.meta.env.DEV ? lazy(() => import('@/features/dev/UiGalleryPage').then((m) => ({ default: m.UiGalleryPage }))) : null
if (UiGalleryPage) {
  desktop.push({
    path: 'dev/ui',
    element: (
      <Suspense fallback={null}>
        <UiGalleryPage />
      </Suspense>
    ),
  })
}
desktop.push({ path: '*', element: <NotFoundPage /> })

export const router = createBrowserRouter([
  { path: '/sign-in', element: <SignInPage /> },
  { path: '/staff/sign-in', element: <StaffSignInPage /> },
  { path: '/investor/sign-in', element: <PhoneOnlyShell />, children: [{ index: true, element: <PlannedPhonePage /> }] },
  {
    path: '/staff',
    element: (
      <RequireAuth signInPath="/staff/sign-in">
        <StaffShell />
      </RequireAuth>
    ),
    children: [{ index: true, element: <StaffHomePage /> }, ...staff.map((r) => ({ ...r, path: r.path?.replace(/^staff\//, '') }))],
  },
  {
    element: (
      <RequireAuth>
        <PhoneOnlyShell />
      </RequireAuth>
    ),
    children: otherPhone,
  },
  {
    path: '/',
    element: (
      <RequireAuth>
        <DesktopShell />
      </RequireAuth>
    ),
    children: desktop,
  },
])

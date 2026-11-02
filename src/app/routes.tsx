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
import { CompaniesPage } from '@/features/admin/companies/CompaniesPage'
import { BranchesPage } from '@/features/admin/branches/BranchesPage'
import { UnitsPage } from '@/features/admin/units/UnitsPage'
import { UsersPage } from '@/features/admin/users/UsersPage'
import { SpecialAccessPage } from '@/features/admin/special-access/SpecialAccessPage'
import { UserLogPage } from '@/features/admin/user-log/UserLogPage'
import { TransactionLogPage } from '@/features/admin/transaction-log/TransactionLogPage'
import { NumberingPage } from '@/features/admin/numbering/NumberingPage'
import { FormFieldsPage } from '@/features/admin/form-fields/FormFieldsPage'
import { SettingsPage } from '@/features/admin/settings/SettingsPage'
import { UXOverviewPage } from '@/features/admin/ux-overview/UXOverviewPage'
import { LawRulesPage } from '@/features/admin/law-rules/LawRulesPage'
import { ERPFlowPage } from '@/features/admin/erp-flow/ERPFlowPage'
import { DataImportPage } from '@/features/admin/import-data/DataImportPage'
import { TallyBooksPage } from '@/features/admin/tally-books/TallyBooksPage'
import { BugFixerPage } from '@/features/admin/bug-fixer/BugFixerPage'
import { BackupPage } from '@/features/admin/backup/BackupPage'
import { ProductMasterPage } from '@/features/inventory/product-master/ProductMasterPage'
import { BiochemProductsPage } from '@/features/sales/biochem-products/BiochemProductsPage'
import { PriceListPage } from '@/features/sales/price-lists/PriceListPage'
import { CustomerKycPage } from '@/features/sales/customer-kyc/CustomerKycPage'
import { SuppliersPage } from '@/features/purchase/suppliers/SuppliersPage'

/** Screens built so far. Everything else in PAGE_INVENTORY renders its planned page until its phase. */
const BUILT: Record<string, React.ReactNode> = {
  Main: <HomePage />,
  Customers: <CustomersPage />,
  StaffHome: <StaffHomePage />,
  // Phase 1
  Companies: <CompaniesPage />,
  Branches: <BranchesPage />,
  Units: <UnitsPage />,
  Users: <UsersPage />,
  SpecialAccess: <SpecialAccessPage />,
  UserLog: <UserLogPage />,
  TransactionLog: <TransactionLogPage />,
  Numbering: <NumberingPage />,
  FormFields: <FormFieldsPage />,
  UXOverview: <UXOverviewPage />,
  LawRules: <LawRulesPage />,
  ERPFlow: <ERPFlowPage />,
  // Phase 2
  DataImport: <DataImportPage />,
  TallyBiochem: <TallyBooksPage logoKey="biochem" />,
  TallyPlastics: <TallyBooksPage logoKey="plastics" />,
  BookFixes: <BugFixerPage />,
  Backup: <BackupPage />,
  ProductMaster: <ProductMasterPage />,
  BiochemProducts: <BiochemProductsPage />,
  PriceList: <PriceListPage />,
  CustomerKYC: <CustomerKycPage />,
  SupplierKYC: <SuppliersPage />,
}

/** Built screens for sidebar items that have no reference screen. */
const BUILT_ROUTES: Record<string, React.ReactNode> = {
  '/admin/settings': <SettingsPage />,
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
  desktop.push({ path: item.route.slice(1), element: BUILT_ROUTES[item.route] ?? <PlannedPage /> })
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


import { lazy, Suspense, useState } from 'react'
import { createBrowserRouter, Outlet, type RouteObject } from 'react-router-dom'
import { SCREENS } from './screens'
import { ROUTES_WITHOUT_REFERENCE } from './nav'
import { RequireAuth } from '@/auth/RequireAuth'
import { DesktopShell } from '@/ui/shell/DesktopShell'
import { StaffShell, type PhoneOutletContext } from '@/ui/shell/StaffShell'
import { HelpPanel } from '@/ui/shell/HelpPanel'
import { askHelp } from '@/features/help/events'
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
import { InvoicePage } from '@/features/sales/invoice/InvoicePage'
import { SalesRegisterPage } from '@/features/sales/sales-register/SalesRegisterPage'
import { DocPreviewPage } from '@/features/admin/document-templates/DocPreviewPage'
import { ReceiptsPage } from '@/features/sales/receipts/ReceiptsPage'
import { CashBookPage } from '@/features/accounts/cash-book/CashBookPage'
import { CashBookCheckPage } from '@/features/accounts/cash-book-check/CashBookCheckPage'
import { BankPage } from '@/features/accounts/bank/BankPage'
import { CashFlowPage } from '@/features/accounts/cash-flow/CashFlowPage'
import { BillsPage } from '@/features/purchase/bills/BillsPage'
import { CashEntryPage } from '@/features/me/cash-entry/CashEntryPage'
import { EmployeesPage } from '@/features/hr/employees/EmployeesPage'
import { AddStaffPage } from '@/features/hr/add-staff/AddStaffPage'
import { AttendancePage } from '@/features/hr/attendance/AttendancePage'
import { WorkerHoursPage } from '@/features/hr/worker-hours/WorkerHoursPage'
import { StaffDutiesPage } from '@/features/hr/duties/StaffDutiesPage'
import { StaffRotationPage } from '@/features/hr/rotation/StaffRotationPage'
import { RequestsPage } from '@/features/hr/requests/RequestsPage'
import { AllowancesPage } from '@/features/hr/allowances/AllowancesPage'
import { CashGivenPage } from '@/features/hr/cash-given/CashGivenPage'
import { PayrollPage } from '@/features/hr/payroll/PayrollPage'
import { PayrollTrendPage } from '@/features/hr/payroll-trend/PayrollTrendPage'
import { StaffWorkflowPage } from '@/features/hr/staff-workflow/StaffWorkflowPage'
import { StaffLeavePage } from '@/features/staff/leave/StaffLeavePage'
import { StaffAdvancePage } from '@/features/staff/advance/StaffAdvancePage'
import { StaffDetailsPage } from '@/features/staff/details/StaffDetailsPage'
import { StaffPayslipPage } from '@/features/staff/payslip/StaffPayslipPage'
import { WhatsAppPage } from '@/features/admin/whatsapp/WhatsAppPage'
import { PurchaseRequestPage } from '@/features/purchase/requests/PurchaseRequestPage'
import { PurchaseOrdersPage } from '@/features/purchase/orders/PurchaseOrdersPage'
import { GoodsReceiptPage } from '@/features/purchase/goods-receipt/GoodsReceiptPage'
import { BillReviewPage } from '@/features/purchase/bill-review/BillReviewPage'
import { PriceChangesPage } from '@/features/purchase/price-changes/PriceChangesPage'
import { BillPhotoPage } from '@/features/me/bill-photo/BillPhotoPage'
import { BuyingLogisticsPage } from '@/features/me/buying-logistics/BuyingLogisticsPage'
import { RawMaterialPage } from '@/features/inventory/raw-material/RawMaterialPage'
import { ComponentStockPage } from '@/features/inventory/component-stock/ComponentStockPage'
import { StockMovementsPage } from '@/features/inventory/stock-movements/StockMovementsPage'
import { ScrapPage } from '@/features/inventory/scrap/ScrapPage'
import { WarehousePage } from '@/features/inventory/warehouse/WarehousePage'
import { StockTransfersPage } from '@/features/inventory/stock-transfers/StockTransfersPage'
import { BiochemManufacturingPage } from '@/features/production/biochem-manufacturing/BiochemManufacturingPage'
import { BiochemProductionEntryPage } from '@/features/production/biochem-production-entry/BiochemProductionEntryPage'
import { BiochemProductionFlowPage } from '@/features/production/biochem-production-flow/BiochemProductionFlowPage'
import { BiochemLabsPage } from '@/features/production/biochem-labs/BiochemLabsPage'
import { FactoryWorkAssignmentPage } from '@/features/production/biochem-work/FactoryWorkAssignmentPage'
import { FreeItemsAndGiftPacksPage } from '@/features/production/biochem-packs/FreeItemsAndGiftPacksPage'
import { BiochemMachinesPage } from '@/features/production/biochem-machines/BiochemMachinesPage'
import { BiochemCostingPage } from '@/features/production/biochem-costing/BiochemCostingPage'
import { FactoryManagerHomePage } from '@/features/me/factory-manager/FactoryManagerHomePage'
import { LabPanelPage } from '@/features/lab/lab-panel/LabPanelPage'
import { LicencesPage } from '@/features/admin/licences/LicencesPage'
import { MouldProjectsPage } from '@/features/production/mould-projects/MouldProjectsPage'
import { MouldRegisterPage } from '@/features/production/mould-register/MouldRegisterPage'
import { MouldCostingPage } from '@/features/production/mould-costing/MouldCostingPage'
import { InjectionProductionPage } from '@/features/production/injection-production/InjectionProductionPage'
import { QualityPage } from '@/features/production/quality/QualityPage'
import { MachineAssemblyPage } from '@/features/production/machine-assembly/MachineAssemblyPage'
import { ComponentCostingPage } from '@/features/production/component-costing/ComponentCostingPage'
import { AssembledProductsPage } from '@/features/production/assembled-products/AssembledProductsPage'
import { PadPrintingPage } from '@/features/production/pad-printing/PadPrintingPage'
import { MouldManagerHomePage } from '@/features/me/mould-manager/MouldManagerHomePage'
import { InjectionManagerHomePage } from '@/features/me/injection-manager/InjectionManagerHomePage'
import { MachineCheckPage } from '@/features/me/machine-check/MachineCheckPage'
import { QuotationsAndOrdersPage } from '@/features/sales/quotations-and-orders/QuotationsAndOrdersPage'
import { CreditCustomersPage } from '@/features/sales/credit-customers/CreditCustomersPage'
import { CustomerCarePage } from '@/features/sales/customer-care/CustomerCarePage'
import { ShopsAndSupermarketsPage } from '@/features/sales/shops-and-supermarkets/ShopsAndSupermarketsPage'
import { OwnShopsPage } from '@/features/sales/own-shops/OwnShopsPage'
import { OnlineChannelsPage } from '@/features/sales/online-channels/OnlineChannelsPage'
import { OnlineListingsPage } from '@/features/sales/online-listings/OnlineListingsPage'
import { ExportOrdersPage } from '@/features/exports/export-orders/ExportOrdersPage'
import { MixerGrinderCostingPage } from '@/features/exports/mixer-grinder-costing/MixerGrinderCostingPage'
import { GstPage } from '@/features/accounts/gst/GstPage'
import { FinancialsPage } from '@/features/accounts/financials/FinancialsPage'
import { ScheduleIIIPage } from '@/features/accounts/schedule-iii/ScheduleIIIPage'
import { DispatchBoardPage } from '@/features/logistics/dispatch-board/DispatchBoardPage'
import { TripsPage } from '@/features/logistics/trips/TripsPage'
import { VehiclesDriversPage } from '@/features/logistics/vehicles-and-drivers/VehiclesDriversPage'
import { VehicleFilePage } from '@/features/logistics/vehicle-file/VehicleFilePage'
import { RouteSalesPage } from '@/features/sales/route-sales/RouteSalesPage'
import { FieldTodayPage } from '@/features/field/today/FieldTodayPage'
import { FIELD_ROUTES } from '@/features/field/routes'
import { DriverTripPage } from '@/features/driver/trip/DriverTripPage'
import { DriverPodPage } from '@/features/driver/pod/DriverPodPage'
import { JobWorkPage } from '@/features/production/job-work/JobWorkPage'
import { MaintenancePage } from '@/features/production/maintenance/MaintenancePage'
import { AssetRegisterPage } from '@/features/admin/asset-register/AssetRegisterPage'
import { DirectorsPage } from '@/features/accounts/directors/DirectorsPage'
import { ProfitSharingPage } from '@/features/accounts/profit-sharing/ProfitSharingPage'
import { PartnerRequestsPage } from '@/features/accounts/partner-requests/PartnerRequestsPage'
import { MonthClosePage } from '@/features/accounts/month-close/MonthClosePage'
import { INVESTOR_ROUTES, InvestorShell, InvestorSignInPage } from '@/features/investor/routes'

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
  // Phase 3
  Invoice: <InvoicePage />,
  SalesRegister: <SalesRegisterPage variant="admin" />,
  CompanyPortal: <SalesRegisterPage variant="accountant" />,
  DocPreview: <DocPreviewPage />,
  CashBook: <CashBookPage />,
  CashBookCheck: <CashBookCheckPage />,
  BankReco: <BankPage />,
  CashFlow: <CashFlowPage />,
  CashEntry: <CashEntryPage />,
  StaffKYC: <EmployeesPage />,
  AddStaff: <AddStaffPage />,
  Attendance: <AttendancePage />,
  WorkerHours: <WorkerHoursPage />,
  StaffDuties: <StaffDutiesPage />,
  StaffRotation: <StaffRotationPage />,
  Requests: <RequestsPage />,
  Allowances: <AllowancesPage />,
  CashGiven: <CashGivenPage />,
  Payroll: <PayrollPage variant="all" />,
  PayrollBiochem: <PayrollPage variant="company" />,
  PayrollBiochemTrend: <PayrollTrendPage />,
  StaffWorkflow: <StaffWorkflowPage />,
  StaffLeave: <StaffLeavePage />,
  StaffAdvance: <StaffAdvancePage />,
  StaffDetails: <StaffDetailsPage />,
  StaffPayslip: <StaffPayslipPage />,
  StaffPayslipHasanan: <StaffPayslipPage />,
  WhatsApp: <WhatsAppPage />,
  // Phase 4 · purchase
  PurchaseRequest: <PurchaseRequestPage />,
  GoodsReceipt: <GoodsReceiptPage />,
  BillReview: <BillReviewPage />,
  PriceChanges: <PriceChangesPage />,
  BillCapture: <BillPhotoPage />,
  RafeeqHome: <BuyingLogisticsPage />,
  // Phase 4 · inventory
  RawMaterial: <RawMaterialPage />,
  ComponentStock: <ComponentStockPage />,
  StockMovement: <StockMovementsPage />,
  Scrap: <ScrapPage />,
  Warehouse: <WarehousePage />,
  StockTransfer: <StockTransfersPage />,
  // Phase 5 · Biochem production
  BiochemManufacturing: <BiochemManufacturingPage />,
  BiochemProduction: <BiochemProductionEntryPage />,
  BiochemFlow: <BiochemProductionFlowPage />,
  BiochemLabs: <BiochemLabsPage />,
  BiochemWork: <FactoryWorkAssignmentPage />,
  BiochemBundles: <FreeItemsAndGiftPacksPage />,
  BiochemAssets: <BiochemMachinesPage />,
  BiochemCosting: <BiochemCostingPage />,
  IsmailHome: <FactoryManagerHomePage />,
  LabPanel: <LabPanelPage />,
  Licences: <LicencesPage />,
  // Phase 5 · Plastics production
  Moulds: <MouldProjectsPage />,
  MouldRegister: <MouldRegisterPage />,
  MouldCosting: <MouldCostingPage />,
  Production: <InjectionProductionPage />,
  Quality: <QualityPage />,
  Machines: <MachineAssemblyPage />,
  ComponentCosting: <ComponentCostingPage />,
  AssemblyCosting: <AssembledProductsPage />,
  PadPrinting: <PadPrintingPage />,
  RaviHome: <MouldManagerHomePage />,
  KrishnaHome: <InjectionManagerHomePage />,
  OperatorCheck: <MachineCheckPage />,
  // Phase 6 · sales desk and exports
  SalesOrders: <QuotationsAndOrdersPage />,
  CreditControl: <CreditCustomersPage />,
  SalesControls: <CustomerCarePage />,
  ShopSales: <ShopsAndSupermarketsPage />,
  Outlets: <OwnShopsPage />,
  OnlineSales: <OnlineChannelsPage />,
  OnlineListings: <OnlineListingsPage />,
  ExportOrders: <ExportOrdersPage />,
  MixerCosting: <MixerGrinderCostingPage />,
  // Phase 6 · accounts and GST
  GST: <GstPage />,
  Reports: <FinancialsPage />,
  ScheduleIIIBiochem: <ScheduleIIIPage />,
  // Phase 6 · logistics, route sales, salesman and driver apps
  Dispatch: <DispatchBoardPage />,
  Trip: <TripsPage />,
  Vehicles: <VehiclesDriversPage />,
  VehicleFile: <VehicleFilePage />,
  RouteSales: <RouteSalesPage />,
  SalesmanApp: <FieldTodayPage />,
  DriverTrip: <DriverTripPage />,
  DriverPOD: <DriverPodPage />,
  // Phase 7 · operations and accounts
  JobWork: <JobWorkPage />,
  Maintenance: <MaintenancePage />,
  AssetRegister: <AssetRegisterPage />,
  Directors: <DirectorsPage />,
  ProfitSharing: <ProfitSharingPage />,
  PartnerRequests: <PartnerRequestsPage />,
  MonthClose: <MonthClosePage />,
}

/** Built screens for sidebar items that have no reference screen. */
const BUILT_ROUTES: Record<string, React.ReactNode> = {
  '/admin/settings': <SettingsPage />,
  '/sales/receipts': <ReceiptsPage />,
  '/purchase/bills-and-payments': <BillsPage />,
  '/purchase/purchase-orders': <PurchaseOrdersPage />,
}

const SPECIAL = new Set(['Login', 'StaffSignIn'])

/** Phone screens outside the staff app (job screens, driver, salesman, investor): no bottom tabs yet. */
function PhoneOnlyShell() {
  const [help, setHelp] = useState(false)
  return (
    <div className="sf-phone">
      <Outlet context={{ openHelp: () => askHelp() } satisfies PhoneOutletContext} />
      <HelpPanel open={help} onOpen={() => setHelp(true)} onClose={() => setHelp(false)} />
    </div>
  )
}

const desktop: RouteObject[] = []
const staff: RouteObject[] = []
const otherPhone: RouteObject[] = []

for (const s of SCREENS) {
  if (SPECIAL.has(s.file)) continue
  if (s.route.startsWith('/investor')) continue // Phase 7: investor portal has its own shell (INVESTOR_ROUTES)
  const element = BUILT[s.file] ?? (s.device === 'desktop' ? <PlannedPage /> : <PlannedPhonePage />)
  const route: RouteObject = s.route === '/' ? { index: true, element } : { path: s.route.slice(1), element }
  if (s.device === 'desktop' && !s.route.startsWith('/investor')) desktop.push(route)
  else if (s.route.startsWith('/staff/')) staff.push(route)
  else otherPhone.push(route)
}
// Salesman portal pages beyond its home (/field/today): customers, customer page, order, collect, queries, library, my day, end day.
otherPhone.push(...FIELD_ROUTES)
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
  { path: '/investor/sign-in', element: <InvestorSignInPage /> },
  {
    path: '/investor',
    element: (
      <RequireAuth signInPath="/investor/sign-in" portal="investor">
        <InvestorShell />
      </RequireAuth>
    ),
    children: INVESTOR_ROUTES,
  },
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


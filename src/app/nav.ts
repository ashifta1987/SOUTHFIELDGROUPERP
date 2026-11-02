/**
 * Sidebar groups and items, in the exact order of §UX-4.1. Do not re-order or rename.
 * Each item points at a reference screen (`file`) or, for the few items with no reference screen,
 * at its own route and the phase it arrives in. `right` is the module.action needed to see it.
 */
import { SCREEN_BY_FILE } from './screens'

export interface NavItem {
  key: string
  /** i18n key under `nav.` */
  labelKey: string
  route: string
  file?: string
  phase: number
  right: string
}

export interface NavGroup {
  key: string
  labelKey: string
  icon: string
  /** Single-link group (Home) */
  route?: string
  items: NavItem[]
}

/** Stroke icon paths taken from Sidebar.html (24×24 viewBox). */
export const NAV_ICONS: Record<string, string> = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  sales: 'M6 3h12v18l-3-2-3 2-3-2-3 2z M9 8h6 M9 12h6',
  purchase: 'M3 4h2l2.5 11h11L21 7H6.2 M9 20h.01 M18 20h.01',
  production: 'M3 21V10l6 4V10l6 4V6h6v15z M7 18h2 M12 18h2',
  inventory: 'M3 7l9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10',
  logistics: 'M2 6h11v10H2z M13 10h4l3 3v3h-7z M6 19h.01 M17 19h.01',
  exports: 'M3 17h18l-2 4H5z M5 17V10h14v7 M8 10V6h8v4 M12 6V3',
  hr: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M2 21c.8-3.5 3.6-6 7-6s6.2 2.5 7 6 M16 4.5a3.5 3.5 0 0 1 0 6.5 M18 15c2 .8 3.4 3 4 6',
  accounts: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M3 7l13-3v3 M16 13h2',
  admin: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z M9 12l2 2 4-4',
}

type ItemSpec = [key: string, fileOrRoute: string, phase?: number]

function items(group: string, specs: ItemSpec[]): NavItem[] {
  return specs.map(([key, ref, phase]) => {
    const screen = SCREEN_BY_FILE[ref]
    if (screen) {
      return { key, labelKey: `nav.${group}.${key}`, route: screen.route, file: screen.file, phase: screen.phase, right: `${group}.view` }
    }
    // No reference screen: built later from the list/document page patterns (§UX-7).
    return { key, labelKey: `nav.${group}.${key}`, route: ref, phase: phase ?? 9, right: `${group}.view` }
  })
}

export const NAV: NavGroup[] = [
  { key: 'home', labelKey: 'nav.home', icon: 'home', route: '/', items: [] },
  {
    key: 'sales',
    labelKey: 'nav.sales._',
    icon: 'sales',
    items: items('sales', [
      ['quotationsOrders', 'SalesOrders'],
      ['invoices', 'Invoice'],
      ['receipts', '/sales/receipts', 3],
      ['customers', 'Customers'],
      ['shops', 'ShopSales'],
      ['routeSales', 'RouteSales'],
      ['ownShops', 'Outlets'],
      ['creditCustomers', 'CreditControl'],
      ['customerCare', 'SalesControls'],
      ['biochemProducts', 'BiochemProducts'],
      ['priceLists', 'PriceList'],
      ['onlineChannels', 'OnlineSales'],
      ['onlineListings', 'OnlineListings'],
    ]),
  },
  {
    key: 'purchase',
    labelKey: 'nav.purchase._',
    icon: 'purchase',
    items: items('purchase', [
      ['purchaseRequests', 'PurchaseRequest'],
      ['billPhoto', 'BillReview'],
      ['priceChanges', 'PriceChanges'],
      ['purchaseOrders', '/purchase/purchase-orders', 4],
      ['goodsReceipt', 'GoodsReceipt'],
      ['billsPayments', '/purchase/bills-and-payments', 4],
      ['suppliers', 'SupplierKYC'],
    ]),
  },
  {
    key: 'production',
    labelKey: 'nav.production._',
    icon: 'production',
    items: items('production', [
      ['biochemFlow', 'BiochemFlow'],
      ['biochemManufacturing', 'BiochemManufacturing'],
      ['biochemProduction', 'BiochemProduction'],
      ['factoryWork', 'BiochemWork'],
      ['biochemLabs', 'BiochemLabs'],
      ['freeItems', 'BiochemBundles'],
      ['biochemMachines', 'BiochemAssets'],
      ['biochemCosting', 'BiochemCosting'],
      ['mouldProjects', 'Moulds'],
      ['mouldRegister', 'MouldRegister'],
      ['mouldCosting', 'MouldCosting'],
      ['machineAssembly', 'Machines'],
      ['injection', 'Production'],
      ['componentCosting', 'ComponentCosting'],
      ['assembled', 'AssemblyCosting'],
      ['padPrinting', 'PadPrinting'],
      ['quality', 'Quality'],
      ['maintenance', 'Maintenance'],
      ['jobWork', 'JobWork'],
    ]),
  },
  {
    key: 'inventory',
    labelKey: 'nav.inventory._',
    icon: 'inventory',
    items: items('inventory', [
      ['warehouse', 'Warehouse'],
      ['stockTransfers', 'StockTransfer'],
      ['productMaster', 'ProductMaster'],
      ['rawMaterial', 'RawMaterial'],
      ['componentStock', 'ComponentStock'],
      ['parts', '/inventory/parts-and-consumables', 4],
      ['stockMovements', 'StockMovement'],
      ['scrap', 'Scrap'],
    ]),
  },
  {
    key: 'logistics',
    labelKey: 'nav.logistics._',
    icon: 'logistics',
    items: items('logistics', [
      ['dispatch', 'Dispatch'],
      ['trips', 'Trip'],
      ['vehicles', 'Vehicles'],
      ['vehicleFile', 'VehicleFile'],
    ]),
  },
  {
    key: 'exports',
    labelKey: 'nav.exports._',
    icon: 'exports',
    items: items('exports', [
      ['exportOrders', 'ExportOrders'],
      ['mixerCosting', 'MixerCosting'],
    ]),
  },
  {
    key: 'hr',
    labelKey: 'nav.hr._',
    icon: 'hr',
    items: items('hr', [
      ['employees', 'StaffKYC'],
      ['attendance', 'Attendance'],
      ['duties', 'StaffDuties'],
      ['rotation', 'StaffRotation'],
      ['workers', 'WorkerHours'],
      ['requests', 'Requests'],
      ['allowances', 'Allowances'],
      ['cashGiven', 'CashGiven'],
      ['payroll', 'Payroll'],
    ]),
  },
  {
    key: 'accounts',
    labelKey: 'nav.accounts._',
    icon: 'accounts',
    items: items('accounts', [
      ['cashBook', 'CashBook'],
      ['bank', 'BankReco'],
      ['cashFlow', 'CashFlow'],
      ['directors', 'Directors'],
      ['partners', 'ProfitSharing'],
      ['partnerRequests', 'PartnerRequests'],
      ['monthClose', 'MonthClose'],
      ['gst', 'GST'],
      ['financials', 'Reports'],
      ['scheduleIII', 'ScheduleIIIBiochem'],
    ]),
  },
  {
    key: 'admin',
    labelKey: 'nav.admin._',
    icon: 'admin',
    items: items('admin', [
      ['companies', 'Companies'],
      ['branches', 'Branches'],
      ['units', 'Units'],
      ['assets', 'AssetRegister'],
      ['licences', 'Licences'],
      ['users', 'Users'],
      ['specialPermissions', 'SpecialAccess'],
      ['totalWorkflow', 'ERPFlow'],
      ['howEachPersonSees', 'UXOverview'],
      ['indianLaw', 'LawRules'],
      ['formsFields', 'FormFields'],
      ['userLog', 'UserLog'],
      ['transactionLog', 'TransactionLog'],
      ['backup', 'Backup'],
      ['importData', 'DataImport'],
      ['bugFixer', 'BookFixes'],
      ['numbering', 'Numbering'],
      ['documentTemplates', 'DocPreview'],
      ['whatsapp', 'WhatsApp'],
      ['settings', '/admin/settings', 1],
    ]),
  },
]

/** Routes for sidebar items that have no reference screen. */
export const ROUTES_WITHOUT_REFERENCE = NAV.flatMap((g) => g.items.filter((i) => !i.file))

/** Find the sidebar group/item that owns a route (longest prefix match, so second views highlight their parent). */
export function findNavForPath(pathname: string): { group?: NavGroup; item?: NavItem } {
  if (pathname === '/') return { group: NAV[0] }
  let best: { group?: NavGroup; item?: NavItem; len: number } = { len: 0 }
  for (const group of NAV) {
    for (const item of group.items) {
      if ((pathname === item.route || pathname.startsWith(item.route + '/')) && item.route.length > best.len) {
        best = { group, item, len: item.route.length }
      }
    }
  }
  return { group: best.group, item: best.item }
}


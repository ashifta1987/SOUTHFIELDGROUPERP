/**
 * Workflow strip configuration, generated from docs/design/WORKFLOWS.md (the 17 workflows).
 * Regenerate when WORKFLOWS.md changes. A page in several flows shows its main flow (§UX-4.1).
 */
import { SCREEN_BY_FILE } from './screens'

export interface FlowStep {
  label: string
  file: string
}

export interface Flow {
  key: string
  name: string
  usedBy: string
  steps: FlowStep[]
}

export const FLOWS: Flow[] = [
  {
    name: 'Owner overview',
    key: 'home',
    usedBy: 'Admin',
    steps: [
      {
        label: 'Today',
        file: 'Main'
      },
      {
        label: 'Total workflow',
        file: 'ERPFlow'
      },
      {
        label: 'How each person sees it',
        file: 'UXOverview'
      },
      {
        label: 'Built to Indian law',
        file: 'LawRules'
      }
    ]
  },
  {
    name: 'Buying',
    key: 'purchase',
    usedBy: 'Admin, accountant, stores',
    steps: [
      {
        label: 'Request',
        file: 'PurchaseRequest'
      },
      {
        label: 'Supplier and KYC',
        file: 'SupplierKYC'
      },
      {
        label: 'Bill photo',
        file: 'BillReview'
      },
      {
        label: 'Price check',
        file: 'PriceChanges'
      },
      {
        label: 'Goods receipt',
        file: 'GoodsReceipt'
      },
      {
        label: 'Incoming test',
        file: 'BiochemLabs'
      },
      {
        label: 'Into stock',
        file: 'RawMaterial'
      },
      {
        label: 'Payment',
        file: 'BankReco'
      }
    ]
  },
  {
    name: 'Warehouse loop',
    key: 'warehouse',
    usedBy: 'Stores, production, dispatch, drivers',
    steps: [
      {
        label: 'Goods receipt',
        file: 'GoodsReceipt'
      },
      {
        label: 'Quarantine and test',
        file: 'BiochemLabs'
      },
      {
        label: 'Warehouse',
        file: 'Warehouse'
      },
      {
        label: 'Issue to manufacturing',
        file: 'BiochemProduction'
      },
      {
        label: 'Pack and free items',
        file: 'BiochemBundles'
      },
      {
        label: 'Back to stock',
        file: 'StockMovement'
      },
      {
        label: 'Order picking',
        file: 'SalesOrders'
      },
      {
        label: 'Dispatch',
        file: 'Dispatch'
      },
      {
        label: 'Trip',
        file: 'Trip'
      },
      {
        label: 'Proof of delivery',
        file: 'DriverPOD'
      }
    ]
  },
  {
    name: 'Stock',
    key: 'stock',
    usedBy: 'Stores, Admin',
    steps: [
      {
        label: 'Product master',
        file: 'ProductMaster'
      },
      {
        label: 'Raw material',
        file: 'RawMaterial'
      },
      {
        label: 'Components',
        file: 'ComponentStock'
      },
      {
        label: 'Stock movements',
        file: 'StockMovement'
      },
      {
        label: 'Scrap and regrind',
        file: 'Scrap'
      },
      {
        label: 'Month-end count',
        file: 'MonthClose'
      }
    ]
  },
  {
    name: 'Biochem production',
    key: 'bio',
    usedBy: 'Production Manager, chemist, factory staff',
    steps: [
      {
        label: 'Products',
        file: 'ProductMaster'
      },
      {
        label: 'Price and label checks',
        file: 'BiochemProducts'
      },
      {
        label: 'Formula and route',
        file: 'BiochemManufacturing'
      },
      {
        label: 'Machines',
        file: 'BiochemAssets'
      },
      {
        label: 'Assign work',
        file: 'BiochemWork'
      },
      {
        label: 'Production entry',
        file: 'BiochemProduction'
      },
      {
        label: 'Lab tests',
        file: 'BiochemLabs'
      },
      {
        label: 'Packs and free items',
        file: 'BiochemBundles'
      },
      {
        label: 'Costing',
        file: 'BiochemCosting'
      },
      {
        label: 'The whole flow',
        file: 'BiochemFlow'
      }
    ]
  },
  {
    name: 'Plastics production',
    key: 'plastics',
    usedBy: 'Admin, supervisors, operators',
    steps: [
      {
        label: 'Mould project',
        file: 'Moulds'
      },
      {
        label: 'Mould register',
        file: 'MouldRegister'
      },
      {
        label: 'Mould costing',
        file: 'MouldCosting'
      },
      {
        label: 'Machines',
        file: 'Machines'
      },
      {
        label: 'Moulding',
        file: 'Production'
      },
      {
        label: 'Quality',
        file: 'Quality'
      },
      {
        label: 'Component costing',
        file: 'ComponentCosting'
      },
      {
        label: 'Assembly',
        file: 'AssemblyCosting'
      },
      {
        label: 'Pad printing',
        file: 'PadPrinting'
      },
      {
        label: 'Job work',
        file: 'JobWork'
      },
      {
        label: 'Maintenance',
        file: 'Maintenance'
      }
    ]
  },
  {
    name: 'Mixer grinder export',
    key: 'export',
    usedBy: 'Admin',
    steps: [
      {
        label: 'Export order',
        file: 'ExportOrders'
      },
      {
        label: 'Mixer costing',
        file: 'MixerCosting'
      },
      {
        label: 'Between companies',
        file: 'Companies'
      }
    ]
  },
  {
    name: 'Selling',
    key: 'sales',
    usedBy: 'Admin, accountant, sales',
    steps: [
      {
        label: 'Customers',
        file: 'Customers'
      },
      {
        label: 'Customer KYC',
        file: 'CustomerKYC'
      },
      {
        label: 'Price list',
        file: 'PriceList'
      },
      {
        label: 'Shops',
        file: 'ShopSales'
      },
      {
        label: 'Order',
        file: 'SalesOrders'
      },
      {
        label: 'Tax invoice',
        file: 'Invoice'
      },
      {
        label: 'Sales register',
        file: 'SalesRegister'
      },
      {
        label: 'Accountant’s register',
        file: 'CompanyPortal'
      },
      {
        label: 'Online listings',
        file: 'OnlineListings'
      },
      {
        label: 'Online orders',
        file: 'OnlineSales'
      }
    ]
  },
  {
    name: 'Field sales and own shops',
    key: 'field',
    usedBy: 'Sales manager, salesmen, shop staff',
    steps: [
      {
        label: 'Customers',
        file: 'Customers'
      },
      {
        label: 'Routes and GPS',
        file: 'RouteSales'
      },
      {
        label: 'Customer care and agents',
        file: 'SalesControls'
      },
      {
        label: 'Salesman’s phone',
        file: 'SalesmanApp'
      },
      {
        label: 'Order',
        file: 'SalesOrders'
      },
      {
        label: 'Own shops',
        file: 'Outlets'
      },
      {
        label: 'Tax invoice',
        file: 'Invoice'
      },
      {
        label: 'Collections',
        file: 'CashBook'
      }
    ]
  },
  {
    name: 'Credit and collections',
    key: 'credit',
    usedBy: 'Sales, finance head, MD',
    steps: [
      {
        label: 'Customers',
        file: 'Customers'
      },
      {
        label: 'Customer KYC',
        file: 'CustomerKYC'
      },
      {
        label: 'Credit approval',
        file: 'CreditControl'
      },
      {
        label: 'Order',
        file: 'SalesOrders'
      },
      {
        label: 'Stock transfers',
        file: 'StockTransfer'
      },
      {
        label: 'Tax invoice',
        file: 'Invoice'
      },
      {
        label: 'Reminders and complaints',
        file: 'SalesControls'
      },
      {
        label: 'Bank receipts',
        file: 'BankReco'
      }
    ]
  },
  {
    name: 'Delivery',
    key: 'delivery',
    usedBy: 'Dispatch staff, drivers',
    steps: [
      {
        label: 'Dispatch board',
        file: 'Dispatch'
      },
      {
        label: 'Trip',
        file: 'Trip'
      },
      {
        label: 'Vehicles',
        file: 'Vehicles'
      },
      {
        label: 'Vehicle papers',
        file: 'VehicleFile'
      }
    ]
  },
  {
    name: 'Cash and bank',
    key: 'money',
    usedBy: 'Cash holder, accountant, Admin',
    steps: [
      {
        label: 'Cash book',
        file: 'CashBook'
      },
      {
        label: 'Check against Tally',
        file: 'CashBookCheck'
      },
      {
        label: 'Bank',
        file: 'BankReco'
      },
      {
        label: 'Cash flow',
        file: 'CashFlow'
      },
      {
        label: 'Month-end close',
        file: 'MonthClose'
      }
    ]
  },
  {
    name: 'Books and tax',
    key: 'books',
    usedBy: 'Admin, CA',
    steps: [
      {
        label: 'Tally books, Biochem',
        file: 'TallyBiochem'
      },
      {
        label: 'Tally books, Plastics',
        file: 'TallyPlastics'
      },
      {
        label: 'Bug fixer',
        file: 'BookFixes'
      },
      {
        label: 'GST',
        file: 'GST'
      },
      {
        label: 'Financials',
        file: 'Reports'
      },
      {
        label: 'Schedule III',
        file: 'ScheduleIIIBiochem'
      }
    ]
  },
  {
    name: 'Staff and payroll',
    key: 'staff',
    usedBy: 'Admin, supervisors',
    steps: [
      {
        label: 'Add staff',
        file: 'AddStaff'
      },
      {
        label: 'KYC',
        file: 'StaffKYC'
      },
      {
        label: 'Duties',
        file: 'StaffDuties'
      },
      {
        label: 'Rotation',
        file: 'StaffRotation'
      },
      {
        label: 'Attendance',
        file: 'Attendance'
      },
      {
        label: 'Hours',
        file: 'WorkerHours'
      },
      {
        label: 'Requests',
        file: 'Requests'
      },
      {
        label: 'Allowances',
        file: 'Allowances'
      },
      {
        label: 'Cash given',
        file: 'CashGiven'
      },
      {
        label: 'Payroll',
        file: 'Payroll'
      },
      {
        label: 'Biochem payroll',
        file: 'PayrollBiochem'
      },
      {
        label: 'Pay trend',
        file: 'PayrollBiochemTrend'
      },
      {
        label: 'Staff app flow',
        file: 'StaffWorkflow'
      }
    ]
  },
  {
    name: 'Partners and investors',
    key: 'partners',
    usedBy: 'Admin, partners',
    steps: [
      {
        label: 'Directors and investment',
        file: 'Directors'
      },
      {
        label: 'Profit sharing',
        file: 'ProfitSharing'
      },
      {
        label: 'Partner requests',
        file: 'PartnerRequests'
      },
      {
        label: 'Group view',
        file: 'InvestorGroup'
      }
    ]
  },
  {
    name: 'Set-up',
    key: 'setup',
    usedBy: 'Admin',
    steps: [
      {
        label: 'Companies',
        file: 'Companies'
      },
      {
        label: 'Branches and GSTINs',
        file: 'Branches'
      },
      {
        label: 'Units',
        file: 'Units'
      },
      {
        label: 'Users',
        file: 'Users'
      },
      {
        label: 'Special permissions',
        file: 'SpecialAccess'
      },
      {
        label: 'Forms and fields',
        file: 'FormFields'
      },
      {
        label: 'Numbering',
        file: 'Numbering'
      },
      {
        label: 'Document templates',
        file: 'DocPreview'
      },
      {
        label: 'WhatsApp and email',
        file: 'WhatsApp'
      }
    ]
  },
  {
    name: 'Records and safety',
    key: 'control',
    usedBy: 'Admin, CA',
    steps: [
      {
        label: 'Licences and documents',
        file: 'Licences'
      },
      {
        label: 'Asset register',
        file: 'AssetRegister'
      },
      {
        label: 'Load Tally data',
        file: 'DataImport'
      },
      {
        label: 'Backup',
        file: 'Backup'
      },
      {
        label: 'User log',
        file: 'UserLog'
      },
      {
        label: 'Transaction log',
        file: 'TransactionLog'
      }
    ]
  }
]

/** Main flows set explicitly in §UX-4.1 for pages that sit in several flows. */
export const MAIN_FLOW_OVERRIDES: Record<string, string> = {
  SalesControls: 'field',
  StockTransfer: 'credit',
  Warehouse: 'warehouse',
  ProductMaster: 'stock',
  RawMaterial: 'stock',
  BiochemLabs: 'bio',
  BankReco: 'money',
  MonthClose: 'money',
  Companies: 'setup',
  Invoice: 'sales',
  LawRules: 'home',
  DataImport: 'control',
}

/** Screens that never show the strip: sign-in, investor portal and every phone/tablet screen. */
export function flowForScreen(file: string): { flow: Flow; stepIndex: number } | null {
  const screen = SCREEN_BY_FILE[file]
  // Total workflow is the map of every flow, so it has no strip of its own (design).
  if (!screen || file === 'ERPFlow' || screen.device !== 'desktop' || screen.route.startsWith('/investor') || screen.route.includes('sign-in')) {
    return null
  }
  const preferred = MAIN_FLOW_OVERRIDES[file]
  const candidates = FLOWS.filter((f) => f.steps.some((s) => s.file === file))
  const flow = (preferred && candidates.find((f) => f.key === preferred)) || candidates[0]
  if (!flow) return null
  return { flow, stepIndex: flow.steps.findIndex((s) => s.file === file) }
}

export function routeForFile(file: string): string {
  return SCREEN_BY_FILE[file]?.route ?? '/'
}

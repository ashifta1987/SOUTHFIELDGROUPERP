# Page inventory — Southfield ERP

Generated from the approved design canvas (132 boards). One row per screen. Use it to plan routes, build order and tests.

- **Reference image:** `design-reference/screens/<Name>.jpg` · **Reference HTML:** `design-reference/html/<Name>.html` (a static snapshot; read the inline styles and wording; figures are masked as `X`).
- **Route** is the suggested React Router path. Keep the repo’s own paths if they already exist, and record the mapping in `docs/MODULE_INVENTORY.md`.
- **Signed in as** is the role the reference screen was drawn for. Other roles see the same page trimmed by rights and by the GST view (see §UX-5 in `docs/prompts/SOUTHFIELD_ERP_PROMPT.md`).
- **Sample** = the reference uses a labelled sample layout or sample day; the real screen shows live data only.

## Sign-in

| Screen (file) | What it is | Device | Route | Signed in as | Workflows | Strip | Sample |
|---|---|---|---|---|---|---|---|
| **Login** `Login` | Sign in — WhatsApp number + password (email for Admin and finance) | Desktop 1440 | `/sign-in` | — | — |  |  |
| **StaffSignIn** `StaffSignIn` | Staff app — sign in with WhatsApp number | Phone 390 | `/staff/sign-in` | — | — |  |  |
| **InvestorSignIn** `InvestorSignIn` | Investor portal — separate sign-in | Phone 390 | `/investor/sign-in` | — | — |  |  |

## Home

| Screen (file) | What it is | Device | Route | Signed in as | Workflows | Strip | Sample |
|---|---|---|---|---|---|---|---|
| **Main** `Main` | Owner dashboard — Biochem sales with GST and without GST | Desktop 1440 | `/` | Ashif · Admin | Owner overview | yes |  |

## Sales

| Screen (file) | What it is | Device | Route | Signed in as | Workflows | Strip | Sample |
|---|---|---|---|---|---|---|---|
| **Invoices** `Invoice` | Sales invoice — tax panel | Desktop 1440 | `/sales/invoices` | — | Selling, Field sales and own shops, Credit and collections |  | yes |
| **Quotations & orders** `SalesOrders` | Quotations and sales orders | Desktop 1440 | `/sales/quotations-and-orders` | Ashif · Admin | Warehouse loop, Selling, Field sales and own shops, Credit and collections | yes |  |
| **Customers (second view)** `CustomerKYC` | Buyer KYC — new buyer form | Desktop 1440 | `/sales/customers/customer-kyc` | Ashif · Admin | Selling, Credit and collections | yes |  |
| **Shops and supermarkets** `ShopSales` | Shops, supermarkets and the Kochi counter | Desktop 1440 | `/sales/shops-and-supermarkets` | Ashif · Admin | Selling | yes |  |
| **Price lists** `PriceList` | Southfield Plastics wholesale price list | Desktop 1440 | `/sales/price-lists` | Ashif · Admin | Selling | yes |  |
| **Online channels** `OnlineSales` | Online channels: Shopify, Amazon, Flipkart, JioMart, Meesho | Desktop 1440 | `/sales/online-channels` | Ashif · Admin | Selling | yes |  |
| **Customers** `Customers` | Customers · Admin can add, edit, remove | Desktop 1440 | `/sales/customers` | Ashif · Admin | Selling, Field sales and own shops, Credit and collections | yes |  |
| **Invoices (second view)** `CompanyPortal` | Sales register as the accountant — the same screen, bills with GST only | Desktop 1440 | `/sales/invoices/company-portal` | Accounts user | Selling | yes |  |
| **Invoices (second view)** `SalesRegister` | Sales register as Admin — all October bills, with GST and without GST, marked | Desktop 1440 | `/sales/invoices/sales-register` | Ashif · Admin | Selling | yes |  |
| **Biochem products** `BiochemProducts` | Biochem products — flyer products, MRP, GST and label checks | Desktop 1440 | `/sales/biochem-products` | Ashif · Admin | Biochem production | yes |  |
| **Online listings** `OnlineListings` | Online store listings | Desktop 1440 | `/sales/online-listings` | Ashif · Admin | Selling | yes |  |
| **Route sales** `RouteSales` | Route sales with GPS — sales manager | Desktop 1440 | `/sales/route-sales` | Sales manager | Field sales and own shops | yes | yes |
| **Own shops** `Outlets` | Own shops — Kochi and Coimbatore | Desktop 1440 | `/sales/own-shops` | Ashif · Admin | Field sales and own shops | yes |  |
| **Credit customers** `CreditControl` | Credit customers — approval chain, exposure, MD exceptions | Desktop 1440 | `/sales/credit-customers` | Ashif · Admin | Credit and collections | yes |  |
| **Customer care and agents** `SalesControls` | Customer care, reminders, complaints, private label, agents | Desktop 1440 | `/sales/customer-care-and-agents` | Sales manager | Field sales and own shops, Credit and collections | yes |  |

## Purchase

| Screen (file) | What it is | Device | Route | Signed in as | Workflows | Strip | Sample |
|---|---|---|---|---|---|---|---|
| **Goods receipt** `GoodsReceipt` | Goods receipt | Desktop 1440 | `/purchase/goods-receipt` | Stores | Buying, Warehouse loop | yes |  |
| **Suppliers** `SupplierKYC` | Supplier KYC | Desktop 1440 | `/purchase/suppliers` | Ashif · Admin | Buying | yes |  |
| **Purchase requests** `PurchaseRequest` | Purchase requests by department | Desktop 1440 | `/purchase/purchase-requests` | Ashif · Admin | Buying | yes |  |
| **Bill photo capture** `BillReview` | Bill read from photo — KVN Impex | Desktop 1440 | `/purchase/bill-photo-capture` | Ashif · Admin | Buying | yes |  |
| **Price changes** `PriceChanges` | Price change report | Desktop 1440 | `/purchase/price-changes` | Ashif · Admin | Buying | yes |  |

## Production

| Screen (file) | What it is | Device | Route | Signed in as | Workflows | Strip | Sample |
|---|---|---|---|---|---|---|---|
| **Mould projects** `Moulds` | Mould projects | Desktop 1440 | `/production/mould-projects` | Ravi · Toolroom | Plastics production | yes |  |
| **Machine assembly** `Machines` | Machine assembly | Desktop 1440 | `/production/machine-assembly` | Sunil · Assembly | Plastics production | yes |  |
| **Injection production** `Production` | Injection production — machine, operator, mould, hours, output by shift | Desktop 1440 | `/production/injection-production` | Krishna · Injection, Mangad | Plastics production | yes |  |
| **Quality** `Quality` | Quality inspections | Desktop 1440 | `/production/quality` | Latha · Quality | Plastics production | yes |  |
| **Maintenance** `Maintenance` | Machine care — daily checks, repair requests, spares and oil | Desktop 1440 | `/production/maintenance` | Ashif · Admin | Plastics production | yes |  |
| **Job work** `JobWork` | Job work | Desktop 1440 | `/production/job-work` | Stores | Plastics production | yes |  |
| **Mould costing** `MouldCosting` | Mould cost sheet | Desktop 1440 | `/production/mould-costing` | Ashif · Admin | Plastics production | yes |  |
| **Component costing** `ComponentCosting` | Component cost sheet — granules, colour, packing, scrap credit | Desktop 1440 | `/production/component-costing` | Ashif · Admin | Plastics production | yes |  |
| **Assembled products** `AssemblyCosting` | Assembled product — bill of materials and cost | Desktop 1440 | `/production/assembled-products` | Ashif · Admin | Plastics production | yes |  |
| **Pad printing** `PadPrinting` | Pad printing — jobs, inks, cost per print | Desktop 1440 | `/production/pad-printing` | Ashif · Admin | Plastics production | yes |  |
| **Mould register** `MouldRegister` | Mould register — every mould, where it is, which machine | Desktop 1440 | `/production/mould-register` | Ashif · Admin | Plastics production | yes |  |
| **Biochem manufacturing** `BiochemManufacturing` | Biochem manufacturing — process families and production | Desktop 1440 | `/production/biochem-manufacturing` | Ashif · Admin | Biochem production | yes |  |
| **Biochem costing** `BiochemCosting` | Biochem product costing | Desktop 1440 | `/production/biochem-costing` | Ashif · Admin | Biochem production | yes |  |
| **Biochem production entry** `BiochemProduction` | Biochem production entry — one batch from weighing to release | Desktop 1440 | `/production/biochem-production-entry` | Ashif · Admin | Warehouse loop, Biochem production | yes |  |
| **Biochem production flow** `BiochemFlow` | Biochem production flow — who does each step, gates and side flows (from the SOP) | Desktop 1440 | `/production/biochem-production-flow` | Ashif · Admin | Biochem production | yes |  |
| **Biochem labs** `BiochemLabs` | Biochem labs — R&D and testing | Desktop 1440 | `/production/biochem-labs` | Ashif · Admin | Buying, Warehouse loop, Biochem production | yes |  |
| **Factory work assignment** `BiochemWork` | Factory work — who does what today | Desktop 1440 | `/production/factory-work-assignment` | Ashif · Admin | Biochem production | yes |  |
| **Free items and gift packs** `BiochemBundles` | Free items and gift packs | Desktop 1440 | `/production/free-items-and-gift-packs` | Ashif · Admin | Warehouse loop, Biochem production | yes |  |
| **Biochem machines** `BiochemAssets` | Biochem machines and assets | Desktop 1440 | `/production/biochem-machines` | Ashif · Admin | Biochem production | yes |  |

## Inventory

| Screen (file) | What it is | Device | Route | Signed in as | Workflows | Strip | Sample |
|---|---|---|---|---|---|---|---|
| **Raw material** `RawMaterial` | Raw material stock | Desktop 1440 | `/inventory/raw-material` | Stores | Buying, Stock | yes |  |
| **Component stock** `ComponentStock` | Component stock | Desktop 1440 | `/inventory/component-stock` | Stores | Stock | yes |  |
| **Stock movements** `StockMovement` | Stock movements and issue | Desktop 1440 | `/inventory/stock-movements` | Stores | Warehouse loop, Stock | yes |  |
| **Scrap and regrind** `Scrap` | Scrap and regrind — sales revenue | Desktop 1440 | `/inventory/scrap-and-regrind` | Ashif · Admin | Stock | yes |  |
| **Product master** `ProductMaster` | Product master — both companies, grouped | Desktop 1440 | `/inventory/product-master` | Ashif · Admin | Stock, Biochem production | yes |  |
| **Warehouse** `Warehouse` | Warehouse — receipt to manufacturing to delivery | Desktop 1440 | `/inventory/warehouse` | Ashif · Admin | Warehouse loop | yes |  |
| **Stock transfers** `StockTransfer` | Stock transfers — two people at each end, transit | Desktop 1440 | `/inventory/stock-transfers` | Ashif · Admin | Credit and collections | yes |  |

## Logistics

| Screen (file) | What it is | Device | Route | Signed in as | Workflows | Strip | Sample |
|---|---|---|---|---|---|---|---|
| **Dispatch board** `Dispatch` | Dispatch board | Desktop 1440 | `/logistics/dispatch-board` | — | Warehouse loop, Delivery |  |  |
| **Trips** `Trip` | Trip detail | Desktop 1440 | `/logistics/trips` | — | Warehouse loop, Delivery |  |  |
| **Vehicles & drivers** `Vehicles` | Vehicles and drivers | Desktop 1440 | `/logistics/vehicles-and-drivers` | Ashif · Admin | Delivery | yes |  |
| **Vehicle file** `VehicleFile` | Vehicle file — fuel, EMI, repairs, accidents, fines | Desktop 1440 | `/logistics/vehicle-file` | Ashif · Admin | Delivery | yes |  |

## Exports

| Screen (file) | What it is | Device | Route | Signed in as | Workflows | Strip | Sample |
|---|---|---|---|---|---|---|---|
| **Mixer grinder costing** `MixerCosting` | Mixer grinder costing — SF1000W GM and promo model | Desktop 1440 | `/exports/mixer-grinder-costing` | Ashif · Admin | Mixer grinder export | yes |  |
| **Export orders** `ExportOrders` | Export orders and containers | Desktop 1440 | `/exports/export-orders` | Ashif · Admin | Mixer grinder export | yes |  |

## HR & payroll

| Screen (file) | What it is | Device | Route | Signed in as | Workflows | Strip | Sample |
|---|---|---|---|---|---|---|---|
| **Employees & KYC** `StaffKYC` | Staff KYC | Desktop 1440 | `/hr-and-payroll/employees-and-kyc` | Ashif · Admin | Staff and payroll | yes |  |
| **Payroll** `Payroll` | Payroll — October 2026 | Desktop 1440 | `/hr-and-payroll/payroll` | Ashif · Admin | Staff and payroll | yes |  |
| **Attendance** `Attendance` | Attendance — October 2026 | Desktop 1440 | `/hr-and-payroll/attendance` | Ashif · Admin | Staff and payroll | yes |  |
| **Leave & advance requests** `Requests` | Leave and advance requests | Desktop 1440 | `/hr-and-payroll/leave-and-advance-requests` | Ashif · Admin | Staff and payroll | yes |  |
| **Staff duties** `StaffDuties` | Staff duties and labour cost | Desktop 1440 | `/hr-and-payroll/staff-duties` | Ashif · Admin | Staff and payroll | yes |  |
| **Staff rotation** `StaffRotation` | Staff rotation between the two companies | Desktop 1440 | `/hr-and-payroll/staff-rotation` | Ashif · Admin | Staff and payroll | yes |  |
| **Payroll (second view)** `PayrollBiochem` | Payroll — Southfield Biochem, October 2026 | Desktop 1440 | `/hr-and-payroll/payroll/payroll-biochem` | Ashif · Admin | Staff and payroll | yes |  |
| **Payroll (second view)** `PayrollBiochemTrend` | Biochem payroll — April to October 2026 | Desktop 1440 | `/hr-and-payroll/payroll/payroll-biochem-trend` | Ashif · Admin | Staff and payroll | yes |  |
| **Employees & KYC (second view)** `AddStaff` | Add staff — designation, top official, operating profit ratio, investment share | Desktop 1440 | `/hr-and-payroll/employees-and-kyc/add-staff` | Ashif · Admin | Staff and payroll | yes |  |
| **Workers and hours** `WorkerHours` | Workers, factories and hours — October 2026 from both registers | Desktop 1440 | `/hr-and-payroll/workers-and-hours` | Ashif · Admin | Staff and payroll | yes |  |
| **Workers and hours (second view)** `StaffWorkflow` | Staff workflow — join the group, assign a factory, mark hours, switch, pay, share profit | Desktop 1440 | `/hr-and-payroll/workers-and-hours/staff-workflow` | Ashif · Admin | Staff and payroll | yes |  |
| **Allowances and benefits** `Allowances` | Allowances and benefits — types, October lines to classify, insurance | Desktop 1440 | `/hr-and-payroll/allowances-and-benefits` | Ashif · Admin | Staff and payroll | yes |  |
| **Cash given to staff** `CashGiven` | Cash given to staff — by staff ID and type, October advances | Desktop 1440 | `/hr-and-payroll/cash-given-to-staff` | Ashif · Admin | Staff and payroll | yes |  |

## Accounts

| Screen (file) | What it is | Device | Route | Signed in as | Workflows | Strip | Sample |
|---|---|---|---|---|---|---|---|
| **Cash book** `CashBook` | Cash book — day view (Biochem Chalissery, 31-Oct-2026) | Desktop 1440 | `/accounts/cash-book` | Ashif · Admin | Field sales and own shops, Cash and bank | yes |  |
| **Bank** `BankReco` | Bank reconciliation — HDFC statement | Desktop 1440 | `/accounts/bank` | Ashif · Admin | Buying, Credit and collections, Cash and bank | yes |  |
| **Financials** `Reports` | Financials for each company · Admin sees with GST, without GST and all, automatically | Desktop 1440 | `/accounts/financials` | Ashif · Admin | Books and tax | yes |  |
| **GST** `GST` | GST page | Desktop 1440 | `/accounts/gst` | Ashif · Admin | Books and tax | yes |  |
| **Month-end close** `MonthClose` | Month-end close on the 10th | Desktop 1440 | `/accounts/month-end-close` | Ashif · Admin | Stock, Cash and bank | yes |  |
| **Cash flow and reminders** `CashFlow` | Cash flow and reminders | Desktop 1440 | `/accounts/cash-flow-and-reminders` | Ashif · Admin | Cash and bank | yes |  |
| **Directors and investment** `Directors` | Directors, investment and loans | Desktop 1440 | `/accounts/directors-and-investment` | Ashif · Admin | Partners and investors | yes |  |
| **Partners and profit sharing** `ProfitSharing` | Partners, incentives (minutes of 11-05-2023) and profit sharing | Desktop 1440 | `/accounts/partners-and-profit-sharing` | Ashif · Admin | Partners and investors | yes |  |
| **Partner requests** `PartnerRequests` | Partner requests — withdrawals, loans, project offers (Admin) | Desktop 1440 | `/accounts/partner-requests` | Ashif · Admin | Partners and investors | yes |  |
| **Schedule III statements** `ScheduleIIIBiochem` | Biochem in Schedule III format — balance sheet, profit and loss, notes (Admin and CA) | Desktop 1440 | `/accounts/schedule-iii-statements` | Ashif · Admin | Books and tax | yes |  |
| **Cash book (second view)** `CashBookCheck` | Cash book check — day by day against Tally, cash limits, book errors, mixer-grinder sheet | Desktop 1440 | `/accounts/cash-book/cash-book-check` | Ashif · Admin | Cash and bank | yes |  |

## Admin

| Screen (file) | What it is | Device | Route | Signed in as | Workflows | Strip | Sample |
|---|---|---|---|---|---|---|---|
| **Users & rights** `Users` | Users and rights | Desktop 1440 | `/admin/users-and-rights` | Ashif · Admin | Set-up | yes |  |
| **User log** `UserLog` | User activity log | Desktop 1440 | `/admin/user-log` | Ashif · Admin | Records and safety | yes |  |
| **Backup** `Backup` | Backup | Desktop 1440 | `/admin/backup` | Ashif · Admin | Records and safety | yes |  |
| **Import data** `DataImport` | Import data — Tally and bulk products | Desktop 1440 | `/admin/import-data` | Ashif · Admin | Records and safety | yes |  |
| **Document templates** `DocPreview` | Preview, download, email, WhatsApp | Desktop 1440 | `/admin/document-templates` | Ashif · Admin | Set-up | yes |  |
| **Numbering & IDs** `Numbering` | Numbering and IDs | Desktop 1440 | `/admin/numbering-and-ids` | Ashif · Admin | Set-up | yes |  |
| **WhatsApp & email** `WhatsApp` | WhatsApp, SMS and email | Desktop 1440 | `/admin/whatsapp-and-email` | Ashif · Admin | Set-up | yes |  |
| **Units** `Units` | Four units and how goods move between them | Desktop 1440 | `/admin/units` | Ashif · Admin | Set-up | yes |  |
| **Asset register** `AssetRegister` | Asset register — machines and equipment by unit, incl. Chalissery assembly | Desktop 1440 | `/admin/asset-register` | Ashif · Admin | Records and safety | yes |  |
| **Companies** `Companies` | Southfield Group: two companies, their logos and GSTINs | Desktop 1440 | `/admin/companies` | Ashif · Admin | Mixer grinder export, Set-up | yes |  |
| **Branches and GSTINs** `Branches` | Southfield Biochem branches, GSTINs and banks | Desktop 1440 | `/admin/branches-and-gstins` | Ashif · Admin | Set-up | yes |  |
| **Forms and fields** `FormFields` | Forms and fields · Admin only | Desktop 1440 | `/admin/forms-and-fields` | Ashif · Admin | Set-up | yes |  |
| **Import data (second view)** `TallyBiochem` | What Biochem’s Tally books change — net worth, partners, loans, mixer grinders, payroll, banks | Desktop 1440 | `/admin/import-data/tally-biochem` | Ashif · Admin | Books and tax | yes |  |
| **Import data (second view)** `TallyPlastics` | What Southfield Plastics’ Tally books change — moulds, mixer grinders, partners, stock, GST | Desktop 1440 | `/admin/import-data/tally-plastics` | Ashif · Admin | Books and tax | yes |  |
| **Built to Indian law** `LawRules` | Built to Indian law — rules and where the books stand | Desktop 1440 | `/admin/built-to-indian-law` | Ashif · Admin | Owner overview | yes |  |
| **How each person sees it** `UXOverview` | How each person sees the ERP — Admin, CA, accountant, staff, partners | Desktop 1440 | `/admin/how-each-person-sees-it` | Ashif · Admin | Owner overview | yes |  |
| **Bug fixer** `BookFixes` | Fix in books — problems from Tally loads, fixed with the right ledger | Desktop 1440 | `/admin/bug-fixer` | Ashif · Admin | Books and tax | yes |  |
| **Special permissions** `SpecialAccess` | Special permissions — time-limited rights with limits Admin fixes; Office admin | Desktop 1440 | `/admin/special-permissions` | Ashif · Admin | Set-up | yes |  |
| **Transaction log** `TransactionLog` | Transaction log — every change to every entry, before and after | Desktop 1440 | `/admin/transaction-log` | Ashif · Admin | Records and safety | yes | yes |
| **Total workflow** `ERPFlow` | Total workflow — every workflow, its steps and the hand-offs | Desktop 1440 | `/admin/total-workflow` | Ashif · Admin | Owner overview |  |  |
| **Licences and documents** `Licences` | Licences, certificates and documents | Desktop 1440 | `/admin/licences-and-documents` | Ashif · Admin | Records and safety | yes |  |

## Phone and tablet screens by job

| Screen (file) | What it is | Device | Route | Signed in as | Workflows | Strip | Sample |
|---|---|---|---|---|---|---|---|
| **BillCapture** `BillCapture` | Bill photo — phone camera | Phone 390 | `/me/bill-photo` | — | — |  |  |
| **RaviHome** `RaviHome` | Ravi · mould manager · Malayalam | Phone 390 | `/me/mould-manager` | — | — |  |  |
| **KrishnaHome** `KrishnaHome` | Krishna · injection manager · Malayalam | Phone 390 | `/me/injection-manager` | — | — |  |  |
| **RafeeqHome** `RafeeqHome` | Rafeek · buying, logistics, petty cash | Phone 390 | `/me/buying-logistics` | — | — |  |  |
| **OperatorCheck** `OperatorCheck` | Hasanan, Parvej, Rehaan · daily machine check · Hindi | Phone 390 | `/me/machine-check` | — | — |  |  |
| **IsmailHome** `IsmailHome` | Ismayilkka · factory manager · Malayalam | Phone 390 | `/me/factory-manager` | — | — |  |  |
| **CashEntry** `CashEntry` | Cash entry on the phone — pay over ₹10,000 goes to the bank | Phone 390 | `/me/cash-entry` | — | — |  |  |
| **LabPanel** `LabPanel` | Lab panel — chemist’s tablet | Tablet 834 | `/lab` | — | — |  | yes |
| **SalesmanApp** `SalesmanApp` | Salesman app — phone | Phone 390 | `/field/today` | — | Field sales and own shops |  | yes |

## Staff app (phone)

| Screen (file) | What it is | Device | Route | Signed in as | Workflows | Strip | Sample |
|---|---|---|---|---|---|---|---|
| **StaffHome** `StaffHome` | Staff app — home (Ravi, October) | Phone 390 | `/staff/home` | — | — |  |  |
| **StaffLeave** `StaffLeave` | Staff app — request leave | Phone 390 | `/staff/leave` | — | — |  |  |
| **StaffAdvance** `StaffAdvance` | Staff app — request advance | Phone 390 | `/staff/advance` | — | — |  |  |
| **StaffDetails** `StaffDetails` | Staff app — my details | Phone 390 | `/staff/details` | — | — |  |  |
| **StaffPayslip** `StaffPayslip` | Staff app — payslip (October) | Phone 390 | `/staff/payslip` | — | — |  |  |
| **StaffPayslipHasanan** `StaffPayslipHasanan` | Staff app — payslip with allowances (Hasanan, October) | Phone 390 | `/staff/payslip (with allowances)` | — | — |  |  |

## Driver app (phone)

| Screen (file) | What it is | Device | Route | Signed in as | Workflows | Strip | Sample |
|---|---|---|---|---|---|---|---|
| **DriverTrip** `DriverTrip` | Driver — current trip | Phone 390 | `/driver/trip` | — | — |  |  |
| **DriverPOD** `DriverPOD` | Driver — proof of delivery | Phone 390 | `/driver/pod` | — | Warehouse loop |  |  |

## Investor portal

| Screen (file) | What it is | Device | Route | Signed in as | Workflows | Strip | Sample |
|---|---|---|---|---|---|---|---|
| **InvestorGroup** `InvestorGroup` | Investor portal — Ashif, whole group (desktop) | Desktop 1440 | `/investor/group` | — | Partners and investors |  |  |
| **PartnerHome** `PartnerHome` | Investor portal — today (analytics only) | Phone 390 | `/investor/home` | — | — |  |  |
| **PartnerPerformance** `PartnerPerformance` | Investor portal — performance charts | Phone 390 | `/investor/performance` | — | — |  |  |
| **PartnerInvestment** `PartnerInvestment` | Investor portal — my investment and net worth | Phone 390 | `/investor/investment` | — | — |  |  |
| **InvestorWorkingPartner** `InvestorWorkingPartner` | Investor portal — working partner (Ismayilkka, Malayalam) | Phone 390 | `/investor/working-partner` | — | — |  |  |
| **InvestorProjects** `InvestorProjects` | Investor portal — projects | Phone 390 | `/investor/projects` | — | — |  |  |
| **InvestorWithdraw** `InvestorWithdraw` | Investor portal — request a withdrawal | Phone 390 | `/investor/withdraw` | — | — |  |  |
| **InvestorLoan** `InvestorLoan` | Investor portal — loan request (borrow or lend) | Phone 390 | `/investor/loan` | — | — |  |  |

## Shared component

| Screen (file) | What it is | Device | Route | Signed in as | Workflows | Strip | Sample |
|---|---|---|---|---|---|---|---|
| **Sidebar** `Sidebar` | Sidebar component | Component | `—` | — | — |  |  |
| **Topbar** `Topbar` | Top bar component | Component | `—` | — | — |  |  |
| **StaffNav** `StaffNav` | Staff app tabs component | Component | `—` | — | — |  |  |
| **FlowStrip** `FlowStrip` | Workflow strip component | Component | `—` | — | — |  |  |

## Design reference

| Screen (file) | What it is | Device | Route | Signed in as | Workflows | Strip | Sample |
|---|---|---|---|---|---|---|---|
| **StyleGuide** `StyleGuide` | Style guide | Reference | `—` | — | — |  |  |
| **Logo** `Logo` | Southfield Plastic logo | Reference | `—` | — | — |  |  |


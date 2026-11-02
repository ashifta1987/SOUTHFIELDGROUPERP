# Module inventory — screen → route → component → tables → RPCs

Phase 0 audit result: **the repo was empty** (only the prompt pack). No existing screens, so every screen is "missing (repo was empty)" except the five Phase 0 shells. Routes follow `docs/design/PAGE_INVENTORY.md`; the per-screen phase map in code is `src/app/screens.ts` and must stay identical to the **Phase** column here.

Conventions:

- Tables are schema-qualified and **planned**; final contracts go into `docs/DATABASE_SCHEMA.md` before each phase.
- RPCs are in schema `api`; every posting RPC takes `p_client_request_id uuid` first (omitted below for brevity). Reads go through `api.v_*` `security_invoker` views.
- Component paths are role-based, never people's names (reference files named after people are referenced only by their file name).
- **Status values:** `missing (repo was empty)` · `Phase 0 shell: UI built, empty states; data in Phase N`.
- Tests column is filled when a screen is built (pgTAP + Playwright DB assertion + axe), per §UX-12.

## Sign-in

| Screen (ref) | Route | Component | Main tables | RPCs (planned) | Phase | Status |
|---|---|---|---|---|---|---|
| Login `Login` | `/sign-in` | `src/features/auth/SignInPage.tsx` | `auth.users`, `audit.user_log` | Supabase Auth (email+password+TOTP / phone+password); `api.log_user_event` (P1) | 0 | Phase 0 shell: UI built, empty states; data in Phase 1 (user log, lock-out, `api.me`) |
| StaffSignIn `StaffSignIn` | `/staff/sign-in` | `src/features/auth/StaffSignInPage.tsx` | `auth.users`, `audit.user_log` | Supabase Auth phone+password; `api.log_user_event` (P1) | 0 | Phase 0 shell: UI built, empty states; data in Phase 1 |
| InvestorSignIn `InvestorSignIn` | `/investor/sign-in` | `src/features/investor/InvestorSignInPage.tsx` | `auth.users`, `acct.partners` | Supabase Auth; `api.investor_me()` | 7 | missing (repo was empty) |

## Home

| Screen (ref) | Route | Component | Main tables | RPCs (planned) | Phase | Status |
|---|---|---|---|---|---|---|
| Main `Main` | `/` | `src/features/home/HomePage.tsx` | `api.v_home_kpis` over `acct.gl_entries`, `sales.invoices`, `ops.bug_items`, `core.licences`, `hr.attendance_hours` | `api.home_dashboard(p_company_id, p_from, p_to)` | 0 | Phase 0 shell: UI built, empty states; data in Phase 3 (KPIs grow through Phase 7) |

## Sales

| Screen (ref) | Route | Component | Main tables | RPCs (planned) | Phase | Status |
|---|---|---|---|---|---|---|
| Invoices `Invoice` | `/sales/invoices` | `src/features/sales/InvoicePage.tsx` | `sales.invoices`, `sales.invoice_lines`, `sales.invoice_tax_lines`, `master.hsn_rates`, `core.doc_series` | `api.preview_invoice_tax`, `api.post_sales_invoice`, `api.reverse_document` | 3 | missing (repo was empty) |
| Quotations & orders `SalesOrders` | `/sales/quotations-and-orders` | `src/features/sales/SalesOrdersPage.tsx` | `sales.quotations`, `sales.orders`, `sales.order_lines`, `inv.reservations` | `api.create_quotation`, `api.confirm_sales_order`, `api.check_credit_exposure` | 6 | missing (repo was empty) |
| Customers (second view) `CustomerKYC` | `/sales/customers/customer-kyc` | `src/features/sales/CustomerKycPage.tsx` | `master.parties`, `master.party_companies`, `master.party_contacts`, `master.party_addresses`, `master.party_documents`, `master.gstin_checks`, `msg.contacts` | `api.propose_customer`, `api.verify_party_kyc`, `api.record_consent` | 2 | missing (repo was empty) |
| Shops and supermarkets `ShopSales` | `/sales/shops-and-supermarkets` | `src/features/sales/ShopSalesPage.tsx` | `sales.orders`, `sales.invoices`, `master.parties` | `api.confirm_sales_order`, `api.post_sales_invoice` | 6 | missing (repo was empty) |
| Price lists `PriceList` | `/sales/price-lists` | `src/features/sales/PriceListPage.tsx` | `master.price_lists`, `master.price_list_items`, `master.product_mrp_history` | `api.upsert_price_list`, `api.approve_price_change` | 2 | missing (repo was empty) |
| Online channels `OnlineSales` | `/sales/online-channels` | `src/features/sales/OnlineSalesPage.tsx` | `sales.online_channels`, `sales.online_orders`, `acct.tcs_reconciliation` | `api.ingest_online_order` (via `store-webhooks`) | 6 | missing (repo was empty) |
| Customers `Customers` | `/sales/customers` | `src/features/sales/CustomersPage.tsx` | `master.parties`, `master.party_companies`, `api.v_customer_outstanding` | `api.v_customers` (list), `api.propose_customer`, `api.archive_party` | 2 | Phase 0 shell: UI built, empty states; data in Phase 2 |
| Invoices (second view) `CompanyPortal` | `/sales/invoices/company-portal` | `src/features/sales/AccountantRegisterPage.tsx` | `api.v_sales_register` (RLS: GST view) | `api.sales_register(p_filters)` | 3 | missing (repo was empty) |
| Invoices (second view) `SalesRegister` | `/sales/invoices/sales-register` | `src/features/sales/SalesRegisterPage.tsx` | `api.v_sales_register` (RLS: all view) | `api.sales_register(p_filters)`, `api.export_register` | 3 | missing (repo was empty) |
| Biochem products `BiochemProducts` | `/sales/biochem-products` | `src/features/sales/BiochemProductsPage.tsx` | `master.products`, `master.product_labels`, `master.product_mrp_history`, `master.hsn_rates` | `api.upsert_product`, `api.check_label` | 2 | missing (repo was empty) |
| Online listings `OnlineListings` | `/sales/online-listings` | `src/features/sales/OnlineListingsPage.tsx` | `sales.listings`, `master.products` | `api.publish_listing` (Admin) | 6 | missing (repo was empty) |
| Route sales `RouteSales` | `/sales/route-sales` | `src/features/sales/RouteSalesPage.tsx` | `field.beats`, `field.visits`, `field.gps_points`, `field.cash_handovers` | `api.plan_beat`, `api.approve_out_of_geofence` | 6 | missing (repo was empty) |
| Own shops `Outlets` | `/sales/own-shops` | `src/features/sales/OwnShopsPage.tsx` | `sales.shop_days`, `sales.invoices`, `inv.transfers` | `api.shop_day_close`, `api.cash_handover` | 6 | missing (repo was empty) |
| Credit customers `CreditControl` | `/sales/credit-customers` | `src/features/sales/CreditControlPage.tsx` | `sales.credit_applications`, `sales.credit_approvals`, `sales.credit_exceptions`, `master.credit_terms` | `api.submit_credit_application`, `api.approve_credit_stage`, `api.grant_md_exception` | 6 | missing (repo was empty) |
| Customer care and agents `SalesControls` | `/sales/customer-care-and-agents` | `src/features/sales/CustomerCarePage.tsx` | `sales.complaints`, `sales.complaint_events`, `sales.agents`, `sales.agent_commissions`, `sales.private_label_orders`, `msg.outbox` | `api.log_complaint`, `api.qc_hold_batch`, `api.close_complaint`, `api.schedule_reminders` | 6 | missing (repo was empty) |
| *Receipts* (no reference) | `/sales/receipts` | `src/features/sales/ReceiptsPage.tsx` | `sales.receipts`, `sales.receipt_allocations`, `acct.gl_entries` | `api.check_cash_limit`, `api.post_receipt` | 3 | missing (repo was empty) — build from §UX-7 list + document patterns |

## Purchase

| Screen (ref) | Route | Component | Main tables | RPCs (planned) | Phase | Status |
|---|---|---|---|---|---|---|
| Goods receipt `GoodsReceipt` | `/purchase/goods-receipt` | `src/features/purchase/GoodsReceiptPage.tsx` | `purch.goods_receipts`, `purch.grn_lines`, `inv.stock_ledger`, `inv.lots` | `api.post_goods_receipt` | 4 | missing (repo was empty) |
| Suppliers `SupplierKYC` | `/purchase/suppliers` | `src/features/purchase/SupplierKycPage.tsx` | `master.parties`, `master.party_bank_accounts`, `master.bank_change_requests`, `master.supplier_material_approvals` | `api.upsert_supplier`, `api.request_bank_change`, `api.approve_bank_change` | 2 | missing (repo was empty) |
| Purchase requests `PurchaseRequest` | `/purchase/purchase-requests` | `src/features/purchase/PurchaseRequestsPage.tsx` | `purch.requests`, `purch.request_lines` | `api.create_purchase_request`, `api.approve_purchase_request` | 4 | missing (repo was empty) |
| Bill photo capture `BillReview` | `/purchase/bill-photo-capture` | `src/features/purchase/BillReviewPage.tsx` | `purch.bill_captures`, `purch.bills`, `purch.orders`, `purch.goods_receipts` | `api.match_bill_to_po_grn`, `api.post_purchase_bill` | 4 | missing (repo was empty) |
| Price changes `PriceChanges` | `/purchase/price-changes` | `src/features/purchase/PriceChangesPage.tsx` | `purch.price_history` | `api.v_price_changes` | 4 | missing (repo was empty) |
| *Purchase orders* (no reference) | `/purchase/purchase-orders` | `src/features/purchase/PurchaseOrdersPage.tsx` | `purch.rfqs`, `purch.quotations`, `purch.orders`, `purch.order_lines` | `api.create_rfq`, `api.record_quotation`, `api.issue_purchase_order` | 4 | missing (repo was empty) — build from §UX-7 patterns |
| *Bills & payments* (no reference) | `/purchase/bills-and-payments` | `src/features/purchase/BillsPaymentsPage.tsx` | `purch.bills`, `purch.payments`, `purch.payment_allocations`, `acct.tds_entries` | `api.post_purchase_bill`, `api.check_cash_limit`, `api.post_payment`, `api.approve_payment` | 3 | missing (repo was empty) — build from §UX-7 patterns |

## Production

| Screen (ref) | Route | Component | Main tables | RPCs (planned) | Phase | Status |
|---|---|---|---|---|---|---|
| Mould projects `Moulds` | `/production/mould-projects` | `src/features/production/MouldProjectsPage.tsx` | `prod.mould_projects`, `prod.moulds` | `api.advance_mould_project` | 5 | missing (repo was empty) |
| Machine assembly `Machines` | `/production/machine-assembly` | `src/features/production/MachineAssemblyPage.tsx` | `prod.assembly_orders`, `prod.assembly_boms`, `inv.stock_ledger` | `api.post_assembly` | 5 | missing (repo was empty) |
| Injection production `Production` | `/production/injection-production` | `src/features/production/InjectionProductionPage.tsx` | `prod.injection_shifts`, `prod.shift_rejects`, `prod.downtime`, `prod.machines`, `prod.moulds` | `api.record_injection_shift` | 5 | missing (repo was empty) |
| Quality `Quality` | `/production/quality` | `src/features/production/QualityPage.tsx` | `prod.quality_inspections` | `api.record_quality_inspection` | 5 | missing (repo was empty) |
| Maintenance `Maintenance` | `/production/maintenance` | `src/features/production/MaintenancePage.tsx` | `prod.machine_checks`, `prod.repair_requests`, `prod.spares_issues` | `api.record_machine_check`, `api.raise_repair_request` | 7 | missing (repo was empty) |
| Job work `JobWork` | `/production/job-work` | `src/features/production/JobWorkPage.tsx` | `prod.job_work_orders`, `sales.delivery_challans`, `inv.stock_ledger` | `api.issue_job_work_challan`, `api.receive_job_work` | 7 | missing (repo was empty) |
| Mould costing `MouldCosting` | `/production/mould-costing` | `src/features/production/MouldCostingPage.tsx` | `prod.mould_costs`, `prod.mould_events` | `api.v_mould_cost` | 5 | missing (repo was empty) |
| Component costing `ComponentCosting` | `/production/component-costing` | `src/features/production/ComponentCostingPage.tsx` | `prod.component_costs`, `prod.material_specs` | `api.v_component_cost` | 5 | missing (repo was empty) |
| Assembled products `AssemblyCosting` | `/production/assembled-products` | `src/features/production/AssembledProductsPage.tsx` | `prod.assembly_boms`, `prod.component_costs` | `api.v_assembly_cost` | 5 | missing (repo was empty) |
| Pad printing `PadPrinting` | `/production/pad-printing` | `src/features/production/PadPrintingPage.tsx` | `prod.pad_print_jobs` | `api.record_pad_print_job` | 5 | missing (repo was empty) |
| Mould register `MouldRegister` | `/production/mould-register` | `src/features/production/MouldRegisterPage.tsx` | `prod.moulds`, `prod.mould_events` | `api.move_mould`, `api.record_mould_service` | 5 | missing (repo was empty) |
| Biochem manufacturing `BiochemManufacturing` | `/production/biochem-manufacturing` | `src/features/production/BiochemManufacturingPage.tsx` | `prod.process_families`, `prod.routes`, `prod.formulas`, `prod.formula_versions`, `prod.formula_lines` | `api.publish_formula_version` | 5 | missing (repo was empty) |
| Biochem costing `BiochemCosting` | `/production/biochem-costing` | `src/features/production/BiochemCostingPage.tsx` | `prod.batch_costs` | `api.v_batch_cost` | 5 | missing (repo was empty) |
| Biochem production entry `BiochemProduction` | `/production/biochem-production-entry` | `src/features/production/BiochemProductionPage.tsx` | `prod.batches`, `prod.batch_events`, `prod.weighings`, `prod.material_consumption`, `prod.packaging_recon` | `api.plan_batch`, `api.reserve_batch_materials`, `api.record_weighing`, `api.verify_weighing`, `api.record_packing`, `api.close_batch` | 5 | missing (repo was empty) |
| Biochem production flow `BiochemFlow` | `/production/biochem-production-flow` | `src/features/production/BiochemFlowPage.tsx` | `core.state_transitions` | `api.v_state_machine('batch')` | 5 | missing (repo was empty) |
| Biochem labs `BiochemLabs` | `/production/biochem-labs` | `src/features/production/BiochemLabsPage.tsx` | `prod.lab_samples`, `prod.lab_tests`, `prod.rnd_trials`, `prod.instruments`, `prod.calibrations` | `api.record_lab_result`, `api.qc_release_batch`, `api.qc_reject_batch` | 5 | missing (repo was empty) |
| Factory work assignment `BiochemWork` | `/production/factory-work-assignment` | `src/features/production/FactoryWorkPage.tsx` | `prod.shift_assignments`, `hr.employees` | `api.assign_shift_duties` | 5 | missing (repo was empty) |
| Free items and gift packs `BiochemBundles` | `/production/free-items-and-gift-packs` | `src/features/production/BundlesPage.tsx` | `prod.packs`, `prod.pack_items`, `inv.stock_ledger` | `api.upsert_pack`, `api.post_pack_assembly` | 5 | missing (repo was empty) |
| Biochem machines `BiochemAssets` | `/production/biochem-machines` | `src/features/production/BiochemAssetsPage.tsx` | `core.assets`, `core.asset_events`, `prod.calibrations` | `api.record_asset_event`, `api.record_calibration` | 5 | missing (repo was empty) |

## Inventory

| Screen (ref) | Route | Component | Main tables | RPCs (planned) | Phase | Status |
|---|---|---|---|---|---|---|
| Raw material `RawMaterial` | `/inventory/raw-material` | `src/features/inventory/RawMaterialPage.tsx` | `api.v_stock_balances` over `inv.stock_ledger`, `inv.reorder_levels` | `api.issue_stock` | 4 | missing (repo was empty) |
| Component stock `ComponentStock` | `/inventory/component-stock` | `src/features/inventory/ComponentStockPage.tsx` | `api.v_stock_balances` | `api.issue_stock` | 4 | missing (repo was empty) |
| Stock movements `StockMovement` | `/inventory/stock-movements` | `src/features/inventory/StockMovementsPage.tsx` | `inv.stock_ledger` | `api.issue_stock`, `api.return_stock` | 4 | missing (repo was empty) |
| Scrap and regrind `Scrap` | `/inventory/scrap-and-regrind` | `src/features/inventory/ScrapPage.tsx` | `prod.regrind_entries`, `inv.stock_ledger`, `sales.invoices` | `api.record_regrind`, `api.post_scrap_sale` | 4 | missing (repo was empty) |
| Product master `ProductMaster` | `/inventory/product-master` | `src/features/inventory/ProductMasterPage.tsx` | `master.products`, `master.product_groups`, `master.product_families`, `master.uoms`, `master.hsn_codes` | `api.upsert_product` (Admin) | 2 | missing (repo was empty) |
| Warehouse `Warehouse` | `/inventory/warehouse` | `src/features/inventory/WarehousePage.tsx` | `core.state_transitions`, `inv.stock_ledger` | `api.release_from_quarantine` | 4 | missing (repo was empty) |
| Stock transfers `StockTransfer` | `/inventory/stock-transfers` | `src/features/inventory/StockTransfersPage.tsx` | `inv.transfers`, `inv.transfer_lines`, `inv.transfer_events`, `inv.stock_ledger` | `api.request_transfer` … `api.close_transfer`, `api.write_off_transfer_shortage` | 4 | missing (repo was empty) |

## Logistics

| Screen (ref) | Route | Component | Main tables | RPCs (planned) | Phase | Status |
|---|---|---|---|---|---|---|
| Dispatch board `Dispatch` | `/logistics/dispatch-board` | `src/features/logistics/DispatchBoardPage.tsx` | `sales.dispatches`, `sales.trips` | `api.create_dispatch`, `api.assign_to_trip` | 6 | missing (repo was empty) |
| Trips `Trip` | `/logistics/trips` | `src/features/logistics/TripPage.tsx` | `sales.trips`, `sales.trip_stops`, `sales.pods` | `api.start_trip`, `api.close_trip` | 6 | missing (repo was empty) |
| Vehicles & drivers `Vehicles` | `/logistics/vehicles-and-drivers` | `src/features/logistics/VehiclesPage.tsx` | `ops.vehicles`, `hr.employees` | `api.upsert_vehicle` | 6 | missing (repo was empty) |
| Vehicle file `VehicleFile` | `/logistics/vehicle-file` | `src/features/logistics/VehicleFilePage.tsx` | `ops.vehicle_events` (fuel, EMI, repairs, papers, accidents, fines) | `api.record_vehicle_event` | 6 | missing (repo was empty) |

## Exports

| Screen (ref) | Route | Component | Main tables | RPCs (planned) | Phase | Status |
|---|---|---|---|---|---|---|
| Mixer grinder costing `MixerCosting` | `/exports/mixer-grinder-costing` | `src/features/exports/MixerCostingPage.tsx` | `prod.assembly_boms`, `sales.export_costings` | `api.v_fob_build_up` | 6 | missing (repo was empty) |
| Export orders `ExportOrders` | `/exports/export-orders` | `src/features/exports/ExportOrdersPage.tsx` | `sales.export_orders`, `sales.containers`, `sales.invoices` | `api.create_export_order`, `api.check_packing_list` | 6 | missing (repo was empty) |

## HR & payroll

| Screen (ref) | Route | Component | Main tables | RPCs (planned) | Phase | Status |
|---|---|---|---|---|---|---|
| Employees & KYC `StaffKYC` | `/hr-and-payroll/employees-and-kyc` | `src/features/hr/StaffKycPage.tsx` | `hr.employees`, `hr.employee_kyc` (Aadhaar last 4 only), `hr.employee_bank` (masked) | `api.upsert_employee`, `api.record_kyc_view` | 3 | missing (repo was empty) |
| Payroll `Payroll` | `/hr-and-payroll/payroll` | `src/features/hr/PayrollPage.tsx` | `hr.payroll_runs`, `hr.payroll_lines`, `hr.payslips` | `api.run_payroll`, `api.approve_payroll`, `api.post_payroll` | 3 | missing (repo was empty) |
| Attendance `Attendance` | `/hr-and-payroll/attendance` | `src/features/hr/AttendancePage.tsx` | `hr.attendance_hours` | `api.record_attendance` | 3 | missing (repo was empty) |
| Leave & advance requests `Requests` | `/hr-and-payroll/leave-and-advance-requests` | `src/features/hr/RequestsPage.tsx` | `hr.leave_requests`, `hr.advance_requests` | `api.decide_request` | 3 | missing (repo was empty) |
| Staff duties `StaffDuties` | `/hr-and-payroll/staff-duties` | `src/features/hr/StaffDutiesPage.tsx` | `hr.duties`, `hr.designations` | `api.assign_duty` | 3 | missing (repo was empty) |
| Staff rotation `StaffRotation` | `/hr-and-payroll/staff-rotation` | `src/features/hr/StaffRotationPage.tsx` | `hr.employee_company_assignments`, `hr.rotations` | `api.rotate_employee` | 3 | missing (repo was empty) |
| Payroll (second view) `PayrollBiochem` | `/hr-and-payroll/payroll/payroll-biochem` | `src/features/hr/PayrollCompanyPage.tsx` | `hr.payroll_runs`, `hr.payroll_lines` | `api.v_payroll_company` | 3 | missing (repo was empty) |
| Payroll (second view) `PayrollBiochemTrend` | `/hr-and-payroll/payroll/payroll-biochem-trend` | `src/features/hr/PayrollTrendPage.tsx` | `hr.payroll_runs` | `api.v_payroll_trend` | 3 | missing (repo was empty) |
| Employees & KYC (second view) `AddStaff` | `/hr-and-payroll/employees-and-kyc/add-staff` | `src/features/hr/AddStaffPage.tsx` | `hr.employees`, `hr.designations`, `core.people` | `api.upsert_employee` | 3 | missing (repo was empty) |
| Workers and hours `WorkerHours` | `/hr-and-payroll/workers-and-hours` | `src/features/hr/WorkerHoursPage.tsx` | `hr.attendance_hours`, `hr.employee_company_assignments` | `api.v_worker_hours` | 3 | missing (repo was empty) |
| Workers and hours (second view) `StaffWorkflow` | `/hr-and-payroll/workers-and-hours/staff-workflow` | `src/features/hr/StaffWorkflowPage.tsx` | `core.state_transitions` | `api.v_state_machine('employee')` | 3 | missing (repo was empty) |
| Allowances and benefits `Allowances` | `/hr-and-payroll/allowances-and-benefits` | `src/features/hr/AllowancesPage.tsx` | `hr.allowance_types`, `hr.allowance_lines` | `api.classify_allowance_line` | 3 | missing (repo was empty) |
| Cash given to staff `CashGiven` | `/hr-and-payroll/cash-given-to-staff` | `src/features/hr/CashGivenPage.tsx` | `hr.cash_given`, `acct.gl_entries` | `api.record_cash_given` (cash-limit checked) | 3 | missing (repo was empty) |

## Accounts

| Screen (ref) | Route | Component | Main tables | RPCs (planned) | Phase | Status |
|---|---|---|---|---|---|---|
| Cash book `CashBook` | `/accounts/cash-book` | `src/features/accounts/CashBookPage.tsx` | `acct.vouchers`, `acct.voucher_lines`, `acct.gl_entries` | `api.check_cash_limit`, `api.post_receipt`, `api.post_payment`, `api.post_contra` | 3 | missing (repo was empty) |
| Bank `BankReco` | `/accounts/bank` | `src/features/accounts/BankRecoPage.tsx` | `acct.bank_accounts`, `acct.bank_statements`, `acct.bank_statement_lines`, `acct.bank_matches` | `api.stage_bank_lines` (via Edge Fn), `api.match_bank_line` | 3 | missing (repo was empty) |
| Financials `Reports` | `/accounts/financials` | `src/features/accounts/FinancialsPage.tsx` | `acct.gl_entries`, `acct.accounts` | `api.trial_balance`, `api.profit_and_loss`, `api.balance_sheet`, `api.party_ledger`, `api.general_ledger`, `api.day_book` | 6 | missing (repo was empty) |
| GST `GST` | `/accounts/gst` | `src/features/accounts/GstPage.tsx` | `acct.gst_workings`, `sales.invoices`, `purch.bills` | `api.build_gstr1`, `api.build_gstr3b`, `api.itc_match` | 6 | missing (repo was empty) |
| Month-end close `MonthClose` | `/accounts/month-end-close` | `src/features/accounts/MonthClosePage.tsx` | `acct.close_checklists`, `acct.close_tasks`, `core.periods` | `api.complete_close_task`, `api.close_period` | 7 | missing (repo was empty) |
| Cash flow and reminders `CashFlow` | `/accounts/cash-flow-and-reminders` | `src/features/accounts/CashFlowPage.tsx` | `acct.gl_entries`, `acct.bill_allocations` | `api.cash_flow_forecast` | 3 | missing (repo was empty) |
| Directors and investment `Directors` | `/accounts/directors-and-investment` | `src/features/accounts/DirectorsPage.tsx` | `acct.partners`, `acct.director_loans`, `acct.director_declarations` | `api.record_director_loan` (s.185 check) | 7 | missing (repo was empty) |
| Partners and profit sharing `ProfitSharing` | `/accounts/partners-and-profit-sharing` | `src/features/accounts/ProfitSharingPage.tsx` | `acct.profit_share_minutes`, `acct.profit_shares` | `api.compute_profit_share`, `api.post_profit_share` | 7 | missing (repo was empty) |
| Partner requests `PartnerRequests` | `/accounts/partner-requests` | `src/features/accounts/PartnerRequestsPage.tsx` | `acct.partner_requests` | `api.decide_partner_request` | 7 | missing (repo was empty) |
| Schedule III statements `ScheduleIIIBiochem` | `/accounts/schedule-iii-statements` | `src/features/accounts/ScheduleIIIPage.tsx` | `acct.gl_entries`, `acct.schedule3_map` | `api.schedule3_statements(p_company_id, p_fy)` | 6 | missing (repo was empty) |
| Cash book (second view) `CashBookCheck` | `/accounts/cash-book/cash-book-check` | `src/features/accounts/CashBookCheckPage.tsx` | `acct.gl_entries`, `ops.import_rows`, `ops.bug_items` | `api.cash_book_check(p_company_id, p_from, p_to)` | 3 | missing (repo was empty) |

## Admin

| Screen (ref) | Route | Component | Main tables | RPCs (planned) | Phase | Status |
|---|---|---|---|---|---|---|
| Users & rights `Users` | `/admin/users-and-rights` | `src/features/admin/UsersPage.tsx` | `core.user_profiles`, `core.roles`, `core.rights`, `core.role_rights`, `core.user_roles`, `core.user_scopes`, `core.approval_limits` | `admin-users` Edge Fn, `api.assign_role`, `api.set_user_scope`, `api.set_approval_limit` | 1 | missing (repo was empty) |
| User log `UserLog` | `/admin/user-log` | `src/features/admin/UserLogPage.tsx` | `audit.user_log` | `api.v_user_log` | 1 | missing (repo was empty) |
| Backup `Backup` | `/admin/backup` | `src/features/admin/BackupPage.tsx` | `ops.backup_runs`, `ops.restore_drills` | `api.record_backup_run`, `api.request_restore` (Admin) | 2 | missing (repo was empty) |
| Import data `DataImport` | `/admin/import-data` | `src/features/admin/DataImportPage.tsx` | `ops.import_batches`, `ops.import_rows`, `ops.source_keys`, `ops.tally_group_map`, `ops.bridge_devices` | `api.start_import_batch`, `api.approve_import_batch`, `api.undo_import_batch` | 2 | missing (repo was empty) |
| Document templates `DocPreview` | `/admin/document-templates` | `src/features/admin/DocPreviewPage.tsx` | `core.doc_templates`, storage `documents` | `pdf-render` Edge Fn, `api.send_document_whatsapp` | 3 | missing (repo was empty) |
| Numbering & IDs `Numbering` | `/admin/numbering-and-ids` | `src/features/admin/NumberingPage.tsx` | `core.doc_series`, `core.doc_series_counters` | `api.upsert_doc_series` | 1 | missing (repo was empty) |
| WhatsApp & email `WhatsApp` | `/admin/whatsapp-and-email` | `src/features/admin/WhatsAppPage.tsx` | `msg.channels`, `msg.templates`, `msg.contacts`, `msg.outbox`, `msg.inbound` | `api.upsert_template`, `api.set_reminder_schedule`, `api.reply_inbound` | 3 | missing (repo was empty) |
| Units `Units` | `/admin/units` | `src/features/admin/UnitsPage.tsx` | `core.branches`, `core.places` | `api.upsert_branch`, `api.upsert_place` | 1 | missing (repo was empty) |
| Asset register `AssetRegister` | `/admin/asset-register` | `src/features/admin/AssetRegisterPage.tsx` | `core.assets`, `core.asset_events`, `core.asset_documents` | `api.add_asset`, `api.record_asset_event`, `api.run_depreciation` | 7 | missing (repo was empty) |
| Companies `Companies` | `/admin/companies` | `src/features/admin/CompaniesPage.tsx` | `core.groups`, `core.companies` | `api.upsert_company` (Admin) | 1 | missing (repo was empty) |
| Branches and GSTINs `Branches` | `/admin/branches-and-gstins` | `src/features/admin/BranchesPage.tsx` | `core.gstins`, `core.branches`, `acct.bank_accounts` | `api.upsert_gstin`, `api.upsert_branch` | 1 | missing (repo was empty) |
| Forms and fields `FormFields` | `/admin/forms-and-fields` | `src/features/admin/FormFieldsPage.tsx` | `core.forms`, `core.form_fields` | `api.upsert_form_field` (Admin) | 1 | missing (repo was empty) |
| Import data (second view) `TallyBiochem` | `/admin/import-data/tally-biochem` | `src/features/admin/TallyBooksPage.tsx` (company param) | `ops.import_batches`, `ops.import_rows`, `ops.bug_items` | `api.v_import_summary` | 2 | missing (repo was empty) |
| Import data (second view) `TallyPlastics` | `/admin/import-data/tally-plastics` | `src/features/admin/TallyBooksPage.tsx` (company param) | as above | `api.v_import_summary` | 2 | missing (repo was empty) |
| Built to Indian law `LawRules` | `/admin/built-to-indian-law` | `src/features/admin/LawRulesPage.tsx` | `core.law_rules` (from `LAW_RULES.md`), `ops.bug_items` | `api.v_law_rules` | 1 | missing (repo was empty) |
| How each person sees it `UXOverview` | `/admin/how-each-person-sees-it` | `src/features/admin/UxOverviewPage.tsx` | `core.roles`, `core.role_rights` | `api.v_role_views` | 1 | missing (repo was empty) |
| Bug fixer `BookFixes` | `/admin/bug-fixer` | `src/features/admin/BugFixerPage.tsx` | `ops.bug_items`, `ops.bug_item_evidence` | `api.resolve_bug_item`, `api.merge_parties_preview`, `api.merge_parties`, `api.keep_separate` | 2 | missing (repo was empty) — label "Bug fixer", not "Fix in books" |
| Special permissions `SpecialAccess` | `/admin/special-permissions` | `src/features/admin/SpecialAccessPage.tsx` | `core.special_grants`, `core.special_grant_requests` | `api.grant_special_permission`, `api.revoke_special_permission`, `api.request_special_permission` | 1 | missing (repo was empty) |
| Transaction log `TransactionLog` | `/admin/transaction-log` | `src/features/admin/TransactionLogPage.tsx` | `audit.document_versions`, `audit.row_history` | `api.v_document_history` | 1 | missing (repo was empty) |
| Total workflow `ERPFlow` | `/admin/total-workflow` | `src/features/admin/TotalWorkflowPage.tsx` | `src/app/flows.ts`; `core.state_transitions` | — (config) | 1 | missing (repo was empty) |
| Licences and documents `Licences` | `/admin/licences-and-documents` | `src/features/admin/LicencesPage.tsx` | `core.licences`, `core.licence_documents` | `api.add_licence`, `api.renew_licence` | 7 | missing (repo was empty) |
| *Settings* (no reference) | `/admin/settings` | `src/features/admin/SettingsPage.tsx` | `core.settings` (effective-dated) | `api.set_setting` (Admin) | 1 | missing (repo was empty) — build from §UX-7 admin pattern |

## Phone and tablet screens by job

| Screen (ref) | Route | Component | Main tables | RPCs (planned) | Phase | Status |
|---|---|---|---|---|---|---|
| BillCapture `BillCapture` | `/me/bill-photo` | `src/features/me/BillCapturePage.tsx` | `purch.bill_captures`, storage `bills` | `bill-photo-reader` Edge Fn | 4 | missing (repo was empty) |
| RaviHome `RaviHome` | `/me/mould-manager` | `src/features/me/MouldManagerHomePage.tsx` | `prod.moulds`, `prod.mould_events` | `api.v_my_moulds` | 5 | missing (repo was empty) |
| KrishnaHome `KrishnaHome` | `/me/injection-manager` | `src/features/me/InjectionManagerHomePage.tsx` | `prod.injection_shifts`, `prod.machines` | `api.record_injection_shift` | 5 | missing (repo was empty) |
| RafeeqHome `RafeeqHome` | `/me/buying-logistics` | `src/features/me/BuyingLogisticsHomePage.tsx` | `purch.requests`, `purch.orders`, `acct.vouchers` | `api.v_my_buying_tasks` | 4 | missing (repo was empty) |
| OperatorCheck `OperatorCheck` | `/me/machine-check` | `src/features/me/MachineCheckPage.tsx` | `prod.machine_checks` | `api.record_machine_check` | 5 | missing (repo was empty) |
| IsmailHome `IsmailHome` | `/me/factory-manager` | `src/features/me/FactoryManagerHomePage.tsx` | `prod.injection_shifts`, `prod.quality_inspections` | `api.v_factory_today` | 5 | missing (repo was empty) |
| CashEntry `CashEntry` | `/me/cash-entry` | `src/features/me/CashEntryPage.tsx` | `acct.vouchers`, `acct.gl_entries` | `api.check_cash_limit`, `api.post_payment` | 3 | missing (repo was empty) |
| LabPanel `LabPanel` | `/lab` | `src/features/lab/LabPanelPage.tsx` | `prod.lab_samples`, `prod.lab_tests`, `prod.rnd_trials`, `prod.instruments` | `api.record_lab_result`, `api.qc_release_batch` | 5 | missing (repo was empty) |
| SalesmanApp `SalesmanApp` | `/field/today` | `src/features/field/SalesmanTodayPage.tsx` | `field.beats`, `field.visits`, `field.salesman_customers` | `api.check_in_visit`, `api.check_out_visit` | 6 | missing (repo was empty) |

### Salesman portal pages without reference screens (§15A, §UX-4.2)

| Page | Route (proposed) | Component | Main tables | RPCs (planned) | Phase | Status |
|---|---|---|---|---|---|---|
| Customer page (Account / Queries / Reference / Visit tabs) | `/field/customers/:id` | `src/features/field/SalesmanCustomerPage.tsx` | `api.v_salesman_customer_account` (respects `salesman_balance_scope`), `field.queries`, `field.visits` | `api.record_promise_to_pay`, `api.send_statement_whatsapp`, `api.log_query` | 6 | missing (repo was empty) |
| Customers list | `/field/customers` | `src/features/field/SalesmanCustomersPage.tsx` | `field.salesman_customers` | — | 6 | missing (repo was empty) |
| Take order | `/field/customers/:id/order` | `src/features/field/TakeOrderPage.tsx` | `sales.orders`, `field.van_stock` | `api.confirm_sales_order`, `api.check_credit_exposure` | 6 | missing (repo was empty) |
| Collect payment | `/field/customers/:id/collect` | `src/features/field/CollectPaymentPage.tsx` | `sales.receipts`, `sales.receipt_allocations` | `api.check_cash_limit`, `api.post_receipt` | 6 | missing (repo was empty) |
| Queries inbox | `/field/queries` | `src/features/field/QueriesInboxPage.tsx` | `field.queries`, `sales.complaints` | `api.log_query` | 6 | missing (repo was empty) |
| Reference library | `/field/library` | `src/features/field/LibraryPage.tsx` | `master.products`, `master.price_lists`, `core.licences` (Admin-allowed copies) | — | 6 | missing (repo was empty) |
| My day | `/field/my-day` | `src/features/field/MyDayPage.tsx` | `field.visits`, `sales.receipts` | `api.v_my_day` | 6 | missing (repo was empty) |
| End day | `/field/end-day` | `src/features/field/EndDayPage.tsx` | `field.cash_handovers`, `field.day_closes` | `api.cash_handover` (two logins), `api.end_salesman_day` | 6 | missing (repo was empty) |

## Staff app (phone)

| Screen (ref) | Route | Component | Main tables | RPCs (planned) | Phase | Status |
|---|---|---|---|---|---|---|
| StaffHome `StaffHome` | `/staff/home` | `src/features/staff/StaffHomePage.tsx` | `hr.employees`, `hr.attendance_hours`, `hr.leave_requests`, `hr.payslips` | `api.v_staff_me` | 3 | Phase 0 shell: UI built, empty states; data in Phase 3 |
| StaffLeave `StaffLeave` | `/staff/leave` | `src/features/staff/StaffLeavePage.tsx` | `hr.leave_requests` | `api.submit_leave_request` | 3 | missing (repo was empty) |
| StaffAdvance `StaffAdvance` | `/staff/advance` | `src/features/staff/StaffAdvancePage.tsx` | `hr.advance_requests` | `api.submit_advance_request` | 3 | missing (repo was empty) |
| StaffDetails `StaffDetails` | `/staff/details` | `src/features/staff/StaffDetailsPage.tsx` | `hr.employees`, `hr.employee_kyc` (masked) | `api.v_staff_me` | 3 | missing (repo was empty) |
| StaffPayslip `StaffPayslip` | `/staff/payslip` | `src/features/staff/StaffPayslipPage.tsx` | `hr.payslips` | `api.v_my_payslips` | 3 | missing (repo was empty) |
| StaffPayslipHasanan `StaffPayslipHasanan` | `/staff/payslip` (allowances variant) | `src/features/staff/StaffPayslipPage.tsx` (same component, allowances section) | `hr.payslips`, `hr.allowance_lines` | `api.v_my_payslips` | 3 | missing (repo was empty) |

## Driver app (phone)

| Screen (ref) | Route | Component | Main tables | RPCs (planned) | Phase | Status |
|---|---|---|---|---|---|---|
| DriverTrip `DriverTrip` | `/driver/trip` | `src/features/driver/DriverTripPage.tsx` | `sales.trips`, `sales.trip_stops` | `api.v_my_trip`, `api.start_trip` | 6 | missing (repo was empty) |
| DriverPOD `DriverPOD` | `/driver/pod` | `src/features/driver/DriverPodPage.tsx` | `sales.pods`, storage `documents` | `api.record_pod` | 6 | missing (repo was empty) |

## Investor portal

| Screen (ref) | Route | Component | Main tables | RPCs (planned) | Phase | Status |
|---|---|---|---|---|---|---|
| InvestorGroup `InvestorGroup` | `/investor/group` | `src/features/investor/InvestorGroupPage.tsx` | `api.v_investor_*` analytics views | `api.investor_group_summary` | 7 | missing (repo was empty) |
| PartnerHome `PartnerHome` | `/investor/home` | `src/features/investor/PartnerHomePage.tsx` | `api.v_investor_today` | — | 7 | missing (repo was empty) |
| PartnerPerformance `PartnerPerformance` | `/investor/performance` | `src/features/investor/PartnerPerformancePage.tsx` | `api.v_investor_performance` | — | 7 | missing (repo was empty) |
| PartnerInvestment `PartnerInvestment` | `/investor/investment` | `src/features/investor/PartnerInvestmentPage.tsx` | `acct.partner_investments` | `api.v_my_investment` | 7 | missing (repo was empty) |
| InvestorWorkingPartner `InvestorWorkingPartner` | `/investor/working-partner` | `src/features/investor/WorkingPartnerPage.tsx` | `api.v_investor_*` | — | 7 | missing (repo was empty) |
| InvestorProjects `InvestorProjects` | `/investor/projects` | `src/features/investor/InvestorProjectsPage.tsx` | `acct.partner_projects` | `api.submit_partner_request('project')` | 7 | missing (repo was empty) |
| InvestorWithdraw `InvestorWithdraw` | `/investor/withdraw` | `src/features/investor/InvestorWithdrawPage.tsx` | `acct.partner_requests` | `api.submit_partner_request('withdrawal')` | 7 | missing (repo was empty) |
| InvestorLoan `InvestorLoan` | `/investor/loan` | `src/features/investor/InvestorLoanPage.tsx` | `acct.partner_requests`, `acct.director_declarations` | `api.submit_partner_request('loan')` | 7 | missing (repo was empty) |

## Shared components

| Ref | Component | Phase | Status |
|---|---|---|---|
| `Sidebar` | `src/ui/shell/Sidebar.tsx` (+ `src/app/nav.ts`) | 0 | Phase 0: built (order per §UX-4.1) |
| `Topbar` | `src/ui/shell/Topbar.tsx` | 0 | Phase 0: built (view chip from JWT `app_metadata.role`) |
| `StaffNav` | `src/ui/BottomNav.tsx` in `src/ui/shell/PhoneShell.tsx` | 0 | Phase 0: built |
| `FlowStrip` | `src/ui/shell/FlowStrip.tsx` (+ `src/app/flows.ts`) | 0 | Phase 0: built; Bug fixer count live from Phase 2 |

## Design reference (not routes)

| Ref | Use |
|---|---|
| `StyleGuide` | Source for `src/ui` components and `/dev/ui` gallery (dev only) |
| `Logo` | Logo asset reference; logos come from `design-reference/assets/` (not committed) |

## Totals

132 reference boards = 126 screens (incl. `StaffPayslipHasanan`, which shares the payslip route) + 4 shared components + 2 design references. Audit: 0 exist and match, 0 exist and differ, 126 missing; 5 built as Phase 0 shells. Plus 4 sidebar items without references (Receipts, Purchase orders, Bills & payments, Settings) and 8 salesman portal pages without references.

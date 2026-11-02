# Workflows — Southfield ERP

The 17 workflows from the approved “Total workflow” screen (ERPFlow). Each step is a screen in PAGE_INVENTORY.md. The workflow strip at the top of every desktop page shows the flow, the step number and links to the other steps.

## Owner overview · `home`
Used by: Admin

1. Today → `Main`
2. Total workflow → `ERPFlow`
3. How each person sees it → `UXOverview`
4. Built to Indian law → `LawRules`

## Buying · `purchase`
Used by: Admin, accountant, stores

1. Request → `PurchaseRequest`
2. Supplier and KYC → `SupplierKYC`
3. Bill photo → `BillReview`
4. Price check → `PriceChanges`
5. Goods receipt → `GoodsReceipt`
6. Incoming test → `BiochemLabs`
7. Into stock → `RawMaterial`
8. Payment → `BankReco`

## Warehouse loop · `warehouse`
Used by: Stores, production, dispatch, drivers

1. Goods receipt → `GoodsReceipt`
2. Quarantine and test → `BiochemLabs`
3. Warehouse → `Warehouse`
4. Issue to manufacturing → `BiochemProduction`
5. Pack and free items → `BiochemBundles`
6. Back to stock → `StockMovement`
7. Order picking → `SalesOrders`
8. Dispatch → `Dispatch`
9. Trip → `Trip`
10. Proof of delivery → `DriverPOD`

## Stock · `stock`
Used by: Stores, Admin

1. Product master → `ProductMaster`
2. Raw material → `RawMaterial`
3. Components → `ComponentStock`
4. Stock movements → `StockMovement`
5. Scrap and regrind → `Scrap`
6. Month-end count → `MonthClose`

## Biochem production · `bio`
Used by: Production Manager, chemist, factory staff

1. Products → `ProductMaster`
2. Price and label checks → `BiochemProducts`
3. Formula and route → `BiochemManufacturing`
4. Machines → `BiochemAssets`
5. Assign work → `BiochemWork`
6. Production entry → `BiochemProduction`
7. Lab tests → `BiochemLabs`
8. Packs and free items → `BiochemBundles`
9. Costing → `BiochemCosting`
10. The whole flow → `BiochemFlow`

## Plastics production · `plastics`
Used by: Admin, supervisors, operators

1. Mould project → `Moulds`
2. Mould register → `MouldRegister`
3. Mould costing → `MouldCosting`
4. Machines → `Machines`
5. Moulding → `Production`
6. Quality → `Quality`
7. Component costing → `ComponentCosting`
8. Assembly → `AssemblyCosting`
9. Pad printing → `PadPrinting`
10. Job work → `JobWork`
11. Maintenance → `Maintenance`

## Mixer grinder export · `export`
Used by: Admin

1. Export order → `ExportOrders`
2. Mixer costing → `MixerCosting`
3. Between companies → `Companies`

## Selling · `sales`
Used by: Admin, accountant, sales

1. Customers → `Customers`
2. Customer KYC → `CustomerKYC`
3. Price list → `PriceList`
4. Shops → `ShopSales`
5. Order → `SalesOrders`
6. Tax invoice → `Invoice`
7. Sales register → `SalesRegister`
8. Accountant’s register → `CompanyPortal`
9. Online listings → `OnlineListings`
10. Online orders → `OnlineSales`

## Field sales and own shops · `field`
Used by: Sales manager, salesmen, shop staff

1. Customers → `Customers`
2. Routes and GPS → `RouteSales`
3. Customer care and agents → `SalesControls`
4. Salesman’s phone → `SalesmanApp`
5. Order → `SalesOrders`
6. Own shops → `Outlets`
7. Tax invoice → `Invoice`
8. Collections → `CashBook`

## Credit and collections · `credit`
Used by: Sales, finance head, MD

1. Customers → `Customers`
2. Customer KYC → `CustomerKYC`
3. Credit approval → `CreditControl`
4. Order → `SalesOrders`
5. Stock transfers → `StockTransfer`
6. Tax invoice → `Invoice`
7. Reminders and complaints → `SalesControls`
8. Bank receipts → `BankReco`

## Delivery · `delivery`
Used by: Dispatch staff, drivers

1. Dispatch board → `Dispatch`
2. Trip → `Trip`
3. Vehicles → `Vehicles`
4. Vehicle papers → `VehicleFile`

## Cash and bank · `money`
Used by: Cash holder, accountant, Admin

1. Cash book → `CashBook`
2. Check against Tally → `CashBookCheck`
3. Bank → `BankReco`
4. Cash flow → `CashFlow`
5. Month-end close → `MonthClose`

## Books and tax · `books`
Used by: Admin, CA

1. Tally books, Biochem → `TallyBiochem`
2. Tally books, Plastics → `TallyPlastics`
3. Bug fixer → `BookFixes`
4. GST → `GST`
5. Financials → `Reports`
6. Schedule III → `ScheduleIIIBiochem`

## Staff and payroll · `staff`
Used by: Admin, supervisors

1. Add staff → `AddStaff`
2. KYC → `StaffKYC`
3. Duties → `StaffDuties`
4. Rotation → `StaffRotation`
5. Attendance → `Attendance`
6. Hours → `WorkerHours`
7. Requests → `Requests`
8. Allowances → `Allowances`
9. Cash given → `CashGiven`
10. Payroll → `Payroll`
11. Biochem payroll → `PayrollBiochem`
12. Pay trend → `PayrollBiochemTrend`
13. Staff app flow → `StaffWorkflow`

## Partners and investors · `partners`
Used by: Admin, partners

1. Directors and investment → `Directors`
2. Profit sharing → `ProfitSharing`
3. Partner requests → `PartnerRequests`
4. Group view → `InvestorGroup`

## Set-up · `setup`
Used by: Admin

1. Companies → `Companies`
2. Branches and GSTINs → `Branches`
3. Units → `Units`
4. Users → `Users`
5. Special permissions → `SpecialAccess`
6. Forms and fields → `FormFields`
7. Numbering → `Numbering`
8. Document templates → `DocPreview`
9. WhatsApp and email → `WhatsApp`

## Records and safety · `control`
Used by: Admin, CA

1. Licences and documents → `Licences`
2. Asset register → `AssetRegister`
3. Load Tally data → `DataImport`
4. Backup → `Backup`
5. User log → `UserLog`
6. Transaction log → `TransactionLog`

## Hand-offs between workflows

| From | To | What passes |
|---|---|---|
| Field sales and own shops | Credit and collections | Credit orders reserve against the customer’s approved limit |
| Credit and collections | Delivery | Released stock moves on two-person transfers and deliveries |
| Buying | Warehouse loop | Goods receipts go into quarantine, then stores |
| Warehouse loop | Biochem production | Released materials are picked and issued to each batch |
| Biochem production | Warehouse loop | Packed lots come back on hold, then are released |
| Warehouse loop | Delivery | Released stock is picked, loaded and delivered |
| Buying | Stock | Received goods pass the incoming test and go into stock |
| Stock | Biochem production | Released materials are issued to Biochem batches |
| Stock | Plastics production | Granules and parts are issued to moulding and assembly |
| Plastics production | Biochem production | Plastics bills Biochem for trays, containers and lids |
| Biochem production | Selling | Released finished lots can be sold |
| Plastics production | Mixer grinder export | Mixer parts become export orders |
| Selling | Delivery | Invoiced orders are dispatched |
| Stock | Field sales and own shops | Vans and the Kochi and Coimbatore shops are stocked from the factory |
| Field sales and own shops | Cash and bank | Salesmen and shops hand over and bank collections daily |
| Selling | Cash and bank | Receipts are matched to bills |
| Staff and payroll | Cash and bank | Payroll and advances are paid from cash and bank |
| Cash and bank | Books and tax | Cash and bank feed the books and GST |
| Books and tax | Partners and investors | Profit is shared out to partners |
| Records and safety | Books and tax | Tally loads and fixes feed the books |

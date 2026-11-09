# SOUTHFIELD GROUP ERP — Tally Import: full build prompt

For Google Antigravity · React + TypeScript · Supabase · Vercel

This prompt covers one module: loading TallyPrime (Gold) data into the ERP. It covers both companies' masters, opening balances and every voucher, with no duplicates, field by field, reconciled to Tally.

It works alongside the main prompt, `docs/prompts/SOUTHFIELD_ERP_PROMPT.md`. Its §25A (Tally loading without duplicates) and the main prompt's §12 (Bug fixer), §23 (database rules) and §24 (security) still apply. Where this prompt is more detailed, it wins.

The owner's table reference is `docs/spec/tally/Tally_Gold_Backend_Tables - Southfield ERP mapping.xlsx`. It has every Tally collection and field, its XML tag, its relationships, the ERP target and the check for each field. The field tables in §9 below are the same mapping.

---

## 1. How Tally stores data (read before building)

- **Tally is not a relational database.** Data lives as objects in collections:
  - **Masters:** Company, Group, Ledger, VoucherType, CostCategory, CostCentre, Currency, StockGroup, StockCategory, StockItem, Unit, Godown.
  - **Vouchers:** Voucher, with nested child lists (ledger entries, inventory entries, batch, accounting, bill, cost category, cost centre and bank allocations).
- **Links are by name, not by ID.** For example, `Ledger.Parent` holds a group's name and `Voucher.PartyLedgerName` holds a ledger's name. Resolve every link inside one company's batch.
- **The stable identity is the object's `GUID`.** `MasterID` is a fallback, and `AlterID` increases on every change.
- **ODBC is not enough.** It exposes masters by default, but not vouchers or their child lists. **Use XML over HTTP** from TallyPrime for everything; it carries the nested lists.

---

## 2. The Tally bridge (extraction)

The bridge is the small service from §25A. It runs on the import computer, a Windows PC with TallyPrime, in the office or in India.

1. **Restore or open.** Restore a TBK backup into its own data folder, or open the company, never over live data. Turn on TallyPrime's HTTP server: port 9000, F1 → Settings → Advanced Configuration.
2. **Masters.** One XML export request per master collection, per company. Fetch every field listed in §9, plus `GUID`, `MasterID` and `AlterID`.
3. **Vouchers.** Request them **month by month**, to avoid timeouts on large books. Each voucher must come with all its child lists:
   - **Both list variants** (invoice view and accounting view): `ALLLEDGERENTRIES` / `LEDGERENTRIES` and `ALLINVENTORYENTRIES` / `INVENTORYENTRIES`
   - **For stock and manufacturing journals:** the **inward and outward inventory lists** (destination and source)
   - **Nested lists:** batch, accounting, bill, cost category, cost centre and bank allocations
4. **Opening balances.** Export each ledger's opening bill allocations and each stock item's opening allocations by godown and batch (§10).
5. **Incremental pulls.** During the parallel-run month, request only objects whose `AlterID` is above the last loaded value. Changed objects go to review (§7).
6. **Upload.** The bridge uploads each export as one file to the private `imports` bucket in Mumbai, with its company GUID, date range and a SHA-256 hash. It authenticates with its own device key and never holds the Supabase secret key.
7. **Formats to handle:**
   - Tally XML may be UTF-16; convert it to UTF-8.
   - Dates are `YYYYMMDD`.
   - Quantities carry units (`"10 Nos"`, `"2.500 kg"`), and rates carry them too (`"100.00/Nos"`).
   - Amounts are text with signs.
   - Booleans are `Yes` / `No`.

---

## 3. Staging (schema `stg_tally`)

- **One staging table per collection** and **one per child list**. Child rows are keyed by the parent's GUID and the line number.
- **Each row stores:**
  - `batch_id`, `company_guid`, `guid`, `master_id`, `alter_id`
  - the parsed columns from §9
  - the raw object as `jsonb`
  - a row hash
- **Staging is write-once per batch.** It is never edited. Corrections happen in mapping tables or in the Bug fixer.
- **Retention.** Staging stays until the batch is approved, then it is kept read-only for audit.
- **Access.** Staging tables are readable only by Admin and the CA. Row security applies.

---

## 4. Mapping tables (Admin screens under Admin › Import data)

| Table | What Admin decides |
|---|---|
| `ops.tally_group_map` | Each Tally group → ERP account group. The system suggests a group from the name, parent, `IsRevenue` and `IsDeemedPositive`; Admin confirms. |
| Ledger kind | Decided by the mapped group: customer, supplier, bank, cash box, tax ledger, expense head, income, asset, partner or director account. |
| `ops.tally_voucher_type_map` | Each voucher type, including user-defined ones → ERP document type and tax class. Example: a user-defined sales type used for bills without GST maps to its class and to the CA review list. |
| `ops.tally_godown_map` | Each godown → ERP place (factory stores, quarantine, FG, Kochi, Coimbatore, Nellimattam, transit, job worker) |
| Unit and currency maps | Tally unit → ERP unit with its UQC code; currency → ISO code |
| Item aliases | A Tally item name → an ERP product master code (for example FG-0001). Kept so later imports match. |

**Nothing posts until every name it uses is mapped.** Each unmapped name is one Bug fixer item, and its vouchers wait.

---

## 5. Import order

Each step must pass its check before the next one starts:

| Step | What | Tally collections | ERP target | Needs first | Must pass before the next step |
|---|---|---|---|---|---|
| 1 | Company | Company | `core.companies (match only)` | — | Company confirmed by Admin; financial years set |
| 2 | Currencies and units | Currency, Unit | `core.currencies, master.uom` | Company | Every unit has a UQC; conversions > 0 |
| 3 | Account heads | Group | `ops.tally_group_map → acct.account_groups` | Company | Every Tally group mapped; nature and statement agree |
| 4 | Ledgers | Ledger | `acct.accounts, master.parties, bank accounts, cash boxes, tax ledgers` | Groups | No possible duplicates open; GSTINs valid or listed |
| 5 | Cost centres | CostCategory, CostCentre | `acct.cost_categories, acct.cost_centres` | Company | Hierarchy complete |
| 6 | Voucher types | VoucherType | `ops.tally_voucher_type_map` | Company | Every type mapped to a document type and tax class |
| 7 | Item groups | StockGroup, StockCategory | `master.item_groups, master.item_categories` | Units | Every group placed |
| 8 | Places | Godown | `inv.places` | Company | Every godown mapped to a place |
| 9 | Items | StockItem | `master.items` | Groups, units | HSN present; batch and expiry flags set for Biochem |
| 10 | Opening balances | Ledger opening bills, StockItem opening by godown and batch | `acct.opening_balances, inv.stock_ledger` | Ledgers, items, places | Opening trial balance and opening stock equal Tally |
| 11 | Vouchers, month by month | Voucher and its child lists | `documents, acct.gl_entries, inv.stock_ledger, acct.bills` | Everything above | Each month: voucher count by type, trial balance and stock equal Tally |
| 12 | Final reconciliation | — | `Import report` | All months | All checks pass; Admin approves; period locked |

---

## 6. Matching and duplicates

These follow §25A of the main prompt.

1. **Matching order:**
   1. Tally `GUID` (and `MasterID`) through `ops.source_keys`
   2. Strong keys: GSTIN, PAN or bank account for parties; HSN + name + unit for items; employee code or PAN for staff
   3. A cleaned name ("M/s", "Pvt Ltd" / "Private Limited", "&" / "and", case, spaces, punctuation, a trailing town name), scored for similarity
2. **When unsure, create nothing.** The import opens a Bug fixer item, "Possible duplicate", with the two records side by side and **Merge** / **Keep separate**.
3. **The same party or person in both companies** becomes one group-level record, linked to each company.
4. **Vouchers:**
   - The same GUID is skipped and counted.
   - A higher `AlterID` goes to "Changed in Tally after loading".
   - A voucher that has disappeared from Tally goes to "Deleted in Tally".

---

## 7. Historical posting mode (`api.import_post_voucher`)

Imported vouchers record **what already happened**. They post through a dedicated import RPC, never through the screens.

- **Same guarantees as live posting:** one transaction, idempotent on `(company, GUID)`, writes to the ledgers and the audit trail with `source = tally` and the batch ID.
- **Every voucher must balance.** The ledger lines must sum to zero, or the voucher is not posted and becomes a Bug fixer item, "Unbalanced voucher".
- **Masters are never invented.** A missing ledger, item, godown or voucher-type mapping holds the voucher and becomes a Bug fixer item, "Missing master".
- **Live-entry refusals become flags, not blocks.** History is loaded as it happened. These are recorded as Bug fixer or CA review items instead:
  - the ₹2 lakh cash receipt limit and the ₹10,000 cash payment limit
  - negative stock
  - credit limits
  - MRP checks
  - approvals and segregation of duties
- **GST:**
  - Tax amounts post as they are in Tally.
  - The ERP recomputes tax from the HSN rate table and lists any difference in the Bug fixer, "GST differs from HSN rate".
  - Bills in a non-GST class keep that class, carry the lawful reason "None · CA review" until the CA decides, and are visible only in the views §6 of the main prompt allows.
- **Periods:**
  - Imported periods are marked "Imported from Tally" and lock after the batch is approved.
  - Live posting starts only after the cut-over date.
- **Opening balances** for the cut-over load bill by bill, plus stock by godown and batch, as one opening document per company. It is signed off by the CA.

---

## 8. Sign and format rules

- **Amount signs:**
  - In Tally XML, a **negative amount is a debit** and a positive amount is a credit.
  - `IsDeemedPositive = Yes` marks a debit (ledger lines) or inward stock (inventory lines). Both signals must agree, or the line goes to the Bug fixer.
- **Confirm the sign rule before going further.** Check it with the first test company: the opening trial balance must equal Tally before any voucher month loads.
- **Quantities:**
  - Parse the number and the unit.
  - The unit must be the item's unit or have a conversion.
  - Round to the unit's decimal places.
- **Rates and amounts:**
  - `Rate × Qty − Discount` must equal `Amount` within ₹1 rounding per line.
  - Store money as `numeric(18,2)` and quantities as `numeric(18,3)`.
- **Text and dates:**
  - Keep the original Tally text in staging.
  - Trim and normalise only in the ERP columns.

---

## 9. Field-by-field mapping (all 175 fields in the owner's table)

Every imported object also writes `ops.source_keys` (company, collection, GUID, MasterID, AlterID, ERP ID).

#### Company

| Tally field | ERP target | How it loads / what is checked |
|---|---|---|
| `Name` | `core.companies.name` | Matched to the company Admin created (by PAN, then name). Never created by the import; no match = Bug fixer "Confirm company". |
| `BasicCompanyFormalName` | `core.companies.legal_name` | Compared with the registered name; a difference is shown for Admin to confirm. |
| `Address` | `core.companies.address` | Shown for comparison only; Admin keeps the ERP address. |
| `StateName` | `core.companies.state` | Checked against the GSTIN state code. |
| `CountryName` | `core.companies.country` | Expect India. |
| `PinCode` | `core.companies.pincode` | Comparison only. |
| `PhoneNumber` | `core.companies.phone` | Comparison only; not overwritten. |
| `Email` | `core.companies.email` | Comparison only; not overwritten. |
| `StartingFrom` | `core.financial_years.start` | Sets which financial years the import covers (April to March). |
| `BooksFrom` | `core.companies.books_from` | Earliest date a voucher may carry; earlier dates go to the Bug fixer. |
| `IncomeTaxNumber` | `core.companies.pan` | Must equal the PAN inside the company GSTINs; mismatch = Bug fixer. |
| `CurrencySymbol` | `core.companies.base_currency` | Expect ₹ (INR). |
| `GUID` | `ops.source_keys` | Tally company identity; every batch is tied to it so two companies never mix. |

#### Group

| Tally field | ERP target | How it loads / what is checked |
|---|---|---|
| `Name` | `ops.tally_group_map.tally_group` | Mapped to an ERP account group through the mapping table. An unmapped group is never created: Bug fixer "Map this head". |
| `Parent` | `ops.tally_group_map.tally_parent` | Hierarchy kept; Primary = top level. Used to suggest the ERP group. |
| `IsRevenue` | `acct.account_groups.statement` | Yes = profit and loss, No = balance sheet. Must agree with the mapped ERP group; disagreement = Bug fixer. |
| `IsDeemedPositive` | `acct.account_groups.nature` | Yes = debit nature (assets, expenses), No = credit nature. Checked against the mapped group. |
| `AffectsGrossProfit` | `acct.account_groups.affects_gross_profit` | Puts the group in the trading section of Schedule III working. |
| `IsSubLedger` | `acct.account_groups.is_subledger` | Sundry Debtors and Creditors style groups become party sub-ledgers. |
| `IsAddable` | `stg_tally.group.is_addable` | Kept in staging for reference; not used for posting. |
| `GUID` | `ops.source_keys` | Stable identity for re-imports. |
| `MasterID` | `ops.source_keys` | Fallback identity. |
| `AlterID` | `ops.source_keys` | A higher AlterID than last load = changed in Tally: review, never silent overwrite. |

#### Ledger

| Tally field | ERP target | How it loads / what is checked |
|---|---|---|
| `Name` | `acct.accounts.name (+ master.parties.name for parties)` | Matched by GUID, then GSTIN/PAN/bank, then cleaned name (§25A). Uncertain = Bug fixer "Possible duplicate"; never a second record. |
| `Parent` | `acct.accounts.group_id` | Through the group map. The group decides the kind: Sundry Debtors = customer, Sundry Creditors = supplier, Bank = bank account, Cash = cash box, Duties & Taxes = tax ledger, Expenses = expense head, Capital / Loans = partner or director account. |
| `MailingName` | `master.parties.legal_name` | Printed name on documents. |
| `Address` | `master.party_addresses` | Billing address; delivery addresses added in KYC. |
| `LedStateName` | `master.party_addresses.state` | Sets place of supply; must match the GSTIN state code. |
| `CountryName` | `master.party_addresses.country` | Non-India = export party. |
| `PinCode` | `master.party_addresses.pincode` | Kept. |
| `LedgerPhone` | `master.party_contacts.phone` | Kept; shown masked in lists. No WhatsApp consent is assumed from Tally. |
| `LedgerMobile` | `master.party_contacts.mobile` | Kept; WhatsApp only after consent is recorded (§WA-4). |
| `Email` | `master.party_contacts.email` | Kept. |
| `LedgerContact` | `master.party_contacts.name` | Contact person. |
| `IncomeTaxNumber` | `master.parties.pan` | Format check; must equal the PAN inside the GSTIN. |
| `PartyGSTIN` | `master.parties.gstin` | Format and checksum check, then verified with the GST portal in KYC. Invalid = Bug fixer. |
| `GSTRegistrationType` | `master.parties.gst_registration_type` | Regular / Composition / Unregistered / Consumer; must agree with the GSTIN being present. |
| `CurrencyName` | `master.parties.currency` | Through the currency map. |
| `OpeningBalance` | `acct.opening_balances` | Loaded bill by bill where bill-wise is on (from the ledger's opening bill allocations); sign: negative = debit. Total must equal Tally. |
| `ClosingBalance` | `check only` | Never written. ERP closing after import must equal it to the paisa; difference = Bug fixer. |
| `IsBillWiseOn` | `acct.accounts.bill_wise` | Bill-wise outstanding kept for these parties. |
| `BillCreditPeriod` | `master.party_terms.proposed_days` | Proposed terms only; active terms come from credit approval (§8A). Parsed from "30 Days" or a date. |
| `CreditLimit` | `master.party_terms.proposed_limit` | Proposed only; goes to the credit approval queue. |
| `IsCostCentresOn` | `acct.accounts.cost_centres_on` | Lines on this ledger expect cost centre splits. |
| `AffectsStock` | `acct.accounts.affects_stock` | Purchase or sales accounts that carry inventory. |
| `GUID` | `ops.source_keys` | Stable identity. |
| `MasterID` | `ops.source_keys` | Fallback identity. |
| `AlterID` | `ops.source_keys` | Change detection. |

#### VoucherType

| Tally field | ERP target | How it loads / what is checked |
|---|---|---|
| `Name` | `ops.tally_voucher_type_map.tally_type` | Every Tally voucher type maps to one ERP document type and tax class. Unmapped = Bug fixer "Map this voucher type"; its vouchers wait. |
| `Parent` | `ops.tally_voucher_type_map.base_type` | Base type (Sales, Purchase, Receipt, Payment, Journal, Contra, Credit Note, Debit Note, Stock Journal, Manufacturing Journal, Delivery Note, Receipt Note, orders). User-defined types inherit it. |
| `NumberingMethod` | `ops.tally_voucher_type_map.numbering` | Tally numbers are kept as the source number on imported documents; ERP series start after cut-over. |
| `IsActive` | `ops.tally_voucher_type_map.active` | Inactive types still import their history. |
| `PreventDuplicates` | `check` | Duplicate numbers in one type and year are listed in the Bug fixer. |
| `AffectsStock` | `ops.tally_voucher_type_map.affects_stock` | Decides whether inventory lines post to the stock ledger. |
| `IsOptional` | `ops.tally_voucher_type_map.optional` | Optional types never post; listed in the import report. |
| `GUID` | `ops.source_keys` | Identity. |
| `MasterID` | `ops.source_keys` | Identity. |

#### CostCategory

| Tally field | ERP target | How it loads / what is checked |
|---|---|---|
| `Name` | `acct.cost_categories.name` | Matched by name; new ones need Admin confirmation. |
| `AllocateRevenue` | `acct.cost_categories.revenue` | Kept. |
| `AllocateNonRevenue` | `acct.cost_categories.non_revenue` | Kept. |
| `GUID` | `ops.source_keys` | Identity. |

#### CostCentre

| Tally field | ERP target | How it loads / what is checked |
|---|---|---|
| `Name` | `acct.cost_centres.name` | Matched by name within its category; mapped to departments, units or vehicles where Admin links them. |
| `Parent` | `acct.cost_centres.parent_id` | Hierarchy kept. |
| `Category` | `acct.cost_centres.category_id` | Through the cost category. |
| `GUID` | `ops.source_keys` | Identity. |

#### Currency

| Tally field | ERP target | How it loads / what is checked |
|---|---|---|
| `Name` | `core.currencies.symbol` | Mapped by ISO code. |
| `MailingName` | `core.currencies.name` | Kept. |
| `OriginalSymbol` | `core.currencies.iso_code` | Key for matching (USD, AED ...). |
| `ExpandedSymbol` | `core.currencies.words_name` | Used in amount-in-words on export documents. |
| `DecimalPlaces` | `core.currencies.decimals` | Kept. |

#### StockGroup

| Tally field | ERP target | How it loads / what is checked |
|---|---|---|
| `Name` | `master.item_groups.name` | Matched by GUID then name; Biochem and Plastics groups stay per company. Ungrouped items go to "To be grouped" with a Bug fixer item. |
| `Parent` | `master.item_groups.parent_id` | Hierarchy kept. |
| `BaseUnits` | `master.item_groups.default_uom` | Through the unit map. |
| `IsAddable` | `master.item_groups.qty_addable` | Kept. |
| `GUID` | `ops.source_keys` | Identity. |

#### StockCategory

| Tally field | ERP target | How it loads / what is checked |
|---|---|---|
| `Name` | `master.item_categories.name` | Kept as a second classification. |
| `Parent` | `master.item_categories.parent_id` | Hierarchy kept. |
| `GUID` | `ops.source_keys` | Identity. |

#### StockItem

| Tally field | ERP target | How it loads / what is checked |
|---|---|---|
| `Name` | `master.items.name` | Matched by GUID, then HSN + name + unit, then cleaned name. Linked to the product master codes (for example FG-0001) through aliases. Uncertain = Bug fixer "Possible duplicate". |
| `Parent` | `master.items.group_id` | Through the stock group. |
| `Category` | `master.items.category_id` | Through the stock category. |
| `Description` | `master.items.description` | Kept. |
| `BaseUnits` | `master.items.uom` | Through the unit map. |
| `AdditionalUnits` | `master.items.alt_uom` | With the conversion from the unit master. |
| `GSTApplicable` | `master.items.gst_applicable` | Must agree with the HSN; taxable items can never go on a bill without GST. |
| `HSNCode` | `master.items.hsn` | Rate comes from the ERP HSN table with effective dates, not from Tally; a different Tally rate on vouchers = Bug fixer "GST differs from HSN rate". |
| `IsBatchWiseOn` | `master.items.batch_tracked` | Biochem finished goods and raw materials must be batch-tracked; off = Bug fixer. |
| `IsPerishableOn` | `master.items.expiry_tracked` | Expiry dates required on batches. |
| `CostingMethod` | `stg_tally.stockitem.costing_method` | Kept for reference; ERP values stock by weighted average per company unless the CA decides otherwise. Difference shown in the reconciliation. |
| `ValuationMethod` | `stg_tally.stockitem.valuation_method` | Reference only. |
| `OpeningBalance` | `inv.stock_ledger (opening)` | Loaded per godown and batch from the item's opening allocations; total must equal this. |
| `OpeningRate` | `inv.stock_ledger.unit_cost` | Opening cost. |
| `OpeningValue` | `inv.stock_ledger.value` | Must equal quantity × rate within rounding. |
| `ClosingBalance` | `check only` | ERP closing quantity per item and godown must equal it. |
| `ClosingRate` | `check only` | Compared; valuation-method differences are explained, not forced. |
| `ClosingValue` | `check only` | Compared with the ERP stock value; difference = Bug fixer (area Stock). |
| `GUID` | `ops.source_keys` | Identity. |
| `MasterID` | `ops.source_keys` | Identity. |
| `AlterID` | `ops.source_keys` | Change detection. |

#### Unit

| Tally field | ERP target | How it loads / what is checked |
|---|---|---|
| `Name` | `master.uom.symbol` | Mapped to ERP units (Nos, kg, L, g, ml, box, carton). |
| `OriginalName` | `master.uom.name` | Kept. |
| `IsSimpleUnit` | `master.uom.is_simple` | Compound units become a conversion row. |
| `BaseUnits` | `master.uom_conversions.from_uom` | First unit of a compound unit. |
| `AdditionalUnits` | `master.uom_conversions.to_uom` | Second unit. |
| `Conversion` | `master.uom_conversions.factor` | Must be > 0. |
| `DecimalPlaces` | `master.uom.decimals` | Quantities rounded to it. |
| `GSTRepUOM` | `master.uom.uqc` | Unit Quantity Code for GST returns; missing = Bug fixer. |

#### Godown

| Tally field | ERP target | How it loads / what is checked |
|---|---|---|
| `Name` | `inv.places.name` | Mapped by Admin to an ERP place (factory stores, quarantine, FG, Kochi shop, Coimbatore shop, Nellimattam, transit). Unmapped = Bug fixer "Map this godown". |
| `Parent` | `inv.places.parent_id` | Hierarchy kept. |
| `Address` | `inv.places.address` | Kept; decides GSTIN of the place. |
| `HasNoSpace` | `inv.places.is_virtual` | Not a storage place. |
| `IsExternal` | `inv.places.held_by_third_party` | Our stock with others (job worker, agent consignment). |
| `IsInternal` | `inv.places.third_party_stock` | Others' stock with us; never counted as our stock. |
| `GUID` | `ops.source_keys` | Identity. |

#### Voucher

| Tally field | ERP target | How it loads / what is checked |
|---|---|---|
| `Date` | `document.date` | YYYYMMDD; must be inside the company's books period; the period is marked "Imported from Tally" and locked after reconciliation. |
| `VoucherTypeName` | `document type` | Through the voucher-type map. |
| `VoucherNumber` | `document.source_no` | Kept exactly; duplicates within a type and year = Bug fixer. |
| `PartyLedgerName` | `document.party_id` | Through the ledger match; missing party = voucher waits, Bug fixer "Missing master". |
| `Reference` | `document.party_ref` | Supplier bill number on purchases. |
| `ReferenceDate` | `document.party_ref_date` | Supplier bill date. |
| `EffectiveDate` | `document.effective_date` | Kept. |
| `Narration` | `document.narration` | Kept as text; personal data in narrations is not copied into messages. |
| `PersistedView` | `stg_tally.voucher.view` | Invoice view vs accounting view; decides which child lists to read. |
| `IsInvoice` | `stg_tally.voucher.is_invoice` | Reference. |
| `IsCancelled` | `document.status = cancelled` | Imported with no postings, listed in the report. |
| `IsOptional` | `not posted` | Listed in the report only. |
| `IsPostDated` | `document.post_dated` | Posts on its own date; future dates listed. |
| `PlaceOfSupply` | `document.place_of_supply` | Checked against the party state: same state = CGST + SGST, other = IGST; mismatch = Bug fixer. |
| `PartyGSTIN` | `document.party_gstin` | Snapshot as on the bill; compared with the party master. |
| `BasicBuyerName` | `document.consignee_name` | Kept. |
| `Amount` | `check only` | Must equal the sum of the posted lines. |
| `GUID` | `ops.source_keys` | Primary key for re-imports: same GUID = skipped. |
| `MasterID` | `ops.source_keys` | Identity. |
| `AlterID` | `ops.source_keys` | Higher than last load = "Changed in Tally after loading" review. |
| `VoucherKey` | `ops.source_keys` | Kept for tracing. |

#### AllLedgerEntries

| Tally field | ERP target | How it loads / what is checked |
|---|---|---|
| `LedgerName` | `acct.gl_entries.account_id` | Through the ledger match. |
| `Amount` | `acct.gl_entries.debit / credit` | Negative = debit in Tally XML. Every voucher must balance to zero; unbalanced = not posted, Bug fixer. |
| `IsDeemedPositive` | `acct.gl_entries side check` | Yes = debit; must agree with the amount sign. |
| `IsPartyLedger` | `document party line` | Exactly one party line on party vouchers. |
| `GSTClass` | `acct.gl_entries.tax_class` | Kept; tax ledgers map to output, input, RCM and TDS accounts. |

#### AllInventoryEntries

| Tally field | ERP target | How it loads / what is checked |
|---|---|---|
| `StockItemName` | `document_lines.item_id` | Through the item match. |
| `ActualQty` | `inv.stock_ledger.qty` | Parsed from text like "10 Nos" or "2.500 kg"; the unit must match the item unit or a conversion. |
| `BilledQty` | `document_lines.billed_qty` | Billed vs actual difference = free quantity; listed for the free-items treatment. |
| `Rate` | `document_lines.rate` | Parsed from "100.00/Nos". |
| `Discount` | `document_lines.discount_pct` | Kept. |
| `Amount` | `document_lines.amount` | Must equal qty × rate − discount within rounding. |
| `IsDeemedPositive` | `inv.stock_ledger.direction` | Yes = inward, No = outward. Stock journals use inward and outward lists (destination and source). |
| `GSTHSNName` | `document_lines.hsn` | Compared with the item HSN. |

#### BatchAllocations

| Tally field | ERP target | How it loads / what is checked |
|---|---|---|
| `GodownName` | `inv.stock_ledger.place_id` | Through the godown map. |
| `BatchName` | `inv.lots.batch_no` | Batch identity; Biochem production batches link to the batch record. |
| `ActualQty` | `inv.stock_ledger.qty (per batch)` | Batch quantities must add up to the line. |
| `BilledQty` | `document_lines.billed_qty (per batch)` | Kept. |
| `Amount` | `inv.stock_ledger.value` | Kept. |
| `MfdOn` | `inv.lots.mfg_date` | Required for Biochem finished goods; missing = Bug fixer (area Production). |
| `ExpiryPeriod` | `inv.lots.expiry_date` | Required where expiry is tracked. |
| `OrderNo` | `document_links (order)` | Links the line to its order. |
| `TrackingNumber` | `document_links (delivery or receipt note)` | Links invoice to delivery note or receipt note. |

#### AccountingAllocations

| Tally field | ERP target | How it loads / what is checked |
|---|---|---|
| `LedgerName` | `acct.gl_entries.account_id` | The sales or purchase account an item line posts to. |
| `Amount` | `acct.gl_entries.debit / credit` | Same sign rule as ledger entries. |
| `IsDeemedPositive` | `side check` | Must agree with the sign. |

#### BillAllocations

| Tally field | ERP target | How it loads / what is checked |
|---|---|---|
| `Name` | `acct.bills.ref` | Bill reference. |
| `BillType` | `acct.bill_allocations.kind` | New Ref = opens a bill; Agst Ref = settles one; Advance; On Account. Agst Ref to a bill not found = Bug fixer. |
| `Amount` | `acct.bill_allocations.amount` | Bill-wise totals per party must equal the ledger balance. |
| `BillCreditPeriod` | `acct.bills.due_date` | Due date for ageing and reminders. |

#### CategoryAllocations

| Tally field | ERP target | How it loads / what is checked |
|---|---|---|
| `Category` | `acct.gl_cost_splits.category_id` | Through the cost category. |
| `IsDeemedPositive` | `side check` | Must agree with the parent line. |

#### CostCentreAllocations

| Tally field | ERP target | How it loads / what is checked |
|---|---|---|
| `Name` | `acct.gl_cost_splits.cost_centre_id` | Through the cost centre. |
| `Amount` | `acct.gl_cost_splits.amount` | Splits must add up to the ledger line. |

#### BankAllocations

| Tally field | ERP target | How it loads / what is checked |
|---|---|---|
| `Date` | `acct.bank_instruments.date` | Kept. |
| `InstrumentDate` | `acct.bank_instruments.instrument_date` | Cheque date. |
| `InstrumentNumber` | `acct.bank_instruments.number` | Cheque or UTR number; used to match the bank statement. |
| `TransactionType` | `acct.bank_instruments.mode` | Cheque, NEFT, RTGS, UPI, cash deposit. |
| `PaymentFavouring` | `acct.bank_instruments.favouring` | Kept. |
| `BankersDate` | `acct.bank_reco.cleared_on` | Sets the reconciled status; blank = unreconciled in the ERP bank reconciliation. |
| `Amount` | `acct.bank_instruments.amount` | Must equal the bank line. |

---

## 10. Tally data not in the owner's table: add it to the bridge

| Tally data | What it is | Why the import needs it |
|---|---|---|
| Employee, EmployeeGroup, PayHead, AttendanceType | Payroll in TallyPrime | Staff list, pay heads, attendance and salary history (G1–G5 of the spec). Match to the one group staff list. |
| Ledger opening bill allocations | Bill-wise opening balances | Needed to load opening outstanding bill by bill. |
| StockItem opening batch / godown allocations | Opening stock by place and batch | Needed for opening stock per godown and batch. |
| GST registrations of the company (multiple GSTINs) | TallyPrime GST registration details | Needed to post each voucher to the right GSTIN (Kerala, Tamil Nadu). |
| Voucher e-invoice and e-way bill fields | IRN, acknowledgement, e-way bill number | Needed to carry e-invoice status into the ERP. |
| Ledger-line tax details | GST rate and taxable value per line | Needed to compare tax with the HSN rate table. |
| Inventory entries in and out (stock and manufacturing journals) | Source and destination lists of stock journals | Biochem production entries are stock journals; both lists must be read. |
| Voucher-mode ledger and inventory lists | Lists used when a voucher is entered in accounting view | Read both the invoice-view and accounting-view lists so no line is missed. |
| Stock item bills of materials | Components of manufactured items | Compared with the ERP formulas; not imported as formulas. |
| Price levels and price lists | Price lists by customer group | Loaded as proposed price lists for approval. |
| Order vouchers and order lines | Sales and purchase orders and their due dates | Open orders at cut-over. |
| User-defined fields (TDL) | Any custom fields in Southfield's Tally | List them from a test export and map or ignore each one. |

Confirm the exact collection and tag names for each of these with a test export from Southfield's own TallyPrime version before building its parser.

---

## 11. Reconciliation (the batch can't be approved until all pass)

| Check | Compared with Tally | Pass rule |
|---|---|---|
| Trial balance | Opening, debit, credit and closing per ledger and per month | Equal to the paisa |
| Stock summary | Closing quantity per item and godown; closing value per item | Quantity equal; value difference explained by valuation method |
| Voucher count | Number of vouchers per type per month, including cancelled and optional | Equal |
| Bill-wise outstanding | Open bills per party with due dates | Equal per party |
| GST registers | Taxable value and tax per month, per GSTIN, sales and purchases | Equal; ERP recomputed tax differences listed |
| Cash and bank books | Closing per cash and bank ledger per day | Equal |
| Cost centres | Totals per cost centre per month | Equal |
| Parties | Count of customers and suppliers; GSTINs valid | All matched or listed in the Bug fixer |

**The import report** for each batch shows:

- counts per collection: created, linked, skipped, held and sent to the Bug fixer
- every check above, with Tally's figure, the ERP figure and the difference
- the list of vouchers and masters waiting, with their reasons

Admin approves the batch only when every check passes or has an accepted explanation. Admin can undo a batch until it is approved.

---

## 12. Bug fixer items from the import (area shown in brackets)

- **Masters:**
  - Confirm company (Admin)
  - Map this head (Ledger)
  - Map this voucher type (Ledger)
  - Map this godown (Stock)
  - Unit without a UQC (Stock)
- **Duplicates and conflicts:**
  - Possible duplicate (Ledger, Stock, Staff)
  - Same name under two groups (Ledger)
- **Party data:**
  - Invalid GSTIN or PAN (Ledger)
  - GSTIN state differs from place of supply (GST)
- **Voucher problems:**
  - Missing master (Ledger, Stock)
  - Unbalanced voucher (Ledger)
  - Duplicate voucher number (Ledger)
  - Agst Ref to a bill not found (Ledger)
  - Changed in Tally after loading (Ledger)
  - Deleted in Tally (Ledger)
- **Tax and limits:**
  - GST differs from HSN rate (GST)
  - Cash limit in history (Cash)
  - Bill without GST, reason needed (GST, CA review)
- **Stock and production:**
  - Negative stock in history (Stock)
  - Batch without manufacture date (Production)
- **Reconciliation:**
  - Trial balance, stock, outstanding, GST register or cash and bank difference (each in its area)

Each item carries its evidence: the staging rows, the Tally values and the ERP values. It also suggests a fix, which goes through the normal posting or mapping screens and is never an edit in place.

---

## 13. Screens

All under Admin › Import data. Build them from the existing reference `DataImport` and the list and document patterns, with no new styles.

1. **Batches.** One row per upload, showing company, file, date range, status (uploaded, staged, mapped, posted, reconciled, approved, undone), counts and who loaded it.
2. **Mapping.** Tabs for heads, voucher types, godowns, units and currencies, and item aliases. Each row shows the suggested ERP target and a Confirm button. Bulk confirm is allowed only for exact matches.
3. **Duplicates.** Possible duplicates side by side with Merge or Keep separate. A merge shows a preview of every document it will re-point.
4. **Preview.** Before posting a month: the number of vouchers by type, what will post, what is held and why.
5. **Reconciliation.** Every check in §11 with Tally, ERP and difference, drilling down to ledgers, items or bills.
6. **Tally bridge status.** Whether the import computer is online, its last pull and its last error.

---

## 14. Security

- **Where Tally data may live:** real Tally files and exports are stored only in the private `imports` bucket in Mumbai and in `stg_tally`. They never go into Git, CI, fixtures or screenshots.
- **Who can work with it:** only Admin can upload, map, merge, post, approve or undo. The CA can read the reconciliation. Every action is in the user log.
- **Bank statement passwords** and any secrets inside Tally are never extracted.
- **Personal data:** phone numbers and email addresses are stored for their purpose, and WhatsApp is used only after consent is recorded.

---

## 15. Tests (synthetic Tally XML only)

Build a small synthetic company with all collections and child lists, then test:

- **Repeat loads:** loading the same files twice creates zero new records and posts zero new vouchers.
- **Changes in Tally:**
  - A renamed ledger with the same GUID gives an alias and a review item.
  - A voucher with a higher AlterID gives a "Changed in Tally" item, and the posted entry is untouched.
- **Duplicates:**
  - Near-duplicate party names give a "Possible duplicate" item and no new party.
  - The same employee or party in both companies gives one group record.
- **Mapping gaps:**
  - An unmapped group gives "Map this head", and its vouchers are held.
  - An unmapped voucher type gives "Map this voucher type".
- **Voucher checks:**
  - An unbalanced voucher is not posted and becomes a Bug fixer item.
  - Sign rule: a negative amount with `IsDeemedPositive = Yes` posts as a debit, and a mismatch is flagged.
- **Production journals:** a stock journal with inward and outward lists posts both directions; a missing batch manufacture date is flagged.
- **Bill-wise:** New Ref then Agst Ref settles the bill. An Agst Ref to an unknown bill is flagged.
- **History:** a historical cash receipt over the limit posts and is flagged, not refused.
- **Reconciliation:**
  - The trial balance, stock summary, outstanding and GST register equal the synthetic Tally figures.
  - A deliberate one-paisa difference blocks approval.
- **Undo** removes every posting of the batch through reversals, and the audit trail shows both.

---

## 16. Build order (Phase 2 of the main plan)

1. **Bridge and staging:** the bridge's extraction and upload, the staging schema and the parsers (with format tests).
2. **Mapping:** mapping tables and screens, the matching engine, duplicates and merges.
3. **Masters:** the master import in the §5 order.
4. **Opening and history:** opening balances, then the historical posting RPC and month-by-month voucher import.
5. **Checks and approval:** reconciliation, the import report, approve and undo.
6. **Incremental pulls** by AlterID, for the parallel-run month.

Run `/verify` after each slice. Stop for the owner's review when the first real company has reconciled.

---

## 17. Open questions for the owner

- **The import computer:** which PC runs the Tally bridge, and which TallyPrime version and release it uses.
- **Customisations:** whether Southfield's Tally has TDL customisations or user-defined fields. A test export will list them.
- **Mappings (owner and CA):** the account head mapping, the voucher-type mapping (including user-defined sales types), and the godown-to-place mapping.
- **Cut-over:** the cut-over date, and who signs off the opening balances (the CA).
- **Payroll:** whether payroll history should be imported, or only the staff list and current pay structure.

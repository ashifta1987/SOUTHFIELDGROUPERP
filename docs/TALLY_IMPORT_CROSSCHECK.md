# Tally import — cross-check against the owner's Tally Import prompt (09-11-2026)

Checked: `docs/prompts/SOUTHFIELD_TALLY_IMPORT_PROMPT.md` (§1–§17) and `docs/spec/tally/Tally_Gold_Backend_Tables - Southfield ERP mapping.xlsx` (175 fields, 12 import steps, 8 reconciliation checks) against what is built and loaded on DEV on 09-11-2026. Review only; nothing was changed. Counts and group names only — no real ledger, party or item names.

## 1. Verdict

The **masters, the duplicate/merge engine, the Day Book as reference history, and the three Tally reports (Trial Balance, Stock Summary, Balance Sheet)** work and are checked against the real files. The spec's core — **historical posting of vouchers, bill-wise and stock opening, the full reconciliation suite, and the approval gate** — is **not built**. Today the ERP's books contain only the opening balances (GL entries = 0 for both companies), so the ERP cannot yet prove that it equals Tally month by month.

## 2. What is on DEV now (facts)

| | SFB Biochem | SFP Plastics |
|---|---|---|
| Vouchers loaded (ops.tally_vouchers) | 45,479, **0 with ledger lines** (Excel day book: one leg each) | 7,669, 7,551 with full lines (XML) |
| GL entries posted | 0 | 0 |
| Accounts with opening balance (as of 03-11-2026) | 860 | 276 |
| Open bills (bill-wise opening) | **0** | **0** |
| Customers/suppliers | 1,042 | 360 |
| Open Bug fixer items | 193 | 39 |

Products 4 (test leftovers, none from Tally), stock lots 2, places 4: **no Tally stock items, godowns, batches or opening stock are loaded.** Open Bug fixer kinds (all companies): possible_duplicate 120, missing_gstin 93, invalid_gstin 7, same_name_two_groups 6, total_mismatch 3, map_head 2, classify_bills 1, other 1.

## 3. Section-by-section

Severity: **Critical** blocks the reconciliation the spec requires; **High** needed before posting history; **Medium** quality/robustness; **Low** polish.

| Spec | Requirement | Status | Evidence | Severity |
|---|---|---|---|---|
| §1 | XML (not ODBC), nested child lists | Partial | Parser reads nested lists into `lines` JSON; Plastics XML has them; Biochem day book came as Excel (one leg) | High |
| §2 | Bridge service: month-by-month pulls, AlterID incremental, device key, SHA-256, company GUID | **Not built** | Only `supabase/functions/tally-bridge/index.ts` (55 lines, not deployed); manual file export + CLI load works instead; no company-GUID check (Plastics needed `--force` for the name mismatch) | Medium |
| §3 | `stg_tally` schema, one staging table per collection and child list, write-once | **Differs** | One generic `ops.import_rows` (jsonb payload; rows are updated with results). No per-child staging | Medium |
| §4 | `tally_group_map` | Built | UI "Map this head"; 28 predefined + 26 custom groups mapped; no name/IsRevenue/IsDeemedPositive suggestion engine (done by script) | Low |
| §4 | `tally_voucher_type_map`, `tally_godown_map`, unit/currency maps | **Not built** | No such tables or screens | High |
| §4 | Item aliases | Partial | product alias + `map_tally_stock_item` exist; no items yet | Medium |
| §5 | Step 1 Company match by PAN/name | Partial | Companies created by Admin; no "Confirm company" check/bug | Medium |
| §5 | Steps 2, 5, 6, 7, 8, 9: units/currency, cost centres, voucher types, stock groups/categories, godowns, items | **Not loaded** | The exported Master files contain no stock/godown/cost-centre/voucher-type masters (or the loader skips them); parser reads only part (see §4 below) | High |
| §5 | Step 10 Opening: ledgers | Built (as Trial Balance) | 860 + 276 opened at 03-11-2026; Tally's own difference parked in suspense (₹436 / ₹1,69,198.75); Biochem extra ₹35,18,807.89 from Tally's computed stock/forex lines parked in a second suspense | Critical (needs CA) |
| §5/§10 | Step 10 Opening: **bill-wise** and **stock by godown/batch** | **Not built** | `acct.open_bills` = 0; no stock opening (stock summary staged, not applied — no items) | **Critical** |
| §5/§7 | Step 11 Vouchers month by month, **historical posting `api.import_post_voucher`** | **Not built** | GL = 0. Vouchers are kept as reference only. No live-refusal-to-flag logic, no "Imported from Tally" periods | **Critical** |
| §5 | Step 12 Final reconciliation, Admin approval, period lock | Partial | Trial Balance compare and Balance Sheet group compare exist. `api.import_approve` only checks Admin + status `processed` (no reconciliation gate) | **Critical** |
| §6 | Matching: GUID → strong keys → cleaned name; duplicates, merge, one party across companies | Built | source_keys, GSTIN/PAN checks, 120 possible duplicates queued, shared parties (1,059) | — |
| §6 | Voucher: same GUID skipped; higher AlterID → "Changed in Tally"; vanished → "Deleted in Tally" | Built | in `app.imp_voucher` / `api.import_process` | — |
| §7 | Sign rule, `IsDeemedPositive` must agree with amount sign | **Not built for vouchers** | tag `ISDEEMEDPOSITIVE` not read; sign handled for reports only (verified on real Trial Balance) | High |
| §7 | GST: post Tally tax, recompute from HSN, list differences | Not built | no posting; HSN table not seeded (CA) | High |
| §8 | Qty+unit parse, Rate×Qty−Discount check, rounding | Reports only | Stock Summary parser handles "125.500 Kg"; voucher lines not checked | High |
| §9 | Field coverage of the 175 fields | **≤ 92 of 175 tags read** (upper bound: generic tags such as NAME/PARENT/GUID match everywhere) | Script comparing the spec's XML tags with `src/features/import/tally/**` and `scripts/import-tally*` | High |
| §10 | Extra data: payroll (Employee/PayHead/Attendance), opening bill/stock allocations, multi-GSTIN registration, e-invoice/e-way fields, ledger-line tax details, stock-journal in/out lists, BOM, price levels, order vouchers, TDL fields | Mostly not read | Employee masters parsed; stock-journal in/out tags present; rest absent | Medium |
| §11 | 8 reconciliation checks (TB per month, stock per godown, voucher count per type per month, bill-wise per party, GST registers, cash/bank daily, cost centres, parties) | 1 of 8 (partial) | Only Trial Balance (as at one date) and Balance Sheet (by group). Voucher counts are known (loaded vs file) but not compared in the product | **Critical** |
| §11 | Import report per batch | Partial | Batch results and Bug fixer; no report screen with the §11 list | Medium |
| §13 | Screens: Batches, Mapping tabs, Duplicates, Preview, Reconciliation, Bridge status | Partial | Batches, group mapping, duplicates (Bug fixer), report history/compare exist; no voucher-type/godown/unit/currency mapping tabs, month Preview, Reconciliation or Bridge status screens | High |
| §14 | Security: private bucket, Admin-only actions, voucher rows Admin/CA only | Built | RLS tested (pgTAP 26/27/28) | — |
| §15 | Synthetic tests listed | Partial | Covered: repeat loads, changed/deleted, duplicates, map-head, PIN cleaning, opening apply, upgrade-in-place. Not covered (feature missing): voucher-type mapping, unbalanced posting, sign rule, production journals, bill-wise New/Agst Ref, history cash-limit flag, per-month reconciliation, undo by reversals | High |

## 4. Field coverage by collection (tags found in our parsers; upper bound)

Company 7/13 · Group 5/10 · Ledger 16/25 · VoucherType 5/9 · CostCategory 2/4 · CostCentre 4/4 · Currency 1/5 · StockGroup 4/5 · StockCategory 3/3 · StockItem 10/21 · Unit 3/8 · Godown 4/7 · Voucher 13/21 · AllLedgerEntries 2/5 · AllInventoryEntries 2/8 · BatchAllocations 1/9 · AccountingAllocations 2/3 · BillAllocations 3/4 · CategoryAllocations 1/2 · CostCentreAllocations 2/2 · BankAllocations 2/7.

Definitely **not** read (needed to post history): `IsDeemedPositive` (ledger, inventory, accounting, category), `StockItemName/ActualQty/BilledQty/Discount/GSTHSNName` on inventory lines, all batch fields (`GodownName, BatchName, MfdOn, ExpiryPeriod, OrderNo, TrackingNumber`), `BillType` (New Ref / Agst Ref / Advance / On Account), bank instrument fields, `PlaceOfSupply`, `ReferenceDate/EffectiveDate`, `IsBillWiseOn/CreditLimit/IsCostCentresOn/AffectsStock` on ledgers, unit conversion and `GSTRepUOM`, stock-item batch/perishable/GST/costing flags and opening/closing rate-value.

## 5. The design conflict to decide first

The spec posts **every historical voucher** (Step 11) with opening balances at the **start of the books**, then proves Tally = ERP month by month. On 05-11-2026 the owner chose **opening date 03-11-2026** with history as reference only. Those two cannot both hold: posting history on top of a 03-11-2026 opening would double count.

| Option | What it means | Proof of correctness | Cost |
|---|---|---|---|
| A. Keep (current) | Opening at 03-11-2026; vouchers stay reference only; live posting starts after | Opening trial balance equals Tally at one date; no month-by-month proof | Smallest. Still needs bill-wise + stock opening |
| **B. Hybrid (recommended)** | Opening at 31-03-2026 (start of FY 2026-27) + post vouchers 01-04-2026 → 03-11-2026 (Biochem 4,143 vouchers ≈ 117 MB XML, ≈ +15 MB DB) then reconcile each month to Tally and to the 03-11-2026 trial balance | Month-by-month proof for the current year | Medium: needs the historical posting RPC, voucher-type/godown maps, full-entry XML for FY 2026-27, trial balance as at 31-03-2026 |
| C. Full history | Opening at books start; post all years (Biochem ≈ 1.3 GB XML, ≈ +166 MB, DB ≈ 365 MB) | Complete | Largest; may exceed the plan limit |

## 6. Recommended build order (after the owner picks A/B/C)

1. Mapping tables and screens: voucher types (with tax class and CA review for the without-GST types), godowns, units/currencies, cost categories/centres. Suggest from name/parent/IsRevenue/IsDeemedPositive.
2. Complete the parser to the 175-field list (inventory, batch, bill, bank, cost-centre child lists; sign cross-check; qty/rate checks) and keep the raw object.
3. Opening: bill-wise (ledger outstanding) and stock by godown/batch.
4. `api.import_post_voucher` (historical mode; refusals become flags; periods "Imported from Tally"; undo by reversals).
5. Reconciliation suite (8 checks), import report, approval gate in `import_approve`, period lock.
6. Bridge (optional): service on the import PC, AlterID incremental pulls for the parallel-run month.

## 7. What is needed from the owner (spec §17 and exports)

- Choice A / B / C (§5 above). Cut-over date confirmed.
- Re-export **Masters including stock items, stock groups/categories, units, godowns, voucher types, cost categories/centres, currencies** (the current Master files hold ledgers and groups only), for both companies.
- Exports as at the opening date: **Outstanding Receivables and Payables (bill-wise)**, **Stock Summary godown-wise and batch-wise**, and (for B) the **Trial Balance as at 31-03-2026**.
- For B: Day Book **XML with full entries** for FY 2026-27 (Biochem) — the Excel day book has one leg per voucher.
- Product list with HSN and UOM (opening stock), a note of any TDL customisation/user-defined fields, TallyPrime version, and whether payroll history is wanted.
- CA: mapping of the without-GST voucher types, Tally's own opening difference (₹436 / ₹1,69,198.75) and Biochem's computed-lines gap (₹35,18,807.89).


## 8. Stage 1 of the full build — what it closes (10-11-2026)

Option C (all the years) was chosen. Stage 1 builds the mapping tables, the complete parser and the staging of the voucher child lists. **Nothing is posted and no real data was changed by this stage.** Counts only below.

| Spec | Was | Now (Stage 1) |
|---|---|---|
| §3 staging per child list | Differs (one generic table) | **Closed for child lists:** `ops.tally_voucher_lines / _inventory / _batches / _bills / _costcentres / _banks`, keyed by voucher and line number, company-scoped, written once per batch (update/delete refused), readable only by Admin and the CA, parsed columns only (no raw JSON per row; the voucher keeps `row_hash`, the batch keeps the file hash and storage path). Master collections still go through `ops.import_rows` (Admin sees them in Batches). |
| §4 `tally_voucher_type_map` | Not built | **Built** (`ops.tally_voucher_type_map`, suggestion by Parent / name; user-defined types inherit their base type; types named like “… WO” or “… Non GST” → `without_gst` + `ca_review`, never auto-confirmed and never bulk-confirmed) |
| §4 `tally_godown_map`, unit and currency maps | Not built | **Built** (`ops.tally_godown_map`, `tally_unit_map`, `tally_currency_map`) plus `tally_item_map` (item aliases) and `tally_group_suggest` (head suggestions from name, parent, IsRevenue, IsDeemedPositive; confirmed heads still land in `ops.tally_group_map`) |
| §4 “Nothing posts until every name is mapped” | Not enforced | **Visible:** `api.tally_map_gaps` lists unmapped voucher types, godowns, units, ledgers and items used by staged vouchers, with counts; the gate itself is enforced by `api.import_post_voucher` in Stage 2 |
| §5 steps 2, 5–9 (units, cost centres, voucher types, item groups/categories, godowns, items) | Not loaded | **Loaders built:** units, currencies, cost categories / centres, voucher types, godowns, stock categories, stock groups (default unit), stock items (batch / expiry / GST flags, alternate unit, category, opening allocations kept as staged data). Items are created **only** with an HSN and a known unit; otherwise Bug fixer `missing_hsn` / `map_unit`. **Data still missing:** the owner's Master files hold groups, ledgers and currencies only (parse-only check) — they must be re-exported with the stock and voucher-type masters. |
| §9 field coverage | 7/13 … (see §4 above) | **175 of 175** spec tags are read (`src/features/import/tally/specTags.json` + a Vitest that fails if a tag is not handled; 12 tags are staged as reference only: closing balances / rates / values, costing and valuation method, group IsAddable, voucher Amount) |
| §8 sign, quantity, rate, amount checks | Not done | **Done in the parser:** negative = debit, IsDeemedPositive cross-check (`sign_mismatch`), quantity + unit and rate + unit parsing (`qty_unparsed`, `unit_mismatch`), Rate × Qty − Discount against Amount within ₹1 (`amount_mismatch`), dates YYYYMMDD, Yes/No, UTF-16 and entities; the original text is kept in `*_text` columns |

Still **open** after Stage 1: historical posting (Stage 2), bill-wise and stock opening, the eight reconciliation checks, the import report, the approval gate and the lock (Stage 3), the bridge (§2), company-GUID confirmation (§5 step 1).

### Findings from the parse-only check of the Plastics Day Book (7,669 vouchers; nothing loaded)

- Every voucher carries at least one child list; vouchers still balance to the paisa when read through the amounts (debit = credit).
- Ledger lines 24,684 (13,675 `ALLLEDGERENTRIES`, 6,899 `LEDGERENTRIES`, 4,951 accounting allocations inside item lines); inventory lines 4,954 (2,185 vouchers), all in the plain list (no stock or manufacturing journal in this company); batch allocations 4,951, all with godown and batch name; **no manufacturing or expiry date on any batch** in this company; bill allocations 1,384 (New Ref 1,346, Agst Ref 38); bank allocations 1,893; no cost-centre allocations.
- TallyPrime writes an empty `BILLALLOCATIONS.LIST` and `BANKALLOCATIONS.LIST` on almost every ledger line; the parser skips empty ones (otherwise 24,144 and 25,522 empty rows would be staged).
- **Sign flag:** 737 ledger lines have `IsDeemedPositive` disagreeing with the amount sign, all in the `LEDGERENTRIES` copy of invoice vouchers (Sales Gst 551, Purchase 108, Sales Order 27, Sales 27, Credit Note 12, Delivery Note 11, Sales Non GST 1). The amount sign is the reliable one (every voucher balances), so these stay as flags for the Stage 2 review, not blocks.
- Quantity or unit unparsed: 0. Rate × Qty − Discount differs from Amount by more than ₹1: 141 inventory lines (Purchase 111, Sales Gst 16, Sales 8, Sales Order 3, Delivery Note 2, Debit Note 1) — flagged. Lines or inventory rows without a name: 6.

## 9. Stage 2 and Stage 3 plan

**Stage 2 — historical posting (`api.import_post_voucher`)**
1. Gate: a voucher posts only when its voucher type, every godown, unit, ledger and item it uses are confirmed (`api.tally_map_gaps` empty for it); otherwise it waits and a Bug fixer `missing_master` item is opened.
2. One transaction per voucher, idempotent on `(company, GUID)`, locks, `source = tally`, batch ID in the audit trail; lines must balance to zero or the voucher becomes `unbalanced_voucher`.
3. Live refusals become flags, not blocks: ₹2 lakh cash receipt, ₹10,000 cash payment, negative stock, credit limit, MRP, approvals / segregation of duties. GST posts as in Tally and is compared with the HSN rate table (“GST differs from HSN rate”). Cancelled vouchers post nothing; optional vouchers never post; bills in a non-GST class keep the class with the reason “None · CA review”.
4. Month preview (counts by type, trial balance movement, stock movement) before each month is posted; periods marked “Imported from Tally”.
5. Undo by reversals (a reversal plus a new document, both linked); never an update or delete of a posted record.

**Stage 3 — opening and proof**
1. Bill-wise opening (ledger opening bills) and stock opening by godown and batch as one opening document per company, signed by the CA.
2. The eight reconciliation checks of the owner's table (trial balance per ledger and month, stock summary, voucher count per type and month, bill-wise outstanding, GST totals, cash and bank, party balances, closing values) in `api.import_reconcile`.
3. Import report, approval gate in `api.import_approve` (all checks pass), then the period lock.

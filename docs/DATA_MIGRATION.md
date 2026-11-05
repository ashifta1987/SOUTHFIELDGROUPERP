# Data migration: Tally to Southfield ERP

How Tally data comes into the ERP (§25, §25A). The plan's later steps (cut-over, parallel run) finish in Phase 9.

## What can be loaded (Import data screen, Admin or the "Load Tally data" right)

| Source | How | Status |
|---|---|---|
| Tally XML export (masters, day book) | Parsed in the browser into rows (`src/features/import/tally/parseTallyXml.ts`). The rows go to `api.import_stage_rows`; Postgres decides everything in `api.import_process`. | **Built (Phase 2)** |
| Excel lists (parties, products, employees) | Headers matched by synonyms (`sheetToRows`). Same engine after that. | **Built (Phase 2)** |
| Tally backup (TBK900_xxxxx.001, zipped data folder) | Stored encrypted in the private `imports` bucket (Mumbai), with batch status `awaiting_bridge`. The **Tally bridge** on the import computer restores it in TallyPrime into its own folder, never over the live data. It reads the masters and vouchers over TallyPrime's XML/HTTP interface (port 9000) and sends rows through the `tally-bridge` Edge Function using its device key. | Upload built; bridge function written (`supabase/functions/tally-bridge`); **bridge PC not chosen yet** (owner question) |
| **Day Book** (Excel or XML) | `parseDayBook` (Excel) / the XML parser; lines go to `api.import_stage_rows`, processed in slices by `api.import_process_step`. Reference history only (see below). | **Built (Phase 10)** |
| **Trial Balance** (Excel, XML best effort) | `parseTrialBalance`; stored in `ops.tally_reports`; Admin applies it as opening balances. | **Built (Phase 10)** |
| **Stock Summary** (Excel, XML best effort) | `parseStockSummary`; stored; applied once as opening stock through `api.post_opening_stock`. | **Built (Phase 10)** |
| **Balance Sheet** (Excel, XML best effort) | `parseBalanceSheet`; stored; reconciliation only, never posts. | **Built (Phase 10)** |
| Nightly read-only pull during the parallel-run month | Bridge | Phase 9 |

The original file is always kept in the `imports` bucket. Each load is one **batch** (`IMP-YYMMDD-NNN`). Admin approves a batch; an unapproved batch can be undone.

## The four Tally reports (Import data → Day Book, Trial Balance, Stock Summary, Balance Sheet)

Each report is read by a pure parser (`src/features/import/tally/reports/*.ts`, the same code in the browser and in `scripts/import-tally-report.mjs`). The parser only converts layout; the database decides.

| Report | What it does | What it never does |
|---|---|---|
| **Day Book** | Keeps every voucher line as reference history in `ops.tally_vouchers` (type, number, date, party, amount, Dr or Cr side). Parties are matched to `master.parties` by name or alias when they exist; otherwise the name stays as text. | **It cannot post.** A Day Book has one leg per voucher (no counter-legs), so it cannot make balanced entries. Nothing goes to the GL. |
| **Trial Balance** | Stored in `ops.tally_reports`. Compared with the ERP trial balance for the parallel run (`api.compare_trial_balance`, view `api.tally_report_diffs`). **Admin only**, after the CA has signed the numbers, `api.apply_trial_balance_as_opening` sets each ledger's `opening_balance`, `opening_dc` and `opening_as_of`. | It posts no ledger entry. Bill-wise detail of debtors and creditors stays as the unclassified opening bills already loaded. It is refused when debit ≠ credit (Bug fixer item), when the sheet lists groups only, when a ledger's Tally group is not mapped (Bug fixer "Map this head"), or when vouchers are already posted after the report date. |
| **Stock Summary** | Stored; items are matched to `master.products` by name or alias. `api.apply_stock_summary_as_opening_stock` (Admin or the stock approval right) posts each item once through `api.post_opening_stock`, in the store you choose, at Tally's rate. | Zero or negative quantities are not posted (Bug fixer). Items not in the product list stop the apply until each is mapped to an existing product (an alias) or created on the Products screen with an HSN and unit the user chooses. A report is applied once. |
| **Balance Sheet** | Stored; group totals of both sides are compared with the ERP for Tally groups that are mapped to an account group (`api.compare_balance_sheet`, view `api.tally_report_bs_diffs`). | It never posts anything. |

**Order to load them:** 1 masters (From Tally) → 2 Trial Balance (CA checks; Admin applies) → 3 Stock Summary (apply) → 4 Day Book (history) → 5 Balance Sheet (compare). Map the Tally groups first (Tally books screen) so ledgers can be placed.

**Idempotent.** A report is identified by company, kind, as-of date and the SHA-256 of the file: the same file again is recognised and stores nothing new. Day Book lines carry `match_key = type|no|date|amount|party|dr-or-cr`; two identical lines in one file get `|#2`, `|#3` so both load, and loading the same file again skips every line. A staged report is history: its lines never change and it is never deleted; only its status moves (stored → applied → replaced).

**Privacy of bills without GST.** A Day Book contains voucher types sold without GST (for example `SALES WO`). Voucher rows (`ops.tally_vouchers` and the staged voucher rows in `ops.import_rows`) are readable only by Admin and the CA, and only Admin can stage voucher rows (a person who holds just "Load Tally data" cannot).

### How to export from TallyPrime
- **Day Book:** Display More Reports → Day Book, set the period, Alt+E (Export) → Excel (Spreadsheet) → Export. The title lines (company, period), the header row (Date, Particulars, Vch Type, Vch No., Debit Amount, Credit Amount) and the "Inwards / Outwards Qty" sub-header row are found and skipped automatically.
- **Trial Balance:** Display More Reports → Trial Balance, period ending on the opening date, **Alt+F5 (Expanded)** so every ledger shows, then Alt+E → Excel. A sheet with groups only is refused with a message asking for the ledger-wise export. Closing Balance (Debit, Credit) columns, plain Debit / Credit columns, or one column with Dr/Cr suffixes are all read. Group rows are told from ledger rows by leading spaces when present, otherwise by the group's amount equalling the sum of the rows below it; the ledger total is checked against the file's Grand Total, and a "Diff. in opening balances" row is reported.
- **Stock Summary:** Display More Reports → Stock Summary, date, Alt+E → Excel. Closing quantity (e.g. `125.500 Kg`), rate and value are read; the as-of date comes from the title line.
- **Balance Sheet:** Display More Reports → Balance Sheet, date, Alt+E → Excel. Both layouts are read: horizontal (Particulars | Amount | Particulars | Amount, liabilities left) and vertical (a Liabilities and an Assets section).
- **XML:** XML exports of the three display reports are also read (tolerant tag scanner), but they have **not** been tried against a real TallyPrime file; check the totals shown before loading. An XML Day Book (with voucher lines) goes through the existing Tally XML parser.

### Loading from the command line (owner's computer)
`npx tsx scripts/import-tally-report.mjs --company SFB --kind daybook --file <path.xlsx> --dry-run` prints the pre-load summary (counts by voucher type, Dr/Cr totals, date range, company named in the file) and sends nothing. Without `--dry-run` it signs in as the Admin login (`E2E_ADMIN_*` from the environment or `.env.test.local`, never printed), stages in chunks of 1,500 lines and processes in slices of 1,000 with progress. `--kind trial_balance|stock_summary|balance_sheet` stores the report (`--as-of` when the file has no date); `--apply` (Trial Balance, or Stock Summary with `--place <store code>`) then calls the apply RPC. `--force` loads even when the company named in the file does not look like the chosen company. Real files are passed at run time and are never committed (`imports/` is git-ignored).

## Real TallyPrime export layouts (learned from the first real load)

Generic notes only; no real values. All TallyPrime XML files are UTF-16LE with a BOM. Tally writes **a debit as a negative number and a credit as a positive one** in every XML report.

| File | Layout | What the importer does |
|---|---|---|
| **Masters** ("All Masters" `IMPORTDATA`) | `TALLYMESSAGE` blocks holding `CURRENCY`, `COMPANY`, `GROUP`, `LEDGER`. No stock items or units unless Tally was asked for them. A predefined group has `RESERVEDNAME` set, a custom one has it empty. Names can end in `&#13;&#10;`. Some PIN codes hold `0`, 5, 7 or 10 digits. A ledger can have no parent (Tally's reserved Profit & Loss). | `scripts/import-tally-masters.mjs` streams the file (UTF-16 decoded incrementally, cut on `</TALLYMESSAGE>`), uses the Import screen's parser and RPCs, prints counts and the group list. A PIN that is not exactly 6 digits is left out. |
| **Trial Balance XML** | A flat ledger list: `DSPACCNAME/DSPDISPNAME` then `DSPACCINFO` with `DSPCLDRAMTA` / `DSPCLCRAMTA` (one signed figure, the other blank). No group rows, no Grand Total, no title or date. A pseudo-line "Opening Stock" can be present with blank figures. | Net debit = −(DR + CR) so a wrong-sign figure still lands on the right side. Blank lines are dropped; a non-zero Opening/Closing Stock line is kept and flagged `stock_valuation_line`. No group is guessed from sums. The as-of date comes from `--as-of` (the file has none). |
| **Stock Summary XML** | Flat item list: `DSPCLQTY` = "<qty> <unit>" (may be negative or blank), `DSPCLRATE` and `DSPCLAMTA` may be blank. `DSPCLAMTA` is negative for stock held. | Value = −`DSPCLAMTA`. Negative quantities, blank rates and value-only lines are kept and counted. No stock groups in this layout. |
| **Balance Sheet XML** | One running list of `BSNAME` + `BSAMT`: `BSMAINAMT` on a group line, `BSSUBAMT` on the lines below it (ledgers or sub-groups). Liabilities are positive, assets negative; no Total lines. "Working Capital" appears as a pseudo-group. | The side is told by Tally's own group name, else by the sign; every group line is a group even with nothing below it; each side's total is the sum of its group lines, so a gap between the sides shows as `sides_differ`. |
| **Day Book XML** (voucher level) | `VOUCHER` blocks. In an item invoice (sales, purchase, notes) the sales/purchase ledger sits inside `ALLINVENTORYENTRIES.LIST/ACCOUNTINGALLOCATIONS.LIST`, not among `ALLLEDGERENTRIES.LIST`. Orders and delivery notes carry entries that never reach the books. Most of the file's size is inventory, GST and audit detail. | Both places are read, so every voucher balances. Order / delivery / receipt notes, memoranda and stock journals keep their entries as `memo_lines` and have an empty `lines`. `scripts/import-tally-daybook-xml.mjs` streams the file (`--dry-run` counts, Dr/Cr totals, per-voucher balance, size; `--from/--to` loads only a date window). |
| **Analysis workbook** (derived from Tally, not Tally's own Excel) | Sheet "Trial Balance": Ledger \| Primary group \| Group \| Debit \| Credit, a Total row (label in the Group column), a "Difference" row, a Source note. Sheet "Stock Summary": Item \| Quantity \| Unit \| Rate \| Value, a Total row (label in the Rate column), extra summary rows, a Source note. The date is only in the Source note ("balances at …", "closing as on …"). | Read by `workbookLayouts.ts`; the CLI picks the sheet by name (`--sheet` overrides). The ledger's group chain comes from the Group / Primary group columns. |

Other things the first real load showed:

- The "difference in opening balances" Tally shows is also the gap in the Trial Balance and the Balance Sheet; in one company it equals the net of the masters' opening balances exactly; in the other the masters nets differ because ledgers under unmapped custom groups are not loaded yet.
- Tally's own predefined groups are mapped 1:1 to ERP account groups named like them (`--map-predefined`, through `api.upsert_account_group` and `api.set_tally_group_map`). Custom groups are never mapped by a script: their ledgers wait as "Map this head" for the owner or CA.
- The ERP holds opening balances only (Day Book lines are reference history, never posted), so a Trial Balance comparison shows the whole year's movement as differences until opening balances are applied.
- `--reparse <tag>` on `scripts/import-tally-report.mjs` stores the same file again after a parser fix (staged reports are history and the file checksum is unique); `scripts/compare-tally-reports.mjs` prints the comparison by ledger group, never by name.
- Heavy loads: about 4 KB of database per Day Book voucher (staged row, voucher, audit history); a one-leg Day Book line costs about 2.3 KB.

## PIN codes and other bad values in masters (fixed 05-11-2026)

Root cause: `app.imp_ledger` wrote the Tally PIN and state text straight into `char(6)` / `char(2)` columns that have a CHECK (`party_addresses_pincode_check`). A PIN of `0`, `682 030`, 5, 7, 10 or 11 digits, or a long state text, failed the check or overflowed the column, and the ledger row ended as `error` (the first Biochem masters load had 99 check failures and 6 overflows). The fix is in the database, so no staged payload can fail on it again: digits only, accepted only as `[1-9][0-9]{5}`, otherwise empty with the raw text kept in address line 2 ("PIN in Tally (not valid): ..."); the state code must be 2 digits; the PAN must be valid and agree with the GSTIN. `api.import_retry_errors` re-runs the stale `error` rows of a batch. Run on the Biochem masters batch: 105 error rows before, 0 after (95 skipped because the later batch had already created them, 10 waiting for a duplicate or head decision). Every ledger of the Biochem masters file is now in `acct.accounts` except 97 names that wait for review (96 for a duplicate decision, 1 for a head mapping).

## Trial Balance applied as opening balances (DEV, 05-11-2026)

Opening date 03-11-2026 for both companies (owner decision). Applied with `api.apply_trial_balance_as_opening(... p_book_difference := true, p_skip_unmapped := true, p_zero_unlisted := true)`:

| | SFB | SFP |
|---|---|---|
| Ledgers opened | 828 (785 updated, 43 created) | 275 (264 updated, 11 created) |
| Not opened | 0 | 2 (no group, no ledger master, net zero) |
| Report status | applied | partly_applied |
| Tally's own difference (Dr − Cr) | 436.00, declared by the file | 1,69,198.75, declared by the Balance Sheet file (the Trial Balance XML has no difference row) |
| Tally pseudo-lines not opened | Opening Stock Dr 9,25,977.60 and Unadjusted Forex Cr 44,44,785.49 (net Cr 35,18,807.89, parked in a second Suspense ledger) | none |
| Unlisted ledgers set to zero | 30 (net Dr 16,07,883.20 of start-of-year openings) | 0 |
| Company debit = credit | 32,33,16,477.39 each | 4,63,04,245.99 each |

The Tally difference stays visible in Suspense for the CA (HIGH Bug fixer items). Comparison with the Trial Balance by ledger group: SFB 828 match; only in Tally 2 (the two pseudo-lines); only in the ERP 2 (the two Suspense ledgers). SFP 275 match; only in Tally 2 (the unplaced lines); only in the ERP 1 (Suspense). No group differs. No GL entry, voucher or stock entry was posted.

## Opening stock: what the owner must supply

The Stock Summary reports are staged and **not applied**: every item is unmatched, because the Tally files carry no stock item masters and no product has an HSN or unit chosen by the owner.

| | SFB | SFP |
|---|---|---|
| Items in the Stock Summary | 420 | 169 |
| By Tally unit | Kgs 205, Nos 201, CTN 4, ROLL 2, Ltrs 1, LTR 1, no unit 6 | Nos 110, Kgs 28, PKTS 27, box 2, MT 1, no unit 1 |
| Negative quantity | 15 (value −27,893.35) | 120 (no value) |
| Zero quantity | 6 | 1 |
| Zero value | 12 | 120 |
| No rate | 18 | 121 |
| Total value in the file | 1,37,90,510.87 | 1,43,07,685.13 |

The owner supplies a **product list** (Excel for the Products import) with, for every item: code, name, HSN, unit of measure (UOM), kind, and the store that holds it. HSN rates need the CA's confirmation (Q-19). **Negative quantities** must be corrected in Tally (a missing receipt or production entry) or by the owner: a line at zero or below is never posted, it opens a Bug fixer item. Units with two spellings (Ltrs / LTR, Kgs) are mapped to one UOM when the product list is loaded.

## Biochem full-entry Day Book (XML): cost estimate and plan

The Biochem Day Book was loaded from Excel (one leg per voucher, 45,479 vouchers). Only a Tally XML export carries the full entries. Measured on Plastics: 7,669 vouchers took a 216 MB XML (about 28.8 KB per voucher) and grew the database by about 28 MB (about 3.7 KB per voucher, staged rows included). The same ratios applied to the Biochem voucher counts by financial year (April to March) in the loaded Excel history (counts only; Biochem vouchers may be 30% larger or smaller, because item-heavy sales vouchers are bigger):

| Financial year | Vouchers | Estimated XML size | Estimated DB growth | Cumulative if exported newest first: vouchers / XML / DB growth / DB total |
|---|---|---|---|---|
| 2026-27 (to 03-11-2026) | 4,143 | 117 MB | 15 MB | 4,143 / 117 MB / 15 MB / 214 MB |
| 2025-26 | 8,621 | 243 MB | 32 MB | 12,764 / 360 MB / 47 MB / 246 MB |
| 2024-25 | 10,975 | 309 MB | 40 MB | 23,739 / 669 MB / 87 MB / 286 MB |
| 2023-24 | 8,909 | 251 MB | 33 MB | 32,648 / 920 MB / 119 MB / 318 MB |
| 2022-23 | 7,865 | 222 MB | 29 MB | 40,513 / 1,141 MB / 148 MB / 347 MB |
| 2021-22 | 4,966 | 140 MB | 18 MB | 45,479 / 1,281 MB / 166 MB / 365 MB |

The database is about 199 MB today (plan limit unknown; the free plan is 500 MB). Recommendation: export **2026-27 and 2025-26** first (about 360 MB of XML, about +47 MB), check the totals, then decide on earlier years. Everything is exported year by year from Tally (one XML per financial year), because a single 1.3 GB file is not practical. Loading all six years fits the free plan (about 365 MB) but leaves little room for the operating data of the first months, so the choice belongs to the owner.

How it loads: `scripts/import-tally-daybook-xml.mjs --company SFB --file <year.xml> --from 2025-04-01 --to 2026-03-31` (`--dry-run` first). `--from` / `--to` keep only vouchers dated inside the window while streaming (inclusive; a bad date or a window that ends before it starts is refused; logic in `src/features/import/tally/reports/dayBookWindow.ts`, unit-tested with synthetic data). A voucher that matches Excel one-leg vouchers on type, number and date **upgrades the first Excel leg in place** (full lines, XML guid, one voucher), and marks the other legs reversed and linked, so nothing is counted twice and loading the same file or the Excel again changes nothing. A voucher with no Excel match is created. Not run on real data yet.

## No duplicate masters (order of matching)

1. **Tally identity:** company + GUID in `ops.source_keys` (with MASTERID and ALTERID). The same GUID is always the same record. A higher ALTERID with changed content opens a "Changed in Tally after loading" item, and the record is not written over. A rename keeps the Tally name as an alias.
2. **Strong keys:** parties by GSTIN, then PAN. Items by HSN + name + unit. Employees by PAN, company employee code, phone, or date of birth + Aadhaar last 4.
3. **Names:** normalised by `app.norm_name()` (case, punctuation, "M/s", Pvt Ltd = Private Limited, & = and), plus aliases. A similar-but-not-certain match (pg_trgm similarity ≥ 0.55 for parties, ≥ 0.7 for items and people) **creates nothing** and opens "Possible duplicate" with Merge / Keep separate.

| Result | What happens |
|---|---|
| Exact match | Linked |
| Strong key matches, name differs | Linked, and the Tally name saved as an alias |
| Similar, not certain | Nothing created; a Bug fixer item opens |
| No match | Created in the "to review" state (parties: KYC draft) |

Special cases:
- **Tally groups** map to ERP account groups through `ops.tally_group_map`. They are never created automatically. An unmapped group opens "Map this head", and its ledgers wait (`waiting_map`) until the group is mapped and the batch is checked again.
- **A party under both Sundry Debtors and Sundry Creditors** opens a Bug fixer item.
- **One party or person across both companies:** parties and people are group-level and linked per company (`master.party_companies`, `master.person_companies`).
- **Merging** is Admin only, in two steps (`api.merge_preview`, then `api.merge_parties`). The merged name is kept as an alias, and the merge is logged in `ops.merge_log`.

## No duplicate transactions

- Vouchers match on company + GUID. Without a GUID they match on type, number, date, amount and party.
- The same voucher loaded again is **skipped** and counted.
- A higher ALTERID with changed lines or amount opens "Changed in Tally after loading". The loaded entry is untouched.
- A voucher that was loaded inside the file's period but is missing from the new file opens "Deleted in Tally after loading".
- Cancelled and optional vouchers are flagged, not posted.
- Vouchers stay in `ops.tally_vouchers` (state `loaded`) until the general ledger exists in Phase 3, when they are posted. They are never edited after loading.

## Reconciliation (each difference opens a Bug fixer item)

Declared totals in the batch (`totals`): `voucher_count`, `opening_dr` / `opening_cr` (trial balance), and `period_from` / `period_to`. Ledger bills are checked against each ledger's opening balance. Stock summary, GST register and payroll totals are added as those modules arrive (Phases 3–4).

## Opening outstanding

Bill-wise opening bills go to `acct.open_bills` as **unclassified**, which only Admin and the CA can see. Admin marks each bill as with GST or without GST on the Tally books screen. This is the safest reading of the view rule. Open question for the owner and CA: should unclassified bills default to with GST?

## Cut-over plan (Phase 9)

The cut-over moves each company from Tally to the ERP on one agreed **cut-over date** (best: the first day of a month, so a month's GST return comes wholly from one system; the safest choice is **1 April**, the start of a financial year). Both companies may cut over on the same date or one after the other; Biochem and Plastics each follow every step below.

> All of this happens on the **production** Supabase project (`ap-south-1`), never on DEV. Real Tally data never goes into DEV, Git, CI or screenshots (`AGENTS.md` rule 12).

### Roles

| Who | Does |
|---|---|
| Owner | Picks the cut-over date; signs the go-live checklist; decides on rollback |
| CA | Signs the opening trial balance, bill-wise debtors/creditors, stock valuation and GST carry-forward as of the cut-over date |
| Admin | Runs the imports and approvals; owns the daily reconciliation report during the parallel run |
| Accountant(s) | Enter every day's transactions in **both** systems during the parallel run |

### Step 1 — Before the cut-over date (T − 30 to T − 1)

1. Production project created in `ap-south-1`, migrations applied through the approval-gated `db-prod.yml` workflow, go-live checklist §1–§6 done (`docs/GO_LIVE_CHECKLIST.md`).
2. Masters loaded from a recent Tally backup in this **import order** (each one a batch, approved before the next):
   1. Account groups → map every Tally group (`ops.tally_group_map`); nothing waits in `waiting_map`.
   2. Units of measure, stock groups, godowns → places.
   3. Ledgers (parties are matched to group-level masters; possible duplicates resolved in the Bug fixer).
   4. Stock items (HSN + name + unit; the HSN rate rows the CA confirmed exist first).
   5. Cost centres; employees (PAN / employee code / phone).
3. Customer KYC and supplier details reviewed by a second person (KYC segregation).
4. Number series for the new FY / month created per GSTIN (no overlap with Tally's last numbers — the CA confirms the prefixes).
5. Staff trained (Help pages, one session per role); the help assistant's provider set (or left on the mock).
6. **Dress rehearsal:** load the previous month into a **fresh, empty production-like project** in `ap-south-1` (not DEV), run the reconciliation report, then delete that project. Rehearsal differences are fixed before T.

### Step 2 — Cut-over day (T)

1. Tally closes the day before T; the final Tally backup (TBK) is taken and stored in the private `imports` bucket.
2. **Opening balances as of T**, signed by the CA (signature page kept with the batch):
   - Trial balance per company (`opening_dr` = `opening_cr`; the batch refuses a mismatch).
   - Bill-wise outstanding (debtors and creditors) → `acct.open_bills` as **unclassified**; Admin classifies each with GST / without GST with the CA.
   - Stock on hand per place and lot, at the CA-agreed valuation (weighted average unless the CA decides otherwise — Q-25).
   - GST: input-tax credit carried forward, and the last return period filed in Tally.
   - Payroll: advances outstanding, leave balances, PF/ESI registrations.
3. Admin approves the opening batches. The ERP is now the place where new documents are posted.

### Step 3 — Parallel run (T to T + 1 month)

1. Every transaction is entered in **both** the ERP and Tally for one month (or the bridge pulls Tally's day book nightly, read-only, into a reconciliation batch — never posted).
2. A **daily reconciliation report** (Admin, by 11:00 next day), per company:
   - Voucher count and totals by type (sales, receipts, payments, purchases, journals): ERP vs Tally.
   - Cash and bank closing balances; bank vs the bank statement.
   - Debtors and creditors control totals; the top 20 parties' balances.
   - GST output and input by rate for the day; e-invoice IRNs issued.
   - Stock quantity by item for the top 50 items.
   - Every difference opens a Bug fixer item with an owner; the report lists open items by age.
3. At the end of each week the CA reviews the week's report.
4. The month's GST returns are prepared from the ERP (`GSTR-1`, `GSTR-3B` views) and compared with Tally's before filing.

### Step 4 — Sign-off and Tally read-only (T + 1 month)

Sign-off needs: (a) zero unexplained differences for the last 7 days, (b) the month's GST return figures match, (c) the CA's written sign-off of the parallel run, (d) the owner's signature on `docs/GO_LIVE_CHECKLIST.md` §9.

Then:
1. Tally is set **read-only**: Tally users removed or changed to view-only (TallyPrime security control), the data folder copied to an Indian archive location and kept for 8 years (Companies Act s.128(5)); no new vouchers in Tally after this date.
2. The nightly bridge pull is switched off.
3. `ops.backup_runs` gets a `restore_drill` record of the first production restore drill.

### Rollback plan

| When | Trigger | What happens |
|---|---|---|
| During the parallel run | A blocking defect (wrong tax, wrong stock, data loss, security issue) that cannot be fixed within 2 working days | Tally stays the books of record (it was kept fully up to date). The ERP is frozen (Admin removes posting rights; users get read-only). Fix, re-load the opening balances if needed, and restart the parallel run from a new date. GST returns are filed from Tally. |
| After sign-off | A blocking defect discovered later | Fix forward in the ERP with reversal + correcting documents (ledgers are append-only — never edited or deleted). If the ERP cannot be used for a period, documents are issued manually with the reserved paper series agreed with the CA and entered in the ERP afterwards, keeping the numbers gap-free. Tally is **not** reopened for posting. |
| Data loss / corruption | Restore needed | Point-in-time restore of the production project in `ap-south-1` (Supabase PITR) to a new project, verify with the restore-drill checks, switch the app's environment variables. See `docs/DEPLOYMENT_GUIDE.md` → Backups and restore. |

Every rollback decision is the owner's, recorded in the Bug fixer and in `docs/IMPLEMENTATION_STATUS.md`.

## Tests (synthetic Tally data only)

`supabase/tests/06_import.sql` (15 assertions) and `src/features/import/tally/parseTallyXml.test.ts` (13 tests, including item-invoice vouchers, memorandum vouchers, PIN codes and entity-encoded names).

Phase 10, Tally reports: `supabase/tests/26_tally_reports.sql` (67 assertions: idempotent staging, Admin-only apply, Dr ≠ Cr refused, opening balances only when balanced and mapped, unmapped group → "Map this head", group-wise refused, vouchers after the date refused, stock applied once, voucher rows Admin/CA only, other company invisible, compare shows differences, timing of a 500-line step), `src/features/import/tally/reports/reports.test.ts` (25 tests on synthetic in-memory workbooks), and `e2e/phase10-tally-reports.spec.ts` (synthetic .xlsx generated at run time, fresh synthetic company, DB assertions, axe).


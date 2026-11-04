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

`supabase/tests/06_import.sql` (15 assertions) and `src/features/import/tally/parseTallyXml.test.ts` (9 tests).

Phase 10, Tally reports: `supabase/tests/26_tally_reports.sql` (67 assertions: idempotent staging, Admin-only apply, Dr ≠ Cr refused, opening balances only when balanced and mapped, unmapped group → "Map this head", group-wise refused, vouchers after the date refused, stock applied once, voucher rows Admin/CA only, other company invisible, compare shows differences, timing of a 500-line step), `src/features/import/tally/reports/reports.test.ts` (25 tests on synthetic in-memory workbooks), and `e2e/phase10-tally-reports.spec.ts` (synthetic .xlsx generated at run time, fresh synthetic company, DB assertions, axe).


# Data migration: Tally to Southfield ERP

How Tally data comes into the ERP (§25, §25A). The plan's later steps (cut-over, parallel run) finish in Phase 9.

## What can be loaded (Import data screen, Admin or the "Load Tally data" right)

| Source | How | Status |
|---|---|---|
| Tally XML export (masters, day book) | Parsed in the browser into rows (`src/features/import/tally/parseTallyXml.ts`). The rows go to `api.import_stage_rows`; Postgres decides everything in `api.import_process`. | **Built (Phase 2)** |
| Excel lists (parties, products, employees) | Headers matched by synonyms (`sheetToRows`). Same engine after that. | **Built (Phase 2)** |
| Tally backup (TBK900_xxxxx.001, zipped data folder) | Stored encrypted in the private `imports` bucket (Mumbai), with batch status `awaiting_bridge`. The **Tally bridge** on the import computer restores it in TallyPrime into its own folder, never over the live data. It reads the masters and vouchers over TallyPrime's XML/HTTP interface (port 9000) and sends rows through the `tally-bridge` Edge Function using its device key. | Upload built; bridge function written (`supabase/functions/tally-bridge`); **bridge PC not chosen yet** (owner question) |
| Nightly read-only pull during the parallel-run month | Bridge | Phase 9 |

The original file is always kept in the `imports` bucket. Each load is one **batch** (`IMP-YYMMDD-NNN`). Admin approves a batch; an unapproved batch can be undone.

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


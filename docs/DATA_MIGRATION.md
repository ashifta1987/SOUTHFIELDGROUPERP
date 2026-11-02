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

## Cut-over (Phase 9)

1. The CA signs off the opening balances.
2. One-month parallel run, with nightly reconciliation.
3. Tally becomes read-only.
4. The final load is approved, and posting starts in the ERP.

## Tests (synthetic Tally data only)

`supabase/tests/06_import.sql` (15 assertions) and `src/features/import/tally/parseTallyXml.test.ts` (9 tests).


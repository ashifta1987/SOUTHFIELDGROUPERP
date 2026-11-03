# DEV database reset (03-11-2026)

> **WARNING — DEV ONLY. Never run this on production.** `scripts/dev-reset.mjs` skips the append-only guard triggers
> (inside one transaction, via `session_replication_role = replica`) and truncates ledgers and audit. It refuses to run
> unless the project ref is the hard-coded DEV ref (`fxwoabbwzcifxzqsmrie`) and `CONFIRM_DEV_RESET=yes`. Do not add a
> production ref to the allow-list. Production corrections are always reversal + new document.

Done on 03-11-2026 at the owner's request ("delete the test data, I will upload Tally backup for testing"). Everything
on DEV was synthetic (E2E companies, parties, products, the 50k-invoice "E2E Perf" company, test users, test files).
No trigger was dropped or altered; the setting reverts at commit.

## Backup taken first
`backups/dev-full-2026-11-03T16-38-30-626Z.ndjson.gz` — 61.5 MiB, 242 tables, 911,386 rows (all app schemas, `auth.users`
without password hashes, `auth.identities`, `storage` metadata), one repeatable-read snapshot, via `scripts/dev-backup.mjs`
(`pg_dump` is not installed). `backups/` is git-ignored (`git check-ignore backups` → `backups`). Line format:
`{"t":"schema.table","r":{...row}}`; the last line is a manifest with row counts.

## Kept
Full tables (seeded by migrations, or `scripts/help-seed.mjs` for help pages): `core.roles`, `core.rights`,
`core.role_rights`, `core.doc_types`, `core.forms`, `core.law_rules`, `master.uoms`, `master.credit_terms`,
`msg.templates`, `acct.schedule3_lines`, `help.pages`, `ops.backup_runs` (Phase 9 backup/restore-drill evidence).

Partly kept:
- `core.settings` — group-level rows (`company_id is null`) with their version history (16 rows); company rows wiped.
- `core.user_profiles` — the 4 kept logins. `core.user_roles` — their base roles only (company_id null, no end date):
  admin → `admin`, staff → `staff`. `phase0.store` and `phase0.investor` have **no** base role (they never had one; the
  specs grant company roles for an hour). Time-limited company roles were removed.
- `supabase_migrations`, `cron` jobs, buckets and storage policies — untouched.

Kept auth users: `phase0.admin@southfield.test`, `phase0.staff@southfield.test`, `phase0.store@southfield.test`,
`phase0.investor@southfield.test` (passwords untouched). The synthetic `e2e.concurrency.*` user was removed.

## Wiped (TRUNCATE … RESTART IDENTITY CASCADE, 226 tables)
Every other table in `acct, audit, core, field, help, hr, inv, master, msg, ops, prod, purch, sales`: companies and
everything company-scoped, parties, products, HSN codes/rates, people, vouchers, GL, stock ledger, lots, documents,
orders, batches, payroll, audit (`row_history`, `user_log`), `core.request_log`, `ops.error_log`, bug items, import and
integration tables, `msg.outbox/inbound`, `field.*`, `hr.*`, `prod.*`, `inv.*`, `purch.*`, `sales.*`,
`help.problem_reports`, special grants, doc series/issued numbers, licences, etc.
Largest: `audit.row_history` 297,628 · `acct.gl_entries` 240,837 · `inv.stock_ledger` 100,493 · `sales.document_lines`
100,099 · `acct.vouchers` 70,286 · `sales.documents` 50,083 · `acct.bill_allocations` 20,135 · `msg.outbox` 10,254.
`master.credit_terms` references `core.companies`, so the script stashes it and restores it after the TRUNCATE.

Storage: all objects deleted via the Storage API (imports 20, pod 4, documents 4, bills 10, kyc 0, field 0); buckets and
policies kept.

Audit note: `audit.user_log` event `admin_action`, detail action `dev_reset` (the table only accepts a fixed event list).

## Re-run
```
DB_PASSWORD=… node scripts/dev-backup.mjs                       # required first (a backup < 24 h old must exist)
DRY_RUN=yes CONFIRM_DEV_RESET=yes DB_PASSWORD=… node scripts/dev-reset.mjs     # prints counts, rolls back
CONFIRM_DEV_RESET=yes DB_PASSWORD=… SUPABASE_SECRET_KEY=… node scripts/dev-reset.mjs
```
Secrets come from the shell only; nothing is stored. Auth/storage steps need `SUPABASE_SECRET_KEY`. The Auth Admin API
fails to list users if one row has `banned_until = 'infinity'` or NULL token columns (the concurrency script created such
a user); fix the row, then delete it through the API.

## First steps for the owner
1. Sign in as `phase0.admin@southfield.test`.
2. Admin → Companies: add Biochem and Plastics with real PAN, CIN and GSTINs.
3. Admin → Numbering: open the financial year and set the number series.
4. Chart of accounts / mapping.
5. Import data → Tally books.

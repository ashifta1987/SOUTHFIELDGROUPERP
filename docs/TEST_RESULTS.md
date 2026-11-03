# Test results

## Phase 0 — 03-11-2026

| Check | Command | Result |
|---|---|---|
| Lint | `pnpm lint` | Pass (0 problems) |
| Types | `pnpm typecheck` | Pass (TypeScript 6, `strict`, `noUncheckedIndexedAccess`) |
| Unit tests | `pnpm test` | **30 passed** in 5 files: Indian number formatting, IST dates and FY, views from the server-set role (and ignoring a role in user-editable metadata), the 126-screen catalogue, 17 flows, sidebar order, i18n key parity, placeholder parity, `needs-native-review` flags, component behaviour (Amount, chips with word and icon, coming-in-phase buttons, Field error linking, Tabs keyboard, DataTable empty state and `th scope`, ConfirmDialog focus on Cancel) |
| Build | `pnpm build` | Pass. Warning: the main chunk is about 800 kB (233 kB gzip). Code-splitting is planned before go-live (see Phase 9 performance) |
| End to end + axe | `npx playwright test` (DEV Supabase, synthetic accounts) | **11 passed**, 3 skipped (screenshot specs, run only with `REVIEW_SHOTS=1`). Covers the sign-in screens with zero serious or critical axe issues, a wrong-password message, the language switch (sets `html lang`), the redirect to sign-in, Admin Home with the "All transactions" chip, the workflow strip and empty states, sidebar → Customers with the Phase 2 controls disabled, Ctrl+K and the Help panel, a planned screen, the drawer at 834 px, and staff landing on `/staff/home` |
| pgTAP | `supabase test db` | Not applicable: Phase 0 creates no tables. Starts in Phase 1 |
| Secrets scan | grep for the secret key and DB password outside `.env*` | None found. `design-reference/`, `.env*` and the pack zip are not staged |
| Hex colours outside tokens | grep `#xxxxxx` in `src/**/*.ts(x)` | None |

### Known gaps (not failures)

- No Playwright test yet asserts **database state**, because Phase 0 writes nothing to the database. These tests start in Phase 1 with the first RPCs.
- Phone + password sign-in can't be tested end to end until the Supabase phone provider is switched on (open question Q-07).
- The low-end Android font check for Malayalam and Devanagari (§UX-9) is not yet automated.


## Phase 1 — 03-11-2026

| Check | Command | Result |
|---|---|---|
| Lint / types | `pnpm lint`, `pnpm typecheck` | Pass |
| Unit tests | `pnpm test` | 30 passed |
| pgTAP (DEV DB, each file rolled back) | `DB_PASSWORD=… pnpm db:test` | **43 passed, 0 failed** — `01_audit` (9), `02_rights` (14), `03_grants` (13), `04_numbering` (7) |
| End to end + axe (DEV DB round-trip) | `npx playwright test --workers=1` | **28 passed**, 4 skipped (screenshot specs) |
| Build | `pnpm build` | Pass |

Notes: pgTAP runs through `scripts/pgtap.mjs` against the DEV project because Docker (needed for `supabase start` / `supabase test db`) is not installed on this computer. Playwright tests create synthetic `E2E…` rows in DEV; `scripts/e2e-cleanup.mjs` removes them (history rows stay, by design).

## Phase 2 — 03-11-2026

| Check | Command | Result |
|---|---|---|
| Lint / types | `pnpm lint`, `pnpm typecheck` | Pass |
| Unit tests | `pnpm test` | **39 passed** (adds 9 Tally XML parser tests) |
| pgTAP (DEV, rolled back) | `pnpm db:test` | **73 passed, 0 failed** — adds `05_masters` (16) and `06_import` (15): same file twice creates nothing, rename under same GUID → alias + review item, one person across both companies, near-duplicate → Bug fixer item and no new party, unmapped group → "Map this head", voucher changed after loading → "Changed in Tally" with the loaded entry untouched, opening bills hidden from the GST view |
| End to end + axe | `npx playwright test --workers=1` | **38 passed**, 5 skipped (screenshot specs) |

## Phase 3 — 03-11-2026

| Check | Command | Result |
|---|---|---|
| Lint / types | `pnpm lint`, `npx tsc -b` | Pass |
| Unit tests | `pnpm test` | **39 passed** |
| pgTAP (DEV, rolled back) | `pnpm db:test` | **155 passed, 0 failed** — adds `07_documents` (GST by place of supply, rate from HSN, no taxable sale without GST, Admin-only without GST, MRP, gap-free numbers, balanced GL, idempotent posting), `08_money_payroll` (cash limits, allocations, closed period, OT, preparer cannot approve payroll, own payslip only), `09_money_screens` (8), `10_hr_screens` (20), `11_staff_help` (25). `05_masters` plan count corrected (15). |
| End to end + axe | `npx playwright test --workers=1` | **46 passed**, 5 skipped (screenshot specs). New: `phase3-invoice` (2), `phase3-money` (3), `phase3-payroll` (3), `phase3-staff`, `phase3-help`, `phase3-whatsapp` — each asserts DB state and runs axe. `phase0` assertions relaxed so they hold once DEV has figures; `phase2-import` waited on the always-visible intro text and is now tied to the success message. |

## Phase 4 — 03-11-2026

| Check | Command | Result |
|---|---|---|
| Lint / types | `pnpm lint`, `npx tsc -b` | Pass |
| pgTAP (DEV, rolled back) | `pnpm db:test` | **250 passed, 0 failed** — adds `12_inventory` (50: last unit, append-only ledger, negative stock allowance, 9-state transfer, balance rule, picker cannot close, sellable buckets, challan vs IGST invoice, blind counts, regrind, RLS) and `13_purchase` (45: request approval by another, RFQ/quotes, drafter cannot issue PO, one `po_issued` outbox row for consented suppliers only and none on retry, GRN → quarantine → test by non-receiver → release, exact 3-way match, MSME dues, payment advice, price history, RLS) |
| Concurrency (two real connections) | `node scripts/concurrency-check.mjs` | Pass — of two simultaneous issues of the last unit exactly one commits, the other is refused `stock.insufficient` after waiting on the lock; balance 0; one ledger row (2 rounds) |
| End to end + axe | `npx playwright test --workers=1` | **48 passed**, 7 skipped (screenshot specs). New: `phase4-purchase`, `phase4-inventory` (three logins for segregation of duties) |

## Phase 5 (database) — 03-11-2026

| Check | Command | Result |
|---|---|---|
| Lint / types | `pnpm lint`, `npx tsc -b` (after `pnpm db:types`) | Pass |
| pgTAP (DEV, rolled back) | `pnpm db:test` | **352 passed, 0 failed** — adds `14_production_biochem` (63: formula approval by another person, no batch without an approved formula or a valid licence, second-person weighing, QC limits, packaging + bulk reconciliation with Bug fixer item and close block, FG quarantine, self-release block, costing, pack GST treatment, RLS) and `15_production_plastics` (39: mould project order and approval, theoretical output and OEE recomputed, granules/scrap through the ledger, inspection by someone else, BOM approval, assembly refused when short, pad printing ink, machine checks, RLS) |
| End to end + axe | — | Screens not built yet (Phase 5 screens next) |

## Phase 8 (integrations) — 03-11-2026

| Check | Command | Result |
|---|---|---|
| Lint / types | `pnpm lint`, `npx tsc -b` (now also `tsconfig.functions.json`: Edge Functions + shared adapters; Deno not installed, so no `deno check`) | Pass |
| Unit (Vitest) | `pnpm test` | **69 passed** — adds `src/integrations/webhooks.test.ts` (Shopify HMAC valid / wrong secret / tampered / missing, RFC 4231 vector, generic HMAC with prefix and timestamp replay window, constant-time compare, back-off schedule and dead-letter rule), `help-redaction.test.ts` (Aadhaar, PAN, IFSC, UPI, phone, account numbers, salary amounts; salary/KYC/bank keys dropped; bills without GST dropped/withheld; the mock model only ever sees redacted text; no data tools on WhatsApp), `einvoice.test.ts` (mock GSP round trip with IRP-style IRN, failures retryable or not, cancel, mock e-way validity, QR claim shape, bank/GPS payload cleaning) |
| pgTAP (DEV, rolled back) | `pnpm db:test` | `24_integrations` **65/65** (back-off timing 60 s → 120 s, dead letter after 5 → Bug fixer item → retry → fixed, e-invoice switch / not final / print refused / outbox hold and release, idempotent request and apply, cancel window and reasons, IRN never edited, e-way required and cancelled e-way refused, start with IRN + e-way, GPS on duty only, webhook dedupe and forged events, help on WhatsApp verification and tool allow-list, TCS reconciliation rate_not_set → matched → mismatch after reversal, append-only settlements, RLS, worker claim and stale sweep) |
| End to end + axe | `npx playwright test e2e/phase8-integrations.spec.ts` | **1 passed** (mock providers through DB RPCs; axe on Invoice, Dispatch board, Bug fixer) |

## Phase 9 (go-live readiness) — 03-11-2026

| Check | Command | Result |
|---|---|---|
| RLS / grants audit | `DB_PASSWORD=… node scripts/rls-audit.mjs` | **0 findings**: 238/238 tables with RLS and at least one policy, 0 public buckets. The 3 first-run findings were fixed in `009000` |
| Secrets scan | `node scripts/secrets-scan.mjs` (also in CI) | **Clean**: tracked tree and the full git history |
| pgTAP (DEV, rolled back) | `DB_PASSWORD=… node scripts/pgtap.mjs` after `scripts/e2e-cleanup.mjs` | **695 passed, 0 failed**, 26 files. New: `25_security` (35): catalogue guarantees, MFA off/on, set-based helpers = `app.can()`, audit-history gate. The file passed against the old helpers before `009200`, and against the new ones after |
| Unit (Vitest) | `pnpm test` | **69 passed** |
| Lint / types / build | `pnpm lint`, `npx tsc -b`, `pnpm build` | Pass |
| End to end + axe | `npx playwright test e2e/phase0.spec.ts e2e/phase8-integrations.spec.ts e2e/phase3-invoice.spec.ts e2e/phase3-money.spec.ts e2e/phase3-whatsapp.spec.ts e2e/phase4-inventory.spec.ts e2e/phase6-accounts.spec.ts --workers=1` (these cover the list pages changed for paging: sales register, cash book, WhatsApp outbox, stock movements) | **20 passed**. The first run had 2 failures, both from leftover DEV test data, not from Phase 9: (1) a synthetic GSTIN collided with an earlier test party, because `randomPan()` had only 10⁴ values and 262 test parties exist; widened to about 1.8·10⁸. (2) A bank-line row appeared after more than 5 s on a busy database; the wait is now 15 s. Re-run green, plus `phase2-customers` |
| CSP against the built app | `dist/` served locally with the `vercel.json` headers (HSTS and `upgrade-insecure-requests` left out, since the server is plain http), signed in as the E2E Admin, 11 screens (invoices, sales register, customers, receipts, stock movements, cash book, WhatsApp, transaction log, Bug fixer, backup) | **0 CSP violations**; IBM Plex Sans and Mono load. `e2e/phase9-headers.spec.ts` checks the deployed URL |
| Performance at 50k | `scripts/perf-measure.mjs` | Every list < 1 s for Admin and accountant (slowest 257 ms). See "Phase 9 performance" below |
| Restore drill (logical) | `node scripts/restore-drill.mjs --record` | 13/13 key tables restored with identical row counts and checksums (240.8 MB). Recorded in `ops.backup_runs`. See `DEPLOYMENT_GUIDE.md` → Backups and restore |

## Phase 9 performance — 03-11-2026

**Target:** every main list < 1 s server time at 50,000 rows, for Admin **and** a non-admin role (accountant). Part 1 §28 Phase 9.

**Data:** synthetic company `E2E Perf Synthetic Pvt Ltd` (code `E2EPERF`, DEV only) from `scripts/perf-seed.mjs`: 50,000 posted sales invoices, 100,000 lines, 70,000 vouchers, 240,000 GL rows, 100,000 stock rows, 20,000 receipts with bill allocations, 10,000 outbox rows (≈ 294,000 audit-history rows in the whole DEV database). Rows were inserted with every trigger on (audit trail, append-only and period guards). The company code starts with `E2E`, so `scripts/e2e-cleanup.mjs` switches it off. Posted rows are never deleted.

**Method:** `DB_PASSWORD=… node scripts/perf-measure.mjs --runs=3`. Each query is the one the screen sends through PostgREST, run as role `authenticated` with JWT claims set and RLS on. Two synthetic users are created inside a transaction that is rolled back: an Admin, and an accountant of the perf company. The figure is planning + execution from `EXPLAIN ANALYZE`, best of 3, server side. Network time is not included.

| Query (screen) | Admin before | Admin after | Accountant before | Accountant after |
|---|---:|---:|---:|---:|
| Sales register, month, 1000 rows | 1,214 ms | **126 ms** | 6,540 ms | **127 ms** |
| Sales register, page of 200 | 245 | **41** | 1,315 | **47** |
| Sales register totals, month (new RPC) | — | **13** | — | **13** |
| Invoices, latest 25 | 23,085 | **8** | timeout (> 60 s) | **14** |
| Receivables, all sales docs (5000) | 3,766 | **27** | 12,234 | **32** |
| Receivables, most overdue 500 | 42,447 | **253** | timeout | **257** |
| Receivables, one party | 120 | **5** | 346 | **12** |
| Stock movements, latest 300 | 535 ¹ | **6** | 1,571 ¹ | **6** |
| Stock movements, date range 300 | — | **46** | — | **39** |
| Transaction log, latest 500 | — | **4** | 2,863 ² | **2** |
| Transaction log, one table | — | **6** | 392 ² | **2** |
| GL lines, debtors ledger 500 | 2,053 | **6** | 6,033 | **6** |
| GL lines, day book 200 | timeout | **4** | timeout | **4** |
| Vouchers, cash book 500 | 41,228 | **5** | timeout | **11** |
| Vouchers, receipts 100 | 12,445 | **3** | 22,193 | **10** |
| Customers, all by name | 921 | **3** | 2,240 | **15** |
| Outbox, sent 200 | 6,559 | **2** | 18,521 | **9** |
| Outbox, reminders of a company 200 | 6,539 | **2** | 18,377 | **9** |

¹ The baseline used the latest 200 rows. ² This figure comes from the intermediate run after `009100` (the baseline run did not include the transaction log). The accountant has no `logs.view`, so the result is 0 rows.

**Slowest after:** 257 ms (receivables sorted by days overdue, which is computed per row). Every list is under 1 s for both roles.

**What changed:**

1. **`20261103009100_performance_indexes.sql`:**
   - Indexes matching each list's filter and sort: `(company_id, doc_date desc, doc_no desc)`, `(company_id, posted_at desc)`, GL `(company_id, [account_id,] entry_date desc, id desc)`, stock `(company_id, id desc)` and `(company_id, move_date desc, id desc)`, outbox `(status, created_at desc)` and `(company_id, event, created_at desc)`, audit `(table_name, at desc)`, the bill-allocation covering index, and a partial customers index.
   - The read policies of the large tables and the always-joined tables now evaluate their rule once per statement: `company_id = any ((select app.companies_with(R))::uuid[])` instead of a per-row `app.can()`.
   - New `api.sales_register_totals` gives correct month totals while the list is paged.
2. **`20261103009200_rls_helpers_set_based.sql`:** `companies_with`, `companies_with_any` and `readable_companies` now take one pass over the user's roles instead of calling `app.can()` for each of the 155 DEV companies. This removed the accountant's fixed cost of about 1.4 s per statement. `api.stock_movements` checks cost visibility once per statement.
3. **`20261103009300_row_history_policy_gate.sql`:** a refused audit-history read now stops at the index instead of filtering all 294k rows (accountant: 1,348 → 2 ms).
4. **UI paging (`src/data/paged.tsx`):**
   - The sales register, stock movements and WhatsApp outbox load 200 rows at a time with "Load more", ordered by the indexed keys.
   - The sales register totals come from the server, so they stay right at any page.
   - The cash book reads the status of exactly the vouchers in its ledger rows. It used to take the latest 500, which missed older rows at volume.

**Same rules:** `supabase/tests/25_security.sql` proves that the set-based helpers give exactly the companies that `app.can()` / `app.can_read_company()` give, for 7 kinds of user × 11 rights, with MFA enforcement off and on. The full pgTAP suite passes after each migration.

**Front end (not server time):** the build is still one 2.8 MB minified chunk (0.7 MB gzip), and the PWA precaches it. Route-level code splitting has not been done yet (see the Phase 9 gaps in `IMPLEMENTATION_STATUS.md`).

**Raw outputs:** baseline, intermediate and final tables are kept in the Phase 9 working notes (not committed).

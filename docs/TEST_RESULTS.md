# Test results

## Phase 0 — 03-11-2026

| Check | Command | Result |
|---|---|---|
| Lint | `pnpm lint` | Pass (0 problems) |
| Types | `pnpm typecheck` | Pass (TypeScript 6, `strict`, `noUncheckedIndexedAccess`) |
| Unit tests | `pnpm test` | **30 passed** in 5 files: Indian number formatting, IST dates and FY, views from the server-set role (and ignoring a role in user-editable metadata), the 126-screen catalogue, 17 flows, sidebar order, i18n key parity, placeholder parity, `needs-native-review` flags, component behaviour (Amount, chips with word and icon, coming-in-phase buttons, Field error linking, Tabs keyboard, DataTable empty state and `th scope`, ConfirmDialog focus on Cancel) |
| Build | `pnpm build` | Pass. Warning: the main chunk is about 800 kB (233 kB gzip). Code-splitting is planned before go-live (Phase 9 performance) |
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

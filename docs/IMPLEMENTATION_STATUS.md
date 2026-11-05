# Implementation status

| Item | Value |
|---|---|
| Current phase | **Phases 4–8 complete on DEV. Phase 9 — Go-live readiness: built and verified on DEV (03-11-2026); production go-live waits for the owner's checklist (`docs/GO_LIVE_CHECKLIST.md`).** Phase 3 approved by the owner on 03-11-2026 ("start phase 4"). On 03-11-2026 the owner waived the per-phase review stop ("don't ask me more permission, you can complete the project"): phases 4–9 are built back to back, each still verified (pgTAP + Playwright + axe) and reported; production go-live steps that need the owner (prod project, keys, WhatsApp, GSP) stay listed under Open questions. |
| Repo before this session | Empty (prompt pack only: `AGENTS.md`, `.agents/`, `docs/prompts`, `docs/design`, `docs/spec/README.md`) |
| Supabase | One project provided (`https://fxwoabbwzcifxzqsmrie.supabase.co`), treated as **DEV**. No ERP schema yet. Region **verified ap-south-1 (Mumbai)** on 03-11-2026. Checked 03-11-2026: email provider on, **phone provider off**, **public sign-up still on** (must be turned off). Two synthetic review accounts created (`phase0.admin@southfield.test` role admin, `phase0.staff@southfield.test` role staff); passwords in the gitignored `.env.test.local`. |
| GitHub | https://github.com/ashifta1987/SOUTHFIELDGROUPERP (must be private) |
| Hosting | Vercel (static SPA) |
| Spec | `docs/spec/SOUTHFIELD_ERP_SPEC.md` **missing** — blocks Phase 1+ acceptance checks |

## Phase 0 checklist (§28, §UX-14)

| # | Deliverable | Status |
|---|---|---|
| 1 | Audit repo + Supabase; map screens to `PAGE_INVENTORY.md` | Done — see `MODULE_INVENTORY.md` (126 screens missing; repo was empty) |
| 2 | `ERP_ARCHITECTURE.md`, `MODULE_INVENTORY.md`, this plan | Done (draft) |
| 3 | `DEPLOYMENT_GUIDE.md`, `SECURITY.md`, `ROLE_PERMISSION_MATRIX.md` | Done (initial) |
| 4 | Tokens + fonts, shell (Sidebar, Topbar with view chip + Help button, FlowStrip, drawer < 1280 px) | Done — `src/ui/shell/`, `src/app/nav.ts`, `src/app/flows.ts` (17 flows), `src/app/screens.ts` (126 routes) |
| 5 | Sign-in (`Login`), staff sign-in (`StaffSignIn`) with Supabase Auth | Done — email + password with TOTP verification when a factor exists; phone + password wired (needs the phone provider, Q-07) |
| 6 | Components on `/dev/ui` (dev only): Card, KpiTile, DataTable, Amount, StatusChip, TaxClassChip, Button, Field, Tabs, ConfirmDialog, PhoneHeader, BottomNav, OfflineBadge | Done — `src/ui/`, gallery at `/dev/ui` (excluded from production build) |
| 7 | Home (`Main`), Customers, StaffHome with empty states | Done — read `api.*` objects; show designed empty states until the phase that builds them |
| 8 | Screenshots vs references in `docs/review/phase-0/` + differences list | Done — `docs/review/phase-0/README.md`, deviations below |
| 9 | Stop for owner review | **Waiting for the owner** |

Phase 0 builds **no ERP tables**. Data on the three screens shows designed empty states only.

---

## Phase 9 result (03-11-2026)

| # | Deliverable | Status |
|---|---|---|
| 1 | RLS / grants audit `scripts/rls-audit.mjs`. 3 real findings fixed in `20261103009000` (3 tables without a policy, lost `anon` grant on the failed sign-in log, 3 mutable `search_path`). Re-run: 238/238 tables with RLS + policy, **0 findings**. `supabase/tests/25_security.sql` makes these permanent. `docs/SECURITY.md` §12 | Done |
| 2 | Server-side MFA: `security.enforce_mfa` (default off; on in prod) drops MFA-required roles below aal2 everywhere (RLS, RPCs → `mfa_required`, investor portal). `api.me().mfa_needed` sends the user to the TOTP step | Done. **Gap:** no in-app TOTP enrolment screen |
| 3 | Secrets scan `scripts/secrets-scan.mjs` (tree + full history, masked output): **clean**. CI job `secrets-scan` (gitleaks + script) in `.github/workflows/ci.yml` | Done |
| 4 | Security headers / CSP in `vercel.json` (Supabase https + wss, storage, `data:`/`blob:` images, Google Fonts, no `unsafe-eval`, `frame-ancestors 'none'`). `e2e/phase9-headers.spec.ts` checks the deployed URL | Done. Runs against a deployment |
| 5 | Performance at 50k invoices: every list < 1 s for Admin **and** accountant (slowest 257 ms, was up to > 60 s). `009100` indexes + once-per-statement policies, `009200` set-based helpers, `009300` audit gate. Paging + server totals in the UI. `docs/TEST_RESULTS.md` → Phase 9 performance | Done |
| 6 | `docs/DPDP_CHECKLIST.md` (each duty → where enforced, gaps marked) | Done |
| 7 | Backups policy + logical restore drill on DEV (`scripts/restore-drill.mjs`, recorded in `ops.backup_runs`). `docs/DEPLOYMENT_GUIDE.md` → Backups and restore says what was **not** drilled (PITR, full pg_restore) | Done (logical drill) |
| 8 | Cut-over plan in `docs/DATA_MIGRATION.md`. `docs/GO_LIVE_CHECKLIST.md` for the owner's signature | Done |

Verification: pgTAP **695/695** (26 files), Vitest 69/69, `tsc -b`, lint and build pass, Playwright (list pages, Phase 0, Phase 8) green. See `docs/TEST_RESULTS.md`.

DEV was reset on 03-11-2026 at the owner's request ("delete the test data, I will upload Tally backup for testing"): all synthetic data, test users and uploaded test files were removed, configuration and the 4 test logins were kept. E2E tests recreate their own synthetic data. See `docs/DEV_RESET.md`.

Known Phase 9 gaps:
- There is no TOTP enrolment screen. Enrol through Supabase before turning on enforcement.
- The app ships as one 2.8 MB minified JS chunk (about 0.7 MB gzip). Route-level code splitting is still to do.
- Full PITR and `pg_restore` drills must be done on prod.
- The CSP carries the DEV project URL until go-live.

## Phase 8 result (03-11-2026)

| # | Deliverable | Status |
|---|---|---|
| 1 | Contracts in `DATABASE_SCHEMA.md` / `API_DOCUMENTATION.md` ("Phase 8"); decisions D-P8-1..6 in `ERP_ARCHITECTURE.md`; deploy steps, secrets and regional invocation in `DEPLOYMENT_GUIDE.md` | Done |
| 2 | Migrations `20261103008000…8200` on DEV: outbound integration queue with back-off and dead letter → Bug fixer (closed again on success), stale-worker sweep (pg_cron), webhook events deduplicated per provider (signed events only), e-invoice IRNs with the per-GSTIN switch + start date (not final without IRN: print refused, WhatsApp invoice held, goods cannot leave), IRN cancel within the window, e-way bills from the API with Part-B and cancel, cancelled/expired e-way bill refused at the gate, bank feeds, online-store order staging, marketplace settlements and the TCS u/s 52 reconciliation (CA rate setting), GPS provider intake on duty only, help on WhatsApp for verified staff (no data tools) | Done |
| 3 | Edge Functions (code + adapters with mocks; **not deployed**, no access token): `integration-worker`, `einvoice`, `ewaybill`, `bank-feed`, `gps-intake`, `store-webhooks`, `help-agent`, `help-whatsapp`; shared pure modules in `supabase/functions/_shared/` type-checked by `tsc -b` (Deno not installed, so no `deno check`) | Code done |
| 4 | Screens: e-invoice panel + QR on the invoice (print checks the server first), IRN on the printed invoice, e-way bill status and request on the dispatch board, Bug fixer → Integrations (dead letters, retry, webhook log), Bug fixer area "Integrations" | Done, live data |
| 5 | pgTAP `24_integrations.sql` **65/65**; Vitest +30 (HMAC, back-off, redaction, mock GSP, QR shape, feed/GPS cleaning); Playwright `phase8-integrations.spec.ts` green (mock providers through DB RPCs, axe on 3 screens) | Done |

Known Phase 8 gaps: no real provider is wired (GSP, e-way, bank feed, GPS, stores, AI model, speech-to-text) — each adapter refuses until chosen, so requests dead-letter instead of pretending; voice input in the in-app Help panel (UI) and voice-note download from WhatsApp media are not built (transcriber adapter only); help-agent rate limit (30/hour) and monthly cost cap are not enforced yet; listing/inventory sync to stores is queued-kind only; GSTR-1/2B filing through the GSP not built; e-invoice for exports (EXPWP/EXPWOP) not covered (exports are stored without GST); the settings and verified-staff screens for Phase 8 are RPC-only (no screen yet for `set_einvoice_switch`, bank feeds, GPS devices, help WhatsApp staff, marketplace settlements — reachable through the API and planned for the Settings screen).

## Phase 7 result (03-11-2026)

| # | Deliverable | Status |
|---|---|---|
| 1 | Contracts in `DATABASE_SCHEMA.md` / `API_DOCUMENTATION.md` ("Phase 7"); decisions D-P7-1..4 in `ERP_ARCHITECTURE.md` | Done |
| 2 | Migrations `20261103007000…7400` on DEV: job work on challan (return by 1 year inputs / 3 years capital goods, balance per line, overdue), maintenance (repair requests, failed operator checks open urgent repairs, spares through the stock ledger, schedules, downtime), licences and documents (private `documents` bucket, renewals, reminders at 90/30/7 days once each, expired blocking licence stops production and packing), asset register with depreciation and disposals (refused until the CA's method/lives exist), partners, directors' loans and declarations (s.185 / s.186 checks as CA settings), profit-share minutes approved by a second Admin, partner requests decided only by Admin and never their own, investor portal (role with no write rights; own data only; figures exclude bills without GST), month-end close (doer ≠ checker; a closed month refuses every posting whatever grant; only Admin reopens with a reason) | Done |
| 3 | Screens: Job work, Maintenance, Licences and documents, Asset register, Directors and investment, Partners and profit sharing, Partner requests, Month-end close; investor portal (`/investor/*`, separate sign-in, no links into the ERP, requests to Admin only) | Done, live data |
| 4 | pgTAP **595/595**; Playwright full suite green after fixes (stale list after save fixed in the shared save hook; checkbox target size 24 px) | Done |

Known Phase 7 gaps: job work for customers' material (we as job worker) and the ITC-04 file are not built; asset QR labels and Excel import, the director-account chart and the compliance calendar need data/CA input; investor role is marked MFA-required but MFA is not enforced yet (Phase 9); an over-limit withdrawal is refused when Admin decides, not when the investor sends it.

## Phase 6 result (03-11-2026)

| # | Deliverable | Status |
|---|---|---|
| 1 | Contracts in `DATABASE_SCHEMA.md` / `API_DOCUMENTATION.md` ("Phase 6") | Done |
| 2 | Migrations `20261103006000…6700` on DEV: sales orders with credit exposure and the 7-stage credit flow, MD exceptions by another person; dispatch, trips (e-way number before start; stock leaves at start), proof of delivery (private `pod` bucket), failed/short deliveries back to quarantine; vehicles; route sales with beats, 150 m geofence, on-duty-only GPS (notice first), 90-day purge (pg_cron), salesman reads limited to GST bills (Q-12), collections with cash limits, cash handover and day end (mismatch → Bug fixer); customer care (complaints with QC hold, coverage tiers, private label, agents and commission), own shops (counter sale, day close), exports (LUT invoice Admin only, containers, packing list), online channels and listings; GSTR-1, GSTR-3B, ITC register, Schedule III with mapping confirmed by CA note; WhatsApp payment reminders (7/3/0/3/7/14, consent only, disputed/proof pauses, pg_cron daily), cost caps, inbox tasks; help data tools under the user's own rights; customer price lists | Done |
| 3 | Screens: Quotations & orders, Credit customers, Customer care and agents, Shops and supermarkets, Own shops, Online channels, Online listings, Export orders, Mixer grinder costing (not built — no tables), GST, Financials, Schedule III statements, WhatsApp (inbox tasks, cost caps, reminders), Dispatch board, Trips, Vehicles & drivers, Vehicle file, Route sales; salesman app (`/field/*`, offline queue); driver app (`/driver/*`) | Done, live data |
| 4 | pgTAP **496/496**; Playwright full suite — see `TEST_RESULTS.md` | Done |

Known Phase 6 gaps: quotations/enquiries and mixer-grinder costing have no tables; credit stages 5–6 need five different people (covered by pgTAP, e2e reaches stage 5); marketplace TCS reconciliation, van-stock counts and vehicle payload checks not built; route map not drawn (last GPS point shown); vehicle papers and driver licences not uploaded; library shows the product master only; a salesman has one duty session across companies (on duty in one company means "on duty" everywhere — by design, one person one working day); GSTR-2B match waits for the GSP (Phase 8); help "insights" and the AI evaluation set wait for the AI provider.

## Phase 5 result (03-11-2026)

| # | Deliverable | Status |
|---|---|---|
| 1 | Contracts in `DATABASE_SCHEMA.md` / `API_DOCUMENTATION.md` ("Phase 5"); KPI definitions in `KPI_DEFINITIONS.md` | Done |
| 2 | Migrations `20261103005000…5600` on DEV. Biochem: licences (production blocked without a valid one), versioned formulas approved by another person, batches with second-person weighing, samples against QC limits, packaging issue/packing into quarantine, reconciliation (difference → Bug fixer, blocks close), self-release block, batch costing, R&D trials/stability, assets/calibrations, work assignment, free items/gift packs (not billable until Admin sets GST treatment with CA note). Plastics: mould projects (stage approval by another), mould register/service, injection shifts with theoretical output and OEE, quality inspection (inspector ≠ operator/recorder), assembly BOM (approved by another) refusing when short, pad printing, machine checks, component/mould/assembly costs. `api.company_people` for people pickers without user-admin rights | Done |
| 3 | Screens: Biochem manufacturing, production entry, production flow, labs, factory work assignment, free items and gift packs, machines, costing; Licences; Lab panel; factory manager phone; Mould projects, Mould register, Mould costing, Injection production, Quality, Machine assembly, Component costing, Assembled products, Pad printing; mould manager, injection manager and machine check phones | Done, live data |
| 4 | pgTAP **359/359**; Playwright full suite green (adds `phase5-biochem`, `phase5-plastics`); e2e global setup removes leftover time-limited test roles | Done |

Known Phase 5 gaps: no upload store for asset documents / licence PDFs; no automatic expiry reminders for licences and calibrations (views show due/overdue); no reversal RPCs for posted production entries; mould quotation cost sheet, operator salary sheet, steel rates, trial reports and pad-print kanban have no tables yet; machine-check photos not captured; `/lab` uses the phone shell width; PCB/SMT route off.

## Phase 4 result (03-11-2026)

| # | Deliverable | Status |
|---|---|---|
| 1 | Contracts in `DATABASE_SCHEMA.md` / `API_DOCUMENTATION.md` ("Phase 4") | Done |
| 2 | Migrations `20261103004000…4500` on DEV: lots and status buckets (available, quarantine, hold, in transit, rejected), append-only stock ledger with locked balances (no negative stock unless a logged allowance), reorder levels, reservations, blind cycle counts posted by someone else, issues/returns, regrind and scrap sales; transfers through 9 states with the balance rule (dispatched = accepted + quarantined + returned + approved loss + in transit), picker/carrier cannot close, blind receive (quantities hidden from the receiver in every view), delivery challan for same-GSTIN moves and IGST invoice link for another GSTIN; purchase requests → RFQ → quotations → PO (drafter cannot issue; price rise must be accepted) → GRN into QC hold → incoming test by someone other than the receiver → release; bill photo capture → 3-way match → purchase bill; price history; MSME due dates; WhatsApp "PO issued" and "payment advice" outbox rows (consented contacts only) | Done |
| 3 | Screens: Purchase requests, Purchase orders (with RFQ/quotes), Goods receipt, Bill photo capture (review), Price changes, Bill photo (phone), Buying & logistics (phone), Raw material, Component stock, Stock movements, Scrap and regrind, Warehouse (tasks, QC, counts, set-up), Stock transfers | Done, live data |
| 4 | pgTAP **250/250**; two-connection race (`scripts/concurrency-check.mjs`): exactly one of two parallel issues of the last unit commits; Playwright **48 passed** | Done |

Known Phase 4 gaps: bill photo reading (OCR/AI) not wired — fields are typed; e-way bill at dispatch is Phase 8; request attachments and scrap-sale slip photos not uploaded; shortage write-off and the other-GSTIN invoice link are built but not covered by e2e (the write-off role needs MFA); phone bill photo has one page and no document-kind tabs; price changes filter by item kind (no department on items).

## Phase 3 result (03-11-2026)

| # | Deliverable | Status |
|---|---|---|
| 1 | Contracts in `DATABASE_SCHEMA.md` | Done |
| 2 | Migrations `20261103002000…3200` on DEV: vouchers + append-only GL, bill allocations, bank accounts/statement lines/matching, cash limits (₹2 lakh receipt refused, ₹10,000 payment warn + reason + Admin flag), sales documents with tax from HSN by date (CGST/SGST vs IGST), purchase bills, receipts/payments/journals/reversals, trial balance / ledger / statement, cash book and cash flow summaries, payroll (staff profiles, attendance, OT from settings, requests, cash given with the cash limit, payroll prepare/approve by a different person, payslips), duties, messaging (channels, templates, consent-only allow list, outbox, inbound), help pages and problem reports, Home summary | Done |
| 3 | Screens: Invoice, Sales register (Admin/accountant), Document templates, Receipts, Bank (reconcile + set-up), Cash book, Cash book check, Cash flow & reminders, Bills & payments, Cash entry (phone), Employees, Add staff, Attendance, Worker hours, Duties, Rotation, Requests, Allowances, Cash given, Payroll (all/company), Payroll trend, Staff workflow, Staff home/leave/advance/details/payslip, WhatsApp & email, Help panel v1 (+ "Ask Help about this" on every error box) | Done, live data |
| 4 | pgTAP **155/155**; Vitest **39**; Playwright full suite (DB round-trip + axe) — see `TEST_RESULTS.md` | Done |
| 5 | Help pages: 26 in `docs/help/`, loaded with `scripts/help-seed.mjs` | Done |
| 6 | Edge Functions `whatsapp-sender`, `whatsapp-webhook` (Meta Cloud + mock provider) | Code written; **not deployed** (WhatsApp Business account + `supabase login` needed) |
| 7 | Stop for owner review | **Waiting for the owner** |

Known Phase 3 gaps: no WhatsApp sending until the Business account exists (outbox fills, nothing leaves); no AI model in Help (search, pages and error explanations only, Q-14); PDF is browser print (server PDF + e-invoice in Phase 8); delivery challan for branch moves arrives with stock in Phase 4; "Against Tally" comparison on Cash book check waits for an imported company; Cash flow forecast covers bills only (no salaries/EMIs/statutory dues yet); "Messages by event" matrix, owner daily summary and message cost cards are Phase 6; KYC document uploads for staff, the investor/official section of Add staff, allowance classification, labour cost per hour on Duties and Excel exports are not built; StaffDetails is read-only; payroll groups follow pay basis (monthly/daily) rather than named groups. Every Playwright payroll/staff run leaves one synthetic `E2EP…` company in DEV (append-only rows), switched off by `scripts/e2e-cleanup.mjs`.

## Phase 2 result (03-11-2026)

| # | Deliverable | Status |
|---|---|---|
| 1 | Contracts in `DATABASE_SCHEMA.md`, `DATA_MIGRATION.md` | Done |
| 2 | Migrations `20261103001000…1400` on DEV: units (UQC), HSN codes + effective-dated rates (none seeded), product groups/products/MRP history/aliases, parties with KYC (GSTIN check digit, PAN inside GSTIN, duplicates), contacts with WhatsApp consent, addresses, masked bank accounts with two-person bank change + call-back, documents (private `kyc` bucket), credit terms, price lists (no price above MRP when tax-inclusive), one group-level staff list, chart of accounts, bill-wise opening outstanding (unclassified until Admin classifies), posting rules table | Done |
| 3 | Tally import engine in Postgres: GUID → strong keys → normalised names; aliases; "to review"; same file twice = skipped; changed/deleted in Tally; map heads; unbalanced vouchers; reconciliation; approve/undo; merges | Done |
| 4 | Tally XML parser (browser, format only) + Excel lists | Done (9 unit tests) |
| 5 | Bug fixer queue with resolve actions and "Run checks again" | Done |
| 6 | Backup: policy, runs and restore drills recorded (India-only locations enforced) | Done; automated nightly dump needs an India-hosted runner (owner) |
| 7 | Screens: Import data, Tally books (Biochem, Plastics), Bug fixer, Backup, Product master, Biochem products, Price lists, Customers, Customer KYC, Suppliers | Done, live data |
| 8 | pgTAP **73/73** (incl. all six §25A import tests); Playwright **38 passed** (DB round-trip + axe) | Done |
| 9 | Tally bridge Edge Function `tally-bridge` | Code written; **not deployed**; import PC not chosen |
| 10 | Stop for owner review | **Waiting for the owner** |

Known Phase 2 gaps: GSTIN live verification and monthly recheck need the GSP (Phase 8) — format + check digit + PAN + state are enforced now; supplier return-filing status also needs the GSP; opening stock quantities are read but stock loads with the stock ledger (Phase 4); vouchers are kept as loaded and post with the GL in Phase 3; nightly encrypted pg_dump needs an India-hosted runner; E2E test rows (companies/parties/products named "E2E …") remain in DEV.

## Phase 1 result (03-11-2026)

| # | Deliverable | Status |
|---|---|---|
| 1 | Data contracts in `DATABASE_SCHEMA.md` | Done |
| 2 | Migrations `20261103000100…500` applied to DEV: schemas `app/core/audit/ops/api`, group structure, users/roles/rights, three views, special permissions with time windows and the never-grantable list, settings (versioned), numbering (gap-free, 16-char limit), forms, law register, audit row history, user log, error log, idempotency | Done |
| 3 | Only the `api` schema is exposed by the Data API | Done (`pgrst.db_schemas = 'api, graphql_public'`) |
| 4 | pgTAP: accountant can't read a bill without GST; CA can't write; other company invisible; grant expires on its own and its use is recorded; never-grantable refused; nobody approves their own request; history append-only; numbering gap-free / ≤16 chars; idempotency | **43/43 pass** (`pnpm db:test`) |
| 5 | Screens: Companies, Branches and GSTINs, Units, Users & rights, Special permissions, User log, Transaction log, Numbering & IDs, Forms and fields, Settings, How each person sees it, Built to Indian law, Total workflow | Done, live data |
| 6 | App uses `api.me()` for view, rights and running grants; special-permission banner with countdown; sign-in / sign-out / failed sign-in in the user log; error references stored in `ops.error_log` | Done |
| 7 | Playwright with DB round-trip + axe | **28/28 pass** |
| 8 | Edge Function `admin-users` (create accounts) | Code written; **not deployed** (needs owner's `supabase login`, see DEPLOYMENT_GUIDE) |
| 9 | Stop for owner review | **Waiting for the owner** |

Known Phase 1 gaps: account lock-out after repeated failures relies on Supabase rate limits (an app-level lock needs the Auth password-verification hook, Q-08); concurrency of numbering is protected by a row lock but the two-session test runs only with a local Supabase (needs Docker); the Admin WhatsApp code for giving rights arrives with WhatsApp in Phase 3; GSTIN check against the GST portal arrives with the GSP in Phase 8; 4 inactive `E2E…` test companies remain in DEV because their versioned settings rows are append-only.

## Phase 0–9 plan

Conventions: tables are schema-qualified and planned; contracts are finalised in `docs/DATABASE_SCHEMA.md` before each phase. Every posting RPC is `api.*`, `security definer`, takes `p_client_request_id uuid` first (shown as `crid`), locks rows, checks rights/state/period/stock/limits, writes ledgers + history in one transaction. Acceptance checks below come from the prompt; **they must be reconciled with spec Part I once the spec is supplied.** Every phase also requires: pgTAP for RLS + RPCs, a Playwright test asserting DB state per workflow touched, axe with zero serious/critical issues, i18n keys, help pages (`docs/help/<Screen>.md`, from Phase 3).

### Phase 0 — Audit and shell

- **Tables:** none.
- **RPCs:** none (Supabase Auth only).
- **Screens:** Login, StaffSignIn, Main (shell), Customers (shell), StaffHome (shell); shared Sidebar, Topbar, FlowStrip, StaffNav; `/dev/ui`.
- **Acceptance:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` pass; sidebar order matches §UX-4.1 exactly; view chip derived from server-set role; no figures/names from `design-reference/` in code; axe clean on the 5 screens; screenshots in `docs/review/phase-0/`.

### Phase 1 — Foundation

- **Tables:** `core.groups`, `core.companies`, `core.gstins`, `core.branches`, `core.places`, `core.departments`, `core.financial_years`, `core.periods`, `core.people`, `core.user_profiles`, `core.roles`, `core.rights`, `core.role_rights`, `core.user_roles`, `core.user_scopes`, `core.approval_limits`, `core.special_grants`, `core.special_grant_requests`, `core.never_grantable_rights`, `core.settings`, `core.doc_types`, `core.doc_series`, `core.doc_series_counters`, `core.state_transitions`, `core.document_links`, `core.forms`, `core.form_fields`, `core.law_rules`, `audit.row_history`, `audit.user_log`, `audit.document_versions`, `ops.error_log`.
- **Helpers (`app`):** `app.can(company_id uuid, right text) → boolean`, `app.current_view() → text`, `app.has_grant(right text, params jsonb) → uuid`, `app.take_doc_number(company_id, gstin_id, doc_type, fy_id) → text`, `app.audit_trigger()`.
- **RPCs:**
  - `api.me() → jsonb` (profile, roles, rights, scopes, view, active grants, language)
  - `api.upsert_company(crid, p jsonb) → uuid`, `api.upsert_gstin(crid, p jsonb) → uuid`, `api.upsert_branch(crid, p jsonb) → uuid`, `api.upsert_place(crid, p jsonb) → uuid`, `api.upsert_department(crid, p jsonb) → uuid`
  - `api.assign_role(crid, p_user_id uuid, p_role text, p_scope jsonb)`, `api.set_user_scope(crid, p_user_id uuid, p_scope jsonb)`, `api.set_approval_limit(crid, p_role text, p_doc_type text, p_amount numeric(18,2))`
  - `api.request_special_permission(crid, p_right text, p_params jsonb, p_from timestamptz, p_to timestamptz, p_reason text) → uuid`
  - `api.grant_special_permission(crid, p_user_id uuid, p_right text, p_params jsonb, p_from timestamptz, p_to timestamptz, p_reason text) → uuid`, `api.revoke_special_permission(crid, p_grant_id uuid, p_reason text)`
  - `api.upsert_doc_series(crid, p jsonb) → uuid`, `api.set_setting(crid, p_company_id uuid, p_key text, p_value jsonb, p_effective_from date)`
  - `api.upsert_form_field(crid, p jsonb) → uuid`
  - `api.log_error(p_route text, p_rpc text, p_rule_code text, p_message text, p_payload_summary jsonb) → text` (returns `ERR-…`), `api.log_user_event(p_event text, p_detail jsonb)`
  - Edge Function `admin-users` (create / disable user; sets `app_metadata`)
- **Screens:** Companies, Branches, Units, Users, SpecialAccess, UserLog, TransactionLog, Numbering, FormFields, UXOverview, LawRules, ERPFlow, Settings (no ref); Login/StaffSignIn wired to `api.me()` + user log + lock-out.
- **Acceptance:** pgTAP: accountant cannot read a bill without GST (using a synthetic test document table); CA cannot write anything; Plastics user cannot see Biochem rows; a grant expires on its own and actions under it record the grant ID; never-grantable rights cannot be granted; `audit.row_history` rejects update/delete and cannot be disabled; numbering is gap-free under concurrency; nobody approves their own request. Playwright: Admin creates company → GSTIN → branch → place → user, asserting rows.

### Phase 2 — Masters and data load

- **Tables:** `master.hsn_codes`, `master.hsn_rates` (effective_from/to), `master.uoms`, `master.product_groups`, `master.product_families`, `master.products`, `master.product_mrp_history`, `master.product_labels`, `master.pack_sizes`, `master.barcodes`, `master.parties`, `master.party_companies`, `master.party_aliases`, `master.party_contacts`, `master.party_addresses`, `master.party_documents`, `master.party_bank_accounts`, `master.bank_change_requests`, `master.gstin_checks`, `master.credit_terms`, `master.price_lists`, `master.price_list_items`, `master.supplier_material_approvals`, `acct.account_groups`, `acct.accounts`, `acct.cost_centres`, `acct.posting_rules`, `acct.open_bills` (bill-wise opening outstanding), `ops.import_batches`, `ops.import_rows`, `ops.source_keys`, `ops.tally_group_map`, `ops.bridge_devices`, `ops.bug_items`, `ops.bug_item_evidence`, `ops.merge_log`, `ops.backup_runs`, `ops.restore_drills`.
- **RPCs:** `api.upsert_product(crid, p jsonb) → uuid`; `api.set_hsn_rate(crid, p_hsn text, p_rate numeric(9,4), p_effective_from date, p_reason text)`; `api.hsn_rate_on(p_hsn text, p_date date) → numeric(9,4)`; `api.propose_customer(crid, p jsonb) → uuid`; `api.upsert_supplier(crid, p jsonb) → uuid`; `api.verify_party_kyc(crid, p_party_id uuid, p_result jsonb)`; `api.request_bank_change(crid, p_party_id uuid, p_bank jsonb) → uuid`; `api.approve_bank_change(crid, p_request_id uuid, p_callback_note text)` (second person); `api.set_customer_terms(crid, p_party_id uuid, p_terms_id uuid)` (approval); `api.upsert_price_list(crid, p jsonb)`; `api.upsert_account(crid, p jsonb)`; `api.start_import_batch(crid, p_company_id uuid, p_kind text) → uuid`; `api.stage_import_rows(p_batch_id uuid, p_rows jsonb)` (Edge Fn only); `api.approve_import_batch(crid, p_batch_id uuid)`; `api.undo_import_batch(crid, p_batch_id uuid)`; `api.merge_parties_preview(p_keep uuid, p_merge uuid) → jsonb`; `api.merge_parties(crid, p_keep uuid, p_merge uuid)`; `api.keep_separate(crid, p_bug_item_id uuid)`; `api.resolve_bug_item(crid, p_bug_item_id uuid, p_fix jsonb)`; `api.record_backup_run(crid, p jsonb)`. Edge Functions `gstin-verify`, `tally-import`.
- **Screens:** ProductMaster, BiochemProducts, PriceList, Customers (data), CustomerKYC, SupplierKYC, DataImport, TallyBiochem, TallyPlastics, BookFixes, Backup.
- **Acceptance (§25A tests, synthetic Tally XML only):** same file twice → zero new records; renamed ledger with same GUID → alias + review item; same employee in both companies → one person; near-duplicate party names → Bug fixer item, no new party; unmapped Tally group → "Map this head"; voucher changed after loading → "Changed in Tally" item, posted entry untouched. Also: GST rate resolved by HSN + date; bank change needs two people; duplicate GSTIN/PAN/phone warns; restore drill recorded.

### Phase 3 — Cash, invoicing and payroll (+ WhatsApp core, Help v1)

- **Tables:** `acct.vouchers`, `acct.voucher_lines`, `acct.gl_entries` (append-only), `acct.bill_allocations`, `acct.bank_accounts`, `acct.bank_statements`, `acct.bank_statement_lines`, `acct.bank_matches`, `acct.tds_entries`, `sales.invoices`, `sales.invoice_lines`, `sales.invoice_tax_lines`, `sales.delivery_challans`, `sales.credit_notes`, `sales.receipts`, `sales.receipt_allocations`, `purch.bills`, `purch.bill_lines`, `purch.payments`, `purch.payment_allocations`, `core.doc_templates`, `hr.employees`, `hr.employee_kyc`, `hr.employee_bank`, `hr.designations`, `hr.employee_company_assignments`, `hr.rotations`, `hr.duties`, `hr.attendance_hours`, `hr.leave_requests`, `hr.advance_requests`, `hr.allowance_types`, `hr.allowance_lines`, `hr.cash_given`, `hr.pay_groups`, `hr.payroll_runs`, `hr.payroll_lines`, `hr.payslips`, `msg.channels`, `msg.templates`, `msg.contacts`, `msg.outbox`, `msg.inbound`, `msg.events`, `help.pages`, `help.chunks`, `help.conversations`, `help.messages`.
- **RPCs:** `api.preview_invoice_tax(p_header jsonb, p_lines jsonb) → jsonb`; `api.post_sales_invoice(crid, p_header jsonb, p_lines jsonb) → jsonb` (tax class; lawful reason + Admin for without-GST; refuses taxable HSN without GST; refuses above MRP; challan vs IGST invoice by GSTIN); `api.post_delivery_challan(crid, p_header, p_lines)`; `api.post_credit_note(crid, p_invoice_id uuid, p_lines jsonb, p_reason text)`; `api.check_cash_limit(p_party_id uuid, p_amount numeric(18,2), p_date date, p_direction text) → jsonb`; `api.post_receipt(crid, p_party_id uuid, p_amount numeric(18,2), p_mode text, p_allocations jsonb) → jsonb`; `api.post_payment(crid, p_party_id uuid, p_amount numeric(18,2), p_mode text, p_allocations jsonb, p_cash_reason text)`; `api.approve_payment(crid, p_payment_id uuid)`; `api.post_journal(crid, p_lines jsonb)`; `api.post_contra(crid, p jsonb)`; `api.post_purchase_bill(crid, p_header, p_lines)`; `api.reverse_document(crid, p_doc_type text, p_doc_id uuid, p_reason text)`; `api.stage_bank_lines(p_statement jsonb)` (Edge Fn), `api.match_bank_line(crid, p_line_id uuid, p_targets jsonb)`; `api.party_ledger`, `api.general_ledger`, `api.day_book`, `api.ageing(p_side text, p_as_of date)`; `api.upsert_employee(crid, p jsonb)`; `api.record_attendance(crid, p_rows jsonb)`; `api.submit_leave_request(crid, p jsonb)`; `api.submit_advance_request(crid, p jsonb)`; `api.decide_request(crid, p_request_id uuid, p_decision text, p_comment text)`; `api.record_cash_given(crid, p jsonb)`; `api.run_payroll(crid, p_company_id uuid, p_period_id uuid) → uuid`; `api.approve_payroll(crid, p_run_id uuid)`; `api.post_payroll(crid, p_run_id uuid)`; `api.record_consent(crid, p_contact jsonb)`; `api.opt_out(p_number text)`; `api.send_document_whatsapp(crid, p_doc_type text, p_doc_id uuid, p_contact_id uuid)`; `api.upsert_template(crid, p jsonb)`; Help: `api.create_problem_report(crid, p_area text, p_summary text, p_details text, p_route text, p_error_ref text) → text`, `api.explain_error(p_ref text) → jsonb`, `api.handoff_to_human(crid, p_topic text)`. Edge Functions `pdf-render`, `whatsapp-sender`, `whatsapp-webhook`, `help-agent` (`search_help`, `explain_error`, `create_problem_report`, `handoff_to_human`), `bank-statement-import`.
- **Screens:** Invoice, SalesRegister, CompanyPortal, Receipts (no ref), Bills & payments (no ref), CashBook, CashBookCheck, CashFlow, BankReco, DocPreview, WhatsApp, CashEntry, StaffKYC, AddStaff, StaffDuties, StaffRotation, Attendance, WorkerHours, StaffWorkflow, Requests, Allowances, CashGiven, Payroll, PayrollBiochem, PayrollBiochemTrend, StaffHome (data), StaffLeave, StaffAdvance, StaffDetails, StaffPayslip, StaffPayslipHasanan; HelpPanel + phone chat; `ErrorRef` everywhere.
- **Acceptance:** balanced GL for every posting; idempotent retry returns same doc; closed period refused; cash receipt ≥ ₹2 lakh/person/day refused; cash payment > ₹10,000 warns + reason recorded; CGST/SGST vs IGST by place of supply; same-GSTIN move only on challan, other-GSTIN only on IGST invoice; taxable HSN without GST refused; non-Admin cannot create without-GST bill; Debtors/Creditors control = sum of party ledgers; payslip in employee language; Aadhaar stored last 4 only. **§WA-8:** invoice post creates exactly one outbox row; retry creates none; consent/opt-out block; mock WhatsApp server e2e post → PDF → sent → delivered → chip; STOP opts out; bad webhook signature rejected; duplicate events ignored. **§HELP:** every UI error has a ref in `ops.error_log`; problem report creates a Bug fixer item; help-agent uses user JWT only.

### Phase 4 — Inventory and purchase

- **Tables:** `inv.lots`, `inv.stock_ledger` (append-only), `inv.stock_balances` (view/materialised), `inv.negative_stock_allowances`, `inv.reservations`, `inv.transfers`, `inv.transfer_lines`, `inv.transfer_events`, `inv.cycle_counts`, `inv.count_lines`, `inv.reorder_levels`, `purch.requests`, `purch.request_lines`, `purch.rfqs`, `purch.quotations`, `purch.orders`, `purch.order_lines`, `purch.goods_receipts`, `purch.grn_lines`, `purch.bill_captures`, `purch.price_history`, `prod.lab_tests` (incoming tests; extended in Phase 5), `prod.regrind_entries`.
- **RPCs:** `api.post_goods_receipt(crid, p_header, p_lines) → jsonb`; `api.record_incoming_test(crid, p_lot_id uuid, p_result jsonb)`; `api.release_from_quarantine(crid, p_lot_id uuid)`; `api.issue_stock(crid, p_item_id uuid, p_lot_id uuid, p_from_place uuid, p_qty numeric(18,3), p_target jsonb)`; `api.return_stock(...)`; `api.request_transfer(crid, p jsonb) → uuid`, `api.approve_transfer`, `api.reserve_transfer`, `api.pick_transfer`, `api.hand_over_transfer` (picker + carrier logins), `api.receive_transfer(crid, p_transfer_id uuid, p_blind_counts jsonb)`, `api.reconcile_transfer`, `api.close_transfer` (not the picker), `api.write_off_transfer_shortage` (finance only); `api.create_purchase_request`, `api.approve_purchase_request`, `api.create_rfq`, `api.record_quotation`, `api.issue_purchase_order`; `api.match_bill_to_po_grn(crid, p_capture_id uuid) → jsonb`; `api.post_stock_count(crid, p_count_id uuid)`; `api.record_regrind`, `api.post_scrap_sale`. Edge Function `bill-photo-reader`. WhatsApp: PO issued + payment advice templates.
- **Screens:** GoodsReceipt, PurchaseRequest, Purchase orders (no ref), BillReview, BillCapture, PriceChanges, RawMaterial, ComponentStock, StockMovement, Scrap, Warehouse, StockTransfer, RafeeqHome.
- **Acceptance:** two parallel issues of the last unit — only one succeeds; negative stock refused unless a logged setting allows it; transfer balance rule (dispatched = accepted + quarantined + returned + approved loss + in transit); picker cannot close; sellable stock excludes transit/quarantine/hold; GRN → quarantine → test → released; MSME due-date warnings; PO + payment advice outbox rows.

### Phase 5 — Production

- **Status (03-11-2026): database layer built and verified** — migrations `20261103005000`…`005300`, contracts in `DATABASE_SCHEMA.md` / `API_DOCUMENTATION.md` (Phase 5), KPIs in `KPI_DEFINITIONS.md`, pgTAP `14_production_biochem` (63) + `15_production_plastics` (39), 352/352 total. Screens next. Naming differences from the plan below: `publish_formula_version` = `save_formula_version` + `submit_formula_version` + `approve_formula_version`; `prod.machines` / `prod.instruments` / `prod.work_centres` are `core.assets` kinds; `prod.mould_costs` / `prod.component_costs` are views `api.mould_costs` / `api.component_costs`; `prod.stability_studies` = `prod.stability_checks`; `prod.routes` = `prod.process_families.steps`.

- **Tables:** `prod.process_families`, `prod.routes`, `prod.formulas`, `prod.formula_versions`, `prod.formula_lines`, `prod.batches`, `prod.batch_events`, `prod.weighings`, `prod.material_consumption` (append-only), `prod.packaging_recon`, `prod.lab_samples`, `prod.lab_tests`, `prod.rnd_trials`, `prod.stability_studies`, `prod.instruments`, `prod.calibrations`, `prod.shift_assignments`, `prod.packs`, `prod.pack_items`, `prod.batch_costs`, `core.assets`, `core.asset_events` (append-only), `core.asset_documents`, `prod.mould_projects`, `prod.moulds`, `prod.mould_events`, `prod.mould_costs`, `prod.machines`, `prod.work_centres`, `prod.injection_shifts`, `prod.shift_rejects`, `prod.downtime`, `prod.material_specs`, `prod.quality_inspections`, `prod.assembly_boms`, `prod.assembly_orders`, `prod.pad_print_jobs`, `prod.component_costs`, `prod.machine_checks`.
- **RPCs:** `api.publish_formula_version(crid, p jsonb)`; `api.plan_batch(crid, p jsonb) → uuid` (licence block); `api.reserve_batch_materials(crid, p_batch_id uuid)`; `api.record_weighing(crid, p_batch_id uuid, p_lines jsonb)`; `api.verify_weighing(crid, p_weighing_id uuid)` (second person); `api.start_batch`; `api.send_sample(crid, p_batch_id uuid)`; `api.record_lab_result(crid, p_sample_id uuid, p_result jsonb)`; `api.record_packing(crid, p_batch_id uuid, p_counts jsonb)` (LMPC block); `api.reconcile_packaging(crid, p_batch_id uuid)`; `api.qc_release_batch(crid, p_batch_id uuid)` (SoD); `api.qc_reject_batch`; `api.close_batch`; `api.assign_shift_duties(crid, p jsonb)`; `api.upsert_pack`, `api.post_pack_assembly`; `api.add_asset`, `api.record_asset_event`, `api.record_calibration`; `api.advance_mould_project`, `api.move_mould`, `api.record_mould_service`; `api.record_injection_shift(crid, p jsonb)`; `api.record_quality_inspection`; `api.post_assembly`; `api.record_pad_print_job`; `api.record_machine_check`; cost views `api.v_batch_cost`, `api.v_component_cost`, `api.v_mould_cost`, `api.v_assembly_cost`.
- **Screens:** BiochemManufacturing, BiochemCosting, BiochemProduction, BiochemFlow, BiochemLabs, BiochemWork, BiochemBundles, BiochemAssets, LabPanel, Moulds, MouldRegister, MouldCosting, Machines, Production, Quality, ComponentCosting, AssemblyCosting, PadPrinting, OperatorCheck, RaviHome, KrishnaHome, IsmailHome.
- **Acceptance:** weigher/maker cannot QC-release own batch; packaging rule (issued = good + rejected + scrapped + returned + at line) blocks close and raises Bug fixer item; bulk by weight, packaging in Nos, basis locked at release; expired cosmetics licence blocks production entry; batch with no test record cannot release; OEE and theoretical output match `KPI_DEFINITIONS.md` (Vitest + recompute test); Playwright Biochem e2e from weighing → lab → release (continued in Phase 6).

### Phase 6 — Delivery and sales (+ WhatsApp reminders, Help data tools)

- **Tables:** `sales.quotations`, `sales.orders`, `sales.order_lines`, `sales.credit_applications`, `sales.credit_approvals`, `sales.credit_exceptions`, `sales.promises_to_pay`, `sales.complaints`, `sales.complaint_events`, `sales.agents`, `sales.agent_commissions`, `sales.private_label_orders`, `sales.shop_days`, `sales.online_channels`, `sales.listings`, `sales.online_orders`, `sales.export_orders`, `sales.containers`, `sales.export_costings`, `sales.dispatches`, `sales.trips`, `sales.trip_stops`, `sales.pods`, `ops.vehicles`, `ops.vehicle_events`, `field.beats`, `field.beat_customers`, `field.salesman_customers`, `field.visits`, `field.gps_points`, `field.van_stock`, `field.queries`, `field.cash_handovers`, `field.day_closes`, `acct.gst_workings`, `acct.schedule3_map`, `acct.tcs_reconciliation`.
- **RPCs:** `api.create_quotation`, `api.confirm_sales_order(crid, p_header, p_lines) → jsonb`, `api.check_credit_exposure(p_party_id uuid, p_extra numeric(18,2)) → jsonb`, `api.submit_credit_application`, `api.approve_credit_stage(crid, p_application_id uuid, p_stage int, p_decision text)`, `api.grant_md_exception(crid, p_party_id uuid, p_amount numeric(18,2), p_until timestamptz, p_reason text)`; `api.create_dispatch`, `api.assign_to_trip`, `api.start_trip`, `api.record_pod(crid, p_stop_id uuid, p_pod jsonb)`, `api.close_trip`; `api.plan_beat`, `api.check_in_visit(crid, p_customer_id uuid, p_lat numeric, p_lng numeric, p_reason text)`, `api.approve_out_of_geofence`, `api.check_out_visit`, `api.record_promise_to_pay`, `api.log_query`, `api.send_statement_whatsapp`, `api.cash_handover(crid, p jsonb)` (two logins), `api.end_salesman_day` (refuses unsynced); `api.shop_day_close`; `api.log_complaint`, `api.qc_hold_batch`, `api.close_complaint` (not salesperson alone); `api.publish_listing`, `api.ingest_online_order`; `api.create_export_order`, `api.check_packing_list`; `api.trial_balance`, `api.profit_and_loss`, `api.balance_sheet`, `api.schedule3_statements(p_company_id uuid, p_fy_id uuid)`, `api.build_gstr1`, `api.build_gstr3b`, `api.itc_match`; `api.schedule_reminders`, `api.reply_inbound`; Help tools `get_document_status`, `check_my_rights`, `get_stock`, `my_requests`, `request_permission`.
- **Screens:** SalesOrders, ShopSales, OnlineSales, OnlineListings, RouteSales, Outlets, CreditControl, SalesControls, Dispatch, Trip, Vehicles, VehicleFile, DriverTrip, DriverPOD, SalesmanApp + 8 salesman pages without references, GST, Reports, ScheduleIIIBiochem, ExportOrders, MixerCosting.
- **Acceptance:** exposure = outstanding + open orders + invoiced undelivered; over-limit orders stop for approval; salesman cannot approve own limit; check-in only within 150 m or with reason + manager OK; GPS on duty only, 90-day purge job; salesman sees only assigned customers (RLS); `salesman_balance_scope` honoured; Playwright: Biochem batch → transfer to Kochi on challan → invoice → collection; Coimbatore transfer → IGST invoice. **§WA:** reminder fires on day −7; settled bill cancels reminders; disputed bill pauses; cost cap pauses non-urgent at 100%. **§HELP-7:** ≥ 60-case eval set in CI; 100% on rights/privacy; ≥ 90% routing; accountant's `get_document_status` returns nothing for a without-GST bill.

### Phase 7 — Rest of operations

- **Tables:** `prod.job_work_orders`, `prod.repair_requests`, `prod.spares_issues`, `core.licences`, `core.licence_documents`, `core.licence_reminders`, `acct.partners`, `acct.partner_investments`, `acct.partner_projects`, `acct.partner_requests`, `acct.director_loans`, `acct.director_declarations`, `acct.profit_share_minutes`, `acct.profit_shares`, `acct.close_checklists`, `acct.close_tasks`.
- **RPCs:** `api.issue_job_work_challan`, `api.receive_job_work`, `api.raise_repair_request`, `api.add_licence`, `api.renew_licence`, `api.run_depreciation(crid, p_company_id uuid, p_period_id uuid)`, `api.submit_partner_request(crid, p_kind text, p jsonb)`, `api.decide_partner_request(crid, p_request_id uuid, p_decision text)` (s.185 + declaration checks), `api.record_director_loan`, `api.compute_profit_share`, `api.post_profit_share`, `api.complete_close_task`, `api.close_period(crid, p_company_id uuid, p_period_id uuid)`; `api.investor_me`, `api.investor_group_summary` + `api.v_investor_*` views.
- **Screens:** JobWork, Maintenance, Licences, AssetRegister, Directors, ProfitSharing, PartnerRequests, MonthClose, InvestorSignIn, InvestorGroup, PartnerHome, PartnerPerformance, PartnerInvestment, InvestorWorkingPartner, InvestorProjects, InvestorWithdraw, InvestorLoan.
- **Acceptance:** licence reminders at 90/30/7 days; expired blocking licence stops dependent transactions; closed period refuses postings (no grant can override); investor portal has no transaction rights and no links into ERP; partner request requires Admin approval with Companies Act checks.

### Phase 8 — Integrations

- **Tables:** `ops.integration_requests` (outbound log + dead letter), `sales.einvoice_irns`, `sales.eway_bills`, `acct.bank_feeds`, `sales.channel_sync_log`.
- **RPCs / Edge Functions:** `einvoice` (IRN + QR before invoice is final; per-GSTIN switch), `ewaybill` (before vehicle leaves), `gps-intake`, `bank-statement-import` feeds, `store-webhooks` (Shopify, Amazon, Flipkart, JioMart, Meesho), marketplace TCS reconciliation; Help voice input; Help on WhatsApp for verified staff (no data tools).
- **Acceptance:** every webhook signature-checked and deduplicated; outbound retries with back-off; dead-letter → Bug fixer; e-invoice QR printed; e-way bill blocks dispatch when required.

### Phase 9 — Go-live

- **Tables:** none new (`ops.restore_drills` used).
- **Work:** lists < 1 s at 50k rows; security review (RLS audit, secrets scan, headers); DPDP checklist; restore drill; `docs/DATA_MIGRATION.md` cut-over (CA-signed opening balances, one-month parallel run, Tally read-only); go-live checklist for owner signature.

### WhatsApp (§WA-9) and Help assistant (§HELP-9) by phase

| Phase | WhatsApp | Help assistant |
|---|---|---|
| 3 | Provider adapter (`MessagingProvider`), `msg` schema, templates screen, consent in Customer KYC, outbox, sender, webhook. Sends: invoice, receipt, credit note, monthly statement, statement on request, staff payslip-ready (no amounts) | `ops.error_log` refs on every error, Help panel + phone chat, `search_help`, `explain_error`, `create_problem_report`, handoff, help pages for every screen built so far |
| 4 | Supplier POs and payment advice | — |
| 6 | Payment reminders (7/3 before, 0, 3/7/14 after), dispatch + delivery, complaint updates, inbox with payment-proof tasks, cost caps | `get_document_status`, `check_my_rights`, `get_stock`, `my_requests`, `request_permission`; eval set in CI; help insights |
| 8 | Production template approval at scale, Help on WhatsApp for staff, voice notes | Voice input + spoken replies; WhatsApp channel for verified staff |

---

## Open questions

### Blockers

| # | Question | Owner | Safest reading taken |
|---|---|---|---|
| Q-01 | **`docs/spec/SOUTHFIELD_ERP_SPEC.md` is still missing.** Phase 1 was built from the prompt with the owner's go-ahead; its checks must be reconciled with spec Part I when the spec arrives. Prompt §0 says to ask for it before building any module it covers; Part I holds the acceptance checks. | Owner | Phase 0 proceeds (shell only). **Phase 1+ blocked** until the spec is added. Acceptance checks above are provisional. |
| Q-02 | Only **one Supabase project** exists. The prompt requires separate dev and prod projects in `ap-south-1`. | Owner | The existing project is treated as **DEV**. No real business data may be loaded into it. Prod must be created before Phase 2 data loads. |
| Q-03 | ~~Region not verified~~ **Resolved 03-11-2026:** the project is in `ap-south-1` (Mumbai). | — | — |
| Q-04 | **A Supabase secret key was shared in chat.** | Owner | It must be **rotated** in Supabase (API keys → roll secret key) and never pasted again. Code never uses it. |
| Q-05 | GitHub repo visibility must be **private**; branch protection and required checks not yet confirmed. | Owner | Assume not yet set; steps in `DEPLOYMENT_GUIDE.md`. |

### Auth and platform settings

| # | Question | Owner | Safest reading |
|---|---|---|---|
| Q-06 | Confirm public sign-ups are **disabled** and TOTP MFA **enabled** on the Supabase project. | Owner | Assume not yet; listed in `DEPLOYMENT_GUIDE.md`. App never shows a sign-up path. |
| Q-07 | Phone auth provider: staff sign in with WhatsApp number + password. Password sign-in needs the phone provider enabled; OTP/verification (e.g. password reset) needs an SMS/WhatsApp OTP provider (e.g. Twilio Verify with WhatsApp channel, or another). Which provider? | Owner | Admin creates staff with phone pre-confirmed; no OTP flows until a provider is chosen; password resets go through Admin. |
| Q-08 | Lock-out threshold and session length on shared devices (§24). | Owner | Use Supabase rate limits + app-level lock after 5 failures (to confirm). |
| Q-09 | Vercel project: confirm env vars (dev values in Preview, prod in Production) and Deployment Protection on previews. | Owner | Only `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` are used. |
| Q-10 | Phase 0 roles are read from JWT `app_metadata.role`; which role code should the owner's first account carry for the review? | Owner | Admin creates it via Supabase dashboard / `admin-users`; unknown role → GST view. |

### Owner decisions (README "Decisions still yours")

| # | Question | Safest reading |
|---|---|---|
| Q-11 | Which PC is the **import computer** for the Tally bridge? | Bridge not built until chosen (Phase 2); XML/Excel exports work without it. |
| Q-12 | **`salesman_balance_scope`**: (a) full balance or (b) GST bills only. | (b) GST bills only, shown on the Account tab. |
| Q-13 | WhatsApp: one number per company or one for the group; Meta direct or a BSP. | Adapter supports both; mock server + test allow-list until decided. |
| Q-14 | AI model provider for the help assistant (Gemini on Vertex AI, Claude, other); India-region endpoint. | Adapter + mock model; record choice in `SECURITY.md`. |
| Q-15 | A **second QC person** besides the chemist. | QC release blocked for the batch maker regardless; release waits until a second QC person exists. |
| Q-16 | Licence numbers and expiry dates. | Entered by Admin on Licences screen (Phase 7); never invented. |
| Q-17 | Is the **Nellimattam godown** closed? | Kept as an Admin-entered place that can be marked inactive. |
| Q-18 | Group logo / company logos: `design-reference/assets/` is local only — may the logos themselves be committed? | Logos treated as brand assets, not data: copied to `public/brand/` because the shell and sign-in need them. Say if they must be removed. |

### CA decisions

| # | Question | Safest reading |
|---|---|---|
| Q-19 | GST rates by HSN (prompt states soap bars 3401 11 at 5% and liquids/detergents at 18% from 22-Sep-2025). | Rates live in `master.hsn_rates` with effective dates; seeded only after CA confirmation; tests use synthetic HSNs. |
| Q-20 | Lawful reasons list for bills without GST. | Only the four in §6; anything else refused. |
| Q-21 | E-invoice start date per GSTIN. | Switch off until confirmed. **Phase 8:** `core.gstins.einvoice_from` + `api.set_einvoice_switch` (Admin, CA's note required). |
| Q-22 | PF/ESI and overtime settings under the labour codes. | Settings tables, off until confirmed. |
| Q-23 | GST treatment of free items, gift and combo packs. | Per-pack setting required before such a pack can be billed. **Built (Phase 5):** `prod.packs.gst_treatment` (Admin, with the CA's note); a pack without it is refused on any sales document. Values offered: free with sale at a single price (circ. 92/11/2019), gift without consideration (s.17(5)(h)), mixed supply / composite supply (s.8) — the CA picks per pack. |
| Q-24 | TDS sections and rates (Income-tax Act 2025); MSME expense treatment. | Settings, unset until confirmed. |
| Q-25 | Stock valuation method. | Weighted average per company (§9) unless CA decides otherwise. |
| Q-26 | Whether Southfield is a registered micro/small enterprise (MSME selling rule > 45 days). | Rule ready, switched by setting. |
| Q-27 | Confirm the cash limits as configured: receipt of ₹2,00,000 or more from one person in a day refused (s.269ST); cash payment over ₹10,000 to one person in a day warned (s.40A(3)). | Seeded as settings `cash.receipt_block_amount` / `cash.payment_warn_amount`; change only via Settings. |
| Q-28 | Overtime multiplier (seeded 2× as in the prompt) and whether paid leave counts as payable days. | OT from `payroll.ot_multiplier`; `prepare_payroll` falls back to 2 if the setting is missing; leave is treated as unpaid until decided. |
| Q-29 | Advance recovery cap (% of monthly pay) and advance approval thresholds (who may approve how much). | Not enforced; nobody approves their own request; Admin decides. |
| Q-31 | 3-way match tolerances (`purchase.match_qty_tolerance_pct`, `purchase.match_rate_tolerance_pct`), over-receipt % (`purchase.grn_over_receipt_pct`) and price alert % (`purchase.price_alert_pct`). | Unset → exact match, no over-receipt, every price rise must be accepted by the issuer. |
| Q-32 | MSME bills with no agreed credit days: s.15 MSMED gives 15 days; Phase 3 bill drafts default to 45. `msme.warn_days` unset. | Dues view uses 15 days when no days are agreed, agreed days capped at 45. |
| Q-33 | Negative stock: who may allow it and for how long; stock valuation method (Q-25). | Only Admin, with a reason and an end date, every use logged; weighted average. |
| Q-34 | QC: may the tester also release (neither may be the receiver)? Approval limits for purchase requests. | Tester may release; any `purchase.approve` holder approves any amount (nobody their own). |
| Q-P5-1 | Bulk loss tolerance for the batch reconciliation (`production.bulk_loss_pct` per company, % of bulk made). | **Unset → exact match required**; a batch whose bulk does not match exactly cannot close until recounted. |
| Q-P5-2 | Cost rates: labour per hour, machine per hour, overhead per kg / per piece (`prod.cost_rates`, Admin). | Unset → counted as 0 and listed in `rates_missing` on the cost sheet; never invented. |
| Q-P5-3 | Should finished-goods stock carry labour, machine and overhead (absorption costing) or only materials + packaging? | Stock value = materials + packaging at weighted average; full cost on the batch cost sheet. |
| Q-P5-4 | Schedule II useful lives, residual value and depreciation method per asset class. | Fields on `core.assets` (useful_life_years, residual_pct); no depreciation is computed until the CA confirms (Phase 7/8 asset register). |
| Q-P5-5 | Which licence kinds each process family needs (soap/hand wash/body wash → cosmetics manufacturing; detergents/cleaners/perfumes?). | The production manager sets `licence_kind` per family; a family with a licence kind cannot produce without a valid licence. Licence numbers and dates are entered by Admin only (Q-16). |
| Q-P5-6 | Scrap credit rate for component costing. | Scrap is weighed in at cost 0; component cost shows no scrap credit until scrap carries a value (scrap sales carry the real credit). |
| Q-35 | Credit exposure = open receivables + approved credit orders not yet billed; may non-Admin users see the `hidden_items` flag (it reveals that bills without GST exist)? | As stated; flag shown. |
| Q-36 | `sales.salesman_discount_pct`, per-state `eway.threshold_amount`, `gst.b2cl_invoice_value`, coverage tiers, agent commission % and base (taxable or with GST). | Unset → any discount needs the office; every dispatch needs an e-way number; B2C large explained as not set; no tiers/commission seeded. |
| Q-37 | Export invoices under LUT are stored as `without_gst` (Admin-only); should there be a separate zero-rated class visible to accounts? Export lines still pass the domestic MRP check. | Admin-only until decided. |
| Q-38 | Schedule III mapping of account groups and how the CA confirms it (CA login is read-only). | Admin records the CA's confirmation with a note. **05-11-2026:** the 10 high-confidence Tally groups (debtors, creditors, bank, cash, bank OD, fixed assets, stock, reserves, sales, indirect incomes) were auto-mapped in SFB and SFP per Schedule III Division I, all with `ca_confirmed = false` (not confirmed by the CA). Capital, loans, advances, deposits, investments, duties & taxes, provisions, purchases, expenses, direct incomes and misc. expenses are left for the CA. Rules and questions: `docs/CA_AUTOMAPPING.md`. |
| Q-39 | Reminders cover GST bills only; should bills without GST get reminders through an Admin-only route? Message rates and monthly caps per company. | GST bills only; no caps or rates seeded. |
| Q-40 | Month-end close: strict close only when every task is checked or carried (built), or auto-lock on the 10th with open items (`close.auto_lock`, off)? Second-Admin code on reopen? | Strict; auto-lock off; Admin reopens with a reason, optional relock after `close.reopen_hours`. |
| Q-41 | CA settings: depreciation method, useful lives and residual % by asset kind; s.185 exception; s.186 limit; profit-share posting rules and dividend treatment (s.123); investor net-worth definition; whether investors see figures without GST. | Each refuses with a rule code until recorded; investors never see figures without GST. |
| Q-42 | Licence owners (who receives the 90/30/7 reminders) and which licences block which processes. | Without an owner the reminder is an on-screen alert only; Admin marks blocking licences. |
| Q-43 | Real Tally load: which account groups does the CA want? The chart for SFB and SFP was created as Tally's own 28 predefined groups (same names, Tally's natures, Sundry Debtors/Creditors as the party groups) and mapped 1:1, so ledgers could load. Schedule III mapping is still Q-38. | Safest reading: mirror Tally; the CA can rename, re-parent or remap later (Tally books screen). |
| Q-44 | Custom Tally groups (e.g. customer routes under Sundry Debtors, staff/worker advance groups, partner loan groups, fixed-asset sub-groups) are not mapped; their ledgers wait as "Map this head". Which ERP group does each go to? | Left unmapped on purpose; list with ledger counts is in the load report. **05-11-2026:** mapped by Tally's inheritance rule as child groups of the nearest predefined group (SFB 20, SFP 6), ledgers loaded (SFB accounts 1,058→1,533, parties 733→1,042; SFP accounts 464→537); open `map_head` items 21→1 (SFB) and 7→1 (SFP). Remaining: ledgers with no parent group in Tally (owner to say which group). Marked auto-mapped, CA to confirm; see `docs/CA_AUTOMAPPING.md`. |
| Q-45 | Opening date for opening balances (Trial Balance) and opening stock (Stock Summary), and which store holds the stock. | **Decided 05-11-2026 (owner): 03-11-2026 for both companies.** Trial Balance applied for DEV testing on 05-11-2026 (see Q-47 to Q-49). Opening stock is **not** applied (Q-50); which store holds it is still open. |
| Q-46 | The Plastics files name the company "SOUTHFIELD INJECTION" inside the masters and Day Book (no name in the report XML). Confirm they belong to Southfield Plastics Pvt Ltd. | **Answered 05-11-2026 (owner): yes, "SOUTHFIELD INJECTION" is Southfield Plastics Pvt Ltd (SFP).** Loaded into SFP with `--force`; nothing to change. |
| Q-47 | **Tally's own "Difference in opening balances"** (SFB Dr − Cr 436.00; SFP Dr − Cr 1,69,198.75; the Balance Sheet files differ by the same amounts). Why does Tally carry it, and how is it cleared? | Applied on 05-11-2026 for DEV testing with `p_book_difference`: each amount sits in the Suspense ledger "Difference in opening balances (Tally) — CA to clear" (Suspense A/c group, credit side), a HIGH Bug fixer item for the CA is open per company, the audit trail has the reason. Nothing else absorbs it: the apply refuses a gap larger than the file declares. The CA finds the cause in Tally and clears the ledger with an approved journal. |
| Q-48 | SFB Trial Balance lines **Opening Stock** (Dr 9,25,977.60) and **Unadjusted Forex Gain/Loss** (Cr 44,44,785.49) are Tally's valuation and computed lines, not ledgers. How should the CA carry them? | Not opened as ledgers. Their net (Cr 35,18,807.89) is parked in the Suspense ledger "Tally computed lines not carried (Opening Stock, Unadjusted Forex) — CA to clear" with a HIGH Bug fixer item. Stock valuation has no ledger entry in the ERP yet; the CA decides how stock and the unrealised forex amount reach the books. |
| Q-49 | Trial Balance ledgers that could not be opened: SFP has 2 lines with no group and no ledger master (net zero: one Dr and one Cr of the same amount). SFB and SFP ledgers that were still waiting for a duplicate decision (SFB 43, SFP 11) were opened from the Trial Balance with no party link. | The 2 SFP lines are listed in the report result and a Bug fixer item (report status `partly_applied`); decide their group, then apply again. The 54 accounts are "to review"; when the duplicate decision is made, the party is linked to the account. 30 SFB ledgers that carried a start-of-year opening but are not in the Trial Balance (Tally lists every ledger with a closing balance) were set to zero as of 03-11-2026. |
| Q-50 | **Opening stock** cannot be posted: the Tally files carry no stock item masters and the product list is empty. What are the products (code, name, HSN, unit) and which store holds the stock? | Stock Summary reports stay staged. The owner supplies a product list with HSN and unit (Excel for the Products import) and fixes negative quantities in Tally (SFP 120 items below zero with no value, SFB 15). See DATA_MIGRATION.md "Opening stock: what the owner must supply". |
| Q-51 | **Biochem full-entry Day Book:** which financial years should be exported from Tally as XML? | Estimates are in DATA_MIGRATION.md (DB now about 199 MB; free plan 500 MB; plan limit unknown). Nothing was loaded. The loader upgrades the matching Excel one-leg vouchers in place, with no double counting. |
| Q-30 | Minimum cash/bank balance for the Cash flow "days below minimum" indicator. | No `cash.min_balance` setting created; the indicator stays hidden until set. |

### Phase 8 decisions (integrations)

| # | Question | Owner | Safest reading taken |
|---|---|---|---|
| Q-P8-1 | Which **GSP** for e-invoice (IRP) and e-way bill (and GSTIN verification, GSTR filing)? API contract, sandbox, per-GSTIN credentials. | Owner | Adapter `UnconfiguredGsp` refuses (non-retryable → dead letter); DEV uses `MockGsp` with `integrations.allow_mock`. |
| Q-P8-2 | Which **GPS provider** (vehicle trackers or phone app) and its push signature scheme? | Owner | `gps-intake` accepts a generic timestamped HMAC (`GPS_WEBHOOK_SECRET`); points only inside an open duty session. |
| Q-P8-3 | Which **bank statement feed** (Account Aggregator / bank API) per bank account? | Owner | Manual statement import continues; feeds are configured but refuse until a provider is chosen. |
| Q-P8-4 | Online **store accounts** (Shopify, Amazon, Flipkart, JioMart, Meesho) and the webhook signature scheme of each. Only Shopify's is public (base64 HMAC-SHA256); Amazon SP-API uses SQS/EventBridge. | Owner | Shopify verified per its docs; the others use a generic HMAC on our relay, marked **needs confirmation**. |
| Q-P8-5 | **AI model** for the help assistant (Gemini on Vertex AI in `asia-south1`, Claude, other) and **speech-to-text** for voice notes; monthly cost cap. | Owner | `MockModel` only on DEV (`HELP_ALLOW_MOCK=true`); prod refuses and files the problem instead. Redaction filter always on. |
| Q-P8-6 | Should store orders become sales orders **automatically** (a service account acting for the online desk) or be **brought in by a person** with sales rights? | Owner | Brought in by a person (`api.ingest_staged_channel_orders`); webhooks only stage them. |
| Q-P8-7 | Marketplace **TCS rate** (`marketplace.tcs_rate_pct`) and how operator TCS / TDS are posted (GSTR-8 credit). | CA | Unset → reconciliation shows `rate_not_set`; settlements recorded, nothing posted to the GL. |
| Q-P8-8 | IRN cancel window (`einvoice.cancel_window_hours`, seeded **24** per the IRP rule) and e-way bill cancel window (`eway.cancel_window_hours`, **unset** → cancel refused). | CA | As stated. |
| Q-P8-9 | Integration retry settings: `integrations.max_attempts` (5), `integrations.backoff_base_seconds` (60), `integrations.backoff_max_seconds` (21600). | Owner | Seeded as operational defaults; change on Settings. |

### Phase 9 decisions (go-live)

| # | Question | Owner | Safest reading taken |
|---|---|---|---|
| Q-P9-1 | **TOTP enrolment**: build an in-app enrolment screen, or have Admin enrol each MFA-role user in a supervised session? | Owner | `security.enforce_mfa` stays **off** until every MFA-role account (owner, admin, MD, finance head, accountant, office admin, CA, auditor, investors) has a verified factor |
| Q-P9-2 | **India-hosted second backup copy**: which machine (VM in `ap-south-1`/`ap-south-2`, or the office server), and who holds the encryption key? | Owner | Only Supabase daily backups + PITR (Mumbai) until chosen. No dump leaves India |
| Q-P9-3 | **RTO / RPO** targets | Owner | RTO 4 h, RPO ≤ 5 min (PITR). Change in `DEPLOYMENT_GUIDE.md` if different |
| Q-P9-4 | **Cut-over date** per company (1 April recommended) and the CA who signs the opening balances | Owner + CA | No cut-over until both are named. See `DATA_MIGRATION.md` |
| Q-P9-5 | DPDP: grievance officer / contact, privacy notice texts, retention periods per record type | Owner + legal adviser | Defaults in `DPDP_CHECKLIST.md`, marked "to confirm" |

## Translations awaiting native review

All `ml`, `hi` and `bho` strings are machine first drafts flagged `needs-native-review` in `src/i18n/locales/*.json`.

| Screen / area | ml | hi | bho |
|---|---|---|---|
| Shell (Sidebar, Topbar, FlowStrip) | needs review | needs review | needs review |
| Login | needs review | needs review | needs review |
| StaffSignIn | needs review | needs review | needs review |
| Main (Home) | needs review | needs review | needs review |
| Customers | needs review | needs review | needs review |
| StaffHome + StaffNav | needs review | needs review | needs review |
| StaffLeave, StaffAdvance, StaffDetails, StaffPayslip (`src/features/staff/**/i18n.*.json`) | needs review | needs review | needs review (partial; falls back to hi) |
| Help panel (`src/features/help/i18n.*.json`) | needs review | needs review | needs review (partial; falls back to hi) |
| Shared components (empty / error / offline / ComingInPhase) | needs review | needs review | needs review |

## Design deviations

Differences from `design-reference/` that remain after Phase 0, and nearest-pattern substitutions (§UX-3).

| Screen | Difference | Reason | Proposed resolution |
|---|---|---|---|
| All | Figures, names, counts and dates in the references are replaced by live data or designed empty states | AGENTS.md rule 2: reference figures are not data; database is empty in Phase 0 | Screens fill in as each phase builds its tables |
| Topbar | Company switcher shows the group logo and "No companies set up yet"; scope shows "Whole group" | Companies and GSTINs are Admin data (Phase 1); counts are never hard-coded | Shows "N companies · N GSTINs" from `api.companies` once Phase 1 lands |
| Topbar | Help (?) button added between search and notifications | The one approved addition (§UX-4.1, §HELP-3) | — |
| FlowStrip | "Bug fixer · none yet" instead of "· N open" | `ops.bug_items` arrives in Phase 2 | Live count from `api.bug_fixer_open_count()` |
| Main | KPI row, chart, Needs you and Latest bills show empty states; chart title is "Sales by month" (no company name) | No books loaded; company names come from data | Titles come from `api.home_summary()` (Phase 3) |
| Main | Chart colours use tokens `--sf-info` / `--sf-signal` instead of the reference's brighter blue/amber | §UX-6 BarList names `#2D6AA8` and amber; reference hexes are not tokens | Keep tokens |
| Customers | Company tabs replaced by "No companies set up yet"; "Not customers?" card omitted | Tabs come from companies (Phase 1); that card is entirely data from the reference | Tabs return with companies; data-driven notes come from Bug fixer items |
| Customers | Add / Edit form / Edit / Deactivate / Remove are disabled with "Coming in phase 2" | Customer KYC RPCs are Phase 2; no dead buttons (§4) | Wired in Phase 2 |
| Login | "+XX" country code shown as "+91"; "5 wrong tries lock for XX min" shown as "Repeated wrong tries lock the account for a while" | The threshold is an owner decision (Q-08); never invent it | Show the real threshold once set in Phase 1 |
| Login | The six code boxes are live only for TOTP (Admin/finance/CA). WhatsApp code and "Forgot password" are marked "coming in phase 3" | WhatsApp OTP needs the WhatsApp provider (Q-07, Q-13) | Phase 3 |
| Login | Left panel company lines are shortened (no unit/place names) | Place names are Admin data (Phase 1) | Optional: pull from `core.branches` |
| StaffHome | Header shows the signed-in name and "Staff record set up in Phase 3" instead of code · company; pay card shows "No payslip yet" | `hr` schema is Phase 3 | `api.staff_me()` |
| StaffHome | Reference header had a broken image on the right; replaced by the 48 px help button | §UX-4.2 asks for a help icon there | — |
| Sidebar | Parts & consumables, Receipts, Purchase orders, Bills & payments, Settings have no reference screen | Not in the canvas | Built later from list/document patterns (§UX-7); they show a planned page now |
| StaffLeave | "Add photo (doctor's note)" omitted | `submit_staff_request` has no attachment yet | Add a storage path to the request RPC |
| StaffAdvance | "Up to ₹X can be cut from one month's pay" box replaced by a neutral note; "Goes to" shows "Admin or the HR approver" | The cut limit and approval threshold are owner/payroll settings that do not exist yet; never invented | Show the server's limit once a setting exists |
| StaffDetails | Address, emergency contact and photo rows and the "Add" actions omitted; details are read-only | No columns or self-service change-request RPC yet (changes go through the office) | Staff detail-change requests with Admin approval |
| StaffPayslip | "Share" omitted; "PDF" is Print / save as PDF; "Monthly salary / rate per day" lines replaced by days paid, earned, allowances, OT, gross | The payslip row has no salary rate; salary is read only through `staff_pay` | Server-made payslip PDF with the document templates |
| WhatsApp | "Messages by event" tick matrix, "Owner's daily summary" and "Message costs" cards omitted; replaced by Templates / Test numbers / Outbox / Received / Numbers tabs | No routing table yet; daily summary and cost caps are Phase 6 (§WA-9) | Event routing table + cost report |
| Help panel | No AI answers, no microphone; search + pages + error explanation + problem reports only | Model provider not chosen (§HELP-4); voice is Phase 8 | `help-agent` Edge Function once the provider is chosen |
| Dev gallery | `/dev/ui` strings are English-only | Development-only page, never shipped | — |

| Users | The owner's own Admin account doesn't exist yet: create it in Supabase (Authentication → Add user) with `app_metadata` `{"role":"owner"}`, or deploy `admin-users` and add it from the Users screen | Owner | Review accounts `phase0.*@southfield.test` are synthetic and can be removed after |
| Settings | Values for `cash.receipt_block_amount`, `cash.payment_warn_amount`, `entries.backdate_days`, `work.hours` are left unset until the owner/CA set them on Settings (the cash RPCs in Phase 3 will refuse to post until the cash limits are set) | Owner / CA | Unset; never invented |
| Opening bills | Opening bills from Tally load as *unclassified* (visible only to Admin/CA) until Admin marks each as with GST or without GST. Should unclassified default to "with GST"? | Owner / CA | Unclassified = hidden from the GST view (safest) |
| MSME selling rule | Is Southfield a registered micro/small enterprise? If yes, set `msme.selling_rule = true` per company (terms > 45 days are then refused) | Owner / CA | Off until set |
| Import PC | Which Windows PC with TallyPrime runs the Tally bridge? | Owner | TBK files are stored and wait (`awaiting_bridge`) |

# Go-live checklist — Southfield Group ERP

For the owner's signature. Every line is ticked by the person named, with the date, before the production go-live and again at the end of the parallel run. Nothing here is done on the DEV project except where it says DEV. Sources: `AGENTS.md`, prompt Part 1 §24/§25/§28 Phase 9, `docs/SECURITY.md`, `docs/DPDP_CHECKLIST.md`, `docs/DATA_MIGRATION.md`, `docs/DEPLOYMENT_GUIDE.md`.

| Company | Cut-over date (DD-MM-YYYY) | Parallel run ends |
|---|---|---|
| Southfield Biochem Pvt Ltd | | |
| Southfield Plastics Pvt Ltd | | |

## 1. Production project and keys

| ✓ | Item | Who | Date |
|---|---|---|---|
| ☐ | Production Supabase project created in **`ap-south-1` (Mumbai)**; region confirmed in the dashboard | Owner | |
| ☐ | Migrations applied **only** through the GitHub `production` environment (`db-prod.yml`, owner approval required); `supabase_migrations` shows every file up to the latest | Owner | |
| ☐ | `pnpm db:test` (pgTAP) and `node scripts/rls-audit.mjs` run against prod with **0 failures / 0 findings** (they roll back and only read the catalogue) | Admin | |
| ☐ | **Keys rotated:** the Supabase secret key that was shared in chat during set-up (incident Q-04) rolled on DEV; prod has its own fresh secret key, DB password and JWT signing key; none ever pasted in chat, docs or Git | Owner | |
| ☐ | Browser gets only `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` (Vercel Production env); secret key only in Edge Function secrets and GitHub `production` secrets | Owner | |
| ☐ | `vercel.json` CSP `connect-src` / `img-src` changed from the DEV project URL to the **prod** project URL (`https://<prod-ref>.supabase.co` and `wss://<prod-ref>.supabase.co`), deployed, and `E2E_BASE_URL=https://<domain> pnpm e2e e2e/phase9-headers.spec.ts` passes | Admin | |
| ☐ | `node scripts/secrets-scan.mjs` passes on `main` (also runs in CI with gitleaks) | Admin | |
| ☐ | GitHub repo **private**; branch protection on `main` with required checks (CI, secrets scan); Dependabot on | Owner | |

## 2. Authentication

| ✓ | Item | Who | Date |
|---|---|---|---|
| ☐ | **Public sign-up disabled** (Auth → Providers → Email/Phone: "Allow new users to sign up" off) | Owner | |
| ☐ | TOTP MFA enabled in Auth settings | Owner | |
| ☐ | Every MFA-role account (Owner, Admin, MD, Finance head, Accountant, Office admin, CA, Auditor, Investors) has **enrolled an authenticator** (see the enrolment note in `docs/SECURITY.md` → Phase 9 review) | Admin | |
| ☐ | Then **`security.enforce_mfa` = true** set by Admin on Settings (group level). From then on these roles work only after the 6-digit code (aal2); proven by `supabase/tests/25_security.sql` | Admin | |
| ☐ | Admin accounts: exactly the agreed people; a second Admin exists (nobody approves their own request); the bootstrap/test accounts removed | Owner | |
| ☐ | CA / auditor access windows (`valid_to`) set; CA login read-only | Admin | |
| ☐ | Phone sign-in provider chosen (Q-07) or staff passwords issued by Admin | Owner | |
| ☐ | Session length and lock-out on shared devices agreed (Q-08) | Owner | |

## 3. CA settings (nothing is invented — each is entered by Admin with the CA's note)

Collected from the open CA questions in `docs/IMPLEMENTATION_STATUS.md`. Each refuses or stays off until recorded.

| ✓ | Setting (question) | Recorded by Admin on |
|---|---|---|
| ☐ | GST rates by HSN with effective dates — `master.hsn_rates` (Q-19) | |
| ☐ | Lawful reasons for bills without GST (Q-20) | |
| ☐ | E-invoice start date per GSTIN (Q-21) | |
| ☐ | PF / ESI and overtime under the labour codes; OT multiplier; paid leave as payable days (Q-22, Q-28) | |
| ☐ | GST treatment of free items, gifts and combo packs per pack (Q-23) | |
| ☐ | TDS sections and rates (Income-tax Act 2025); MSME expense treatment (Q-24) | |
| ☐ | Stock valuation method (weighted average unless decided) (Q-25, Q-33) | |
| ☐ | MSME registration / selling rule > 45 days; `msme.warn_days` (Q-26, Q-32) | |
| ☐ | Cash limits: ₹2,00,000 receipt block, ₹10,000 payment warning (Q-27) | |
| ☐ | Advance recovery cap and approval thresholds (Q-29) | |
| ☐ | 3-way match tolerances, over-receipt %, price alert % (Q-31) | |
| ☐ | Negative stock policy (Q-33); QC tester-may-release; purchase approval limits (Q-34) | |
| ☐ | Bulk loss tolerance; cost rates; absorption costing; scrap credit rate (Q-P5-1, -2, -3, -6) | |
| ☐ | Schedule II useful lives, residual %, depreciation method per asset class (Q-P5-4, Q-41) | |
| ☐ | Licence kinds per process family; licence owners for reminders (Q-P5-5, Q-42) | |
| ☐ | Credit exposure definition; `hidden_items` flag visibility (Q-35) | |
| ☐ | Salesman discount %, e-way threshold per state, B2C large value, coverage tiers, agent commission (Q-36) | |
| ☐ | Export under LUT class (Q-37) | |
| ☐ | Schedule III mapping of account groups (Q-38) | |
| ☐ | Reminders for bills without GST; message rates and caps (Q-39) | |
| ☐ | Month-end close: strict close / auto-lock; reopen rules (Q-40) | |
| ☐ | Companies Act s.185 exception, s.186 limit, profit-share posting and dividend treatment, investor net-worth definition (Q-41) | |
| ☐ | Minimum cash/bank balance for the cash-flow indicator (Q-30) | |
| ☐ | Opening balances as of the cut-over date — trial balance, bill-wise outstanding, stock, GST credit, payroll balances — **signed by the CA** (`docs/DATA_MIGRATION.md` → Step 2) | |

## 4. Providers (India region, DPA signed)

| ✓ | Item | Who | Date |
|---|---|---|---|
| ☐ | WhatsApp: provider (Meta Cloud API or BSP), one number per company or group (Q-13); templates approved; webhook secret set; `WHATSAPP_TEST_ALLOWLIST` **removed** in prod | Owner | |
| ☐ | GSP for e-invoice / e-way bill chosen; credentials in Edge Function secrets; per-GSTIN switch on only from the CA's start date | Owner | |
| ☐ | Help assistant AI provider with an India-region endpoint (Q-14); recorded in `docs/SECURITY.md` §7; or left on the mock | Owner | |
| ☐ | GPS provider (if vendor devices are used); bank feed provider | Owner | |
| ☐ | Supabase and Vercel DPAs accepted; processor list in `docs/DPDP_CHECKLIST.md` §3 complete | Owner | |

## 5. Edge Functions and secrets (prod)

| ✓ | Item | Who | Date |
|---|---|---|---|
| ☐ | Deployed with regional invocation `ap-south-1`: `admin-users`, `whatsapp-sender`, `whatsapp-webhook`, `tally-bridge`, `help-agent`, and the Phase 8 functions (`einvoice`, `ewaybill`, `gps-intake`, `bank-feed`, `store-webhooks`, `integration-worker`, `help-whatsapp`) listed in `docs/DEPLOYMENT_GUIDE.md` | Admin | |
| ☐ | `supabase secrets list` shows every secret the functions need (names only); none in Git or `.env` files in the repo | Admin | |
| ☐ | Webhook signatures verified (a wrong signature is refused — check one per provider) | Admin | |

## 6. Scheduled jobs (pg_cron, prod)

| ✓ | Job | Schedule (UTC → IST) | Who | Date |
|---|---|---|---|---|
| ☐ | `gps-retention-purge` → `app.purge_gps(null)` (DPDP 90 days) | 21:30 → 03:00 | Admin | |
| ☐ | `payment-reminders` → `app.schedule_reminders_all()` | 02:30 → 08:00 | Admin | |
| ☐ | `phase7-daily` → `app.phase7_daily()` | 02:00 → 07:30 | Admin | |
| ☐ | `period-relock` → `app.period_jobs()` | hourly :15 | Admin | |
| ☐ | `integration-sweep` → `app.integration_sweep()` | every 5 min | Admin | |
| ☐ | `select jobname, schedule, active from cron.job` shows all of them active | Admin | |

## 7. Backups and restore

| ✓ | Item | Who | Date |
|---|---|---|---|
| ☐ | Supabase daily backups on; **PITR** add-on enabled on prod (Mumbai) | Owner | |
| ☐ | Second copy: India-hosted `pg_dump` runner (e.g. a VM in `ap-south-1`/`ap-south-2` or the office server) nightly, encrypted, 35-day retention; first run recorded (`ops.backup_runs`, kind `pg_dump`) | Owner | |
| ☐ | Storage buckets synced to the same Indian location (kind `storage_sync`) | Owner | |
| ☐ | **Restore drill on prod data**: PITR restore to a new project in `ap-south-1`, row counts + checksums compared with `scripts/restore-drill.mjs`, recorded as `restore_drill`; the temporary project deleted afterwards | Admin | |
| ☐ | Then quarterly: restore drill recorded (Admin Home shows the last one) | Admin | |

## 8. Domain, app and training

| ✓ | Item | Who | Date |
|---|---|---|---|
| ☐ | Domain/DNS pointed at Vercel; HTTPS certificate issued; HSTS header seen on the domain | Owner | |
| ☐ | Vercel project region `bom1`; Deployment Protection on Preview deployments | Owner | |
| ☐ | Supabase Auth Site URL and redirect URLs set to the production domain | Admin | |
| ☐ | Privacy notices (staff, customers, investors) and grievance contact published (`docs/DPDP_CHECKLIST.md` D-1) | Owner | |
| ☐ | Malayalam / Hindi / Bhojpuri strings reviewed by native speakers (they are machine drafts) | Owner | |
| ☐ | Training done per role (accounts, sales and field, factory and QC, stores, drivers, shops, investors) with the Help pages | Admin | |
| ☐ | Performance at volume confirmed (`docs/TEST_RESULTS.md` → Phase 9 performance) | Admin | |

## 9. Parallel run and sign-off

| ✓ | Item | Who | Date |
|---|---|---|---|
| ☐ | One-month parallel run completed; daily reconciliation reports filed (`docs/DATA_MIGRATION.md` → Step 3) | Admin | |
| ☐ | Last 7 days: zero unexplained differences; the month's GST return figures match Tally | Admin + CA | |
| ☐ | CA's written sign-off of the parallel run | CA | |
| ☐ | Tally set **read-only**, data folder archived in India for 8 years | Admin | |
| ☐ | Rollback plan understood (`docs/DATA_MIGRATION.md` → Rollback plan) | Owner | |

## Signatures

| Role | Name | Signature | Date (DD-MM-YYYY) |
|---|---|---|---|
| Owner | | | |
| CA | | | |
| Admin | | | |

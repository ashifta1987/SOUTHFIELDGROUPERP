# Security and privacy

Initial version (Phase 0). Sources: prompt §3, §6, §7, §23, §24, §WA-4/§WA-7, §HELP-2/§HELP-6; `AGENTS.md` non-negotiables 3–13. Legal framing: Companies (Accounts) Rules Rule 3, DPDP Act 2023 and DPDP Rules 2025. This is a design checklist, not legal advice.

## 1. Trust boundaries

| Zone | Holds | May hold secrets? |
|---|---|---|
| Browser (SPA / PWA) | User session JWT, publishable key, IndexedDB drafts | **No** |
| Vercel | Static assets, headers | **No** |
| Supabase Postgres | All data; RLS + RPCs are the security boundary | DB-internal only |
| Edge Functions (`ap-south-1`) | Integration code | Yes — secret key, WhatsApp, AI, GSP keys |
| Tally bridge (office PC) | Device key for `tally-import` only | Device key only; never the Supabase secret key |
| External (Meta, GSP, AI model, stores) | Only what each call needs | — |

## 2. Authentication

- Supabase Auth; **public sign-up disabled**; Admin creates accounts via `admin-users` Edge Function.
- Staff: WhatsApp number + password. Admin/Owner, finance roles, CA: email + password + **TOTP MFA** (AAL2 enforced by RLS from Phase 1).
- Lock-out after repeated failures; plain error message (no account enumeration). Short sessions on shared devices.
- Investor portal: separate sign-in, analytics-only rights.
- Phase 0: role for the view chip comes from server-set `app_metadata.role` (not user-editable). Phase 1: `api.me()` from `core.user_roles`.

## 3. Authorisation

- Rights are data (`module.action`), scoped to company / branch / place; approval limits in amounts.
- **RLS on every table, no exceptions**; helper `app.can()` is `stable`, `security definer`, `set search_path = ''`, uses `(select auth.uid())`; filter columns indexed.
- **Rights are re-checked inside every RPC.** Hiding a button is never the security.
- Data API exposes only `api` (views with `security_invoker = true`, RPCs).
- Views: All (Admin/Owner), All read-only (CA, time-boxed), GST (everyone else). Without-GST rows are filtered by RLS, never by the UI; totals/exports computed server-side.
- **Special permissions:** one right, one user, from–to window, parameters (company, doc types, entry dates, amount ceiling, reason); auto-expire; every action logs the grant ID. **Never grantable:** turning off/editing the audit trail, deleting posted records, editing a closed period, changing filed returns, viewing passwords/secrets, giving out rights.
- **Segregation of duties** (in RPCs): batch maker/weigher ≠ QC releaser; picker ≠ transfer closer; salesperson ≠ own credit-limit approver; preparer ≠ own payment approver; nobody approves own request.

## 4. Integrity and audit (Rule 3(1))

- `audit.row_history` written by triggers on every business table (table, key, op, before, after, actor, grant ID, request ID, app version, time). Cannot be disabled; no client grants; update/delete rejected.
- Transaction log (`audit.document_versions`) with field-level diffs; user log (`audit.user_log`): sign-ins, failures, exports, prints, sensitive views (salary, KYC, without-GST bills).
- Ledgers append-only: `inv.stock_ledger`, `acct.gl_entries`, `prod.material_consumption`, `core.asset_events`. Corrections = reversal + new document, linked.
- Posting RPCs: one transaction, row locks, idempotency via `client_request_id`, state-transition table, period checks, gap-free numbering.

## 5. Privacy (DPDP)

| Data | Rule |
|---|---|
| Aadhaar | Stored masked — last 4 digits only. Never shown in full. |
| Bank account numbers | Masked in lists (`XXXX XXXX 1234`); bank change needs two-person approval + logged call-back. |
| Bank statement passwords | Typed each time, **never stored**. |
| Salary, KYC | Readable only with the right; each view logged. |
| GPS | Only on duty, after notice; kept **90 days**; salesman sees own track, manager sees team. |
| Customer data | Customers don't give Aadhaar; GSTIN/PAN used. |
| Purpose & notice | Recorded per data type; consent where needed (WhatsApp, GPS); retention per record type; rights requests handled. |
| Logs | No secrets or personal data in logs; `ops.error_log` stores a redacted payload summary. |

## 6. Messaging (WhatsApp) limits

- Official WhatsApp Business Platform only, via provider adapter; token in Edge Function secrets.
- Only verified numbers with recorded consent; STOP opts out immediately; never a number typed in free text.
- Customers receive only their own documents/statements, complete and exactly as in the books.
- Staff messages carry links only — never salary, KYC or bank details.
- Internal alerts never carry without-GST figures or personal data.
- Dev/preview send only to a test allow-list; prod numbers never stored outside prod.
- Webhooks: `X-Hub-Signature-256` verified, deduplicated, logged. Retention: content 12 months, delivery events 90 days.

## 7. Help assistant limits

- Runs with the **user's own JWT** — RLS applies; no service-role key for data tools.
- Read-only: never posts, edits, approves, deletes, grants or changes settings.
- Never sends to the AI model: salary, KYC, bank details, Aadhaar, passwords, or without-GST figures (even for Admin). Server-side redaction; phone/Aadhaar/bank numbers masked.
- Treats instructions inside data as data (prompt-injection defence); ERP topics only.
- Limits: 30 messages/user/hour, monthly cost cap, 20 s timeout. Conversations kept 12 months; first-use DPDP notice.
- **Model provider and data flow:** _not yet chosen (open question Q-14)._ Record provider, region and data flow here when decided.

## 8. Data residency

Supabase DB, Storage, Edge Functions in `ap-south-1`; Vercel functions (if any) in `bom1`; backups only to Indian locations (Supabase Mumbai PITR + second copy in India, e.g. `ap-south-2`). Real business data never in Git, CI, GitHub-hosted runners, fixtures or screenshots.

## 9. Web security

`vercel.json`: CSP (incl. `frame-ancestors 'none'`), HSTS, `X-Frame-Options: DENY`, `nosniff`, strict referrer policy, restrictive permissions policy. No `dangerouslySetInnerHTML` with untrusted data. Storage via short-expiry signed URLs only.

## 10. Supply chain and CI

Dependabot; secret scanning with push protection; gitleaks in CI; lockfile committed; prod migrations only through the approval-gated GitHub environment.

## 11. Incident log

| Date | Incident | Action | Status |
|---|---|---|---|
| Phase 0 | Supabase secret key was shared in chat during set-up | Owner to **rotate** the secret key; code never uses it; not stored in repo | **Open** |

## 12. Phase 9 review — 03-11-2026

Go-live security review (prompt Part 1 §24, §28 Phase 9). DEV project `fxwoabbwzcifxzqsmrie` (`ap-south-1`), synthetic data only.

### 12.1 RLS and grants audit (`scripts/rls-audit.mjs`)

`DB_PASSWORD=… node scripts/rls-audit.mjs [--tables] [--json]` reads only the catalogue and exits 1 on any finding. It checks every table in `acct, audit, core, field, help, hr, inv, master, msg, ops, prod, purch, sales, public`: RLS on, ≥ 1 policy, no `using (true)` write policy; every `api` view `security_invoker`; every SECURITY DEFINER function (and every `api`/`app` function) has a pinned `search_path`; nothing in `api`/`app` executable by `anon` except the documented sign-in RPCs; no table privilege for `anon`; no direct `insert/update/delete/truncate` for `authenticated`; no public storage bucket.

| # | Finding (first run) | Fix (`20261103009000_security_hardening.sql`) |
|---|---|---|
| 1 | `core.request_log`, `core.doc_numbers_issued`, `ops.bridge_devices` had RLS on but **no policy** (deny-all by accident, not by design) | Explicit narrow read policies: own requests only; issued numbers to All / All read-only views; bridge devices Admin only. Writes stay RPC-only |
| 2 | `api.log_sign_in_failure` had **lost its `anon` EXECUTE** (a later blanket revoke), so failed sign-ins were not reaching the user log | Re-granted to `anon` (masked identifier, throttled to 20/hour inside). `25_security.sql` guards it |
| 3 | `app.imp_rank`, `app.imp_phone`, `app.imp_uom` had a mutable `search_path` | Pinned to `''` |

**Re-run after the fixes: 238/238 tables with RLS and ≥ 1 policy, 0 findings** (6 storage buckets, none public; 12 `storage.objects` policies). Signed-out RPC allow-list: `log_sign_in_failure` (plus sign-in helpers if added later: `sign_in_methods`, `phone_sign_in_allowed`, `investor_sign_in_allowed` — none exist today).

`supabase/tests/25_security.sql` (32 assertions) turns these catalogue properties into permanent tests, so a future migration that forgets RLS, a policy, `security_invoker` or `search_path`, or grants `anon` anything, fails CI.

### 12.2 MFA enforcement (server-side)

- Roles with `core.roles.mfa_required`: owner, admin, CA, auditor, MD, finance head, accountant, office admin, investor.
- Group setting **`security.enforce_mfa`** (`core.settings`, company null). **Default OFF** (no row) — DEV and the test suite. **Production: ON at go-live** (`docs/GO_LIVE_CHECKLIST.md`), only after every MFA-role account has enrolled an authenticator.
- When ON and the JWT is not `aal2`: `app.my_roles()` drops the MFA-required roles, so `app.can`, `app.can_read_company`, `app.current_view`, every RLS policy and Realtime see no such role; `app.require()` raises `mfa_required`; investor-portal partner rows, views and functions return nothing. Roles without MFA (salesman, staff…) are unaffected.
- `api.me()` returns `mfa_required`, `mfa_enforced`, `aal`, `mfa_needed`; `AuthProvider` sends the user to the existing TOTP step when `mfa_needed` is true (the `me` query is keyed on the access token so the new `aal2` token is re-checked).
- Tests: `25_security.sql` covers OFF (aal1 keeps access) and ON (accountant / Admin / investor at aal1 lose access, at aal2 regain it; salesman unaffected; RPC error `mfa_required`).
- **Gap:** there is no in-app **TOTP enrolment** screen yet; enrolment must be done before the setting is turned on (owner item in the go-live checklist).

### 12.3 Set-based RLS helpers (performance, same rules)

`20261103009100_performance_indexes.sql` rewrote the read policies of the large and always-joined tables from per-row `app.can(company_id, R)` to `company_id = any ((select app.companies_with(R))::uuid[])` (evaluated once per statement). `20261103009200_rls_helpers_set_based.sql` then computes `app.companies_with`, `app.companies_with_any` and `app.readable_companies` in one pass over the user's roles instead of calling `app.can()` per company, following `app.can()` case by case ('all' → every right; 'all-readonly' → only `*.view`/`*.export`; role right; otherwise an active special grant). Every rewritten table has `company_id NOT NULL`, so `= any(…)` and `app.can(company_id, …)` agree row for row.

`25_security.sql` proves the equivalence: for Admin, CA (group-wide all-readonly), two company accountants, a salesman with a company grant (and an expired one), a user with a group-wide grant, and an investor, over 11 rights, `companies_with(R) = { c : app.can(c, R) }`, `companies_with_any = ∪`, `readable_companies() = { c : app.can_read_company(c) }`, with MFA enforcement off, on at aal1 and on at aal2. The test passed against the old helpers before the migration and against the new ones after it.

### 12.4 Secrets scan (`scripts/secrets-scan.mjs`, CI)

Scans the tracked tree and the **whole git history** for Supabase `sb_secret_` keys, service-role JWTs (anon/publishable JWTs are allowed), private keys, Postgres URLs with a password, AWS / Google / Meta / GitHub tokens. Values are printed masked. **Result: no secrets in the tree or history.** `.env*.local` files are git-ignored and hold no `VITE_`-prefixed secret. CI (`.github/workflows/ci.yml`, job `secrets-scan`) runs gitleaks and this script on every PR and push to `main`. The Phase 0 key shared in chat still has to be **rotated** (incident log, Q-04).

### 12.5 Web security headers (`vercel.json`)

| Header | Value / reason |
|---|---|
| `Content-Security-Policy` | `default-src 'self'`; `script-src 'self'` (no `unsafe-eval`, no inline script — the build emits one external module); `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com` (React `style` props need inline styles; IBM Plex / Noto fonts CSS); `font-src 'self' https://fonts.gstatic.com`; `img-src 'self' data: blob: https://<ref>.supabase.co` (QR codes and signature canvas use `data:`/`blob:`; storage images); `connect-src 'self' https://<ref>.supabase.co wss://<ref>.supabase.co` (REST, Auth, Storage incl. signed URLs, Edge Functions, Realtime); `media-src 'self' blob:` (voice input); `worker-src 'self'` (service worker); `manifest-src 'self'`; `object-src 'none'`; `frame-src 'none'`; `frame-ancestors 'none'`; `base-uri 'self'`; `form-action 'self'`; `upgrade-insecure-requests` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(self)` (photo capture), `geolocation=(self)` (field / driver, on duty only), `microphone=(self)` (help voice input), everything else off |
| `X-Frame-Options` / `Cross-Origin-Opener-Policy` | `DENY` / `same-origin` |

Signed storage URLs are opened in a new tab (top-level navigation), so the CSP does not need to allow them in frames. `regions: ["bom1"]` (no Vercel functions today). **At go-live the DEV project URL in the CSP is replaced by the prod project URL**; `e2e/phase9-headers.spec.ts` (runs only when `E2E_BASE_URL` is an `https://` deployment) asserts every header and that the app loads without CSP violations.

### 12.6 Still open for the owner

Rotate the Supabase secret key (Q-04); repo private + branch protection (Q-05); TOTP enrolment for every MFA-role account, then `security.enforce_mfa = true` on prod; CSP prod URL swap; quarterly re-run of `rls-audit.mjs` against prod (read-only).

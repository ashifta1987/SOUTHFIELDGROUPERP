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

# Deployment guide

Covers GitHub, Vercel, Supabase, local development, secrets and the owner's WhatsApp / AI set-up tasks (§26, §WA-1, §HELP-4). Status: **Phase 0 initial version.**

## 1. Environments

| Env | Supabase project | Vercel | Data |
|---|---|---|---|
| Local | `supabase start` (Docker) | `pnpm dev` | Synthetic only |
| Dev / Preview | Existing project `fxwoabbwzcifxzqsmrie` (treated as DEV; region to verify) | Preview deployment per PR, Deployment Protection **on** | Synthetic only; WhatsApp test allow-list |
| Prod | **To be created**: `southfield-prod`, region **South Asia (Mumbai) `ap-south-1`** | Production from `main` | Real data, loaded only by the owner via the Import screen |

Previews always point at **dev**, never prod.

## 2. Run locally

Prerequisites: Node 20+ (LTS), pnpm, Docker (for local Supabase), Supabase CLI.

```bash
pnpm install
cp .env.example .env.local      # fill in the two browser-safe values below
pnpm dev                        # http://localhost:5173
```

`.env.local` (never committed; `.gitignore` covers `.env.*`):

```
VITE_SUPABASE_URL=<dev project URL or http://127.0.0.1:54321>
VITE_SUPABASE_PUBLISHABLE_KEY=<publishable / anon key>
```

Other commands:

| Command | Does |
|---|---|
| `pnpm lint`, `pnpm typecheck`, `pnpm test` | ESLint, `tsc --noEmit`, Vitest |
| `pnpm build` | Production build |
| `pnpm e2e` | Playwright + axe (against local Supabase, synthetic data) |
| `supabase start` / `supabase db reset` / `supabase test db` | Local DB, migrations + seed, pgTAP (from Phase 1) |
| `supabase gen types typescript --local > src/shared/database.types.ts` | Regenerate committed types after each migration |

`/dev/ui` (component gallery) exists only in `pnpm dev`.

## 3. GitHub

1. Repo `ashifta1987/SOUTHFIELDGROUPERP` → **Settings → General → Danger zone → Change visibility → Private.**
2. **Branch protection on `main`** (Settings → Branches / Rulesets):
   - Require a pull request before merging (≥ 1 approval; dismiss stale approvals).
   - Require status checks: `lint`, `typecheck`, `test` (Vitest), `pgtap`, `build`, `e2e-smoke` (Playwright), `gitleaks`.
   - Require branches up to date; block force pushes and deletion; include administrators.
3. **Security:** enable secret scanning + push protection, Dependabot alerts and version updates, and gitleaks in CI.
4. **Environments:**
   - `dev` — CI applies migrations to the dev project.
   - `production` — **required reviewer: owner**. Prod migrations run only from this environment. Destructive changes (drop, rename with data, type change) need a written plan in the PR and the owner's explicit approval.
5. **CI secrets** (Actions → Secrets): `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD_DEV`, `SUPABASE_PROJECT_REF_DEV`; prod equivalents only in the `production` environment. No business data on GitHub-hosted runners; nightly `pg_dump` runs on an India-hosted runner (Phase 2).
6. `design-reference/` and real Tally files are git-ignored. Never commit them.

## 4. Vercel

| Setting | Value |
|---|---|
| Framework preset | Vite |
| Install / build / output | `pnpm install` / `pnpm build` / `dist` |
| Production branch | `main` |
| Preview deployments | Every PR; **Deployment Protection on** |
| Functions | None (static SPA). If ever needed: region `bom1` only, with a written reason in `ERP_ARCHITECTURE.md` |
| Rollback | Promote the previous deployment |

**Environment variables** (the only two):

| Name | Preview / Development | Production |
|---|---|---|
| `VITE_SUPABASE_URL` | dev project URL | prod project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | dev publishable key | prod publishable key |

**Never add the service-role / secret key, WhatsApp tokens or AI keys to Vercel.** Anything prefixed `VITE_` is shipped to the browser.

`vercel.json` provides: SPA rewrite to `/index.html`; headers — `Content-Security-Policy` (default-src 'self'; connect-src self + Supabase URL + its websocket; font/style sources for self-hosted fonts; `frame-ancestors 'none'`), `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera/geolocation only on phone routes that need them).

## 5. Supabase

### Project

- [ ] Verify the existing project's region is **ap-south-1**. If not, create a new dev project in Mumbai.
- [ ] Create a separate **prod** project in `ap-south-1`.
- [ ] Database password kept in the owner's password manager only — never pasted into the agent or chat.
- [ ] **Rotate the secret key that was shared in chat** (Project Settings → API Keys → roll). Update Edge Function / CI secrets afterwards.
- [ ] Data API: expose **only** the `api` schema (Settings → API → Exposed schemas). Until Phase 1 creates `api`, nothing ERP-specific is exposed.
- [ ] Enable PITR / daily backups (Mumbai). Second-copy backups only to an Indian location (see "Backups and restore (Phase 9)" below).

### Auth

- [ ] **Disable public sign-ups** (Authentication → Sign In / Providers → "Allow new users to sign up" off). Admin creates every account.
- [ ] **Email** provider: on, email + password; confirm email on.
- [ ] **Phone** provider: on for staff phone + password sign-in. Staff accounts are created with the phone already confirmed. OTP-based flows need an SMS/WhatsApp OTP provider — **owner to choose** (open question Q-07).
- [ ] **MFA: TOTP enabled.** Required (AAL2) for Admin/Owner, finance roles and CA — enforced in RLS from Phase 1.
- [ ] Site URL and redirect URLs: production domain + Vercel preview pattern + `http://localhost:5173`.
- [ ] Rate limits / lock-out: keep Supabase defaults or tighter; app lock-out policy in Phase 1.
- [ ] Session: JWT expiry ≤ 1 hour; short sessions on shared devices.
- [ ] Roles for Phase 0 review: set `app_metadata.role` on test users (dashboard or `admin-users` Edge Function). Users cannot edit `app_metadata`.

### Storage (from Phase 2)

Private buckets only: `kyc`, `bills`, `documents`, `licences`, `lab`, `imports`. Policies by company + right; `kyc` readable only by HR and Admin. Signed URLs with short expiry.

### Edge Function secrets (`supabase secrets set`, per project)

| Secret | Used by | Phase |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` / secret key | `admin-users`, `tally-import`, `whatsapp-sender`, `pdf-render` (never data tools of `help-agent`) | 1+ |
| `WHATSAPP_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | `whatsapp-sender`, `whatsapp-webhook` | 3 |
| `WHATSAPP_TEST_ALLOWLIST` | dev/preview only | 3 |
| `HELP_AI_PROVIDER`, `HELP_AI_API_KEY`, `HELP_AI_REGION` | `help-agent` | 3 |
| `GSP_CLIENT_ID`, `GSP_CLIENT_SECRET` | `gstin-verify`, `einvoice`, `ewaybill` | 2 / 8 |
| `INTEGRATION_WORKER_SECRET` | scheduler → `integration-worker`, `einvoice`, `ewaybill`, `bank-feed` | 8 |
| `GSP_BASE_URL`, `GSP_USERNAME`, `GSP_PASSWORD` (per GSTIN, as the GSP requires) | `einvoice`, `ewaybill` (via `integration-worker`) | 8 |
| `BANK_FEED_CLIENT_ID`, `BANK_FEED_CLIENT_SECRET` | `bank-feed` | 8 |
| `GPS_WEBHOOK_SECRET` | `gps-intake` | 8 |
| `STORE_WEBHOOK_SECRET_SHOPIFY`, `…_AMAZON`, `…_FLIPKART`, `…_JIOMART`, `…_MEESHO` | `store-webhooks` | 8 |
| `HELP_ALLOW_MOCK` (DEV only: `true`), `HELP_WHATSAPP_PHONE_NUMBER_ID`, `HELP_WHATSAPP_VERIFY_TOKEN` | `help-agent`, `help-whatsapp` | 8 |

Edge Functions are invoked regionally in `ap-south-1`.

## 6. Secret handling rules

- Browser: only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
- Secret/service-role key: only Edge Function secrets and CI secrets. Never in `VITE_*`, the repo, logs or chat.
- Never commit `.env` files (`.env.example` holds names only).
- Bank statement passwords are typed each time and never stored.
- If a secret is exposed: rotate immediately, record in `SECURITY.md` incident log.

## 7. Owner set-up tasks (later phases)

**WhatsApp (before Phase 3 goes live, §WA-1):** Meta Business verification for each company; WhatsApp Business number + display name per company (or one for the group — owner decides); payment method on the WhatsApp Business account; template approval; choose Meta direct or a BSP (Gupshup, Interakt, AiSensy, Wati, Twilio).

**Help assistant (§HELP-4):** choose the AI provider (Gemini on Vertex AI, Claude, other); prefer an India-region endpoint; key only in Edge Function secrets; set a monthly cost cap.

**Tally bridge (Phase 2):** choose the import computer (Windows PC with TallyPrime); enable TallyPrime HTTP server on port 9000; bridge gets its own device key, never the Supabase secret key.

## Database commands (Phase 1+)

The database password is never stored in the repo. Export it in your shell for the session:

```bash
export DB_PASSWORD='…'          # DEV project database password
pnpm db:push                     # apply supabase/migrations to DEV
pnpm db:test                     # pgTAP (scripts/pgtap.mjs), every file rolled back
pnpm db:types                    # regenerate src/shared/database.types.ts
node scripts/e2e-cleanup.mjs     # remove synthetic E2E rows from DEV
```

GitHub Actions: `Database (DEV)` applies migrations and runs pgTAP on pushes touching `supabase/` when the repo secret `DEV_DB_PASSWORD` is set. `Database (PROD)` runs only by hand from the `production` environment — set that environment to **require the owner's approval** and add `PROD_DB_PASSWORD` and `PROD_SUPABASE_REF` there.

## Edge Function `admin-users`

Creates sign-in accounts from the Users screen. Deploy once (owner):

```bash
npx supabase login
npx supabase functions deploy admin-users --project-ref fxwoabbwzcifxzqsmrie
```

The service-role key is provided to Edge Functions by Supabase automatically; never put it in Vercel or the repo. Until it is deployed, create accounts in the Supabase dashboard (Authentication → Add user); a profile is created automatically and Admin assigns the role on the Users screen.

## Edge Functions `whatsapp-sender` and `whatsapp-webhook` (Phase 3)

Not deployed yet — needs the WhatsApp Business account (Q-13) and the owner's `supabase login`. Until then the outbox fills and nothing is sent.

```bash
supabase secrets set --project-ref <ref> WHATSAPP_TOKEN=… WHATSAPP_APP_SECRET=… WHATSAPP_VERIFY_TOKEN=… APP_ENV=dev WHATSAPP_PROVIDER=mock
supabase functions deploy whatsapp-sender --project-ref <ref>
supabase functions deploy whatsapp-webhook --project-ref <ref> --no-verify-jwt   # Meta calls it; the signature is checked in code
```

- Invoke regionally (`x-region: ap-south-1`) so data stays in India.
- Schedule the sender every minute with `pg_cron` + `pg_net` (call the function URL with the service key from Vault, never from the repo).
- Keep `WHATSAPP_PROVIDER=mock` on DEV; in dev only allow-listed numbers receive messages.
- Webhook URL to give Meta: `https://<ref>.supabase.co/functions/v1/whatsapp-webhook`.

## Phase 8 Edge Functions (integrations)

Code is in `supabase/functions/<name>/index.ts`; pure adapters in `supabase/functions/_shared/` (unit-tested by `pnpm test`, type-checked by `tsc -b` through `tsconfig.functions.json`). **None is deployed yet** (needs the owner's `supabase login` / access token) and **no real provider is configured**: each kind of integration uses the provider named in Settings (`integrations.provider.einvoice`, `…eway`, …). Unset → refused; `mock` works only where the setting `integrations.allow_mock` is true — set it on DEV only, never on prod.

```bash
REF=fxwoabbwzcifxzqsmrie   # DEV; prod later from the protected environment
supabase secrets set --project-ref $REF INTEGRATION_WORKER_SECRET=<random 32+ chars> GPS_WEBHOOK_SECRET=<from GPS provider> \
  STORE_WEBHOOK_SECRET_SHOPIFY=<Shopify app client secret> HELP_AI_PROVIDER=mock HELP_ALLOW_MOCK=true WHATSAPP_PROVIDER=mock
# when chosen: GSP_BASE_URL=… GSP_CLIENT_ID=… GSP_CLIENT_SECRET=… GSP_USERNAME=… GSP_PASSWORD=… BANK_FEED_CLIENT_ID=… BANK_FEED_CLIENT_SECRET=… HELP_AI_API_KEY=… HELP_AI_REGION=asia-south1

# Called by the scheduler or a signed-in user (JWT verified by Supabase):
supabase functions deploy integration-worker --project-ref $REF --no-verify-jwt   # checks INTEGRATION_WORKER_SECRET in code
supabase functions deploy bank-feed          --project-ref $REF --no-verify-jwt   # checks INTEGRATION_WORKER_SECRET in code
supabase functions deploy einvoice           --project-ref $REF --no-verify-jwt   # worker secret or a valid user JWT, checked in code
supabase functions deploy ewaybill           --project-ref $REF --no-verify-jwt
supabase functions deploy help-agent         --project-ref $REF                    # user JWT required; runs with the user's rights only
# Called by outside providers (signature checked in code before anything else):
supabase functions deploy gps-intake         --project-ref $REF --no-verify-jwt
supabase functions deploy store-webhooks     --project-ref $REF --no-verify-jwt
supabase functions deploy help-whatsapp      --project-ref $REF --no-verify-jwt
```

**Regional invocation (data stays in India).** From the app: `supabase.functions.invoke('einvoice', { region: FunctionRegion.ApSouth1 })` (header `x-region: ap-south-1`). Provider webhooks cannot set headers, so their URLs carry the query parameter: `https://<ref>.supabase.co/functions/v1/store-webhooks?provider=shopify&channel=<online channel id>&forceFunctionRegion=ap-south-1`, `…/gps-intake?provider=<name>&forceFunctionRegion=ap-south-1`, `…/help-whatsapp?forceFunctionRegion=ap-south-1`.

**Scheduler.** Enable `pg_net`, keep `INTEGRATION_WORKER_SECRET` in Supabase Vault (never in the repo), then:

```sql
select cron.schedule('integration-worker', '* * * * *', $$
  select net.http_post(url := 'https://<ref>.supabase.co/functions/v1/integration-worker',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'integration_worker_secret'),
                                  'x-region', 'ap-south-1', 'Content-Type', 'application/json'), body := '{}'::jsonb) $$);
```

`integration-sweep` (pg_cron, every 5 minutes) is created by the migration and needs nothing else.

**Webhook set-up per provider** (after the owner opens the accounts): Shopify → Settings → Notifications → Webhooks (`orders/create`, `orders/cancelled`) to the URL above; the app's client secret is `STORE_WEBHOOK_SECRET_SHOPIFY`. Amazon SP-API sends notifications to SQS/EventBridge — relay them to `store-webhooks?provider=amazon` signed with the generic HMAC (`X-Signature` = hex HMAC-SHA256 of `${X-Timestamp}.${body}`, `X-Event-Id`); Flipkart, JioMart and Meesho the same until their own scheme is confirmed (Q-P8-4). GPS provider → `gps-intake` with the same generic HMAC. Help WhatsApp number → Meta webhook to `help-whatsapp` (verify token `HELP_WHATSAPP_VERIFY_TOKEN`).

**Turning e-invoicing on (per GSTIN):** Admin records the CA's confirmation with `api.set_einvoice_switch` (start date). From then on a B2B tax invoice / credit note is final only with its IRN (no print, the WhatsApp invoice waits, goods do not leave).

## Help pages (Phase 3)

`docs/help/*.md` are loaded into `help.pages` with `DB_PASSWORD=… node scripts/help-seed.mjs` after each change.

## Backups and restore (Phase 9)

### Policy (production)

| Layer | What | Where | Retention | Who |
|---|---|---|---|---|
| 1. Supabase daily backups | Physical backup of the whole database, taken by Supabase | Same project region, **`ap-south-1` (Mumbai)** | Per plan (Pro: 7 days) | Automatic |
| 2. **PITR** (point-in-time recovery add-on) | WAL archive: restore to any second inside the window | `ap-south-1` | 7 days minimum (owner may buy 14/28) | Owner enables at go-live |
| 3. Second copy — India-hosted `pg_dump` runner | Nightly `pg_dump --format=custom` of the app schemas + Storage bucket sync, encrypted (age/GPG, key held by the owner offline) | A VM or office server **in India** (e.g. a small VM in `ap-south-1`/`ap-south-2`, or the Chalissery office server) — never a GitHub-hosted runner, never outside India | 35 nightly + 12 month-end copies; month-end copies of FY-end kept 8 years (books of account, Companies Act s.128(5)) | Admin; each run recorded via `api.record_backup_run` (kind `pg_dump`) |
| 4. Tally archive | Final Tally data folder after sign-off | Indian archive location | 8 years | Admin (cut-over Step 4) |

Rules: the dump runner uses a **read-only** database role created for it (not the `postgres` password, never the secret key in the browser); its connection string lives only on that machine; dumps never go into Git, CI artifacts or chat. Each run's size and checksum go into `ops.backup_runs`; the Backup screen (Phase 2) shows the latest run and warns when the last good run is older than 26 hours.

### Restore procedures

1. **Point-in-time (PITR)** — Supabase dashboard → Database → Backups → Point in time → pick the time → restore **into a new project in `ap-south-1`**. Then run `scripts/restore-drill.mjs`-style checks (schema fingerprint, row counts, ledger checksums) against it, point Vercel's `VITE_SUPABASE_URL`/key at it, redeploy Edge Functions and secrets, update the CSP URL in `vercel.json`. Owner decides; recorded in the Bug fixer.
2. **From the India `pg_dump`** — create an empty project in `ap-south-1` and restore the whole custom dump into it in one go (`pg_restore --single-transaction --no-owner`), as a like-for-like copy that includes the audit tables. Never restore selected rows into a live database: corrections are reversals plus new documents.
3. After any restore: verify `audit.row_history` continuity (max id/time), trial balance per company = pre-incident report, stock ledger totals, gap-free numbering (`core.doc_numbers_issued`).

### Restore drill — DEV, 03-11-2026 (what was and wasn't drilled)

Docker is not available on the build machine and the DEV project is on the free plan, so a full PITR restore into a second project **was not** performed. What **was** drilled, with `DB_PASSWORD=… node scripts/restore-drill.mjs --record`:

The drill ran on 03-11-2026 at 21:09 IST. The data is synthetic only. Dump files went to `backups/drill-…/` on the office laptop in India; that folder is git-ignored.

1. **Dump from one snapshot** (`REPEATABLE READ`, read-only):
   - 13 key tables as JSON: `core.companies, gstins, user_roles, settings`, `master.parties, products`, `acct.accounts, vouchers, gl_entries, bill_allocations`, `sales.documents, document_lines`, `inv.stock_ledger`.
   - Their row counts and order-independent content checksums.
   - Row counts of all 238 app tables.
   - A schema fingerprint: tables, columns, constraints, indexes, policies, `api`/`app` function bodies and `api` views.
   - Size: 240.8 MB. Time: 104 s.
2. **Restore and verify:** each file was checked against its SHA-256, loaded into a temporary copy of its table (`create temp table … (like …)` + `json_populate_recordset`), and re-checksummed. **13/13 tables matched exactly** on row count and content checksum, including 240,614 GL rows, 100,409 stock rows and 70,212 vouchers. The temporary copies were rolled back. The schema fingerprint read again was identical. Total time: 154 s.
3. **Recorded** through `api.record_backup_run` (kind `restore_drill`, status `ok`) as the synthetic E2E Admin. It shows on the Backup screen.

What this proves: a logical export of the books can be taken consistently and read back bit-for-bit. What it does **not** prove: that a whole database can be rebuilt, including roles, auth users, Storage objects, sequences and triggers.

**Not drilled yet (owner, on prod before go-live — `docs/GO_LIVE_CHECKLIST.md` §7):** a real PITR restore into a new `ap-south-1` project; a full `pg_dump`/`pg_restore` round trip on the India runner; Storage bucket restore; timing the switch of the app to a restored project (target RTO 4 h, RPO ≤ 5 minutes with PITR).

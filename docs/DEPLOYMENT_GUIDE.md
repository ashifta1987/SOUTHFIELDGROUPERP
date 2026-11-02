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
- [ ] Enable PITR / daily backups (Mumbai). Second-copy backups only to an Indian location (Phase 2).

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

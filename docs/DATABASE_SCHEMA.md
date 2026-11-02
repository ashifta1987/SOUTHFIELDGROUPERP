# Database schema

Data contracts for each phase. Written before the code (`/next-phase` step 3). Migrations live in `supabase/migrations/`; pgTAP tests in `supabase/tests/`.

**Environment:** one Supabase project, used as **DEV** (`fxwoabbwzcifxzqsmrie`). Its region was verified as **ap-south-1 (Mumbai)** on 03-11-2026: the connection goes through the ap-south-1 pooler. Production is a separate project, still to be created.

## Conventions

| Topic | Rule |
|---|---|
| Schemas | Private: `app` (helpers), `core`, `audit`, `ops` (Phase 1). Later: `master`, `inv`, `prod`, `sales`, `purch`, `acct`, `hr`, `field`, `msg`, `help`. **Only `api` is exposed** by the Data API (`alter role authenticator set pgrst.db_schemas = 'api, graphql_public'`). |
| Reads | `api.*` views with `security_invoker = true`. `authenticated` has SELECT on the base tables, and RLS decides which rows arrive. |
| Writes | Only `api.*` RPCs (`security definer`, `set search_path = ''`). There are no INSERT/UPDATE/DELETE grants or policies on any table. |
| RLS | Enabled on every table in `core`, `audit` and `ops`. Policies call `app.can_read_company()`, `app.can()` and `app.can_see_tax_class()`. |
| Idempotency | Every changing RPC takes `p_client_request_id uuid` as its first argument. `core.request_log` stores the result, so a repeat call returns the same result and changes nothing. |
| Rule codes | Refusals raise with `errcode` (`42501` rights, `22023` bad input, `P0001` business rule, `P0002` not found) and a `HINT` holding a stable rule code (e.g. `rights.missing`). The UI maps the code to a message. |
| History | `app.audit_trigger()` (AFTER INSERT/UPDATE/DELETE) on every business table writes to `audit.row_history`. The row records the actor, the grant id (`app.grant_id`), the request id (`app.request_id`) and the app version. |
| Append-only | `app.reject_change()` blocks UPDATE, DELETE and TRUNCATE on `audit.row_history` and `audit.user_log`, and UPDATE and DELETE on `core.doc_numbers_issued` and `core.settings`. |
| Types | Money `numeric(18,2)`, quantities `numeric(18,3)`, rates `numeric(9,4)`. No float. |

## Phase 1: foundation (built)

Migrations: `20261103000100_foundation.sql`, `20261103000200_seed_config.sql`, `20261103000300_api.sql`.

### Tables

| Table | Key columns and constraints |
|---|---|
| `core.companies` | `code` unique (`^[A-Z0-9]{2,8}$`), `legal_name`, `short_name`, `pan` unique (PAN format), `cin` unique, `registered_address`, `logo_key`, `status` active/inactive |
| `core.gstins` | `company_id`, `gstin` unique (GSTIN format), `state_code` generated from the GSTIN, `is_principal` (one per company, kept by the RPC), `einvoice_enabled` (off by default), `status` |
| `core.branches` | `company_id`, `gstin_id` (same company only), `code` (unique per company), `kind` factory/shop/branch/godown/office/unit |
| `core.places` | `company_id`, `branch_id`, `code`, `kind` stores/quarantine/wip/fg_hold/fg_released/damage/transit/van/agent_consignment/other |
| `core.departments` | `company_id` (null = group) |
| `core.financial_years`, `core.periods` | April–March year (label `2026-27`), 12 monthly periods, open/closed |
| `core.roles` | `key`, `view_kind` all / all-readonly / gst, `sign_in`, `mfa_required`. The 30 roles from §2.4 are seeded. |
| `core.rights` | `module.action`. `kind` module/special. Flags: `admin_only`, `never_grantable`, `grantable_by_permission`. |
| `core.role_rights` | Rights per role. The accountant's starting template is seeded (Users screen). |
| `core.user_profiles` | One per auth user (trigger `app.on_auth_user_created`): name, person code, language, status |
| `core.user_roles` | `user_id`, `role_key`, `company_id` (null = all companies), `valid_from`, `valid_to` (required for CA/auditor) |
| `core.user_scopes` | Optional place-level scope |
| `core.approval_limits` | `role_key`, `company_id`, `doc_type`, `amount numeric(18,2)` |
| `core.special_grants` | `code` (SP-YYMMDD-NNN), `user_id`, `right_key`, `company_id`, `params jsonb`, `starts_at`/`ends_at`, `max_uses`/`uses`, `reason`, `granted_by` ≠ `user_id`, revoke fields. A trigger refuses never-grantable and admin-only rights. |
| `core.special_grant_requests` | `requested_by`, wanted window, `status`. Check: `decided_by <> requested_by`. |
| `core.settings` | Versioned and append-only. The current value is the latest `effective_from <= today`; a company row beats the group row. |
| `core.doc_types` | 16 document types; GST documents have `max_number_length` 16 |
| `core.doc_series`, `core.doc_numbers_issued` | Series per company, GSTIN, doc type and FY. Every issued number is recorded (append-only), so the series is provably gap-free. |
| `core.forms`, `core.form_fields` | Admin-defined extra fields per form |
| `core.law_rules` | The Indian-law register shown on "Built to Indian law" |
| `core.request_log` | Idempotency store. No client access. |
| `audit.row_history`, `audit.user_log` | Append-only audit trail and user log |
| `ops.error_log` | `ref` `ERR-XXXXX`, route, rpc, rule code, message |

### Helpers (`app`)

| Function | Purpose |
|---|---|
| `app.my_roles()` | The current user's active roles (CA windows end on their own; disabled profiles have none) |
| `app.current_view()` | `all` > `all-readonly` > `gst`; no role means `gst` |
| `app.can(company_id, right)` | Admin: everything. CA: only `*.view` / `*.export`. Others: role rights for that company, or an active special grant. |
| `app.can_read_company(company_id)` | Company visibility from role scope |
| `app.can_see_tax_class(tax_class)` | `without_gst` rows only in the Admin/CA views. Every later document table uses it in RLS. |
| `app.active_grant(right, company)` | Running grant id (inside its window, not revoked, uses left) |
| `app.require(company, right)` | Raises `42501` with a rule code; returns the grant id when the right comes only from a grant |
| `app.use_grant(grant_id, detail)` | Counts a use, sets `app.grant_id` for history, logs `grant_used` |
| `app.take_doc_number(company, gstin, doc_type, fy)` | Locks the series row (`FOR UPDATE`), records the number, refuses numbers over 16 characters |
| `app.setting(company, key, on)` | Current setting value |
| `app.request_seen` / `app.request_done` | Idempotency |

### RLS summary

| Table | Who reads |
|---|---|
| companies, gstins, branches, places, FYs, periods, doc_series, approval_limits | Users whose roles cover the company (Admin and CA: all) |
| roles, rights, role_rights, doc_types, forms, law_rules | Every signed-in user |
| user_profiles, user_roles, user_scopes, special_grants, grant_requests | Self, or `users.view` |
| row_history | `logs.view` (Admin, CA) |
| user_log, error_log | Self, or `logs.view` |
| request_log, doc_numbers_issued | Nobody (RLS on, no policy) |

### RPCs (`api`)

Full list with parameters: [API_DOCUMENTATION.md](API_DOCUMENTATION.md).

### State machines

- Special permission: `scheduled → running → ended`, or `→ stopped` (revoked). The state is computed from time; nothing has to switch it off.
- Grant request: `pending → approved | refused | withdrawn`. The decider must be another person.
- Period: `open → closed` (closing arrives in Phase 7). A closed period can only be edited under the `period.reopen` grant.

### Events to `msg.outbox`

None in Phase 1. WhatsApp to Admin when a grant starts, is used or ends is planned for Phase 3, with the `msg` schema.

### Tests

`supabase/tests/01_audit.sql`, `02_rights.sql`, `03_grants.sql`, `04_numbering.sql` (43 assertions). Run them with `DB_PASSWORD=… pnpm db:test`. Each file runs inside one transaction that is always rolled back.

## Phase 2 onwards

Contracts are written at the start of each phase. The plan is in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).


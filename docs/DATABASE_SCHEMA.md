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

## Phase 2: masters and data load (built)

Migrations: `20261103001000_masters.sql`, `…001100_import_bugfixer.sql`, `…001200_api_phase2.sql`, `…001300_import_engine.sql`. New schemas `master` and `acct`; extension `pg_trgm`.

| Area | Tables | Notes |
|---|---|---|
| Units and tax | `master.uoms` (GST UQC codes seeded), `master.hsn_codes`, `master.hsn_rates` | Rates are effective-dated (`effective_from/to`), `ca_confirmed`, never deleted; **no rates seeded** (the CA confirms) |
| Products | `master.product_groups`, `master.products` (code, HSN, unit, net quantity, pack, barcode, licence no., label jsonb, status to_review/active/inactive), `master.product_companies`, `master.product_mrp_history` (append-only), `master.product_aliases` | Duplicate names blocked unless forced |
| Parties | `master.parties` (group-level; GSTIN unique with check digit and PAN-inside check; KYC draft → review → verified/rejected; MSME + Udyam), `master.party_companies` (customer/supplier per company, terms, beat, tier, TDS section), `master.party_aliases`, `master.party_contacts` (WhatsApp +91, consent with time, language), `master.party_addresses` (pin code, lat/lng), `master.party_documents` (private `kyc` bucket) | Proposer can't verify KYC; GST view sees parties of its companies |
| Bank | `master.party_bank_accounts` (full number **not selectable** by clients; lists show ••last 4), `master.bank_change_requests` | Change = request → call-back by another person → approval by another person |
| Terms and prices | `master.credit_terms` (CASH, 7–60 days seeded as labels), `master.price_lists`, `master.price_list_items` (effective-dated) | Tax-inclusive price above MRP refused |
| People | `master.people` (one group-level staff list; Aadhaar last 4 only), `master.person_companies` | HR details in Phase 3 |
| Accounts | `acct.account_groups` (nature, debtors/creditors flag), `acct.accounts` (opening balance Dr/Cr), `acct.open_bills` (bill-wise opening outstanding with `tax_class`, default `unclassified`), `acct.posting_rules` | Unclassified/without-GST bills visible only to Admin/CA |
| Import | `ops.import_batches`, `ops.import_rows`, `ops.source_keys` (GUID/MASTERID/ALTERID), `ops.tally_group_map`, `ops.bridge_devices`, `ops.tally_vouchers` (never deleted) | See DATA_MIGRATION.md |
| Bug fixer | `ops.bug_items` (`F-0001`, area, kind, severity, evidence, suggested fix, who fixes, dedupe key), `ops.merge_log` | Items about bills without GST follow the view rule |
| Backups | `ops.backup_runs` | Location must be in India |
| Storage | buckets `imports` (data.import), `kyc` (kyc.view to read) — private | |

Helpers: `app.norm_name()`, `app.gstin_valid()`, `app.party_candidates()`, `app.can_see_party()`, `app.can_see_bill_class()`, `app.open_bug()`, and the import engine `app.imp_*`.

Tests: `05_masters.sql` (16), `06_import.sql` (15). **73/73 pass in total.**

## Phase 3 onwards

Contracts are written at the start of each phase. The plan is in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).


### Phase 3 HR screens (`20261103003000_hr_screens.sql`, built)

| Object | Contract |
|---|---|
| `api.save_staff(crid, p jsonb) → {person_id, person_code}` | Add or edit a staff member in **one transaction**: `master.people` + `master.person_companies` (pay company) + `hr.staff_profiles`. Rights: `hr.create` (new), `hr.edit` on the pay company (and on the old one when moving); salary keys need `payroll.run`. Designation and pay company required; Aadhaar → last 4 only; bank → last 4 only; phone normalised to +91. Staff ID from `hr.staff_code_seq` via `app.next_staff_code()` (`EMP-0001`…, never reused). Rule codes `staff.*`. |
| `api.staff_kyc()` (read) | Staff list with KYC completeness (phone, DOB, Aadhaar, PAN, bank = 5); Aadhaar, PAN and bank returned **masked**. Rows limited to `hr.view` on the pay company, or the person themselves. |
| `api.staff_pay(p_person_id)` (read, logged) | Salary / day rate of one person; `payroll.run` on the pay company or self; every view of someone else's pay is logged as `view_sensitive`. |
| `api.staff_allowances` (view, invoker) | Read-only allowances/deductions under `hr.allowances` RLS. |
| `api.give_staff_cash` (replaced) | Now locks the person, applies the daily cash **payment** limit per person (`cash.payment_warn_amount`; above it needs `cash_reason`, voucher flagged, Admin log), and pays an advance request only if it is that person's **approved** advance and not already paid. Returns `warning`. |
| `api.decide_staff_request` (replaced) | Refuses a missing request (`staff.request_missing`); leave marking only when the request has a company. |

Tests: `supabase/tests/10_hr_screens.sql` (18).

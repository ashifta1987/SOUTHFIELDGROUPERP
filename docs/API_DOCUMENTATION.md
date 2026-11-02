# API documentation

The browser talks only to the `api` schema through Supabase (PostgREST), using the user's own token. Every changing RPC takes `p_client_request_id uuid` first; the frontend helper `callApi()` in `src/data/rpc.ts` adds it automatically. Refusals come back with a Postgres error code plus a rule code in `hint`.

## Read views (security_invoker; RLS decides rows)

| View | Columns (main) |
|---|---|
| `api.companies` | id, code, name, short_name, pan, cin, registered_address, logo_key, status, gstin_count, branch_count |
| `api.gstins` | id, company_id, company_name, gstin, state_code, legal_name, trade_name, registered_on, is_principal, einvoice_enabled, status |
| `api.branches` | id, company_id, company_name, gstin_id, gstin, code, name, kind, address, status, place_count |
| `api.places` | id, company_id, company_name, branch_id, branch_name, code, name, kind, status |
| `api.departments` | id, company_id, name, status |
| `api.financial_years` | id, company_id, label, starts_on, ends_on, status, closed_periods |
| `api.roles` | key, label, view_kind, sign_in, mfa_required, sort, rights[] |
| `api.rights` | key, module, action, label, hint, kind, admin_only, never_grantable, grantable_by_permission |
| `api.special_grants` | id, code, user, right, company, params, window, uses, reason, granted by, revoke, **state** |
| `api.special_grant_requests` | id, requested_by, right, window, reason, status, decided_by |
| `api.user_log` | id, user, event, detail, grant_code, at |
| `api.transaction_log` | id, table_name, row_pk, op, before, after, actor_name, grant_code, request_id, at |
| `api.error_log` | ref, user_id, route, rpc, rule_code, message, at |
| `api.settings_current` / `api.settings_history` | company_id, key, value, effective_from, note, set_at (history: set_by_name) |
| `api.doc_types`, `api.doc_series` | series with `next_number` and `fits_limit` |
| `api.forms`, `api.form_fields` | form fields per form |
| `api.law_rules` | code, area, rule, what_erp_does, enforced_in, test_ref, status, phase |

## RPCs

| RPC | Parameters | Right | Notes |
|---|---|---|---|
| `me()` | — | signed in | Profile, view, roles, rights (`*` for Admin), running grants, read-only end date |
| `upsert_company` | crid, p {id?, code, legal_name, short_name, pan, cin, registered_address, logo_key, status} | org.manage | code fixed after create |
| `upsert_gstin` | crid, p {id?, company_id, gstin, legal_name, trade_name, registered_on, is_principal, einvoice_enabled, status} | org.manage | GSTIN must carry the company PAN; one principal place |
| `upsert_branch` | crid, p {id?, company_id, gstin_id, code, name, kind, address, status} | org.manage | GSTIN of the same company only |
| `upsert_place` | crid, p {id?, branch_id, code, name, kind, status} | org.manage | |
| `upsert_department` | crid, p {id?, company_id, name, status} | org.manage | |
| `open_financial_year` | crid, p_company_id, p_start_year | settings.manage | April–March + 12 periods |
| `list_users()` | — | users.view | Phone masked to ••last 4 |
| `update_user_profile` | crid, p_user_id, p {display_name, person_code, language, status} | users.manage (own language: self) | cannot disable self |
| `assign_role` | crid, p_user_id, p_role, p_company_id, p_valid_to, p_reason | users.manage | CA/auditor need an end date; reason ≥ 5 chars |
| `remove_role` | crid, p_user_role_id, p_reason | users.manage | cannot remove own Admin |
| `set_role_rights` | crid, p_role, p_rights[], p_reason | users.manage | GST-view roles only; admin-only/never-grantable refused |
| `grant_special_permission` | crid, p_user_id, p_right, p_company_id, p_params, p_starts_at, p_ends_at, p_max_uses, p_reason | users.manage | never-grantable refused; not to self; ≤ `grants.max_days` |
| `revoke_special_permission` | crid, p_grant_id, p_reason | users.manage | |
| `request_special_permission` | crid, p_right, p_company_id, p_params, p_from, p_to, p_reason | signed in (not CA) | |
| `decide_special_permission` | crid, p_request_id, p_approve, p_max_uses | users.manage | requester can never decide |
| `set_setting` | crid, p_company_id, p_key, p_value, p_effective_from, p_note | settings.manage | append-only versions |
| `upsert_doc_series` | crid, p {id?, company_id, gstin_id, doc_type, fy_id, prefix, pad, next_no, status} | settings.manage | locked once numbers issued |
| `upsert_form_field` | crid, p {id?, form_key, company_id, field_key, label, field_type, required, options, sort, active} | forms.manage | |
| `log_error` | p_route, p_rpc, p_rule_code, p_message, p_payload_summary | signed in | returns `ERR-XXXXX` |
| `log_user_event` | p_event (sign_in/sign_out/export/print/view_sensitive), p_detail | signed in | |
| `log_sign_in_failure` | p_identifier | anon | stored masked; ≤ 20/hour per identifier |

## Phase 2 RPCs

| RPC | Right | Notes |
|---|---|---|
| `upsert_hsn`, `add_hsn_rate` | hsn.manage (Admin) | rate versions by date; previous version closed the day before |
| `upsert_product_group`, `upsert_product`, `set_product_mrp` | products.manage (Admin) | duplicate names → `masters.possible_duplicate` (DETAIL lists candidates) unless `force` |
| `upsert_party` | sales.create/edit or purchase.create/edit for the company | GSTIN check digit, PAN inside GSTIN, duplicates (GSTIN/PAN/phone/name), MSME 45-day selling rule when `msme.selling_rule` is set |
| `party_duplicates`, `check_gstin` | read | live checks for the KYC form |
| `upsert_party_contact`, `upsert_party_address`, `add_party_document` | sales/purchase edit | |
| `set_party_kyc` | review: editors · verify/reject: Admin or kyc.view, never the proposer | refresh due in a year |
| `add_party_bank_account` | edit | first account only |
| `request_bank_change` → `record_bank_callback` → `decide_bank_change` | edit → bank_change.approve (another person) → bank_change.approve (another person) | |
| `view_bank_account` | bank.view_full | logged as a sensitive view |
| `upsert_credit_term` | settings.manage | |
| `upsert_price_list`, `set_price` | products.manage | tax-inclusive price above MRP refused |
| `upsert_account_group`, `upsert_account`, `set_tally_group_map` | settings.manage | mapping closes the matching "Map this head" items |
| `classify_open_bills` | Admin | |
| `merge_preview`, `merge_parties` | Admin | alias kept, merge logged |
| `import_create_batch`, `import_stage_rows`, `import_process`, `import_approve` (Admin), `import_undo` (Admin, reason) | data.import | |
| `bug_resolve` (keep_separate, link_existing, accept_change, dismiss, fixed), `run_checks` | bugfix.fix | note required |
| `record_backup_run` | Admin | location must be in India |
| `bug_fixer_open_count()` | read (security invoker) | workflow strip |

## Rule codes

`auth.required`, `rights.missing`, `rights.read_only`, `rights.reason_required`, `rights.admin_only`, `rights.role_fixed`, `rights.self_demote`, `rights.ca_needs_end`, `grant.never_grantable`, `grant.not_on_list`, `grant.self`, `grant.too_long`, `grant.bad_window`, `grant.reason_required`, `grant.already_stopped`, `grant.already_decided`, `sod.self_approval`, `org.gstin_pan_mismatch`, `org.gstin_other_company`, `org.company_missing`, `org.branch_missing`, `numbering.no_series`, `numbering.too_long`, `numbering.in_use`, `users.self_disable`, `request.id_missing`, `masters.possible_duplicate`, `party.*` (gstin_invalid, gstin_pan_mismatch, pan_invalid, gstin_exists, msme_terms, verified_locked, gstin_required, company_required, role_required), `bank.change_needs_approval`, `bank.callback_required`, `bank.callback_note`, `price.above_mrp`, `hsn.missing`, `import.missing`, `import.locked`, `bug.missing`, `bug.closed`, `bug.bad_action`, `merge.same`, `backup.outside_india`.

## Edge Functions

| Function | Purpose | Status |
|---|---|---|
| `tally-bridge` | Device-key endpoint for the Tally bridge on the import computer (next batch + signed TBK URL, staged rows, done) | Code in `supabase/functions/tally-bridge`. **Not deployed** (owner's `supabase login`; import PC not chosen) |
| `admin-users` | Create a sign-in account (phone or email + password) and assign its role as the calling Admin; disable an account | Code in `supabase/functions/admin-users`. **Not deployed yet**: needs `supabase login` by the owner. See DEPLOYMENT_GUIDE. |


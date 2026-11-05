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

### Phase 3 staff app, WhatsApp admin, Help v1 (`20261103003200_staff_help_msg.sql`, built)

| Object | Contract |
|---|---|
| `hr.requests` (+ columns) | `leave_type` casual\|sick\|unpaid, `half_day`, `repay_months` 1–12, `needed_by`, `paid_in` cash\|bank. For the approver only; payroll still recovers what was actually given (`hr.cash_given`). |
| `api.submit_staff_request(crid, p)` (replaced) | Own request only (`app.my_person()`), locks the person row. Leave: dates required, a half day is one date (`staff.half_day`), leave type checked. Advance: amount > 0, pay back 1–12 months, needed-by not in the past (IST), cash or bank. Rule codes `staff.*`. |
| `api.staff_requests` (view, invoker; columns appended) | + `leave_type, half_day, repay_months, needed_by, paid_in`. |
| `api.staff_me()` (replaced, read) | Adds `person_id`, masked `phone_masked` / `bank_masked`, `language`, `join_date`, `pay_basis`, `kyc_done/kyc_needed`, and `payslips[]` = the person's own payslips of **posted** runs only (drafts never shown). Requests carry leave type, half day and the approver's note. |
| `api.upsert_template(crid, p)` | Admin only. New → draft v1; edit of a draft updates in place (row locked); edit of a submitted/approved template inserts a new draft version (approved one keeps working). Body `{{n}}` count must equal the parameter list (`msg.template_params`). Events `hr.*` may not carry ₹/amounts or salary/bank/KYC words or parameter names (`msg.staff_template_private`, §WA-7). |
| `app.consented_number(number)` | Admin only (null otherwise): `party:<name>` when a party contact with WhatsApp consent has the number, `staff:<name>` for an active staff member with their own sign-in. |
| `api.set_allow_list` (replaced) | Admin only. Number normalised to +91; adding requires `app.consented_number` (`msg.not_consented`); bad format `msg.bad_number`. |
| `api.msg_allow_list` (view, columns appended) | + `number_masked`, `belongs_to_kind`, `belongs_to`. |
| `api.msg_inbound` (view, invoker) | Received messages with `from_masked`, party, window expiry (RLS: Admin, or accounts of that company). |

Tests: `supabase/tests/11_staff_help.sql` (25).

## Phase 4: inventory and purchase (built)

Migrations: `20261103004000_inventory_core.sql`, `004100_inventory_api.sql`, `004200_transfers.sql`, `004300_purchase.sql`, `004400_inventory_purchase_views.sql`. All additive (one relaxation: `sales.documents.party_id` may be null **only** for `delivery_challan`, enforced by check `sales_documents_party_required`). Money `numeric(18,2)`, quantities `numeric(18,3)`, unit cost `numeric(18,4)`.

### Stock tables (`inv`, `prod`)

| Table | Key columns | Notes |
|---|---|---|
| `inv.lots` | company_id, product_id, lot_no (unique per company+item), supplier_lot_no, mfg_date, expiry_date, source `goods_receipt\|production\|opening\|return\|adjustment`, status `quarantine\|available\|hold\|rejected`, needs_test, grn_id, received_by/at, released_by/at | One row per batch. A GRN lot gets `lot_no` = given lot or `<GRN no>-<line>`. |
| `inv.stock_ledger` | id bigint, company_id, product_id, lot_id, place_id, bucket `available\|quarantine\|hold\|in_transit\|rejected`, qty (signed, ≠ 0), unit_cost, value, move_type, source_table, source_id, doc_no, move_date, note, negative_allowance_id, reverses_id, client_request_id, created_by | **Append-only** (update/delete/truncate refused by `app.reject_change`, errcode P0001); inserts only inside `app.stock_post` (else 42501 `stock.direct_write`). move_type: opening, receipt, issue, issue_in, return, release, reject, adjustment, transit_out, transit_in, transfer_in, transfer_return, write_off, scrap_in, regrind, scrap_sale, reversal. |
| `inv.stock_balances` | company_id, product_id, lot_id, place_id, bucket, qty, negative_allowance_id; unique nulls-not-distinct (company, item, lot, place, bucket) | Kept by `app.stock_post` in the same transaction. Check `qty >= 0 or negative_allowance_id is not null`. Direct writes refused (42501). |
| `inv.negative_stock_allowances` | company_id, product_id, place_id (null = every place), reason (≥ 5 chars), valid_from/to, granted_by, revoked_at/by, revoke_reason | Admin (`settings.manage`) only; logged in `audit.user_log` (`setting_changed`). |
| `inv.negative_stock_uses` | allowance_id, ledger_id, company_id, product_id, place_id, qty_after, used_by, at | Append-only; one row per movement that left a balance below zero (+ `admin_action` user-log event). |
| `inv.reservations` | company_id, product_id, lot_id, place_id, qty, source_table, source_id, source_line_id, status `active\|consumed\|released` | Transfers reserve at `reserve_transfer`; `app.stock_take` refuses to take reserved stock for anything else (`stock.reserved`). |
| `inv.reorder_levels` | company_id, product_id, place_id (null = company level), min_qty, reorder_qty, max_qty | `api.item_stock.below_reorder` uses the company-level row. |
| `inv.cycle_counts` | company_id, place_id, doc_no (`CNT/…`), count_date, blind, status `counting\|submitted\|posted\|cancelled`, submitted_by, approved_by (≠ submitted_by) | |
| `inv.count_lines` | count_id, product_id, lot_id, bucket, system_qty (frozen at start), counted_qty, counted_by/at, reason | System quantity hidden in `api.stock_count_lines` while a blind count is open. |
| `inv.stock_issues` | company_id, doc_no (`ST/…`), kind `issue\|return`, product_id, lot_id, from_place_id, to_place_id, qty, target_kind `production\|cost_centre\|batch\|job\|maintenance\|other`, target_ref, cost_centre, against_issue_id, bucket, reason, issue_date | Append-only. |
| `inv.scrap_sales` | company_id, sales_document_id (unique; a posted `sales_invoice`), place_id, slip_path, qty, sold_by | Append-only; stock out once per invoice. |
| `inv.transfers` | company_id, doc_no (`TR/…`), transfer_date, from/to_place_id, from/to_gstin_id, gst_doc_kind `delivery_challan\|tax_invoice` (= same GSTIN or not, checked), sales_document_id, status (see state machine), needed_by, note, vehicle_no, carrier_name, requested_by, approved_by, reserved_by, picked_by, handed_over_at, carried_by, dispatched_at, received_by, witness_by, reconciled_by, closed_by, cancelled_by + timestamps, cancel_reason | Checks: approved_by ≠ requested_by; carried_by ≠ picked_by; received_by ≠ picked_by; witness_by ≠ received_by; closed_by ∉ {picked_by, carried_by}. No delete. |
| `inv.transfer_lines` | transfer_id, line_no, product_id, lot_id, qty_requested, qty_approved, note | |
| `inv.transfer_items` | transfer_id, line_id, product_id, lot_id, qty_dispatched, qty_accepted, qty_quarantined, qty_returned, qty_lost, **qty_in_transit (generated = dispatched − accepted − quarantined − returned − lost)**, unit_cost, counted_by/at | Check `transfer_items_balance`: in transit never below zero. |
| `inv.transfer_events` | transfer_id, action, from_status, to_status, actor, detail jsonb, at | Append-only history of every step. |
| `prod.lab_tests` | company_id, lot_id, kind `incoming`, result `pass\|fail\|hold`, parameters jsonb, remarks, test_date, tested_by | Append-only. Extended in Phase 5. |
| `prod.regrind_entries` | company_id, entry_date, kind `scrap_in\|regrind_reuse`, product_id (an `is_scrap` item), source_product_id, place_id, qty, machine, mould, shift, note, recorded_by | Append-only. |

Item flags (additive on `master.products`): `needs_incoming_test boolean` (GRN → quarantine), `is_scrap boolean`.

### Purchase tables (`purch`)

| Table | Key columns | Notes |
|---|---|---|
| `purch.requests` | company_id, doc_no (`PR/…`), request_date, department, for_job, needed_by, reason, attachment_path, est_total, status `draft\|submitted\|approved\|refused\|ordered\|closed\|cancelled`, requested_by, decided_by (≠ requested_by), decided_at, decision_note | |
| `purch.request_lines` | request_id, line_no, product_id (optional), description, qty, uom, est_rate, suggested_party_id, note | |
| `purch.rfqs` / `purch.rfq_lines` / `purch.rfq_suppliers` | rfq: doc_no (`RFQ/…`), rfq_date, request_id, due_date, status `open\|closed\|cancelled`; lines: product_id, description, qty, uom, request_line_id | |
| `purch.quotations` / `purch.quotation_lines` | quotation: rfq_id, party_id (unique per RFQ), quote_ref, quote_date, valid_until, terms_days, delivery_days, status `received\|selected\|rejected`; lines: rfq_line_id, qty, rate, discount | |
| `purch.orders` | company_id, gstin_id, doc_no (`PO/…`, null while draft), party_id, request_id, quotation_id, order_date, delivery_date, place_id, place_of_supply, terms_days, msme, taxable, cgst, sgst, igst, round_off, total, status `draft\|issued\|confirmed\|part_received\|received\|closed\|cancelled`, price_flags jsonb, price_rise_accepted_by, created_by, issued_by/at, confirmed_at, cancelled_at, cancel_reason | Check: `not msme or terms_days <= 45`. Tax from `app.compute_tax` (HSN table by date). |
| `purch.order_lines` | order_id, line_no, product_id, description, hsn_code, uom, qty, rate, discount, taxable, gst_rate, cgst, sgst, igst, total, qty_received, request_line_id | |
| `purch.goods_receipts` | company_id, gstin_id, doc_no (`GRN/…`), party_id, order_id, place_id, receipt_date, supplier_invoice_no/date, eway_bill_no, vehicle_no, direct_purchase, approved_by, status, notes, received_by | Check: an order, or a direct purchase with approver. No delete. |
| `purch.grn_lines` | grn_id, line_no, order_line_id, product_id, qty, uom, rate, lot_id, supplier_lot_no, bucket `quarantine\|available`, qty_accepted, qty_rejected | No delete. |
| `purch.bill_captures` | company_id, photo_path (bucket `bills`, `<company_id>/<file>`), source `phone\|whatsapp\|email\|pdf\|upload`, status `uploaded\|read\|matched\|mismatch\|drafted\|posted\|rejected`, extracted jsonb, party_id, order_id, grn_id, bill_id, match_result jsonb, uploaded_by/at, read_at, matched_by/at, reject_reason | |
| `purch.price_history` | company_id, product_id, party_id, rate (per unit after discount, before GST), qty, uom, source `bill\|order`, source_id, rate_date | Append-only. Order rates at issue; bill rates when a purchase bill posts (trigger `purchase_bill_posted`). |
| `purch.bills` (+ columns) | order_id, grn_id, capture_id | Phase 3 table, linked additively. |

Storage: private bucket `bills` (20 MB). Read needs `purchase.view` or `purchase_bills.view`, upload needs `purchase.create` or `purchase_bills.create`, **for the company in the first folder of the path** (`app.storage_company(name)`).

WhatsApp templates (drafts; Meta approval is the owner's step): `po_issued` (event `purchase.po_issued`: supplier, doc_no, delivery_date, company) and `payment_advice` (event `purchase.payment_advice`: supplier, amount, doc_no, bills, company).

### Helpers (`app`)

| Helper | Contract |
|---|---|
| `app.stock_post(company, product, lot, place, bucket, qty, move_type, source_table, source_id, doc_no, date, unit_cost?, note?) → ledger id` | The only writer of stock. Transaction advisory lock on (company, item, place) + `FOR UPDATE` on the balance row; refuses below zero (`stock.insufficient`, P0001) unless `app.negative_allowance` returns an allowance (then logs the use). Checks place company (`stock.place_other_company`) and lot (`stock.lot_mismatch`). |
| `app.stock_take(company, product, lot, place, bucket, qty, move_type, source_table, source_id, doc_no, date, note?, own_reservation?) → [{lot_id, qty, unit_cost}]` | Takes from the given lot or earliest expiry first; refuses stock reserved for others (`stock.reserved`). |
| `app.avg_cost(company, product)` | Weighted average from the ledger (valuation method is an open CA question). |
| `app.negative_allowance(company, product, place)` | Active allowance id or null. |
| `app.internal_doc_no(company, doc_type, date)` | Non-GST numbering (PR, RFQ, PO, GRN, TR, ST, CNT); creates the FY series on first use. |
| `app.check_stock_date(company, date)` | Future date refused, back-date setting, FY and closed month. |
| `app.transfer_challan(transfer, date)` / `app.check_transfer_invoice(transfer, doc)` | GST document for a transfer (see below). |
| `app.order_price_flags(order)` | Lines dearer than the last rate (threshold setting `purchase.price_alert_pct`; unset = every increase). |
| `app.last_rate`, `app.setting_num`, `app.storage_company` | |

### State machines

- **Transfer:** `requested` →(approve, another person)→ `approved` →(reserve, `inventory.edit`)→ `reserved` →(pick, `transfer.pick`)→ `picked` →(hand over: picker)→ `handed_over` →(hand over: carrier, another login; stock `available` at source → `in_transit` at destination; challan or invoice)→ `in_transit` →(blind receipt, not the picker; a carrier who receives needs a witness)→ `received` →(reconcile: found/returned, `transfer.approve`; finance write-off with `transfer.write_off`)→ `reconciled` (nothing in transit) →(close, never picker or carrier)→ `closed`. `cancelled` from any state before `in_transit` (reservations released). Balance rule: dispatched = accepted + quarantined + returned + approved loss + in transit; close needs in transit = 0 (`transfer.unbalanced`).
- **GST for transfers (AGENTS rule 7):** same GSTIN → a posted `delivery_challan` in `sales.documents` (no party, `tax_class = without_gst`, `lawful_reason = challan_not_sold`, numbered from the GSTIN's `delivery_challan` series) made at dispatch. Other GSTIN → dispatch refused until a **posted tax invoice** from the sending GSTIN, billed to a party whose GSTIN is the receiving GSTIN, with IGST when the states differ and covering every dispatched item, is linked (`transfer.invoice_*`).
- **Lot:** `quarantine` →(test pass by someone other than the receiver; release by someone other than the receiver)→ `available`; `quarantine` →(test fail; reject)→ `rejected`.
- **Purchase request:** `draft` → `submitted` → `approved`/`refused` (another person, approval limits `core.approval_limits` doc_type `purchase_request` when set) → `ordered` (when its PO is issued).
- **PO:** `draft` →(issue: `purchase.approve`, not the drafter, price increase accepted)→ `issued` → `confirmed` → `part_received` / `received` (by GRNs); `cancelled` before any receipt.
- **Bill capture:** `uploaded` → `read` (fields set) → `matched` / `mismatch` → `drafted` (purchase bill draft; mismatch only by Admin) → `posted` (when the bill posts); `rejected`.
- **Cycle count:** `counting` → `submitted` → `posted` (by someone who neither counted nor submitted; differences become `adjustment` movements) / `cancelled`.

### Events to `msg.outbox`

`purchase.po_issued` (issue_purchase_order; doc_type `purch.orders`, stage `issued`) and `purchase.payment_advice` (post_payment to a supplier; doc_type `acct.vouchers`, stage `payment_advice`). Through `app.enqueue_message`: status `queued` only for a party contact with a WhatsApp number **and consent**; otherwise one `skipped` row with `skip_reason` (`no verified WhatsApp number` / `no consent recorded`) is kept as the record. Idempotency key = doc + stage + number, so a retry queues nothing new.

### Rights seeded

New: `transfer.view/create/approve/pick/carry/receive/close`, `transfer.write_off` (special, finance), `qc.test`, `qc.release`. Role mapping (existing roles): buyer_logistics (purchase view/create/edit, inventory.view, transfer view/create/carry, purchase_bills.view); factory_manager (inventory view/create/edit/approve, purchase view/approve, transfer view/approve/close); finance_head (inventory/purchase view, purchase.approve, transfer view/write_off/close, purchase_bills view/create); accountant (transfer.view); md, gm (view + purchase.approve + transfer.approve); production_manager (inventory view/create, purchase view/create, transfer view/create/receive); injection_manager, mould_manager, assembly (inventory view/create, purchase view/create); supervisor (inventory view/create, transfer view/pick); factory_staff (transfer view/pick); qc_releaser, quality (inventory.view, qc.test, qc.release); chemist (qc.test); shop_staff (transfer view/create/receive, inventory.view); sales_manager (transfer view/approve, inventory.view); driver (transfer view/carry).

### RLS

RLS on every new table; select only (all writes through `api` RPCs). Stock tables: `inventory.view` (lots also purchase.view / qc.*; transfers also `transfer.view`); purchase tables: `purchase.view` (requests also the requester; orders/GRNs also `inventory.create`/`inventory.view`; captures also `purchase_bills.view` or the uploader; price history also `purchase_bills.view`). Cost and value columns in views show only with `cost.view`.

### Law register

`MSME-1` → built (test `13_purchase.sql`); `GST-3` enforced_in updated for transfers (challan / IGST invoice); new `STK-1` (no negative stock without a logged allowance).

### Tests

`supabase/tests/12_inventory.sql` (50), `supabase/tests/13_purchase.sql` (45); `scripts/concurrency-check.mjs` (two real connections race for the last unit). **250/250 pgTAP pass in total.**


## Phase 5: production (database built; screens next)

Migrations: `20261103005000_production_core.sql` (tables, guards, RLS, rights), `005100_production_biochem_api.sql`, `005200_production_plastics_api.sql`, `005300_production_views.sql`. All additive. Widened (non-destructive): `inv.stock_ledger.move_type` adds `consumption` and `production_in`; `prod.lab_tests.kind` adds `in_process|bulk|finished|retained|stability|rnd|component` and `lot_id` became nullable (a test belongs to a lot, a batch or a sample). `app.internal_doc_no` gains prefixes `BT` (batch), `QC` (lab sample), `SH` (injection shift), `AS` (assembly order), `PK` (pack assembly), `PP` (pad print). The Phase 4 `api.record_incoming_test / release_from_quarantine / reject_from_quarantine` now refuse production lots (`qc.use_batch_release`) so the self-release block cannot be bypassed.

Decisions (also in `ERP_ARCHITECTURE.md`): one asset register `core.assets` for both companies (no separate `prod.machines` / `prod.instruments`: lab instruments are `kind = lab_instrument`, injection machines `kind = injection_machine`); bulk is work in progress on the batch (not a stock item); finished goods are valued at material + packaging cost at packing, the full batch cost (labour, machine, overhead) is on the cost sheet.

### Tables

| Table | Key columns | Notes |
|---|---|---|
| `core.licences` | company_id, branch_id (null = every branch), kind `cosmetics_manufacturing\|drug_manufacturing\|factory\|pollution_consent\|fire\|trade\|fssai\|legal_metrology\|other`, licence_no, issued_by, valid_from, valid_to, status `active\|suspended\|cancelled`, document_path, note | Admin (`settings.manage`) only; numbers never invented. Read: anyone who can see the company. |
| `core.assets` | company_id, code (unique per company), name, kind `mixer\|scale\|filling\|soap_line\|lab_instrument\|injection_machine\|pad_printer\|assembly_station\|compressor\|chiller\|utility\|vehicle\|it\|other`, place_id, make, model, serial_no, attrs jsonb, purchase_date, put_to_use_date, cost (18,2), useful_life_years, residual_pct (Schedule II, set with the CA), needs_calibration, calibration_interval_days, calibration_due, amc_vendor, amc_until, status `active\|repair\|out_of_service\|disposed` | Place, status and calibration change only through events / calibrations / machine checks. |
| `core.asset_events` | id bigint, asset_id, kind `added\|moved\|repair\|service\|amc\|breakdown\|restored\|disposed\|note`, event_date, detail jsonb, amount | **Append-only.** |
| `core.asset_documents` | asset_id, kind `invoice\|warranty\|amc\|manual\|calibration_certificate\|photo\|other`, path, valid_to | |
| `prod.calibrations` | id bigint, asset_id, calibrated_on, next_due, result `pass\|adjusted\|fail`, agency, certificate_path, remarks | **Append-only.** Fail → asset `out_of_service`. |
| `prod.process_families` | company_id, code, name, licence_kind (null = no licence needed), steps jsonb (route), status | |
| `prod.formulas` | company_id, product_id (finished item), family_id, code (unique per company), name | |
| `prod.formula_versions` | formula_id, version, status `draft\|submitted\|approved\|superseded\|withdrawn`, batch_size (kg), fill_qty_g (bulk per pack; else the item's net quantity in g/kg), qc_spec jsonb `[{parameter, min, max, unit, stage}]`, effective_from/to, created_by, submitted_by, approved_by (≠ creator and ≠ submitter, check) | Approved/superseded versions cannot change (trigger `formula.not_draft`). |
| `prod.formula_lines` | version_id, line_no, line_kind `bulk\|packaging`, product_id, qty (bulk: kg per batch_size, item uom must be KGS; packaging: Nos per pack, count uom) | Only draft versions' lines can change. |
| `prod.batches` | company_id, batch_no (`BT/…`), product_id, formula_version_id, family_id, licence_id, line_place_id, stores_place_id, fg_place_id, batch_date, shift, planned_qty (kg), status (state machine), bulk_qty, bulk_scrap_kg, bulk_left_kg, fill_qty_g, good_packs, rejected_packs (whole), fg_lot_id, mfg_date, expiry_date, labour_hours, machine_hours, recon_status `pending\|balanced\|mismatch`, basis_locked, planned_by, started_by, packed_by, released_by, closed_by (+ _at), reject_reason | |
| `prod.batch_events` | id bigint, batch_id, from_status, to_status, note, by_user, at | **Append-only.** |
| `prod.weighings` | batch_id, product_id, lot_id, planned_qty, weighed_qty, scale_asset_id, status `weighed\|verified\|rejected`, weighed_by, verified_by (≠ weighed_by, check) | Stock leaves the stores only at verification. |
| `prod.material_consumption` | id bigint, company_id, source_table, source_id, batch_id, kind `bulk_material\|packaging\|free_item\|pack_item\|component\|granule\|ink\|other`, product_id, lot_id, place_id, qty, unit_cost, value, consumed_on, reverses_id | **Append-only** consumption ledger (mirrors the stock ledger's `consumption` rows). |
| `prod.batch_packaging_issues` | id bigint, batch_id, product_id, qty, issued_by | **Append-only.** |
| `prod.packaging_recon` | batch_id, product_id (unique), issued, in_good, in_rejected, scrapped, returned, at_line, **difference (generated = issued − in_good − in_rejected − scrapped − returned − at_line)** | |
| `prod.lab_samples` | company_id, sample_no (`QC/…`), kind `in_process\|bulk\|finished\|retained\|rnd`, batch_id, lot_id, trial_id, assigned_to, status `pending\|tested\|retained\|disposed`, retain_until | |
| `prod.lab_tests` (extended) | + batch_id, sample_id, instrument_id, out_of_spec jsonb | Append-only (Phase 4 trigger). |
| `prod.rnd_trials` | company_id, code, title, family_id, formula_version_id, assigned_to, status `planned\|running\|stability\|passed\|failed\|dropped`, started_on | |
| `prod.stability_checks` | trial_id, day_no, condition, due_on, result `pass\|fail\|watch`, observations | unique (trial, day, condition). |
| `prod.shift_assignments` | company_id, place_id, work_date, shift `day\|night\|general`, user_id, duty `batch_maker\|weigher\|weigh_checker\|packer\|labour\|supervisor\|qc_tester\|qc_releaser\|rnd\|operator\|helper\|inspector\|assembler\|printer`, batch_id, asset_id, hours | One person can hold several duties. |
| `prod.packs` | company_id, product_id (the pack), kind `free_item_pack\|gift_pack\|combo_pack`, name, gst_treatment (null = not set) `free_with_sale_single_price\|gift_without_consideration\|mixed_supply\|composite_supply`, gst_treatment_note, set_by/at, status | Q-23: no billing until set. |
| `prod.pack_items` | pack_id, product_id, qty, is_free | |
| `prod.pack_assemblies` | doc_no (`PK/…`), pack_id, qty, from/to_place_id, unit_cost, assembly_date | |
| `prod.cost_rates` | company_id, kind `labour_hour\|machine_hour\|overhead_per_kg\|overhead_per_piece`, rate (18,2), effective_from | Admin only; never invented. |
| `prod.batch_costs` | batch_id (unique), materials, packaging, labour, machine, overhead, total, good_packs, cost_per_pack, rates_missing text[] | Fixed at close. |
| `prod.mould_projects` | code, name, product_id, ownership `own\|buyer`, buyer_party_id, stage `design\|trial\|approval\|approved\|dropped`, target_date, estimated_cost, approved_by (≠ created_by) | |
| `prod.moulds` | code, name, project_id, product_id, material_product_id, cavities (> 0), cycle_time_sec (> 0), part_weight_g, runner_weight_g, ownership, buyer_party_id, location `rack\|machine\|repair\|buyer\|other`, place_id, machine_asset_id, shot_count, shots_at_last_service, service_interval_shots, life_shots, cost, status `active\|repair\|retired` | |
| `prod.mould_events` | id bigint, mould_id / project_id, kind `created\|stage\|moved\|mounted\|unmounted\|service\|repair\|shots\|retired`, event_date, detail, shots, amount, source_id | **Append-only.** |
| `prod.injection_shifts` | doc_no (`SH/…`), place_id, output_place_id, shift_date, shift, machine_asset_id, mould_id, product_id, operator_user_id / operator_name, cavities_running, cycle_time_sec (standard, from the mould), planned_minutes, downtime_minutes, run_minutes, shot_start/end, shots, good_qty, reject_qty, theoretical_qty, availability, performance, quality, oee (9,4), lot_id | KPIs per `KPI_DEFINITIONS.md`. |
| `prod.shift_rejects` / `prod.downtime` | shift_id, reason, qty / shift_id, kind `setup\|mould_change\|breakdown\|no_material\|no_operator\|power\|quality\|other`, reason, minutes | |
| `prod.quality_inspections` | lot_id, shift_id, assembly_order_id, kind `first_piece\|patrol\|final\|assembly`, sample_qty, accepted_qty, rejected_qty, result, defects, inspected_by | **Append-only.** |
| `prod.assembly_boms` / `prod.assembly_bom_lines` | product_id, version, status `draft\|approved\|superseded`, approved_by (≠ created_by) / bom_id, product_id, qty_per | |
| `prod.assembly_orders` | doc_no (`AS/…`), bom_id, product_id, qty, from/to_place_id, lot_id, unit_cost, labour_hours, order_date | |
| `prod.pad_print_jobs` | doc_no (`PP/…`), job_date, product_id, machine_asset_id, operator_user_id, qty_printed, qty_rejected, prints_per_piece, ink_product_id, ink_qty, ink_place_id, ink_value, labour_minutes | |
| `prod.material_specs` | product_id (component, unique per company), granule_product_id, grade, colour, masterbatch_product_id, masterbatch_pct, part_weight_g, runner_weight_g, cavities, packing_cost_per_piece | |
| `prod.machine_checks` | asset_id, check_date, shift, checklist jsonb `[{item, ok, note}]`, all_ok, remarks, checked_by | **Append-only.** A failed item sets the asset to `repair`. |

### Helpers (`app`)

`app.check_licence(company, family, place, date) → licence id` (refuses `licence.missing` / `licence.expired`); `app.lock_batch(batch, right, states[], licence)`; `app.batch_event`; `app.check_instrument(company, asset, date)` (`asset.calibration_due`, `asset.not_in_use`); `app.current_formula_version(company, product, date)`; `app.fill_g(version, product)`; `app.batch_makers(batch) → uuid[]`; `app.qc_out_of_spec(spec, params, stage)`; `app.batch_recon(batch) → jsonb` (writes recon_status, opens/fixes the Bug fixer item `prod.recon:<batch>`); `app.batch_cost(batch) → jsonb`; `app.cost_rate(company, kind, date)`; `app.record_consumption(...)`; `app.apply_packaging_counts`; `app.can_prod(company)`, `app.can_lab(company)`.

### State machines

- **Batch:** `planned → reserved → weighed → in_process → sample_sent → bulk_passed | bulk_failed`; `bulk_passed → packing → packed_hold → released | rejected`; `bulk_failed → rejected`; `released | rejected → closed`; `planned | reserved → cancelled`. Exposed as `api.batch_states`.
- **Formula version:** `draft → submitted → approved → superseded` (by a later approved version) or `withdrawn`.
- **Mould project:** `design → trial → approval → approved`, or `dropped` from any open stage.
- **Assembly BOM:** `draft → approved → superseded`.

### Rules enforced

Licence block on plan and every production entry; approved formula in force on the batch date; bulk lines in kg only, packaging and packs in Nos only; second-person weighing check; scale / instrument calibration; QC limits on a pass; packaging reconciliation (exact) and bulk reconciliation (setting `production.bulk_loss_pct` per company; **unset = exact**); difference → Bug fixer item and close refused; finished goods into quarantine; QC release only with a passed bulk test and a passed finished test, never by a batch maker (`app.batch_makers`); work assignment conflict check; pack GST treatment before billing (trigger `pack_billing_guard` on `sales.document_lines`); moulding lots released only by an inspector who did not make or record them; assembly refuses when any component is short.

### Rights seeded

New: `lab.rnd`, `assets.view`, `assets.manage`. Module rights `production.view/create/edit/approve` given to production_manager, chemist (view/create + lab.rnd), qc_releaser (view), supervisor, factory_staff (view/create), mould_manager, injection_manager (view/create/edit + assets), assembly, machine_operator (view/create), quality (view), factory_manager (view/edit/approve + assets), md, gm, finance_head (view). Costs need `cost.view`; cost rates, licences and pack GST treatment need `settings.manage` (Admin).

### RLS

On for every new table; reads only (writes through the RPCs). Production tables: `production.view`; lab tables, batches, formulas: `app.can_lab` (production.view or qc.test or qc.release or lab.rnd); assets/calibrations: `assets.view` or lab; licences: `app.can_read_company`; cost tables: `cost.view`; shift assignments: also your own rows.

### Law register

`COS-1` → built; new `PROD-1` (self-release block), `PROD-2` (reconciliation), `GST-FREE` (needs CA, Q-23).

### Tests

`supabase/tests/14_production_biochem.sql` (63), `supabase/tests/15_production_plastics.sql` (39); `_setup.sql` gains `tests.seed5` and `tests.hint` (returns the rule code). **352/352 pgTAP pass in total.**


## Phase 6: delivery and sales (database built; screens next)

Migrations: `20261103006000_sales_core.sql` (tables, guards, RLS, rights, settings, storage), `006100_orders_credit_logistics.sql`, `006200_field_sales.sql`, `006300_care_shops_exports_online.sql`, `006400_gst_schedule3.sql`, `006500_msg_help_phase6.sql`, `006600_phase6_views.sql`. All additive. Widened (non-destructive): `inv.stock_ledger.move_type` adds `dispatch`, `dispatch_return`, `sale`, `qc_hold`, `qc_release`. New nullable/defaulted columns: `master.party_companies.credit_status` (`none|active|hold|review`, default none), `credit_review_on`, `price_list_id`; `msg.inbound.task_id`. New schema `field` (private, RLS). Doc types `dispatch` (DL), `trip` (TRIP), `complaint` (CMP), `export_order` (EXP), `credit_application` (CR); `sales_order` (SO) existed. Numbers through `app.p6_doc_no` (series created on first use).

Settings seeded (business defaults stated in the prompt, changeable by Admin; no legal thresholds invented): `field.geofence_m` = 150, `field.gps_retention_days` = 90, `salesman_balance_scope` = `"gst_only"` (Q-12 reading b), `msg.reminder_days` = `[-7,-3,0,3,7,14]`. Read but **not seeded** (Admin/CA sets): `sales.salesman_discount_pct` (unset = 0, any discount needs the office), `eway.threshold_amount` (unset = every dispatch needs an e-way bill number), `gst.b2cl_invoice_value` (unset = all unregistered invoices in B2CS), `msme.selling_rule` (Phase 2).

### Tables

| Table | Key columns | Notes |
|---|---|---|
| `sales.orders` | company_id, gstin_id, doc_no (`SO/…`), order_date, delivery_date, party_id, place_of_supply, channel `direct\|field\|shop\|online\|export\|private_label`, payment `credit\|cash\|advance`, salesman_user_id, place_id (dispatch from), price_list_id, buyer_po_no/date, taxable/cgst/sgst/igst/round_off/total (18,2, from `app.compute_tax`), status, credit_check jsonb, credit_exception_id, private_label_id, export_order_id, online_order_id, created_by, confirmed_by/at, cancelled_by/at/reason, device_created_at, **client_request_id unique** | No delete. Offline orders keep the phone's time in device_created_at. |
| `sales.order_lines` | order_id, line_no, product_id, description, hsn_code, uom, qty (18,3), rate, discount, taxable, gst_rate, cgst, sgst, igst, total, qty_dispatched, qty_delivered, qty_invoiced | check dispatched/invoiced ≤ qty |
| `sales.order_documents` | order_id, document_id (unique, `sales.documents`), dispatch_id, linked_by/at | Which posted GST document bills which order and dispatch |
| `sales.credit_applications` | company_id, doc_no (`CR/…`), party_id, requested_limit, requested_term_id, expected_monthly, security, note, stage 2–7 (stage awaiting decision), status `in_progress\|active\|rejected\|withdrawn`, decided_limit, decided_term_id, review_on, reject_reason, requested_by | One in progress per customer and company |
| `sales.credit_approvals` | application_id, stage 3–6 (unique per application), decision, limit_amount, term_id, note, decided_by/at | **Append-only** |
| `sales.credit_exceptions` | company_id, party_id, order_id, amount > 0, valid_until (> granted_at), reason (≥ 5), requested_by, granted_by (≠ requested_by, check), revoked_at/by | MD exception; live while `now() < valid_until` and not revoked |
| `sales.promises_to_pay` | company_id, party_id, amount, promised_on, note, status `open\|kept\|broken`, recorded_by, client_request_id | |
| `ops.vehicles` | company_id, reg_no (unique, `KL08AB1234` form), kind, ownership `owned\|hired`, transporter, payload_kg, usual_driver_user_id, place_id (van stock place), status `active\|repair\|inactive` | |
| `ops.vehicle_documents` | vehicle_id, kind `rc\|insurance\|fitness\|permit\|puc\|road_tax\|fastag`, doc_no, valid_to, path, set_by/at | History kept; the latest per kind counts. An expired one blocks trips (Admin may override) |
| `ops.vehicle_events` | company_id, vehicle_id, kind (fuel, repair, service, emi, insurance, tax, toll, parking, bata, loading, washing, tyre, accident, fine, other), event_date, odometer_km, litres, amount, trip_id, paid_by, note | **Append-only** vehicle file |
| `sales.dispatches` | company_id, doc_no (`DL/…`), order_id, party_id, place_id, scheduled_at, status `planned\|dispatched\|delivered\|part_delivered\|failed\|cancelled`, trip_id, document_id (posted invoice), eway_bill_no, value, dispatched_at, delivered_at | No delete |
| `sales.dispatch_lines` | dispatch_id, order_line_id, product_id, qty, qty_delivered, qty_returned, short_reason `damaged\|rejected\|short_loaded\|not_available\|other`, lots jsonb (`[{lot_id, qty, unit_cost}]` taken at dispatch) | delivered + returned ≤ qty |
| `sales.trips` | company_id, doc_no (`TRIP/…`), trip_date, vehicle_id or transporter (one required), driver_user_id, lr_no, status `planned\|started\|closed\|cancelled`, odometer_start/end, started_by/at, closed_by/at | |
| `sales.trip_stops` | trip_id, seq, dispatch_id (unique), status `pending\|arrived\|delivered\|part_delivered\|failed`, arrived_at, done_at, fail_reason | |
| `sales.pods` | company_id, stop_id (unique), dispatch_id, received_by_name, receiver_phone_last4 (masked), signature_path, photo_paths[] (private bucket `pod`, first folder = company id), lat, lng, remarks, device_at, recorded_by | **Append-only** except the GPS purge clearing lat/lng (`app.reject_change_except_purge`) |
| `field.beats` / `field.beat_customers` | company_id, code, name, salesman_user_id, weekday 1–7 (ISO), active / beat_id, party_id, seq | Customer ↔ salesman assignment is `master.party_companies.salesman_user_id` |
| `field.duty_sessions` | company_id, user_id, kind `salesman\|driver`, notice_ack_at (required), started_at, ended_at, client_request_id | One open per user (partial unique index). GPS only inside an open session |
| `field.gps_points` | company_id, user_id, session_id, at, lat, lng, accuracy_m, source `ping\|check_in\|check_out\|pod` | Deleted after 90 days by `app.purge_gps` |
| `field.visits` | company_id, salesman_user_id, party_id, beat_id, session_id, planned, unplanned_reason, check_in_at/lat/lng, distance_m, geofence_ok, out_of_fence_reason, approval `none\|pending\|approved\|refused`, approved_by (≠ salesman, check), check_out_at/lat/lng/distance_m, outcome `order\|no_order\|collection\|follow_up`, no_order_reason, shelf jsonb, competitor_notes, photo_paths[], next_visit_on, client_request_id | Out of fence needs a reason (check). Coordinates cleared after 90 days |
| `field.collections` | company_id, salesman_user_id, party_id, voucher_id (receipt), amount, mode `cash\|cheque\|upi\|bank`, reference, cheque_photo_path (required for cheque), handover_id, visit_id, collected_at, client_request_id | No delete. Cash is "with me" until a handover |
| `field.cash_handovers` | company_id, salesman_user_id, cashier_user_id (≠ salesman), handover_date, expected_cash, salesman_count jsonb (denomination → count), salesman_total, cashier_count, cashier_total, cheques, difference, status `pending\|confirmed\|mismatch\|resolved`, to_account_id, contra_voucher_id, bug_item_id, resolved_by (≠ salesman), resolution_note | No delete |
| `field.day_closes` | company_id, user_id, close_date (unique per user/company/day), session_id, visits_planned, visits_done, orders_total, collections_total, handover_id, van_counts | |
| `field.queries` | company_id, party_id, kind `product_complaint\|billing\|delivery\|price_scheme\|return\|other`, document_id, lot_id, description, photo_paths[], status `open\|in_progress\|answered\|closed`, raised_by, assigned_to, next_step, reply, complaint_id, client_request_id | A product complaint also opens `sales.complaints`; an open billing query pauses reminders for that bill |
| `sales.coverage_tiers` | (company_id, tier) pk, call_every_days, visit_every_days, grace_days | No defaults seeded (the design's values are "for approval") |
| `sales.contact_attempts` | company_id, party_id, kind `call\|visit`, outcome `reached\|no_answer\|deferred`, note, next_action, visit_id, by_user, at | **Append-only** (history does not move when a customer is reassigned) |
| `sales.complaints` | company_id, doc_no (`CMP/…`), party_id, document_id, product_id, lot_id, kind, description, severity, status `logged\|investigating\|on_hold\|resolved\|closed\|rejected`, logged_by, assigned_to, qc_hold_id, resolution, closed_by (≠ logged_by, check), closed_at | |
| `sales.complaint_events` | complaint_id, from_status, to_status, note, by_user, at | **Append-only** |
| `inv.qc_holds` | company_id, lot_id (one open hold per lot), complaint_id, reason, status `on_hold\|released\|rejected`, qty_held, previous_lot_status, held_by/at, decided_by/at, decision_note | |
| `sales.private_label_orders` | company_id, party_id, brand_name, spec, artwork_path, status `submitted\|approved\|rejected`, created_by, sales_/quality_/md_approved_by (each ≠ creator), rejected_by, reject_reason | |
| `sales.agents` / `sales.agent_customers` / `sales.agent_commissions` | company_id, party_id, model `A–D`, commission_pct / agent_id, party_id, from_date / agent_id, voucher_id, document_id (unique triple), collected, commission, period_from/to | Commissions **append-only** |
| `sales.shops` / `sales.shop_days` | company_id, branch_id (unique, kind shop), place_id, walk_in_party_id, cash_account_id, bank_account_id, price_list_id / shop_id, day (unique), expected_cash, counted jsonb, counted_cash, upi_total, card_total, bills, difference, status `closed\|mismatch`, bug_item_id | |
| `sales.export_orders` / `sales.containers` / `sales.export_invoices` | company_id, doc_no (`EXP/…`), party_id (overseas), currency, fx_rate numeric(12,4), incoterm, port_of_loading, destination, lut_ref, lut_valid_to, lines jsonb `[{product_id, qty, rate_fc}]`, status / export_order_id, container_no (ISO 6346 format + check digit), seal_no, packing_list, loaded, check_status `pending\|matches\|mismatch`, check_result / document_id pk, export_order_id, currency, fx_rate, value_fc, lut, shipping_bill_no/date, port_code | |
| `sales.online_channels` / `sales.listings` / `sales.online_orders` | company_id, code `shopify\|amazon\|flipkart\|jiomart\|meesho`, gstin_id, party_id, place_id, tcs_applicable, status / channel_id, product_id (unique pair), title, price, status `draft\|listed\|paused`, blockers[] / channel_id + external_order_id (unique), order_date, ship_state, payload, order_id | |
| `acct.schedule3_lines` | code pk, statement `bs\|pl`, side, section, label, sort | Schedule III Division I line items seeded (structure only) |
| `acct.schedule3_map` | account_group_id pk, company_id, line_code, set_by/at, ca_confirmed, ca_note, confirmed_by/at | Changing a line clears the CA confirmation |
| `msg.cost_caps` | company_id pk, monthly_cap (18,2), alert_pct (default 80) | Admin |
| `msg.message_rates` | category, est_cost numeric(18,4), effective_from | Admin enters the provider's price; none seeded |
| `msg.cost_alerts` | (company_id, month, level `alert\|cap`) pk | One alert row per level per month |
| `msg.tasks` | company_id, kind `payment_proof\|reply_needed\|send_failed`, party_id, inbound_id, priority, status `open\|done\|dismissed`, due_at, assigned_user_id (customer's salesman), note, resolved_by/at | |

Storage (private, first folder = company id via `app.storage_company`): `pod` (write `trip.drive` or `logistics.edit`; read `logistics.view`/`sales.view`/owner), `field` (write `field.sell`/`sales.create`; read `field.manage`/`sales.view`/owner).

### Helpers (`app`)

`app.p6_doc_no(company, doc_type, date)`; `app.distance_m(lat1, lng1, lat2, lng2)` (haversine, metres, 0.1 m); `app.child_crid(crid, tag)` (derived idempotency id for nested Phase 3 calls); `app.list_rate(price_list, product, date, qty)` (net rate; tax-inclusive lists converted with the HSN rate); `app.credit_exposure(company, party) → {limit, credit_status, terms, receivables, receivables_gst, open_orders, exception, exposure, available}`; `app.credit_view(exposure, extra)` (Admin/CA full; others GST figures + `blocked` + `hidden_items`); `app.reserve_order(order)`; `app.order_message(...)`; `app.check_vehicle(vehicle, date)`; `app.add_trip_stops`, `app.lock_trip` (driver of the trip with `trip.drive`, else `logistics.edit`); `app.link_dispatch_doc`; `app.return_dispatch_qty` (back to the dispatch place in **quarantine**, lot by lot); `app.is_my_customer`, `app.can_sales_party`, `app.can_write_party`; `app.my_session()`; `app.party_pin(party)` (delivery pin, else billing); `app.salesman_scope(company)`; `app.party_open_bills(company, party, gst_only)`; `app.count_total(denominations)`; `app.handover_contra`; `app.purge_gps(days)`; `app.create_complaint`, `app.complaint_event`; `app.iso6346_valid`; `app.listing_blockers`; `app.gst_reader`, `app.gst_docs`, `app.s3_balances`; `app.msg_rate`, `app.msg_month_spend`, `app.msg_is_urgent`, trigger `app.outbox_cost_cap` (BEFORE INSERT on `msg.outbox`), `app.schedule_reminders(company, date)`, `app.schedule_reminders_all()`, trigger `app.cancel_settled_reminders` (AFTER INSERT on `acct.bill_allocations`), `app.record_inbound(p)`.

### State machines

- **Credit application:** 1 prospect (party exists) → 2 request (`credit.request`; salesman only for his own customers) → 3 sales manager endorses (`credit.endorse`) → 4 file verified, KYC must be verified (`credit.verify`) → 5 finance head recommends (`credit.recommend`) → 6 MD approves limit, terms, review date (`credit.approve`; MSME rule for terms > 45 days when `msme.selling_rule` is on) → 7 **active** (writes `party_companies.credit_limit/credit_term_id/credit_status = active/credit_review_on`). A rejection at any stage needs a note and ends the application. The decider is never the requester (`sod.own_request`) nor someone who decided an earlier stage (`credit.same_person`).
- **Order:** `pending_credit` (payment credit and exposure + order > limit + live exceptions) / `pending_approval` (private label not approved) → `confirmed` (by `release_order` or `grant_md_exception`, never the order's creator) → `part_dispatched` → `dispatched` → `closed` (all delivered and invoiced); `cancelled` before any dispatch. Cash/advance orders skip the credit check; credit orders need verified KYC.
- **Dispatch / trip:** dispatch `planned` (invoice linked + e-way bill) → trip `planned → started` (stock out with move `dispatch`, held lots never leave, credit re-checked, dispatch message) → stop `pending → arrived → delivered | part_delivered | failed` (POD; short or failed quantities return to quarantine and reopen the order quantity) → trip `closed` (every stop done; the driver's GPS window ends).
- **Visit:** check-in (on duty; within `field.geofence_m` → accepted, else reason required and approval `pending`) → approval `approved|refused` (sales manager, not the salesman) → check-out (outcome; no-order reason).
- **Cash handover:** `pending` (salesman's count; his open cash collections are attached) → `confirmed` (cashier's count = salesman's = expected; contra from `field.cash_in_hand` to the cashier's cash account) | `mismatch` (Bug fixer item `field.handover:<id>`) → `resolved` (finance, `cash_book.approve`, contra for the cashier's count).
- **Complaint:** `logged → investigating → on_hold (QC hold) → resolved | rejected → closed` (closer ≠ logger, `sales.approve`; not while the hold is open). **QC hold:** `on_hold → released` (back to available, lot status restored) `| rejected` (to rejected bucket).
- **Private label:** `submitted → approved` (sales, quality and MD approvals by three different people, none the creator) `| rejected`.

### Rules enforced (where)

Exposure = open receivables (posted invoices/bills of supply and opening bills still owed) + approved credit orders not yet billed; invoiced-but-undelivered is inside receivables (`app.credit_exposure`). Prices locked to the customer's price list for salesmen; discount over `sales.salesman_discount_pct` refused. MRP checked on orders and invoices. GPS: refused off duty (`gps.off_duty`), notice required (`gps.notice_required`), points outside the duty window refused, kept 90 days (`app.purge_gps`; pg_cron job `gps-retention-purge` 03:00 IST when pg_cron is enabled). Salesman sees only assigned customers (RLS on orders, queries, promises, complaints via `app.can_sales_party`; salesman reads through definer RPCs that check the assignment) and GST bills only. Collections use the Phase 3 cash rule (`app.cash_check`, ₹2 lakh refusal from settings). Day end refuses unsynced work, open visit, cash not handed over, handover awaiting the cashier. E-way bill before the vehicle leaves. LUT export invoices Admin only with a valid LUT. Counter sale = Phase 3 invoice + stock out + receipt. Reminders: GST bills only, consented contacts only (others recorded as skipped), one per customer per day, disputed bills paused, payment proof holds, settled bills cancel. Cost cap: non-urgent messages skipped at 100 %, alert at `alert_pct`.

### Events to `msg.outbox`

`sales.order_confirmed` (`order_confirmed`, doc `sales.orders`, stage confirmed), `sales.dispatched` (`dispatched`, stage `dispatched:<dispatch>`), `sales.delivered` (`delivered`, stage `delivered:<dispatch>`), `sales.payment_received` (field collections; Phase 3 template), `sales.complaint_update` (`complaint_update`, stage = complaint status), `sales.payment_reminder` (`payment_reminder`, doc_type `sales.reminder`, doc_id = party, stage `reminder:<date>`, window `reminders`, params include `bill_ids` and `offsets`), `sales.statement` (`statement_request`, stage `statement:<date>`), `msg.reply` (free text inside the 24-hour window, category `service`). Templates are English drafts; Meta approval is the owner's step.

### Rights seeded

New: `field.sell`, `field.manage`, `trip.drive`, `shop.operate`, `credit.request`, `credit.endorse`, `credit.verify`, `credit.recommend`, `credit.approve`, `credit.md_exception`. Role mapping: salesman (field.sell, credit.request); sales_manager (sales view/create/edit/approve, field.manage, field.sell, credit.request, credit.endorse, logistics.view, sales_invoices.view); driver (trip.drive); shop_staff (shop.operate, sales_invoices.create); buyer_logistics (logistics view/create/edit); factory_manager (logistics view/approve); accountant (credit.verify); finance_head (credit.verify, credit.recommend, sales.view, accounts.view, cash_book view/create/approve, gst.view, reports.view); md (credit.approve, credit.md_exception, sales.view, logistics.view, reports.view); gm (sales.view, logistics.view).

### RLS

On for every new table; select only. Orders/lines/promises/queries/contact attempts/complaints: `app.can_sales_party` (sales.view, accounts.view, or the assigned salesman with field.sell) — complaints also QC. Credit tables: sales.view/accounts.view (applications also the requester). Logistics: logistics.view (trips and stops also the driver; dispatches also the sales side). Field: own rows or field.manage (visits also sales.view; handovers also the cashier and cash_book.view; collections also cash_book/accounts). Shops: shop.operate/sales.view. Exports: exports.view (export invoices also the document's tax-class rule). Online: sales.view. Schedule III map: reports/accounts.view. Cost caps/rates: Admin and CA. Tasks: Admin, accounts.view, or the assigned person.

### Tests

`supabase/tests/17_delivery_sales.sql` (57), `18_gst_reports.sql` (38), `19_field_sales.sql` (33); `_setup.sql` gains `tests.seed6`.

## Phase 7: the rest of operations (database built; screens next)

Migrations (all additive):

- `20261103007000_phase7_core.sql`: tables, guards, RLS, the closed-period lock, the investor read rule, the `documents` bucket, rights and settings
- `007100_phase7_ops_api.sql`: job work, maintenance, licences, depreciation and disposals
- `007200_phase7_partners_close_api.sql`: partners, directors, the investor portal and the month-end close
- `007300_phase7_views.sql`: views and the law register
- `007400_phase7_setting_keys.sql`: the Companies Act setting keys

**Widened (non-destructive):**

- `core.places.kind` adds `job_worker`.
- `inv.stock_ledger.move_type` adds `job_work_out` and `job_work_in`.
- `core.licences.kind` adds `gst_registration`, `company_registration`, `pan_tan`, `udyam`, `iec`, `lut`, `epf`, `esi`, `shops_establishment`, `trademark`, `iso`, `bis`, `weighing_verification` and `spirit_permit`.

**New defaulted or nullable columns:**

- On `core.licences`:
  - `title`, `portal_url`, `owner_person_id` (→ `master.people`)
  - `is_blocking` (default false)
  - `blocks text[]`: a subset of `production` and `packing`
  - `renewal_status`: `ok|renewal_due|applied|renewed|lapsed`
  - `renewal_applied_on`
- On `core.assets`: `disposed_on`.

**Numbering.** Doc types `job_work` (JW), `repair_request` (RR), `spares_issue` (SP) and `partner_request` (PRQ). Numbers come from `app.p7_doc_no`.

**Settings seeded** (values from the prompt or the Act; the CA confirms):

- `licence.reminder_days` = `[90, 30, 7]`
- `close.due_day` = 10
- `jobwork.return_years` = `{"inputs": 1, "capital_goods": 3, "moulds_tools": null}`
- `close.default_tasks`: task titles from the MonthClose design

**Settings read but not seeded.** The CA decides each one and Admin records it with `api.set_setting`. When a setting is unset, the action is refused with a rule code. Nothing is assumed.

| Setting | Value | Meaning |
|---|---|---|
| `depreciation.method` | `"slm"` or `"wdv"` | Depreciation method |
| `depreciation.useful_life_years` | `{asset_kind: years}` | Useful life by asset kind. The asset's own `useful_life_years` wins. |
| `depreciation.residual_pct` | number | Residual value %. The asset's own `residual_pct` wins. Needed above 0 for WDV. |
| `companies_act.director_loan_exception` | `{basis, resolution_ref?, …}` | The allowed s.185 exception |
| `companies_act.loan_limit` | number | The s.186 limit |
| `investor.include_without_gst` | boolean, default false | Admin-approved policy to include without-GST figures in investor aggregates |
| `close.reopen_hours` | number | Relock a reopened month after this many hours |
| `close.auto_lock` | boolean, default false | Lock months on their due date. Open tasks move to the next month. |

**Closed periods** (a change to Phase 3 behaviour; decision D-P7-1):

- `app.fy_for` refuses a closed month whatever grant is held (`period.closed`).
- The triggers `closed_period_guard` on `acct.gl_entries` and `inv.stock_ledger` refuse any row dated in a closed month.
- The trigger `periods_guard` on `core.periods` allows closed → open only inside `api.reopen_period`.
- `core.rights.period.reopen` is now `admin_only` and not grantable.

**Investor read rule** (decision D-P7-2): `app.can_read_company` ignores the `investor` role. A new helper, `app.is_partner_user(partner_id)`, checks that the partner row belongs to the caller.

### Tables

| Table | Key columns | Notes |
|---|---|---|
| `core.licence_documents` | company_id, licence_id, kind `licence_copy\|application\|renewal_receipt\|inspection\|other`, path (`documents` bucket `<company_id>/licences/…`), valid_to, uploaded_by | **Append-only** |
| `core.licence_renewals` | licence_id, old_licence_no / old_valid_from / old_valid_to, new_licence_no / new_valid_from / new_valid_to, document_id, note, renewed_by/at | **Append-only** renewal history |
| `core.licence_reminders` | licence_id, valid_to, days_before, due_on, status `queued\|skipped\|alert_only\|superseded`, outbox_id, run_date | **Append-only**. **Unique (licence_id, valid_to, days_before)**: a reminder is never sent twice. |
| `prod.job_worker_places` | (company_id, party_id) PK, place_id (unique, kind `job_worker`) | Created on first job work for that job worker |
| `prod.job_work_orders` | company_id, doc_no (`JW/…`), gstin_id, job_worker_party_id, process, goods_kind `inputs\|capital_goods\|moulds_tools`, from_place_id, jw_place_id, sent_on, return_by (null = no limit, > sent_on), challan_document_id (→ `sales.documents`), challan_no, status `sent\|part_received\|received\|cancelled` | |
| `prod.job_work_lines` | order_id, line_no, product_id, lot_id, qty_sent (18,3) > 0, unit_cost, qty_settled (≤ qty_sent) | Balance = qty_sent − qty_settled. Only `receive_job_work` changes it, under a row lock. |
| `prod.job_work_receipts` | order_id, line_id, kind `finished\|returned\|scrap\|loss`, product_id, qty, input_qty, to_place_id, value, received_on, challan_ref | **Append-only**. `loss` has qty 0. |
| `prod.repair_requests` | company_id, doc_no (`RR/…`), asset_id or mould_id, source `operator_check\|manual\|breakdown\|preventive`, machine_check_id (unique), title, description, photo_path, priority, is_breakdown, broke_down_at, restored_at, downtime_minutes, status `new\|assigned\|waiting_parts\|done\|cancelled`, assigned_to, outside_vendor, purchase_request_id, labour_cost, outside_cost, resolution, raised_by, closed_by/at | A failed operator check opens one (trigger `machine_check_repair`) |
| `prod.spares_issues` | company_id, doc_no (`SP/…`), repair_request_id, asset_id, product_id, place_id, qty, value, issued_on | **Append-only**. The stock moves through `app.stock_take` (`issue`). |
| `prod.maintenance_schedules` | asset_id, title, interval_days > 0, checklist, last_done_on, next_due_on, active | |
| `prod.maintenance_logs` | schedule_id, asset_id, done_on, note, cost, done_by | **Append-only** |
| `acct.depreciation_runs` | company_id, period_id, method, total, voucher_id, status `posted\|reversed`, run_by/at | One posted run per company and month (partial unique index) |
| `acct.depreciation_lines` | run_id, asset_id, cost, residual, useful_life_years, opening_wdv, days, amount, closing_wdv | **Append-only** |
| `core.asset_disposals` | asset_id (unique), disposal_date, proceeds, cost, accumulated_depreciation, wdv, gain_loss, reason, voucher_id | **Append-only** |
| `acct.partners` | company_id, person_id, user_id (the portal sign-in), display_name, is_legal_partner / is_investment_partner / is_working_partner / is_director / director_interested, din (8 digits), shares, share_pct (0–100), capital_account_id / current_account_id / loan_account_id (→ `acct.accounts`), language `en\|ml`, status | Unique (company_id, user_id) and (company_id, person_id) |
| `acct.partner_projects` | company_id, name, status `idea\|being_built\|running\|closed`, started_on, summary, investor_figures jsonb (only what Admin shows), visible_to_investors | |
| `acct.partner_investments` | partner_id, kind `share_capital\|capital_account\|project\|other`, amount, invested_on, agreement_ref, project_id | **Append-only** memo. `project` needs the project and the agreement. |
| `acct.partner_requests` | company_id, doc_no (`PRQ/…`), partner_id, kind `withdraw\|loan_to_partner\|loan_from_partner\|info\|project_offer`, source `land_rent\|incentive\|dividend\|investment`, project_id, amount, repay_months, repay_from, purpose, note, status `submitted\|approved\|rejected\|paid\|withdrawn`, requested_by, decided_by (≠ requested_by, check), decided_at, decided_amount, decision_note, checks jsonb, voucher_id, paid_at | |
| `acct.director_declarations` | partner_id, kind `not_borrowed\|interest_disclosure\|other`, declared_on, valid_to, document_path | **Append-only** |
| `acct.director_loans` | partner_id, direction `given\|taken`, movement `advance\|repayment`, amount, loan_date, bank_account_id, request_id, declaration_id, legal_basis jsonb, voucher_id | **Append-only** |
| `acct.profit_share_minutes` | company_id, fy_id, meeting_date, minutes_ref, document_path, basis `{incentives: [{partner_id, pct}]}`, status `draft\|approved\|superseded`, created_by, approved_by (≠ created_by, check) | |
| `acct.profit_share_runs` | minutes_id, fy_id, net_profit, incentive_total, distributable, status `computed\|posted\|superseded`, voucher_id | One posted run per set of minutes |
| `acct.profit_shares` | run_id, partner_id, kind `incentive\|share`, pct, amount | **Append-only**. A rounding row (pct 0) may follow the largest share. |
| `acct.close_checklists` | company_id, period_id (unique), due_on, status `open\|closed` | |
| `acct.close_tasks` | checklist_id, title, area, sort, doer_user_id, checker_user_id (≠ doer, check), status `open\|done\|checked\|carried`, done_by/at/note, checked_by (≠ done_by, check)/at/note, carried_to_task_id, carry_reason | |
| `acct.period_events` | period_id, action `closed\|reopened\|relocked\|auto_closed`, reason, relock_at, by_user, at | **Append-only** |

### Stock movements

| Event | Out of | Into | Move type |
|---|---|---|---|
| Job work out | sending place (`available`) | job worker's place (`available`, still our stock) | `job_work_out` |
| Job work back: `returned` | job worker's place | the receiving place (same lots and cost) | `job_work_in` |
| Job work back: `finished` | job worker's place (the input used) | the receiving place: the processed item, valued at the input it used | `job_work_in` |
| Job work back: `scrap` | — | the receiving place: the scrap item at zero cost | `scrap_in` |
| Job work back: `loss` | job worker's place (the input used) | nothing comes back | `write_off` |
| Spares | the chosen place | — | `issue` |

### State machines

**Job work order:**

- `sent` → `part_received` → `received`
- Overdue = `return_by < today` with a balance left.
- `app.job_work_overdue_run` opens one Bug fixer item per overdue order (area `tax`, for the CA).

**Repair request:**

- `new` → `assigned` / `waiting_parts` → `done` (needs a resolution).
- `cancelled` is possible from any open state.
- A breakdown sets the asset to `repair`.
- When the request is done, downtime = restored_at − broke_down_at, and the asset goes back to `active` if no other breakdown is open.

**Partner request:**

- `submitted` → `approved` / `rejected` (Admin, never the requester or the partner themselves) → `paid`.
  - A withdrawal is paid with `pay_partner_request`.
  - A loan is paid with `record_director_loan` and its `request_id`.
- `submitted` → `withdrawn` (by the requester).

**Close task:**

- `open` → `done` (the doer) → `checked` (the checker; never the person who did it). A checker can `return` it to `open` with a note.
- An open or done task can be `carried` to the next month's checklist.

**Period:**

- `open` → `closed` (`api.close_period`: every task checked or carried, and the month has ended).
- `closed` → `open` only through `api.reopen_period` (Admin, a reason of at least 10 characters, logged in `acct.period_events` and `audit.user_log`).
- Relocks after `close.reopen_hours` through the hourly pg_cron job `period-relock`.

### Rules enforced (where)

- **Licence reminders** (`app.licence_reminders_run`, pg_cron `phase7-daily` at 02:00 UTC = 07:30 IST):
  - Each crossed threshold gets one `core.licence_reminders` row per licence and expiry.
  - Only the tightest new threshold sends an internal alert to the licence owner: `msg.outbox` event `internal.licence_expiring`, template `licence_expiring`, params licence / licence_no / valid_to / days_left. No figures.
  - On a late first run the larger thresholds are recorded as `superseded`.
  - An expired licence that blocks something opens one Bug fixer item and moves `renewal_status` to `lapsed`.
- **Blocking licences** (`app.check_blocking_licences(company, place, activity, date)`):
  - A licence kind that Admin marked `is_blocking` for `production` or `packing` must have a valid licence covering the place's branch on the date. Otherwise `licence.expired`.
  - Called from `app.check_licence` (every Biochem production entry), from trigger `shift_licence_guard` (injection shifts) and from trigger `packing_licence_guard` (a batch moving to packing).
  - The Phase 5 cosmetics family check is unchanged.
- **Depreciation** (`api.run_depreciation`):
  - Refuses with `depreciation.settings_missing`, `depreciation.life_not_set`, `depreciation.asset_dates_missing` or `depreciation.residual_not_set` (WDV).
  - Also refuses `period.closed`, `depreciation.period_not_ended` and `depreciation.already_run`.
  - SLM: (cost − residual) ÷ life × days in use ÷ days in the FY.
  - WDV: opening WDV × (1 − (residual%)^(1/life)) × days ÷ days in the FY.
  - The charge is capped at cost − residual − accumulated.
  - Only assets with a cost and a put-to-use (or purchase) date count.
  - One journal: Dr `depreciation.expense`, Cr `depreciation.accumulated`.
- **Disposal**: Dr `depreciation.accumulated`, Dr the proceeds account, Cr `asset.cost`; the gain or loss goes to `asset.disposal_gain_loss`.
- **Companies Act** (`app.check_partner_loan`, `app.director_declaration`): see LAW_RULES CA-185, CA-186 and DIR-1. A loan approval also needs the board resolution reference in the note.
- **Profit share**:
  - Net profit = Σ(cr − dr) on income and expense accounts within the FY (every class of entry; Admin only).
  - Incentives (% of net profit) come first. The rest goes by `share_pct`, which must total 100.
  - Posted Dr `profit_share.incentive` / `profit_share.distribution`, Cr each partner's current account.
- **Withdrawals**: no more than the partner's current-account credit balance (`app.account_credit_balance`, opening included).

### Posting rules used (data; Admin maps them with the CA)

`depreciation.expense`, `depreciation.accumulated`, `asset.cost`, `asset.disposal_gain_loss`, `profit_share.incentive`, `profit_share.distribution`. Missing → `posting.rule_missing`.

### Rights seeded

- `partners.view` (finance_head, md)
- `investor.portal` (investor)
- `close.manage` (finance_head)
- `partners.manage`: special, admin-only and never grantable
- `period.reopen`: now admin-only and not grantable

The investor role holds only `home.view` and `investor.portal`. Job work and maintenance use `production.create` / `production.view` and `assets.manage` / `assets.view`. Licences use `settings.manage`. Depreciation and disposals use `accounts.create`.

### RLS

**Licence tables:** `app.can_read_company` (never the investor).

**Job work:** `production.view` or `inventory.view`.

**Maintenance:**

- `production.view` or `assets.view`.
- Repair requests can also be read by the person who raised the request and by the assignee.

**Depreciation and disposals:** `accounts.view` or `assets.view`.

**Partners and directors:**

- The partner rows and everything hanging off them can be read by their own portal user (`user_id = auth.uid()` / `app.is_partner_user`) or with `partners.view`.
- Minutes and runs need `partners.view`.
- Projects can be read with `partners.view`, or when they are visible to investors and the caller is a partner of that company.

**Close:**

- `accounts.view` or `close.manage`.
- Tasks can also be read by the assigned doer or checker.

**Storage bucket `documents`** (private): `<company_id>/licences/…` can be read by those who can see the company and written with `settings.manage`. `<company_id>/assets/…` can be read with `assets.view` or `production.view` and written with `assets.manage`.

### Background jobs (pg_cron)

| Job | Schedule (UTC) | Calls |
|---|---|---|
| `phase7-daily` | `0 2 * * *` | `app.phase7_daily()`: licence reminders and expiries, overdue job work |
| `period-relock` | `15 * * * *` | `app.period_jobs()`: relocks reopened months whose window ended. If `close.auto_lock` is on, also locks months past their due date. |

### Tests

| File | Covers | Tests |
|---|---|---|
| `supabase/tests/21_jobwork_maintenance.sql` | Job work and maintenance | 28 |
| `22_licences_assets.sql` | Licences and assets | 29 |
| `23_partners_investor_close.sql` | Partners, the investor portal and the close | 42 |

`_setup.sql` has a new seed, `tests.seed7`.

## Phase 8: integrations (database built; providers are mocks until the owner chooses)

Migrations (all additive):

- `20261103008000_integrations_core.sql`: tables, guards, RLS, operational settings
- `008100_integrations_api.sql`: RPCs (outbound queue, webhooks, e-invoice, e-way bill, stores, settlements, bank feeds, GPS, help on WhatsApp), the leave guard, the outbox hold, the sweep job
- `008200_integrations_views.sql`: read views and `api.tcs_reconciliation`

**Widened (non-destructive):** `ops.bug_items.area` adds `integration`; `ops.bug_items.kind` adds `integration_dead_letter`.

**New column:** `core.gstins.einvoice_from date` (the e-invoice start date for the GSTIN; Q-21). E-invoicing applies to a document when `einvoice_enabled` is true and (`einvoice_from` is null or the document date is on/after it).

### Tables

| Table | Key columns | Notes |
|---|---|---|
| `ops.integration_requests` | `company_id`, `provider`, `kind` (`einvoice_generate`, `einvoice_cancel`, `eway_generate`, `eway_update_partb`, `eway_cancel`, `bank_feed_sync`, `channel_listing_sync`, `channel_order_ack`, `help_whatsapp_reply`), `ref_table`/`ref_id`, `payload` (built on the server; never secrets), `payload_hash` (SHA-256), `idempotency_key` **unique**, `status` `queued→in_progress→done|dead|cancelled`, `attempts`, `max_attempts`, `next_attempt_at`, `locked_at`, `last_error`, `response`, `bug_id` | Outbound log and dead letter. Admin reads (RLS) |
| `ops.integration_attempts` | `request_id`, `attempt_no`, `ok`, `error`, `retryable`, `next_attempt_at` | **Append-only** (trigger) |
| `ops.webhook_events` | `provider`, `external_id`, `topic`, `signature_ok`, `payload`, `payload_hash`, `status` (`received|processed|rejected|failed|ignored`), `result`, `error`, `received_at`, `processed_at` | **Unique (provider, external_id) where signature_ok** — only signed events dedupe, so a forged event never blocks the real one. Payloads cleared after 90 days |
| `sales.einvoice_irns` | `document_id`, `gstin_id`, `irn` (64 hex, unique), `ack_no`, `ack_date`, `signed_qr`, `provider`, `is_mock`, `status` (`active|cancelled`), `cancel_reason` (`duplicate|data_entry_mistake|order_cancelled|other`), `cancel_remark`, `cancelled_at/by`, `request_id` | One active IRN per document (partial unique index). Never edited or deleted; the only change is active → cancelled (trigger `einvoice_irn_guard`, rule `einvoice.locked`) |
| `sales.eway_bills` | `dispatch_id`, `document_id`, `eway_bill_no` (12 digits, unique), `generated_at`, `valid_until`, `vehicle_no`, `transporter_gstin`, `distance_km`, `transport_mode`, `provider`, `is_mock`, `status` (`active|cancelled`) | One active per dispatch |
| `sales.eway_partb_updates` | `eway_bill_id`, `vehicle_no`, `reason`, `valid_until`, `request_id` | **Append-only** |
| `acct.bank_feeds` | `account_id` (→ `acct.bank_accounts`), `provider`, `external_ref` (provider's opaque link id; a 9+ digit run is refused), `status`, `last_sync_at`, `last_cursor`, `last_result`, `last_error` | Unique (account, provider). Never an account number or a statement password |
| `sales.channel_sync_log` | `channel_id`, `direction`, `kind` (`order|order_cancel|listing|inventory|settlement|return`), `external_id`, `status` (`staged|ingested|failed|sent|skipped`), `detail` (normalised order), `webhook_event_id`, `online_order_id` | Unique (channel, kind, external_id) for inbound |
| `sales.marketplace_settlements` | `channel_id`, `settlement_ref` (unique per channel), `period_from/to`, `payout_date`, `gross_sales`, `returns_value`, `net_taxable`, `tcs_cgst`, `tcs_sgst`, `tcs_igst`, `tds_amount`, `commission`, `other_fees`, `net_payout`, `bank_line_id`, `reverses_id`, `source` | **Append-only**; a wrong one is reversed by a negated row (`<ref>-REV`) |
| `ops.gps_devices` | `provider`, `device_ref` (unique per provider), `user_id`, `vehicle_id`, `active` | GPS provider devices mapped to the person on duty |
| `help.whatsapp_staff` | `person_id`, `user_id`, `number` (+91…, unique while active), `language`, `consent_at`, `verified_at/by`, `revoked_at/by` | Verified staff numbers for help on WhatsApp |
| `help.whatsapp_messages` | `staff_id`, `direction`, `kind` (`text|voice`), `body` (redacted), `tool`, `webhook_event_id` | Kept 12 months (sweep) |

Money is `numeric(18,2)` everywhere above.

### Rules enforced (where)

| Rule | Where |
|---|---|
| Outbound calls retry with back-off `base × 2^(attempts−1)` capped, then dead-letter → one Bug fixer item (`area integration`, `kind integration_dead_letter`, high); a later success closes it | `app.integration_fail`, `app.integration_succeed`, `app.integration_backoff_seconds`; settings `integrations.max_attempts` (5), `integrations.backoff_base_seconds` (60), `integrations.backoff_max_seconds` (21600) |
| A worker that never reports back counts as a failed attempt after 10 minutes | `app.integration_sweep` (pg_cron `integration-sweep`, every 5 minutes) |
| Webhooks: signature checked before anything; one stored event per provider + id | Edge Functions, then `api.ingest_webhook` |
| E-invoice switch per GSTIN; IRN only for posted B2B tax invoices / credit notes with GST on or after the start date | `api.request_einvoice` (`einvoice.switch_off`, `einvoice.not_posted`, `einvoice.not_eligible`, `einvoice.already_issued`) |
| Not final without the IRN: no print, the WhatsApp invoice message waits, goods do not leave | `app.einvoice_pending`, `api.check_document_printable` (`einvoice.irn_required`), trigger `outbox_wait_for_irn` (send_after = infinity, released by the IRN), trigger `dispatch_leave_guard` on `sales.dispatches` |
| IRN cancel only within `einvoice.cancel_window_hours` (seeded 24, CA confirms); a document with an active IRN is not cancelled first | `api.cancel_einvoice` (`einvoice.cancel_window`, `einvoice.cancel_reason`), `api.cancel_sales_document` (`einvoice.cancel_irn_first`) |
| E-way bill before the vehicle leaves (existing `dispatch.eway_required` in `api.start_trip`), and a cancelled or expired e-way bill is refused | `dispatch_leave_guard` (`dispatch.eway_invalid`); `api.request_eway_bill` needs the invoice final (`einvoice.irn_required`) |
| E-way bill cancel only before the goods move and within `eway.cancel_window_hours` (**unset** → refused, CA confirms) | `api.cancel_eway_bill` |
| Provider chosen per kind by setting `integrations.provider.<einvoice|eway|…>`; unset → refused; `mock` only where `integrations.allow_mock` is true; mock IRNs / e-way bills flagged `is_mock` and printed as TEST | `app.integration_provider`, `api.run_mock_integration` |
| TCS u/s 52: rate is the CA's setting `marketplace.tcs_rate_pct` (effective-dated); unset → `rate_not_set`; bills without GST never counted | `api.tcs_reconciliation` |
| GPS from the provider only inside the device user's open duty session | `api.gps_ingest` (`off_duty`, `unknown_device`, points outside the session dropped) |
| Help on WhatsApp: verified staff numbers only (number = staff record, consent, another Admin verifies), no data tools, numbers masked before storing | `api.verify_help_whatsapp_staff` (`help_wa.number_mismatch`, `help_wa.consent`, `sod.own_request`), `api.help_whatsapp_inbound`, `api.help_wa_tool` (`help_wa.unverified`, `help_wa.tool_not_allowed`), `app.help_redact` |
| Service-only RPCs refuse signed-in users | `app.require_service` (`rights.service_only`) and no `EXECUTE` grant to `authenticated` |

### RLS

- `ops.integration_requests`, `ops.integration_attempts`, `ops.webhook_events`, `help.whatsapp_messages`: Admin only.
- `sales.einvoice_irns`: `sales_invoices.view` or `sales.view` for the company. `sales.eway_bills` (+ Part-B): `logistics.view`, `sales.view` or `sales_invoices.view`.
- `acct.bank_feeds`, `sales.marketplace_settlements`: `accounts.view`. `sales.channel_sync_log`: `sales.view`. `ops.gps_devices`: Admin or `logistics.view`. `help.whatsapp_staff`: Admin or the staff member.

### Background jobs (pg_cron)

| Job | Schedule (UTC) | Calls |
|---|---|---|
| `integration-sweep` | `*/5 * * * *` | `app.integration_sweep()`: stale in-progress requests → failed attempt (back-off / dead letter); webhook payloads older than 90 days cleared; help WhatsApp lines older than 12 months deleted |

The Edge Functions `integration-worker` (every minute) and `bank-feed` are called by Supabase Cron + `pg_net` once deployed (DEPLOYMENT_GUIDE).

### Tests

| File | Covers | Tests |
|---|---|---|
| `supabase/tests/24_integrations.sql` | Back-off, dead letter → Bug fixer → retry, e-invoice switch / not final / print / outbox hold, cancel window, e-way required and invalid, service-only RPCs, webhook dedupe, help on WhatsApp, GPS on duty, TCS reconciliation, sweep, RLS | 65 |

## Phase 9: go-live readiness (security, performance)

No new business tables. Migrations (all additive, applied to DEV 03-11-2026):

| Migration | Contents |
|---|---|
| `20261103009000_security_hardening.sql` | Read policies for `core.request_log` (own rows), `core.doc_numbers_issued` (All / All read-only views) and `ops.bridge_devices` (Admin). `anon` EXECUTE on `api.log_sign_in_failure` restored. `search_path` pinned on `app.imp_*`. MFA enforcement: `app.mfa_enforced()`, `app.mfa_satisfied()`, `app.has_mfa_role()`, `app.my_roles()` (drops MFA-required roles below aal2 when enforced), `app.require()` (raises `mfa_required`), investor-portal row functions gated, `api.me()` gains `mfa_required` / `mfa_enforced` / `aal` / `mfa_needed` |
| `20261103009100_performance_indexes.sql` | `app.companies_with(right)`, `app.companies_with_any(rights[])`, `app.readable_companies()`, `app.sees_all_classes()`, `app.visible_party_ids()`. Equivalent once-per-statement read policies on `core.companies/gstins/branches/financial_years/places/user_profiles/special_grants`, `master.parties/party_companies/product_companies`, `sales.documents`, `acct.vouchers/gl_entries/open_bills/bill_allocations/accounts`, `inv.stock_ledger/lots`, `msg.outbox`, `audit.row_history`. List indexes. `api.sales_register_totals` |
| `20261103009200_rls_helpers_set_based.sql` | The three set helpers rewritten as one pass over `app.my_roles()` (same results as `app.can()` / `app.can_read_company()`). `api.stock_movements` checks cost visibility once per statement |
| `20261103009300_row_history_policy_gate.sql` | `row_history_read` keeps its rule and adds an index range that is empty without `logs.view` |

### Settings

| Key | Scope | Default | Meaning |
|---|---|---|---|
| `security.enforce_mfa` | group (`company_id` null) | absent = off | When `true`, MFA-required roles count only in `aal2` sessions |

### Tests

| File | Covers | Tests |
|---|---|---|
| `supabase/tests/25_security.sql` | Catalogue: RLS + at least one policy on every table, invoker views, pinned `search_path`, no `anon` access except the failed sign-in log, no direct writes, no `using (true)` write policy, no public bucket. MFA off/on at aal1/aal2 for accountant, Admin, salesman and investor. Set helpers equal `app.can()` for 7 user kinds × 11 rights. Audit-history gate | 35 |

## Phase 10: Tally reports import (Day Book, Trial Balance, Stock Summary, Balance Sheet)

Migrations `20261103010000_tally_reports.sql` and `20261103010100_tally_reports_grants.sql` (additive only). Later, additive: `20261103011000_import_pincode_sanitise.sql` (`app.imp_pincode`, `app.imp_state2`, `app.imp_pan`; `app.imp_ledger` patched so a bad PIN, state code or PAN is left out and the raw PIN text is kept in address line 2 as "PIN in Tally (not valid): ..."; `api.import_retry_errors`), `011100` / `011200` / `011400` (`api.apply_trial_balance_as_opening` with the Suspense options, `app.tb_resolve_group`, `app.tb_is_pseudo`, `app.tb_declared_difference`, `app.tb_suspense_account`, index `import_rows_ledger_name_idx`), `011300` / `011500` / `011600` (Day Book upgrade in place).

### Tables and columns

| Object | Contents |
|---|---|
| `ops.tally_reports` | One staged Tally display report. `company_id`, `kind` (`trial_balance`, `stock_summary`, `balance_sheet`), `as_of`, `period_from`, `period_to`, `file_name`, `file_sha256`, `company_name_in_file`, `grain` (`ledger`, `group`, `unknown`), `lines jsonb`, `totals jsonb` (server-computed sums plus the file's own grand totals as `tally_*`), `status` (`staged`, `applied`, `superseded`), `result jsonb`, `uploaded_by/at`, `applied_by/at`. **Unique `(company_id, kind, as_of, file_sha256)`.** Append-only: a trigger refuses any change to lines, totals, keys or uploader, delete is refused, row history is on. RLS: read with `data.import` for the company, or Admin / CA view. |
| `ops.tally_vouchers.dc` | New column: `D` or `C`, the side of a one-leg Day Book line (null for XML vouchers with lines). |
| `ops.tally_vouchers.upgraded_into`, `upgraded_at`, `upgraded_from` | New columns (migration `20261103011300`, `011500`, `011600`). A full-entry Day Book XML voucher that matches one-leg Excel vouchers on type, number and date is **upgraded in place**: the first Excel leg (by key) takes the XML guid, key, party, amount and full lines and keeps `upgraded_from {legs, match_key, amount, batch_id, other_amounts}`; the other legs are `state = 'reversed'` with `upgraded_into` pointing at it. Loading the XML again, or the Excel again, changes nothing (the old Excel key of the kept leg is recognised through `upgraded_from`). |
| `ops.tally_reports.status` | Now also `partly_applied` (a Trial Balance applied with unplaced ledgers listed in `result.skipped`; it can be applied again). |
| `ops.import_rows` | New **restrictive** read policy: voucher rows only for Admin and the CA. |

Line shapes in `lines`: Trial Balance `{name, parents[], is_group, dr, cr}`; Stock Summary `{name, parents[], is_group, qty, unit, rate, value}`; Balance Sheet `{side L|A, name, depth, is_group, is_total, amount}`.

### Views (security invoker)
`api.tally_reports` (list, no lines), `api.tally_report_lines`, `api.tally_report_diffs` (Trial Balance, per ledger), `api.tally_report_bs_diffs` (Balance Sheet, per group), `api.tally_report_stock_match` (Stock Summary items against products). `api.tally_vouchers` gains `dc`.

### Rules enforced (where)
- Day Book `match_key` and Dr/Cr side: `app.imp_voucher`. Same file twice → every line skipped.
- Vouchers are Admin-only to stage (`api.import_stage_rows`) and to read.
- Trial Balance apply: Admin only, `grain = ledger`, Dr = Cr and equal to the file's grand total, every ledger resolvable (existing account by normalised name, or a missing account created in the group mapped through `ops.tally_group_map`), no posted voucher after the date, company opening stays balanced; nothing is posted.
- Stock Summary apply: `inventory.approve`, store of the same company, once, unmatched items refuse, zero/negative lines → Bug fixer `negative_stock`.
- Balance Sheet: stored for reconciliation only.


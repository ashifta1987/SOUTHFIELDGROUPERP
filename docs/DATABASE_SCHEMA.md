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

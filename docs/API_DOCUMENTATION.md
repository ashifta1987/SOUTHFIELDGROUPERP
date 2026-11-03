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

## Phase 4 RPCs (inventory, transfers, purchase)

Every mutating RPC: `security definer`, first parameter `p_client_request_id uuid` (repeat → first result, nothing done twice), locks the rows it changes, checks rights + state + period + stock, history by triggers. Errors carry the rule code in the Postgres **hint**; errcode 42501 = rights / segregation of duties, 22023 = bad input or state, P0001 = business rule (stock, price, invoice), P0002 = not found. Dates are `YYYY-MM-DD` (default today); quantities up to 3 decimals.

### Stock set-up and movements

| RPC | Right | `p` keys / params | Returns | Rule codes |
|---|---|---|---|---|
| `set_item_stock_settings(crid, p_product_id, p)` | products.manage | `needs_incoming_test`, `is_scrap` (booleans; omitted = unchanged) | `{id}` | product.missing |
| `set_reorder_level(crid, p)` | inventory.edit | `company_id`, `product_id`, `place_id` (null = company level), `min_qty`, `reorder_qty`, `max_qty` | `{id}` | stock.place_other_company |
| `set_negative_stock_allowance(crid, p)` | settings.manage (Admin) | `company_id`, `product_id`, `place_id` (null = all places), `reason` (≥ 5), `valid_to` | `{id}` | rights.reason_required, stock.place_other_company |
| `revoke_negative_stock_allowance(crid, p_id, p_reason)` | settings.manage | reason ≥ 5 | `{id}` | stock.allowance_missing, stock.allowance_revoked, rights.reason_required |
| `post_opening_stock(crid, p)` | inventory.approve | `company_id`, `place_id`, `date`, `lines: [{product_id, qty, unit_cost, lot_no, expiry_date, mfg_date}]` | `{lines}` | stock.qty, doc.no_lines, date.*, period.* |
| `issue_stock(crid, p_item_id, p_lot_id, p_from_place, p_qty, p_target)` | inventory.create | `p_target`: `kind` production\|cost_centre\|batch\|job\|maintenance\|other, `ref`, `cost_centre`, `to_place_id` (move into a line/WIP place instead of consuming), `date`, `reason`. `p_lot_id` null = earliest expiry first | `{issue_id, doc_no, pieces: [{lot_id, qty, unit_cost}]}` | stock.place_missing, stock.qty, stock.target, stock.same_place, stock.lot_not_released, **stock.insufficient**, **stock.reserved** |
| `return_stock(crid, p)` | inventory.create | `issue_id` (optional; fills company/item/lot/from place), `company_id`, `product_id`, `lot_id`, `from_place_id`, `to_place_id`, `qty`, `bucket` available\|quarantine (default quarantine), `reason`, `date` | `{return_id, doc_no}` | stock.issue_missing, stock.return_exceeds, stock.bucket, stock.qty |
| `record_regrind(crid, p)` | inventory.create | `company_id`, `kind` scrap_in\|regrind_reuse, `product_id` (is_scrap item), `source_product_id`, `place_id`, `qty`, `machine`, `mould`, `shift`, `date`, `note` | `{id}` | scrap.kind, scrap.not_scrap_item, stock.qty, stock.insufficient |
| `post_scrap_sale(crid, p)` | inventory.create | `sales_document_id` (posted sales_invoice with scrap lines), `place_id`, `slip_path` | `{id, qty}` | scrap.no_invoice, scrap.already_out, scrap.no_scrap_lines, stock.insufficient |

### Cycle counts (blind)

| RPC | Right | Params | Returns | Rule codes |
|---|---|---|---|---|
| `start_stock_count(crid, p)` | inventory.edit | `company_id`, `place_id`, `product_ids` (optional; default every item with stock there), `blind` (default true), `date`, `note` | `{id, doc_no, lines}` | stock.place_other_company |
| `record_stock_count(crid, p_count_id, p_lines)` | inventory.create | `[{line_id} or {product_id, lot_id, bucket}, counted_qty ≥ 0, reason]` (an unlisted item adds a line) | `{id, counted}` | count.missing, count.state, count.qty, count.line_missing |
| `submit_stock_count(crid, p_count_id)` | inventory.create | | `{id, status}` | count.incomplete, count.state |
| `post_stock_count(crid, p_count_id)` | inventory.approve, **not** the submitter or a counter | | `{id, adjustments}` | **sod.own_count**, count.state |
| `cancel_stock_count(crid, p_count_id, p_reason)` | inventory.edit | reason ≥ 5 | `{id, status}` | count.state, rights.reason_required |

### Quality (incoming tests)

| RPC | Right | Params | Returns | Rule codes |
|---|---|---|---|---|
| `record_incoming_test(crid, p_lot_id, p_result)` | qc.test, **not** the receiver | `result` pass\|fail\|hold, `parameters` {}, `remarks`, `date` | `{id, result}` | qc.lot_missing, qc.not_in_quarantine, **sod.tester_receiver**, qc.result |
| `release_from_quarantine(crid, p_lot_id, p_note?)` | qc.release, **not** the receiver | latest test must be pass | `{lot_id, released_qty}` | qc.no_pass, **sod.releaser_receiver**, qc.not_in_quarantine |
| `reject_from_quarantine(crid, p_lot_id, p_reason)` | qc.release, not the receiver | a fail test must exist; reason ≥ 5 | `{lot_id, rejected_qty}` | qc.no_fail, sod.releaser_receiver |

### Transfers

| RPC | Right | Params | Returns | Rule codes |
|---|---|---|---|---|
| `request_transfer(crid, p)` | transfer.create | `company_id`, `from_place_id`, `to_place_id`, `date`, `needed_by`, `note`, `lines: [{product_id, lot_id, qty, note}]` | `{id, doc_no, gst_doc_kind}` | transfer.places, transfer.same_place, transfer.no_gstin, stock.lot_mismatch, doc.no_lines |
| `approve_transfer(crid, p_transfer_id, p_lines?, p_note?)` | transfer.approve, not the requester | `p_lines: [{line_id, qty_approved}]` (default = requested) | `{id, status}` | **sod.own_request**, transfer.nothing_approved, transfer.state |
| `reserve_transfer(crid, p_transfer_id)` | inventory.edit | | `{id, status}` | stock.insufficient (released and free) |
| `pick_transfer(crid, p_transfer_id, p_picks)` | transfer.pick | `[{line_id, lot_id, qty}]` (lot required when the item is held in lots) | `{id, status}` | transfer.wrong_lot, transfer.lot_required, stock.lot_not_released, transfer.over_pick |
| `hand_over_transfer(crid, p_transfer_id, p_role, p?)` | picker: transfer.pick (the picker); carrier: transfer.carry (not the picker) | `p_role` picker\|carrier; `p`: `vehicle_no`, `carrier_name`, `sales_document_id` (tax invoice, other GSTIN), `date` | picker `{id, status}`; carrier `{id, status, gst_doc_kind, sales_document_id, gst_doc_no}` | sod.not_picker, **sod.picker_carrier**, transfer.invoice_required / invoice_invalid / invoice_used / invoice_wrong_party / invoice_needs_igst / invoice_short, transfer.role |
| `receive_transfer(crid, p_transfer_id, p_blind_counts, p_witness_id?)` | transfer.receive, not the picker; a carrier receiving needs a witness | `[{item_id, good_qty, damaged_qty}]` (good → available, damaged → quarantine; unlisted = still in transit) | `{id, status, still_in_transit}` | sod.picker_receiver, sod.witness_required, transfer.extra_goods |
| `reconcile_transfer(crid, p_transfer_id, p?)` | transfer.approve | `found: [{item_id, good_qty, damaged_qty}]`, `returned: [{item_id, qty}]` (→ quarantine at the sender), `note` | `{id, status reconciled\|received, still_in_transit}` | transfer.return_exceeds |
| `write_off_transfer_shortage(crid, p_transfer_id, p_items, p_reason)` | transfer.write_off, not picker/carrier/receiver | `[{item_id, qty}]`, reason ≥ 5 | `{id, written_off, still_in_transit}` | **sod.write_off**, transfer.write_off_exceeds |
| `close_transfer(crid, p_transfer_id)` | transfer.close, not picker or carrier | | `{id, status}` | **sod.picker_close**, **transfer.unbalanced** |
| `cancel_transfer(crid, p_transfer_id, p_reason)` | requester (transfer.create) or transfer.approve | before dispatch only | `{id, status}` | transfer.state, rights.reason_required |

### Purchase to pay

| RPC | Right | Params | Returns | Rule codes |
|---|---|---|---|---|
| `create_purchase_request(crid, p)` | purchase.create (own draft to edit) | `id` (edit draft), `company_id`, `department`, `for_job`, `needed_by`, `reason`, `attachment_path`, `date`, `submit` bool, `lines: [{product_id, description, qty, uom, est_rate, suggested_party_id, note}]` | `{id, doc_no, status}` | purchase.request_locked, purchase.request_not_yours, purchase.department, doc.no_lines |
| `approve_purchase_request(crid, p_request_id, p_approve, p_note?)` | purchase.approve, not the requester; within approval limit when limits are set | refusal needs a note ≥ 5 | `{id, status}` | **sod.own_request**, purchase.over_limit, purchase.request_state |
| `create_rfq(crid, p)` | purchase.create | `company_id`, `request_id` (approved), `date`, `due_date`, `note`, `supplier_ids: [uuid]`, `lines: [{product_id, description, qty, uom, request_line_id}]` (empty + request = copy the request) | `{id, doc_no, lines}` | purchase.request_not_approved, party.missing, doc.no_lines |
| `record_quotation(crid, p)` | purchase.create | `rfq_id`, `party_id`, `quote_ref`, `quote_date`, `valid_until`, `terms_days`, `delivery_days`, `attachment_path`, `note`, `lines: [{rfq_line_id, rate, qty, discount}]` (re-recording replaces) | `{id}` | **msme.terms_over_45**, purchase.rfq_closed, purchase.rfq_line_missing |
| `select_quotation(crid, p_quotation_id, p?)` | purchase.create | `gstin_id`, `place_id`, `delivery_date`, `order_date` | `{quotation_id, order_id}` (draft PO) | purchase.rfq_closed |
| `save_purchase_order(crid, p)` | purchase.create | `id` (edit draft), `company_id`, `gstin_id` (default principal), `party_id`, `request_id`, `quotation_id`, `order_date`, `delivery_date`, `place_id`, `terms_days`, `notes`, `lines: [{product_id, description, hsn_code, uom, qty, rate, discount, request_line_id}]` | `{id, totals, price_flags}` | msme.terms_over_45, gst.no_rate, posting.locked |
| `issue_purchase_order(crid, p_order_id, p_accept_price_increase?)` | purchase.approve, **not the drafter** | | `{id, doc_no, price_flags, message_id}` | **sod.own_order**, **purchase.price_increase**, purchase.order_state, msme.terms_over_45 |
| `confirm_purchase_order(crid, p_order_id, p_note?)` | purchase.edit | | `{id, status}` | purchase.order_state |
| `cancel_purchase_order(crid, p_order_id, p_reason)` | purchase.cancel | nothing received yet | `{id, status}` | purchase.order_state |
| `post_goods_receipt(crid, p_header, p_lines)` | inventory.create (+ purchase.approve without an order) | header: `company_id`, `party_id`, `order_id`, `place_id`, `receipt_date`, `gstin_id`, `supplier_invoice_no/date`, `eway_bill_no`, `vehicle_no`, `notes`; lines: `[{order_line_id, product_id, qty, rate, lot_no, supplier_lot_no, expiry_date, mfg_date}]` | `{id, doc_no, lots: [{line_no, lot_id, lot_no, bucket}], direct_purchase}` | purchase.direct_needs_approval, purchase.grn_line_not_on_order, **purchase.over_receipt** (tolerance `purchase.grn_over_receipt_pct`, default 0), purchase.grn_wrong_supplier, purchase.order_state |
| `create_bill_capture(crid, p)` | purchase.create or purchase_bills.create | `company_id`, `photo_path` (`<company_id>/…` in bucket `bills`), `source` | `{id}` | capture.photo, capture.photo_path |
| `set_bill_capture_fields(crid, p_capture_id, p)` | same | `extracted: {supplier_gstin, invoice_no, invoice_date, irn, taxable, cgst, sgst, igst, total, lines: [{product_id, description, hsn_code, uom, qty, rate, discount}]}`, `party_id` (else matched by GSTIN), `order_id`, `grn_id` | `{id, party_id, status}` | capture.locked, purchase.order_missing, purchase.grn_missing |
| `match_bill_to_po_grn(crid, p_capture_id)` | same | | `{id, status matched\|mismatch, ok, checks: [{check duplicate\|order\|item\|rate\|qty\|tax\|lines, line, ok, …}], notes: [{code match.tolerance_not_set \| price.increase, …}]}` | capture.state, party.missing |
| `capture_to_purchase_draft(crid, p_capture_id, p_gstin_id?)` | purchase_bills.create (mismatch: Admin) | | `{capture_id, bill_id, totals}` → post with `post_purchase_bill` | capture.needs_admin, capture.state |
| `reject_bill_capture(crid, p_capture_id, p_reason)` | purchase.create or purchase_bills.create | reason ≥ 5 | `{id, status}` | capture.locked |
| `post_payment(crid, p)` (replaced) | as Phase 3 | as Phase 3 | as Phase 3 | + queues `purchase.payment_advice` for a supplier (bills = supplier bill numbers allocated, or "on account") |
| `buying_logistics_home(p_company_id?)` (read, invoker) | RLS | | `{requests_waiting, requests_approved, orders_draft, orders_open, orders_late, receipts_today, lots_in_quarantine, bill_photos_to_review, transfers_in_transit, transfers_to_carry, msme_overdue, msme_due_soon, price_increases_this_month, below_reorder, tasks: [{id, severity, title, href}]}` | |

3-way match rules: rate = bill (qty × rate − discount) / qty vs the order line rate; qty = bill vs posted GRN quantity (the linked GRN, else all GRNs of the order); tax = `app.compute_tax` from the HSN table on the bill date vs the bill's taxable/CGST/SGST/IGST (exact). Tolerances from settings `purchase.match_qty_tolerance_pct`, `purchase.match_rate_tolerance_pct`; **not set → exact match**, and the result carries note `match.tolerance_not_set`.

### Phase 4 read views (security_invoker; RLS decides rows)

Notes: `sellable` = `available` only (in transit, quarantine, hold, rejected are never sellable); `free` = sellable − reserved. `unit_cost`, `value`, `avg_cost`, `stock_value` are null without `cost.view`. `api.stock_count_lines.system_qty/difference` are null while a blind count is open; `api.transfer_items.qty_dispatched/qty_in_transit` are null for the receiving side while in transit. `api.msme_dues.state` = overdue \| due_soon (within setting `msme.warn_days`, default 0) \| not_due; `legal_due_date` = acceptance (GRN date, else bill date) + agreed days capped at 45 (15 when none agreed); `effective_due` = earlier of bill due date and legal due date. `api.warehouse_tasks.task_kind` = receive_order \| receive_transfer \| test_lot \| put_away \| pick_transfer \| hand_over_transfer \| count_due. `api.sales_documents` now left-joins the party (branch challans have none).

| View | Columns |
|---|---|
| `api.lots` | id, company_id, product_id, product_code, product_name, uom, lot_no, supplier_lot_no, mfg_date, expiry_date, source, status, needs_test, grn_id, grn_no, supplier_id, supplier_name, received_by, received_by_name, received_at, released_by, released_by_name, released_at, last_test_result, qty_on_hand, qty_quarantine, days_to_expiry |
| `api.stock_on_hand` | id, company_id, company_name, product_id, product_code, product_name, product_kind, uom, place_id, place_code, place_name, place_kind, branch_id, branch_name, lot_id, lot_no, expiry_date, bucket, qty, sellable, negative_allowed, updated_at |
| `api.stock_summary` | company_id, product_id, product_code, product_name, product_kind, uom, place_id, place_code, place_name, available, quarantine, hold, in_transit, rejected, total, sellable, reserved |
| `api.item_stock` | company_id, product_id, product_code, product_name, product_kind, uom, group_name, is_scrap, needs_incoming_test, total, sellable, quarantine, hold, in_transit, rejected, reserved, free, reorder_level, reorder_qty, below_reorder, last_rate, avg_cost, stock_value |
| `api.raw_material_stock` | company_id, product_id, product_code, product_name, product_kind, uom, group_name, is_scrap, needs_incoming_test, total, sellable, quarantine, hold, in_transit, rejected, reserved, free, reorder_level, reorder_qty, below_reorder, last_rate, avg_cost, stock_value |
| `api.component_stock` | company_id, product_id, product_code, product_name, product_kind, uom, group_name, is_scrap, needs_incoming_test, total, sellable, quarantine, hold, in_transit, rejected, reserved, free, reorder_level, reorder_qty, below_reorder, last_rate, avg_cost, stock_value |
| `api.scrap_stock` | company_id, product_id, product_code, product_name, product_kind, uom, group_name, is_scrap, needs_incoming_test, total, sellable, quarantine, hold, in_transit, rejected, reserved, free, reorder_level, reorder_qty, below_reorder, last_rate, avg_cost, stock_value, last_sold_rate |
| `api.stock_movements` | id, company_id, move_date, created_at, doc_no, move_type, product_id, product_code, product_name, uom, lot_id, lot_no, place_id, place_name, bucket, qty, unit_cost, value, source_table, source_id, note, negative_allowed, created_by, created_by_name |
| `api.stock_issues` | id, company_id, doc_no, kind, issue_date, product_id, product_code, product_name, uom, lot_id, lot_no, from_place_id, from_place_name, to_place_id, to_place_name, qty, target_kind, target_ref, cost_centre, against_issue_id, bucket, reason, created_by, created_by_name, created_at, qty_still_out |
| `api.reorder_levels` | id, company_id, product_id, product_code, product_name, place_id, place_name, min_qty, reorder_qty, max_qty, set_at |
| `api.negative_stock_allowances` | id, company_id, product_id, product_code, product_name, place_id, place_name, reason, valid_from, valid_to, granted_by, granted_by_name, granted_at, revoked_at, revoke_reason, active, uses |
| `api.stock_counts` | id, company_id, doc_no, count_date, place_id, place_name, blind, status, note, created_by, created_by_name, submitted_by, submitted_by_name, submitted_at, approved_by, approved_by_name, posted_at, lines, counted, differences |
| `api.stock_count_lines` | id, count_id, product_id, product_code, product_name, uom, lot_id, lot_no, bucket, system_qty, counted_qty, difference, counted_by, counted_by_name, counted_at, reason |
| `api.regrind_entries` | id, company_id, entry_date, kind, product_id, product_name, source_product_id, source_product_name, place_id, place_name, qty, machine, mould, shift, note, recorded_by, recorded_by_name, created_at |
| `api.scrap_sales` | id, company_id, sales_document_id, invoice_no, doc_date, buyer_id, buyer_name, place_id, place_name, qty, taxable, total, rate_per_unit, slip_path, sold_by, created_at |
| `api.lab_tests` | id, company_id, lot_id, lot_no, product_id, product_name, kind, result, parameters, remarks, test_date, tested_by, tested_by_name, created_at |
| `api.transfers` | id, company_id, doc_no, transfer_date, status, from_place_id, from_place_name, to_place_id, to_place_name, from_gstin_id, from_gstin, to_gstin_id, to_gstin, gst_doc_kind, sales_document_id, gst_doc_no, needed_by, note, vehicle_no, carrier_name, requested_by, requested_by_name, requested_at, approved_by, approved_by_name, approved_at, picked_by, picked_by_name, picked_at, carried_by, carried_by_name, dispatched_at, received_by, received_by_name, received_at, witness_by, closed_by, closed_at, cancel_reason, qty_dispatched, qty_accepted, qty_quarantined, qty_returned, qty_lost, qty_in_transit, balanced, can_close, days_open |
| `api.transfer_lines` | id, transfer_id, line_no, product_id, product_code, product_name, uom, lot_id, lot_no, qty_requested, qty_approved, note, qty_picked |
| `api.transfer_items` | id, transfer_id, line_id, product_id, product_code, product_name, uom, lot_id, lot_no, expiry_date, qty_dispatched, qty_accepted, qty_quarantined, qty_returned, qty_lost, qty_in_transit, counted_by, counted_at |
| `api.transfer_events` | id, transfer_id, action, from_status, to_status, actor, actor_name, detail, at |
| `api.purchase_requests` | id, company_id, doc_no, request_date, department, for_job, needed_by, reason, attachment_path, est_total, status, requested_by, requested_by_name, submitted_at, decided_by, decided_by_name, decided_at, decision_note, created_at, lines, order_id |
| `api.purchase_request_lines` | id, request_id, line_no, product_id, product_code, description, qty, uom, est_rate, suggested_party_id, suggested_party_name, note, in_stock, on_order, last_rate |
| `api.rfqs` | id, company_id, doc_no, rfq_date, request_id, request_no, due_date, status, note, created_at, suppliers, quotations |
| `api.rfq_lines` | id, rfq_id, line_no, product_id, product_code, description, qty, uom, request_line_id |
| `api.quotations` | id, rfq_id, company_id, party_id, party_name, msme_category, quote_ref, quote_date, valid_until, terms_days, delivery_days, status, attachment_path, note, created_at, taxable_total |
| `api.quotation_compare` | rfq_id, rfq_line_id, line_no, product_id, description, rfq_qty, uom, quotation_id, party_id, party_name, qty, rate, discount, taxable, net_rate, cheapest, last_rate |
| `api.purchase_orders` | id, company_id, gstin_id, gstin, doc_no, party_id, party_name, msme_category, request_id, quotation_id, order_date, delivery_date, place_id, place_name, place_of_supply, terms_days, msme, taxable, cgst, sgst, igst, round_off, total, status, price_flags, has_price_increase, price_rise_accepted_by, notes, created_by, created_at, issued_by, issued_by_name, issued_at, confirmed_at, cancelled_at, cancel_reason, qty_ordered, qty_received, message_status |
| `api.purchase_order_lines` | id, order_id, line_no, product_id, product_code, description, hsn_code, uom, qty, rate, discount, taxable, gst_rate, cgst, sgst, igst, total, qty_received, qty_pending, request_line_id |
| `api.goods_receipts` | id, company_id, doc_no, receipt_date, party_id, party_name, order_id, order_no, place_id, place_name, supplier_invoice_no, supplier_invoice_date, eway_bill_no, vehicle_no, direct_purchase, approved_by, status, notes, received_by, received_by_name, created_at, lines, lines_in_quarantine, bill_id |
| `api.grn_lines` | id, grn_id, line_no, order_line_id, product_id, product_code, product_name, qty, uom, rate, lot_id, lot_no, supplier_lot_no, expiry_date, bucket, lot_status, qty_accepted, qty_rejected |
| `api.bill_captures` | id, company_id, photo_path, source, status, extracted, party_id, party_name, party_gstin, order_id, order_no, grn_id, grn_no, bill_id, bill_doc_no, bill_status, match_result, uploaded_by, uploaded_by_name, uploaded_at, read_at, matched_at, reject_reason, invoice_no, invoice_date, invoice_total |
| `api.price_history` | id, company_id, product_id, product_code, product_name, party_id, party_name, rate, qty, uom, source, source_id, rate_date |
| `api.price_changes` | company_id, product_id, product_code, product_name, uom, group_name, product_kind, latest_rate, latest_date, latest_party_id, latest_party_name, previous_rate, previous_date, previous_party_id, previous_party_name, change, change_pct, is_increase, first_bill, alert_pct |
| `api.msme_dues` | bill_id, company_id, party_id, party_name, msme_category, udyam_no, supplier_bill_no, supplier_bill_date, doc_no, accepted_on, agreed_days, due_date, legal_due_date, effective_due, total, open_amount, warn_days, days_left, state |
| `api.warehouse_tasks` | task_kind, company_id, place_id, place_name, ref_table, ref_id, ref_no, title, qty, due_date, href |

## Phase 5 RPCs (production)

All `api.*`, security definer, first parameter `p_client_request_id uuid` (idempotent: the same id returns the first result), row locks, rights + state + period + stock checks; history by triggers. Dates default to today; stock moves are dated today and pass `app.check_stock_date`. Money (18,2), quantities (18,3).

### Licences, families, formulas

| RPC | Right | Params | Returns | Rule codes |
|---|---|---|---|---|
| `upsert_licence(crid, p)` | settings.manage (Admin) | `id?`, `company_id`, `branch_id`, `kind`, `licence_no`, `issued_by`, `valid_from`, `valid_to`, `status` active\|suspended\|cancelled, `document_path`, `note` | `{id}` | licence.no_number, licence.dates, org.branch_other_company |
| `upsert_process_family(crid, p)` | production.edit | `id?`, `company_id`, `code`, `name`, `licence_kind` (null = none), `steps` [text], `status` | `{id}` | prod.family_name |
| `save_formula_version(crid, p)` | production.create | `company_id`; `formula_id` **or** (`product_id`, `family_id`, `code`, `name`); `version_id?` (edit a draft); `batch_size` (kg), `fill_qty_g`, `notes`, `qc_spec` [{parameter, min, max, unit, stage in_process\|bulk\|finished}], `lines` [{line_kind bulk\|packaging, product_id, qty, note}] | `{formula_id, version_id, version, status}` | prod.bulk_by_weight, prod.packaging_in_nos, prod.pack_in_nos, formula.batch_size, formula.no_bulk, formula.not_draft, formula.qty, formula.line_kind, prod.family_missing |
| `submit_formula_version(crid, p_version_id)` | production.create | | `{id, status}` | formula.state |
| `approve_formula_version(crid, p_version_id, p_effective_from date?)` | production.approve, **not** the writer/submitter | supersedes the version in force (ends the day before) | `{id, status, effective_from}` | **sod.own_formula**, formula.state, formula.effective_overlap |
| `withdraw_formula_version(crid, p_version_id, p_reason)` | production.approve | reason ≥ 5 | `{id, status}` | formula.state |

### Batches (Biochem production entry)

| RPC | Right | Params | Returns | Rule codes |
|---|---|---|---|---|
| `plan_batch(crid, p)` | production.create | `company_id`, `product_id`, `formula_version_id?` (default: in force on the date), `planned_qty` (kg bulk), `date`, `shift`, `line_place_id`, `stores_place_id`, `fg_place_id`, `note` | `{id, batch_no, status, formula_version_id, licence_id}` | **prod.no_approved_formula**, **licence.missing**, **licence.expired**, prod.qty, stock.place_other_company, stock.same_place |
| `reserve_batch_materials(crid, p_batch_id)` | production.create | reserves bulk lines × planned ÷ batch size at the stores | `{id, status, lines}` | batch.state, stock.insufficient, licence.* |
| `record_weighing(crid, p_batch_id, p_lines)` | production.create | `[{product_id, lot_id?, qty (kg), scale_asset_id?, note}]` | `{batch_id, weighing_ids[]}` | prod.not_in_formula, stock.lot_not_released, asset.calibration_due, asset.not_in_use |
| `verify_weighing(crid, p_weighing_id, p_ok bool = true, p_note?)` | production.create, **not** the weigher | OK → stock out of the stores (`consumption`) + consumption ledger; all lines checked → `weighed` | `{id, status, value, batch_status}` | **sod.own_weighing**, weighing.state |
| `start_batch(crid, p_batch_id)` | production.create | | `{id, status}` | batch.state, weighing.pending |
| `send_sample(crid, p_batch_id, p)` | production.create | `kind` in_process\|bulk\|finished\|retained, `bulk_qty` (kg, required for bulk), `labour_hours`, `machine_hours`, `assigned_to`, `retain_until`, `note` | `{sample_id, sample_no, batch_status}` | prod.no_bulk_qty, batch.state |
| `record_lab_result(crid, p_sample_id, p)` | qc.test (rnd samples: lab.rnd) | `result` pass\|fail\|hold, `parameters` {name: number}, `instrument_id`, `remarks`, `date` | `{id, result, out_of_spec[]}` | **qc.out_of_spec**, qc.sample_state, qc.result, asset.calibration_due |
| `issue_batch_packaging(crid, p_batch_id, p_lines)` | production.create | `[{product_id, lot_id?, qty (whole Nos)}]` stores → line | `{batch_id, lines, status}` | prod.packaging_in_nos, prod.packaging_whole, stock.insufficient |
| `record_packing(crid, p_batch_id, p)` | production.create | `good_packs`, `rejected_packs`, `bulk_scrap_kg`, `bulk_left_kg`, `labour_hours`, `machine_hours`, `mfg_date`, `expiry_date`, `packaging` [{product_id, scrapped, returned, at_line}] | `{batch_id, status, fg_lot_id, unit_cost, recon}` | prod.no_good_packs, prod.no_bulk_qty, prod.no_fill_weight, prod.not_issued, prod.recon_decrease |
| `reconcile_packaging(crid, p_batch_id, p_counts?)` | production.create | optional recount `[{product_id, scrapped, returned, at_line}]` (scrapped/returned only go up) | `{batch_id, balanced, packaging_ok, bulk{bulk_qty, packed_kg, scrap_kg, left_kg, difference, tolerance_pct, tolerance_set, tolerance_kg, ok}, items[{product_id, product_code, product_name, issued, in_good, in_rejected, scrapped, returned, at_line, difference}], bug_item_id}` | batch.state |
| `qc_release_batch(crid, p_batch_id, p_note?)` | qc.release, **not a batch maker** | needs a passed bulk test and the latest finished test = pass | `{batch_id, status, released_qty}` | **sod.self_release**, qc.no_test, qc.no_pass |
| `qc_reject_batch(crid, p_batch_id, p_reason)` | qc.release, not a batch maker | packed_hold (failed finished test) or bulk_failed | `{batch_id, status, rejected_qty}` | sod.self_release, qc.no_fail |
| `close_batch(crid, p_batch_id)` | production.approve | reconciliation must balance; fixes `prod.batch_costs` | `{batch_id, status, cost{materials, packaging, labour, machine, overhead, total, good_packs, cost_per_pack, rates_missing[]}}` | **prod.recon_mismatch** |
| `cancel_batch(crid, p_batch_id, p_reason)` | production.edit | planned/reserved, nothing issued | `{batch_id, status}` | batch.has_issues |
| `set_cost_rate(crid, p)` | settings.manage | `company_id`, `kind` labour_hour\|machine_hour\|overhead_per_kg\|overhead_per_piece, `rate`, `effective_from`, `note` | `{id}` | cost.rate |

"Batch maker" = planner, weighers and checkers, starter, packaging issuers, packer, anyone assigned a non-QC duty on the batch (`app.batch_makers`).

### Labs, work assignment, assets

| RPC | Right | Params | Returns | Rule codes |
|---|---|---|---|---|
| `save_rnd_trial(crid, p)` | lab.rnd | `id?`, `company_id`, `code`, `title`, `family_id`, `formula_version_id`, `assigned_to`, `status`, `started_on`, `notes` | `{id}` | rnd.code |
| `record_stability_check(crid, p_trial_id, p)` | lab.rnd | `day_no`, `condition`, `due_on`, `result` pass\|fail\|watch (null = plan only), `observations` | `{id}` | rnd.day |
| `send_trial_sample(crid, p_trial_id, p)` | lab.rnd | `assigned_to`, `note` | `{sample_id, sample_no}` | |
| `assign_shift_duties(crid, p)` | production.edit | `company_id`, `place_id`, `work_date`, `shift`, `assignments` [{user_id, duty, batch_id, asset_id, hours}] | `{ids[]}` | **sod.self_release**, work.not_staff, work.date |
| `remove_shift_duty(crid, p_assignment_id, p_reason)` | production.edit | | `{id, removed}` | work.batch_started |
| `upsert_asset(crid, p)` | assets.manage | `id?`, `company_id`, `code`, `name`, `kind`, `place_id` (on add), `make`, `model`, `serial_no`, `attrs`, `purchase_date`, `put_to_use_date`, `cost`, `useful_life_years`, `residual_pct`, `needs_calibration`, `calibration_interval_days`, `calibration_due` (on add), `amc_vendor`, `amc_until` | `{id}` | asset.code |
| `record_asset_event(crid, p_asset_id, p)` | assets.manage | `kind` moved\|repair\|service\|amc\|breakdown\|restored\|disposed\|note, `date`, `place_id` (moved), `amc_until` (amc), `detail`, `amount` | `{id}` | asset.event_kind, asset.disposed |
| `record_calibration(crid, p_asset_id, p)` | assets.manage or qc.test | `calibrated_on`, `next_due` (default + interval), `result` pass\|adjusted\|fail, `agency`, `certificate_path`, `remarks` | `{id, next_due}` | asset.calibration_result, asset.next_due |
| `add_asset_document(crid, p_asset_id, p)` | assets.manage | `kind`, `path`, `valid_to` | `{id}` | asset.document_path |

### Packs (free items, gift and combo packs)

| RPC | Right | Params | Returns | Rule codes |
|---|---|---|---|---|
| `upsert_pack(crid, p)` | production.edit | `id?`, `company_id`, `product_id`, `kind` free_item_pack\|gift_pack\|combo_pack, `name`, `status`, `items` [{product_id, qty, is_free, note}] (replaces) | `{id, items}` | pack.name, pack.self, pack.qty |
| `set_pack_gst_treatment(crid, p_pack_id, p_treatment, p_note)` | settings.manage (Admin) | treatment free_with_sale_single_price\|gift_without_consideration\|mixed_supply\|composite_supply; note = CA's advice | `{id, gst_treatment}` | pack.gst_treatment |
| `post_pack_assembly(crid, p)` | production.create | `pack_id`, `qty` (whole), `from_place_id`, `to_place_id`, `date` | `{id, doc_no, unit_cost}` | pack.no_items, pack.inactive, stock.insufficient |

A pack without a GST treatment cannot be put on a sales document (`pack.gst_treatment_unset`, trigger).

### Plastics

| RPC | Right | Params | Returns | Rule codes |
|---|---|---|---|---|
| `save_mould_project(crid, p)` | production.edit | `id?`, `company_id`, `code`, `name`, `product_id`, `ownership` own\|buyer, `buyer_party_id`, `target_date`, `estimated_cost`, `notes` | `{id}` | mould.code, mould.buyer, mould.project_closed |
| `advance_mould_project(crid, p_project_id, p_stage, p_note?)` | production.edit (`approved`: production.approve, not the creator) | next stage only, or `dropped` (note ≥ 5) | `{id, stage}` | mould.stage_order, **sod.own_approval** |
| `upsert_mould(crid, p)` | production.edit | `id?`, `company_id`, `code`, `name`, `project_id`, `product_id`, `material_product_id`, `cavities`, `cycle_time_sec`, `part_weight_g`, `runner_weight_g`, `ownership`, `buyer_party_id`, `place_id`, `service_interval_shots`, `life_shots`, `cost`, `shot_count` (on add), `status` retired | `{id}` | mould.cavities |
| `move_mould(crid, p_mould_id, p)` | production.create | `location` rack\|machine\|repair\|buyer\|other, `machine_asset_id`, `place_id`, `date`, `note` | `{id, location}` | mould.machine, mould.machine_busy |
| `record_mould_service(crid, p_mould_id, p)` | production.create | `kind` service\|repair, `amount`, `date`, `note` (resets shots since service) | `{id, shots_at_service}` | |
| `record_injection_shift(crid, p)` | production.create | `company_id`, `place_id`, `output_place_id`, `date`, `shift`, `machine_asset_id`, `mould_id`, `operator_user_id`/`operator_name`, `cavities_running`, `planned_minutes`, `shot_start`, `shot_end`, `good_qty`, `rejects` [{reason, qty}], `downtime` [{kind, reason, minutes}], `materials` [{product_id, qty, place_id}], `regrind` [{product_id, qty, place_id}], `scrap` {product_id, qty, place_id}, `note` | `{id, doc_no, lot_id, run_minutes, theoretical_qty, total_qty, shots, availability, performance, quality, oee}` | shift.cavities, shift.planned, shift.downtime, shift.good, shift.shots, mould.not_active, mould.no_product, scrap.not_scrap_item, stock.insufficient |
| `record_quality_inspection(crid, p)` | qc.test (final/assembly: qc.release), **not** the maker/recorder | `lot_id`, `kind` first_piece\|patrol\|final\|assembly, `sample_qty`, `accepted_qty`, `rejected_qty`, `result`, `defects`, `remarks`, `date` | `{id, lot_status}` | **sod.inspector_maker**, qc.qty_mismatch, qc.not_inspection_lot |
| `save_assembly_bom(crid, p)` | production.edit | `company_id`, `product_id`, `notes`, `lines` [{product_id, qty_per, note}] | `{id, version, status}` | bom.self, bom.qty |
| `approve_assembly_bom(crid, p_bom_id)` | production.approve, not the writer | | `{id, status}` | sod.own_approval, bom.state |
| `post_assembly(crid, p)` | production.create | `product_id`, `qty` (whole), `from_place_id`, `to_place_id`, `date`, `labour_hours`, `note` | `{id, doc_no, lot_id, unit_cost}` | **prod.components_short** (lists every short item), bom.none_approved |
| `record_pad_print_job(crid, p)` | production.create | `company_id`, `date`, `product_id`, `machine_asset_id`, `operator_user_id`, `qty_printed`, `qty_rejected`, `prints_per_piece`, `ink_product_id`, `ink_qty`, `ink_place_id`, `labour_minutes`, `note` | `{id, doc_no, ink_value}` | print.qty, print.ink |
| `upsert_material_spec(crid, p)` | production.edit | `company_id`, `product_id`, `granule_product_id`, `grade`, `colour`, `masterbatch_product_id`, `masterbatch_pct`, `part_weight_g`, `runner_weight_g`, `cavities`, `packing_cost_per_piece` | `{id}` | |
| `record_machine_check(crid, p)` | production.create | `asset_id`, `date`, `shift`, `checklist` [{item, ok, note}], `remarks` | `{id, all_ok}` | check.empty |

Lots made by production (`inv.lots.source = 'production'`) are refused by `record_incoming_test`, `release_from_quarantine`, `reject_from_quarantine` (`qc.use_batch_release`).

### Phase 5 read views (security_invoker; RLS decides rows; cost columns null without `cost.view`)

| View | Columns |
|---|---|
| `api.licences` | id, company_id, company_name, branch_id, branch_name, kind, licence_no, issued_by, valid_from, valid_to, status, document_path, note, created_at, updated_at, is_valid, days_to_expiry |
| `api.process_families` | id, company_id, code, name, licence_kind, steps, status, created_at, formulas, approved_formulas, licence_ok |
| `api.formula_versions` | id, company_id, formula_id, formula_code, formula_name, product_id, product_code, product_name, family_id, family_code, family_name, version, status, batch_size, fill_qty_g, qc_spec, effective_from, effective_to, notes, created_by, created_by_name, created_at, submitted_by, submitted_at, approved_by, approved_by_name, approved_at, in_force, bulk_lines, packaging_lines |
| `api.formula_lines` | id, company_id, version_id, line_no, line_kind, product_id, product_code, product_name, uom, qty, note |
| `api.batches` | id, company_id, batch_no, product_id, product_code, product_name, formula_version_id, formula_code, formula_version, family_id, family_name, licence_id, licence_no, licence_valid_to, line_place_id, line_place_name, stores_place_id, stores_place_name, fg_place_id, fg_place_name, batch_date, shift, planned_qty, status, bulk_qty, bulk_scrap_kg, bulk_left_kg, fill_qty_g, good_packs, rejected_packs, fg_lot_id, mfg_date, expiry_date, labour_hours, machine_hours, recon_status, basis_locked, note, reject_reason, planned_by, planned_by_name, started_by, started_at, packed_by, packed_at, released_by, released_by_name, released_at, closed_by, closed_at, created_at, **i_made_it**, weighings_to_check, last_bulk_result, last_finished_result |
| `api.batch_events` | id, company_id, batch_id, from_status, to_status, note, by_user, by_name, at |
| `api.batch_weighings` | id, company_id, batch_id, product_id, product_code, product_name, lot_id, lot_no, planned_qty, weighed_qty, variance, scale_asset_id, scale_code, status, weighed_by, weighed_by_name, weighed_at, verified_by, verified_by_name, verified_at, note, i_can_check |
| `api.batch_packaging` | id, company_id, batch_id, product_id, product_code, product_name, uom, issued, in_good, in_rejected, scrapped, returned, at_line, difference, balanced, updated_at |
| `api.material_consumption` | id, company_id, source_table, source_id, batch_id, batch_no, kind, product_id, product_code, product_name, uom, lot_id, lot_no, place_id, place_name, qty, consumed_on, created_by, created_at, unit_cost†, value† |
| `api.batch_states` | step, status, label, rpc, next_states |
| `api.batch_costs` (cost.view) | batch_id, company_id, batch_no, status, product_id, product_code, product_name, family_id, family_name, final, materials, packaging, labour, machine, overhead, total, good_packs, cost_per_pack, rates_missing, mrp |
| `api.cost_rates` (cost.view) | id, company_id, kind, rate, effective_from, note, set_by, set_at |
| `api.lab_samples` | id, company_id, sample_no, kind, batch_id, batch_no, product_id, product_code, product_name, lot_id, lot_no, trial_id, trial_code, assigned_to, assigned_to_name, status, retain_until, note, taken_by, taken_by_name, taken_at, last_result, spec_parameters |
| `api.lab_tests` (extended) | id, company_id, lot_id, lot_no, product_id, product_name, kind, result, parameters, remarks, test_date, tested_by, tested_by_name, created_at, out_of_spec, batch_id, batch_no, sample_id, sample_no, instrument_id, instrument_code |
| `api.my_lab_work` | kind sample\|stability\|calibration\|release, id, company_id, ref, detail, sub_kind, due_on, mine, i_made_it |
| `api.rnd_trials` | id, company_id, code, title, family_id, family_name, formula_version_id, assigned_to, assigned_to_name, status, started_on, notes, created_at, next_check_due |
| `api.stability_checks` | id, company_id, trial_id, trial_code, day_no, condition, due_on, result, observations, recorded_by, recorded_by_name, recorded_at |
| `api.shift_assignments` | id, company_id, place_id, place_name, work_date, shift, user_id, user_name, duty, batch_id, batch_no, asset_id, asset_code, hours, assigned_by, assigned_at |
| `api.factory_workload` | company_id, work_date, shift, user_id, user_name, duties, duty_list, hours, batches |
| `api.assets` | id, company_id, company_name, code, name, kind, place_id, place_name, make, model, serial_no, attrs, purchase_date, put_to_use_date, useful_life_years, residual_pct, needs_calibration, calibration_interval_days, calibration_due, calibration_overdue, days_to_calibration, amc_vendor, amc_until, status, created_at, cost†, mould_on_machine, last_check_date |
| `api.asset_events` | id, company_id, asset_id, asset_code, kind, event_date, detail, amount, recorded_by, recorded_by_name, created_at |
| `api.calibrations` | id, company_id, asset_id, asset_code, asset_name, calibrated_on, next_due, result, agency, certificate_path, remarks, recorded_by, recorded_by_name, created_at |
| `api.asset_documents` | id, company_id, asset_id, kind, path, valid_to, uploaded_by, created_at |
| `api.packs` | id, company_id, product_id, product_code, product_name, kind, name, gst_treatment, gst_treatment_note, gst_treatment_set, gst_treatment_set_at, status, created_at, items, free_items |
| `api.pack_items` | id, company_id, pack_id, product_id, product_code, product_name, uom, qty, is_free, note |
| `api.pack_assemblies` | id, company_id, doc_no, pack_id, pack_name, qty, from_place_id, to_place_id, assembly_date, assembled_by, created_at, unit_cost† |
| `api.mould_projects` | id, company_id, code, name, product_id, product_code, product_name, ownership, buyer_party_id, buyer_name, stage, target_date, notes, created_by, created_at, approved_by, approved_at, estimated_cost† |
| `api.moulds` | id, company_id, code, name, project_id, product_id, product_code, product_name, material_product_id, material_code, cavities, cycle_time_sec, part_weight_g, runner_weight_g, ownership, buyer_party_id, buyer_name, location, place_id, place_name, machine_asset_id, machine_code, shot_count, shots_at_last_service, shots_since_service, service_interval_shots, service_due, life_shots, life_used_pct, status, created_at |
| `api.mould_events` | id, company_id, mould_id, mould_code, project_id, kind, event_date, detail, shots, source_id, recorded_by, recorded_by_name, created_at, amount† |
| `api.mould_costs` (cost.view) | mould_id, company_id, code, name, cavities, shot_count, life_shots, cost, upkeep, cost_per_shot, cost_per_piece |
| `api.injection_shifts` | id, company_id, doc_no, place_id, place_name, output_place_id, shift_date, shift, machine_asset_id, machine_code, mould_id, mould_code, product_id, product_code, product_name, operator_user_id, operator_name, cavities_running, cycle_time_sec, planned_minutes, downtime_minutes, run_minutes, shot_start, shot_end, shots, good_qty, reject_qty, total_qty, theoretical_qty, availability, performance, quality, oee, lot_id, lot_status, note, recorded_by, created_at |
| `api.shift_rejects` / `api.shift_downtime` | id, company_id, shift_id, reason, qty / id, company_id, shift_id, kind, reason, minutes |
| `api.quality_inspections` | id, company_id, lot_id, lot_no, product_id, product_code, product_name, shift_id, assembly_order_id, kind, sample_qty, accepted_qty, rejected_qty, result, defects, remarks, inspection_date, inspected_by, inspected_by_name, created_at |
| `api.assembly_boms` | id, company_id, product_id, product_code, product_name, version, status, notes, created_by, created_by_name, created_at, approved_by, approved_by_name, approved_at, lines |
| `api.assembly_bom_lines` | id, company_id, bom_id, product_id, product_code, product_name, uom, qty_per, note, avg_cost† |
| `api.assembly_orders` | id, company_id, doc_no, bom_id, bom_version, product_id, product_code, product_name, qty, from_place_id, to_place_id, lot_id, lot_status, labour_hours, order_date, note, assembled_by, assembled_by_name, created_at, unit_cost† |
| `api.assembly_costs` (cost.view) | bom_id, company_id, product_id, product_code, product_name, version, components_cost, components_without_cost, mrp |
| `api.pad_print_jobs` | id, company_id, doc_no, job_date, product_id, product_code, product_name, machine_asset_id, machine_code, operator_user_id, operator_name, qty_printed, qty_rejected, prints_per_piece, ink_product_id, ink_qty, labour_minutes, note, created_at, ink_value†, cost_per_print† |
| `api.material_specs` | id, company_id, product_id, product_code, product_name, granule_product_id, granule_code, grade, colour, masterbatch_product_id, masterbatch_code, masterbatch_pct, part_weight_g, runner_weight_g, cavities, packing_cost_per_piece, set_at |
| `api.component_costs` (cost.view) | company_id, product_id, product_code, product_name, part_weight_g, runner_weight_g, cavities, granule_cost, masterbatch_cost, packing_cost, mould_cost, granule_cost_missing |
| `api.machine_checks` | id, company_id, asset_id, asset_code, asset_name, check_date, shift, checklist, all_ok, remarks, checked_by, checked_by_name, created_at |

† null without `cost.view`.

## Phase 6 RPCs (delivery and sales)

Every changing RPC: `api.*`, security definer, `p_client_request_id uuid` first (same id → same result, nothing changes twice), row locks, rights / state / period / stock / credit / cash checks. Money `numeric(18,2)`, quantities `numeric(18,3)`. Reads marked *(read)*. Nested Phase 3 calls (invoice, posting) use `app.child_crid(crid, tag)` so a retry is idempotent end to end.

### Orders and credit (screens SalesOrders, CreditControl, Take order)

| RPC | Parameters (jsonb keys) | Returns | Rights / rules |
|---|---|---|---|
| `api.confirm_sales_order(crid, p_header jsonb, p_lines jsonb)` | header: company_id, gstin_id (default principal), party_id, order_date, delivery_date, channel `direct\|field\|shop\|online\|export\|private_label`, payment `credit\|cash\|advance`, place_id, price_list_id (office only), place_of_supply, buyer_po_no, buyer_po_date, notes, private_label_id, salesman_user_id (office), device_created_at; lines: [{product_id, qty, rate, discount}] | {id, doc_no, status `confirmed\|pending_credit\|pending_approval`, totals, reserved_lines, credit} | `sales.create`, or `field.sell` for the salesman's own customer (rate = price list, `order.price_locked`, `order.no_price_list`, `order.discount_over_authority`). `order.kyc_cash_only`, `party.missing`, `party.not_linked`, `price.above_mrp`, `gst.no_rate`, `order.private_label_missing`. Credit orders over limit + live exceptions → `pending_credit`. Queues `order_confirmed` when confirmed. |
| `api.check_credit_exposure(p_company_id, p_party_id, p_extra numeric)` *(read)* | | {limit, credit_status, terms, receivables, open_orders, exception, exposure, available, extra, blocked, hidden_items} (+ receivables_gst for Admin/CA) | sales/accounts or the assigned salesman. Non-Admin: GST figures only; `blocked` always from the full exposure |
| `api.release_order(crid, p_order_id)` | | {id, status} | `sales.approve` or `credit.md_exception`; never the creator (`sod.own_request`); `credit.over_limit`, `order.private_label_pending`, `order.state` |
| `api.grant_md_exception(crid, p)` | company_id, party_id, order_id?, amount, valid_until (future), reason (≥ 5) | {id, order_status} | `credit.md_exception`; not the order's creator (`sod.own_request`); logged (`admin_action/credit_exception`); releases the held order when it now fits. `credit.exception_until`, `credit.exception_amount` |
| `api.cancel_sales_order(crid, p_order_id, p_reason)` | | {id, status} | `sales.cancel`; nothing dispatched (`order.state`); reservations released |
| `api.submit_credit_application(crid, p)` | company_id, party_id, requested_limit, requested_term_id, expected_monthly, security, note | {id, doc_no, stage 3} | `credit.request` (salesman: own customer). `credit.application_open`, `credit.limit_amount` |
| `api.approve_credit_stage(crid, p_application_id, p_stage int, p_decision 'approved'\|'rejected', p jsonb)` | limit, term_id, review_on (stage 6), note (required to reject) | {id, status, stage} | stage 3 `credit.endorse`, 4 `credit.verify` (KYC verified, `credit.kyc_not_verified`), 5 `credit.recommend`, 6 `credit.approve` (`credit.review_date`, `credit.terms_required`, `party.msme_terms`). `credit.wrong_stage`, `sod.own_request`, `credit.same_person` |
| `api.set_credit_status(crid, p_company_id, p_party_id, p_status 'active'\|'hold'\|'review', p_reason)` | | {ok} | `credit.recommend` or `credit.approve`; active only with an approved application (`credit.no_approval`) |

### Dispatch, trips, driver app, vehicles (screens Dispatch, Trip, DriverTrip, DriverPOD, Vehicles, VehicleFile)

| RPC | Parameters | Returns | Rights / rules |
|---|---|---|---|
| `api.create_dispatch(crid, p)` | order_id, place_id (default the order's), scheduled_at, eway_bill_no, lines [{order_line_id, qty}] (empty = all open) | {id, doc_no, value} | `logistics.create`; `order.not_confirmed`, `dispatch.place`, `dispatch.over_order`, `dispatch.no_lines` |
| `api.invoice_dispatch(crid, p_dispatch_id, p)` | doc_date, gstin_id, notes | {dispatch_id, document_id, doc_no, total} | `sales_invoices.create`; Phase 3 `save_sales_draft` + `post_sales_document` (GST, MRP, numbering, GL, invoice message) then link. `dispatch.already_invoiced` |
| `api.link_dispatch_document(crid, p_dispatch_id, p_document_id)` | | {dispatch_id, document_id} | `logistics.edit` or `sales_invoices.create`; `dispatch.document`, `dispatch.document_short`, `dispatch.state` |
| `api.set_dispatch_eway(crid, p_dispatch_id, p_eway_bill_no)` | 12 digits | {id} | `logistics.edit`; `dispatch.eway_format` |
| `api.create_trip(crid, p)` | company_id, trip_date, vehicle_id \| transporter, driver_user_id, lr_no, dispatch_ids [] | {id, doc_no} | `logistics.create`; `vehicle.document_expired` (Admin overrides), `vehicle.not_active`, `trip.dispatch` |
| `api.assign_to_trip(crid, p_trip_id, p_dispatch_ids jsonb)` | | {trip_id, added} | `logistics.edit`; `trip.state` |
| `api.start_trip(crid, p_trip_id, p)` | odometer_start, gps_notice_ack | {id, status, dispatches} | the trip's driver (`trip.drive`) or `logistics.edit`. `dispatch.no_invoice`, `dispatch.eway_required` (unless under `eway.threshold_amount`), `credit.over_limit`, `stock.insufficient`, `stock.reserved`, `stock.lot_on_hold`. Stock out (`dispatch`), `dispatched` message; opens the driver's GPS window when the notice is acknowledged |
| `api.mark_stop_arrived(crid, p_stop_id)` | | {id, status} | driver / logistics |
| `api.record_pod(crid, p_stop_id, p)` | received_by_name, receiver_phone (only last 4 kept), signature_path, photo_paths [] (bucket `pod`, `<company_id>/…`), lat, lng, device_at, remarks, lines [{dispatch_line_id, qty_delivered, short_reason}] | {stop_id, status, short} | driver / logistics. `pod.receiver`, `pod.proof`, `pod.bad_path`, `pod.qty`, `pod.short_reason`, `pod.already`. Short goods → quarantine at the dispatch place; GPS stored only on the driver's open trip window; `delivered` message |
| `api.record_failed_delivery(crid, p_stop_id, p_reason)` | | {stop_id, status} | driver / logistics; everything back to quarantine, order quantity reopened |
| `api.close_trip(crid, p_trip_id, p)` | odometer_end | {id, status} | driver / logistics; `trip.open_stops`; ends the driver's GPS window |
| `api.my_trip()` *(read)* | | {trip_id, doc_no, status, trip_date, vehicle, stops [{stop_id, seq, status, dispatch_id, dispatch_no, customer, scheduled_at, address, contact_masked, lines [{dispatch_line_id, product, qty, uom}]}]} | the driver's own current trip |
| `api.upsert_vehicle(crid, p)` | id?, company_id, reg_no, kind, ownership, transporter, payload_kg, usual_driver_user_id, place_id, status | {id} | `logistics.create` / `logistics.edit` |
| `api.set_vehicle_document(crid, p)` | vehicle_id, kind, doc_no, valid_to, path | {id} | `logistics.edit` |
| `api.record_vehicle_event(crid, p)` | vehicle_id, kind, event_date, odometer_km, litres, amount, trip_id, paid_by, note | {id} | `logistics.create` |

### Route sales and the salesman portal (screens RouteSales, SalesmanApp + Customers, Customer page, Take order, Collect payment, Queries inbox, My day, End day)

| RPC | Parameters | Returns | Rights / rules |
|---|---|---|---|
| `api.plan_beat(crid, p)` | company_id, id?, code, name, salesman_user_id, weekday 1–7, active, customers [party_id] | {id, customers} | `field.manage`; assigns the customers to the beat's salesman |
| `api.assign_salesman(crid, p_company_id, p_party_id, p_user_id)` | | {ok} | `field.manage` |
| `api.start_duty(crid, p)` | company_id, notice_ack (true), lat, lng | {session_id} | `field.sell`; `gps.notice_required`, `duty.already_on` |
| `api.record_locations(crid, p_points jsonb)` | [{lat, lng, at, accuracy_m}] | {recorded} | own open session only: `gps.off_duty`, `gps.outside_duty` |
| `api.check_in_visit(crid, p)` | company_id, party_id, lat, lng, at, beat_id, planned, unplanned_reason, reason | {visit_id, geofence_ok, distance_m, radius_m, approval} | `field.sell`, own customer (`field.not_my_customer`), on duty (`gps.off_duty`); `visit.open`, `visit.unplanned_reason`, `visit.no_location`, **`visit.out_of_fence`** (outside `field.geofence_m` or no pin, without a reason) |
| `api.approve_out_of_geofence(crid, p_visit_id, p_approve bool, p_note)` | | {id, approval} | `field.manage`; not the salesman (`sod.own_request`); `visit.not_pending`; logged |
| `api.check_out_visit(crid, p_visit_id, p)` | lat, lng, at, outcome `order\|no_order\|collection\|follow_up`, no_order_reason, shelf, competitor_notes, photo_paths (bucket `field`), next_visit_on | {visit_id, check_out_distance_m} | own visit; `visit.outcome`, `visit.no_order_reason`, `field.bad_path`, `visit.closed` |
| `api.field_collect(crid, p)` | company_id, party_id, amount, mode `cash\|cheque\|upi\|bank`, reference, cheque_photo_path, visit_id, date | {voucher_id, doc_no, allocated [{kind, bill_ref, amount}], on_account, balance_gst} | `field.sell`, own customer. `cash.receipt_blocked` (Phase 3 limit), `field.cheque_photo`, `field.reference`, `money.account`, `posting.rule_missing` (`field.cash_in_hand`, `field.collection_bank`). Oldest bill first among the bills in scope; receipt message |
| `api.cash_handover(crid, p)` | company_id, denominations {"500": n, …}, cheques | {id, expected, counted, difference} | `field.sell`; `field.handover_pending` |
| `api.confirm_cash_handover(crid, p_handover_id, p)` | denominations, to_account_id (cash) | {id, status `confirmed\|mismatch`, difference, contra_voucher_id} | `cash_book.create`, another login (`sod.own_request`); mismatch → Bug fixer item |
| `api.resolve_cash_handover(crid, p_handover_id, p_note)` | | {id, status, contra_voucher_id} | `cash_book.approve`, not the salesman |
| `api.end_salesman_day(crid, p)` | company_id, unsynced (count on the phone), van_counts | {id, visits_planned, visits_done, orders_total, collections_total} | `field.unsynced`, `gps.off_duty`, `visit.open`, `field.cash_not_handed_over`, `field.handover_pending`; closes the duty session |
| `api.log_query(crid, p)` | company_id, party_id, kind, document_id, lot_id, description, photo_paths | {id, complaint_id} | `sales.create` or own customer; `query.document` |
| `api.answer_query(crid, p_query_id, p)` | status, reply, next_step, assigned_to | {id} | `sales.edit` |
| `api.record_promise_to_pay(crid, p)` | company_id, party_id, amount, promised_on, note | {id} | own customer / sales.create; `promise.date` |
| `api.send_statement_whatsapp(crid, p_company_id, p_party_id, p_to date)` | | {outbox_id, status, skip_reason} | sales/accounts or own customer; `statement.admin_only` when the statement holds a bill without GST and the sender is not Admin; registered consented number only |
| `api.salesman_customer_account(p_company_id, p_party_id)` *(read)* | | {scope, as_of, balance_due, ageing {not_due, 0-30, 31-60, 61-90, 90+}, overdue, credit_limit, credit_status, available_credit, credit_blocked, last_payment, promises, open_bills [{kind, id, bill_ref, bill_date, due_date, amount, open_amount, days_overdue}]} | own customer or sales.view; `salesman_balance_scope` (gst_only until the owner decides) |
| `api.my_customers(p_company_id)` *(read)* | | [{party_id, name, trade_name, gstin, kyc_status, credit_status, tier, overdue_gst, open_queries, last_visit, last_order, pin, phone_masked}] | `field.sell` |
| `api.my_route_today(p_company_id, p_date)` *(read)* | | [{beat_id, beat, seq, party_id, name, pin, overdue_gst, open_query, credit_hold, kyc_missing, visited, last_visit, last_order}] | `field.sell` |
| `api.my_day(p_company_id, p_date)` *(read)* | | {date, on_duty, visits_planned, visits_done, orders_total, collections_total, cash_with_me, cheques_with_me} | `field.sell` |
| `api.route_sales_board(p_company_id, p_date)` *(read)* | | [{user_id, name, on_duty, visits [...], exceptions, orders_total, collected, cash_with_salesman, last_point}] | `field.manage` |
| `api.purge_gps(crid)` | | {retention_days, points_deleted, visits_cleared, pods_cleared} | Admin (pg_cron runs `app.purge_gps` nightly) |
| `api.set_customer_price_list(crid, p_company_id, p_party_id, p_price_list_id)` (migration 006700) | p_price_list_id null clears | {company_id, party_id, price_list_id} | `sales.edit` or `field.manage`; `party.not_linked`, `price_list.other_company` (active list of the same company). Sets `master.party_companies.price_list_id`, which salesman orders price from (audited by the table trigger) |
| `api.customer_price_list(p_company_id, p_party_id)` *(read)* | | {price_list_id, name, tax_inclusive, items [{product_id, code, name, uom, min_qty, price, rate (net of GST via `app.list_rate`), mrp}]} | `app.can_sales_party` (sales/accounts view or the assigned salesman); `rights.missing` |

### Customer care, shops, exports, online (screens SalesControls, Outlets, ShopSales, ExportOrders, OnlineListings, OnlineSales)

| RPC | Parameters | Returns | Rights / rules |
|---|---|---|---|
| `api.log_complaint(crid, p)` | company_id, party_id, document_id, product_id, lot_id, kind, description, severity | {id, doc_no} | sales.create or own customer; `complaint.lot`, `complaint.description`; `complaint_update` message |
| `api.qc_hold_batch(crid, p)` | lot_id, complaint_id, reason | {hold_id, qty_held} | `qc.release` or `qc.test`; `qc.already_on_hold`. Moves available → hold everywhere (`qc_hold`), lot status hold |
| `api.qc_release_hold(crid, p_hold_id, p_decision 'release'\|'reject', p_note)` | | {hold_id, status} | `qc.release` |
| `api.update_complaint(crid, p_complaint_id, p)` | status `investigating\|resolved\|rejected`, note, assigned_to | {id, status} | sales.edit or QC |
| `api.close_complaint(crid, p_complaint_id, p_resolution)` | | {id, status} | `sales.approve`; `complaint.not_alone`, `complaint.hold_open`, `complaint.closed` |
| `api.set_coverage_tier(crid, p)` / `api.set_customer_tier(crid, p_company_id, p_party_id, p_tier)` | company_id, tier, call_every_days, visit_every_days, grace_days | {ok} | `field.manage`; `coverage.tier` |
| `api.log_call(crid, p)` | company_id, party_id, outcome `reached\|no_answer\|deferred`, note, next_action | {id} | own customer / sales.create |
| `api.submit_private_label(crid, p)` / `api.approve_private_label(crid, p_id, p_stage 'sales'\|'quality'\|'md', p_approve, p_note)` | company_id, party_id, brand_name, spec, artwork_path | {id[, status]} | sales.create / sales.approve, qc.release, credit.approve; three different people, none the creator (`sod.own_request`, `private_label.same_person`) |
| `api.upsert_agent(crid, p)` / `api.accrue_agent_commissions(crid, p_company_id, p_from, p_to)` | company_id, party_id, model, commission_pct, customers [] | {id} / {accrued, commission} | sales.approve / accounts.create. Only cash receipts or bank receipts matched to a statement line; GST invoices of the agent's customers; never twice |
| `api.upsert_shop(crid, p)` | company_id, branch_id (kind shop), place_id, walk_in_party_id, cash_account_id, bank_account_id, price_list_id, active | {id} | `settings.manage` |
| `api.shop_sale(crid, p)` | shop_id, party_id (default walk-in), doc_date, lines [{product_id, qty, rate, discount}], payment {mode cash\|upi\|card} | {document_id, doc_no, total, receipt_voucher_id, receipt_no} | `shop.operate` + `sales_invoices.create`; Phase 3 invoice, stock out (`sale`), `stock.lot_on_hold`, cash limit, receipt allocated to the invoice |
| `api.shop_day_close(crid, p)` | shop_id, day, denominations, upi_total, card_total | {id, status `closed\|mismatch`, expected_cash, counted_cash, difference} | `shop.operate`; `shop.day_closed`; mismatch → Bug fixer item |
| `api.create_export_order(crid, p)` | company_id, party_id (overseas), order_date, currency, fx_rate, incoterm, port_of_loading, destination, lut_ref, lut_valid_to, lines [{product_id, qty, rate_fc}] | {id, doc_no} | `exports.create`; `export.not_overseas`, `export.fx_rate` |
| `api.add_container(crid, p)` / `api.check_packing_list(crid, p_container_id, p_loaded jsonb)` | export_order_id, container_no, seal_no, packing_list [{product_id, cartons, pieces}] / loaded | {id, container_no} / {id, status, differences} | `exports.edit`; `export.container_no` (ISO 6346 check digit) |
| `api.post_export_invoice(crid, p)` | export_order_id, gstin_id, doc_date, lut (default true), shipping_bill_no, shipping_bill_date, port_code, lines (default the order's) | {document_id, doc_no, total_inr, value_fc, currency, lut} | `exports.create` + `sales_invoices.create`; LUT: Admin only (`gst.without_admin_only`), `export.lut_expired`; without LUT: IGST, place of supply 96 |
| `api.upsert_online_channel(crid, p)` | company_id, code, gstin_id, party_id, place_id, tcs_applicable, status | {id} | `settings.manage` |
| `api.publish_listing(crid, p)` | channel_id, product_id, title, price, publish | {id, status, blockers} | Admin; `listing.blocked` (barcode, mrp, price_above_mrp, price, not_active) |
| `api.ingest_online_order(crid, p)` | channel_id, external_order_id, order_date, ship_state, lines [{product_id \| sku, qty, price_incl_tax}] | {online_order_id, order_id, doc_no, duplicate} | `sales.create` (Edge Function `store-webhooks`, Phase 8); same order twice → first result; `online.unknown_item` |

### GST page and Schedule III (screens GST, Reports, ScheduleIIIBiochem)

| RPC | Returns | Rights |
|---|---|---|
| `api.gstr1_summary(p_company_id, p_gstin_id \| null, p_from, p_to)` *(read)* | {b2b [{party_gstin, party_name, invoices, taxable, cgst, sgst, igst, total}], b2cl [...] (only when `gst.b2cl_invoice_value` set), b2cs [{pos, rate, taxable, cgst, sgst, igst}], exp [{doc_no, doc_date, with_payment, taxable, igst, total, shipping_bill_no, shipping_bill_date, port_code}], cdnr, cdnur, hsn [{hsn_code, uom, rate, qty, taxable, cgst, sgst, igst, total}], nil_exempt_non_gst (Admin/CA only), docs [{doc_type, series, from_no, to_no, issued, cancelled}], totals {taxable, cgst, sgst, igst, total}, all_supplies, b2cl_threshold_set} | `gst.view` or `reports.view` |
| `api.gstr3b_summary(p_company_id, p_gstin_id, p_from, p_to)` *(read)* | {outward_taxable {taxable, igst, cgst, sgst}, outward_zero_rated, outward_nil_exempt (Admin/CA), outward_non_gst (Admin/CA), inward_reverse_charge, itc_available {igst, cgst, sgst, bills}, itc_ineligible, output_tax, net_before_setoff, note} | same |
| `api.itc_register(p_company_id, p_from, p_to)` *(read, table)* | bill_id, gstin_id, supplier, supplier_gstin, supplier_bill_no, supplier_bill_date, bill_date, taxable, cgst, sgst, igst, itc, itc_eligible, reverse_charge, match_status (`await_2b`) | same |
| `api.set_schedule3_map(crid, p {account_group_id, line_code})` | {ok} | `settings.manage`; clears the CA confirmation |
| `api.confirm_schedule3_map(crid, p_company_id, p_note)` | {confirmed} | `settings.manage` (records the CA's confirmation) |
| `api.schedule3_statements(p_company_id, p_from, p_to)` *(read)* | {balance_sheet [{side, section, code, label, amount}], profit_and_loss [{section, code, label, amount}], profit_for_period, profit_brought_forward, unmapped_groups [{group_id, group, nature, balance}], mapping_confirmed_by_ca, totals {assets, equity_liabilities, difference}, all_transactions, status} | `reports.view` or `accounts.view`; GST view excludes without-GST GL entries |

The Phase 3 `api.trial_balance(company, from, to)` serves the trial balance tab.

### WhatsApp (screen WhatsApp & email) and Help data tools

| RPC | Parameters | Returns | Rights / rules |
|---|---|---|---|
| `api.schedule_reminders(crid, p_company_id, p_date)` | | {queued, skipped, date} | Admin or `receipts_payments.create`; pg_cron `payment-reminders` runs `app.schedule_reminders_all()` at 08:00 IST |
| `api.set_cost_cap(crid, p_company_id, p_monthly_cap, p_alert_pct)` / `api.set_message_rate(crid, p_category, p_est_cost, p_effective_from)` | | {ok} | Admin |
| `api.record_inbound(crid, p)` | wa_message_id, from_number, kind, body, media_path, company_id | {inbound_id, task_id, task_kind, party_id} \| {duplicate} \| {opted_out} | Admin or the webhook (service role). STOP words opt out |
| `api.resolve_task(crid, p_task_id, p_status 'done'\|'dismissed', p_note)` | | {id, status} | finance, Admin, or the assigned person (payment proofs: finance only, `task.finance_only`) |
| `api.reply_inbound(crid, p_inbound_id, p_text)` | | {outbox_id} | finance/salesperson/Admin; `msg.window_closed`, `msg.not_consented` |
| `api.help_get_document_status(p_doc_no)` *(read, invoker)* | | {found, documents [{kind, type, doc_no, date, status, amount, due_date}]} | RLS: a without-GST bill is not found for non-Admin |
| `api.help_check_my_rights(p_company_id, p_right)` *(read, invoker)* | | {view, roles, has_right, rights, special_permissions} | own rights only |
| `api.help_get_stock(p_query, p_company_id)` *(read, invoker)* | | [{company_id, product_code, product, uom, sellable, free, quarantine, hold, in_transit}] | `inventory.view` (no cost) |
| `api.help_my_requests()` *(read, invoker)* | | {special_permissions, staff_requests (no amounts), purchase_requests, credit_applications} | own rows |
| `api.help_request_permission(crid, p_right, p_company_id, p_hours, p_reason)` | | as `api.request_special_permission` | grantable rights only |

### Phase 6 read views (security_invoker; RLS decides rows; non-Admin sums are GST-only)

| View | Columns |
|---|---|
| `api.sales_orders` | id, company_id, company_name, gstin_id, doc_no, order_date, delivery_date, party_id, party_name, place_of_supply, channel, payment, salesman_user_id, salesman_name, place_id, place_name, price_list_id, buyer_po_no, buyer_po_date, notes, taxable, cgst, sgst, igst, round_off, total, status, credit_check, credit_exception_id, private_label_id, export_order_id, online_order_id, created_by, created_by_name, confirmed_by, confirmed_at, cancelled_at, cancel_reason, device_created_at, created_at, open_value, dispatches |
| `api.sales_order_lines` | id, order_id, line_no, product_id, product_code, description, hsn_code, uom, qty, rate, discount, taxable, gst_rate, cgst, sgst, igst, total, qty_dispatched, qty_delivered, qty_invoiced, qty_to_dispatch |
| `api.credit_customers` | company_id, party_id, party_name, gstin, kyc_status, customer_type, credit_status, credit_limit, credit_term_id, terms, credit_review_on, salesman_user_id, salesman_name, tier, beat, receivables, open_orders, exception, available, last_application |
| `api.credit_applications` | id, company_id, doc_no, party_id, party_name, requested_limit, requested_term_id, requested_terms, expected_monthly, security, note, stage, status, decided_limit, decided_term_id, review_on, reject_reason, requested_by, requested_by_name, created_at |
| `api.credit_approvals` | id, application_id, stage, decision, limit_amount, term_id, note, decided_by, decided_by_name, decided_at |
| `api.credit_exceptions` | id, company_id, party_id, party_name, order_id, amount, valid_until, reason, requested_by, granted_by, granted_by_name, granted_at, revoked_at, active |
| `api.promises_to_pay` | id, company_id, party_id, amount, promised_on, note, status, recorded_by, created_at |
| `api.vehicles` | id, company_id, reg_no, kind, ownership, transporter, payload_kg, usual_driver_user_id, usual_driver_name, place_id, status, created_at, next_expiry, has_expired_papers |
| `api.vehicle_documents` (latest per kind) | id, vehicle_id, kind, doc_no, valid_to, path, set_by, set_at, days_left |
| `api.vehicle_events` | id, company_id, vehicle_id, kind, event_date, odometer_km, litres, amount, trip_id, paid_by, note, recorded_by, created_at |
| `api.dispatches` | id, company_id, doc_no, order_id, order_no, party_id, party_name, place_id, place_name, scheduled_at, status, trip_id, trip_no, vehicle_id, vehicle_reg_no, document_id, invoice_no, eway_bill_no, value, dispatched_at, delivered_at, created_at, invoice_ready, eway_ready, pod_recorded |
| `api.dispatch_lines` | id, dispatch_id, order_line_id, product_id, product_code, product_name, uom, qty, qty_delivered, qty_returned, short_reason, lots |
| `api.trips` | id, company_id, doc_no, trip_date, vehicle_id, vehicle_reg_no, driver_user_id, driver_name, transporter, lr_no, status, odometer_start, odometer_end, started_at, closed_at, created_at, stops, stops_done |
| `api.trip_stops` | id, trip_id, seq, dispatch_id, dispatch_no, party_id, party_name, status, arrived_at, done_at, fail_reason |
| `api.pods` | id, company_id, stop_id, dispatch_id, received_by_name, receiver_phone_masked, signature_path, photo_paths, lat, lng, remarks, device_at, recorded_by, created_at |
| `api.beats` | id, company_id, code, name, salesman_user_id, salesman_name, weekday, active, customers |
| `api.beat_customers` | beat_id, party_id, party_name, seq |
| `api.visits` | id, company_id, salesman_user_id, salesman_name, party_id, party_name, beat_id, planned, unplanned_reason, check_in_at, distance_m, geofence_ok, out_of_fence_reason, approval, approved_by, approved_at, check_out_at, check_out_distance_m, outcome, no_order_reason, shelf, competitor_notes, photo_paths, next_visit_on, created_at |
| `api.gps_points` | id, company_id, user_id, user_name, session_id, at, lat, lng, accuracy_m, source |
| `api.field_collections` | id, company_id, salesman_user_id, salesman_name, party_id, party_name, voucher_id, receipt_no, amount, mode, reference, cheque_photo_path, handover_id, visit_id, collected_at |
| `api.cash_handovers` | id, company_id, salesman_user_id, salesman_name, cashier_user_id, cashier_name, handover_date, expected_cash, salesman_count, salesman_total, cashier_count, cashier_total, cheques, difference, status, to_account_id, contra_voucher_id, bug_item_id, resolved_by, resolution_note, created_at, confirmed_at |
| `api.day_closes` | id, company_id, user_id, user_name, close_date, visits_planned, visits_done, orders_total, collections_total, handover_id, van_counts, closed_at |
| `api.queries` | id, company_id, party_id, party_name, kind, document_id, document_no, lot_id, description, photo_paths, status, raised_by, raised_by_name, assigned_to, next_step, reply, complaint_id, created_at, updated_at, age_days |
| `api.coverage_tiers` | company_id, tier, call_every_days, visit_every_days, grace_days, set_by, set_at |
| `api.coverage_status` | company_id, party_id, party_name, tier, salesman_user_id, call_every_days, visit_every_days, grace_days, last_call, last_visit, call_due, visit_due, call_missed, visit_missed |
| `api.contact_attempts` | id, company_id, party_id, kind, outcome, note, next_action, visit_id, by_user, by_name, at |
| `api.complaints` | id, company_id, doc_no, party_id, party_name, document_id, document_no, product_id, product_name, lot_id, lot_no, kind, description, severity, status, logged_by, logged_by_name, assigned_to, qc_hold_id, hold_status, resolution, closed_by, closed_at, created_at |
| `api.complaint_events` | id, complaint_id, from_status, to_status, note, by_user, by_name, at |
| `api.qc_holds` | id, company_id, lot_id, lot_no, product_id, product_name, complaint_id, reason, status, qty_held, previous_lot_status, held_by, held_at, decided_by, decided_at, decision_note |
| `api.private_label_orders` | id, company_id, party_id, party_name, brand_name, spec, artwork_path, status, created_by, sales_approved_by, quality_approved_by, md_approved_by, rejected_by, reject_reason, created_at |
| `api.agents` | id, company_id, party_id, party_name, model, commission_pct, status, customers, commission_accrued |
| `api.agent_commissions` | id, company_id, agent_id, voucher_id, receipt_no, document_id, invoice_no, collected, commission, period_from, period_to, created_at |
| `api.shops` | id, company_id, branch_id, branch_name, gstin_id, gstin, place_id, place_name, walk_in_party_id, cash_account_id, bank_account_id, price_list_id, active |
| `api.shop_days` | id, company_id, shop_id, day, expected_cash, counted, counted_cash, upi_total, card_total, bills, difference, status, bug_item_id, closed_by, closed_by_name, closed_at |
| `api.export_orders` | id, company_id, doc_no, party_id, party_name, order_date, currency, fx_rate, incoterm, port_of_loading, destination, lut_ref, lut_valid_to, lines, status, created_at, containers |
| `api.containers` | id, export_order_id, container_no, seal_no, packing_list, loaded, check_status, check_result, checked_by, checked_at, created_at |
| `api.export_invoices` | document_id, doc_no, doc_date, total_inr, export_order_id, currency, fx_rate, value_fc, lut, shipping_bill_no, shipping_bill_date, port_code |
| `api.online_channels` | id, company_id, code, gstin_id, party_id, place_id, tcs_applicable, status, listed, orders |
| `api.listings` | id, channel_id, channel, company_id, product_id, product_code, product_name, title, price, status, blockers, published_by, published_at |
| `api.online_orders` | id, company_id, channel_id, channel, external_order_id, order_date, ship_state, order_id, order_no, order_status, status, created_at |
| `api.schedule3_lines` | code, statement, side, section, label, note_ref, sort |
| `api.schedule3_map` | company_id, account_group_id, group_name, nature, line_code, line_label, set_by, set_at, ca_confirmed, ca_note, confirmed_at |
| `api.msg_tasks` | id, company_id, kind, party_id, party_name, inbound_id, from_masked, message_kind, message_text, received_at, window_expires_at, priority, status, due_at, assigned_user_id, note, resolved_by, resolved_at, created_at |
| `api.msg_cost_caps` | company_id, monthly_cap, alert_pct, set_at, spent_this_month |
| `api.msg_message_rates` | id, category, est_cost, effective_from, set_at |
| `api.msg_cost_by_month` | company_id, month, category, event, messages, delivered_or_sent, skipped, est_cost |

## Phase 7 RPCs (the rest of operations)

Every changing RPC follows the same pattern:

- It is `api.*`, security definer, and takes `p_client_request_id uuid` first.
- It is idempotent: a repeat call returns the first result.
- It locks the rows it changes and checks rights, state and the period.
- History is written by triggers.

Errors carry a rule code in the hint. Amounts are `numeric(18,2)` and quantities `numeric(18,3)`.

### Job work (screen JobWork)

| RPC | Input | Returns | Right · rules |
|---|---|---|---|
| `api.issue_job_work_challan(crid, p jsonb)` | `{company_id, job_worker_party_id, process, goods_kind inputs\|capital_goods\|moulds_tools, from_place_id, sent_on?, note?, lines:[{product_id, lot_id?, qty}]}` | `{id, doc_no, challan_id, challan_no, return_by, jw_place_id}` | `production.create`. Moves stock to the job worker's place. Posts a delivery challan (`challan_not_sold`) from the sending GSTIN's series. `return_by` comes from `jobwork.return_years` (null for moulds_tools). Rule codes: `jobwork.*` (party, party_other_company, process, goods_kind, no_lines, no_gstin, limit_not_set), `stock.*`, `period.*`, `numbering.no_series` |
| `api.receive_job_work(crid, p_order_id, p jsonb)` | `{received_on?, challan_ref?, to_place_id? (default: sending place), lines:[{line_id, kind finished\|returned\|scrap\|loss, product_id?, qty, input_qty?, bucket? available\|quarantine}]}` | `{order_id, status, balance:[{line_id, product_id, sent, settled, balance}]}` | `production.create`. `input_qty` defaults to qty for `returned`, and for `finished` when it is the same item. It is required for a finished different item. Refuses `jobwork.over_balance`, `jobwork.closed`, `jobwork.date`, `jobwork.returned_item`, `jobwork.returned_qty`, `jobwork.loss_qty`, `jobwork.scrap_item`, `jobwork.input_qty` |

**Views:**

| View | Columns |
|---|---|
| `api.v_job_work_orders` | id, company_id, company_name, doc_no, challan_no, challan_document_id, sent_on, return_by, goods_kind, process, status, job_worker_party_id, job_worker_name, from_place_id, from_place_name, jw_place_id, note, goods, qty_sent, qty_back, qty_balance, days_left, **overdue**, return_state `returned\|overdue\|no_limit\|at_job_worker`, value_out (cost.view), created_by, created_at |
| `api.v_job_work_lines` | id, order_id, line_no, product_id, product_code, product_name, uom, lot_id, lot_no, qty_sent, qty_settled, balance, unit_cost (cost.view) |
| `api.v_job_work_receipts` | id, order_id, line_id, kind, product_id, product_name, qty, input_qty, to_place_id, to_place_name, value (cost.view), received_on, challan_ref, received_by_name |

ITC-04 data (sent and received, by date) comes from these views. The ITC-04 file format is a Phase 8 / CA item.

### Maintenance (screen Maintenance; OperatorCheck feeds it)

| RPC | Input | Returns | Right · rules |
|---|---|---|---|
| `api.raise_repair_request(crid, p)` | `{asset_id \| mould_id, title, description?, photo_path?, priority? urgent\|normal\|low, is_breakdown?, broke_down_at?}` | `{id, doc_no, status}` | `production.create` or `assets.manage`. A breakdown sets the asset to `repair` and adds an asset event. Rule codes: `repair.what`, `repair.title`, `date.future` |
| `api.update_repair_request(crid, p_request_id, p)` | `{status? assigned\|waiting_parts\|cancelled, assigned_to?, outside_vendor?, purchase_request_id?, priority?}` | `{id, status}` | `assets.manage` |
| `api.close_repair_request(crid, p_request_id, p)` | `{resolution, restored_at?, labour_cost?, outside_cost?}` | `{id, status:'done', downtime_minutes}` | `assets.manage`. Downtime runs from breakdown to restore. The machine goes back to active. Rule codes: `repair.resolution`, `repair.restore_before_breakdown` |
| `api.issue_spares(crid, p)` | `{company_id \| repair_request_id, asset_id?, place_id, issued_on?, lines:[{product_id, qty, lot_id?}]}` | `{doc_no, value}` | `assets.manage`. Moves stock through the ledger (`issue`) |
| `api.upsert_maintenance_schedule(crid, p)` | `{id?, asset_id, title, interval_days, next_due_on?, checklist?, active?}` | `{id}` | `assets.manage` |
| `api.record_maintenance_done(crid, p_schedule_id, p)` | `{done_on?, note?, cost?}` | `{id, next_due_on}` | `assets.manage` or `production.create` |
| `api.maintenance_summary(p_company_id)` | — | `{machines, checked_today, open_requests{status:n}, done_this_month, breakdown_hours_month, schedules_overdue, spend_month (cost.view)}` | invoker |

A ✗ on `api.record_machine_check` now also opens an urgent `operator_check` repair request (trigger).

**Views:**

| View | Columns |
|---|---|
| `api.v_repair_requests` | id, doc_no, asset_id, asset_code, asset_name, mould_id, mould_code, source, machine_check_id, title, description, photo_path, priority, is_breakdown, broke_down_at, restored_at, downtime_minutes (live while open), status, assigned_to, assigned_to_name, outside_vendor, purchase_request_id, resolution, labour_cost / outside_cost / spares_value (cost.view), raised_by_name, closed_at, created_at |
| `api.v_spares_issues` | id, doc_no, repair_request_id, asset_code, product_code, product_name, uom, qty, value (cost.view), issued_on, issued_by_name |
| `api.v_maintenance_schedules` | id, asset_id, asset_code, asset_name, title, interval_days, checklist, last_done_on, next_due_on, active, days_to_due, **overdue** |

### Licences and documents (screen Licences; Admin)

| RPC | Input | Returns | Right · rules |
|---|---|---|---|
| `api.upsert_licence(crid, p)` (extended) | Phase 5 fields + `{title, portal_url, owner_person_id, is_blocking, blocks:['production'\|'packing'], renewal_status, renewal_applied_on}` | `{id}` | `settings.manage`. Rule codes: `licence.blocks`, `licence.owner` |
| `api.renew_licence(crid, p_licence_id, p)` | `{valid_from, valid_to, licence_no?, document_path?, note?}` | `{id, renewal_id, valid_to}` | `settings.manage`. The old dates go to `core.licence_renewals`. Rule codes: `licence.not_later`, `licence.dates`, `licence.cancelled`, `licence.duplicate`, `licence.document_folder` |
| `api.add_licence_document(crid, p_licence_id, p)` | `{path: '<company_id>/licences/…', kind?, valid_to?}` | `{id}` | `settings.manage`. Upload to the `documents` bucket first. Rule codes: `licence.document_folder`, `licence.document_path` |
| `api.run_licence_reminders(crid, p_company_id, p_date?)` | — | `{date, reminders, superseded, expired_items}` | `settings.manage` ("send now"). The daily job does the same for every company. |

**Views:**

| View | Columns |
|---|---|
| `api.v_licence_register` | id, company_id, company_name, branch_id, branch_name, kind, title, label, licence_no, issued_by, portal_url, valid_from, valid_to, status, renewal_status, renewal_applied_on, is_blocking, blocks, owner_person_id, owner_name, document_path, note, **state** `valid\|expiring\|expired\|no_expiry\|suspended\|cancelled`, days_to_expiry, blocks_something, documents, reminders_done (days array for the current expiry), created_at, updated_at |
| `api.v_licence_documents` | id, licence_id, kind, path, valid_to, uploaded_by_name, created_at |
| `api.v_licence_renewals` | id, licence_id, old_licence_no, old_valid_from, old_valid_to, new_licence_no, new_valid_from, new_valid_to, note, renewed_by_name, renewed_at |
| `api.v_licence_reminders` | id, licence_id, label, licence_no, valid_to, days_before, due_on, status, message_status, run_date |

### Asset register (screen AssetRegister)

| RPC | Input | Returns | Right · rules |
|---|---|---|---|
| `api.depreciation_readiness(p_company_id)` | — | `{method, useful_life_years, residual_pct, assets_without_life[], assets_without_dates[], assets_without_residual[], ready}` | `accounts.view` or `assets.view` |
| `api.run_depreciation(crid, p_company_id, p_period_id)` | — | `{run_id, method, total, assets, voucher_id, doc_no, skipped[]}` | `accounts.create`. Rule codes: `depreciation.settings_missing`, `depreciation.life_not_set`, `depreciation.asset_dates_missing`, `depreciation.residual_not_set`, `depreciation.period_not_ended`, `depreciation.already_run`, `period.closed`, `posting.rule_missing` |
| `api.dispose_asset(crid, p_asset_id, p)` | `{disposal_date?, proceeds, proceeds_account_id (when proceeds > 0), reason}` | `{id, voucher_id, doc_no, wdv, gain_loss}` | `accounts.create`. Rule codes: `asset.disposed`, `asset.no_cost`, `asset.disposal_reason`, `asset.proceeds_account`. The sale itself is billed through Sales with GST. |

Existing Phase 5 asset RPCs are unchanged: `upsert_asset`, `record_asset_event`, `record_calibration`, `add_asset_document`. Asset files can now go in the `documents` bucket under `<company_id>/assets/…`.

**Views:**

| View | Columns |
|---|---|
| `api.v_asset_register` | id, code, name, kind, place_name, make, model, serial_no, purchase_date, put_to_use_date, useful_life_years, residual_pct, status, disposed_on, amc_until, cost / accumulated_depreciation / wdv (cost.view or accounts.view), depreciated_to, documents, open_repairs |
| `api.v_depreciation_runs` | id, period_id, month_start, method, total, voucher_id, voucher_no, status, run_by_name, run_at, assets |
| `api.v_depreciation_lines` | run_id, asset_code, asset_name, cost, residual, useful_life_years, opening_wdv, days, amount, closing_wdv |
| `api.v_asset_disposals` | asset_code, disposal_date, proceeds, cost, accumulated_depreciation, wdv, gain_loss, reason, voucher_id |

### Directors and investment, partners and profit sharing, partner requests (screens Directors, ProfitSharing, PartnerRequests; Admin)

| RPC | Input | Returns | Right · rules |
|---|---|---|---|
| `api.upsert_partner(crid, p)` | `{id?, company_id, person_id?, user_id? (portal), display_name, is_legal_partner, is_investment_partner, is_working_partner, is_director, director_interested, din?, shares?, share_pct, capital_account_id?, current_account_id?, loan_account_id?, language en\|ml, status}` | `{id}` | `partners.manage` (Admin). Rule codes: `partner.share_over_100`, `partner.account_other_company`. The portal role itself is assigned with `api.assign_role(…, 'investor', …)`. |
| `api.record_partner_investment(crid, p)` | `{partner_id, kind, amount, invested_on?, agreement_ref?, project_id?, note?}` | `{id}` | `partners.manage`. Rule code: `partner.agreement_required` (project) |
| `api.upsert_partner_project(crid, p)` | `{id?, company_id, name, status, started_on?, summary?, investor_figures?, visible_to_investors?}` | `{id}` | `partners.manage` |
| `api.record_director_declaration(crid, p)` | `{partner_id, kind not_borrowed\|interest_disclosure\|other, declared_on, valid_to?, document_path?, note?}` | `{id}` | `partners.manage` |
| `api.submit_partner_request(crid, p_kind, p)` | p_kind `withdraw\|loan_to_partner\|loan_from_partner\|info\|project_offer`; p `{partner_id (or company_id for the caller's own row), source (withdraw), amount, repay_months?, repay_from? land_rent\|incentive\|bank, project_id?, purpose?, note?}` | `{id, doc_no, status}` | `investor.portal` (own partner row) or `partners.manage` (on behalf). Rule codes: `partner_request.*` (kind, source, project, question), `partner.amount`, `partner.inactive` |
| `api.withdraw_partner_request(crid, p_request_id)` | — | `{id, status}` | The requester only, while submitted |
| `api.decide_partner_request(crid, p_request_id, p_decision approve\|reject, p_amount numeric = null, p_note text = null)` | Rejecting needs a note. Approving a loan to a partner needs the board resolution reference in the note. | `{id, status, checks}` | Admin with `partners.manage`; never the requester or the partner themselves (`sod.own_request`). Withdraw: `partner.over_due`, `partner.account_not_set`. Loan to a director or interested party: `companies_act.s185`. Other loans: `companies_act.s186_limit_not_set`, `companies_act.s186_limit`, `partner.board_resolution_required`. Loan from a director: `companies_act.director_declaration` |
| `api.pay_partner_request(crid, p_request_id, p)` | `{bank_account_id, paid_on?}` | `{id, status:'paid', voucher_id, doc_no}` | `partners.manage`. Approved withdrawals only. Payment voucher Dr partner current account / Cr bank |
| `api.record_director_loan(crid, p)` | `{partner_id, direction given\|taken, movement advance\|repayment, amount, loan_date?, bank_account_id, request_id?}` | `{id, voucher_id, doc_no, legal_basis}` | Admin. Runs the same s.185 / s.186 / declaration checks. Rule codes: `loan.over_repaid`, `loan.request`. Posts to the loan account and the bank |
| `api.save_profit_share_minutes(crid, p)` | `{id?, company_id, fy_id, meeting_date, minutes_ref, document_path?, basis:{incentives:[{partner_id, pct}]}}` | `{id, status}` | `partners.manage`. Rule codes: `minutes.*` |
| `api.approve_profit_share_minutes(crid, p_minutes_id)` | — | `{id, status}` | A second Admin (`sod.own_minutes`) |
| `api.compute_profit_share(crid, p_minutes_id)` | — | `{run_id, net_profit, incentive_total, distributable, lines:[{partner_id, kind, pct, amount}]}` | Admin. Rule codes: `minutes.not_approved`, `profit_share.no_profit`, `profit_share.share_pct_not_100`, `profit_share.already_posted` |
| `api.post_profit_share(crid, p_run_id, p_post_date date = today)` | — | `{run_id, status:'posted', voucher_id, doc_no}` | Admin. The date must be in an open month. Rule codes: `posting.rule_missing`, `partner.account_not_set` |

**Views:**

| View | Columns |
|---|---|
| `api.v_partners` | id, company_id, company_name, person_id, user_id, display_name, role flags, din, shares, share_pct, account ids, language, status, share_capital, investment, current_account_balance, loan_account_balance, declaration_on_file, portal_set_up |
| `api.v_partner_requests` | id, company_name, doc_no, partner_id, partner_name, is_director, kind, source, project_id, amount, repay_months, repay_from, purpose, note, status, requested_by_name, created_at, decided_by_name, decided_at, decided_amount, decision_note, checks, voucher_id, paid_at, due_to_partner |
| `api.v_partner_investments` | One row per recorded investment |
| `api.v_partner_projects` | One row per project |
| `api.v_director_declarations` | Includes `current` |
| `api.v_director_loans` | Includes `outstanding_after` and voucher_no |
| `api.v_profit_share_minutes` | One row per set of minutes |
| `api.v_profit_share_runs` | Includes `lines` with partner names |

### Investor portal (InvestorSignIn, InvestorGroup, PartnerHome, PartnerPerformance, PartnerInvestment, InvestorProjects, InvestorWithdraw, InvestorLoan, InvestorWorkingPartner)

The investor role holds `home.view` and `investor.portal` only, with no transaction rights. It reads nothing through "can see the company". Everything below returns only the caller's own rows and aggregates: no party names, salaries or without-GST figures, unless Admin records the `investor.include_without_gst` policy.

| Call | Returns |
|---|---|
| `api.investor_me()` | `{user_id, display_name, portal, can_transact:false, partners:[{partner_id, company_id, company, name, legal_partner, investment_partner, working_partner, director, shares, share_pct, language}], open_requests}` |
| `api.investor_group_summary(p_on date = today)` | `{as_of, companies:[{partner_id, company_id, company, shares, share_pct, share_capital, investment, net_worth_book, value_of_my_shares, profit_share_posted, my_loan_account, money_in_12m, buyers_paying_12m (count of posted receipts, not distinct buyers)}], totals:{share_capital, investment, value_of_my_shares}}` |
| `api.v_investor_partners` | partner_id, company_id, company_name, display_name, role flags, shares, share_pct, language, share_capital, investment |
| `api.v_investor_requests` | id, company_id, company_name, doc_no, kind, source, project_id, amount, repay_months, repay_from, purpose, status, created_at, decided_at, decided_amount, decision_note, paid_at |
| `api.v_investor_profit_shares` | company_id, company_name, fy_label, minutes_ref, kind, pct, amount, posted_at |
| `api.v_investor_projects` | id, company_id, company_name, name, status, started_on, summary, investor_figures, updated_at (projects Admin marked visible) |
| `api.v_investor_money_in` | company_id, company_name, month, mode, receipts, amount (posted receipts, last 12 months) |

Requests (withdraw, loan, project interest, information) go through `api.submit_partner_request` and `api.withdraw_partner_request`.

### Month-end close (screen MonthClose)

| RPC | Input | Returns | Right · rules |
|---|---|---|---|
| `api.open_close_checklist(crid, p_company_id, p_period_id, p jsonb = '{}')` | `{doer_user_id?, checker_user_id?}` | `{id, due_on, tasks}` | `close.manage`. due_on = the `close.due_day` (10th) of the next month. Tasks come from `close.default_tasks`. Rule codes: `close.exists`, `period.already_closed`, `sod.doer_is_checker` |
| `api.add_close_task(crid, p_checklist_id, p)` | `{title, area?, sort?, doer_user_id?, checker_user_id?}` | `{id}` | `close.manage` |
| `api.assign_close_task(crid, p_task_id, p)` | `{doer_user_id?, checker_user_id?}` | `{id}` | `close.manage`. Doer ≠ checker |
| `api.complete_close_task(crid, p_task_id, p_action done\|check\|return, p_note = null)` | — | `{id, status}` | The assigned doer or checker, or `close.manage` when unassigned. The doer never checks (`sod.doer_is_checker`). Rule codes: `close.not_doer`, `close.not_checker`, `close.task_state`, `close.note` |
| `api.carry_close_task(crid, p_task_id, p_reason)` | — | `{id, status:'carried', new_task_id}` | `close.manage`. Moves the task to next month's checklist |
| `api.close_period(crid, p_company_id, p_period_id)` | — | `{period_id, status:'closed'}` | `close.manage`. Rule codes: `close.no_checklist`, `close.tasks_open`, `close.month_not_over`, `period.already_closed` |
| `api.reopen_period(crid, p_company_id, p_period_id, p_reason)` | reason of at least 10 characters | `{period_id, status:'open', relock_at}` | **Admin only** (`period.reopen_admin_only`). Rule codes: `period.reason_required`, `period.not_closed`. Logged |

**Views:**

| View | Columns |
|---|---|
| `api.v_close_checklists` | id, company_name, period_id, month_start, period_status, due_on, status, days_left, tasks, open_tasks, done_tasks, checked_tasks, carried_tasks |
| `api.v_close_tasks` | id, checklist_id, title, area, sort, status, doer_user_id, doer_name, checker_user_id, checker_name, done_by, done_at, done_note, checked_by, checked_at, check_note, carried_to_task_id, carry_reason, my_turn |
| `api.v_period_status` | period_id, company_id, fy_id, month_start, status, closed_at, closed_by_name, checklist_id, due_on, last_action, last_reason, relock_at, last_action_at |

**After the close:** no entry dated in a closed month can be posted by any route. That includes Admin and any special grant: `app.fy_for` and the triggers on the GL and the stock ledger refuse it with `period.closed`.


## Phase 8 RPCs (integrations)

All changing RPCs take `p_client_request_id` first (idempotent) unless marked *service*. *Service* RPCs are callable only by the Edge Functions with the service-role key (`app.require_service`, no `EXECUTE` for `authenticated`). Every outside call is queued in `ops.integration_requests`; the Edge Functions send it and report back.

### Outbound queue (Bug fixer → Integrations)

| RPC | Who | Does |
|---|---|---|
| `integration_claim_due(p_limit, p_kinds text[])` | *service* | Claims due `queued` requests (skip-locked), sets `in_progress`, counts the attempt; returns `[{id, company_id, provider, kind, ref_table, ref_id, payload, attempts, max_attempts}]` |
| `integration_report(p_request_id, p_ok, p_response, p_error, p_retryable)` | *service* | Success → `done` (closes its Bug fixer item); failure → back-off or dead letter. E-invoice / e-way kinds must use their apply RPC |
| `integration_retry(crid, p_request_id)` | Admin | Dead or waiting → `queued` now, attempts reset (logged) |
| `integration_cancel(crid, p_request_id, p_reason)` | Admin | Dead or waiting → `cancelled` (logged) |
| `run_mock_integration(crid, p_request_id, p {fail, error, retryable})` | Admin (DEV) | Completes a request of provider `mock` with the database mock (or a simulated failure); refused unless `integrations.allow_mock` is true (`integrations.mock_not_allowed`) |

Views: `api.integration_requests` (no payload), `api.integration_attempts`, `api.webhook_events` (no payload).

### Webhooks

| RPC | Who | Does |
|---|---|---|
| `ingest_webhook(p_provider, p_external_id, p_signature_ok, p_topic, p_payload)` | *service* | Unsigned → stored as `rejected` (payload dropped), `{accepted:false, reason:'bad_signature'}`. Signed → stored once per provider + id; repeat → `{accepted:false, duplicate:true}` |
| `finish_webhook(p_event_id, p_status processed|failed|ignored, p_result, p_error)` | *service* | Marks the event |

### E-invoice (IRN)

| RPC | Who | Does |
|---|---|---|
| `set_einvoice_switch(crid, p_gstin_id, p_enabled, p_from date, p_note)` | Admin | Switch per GSTIN + start date; switching on needs the CA's note (`einvoice.ca_note`). Logged |
| `request_einvoice(crid, p_document_id)` | `sales_invoices.create` | Queues `einvoice_generate` with the INV-01 body (`app.einvoice_payload`). Refuses `einvoice.switch_off`, `einvoice.not_posted`, `einvoice.not_eligible`, `einvoice.already_issued`, `integrations.provider_not_set`, `integrations.mock_not_allowed`. Same document again → same request |
| `apply_einvoice_result(p_request_id, p {ok, irn, ack_no, ack_date, signed_qr} | {ok:false, error, retryable})` | *service* | Stores the IRN, puts it on the document, releases the held invoice message; or back-off / dead letter. Repeat → `{duplicate:true}` |
| `cancel_einvoice(crid, p_document_id, p_reason duplicate|data_entry_mistake|order_cancelled|other, p_remark)` | `sales_invoices.cancel` | Queues `einvoice_cancel` within `einvoice.cancel_window_hours` (`einvoice.cancel_window` after it) |
| `document_final_status(p_document_id)` | viewers of the document | `{found, status, einvoice_required, final, irn {irn, ack_no, ack_date, signed_qr, status, is_mock}, request {id, status, attempts, next_attempt_at, last_error}}` |
| `check_document_printable(p_document_id)` | viewers | Refuses `einvoice.irn_required` for a posted invoice without its IRN; logs the print |
| `cancel_sales_document` (replaced) | `sales_invoices.cancel` | Adds `einvoice.cancel_irn_first` |

View: `api.einvoice_irns`, `api.einvoice_switches`.

### E-way bill

| RPC | Who | Does |
|---|---|---|
| `request_eway_bill(crid, p_dispatch_id, p {vehicle_no, transporter_gstin, distance_km, transport_mode})` | `logistics.edit` | Queues `eway_generate` from the posted invoice. Refuses `dispatch.state`, `eway.needs_invoice`, `einvoice.irn_required`, `eway.already`, `eway.vehicle`, `eway.vehicle_format` |
| `update_eway_partb(crid, p_eway_bill_id, p_vehicle_no, p_reason)` | `logistics.edit` | Queues a Part-B vehicle update |
| `cancel_eway_bill(crid, p_eway_bill_id, p_reason)` | `logistics.edit` | Only before the goods move (`eway.goods_moved`) and within `eway.cancel_window_hours` (unset → `eway.cancel_window_not_set`) |
| `apply_eway_result(p_request_id, p {ok, eway_bill_no, generated_at, valid_until} | {ok:false, …})` | *service* | Stores the e-way bill and puts the number on the planned dispatch; Part-B / cancel results |

Views: `api.eway_bills`, `api.dispatch_compliance` (per dispatch: e-way status, validity, request status/error, `irn_missing`). `api.start_trip` keeps `dispatch.eway_required`; the leave guard adds `einvoice.irn_required` and `dispatch.eway_invalid`.

### Online stores and marketplace TCS

| RPC | Who | Does |
|---|---|---|
| `stage_channel_event(p_event_id, p_channel_id, p_kind, p_external_id, p_detail)` | *service* | Stages a normalised order (`{external_order_id, order_date, ship_state, lines:[{sku, qty, price_incl_tax}]}`) once |
| `ingest_staged_channel_orders(crid, p_channel_id)` | `sales.create` | Brings staged orders in through Phase 6 `ingest_online_order` (each in its own sub-transaction; failures kept with the error) |
| `record_marketplace_settlement(crid, p)` | `receipts_payments.create` | Records the operator's settlement (`settlement.*` rules), or `{reverses_id, note}` to reverse one |

Views: `api.channel_sync_log`, `api.marketplace_settlements`, **`api.tcs_reconciliation`** (per company, channel, month: operator net taxable and TCS vs books net taxable, `rate_pct` from `marketplace.tcs_rate_pct`, `expected_tcs`, `tcs_difference`, `status` `rate_not_set|no_settlement|not_in_books|matched|mismatch`; `accounts.view`).

### Bank feeds and GPS

| RPC | Who | Does |
|---|---|---|
| `upsert_bank_feed(crid, p {account_id, provider, external_ref, status})` | `settings.manage` | Feed config per bank account (`bank_feed.no_account_number`) |
| `request_bank_feed_sync(crid, p_feed_id)` | `receipts_payments.create` | Queues `bank_feed_sync` |
| `bank_feed_import(p_request_id, p_feed_id, p_lines, p_cursor)` | *service* | Same dedupe hash as `import_bank_lines`; updates last sync |
| `upsert_gps_device(crid, p {company_id, provider, device_ref, user_id, vehicle_id, active})` | `logistics.edit` | Device → person |
| `gps_ingest(p_provider, p_device_ref, p_points)` | *service* | Keeps points inside the person's open duty session only; `{accepted, rejected, reason}` |

Views: `api.bank_feeds`, `api.gps_devices`.

### Help on WhatsApp (§HELP-8)

| RPC | Who | Does |
|---|---|---|
| `verify_help_whatsapp_staff(crid, p {person_id, number, language, consent})` | Admin (not for their own number) | Number must be the one on the staff record; consent required |
| `revoke_help_whatsapp_staff(crid, p_id)` | Admin or the staff member | Stops it |
| `help_whatsapp_inbound(p_event_id, p_from, p_kind, p_text)` | *service* | Unverified → `{allowed:false}` (nothing kept); verified → stores the redacted line, returns the allowed tools |
| `help_wa_tool(p_number, p_tool, p_args)` | *service* | Only `search_help`, `help_page`, `explain_error` (own errors), `create_problem_report`, `handoff`, `ticket_status` (`help_wa.tool_not_allowed`, `help_wa.unverified`) |
| `help_wa_log_reply(p_number, p_text)` | *service* | Logs the reply (redacted) |

View: `api.help_whatsapp_staff` (number masked).

## Phase 9 (go-live readiness)

| RPC / field | Who | Returns / does |
|---|---|---|
| `api.me()` new fields | signed in | `mfa_required` (holds an MFA role), `mfa_enforced` (`security.enforce_mfa`), `aal` (`aal1`/`aal2`), `mfa_needed` (enforced, has an MFA role and the session is not aal2). The client shows the TOTP step when `mfa_needed` is true |
| `api.sales_register_totals(p_company_id, p_from, p_to)` | sales view (RLS, security invoker) | One row per `tax_class` × `doc_type` for posted documents in the range (delivery challans excluded): `docs, taxable, cgst, sgst, igst, cess, total`. A GST-view user's totals never include bills without GST |
| Error `mfa_required` | any RPC through `app.require()` | Raised when enforcement is on, the right comes only from an MFA-required role and the session is aal1 |

Paging: list screens request pages with PostgREST `range()` (`src/data/paged.tsx`, 200 rows) in the order of the Phase 9 indexes.

## Rule codes

`auth.required`, `rights.missing`, `rights.read_only`, `rights.reason_required`, `rights.admin_only`, `rights.role_fixed`, `rights.self_demote`, `rights.ca_needs_end`, `grant.never_grantable`, `grant.not_on_list`, `grant.self`, `grant.too_long`, `grant.bad_window`, `grant.reason_required`, `grant.already_stopped`, `grant.already_decided`, `sod.self_approval`, `org.gstin_pan_mismatch`, `org.gstin_other_company`, `org.company_missing`, `org.branch_missing`, `numbering.no_series`, `numbering.too_long`, `numbering.in_use`, `users.self_disable`, `request.id_missing`, `masters.possible_duplicate`, `party.*` (gstin_invalid, gstin_pan_mismatch, pan_invalid, gstin_exists, msme_terms, verified_locked, gstin_required, company_required, role_required), `bank.change_needs_approval`, `bank.callback_required`, `bank.callback_note`, `price.above_mrp`, `hsn.missing`, `import.missing`, `import.locked`, `bug.missing`, `bug.closed`, `bug.bad_action`, `merge.same`, `backup.outside_india`.

Phase 4: `stock.*` (insufficient, reserved, qty, bucket, place_missing, place_other_company, lot_mismatch, lot_not_released, same_place, target, issue_missing, return_exceeds, allowance_missing, allowance_revoked, direct_write), `count.*`, `qc.*`, `scrap.*`, `transfer.*`, `purchase.*`, `capture.*`, `msme.terms_over_45`, `sod.own_request`, `sod.own_order`, `sod.own_count`, `sod.tester_receiver`, `sod.releaser_receiver`, `sod.not_picker`, `sod.picker_carrier`, `sod.picker_receiver`, `sod.witness_required`, `sod.write_off`, `sod.picker_close`, `period.no_fy`.

Phase 5: `licence.*` (missing, expired, no_number, dates), `prod.*` (no_approved_formula, bulk_by_weight, packaging_in_nos, pack_in_nos, packaging_whole, not_in_formula, no_bulk_qty, no_fill_weight, no_good_packs, not_issued, recon_decrease, **recon_mismatch**, components_short, qty, family_name, family_missing), `formula.*`, `batch.*` (missing, state, has_issues), `weighing.*` (missing, state, pending), `qc.out_of_spec`, `qc.no_test`, `qc.sample_state`, `qc.use_batch_release`, `qc.qty_mismatch`, `qc.not_inspection_lot`, `asset.*` (calibration_due, not_in_use, missing, …), `mould.*`, `shift.*`, `bom.*`, `pack.*` (incl. gst_treatment_unset), `print.*`, `rnd.*`, `work.*`, `cost.rate`, `check.empty`, **`sod.own_formula`**, **`sod.own_weighing`**, **`sod.self_release`**, **`sod.inspector_maker`**, `sod.own_approval`.

Phase 6: `order.*` (channel, payment, product, no_rate, no_price_list, price_locked, discount_over_authority, kyc_cash_only, private_label_missing, private_label_pending, missing, state, not_confirmed), `credit.*` (over_limit, exception_until, exception_amount, application_open, limit_amount, missing, state, wrong_stage, decision, same_person, kyc_not_verified, review_date, terms_required, status, no_approval), `party.not_linked`, `vehicle.*` (missing, not_active, document_expired), `dispatch.*` (place, over_order, no_lines, document, document_short, state, already_invoiced, eway_format, no_invoice, eway_required, missing), `trip.*` (missing, state, dispatch, no_stops, stop_missing, open_stops), `pod.*` (already, receiver, proof, bad_path, qty, short_reason), `stock.lot_on_hold`, `gps.*` (off_duty, notice_required, outside_duty), `duty.already_on`, `visit.*` (open, unplanned_reason, no_location, out_of_fence, missing, not_pending, closed, outcome, no_order_reason), `field.*` (not_my_customer, bad_path, cheque_photo, reference, handover_pending, handover_missing, handover_state, unsynced, cash_not_handed_over), `query.*`, `promise.date`, `complaint.*` (lot, description, missing, closed, status, not_alone, hold_open), `qc.already_on_hold`, `qc.hold_missing`, `qc.hold_closed`, `qc.decision`, `lot.missing`, `coverage.tier`, `private_label.*`, `shop.*` (missing, no_customer, branch, place, day_closed), `export.*` (missing, not_overseas, fx_rate, container_no, container_missing, lut_expired), `listing.*` (channel, blocked), `online.unknown_item`, `schedule3.*` (group, line), `task.*` (missing, status, closed, finance_only), `msg.*` (inbound_missing, window_closed, not_consented, empty).

Phase 7: `jobwork.*` (party, party_other_company, process, goods_kind, no_lines, no_gstin, limit_not_set, missing, closed, date, line, kind, returned_item, returned_qty, loss_qty, scrap_item, input_qty, **over_balance**), `repair.*` (what, title, missing, closed, status, purchase_request, resolution, restore_before_breakdown), `spares.no_lines`, `schedule.*`, `licence.*` (blocks, owner, missing_row, cancelled, **not_later**, duplicate, document_path, document_folder; **expired** now also from blocking licences), `depreciation.*` (**settings_missing**, **life_not_set**, asset_dates_missing, residual_not_set, period_not_ended, already_run), `asset.*` (disposed, no_cost, disposal_reason, proceeds, proceeds_account), `partner.*` (missing, name, inactive, amount, account_not_set, account_other_company, share_over_100, agreement_required, project, bank, over_due, board_resolution_required), `partner_request.*` (kind, source, project, question, missing, state, decision, reason), **`companies_act.s185`**, **`companies_act.s186_limit_not_set`**, **`companies_act.s186_limit`**, **`companies_act.director_declaration`**, `loan.*` (kind, request, over_repaid), `minutes.*` (missing, not_draft, fy, ref, partner, pct, pct_over_100, not_approved), `profit_share.*` (missing, state, no_profit, share_pct_not_100, already_posted), **`sod.own_minutes`**, **`sod.doer_is_checker`**, `close.*` (exists, missing, closed, title, task_missing, task_state, not_doer, not_checker, note, action, reason, no_checklist, tasks_open, month_not_over), `period.*` (**closed**: no grant overrides, missing, already_closed, not_closed, **reopen_admin_only**, reason_required).

Phase 8: `rights.service_only`, `integrations.*` (provider_not_set, mock_not_allowed, not_queued, missing, state, use_apply), `webhook.*` (no_id, status), `einvoice.*` (switch_off, ca_note, not_posted, not_eligible, already_issued, no_irn, cancel_reason, cancel_window, cancel_window_not_set, **irn_required**, cancel_irn_first, locked), `eway.*` (needs_invoice, already, vehicle, vehicle_format, missing, goods_moved, cancel_window_not_set, cancel_window), **`dispatch.eway_invalid`**, `settlement.*` (missing, already_reversed, ref, period, negative, payout, duplicate, bank_line), `bank_feed.*` (provider, no_account_number, missing, not_active), `gps.device`, `gps.user`, `help_wa.*` (person, no_sign_in, number_mismatch, consent, unverified, tool_not_allowed), `doc.missing`, `org.gstin_missing`.

## Edge Functions

| Function | Purpose | Status |
|---|---|---|
| `tally-bridge` | Device-key endpoint for the Tally bridge on the import computer (next batch + signed TBK URL, staged rows, done) | Code in `supabase/functions/tally-bridge`. **Not deployed** (owner's `supabase login`; import PC not chosen) |
| `admin-users` | Create a sign-in account (phone or email + password) and assign its role as the calling Admin; disable an account | Code in `supabase/functions/admin-users`. **Not deployed yet**: needs `supabase login` by the owner. See DEPLOYMENT_GUIDE. |
| `integration-worker` | Sends every due integration request (all kinds) through its adapter; back-off and dead letter in Postgres | Code in `supabase/functions/integration-worker`. **Not deployed** (no access token); scheduler call with `INTEGRATION_WORKER_SECRET` |
| `einvoice` | IRN generate / cancel now (GSP adapter; `MockGsp` on DEV) | Code only; GSP not chosen (Q-P8-1) |
| `ewaybill` | E-way bill generate / Part-B / cancel now (adapter; `MockEway` on DEV) | Code only (Q-P8-1) |
| `bank-feed` | Statement lines from the feed provider → `bank_feed_import` | Code only (Q-P8-3) |
| `gps-intake` | GPS provider push: HMAC check → dedupe → `gps_ingest` (on duty only) | Code only (Q-P8-2) |
| `store-webhooks` | Shopify (documented HMAC) and Amazon / Flipkart / JioMart / Meesho (generic HMAC until confirmed) → dedupe → stage order | Code only (Q-P8-4) |
| `help-agent` | In-app help assistant: user's JWT only, allow-listed help tools, redaction filter, voice input via transcriber adapter | Code only; model not chosen (Q-P8-5) — `MockModel` with `HELP_ALLOW_MOCK=true` |
| `help-whatsapp` | Help on WhatsApp for verified staff: signature → dedupe → verified check → no data tools → reply with "talk to a person" | Code only (Q-13, Q-P8-5) |

Webhook contract for every inbound handler: verify the signature on the raw body first → `ingest_webhook` (dedupe) → answer 200 → process in the background (`EdgeRuntime.waitUntil`) → `finish_webhook`.


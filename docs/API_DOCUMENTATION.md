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

## Rule codes

`auth.required`, `rights.missing`, `rights.read_only`, `rights.reason_required`, `rights.admin_only`, `rights.role_fixed`, `rights.self_demote`, `rights.ca_needs_end`, `grant.never_grantable`, `grant.not_on_list`, `grant.self`, `grant.too_long`, `grant.bad_window`, `grant.reason_required`, `grant.already_stopped`, `grant.already_decided`, `sod.self_approval`, `org.gstin_pan_mismatch`, `org.gstin_other_company`, `org.company_missing`, `org.branch_missing`, `numbering.no_series`, `numbering.too_long`, `numbering.in_use`, `users.self_disable`, `request.id_missing`, `masters.possible_duplicate`, `party.*` (gstin_invalid, gstin_pan_mismatch, pan_invalid, gstin_exists, msme_terms, verified_locked, gstin_required, company_required, role_required), `bank.change_needs_approval`, `bank.callback_required`, `bank.callback_note`, `price.above_mrp`, `hsn.missing`, `import.missing`, `import.locked`, `bug.missing`, `bug.closed`, `bug.bad_action`, `merge.same`, `backup.outside_india`.

Phase 4: `stock.*` (insufficient, reserved, qty, bucket, place_missing, place_other_company, lot_mismatch, lot_not_released, same_place, target, issue_missing, return_exceeds, allowance_missing, allowance_revoked, direct_write), `count.*`, `qc.*`, `scrap.*`, `transfer.*`, `purchase.*`, `capture.*`, `msme.terms_over_45`, `sod.own_request`, `sod.own_order`, `sod.own_count`, `sod.tester_receiver`, `sod.releaser_receiver`, `sod.not_picker`, `sod.picker_carrier`, `sod.picker_receiver`, `sod.witness_required`, `sod.write_off`, `sod.picker_close`, `period.no_fy`.

## Edge Functions

| Function | Purpose | Status |
|---|---|---|
| `tally-bridge` | Device-key endpoint for the Tally bridge on the import computer (next batch + signed TBK URL, staged rows, done) | Code in `supabase/functions/tally-bridge`. **Not deployed** (owner's `supabase login`; import PC not chosen) |
| `admin-users` | Create a sign-in account (phone or email + password) and assign its role as the calling Admin; disable an account | Code in `supabase/functions/admin-users`. **Not deployed yet**: needs `supabase login` by the owner. See DEPLOYMENT_GUIDE. |


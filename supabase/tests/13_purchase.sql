-- Phase 4 purchase to pay: a department request approved by someone else, RFQ and quotations, the PO issued by an
-- approver who did not draft it (WhatsApp "PO issued" queued only for a consented supplier contact, once per request),
-- price increases accepted explicitly, goods receipt into quarantine for an item that needs a test, the test and the
-- release by someone other than the receiver, the 3-way match (exact when no tolerance is set), the bill posted with
-- its rates in the price history, MSME due dates, the payment advice row, and RLS. Synthetic data only.
select plan(45);

create temp table s as select tests.seed4(tests.seed3(tests.seed2(tests.seed()))) as v;
grant select on s to authenticated;
create or replace function tests.k(p text) returns uuid language sql stable as $$ select (v ->> p)::uuid from s $$;
-- Results kept between steps (written while signed in as the test users).
create temp table ids (k text primary key, v jsonb);
grant select, insert on ids to authenticated;
create or replace function tests.r(p text) returns jsonb language sql stable as $$ select v from ids where k = p $$;
create or replace function tests.id(p text, f text default 'id') returns uuid language sql stable as $$ select (v ->> f)::uuid from ids where k = p $$;
-- The rule code (hint) a statement is refused with, or 'ok'.
create or replace function tests.rule(p_sql text) returns text language plpgsql as $$
declare h text;
begin
  execute p_sql;
  return 'ok';
exception when others then
  get stacked diagnostics h = pg_exception_hint;
  return coalesce(nullif(h, ''), sqlstate);
end $$;
grant execute on all functions in schema tests to authenticated;
insert into core.role_rights (role_key, right_key) values ('accountant', 'receipts_payments.create') on conflict do nothing;

-- ── Department request, approved by someone else ──
select tests.login(tests.k('buyer'));
insert into ids select 'pr', api.create_purchase_request(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'department', 'Test Stores',
  'reason', 'Test reorder', 'submit', true, 'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('rm1'), 'qty', 100, 'est_rate', 50))));
select is(tests.r('pr') ->> 'status', 'submitted', 'a department request is sent for approval');
select tests.logout();

select tests.login(tests.k('admin'));
insert into ids select 'pr_own', api.create_purchase_request(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'department', 'Test Office',
  'submit', true, 'lines', jsonb_build_array(jsonb_build_object('description', 'Test stationery', 'qty', 2, 'est_rate', 10))));
select is(tests.rule(format('select api.approve_purchase_request(gen_random_uuid(), %L, true)', tests.id('pr_own'))), 'sod.own_request', 'nobody approves their own request, not even Admin');
select tests.logout();

select tests.login(tests.k('custodian'));
select is(api.approve_purchase_request(gen_random_uuid(), tests.id('pr'), true) ->> 'status', 'approved', 'another person with the approve right approves it');
select tests.logout();
select is((select decided_by from purch.requests where id = tests.id('pr')), tests.k('custodian'), 'the approver is recorded');

-- ── RFQ and quotations ──
select tests.login(tests.k('buyer'));
insert into ids select 'rfq', api.create_rfq(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'request_id', tests.id('pr'),
  'supplier_ids', jsonb_build_array(tests.k('supp'), tests.k('supp2'))));
select is((tests.r('rfq') ->> 'lines')::int, 1, 'the RFQ copies the approved request lines');
select is(tests.rule(format($q$ select api.record_quotation(gen_random_uuid(), jsonb_build_object('rfq_id', %L, 'party_id', %L, 'terms_days', 60,
  'lines', jsonb_build_array(jsonb_build_object('rfq_line_id', (select id from purch.rfq_lines where rfq_id = %L), 'rate', 50)))) $q$,
  tests.id('rfq'), tests.k('supp'), tests.id('rfq'))), 'msme.terms_over_45', 'an MSME supplier quotation with terms over 45 days is refused');
insert into ids select 'q1', api.record_quotation(gen_random_uuid(), jsonb_build_object('rfq_id', tests.id('rfq'), 'party_id', tests.k('supp'), 'terms_days', 30,
  'lines', jsonb_build_array(jsonb_build_object('rfq_line_id', (select id from purch.rfq_lines where rfq_id = tests.id('rfq')), 'rate', 50))));
insert into ids select 'q2', api.record_quotation(gen_random_uuid(), jsonb_build_object('rfq_id', tests.id('rfq'), 'party_id', tests.k('supp2'), 'terms_days', 30,
  'lines', jsonb_build_array(jsonb_build_object('rfq_line_id', (select id from purch.rfq_lines where rfq_id = tests.id('rfq')), 'rate', 55))));
select ok((select cheapest from api.quotation_compare where quotation_id = tests.id('q1')) and not (select cheapest from api.quotation_compare where quotation_id = tests.id('q2')),
  'the comparison marks the cheapest quotation');
insert into ids select 'sel', api.select_quotation(gen_random_uuid(), tests.id('q1'), jsonb_build_object('place_id', tests.k('stores'), 'delivery_date', '2026-12-01'));
select tests.logout();
select ok((select status = 'selected' from purch.quotations where id = tests.id('q1')) and (select status = 'rejected' from purch.quotations where id = tests.id('q2'))
          and (select status = 'closed' from purch.rfqs where id = tests.id('rfq')) and tests.id('sel', 'order_id') is not null,
  'choosing a quotation rejects the others, closes the RFQ and drafts the order');

-- ── PO issued: WhatsApp only to a consented contact, once ──
select tests.login(tests.k('custodian'));
insert into ids select 'po1', api.issue_purchase_order('bbbbbbbb-0000-4000-8000-000000000001', tests.id('sel', 'order_id'));
select ok(tests.r('po1') ->> 'doc_no' like 'PO/%', 'an approver who did not draft it issues the order with a number');
select tests.logout();
select is((select array[count(*)::text, max(status), max(to_number), max(template_name)] from msg.outbox where doc_type = 'purch.orders' and doc_id = tests.id('sel', 'order_id')),
  array['1', 'queued', '+919000000202', 'po_issued'], 'exactly one "PO issued" WhatsApp row is queued for the consented supplier contact');
select tests.login(tests.k('custodian'));
select is(api.issue_purchase_order('bbbbbbbb-0000-4000-8000-000000000001', tests.id('sel', 'order_id')) ->> 'doc_no', tests.r('po1') ->> 'doc_no',
  'repeating the same request returns the first result');
select tests.logout();
select is((select count(*)::int from msg.outbox where doc_type = 'purch.orders' and doc_id = tests.id('sel', 'order_id')), 1, 'the retry queues no second message');
select is((select rate from purch.price_history where source = 'order' and source_id = tests.id('sel', 'order_id') and product_id = tests.k('rm1')), 50.00::numeric,
  'the issued order rate is recorded in the price history');
select is((select status from purch.requests where id = tests.id('pr')), 'ordered', 'the request is marked ordered');

-- A dearer order to a supplier without WhatsApp consent.
select tests.login(tests.k('admin'));
insert into ids select 'po2d', api.save_purchase_order(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'party_id', tests.k('supp2'),
  'place_id', tests.k('stores'), 'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('rm1'), 'qty', 10, 'rate', 55))));
select is(tests.rule(format('select api.issue_purchase_order(gen_random_uuid(), %L, true)', tests.id('po2d'))), 'sod.own_order', 'the person who drafted an order cannot issue it');
select tests.logout();
select tests.login(tests.k('custodian'));
select is(tests.rule(format('select api.issue_purchase_order(gen_random_uuid(), %L)', tests.id('po2d'))), 'purchase.price_increase', 'a price above the last purchase must be accepted explicitly');
select lives_ok(format('select api.issue_purchase_order(gen_random_uuid(), %L, true)', tests.id('po2d')), 'with the increase accepted the order is issued');
select tests.logout();
select is((select price_rise_accepted_by from purch.orders where id = tests.id('po2d')), tests.k('custodian'), 'who accepted the price increase is recorded');
select is((select array[count(*) filter (where status = 'queued'), count(*) filter (where status = 'skipped' and skip_reason = 'no consent recorded')]::int[]
           from msg.outbox where doc_type = 'purch.orders' and doc_id = tests.id('po2d')), array[0, 1],
  'nothing is queued for a supplier contact without consent (only a skipped record with the reason)');

-- ── Goods receipt → quarantine → test (not by the receiver) → released ──
select tests.login(tests.k('store'));
select is(tests.rule(format($q$ select api.post_goods_receipt(gen_random_uuid(), jsonb_build_object('company_id', %L, 'party_id', %L, 'place_id', %L, 'receipt_date', '2026-06-05'),
  jsonb_build_array(jsonb_build_object('product_id', %L, 'qty', 5, 'rate', 50))) $q$, tests.k('company_a'), tests.k('supp'), tests.k('stores'), tests.k('rm1'))),
  'purchase.direct_needs_approval', 'goods without an order need approval as a direct purchase');
select tests.logout();
select tests.login(tests.k('admin'));
insert into ids select 'grn', api.post_goods_receipt(gen_random_uuid(), jsonb_build_object('order_id', tests.id('sel', 'order_id'), 'place_id', tests.k('stores'),
  'receipt_date', '2026-06-05', 'supplier_invoice_no', 'TINV-1'),
  jsonb_build_array(jsonb_build_object('order_line_id', (select id from purch.order_lines where order_id = tests.id('sel', 'order_id')), 'qty', 100, 'supplier_lot_no', 'TSL-1')));
select is(tests.r('grn') -> 'lots' -> 0 ->> 'bucket', 'quarantine', 'an item that needs an incoming test is received into quarantine');
select tests.logout();
insert into ids values ('lot', jsonb_build_object('id', tests.r('grn') -> 'lots' -> 0 ->> 'lot_id'));
select is((select array[quarantine, sellable] from api.stock_summary where place_id = tests.k('stores') and product_id = tests.k('rm1')), array[100, 0]::numeric[],
  'quarantined stock is not sellable');
select is((select array[status, qty_received::text] from api.purchase_orders where id = tests.id('sel', 'order_id')), array['received', '100.000'], 'the order shows it is fully received');
select tests.login(tests.k('store'));
select is(tests.rule(format($q$ select api.post_goods_receipt(gen_random_uuid(), jsonb_build_object('order_id', %L, 'place_id', %L, 'receipt_date', '2026-06-06'),
  jsonb_build_array(jsonb_build_object('order_line_id', (select id from purch.order_lines where order_id = %L), 'qty', 1))) $q$,
  tests.id('sel', 'order_id'), tests.k('stores'), tests.id('sel', 'order_id'))), 'purchase.order_state', 'nothing more is received against a fully received order');
select tests.logout();

select tests.login(tests.k('admin'));
select is(tests.rule(format($q$ select api.record_incoming_test(gen_random_uuid(), %L, '{"result":"pass"}') $q$, tests.id('lot'))), 'sod.tester_receiver',
  'the person who received the goods cannot test them');
select tests.logout();
select tests.login(tests.k('tester'));
select is(tests.rule(format('select api.release_from_quarantine(gen_random_uuid(), %L)', tests.id('lot'))), 'qc.no_pass', 'no release before a passing test');
select lives_ok(format($q$ select api.record_incoming_test(gen_random_uuid(), %L, '{"result":"pass","parameters":{"appearance":"ok"}}') $q$, tests.id('lot')),
  'another person records the passing test');
select is((api.release_from_quarantine(gen_random_uuid(), tests.id('lot')) ->> 'released_qty')::numeric, 100::numeric, 'the tester releases the lot');
select tests.logout();
select ok((select quarantine = 0 and sellable = 100 from api.stock_summary where place_id = tests.k('stores') and product_id = tests.k('rm1'))
          and (select status = 'available' and released_by = tests.k('tester') from inv.lots where id = tests.id('lot'))
          and (select qty_accepted = 100 from purch.grn_lines where lot_id = tests.id('lot')),
  'released stock is available and the receipt line is accepted');

-- ── Bill photo and the 3-way match ──
select tests.login(tests.k('buyer'));
select is(tests.rule(format($q$ select api.create_bill_capture(gen_random_uuid(), jsonb_build_object('company_id', %L, 'photo_path', 'loose/bill.jpg')) $q$, tests.k('company_a'))),
  'capture.photo_path', 'a bill photo must sit in the company''s folder of the private bucket');
insert into ids select 'cap1', api.create_bill_capture(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'photo_path', tests.k('company_a') || '/test-bill-1.jpg'));
insert into ids select 'cap2', api.create_bill_capture(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'photo_path', tests.k('company_a') || '/test-bill-2.jpg'));
select api.set_bill_capture_fields(gen_random_uuid(), tests.id('cap1'), jsonb_build_object('party_id', tests.k('supp'), 'order_id', tests.id('sel', 'order_id'), 'grn_id', tests.id('grn'),
  'extracted', jsonb_build_object('invoice_no', 'TINV-1', 'invoice_date', '2026-06-05', 'taxable', 5000, 'cgst', 450, 'sgst', 450, 'igst', 0, 'total', 5900,
    'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('rm1'), 'qty', 100, 'rate', 50)))));
select api.set_bill_capture_fields(gen_random_uuid(), tests.id('cap2'), jsonb_build_object('party_id', tests.k('supp'), 'order_id', tests.id('sel', 'order_id'), 'grn_id', tests.id('grn'),
  'extracted', jsonb_build_object('invoice_no', 'TINV-1B', 'invoice_date', '2026-06-05', 'taxable', 5050, 'cgst', 454.5, 'sgst', 454.5, 'igst', 0, 'total', 5959,
    'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('rm1'), 'qty', 101, 'rate', 50)))));
insert into ids select 'm1', api.match_bill_to_po_grn(gen_random_uuid(), tests.id('cap1'));
insert into ids select 'm2', api.match_bill_to_po_grn(gen_random_uuid(), tests.id('cap2'));
select tests.logout();
select is(tests.r('m1') ->> 'status', 'matched', 'a bill that agrees with the order rate, the received quantity and the HSN tax is matched');
select ok(tests.r('m1') -> 'notes' @> '[{"code":"match.tolerance_not_set"}]', 'with no tolerance set the match says it was exact');
select ok(tests.r('m2') ->> 'status' = 'mismatch' and tests.r('m2') -> 'checks' @> '[{"check":"qty","ok":false}]',
  'one unit more than received is a mismatch when no tolerance is set');

select tests.login(tests.k('finance'));
select is(tests.rule(format('select api.capture_to_purchase_draft(gen_random_uuid(), %L)', tests.id('cap2'))), 'capture.needs_admin', 'a mismatched bill needs Admin');
insert into ids select 'draft', api.capture_to_purchase_draft(gen_random_uuid(), tests.id('cap1'));
select lives_ok(format('select api.post_purchase_bill(gen_random_uuid(), %L)', tests.id('draft', 'bill_id')), 'the matched bill becomes a purchase bill and posts');
select tests.logout();
select ok((select status = 'posted' from purch.bill_captures where id = tests.id('cap1'))
          and (select order_id = tests.id('sel', 'order_id') and grn_id = tests.id('grn') from purch.bills where id = tests.id('draft', 'bill_id')),
  'the bill is linked to its order, receipt and photo');
select ok((select rate = 50 and party_id = tests.k('supp') from purch.price_history where source = 'bill' and source_id = tests.id('draft', 'bill_id') and product_id = tests.k('rm1'))
          and (select first_bill and latest_rate = 50 from api.price_changes where company_id = tests.k('company_a') and product_id = tests.k('rm1')),
  'the bill rate is recorded in the price history and shows on price changes');

-- ── MSME due dates ──
insert into core.settings (company_id, key, value, note) values (tests.k('company_a'), 'msme.warn_days', '60', 'Test warning window');
select tests.login(tests.k('finance'));
insert into ids select 'b2', api.save_purchase_draft(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'gstin_id', tests.k('gstin_a'), 'party_id', tests.k('supp'),
  'supplier_bill_no', 'TINV-2', 'supplier_bill_date', current_date, 'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('rm2'), 'qty', 1, 'rate', 10))));
select api.post_purchase_bill(gen_random_uuid(), tests.id('b2'));
select is((select array[state, legal_due_date::text] from api.msme_dues where bill_id = tests.id('draft', 'bill_id')), array['overdue', '2026-07-20'],
  'an unpaid MSME bill past 45 days from the goods receipt is overdue');
select is((select state from api.msme_dues where bill_id = tests.id('b2')), 'due_soon', 'a bill inside the warning window is flagged due soon');
select ok((api.buying_logistics_home(tests.k('company_a')) ->> 'msme_overdue')::int >= 1, 'the buying home counts the overdue MSME bill');
select tests.logout();

-- ── Payment advice ──
select tests.login(tests.k('acct'));
insert into ids select 'pay', api.post_payment(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'party_id', tests.k('supp'), 'date', current_date,
  'mode', 'bank', 'account_id', tests.k('bank'), 'amount', 5900,
  'allocations', jsonb_build_array(jsonb_build_object('kind', 'purchase_bill', 'id', tests.id('draft', 'bill_id'), 'amount', 5900))));
select tests.logout();
select is((select array[count(*)::text, max(status), max(params ->> 'bills'), max(template_name)] from msg.outbox where doc_type = 'acct.vouchers' and doc_id = tests.id('pay', 'voucher_id')),
  array['1', 'queued', 'TINV-1', 'payment_advice'], 'a supplier payment queues one payment advice naming the bills paid');
select is((select count(*)::int from api.msme_dues where bill_id = tests.id('draft', 'bill_id')), 0, 'a paid MSME bill leaves the dues list');

-- ── RLS: another company sees nothing ──
select tests.login(tests.k('plastics_user'));
select is((select count(*)::int from api.purchase_orders where company_id = tests.k('company_a')), 0, 'a company B user sees no company A orders');
select is((select count(*)::int from api.purchase_requests where company_id = tests.k('company_a')), 0, 'a company B user sees no company A requests');
select is((select count(*)::int from api.goods_receipts where company_id = tests.k('company_a')) + (select count(*)::int from api.bill_captures where company_id = tests.k('company_a')),
  0, 'a company B user sees no company A receipts or bill photos');
select tests.logout();

select * from finish();

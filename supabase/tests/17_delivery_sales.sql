-- Phase 6 delivery and sales: the 7-stage credit approval (nobody decides their own step), exposure = open receivables + approved
-- orders not yet billed against the limit, orders over the limit held, MD exception by another person (time-limited, logged),
-- salesman prices locked to the price list, dispatch → invoice → e-way bill → trip → proof of delivery (short goods back to
-- quarantine), dispatch and delivery messages, a complaint putting the lot on QC hold (not sellable) and closing rules, export
-- invoice under LUT, a shop counter sale with the day close, and RLS. Synthetic data only.
select plan(57);

create temp table s as select tests.seed6(tests.seed4(tests.seed3(tests.seed2(tests.seed())))) as v;
grant select on s to authenticated;
create or replace function tests.k(p text) returns uuid language sql stable as $$ select (v ->> p)::uuid from s $$;
create temp table ids (k text primary key, v jsonb);
grant select, insert on ids to authenticated;
create or replace function tests.r(p text) returns jsonb language sql stable as $$ select v from ids where k = p $$;
create or replace function tests.id(p text, f text default 'id') returns uuid language sql stable as $$ select (v ->> f)::uuid from ids where k = p $$;
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
-- Synthetic overseas buyer for the export test (company A).
insert into master.parties (legal_name, gst_status, is_customer, kyc_status, customer_type) values ('Test Overseas Buyer', 'overseas', true, 'verified', 'export_buyer');
insert into master.party_companies (party_id, company_id, is_customer) select id, tests.k('company_a'), true from master.parties where legal_name = 'Test Overseas Buyer';

-- ── Credit: seven stages, nobody decides their own step ──
select tests.login(tests.k('salesman'));
insert into ids select 'app', api.submit_credit_application(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'party_id', tests.k('cust'),
  'requested_limit', 10000, 'requested_term_id', tests.k('term30'), 'expected_monthly', 20000));
select is((tests.r('app') ->> 'stage')::int, 3, 'the salesman''s request waits for the sales manager (stage 3)');
select is(tests.rule(format('select api.approve_credit_stage(gen_random_uuid(), %L, 3, %L, %L::jsonb)', tests.id('app'), 'approved', '{}')), 'rights.missing',
  'the salesman cannot endorse a credit request');
select tests.logout();
select tests.login(tests.k('smgr'));
select is(api.approve_credit_stage(gen_random_uuid(), tests.id('app'), 3, 'approved', '{}') ->> 'stage', '4', 'the sales manager endorses (stage 3 → 4)');
select is(tests.rule(format('select api.approve_credit_stage(gen_random_uuid(), %L, 4, %L, %L::jsonb)', tests.id('app'), 'approved', '{}')), 'rights.missing',
  'the sales manager cannot verify the finance file');
insert into ids select 'app_own', api.submit_credit_application(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'party_id', tests.k('cust_tn'), 'requested_limit', 5000));
select is(tests.rule(format('select api.approve_credit_stage(gen_random_uuid(), %L, 3, %L, %L::jsonb)', tests.id('app_own'), 'approved', '{}')), 'sod.own_request',
  'nobody approves their own credit request');
select tests.logout();
select tests.login(tests.k('acct'));
select is(api.approve_credit_stage(gen_random_uuid(), tests.id('app'), 4, 'approved', '{}') ->> 'stage', '5', 'finance verifies the file (stage 4)');
select tests.logout();
select tests.login(tests.k('finance'));
select is(tests.rule(format('select api.approve_credit_stage(gen_random_uuid(), %L, 6, %L, %L::jsonb)', tests.id('app'), 'approved', '{}')), 'credit.wrong_stage',
  'stages are taken in order');
select is(api.approve_credit_stage(gen_random_uuid(), tests.id('app'), 5, 'approved', '{}') ->> 'stage', '6', 'the finance head recommends (stage 5)');
select tests.logout();
select tests.login(tests.k('md'));
select is(tests.rule(format('select api.approve_credit_stage(gen_random_uuid(), %L, 6, %L, %L::jsonb)', tests.id('app'), 'approved', '{}')), 'credit.review_date',
  'the MD sets a review date');
select is(api.approve_credit_stage(gen_random_uuid(), tests.id('app'), 6, 'approved', jsonb_build_object('review_on', current_date + 180)) ->> 'status', 'active',
  'the MD approves and credit becomes active (stage 7)');
select tests.logout();
select is((select array[credit_status, credit_limit::text] from master.party_companies where party_id = tests.k('cust') and company_id = tests.k('company_a')),
  array['active', '10000.00'], 'the approved limit and status are on the customer');
select is((select count(*)::int from sales.credit_approvals where application_id = tests.id('app')), 4, 'each decided stage is recorded once');

-- ── Orders against the limit ──
select tests.login(tests.k('salesman'));
select is(tests.rule(format($q$ select api.confirm_sales_order(gen_random_uuid(), jsonb_build_object('company_id', %L, 'party_id', %L, 'place_id', %L),
  jsonb_build_array(jsonb_build_object('product_id', %L, 'qty', 5, 'rate', 90))) $q$, tests.k('company_a'), tests.k('cust'), tests.k('stores'), tests.k('prod'))),
  'order.price_locked', 'a salesman cannot change the price-list rate');
insert into ids select 'o1', api.confirm_sales_order(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'party_id', tests.k('cust'), 'place_id', tests.k('stores'),
  'delivery_date', current_date + 2), jsonb_build_array(jsonb_build_object('product_id', tests.k('prod'), 'qty', 50)));
select is(array[tests.r('o1') ->> 'status', tests.r('o1') #>> '{totals,total}'], array['confirmed', '5900.00'], 'an order within the limit is confirmed at the list rate with GST from the server');
insert into ids select 'o2', api.confirm_sales_order(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'party_id', tests.k('cust'), 'place_id', tests.k('stores')),
  jsonb_build_array(jsonb_build_object('product_id', tests.k('prod'), 'qty', 50)));
select is(tests.r('o2') ->> 'status', 'pending_credit', 'an order beyond the exposure limit stops for approval');
select is((tests.r('o2') #>> '{credit,blocked}')::boolean, true, 'the credit check shows the order is blocked');
select is(tests.rule(format('select api.grant_md_exception(gen_random_uuid(), jsonb_build_object(%L, %L, %L, 2000, %L, now() + interval ''7 days'', %L, %L))',
  'order_id', tests.id('o2'), 'amount', 'valid_until', 'reason', 'Test festival stock')), 'rights.missing', 'the salesman cannot grant an MD exception');
select tests.logout();
select is((select (app.credit_exposure(tests.k('company_a'), tests.k('cust')) ->> 'exposure')::numeric), 5900.00::numeric, 'exposure counts the approved order not yet billed');
select is((select count(*)::int from msg.outbox where doc_type = 'sales.orders' and doc_id = tests.id('o1') and status = 'queued' and template_name = 'order_confirmed'), 1,
  'the consented customer gets one order confirmation');

select tests.login(tests.k('admin'));
insert into ids select 'o3', api.confirm_sales_order(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'party_id', tests.k('cust'), 'place_id', tests.k('stores'), 'rate', 100),
  jsonb_build_array(jsonb_build_object('product_id', tests.k('prod'), 'qty', 60, 'rate', 100)));
select is(tests.rule(format('select api.grant_md_exception(gen_random_uuid(), jsonb_build_object(%L, %L, %L, 9000, %L, now() + interval ''7 days'', %L, %L))',
  'order_id', tests.id('o3'), 'amount', 'valid_until', 'reason', 'Test own order')), 'sod.own_request', 'nobody grants an MD exception on their own order, not even Admin');
select tests.logout();

select tests.login(tests.k('md'));
select is(api.grant_md_exception(gen_random_uuid(), jsonb_build_object('order_id', tests.id('o2'), 'amount', 2000, 'valid_until', now() + interval '7 days',
  'reason', 'Test festival stock')) ->> 'order_status', 'confirmed', 'an MD exception by another person releases the held order');
select tests.logout();
select is((select array[granted_by::text, requested_by::text] from sales.credit_exceptions where order_id = tests.id('o2')), array[tests.k('md')::text, tests.k('salesman')::text],
  'the exception records who asked and who granted');
select ok(exists (select 1 from audit.user_log where event = 'admin_action' and detail ->> 'entity' = 'credit_exception'), 'the exception is logged');

-- ── Dispatch → invoice → e-way bill → trip → proof of delivery ──
select tests.login(tests.k('buyer'));
insert into ids select 'd1', api.create_dispatch(gen_random_uuid(), jsonb_build_object('order_id', tests.id('o1')));
select is((tests.r('d1') ->> 'value')::numeric, 5900.00::numeric, 'the dispatch carries the open order value');
select tests.logout();
select tests.login(tests.k('acct'));
insert into ids select 'inv1', api.invoice_dispatch(gen_random_uuid(), tests.id('d1'), '{}');
select tests.logout();
select is((select array[status, total::text] from sales.documents where id = tests.id('inv1', 'document_id')), array['posted', '5900.00'], 'the dispatch is billed through the Phase 3 tax invoice');
select tests.login(tests.k('buyer'));
insert into ids select 'trip', api.create_trip(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'transporter', 'Test Transporter', 'driver_user_id', tests.k('carrier'),
  'dispatch_ids', jsonb_build_array(tests.id('d1'))));
select tests.logout();
select tests.login(tests.k('carrier'));
select is(tests.rule(format('select api.start_trip(gen_random_uuid(), %L, %L::jsonb)', tests.id('trip'), '{"gps_notice_ack": true}')), 'dispatch.eway_required',
  'the vehicle cannot leave without the e-way bill');
select tests.logout();
select tests.login(tests.k('buyer'));
select api.set_dispatch_eway(gen_random_uuid(), tests.id('d1'), '123456789012');
select tests.logout();
select tests.login(tests.k('carrier'));
select is(api.start_trip(gen_random_uuid(), tests.id('trip'), '{"gps_notice_ack": true}') ->> 'status', 'started', 'the driver starts the trip');
select tests.logout();
select is((select qty from inv.stock_balances where lot_id = tests.k('lot1') and place_id = tests.k('stores') and bucket = 'available'), 50.000::numeric, 'the goods leave the stores');
select is((select count(*)::int from msg.outbox where doc_type = 'sales.orders' and doc_id = tests.id('o1') and template_name = 'dispatched'), 1, 'the customer gets one dispatch message');
select tests.login(tests.k('carrier'));
select is(tests.rule(format('select api.record_pod(gen_random_uuid(), %L, jsonb_build_object(%L, %L, %L, jsonb_build_array(%L)))',
  (select id from sales.trip_stops where dispatch_id = tests.id('d1')), 'received_by_name', 'Test Receiver', 'photo_paths', 'other-folder/pod.jpg')), 'pod.bad_path',
  'proof photos must sit in the company''s private folder');
insert into ids select 'pod', api.record_pod(gen_random_uuid(), (select id from sales.trip_stops where dispatch_id = tests.id('d1')), jsonb_build_object('received_by_name', 'Test Receiver',
  'receiver_phone', '+919000000555', 'photo_paths', jsonb_build_array(tests.k('company_a') || '/pod/test.jpg'), 'lat', 10.0001, 'lng', 76.3001,
  'lines', jsonb_build_array(jsonb_build_object('dispatch_line_id', (select id from sales.dispatch_lines where dispatch_id = tests.id('d1')), 'qty_delivered', 48, 'short_reason', 'damaged'))));
select is(tests.r('pod') ->> 'status', 'part_delivered', 'a short delivery is recorded with its reason');
select tests.logout();
select is((select qty from inv.stock_balances where lot_id = tests.k('lot1') and place_id = tests.k('stores') and bucket = 'quarantine'), 2.000::numeric,
  'damaged goods come back into quarantine');
select is((select array[receiver_phone_last4::text, (cardinality(photo_paths))::text] from sales.pods where dispatch_id = tests.id('d1')), array['0555', '1'],
  'the proof keeps the photo path and only the last 4 digits of the receiver''s phone');
select ok(exists (select 1 from field.gps_points where user_id = tests.k('carrier') and source = 'pod'), 'the POD point is recorded only because the driver is on a trip after the notice');
select is((select count(*)::int from msg.outbox where doc_type = 'sales.orders' and doc_id = tests.id('o1') and template_name = 'delivered'), 1, 'the customer gets the delivery message');
select tests.login(tests.k('carrier'));
select is(api.close_trip(gen_random_uuid(), tests.id('trip'), '{}') ->> 'status', 'closed', 'the trip closes when every stop is done');
select ok(not exists (select 1 from field.duty_sessions where user_id = tests.k('carrier') and ended_at is null), 'closing the trip ends the driver''s GPS window');
select tests.logout();

-- ── Complaint → QC hold on the lot (not sellable) ──
select tests.login(tests.k('salesman'));
insert into ids select 'cmp', api.log_complaint(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'party_id', tests.k('cust'), 'lot_id', tests.k('lot1'),
  'description', 'Test bars cracked'));
select tests.logout();
select tests.login(tests.k('tester'));
insert into ids select 'hold', api.qc_hold_batch(gen_random_uuid(), jsonb_build_object('lot_id', tests.k('lot1'), 'complaint_id', tests.id('cmp'), 'reason', 'Test complaint on this batch'));
select tests.logout();
select is((select array[coalesce(sum(qty) filter (where bucket = 'available'), 0)::text, coalesce(sum(qty) filter (where bucket = 'hold'), 0)::text] from inv.stock_balances where lot_id = tests.k('lot1')),
  array['0.000', '50.000'], 'the held lot moves out of sellable stock everywhere');
select is((select status from inv.lots where id = tests.k('lot1')), 'hold', 'the lot status is hold');
select is((select status from sales.complaints where id = tests.id('cmp')), 'on_hold', 'the complaint shows the QC hold');
select tests.login(tests.k('buyer'));
insert into ids select 'd2', api.create_dispatch(gen_random_uuid(), jsonb_build_object('order_id', tests.id('o2'), 'eway_bill_no', '123456789013'));
select tests.logout();
select tests.login(tests.k('acct'));
select api.invoice_dispatch(gen_random_uuid(), tests.id('d2'), '{}');
select tests.logout();
select tests.login(tests.k('buyer'));
insert into ids select 'trip2', api.create_trip(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'transporter', 'Test Transporter', 'dispatch_ids', jsonb_build_array(tests.id('d2'))));
select is(tests.rule(format('select api.start_trip(gen_random_uuid(), %L, %L::jsonb)', tests.id('trip2'), '{}')), 'stock.insufficient', 'stock of a held lot cannot be dispatched');
select tests.logout();
select tests.login(tests.k('smgr'));
select is(tests.rule(format('select api.close_complaint(gen_random_uuid(), %L, %L)', tests.id('cmp'), 'Test replaced the bars')), 'complaint.hold_open', 'a complaint cannot close while QC holds the batch');
insert into ids select 'cmp_own', api.log_complaint(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'party_id', tests.k('cust'), 'description', 'Test late delivery', 'kind', 'delivery'));
select is(tests.rule(format('select api.close_complaint(gen_random_uuid(), %L, %L)', tests.id('cmp_own'), 'Test sorted it out')), 'complaint.not_alone', 'the person who logged a complaint cannot close it alone');
select tests.logout();
select tests.login(tests.k('salesman'));
select is(tests.rule(format('select api.close_complaint(gen_random_uuid(), %L, %L)', tests.id('cmp'), 'Test replaced the bars')), 'rights.missing', 'the salesperson cannot close a complaint');
select tests.logout();
select tests.login(tests.k('tester'));
select api.qc_release_hold(gen_random_uuid(), tests.id('hold', 'hold_id'), 'release', 'Test retest passed');
select tests.logout();
select is((select qty from inv.stock_balances where lot_id = tests.k('lot1') and place_id = tests.k('stores') and bucket = 'available'), 50.000::numeric, 'QC release puts the lot back on sale');
select tests.login(tests.k('smgr'));
select is(api.close_complaint(gen_random_uuid(), tests.id('cmp'), 'Test replaced the bars') ->> 'status', 'closed', 'another person closes it after the QC decision');
select tests.logout();

-- ── Export under LUT ──
select tests.login(tests.k('admin'));
insert into ids select 'exp', api.create_export_order(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'party_id', (select id from master.parties where legal_name = 'Test Overseas Buyer'),
  'currency', 'USD', 'fx_rate', 80, 'incoterm', 'FOB', 'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('rm2'), 'qty', 10, 'rate_fc', 5))));
select is(tests.rule(format('select api.add_container(gen_random_uuid(), jsonb_build_object(%L, %L, %L, %L))', 'export_order_id', tests.id('exp'), 'container_no', 'CSQU3054384')),
  'export.container_no', 'a container number with a wrong check digit is refused');
select is(api.add_container(gen_random_uuid(), jsonb_build_object('export_order_id', tests.id('exp'), 'container_no', 'CSQU3054383',
  'packing_list', jsonb_build_array(jsonb_build_object('product_id', tests.k('rm2'), 'cartons', 2, 'pieces', 10)))) ->> 'container_no', 'CSQU3054383', 'a valid ISO 6346 container number is accepted');
select is(api.check_packing_list(gen_random_uuid(), (select id from sales.containers where container_no = 'CSQU3054383'),
  jsonb_build_array(jsonb_build_object('product_id', tests.k('rm2'), 'cartons', 3, 'pieces', 10))) ->> 'status', 'mismatch', 'loading that differs from the packing list is flagged');
select is(tests.rule(format('select api.post_export_invoice(gen_random_uuid(), jsonb_build_object(%L, %L, %L, true))', 'export_order_id', tests.id('exp'), 'lut')), 'export.lut_expired',
  'an export without a valid LUT cannot go out without GST');
select tests.logout();
update sales.export_orders set lut_ref = 'TEST-LUT-1', lut_valid_to = current_date + 100 where id = tests.id('exp');
select tests.login(tests.k('admin'));
insert into ids select 'expinv', api.post_export_invoice(gen_random_uuid(), jsonb_build_object('export_order_id', tests.id('exp'), 'lut', true, 'shipping_bill_no', 'TSB1'));
select is((select array[tax_class, lawful_reason, igst::text, total::text, place_of_supply::text] from sales.documents where id = tests.id('expinv', 'document_id')),
  array['without_gst', 'export_lut', '0.00', '4000.00', '96'], 'the export invoice is zero-rated under LUT, in INR at the recorded rate');
select is((select array[currency::text, value_fc::text, shipping_bill_no] from sales.export_invoices where document_id = tests.id('expinv', 'document_id')), array['USD', '50.00', 'TSB1'],
  'currency, foreign value and shipping bill are kept');

-- ── Own shop: counter sale and day close ──
insert into ids select 'shop', api.upsert_shop(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'branch_id', tests.k('shop_branch'), 'place_id', tests.k('shop'),
  'walk_in_party_id', tests.k('cust'), 'cash_account_id', tests.k('cash'), 'bank_account_id', tests.k('bank')));
select tests.logout();
select tests.login(tests.k('receiver'));
insert into ids select 'sale', api.shop_sale(gen_random_uuid(), jsonb_build_object('shop_id', tests.id('shop'), 'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('prod'), 'qty', 2, 'rate', 100)),
  'payment', jsonb_build_object('mode', 'cash')));
select is((tests.r('sale') ->> 'total')::numeric, 236.00::numeric, 'the counter sale is a tax invoice with GST');
select is((select qty from inv.stock_balances where lot_id = tests.k('lot2') and place_id = tests.k('shop') and bucket = 'available'), 8.000::numeric, 'shop stock goes down through the stock ledger');
select is(api.shop_day_close(gen_random_uuid(), jsonb_build_object('shop_id', tests.id('shop'), 'denominations', jsonb_build_object('100', 2))) ->> 'status', 'mismatch',
  'a cash close that does not match the day''s cash is flagged');
select tests.logout();

-- ── RLS ──
select tests.login(tests.k('plastics_user'));
select is((select count(*)::int from api.sales_orders where company_id = tests.k('company_a')) + (select count(*)::int from api.dispatches where company_id = tests.k('company_a')), 0,
  'a company B user sees no company A orders or dispatches');
select tests.logout();
select tests.login(tests.k('salesman2'));
select is((select count(*)::int from api.sales_orders where party_id = tests.k('cust')), 0, 'a salesman does not see another salesman''s customers');
select tests.logout();

select * from finish();

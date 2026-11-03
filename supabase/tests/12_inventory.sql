-- Phase 4 inventory: the last unit cannot be issued twice, the ledger is append-only and balances cannot be typed in,
-- negative stock only under a logged allowance, transfers through the 9 states with two people at each end, the balance
-- rule before close, the picker never closes, sellable stock excludes transit/quarantine/hold, the challan for a
-- same-GSTIN move and the IGST invoice for another GSTIN, blind cycle counts approved by someone else, regrind, RLS.
select plan(50);

create temp table s as select tests.seed4(tests.seed3(tests.seed2(tests.seed()))) as v;
grant select on s to authenticated;
create or replace function tests.k(p text) returns uuid language sql stable as $$ select (v ->> p)::uuid from s $$;

-- ── Last unit ──
select tests.login(tests.k('admin'));
select lives_ok($$ select api.post_opening_stock(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'place_id', tests.k('stores'), 'date', '2026-06-01',
  'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('rm2'), 'qty', 1, 'unit_cost', 50)))) $$, 'opening stock of one unit is posted');
select tests.logout();

select tests.login(tests.k('store'));
create temp table iss as select api.issue_stock('aaaaaaaa-0000-4000-8000-000000000001', tests.k('rm2'), null, tests.k('stores'), 1, '{"kind":"production","ref":"Test batch","date":"2026-06-10"}'::jsonb) as r;
select ok((select r ->> 'issue_id' is not null from iss), 'the last unit is issued once');
select throws_ok($$ select api.issue_stock(gen_random_uuid(), tests.k('rm2'), null, tests.k('stores'), 1, '{"kind":"production","ref":"Test batch","date":"2026-06-10"}'::jsonb) $$,
  'P0001', null, 'a second issue of the same last unit in the same transaction is refused');
select is((api.issue_stock('aaaaaaaa-0000-4000-8000-000000000001', tests.k('rm2'), null, tests.k('stores'), 1, '{"kind":"production","date":"2026-06-10"}'::jsonb) ->> 'issue_id'),
  (select r ->> 'issue_id' from iss), 'repeating the same request returns the first result and issues nothing more');
select tests.logout();
select is((select qty from inv.stock_balances where product_id = tests.k('rm2') and place_id = tests.k('stores') and bucket = 'available'), 0.000::numeric(18,3), 'the balance is zero, not negative');
select is((select count(*)::int from inv.stock_ledger where product_id = tests.k('rm2') and move_type = 'issue'), 1, 'exactly one issue is in the ledger');

-- ── Append-only ledger, balances only through the RPCs ──
select throws_ok($$ update inv.stock_ledger set qty = 5 where product_id = tests.k('rm2') $$, 'P0001', null, 'the stock ledger cannot be edited');
select throws_ok($$ delete from inv.stock_ledger where product_id = tests.k('rm2') $$, 'P0001', null, 'the stock ledger cannot be deleted');
select throws_ok($$ update inv.stock_balances set qty = 100 where product_id = tests.k('rm2') $$, '42501', null, 'a balance cannot be typed in');

-- ── Negative stock only under a logged allowance ──
select tests.login(tests.k('store'));
select throws_ok($$ select api.set_negative_stock_allowance(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'product_id', tests.k('rm2'),
  'place_id', tests.k('stores'), 'reason', 'Test: I want negative stock')) $$, '42501', null, 'only Admin can allow negative stock');
select tests.logout();
select tests.login(tests.k('admin'));
select lives_ok($$ select api.set_negative_stock_allowance(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'product_id', tests.k('rm2'),
  'place_id', tests.k('stores'), 'reason', 'Test: goods arrived, paperwork pending')) $$, 'Admin allows negative stock for one item and place with a reason');
select tests.logout();
select tests.login(tests.k('store'));
select lives_ok($$ select api.issue_stock(gen_random_uuid(), tests.k('rm2'), null, tests.k('stores'), 2, '{"kind":"cost_centre","cost_centre":"Test","date":"2026-06-11"}'::jsonb) $$,
  'with the allowance the issue may go below zero');
select tests.logout();
select is((select qty from inv.stock_balances where product_id = tests.k('rm2') and place_id = tests.k('stores') and bucket = 'available'), -2.000::numeric(18,3), 'the balance shows the negative quantity');
select is((select count(*)::int from inv.negative_stock_uses where product_id = tests.k('rm2')), 1, 'each use of the allowance is logged');
select ok(exists (select 1 from audit.user_log where event = 'setting_changed' and detail ->> 'entity' = 'negative_stock_allowance' and detail ->> 'product_id' = tests.k('rm2')::text),
  'the allowance itself is in the user log');

-- ── Transfer on the same GSTIN: challan, 9 states, blind count, balance rule ──
select tests.login(tests.k('admin'));
select lives_ok($$ select api.post_opening_stock(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'place_id', tests.k('stores'), 'date', '2026-06-01',
  'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('prod'), 'qty', 15, 'unit_cost', 20)))) $$, 'opening stock of the finished item');
create temp table tr as select api.request_transfer(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'from_place_id', tests.k('stores'),
  'to_place_id', tests.k('shop'), 'date', '2026-06-15', 'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('prod'), 'qty', 10)))) as r;
select is((select r ->> 'gst_doc_kind' from tr), 'delivery_challan', 'a move on the same GSTIN travels on a delivery challan');
select throws_ok($$ select api.approve_transfer(gen_random_uuid(), (select (r ->> 'id')::uuid from tr)) $$, '42501', null, 'nobody approves their own transfer request');
select tests.logout();
create or replace function tests.tr() returns uuid language sql stable as $$ select (r ->> 'id')::uuid from tr $$;
grant select on tr to authenticated;

select tests.login(tests.k('custodian'));
select lives_ok($$ select api.approve_transfer(gen_random_uuid(), tests.tr()) $$, 'another person approves');
select lives_ok($$ select api.reserve_transfer(gen_random_uuid(), tests.tr()) $$, 'the custodian reserves released stock');
select tests.logout();
select tests.login(tests.k('store'));
select throws_ok($$ select api.issue_stock(gen_random_uuid(), tests.k('prod'), null, tests.k('stores'), 6, '{"kind":"production","date":"2026-06-15"}'::jsonb) $$,
  'P0001', null, 'reserved stock cannot be issued to someone else');
select tests.logout();

select tests.login(tests.k('admin2'));   -- the picker
select lives_ok($$ select api.pick_transfer(gen_random_uuid(), tests.tr(), jsonb_build_array(jsonb_build_object('line_id', (select id from inv.transfer_lines where transfer_id = tests.tr()), 'qty', 10))) $$,
  'the picker picks the approved quantity');
select lives_ok($$ select api.hand_over_transfer(gen_random_uuid(), tests.tr(), 'picker') $$, 'the picker confirms the handover');
select throws_ok($$ select api.hand_over_transfer(gen_random_uuid(), tests.tr(), 'carrier', '{"date":"2026-06-15"}'::jsonb) $$, '42501', null, 'the picker cannot also take over as carrier');
select tests.logout();
select tests.login(tests.k('carrier'));
select lives_ok($$ select api.hand_over_transfer(gen_random_uuid(), tests.tr(), 'carrier', '{"date":"2026-06-15","vehicle_no":"KL00T0000"}'::jsonb) $$, 'the carrier takes over on their own login');
select tests.logout();
select ok((select d.doc_type = 'delivery_challan' and d.status = 'posted' and d.doc_no like 'TDC/%' and d.tax_class = 'without_gst' and d.lawful_reason = 'challan_not_sold'
           from inv.transfers t join sales.documents d on d.id = t.sales_document_id where t.id = tests.tr()), 'a numbered delivery challan is posted with the dispatch');
select is((select array[sellable, in_transit] from api.stock_summary where place_id = tests.k('shop') and product_id = tests.k('prod')), array[0, 10]::numeric[],
  'goods in transit are company stock but not sellable');
select is((select available from api.stock_summary where place_id = tests.k('stores') and product_id = tests.k('prod')), 5.000::numeric(18,3), 'the sending place went down by the dispatched quantity');

select tests.login(tests.k('receiver'));
select is((select qty_dispatched from api.transfer_items where transfer_id = tests.tr()), null::numeric, 'the receiver does not see the dispatched quantity (blind count)');
select lives_ok($$ select api.receive_transfer(gen_random_uuid(), tests.tr(), jsonb_build_array(jsonb_build_object('item_id', (select id from inv.transfer_items where transfer_id = tests.tr()),
  'good_qty', 7, 'damaged_qty', 1))) $$, 'the receiver counts 7 good and 1 damaged');
select throws_ok($$ select api.write_off_transfer_shortage(gen_random_uuid(), tests.tr(), jsonb_build_array(jsonb_build_object('item_id', (select id from inv.transfer_items where transfer_id = tests.tr()), 'qty', 1)), 'Test: lost on the way') $$,
  '42501', null, 'the receiver cannot write off the shortage');
select tests.logout();

select tests.login(tests.k('custodian'));
select throws_ok($$ select api.close_transfer(gen_random_uuid(), tests.tr()) $$, 'P0001', null, 'the transfer cannot close while 2 are still in transit');
select tests.logout();
select tests.login(tests.k('admin2'));
select throws_ok($$ select api.close_transfer(gen_random_uuid(), tests.tr()) $$, '42501', null, 'the picker cannot close the transfer');
select tests.logout();
select tests.login(tests.k('finance'));
select lives_ok($$ select api.write_off_transfer_shortage(gen_random_uuid(), tests.tr(), jsonb_build_array(jsonb_build_object('item_id', (select id from inv.transfer_items where transfer_id = tests.tr()), 'qty', 1)), 'Test: lost on the way') $$,
  'finance writes off one missing unit');
select tests.logout();
select tests.login(tests.k('custodian'));
select is((api.reconcile_transfer(gen_random_uuid(), tests.tr(), jsonb_build_object('returned', jsonb_build_array(jsonb_build_object('item_id', (select id from inv.transfer_items where transfer_id = tests.tr()), 'qty', 1))))) ->> 'status',
  'reconciled', 'the last unit is returned and the transfer is reconciled');
select ok((select balanced and qty_in_transit = 0 and qty_dispatched = 10 and qty_dispatched = qty_accepted + qty_quarantined + qty_returned + qty_lost from api.transfers where id = tests.tr()),
  'dispatched = accepted + quarantined + returned + approved loss + in transit');
select lives_ok($$ select api.close_transfer(gen_random_uuid(), tests.tr()) $$, 'someone other than the picker closes it');
select tests.logout();
select is((select array[sellable, quarantine] from api.stock_summary where place_id = tests.k('shop') and product_id = tests.k('prod')), array[7, 1]::numeric[],
  'damaged goods sit in quarantine and are not sellable');
select is((select count(*)::int from inv.transfer_events where transfer_id = tests.tr()), 10, 'every step is in the transfer history');

-- ── Transfer to another GSTIN: tax invoice with IGST before dispatch ──
select tests.login(tests.k('admin'));
create temp table tr2 as select api.request_transfer(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'from_place_id', tests.k('stores'),
  'to_place_id', tests.k('tn_shop'), 'date', '2026-06-16', 'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('prod'), 'qty', 5)))) as r;
grant select on tr2 to authenticated;
select tests.logout();
create or replace function tests.tr2() returns uuid language sql stable as $$ select (r ->> 'id')::uuid from tr2 $$;
select tests.login(tests.k('custodian'));
select api.approve_transfer(gen_random_uuid(), tests.tr2());
select api.reserve_transfer(gen_random_uuid(), tests.tr2());
select tests.logout();
select tests.login(tests.k('admin2'));
select api.pick_transfer(gen_random_uuid(), tests.tr2(), jsonb_build_array(jsonb_build_object('line_id', (select id from inv.transfer_lines where transfer_id = tests.tr2()), 'qty', 5)));
select api.hand_over_transfer(gen_random_uuid(), tests.tr2(), 'picker');
select tests.logout();
select tests.login(tests.k('carrier'));
select throws_ok($$ select api.hand_over_transfer(gen_random_uuid(), tests.tr2(), 'carrier', '{"date":"2026-06-16"}'::jsonb) $$, 'P0001', null, 'goods cannot leave for another GSTIN without the tax invoice');
select tests.logout();
select tests.login(tests.k('admin'));
create temp table tinv as select api.post_sales_document(gen_random_uuid(), (api.save_sales_draft(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'),
  'gstin_id', tests.k('gstin_a'), 'doc_type', 'sales_invoice', 'doc_date', '2026-06-16', 'party_id', tests.k('tn_party'),
  'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('prod'), 'qty', 5, 'rate', 100)))) ->> 'id')::uuid) as r;
grant select on tinv to authenticated;
select tests.logout();
select tests.login(tests.k('carrier'));
select lives_ok($$ select api.hand_over_transfer(gen_random_uuid(), tests.tr2(), 'carrier', jsonb_build_object('date', '2026-06-16', 'sales_document_id', (select r ->> 'id' from tinv))) $$,
  'with the posted IGST invoice to the TN GSTIN the goods leave');
select tests.logout();
select ok((select d.igst > 0 and d.cgst = 0 and t.gst_doc_kind = 'tax_invoice' from inv.transfers t join sales.documents d on d.id = t.sales_document_id where t.id = tests.tr2()),
  'the transfer carries a tax invoice with IGST');

-- ── Blind cycle count approved by someone else ──
select tests.login(tests.k('custodian'));
create temp table cnt as select api.start_stock_count(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'place_id', tests.k('shop'), 'date', '2026-06-20',
  'product_ids', jsonb_build_array(tests.k('prod')))) as r;
select is((select system_qty from api.stock_count_lines where count_id = (select (r ->> 'id')::uuid from cnt) and bucket = 'available'), null::numeric, 'the counter does not see the system quantity');
select api.record_stock_count(gen_random_uuid(), (select (r ->> 'id')::uuid from cnt),
  (select jsonb_agg(jsonb_build_object('line_id', id, 'counted_qty', case when bucket = 'available' then 6 else 1 end)) from inv.count_lines where count_id = (select (r ->> 'id')::uuid from cnt)));
select api.submit_stock_count(gen_random_uuid(), (select (r ->> 'id')::uuid from cnt));
select throws_ok($$ select api.post_stock_count(gen_random_uuid(), (select (r ->> 'id')::uuid from cnt)) $$, '42501', null, 'the counter cannot approve their own count');
grant select on cnt to authenticated;
select tests.logout();
select tests.login(tests.k('admin'));
select lives_ok($$ select api.post_stock_count(gen_random_uuid(), (select (r ->> 'id')::uuid from cnt)) $$, 'someone else posts the differences');
select tests.logout();
select is((select sellable from api.stock_summary where place_id = tests.k('shop') and product_id = tests.k('prod')), 6.000::numeric(18,3), 'the difference is posted as an adjustment');

-- ── Regrind ──
select tests.login(tests.k('store'));
select api.record_regrind(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'kind', 'scrap_in', 'product_id', tests.k('scrap'), 'place_id', tests.k('stores'), 'qty', 5, 'machine', 'T1', 'date', '2026-06-20'));
select api.record_regrind(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'kind', 'regrind_reuse', 'product_id', tests.k('scrap'), 'place_id', tests.k('stores'), 'qty', 2, 'date', '2026-06-20'));
select tests.logout();
select is((select sellable from api.stock_summary where place_id = tests.k('stores') and product_id = tests.k('scrap')), 3.000::numeric(18,3), 'scrap weighed in less regrind reused');

-- ── RLS: another company's stock is invisible ──
select tests.login(tests.k('plastics_user'));
select is((select count(*)::int from api.stock_on_hand where company_id = tests.k('company_a')), 0, 'a company B user sees no company A stock');
select is((select count(*)::int from api.transfers where company_id = tests.k('company_a')), 0, 'a company B user sees no company A transfers');
select tests.logout();
select tests.login(tests.k('acct'));
select ok((select count(*) > 0 from api.stock_on_hand where company_id = tests.k('company_a')), 'a company A accountant sees company A stock');
select tests.logout();

select * from finish();

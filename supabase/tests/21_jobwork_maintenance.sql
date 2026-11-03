-- Phase 7 job work and maintenance: goods out to a job worker on a job-work challan (delivery challan, goods not sold, from the
-- challan series) with the return-by date from settings (1 year for inputs, none for moulds and tools), stock moved to the job
-- worker's place through the ledger, receipts (finished / scrap / returned / loss) settling the balance per line and refusing more
-- than is out, overdue flagged once to the Bug fixer; repair requests from a failed operator check and from a breakdown, spares
-- through the stock ledger, downtime from the breakdown and restore times, preventive schedules, and RLS. Synthetic data only.
select plan(28);

create temp table s as select tests.seed7(tests.seed5(tests.seed4(tests.seed3(tests.seed2(tests.seed()))))) as v;
grant select on s to authenticated;
create or replace function tests.k(p text) returns uuid language sql stable as $$ select (v ->> p)::uuid from s $$;
create temp table ids (k text primary key, v jsonb);
grant select, insert on ids to authenticated;
create or replace function tests.r(p text) returns jsonb language sql stable as $$ select v from ids where k = p $$;
create or replace function tests.id(p text, f text default 'id') returns uuid language sql stable as $$ select (v ->> f)::uuid from ids where k = p $$;
create or replace function tests.bal(p_product uuid, p_place uuid) returns numeric language sql stable security definer as $$
  select coalesce(sum(qty), 0) from inv.stock_balances where product_id = p_product and place_id = p_place and bucket = 'available' $$;
grant execute on all functions in schema tests to authenticated;

-- ── Job work out ──
select tests.login(tests.k('store'));
insert into ids select 'jw', api.issue_job_work_challan(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'job_worker_party_id', tests.k('job_worker'),
  'process', 'Test machining', 'goods_kind', 'inputs', 'from_place_id', tests.k('stores'), 'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('rm2'), 'qty', 10))));
select tests.logout();
select is((select doc_type || '|' || tax_class || '|' || lawful_reason || '|' || status from sales.documents where id = tests.id('jw', 'challan_id')),
  'delivery_challan|without_gst|challan_not_sold|posted', 'the goods leave on a posted delivery challan (goods not sold), not an invoice');
select is((select party_id from sales.documents where id = tests.id('jw', 'challan_id')), tests.k('job_worker'), 'the challan is addressed to the job worker');
select ok((tests.r('jw') ->> 'challan_no') like 'TDC/%', 'the challan number comes from the GSTIN''s challan series');
select is((select return_by from prod.job_work_orders where id = tests.id('jw')), (current_date + interval '1 year')::date, 'inputs must come back within one year (setting)');
select is(tests.bal(tests.k('rm2'), tests.k('stores')), 90.000::numeric, 'the stores are down by what was sent');
select is(tests.bal(tests.k('rm2'), tests.id('jw', 'jw_place_id')), 10.000::numeric, 'the goods sit at the job worker''s place, still ours');

select tests.login(tests.k('store'));
insert into ids select 'jw_mould', api.issue_job_work_challan(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'job_worker_party_id', tests.k('job_worker'),
  'process', 'Test texturing', 'goods_kind', 'moulds_tools', 'from_place_id', tests.k('stores'), 'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('rm2'), 'qty', 1))));
select is((tests.r('jw_mould') ->> 'return_by'), null, 'moulds, dies, jigs, fixtures and tools have no return limit');

-- ── Job work back ──
insert into ids select 'line', jsonb_build_object('id', (select id from prod.job_work_lines where order_id = tests.id('jw')));
insert into ids select 'rec1', api.receive_job_work(gen_random_uuid(), tests.id('jw'), jsonb_build_object('challan_ref', 'TJW-RET-1', 'to_place_id', tests.k('stores'),
  'lines', jsonb_build_array(jsonb_build_object('line_id', tests.id('line'), 'kind', 'finished', 'product_id', tests.k('cmp1'), 'qty', 6, 'input_qty', 6),
                             jsonb_build_object('line_id', tests.id('line'), 'kind', 'scrap', 'product_id', tests.k('scrap'), 'qty', 0.5))));
select is(tests.r('rec1') ->> 'status', 'part_received', 'part of the goods came back');
select is((tests.r('rec1') -> 'balance' -> 0 ->> 'balance')::numeric, 4.000::numeric, 'the balance still with the job worker is 4');
select is(tests.bal(tests.k('cmp1'), tests.k('stores')), 6.000::numeric, 'the finished pieces are in the stores');
select is(tests.hint(format('select api.receive_job_work(gen_random_uuid(), %L, jsonb_build_object(%L, jsonb_build_array(jsonb_build_object(%L, %L, %L, %L, %L, 5))))',
  tests.id('jw'), 'lines', 'line_id', tests.id('line'), 'kind', 'returned', 'qty')), 'jobwork.over_balance', 'more than is out with the job worker cannot come back');
insert into ids select 'rec2', api.receive_job_work(gen_random_uuid(), tests.id('jw'), jsonb_build_object('to_place_id', tests.k('stores'),
  'lines', jsonb_build_array(jsonb_build_object('line_id', tests.id('line'), 'kind', 'returned', 'qty', 3), jsonb_build_object('line_id', tests.id('line'), 'kind', 'loss', 'input_qty', 1))));
select tests.logout();
select is(tests.r('rec2') ->> 'status', 'received', 'everything is accounted for: the order is received');
select is(tests.bal(tests.k('rm2'), tests.id('jw', 'jw_place_id')), 1.000::numeric, 'nothing of this order is left at the job worker (1 is the mould order)');
select is(tests.bal(tests.k('rm2'), tests.k('stores')), 92.000::numeric, 'the unprocessed goods are back in the stores');
select throws_ok($$ update prod.job_work_receipts set qty = 0 $$, 'P0001', null, 'job work receipts are append-only');

-- ── Overdue (test clock: the order is moved into the past) ──
update prod.job_work_orders set sent_on = '2026-04-02', return_by = current_date - 1 where id = tests.id('jw_mould');
select tests.login(tests.k('store'));
select is((select overdue from api.v_job_work_orders where id = tests.id('jw_mould')), true, 'goods not back by the limit are flagged overdue');
select tests.logout();
select is(app.job_work_overdue_run(tests.k('company_a'), current_date), 1, 'the overdue order goes to the Bug fixer for the CA');
select is(app.job_work_overdue_run(tests.k('company_a'), current_date), 0, 'and only once');

-- ── Maintenance: a failed operator check opens a repair request ──
select tests.login(tests.k('operator'));
select api.record_machine_check(gen_random_uuid(), jsonb_build_object('asset_id', tests.k('inj'), 'checklist', jsonb_build_array(jsonb_build_object('item', 'oil level', 'ok', true),
  jsonb_build_object('item', 'cooling water', 'ok', false))));
select tests.logout();
select is((select source || '|' || priority || '|' || is_breakdown::text from prod.repair_requests where asset_id = tests.k('inj')), 'operator_check|urgent|true',
  'a ✗ on the daily check opens an urgent repair request for the machine');

-- ── Breakdown, spares, restore ──
select tests.login(tests.k('operator'));
insert into ids select 'rr', api.raise_repair_request(gen_random_uuid(), jsonb_build_object('asset_id', tests.k('scale'), 'title', 'Test display dead', 'is_breakdown', true,
  'broke_down_at', now() - interval '3 hours'));
select is((select status from core.assets where id = tests.k('scale')), 'repair', 'a breakdown takes the machine out of use');
select is(tests.hint(format('select api.close_repair_request(gen_random_uuid(), %L, %L::jsonb)', tests.id('rr'), '{"resolution": "fixed"}')), 'rights.missing',
  'an operator cannot close a repair (maintenance right needed)');
select tests.logout();
select tests.login(tests.k('mouldmgr'));
select api.issue_spares(gen_random_uuid(), jsonb_build_object('repair_request_id', tests.id('rr'), 'place_id', tests.k('stores'),
  'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('oil'), 'qty', 2))));
select is(tests.bal(tests.k('oil'), tests.k('stores')), 48.000::numeric, 'spares leave the stores through the stock ledger');
select is((select value from prod.spares_issues where repair_request_id = tests.id('rr')), 400.00::numeric(18,2), 'and are valued (2 × 200)');
insert into ids select 'rr_done', api.close_repair_request(gen_random_uuid(), tests.id('rr'), jsonb_build_object('resolution', 'Test board replaced',
  'restored_at', (select broke_down_at + interval '90 minutes' from prod.repair_requests where id = tests.id('rr'))));
select is((tests.r('rr_done') ->> 'downtime_minutes')::numeric, 90.00::numeric, 'downtime is worked out from breakdown to restore');
select is((select status from core.assets where id = tests.k('scale')), 'active', 'the machine runs again');

-- ── Preventive schedule ──
insert into ids select 'sch', api.upsert_maintenance_schedule(gen_random_uuid(), jsonb_build_object('asset_id', tests.k('inj'), 'title', 'Test oil change', 'interval_days', 30,
  'next_due_on', current_date - 1));
select is((select overdue from api.v_maintenance_schedules where id = tests.id('sch')), true, 'a service past its date shows overdue');
select is((api.record_maintenance_done(gen_random_uuid(), tests.id('sch'), '{}'::jsonb) ->> 'next_due_on')::date, current_date + 30, 'doing it moves the next date by the interval');
select tests.logout();

-- ── RLS ──
select tests.login(tests.k('plastics_user'));
select is((select count(*)::int from api.v_job_work_orders) + (select count(*)::int from api.v_repair_requests) + (select count(*)::int from prod.spares_issues), 0,
  'a company B user sees no company A job work, repairs or spares');
select tests.logout();

select * from finish();

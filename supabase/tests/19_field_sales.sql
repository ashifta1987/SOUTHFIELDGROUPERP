-- Phase 6 route sales and the salesman portal: GPS only on duty and after the notice, the 150 m geofence computed in Postgres
-- (200 m refused without a reason, then flagged for the sales manager; 100 m accepted), the salesman sees GST bills only
-- (salesman_balance_scope = gst_only), collections with the ₹2 lakh cash refusal, cash handover on two logins with the mismatch
-- flagged, end of day refusing unsynced work, the 90-day GPS purge, beats, and RLS. Synthetic data only.
select plan(33);

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

-- Admin bills the customer: one tax invoice and one bill of supply without GST (exempt item, lawful reason).
select tests.login(tests.k('admin'));
insert into ids select 'inv', api.save_sales_draft(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'gstin_id', tests.k('gstin_a'), 'party_id', tests.k('cust'),
  'doc_type', 'sales_invoice', 'doc_date', current_date, 'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('prod'), 'qty', 10, 'rate', 100))));
select api.post_sales_document(gen_random_uuid(), tests.id('inv'));
insert into ids select 'bos', api.save_sales_draft(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'gstin_id', tests.k('gstin_a'), 'party_id', tests.k('cust'),
  'doc_type', 'bill_of_supply', 'lawful_reason', 'exempt_or_nil', 'doc_date', current_date, 'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('prod_free'), 'qty', 5, 'rate', 100))));
select api.post_sales_document(gen_random_uuid(), tests.id('bos'));
select is((api.salesman_customer_account(tests.k('company_a'), tests.k('cust')) ->> 'balance_due')::numeric, 1680.00::numeric, 'Admin sees the full balance');
select tests.logout();

-- ── Duty and GPS ──
select tests.login(tests.k('salesman'));
select is(tests.rule($q$ select api.record_locations(gen_random_uuid(), '[{"lat": 10.0, "lng": 76.3}]') $q$), 'gps.off_duty', 'a location ping off duty is refused');
select is(tests.rule(format('select api.check_in_visit(gen_random_uuid(), jsonb_build_object(%L, %L, %L, %L, %L, 10.0, %L, 76.3))', 'company_id', tests.k('company_a'), 'party_id', tests.k('cust'), 'lat', 'lng')),
  'gps.off_duty', 'check-in needs the day to be started');
select is(tests.rule(format('select api.start_duty(gen_random_uuid(), jsonb_build_object(%L, %L))', 'company_id', tests.k('company_a'))), 'gps.notice_required',
  'the day starts only after the location notice is accepted');
insert into ids select 'duty', api.start_duty(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'notice_ack', true));
select is(api.record_locations(gen_random_uuid(), '[{"lat": 10.0, "lng": 76.3}, {"lat": 10.001, "lng": 76.3}]') ->> 'recorded', '2', 'pings are recorded while on duty');

-- ── Geofence (pin at 10.000000, 76.300000) ──
select is(tests.rule(format('select api.check_in_visit(gen_random_uuid(), jsonb_build_object(%L, %L, %L, %L, %L, 10.0018, %L, 76.3))', 'company_id', tests.k('company_a'),
  'party_id', tests.k('cust'), 'lat', 'lng')), 'visit.out_of_fence', 'a check-in 200 m from the pin is refused without a reason');
insert into ids select 'v_far', api.check_in_visit(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'party_id', tests.k('cust'), 'lat', 10.0018, 'lng', 76.3,
  'reason', 'Test shop moved across the road'));
select is(array[tests.r('v_far') ->> 'geofence_ok', tests.r('v_far') ->> 'approval'], array['false', 'pending'], 'with a reason it is recorded and flagged for the sales manager');
select ok((tests.r('v_far') ->> 'distance_m')::numeric between 195 and 205, 'the distance is computed in Postgres (about 200 m)');
select is(tests.rule(format('select api.check_out_visit(gen_random_uuid(), %L, %L::jsonb)', tests.id('v_far', 'visit_id'), '{"outcome": "no_order"}')), 'visit.no_order_reason',
  'a no-order visit needs its reason');
select api.check_out_visit(gen_random_uuid(), tests.id('v_far', 'visit_id'), '{"outcome": "no_order", "no_order_reason": "Test owner away", "lat": 10.0018, "lng": 76.3}');
select is(tests.rule(format('select api.approve_out_of_geofence(gen_random_uuid(), %L, true, %L)', tests.id('v_far', 'visit_id'), 'Test')), 'rights.missing',
  'the salesman cannot approve his own out-of-fence check-in');
insert into ids select 'v_near', api.check_in_visit(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'party_id', tests.k('cust'), 'lat', 10.0009, 'lng', 76.3));
select is(array[tests.r('v_near') ->> 'geofence_ok', tests.r('v_near') ->> 'approval'], array['true', 'none'], 'a check-in 100 m from the pin is accepted');
select tests.logout();
select tests.login(tests.k('smgr'));
select is(api.approve_out_of_geofence(gen_random_uuid(), tests.id('v_far', 'visit_id'), true, 'Test pin to be corrected') ->> 'approval', 'approved', 'the sales manager approves the exception');
select tests.logout();

-- ── The salesman's view of the account: GST bills only ──
select tests.login(tests.k('salesman'));
insert into ids select 'acc', api.salesman_customer_account(tests.k('company_a'), tests.k('cust'));
select is(array[tests.r('acc') ->> 'scope', tests.r('acc') ->> 'balance_due', jsonb_array_length(tests.r('acc') -> 'open_bills')::text], array['gst_only', '1180.00', '1'],
  'the salesman sees the GST bill balance only (Q-12 reading b)');
select is((select count(*)::int from api.sales_documents where party_id = tests.k('cust')), 0, 'the salesman cannot list documents directly');
select is(jsonb_array_length(api.my_customers(tests.k('company_a'))), 1, 'the salesman sees his assigned customer');

-- ── Collections ──
select is(tests.rule(format('select api.field_collect(gen_random_uuid(), jsonb_build_object(%L, %L, %L, %L, %L, 200000, %L, %L))', 'company_id', tests.k('company_a'),
  'party_id', tests.k('cust'), 'amount', 'mode', 'cash')), 'cash.receipt_blocked', 'cash of ₹2 lakh or more from one customer in a day is refused');
insert into ids select 'col', api.field_collect(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'party_id', tests.k('cust'), 'amount', 1000, 'mode', 'cash',
  'visit_id', tests.id('v_near', 'visit_id')));
select is(array[tests.r('col') #>> '{allocated,0,kind}', tests.r('col') #>> '{allocated,0,amount}', tests.r('col') ->> 'balance_gst'], array['sales_document', '1000.00', '180.00'],
  'the collection is set against the oldest GST bill and the new balance is returned');
select is((select (v.amount)::text from api.field_collections v where v.id is not null limit 1), '1000.00', 'the collection shows as with the salesman');
select is((api.my_day(tests.k('company_a'), current_date) ->> 'cash_with_me')::numeric, 1000.00::numeric, 'my day shows the cash with me');
select api.check_out_visit(gen_random_uuid(), tests.id('v_near', 'visit_id'), '{"outcome": "collection", "lat": 10.0009, "lng": 76.3}');

-- ── End of day and handover ──
select is(tests.rule(format('select api.end_salesman_day(gen_random_uuid(), jsonb_build_object(%L, %L, %L, 2))', 'company_id', tests.k('company_a'), 'unsynced')), 'field.unsynced',
  'the day cannot end while anything is unsynced');
select is(tests.rule(format('select api.end_salesman_day(gen_random_uuid(), jsonb_build_object(%L, %L))', 'company_id', tests.k('company_a'))), 'field.cash_not_handed_over',
  'the day cannot end with cash not handed over');
insert into ids select 'ho', api.cash_handover(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'denominations', jsonb_build_object('500', 1, '200', 2)));
select is(array[tests.r('ho') ->> 'expected', tests.r('ho') ->> 'counted'], array['1000.00', '900'], 'the handover records the expected cash and the salesman''s count');
select is(tests.rule(format('select api.confirm_cash_handover(gen_random_uuid(), %L, %L::jsonb)', tests.id('ho'), '{}')), 'rights.missing', 'the salesman cannot confirm his own handover');
select tests.logout();
select tests.login(tests.k('acct'));
select is(api.confirm_cash_handover(gen_random_uuid(), tests.id('ho'), jsonb_build_object('denominations', jsonb_build_object('500', 1, '200', 2), 'to_account_id', tests.k('cash'))) ->> 'status',
  'mismatch', 'the cashier''s count against the expected cash is flagged as a mismatch');
select tests.logout();
select ok(exists (select 1 from ops.bug_items where dedupe_key = 'field.handover:' || tests.id('ho') and status = 'open'), 'the mismatch opens a Bug fixer item');
select tests.login(tests.k('salesman'));
select is(api.end_salesman_day(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'))) ->> 'visits_done', '2', 'the day ends with the visit count');
select is(tests.rule($q$ select api.record_locations(gen_random_uuid(), '[{"lat": 10.0, "lng": 76.3}]') $q$), 'gps.off_duty', 'no location after the day has ended');
select tests.logout();

-- ── 90-day retention ──
insert into field.gps_points (company_id, user_id, session_id, at, lat, lng) values
  (tests.k('company_a'), tests.k('salesman'), tests.id('duty', 'session_id'), now() - interval '100 days', 10.0, 76.3),
  (tests.k('company_a'), tests.k('salesman'), tests.id('duty', 'session_id'), now() - interval '10 days', 10.0, 76.3);
select is((app.purge_gps(null) ->> 'points_deleted')::int, 1, 'the purge removes only the point older than 90 days');
select is((select count(*)::int from field.gps_points where user_id = tests.k('salesman')), 7, 'recent points stay (6 on-duty points today + 1 from 10 days ago)');

-- ── Beats and RLS ──
select tests.login(tests.k('smgr'));
select api.plan_beat(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'code', 'TB1', 'name', 'Test Beat', 'salesman_user_id', tests.k('salesman'),
  'weekday', extract(isodow from current_date)::int, 'customers', jsonb_build_array(tests.k('cust'))));
select is((select count(*)::int from api.visits where salesman_user_id = tests.k('salesman')), 2, 'the sales manager sees every salesman''s visits');
select tests.logout();
select tests.login(tests.k('salesman'));
select is(jsonb_array_length(api.my_route_today(tests.k('company_a'), current_date)), 1, 'today''s route lists the beat''s shops');
select tests.logout();
select tests.login(tests.k('salesman2'));
select is((select count(*)::int from api.visits where salesman_user_id = tests.k('salesman')) + (select count(*)::int from api.gps_points where user_id = tests.k('salesman')), 0,
  'another salesman sees none of his visits or locations');
select is(tests.rule(format('select api.salesman_customer_account(%L, %L)', tests.k('company_a'), tests.k('cust'))), 'field.not_my_customer', 'and cannot open his customer''s account');
select tests.logout();

select * from finish();

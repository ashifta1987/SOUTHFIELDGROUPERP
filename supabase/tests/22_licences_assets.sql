-- Phase 7 licences and the asset register: reminders at 90/30/7 days sent once each (a late first run sends only the tightest one),
-- the owner's alert carries no figures, an expired blocking licence stops a dependent production entry until it is renewed (renewal
-- history kept), documents only in the company's licences folder, an expired blocking licence goes to the Bug fixer once;
-- depreciation refused until the CA's method, lives and residual are recorded, then posted pro-rata through the books once per
-- month; disposal posts the gain or loss. Synthetic data only.
select plan(29);

create temp table s as select tests.seed7(tests.seed5(tests.seed4(tests.seed3(tests.seed2(tests.seed()))))) as v;
grant select on s to authenticated;
create or replace function tests.k(p text) returns uuid language sql stable as $$ select (v ->> p)::uuid from s $$;
create temp table ids (k text primary key, v jsonb);
grant select, insert on ids to authenticated;
create or replace function tests.r(p text) returns jsonb language sql stable as $$ select v from ids where k = p $$;
create or replace function tests.id(p text, f text default 'id') returns uuid language sql stable as $$ select (v ->> f)::uuid from ids where k = p $$;
create or replace function tests.oct() returns uuid language sql stable security definer as $$
  select id from core.periods where company_id = tests.k('company_a') and month_start = '2026-10-01' $$;
grant execute on all functions in schema tests to authenticated;

-- ── Reminders at 90 / 30 / 7 days, once each ──
select tests.login(tests.k('admin'));
insert into ids select 'l1', api.upsert_licence(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'kind', 'factory', 'licence_no', 'TEST-FAC-1',
  'title', 'Test factory licence', 'valid_from', current_date - 365, 'valid_to', current_date + 90, 'owner_person_id', tests.k('licence_owner')));
select tests.logout();
select app.licence_reminders_run(tests.k('company_a'), current_date);
select is((select string_agg(days_before || ':' || status, ',') from core.licence_reminders where licence_id = tests.id('l1')), '90:queued',
  '90 days before expiry the owner''s reminder is queued');
select app.licence_reminders_run(tests.k('company_a'), current_date);
select is((select count(*)::int from core.licence_reminders where licence_id = tests.id('l1')), 1, 'running again the same day sends nothing more');
select app.licence_reminders_run(tests.k('company_a'), current_date + 60);
select app.licence_reminders_run(tests.k('company_a'), current_date + 61);
select is((select string_agg(days_before::text, ',' order by days_before desc) from core.licence_reminders where licence_id = tests.id('l1')), '90,30', 'the 30-day reminder goes once');
select app.licence_reminders_run(tests.k('company_a'), current_date + 83);
select app.licence_reminders_run(tests.k('company_a'), current_date + 85);
select app.licence_reminders_run(tests.k('company_a'), current_date + 89);
select is((select string_agg(days_before::text, ',' order by days_before desc) from core.licence_reminders where licence_id = tests.id('l1')), '90,30,7', 'and the 7-day reminder once');
select is((select count(*)::int from msg.outbox where doc_id = tests.id('l1') and event = 'internal.licence_expiring'), 3, 'three messages in all, never twice');
select is((select array_agg(k order by k) from msg.outbox o, jsonb_object_keys(o.params) k where o.id = (select id from msg.outbox where doc_id = tests.id('l1') limit 1)),
  array['days_left', 'licence', 'licence_no', 'valid_to'], 'the alert carries the licence and its dates only, no figures');

-- A late first run (5 days left) sends only the 7-day reminder; the larger ones are recorded as superseded.
select tests.login(tests.k('admin'));
insert into ids select 'l2', api.upsert_licence(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'kind', 'trade', 'licence_no', 'TEST-TRD-1',
  'valid_from', current_date - 300, 'valid_to', current_date + 5, 'owner_person_id', tests.k('licence_owner')));
select is(tests.hint(format('select api.run_licence_reminders(gen_random_uuid(), %L, %L)', tests.k('company_a'), current_date)), 'no error', 'Admin can run the reminders now');
select tests.logout();
select is((select string_agg(days_before || ':' || status, ',' order by days_before) from core.licence_reminders where licence_id = tests.id('l2')), '7:queued,30:superseded,90:superseded',
  'only the tightest reminder is sent on a late first run');
select is((select count(*)::int from msg.outbox where doc_id = tests.id('l2')), 1, 'one message, not three');

-- ── An expired blocking licence stops a dependent production entry until it is renewed ──
select tests.login(tests.k('admin'));
insert into ids select 'family', api.upsert_process_family(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'code', 'TNOLIC', 'name', 'Test family needing no product licence'));
insert into ids select 'pcb', api.upsert_licence(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'kind', 'pollution_consent', 'licence_no', 'TEST-PCB-1',
  'valid_from', '2025-01-01', 'valid_to', '2026-01-31', 'is_blocking', true, 'blocks', jsonb_build_array('production')));
select tests.logout();
select tests.login(tests.k('maker'));
insert into ids select 'version', api.save_formula_version(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'product_id', tests.k('fg'), 'family_id', tests.id('family'),
  'code', 'TF-P7', 'name', 'Test formula P7', 'batch_size', 10, 'fill_qty_g', 100,
  'lines', jsonb_build_array(jsonb_build_object('line_kind', 'bulk', 'product_id', tests.k('rm2'), 'qty', 6), jsonb_build_object('line_kind', 'bulk', 'product_id', tests.k('rm3'), 'qty', 4))));
select api.submit_formula_version(gen_random_uuid(), tests.id('version', 'version_id'));
select tests.logout();
select tests.login(tests.k('approver'));
select api.approve_formula_version(gen_random_uuid(), tests.id('version', 'version_id'), '2026-04-01');
select tests.logout();
select tests.login(tests.k('maker'));
select is(tests.hint(format('select api.plan_batch(gen_random_uuid(), jsonb_build_object(%L, %L, %L, %L, %L, 10, %L, %L, %L, %L, %L, %L))', 'company_id', tests.k('company_a'),
  'product_id', tests.k('fg'), 'planned_qty', 'line_place_id', tests.k('line'), 'stores_place_id', tests.k('stores'), 'fg_place_id', tests.k('fg_place'))), 'licence.expired',
  'an expired blocking licence (pollution consent) stops the production entry');
select tests.logout();
select tests.login(tests.k('acct'));
select is(tests.hint(format('select api.renew_licence(gen_random_uuid(), %L, jsonb_build_object(%L, current_date, %L, current_date + 365))', tests.id('pcb'), 'valid_from', 'valid_to')),
  'rights.missing', 'only Admin records a renewal');
select tests.logout();
select tests.login(tests.k('admin'));
select api.renew_licence(gen_random_uuid(), tests.id('pcb'), jsonb_build_object('valid_from', current_date, 'valid_to', current_date + 365, 'note', 'Test renewal'));
select is(tests.hint(format('select api.renew_licence(gen_random_uuid(), %L, jsonb_build_object(%L, current_date, %L, current_date + 30))', tests.id('pcb'), 'valid_from', 'valid_to')),
  'licence.not_later', 'a renewal must run beyond the current expiry');
select tests.logout();
select is((select old_valid_to::text || '|' || new_licence_no from core.licence_renewals where licence_id = tests.id('pcb')), '2026-01-31|TEST-PCB-1', 'the old dates are kept in the renewal history');
select is((select renewal_status from core.licences where id = tests.id('pcb')), 'renewed', 'the licence shows renewed');
select tests.login(tests.k('maker'));
select lives_ok(format('select api.plan_batch(gen_random_uuid(), jsonb_build_object(%L, %L, %L, %L, %L, 10, %L, %L, %L, %L, %L, %L))', 'company_id', tests.k('company_a'),
  'product_id', tests.k('fg'), 'planned_qty', 'line_place_id', tests.k('line'), 'stores_place_id', tests.k('stores'), 'fg_place_id', tests.k('fg_place')),
  'after the renewal the production entry goes through');
select tests.logout();

-- ── Documents in the company's licences folder only ──
select tests.login(tests.k('admin'));
select is(tests.hint(format('select api.add_licence_document(gen_random_uuid(), %L, jsonb_build_object(%L, %L))', tests.id('pcb'), 'path', tests.k('company_b') || '/licences/x.pdf')),
  'licence.document_folder', 'a licence file cannot go into another company''s folder');
select api.add_licence_document(gen_random_uuid(), tests.id('pcb'), jsonb_build_object('path', tests.k('company_a') || '/licences/' || tests.id('pcb') || '/test-copy.pdf', 'kind', 'licence_copy'));
select is((select documents from api.v_licence_register where id = tests.id('pcb')), 1, 'the copy is on file');

-- ── An expired blocking licence goes to the Bug fixer once ──
insert into ids select 'fire', api.upsert_licence(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'kind', 'fire', 'licence_no', 'TEST-FIRE-1',
  'valid_from', '2025-07-01', 'valid_to', '2026-06-30', 'is_blocking', true, 'blocks', jsonb_build_array('packing')));
select is((select state from api.v_licence_register where id = tests.id('fire')), 'expired', 'the register shows it expired');
select tests.logout();
select app.licence_reminders_run(tests.k('company_a'), current_date);
select app.licence_reminders_run(tests.k('company_a'), current_date);
select is((select count(*)::int from ops.bug_items where ref_id = tests.id('fire')), 1, 'one Bug fixer item, however often the job runs');

-- ── Depreciation: refused until the CA's settings are recorded ──
select tests.login(tests.k('admin'));
select is(tests.hint(format('select api.run_depreciation(gen_random_uuid(), %L, %L)', tests.k('company_a'), tests.oct())), 'depreciation.settings_missing',
  'no method set → depreciation is refused, nothing assumed');
select api.set_setting(gen_random_uuid(), tests.k('company_a'), 'depreciation.method', '"wdv"', '2026-04-01', 'Test CA setting');
select is(tests.hint(format('select api.run_depreciation(gen_random_uuid(), %L, %L)', tests.k('company_a'), tests.oct())), 'depreciation.life_not_set',
  'no useful life → refused');
select api.set_setting(gen_random_uuid(), tests.k('company_a'), 'depreciation.useful_life_years', '{"utility": 10}', '2026-04-01', 'Test CA setting');
select is(tests.hint(format('select api.run_depreciation(gen_random_uuid(), %L, %L)', tests.k('company_a'), tests.oct())), 'depreciation.residual_not_set',
  'WDV with no residual value → refused');
select api.set_setting(gen_random_uuid(), tests.k('company_a'), 'depreciation.method', '"slm"', '2026-04-02', 'Test CA setting');
insert into ids select 'dep', api.run_depreciation(gen_random_uuid(), tests.k('company_a'), tests.oct());
select is((tests.r('dep') ->> 'total')::numeric, 1019.18::numeric, 'SLM: 1,20,000 ÷ 10 years × 31 / 365 days = 1,019.18');
select is((select sum(dr)::text || '|' || sum(cr)::text from acct.gl_entries where voucher_id = tests.id('dep', 'voucher_id')), '1019.18|1019.18', 'posted as one balanced journal');
select is(tests.hint(format('select api.run_depreciation(gen_random_uuid(), %L, %L)', tests.k('company_a'), tests.oct())), 'depreciation.already_run', 'a month is depreciated once');
select tests.logout();
select tests.login(tests.k('acct'));
select is(tests.hint(format('select api.run_depreciation(gen_random_uuid(), %L, %L)', tests.k('company_a'), tests.oct())), 'rights.missing', 'the accountant cannot post depreciation without the right');
select tests.logout();

-- ── Disposal ──
select tests.login(tests.k('admin'));
insert into ids select 'disp', api.dispose_asset(gen_random_uuid(), tests.k('dep_asset'), jsonb_build_object('proceeds', 100000, 'proceeds_account_id', tests.k('bank'), 'reason', 'Test sold to a buyer'));
select is((tests.r('disp') ->> 'gain_loss')::numeric, -18980.82::numeric, 'loss = proceeds − (cost − depreciation) = 1,00,000 − 1,18,980.82');
select tests.logout();
select is((select status from core.assets where id = tests.k('dep_asset')), 'disposed', 'the asset is marked disposed');
select throws_ok($$ update acct.depreciation_lines set amount = 0 $$, 'P0001', null, 'depreciation lines are append-only');

select * from finish();

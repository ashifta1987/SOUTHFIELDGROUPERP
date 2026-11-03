-- Phase 5 Plastics: mould projects approved in order by someone else; the mould register; injection shift entry with
-- theoretical output (run time ÷ cycle time × cavities) and OEE = availability × performance × quality, recomputed here;
-- granules out and scrap in through the stock ledger; good pieces in quarantine until an inspection by someone who did not
-- make them; the mixer grinder BOM (second-person approval) and assembly that consumes components and refuses when short;
-- pad printing ink; machine checks; RLS hides the other company.
select plan(39);

create temp table s as select tests.seed5(tests.seed4(tests.seed3(tests.seed2(tests.seed())))) as v;
grant select on s to authenticated;
create or replace function tests.k(p text) returns uuid language sql stable as $$ select (v ->> p)::uuid from s $$;
create temp table ids (k text primary key, id uuid);
grant select, insert, update on ids to authenticated;
create or replace function tests.id(p text) returns uuid language sql stable as $$ select id from ids where k = p $$;

select tests.login(tests.k('admin'));
select lives_ok($$ select api.post_opening_stock(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'place_id', tests.k('stores'), 'date', '2026-06-01',
  'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('granule'), 'qty', 100, 'unit_cost', 100), jsonb_build_object('product_id', tests.k('ink'), 'qty', 5, 'unit_cost', 400)))) $$,
  'opening stock of granules and ink');
select api.post_opening_stock(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'place_id', tests.k('mould_out'), 'date', '2026-06-01',
  'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('cmp2'), 'qty', 3, 'unit_cost', 10))));
select tests.logout();

-- ── Mould project and register ──
select tests.login(tests.k('mouldmgr'));
insert into ids select 'project', (api.save_mould_project(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'code', 'TMP-1', 'name', 'Test mould project',
  'product_id', tests.k('cmp1'))) ->> 'id')::uuid;
select is(tests.hint($q$ select api.advance_mould_project(gen_random_uuid(), tests.id('project'), 'approval') $q$), 'mould.stage_order', 'a project cannot skip the trial');
select lives_ok($$ select api.advance_mould_project(gen_random_uuid(), tests.id('project'), 'trial') $$, 'design → trial');
select lives_ok($$ select api.advance_mould_project(gen_random_uuid(), tests.id('project'), 'approval') $$, 'trial → approval');
select is(tests.hint($q$ select api.advance_mould_project(gen_random_uuid(), tests.id('project'), 'approved') $q$), 'rights.missing', 'the mould manager cannot approve');
select tests.logout();
select tests.login(tests.k('approver'));
select lives_ok($$ select api.advance_mould_project(gen_random_uuid(), tests.id('project'), 'approved') $$, 'the factory manager approves the project');
select tests.logout();
select tests.login(tests.k('mouldmgr'));
insert into ids select 'mould', (api.upsert_mould(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'code', 'TMLD-1', 'name', 'Test mould', 'project_id', tests.id('project'),
  'product_id', tests.k('cmp1'), 'material_product_id', tests.k('granule'), 'cavities', 4, 'cycle_time_sec', 20, 'part_weight_g', 10, 'runner_weight_g', 4,
  'service_interval_shots', 1000, 'life_shots', 100000, 'cost', 200000)) ->> 'id')::uuid;
select lives_ok($$ select api.move_mould(gen_random_uuid(), tests.id('mould'), jsonb_build_object('location', 'machine', 'machine_asset_id', tests.k('inj'))) $$, 'the mould is mounted on the machine');
select tests.logout();

-- ── Shift entry: theoretical output and OEE ──
select tests.login(tests.k('operator'));
select is(tests.hint($q$ select api.record_injection_shift(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'place_id', tests.k('mould_out'),
  'output_place_id', tests.k('mould_out'), 'shift', 'day', 'machine_asset_id', tests.k('inj'), 'mould_id', tests.id('mould'), 'cavities_running', 5, 'planned_minutes', 480, 'good_qty', 10)) $q$),
  'shift.cavities', 'cavities running cannot exceed the mould''s cavities');
create temp table sh as select api.record_injection_shift(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'place_id', tests.k('mould_out'),
  'output_place_id', tests.k('mould_out'), 'shift', 'day', 'machine_asset_id', tests.k('inj'), 'mould_id', tests.id('mould'), 'operator_user_id', tests.k('operator'),
  'cavities_running', 4, 'planned_minutes', 480, 'shot_start', 0, 'shot_end', 1200, 'good_qty', 4500,
  'rejects', jsonb_build_array(jsonb_build_object('reason', 'short shot', 'qty', 200), jsonb_build_object('reason', 'flash', 'qty', 100)),
  'downtime', jsonb_build_array(jsonb_build_object('kind', 'setup', 'minutes', 30), jsonb_build_object('kind', 'breakdown', 'minutes', 30)),
  'materials', jsonb_build_array(jsonb_build_object('product_id', tests.k('granule'), 'qty', 50, 'place_id', tests.k('stores'))),
  'scrap', jsonb_build_object('product_id', tests.k('scrap'), 'qty', 3, 'place_id', tests.k('stores')))) as r;
select tests.logout();
grant select on sh to authenticated;
insert into ids select 'shift', (r ->> 'id')::uuid from sh;
select is((select run_minutes from prod.injection_shifts where id = tests.id('shift')), 420.00::numeric(9,2), 'run time = planned 480 − downtime 60');
select is((select theoretical_qty from prod.injection_shifts where id = tests.id('shift')), 5040.000::numeric(18,3), 'theoretical = floor(420×60 ÷ 20) × 4 cavities = 5040');
select is((select array[availability, performance, quality] from prod.injection_shifts where id = tests.id('shift')), array[0.8750, 0.9524, 0.9375]::numeric[],
  'availability 420/480, performance 4800/5040, quality 4500/4800');
select ok((select oee = round(availability * performance * quality, 4) and oee = 0.7813 from prod.injection_shifts where id = tests.id('shift')), 'OEE = A × P × Q (recomputed)');
select ok((select abs(oee - run_minutes / planned_minutes * ((good_qty + reject_qty) / (floor(run_minutes * 60 / cycle_time_sec) * cavities_running)) * (good_qty / (good_qty + reject_qty))) <= 0.0001
           from prod.injection_shifts where id = tests.id('shift')), 'an independent recompute from the raw shift data agrees within 0.0001');
select is((select sum(qty) from prod.shift_rejects where shift_id = tests.id('shift')), 300.000::numeric(18,3), 'rejects by reason are kept');
select is((select qty from inv.stock_balances where product_id = tests.k('granule') and place_id = tests.k('stores') and bucket = 'available'), 50.000::numeric(18,3),
  'granules used left the stores through the ledger');
select is((select count(*)::int from prod.material_consumption where source_id = tests.id('shift') and kind = 'granule'), 1, 'and are in the consumption ledger');
select is((select qty from inv.stock_balances where product_id = tests.k('scrap') and place_id = tests.k('stores') and bucket = 'available'), 3.000::numeric(18,3), 'scrap is weighed in');
select is((select count(*)::int from prod.regrind_entries where note = (select r ->> 'doc_no' from sh) and kind = 'scrap_in'), 1, 'the scrap entry is on the regrind register');
select is((select qty from inv.stock_balances where product_id = tests.k('cmp1') and place_id = tests.k('mould_out') and bucket = 'quarantine'), 4500.000::numeric(18,3),
  'good pieces wait in quarantine');
select is((select shot_count from prod.moulds where id = tests.id('mould')), 1200::bigint, 'the mould''s shot count goes up by the shots');
select is((select service_due from api.moulds where id = tests.id('mould')), true, 'the register shows service due past the shot interval');

-- ── Inspection: never by the maker ──
select tests.login(tests.k('inspector'));
select is(tests.hint($q$ select api.release_from_quarantine(gen_random_uuid(), (select lot_id from prod.injection_shifts where id = tests.id('shift'))) $q$), 'qc.use_batch_release',
  'moulded lots are not released through the incoming-goods release');
select is(tests.hint($q$ select api.record_quality_inspection(gen_random_uuid(), jsonb_build_object('lot_id', (select lot_id from prod.injection_shifts where id = tests.id('shift')),
  'kind', 'final', 'result', 'pass', 'accepted_qty', 4400, 'rejected_qty', 50)) $q$), 'qc.qty_mismatch', 'accepted + rejected must equal the quarantined pieces');
select tests.logout();
select tests.login(tests.k('admin2'));
create temp table sh2 as select api.record_injection_shift(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'place_id', tests.k('mould_out'),
  'output_place_id', tests.k('mould_out'), 'shift', 'night', 'machine_asset_id', tests.k('inj'), 'mould_id', tests.id('mould'), 'cavities_running', 4, 'planned_minutes', 60, 'good_qty', 100)) as r;
select is(tests.hint($q$ select api.record_quality_inspection(gen_random_uuid(), jsonb_build_object('lot_id', (select (r ->> 'lot_id')::uuid from sh2),
  'kind', 'final', 'result', 'pass', 'accepted_qty', 100, 'rejected_qty', 0)) $q$), 'sod.inspector_maker', 'the person who recorded a shift cannot inspect its lot');
select tests.logout();
select tests.login(tests.k('inspector'));
select lives_ok($$ select api.record_quality_inspection(gen_random_uuid(), jsonb_build_object('lot_id', (select lot_id from prod.injection_shifts where id = tests.id('shift')),
  'kind', 'final', 'result', 'pass', 'accepted_qty', 4400, 'rejected_qty', 100, 'defects', jsonb_build_array('sink marks'))) $$, 'an independent inspector accepts 4400 and rejects 100');
select tests.logout();
select is((select array[coalesce(sum(qty) filter (where bucket = 'available'), 0), coalesce(sum(qty) filter (where bucket = 'rejected'), 0), coalesce(sum(qty) filter (where bucket = 'quarantine'), 0)]
           from inv.stock_balances where lot_id = (select lot_id from prod.injection_shifts where id = tests.id('shift'))), array[4400, 100, 0]::numeric[], 'accepted pieces are available, rejects set aside');

-- ── Mixer grinder BOM and assembly ──
select tests.login(tests.k('mouldmgr'));
insert into ids select 'bom', (api.save_assembly_bom(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'product_id', tests.k('mixer'),
  'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('cmp1'), 'qty_per', 2), jsonb_build_object('product_id', tests.k('cmp2'), 'qty_per', 1)))) ->> 'id')::uuid;
select tests.logout();
select tests.login(tests.k('assembler'));
select is(tests.hint($q$ select api.post_assembly(gen_random_uuid(), jsonb_build_object('product_id', tests.k('mixer'), 'qty', 1, 'from_place_id', tests.k('mould_out'),
  'to_place_id', tests.k('fg_place'))) $q$), 'bom.none_approved', 'no assembly without an approved BOM');
select tests.logout();
select tests.login(tests.k('approver'));
select lives_ok($$ select api.approve_assembly_bom(gen_random_uuid(), tests.id('bom')) $$, 'another person approves the BOM');
select tests.logout();
select tests.login(tests.k('assembler'));
select is(tests.hint($q$ select api.post_assembly(gen_random_uuid(), jsonb_build_object('product_id', tests.k('mixer'), 'qty', 5, 'from_place_id', tests.k('mould_out'),
  'to_place_id', tests.k('fg_place'))) $q$), 'prod.components_short', 'five units need five of component two; only three are free → refused');
select is((select qty from inv.stock_balances where product_id = tests.k('cmp1') and place_id = tests.k('mould_out') and bucket = 'available'), 4400.000::numeric(18,3), 'nothing moved on refusal');
create temp table asm as select api.post_assembly(gen_random_uuid(), jsonb_build_object('product_id', tests.k('mixer'), 'qty', 3, 'from_place_id', tests.k('mould_out'),
  'to_place_id', tests.k('fg_place'), 'labour_hours', 2)) as r;
select tests.logout();
select is((select array[(select qty from inv.stock_balances where product_id = tests.k('cmp1') and place_id = tests.k('mould_out') and bucket = 'available'),
                        (select qty from inv.stock_balances where product_id = tests.k('cmp2') and place_id = tests.k('mould_out') and bucket = 'available')]),
  array[4394, 0]::numeric[], 'three units consumed 6 of component one and 3 of component two');
select is((select count(*)::int from prod.material_consumption where source_id = (select (r ->> 'id')::uuid from asm) and kind = 'component'), 2, 'the components are in the consumption ledger');
select is((select qty from inv.stock_balances where product_id = tests.k('mixer') and place_id = tests.k('fg_place') and bucket = 'quarantine'), 3.000::numeric(18,3),
  'assembled units wait in quarantine for inspection');

-- ── Pad printing and machine checks ──
select tests.login(tests.k('operator'));
select lives_ok($$ select api.record_pad_print_job(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'product_id', tests.k('cmp1'), 'qty_printed', 1000,
  'prints_per_piece', 2, 'ink_product_id', tests.k('ink'), 'ink_qty', 0.5, 'ink_place_id', tests.k('stores'), 'labour_minutes', 60)) $$, 'a pad printing job uses ink from the stores');
select tests.logout();
select is((select ink_value from prod.pad_print_jobs order by created_at desc limit 1), 200.00::numeric(18,2), 'ink value = 0.5 kg × 400');
select tests.login(tests.k('operator'));
select is((api.record_machine_check(gen_random_uuid(), jsonb_build_object('asset_id', tests.k('inj'), 'checklist', jsonb_build_array(jsonb_build_object('item', 'oil level', 'ok', true),
  jsonb_build_object('item', 'heater zones', 'ok', false)))) ->> 'all_ok')::boolean, false, 'a failed daily check is recorded');
select tests.logout();
select is((select status from core.assets where id = tests.k('inj')), 'repair', 'and the machine goes for repair');
select throws_ok($$ update prod.mould_events set shots = 0 where mould_id = tests.id('mould') $$, 'P0001', null, 'mould history is append-only');

-- ── RLS ──
select tests.login(tests.k('plastics_user'));
select is((select count(*)::int from api.injection_shifts) + (select count(*)::int from api.moulds) + (select count(*)::int from prod.assembly_orders), 0,
  'a company B user sees no company A shifts, moulds or assemblies');
select tests.logout();

select * from finish();

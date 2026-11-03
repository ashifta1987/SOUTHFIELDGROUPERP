-- Phase 5 Biochem: formula versions approved by another person; no batch without an approved formula and a valid
-- licence; weighing needs a second-person check and only then leaves the stores (append-only consumption ledger);
-- QC limits on lab results; packaging + bulk reconciliation (Bug fixer item, blocks close; tolerance unset = exact);
-- finished goods in quarantine until QC release; the batch maker cannot release their own batch; batch costing;
-- packs need a GST treatment before billing; RLS hides the other company.
select plan(63);

create temp table s as select tests.seed5(tests.seed4(tests.seed3(tests.seed2(tests.seed())))) as v;
grant select on s to authenticated;
create or replace function tests.k(p text) returns uuid language sql stable as $$ select (v ->> p)::uuid from s $$;
create temp table ids (k text primary key, id uuid);
grant select, insert, update on ids to authenticated;
create or replace function tests.id(p text) returns uuid language sql stable as $$ select id from ids where k = p $$;

-- ── Set-up: a licensed family, opening stock, an overhead rate ──
select tests.login(tests.k('admin'));
insert into ids select 'family', (api.upsert_process_family(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'code', 'TSOAP', 'name', 'Test soap bars',
  'licence_kind', 'cosmetics_manufacturing', 'steps', jsonb_build_array('mix', 'mill', 'plod', 'cut', 'stamp'))) ->> 'id')::uuid;
select lives_ok($$ select api.post_opening_stock(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'place_id', tests.k('stores'), 'date', '2026-06-01',
  'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('rm2'), 'qty', 100, 'unit_cost', 50), jsonb_build_object('product_id', tests.k('rm3'), 'qty', 100, 'unit_cost', 20),
                             jsonb_build_object('product_id', tests.k('wrap'), 'qty', 500, 'unit_cost', 2)))) $$, 'opening stock of the materials and wrappers');
select api.post_opening_stock(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'place_id', tests.k('fg_place'), 'date', '2026-06-01',
  'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('wrap'), 'qty', 20, 'unit_cost', 2))));
select lives_ok($$ select api.set_cost_rate(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'kind', 'overhead_per_kg', 'rate', 5, 'effective_from', '2026-04-01')) $$,
  'Admin sets a synthetic overhead rate per kg');
select tests.logout();

-- ── Formula: draft, submit, approval by another person ──
select tests.login(tests.k('maker'));
select is(tests.hint($q$ select api.save_formula_version(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'product_id', tests.k('fg'), 'family_id', tests.id('family'),
  'code', 'TF-BAD', 'batch_size', 10, 'lines', jsonb_build_array(jsonb_build_object('line_kind', 'bulk', 'product_id', tests.k('wrap'), 'qty', 1)))) $q$), 'prod.bulk_by_weight',
  'bulk materials are entered by weight only');
insert into ids select 'version', (api.save_formula_version(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'product_id', tests.k('fg'), 'family_id', tests.id('family'),
  'code', 'TF-1', 'name', 'Test formula', 'batch_size', 10, 'fill_qty_g', 100,
  'qc_spec', jsonb_build_array(jsonb_build_object('parameter', 'ph', 'min', 9, 'max', 11, 'stage', 'bulk')),
  'lines', jsonb_build_array(jsonb_build_object('line_kind', 'bulk', 'product_id', tests.k('rm2'), 'qty', 6), jsonb_build_object('line_kind', 'bulk', 'product_id', tests.k('rm3'), 'qty', 4),
                             jsonb_build_object('line_kind', 'packaging', 'product_id', tests.k('wrap'), 'qty', 1)))) ->> 'version_id')::uuid;
select is(tests.hint($q$ select api.plan_batch(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'product_id', tests.k('fg'), 'planned_qty', 10,
  'line_place_id', tests.k('line'), 'stores_place_id', tests.k('stores'), 'fg_place_id', tests.k('fg_place'))) $q$), 'prod.no_approved_formula',
  'a batch cannot open while the formula is only a draft');
select lives_ok($$ select api.submit_formula_version(gen_random_uuid(), tests.id('version')) $$, 'the maker sends the formula for approval');
select is(tests.hint($q$ select api.approve_formula_version(gen_random_uuid(), tests.id('version')) $q$), 'sod.own_formula', 'nobody approves the formula they wrote');
select tests.logout();
select tests.login(tests.k('approver'));
select lives_ok($$ select api.approve_formula_version(gen_random_uuid(), tests.id('version'), '2026-04-01') $$, 'another person approves it');
select tests.logout();
select throws_ok($$ update prod.formula_versions set batch_size = 20 where id = tests.id('version') $$, 'P0001', null, 'an approved formula version cannot be changed');
select throws_ok($$ insert into prod.formula_lines (company_id, version_id, line_no, line_kind, product_id, qty) values (tests.k('company_a'), tests.id('version'), 9, 'bulk', tests.k('rm2'), 1) $$,
  'P0001', null, 'lines of an approved version cannot be added');

-- ── Licence block ──
select tests.login(tests.k('maker'));
select is(tests.hint($q$ select api.plan_batch(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'product_id', tests.k('fg'), 'planned_qty', 10,
  'line_place_id', tests.k('line'), 'stores_place_id', tests.k('stores'), 'fg_place_id', tests.k('fg_place'))) $q$), 'licence.missing', 'no licence recorded → production entry is blocked');
select is(tests.hint($q$ select api.upsert_licence(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'kind', 'cosmetics_manufacturing', 'licence_no', 'TEST-LIC-1',
  'valid_from', '2025-01-01')) $q$), 'rights.missing', 'only Admin enters licences');
select tests.logout();
select tests.login(tests.k('admin'));
select lives_ok($$ select api.upsert_licence(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'kind', 'cosmetics_manufacturing', 'licence_no', 'TEST-LIC-OLD',
  'valid_from', '2024-01-01', 'valid_to', '2025-12-31')) $$, 'Admin records an expired synthetic licence');
select tests.logout();
select tests.login(tests.k('maker'));
select is(tests.hint($q$ select api.plan_batch(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'product_id', tests.k('fg'), 'planned_qty', 10,
  'line_place_id', tests.k('line'), 'stores_place_id', tests.k('stores'), 'fg_place_id', tests.k('fg_place'))) $q$), 'licence.expired', 'an expired licence blocks production entry');
select tests.logout();
select tests.login(tests.k('admin'));
insert into ids select 'licence', (api.upsert_licence(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'kind', 'cosmetics_manufacturing', 'licence_no', 'TEST-LIC-NEW',
  'valid_from', '2026-01-01', 'valid_to', '2030-12-31')) ->> 'id')::uuid;
select tests.logout();

-- ── Batch: plan, reserve, weigh with a second-person check ──
select tests.login(tests.k('maker'));
insert into ids select 'batch', (api.plan_batch(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'product_id', tests.k('fg'), 'planned_qty', 10, 'shift', 'day',
  'line_place_id', tests.k('line'), 'stores_place_id', tests.k('stores'), 'fg_place_id', tests.k('fg_place'))) ->> 'id')::uuid;
select is((select licence_id from prod.batches where id = tests.id('batch')), tests.id('licence'), 'the batch records the licence in force');
select lives_ok($$ select api.reserve_batch_materials(gen_random_uuid(), tests.id('batch')) $$, 'materials are reserved for the batch');
select is((select sum(qty) from inv.reservations where source_id = tests.id('batch') and status = 'active'), 10.000::numeric(18,3), 'the formula is scaled to the planned kg');
select is(tests.hint($q$ select api.record_weighing(gen_random_uuid(), tests.id('batch'), jsonb_build_array(jsonb_build_object('product_id', tests.k('rm2'), 'qty', 6,
  'scale_asset_id', tests.k('scale_overdue')))) $q$), 'asset.calibration_due', 'a scale due for calibration cannot be used');
insert into ids select 'w1', (api.record_weighing(gen_random_uuid(), tests.id('batch'), jsonb_build_array(jsonb_build_object('product_id', tests.k('rm2'), 'qty', 6, 'scale_asset_id', tests.k('scale'))))
  -> 'weighing_ids' ->> 0)::uuid;
insert into ids select 'w2', (api.record_weighing(gen_random_uuid(), tests.id('batch'), jsonb_build_array(jsonb_build_object('product_id', tests.k('rm3'), 'qty', 4, 'scale_asset_id', tests.k('scale'))))
  -> 'weighing_ids' ->> 0)::uuid;
select is(tests.hint($q$ select api.verify_weighing(gen_random_uuid(), tests.id('w1')) $q$), 'sod.own_weighing', 'the weigher cannot check their own weighing');
select is(tests.hint($q$ select api.start_batch(gen_random_uuid(), tests.id('batch')) $q$), 'batch.state', 'the batch cannot start before every weighing is checked');
select tests.logout();
select is((select qty from inv.stock_balances where product_id = tests.k('rm2') and place_id = tests.k('stores') and bucket = 'available'), 100.000::numeric(18,3),
  'nothing leaves the stores before the check');
select tests.login(tests.k('admin2'));   -- the second person (later refused at release: they helped make the batch)
select lives_ok($$ select api.verify_weighing(gen_random_uuid(), tests.id('w1')) $$, 'a second person checks the first weighing');
select lives_ok($$ select api.verify_weighing(gen_random_uuid(), tests.id('w2')) $$, 'and the second');
select tests.logout();
select is((select status from prod.batches where id = tests.id('batch')), 'weighed', 'all materials checked → weighed and issued');
select is((select qty from inv.stock_balances where product_id = tests.k('rm2') and place_id = tests.k('stores') and bucket = 'available'), 94.000::numeric(18,3),
  'the checked weight left the stores through the stock ledger');
select is((select count(*)::int from prod.material_consumption where batch_id = tests.id('batch') and kind = 'bulk_material'), 2, 'two consumption rows for the batch');
select throws_ok($$ update prod.material_consumption set qty = 1 where batch_id = tests.id('batch') $$, 'P0001', null, 'the consumption ledger cannot be edited');
select throws_ok($$ delete from prod.material_consumption where batch_id = tests.id('batch') $$, 'P0001', null, 'the consumption ledger cannot be deleted');
select is((select count(*)::int from inv.reservations where source_id = tests.id('batch') and status = 'active'), 0, 'the reservations are used up');

-- ── Process, bulk sample, lab limits ──
select tests.login(tests.k('maker'));
select lives_ok($$ select api.start_batch(gen_random_uuid(), tests.id('batch')) $$, 'the batch starts');
insert into ids select 'bulk_sample', (api.send_sample(gen_random_uuid(), tests.id('batch'), jsonb_build_object('kind', 'bulk', 'bulk_qty', 9.8)) ->> 'sample_id')::uuid;
select tests.logout();
select tests.login(tests.k('chemist'));
select is(tests.hint($q$ select api.record_lab_result(gen_random_uuid(), tests.id('bulk_sample'), jsonb_build_object('result', 'pass', 'parameters', jsonb_build_object('ph', 12),
  'instrument_id', tests.k('phm'))) $q$), 'qc.out_of_spec', 'a pass outside the approved limits is refused');
select lives_ok($$ select api.record_lab_result(gen_random_uuid(), tests.id('bulk_sample'), jsonb_build_object('result', 'pass', 'parameters', jsonb_build_object('ph', 10),
  'instrument_id', tests.k('phm'))) $$, 'the chemist passes the bulk within limits');
select tests.logout();
select is((select status from prod.batches where id = tests.id('batch')), 'bulk_passed', 'bulk passed');

-- ── Packaging in Nos, packing, reconciliation ──
select tests.login(tests.k('maker'));
select lives_ok($$ select api.issue_batch_packaging(gen_random_uuid(), tests.id('batch'), jsonb_build_array(jsonb_build_object('product_id', tests.k('wrap'), 'qty', 100))) $$,
  '100 wrappers go to the line');
select lives_ok($$ select api.record_packing(gen_random_uuid(), tests.id('batch'), jsonb_build_object('good_packs', 95, 'rejected_packs', 2, 'bulk_scrap_kg', 0.1,
  'packaging', jsonb_build_array(jsonb_build_object('product_id', tests.k('wrap'), 'scrapped', 1, 'returned', 1, 'at_line', 0)))) $$, 'packing is recorded: 95 good, 2 rejected');
select tests.logout();
select is((select array[issued, in_good, in_rejected, scrapped, returned, at_line, difference] from prod.packaging_recon where batch_id = tests.id('batch') and product_id = tests.k('wrap')),
  array[100, 95, 2, 1, 1, 0, 1]::numeric[], 'issued 100 = 95 + 2 + 1 + 1 + 0 leaves a difference of 1');
select is((select recon_status from prod.batches where id = tests.id('batch')), 'mismatch', 'the batch does not reconcile');
select ok(exists (select 1 from ops.bug_items where dedupe_key = 'prod.recon:' || tests.id('batch') and status = 'open' and area = 'production'), 'a Bug fixer item is raised');
select is((select qty from inv.stock_balances b join prod.batches x on x.fg_lot_id = b.lot_id where x.id = tests.id('batch') and b.bucket = 'quarantine' and b.place_id = tests.k('fg_place')),
  95.000::numeric(18,3), 'the finished goods land in quarantine');
select is((select coalesce(sum(qty), 0) from inv.stock_balances where product_id = tests.k('fg') and bucket = 'available'), 0::numeric, 'nothing is sellable before QC release');
select is((select qty from inv.stock_balances where product_id = tests.k('wrap') and place_id = tests.k('stores') and bucket = 'available'), 401.000::numeric(18,3),
  'the returned wrapper is back in the stores');

-- ── QC release: never by a batch maker ──
select tests.login(tests.k('releaser'));
select is(tests.hint($q$ select api.release_from_quarantine(gen_random_uuid(), (select fg_lot_id from prod.batches where id = tests.id('batch'))) $q$), 'qc.use_batch_release',
  'the incoming-goods release cannot be used for a production lot');
select is(tests.hint($q$ select api.qc_release_batch(gen_random_uuid(), tests.id('batch')) $q$), 'qc.no_pass', 'no release without a passed finished-goods test');
select tests.logout();
select tests.login(tests.k('maker'));
insert into ids select 'fin_sample', (api.send_sample(gen_random_uuid(), tests.id('batch'), jsonb_build_object('kind', 'finished')) ->> 'sample_id')::uuid;
select tests.logout();
select tests.login(tests.k('chemist'));
select lives_ok($$ select api.record_lab_result(gen_random_uuid(), tests.id('fin_sample'), jsonb_build_object('result', 'pass', 'parameters', '{}'::jsonb)) $$, 'the finished goods pass');
select tests.logout();
select tests.login(tests.k('admin'));
select is(tests.hint($q$ select api.assign_shift_duties(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'work_date', current_date, 'shift', 'day',
  'assignments', jsonb_build_array(jsonb_build_object('user_id', tests.k('admin2'), 'duty', 'qc_releaser', 'batch_id', tests.id('batch'))))) $q$), 'sod.self_release',
  'work assignment refuses to make a batch maker its QC releaser');
select lives_ok($$ select api.assign_shift_duties(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'work_date', current_date, 'shift', 'day',
  'assignments', jsonb_build_array(jsonb_build_object('user_id', tests.k('releaser'), 'duty', 'labour', 'batch_id', tests.id('batch'), 'hours', 4)))) $$,
  'the QC releaser also helped on the line as labour');
select tests.logout();
select tests.login(tests.k('admin2'));
select is(tests.hint($q$ select api.qc_release_batch(gen_random_uuid(), tests.id('batch')) $q$), 'sod.self_release', 'the person who checked the weighing cannot release the batch');
select tests.logout();
select tests.login(tests.k('releaser'));
select is(tests.hint($q$ select api.qc_release_batch(gen_random_uuid(), tests.id('batch')) $q$), 'sod.self_release', 'a releaser who worked on the batch cannot release it');
select tests.logout();
select tests.login(tests.k('inspector'));
select lives_ok($$ select api.qc_release_batch(gen_random_uuid(), tests.id('batch')) $$, 'an independent QC person releases it');
select tests.logout();
select is((select qty from inv.stock_balances b join prod.batches x on x.fg_lot_id = b.lot_id where x.id = tests.id('batch') and b.bucket = 'available'), 95.000::numeric(18,3),
  'released goods are available');
select ok((select basis_locked and status = 'released' from prod.batches where id = tests.id('batch')), 'the entry basis is locked at release');

-- ── Close needs a balanced reconciliation; costing ──
select tests.login(tests.k('approver'));
select is(tests.hint($q$ select api.close_batch(gen_random_uuid(), tests.id('batch')) $q$), 'prod.recon_mismatch', 'the difference blocks the batch from closing');
select tests.logout();
select tests.login(tests.k('maker'));
select is((api.reconcile_packaging(gen_random_uuid(), tests.id('batch'), jsonb_build_array(jsonb_build_object('product_id', tests.k('wrap'), 'at_line', 1))) ->> 'balanced')::boolean, true,
  'the recount finds the last wrapper at the line');
select tests.logout();
select is((select status from ops.bug_items where code = (select code from ops.bug_items where ref_id = tests.id('batch') order by created_at desc limit 1)), 'fixed', 'the Bug fixer item is closed');
select tests.login(tests.k('approver'));
select lives_ok($$ select api.close_batch(gen_random_uuid(), tests.id('batch')) $$, 'the batch closes');
select tests.logout();
select is((select array[materials, packaging, overhead, total] from prod.batch_costs where batch_id = tests.id('batch')), array[380, 196, 49, 625]::numeric[],
  'cost = materials 6×50 + 4×20, packaging 98×2, overhead 9.8 kg × 5');
select is((select cost_per_pack from prod.batch_costs where batch_id = tests.id('batch')), 6.5789::numeric(18,4), 'cost per good pack');

-- ── Packs: GST treatment before billing ──
select tests.login(tests.k('maker'));
insert into ids select 'pack', (api.upsert_pack(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'product_id', tests.k('pack'), 'kind', 'gift_pack', 'name', 'Test gift pack',
  'items', jsonb_build_array(jsonb_build_object('product_id', tests.k('fg'), 'qty', 2), jsonb_build_object('product_id', tests.k('wrap'), 'qty', 1, 'is_free', true)))) ->> 'id')::uuid;
select lives_ok($$ select api.post_pack_assembly(gen_random_uuid(), jsonb_build_object('pack_id', tests.id('pack'), 'qty', 10, 'from_place_id', tests.k('fg_place'), 'to_place_id', tests.k('fg_place'))) $$,
  'ten packs are built from released stock; the free item is issued');
select tests.logout();
select is((select count(*)::int from prod.material_consumption where kind = 'free_item' and product_id = tests.k('wrap')), 1, 'the free item is recorded in the consumption ledger');
select throws_ok($$ with d as (insert into sales.documents (company_id, gstin_id, doc_type, doc_date, party_id, place_of_supply)
                               values (tests.k('company_a'), tests.k('gstin_a'), 'sales_invoice', current_date, tests.k('cust'), '32') returning id)
                    insert into sales.document_lines (document_id, line_no, product_id, description, qty, rate) select id, 1, tests.k('pack'), 'Test gift pack', 1, 100 from d $$,
  'P0001', null, 'a pack without a GST treatment cannot be billed');

-- ── A licence suspended after planning blocks the next production entry ──
select tests.login(tests.k('maker'));
insert into ids select 'batch2', (api.plan_batch(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'product_id', tests.k('fg'), 'planned_qty', 5,
  'line_place_id', tests.k('line'), 'stores_place_id', tests.k('stores'), 'fg_place_id', tests.k('fg_place'))) ->> 'id')::uuid;
select tests.logout();
select tests.login(tests.k('admin'));
select lives_ok($$ select api.upsert_licence(gen_random_uuid(), jsonb_build_object('id', tests.id('licence'), 'company_id', tests.k('company_a'), 'kind', 'cosmetics_manufacturing',
  'licence_no', 'TEST-LIC-NEW', 'valid_from', '2026-01-01', 'valid_to', '2030-12-31', 'status', 'suspended')) $$, 'Admin marks the licence suspended');
select tests.logout();
select tests.login(tests.k('maker'));
select is(tests.hint($q$ select api.reserve_batch_materials(gen_random_uuid(), tests.id('batch2')) $q$), 'licence.expired', 'the planned batch cannot go on without a valid licence');
select tests.logout();

-- ── RLS: the other company sees nothing ──
select tests.login(tests.k('plastics_user'));
select is((select count(*)::int from api.batches), 0, 'a company B user sees no company A batches');
select is((select count(*)::int from prod.material_consumption), 0, 'nor its consumption');
select tests.logout();

select * from finish();

-- Tally mapping tables (Stage 1): suggestions by base type / name, the without-GST voucher types on the CA review list (never bulk-confirmed),
-- godown / unit / currency / item suggestions, Admin-only confirm, bulk confirm for exact matches, idempotent replay, Bug fixer items, RLS.
-- Synthetic data only; everything is rolled back.
select plan(34);

create temp table s as select tests.seed4(tests.seed3(tests.seed2(tests.seed()))) as v;
grant select on s to authenticated;
create or replace function tests.k(p text) returns uuid language sql stable as $$ select (v ->> p)::uuid from s $$;
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
create temp table ids (k text primary key, v jsonb);
grant select, insert on ids to authenticated;
create or replace function tests.r(p text) returns jsonb language sql stable as $$ select v from ids where k = p $$;

select has_table('ops', 'tally_voucher_type_map', 'voucher type map exists');
select has_table('ops', 'tally_godown_map', 'godown map exists');
select has_table('ops', 'tally_unit_map', 'unit map exists');
select has_table('ops', 'tally_currency_map', 'currency map exists');
select ok(not exists (select 1 from pg_tables where schemaname in ('ops', 'acct', 'master') and tablename in ('tally_voucher_type_map', 'tally_godown_map', 'tally_unit_map', 'tally_currency_map',
  'tally_item_map', 'tally_group_suggest', 'cost_categories', 'cost_centres', 'item_categories') and not rowsecurity), 'row-level security is on for every new mapping and master table');

-- ── stage masters through the normal engine ──
select tests.login(tests.k('admin'));
insert into ids select 'b1', api.import_create_batch(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'source', 'tally_xml', 'kind', 'masters', 'file_name', 'masters.xml'));
select api.import_stage_rows((tests.r('b1') ->> 'id')::uuid, jsonb_build_array(
  jsonb_build_object('object_type', 'voucher_type', 'name', 'Sales', 'guid', 'vt-1', 'payload', jsonb_build_object('parent', '', 'affects_stock', true)),
  jsonb_build_object('object_type', 'voucher_type', 'name', 'Test Local Sales', 'guid', 'vt-2', 'payload', jsonb_build_object('parent', 'Sales')),
  jsonb_build_object('object_type', 'voucher_type', 'name', 'TEST SALES WO', 'guid', 'vt-3', 'payload', jsonb_build_object('parent', 'Sales')),
  jsonb_build_object('object_type', 'voucher_type', 'name', 'Test Sales Non GST', 'guid', 'vt-4', 'payload', jsonb_build_object('parent', 'Sales')),
  jsonb_build_object('object_type', 'voucher_type', 'name', 'Receipt', 'guid', 'vt-5', 'payload', jsonb_build_object('parent', '')),
  jsonb_build_object('object_type', 'voucher_type', 'name', 'Test Transfer', 'guid', 'vt-6', 'payload', jsonb_build_object('parent', 'Stock Journal', 'optional', true)),
  jsonb_build_object('object_type', 'voucher_type', 'name', 'Test Odd Type', 'guid', 'vt-7', 'payload', jsonb_build_object('parent', '')),
  jsonb_build_object('object_type', 'godown', 'name', 'Test Stores', 'guid', 'gd-1', 'payload', jsonb_build_object('parent', '')),
  jsonb_build_object('object_type', 'godown', 'name', 'Test Shop Stok', 'guid', 'gd-2', 'payload', jsonb_build_object('parent', '')),
  jsonb_build_object('object_type', 'godown', 'name', 'Zzz Elsewhere', 'guid', 'gd-3', 'payload', jsonb_build_object('has_no_space', true)),
  jsonb_build_object('object_type', 'unit', 'name', 'Nos', 'payload', jsonb_build_object('simple', 'Yes')),
  jsonb_build_object('object_type', 'unit', 'name', 'Ltrs', 'payload', jsonb_build_object('simple', 'Yes')),
  jsonb_build_object('object_type', 'unit', 'name', 'Test Odd Unit', 'payload', jsonb_build_object('simple', 'Yes')),
  jsonb_build_object('object_type', 'currency', 'name', '₹', 'payload', jsonb_build_object('original_symbol', 'INR', 'decimals', 2)),
  jsonb_build_object('object_type', 'cost_category', 'name', 'Test Category', 'guid', 'cc-1', 'payload', jsonb_build_object('revenue', true, 'non_revenue', false)),
  jsonb_build_object('object_type', 'cost_centre', 'name', 'Test Centre', 'guid', 'cc-2', 'payload', jsonb_build_object('category', 'Test Category', 'parent', 'Primary')),
  jsonb_build_object('object_type', 'cost_centre', 'name', 'Test Sub Centre', 'guid', 'cc-3', 'payload', jsonb_build_object('category', 'Test Category', 'parent', 'Test Centre')),
  jsonb_build_object('object_type', 'stock_category', 'name', 'Test Item Category', 'guid', 'sc-1', 'payload', jsonb_build_object('parent', '')),
  jsonb_build_object('object_type', 'stock_item', 'name', 'Test Item No HSN', 'guid', 'si-1', 'payload', jsonb_build_object('unit', 'Nos')),
  jsonb_build_object('object_type', 'stock_item', 'name', 'Test Item Odd Unit', 'guid', 'si-2', 'payload', jsonb_build_object('unit', 'Zorp', 'hsn', '340111')),
  jsonb_build_object('object_type', 'stock_item', 'name', 'Test Item Good', 'guid', 'si-3', 'payload', jsonb_build_object('unit', 'Kgs', 'hsn', '340111', 'batch_wise', true, 'perishable', true, 'category', 'Test Item Category'))));
select api.import_process(gen_random_uuid(), (tests.r('b1') ->> 'id')::uuid);
select tests.logout();

-- voucher types
select is((select base_type from ops.tally_voucher_type_map where company_id = tests.k('company_a') and tally_type = 'Test Local Sales'), 'Sales', 'a user-defined sales type keeps its Parent as base type');
select is((select erp_doc_type from ops.tally_voucher_type_map where company_id = tests.k('company_a') and tally_type = 'Test Local Sales'), 'sales_invoice', 'and inherits the sales document type');
select is((select exact from ops.tally_voucher_type_map where company_id = tests.k('company_a') and tally_type = 'Sales'), true, 'the Tally base type itself is an exact match');
select is((select exact from ops.tally_voucher_type_map where company_id = tests.k('company_a') and tally_type = 'Test Local Sales'), false, 'a user-defined type is not an exact match');
select is((select tax_class || '/' || ca_review::text from ops.tally_voucher_type_map where company_id = tests.k('company_a') and tally_type = 'TEST SALES WO'), 'without_gst/true', 'a "... WO" type is without_gst and on the CA review list');
select is((select tax_class || '/' || ca_review::text from ops.tally_voucher_type_map where company_id = tests.k('company_a') and tally_type = 'Test Sales Non GST'), 'without_gst/true', 'a "... Non GST" type is without_gst and on the CA review list');
select is((select count(*)::int from ops.tally_voucher_type_map where company_id = tests.k('company_a') and status = 'confirmed'), 0, 'nothing is confirmed by the engine');
select is((select erp_doc_type from ops.tally_voucher_type_map where company_id = tests.k('company_a') and tally_type = 'Test Transfer'), 'stock_journal', 'a stock journal type maps to the stock journal document');
select is((select erp_doc_type is null from ops.tally_voucher_type_map where company_id = tests.k('company_a') and tally_type = 'Test Odd Type'), true, 'a type with no recognisable base has no target');
select ok(exists (select 1 from ops.bug_items where company_id = tests.k('company_a') and kind = 'map_voucher_type' and evidence ->> 'name' = 'TEST SALES WO' and who_fixes = 'ca' and tax_class = 'without_gst'),
  'the without-GST type opens a Bug fixer item for the CA');

-- godowns, units, currency
select is((select place_id from ops.tally_godown_map where company_id = tests.k('company_a') and tally_godown = 'Test Stores'), tests.k('stores'), 'a godown named like an ERP place is suggested to it');
select is((select exact from ops.tally_godown_map where company_id = tests.k('company_a') and tally_godown = 'Test Stores'), true, 'and it is an exact match');
select is((select place_id is not null and not exact from ops.tally_godown_map where company_id = tests.k('company_a') and tally_godown = 'Test Shop Stok'), true, 'a similar name is suggested but not exact');
select is((select uom_code || '/' || exact::text from ops.tally_unit_map where company_id = tests.k('company_a') and tally_unit = 'Ltrs'), 'LTR/true', 'Ltrs maps to litres');
select ok(exists (select 1 from ops.bug_items where company_id = tests.k('company_a') and kind = 'map_unit' and evidence ->> 'name' = 'Test Odd Unit'), 'an unknown unit opens "Map this unit"');
select is((select iso_code from ops.tally_currency_map where company_id = tests.k('company_a') and tally_symbol = '₹'), 'INR', 'the rupee symbol maps to INR');

-- cost centres and stock masters
select is((select count(*)::int from acct.cost_centres c join acct.cost_categories k on k.id = c.category_id where c.company_id = tests.k('company_a') and k.name = 'Test Category'), 2, 'cost centres load under their category');
select is((select p.name from acct.cost_centres c join acct.cost_centres p on p.id = c.parent_id where c.name = 'Test Sub Centre'), 'Test Centre', 'the cost centre hierarchy is kept');
select is((select count(*)::int from master.products where name like 'Test Item No HSN%' or name like 'Test Item Odd Unit%'), 0, 'items without an HSN or with an unknown unit are not created');
select ok(exists (select 1 from ops.bug_items where company_id = tests.k('company_a') and kind = 'missing_hsn' and evidence ->> 'name' = 'Test Item No HSN'), 'the missing HSN goes to the Bug fixer');
select is((select batch_tracked::text || '/' || expiry_tracked::text from master.products where name = 'Test Item Good'), 'true/true', 'an item with HSN and unit is created with its batch and expiry flags');

-- confirm: rights, CA review, bulk
select tests.login(tests.k('acct'));
select is(tests.rule($$ select api.confirm_tally_map(gen_random_uuid(), (select (v ->> 'company_a')::uuid from s), 'voucher_type', 'Sales') $$), 'rights.missing', 'a non-Admin cannot confirm a mapping');
select tests.logout();
select tests.login(tests.k('admin'));
select is(tests.rule($$ select api.confirm_tally_map(gen_random_uuid(), (select (v ->> 'company_a')::uuid from s), 'voucher_type', 'TEST SALES WO') $$), 'map.ca_review', 'a CA-review type needs the acknowledgement');
select is(api.confirm_tally_map(gen_random_uuid(), tests.k('company_a'), 'voucher_type', 'TEST SALES WO', '{}', true) ->> 'ok', 'true', 'with the acknowledgement Admin confirms it one by one');
insert into ids select 'bulk', api.confirm_tally_maps_bulk(gen_random_uuid(), tests.k('company_a'), 'voucher_type');
select is((select (v ->> 'confirmed')::int from ids where k = 'bulk'), 2, 'bulk confirm takes the exact matches only (Sales, Receipt)');
select is((select status from ops.tally_voucher_type_map where company_id = tests.k('company_a') and tally_type = 'Test Sales Non GST'), 'suggested', 'a CA-review type is never bulk-confirmed');
select is((select status from ops.tally_voucher_type_map where company_id = tests.k('company_a') and tally_type = 'Test Local Sales'), 'suggested', 'nor a user-defined type');
select is(tests.rule($$ select api.confirm_tally_map(gen_random_uuid(), (select (v ->> 'company_b')::uuid from s), 'godown', 'X', jsonb_build_object('place_id', (select (v ->> 'stores')::uuid from s))) $$), 'org.company_missing', 'a place of another company is refused');
insert into ids select 'crid', to_jsonb(gen_random_uuid()::text);
select api.confirm_tally_map((tests.r('crid') #>> '{}')::uuid, tests.k('company_a'), 'godown', 'Test Stores');
select is(api.confirm_tally_map((tests.r('crid') #>> '{}')::uuid, tests.k('company_a'), 'godown', 'Test Stores') ->> 'ok', 'true', 'the same request id replays');
select tests.logout();

select * from finish();

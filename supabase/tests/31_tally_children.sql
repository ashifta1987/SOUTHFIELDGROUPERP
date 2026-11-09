-- Voucher child lists (Stage 1): staging of ledger lines, inventory, batches, bills, cost centres and bank allocations; header fields; write-once rows;
-- Admin-only staging and reading; repeat loads change nothing; the Excel one-leg upgrade keeps working and its children attach to the upgraded voucher;
-- the gaps view. Synthetic data only; everything is rolled back.
select plan(29);

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

create or replace function tests.children() returns jsonb language sql immutable as $$
  select jsonb_build_array(
    jsonb_build_object('guid', 'ch-guid-1', 'alter_id', 5,
      'header', jsonb_build_object('reference', 'PO-1', 'reference_date', '2021-03-30', 'persisted_view', 'Invoice Voucher View', 'is_invoice', true, 'place_of_supply', 'Kerala',
                                   'party_gstin', '32AAAAA1111A1Z5', 'voucher_key', 'vk1', 'row_hash', 'abc123', 'narration', 'Test narration'),
      'lines', jsonb_build_array(
        jsonb_build_object('no', 1, 'list', 'ALLLEDGERENTRIES', 'ledger', 'Test Cust X', 'amount', -100, 'amount_text', '-100.00', 'deemed_positive', true, 'party', true, 'flags', jsonb_build_array()),
        jsonb_build_object('no', 2, 'list', 'ACCOUNTINGALLOCATIONS', 'inv_no', 1, 'ledger', 'Test Sales Ledger', 'amount', 100, 'deemed_positive', false, 'flags', jsonb_build_array('sign_mismatch'))),
      'inventory', jsonb_build_array(
        jsonb_build_object('no', 1, 'list_kind', 'entries', 'item', 'Test Item Unmapped', 'actual_qty', 10, 'actual_unit', 'Nos', 'actual_qty_text', '10 Nos', 'billed_qty', 10, 'billed_unit', 'Nos',
                           'rate', 10, 'rate_unit', 'Nos', 'discount_pct', 0, 'amount', 100, 'deemed_positive', false, 'hsn', '34011190', 'flags', jsonb_build_array())),
      'batches', jsonb_build_array(
        jsonb_build_object('no', 1, 'inv_no', 1, 'godown', 'Test Godown Unmapped', 'batch', 'B-1', 'actual_qty', 10, 'actual_unit', 'Nos', 'amount', 100, 'mfd_text', '20210301', 'mfd_on', '2021-03-01',
                           'expiry_text', '12 Months', 'order_no', 'SO-1', 'tracking_no', 'DN-1')),
      'bills', jsonb_build_array(
        jsonb_build_object('no', 1, 'line_no', 1, 'name', 'INV-1', 'bill_type', 'New Ref', 'amount', -100, 'credit_period_text', '30 Days', 'credit_days', 30),
        jsonb_build_object('no', 2, 'line_no', 1, 'name', 'WEIRD', 'bill_type', 'Something Else', 'amount', 0)),
      'costcentres', jsonb_build_array(jsonb_build_object('no', 1, 'line_no', 2, 'category', 'Primary Cost Category', 'centre', 'Test Unit', 'amount', 100, 'deemed_positive', false)),
      'banks', jsonb_build_array(jsonb_build_object('no', 1, 'line_no', 1, 'date', '2021-04-01', 'instrument_date', '2021-04-02', 'instrument_number', '000111', 'transaction_type', 'Cheque', 'favouring', 'Test Payee', 'bankers_date', '2021-04-05', 'amount', 100))),
    jsonb_build_object('guid', 'no-such-guid', 'lines', jsonb_build_array(jsonb_build_object('no', 1, 'list', 'LEDGERENTRIES', 'ledger', 'Z', 'amount', 0))))
$$;
grant execute on function tests.children() to authenticated;

select tests.login(tests.k('admin'));
-- Excel one-leg history first, then the XML voucher that replaces it in place
insert into ids select 'ex', api.import_create_batch(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'source', 'excel', 'kind', 'vouchers', 'file_name', 'daybook.xlsx'));
select api.import_stage_rows((tests.r('ex') ->> 'id')::uuid, jsonb_build_array(
  jsonb_build_object('object_type', 'voucher', 'name', 'S-1', 'payload', jsonb_build_object('type', 'Test Sales Type', 'number', 'S-1', 'date', '2021-04-01', 'party', 'Test Cust X', 'amount', 100, 'dc', 'dr', 'match_key', 'k|S-1|dr')),
  jsonb_build_object('object_type', 'voucher', 'name', 'S-1', 'payload', jsonb_build_object('type', 'Test Sales Type', 'number', 'S-1', 'date', '2021-04-01', 'party', 'Test Sales Ledger', 'amount', 100, 'dc', 'cr', 'match_key', 'k|S-1|cr'))));
select api.import_process(gen_random_uuid(), (tests.r('ex') ->> 'id')::uuid);
insert into ids select 'xm', api.import_create_batch(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'source', 'tally_xml', 'kind', 'vouchers', 'file_name', 'daybook.xml'));
select api.import_stage_rows((tests.r('xm') ->> 'id')::uuid, jsonb_build_array(
  jsonb_build_object('object_type', 'voucher', 'name', 'S-1', 'guid', 'ch-guid-1', 'alter_id', 5, 'payload', jsonb_build_object('type', 'Test Sales Type', 'number', 'S-1', 'date', '2021-04-01', 'party', 'Test Cust X', 'amount', 100,
    'reference', 'PO-1', 'place_of_supply', 'Kerala', 'row_hash', 'abc123',
    'lines', jsonb_build_array(jsonb_build_object('ledger', 'Test Cust X', 'amount', -100), jsonb_build_object('ledger', 'Test Sales Ledger', 'amount', 100))))));
select api.import_process(gen_random_uuid(), (tests.r('xm') ->> 'id')::uuid);
select tests.logout();

select is((select count(*)::int from ops.tally_vouchers where company_id = tests.k('company_a') and voucher_no = 'S-1' and state = 'loaded'), 1, 'the Excel legs were upgraded into one voucher');
select is((select reference from ops.tally_vouchers where guid = 'ch-guid-1'), 'PO-1', 'the header fields of the XML voucher are kept on the upgraded voucher');

-- stage the children
select tests.login(tests.k('acct'));
select is(tests.rule($$ select api.import_stage_voucher_children(gen_random_uuid(), (select (v ->> 'id')::uuid from ids where k = 'xm'), tests.children()) $$), 'rights.missing', 'a non-Admin cannot stage voucher lines');
select tests.logout();
select tests.login(tests.k('admin'));
insert into ids select 'c1', api.import_stage_voucher_children(gen_random_uuid(), (tests.r('xm') ->> 'id')::uuid, tests.children());
select is((tests.r('c1') ->> 'vouchers')::int, 1, 'one voucher got its children');
select is((tests.r('c1') ->> 'unlinked')::int, 1, 'a voucher that is not loaded is counted as unlinked, not stored');
select is((tests.r('c1') ->> 'lines')::int || '/' || (tests.r('c1') ->> 'inventory') || '/' || (tests.r('c1') ->> 'batches') || '/' || (tests.r('c1') ->> 'bills') || '/' || (tests.r('c1') ->> 'costcentres') || '/' || (tests.r('c1') ->> 'banks'),
  '2/1/1/2/1/1', 'every child list was staged');
select is((select flagged from (select count(*)::int as flagged from ops.tally_voucher_lines where cardinality(flags) > 0) x), 1, 'a flagged line keeps its flag');
select is((tests.r('c1') ->> 'flagged_lines')::int, 1, 'and the RPC reports it');

select is((select place_of_supply || '|' || party_gstin || '|' || voucher_key || '|' || reference_date::text || '|' || persisted_view || '|' || is_invoice::text from ops.tally_vouchers where guid = 'ch-guid-1'),
  'Kerala|32AAAAA1111A1Z5|vk1|2021-03-30|Invoice Voucher View|true', 'header fields are filled where empty');
select is((select narration from ops.tally_vouchers where guid = 'ch-guid-1'), 'Test narration', 'the narration is kept');
select is((select reference from ops.tally_vouchers where guid = 'ch-guid-1'), 'PO-1', 'a value already there is not overwritten');
select is((select children_batch_id from ops.tally_vouchers where guid = 'ch-guid-1'), (tests.r('xm') ->> 'id')::uuid, 'the voucher remembers which batch its children came from');
select is((select count(*)::int from ops.tally_voucher_lines l join ops.tally_vouchers v on v.id = l.voucher_id where v.guid = 'ch-guid-1' and v.upgraded_from is not null), 2, 'children attach to the upgraded voucher');
select is((select bill_type from ops.tally_voucher_bills where bill_name = 'WEIRD'), 'Other', 'an unknown bill type is kept as Other');
select is((select mfd_on::text || '|' || expiry_text from ops.tally_voucher_batches), '2021-03-01|12 Months', 'batch manufacturing date and expiry period are kept');
select is((select instrument_number || '|' || bankers_date::text from ops.tally_voucher_banks), '000111|2021-04-05', 'bank allocation fields are kept');

-- repeat: nothing is added
insert into ids select 'c2', api.import_stage_voucher_children(gen_random_uuid(), (tests.r('xm') ->> 'id')::uuid, tests.children());
select is((tests.r('c2') ->> 'skipped')::int, 1, 'staging the same children again skips the voucher');
select is((select count(*)::int from ops.tally_voucher_lines), 2, 'and adds no row');
-- same request id replays
insert into ids select 'crid', to_jsonb(gen_random_uuid()::text);
select api.import_stage_voucher_children((tests.r('crid') #>> '{}')::uuid, (tests.r('xm') ->> 'id')::uuid, '[]');
select is((api.import_stage_voucher_children((tests.r('crid') #>> '{}')::uuid, (tests.r('xm') ->> 'id')::uuid, '[]') ->> 'vouchers')::int, 0, 'the same request id replays');
select tests.logout();

-- write once
select throws_ok($$ update ops.tally_voucher_lines set amount = 1 where line_no = 1 $$, '42501', null, 'a staged line cannot be updated, even by the owner');
select throws_ok($$ delete from ops.tally_voucher_inventory $$, '42501', null, 'a staged line cannot be deleted while its voucher exists');

-- visibility: Admin only
select tests.login(tests.k('acct'));
select is((select count(*)::int from ops.tally_voucher_lines), 0, 'a non-Admin sees no staged lines');
select is((select count(*)::int from ops.tally_voucher_banks), 0, 'nor bank allocations');
select tests.logout();
select tests.login(tests.k('admin'));
select is((select count(*)::int from ops.tally_voucher_lines), 2, 'Admin sees them');

-- gaps: names used by staged vouchers that are not confirmed
select ok(exists (select 1 from api.tally_map_gaps where company_id = tests.k('company_a') and kind = 'voucher_type' and name = 'Test Sales Type' and used_count = 1), 'the gaps view lists the unmapped voucher type with its count');
select ok(exists (select 1 from api.tally_map_gaps where company_id = tests.k('company_a') and kind = 'godown' and name = 'Test Godown Unmapped'), 'and the unmapped godown');
select ok(exists (select 1 from api.tally_map_gaps where company_id = tests.k('company_a') and kind = 'item' and name = 'Test Item Unmapped'), 'and the unmapped item');
select ok(exists (select 1 from api.tally_map_gaps where company_id = tests.k('company_a') and kind = 'unit' and name = 'Nos') , 'and the unit');
select api.suggest_tally_maps(gen_random_uuid(), tests.k('company_a'));
select api.confirm_tally_map(gen_random_uuid(), tests.k('company_a'), 'voucher_type', 'Test Sales Type');
select is((select count(*)::int from api.tally_map_gaps where company_id = tests.k('company_a') and kind = 'voucher_type'), 0, 'a confirmed voucher type leaves the gaps view');
select tests.logout();

select * from finish();

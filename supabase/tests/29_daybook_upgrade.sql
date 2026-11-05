-- Day Book XML (full entries) after the Excel Day Book (one leg per voucher): the matching Excel voucher is upgraded in place
-- (type | number | date), its other legs are marked reversed and linked, nothing is counted twice, a repeat load changes nothing.
-- Synthetic data only; everything is rolled back.
select plan(15);

create temp table s as select tests.seed4(tests.seed3(tests.seed2(tests.seed()))) as v;
grant select on s to authenticated;
create or replace function tests.k(p text) returns uuid language sql stable as $$ select (v ->> p)::uuid from s $$;
grant execute on all functions in schema tests to authenticated;
create temp table ids (k text primary key, v jsonb);
grant select, insert on ids to authenticated;
create or replace function tests.r(p text) returns jsonb language sql stable as $$ select v from ids where k = p $$;

create or replace function tests.xml_rows() returns jsonb language sql immutable as $$
  select jsonb_build_array(
    jsonb_build_object('object_type', 'voucher', 'name', 'S-1', 'guid', 'xml-guid-1', 'alter_id', 5, 'payload', jsonb_build_object('type', 'Sales', 'number', 'S-1', 'date', '2021-04-01', 'party', 'Test Cust X', 'amount', 100,
      'lines', jsonb_build_array(jsonb_build_object('ledger', 'Test Cust X', 'amount', -100), jsonb_build_object('ledger', 'Test Sales Ledger', 'amount', 100)))),
    jsonb_build_object('object_type', 'voucher', 'name', 'N-1', 'guid', 'xml-guid-2', 'alter_id', 6, 'payload', jsonb_build_object('type', 'Journal', 'number', 'N-1', 'date', '2021-04-03', 'party', 'Test Cust X', 'amount', 10,
      'lines', jsonb_build_array(jsonb_build_object('ledger', 'Test Cust X', 'amount', -10), jsonb_build_object('ledger', 'Test Sales Ledger', 'amount', 10)))))
$$;
grant execute on function tests.xml_rows() to authenticated;

select tests.login(tests.k('admin'));
-- Excel history: voucher S-1 has two legs (debit and credit), R-2 one leg
insert into ids select 'ex1', api.import_create_batch(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'source', 'excel', 'kind', 'vouchers', 'file_name', 'daybook.xlsx'));
select api.import_stage_rows((tests.r('ex1') ->> 'id')::uuid, jsonb_build_array(
  jsonb_build_object('object_type', 'voucher', 'name', 'S-1', 'payload', jsonb_build_object('type', 'Sales', 'number', 'S-1', 'date', '2021-04-01', 'party', 'Test Cust X', 'amount', 100, 'dc', 'dr', 'match_key', 'Sales|S-1|2021-04-01|100.00|Test Cust X|dr')),
  jsonb_build_object('object_type', 'voucher', 'name', 'S-1', 'payload', jsonb_build_object('type', 'Sales', 'number', 'S-1', 'date', '2021-04-01', 'party', 'Test Sales Ledger', 'amount', 100, 'dc', 'cr', 'match_key', 'Sales|S-1|2021-04-01|100.00|Test Sales Ledger|cr')),
  jsonb_build_object('object_type', 'voucher', 'name', 'R-2', 'payload', jsonb_build_object('type', 'Receipt', 'number', 'R-2', 'date', '2021-04-02', 'party', 'Test Cust X', 'amount', 40, 'dc', 'cr', 'match_key', 'Receipt|R-2|2021-04-02|40.00|Test Cust X|cr'))));
select api.import_process(gen_random_uuid(), (tests.r('ex1') ->> 'id')::uuid);

-- XML: S-1 with its full lines (matches the Excel legs), N-1 new
insert into ids select 'xm1', api.import_create_batch(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'source', 'tally_xml', 'kind', 'vouchers', 'file_name', 'daybook.xml'));
select api.import_stage_rows((tests.r('xm1') ->> 'id')::uuid, tests.xml_rows());
select api.import_process(gen_random_uuid(), (tests.r('xm1') ->> 'id')::uuid);
select tests.logout();

select is((select count(*)::int from ops.tally_vouchers where company_id = tests.k('company_a') and voucher_no = 'S-1' and state = 'loaded'), 1, 'voucher S-1 is counted once after the upgrade');
select is((select count(*)::int from ops.tally_vouchers where company_id = tests.k('company_a') and voucher_no = 'S-1' and state = 'reversed' and upgraded_into is not null), 1, 'the other Excel leg is marked reversed and linked');
select is((select jsonb_array_length(lines) from ops.tally_vouchers where company_id = tests.k('company_a') and voucher_no = 'S-1' and state = 'loaded'), 2, 'the kept voucher now has its full lines');
select is((select guid from ops.tally_vouchers where company_id = tests.k('company_a') and voucher_no = 'S-1' and state = 'loaded'), 'xml-guid-1', 'and the XML guid');
select is((select (upgraded_from ->> 'legs')::int from ops.tally_vouchers where company_id = tests.k('company_a') and voucher_no = 'S-1' and state = 'loaded'), 2, 'it remembers how many Excel legs it replaced');
select is((select upgraded_into from ops.tally_vouchers where company_id = tests.k('company_a') and voucher_no = 'S-1' and state = 'reversed'), (select id from ops.tally_vouchers where company_id = tests.k('company_a') and voucher_no = 'S-1' and state = 'loaded'), 'the reversed leg points at the kept voucher');
select is((select result from ops.import_rows where batch_id = (tests.r('xm1') ->> 'id')::uuid and guid = 'xml-guid-1'), 'linked', 'the upgraded row is reported as linked');
select is((select result from ops.import_rows where batch_id = (tests.r('xm1') ->> 'id')::uuid and guid = 'xml-guid-2'), 'created', 'a voucher with no Excel match is created');
select is((select count(*)::int from ops.tally_vouchers where company_id = tests.k('company_a') and voucher_no = 'R-2' and state = 'loaded'), 1, 'an Excel voucher the XML does not have is left alone');

-- Same XML again, then the Excel again: nothing changes, nothing comes back
create temp table before_counts as select count(*)::int total, count(*) filter (where state = 'loaded')::int loaded from ops.tally_vouchers where company_id = tests.k('company_a');
grant select on before_counts to authenticated;
select tests.login(tests.k('admin'));
insert into ids select 'xm2', api.import_create_batch(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'source', 'tally_xml', 'kind', 'vouchers', 'file_name', 'daybook2.xml'));
select api.import_stage_rows((tests.r('xm2') ->> 'id')::uuid, tests.xml_rows());
select api.import_process(gen_random_uuid(), (tests.r('xm2') ->> 'id')::uuid);
select is((select count(*)::int from ops.import_rows where batch_id = (tests.r('xm2') ->> 'id')::uuid and result = 'skipped'), 2, 'the same XML again is skipped');
insert into ids select 'ex2', api.import_create_batch(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'source', 'excel', 'kind', 'vouchers', 'file_name', 'daybook-again.xlsx'));
select api.import_stage_rows((tests.r('ex2') ->> 'id')::uuid, (select jsonb_agg(jsonb_build_object('object_type', 'voucher', 'name', r.name, 'payload', r.payload)) from ops.import_rows r where r.batch_id = (tests.r('ex1') ->> 'id')::uuid));
select api.import_process(gen_random_uuid(), (tests.r('ex2') ->> 'id')::uuid);
select tests.logout();
select is((select count(*)::int from ops.tally_vouchers where company_id = tests.k('company_a')), (select total from before_counts), 'loading the Excel again creates no voucher');
select is((select count(*)::int from ops.tally_vouchers where company_id = tests.k('company_a') and state = 'loaded'), (select loaded from before_counts), 'and brings no reversed leg back');
select is((select count(*)::int from ops.tally_vouchers where company_id = tests.k('company_a') and voucher_no = 'S-1' and state = 'loaded'), 1, 'S-1 is still counted once');
select is((select count(*)::int from acct.vouchers where company_id = tests.k('company_a')), 0, 'nothing was posted');
select is((select count(*)::int from ops.import_rows where batch_id = (tests.r('ex2') ->> 'id')::uuid and result = 'skipped'), 3, 'all three repeated Excel legs are skipped');

select * from finish();

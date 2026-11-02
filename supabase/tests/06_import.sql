-- Tally import (§25A tests, synthetic data only): same file twice creates nothing new; a rename under the same GUID
-- gives an alias and a review item; one person across both companies; near-duplicate names give a Bug fixer item and
-- no new party; an unmapped group gives "Map this head"; a voucher changed after loading gives "Changed in Tally" and
-- the loaded entry is untouched; opening bills are hidden from the GST view until classified.
select plan(15);

create temp table s as select tests.seed2(tests.seed()) as v;
grant select on s to authenticated;

create temp table rows1 as select jsonb_build_array(
  jsonb_build_object('object_type', 'group', 'name', 'Sundry Debtors', 'payload', '{}'::jsonb),
  jsonb_build_object('object_type', 'ledger', 'name', 'Test Traders Pvt Ltd', 'guid', 'g-led-1', 'alter_id', 10,
     'payload', jsonb_build_object('parent', 'Sundry Debtors', 'opening', -1500, 'bills', jsonb_build_array(jsonb_build_object('ref', 'TB-1', 'date', '2026-03-01', 'amount', -1500)))),
  jsonb_build_object('object_type', 'ledger', 'name', 'Unmapped Head Ledger', 'guid', 'g-led-2', 'alter_id', 3, 'payload', jsonb_build_object('parent', 'Test Strange Group', 'opening', 0)),
  jsonb_build_object('object_type', 'employee', 'name', 'Test Worker One', 'guid', 'g-emp-1', 'payload', jsonb_build_object('code', 'E01', 'pan', 'WWWWW1111W')),
  jsonb_build_object('object_type', 'voucher', 'guid', 'g-v-1', 'alter_id', 5,
     'payload', jsonb_build_object('type', 'Sales', 'number', 'T/1', 'date', '2026-04-10', 'party', 'Test Traders Pvt Ltd', 'amount', 1000,
                                   'lines', jsonb_build_array(jsonb_build_object('ledger', 'Test Traders Pvt Ltd', 'amount', -1000), jsonb_build_object('ledger', 'Sales', 'amount', 1000))))
) as r;
grant select on rows1 to authenticated;

select tests.login((select (v ->> 'admin')::uuid from s));
create temp table b1 as select api.import_create_batch(gen_random_uuid(), jsonb_build_object('company_id', (select v ->> 'company_a' from s), 'source', 'tally_xml', 'as_of', '2026-03-31')) as res;
select api.import_stage_rows((select (res ->> 'id')::uuid from b1), (select r from rows1));
select api.import_process(gen_random_uuid(), (select (res ->> 'id')::uuid from b1));
select tests.logout();

select is((select count(*)::int from master.parties where legal_name = 'Test Traders Pvt Ltd'), 1, 'the debtor ledger created one party');
select is((select count(*)::int from acct.accounts where name = 'Test Traders Pvt Ltd'), 1, 'and one account');
select ok(exists (select 1 from ops.bug_items where kind = 'map_head' and evidence ->> 'tally_group' = 'Test Strange Group'), 'an unmapped group gives a "Map this head" item');
select is((select count(*)::int from acct.accounts where name = 'Unmapped Head Ledger'), 0, 'and its ledger is not created');
select is((select tax_class from acct.open_bills where bill_ref = 'TB-1'), 'unclassified', 'opening bills load unclassified');

-- Same file again: nothing new
create temp table counts_before as select (select count(*) from master.parties) p, (select count(*) from acct.accounts) a, (select count(*) from ops.tally_vouchers) v, (select count(*) from master.people) e;
grant select on counts_before to authenticated;
select tests.login((select (v ->> 'admin')::uuid from s));
create temp table b2 as select api.import_create_batch(gen_random_uuid(), jsonb_build_object('company_id', (select v ->> 'company_a' from s), 'source', 'tally_xml', 'as_of', '2026-03-31')) as res;
select api.import_stage_rows((select (res ->> 'id')::uuid from b2), (select r from rows1));
select api.import_process(gen_random_uuid(), (select (res ->> 'id')::uuid from b2));
select tests.logout();
select ok((select (select count(*) from master.parties) = p and (select count(*) from acct.accounts) = a and (select count(*) from ops.tally_vouchers) = v and (select count(*) from master.people) = e from counts_before),
  'loading the same file twice creates zero new records');
select ok((select count(*) from ops.import_rows where batch_id = (select (res ->> 'id')::uuid from b2) and result = 'skipped') >= 3, 'the repeats are counted as skipped');

-- Rename under the same GUID (higher ALTERID) + voucher changed after loading + near-duplicate party + employee in company B
select tests.login((select (v ->> 'admin')::uuid from s));
create temp table b3 as select api.import_create_batch(gen_random_uuid(), jsonb_build_object('company_id', (select v ->> 'company_a' from s), 'source', 'tally_xml', 'as_of', '2026-03-31')) as res;
select api.import_stage_rows((select (res ->> 'id')::uuid from b3), jsonb_build_array(
  jsonb_build_object('object_type', 'ledger', 'name', 'Test Traders (Kochi) Pvt Ltd', 'guid', 'g-led-1', 'alter_id', 11, 'payload', jsonb_build_object('parent', 'Sundry Debtors', 'opening', -1500)),
  jsonb_build_object('object_type', 'ledger', 'name', 'Test Tradrs Pvt Ltd', 'guid', 'g-led-9', 'alter_id', 1, 'payload', jsonb_build_object('parent', 'Sundry Debtors', 'opening', 0)),
  jsonb_build_object('object_type', 'voucher', 'guid', 'g-v-1', 'alter_id', 6,
     'payload', jsonb_build_object('type', 'Sales', 'number', 'T/1', 'date', '2026-04-10', 'party', 'Test Traders Pvt Ltd', 'amount', 1200,
                                   'lines', jsonb_build_array(jsonb_build_object('ledger', 'Test Traders Pvt Ltd', 'amount', -1200), jsonb_build_object('ledger', 'Sales', 'amount', 1200))))));
select api.import_process(gen_random_uuid(), (select (res ->> 'id')::uuid from b3));
create temp table b4 as select api.import_create_batch(gen_random_uuid(), jsonb_build_object('company_id', (select v ->> 'company_b' from s), 'source', 'tally_xml')) as res;
select api.import_stage_rows((select (res ->> 'id')::uuid from b4), jsonb_build_array(
  jsonb_build_object('object_type', 'employee', 'name', 'TEST WORKER ONE', 'guid', 'g-emp-b1', 'payload', jsonb_build_object('code', 'P07', 'pan', 'WWWWW1111W'))));
select api.import_process(gen_random_uuid(), (select (res ->> 'id')::uuid from b4));
select tests.logout();

select ok(exists (select 1 from master.party_aliases where alias = 'Test Traders (Kochi) Pvt Ltd'), 'a renamed ledger with the same GUID gives an alias');
select ok(exists (select 1 from ops.bug_items where kind = 'changed_in_tally' and ref_table = 'acct.accounts'), 'and a review item');
select ok(exists (select 1 from ops.bug_items where kind = 'possible_duplicate' and title like '%Test Tradrs%'), 'a near-duplicate name gives a Bug fixer item');
select is((select count(*)::int from master.parties where legal_name = 'Test Tradrs Pvt Ltd'), 0, 'and no new party');
select ok(exists (select 1 from ops.bug_items where kind = 'changed_in_tally' and ref_table = 'ops.tally_vouchers'), 'a voucher changed after loading gives a "Changed in Tally" item');
select is((select amount from ops.tally_vouchers where guid = 'g-v-1'), 1000.00::numeric(18,2), 'the loaded entry is untouched');
select is((select count(*)::int from master.people where pan = 'WWWWW1111W'), 1, 'the same employee in both companies is one person');

-- Opening bills: hidden from the accountant until Admin classifies them
select tests.login((select (v ->> 'acct')::uuid from s));
select is((select count(*)::int from acct.open_bills), 0, 'the GST view does not see unclassified opening bills');
select tests.logout();

select * from finish();

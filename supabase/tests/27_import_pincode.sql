-- Import loader hardening: a bad PIN code, state code or PAN in a Tally ledger never aborts the row, and stale 'error' rows of a
-- batch can be re-run (Admin or Load Tally data, idempotent, locks the batch). Synthetic data only; everything is rolled back.
select plan(28);

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

-- ── The sanitising helpers ──
select is(app.imp_pincode('0'), null, 'PIN "0" is ignored');
select is(app.imp_pincode('682 030'), '682030', 'a PIN with a space is cleaned to six digits');
select is(app.imp_pincode('682-030'), '682030', 'a PIN with a dash is cleaned');
select is(app.imp_pincode('6820301'), null, 'seven digits is ignored');
select is(app.imp_pincode('6820301234'), null, 'ten digits is ignored');
select is(app.imp_pincode('68203012345'), null, 'eleven digits is ignored');
select is(app.imp_pincode('68203'), null, 'five digits is ignored');
select is(app.imp_pincode('012345'), null, 'a PIN starting with 0 is ignored');
select is(app.imp_pincode('abc'), null, 'text without digits is ignored');
select is(app.imp_pincode('682030'), '682030', 'a valid six digit PIN is kept');
select is(app.imp_state2('32'), '32', 'a two digit state code is kept');
select is(app.imp_state2('Kerala State'), null, 'a long state text is ignored');
select is(app.imp_state2('3'), null, 'a one digit state code is ignored');
select is(app.imp_pan('abc12'), null, 'a malformed PAN is ignored');

-- ── Loading ledgers with bad values: no row errors, the raw PIN text is kept in line 2 ──
select tests.login(tests.k('admin'));
insert into ids select 'b1', api.import_create_batch(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'source', 'tally_xml', 'as_of', '2026-03-31'));
select api.import_stage_rows((tests.r('b1') ->> 'id')::uuid, jsonb_build_array(
  jsonb_build_object('object_type', 'ledger', 'name', 'Alpha Zeta Traders', 'guid', 'g-pin-1', 'payload', jsonb_build_object('parent', 'Sundry Debtors', 'address', 'Road 1', 'pincode', '0')),
  jsonb_build_object('object_type', 'ledger', 'name', 'Bravo Quartz Stores', 'guid', 'g-pin-2', 'payload', jsonb_build_object('parent', 'Sundry Debtors', 'address', 'Road 2', 'pincode', '682 030')),
  jsonb_build_object('object_type', 'ledger', 'name', 'Cobalt Mango Agencies', 'guid', 'g-pin-3', 'payload', jsonb_build_object('parent', 'Sundry Debtors', 'address', 'Road 3', 'pincode', '68203012345', 'state_code', 'Kerala State')),
  jsonb_build_object('object_type', 'ledger', 'name', 'Delta Ivory Supplies', 'guid', 'g-pin-4', 'payload', jsonb_build_object('parent', 'Sundry Debtors', 'address', 'Road 4', 'pincode', '68203')),
  jsonb_build_object('object_type', 'ledger', 'name', 'Echo Violet Marketing', 'guid', 'g-pin-5', 'payload', jsonb_build_object('parent', 'Sundry Debtors', 'address', 'Road 5', 'pincode', '682030', 'state_code', '32')),
  jsonb_build_object('object_type', 'ledger', 'name', 'Foxtrot Amber Exports', 'guid', 'g-pin-6', 'payload', jsonb_build_object('parent', 'Sundry Debtors', 'address', 'Road 6', 'pincode', 'Kochi', 'pan', 'BAD')),
  jsonb_build_object('object_type', 'ledger', 'name', 'Gamma Onyx Distributors', 'guid', 'g-pin-7', 'payload', jsonb_build_object('parent', 'Sundry Debtors', 'address', 'Road 7', 'pincode', '6820301234'))));
select api.import_process(gen_random_uuid(), (tests.r('b1') ->> 'id')::uuid);
select tests.logout();

select is((select count(*)::int from ops.import_rows where batch_id = (tests.r('b1') ->> 'id')::uuid and result = 'error'), 0, 'no ledger row ends as an error');
select is((select count(*)::int from acct.accounts where name in ('Alpha Zeta Traders','Bravo Quartz Stores','Cobalt Mango Agencies','Delta Ivory Supplies','Echo Violet Marketing','Foxtrot Amber Exports','Gamma Onyx Distributors')), 7, 'all seven ledgers were created');
select is((select a.pincode::text from master.party_addresses a join master.parties p on p.id = a.party_id where p.legal_name = 'Bravo Quartz Stores'), '682030', 'the cleaned PIN is stored');
select is((select a.pincode::text from master.party_addresses a join master.parties p on p.id = a.party_id where p.legal_name = 'Alpha Zeta Traders'), null, 'a bad PIN is stored as empty');
select is((select a.line2 from master.party_addresses a join master.parties p on p.id = a.party_id where p.legal_name = 'Alpha Zeta Traders'), 'PIN in Tally (not valid): 0', 'the raw PIN text is kept in address line 2');
select is((select a.state_code::text from master.party_addresses a join master.parties p on p.id = a.party_id where p.legal_name = 'Cobalt Mango Agencies'), null, 'a long state text is stored as empty');
select is((select a.state_code::text from master.party_addresses a join master.parties p on p.id = a.party_id where p.legal_name = 'Echo Violet Marketing'), '32', 'a good state code is kept');

-- ── Retry the rows that ended as error ──
update ops.import_rows set result = 'error', message = 'old failure' where batch_id = (tests.r('b1') ->> 'id')::uuid and guid in ('g-pin-1', 'g-pin-3');
select tests.login(tests.k('plastics_user'));
select is(tests.rule($$ select api.import_retry_errors(gen_random_uuid(), (tests.r('b1') ->> 'id')::uuid) $$), 'rights.missing', 'a person without rights to the company cannot re-run its rows');
select tests.logout();
select tests.login(tests.k('admin'));
insert into ids select 'retry1', api.import_retry_errors('00000000-0000-0000-0000-0000000000a1', (tests.r('b1') ->> 'id')::uuid);
select is(((tests.r('retry1')) ->> 'error_before')::int, 2, 'two error rows were re-run');
select is(((tests.r('retry1')) ->> 'error_after')::int, 0, 'and none is an error now');
select is((select count(*)::int from ops.import_rows where batch_id = (tests.r('b1') ->> 'id')::uuid and result = 'error'), 0, 'no error row is left in the batch');
select is(api.import_retry_errors('00000000-0000-0000-0000-0000000000a1', (tests.r('b1') ->> 'id')::uuid), tests.r('retry1'), 'the same request id gives the same answer (idempotent)');
select is((api.import_retry_errors(gen_random_uuid(), (tests.r('b1') ->> 'id')::uuid) ->> 'error_before')::int, 0, 'a new run finds nothing left to do');
select is((select count(*)::int from acct.accounts where name in ('Alpha Zeta Traders','Bravo Quartz Stores','Cobalt Mango Agencies','Delta Ivory Supplies','Echo Violet Marketing','Foxtrot Amber Exports','Gamma Onyx Distributors')), 7, 'no ledger was created twice');
select tests.logout();

select * from finish();

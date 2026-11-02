-- Audit trail (Companies (Accounts) Rules, Rule 3(1)): written by triggers, append-only, not writable by clients.
select plan(9);

select has_trigger('core', 'companies', 'audit_row', 'companies has the history trigger');
select has_trigger('core', 'special_grants', 'audit_row', 'special_grants has the history trigger');
select has_trigger('audit', 'row_history', 'row_history_append_only', 'row_history rejects update/delete');

create temp table s as select tests.seed() as v;
grant select on s to authenticated;

select tests.login((select (v ->> 'admin')::uuid from s));
select lives_ok($$ select api.upsert_company(gen_random_uuid(), '{"code":"TCC","legal_name":"Test Company C Pvt Ltd"}') $$, 'admin creates a company through the RPC');
select tests.logout();

select ok(
  exists (select 1 from audit.row_history h join core.companies c on c.id::text = h.row_pk
          where c.code = 'TCC' and h.op = 'INSERT' and h.actor = (select (v ->> 'admin')::uuid from s)),
  'the insert is in row history with the actor');

select throws_ok($$ update audit.row_history set op = 'DELETE' where id = (select max(id) from audit.row_history) $$,
  'P0001', null, 'row history cannot be updated, even by the owner');
select throws_ok($$ delete from audit.row_history where id = (select max(id) from audit.row_history) $$,
  'P0001', null, 'row history cannot be deleted, even by the owner');

select tests.login((select (v ->> 'admin')::uuid from s));
select throws_ok($$ insert into audit.row_history (table_name, row_pk, op) values ('x', 'y', 'INSERT') $$,
  '42501', null, 'a signed-in user cannot write history directly');
select throws_ok($$ insert into core.companies (code, legal_name, short_name) values ('TCD', 'Direct insert', 'D') $$,
  '42501', null, 'tables are not writable directly; only RPCs change data');
select tests.logout();

select * from finish();

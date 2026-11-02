-- Views and rights: accountant cannot read a bill without GST; the CA reads everything and writes nothing;
-- a user of one company cannot see the other company.
select plan(14);

create temp table s as select tests.seed() as v;
grant select on s to authenticated;

-- A synthetic document table protected exactly as every later document table will be.
create table tests.docs (id int primary key, company_id uuid not null, tax_class text not null);
alter table tests.docs enable row level security;
create policy docs_read on tests.docs for select to authenticated
  using (app.can_read_company(company_id) and app.can_see_tax_class(tax_class));
grant select on tests.docs to authenticated;
insert into tests.docs values
  (1, (select (v ->> 'company_a')::uuid from s), 'taxable'),
  (2, (select (v ->> 'company_a')::uuid from s), 'without_gst'),
  (3, (select (v ->> 'company_b')::uuid from s), 'taxable');

-- Accountant of company A
select tests.login((select (v ->> 'acct')::uuid from s));
select is(app.current_view(), 'gst', 'accountant has the GST view');
select is((select count(*)::int from tests.docs where tax_class = 'without_gst'), 0, 'accountant cannot read a bill without GST');
select is((select count(*)::int from tests.docs), 1, 'accountant sees only company A bills with GST');
select is((select count(*)::int from core.companies), 1, 'accountant sees only their own company');
select ok(app.can((select (v ->> 'company_a')::uuid from s), 'sales_invoices.create'), 'accountant can create sales invoices (template right)');
select ok(not app.can((select (v ->> 'company_a')::uuid from s), 'org.manage'), 'accountant cannot manage companies');
select throws_ok($$ select api.upsert_gstin(gen_random_uuid(), jsonb_build_object('company_id', (select v ->> 'company_a' from s), 'gstin', '32AAAAA1111A2Z4')) $$,
  '42501', null, 'accountant cannot add a GSTIN');
select tests.logout();

-- Accountant of company B ("Plastics user") cannot see company A
select tests.login((select (v ->> 'plastics_user')::uuid from s));
select is((select count(*)::int from core.companies where id = (select (v ->> 'company_a')::uuid from s)), 0, 'a company B user cannot see company A');
select is((select count(*)::int from tests.docs where company_id = (select (v ->> 'company_a')::uuid from s)), 0, 'a company B user cannot see company A documents');
select tests.logout();

-- CA: reads everything (including without GST), writes nothing
select tests.login((select (v ->> 'ca')::uuid from s));
select is(app.current_view(), 'all-readonly', 'CA has the read-only all-transactions view');
select is((select count(*)::int from tests.docs), 3, 'CA reads every bill, with and without GST');
select throws_ok($$ select api.upsert_company(gen_random_uuid(), '{"code":"TCZ","legal_name":"Should fail"}') $$,
  '42501', null, 'CA cannot write');
select tests.logout();

-- Admin
select tests.login((select (v ->> 'admin')::uuid from s));
select is((select count(*)::int from tests.docs), 3, 'Admin sees every bill');
select is(app.current_view(), 'all', 'Admin has the all-transactions view');
select tests.logout();

select * from finish();

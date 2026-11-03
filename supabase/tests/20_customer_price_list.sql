-- Phase 6 gap fix: the customer's price list (api.set_customer_price_list, api.customer_price_list). The office (sales.edit or
-- field.manage) sets it; a salesman cannot; a list of another company is refused; without a list a salesman order is refused
-- (order.no_price_list) and with it the price comes from the list; the salesman reads only his own customer's list. Synthetic data.
select plan(9);

create temp table s as select tests.seed6(tests.seed4(tests.seed3(tests.seed2(tests.seed())))) as v;
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

-- A price list of the other company (set-up as the owner of the test transaction).
create temp table other_pl (id uuid);
with x as (insert into master.price_lists (company_id, name, kind) values (tests.k('company_b'), 'Test Other List', 'wholesale') returning id) insert into other_pl select id from x;
grant select on other_pl to authenticated;

select tests.login(tests.k('salesman'));
select is(tests.rule(format('select api.set_customer_price_list(gen_random_uuid(), %L, %L, %L)', tests.k('company_a'), tests.k('cust'), tests.k('price_list'))),
  'rights.missing', 'a salesman cannot set a customer''s price list');
select tests.logout();

select tests.login(tests.k('smgr'));
select is(tests.rule(format('select api.set_customer_price_list(gen_random_uuid(), %L, %L, %L)', tests.k('company_a'), tests.k('cust'), (select id from other_pl))),
  'price_list.other_company', 'a price list of another company is refused');
select is(api.set_customer_price_list(gen_random_uuid(), tests.k('company_a'), tests.k('cust'), null) ->> 'price_list_id', null, 'the sales manager clears the list');
select tests.logout();

select tests.login(tests.k('salesman'));
select is(tests.rule(format($q$ select api.confirm_sales_order(gen_random_uuid(), jsonb_build_object('company_id', %L, 'party_id', %L, 'channel', 'field', 'payment', 'cash'),
  jsonb_build_array(jsonb_build_object('product_id', %L, 'qty', 2))) $q$, tests.k('company_a'), tests.k('cust'), tests.k('prod'))),
  'order.no_price_list', 'without a price list the salesman cannot take an order');
select is(api.customer_price_list(tests.k('company_a'), tests.k('cust')) -> 'items', '[]'::jsonb, 'no list: no items');
select tests.logout();

select tests.login(tests.k('smgr'));
create temp table again as select gen_random_uuid() as crid;
select is(api.set_customer_price_list((select crid from again), tests.k('company_a'), tests.k('cust'), tests.k('price_list')),
          api.set_customer_price_list((select crid from again), tests.k('company_a'), tests.k('cust'), tests.k('price_list')), 'same request id → same result');
select tests.logout();

select tests.login(tests.k('salesman'));
select is((api.customer_price_list(tests.k('company_a'), tests.k('cust')) -> 'items' -> 0 ->> 'rate')::numeric, 100.00::numeric, 'the salesman sees his customer''s list rate');
select is((api.confirm_sales_order(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'party_id', tests.k('cust'), 'channel', 'field', 'payment', 'cash'),
  jsonb_build_array(jsonb_build_object('product_id', tests.k('prod'), 'qty', 2))) -> 'totals' ->> 'taxable')::numeric, 200.00::numeric, 'with the list the order is priced from it');
select tests.logout();

select tests.login(tests.k('salesman2'));
select is(tests.rule(format('select api.customer_price_list(%L, %L)', tests.k('company_a'), tests.k('cust'))), 'rights.missing', 'another salesman cannot read this customer''s list');
select tests.logout();

select * from finish();

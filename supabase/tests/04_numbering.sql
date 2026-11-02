-- Gap-free numbering, at most 16 characters for GST documents; idempotent RPCs.
select plan(7);

create temp table s as select tests.seed() as v;
grant select on s to authenticated;

select tests.login((select (v ->> 'admin')::uuid from s));
create temp table r1 as select api.upsert_doc_series('11111111-1111-1111-1111-111111111111',
  jsonb_build_object('company_id', (select v ->> 'company_a' from s), 'gstin_id', (select v ->> 'gstin_a' from s),
                     'doc_type', 'sales_invoice', 'fy_id', (select v ->> 'fy_a' from s), 'prefix', 'TA')) as res;
select is((select api.upsert_doc_series('11111111-1111-1111-1111-111111111111', '{}'::jsonb)), (select res from r1),
  'repeating the same client_request_id returns the same result and creates nothing new');
select tests.logout();

select is(app.take_doc_number((select (v ->> 'company_a')::uuid from s), (select (v ->> 'gstin_a')::uuid from s), 'sales_invoice', (select (v ->> 'fy_a')::uuid from s)),
  'TA/26-27/0001', 'first number');
select is(app.take_doc_number((select (v ->> 'company_a')::uuid from s), (select (v ->> 'gstin_a')::uuid from s), 'sales_invoice', (select (v ->> 'fy_a')::uuid from s)),
  'TA/26-27/0002', 'second number follows with no gap');
select is((select count(*)::int from core.doc_numbers_issued i join core.doc_series d on d.id = i.series_id where d.prefix = 'TA'), 2, 'every issued number is recorded');

select tests.login((select (v ->> 'admin')::uuid from s));
select throws_ok($$ select api.upsert_doc_series(gen_random_uuid(), jsonb_build_object('id', (select res ->> 'id' from r1), 'next_no', 1)) $$,
  '22023', null, 'the counter cannot be reset once numbers are issued');
select throws_ok($$ select api.upsert_doc_series(gen_random_uuid(),
  jsonb_build_object('company_id', (select v ->> 'company_a' from s), 'doc_type', 'credit_note', 'fy_id', (select v ->> 'fy_a' from s), 'prefix', 'TOOLONGPREFX', 'pad', 6)) $$,
  '22023', null, 'a GST series whose numbers would pass 16 characters is refused when saved');
select tests.logout();
select throws_ok($$ insert into core.doc_series (company_id, doc_type, fy_id, prefix, pad)
  values ((select (v ->> 'company_a')::uuid from s), 'debit_note', (select (v ->> 'fy_a')::uuid from s), 'TOOLONGPREFX', 6) $$,
  '22023', null, 'the 16-character limit holds even on a direct insert');

select * from finish();

-- company_people: names and role keys of people with a current role in the company, only for someone who also holds
-- a role there; nothing for another company; no personal contact data in the result.
select plan(5);

create temp table s as select tests.seed() as v;
grant select on s to authenticated;

select tests.login((select (v ->> 'acct')::uuid from s));
select ok((select count(*) > 0 from api.company_people((select (v ->> 'company_a')::uuid from s))), 'the accountant sees the people of their company');
select ok((select bool_or(user_id = (select (v ->> 'acct')::uuid from s)) from api.company_people((select (v ->> 'company_a')::uuid from s))), 'including themselves with their role');
select ok(not exists (select 1 from api.company_people((select (v ->> 'company_a')::uuid from s)) where user_id = (select (v ->> 'plastics_user')::uuid from s)), 'a person with a role only in the other company is not listed');
select throws_ok(format($$ select * from api.company_people(%L) $$, (select v ->> 'company_b' from s)), '42501', null, 'the other company''s people are refused');
select tests.logout();
select is((select count(*)::int from unnest((select proargnames from pg_proc where oid = 'api.company_people'::regproc)) n where n ~ '(^|_)(phone|email|aadhaar|pan)$'), 0, 'no contact or KYC columns are returned');

select * from finish();

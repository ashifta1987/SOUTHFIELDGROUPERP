-- HR screens: add/edit staff in one transaction (IDs by the app, Aadhaar last 4 only, salary needs the Payroll right),
-- the masked staff list, the logged salary read, the allowances view under RLS, cash to staff under the daily cash
-- limit and against an approved advance only, and request decisions (never your own; a missing request is refused).
select plan(20);

create temp table s as select tests.seed3(tests.seed2(tests.seed())) as v;
grant select on s to authenticated;
-- For these tests the accountant may add and edit staff (Admin can give this on Users & rights), but has no Payroll right.
insert into core.role_rights (role_key, right_key) values ('accountant', 'hr.create'), ('accountant', 'hr.edit'), ('accountant', 'hr.view') on conflict do nothing;

-- ── Add staff ──
select tests.login((select (v ->> 'admin')::uuid from s));
create temp table st as select api.save_staff(gen_random_uuid(), jsonb_build_object('name', 'Test Staff One', 'designation', 'Test operator',
  'pay_company_id', (select v ->> 'company_a' from s), 'pay_basis', 'monthly', 'monthly_salary', 24000, 'phone', '9000000111', 'aadhaar', '1234 5678 9012',
  'bank_last4', '00004321', 'join_date', '2026-06-01')) as r;
grant select on st to authenticated;
select matches((select r ->> 'person_code' from st), '^EMP-[0-9]{4,}$', 'the app gives the staff ID');
select is((select aadhaar_last4::text from master.people where id = (select (r ->> 'person_id')::uuid from st)), '9012', 'only the last 4 Aadhaar digits are kept');
select ok((select pay_company_id = (select (v ->> 'company_a')::uuid from s) and designation = 'Test operator' from api.staff where person_id = (select (r ->> 'person_id')::uuid from st)),
  'the profile is saved in the same call');
select ok((select aadhaar_masked = 'XXXX XXXX 9012' and bank_masked = '••4321' and kyc_done = 3 from api.staff_kyc() where person_id = (select (r ->> 'person_id')::uuid from st)),
  'the staff list shows Aadhaar and bank masked, with KYC completeness');
select throws_ok(format($$ select api.save_staff(gen_random_uuid(), jsonb_build_object('name', 'Test No Designation', 'pay_company_id', %L)) $$, (select v ->> 'company_a' from s)),
  '22023', null, 'a staff member without a designation is refused');
select is((select (api.staff_pay((select (r ->> 'person_id')::uuid from st))) ->> 'monthly_salary')::numeric, 24000::numeric, 'a payroll user reads the salary');
select tests.logout();

-- ── Without the Payroll right ──
select tests.login((select (v ->> 'acct')::uuid from s));
select throws_ok(format($$ select api.save_staff(gen_random_uuid(), jsonb_build_object('name', 'Test Staff Two', 'designation', 'Test packer', 'pay_company_id', %L, 'monthly_salary', 15000)) $$,
  (select v ->> 'company_a' from s)), '42501', null, 'setting a salary needs the Payroll right');
select lives_ok(format($$ select api.save_staff(gen_random_uuid(), jsonb_build_object('name', 'Test Staff Two', 'designation', 'Test packer', 'pay_company_id', %L)) $$,
  (select v ->> 'company_a' from s)), 'HR can add a person without a salary');
select throws_ok($$ select api.staff_pay((select (r ->> 'person_id')::uuid from st)) $$, '42501', null, 'the salary is not readable without the Payroll right');
select tests.logout();

-- ── Allowances view under RLS ──
insert into hr.allowances (person_id, company_id, head, kind, amount, from_month) values
  ((select (v ->> 'person')::uuid from s), (select (v ->> 'company_a')::uuid from s), 'Test travel', 'allowance', 1500, '2026-06-01'),
  ((select (r ->> 'person_id')::uuid from st), (select (v ->> 'company_a')::uuid from s), 'Test food', 'allowance', 800, '2026-06-01');
select tests.login((select (v ->> 'staff_user')::uuid from s));
select ok((select count(*) = 1 and bool_and(head = 'Test travel') from api.staff_allowances), 'a staff member sees only their own allowances');
select tests.logout();
select tests.login((select (v ->> 'admin')::uuid from s));
select ok((select count(*) >= 2 from api.staff_allowances where company_id = (select (v ->> 'company_a')::uuid from s)), 'payroll users see the company''s allowances');

-- ── Cash to staff under the daily cash limit ──
select throws_ok(format($$ select api.give_staff_cash(gen_random_uuid(), jsonb_build_object('company_id', %L, 'person_id', %L, 'date', '2026-06-10', 'amount', 12000, 'account_id', %L)) $$,
  (select v ->> 'company_a' from s), (select v ->> 'person' from s), (select v ->> 'cash' from s)), '22023', null, 'cash over ₹10,000 to one person in a day needs a reason');
create temp table cg as select api.give_staff_cash(gen_random_uuid(), jsonb_build_object('company_id', (select v ->> 'company_a' from s), 'person_id', (select v ->> 'person' from s),
  'date', '2026-06-10', 'amount', 12000, 'account_id', (select v ->> 'cash' from s), 'cash_reason', 'Test: no bank account yet')) as r;
select ok((select (r ->> 'warning') = 'over_limit' from cg) and (select cash_reason is not null and mode = 'cash' from acct.vouchers where id = (select (r ->> 'voucher_id')::uuid from cg)),
  'with a reason it posts and the voucher is flagged for Admin');
select tests.logout();

-- ── Requests: nobody approves their own; a pending advance cannot be paid ──
insert into master.people (name, status, user_id) values ('Test Admin Person', 'active', (select (v ->> 'admin')::uuid from s));
insert into hr.staff_profiles (person_id, pay_company_id) select id, (select (v ->> 'company_a')::uuid from s) from master.people where name = 'Test Admin Person';
select tests.login((select (v ->> 'admin')::uuid from s));
create temp table rq as select api.submit_staff_request(gen_random_uuid(), jsonb_build_object('kind', 'advance', 'amount', 2000, 'reason', 'Test advance')) as r;
grant select on rq to authenticated;
select throws_ok($$ select api.decide_staff_request(gen_random_uuid(), (select (r ->> 'id')::uuid from rq), true, 'self') $$, '42501', null, 'nobody approves their own request');
select throws_ok(format($$ select api.give_staff_cash(gen_random_uuid(), jsonb_build_object('company_id', %L, 'person_id', (select id from master.people where name = 'Test Admin Person'),
  'date', '2026-06-11', 'amount', 2000, 'account_id', %L, 'request_id', (select r ->> 'id' from rq))) $$, (select v ->> 'company_a' from s), (select v ->> 'cash' from s)),
  '22023', null, 'an advance request that is not approved cannot be paid');
select throws_ok($$ select api.decide_staff_request(gen_random_uuid(), gen_random_uuid(), true, null) $$, 'P0002', null, 'a request that does not exist is refused');
select tests.logout();
select tests.login((select (v ->> 'admin2')::uuid from s));
select lives_ok($$ select api.decide_staff_request(gen_random_uuid(), (select (r ->> 'id')::uuid from rq), true, 'Test approved') $$, 'another person approves it');
select lives_ok(format($$ select api.give_staff_cash(gen_random_uuid(), jsonb_build_object('company_id', %L, 'person_id', (select id from master.people where name = 'Test Admin Person'),
  'date', '2026-06-11', 'amount', 2000, 'account_id', %L, 'request_id', (select r ->> 'id' from rq))) $$, (select v ->> 'company_a' from s), (select v ->> 'cash' from s)),
  'the approved advance is paid once, against the request');
select tests.logout();

-- ── Duties: saved for the company of the day; an empty duty is refused ──
select tests.login((select (v ->> 'admin')::uuid from s));
select is((select (api.set_duties(gen_random_uuid(), '2026-06-12', jsonb_build_array(jsonb_build_object('person_id', (select v ->> 'person' from s),
  'company_id', (select v ->> 'company_b' from s), 'duty', 'Test packing', 'shift', 'night'))) ->> 'saved')::int), 1, 'a duty for the other company is saved');
select throws_ok(format($$ select api.set_duties(gen_random_uuid(), '2026-06-12', jsonb_build_array(jsonb_build_object('person_id', %L, 'company_id', %L, 'duty', ''))) $$,
  (select v ->> 'person' from s), (select v ->> 'company_a' from s)), '22023', null, 'a duty without a name is refused');
select tests.logout();

select * from finish();

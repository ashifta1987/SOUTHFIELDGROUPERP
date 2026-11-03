-- Cash limits, receipts allocated bill by bill, closed periods, payroll separation of duties, overtime at the
-- configured multiplier, and staff privacy (own payslip only).
select plan(13);

create temp table s as select tests.seed3(tests.seed2(tests.seed())) as v;
grant select on s to authenticated;
insert into core.role_rights (role_key, right_key) values ('accountant', 'accounts.create'), ('accountant', 'cash_book.create'), ('accountant', 'receipts_payments.create') on conflict do nothing;

select tests.login((select (v ->> 'acct')::uuid from s));
create temp table inv as select api.post_sales_document(gen_random_uuid(), (api.save_sales_draft(gen_random_uuid(), jsonb_build_object('company_id', (select v ->> 'company_a' from s),
  'gstin_id', (select v ->> 'gstin_a' from s), 'doc_type', 'sales_invoice', 'doc_date', '2026-06-01', 'party_id', (select v ->> 'cust' from s),
  'lines', jsonb_build_array(jsonb_build_object('product_id', (select v ->> 'prod' from s), 'qty', 1, 'rate', 100)))) ->> 'id')::uuid) as r;

select throws_ok(format($$ select api.post_receipt(gen_random_uuid(), jsonb_build_object('company_id', %L, 'party_id', %L, 'date', '2026-06-02', 'mode', 'cash', 'account_id', %L, 'amount', 200000)) $$,
  (select v ->> 'company_a' from s), (select v ->> 'cust' from s), (select v ->> 'cash' from s)), '42501', null, 'a cash receipt of ₹2 lakh from one person in a day is refused');
select lives_ok(format($$ select api.post_receipt(gen_random_uuid(), jsonb_build_object('company_id', %L, 'party_id', %L, 'date', '2026-06-02', 'mode', 'cash', 'account_id', %L, 'amount', 150000)) $$,
  (select v ->> 'company_a' from s), (select v ->> 'cust' from s), (select v ->> 'cash' from s)), 'a cash receipt below the limit is accepted');
select throws_ok(format($$ select api.post_receipt(gen_random_uuid(), jsonb_build_object('company_id', %L, 'party_id', %L, 'date', '2026-06-02', 'mode', 'cash', 'account_id', %L, 'amount', 60000)) $$,
  (select v ->> 'company_a' from s), (select v ->> 'cust' from s), (select v ->> 'cash' from s)), '42501', null, 'a second cash receipt the same day that reaches the limit is refused');
select throws_ok(format($$ select api.post_payment(gen_random_uuid(), jsonb_build_object('company_id', %L, 'party_id', %L, 'date', '2026-06-02', 'mode', 'cash', 'account_id', %L, 'amount', 12000)) $$,
  (select v ->> 'company_a' from s), (select v ->> 'supp' from s), (select v ->> 'cash' from s)), '22023', null, 'a cash payment over ₹10,000 without a reason is stopped');
select is((select api.post_payment(gen_random_uuid(), jsonb_build_object('company_id', (select v ->> 'company_a' from s), 'party_id', (select v ->> 'supp' from s), 'date', '2026-06-02', 'mode', 'cash',
  'account_id', (select v ->> 'cash' from s), 'amount', 12000, 'cash_reason', 'Test: supplier has no bank account')) ->> 'warning'), 'over_limit', 'with a reason it posts and is flagged for Admin');
-- Bill-wise allocation by bank
select throws_ok(format($$ select api.post_receipt(gen_random_uuid(), jsonb_build_object('company_id', %L, 'party_id', %L, 'date', '2026-06-03', 'mode', 'bank', 'account_id', %L, 'amount', 500,
  'allocations', jsonb_build_array(jsonb_build_object('kind', 'sales_document', 'id', %L, 'amount', 500)))) $$,
  (select v ->> 'company_a' from s), (select v ->> 'cust' from s), (select v ->> 'bank' from s), (select r ->> 'id' from inv)), '22023', null, 'an allocation above what the bill owes is refused');
select lives_ok(format($$ select api.post_receipt(gen_random_uuid(), jsonb_build_object('company_id', %L, 'party_id', %L, 'date', '2026-06-03', 'mode', 'bank', 'account_id', %L, 'amount', 118,
  'allocations', jsonb_build_array(jsonb_build_object('kind', 'sales_document', 'id', %L, 'amount', 118)))) $$,
  (select v ->> 'company_a' from s), (select v ->> 'cust' from s), (select v ->> 'bank' from s), (select r ->> 'id' from inv)), 'a bank receipt settles the bill');
select is((select open_amount from api.receivables where id = (select (r ->> 'id')::uuid from inv)), 0.00::numeric, 'the bill shows nothing still owed');
select tests.logout();

-- Closed period
update core.periods set status = 'closed' where company_id = (select (v ->> 'company_a')::uuid from s) and month_start = '2026-04-01';
select tests.login((select (v ->> 'acct')::uuid from s));
select throws_ok(format($$ select api.post_payment(gen_random_uuid(), jsonb_build_object('company_id', %L, 'party_id', %L, 'date', '2026-04-15', 'mode', 'bank', 'account_id', %L, 'amount', 100)) $$,
  (select v ->> 'company_a' from s), (select v ->> 'supp' from s), (select v ->> 'bank' from s)), '42501', null, 'posting into a closed month is refused');
select tests.logout();

-- Payroll: OT at 2×, preparer cannot approve, another person can; staff sees only their own payslip
insert into hr.attendance (person_id, company_id, work_date, status, ot_hours)
select (select (v ->> 'person')::uuid from s), (select (v ->> 'company_a')::uuid from s), d::date, 'P', case when d::date = '2026-06-05' then 4 else 0 end
from generate_series('2026-06-01'::date, '2026-06-30'::date, interval '1 day') d;
select tests.login((select (v ->> 'admin')::uuid from s));
create temp table run as select api.prepare_payroll(gen_random_uuid(), (select (v ->> 'company_a')::uuid from s), '2026-06-01') as r;
select is((select ot_pay from hr.payslips where run_id = (select (r ->> 'run_id')::uuid from run)), round(4 * (30000.0 / 30 / 8) * 2, 2)::numeric(18,2), 'overtime is paid at twice the hourly rate');
select throws_ok($$ select api.approve_payroll(gen_random_uuid(), (select (r ->> 'run_id')::uuid from run)) $$, '42501', null, 'the person who prepared the payroll cannot approve it');
select tests.logout();
select tests.login((select (v ->> 'admin2')::uuid from s));
select lives_ok($$ select api.approve_payroll(gen_random_uuid(), (select (r ->> 'run_id')::uuid from run)) $$, 'another person approves and posts it');
select tests.logout();
select tests.login((select (v ->> 'staff_user')::uuid from s));
select ok((select count(*) = 1 and bool_and(person_id = (select (v ->> 'person')::uuid from s)) from hr.payslips), 'the staff member sees only their own payslip');
select tests.logout();

select * from finish();

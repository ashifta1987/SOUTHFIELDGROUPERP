-- Staff app, WhatsApp admin and Help v1: own requests with the staff-app details, staff_me returns only the person's
-- own data and posted payslips, payslip reads refuse other people's slips without the Payroll right, staff templates
-- never carry amounts, the allow-list only takes consenting contacts, and problem reports are visible to their author
-- and Admin only (Admin answers).
select plan(25);

create temp table s as select tests.seed3(tests.seed2(tests.seed())) as v;
grant select on s to authenticated;

-- ── Staff requests from the staff app ──
select tests.login((select (v ->> 'staff_user')::uuid from s));
create temp table lv as select api.submit_staff_request(gen_random_uuid(), jsonb_build_object('kind', 'leave', 'from_date', '2026-06-15', 'half_day', true,
  'leave_type', 'sick', 'reason', 'Test fever')) as r;
grant select on lv to authenticated;
select ok((select person_id = (select (v ->> 'person')::uuid from s) and kind = 'leave' and leave_type = 'sick' and half_day and from_date = to_date and status = 'pending'
           from api.staff_requests where id = (select (r ->> 'id')::uuid from lv)), 'a half-day sick leave is saved for the person themselves, one date');
select throws_ok($$ select api.submit_staff_request(gen_random_uuid(), jsonb_build_object('kind', 'leave', 'from_date', '2026-06-15', 'to_date', '2026-06-16', 'half_day', true, 'reason', 'Test two days')) $$,
  '22023', null, 'a half day over two dates is refused');
select throws_ok($$ select api.submit_staff_request(gen_random_uuid(), jsonb_build_object('kind', 'leave', 'from_date', '2026-06-15', 'to_date', '2026-06-16', 'leave_type', 'holiday', 'reason', 'Test type')) $$,
  '22023', null, 'an unknown leave type is refused');
create temp table ad as select api.submit_staff_request(gen_random_uuid(), jsonb_build_object('kind', 'advance', 'amount', 1500, 'repay_months', 3, 'paid_in', 'cash',
  'needed_by', ((now() at time zone 'Asia/Kolkata')::date + 3)::text, 'reason', 'Test advance')) as r;
grant select on ad to authenticated;
select ok((select amount = 1500 and repay_months = 3 and paid_in = 'cash' and from_date is null from api.staff_requests where id = (select (r ->> 'id')::uuid from ad)),
  'an advance keeps the amount, pay-back months and how it is paid');
select throws_ok($$ select api.submit_staff_request(gen_random_uuid(), jsonb_build_object('kind', 'advance', 'amount', 1500, 'repay_months', 24, 'reason', 'Test long')) $$,
  '22023', null, 'pay back over more than 12 months is refused');
select throws_ok($$ select api.submit_staff_request(gen_random_uuid(), jsonb_build_object('kind', 'advance', 'amount', 1500, 'needed_by', '2020-01-01', 'reason', 'Test past')) $$,
  '22023', null, 'a needed-by date in the past is refused');
select is(jsonb_array_length(api.staff_me() -> 'requests'), 2, 'staff_me lists the person''s own requests');
select is(api.staff_me() ->> 'person_id', (select v ->> 'person' from s), 'staff_me is about the signed-in person');
select is(api.staff_me() -> 'payslips', '[]'::jsonb, 'no posted payslip yet, so none is listed');
select tests.logout();

-- ── Payroll: draft payslips stay hidden in the staff app; posted ones are listed; another person's slip is refused ──
insert into master.people (name, status) values ('Test Other Worker', 'active');
insert into hr.staff_profiles (person_id, pay_company_id, pay_basis, monthly_salary) select id, (select (v ->> 'company_a')::uuid from s), 'monthly', 18000 from master.people where name = 'Test Other Worker';
select tests.login((select (v ->> 'admin')::uuid from s));
create temp table pr as select api.prepare_payroll(gen_random_uuid(), (select (v ->> 'company_a')::uuid from s), '2026-06-01') as r;
grant select on pr to authenticated;
select tests.logout();
select tests.login((select (v ->> 'staff_user')::uuid from s));
select is(api.staff_me() -> 'payslips', '[]'::jsonb, 'a draft payroll is not shown in the staff app');
select tests.logout();
select tests.login((select (v ->> 'admin2')::uuid from s));
select lives_ok($$ select api.approve_payroll(gen_random_uuid(), (select id from hr.payroll_runs where company_id = (select (v ->> 'company_a')::uuid from s) and month = '2026-06-01')) $$,
  'a second person approves the payroll');
select tests.logout();
create temp table other_slip as select ps.id from hr.payslips ps join master.people pe on pe.id = ps.person_id where pe.name = 'Test Other Worker';
grant select on other_slip to authenticated;
select tests.login((select (v ->> 'staff_user')::uuid from s));
select is(jsonb_array_length(api.staff_me() -> 'payslips'), 1, 'the posted payslip is listed in the staff app');
select is((api.payslip((select (api.staff_me() -> 'payslips' -> 0 ->> 'id')::uuid)) ->> 'person_id'), (select v ->> 'person' from s), 'the person opens their own payslip');
select is((select count(*)::int from hr.payslips), 1, 'row-level security shows only the person''s own payslip');
select throws_ok(format($$ select api.payslip(%L) $$, (select id from other_slip)), '42501', null, 'another person''s payslip is refused');
select tests.logout();

-- ── WhatsApp templates ──
select tests.login((select (v ->> 'admin')::uuid from s));
create temp table tp as select api.upsert_template(gen_random_uuid(), jsonb_build_object('name', 'test_duty_tomorrow', 'language', 'en', 'category', 'utility', 'event', 'hr.duty_tomorrow',
  'body', 'Your duty tomorrow is {{1}}. Open the staff app for details.', 'params', jsonb_build_array('duty'))) as r;
grant select on tp to authenticated;
select ok((select approval_status = 'draft' and version = 1 and event = 'hr.duty_tomorrow' from api.msg_templates where id = (select (r ->> 'id')::uuid from tp)), 'Admin adds a draft template');
select throws_ok($$ select api.upsert_template(gen_random_uuid(), jsonb_build_object('name', 'test_salary', 'language', 'en', 'category', 'utility', 'event', 'hr.salary',
  'body', 'Your salary of ₹{{1}} is paid.', 'params', jsonb_build_array('net'))) $$, '22023', null, 'a staff template with an amount is refused');
select throws_ok($$ select api.upsert_template(gen_random_uuid(), jsonb_build_object('name', 'test_mismatch', 'language', 'en', 'category', 'utility', 'event', 'sales.x',
  'body', 'Dear {{1}}, hello {{2}}.', 'params', jsonb_build_array('customer'))) $$, '22023', null, 'the body and the parameter list must match');
select tests.logout();
update msg.templates set approval_status = 'approved' where id = (select (r ->> 'id')::uuid from tp);   -- Meta approval (outside the ERP)
select tests.login((select (v ->> 'admin')::uuid from s));
create temp table tp2 as select api.upsert_template(gen_random_uuid(), jsonb_build_object('id', (select r ->> 'id' from tp), 'event', 'hr.duty_tomorrow',
  'body', 'Tomorrow your duty is {{1}}. See the staff app.', 'params', jsonb_build_array('duty'))) as r;
grant select on tp2 to authenticated;
select ok((select version = 2 and approval_status = 'draft' from api.msg_templates where id = (select (r ->> 'id')::uuid from tp2))
          and (select approval_status = 'approved' from api.msg_templates where id = (select (r ->> 'id')::uuid from tp)),
  'changing an approved template makes a new draft version and keeps the approved one');

-- ── Allow-list ──
select lives_ok($$ select api.set_allow_list(gen_random_uuid(), '9000000101', 'Test contact', false) $$, 'a consenting party contact goes on the allow-list');
select is((select belongs_to from api.msg_allow_list where number = '+919000000101'), 'Test Customer Kerala', 'the list shows whose number it is');
select throws_ok($$ select api.set_allow_list(gen_random_uuid(), '9000000999', 'Typed number', false) $$, '22023', null, 'a typed number with no consent is refused');
select tests.logout();
select tests.login((select (v ->> 'acct')::uuid from s));
select throws_ok($$ select api.set_allow_list(gen_random_uuid(), '9000000101', null, true) $$, '42501', null, 'only Admin changes the allow-list');
select tests.logout();

-- ── Problem reports ──
select tests.login((select (v ->> 'staff_user')::uuid from s));
create temp table rp as select api.create_problem_report(gen_random_uuid(), jsonb_build_object('screen', 'StaffHome', 'what_happened', 'Test: the page did not load')) as r;
grant select on rp to authenticated;
select tests.logout();
select tests.login((select (v ->> 'acct')::uuid from s));
select is((select count(*)::int from api.problem_reports where id = (select (r ->> 'id')::uuid from rp)), 0, 'another user cannot read someone''s problem report');
select tests.logout();
select tests.login((select (v ->> 'admin')::uuid from s));
select api.answer_problem_report(gen_random_uuid(), (select (r ->> 'id')::uuid from rp), 'Test reply', 'closed');
select tests.logout();
select tests.login((select (v ->> 'staff_user')::uuid from s));
select is((select reply || '/' || status from api.problem_reports where id = (select (r ->> 'id')::uuid from rp)), 'Test reply/closed', 'the author sees Admin''s answer');
select tests.logout();

select * from finish();

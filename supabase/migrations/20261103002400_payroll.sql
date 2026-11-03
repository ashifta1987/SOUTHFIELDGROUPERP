-- 20261103002400_payroll.sql
-- Phase 3: staff profiles on the one group staff list, attendance and hours, leave/advance requests from the staff
-- app (decided by someone else), allowances/deductions, cash given to staff, payroll runs per company and month
-- (overtime at the configured multiplier, advance recovery, round-off), approval by another person, posting to the GL,
-- payslip-ready WhatsApp without amounts, and the staff app reads. Salary is readable only with payroll rights or by
-- the person themselves; each salary view is logged. PF/ESI stay off until the CA confirms the settings. Additive.

create table hr.staff_profiles (
  person_id uuid primary key references master.people (id),
  designation text,
  department_id uuid references core.departments (id),
  pay_company_id uuid references core.companies (id),
  pay_basis text not null default 'monthly' check (pay_basis in ('monthly', 'daily')),
  monthly_salary numeric(18, 2) check (monthly_salary is null or monthly_salary >= 0),
  daily_wage numeric(18, 2) check (daily_wage is null or daily_wage >= 0),
  join_date date,
  language text not null default 'en' check (language in ('en', 'ml', 'hi', 'bho')),
  bank_last4 char(4),
  active boolean not null default true
);
create index on hr.staff_profiles (pay_company_id);

create table hr.attendance (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references master.people (id),
  company_id uuid not null references core.companies (id),
  work_date date not null,
  status text not null check (status in ('P', 'A', 'H', 'L', 'WO')),     -- present, absent, half day, leave, weekly off
  hours numeric(5, 2) check (hours is null or (hours >= 0 and hours <= 24)),
  ot_hours numeric(5, 2) not null default 0 check (ot_hours >= 0 and ot_hours <= 16),
  marked_by uuid references auth.users (id),
  marked_at timestamptz not null default now(),
  unique (person_id, company_id, work_date)
);
create index on hr.attendance (company_id, work_date);

create table hr.requests (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references master.people (id),
  company_id uuid references core.companies (id),
  kind text not null check (kind in ('leave', 'advance')),
  from_date date,
  to_date date,
  amount numeric(18, 2) check (amount is null or amount > 0),
  reason text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'refused', 'withdrawn')),
  requested_by uuid not null references auth.users (id),
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  check (decided_by is null or decided_by <> requested_by)
);
create index on hr.requests (person_id);

create table hr.allowances (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references master.people (id),
  company_id uuid not null references core.companies (id),
  head text not null,
  kind text not null check (kind in ('allowance', 'deduction')),
  amount numeric(18, 2) not null check (amount >= 0),
  from_month date not null check (extract(day from from_month) = 1),
  to_month date,
  note text
);
create index on hr.allowances (person_id);

create table hr.cash_given (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references master.people (id),
  company_id uuid not null references core.companies (id),
  given_on date not null,
  amount numeric(18, 2) not null check (amount > 0),
  purpose text not null default 'advance',
  voucher_id uuid references acct.vouchers (id),
  request_id uuid references hr.requests (id),
  recovered_run_id uuid,
  created_at timestamptz not null default now()
);
create index on hr.cash_given (person_id);

create table hr.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  month date not null check (extract(day from month) = 1),
  status text not null default 'draft' check (status in ('draft', 'approved', 'posted')),
  prepared_by uuid not null references auth.users (id),
  prepared_at timestamptz not null default now(),
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  voucher_id uuid references acct.vouchers (id),
  totals jsonb not null default '{}'::jsonb,
  unique (company_id, month),
  check (approved_by is null or approved_by <> prepared_by)
);
alter table hr.cash_given add constraint cash_given_run_fk foreign key (recovered_run_id) references hr.payroll_runs (id);

create table hr.payslips (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references hr.payroll_runs (id) on delete cascade,
  person_id uuid not null references master.people (id),
  company_id uuid not null references core.companies (id),
  month date not null,
  days_in_month int not null,
  present numeric(5, 1) not null,
  half_days int not null default 0,
  leave_days int not null default 0,
  weekly_off int not null default 0,
  payable_days numeric(5, 1) not null,
  ot_hours numeric(6, 2) not null default 0,
  basic numeric(18, 2) not null,
  allowances numeric(18, 2) not null default 0,
  ot_pay numeric(18, 2) not null default 0,
  gross numeric(18, 2) not null,
  advance_recovery numeric(18, 2) not null default 0,
  deductions numeric(18, 2) not null default 0,
  round_off numeric(18, 2) not null default 0,
  net numeric(18, 2) not null,
  lines jsonb not null default '[]'::jsonb,
  unique (run_id, person_id)
);
create index on hr.payslips (person_id);

do $$
declare t text;
begin
  foreach t in array array['staff_profiles', 'attendance', 'requests', 'allowances', 'cash_given', 'payroll_runs', 'payslips'] loop
    execute format('create trigger audit_row after insert or update or delete on hr.%I for each row execute function app.audit_trigger()', t);
    execute format('alter table hr.%I enable row level security', t);
    execute format('revoke all on hr.%I from anon, authenticated', t);
    execute format('grant select on hr.%I to authenticated', t);
  end loop;
end $$;

create or replace function app.my_person() returns uuid
language sql stable security definer set search_path = '' as $$ select id from master.people where user_id = auth.uid() $$;

-- Salary columns: payroll right, or the person's own row.
create policy staff_profiles_read on hr.staff_profiles for select to authenticated using (app.can(pay_company_id, 'payroll.run') or app.can(null, 'hr.view') or person_id = app.my_person());
revoke select on hr.staff_profiles from authenticated;
grant select (person_id, designation, department_id, pay_company_id, pay_basis, join_date, language, active) on hr.staff_profiles to authenticated;
create policy attendance_read on hr.attendance for select to authenticated using (app.can(company_id, 'hr.view') or person_id = app.my_person());
create policy requests_read on hr.requests for select to authenticated using (app.can(company_id, 'hr.view') or app.can(null, 'hr.approve') or person_id = app.my_person());
create policy allowances_read on hr.allowances for select to authenticated using (app.can(company_id, 'payroll.run') or person_id = app.my_person());
create policy cash_given_read on hr.cash_given for select to authenticated using (app.can(company_id, 'payroll.run') or app.can(company_id, 'cash_book.view') or person_id = app.my_person());
create policy runs_read on hr.payroll_runs for select to authenticated using (app.can(company_id, 'payroll.run'));
create policy payslips_read on hr.payslips for select to authenticated using (app.can(company_id, 'payroll.run') or person_id = app.my_person());

-- ─────────── RPCs ───────────
create or replace function api.upsert_staff_profile(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_person uuid := (p ->> 'person_id')::uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_staff_profile'); if v_prev is not null then return v_prev; end if;
  perform app.require(nullif(p ->> 'pay_company_id', '')::uuid, 'hr.edit');
  if (p ? 'monthly_salary' or p ? 'daily_wage') then perform app.require(nullif(p ->> 'pay_company_id', '')::uuid, 'payroll.run'); end if;
  insert into hr.staff_profiles (person_id, designation, department_id, pay_company_id, pay_basis, monthly_salary, daily_wage, join_date, language, bank_last4)
  values (v_person, p ->> 'designation', nullif(p ->> 'department_id', '')::uuid, nullif(p ->> 'pay_company_id', '')::uuid, coalesce(p ->> 'pay_basis', 'monthly'),
          nullif(p ->> 'monthly_salary', '')::numeric, nullif(p ->> 'daily_wage', '')::numeric, nullif(p ->> 'join_date', '')::date, coalesce(p ->> 'language', 'en'),
          nullif(right(regexp_replace(coalesce(p ->> 'bank_last4', ''), '\D', '', 'g'), 4), ''))
  on conflict (person_id) do update set designation = coalesce(excluded.designation, hr.staff_profiles.designation), department_id = coalesce(excluded.department_id, hr.staff_profiles.department_id),
    pay_company_id = coalesce(excluded.pay_company_id, hr.staff_profiles.pay_company_id), pay_basis = excluded.pay_basis,
    monthly_salary = case when p ? 'monthly_salary' then excluded.monthly_salary else hr.staff_profiles.monthly_salary end,
    daily_wage = case when p ? 'daily_wage' then excluded.daily_wage else hr.staff_profiles.daily_wage end,
    join_date = coalesce(excluded.join_date, hr.staff_profiles.join_date), language = excluded.language, bank_last4 = coalesce(excluded.bank_last4, hr.staff_profiles.bank_last4);
  update master.people set status = 'active' where id = v_person and status = 'to_review';
  v_res := jsonb_build_object('person_id', v_person);
  return app.request_done(p_client_request_id, 'upsert_staff_profile', v_res);
end $$;

-- Mark attendance for one day: entries [{person_id, status, hours, ot_hours}]. A paid month is locked.
create or replace function api.mark_attendance(p_client_request_id uuid, p_company_id uuid, p_date date, p_entries jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_n int; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'mark_attendance'); if v_prev is not null then return v_prev; end if;
  perform app.require(p_company_id, 'hr.create');
  if p_date > current_date then perform app.raise_rule('date.future', 'attendance cannot be marked for a future date', '22023'); end if;
  if exists (select 1 from hr.payroll_runs where company_id = p_company_id and month = date_trunc('month', p_date)::date and status <> 'draft') then
    perform app.raise_rule('payroll.month_locked', 'payroll for this month is approved; attendance is locked', '42501');
  end if;
  insert into hr.attendance (person_id, company_id, work_date, status, hours, ot_hours, marked_by)
  select (e ->> 'person_id')::uuid, p_company_id, p_date, e ->> 'status', nullif(e ->> 'hours', '')::numeric, coalesce(nullif(e ->> 'ot_hours', '')::numeric, 0), auth.uid()
  from jsonb_array_elements(p_entries) e
  on conflict (person_id, company_id, work_date) do update set status = excluded.status, hours = excluded.hours, ot_hours = excluded.ot_hours, marked_by = excluded.marked_by, marked_at = now();
  get diagnostics v_n = row_count;
  v_res := jsonb_build_object('marked', v_n);
  return app.request_done(p_client_request_id, 'mark_attendance', v_res);
end $$;

-- The staff app: a person asks for leave or an advance for themselves.
create or replace function api.submit_staff_request(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_person uuid := app.my_person(); v_id uuid; v_company uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'submit_staff_request'); if v_prev is not null then return v_prev; end if;
  if v_person is null then perform app.raise_rule('staff.not_linked', 'your sign-in is not linked to a staff record yet; ask Admin', '42501'); end if;
  if coalesce(length(trim(p ->> 'reason')), 0) < 3 then perform app.raise_rule('staff.reason', 'say why in a few words', '22023'); end if;
  select pay_company_id into v_company from hr.staff_profiles where person_id = v_person;
  if p ->> 'kind' = 'leave' and (nullif(p ->> 'from_date', '') is null or nullif(p ->> 'to_date', '')::date < (p ->> 'from_date')::date) then
    perform app.raise_rule('staff.dates', 'choose the leave dates', '22023');
  end if;
  if p ->> 'kind' = 'advance' and coalesce(nullif(p ->> 'amount', '')::numeric, 0) <= 0 then perform app.raise_rule('staff.amount', 'enter the amount', '22023'); end if;
  insert into hr.requests (person_id, company_id, kind, from_date, to_date, amount, reason, requested_by)
  values (v_person, v_company, p ->> 'kind', nullif(p ->> 'from_date', '')::date, nullif(p ->> 'to_date', '')::date, nullif(p ->> 'amount', '')::numeric, p ->> 'reason', auth.uid())
  returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'submit_staff_request', v_res);
end $$;

create or replace function api.decide_staff_request(p_client_request_id uuid, p_request_id uuid, p_approve boolean, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; r hr.requests; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'decide_staff_request'); if v_prev is not null then return v_prev; end if;
  select * into r from hr.requests where id = p_request_id for update;
  perform app.require(r.company_id, 'hr.approve');
  if r.requested_by = auth.uid() or r.person_id = app.my_person() then perform app.raise_rule('sod.self_approval', 'nobody approves their own request', '42501'); end if;
  if r.status <> 'pending' then perform app.raise_rule('grant.already_decided', 'already decided', '22023'); end if;
  update hr.requests set status = case when p_approve then 'approved' else 'refused' end, decided_by = auth.uid(), decided_at = now(), decision_note = p_note where id = r.id;
  if p_approve and r.kind = 'leave' then
    insert into hr.attendance (person_id, company_id, work_date, status, marked_by)
    select r.person_id, r.company_id, d::date, 'L', auth.uid() from generate_series(r.from_date, r.to_date, interval '1 day') d
    on conflict (person_id, company_id, work_date) do update set status = 'L';
  end if;
  perform app.enqueue_message(jsonb_build_object('company_id', r.company_id, 'event', 'hr.request_decided', 'template', 'request_decided', 'person_id', r.person_id,
    'doc_type', 'hr.requests', 'doc_id', r.id, 'stage', 'decided', 'params', jsonb_build_object('kind', r.kind, 'decision', case when p_approve then 'approved' else 'refused' end)));
  v_res := jsonb_build_object('id', r.id, 'approved', p_approve);
  return app.request_done(p_client_request_id, 'decide_staff_request', v_res);
end $$;

-- Cash given to staff (an advance): posts a payment voucher and records it against the person for recovery.
create or replace function api.give_staff_cash(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_fy uuid; v_no text; v_voucher uuid; v_date date := (p ->> 'date')::date; v_amount numeric := (p ->> 'amount')::numeric; v_res jsonb; v_cash acct.accounts;
begin
  v_prev := app.request_seen(p_client_request_id, 'give_staff_cash'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'cash_book.create');
  perform app.check_backdate(v_company, v_date);
  v_fy := app.fy_for(v_company, v_date);
  select * into v_cash from acct.accounts where id = (p ->> 'account_id')::uuid and company_id = v_company and kind = 'cash';
  if v_cash.id is null then perform app.raise_rule('money.account', 'choose the cash account', '22023'); end if;
  v_no := app.take_doc_number(v_company, null, 'payment', v_fy);
  v_voucher := app.post_voucher(jsonb_build_object('company_id', v_company, 'fy_id', v_fy, 'voucher_type', 'payment', 'doc_no', v_no, 'voucher_date', v_date,
      'narration', 'Cash to staff: ' || coalesce(p ->> 'purpose', 'advance'), 'mode', 'cash', 'client_request_id', p_client_request_id),
    jsonb_build_array(jsonb_build_object('account_id', app.rule_account(v_company, 'payroll.advances'), 'dr', v_amount), jsonb_build_object('account_id', v_cash.id, 'cr', v_amount)));
  insert into hr.cash_given (person_id, company_id, given_on, amount, purpose, voucher_id, request_id)
  values ((p ->> 'person_id')::uuid, v_company, v_date, v_amount, coalesce(p ->> 'purpose', 'advance'), v_voucher, nullif(p ->> 'request_id', '')::uuid);
  v_res := jsonb_build_object('voucher_id', v_voucher, 'doc_no', v_no);
  return app.request_done(p_client_request_id, 'give_staff_cash', v_res);
end $$;

-- Prepare (or re-prepare) a draft payroll run for a company and month from attendance, profiles, allowances and advances.
create or replace function api.prepare_payroll(p_client_request_id uuid, p_company_id uuid, p_month date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_run uuid; v_month date := date_trunc('month', p_month)::date; v_days int; r record; v_basic numeric; v_hourly numeric; v_ot numeric; v_allow numeric; v_ded numeric;
  v_adv numeric; v_gross numeric; v_net numeric; v_round numeric; v_mult numeric := coalesce((app.setting(p_company_id, 'payroll.ot_multiplier', p_month))::text::numeric, 2); v_res jsonb; v_status text;
begin
  v_prev := app.request_seen(p_client_request_id, 'prepare_payroll'); if v_prev is not null then return v_prev; end if;
  perform app.require(p_company_id, 'payroll.run');
  v_days := extract(day from (v_month + interval '1 month - 1 day'))::int;
  select id, status into v_run, v_status from hr.payroll_runs where company_id = p_company_id and month = v_month for update;
  if v_status is not null and v_status <> 'draft' then perform app.raise_rule('payroll.month_locked', 'this month''s payroll is already approved', '22023'); end if;
  if v_run is null then
    insert into hr.payroll_runs (company_id, month, prepared_by) values (p_company_id, v_month, auth.uid()) returning id into v_run;
  else
    delete from hr.payslips where run_id = v_run;
    update hr.payroll_runs set prepared_by = auth.uid(), prepared_at = now() where id = v_run;
  end if;
  for r in
    select sp.*, pe.name,
           count(*) filter (where a.status = 'P') as p_days, count(*) filter (where a.status = 'H') as h_days, count(*) filter (where a.status = 'L') as l_days,
           count(*) filter (where a.status = 'WO') as wo_days, coalesce(sum(a.ot_hours), 0) as ot
    from hr.staff_profiles sp join master.people pe on pe.id = sp.person_id
    left join hr.attendance a on a.person_id = sp.person_id and a.company_id = p_company_id and a.work_date >= v_month and a.work_date < v_month + interval '1 month'
    where sp.active and sp.pay_company_id = p_company_id
    group by sp.person_id, pe.name
  loop
    -- Payable days: present + half days / 2 + weekly offs (approved leave is unpaid until a paid-leave setting exists).
    v_basic := case when r.pay_basis = 'daily' then round(coalesce(r.daily_wage, 0) * (r.p_days + r.h_days * 0.5), 2)
                    else round(coalesce(r.monthly_salary, 0) * (r.p_days + r.h_days * 0.5 + r.wo_days) / v_days, 2) end;
    v_hourly := case when r.pay_basis = 'daily' then coalesce(r.daily_wage, 0) / 8 else coalesce(r.monthly_salary, 0) / v_days / 8 end;
    v_ot := round(r.ot * v_hourly * v_mult, 2);
    select coalesce(sum(amount) filter (where kind = 'allowance'), 0), coalesce(sum(amount) filter (where kind = 'deduction'), 0) into v_allow, v_ded
    from hr.allowances where person_id = r.person_id and company_id = p_company_id and from_month <= v_month and (to_month is null or to_month >= v_month);
    select coalesce(sum(amount), 0) into v_adv from hr.cash_given where person_id = r.person_id and company_id = p_company_id and recovered_run_id is null and given_on < v_month + interval '1 month';
    v_gross := v_basic + v_allow + v_ot;
    v_adv := least(v_adv, greatest(v_gross - v_ded, 0));
    v_net := v_gross - v_ded - v_adv;
    v_round := round(v_net) - v_net;
    insert into hr.payslips (run_id, person_id, company_id, month, days_in_month, present, half_days, leave_days, weekly_off, payable_days, ot_hours, basic, allowances, ot_pay, gross,
                             advance_recovery, deductions, round_off, net, lines)
    values (v_run, r.person_id, p_company_id, v_month, v_days, r.p_days, r.h_days, r.l_days, r.wo_days, r.p_days + r.h_days * 0.5 + case when r.pay_basis = 'monthly' then r.wo_days else 0 end,
            r.ot, v_basic, v_allow, v_ot, v_gross, v_adv, v_ded, v_round, v_net + v_round,
            jsonb_build_object('ot_multiplier', v_mult, 'pay_basis', r.pay_basis));
  end loop;
  update hr.payroll_runs set totals = (select jsonb_build_object('people', count(*), 'gross', coalesce(sum(gross), 0), 'net', coalesce(sum(net), 0), 'advance_recovery', coalesce(sum(advance_recovery), 0))
                                       from hr.payslips where run_id = v_run) where id = v_run;
  v_res := jsonb_build_object('run_id', v_run);
  return app.request_done(p_client_request_id, 'prepare_payroll', v_res);
end $$;

-- Approve and post (by someone other than the preparer): GL, advances recovered, payslip-ready messages (no amounts).
create or replace function api.approve_payroll(p_client_request_id uuid, p_run_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; r hr.payroll_runs; v_fy uuid; v_no text; v_voucher uuid; v_gross numeric; v_net numeric; v_adv numeric; v_ded numeric; v_round numeric; v_res jsonb; s record; v_date date;
begin
  v_prev := app.request_seen(p_client_request_id, 'approve_payroll'); if v_prev is not null then return v_prev; end if;
  select * into r from hr.payroll_runs where id = p_run_id for update;
  perform app.require(r.company_id, 'payroll.run');
  if r.status <> 'draft' then perform app.raise_rule('payroll.month_locked', 'already approved', '22023'); end if;
  if r.prepared_by = auth.uid() then perform app.raise_rule('sod.self_approval', 'the person who prepared the payroll cannot approve it', '42501'); end if;
  select coalesce(sum(gross), 0), coalesce(sum(net), 0), coalesce(sum(advance_recovery), 0), coalesce(sum(deductions), 0), coalesce(sum(round_off), 0)
    into v_gross, v_net, v_adv, v_ded, v_round from hr.payslips where run_id = r.id;
  v_date := (r.month + interval '1 month - 1 day')::date;
  if v_gross > 0 then
    v_fy := app.fy_for(r.company_id, v_date);
    v_no := 'PAY/' || to_char(r.month, 'YYYY-MM');
    v_voucher := app.post_voucher(jsonb_build_object('company_id', r.company_id, 'fy_id', v_fy, 'voucher_type', 'payroll', 'doc_no', v_no, 'voucher_date', v_date,
        'narration', 'Payroll ' || to_char(r.month, 'Mon YYYY'), 'source_table', 'hr.payroll_runs', 'source_id', r.id, 'client_request_id', p_client_request_id),
      (select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(jsonb_build_array(
        jsonb_build_object('account_id', app.rule_account(r.company_id, 'payroll.salary_expense'), 'dr', v_gross),
        jsonb_build_object('account_id', case when v_round <> 0 then app.rule_account(r.company_id, 'round_off') end, 'dr', greatest(v_round, 0), 'cr', greatest(-v_round, 0)),
        jsonb_build_object('account_id', case when v_adv > 0 then app.rule_account(r.company_id, 'payroll.advances') end, 'cr', v_adv),
        jsonb_build_object('account_id', case when v_ded > 0 then app.rule_account(r.company_id, 'payroll.deductions') end, 'cr', v_ded),
        jsonb_build_object('account_id', app.rule_account(r.company_id, 'payroll.salary_payable'), 'cr', v_net))) e where e ->> 'account_id' is not null));
  end if;
  update hr.cash_given c set recovered_run_id = r.id from hr.payslips s
   where s.run_id = r.id and s.person_id = c.person_id and c.company_id = r.company_id and c.recovered_run_id is null and s.advance_recovery > 0;
  update hr.payroll_runs set status = 'posted', approved_by = auth.uid(), approved_at = now(), voucher_id = v_voucher where id = r.id;
  for s in select person_id from hr.payslips where run_id = r.id loop
    perform app.enqueue_message(jsonb_build_object('company_id', r.company_id, 'event', 'hr.payslip_ready', 'template', 'payslip_ready', 'person_id', s.person_id,
      'doc_type', 'hr.payroll_runs', 'doc_id', r.id, 'stage', 'payslip_ready', 'params', jsonb_build_object('month', to_char(r.month, 'FMMonth YYYY'))));
  end loop;
  v_res := jsonb_build_object('run_id', r.id, 'voucher_id', v_voucher);
  return app.request_done(p_client_request_id, 'approve_payroll', v_res);
end $$;

-- Payslip detail (logged as a sensitive view when it is someone else's).
create or replace function api.payslip(p_payslip_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s hr.payslips; v_name text; v_company text;
begin
  select * into s from hr.payslips where id = p_payslip_id;
  if s.id is null then return null; end if;
  if s.person_id is distinct from app.my_person() then
    perform app.require(s.company_id, 'payroll.run');
    perform app.log_event('view_sensitive', jsonb_build_object('entity', 'payslip', 'id', s.id));
  end if;
  select name into v_name from master.people where id = s.person_id;
  select legal_name into v_company from core.companies where id = s.company_id;
  return to_jsonb(s) || jsonb_build_object('person_name', v_name, 'company_name', v_company, 'net_in_words', app.amount_in_words(s.net));
end $$;

-- Staff app home: own pay, attendance this month, requests (never other people's data).
create or replace function api.staff_me() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_person uuid := app.my_person(); pe master.people; sp hr.staff_profiles; s hr.payslips; v_company text; v_att jsonb;
begin
  if v_person is null then return null; end if;
  select * into pe from master.people where id = v_person;
  select * into sp from hr.staff_profiles where person_id = v_person;
  select short_name into v_company from core.companies where id = sp.pay_company_id;
  select x.* into s from hr.payslips x join hr.payroll_runs r on r.id = x.run_id and r.status = 'posted' where x.person_id = v_person order by x.month desc limit 1;
  select jsonb_build_object('present', count(*) filter (where status in ('P')) + count(*) filter (where status = 'H') * 0.5, 'leave', count(*) filter (where status = 'L'), 'marked', count(*))
    into v_att from hr.attendance where person_id = v_person and work_date >= date_trunc('month', current_date);
  return jsonb_build_object(
    'person_code', coalesce(pe.person_code, ''), 'display_name', pe.name, 'company_label', coalesce(v_company, ''), 'designation', sp.designation,
    'pay_month_label', case when s.id is not null then to_char(s.month, 'FMMonth YYYY') end, 'payslip_id', s.id,
    'net_pay', s.net, 'present_days', s.payable_days, 'working_days', s.days_in_month, 'leave_days', s.leave_days, 'advance_cut', s.advance_recovery,
    'attendance', v_att,
    'requests', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'kind', q.kind, 'status', q.status, 'created_at', q.created_at, 'from_date', q.from_date, 'to_date', q.to_date, 'amount', q.amount) order by q.created_at desc)
                          from (select * from hr.requests where person_id = v_person order by created_at desc limit 10) q), '[]'::jsonb));
end $$;

-- ─────────── Views ───────────
create or replace view api.staff with (security_invoker = true) as
select pe.id as person_id, pe.person_code, pe.name, pe.status, case when pe.phone is null then null else '••' || right(pe.phone, 4) end as phone_masked,
       pe.user_id is not null as has_login, sp.designation, sp.department_id, d.name as department_name, sp.pay_company_id, c.short_name as pay_company_name, sp.pay_basis, sp.join_date, sp.language, sp.active
from master.people pe left join hr.staff_profiles sp on sp.person_id = pe.id left join core.departments d on d.id = sp.department_id left join core.companies c on c.id = sp.pay_company_id;
create or replace view api.attendance with (security_invoker = true) as
select a.id, a.person_id, pe.name as person_name, a.company_id, a.work_date, a.status, a.hours, a.ot_hours from hr.attendance a join master.people pe on pe.id = a.person_id;
create or replace view api.staff_requests with (security_invoker = true) as
select q.id, q.person_id, pe.name as person_name, q.company_id, q.kind, q.from_date, q.to_date, q.amount, q.reason, q.status, q.decided_at, q.decision_note, q.created_at, q.requested_by
from hr.requests q join master.people pe on pe.id = q.person_id;
create or replace view api.payroll_runs with (security_invoker = true) as
select r.id, r.company_id, r.month, r.status, r.prepared_by, pp.display_name as prepared_by_name, r.prepared_at, r.approved_by, ap.display_name as approved_by_name, r.approved_at, r.voucher_id, r.totals
from hr.payroll_runs r left join core.user_profiles pp on pp.user_id = r.prepared_by left join core.user_profiles ap on ap.user_id = r.approved_by;
create or replace view api.payslips with (security_invoker = true) as
select s.id, s.run_id, s.person_id, pe.name as person_name, s.company_id, s.month, s.days_in_month, s.present, s.half_days, s.leave_days, s.weekly_off, s.payable_days, s.ot_hours,
       s.basic, s.allowances, s.ot_pay, s.gross, s.advance_recovery, s.deductions, s.round_off, s.net, r.status as run_status
from hr.payslips s join master.people pe on pe.id = s.person_id join hr.payroll_runs r on r.id = s.run_id;
create or replace view api.cash_given with (security_invoker = true) as
select c.id, c.person_id, pe.name as person_name, c.company_id, c.given_on, c.amount, c.purpose, c.voucher_id, c.recovered_run_id is not null as recovered
from hr.cash_given c join master.people pe on pe.id = c.person_id;

-- Link a sign-in to a staff record (so the staff app shows their own data).
create or replace function api.link_person_user(p_client_request_id uuid, p_person_id uuid, p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'link_person_user'); if v_prev is not null then return v_prev; end if;
  perform app.require(null, 'users.manage');
  update master.people set user_id = null where user_id = p_user_id and id <> p_person_id;
  update master.people set user_id = p_user_id where id = p_person_id;
  v_res := jsonb_build_object('ok', true);
  return app.request_done(p_client_request_id, 'link_person_user', v_res);
end $$;

-- Add a person to the group staff list by hand (imports create them too).
create or replace function api.add_person(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'add_person'); if v_prev is not null then return v_prev; end if;
  perform app.require(null, 'hr.create');
  insert into master.people (person_code, name, pan, phone, dob, aadhaar_last4, status)
  values (nullif(upper(p ->> 'person_code'), ''), p ->> 'name', nullif(upper(p ->> 'pan'), ''), app.imp_phone(p ->> 'phone'), nullif(p ->> 'dob', '')::date,
          nullif(right(regexp_replace(coalesce(p ->> 'aadhaar', ''), '\D', '', 'g'), 4), ''), 'active')
  returning id into v_id;
  if nullif(p ->> 'company_id', '') is not null then
    insert into master.person_companies (person_id, company_id, employee_code, is_pay_company) values (v_id, (p ->> 'company_id')::uuid, nullif(p ->> 'employee_code', ''), true);
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'add_person', v_res);
end $$;

grant select on all tables in schema api to authenticated;
revoke all on all functions in schema api from public, anon;
grant execute on all functions in schema api to authenticated;
grant execute on function api.log_sign_in_failure(text) to anon;
revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;
notify pgrst, 'reload schema';

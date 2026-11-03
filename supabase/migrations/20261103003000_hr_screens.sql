-- 20261103003000_hr_screens.sql
-- Phase 3 HR screens: one RPC to add or edit a staff member (person + profile in one transaction, staff IDs given by
-- the app and never reused), the staff list with KYC completeness (Aadhaar and bank masked), a logged salary read for
-- payroll users, a read view of allowances, cash to staff under the same cash limit as any other cash payment, and a
-- clear refusal when a request does not exist. Additive: new objects and function replacements only.

-- ─────────── Staff IDs: given by the app, never reused ───────────
create sequence if not exists hr.staff_code_seq;
revoke all on sequence hr.staff_code_seq from public, anon, authenticated;

create or replace function app.next_staff_code() returns text
language plpgsql volatile security definer set search_path = '' as $$
declare v_code text;
begin
  loop
    v_code := 'EMP-' || lpad(nextval('hr.staff_code_seq')::text, 4, '0');
    exit when not exists (select 1 from master.people where person_code = v_code);
  end loop;
  return v_code;
end $$;

-- ─────────── Add or edit a staff member ───────────
-- p: {person_id?, name, person_code?, phone, dob, aadhaar (only the last 4 digits are kept), pan, designation,
--     department_id, pay_company_id, pay_basis monthly|daily, monthly_salary?, daily_wage?, join_date, language, bank_last4}
-- Salary keys are only accepted with the Payroll right for the pay company.
create or replace function api.save_staff(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_id uuid := nullif(p ->> 'person_id', '')::uuid; v_pay uuid := nullif(p ->> 'pay_company_id', '')::uuid;
  v_code text; v_phone text; v_aadhaar text; v_basis text := coalesce(nullif(p ->> 'pay_basis', ''), 'monthly'); v_res jsonb; v_old master.people;
begin
  v_prev := app.request_seen(p_client_request_id, 'save_staff'); if v_prev is not null then return v_prev; end if;
  if v_id is null then perform app.require(null, 'hr.create'); end if;
  if v_pay is null then perform app.raise_rule('staff.pay_company', 'choose the company that issues the payslip', '22023'); end if;
  perform app.require(v_pay, 'hr.edit');
  if (nullif(p ->> 'monthly_salary', '') is not null or nullif(p ->> 'daily_wage', '') is not null) then perform app.require(v_pay, 'payroll.run'); end if;
  if coalesce(length(trim(p ->> 'name')), 0) < 2 then perform app.raise_rule('staff.name', 'enter the full name as on the ID', '22023'); end if;
  if coalesce(length(trim(p ->> 'designation')), 0) < 2 then perform app.raise_rule('staff.designation', 'every staff member needs a designation', '22023'); end if;
  if v_basis not in ('monthly', 'daily') then perform app.raise_rule('staff.pay_basis', 'choose monthly or daily pay', '22023'); end if;
  if coalesce(nullif(p ->> 'monthly_salary', '')::numeric, 0) < 0 or coalesce(nullif(p ->> 'daily_wage', '')::numeric, 0) < 0 then
    perform app.raise_rule('money.amount', 'enter an amount of zero or more', '22023');
  end if;
  v_phone := app.imp_phone(p ->> 'phone');
  if nullif(trim(coalesce(p ->> 'phone', '')), '') is not null and v_phone is null then perform app.raise_rule('staff.phone', 'enter a 10-digit Indian mobile number', '22023'); end if;
  v_aadhaar := regexp_replace(coalesce(p ->> 'aadhaar', ''), '\D', '', 'g');
  if v_aadhaar <> '' and length(v_aadhaar) not in (4, 12) then perform app.raise_rule('staff.aadhaar', 'enter the 12-digit Aadhaar or its last 4 digits', '22023'); end if;
  v_aadhaar := nullif(right(v_aadhaar, 4), '');

  if v_id is null then
    v_code := coalesce(nullif(upper(trim(p ->> 'person_code')), ''), app.next_staff_code());
    insert into master.people (person_code, name, pan, phone, dob, aadhaar_last4, status)
    values (v_code, trim(p ->> 'name'), nullif(upper(trim(p ->> 'pan')), ''), v_phone, nullif(p ->> 'dob', '')::date, v_aadhaar, 'active')
    returning id into v_id;
  else
    select * into v_old from master.people where id = v_id for update;
    if v_old.id is null then perform app.raise_rule('staff.person', 'this staff member was not found', 'P0002'); end if;
    -- Moving someone to another pay company needs the HR right on the company they leave as well.
    perform app.require(sp.pay_company_id, 'hr.edit') from hr.staff_profiles sp where sp.person_id = v_id and sp.pay_company_id is distinct from v_pay and sp.pay_company_id is not null;
    v_code := coalesce(v_old.person_code, app.next_staff_code());
    update master.people set person_code = v_code, name = trim(p ->> 'name'),
      pan = coalesce(nullif(upper(trim(p ->> 'pan')), ''), pan), phone = coalesce(v_phone, phone), dob = coalesce(nullif(p ->> 'dob', '')::date, dob),
      aadhaar_last4 = coalesce(v_aadhaar, aadhaar_last4), status = case when status = 'to_review' then 'active' else status end
    where id = v_id;
  end if;

  update master.person_companies set is_pay_company = false where person_id = v_id and company_id <> v_pay and is_pay_company;
  insert into master.person_companies (person_id, company_id, employee_code, is_pay_company) values (v_id, v_pay, v_code, true)
  on conflict (person_id, company_id) do update set is_pay_company = true, employee_code = coalesce(master.person_companies.employee_code, excluded.employee_code);

  insert into hr.staff_profiles (person_id, designation, department_id, pay_company_id, pay_basis, monthly_salary, daily_wage, join_date, language, bank_last4)
  values (v_id, trim(p ->> 'designation'), nullif(p ->> 'department_id', '')::uuid, v_pay, v_basis,
          nullif(p ->> 'monthly_salary', '')::numeric, nullif(p ->> 'daily_wage', '')::numeric, nullif(p ->> 'join_date', '')::date,
          coalesce(nullif(p ->> 'language', ''), 'en'), nullif(right(regexp_replace(coalesce(p ->> 'bank_last4', ''), '\D', '', 'g'), 4), ''))
  on conflict (person_id) do update set designation = excluded.designation, department_id = excluded.department_id, pay_company_id = excluded.pay_company_id,
    pay_basis = excluded.pay_basis,
    monthly_salary = case when nullif(p ->> 'monthly_salary', '') is not null then excluded.monthly_salary else hr.staff_profiles.monthly_salary end,
    daily_wage = case when nullif(p ->> 'daily_wage', '') is not null then excluded.daily_wage else hr.staff_profiles.daily_wage end,
    join_date = coalesce(excluded.join_date, hr.staff_profiles.join_date), language = excluded.language,
    bank_last4 = coalesce(excluded.bank_last4, hr.staff_profiles.bank_last4), active = true;

  v_res := jsonb_build_object('person_id', v_id, 'person_code', v_code);
  return app.request_done(p_client_request_id, 'save_staff', v_res);
end $$;

-- ─────────── Staff list with KYC completeness (masked) ───────────
create or replace function api.staff_kyc() returns table (
  person_id uuid, person_code text, name text, status text, designation text, department_id uuid, department_name text, pay_company_id uuid,
  pay_company_name text, pay_basis text, join_date date, language text, active boolean, has_login boolean, phone_masked text, dob date,
  aadhaar_masked text, pan_masked text, bank_masked text, has_profile boolean, kyc_done int, kyc_needed int)
language sql stable security definer set search_path = '' as $$
  select pe.id, pe.person_code, pe.name, pe.status, sp.designation, sp.department_id, d.name, sp.pay_company_id, c.short_name, sp.pay_basis, sp.join_date,
         sp.language, coalesce(sp.active, false), pe.user_id is not null,
         case when pe.phone is null then null else '••' || right(pe.phone, 4) end, pe.dob,
         case when pe.aadhaar_last4 is null then null else 'XXXX XXXX ' || pe.aadhaar_last4 end,
         case when pe.pan is null then null else 'XXXXX' || right(pe.pan, 5) end,
         case when sp.bank_last4 is null then null else '••' || sp.bank_last4 end,
         sp.person_id is not null,
         ((pe.phone is not null)::int + (pe.dob is not null)::int + (pe.aadhaar_last4 is not null)::int + (pe.pan is not null)::int + (sp.bank_last4 is not null)::int),
         5
  from master.people pe
  left join hr.staff_profiles sp on sp.person_id = pe.id
  left join core.departments d on d.id = sp.department_id
  left join core.companies c on c.id = sp.pay_company_id
  where (sp.pay_company_id is not null and app.can(sp.pay_company_id, 'hr.view'))
     or (sp.pay_company_id is null and app.can(null, 'hr.view'))
     or pe.id = app.my_person()
  order by pe.person_code nulls last, pe.name
$$;

-- ─────────── Salary of one person (payroll right; each view is logged) ───────────
create or replace function api.staff_pay(p_person_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare sp hr.staff_profiles;
begin
  select * into sp from hr.staff_profiles where person_id = p_person_id;
  if sp.person_id is null then return null; end if;
  if sp.person_id is distinct from app.my_person() then
    perform app.require(sp.pay_company_id, 'payroll.run');
    perform app.log_event('view_sensitive', jsonb_build_object('entity', 'staff_pay', 'id', sp.person_id));
  end if;
  return jsonb_build_object('person_id', sp.person_id, 'pay_basis', sp.pay_basis, 'monthly_salary', sp.monthly_salary, 'daily_wage', sp.daily_wage,
                            'bank_masked', case when sp.bank_last4 is null then null else '••' || sp.bank_last4 end);
end $$;

-- ─────────── Allowances and deductions (read) ───────────
create or replace view api.staff_allowances with (security_invoker = true) as
select a.id, a.person_id, pe.person_code, pe.name as person_name, a.company_id, c.short_name as company_name, a.head, a.kind, a.amount, a.from_month, a.to_month, a.note
from hr.allowances a join master.people pe on pe.id = a.person_id join core.companies c on c.id = a.company_id;

-- ─────────── Cash to staff, under the daily cash payment limit ───────────
-- Same rule as any cash payment (§17): above the warn amount to one person in a day it needs a reason Admin sees
-- (or pay by bank). An approved advance request can be paid once.
create or replace function api.give_staff_cash(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_fy uuid; v_no text; v_voucher uuid; v_date date := nullif(p ->> 'date', '')::date;
  v_amount numeric := nullif(p ->> 'amount', '')::numeric; v_res jsonb; v_cash acct.accounts; v_person master.people; v_req hr.requests;
  v_warn_amt numeric; v_today numeric; v_flag text; v_reason text := nullif(trim(coalesce(p ->> 'cash_reason', '')), '');
begin
  v_prev := app.request_seen(p_client_request_id, 'give_staff_cash'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'cash_book.create');
  if v_amount is null or v_amount <= 0 then perform app.raise_rule('money.amount', 'enter an amount above zero', '22023'); end if;
  if v_date is null then perform app.raise_rule('staff.date', 'choose the date', '22023'); end if;
  select * into v_person from master.people where id = nullif(p ->> 'person_id', '')::uuid for update;
  if v_person.id is null then perform app.raise_rule('staff.person', 'choose the staff member', '22023'); end if;
  if nullif(p ->> 'request_id', '') is not null then
    select * into v_req from hr.requests where id = (p ->> 'request_id')::uuid for update;
    if v_req.id is null or v_req.person_id <> v_person.id or v_req.kind <> 'advance' or v_req.status <> 'approved' then
      perform app.raise_rule('staff.request', 'only an approved advance request of this person can be paid', '22023');
    end if;
    if exists (select 1 from hr.cash_given where request_id = v_req.id) then perform app.raise_rule('staff.request_paid', 'this advance request is already paid', '22023'); end if;
  end if;
  perform app.check_backdate(v_company, v_date);
  v_fy := app.fy_for(v_company, v_date);
  select * into v_cash from acct.accounts where id = nullif(p ->> 'account_id', '')::uuid and company_id = v_company and kind = 'cash';
  if v_cash.id is null then perform app.raise_rule('money.account', 'choose the cash account', '22023'); end if;

  v_warn_amt := (app.setting(v_company, 'cash.payment_warn_amount', v_date))::text::numeric;
  if v_warn_amt is null then perform app.raise_rule('cash.limits_not_set', 'set the cash payment limit on Settings first', '22023'); end if;
  select coalesce(sum(c.amount), 0) into v_today from hr.cash_given c join acct.vouchers v on v.id = c.voucher_id
   where c.person_id = v_person.id and c.company_id = v_company and c.given_on = v_date and v.mode = 'cash' and v.status = 'posted';
  if v_today + v_amount > v_warn_amt then
    if coalesce(length(v_reason), 0) < 5 then
      perform app.raise_rule('cash.payment_over_limit', 'cash over the daily limit to one person is not deductible; pay by bank, or give a reason Admin will see', '22023');
    end if;
    v_flag := 'over_limit';
  end if;

  v_no := app.take_doc_number(v_company, null, 'payment', v_fy);
  v_voucher := app.post_voucher(jsonb_build_object('company_id', v_company, 'fy_id', v_fy, 'voucher_type', 'payment', 'doc_no', v_no, 'voucher_date', v_date,
      'narration', 'Cash to staff: ' || coalesce(nullif(p ->> 'purpose', ''), 'advance'), 'mode', 'cash', 'cash_reason', case when v_flag is not null then v_reason end,
      'client_request_id', p_client_request_id),
    jsonb_build_array(jsonb_build_object('account_id', app.rule_account(v_company, 'payroll.advances'), 'dr', v_amount), jsonb_build_object('account_id', v_cash.id, 'cr', v_amount)));
  insert into hr.cash_given (person_id, company_id, given_on, amount, purpose, voucher_id, request_id)
  values (v_person.id, v_company, v_date, v_amount, coalesce(nullif(p ->> 'purpose', ''), 'advance'), v_voucher, v_req.id);
  if v_flag is not null then
    perform app.log_event('admin_action', jsonb_build_object('entity', 'cash_payment_over_limit', 'voucher', v_no, 'reason', v_reason));
  end if;
  v_res := jsonb_build_object('voucher_id', v_voucher, 'doc_no', v_no, 'warning', v_flag);
  return app.request_done(p_client_request_id, 'give_staff_cash', v_res);
end $$;

-- ─────────── Decide a request: refuse clearly when it does not exist ───────────
create or replace function api.decide_staff_request(p_client_request_id uuid, p_request_id uuid, p_approve boolean, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; r hr.requests; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'decide_staff_request'); if v_prev is not null then return v_prev; end if;
  select * into r from hr.requests where id = p_request_id for update;
  if r.id is null then perform app.raise_rule('staff.request_missing', 'this request was not found', 'P0002'); end if;
  perform app.require(r.company_id, 'hr.approve');
  if r.requested_by = auth.uid() or r.person_id = app.my_person() then perform app.raise_rule('sod.self_approval', 'nobody approves their own request', '42501'); end if;
  if r.status <> 'pending' then perform app.raise_rule('grant.already_decided', 'already decided', '22023'); end if;
  update hr.requests set status = case when p_approve then 'approved' else 'refused' end, decided_by = auth.uid(), decided_at = now(), decision_note = p_note where id = r.id;
  if p_approve and r.kind = 'leave' and r.company_id is not null then
    insert into hr.attendance (person_id, company_id, work_date, status, marked_by)
    select r.person_id, r.company_id, d::date, 'L', auth.uid() from generate_series(r.from_date, r.to_date, interval '1 day') d
    on conflict (person_id, company_id, work_date) do update set status = 'L';
  end if;
  perform app.enqueue_message(jsonb_build_object('company_id', r.company_id, 'event', 'hr.request_decided', 'template', 'request_decided', 'person_id', r.person_id,
    'doc_type', 'hr.requests', 'doc_id', r.id, 'stage', 'decided', 'params', jsonb_build_object('kind', r.kind, 'decision', case when p_approve then 'approved' else 'refused' end)));
  v_res := jsonb_build_object('id', r.id, 'approved', p_approve);
  return app.request_done(p_client_request_id, 'decide_staff_request', v_res);
end $$;

grant select on api.staff_allowances to authenticated;
revoke all on function api.save_staff(uuid, jsonb), api.staff_kyc(), api.staff_pay(uuid), app.next_staff_code() from public, anon;
grant execute on function api.save_staff(uuid, jsonb), api.staff_kyc(), api.staff_pay(uuid), app.next_staff_code() to authenticated;
notify pgrst, 'reload schema';

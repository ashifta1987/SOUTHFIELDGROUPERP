-- 20261103003200_staff_help_msg.sql
-- Phase 3, last slice: the staff app, the WhatsApp & email admin screen and the Help panel.
--  * Staff requests carry the details the staff app asks for (leave type, half day; advance: pay back over, needed by,
--    paid in). They are for the approver; payroll still recovers what was actually given (hr.cash_given).
--  * staff_me() also returns the person's own masked details and the list of their posted payslips (never drafts).
--  * Admin adds or edits message templates (a template that was already submitted gets a new draft version). Staff
--    templates (events hr.*) may never carry amounts, salary, KYC or bank details (§WA-7).
--  * The DEV/preview allow-list (§WA-4.7) only takes numbers that belong to a contact with recorded WhatsApp consent
--    (a party contact with consent, or a staff member with their own sign-in). A typed number is refused.
--  * Read view of inbound WhatsApp messages (number masked).
-- Additive: new columns, function replacements and views (columns appended at the end only).

-- ─────────── Staff requests: details asked in the staff app ───────────
alter table hr.requests add column if not exists leave_type text check (leave_type is null or leave_type in ('casual', 'sick', 'unpaid'));
alter table hr.requests add column if not exists half_day boolean not null default false;
alter table hr.requests add column if not exists repay_months int check (repay_months is null or repay_months between 1 and 12);
alter table hr.requests add column if not exists needed_by date;
alter table hr.requests add column if not exists paid_in text check (paid_in is null or paid_in in ('cash', 'bank'));

-- The staff app: a person asks for leave or an advance for themselves.
-- p: {kind leave|advance, from_date, to_date, half_day, leave_type casual|sick|unpaid, amount, repay_months, needed_by, paid_in cash|bank, reason}
create or replace function api.submit_staff_request(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_person uuid := app.my_person(); v_id uuid; v_company uuid; v_res jsonb;
  v_kind text := p ->> 'kind'; v_from date := nullif(p ->> 'from_date', '')::date; v_to date := nullif(p ->> 'to_date', '')::date;
  v_half boolean := coalesce(nullif(p ->> 'half_day', '')::boolean, false);
begin
  v_prev := app.request_seen(p_client_request_id, 'submit_staff_request'); if v_prev is not null then return v_prev; end if;
  if v_person is null then perform app.raise_rule('staff.not_linked', 'your sign-in is not linked to a staff record yet; ask Admin', '42501'); end if;
  if v_kind is null or v_kind not in ('leave', 'advance') then perform app.raise_rule('staff.kind', 'choose leave or advance', '22023'); end if;
  if coalesce(length(trim(p ->> 'reason')), 0) < 3 then perform app.raise_rule('staff.reason', 'say why in a few words', '22023'); end if;
  perform 1 from master.people where id = v_person for update;   -- one request at a time per person
  select pay_company_id into v_company from hr.staff_profiles where person_id = v_person;
  if v_kind = 'leave' then
    if v_half then v_to := coalesce(v_to, v_from); end if;
    if v_from is null or v_to is null or v_to < v_from then perform app.raise_rule('staff.dates', 'choose the leave dates', '22023'); end if;
    if v_half and v_to <> v_from then perform app.raise_rule('staff.half_day', 'a half day is one date only', '22023'); end if;
    if nullif(p ->> 'leave_type', '') is not null and p ->> 'leave_type' not in ('casual', 'sick', 'unpaid') then
      perform app.raise_rule('staff.leave_type', 'choose casual, sick or unpaid leave', '22023');
    end if;
  else
    if coalesce(nullif(p ->> 'amount', '')::numeric, 0) <= 0 then perform app.raise_rule('staff.amount', 'enter the amount', '22023'); end if;
    if nullif(p ->> 'repay_months', '') is not null and (p ->> 'repay_months')::int not between 1 and 12 then
      perform app.raise_rule('staff.repay_months', 'pay back over 1 to 12 months', '22023');
    end if;
    if nullif(p ->> 'needed_by', '') is not null and (p ->> 'needed_by')::date < (now() at time zone 'Asia/Kolkata')::date then
      perform app.raise_rule('staff.needed_by', 'the date needed cannot be in the past', '22023');
    end if;
    if nullif(p ->> 'paid_in', '') is not null and p ->> 'paid_in' not in ('cash', 'bank') then
      perform app.raise_rule('staff.paid_in', 'choose cash or bank', '22023');
    end if;
  end if;
  insert into hr.requests (person_id, company_id, kind, from_date, to_date, amount, reason, requested_by, leave_type, half_day, repay_months, needed_by, paid_in)
  values (v_person, v_company, v_kind,
          case when v_kind = 'leave' then v_from end, case when v_kind = 'leave' then v_to end,
          case when v_kind = 'advance' then round(nullif(p ->> 'amount', '')::numeric, 2) end,
          left(trim(p ->> 'reason'), 500), auth.uid(),
          case when v_kind = 'leave' then nullif(p ->> 'leave_type', '') end,
          v_kind = 'leave' and v_half,
          case when v_kind = 'advance' then nullif(p ->> 'repay_months', '')::int end,
          case when v_kind = 'advance' then nullif(p ->> 'needed_by', '')::date end,
          case when v_kind = 'advance' then nullif(p ->> 'paid_in', '') end)
  returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'submit_staff_request', v_res);
end $$;

create or replace view api.staff_requests with (security_invoker = true) as
select q.id, q.person_id, pe.name as person_name, q.company_id, q.kind, q.from_date, q.to_date, q.amount, q.reason, q.status, q.decided_at, q.decision_note, q.created_at, q.requested_by,
       q.leave_type, q.half_day, q.repay_months, q.needed_by, q.paid_in
from hr.requests q join master.people pe on pe.id = q.person_id;

-- Staff app home: own pay, attendance this month, own masked details, posted payslips and requests (never other people's data).
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
    'person_id', pe.id, 'person_code', coalesce(pe.person_code, ''), 'display_name', pe.name, 'company_label', coalesce(v_company, ''), 'designation', sp.designation,
    'pay_month_label', case when s.id is not null then to_char(s.month, 'FMMonth YYYY') end, 'payslip_id', s.id,
    'net_pay', s.net, 'present_days', s.payable_days, 'working_days', s.days_in_month, 'leave_days', s.leave_days, 'advance_cut', s.advance_recovery,
    'attendance', v_att,
    'phone_masked', case when pe.phone is null then null else '••' || right(pe.phone, 4) end,
    'bank_masked', case when sp.bank_last4 is null then null else '••' || sp.bank_last4 end,
    'language', coalesce(sp.language, 'en'), 'join_date', sp.join_date, 'pay_basis', sp.pay_basis,
    'kyc_done', ((pe.phone is not null)::int + (pe.dob is not null)::int + (pe.aadhaar_last4 is not null)::int + (pe.pan is not null)::int + (sp.bank_last4 is not null)::int),
    'kyc_needed', 5,
    'payslips', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'month', x.month, 'company_label', c.short_name) order by x.month desc, c.short_name)
                          from hr.payslips x join hr.payroll_runs r on r.id = x.run_id and r.status = 'posted' left join core.companies c on c.id = x.company_id
                          where x.person_id = v_person), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'kind', q.kind, 'status', q.status, 'created_at', q.created_at, 'from_date', q.from_date, 'to_date', q.to_date,
                                                              'amount', q.amount, 'leave_type', q.leave_type, 'half_day', q.half_day, 'decision_note', q.decision_note) order by q.created_at desc)
                          from (select * from hr.requests where person_id = v_person order by created_at desc limit 10) q), '[]'::jsonb));
end $$;

-- ─────────── WhatsApp templates (Admin) ───────────
-- p: {id?, name, language en|ml|ta|hi, category utility|marketing|authentication, event, header_type none|text|document, body, params [names], active}
create or replace function api.upsert_template(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; t msg.templates; v_res jsonb; v_params jsonb := coalesce(p -> 'params', '[]'::jsonb);
  v_event text := trim(coalesce(p ->> 'event', '')); v_body text := trim(coalesce(p ->> 'body', ''));
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_template'); if v_prev is not null then return v_prev; end if;
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'Admin only', '42501'); end if;
  if jsonb_typeof(v_params) <> 'array' then perform app.raise_rule('msg.template_params', 'parameters must be a list of names', '22023'); end if;
  if length(v_body) < 5 or v_event = '' then perform app.raise_rule('msg.template_body', 'a template needs an event and a message body', '22023'); end if;
  if (select count(distinct m[1]) from regexp_matches(v_body, '\{\{([0-9]+)\}\}', 'g') m) <> jsonb_array_length(v_params) then
    perform app.raise_rule('msg.template_params', 'the body must have one {{n}} for each parameter', '22023');
  end if;
  -- Staff messages link to the staff app; they never carry salary, amounts, KYC or bank details (§WA-7).
  if v_event like 'hr.%' and (v_body ~ '₹|[Rr]s\.?\s*[0-9]' or v_body ~* '(salary|aadhaar|account no|ifsc|\mpan\M)'
       or exists (select 1 from jsonb_array_elements_text(v_params) x where x ~* '(salary|net|gross|amount|pay|bank|account|ifsc|aadhaar|pan|kyc|wage)')) then
    perform app.raise_rule('msg.staff_template_private', 'staff messages may not carry amounts, salary, KYC or bank details', '22023');
  end if;
  if v_id is not null then
    select * into t from msg.templates where id = v_id for update;
    if t.id is null then perform app.raise_rule('msg.template_missing', 'that template does not exist', 'P0002'); end if;
  end if;
  if t.id is not null and t.approval_status = 'draft' then
    update msg.templates set name = coalesce(nullif(p ->> 'name', ''), name), language = coalesce(nullif(p ->> 'language', ''), language),
      category = coalesce(nullif(p ->> 'category', ''), category), event = v_event, header_type = coalesce(nullif(p ->> 'header_type', ''), header_type),
      body = v_body, params = v_params, active = coalesce((p ->> 'active')::boolean, active)
    where id = t.id;
  elsif t.id is not null then
    -- Submitted or approved at Meta: the change becomes a new draft version; the approved one keeps working.
    insert into msg.templates (name, language, category, event, header_type, body, params, approval_status, version, active)
    values (t.name, t.language, coalesce(nullif(p ->> 'category', ''), t.category), v_event, coalesce(nullif(p ->> 'header_type', ''), t.header_type), v_body, v_params, 'draft',
            (select max(version) + 1 from msg.templates where name = t.name and language = t.language), true)
    returning id into v_id;
  else
    insert into msg.templates (name, language, category, event, header_type, body, params, approval_status, active)
    values (lower(trim(p ->> 'name')), coalesce(nullif(p ->> 'language', ''), 'en'), coalesce(nullif(p ->> 'category', ''), 'utility'), v_event,
            coalesce(nullif(p ->> 'header_type', ''), 'none'), v_body, v_params, 'draft', coalesce((p ->> 'active')::boolean, true))
    returning id into v_id;
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_template', v_res);
end $$;

-- ─────────── Allow-list: only numbers that belong to a consenting contact ───────────
create or replace function app.consented_number(p_number text) returns text
language sql stable security definer set search_path = '' as $$
  select case when app.is_admin() then coalesce(
    (select 'party:' || pa.legal_name from master.party_contacts c join master.parties pa on pa.id = c.party_id
      where c.whatsapp = p_number and c.whatsapp_consent order by c.is_primary desc limit 1),
    (select 'staff:' || pe.name from master.people pe where pe.phone = p_number and pe.user_id is not null and pe.status = 'active' limit 1)) end
$$;

create or replace function api.set_allow_list(p_client_request_id uuid, p_number text, p_note text, p_remove boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_number text := app.imp_phone(p_number);
begin
  v_prev := app.request_seen(p_client_request_id, 'set_allow_list'); if v_prev is not null then return v_prev; end if;
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'Admin only', '42501'); end if;
  if v_number is null then perform app.raise_rule('msg.bad_number', 'enter a 10-digit Indian mobile number', '22023'); end if;
  if coalesce(p_remove, false) then
    delete from msg.allow_list where number = v_number;
  else
    if app.consented_number(v_number) is null then
      perform app.raise_rule('msg.not_consented', 'this number is not a contact who agreed to WhatsApp messages', '22023');
    end if;
    insert into msg.allow_list (number, note) values (v_number, nullif(trim(p_note), '')) on conflict (number) do update set note = excluded.note;
  end if;
  v_res := jsonb_build_object('ok', true, 'number', v_number);
  return app.request_done(p_client_request_id, 'set_allow_list', v_res);
end $$;

create or replace view api.msg_allow_list with (security_invoker = true) as
select a.number, a.note, '••' || right(a.number, 4) as number_masked, split_part(app.consented_number(a.number), ':', 1) as belongs_to_kind,
       nullif(substr(app.consented_number(a.number), strpos(app.consented_number(a.number), ':') + 1), '') as belongs_to
from msg.allow_list a;

create or replace view api.msg_inbound with (security_invoker = true) as
select i.id, i.company_id, '••' || right(i.from_number, 4) as from_masked, i.kind, i.body, i.party_id, p.legal_name as party_name, i.window_expires_at,
       i.handled_at, i.received_at
from msg.inbound i left join master.parties p on p.id = i.party_id;

grant select on api.staff_requests, api.msg_allow_list, api.msg_inbound to authenticated;
revoke all on function api.submit_staff_request(uuid, jsonb), api.staff_me(), api.upsert_template(uuid, jsonb), api.set_allow_list(uuid, text, text, boolean), app.consented_number(text) from public, anon;
grant execute on function api.submit_staff_request(uuid, jsonb), api.staff_me(), api.upsert_template(uuid, jsonb), api.set_allow_list(uuid, text, text, boolean), app.consented_number(text) to authenticated;
notify pgrst, 'reload schema';

-- 20261103002700_duties.sql
-- Phase 3: daily duties and rotation between the companies (staff work for either company; each day's duty says
-- which company and place they work for, so hours for the other company are known). Additive.
create table hr.duties (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references master.people (id),
  company_id uuid not null references core.companies (id),
  place_id uuid references core.places (id),
  duty_date date not null,
  duty text not null,
  shift text check (shift in ('day', 'night', 'general')),
  assigned_by uuid references auth.users (id),
  assigned_at timestamptz not null default now(),
  unique (person_id, duty_date)
);
create index on hr.duties (company_id, duty_date);
create trigger audit_row after insert or update or delete on hr.duties for each row execute function app.audit_trigger();
alter table hr.duties enable row level security;
revoke all on hr.duties from anon, authenticated;
grant select on hr.duties to authenticated;
create policy duties_read on hr.duties for select to authenticated using (app.can(company_id, 'hr.view') or person_id = app.my_person());

create or replace function api.set_duties(p_client_request_id uuid, p_date date, p_entries jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_n int; e jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_duties'); if v_prev is not null then return v_prev; end if;
  for e in select * from jsonb_array_elements(p_entries) loop
    perform app.require((e ->> 'company_id')::uuid, 'hr.create');
  end loop;
  insert into hr.duties (person_id, company_id, place_id, duty_date, duty, shift, assigned_by)
  select (e ->> 'person_id')::uuid, (e ->> 'company_id')::uuid, nullif(e ->> 'place_id', '')::uuid, p_date, e ->> 'duty', nullif(e ->> 'shift', ''), auth.uid()
  from jsonb_array_elements(p_entries) e
  on conflict (person_id, duty_date) do update set company_id = excluded.company_id, place_id = excluded.place_id, duty = excluded.duty, shift = excluded.shift, assigned_by = excluded.assigned_by, assigned_at = now();
  get diagnostics v_n = row_count;
  v_res := jsonb_build_object('saved', v_n);
  return app.request_done(p_client_request_id, 'set_duties', v_res);
end $$;

create or replace view api.duties with (security_invoker = true) as
select d.id, d.person_id, pe.name as person_name, d.company_id, c.short_name as company_name, d.place_id, pl.name as place_name, d.duty_date, d.duty, d.shift
from hr.duties d join master.people pe on pe.id = d.person_id join core.companies c on c.id = d.company_id left join core.places pl on pl.id = d.place_id;

-- Hours by company for a month (rotation: hours worked for the company that is not the pay company).
create or replace function api.hours_by_company(p_month date) returns table (person_id uuid, person_name text, pay_company_id uuid, company_id uuid, company_name text, days int, ot_hours numeric)
language sql stable security invoker set search_path = '' as $$
  select a.person_id, pe.name, sp.pay_company_id, a.company_id, c.short_name, count(*) filter (where a.status in ('P', 'H'))::int, coalesce(sum(a.ot_hours), 0)
  from hr.attendance a join master.people pe on pe.id = a.person_id join core.companies c on c.id = a.company_id left join hr.staff_profiles sp on sp.person_id = a.person_id
  where a.work_date >= date_trunc('month', p_month) and a.work_date < date_trunc('month', p_month) + interval '1 month'
  group by a.person_id, pe.name, sp.pay_company_id, a.company_id, c.short_name
$$;

grant select on api.duties to authenticated;
grant execute on function api.set_duties(uuid, date, jsonb), api.hours_by_company(date) to authenticated;
notify pgrst, 'reload schema';


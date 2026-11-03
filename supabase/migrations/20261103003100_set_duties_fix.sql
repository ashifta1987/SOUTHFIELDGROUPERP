-- 20261103003100_set_duties_fix.sql
-- Fix: in api.set_duties the PL/pgSQL loop variable "e" clashed with the SQL alias "e" ("column reference is
-- ambiguous"), so no duty could be saved. Also refuses an empty duty or a missing person/company. Function replacement only.

create or replace function api.set_duties(p_client_request_id uuid, p_date date, p_entries jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_n int; v_entry jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_duties'); if v_prev is not null then return v_prev; end if;
  if p_date is null then perform app.raise_rule('staff.date', 'choose the date', '22023'); end if;
  for v_entry in select * from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) loop
    if nullif(v_entry ->> 'person_id', '') is null or nullif(v_entry ->> 'company_id', '') is null then
      perform app.raise_rule('staff.person', 'each duty needs the person and the company', '22023');
    end if;
    if coalesce(length(trim(v_entry ->> 'duty')), 0) < 2 then perform app.raise_rule('staff.duty', 'enter the duty', '22023'); end if;
    perform app.require((v_entry ->> 'company_id')::uuid, 'hr.create');
  end loop;
  insert into hr.duties (person_id, company_id, place_id, duty_date, duty, shift, assigned_by)
  select (x ->> 'person_id')::uuid, (x ->> 'company_id')::uuid, nullif(x ->> 'place_id', '')::uuid, p_date, trim(x ->> 'duty'), nullif(x ->> 'shift', ''), auth.uid()
  from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) x
  on conflict (person_id, duty_date) do update set company_id = excluded.company_id, place_id = excluded.place_id, duty = excluded.duty, shift = excluded.shift,
    assigned_by = excluded.assigned_by, assigned_at = now();
  get diagnostics v_n = row_count;
  v_res := jsonb_build_object('saved', v_n);
  return app.request_done(p_client_request_id, 'set_duties', v_res);
end $$;

notify pgrst, 'reload schema';

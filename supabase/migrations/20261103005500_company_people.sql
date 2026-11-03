-- 20261103005500_company_people.sql
-- Pickers for duties, witnesses, R&D and QC need "who works in this company" without the users.view right
-- (api.list_users is Admin-grade: phones, roles, scopes). This read RPC returns only user id, display name and
-- role keys of people holding a current role in the company, and only to someone who holds a current role there.
-- No phone, email or other personal data (DPDP). Additive.

create or replace function api.company_people(p_company_id uuid)
returns table (user_id uuid, display_name text, role_keys text[])
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501', hint = 'auth.required';
  end if;
  if not exists (select 1 from core.user_roles r where r.user_id = auth.uid()
                 and (r.company_id = p_company_id or r.company_id is null)
                 and r.valid_from <= now() and (r.valid_to is null or r.valid_to > now())) then
    raise exception 'you have no role in this company' using errcode = '42501', hint = 'people.no_access';
  end if;
  return query
    select p.user_id, p.display_name, array_agg(distinct r.role_key order by r.role_key)
    from core.user_roles r join core.user_profiles p on p.user_id = r.user_id
    where (r.company_id = p_company_id or r.company_id is null)
      and r.valid_from <= now() and (r.valid_to is null or r.valid_to > now())
      and p.status = 'active'
    group by p.user_id, p.display_name
    order by p.display_name;
end $$;

revoke all on function api.company_people(uuid) from public, anon;
grant execute on function api.company_people(uuid) to authenticated;
notify pgrst, 'reload schema';


-- 20261103011400_tb_suspense_group.sql
-- The Suspense ledgers of a Trial Balance apply sit under Tally's predefined group "Suspense A/c". A company that does not have the
-- group yet gets it (liability nature, root) instead of the apply failing.
create or replace function app.tb_suspense_account(p_company uuid, p_name text, p_net numeric, p_as_of date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_grp uuid; v_id uuid;
begin
  select id into v_grp from acct.account_groups where company_id = p_company and parent_id is null and name = 'Suspense A/c';
  if v_grp is null then select account_group_id into v_grp from ops.tally_group_map where company_id = p_company and tally_group = 'Suspense A/c'; end if;
  if v_grp is null then
    insert into acct.account_groups (company_id, name, nature) values (p_company, 'Suspense A/c', 'liability') returning id into v_grp;
  end if;
  insert into acct.accounts (company_id, group_id, name, opening_balance, opening_dc, opening_as_of, status)
  values (p_company, v_grp, p_name, abs(p_net), case when p_net >= 0 then 'D' else 'C' end, p_as_of, 'to_review')
  on conflict (company_id, name) do update set opening_balance = excluded.opening_balance, opening_dc = excluded.opening_dc, opening_as_of = excluded.opening_as_of
  returning id into v_id;
  return v_id;
end $$;

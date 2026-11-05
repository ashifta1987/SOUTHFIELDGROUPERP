-- 20261103011200_tb_resolve_group_fast.sql
-- The group lookup for a Trial Balance line without a group (Tally XML) scanned every import row. Index the ledger rows by name
-- and look the exact name up first (the same ledger name comes from the same Tally company); the normalised match stays as the fallback.
create index if not exists import_rows_ledger_name_idx on ops.import_rows (name) where object_type = 'ledger';

create or replace function app.tb_resolve_group(p_company uuid, p_name text, p_parents jsonb) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_grp uuid; v_parent text;
begin
  for v_parent in select jsonb_array_elements_text(coalesce(p_parents, '[]'::jsonb)) loop
    select account_group_id into v_grp from ops.tally_group_map where company_id = p_company and tally_group = v_parent;
    exit when v_grp is not null;
  end loop;
  if v_grp is null and jsonb_array_length(coalesce(p_parents, '[]'::jsonb)) = 0 then
    select m.account_group_id into v_grp
    from ops.import_rows x join ops.import_batches b on b.id = x.batch_id
    join ops.tally_group_map m on m.company_id = p_company and m.tally_group = x.payload ->> 'parent'
    where x.object_type = 'ledger' and x.name = trim(p_name) and b.company_id = p_company and b.status <> 'undone'
    order by x.id desc limit 1;
  end if;
  return v_grp;
end $$;

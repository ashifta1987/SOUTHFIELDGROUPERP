-- 20261103011500_daybook_upgrade_tombstone.sql
-- The first Excel leg of an upgraded voucher takes the XML key, so its old Excel key must still be recognised: loading the Excel
-- Day Book again must not create that leg a second time (the other legs are kept as reversed rows, which already stop it).
create index if not exists tally_vouchers_upgraded_key_idx on ops.tally_vouchers (company_id, (upgraded_from ->> 'match_key')) where upgraded_from is not null;

do $$
declare
  v_def text; v_new text;
  v_old constant text := $q$  select * into v_existing from ops.tally_vouchers where company_id = b.company_id and match_key = v_key;$q$;
  v_rep constant text := $q$  select * into v_existing from ops.tally_vouchers where company_id = b.company_id and match_key = v_key;
  if v_existing.id is null then
    select * into v_existing from ops.tally_vouchers where company_id = b.company_id and upgraded_from is not null and upgraded_from ->> 'match_key' = v_key;
  end if;$q$;
begin
  v_def := pg_get_functiondef('app.imp_voucher(ops.import_batches, ops.import_rows)'::regprocedure);
  v_new := replace(v_def, v_old, v_rep);
  if v_new = v_def then raise exception 'imp_voucher tombstone patch did not match'; end if;
  execute v_new;
end $$;

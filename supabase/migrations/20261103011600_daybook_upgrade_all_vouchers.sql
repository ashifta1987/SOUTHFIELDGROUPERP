-- 20261103011600_daybook_upgrade_all_vouchers.sql
-- The upgrade of Excel one-leg vouchers also covers XML vouchers that carry no ledger lines (orders, delivery and receipt notes,
-- memoranda, stock journals): they are the same voucher as the Excel line, so they must not be counted twice either.
do $$
declare
  v_def text; v_new text;
  v_old constant text := $q$ and nullif(p ->> 'number', '') is not null and jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) > 0 then$q$;
  v_rep constant text := $q$ and nullif(p ->> 'number', '') is not null then$q$;
begin
  v_def := pg_get_functiondef('app.imp_voucher(ops.import_batches, ops.import_rows)'::regprocedure);
  v_new := replace(v_def, v_old, v_rep);
  if v_new = v_def then raise exception 'imp_voucher all-vouchers patch did not match'; end if;
  execute v_new;
end $$;

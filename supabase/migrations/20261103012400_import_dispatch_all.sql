-- 20261103012400_import_dispatch_all.sql
-- The new staged master kinds (voucher types, godowns, currencies, cost categories / centres, stock categories) must also be dispatched by
-- api.import_process and api.import_retry_errors (api.import_process_step was patched in the previous migration).
do $$
declare
  v_def text; v_new text; f text;
  v_a constant text := $q$when 'voucher' then app.imp_voucher(b, r)$q$;
begin
  foreach f in array array['api.import_process(uuid, uuid)', 'api.import_retry_errors(uuid, uuid)'] loop
    v_def := pg_get_functiondef(f::regprocedure);
    if length(v_def) - length(replace(v_def, v_a, '')) <> length(v_a) then raise exception '% dispatch patch: anchor not found exactly once', f; end if;
    v_new := replace(v_def, v_a, v_a || $q$
        when 'voucher_type' then app.imp_voucher_type(b, r)
        when 'godown' then app.imp_godown(b, r)
        when 'currency' then app.imp_currency(b, r)
        when 'cost_category' then app.imp_cost_category(b, r)
        when 'cost_centre' then app.imp_cost_centre(b, r)
        when 'stock_category' then app.imp_stock_category(b, r)$q$);
    execute v_new;
  end loop;
end $$;

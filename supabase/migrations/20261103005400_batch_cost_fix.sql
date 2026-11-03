-- 20261103005400_batch_cost_fix.sql
-- app.batch_cost: appending a missing rate name used text[] || untyped literal (parsed as array || array → 22P02),
-- so close_batch and api.batch_costs failed whenever a cost rate was unset. Use array_append. Body otherwise unchanged.

CREATE OR REPLACE FUNCTION app.batch_cost(p_batch uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare b prod.batches; v_mat numeric; v_pack numeric; v_lr numeric; v_mr numeric; v_or numeric; v_missing text[] := '{}'; v_lab numeric; v_mach numeric; v_ovh numeric; v_total numeric;
begin
  select * into b from prod.batches where id = p_batch;
  select coalesce(sum(value) filter (where kind = 'bulk_material'), 0), coalesce(sum(value) filter (where kind = 'packaging'), 0)
    into v_mat, v_pack from prod.material_consumption where batch_id = b.id;
  v_lr := app.cost_rate(b.company_id, 'labour_hour', b.batch_date); if v_lr is null and b.labour_hours > 0 then v_missing := array_append(v_missing, 'labour_hour'); end if;
  v_mr := app.cost_rate(b.company_id, 'machine_hour', b.batch_date); if v_mr is null and b.machine_hours > 0 then v_missing := array_append(v_missing, 'machine_hour'); end if;
  v_or := app.cost_rate(b.company_id, 'overhead_per_kg', b.batch_date); if v_or is null then v_missing := array_append(v_missing, 'overhead_per_kg'); end if;
  v_lab := round(b.labour_hours * coalesce(v_lr, 0), 2);
  v_mach := round(b.machine_hours * coalesce(v_mr, 0), 2);
  v_ovh := round(coalesce(b.bulk_qty, 0) * coalesce(v_or, 0), 2);
  v_total := round(v_mat + v_pack + v_lab + v_mach + v_ovh, 2);
  return jsonb_build_object('materials', round(v_mat, 2), 'packaging', round(v_pack, 2), 'labour', v_lab, 'machine', v_mach, 'overhead', v_ovh, 'total', v_total,
                            'good_packs', b.good_packs, 'cost_per_pack', case when coalesce(b.good_packs, 0) > 0 then round(v_total / b.good_packs, 4) end,
                            'rates_missing', to_jsonb(v_missing));
end $function$
;

-- 20261103005600_upsert_mould_cost_fix.sql
-- api.upsert_mould: an edit by someone without cost.view (or without a 'cost' key) wiped the mould cost to null.
-- Keep the existing cost unless the editor holds cost.view and sends the key. Body otherwise unchanged.

CREATE OR REPLACE FUNCTION api.upsert_mould(p_client_request_id uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_prev jsonb; v_res jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_company uuid := nullif(p ->> 'company_id', '')::uuid; v_place uuid := nullif(p ->> 'place_id', '')::uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_mould'); if v_prev is not null then return v_prev; end if;
  if v_id is not null then select company_id into v_company from prod.moulds where id = v_id for update; end if;
  perform app.require(v_company, 'production.edit');
  if coalesce(length(trim(p ->> 'code')), 0) = 0 or coalesce(length(trim(p ->> 'name')), 0) = 0 then perform app.raise_rule('mould.code', 'enter the mould code and name', '22023'); end if;
  if coalesce((p ->> 'cavities')::int, 0) <= 0 or coalesce((p ->> 'cycle_time_sec')::numeric, 0) <= 0 then
    perform app.raise_rule('mould.cavities', 'enter the cavities and the standard cycle time (seconds)', '22023');
  end if;
  if coalesce(p ->> 'ownership', 'own') = 'buyer' and nullif(p ->> 'buyer_party_id', '') is null then perform app.raise_rule('mould.buyer', 'choose the buyer who owns the mould', '22023'); end if;
  if v_place is not null and not exists (select 1 from core.places where id = v_place and company_id = v_company) then
    perform app.raise_rule('stock.place_other_company', 'the place belongs to another company', '22023');
  end if;
  if v_id is null then
    insert into prod.moulds (company_id, code, name, project_id, product_id, material_product_id, cavities, cycle_time_sec, part_weight_g, runner_weight_g, ownership,
                             buyer_party_id, place_id, shot_count, shots_at_last_service, service_interval_shots, life_shots, cost, created_by)
    values (v_company, upper(trim(p ->> 'code')), trim(p ->> 'name'), nullif(p ->> 'project_id', '')::uuid, nullif(p ->> 'product_id', '')::uuid,
            nullif(p ->> 'material_product_id', '')::uuid, (p ->> 'cavities')::int, (p ->> 'cycle_time_sec')::numeric, nullif(p ->> 'part_weight_g', '')::numeric,
            nullif(p ->> 'runner_weight_g', '')::numeric, coalesce(nullif(p ->> 'ownership', ''), 'own'), nullif(p ->> 'buyer_party_id', '')::uuid, v_place,
            coalesce(nullif(p ->> 'shot_count', '')::bigint, 0), coalesce(nullif(p ->> 'shot_count', '')::bigint, 0), nullif(p ->> 'service_interval_shots', '')::bigint,
            nullif(p ->> 'life_shots', '')::bigint, nullif(p ->> 'cost', '')::numeric, auth.uid())
    returning id into v_id;
    insert into prod.mould_events (company_id, mould_id, kind, event_date, detail, recorded_by) values (v_company, v_id, 'created', current_date, '{}'::jsonb, auth.uid());
  else
    update prod.moulds set code = upper(trim(p ->> 'code')), name = trim(p ->> 'name'), project_id = nullif(p ->> 'project_id', '')::uuid, product_id = nullif(p ->> 'product_id', '')::uuid,
      material_product_id = nullif(p ->> 'material_product_id', '')::uuid, cavities = (p ->> 'cavities')::int, cycle_time_sec = (p ->> 'cycle_time_sec')::numeric,
      part_weight_g = nullif(p ->> 'part_weight_g', '')::numeric, runner_weight_g = nullif(p ->> 'runner_weight_g', '')::numeric,
      ownership = coalesce(nullif(p ->> 'ownership', ''), ownership), buyer_party_id = nullif(p ->> 'buyer_party_id', '')::uuid,
      service_interval_shots = nullif(p ->> 'service_interval_shots', '')::bigint, life_shots = nullif(p ->> 'life_shots', '')::bigint, cost = case when p ? 'cost' and app.can(prod.moulds.company_id, 'cost.view') then nullif(p ->> 'cost', '')::numeric else prod.moulds.cost end,
      status = case when p ->> 'status' = 'retired' then 'retired' else status end
    where id = v_id;   -- location and shot count change only through moves, services and shift entries
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_mould', v_res);
end $function$
;

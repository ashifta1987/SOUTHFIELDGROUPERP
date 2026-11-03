-- 20261103005200_production_plastics_api.sql
-- Phase 5 Plastics RPCs: mould projects (design → trial → approval → approved, approved by someone else), the mould
-- register (moves, service, shot count), injection shift entry with theoretical output and OEE (docs/KPI_DEFINITIONS.md),
-- granule / regrind consumption and scrap through the stock ledger, good pieces into quarantine until a quality
-- inspection by someone other than the maker, the mixer grinder BOM (approved by a second person) and assembly that
-- consumes components and refuses when short, pad printing with cost per print, material specs and operator machine
-- checks. Same RPC contract as every phase. Additive.

-- ─────────── Mould projects ───────────
-- p: {id?, company_id, code, name, product_id, ownership own|buyer, buyer_party_id, target_date, estimated_cost, notes}
create or replace function api.save_mould_project(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_company uuid := nullif(p ->> 'company_id', '')::uuid; v_stage text;
begin
  v_prev := app.request_seen(p_client_request_id, 'save_mould_project'); if v_prev is not null then return v_prev; end if;
  if v_id is not null then select company_id, stage into v_company, v_stage from prod.mould_projects where id = v_id for update; end if;
  perform app.require(v_company, 'production.edit');
  if coalesce(length(trim(p ->> 'code')), 0) = 0 or coalesce(length(trim(p ->> 'name')), 0) = 0 then perform app.raise_rule('mould.code', 'enter the project code and name', '22023'); end if;
  if coalesce(p ->> 'ownership', 'own') = 'buyer' and nullif(p ->> 'buyer_party_id', '') is null then perform app.raise_rule('mould.buyer', 'choose the buyer who owns the mould', '22023'); end if;
  if v_id is null then
    insert into prod.mould_projects (company_id, code, name, product_id, ownership, buyer_party_id, target_date, estimated_cost, notes, created_by)
    values (v_company, upper(trim(p ->> 'code')), trim(p ->> 'name'), nullif(p ->> 'product_id', '')::uuid, coalesce(nullif(p ->> 'ownership', ''), 'own'),
            nullif(p ->> 'buyer_party_id', '')::uuid, nullif(p ->> 'target_date', '')::date, nullif(p ->> 'estimated_cost', '')::numeric, nullif(p ->> 'notes', ''), auth.uid())
    returning id into v_id;
    insert into prod.mould_events (company_id, project_id, kind, event_date, detail, recorded_by) values (v_company, v_id, 'created', current_date, '{}'::jsonb, auth.uid());
  else
    if v_stage in ('approved', 'dropped') then perform app.raise_rule('mould.project_closed', 'this project is closed', '22023'); end if;
    update prod.mould_projects set name = trim(p ->> 'name'), product_id = nullif(p ->> 'product_id', '')::uuid, ownership = coalesce(nullif(p ->> 'ownership', ''), ownership),
      buyer_party_id = nullif(p ->> 'buyer_party_id', '')::uuid, target_date = nullif(p ->> 'target_date', '')::date, estimated_cost = nullif(p ->> 'estimated_cost', '')::numeric,
      notes = nullif(p ->> 'notes', '') where id = v_id;
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'save_mould_project', v_res);
end $$;

-- One stage forward (or dropped). Approved needs production.approve and someone other than the project's creator.
create or replace function api.advance_mould_project(p_client_request_id uuid, p_project_id uuid, p_stage text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; m prod.mould_projects; v_order text[] := array['design', 'trial', 'approval', 'approved'];
begin
  v_prev := app.request_seen(p_client_request_id, 'advance_mould_project'); if v_prev is not null then return v_prev; end if;
  select * into m from prod.mould_projects where id = p_project_id for update;
  if m.id is null then perform app.raise_rule('mould.project_missing', 'project not found', 'P0002'); end if;
  perform app.require(m.company_id, case when p_stage = 'approved' then 'production.approve' else 'production.edit' end);
  if m.stage in ('approved', 'dropped') then perform app.raise_rule('mould.project_closed', 'this project is closed', '22023'); end if;
  if p_stage = 'dropped' then
    if coalesce(length(trim(p_note)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'reason required', '22023'); end if;
  elsif array_position(v_order, p_stage) is distinct from array_position(v_order, m.stage) + 1 then
    perform app.raise_rule('mould.stage_order', 'the next stage is ' || v_order[array_position(v_order, m.stage) + 1], '22023');
  end if;
  if p_stage = 'approved' and auth.uid() = m.created_by then perform app.raise_rule('sod.own_approval', 'someone else must approve the mould project you created', '42501'); end if;
  update prod.mould_projects set stage = p_stage, approved_by = case when p_stage = 'approved' then auth.uid() end, approved_at = case when p_stage = 'approved' then now() end
   where id = m.id;
  insert into prod.mould_events (company_id, project_id, kind, event_date, detail, recorded_by)
  values (m.company_id, m.id, 'stage', current_date, jsonb_build_object('from', m.stage, 'to', p_stage, 'note', p_note), auth.uid());
  v_res := jsonb_build_object('id', m.id, 'stage', p_stage);
  return app.request_done(p_client_request_id, 'advance_mould_project', v_res);
end $$;

-- ─────────── Mould register ───────────
-- p: {id?, company_id, code, name, project_id, product_id, material_product_id, cavities, cycle_time_sec, part_weight_g, runner_weight_g, ownership,
--     buyer_party_id, place_id, service_interval_shots, life_shots, cost, status (active|retired), shot_count (only when adding)}
create or replace function api.upsert_mould(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
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
      service_interval_shots = nullif(p ->> 'service_interval_shots', '')::bigint, life_shots = nullif(p ->> 'life_shots', '')::bigint, cost = nullif(p ->> 'cost', '')::numeric,
      status = case when p ->> 'status' = 'retired' then 'retired' else status end
    where id = v_id;   -- location and shot count change only through moves, services and shift entries
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_mould', v_res);
end $$;

-- p: {location rack|machine|repair|buyer|other, place_id, machine_asset_id (location machine), date, note}
create or replace function api.move_mould(p_client_request_id uuid, p_mould_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; m prod.moulds; v_loc text := p ->> 'location'; v_machine uuid := nullif(p ->> 'machine_asset_id', '')::uuid; v_place uuid := nullif(p ->> 'place_id', '')::uuid;
        v_date date := coalesce(nullif(p ->> 'date', '')::date, current_date);
begin
  v_prev := app.request_seen(p_client_request_id, 'move_mould'); if v_prev is not null then return v_prev; end if;
  select * into m from prod.moulds where id = p_mould_id for update;
  if m.id is null then perform app.raise_rule('mould.missing', 'mould not found', 'P0002'); end if;
  perform app.require(m.company_id, 'production.create');
  if m.status = 'retired' then perform app.raise_rule('mould.retired', 'this mould is retired', '22023'); end if;
  if v_date > current_date then perform app.raise_rule('date.future', 'the date is in the future', '22023'); end if;
  if v_loc not in ('rack', 'machine', 'repair', 'buyer', 'other') then perform app.raise_rule('mould.location', 'choose where the mould is going', '22023'); end if;
  if v_loc = 'machine' then
    if v_machine is null or not exists (select 1 from core.assets where id = v_machine and company_id = m.company_id and kind = 'injection_machine' and status = 'active') then
      perform app.raise_rule('mould.machine', 'choose an injection machine of this company that is in use', '22023');
    end if;
    if exists (select 1 from prod.moulds where machine_asset_id = v_machine and location = 'machine' and id <> m.id) then
      perform app.raise_rule('mould.machine_busy', 'another mould is on this machine; take it off first', '22023');
    end if;
    select place_id into v_place from core.assets where id = v_machine;
  else
    v_machine := null;
  end if;
  if v_place is not null and not exists (select 1 from core.places where id = v_place and company_id = m.company_id) then
    perform app.raise_rule('stock.place_other_company', 'the place belongs to another company', '22023');
  end if;
  update prod.moulds set location = v_loc, machine_asset_id = v_machine, place_id = coalesce(v_place, place_id), status = case when v_loc = 'repair' then 'repair' when status = 'repair' then 'active' else status end
   where id = m.id;
  insert into prod.mould_events (company_id, mould_id, kind, event_date, detail, recorded_by)
  values (m.company_id, m.id, case when v_loc = 'machine' then 'mounted' when m.location = 'machine' then 'unmounted' else 'moved' end, v_date,
          jsonb_strip_nulls(jsonb_build_object('from', m.location, 'to', v_loc, 'machine_asset_id', v_machine, 'from_machine_asset_id', m.machine_asset_id, 'place_id', v_place, 'note', p ->> 'note')),
          auth.uid());
  v_res := jsonb_build_object('id', m.id, 'location', v_loc);
  return app.request_done(p_client_request_id, 'move_mould', v_res);
end $$;

-- p: {kind service|repair, amount, date, note}. A service resets the shots-since-service counter.
create or replace function api.record_mould_service(p_client_request_id uuid, p_mould_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; m prod.moulds; v_kind text := coalesce(nullif(p ->> 'kind', ''), 'service'); v_date date := coalesce(nullif(p ->> 'date', '')::date, current_date);
begin
  v_prev := app.request_seen(p_client_request_id, 'record_mould_service'); if v_prev is not null then return v_prev; end if;
  select * into m from prod.moulds where id = p_mould_id for update;
  if m.id is null then perform app.raise_rule('mould.missing', 'mould not found', 'P0002'); end if;
  perform app.require(m.company_id, 'production.create');
  if v_kind not in ('service', 'repair') then perform app.raise_rule('mould.service_kind', 'service or repair', '22023'); end if;
  if v_date > current_date then perform app.raise_rule('date.future', 'the date is in the future', '22023'); end if;
  update prod.moulds set shots_at_last_service = shot_count, status = case when status = 'repair' then 'active' else status end,
    location = case when location = 'repair' then 'rack' else location end where id = m.id;
  insert into prod.mould_events (company_id, mould_id, kind, event_date, detail, shots, amount, recorded_by)
  values (m.company_id, m.id, v_kind, v_date, jsonb_strip_nulls(jsonb_build_object('note', p ->> 'note')), m.shot_count, nullif(p ->> 'amount', '')::numeric, auth.uid());
  v_res := jsonb_build_object('id', m.id, 'shots_at_service', m.shot_count);
  return app.request_done(p_client_request_id, 'record_mould_service', v_res);
end $$;

-- ─────────── Injection shift entry ───────────
-- p: {company_id, place_id (unit), output_place_id, date, shift day|night|general, machine_asset_id, mould_id, operator_user_id, operator_name,
--     cavities_running, planned_minutes, shot_start, shot_end, good_qty, rejects [{reason, qty}], downtime [{kind, reason, minutes}],
--     materials [{product_id, qty, place_id}] (granules, masterbatch), regrind [{product_id, qty, place_id}] (regrind reused),
--     scrap {product_id, qty, place_id} (rejects and runners weighed into scrap), note}
-- Theoretical output = floor(run seconds ÷ standard cycle time) × cavities running; OEE = availability × performance × quality.
create or replace function api.record_injection_shift(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_res jsonb; v_company uuid := nullif(p ->> 'company_id', '')::uuid; v_date date := coalesce(nullif(p ->> 'date', '')::date, current_date);
  m prod.moulds; v_machine core.assets; v_cav int := (p ->> 'cavities_running')::int; v_planned numeric := (p ->> 'planned_minutes')::numeric; v_down numeric := 0;
  v_run numeric; v_theo numeric; v_good numeric := round(coalesce((p ->> 'good_qty')::numeric, -1), 3); v_rej numeric := 0; v_total numeric; v_shots bigint;
  v_avail numeric; v_perf numeric; v_qual numeric; v_oee numeric; v_no text; v_id uuid; x jsonb; v_pieces jsonb; v_value numeric := 0; v_lot uuid; v_cost numeric;
  v_out uuid := (p ->> 'output_place_id')::uuid; v_place uuid := (p ->> 'place_id')::uuid; v_rid uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'record_injection_shift'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'production.create');
  select * into m from prod.moulds where id = (p ->> 'mould_id')::uuid for update;
  if m.id is null or m.company_id <> v_company then perform app.raise_rule('mould.missing', 'choose a mould of this company', '22023'); end if;
  if m.status <> 'active' then perform app.raise_rule('mould.not_active', 'this mould is ' || m.status, '22023'); end if;
  if m.product_id is null then perform app.raise_rule('mould.no_product', 'set the component this mould makes on the mould register', '22023'); end if;
  select * into v_machine from core.assets where id = (p ->> 'machine_asset_id')::uuid;
  if v_machine.id is null or v_machine.company_id <> v_company or v_machine.kind <> 'injection_machine' then
    perform app.raise_rule('mould.machine', 'choose an injection machine of this company', '22023');
  end if;
  if v_machine.status <> 'active' then perform app.raise_rule('asset.not_in_use', v_machine.code || ' is not in use (' || v_machine.status || ')', 'P0001'); end if;
  if (select count(*) from core.places where id in (v_place, v_out) and company_id = v_company) <> (case when v_place = v_out then 1 else 2 end) then
    perform app.raise_rule('stock.place_other_company', 'choose the unit and output places of this company', '22023');
  end if;
  if coalesce(v_cav, 0) < 1 or v_cav > m.cavities then perform app.raise_rule('shift.cavities', format('cavities running must be between 1 and %s', m.cavities), '22023'); end if;
  if coalesce(v_planned, 0) <= 0 or v_planned > 1440 then perform app.raise_rule('shift.planned', 'enter the planned production time in minutes', '22023'); end if;
  if v_good < 0 then perform app.raise_rule('shift.good', 'enter the good pieces (zero or more)', '22023'); end if;
  if coalesce(p ->> 'shift', '') not in ('day', 'night', 'general') then perform app.raise_rule('shift.shift', 'choose the shift', '22023'); end if;
  select coalesce(sum((d ->> 'minutes')::numeric), 0) into v_down from jsonb_array_elements(coalesce(p -> 'downtime', '[]'::jsonb)) d;
  select coalesce(sum((r ->> 'qty')::numeric), 0) into v_rej from jsonb_array_elements(coalesce(p -> 'rejects', '[]'::jsonb)) r;
  if v_down > v_planned then perform app.raise_rule('shift.downtime', 'downtime cannot be more than the planned time', '22023'); end if;
  perform app.check_stock_date(v_company, v_date);
  v_run := v_planned - v_down;
  v_theo := floor(v_run * 60 / m.cycle_time_sec) * v_cav;
  v_total := v_good + v_rej;
  v_shots := coalesce((p ->> 'shot_end')::bigint - (p ->> 'shot_start')::bigint, ceil(v_total / v_cav)::bigint);
  if v_shots < 0 then perform app.raise_rule('shift.shots', 'the shot counter end is below the start', '22023'); end if;
  v_avail := round(v_run / v_planned, 4);
  v_perf := case when v_theo > 0 then round(v_total / v_theo, 4) end;
  v_qual := case when v_total > 0 then round(v_good / v_total, 4) end;
  v_oee := round(v_avail * v_perf * v_qual, 4);
  v_no := app.internal_doc_no(v_company, 'injection_shift', v_date);
  insert into prod.injection_shifts (company_id, doc_no, place_id, output_place_id, shift_date, shift, machine_asset_id, mould_id, product_id, operator_user_id, operator_name,
                                     cavities_running, cycle_time_sec, planned_minutes, downtime_minutes, run_minutes, shot_start, shot_end, shots, good_qty, reject_qty,
                                     theoretical_qty, availability, performance, quality, oee, note, recorded_by)
  values (v_company, v_no, v_place, v_out, v_date, p ->> 'shift', v_machine.id, m.id, m.product_id, nullif(p ->> 'operator_user_id', '')::uuid, nullif(p ->> 'operator_name', ''),
          v_cav, m.cycle_time_sec, v_planned, v_down, v_run, nullif(p ->> 'shot_start', '')::bigint, nullif(p ->> 'shot_end', '')::bigint, v_shots, v_good, v_rej,
          v_theo, v_avail, v_perf, v_qual, v_oee, nullif(p ->> 'note', ''), auth.uid())
  returning id into v_id;
  for x in select * from jsonb_array_elements(coalesce(p -> 'rejects', '[]'::jsonb)) loop
    insert into prod.shift_rejects (company_id, shift_id, reason, qty) values (v_company, v_id, coalesce(nullif(x ->> 'reason', ''), 'unspecified'), (x ->> 'qty')::numeric);
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p -> 'downtime', '[]'::jsonb)) loop
    insert into prod.downtime (company_id, shift_id, kind, reason, minutes) values (v_company, v_id, coalesce(nullif(x ->> 'kind', ''), 'other'), nullif(x ->> 'reason', ''), (x ->> 'minutes')::numeric);
  end loop;
  -- Materials (granules, masterbatch) and regrind reused, out of stock into the consumption ledger.
  for x in select * from jsonb_array_elements(coalesce(p -> 'materials', '[]'::jsonb)) loop
    v_pieces := app.stock_take(v_company, (x ->> 'product_id')::uuid, null, (x ->> 'place_id')::uuid, 'available', (x ->> 'qty')::numeric, 'consumption', 'prod.injection_shifts', v_id, v_no, v_date, 'Moulding');
    v_value := v_value + app.record_consumption(v_company, 'prod.injection_shifts', v_id, null, 'granule', (x ->> 'product_id')::uuid, (x ->> 'place_id')::uuid, v_pieces, v_date);
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p -> 'regrind', '[]'::jsonb)) loop
    if not exists (select 1 from master.products where id = (x ->> 'product_id')::uuid and is_scrap) then perform app.raise_rule('scrap.not_scrap_item', 'choose a scrap or regrind item', '22023'); end if;
    insert into prod.regrind_entries (company_id, entry_date, kind, product_id, source_product_id, place_id, qty, machine, mould, shift, note, recorded_by)
    values (v_company, v_date, 'regrind_reuse', (x ->> 'product_id')::uuid, m.material_product_id, (x ->> 'place_id')::uuid, (x ->> 'qty')::numeric, v_machine.code, m.code, p ->> 'shift', v_no, auth.uid())
    returning id into v_rid;
    v_pieces := app.stock_take(v_company, (x ->> 'product_id')::uuid, null, (x ->> 'place_id')::uuid, 'available', (x ->> 'qty')::numeric, 'regrind', 'prod.regrind_entries', v_rid, v_no, v_date, 'Regrind reused');
    v_value := v_value + app.record_consumption(v_company, 'prod.injection_shifts', v_id, null, 'granule', (x ->> 'product_id')::uuid, (x ->> 'place_id')::uuid, v_pieces, v_date);
  end loop;
  if jsonb_typeof(p -> 'scrap') = 'object' and coalesce((p -> 'scrap' ->> 'qty')::numeric, 0) > 0 then
    if not exists (select 1 from master.products where id = (p -> 'scrap' ->> 'product_id')::uuid and is_scrap) then perform app.raise_rule('scrap.not_scrap_item', 'choose a scrap or regrind item', '22023'); end if;
    insert into prod.regrind_entries (company_id, entry_date, kind, product_id, source_product_id, place_id, qty, machine, mould, shift, note, recorded_by)
    values (v_company, v_date, 'scrap_in', (p -> 'scrap' ->> 'product_id')::uuid, m.material_product_id, (p -> 'scrap' ->> 'place_id')::uuid, (p -> 'scrap' ->> 'qty')::numeric,
            v_machine.code, m.code, p ->> 'shift', v_no, auth.uid())
    returning id into v_rid;
    perform app.stock_post(v_company, (p -> 'scrap' ->> 'product_id')::uuid, null, (p -> 'scrap' ->> 'place_id')::uuid, 'available', (p -> 'scrap' ->> 'qty')::numeric, 'scrap_in',
                           'prod.regrind_entries', v_rid, v_no, v_date, 0, 'Shift rejects and runners');
  end if;
  -- Good pieces into quarantine until a quality inspection releases them.
  if v_good > 0 then
    v_cost := round(v_value / v_good, 4);
    insert into inv.lots (company_id, product_id, lot_no, mfg_date, source, status, needs_test, received_by)
    values (v_company, m.product_id, v_no, v_date, 'production', 'quarantine', true, coalesce(nullif(p ->> 'operator_user_id', '')::uuid, auth.uid()))
    returning id into v_lot;
    perform app.stock_post(v_company, m.product_id, v_lot, v_out, 'quarantine', v_good, 'production_in', 'prod.injection_shifts', v_id, v_no, v_date, v_cost, 'Moulded; waits for inspection');
    update prod.injection_shifts set lot_id = v_lot where id = v_id;
  end if;
  if v_shots > 0 then
    update prod.moulds set shot_count = shot_count + v_shots where id = m.id;
    insert into prod.mould_events (company_id, mould_id, kind, event_date, detail, shots, source_id, recorded_by)
    values (v_company, m.id, 'shots', v_date, jsonb_build_object('doc_no', v_no, 'machine_asset_id', v_machine.id), v_shots, v_id, auth.uid());
  end if;
  v_res := jsonb_build_object('id', v_id, 'doc_no', v_no, 'lot_id', v_lot, 'run_minutes', v_run, 'theoretical_qty', v_theo, 'total_qty', v_total, 'shots', v_shots,
                              'availability', v_avail, 'performance', v_perf, 'quality', v_qual, 'oee', v_oee);
  return app.request_done(p_client_request_id, 'record_injection_shift', v_res);
end $$;

-- ─────────── Quality inspections ───────────
-- p: {lot_id, kind first_piece|patrol|final|assembly, sample_qty, accepted_qty, rejected_qty, result pass|fail|hold, defects [], remarks, date}
-- final / assembly decide the whole quarantined lot: accepted → available, rejected → rejected (accepted + rejected = quantity in quarantine).
-- The inspector is never the operator / assembler / recorder of the lot.
create or replace function api.record_quality_inspection(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_res jsonb; l inv.lots; v_kind text := p ->> 'kind'; v_result text := p ->> 'result'; v_acc numeric := round(coalesce(nullif(p ->> 'accepted_qty', '')::numeric, 0), 3);
  v_rej numeric := round(coalesce(nullif(p ->> 'rejected_qty', '')::numeric, 0), 3); v_q numeric; v_shift prod.injection_shifts; v_asm prod.assembly_orders; v_id uuid; bal record;
  v_left_acc numeric; v_take numeric; v_cost numeric; v_date date := coalesce(nullif(p ->> 'date', '')::date, current_date);
begin
  v_prev := app.request_seen(p_client_request_id, 'record_quality_inspection'); if v_prev is not null then return v_prev; end if;
  select * into l from inv.lots where id = (p ->> 'lot_id')::uuid for update;
  if l.id is null then perform app.raise_rule('qc.lot_missing', 'lot not found', 'P0002'); end if;
  perform app.require(l.company_id, case when v_kind in ('final', 'assembly') then 'qc.release' else 'qc.test' end);
  if v_kind not in ('first_piece', 'patrol', 'final', 'assembly') then perform app.raise_rule('qc.kind', 'choose the inspection kind', '22023'); end if;
  if v_result not in ('pass', 'fail', 'hold') then perform app.raise_rule('qc.result', 'the result is pass, fail or hold', '22023'); end if;
  if v_date > current_date then perform app.raise_rule('date.future', 'the date is in the future', '22023'); end if;
  select * into v_shift from prod.injection_shifts where lot_id = l.id;
  select * into v_asm from prod.assembly_orders where lot_id = l.id;
  if v_shift.id is null and v_asm.id is null then perform app.raise_rule('qc.not_inspection_lot', 'inspections are for moulded or assembled lots', '22023'); end if;
  if auth.uid() in (l.received_by, v_shift.operator_user_id, v_shift.recorded_by, v_asm.assembled_by) then
    perform app.raise_rule('sod.inspector_maker', 'you made or recorded this lot, so someone else must inspect it', '42501');
  end if;
  if v_kind in ('final', 'assembly') and v_result <> 'hold' then
    if l.status <> 'quarantine' then perform app.raise_rule('qc.not_in_quarantine', 'this lot is not in quarantine', '22023'); end if;
    select coalesce(sum(qty), 0) into v_q from inv.stock_balances where lot_id = l.id and bucket = 'quarantine';
    if v_acc + v_rej <> v_q then perform app.raise_rule('qc.qty_mismatch', format('accepted + rejected must equal the %s in quarantine', v_q), '22023'); end if;
    if v_result = 'pass' and v_acc = 0 then perform app.raise_rule('qc.qty_mismatch', 'a pass needs accepted pieces', '22023'); end if;
    if v_result = 'fail' and v_acc > 0 then perform app.raise_rule('qc.qty_mismatch', 'a fail accepts nothing', '22023'); end if;
    perform app.check_stock_date(l.company_id, current_date);
    v_cost := app.avg_cost(l.company_id, l.product_id);
    v_left_acc := v_acc;
    for bal in select place_id, qty from inv.stock_balances where lot_id = l.id and bucket = 'quarantine' and qty > 0 order by place_id loop
      perform app.stock_post(l.company_id, l.product_id, l.id, bal.place_id, 'quarantine', -bal.qty, case when v_left_acc > 0 then 'release' else 'reject' end, 'inv.lots', l.id, l.lot_no, current_date, v_cost, 'Inspection');
      v_take := least(bal.qty, v_left_acc);
      if v_take > 0 then perform app.stock_post(l.company_id, l.product_id, l.id, bal.place_id, 'available', v_take, 'release', 'inv.lots', l.id, l.lot_no, current_date, v_cost, 'Accepted at inspection'); end if;
      if bal.qty - v_take > 0 then perform app.stock_post(l.company_id, l.product_id, l.id, bal.place_id, 'rejected', bal.qty - v_take, 'reject', 'inv.lots', l.id, l.lot_no, current_date, v_cost, 'Rejected at inspection'); end if;
      v_left_acc := v_left_acc - v_take;
    end loop;
    update inv.lots set status = case when v_acc > 0 then 'available' else 'rejected' end, released_by = auth.uid(), released_at = now() where id = l.id;
  end if;
  insert into prod.quality_inspections (company_id, lot_id, shift_id, assembly_order_id, kind, sample_qty, accepted_qty, rejected_qty, result, defects, remarks, inspection_date, inspected_by)
  values (l.company_id, l.id, v_shift.id, v_asm.id, v_kind, nullif(p ->> 'sample_qty', '')::numeric, v_acc, v_rej, v_result, coalesce(p -> 'defects', '[]'::jsonb),
          nullif(p ->> 'remarks', ''), v_date, auth.uid())
  returning id into v_id;
  v_res := jsonb_build_object('id', v_id, 'lot_status', (select status from inv.lots where id = l.id));
  return app.request_done(p_client_request_id, 'record_quality_inspection', v_res);
end $$;

-- ─────────── Assembly (mixer grinder BOM) ───────────
-- New draft BOM version. p: {company_id, product_id, notes, lines [{product_id, qty_per, note}]}
create or replace function api.save_assembly_bom(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_company uuid := nullif(p ->> 'company_id', '')::uuid; v_product uuid := (p ->> 'product_id')::uuid; v_id uuid; v_ver int; l jsonb; v_n int := 0;
begin
  v_prev := app.request_seen(p_client_request_id, 'save_assembly_bom'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'production.edit');
  if not exists (select 1 from master.products where id = v_product) then perform app.raise_rule('product.missing', 'item not found', 'P0002'); end if;
  perform pg_advisory_xact_lock(hashtextextended('bom|' || v_company::text || '|' || v_product::text, 0));
  select coalesce(max(version), 0) + 1 into v_ver from prod.assembly_boms where company_id = v_company and product_id = v_product;
  insert into prod.assembly_boms (company_id, product_id, version, notes, created_by) values (v_company, v_product, v_ver, nullif(p ->> 'notes', ''), auth.uid()) returning id into v_id;
  for l in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    if (l ->> 'product_id')::uuid = v_product then perform app.raise_rule('bom.self', 'an item cannot be its own component', '22023'); end if;
    if coalesce((l ->> 'qty_per')::numeric, 0) <= 0 then perform app.raise_rule('bom.qty', 'every component needs a quantity above zero', '22023'); end if;
    insert into prod.assembly_bom_lines (company_id, bom_id, product_id, qty_per, note) values (v_company, v_id, (l ->> 'product_id')::uuid, round((l ->> 'qty_per')::numeric, 3), nullif(l ->> 'note', ''));
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then perform app.raise_rule('doc.no_lines', 'add at least one component', '22023'); end if;
  v_res := jsonb_build_object('id', v_id, 'version', v_ver, 'status', 'draft');
  return app.request_done(p_client_request_id, 'save_assembly_bom', v_res);
end $$;

create or replace function api.approve_assembly_bom(p_client_request_id uuid, p_bom_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; b prod.assembly_boms;
begin
  v_prev := app.request_seen(p_client_request_id, 'approve_assembly_bom'); if v_prev is not null then return v_prev; end if;
  select * into b from prod.assembly_boms where id = p_bom_id for update;
  if b.id is null then perform app.raise_rule('bom.missing', 'BOM not found', 'P0002'); end if;
  perform app.require(b.company_id, 'production.approve');
  if b.status <> 'draft' then perform app.raise_rule('bom.state', 'only a draft BOM can be approved', '22023'); end if;
  if auth.uid() = b.created_by then perform app.raise_rule('sod.own_approval', 'someone else must approve the BOM you wrote', '42501'); end if;
  update prod.assembly_boms set status = 'superseded' where company_id = b.company_id and product_id = b.product_id and status = 'approved';
  update prod.assembly_boms set status = 'approved', approved_by = auth.uid(), approved_at = now() where id = b.id;
  v_res := jsonb_build_object('id', b.id, 'status', 'approved');
  return app.request_done(p_client_request_id, 'approve_assembly_bom', v_res);
end $$;

-- p: {product_id (uses its approved BOM), qty (whole units), from_place_id (components), to_place_id (assembled units, quarantine), date, labour_hours, note}
-- Every component shortage is listed and nothing moves.
create or replace function api.post_assembly(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_res jsonb; b prod.assembly_boms; v_qty numeric := (p ->> 'qty')::numeric; v_from uuid := (p ->> 'from_place_id')::uuid; v_to uuid := (p ->> 'to_place_id')::uuid;
  v_date date := coalesce(nullif(p ->> 'date', '')::date, current_date); l record; v_need numeric; v_avail numeric; v_resv numeric; v_short jsonb := '[]'::jsonb; v_no text; v_id uuid;
  v_pieces jsonb; v_value numeric := 0; v_lot uuid; v_cost numeric; v_company uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'post_assembly'); if v_prev is not null then return v_prev; end if;
  select company_id into v_company from core.places where id = v_from;
  perform app.require(v_company, 'production.create');
  select * into b from prod.assembly_boms where company_id = v_company and product_id = (p ->> 'product_id')::uuid and status = 'approved';
  if b.id is null then perform app.raise_rule('bom.none_approved', 'this item has no approved bill of materials', 'P0001'); end if;
  if coalesce(v_qty, 0) <= 0 or v_qty <> trunc(v_qty) then perform app.raise_rule('prod.qty', 'enter whole units', '22023'); end if;
  if not exists (select 1 from core.places where id = v_to and company_id = v_company) then perform app.raise_rule('stock.place_other_company', 'choose places of this company', '22023'); end if;
  perform app.check_stock_date(v_company, v_date);
  for l in select bl.product_id, bl.qty_per, pr.code from prod.assembly_bom_lines bl join master.products pr on pr.id = bl.product_id where bl.bom_id = b.id order by pr.code loop
    v_need := round(l.qty_per * v_qty, 3);
    perform pg_advisory_xact_lock(hashtextextended(v_company::text || '|' || l.product_id::text || '|' || v_from::text, 0));
    select coalesce(sum(qty), 0) into v_avail from inv.stock_balances where company_id = v_company and product_id = l.product_id and place_id = v_from and bucket = 'available';
    select coalesce(sum(qty), 0) into v_resv from inv.reservations where status = 'active' and company_id = v_company and product_id = l.product_id and place_id = v_from;
    if v_avail - v_resv < v_need and app.negative_allowance(v_company, l.product_id, v_from) is null then
      v_short := v_short || jsonb_build_object('product_id', l.product_id, 'code', l.code, 'needed', v_need, 'free', greatest(v_avail - v_resv, 0));
    end if;
  end loop;
  if jsonb_array_length(v_short) > 0 then
    perform app.raise_rule('prod.components_short', 'components short: ' || (select string_agg(format('%s (need %s, free %s)', x ->> 'code', x ->> 'needed', x ->> 'free'), ', ') from jsonb_array_elements(v_short) x), 'P0001');
  end if;
  v_no := app.internal_doc_no(v_company, 'assembly_order', v_date);
  insert into prod.assembly_orders (company_id, doc_no, bom_id, product_id, qty, from_place_id, to_place_id, labour_hours, order_date, note, assembled_by)
  values (v_company, v_no, b.id, b.product_id, v_qty, v_from, v_to, coalesce(nullif(p ->> 'labour_hours', '')::numeric, 0), v_date, nullif(p ->> 'note', ''), auth.uid())
  returning id into v_id;
  for l in select product_id, qty_per from prod.assembly_bom_lines where bom_id = b.id order by product_id loop
    v_pieces := app.stock_take(v_company, l.product_id, null, v_from, 'available', round(l.qty_per * v_qty, 3), 'consumption', 'prod.assembly_orders', v_id, v_no, v_date, 'Assembly ' || v_no);
    v_value := v_value + app.record_consumption(v_company, 'prod.assembly_orders', v_id, null, 'component', l.product_id, v_from, v_pieces, v_date);
  end loop;
  v_cost := round(v_value / v_qty, 4);
  insert into inv.lots (company_id, product_id, lot_no, mfg_date, source, status, needs_test, received_by)
  values (v_company, b.product_id, v_no, v_date, 'production', 'quarantine', true, auth.uid()) returning id into v_lot;
  perform app.stock_post(v_company, b.product_id, v_lot, v_to, 'quarantine', v_qty, 'production_in', 'prod.assembly_orders', v_id, v_no, v_date, v_cost, 'Assembled; waits for inspection');
  update prod.assembly_orders set lot_id = v_lot, unit_cost = v_cost where id = v_id;
  v_res := jsonb_build_object('id', v_id, 'doc_no', v_no, 'lot_id', v_lot, 'unit_cost', v_cost);
  return app.request_done(p_client_request_id, 'post_assembly', v_res);
end $$;

-- ─────────── Pad printing ───────────
-- p: {company_id, date, product_id, machine_asset_id, operator_user_id, qty_printed, qty_rejected, prints_per_piece, ink_product_id, ink_qty, ink_place_id, labour_minutes, note}
create or replace function api.record_pad_print_job(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_company uuid := nullif(p ->> 'company_id', '')::uuid; v_date date := coalesce(nullif(p ->> 'date', '')::date, current_date); v_no text; v_id uuid;
        v_pieces jsonb; v_value numeric := 0;
begin
  v_prev := app.request_seen(p_client_request_id, 'record_pad_print_job'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'production.create');
  if coalesce((p ->> 'qty_printed')::numeric, -1) < 0 then perform app.raise_rule('print.qty', 'enter the pieces printed', '22023'); end if;
  if nullif(p ->> 'machine_asset_id', '') is not null and not exists (select 1 from core.assets where id = (p ->> 'machine_asset_id')::uuid and company_id = v_company) then
    perform app.raise_rule('asset.missing', 'choose a machine of this company', '22023');
  end if;
  if nullif(p ->> 'ink_product_id', '') is not null and (coalesce((p ->> 'ink_qty')::numeric, 0) <= 0 or nullif(p ->> 'ink_place_id', '') is null) then
    perform app.raise_rule('print.ink', 'enter the ink used and the place it came from', '22023');
  end if;
  perform app.check_stock_date(v_company, v_date);
  v_no := app.internal_doc_no(v_company, 'pad_print', v_date);
  insert into prod.pad_print_jobs (company_id, doc_no, job_date, product_id, machine_asset_id, operator_user_id, qty_printed, qty_rejected, prints_per_piece, ink_product_id, ink_qty,
                                   ink_place_id, labour_minutes, note, recorded_by)
  values (v_company, v_no, v_date, (p ->> 'product_id')::uuid, nullif(p ->> 'machine_asset_id', '')::uuid, nullif(p ->> 'operator_user_id', '')::uuid,
          round((p ->> 'qty_printed')::numeric, 3), round(coalesce(nullif(p ->> 'qty_rejected', '')::numeric, 0), 3), coalesce(nullif(p ->> 'prints_per_piece', '')::int, 1),
          nullif(p ->> 'ink_product_id', '')::uuid, nullif(p ->> 'ink_qty', '')::numeric, nullif(p ->> 'ink_place_id', '')::uuid,
          coalesce(nullif(p ->> 'labour_minutes', '')::numeric, 0), nullif(p ->> 'note', ''), auth.uid())
  returning id into v_id;
  if nullif(p ->> 'ink_product_id', '') is not null then
    v_pieces := app.stock_take(v_company, (p ->> 'ink_product_id')::uuid, null, (p ->> 'ink_place_id')::uuid, 'available', (p ->> 'ink_qty')::numeric, 'consumption', 'prod.pad_print_jobs', v_id, v_no, v_date, 'Pad printing ink');
    v_value := app.record_consumption(v_company, 'prod.pad_print_jobs', v_id, null, 'ink', (p ->> 'ink_product_id')::uuid, (p ->> 'ink_place_id')::uuid, v_pieces, v_date);
    update prod.pad_print_jobs set ink_value = v_value where id = v_id;
  end if;
  v_res := jsonb_build_object('id', v_id, 'doc_no', v_no, 'ink_value', v_value);
  return app.request_done(p_client_request_id, 'record_pad_print_job', v_res);
end $$;

-- ─────────── Material specs ───────────
-- p: {company_id, product_id, granule_product_id, grade, colour, masterbatch_product_id, masterbatch_pct, part_weight_g, runner_weight_g, cavities, packing_cost_per_piece}
create or replace function api.upsert_material_spec(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_company uuid := nullif(p ->> 'company_id', '')::uuid; v_id uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_material_spec'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'production.edit');
  insert into prod.material_specs (company_id, product_id, granule_product_id, grade, colour, masterbatch_product_id, masterbatch_pct, part_weight_g, runner_weight_g, cavities,
                                   packing_cost_per_piece, set_by)
  values (v_company, (p ->> 'product_id')::uuid, nullif(p ->> 'granule_product_id', '')::uuid, nullif(p ->> 'grade', ''), nullif(p ->> 'colour', ''),
          nullif(p ->> 'masterbatch_product_id', '')::uuid, nullif(p ->> 'masterbatch_pct', '')::numeric, nullif(p ->> 'part_weight_g', '')::numeric,
          nullif(p ->> 'runner_weight_g', '')::numeric, nullif(p ->> 'cavities', '')::int, nullif(p ->> 'packing_cost_per_piece', '')::numeric, auth.uid())
  on conflict (company_id, product_id) do update set granule_product_id = excluded.granule_product_id, grade = excluded.grade, colour = excluded.colour,
    masterbatch_product_id = excluded.masterbatch_product_id, masterbatch_pct = excluded.masterbatch_pct, part_weight_g = excluded.part_weight_g,
    runner_weight_g = excluded.runner_weight_g, cavities = excluded.cavities, packing_cost_per_piece = excluded.packing_cost_per_piece, set_by = excluded.set_by, set_at = now()
  returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_material_spec', v_res);
end $$;

-- ─────────── Operator machine checks ───────────
-- p: {asset_id, date, shift, checklist [{item, ok, note}], remarks}. A failed item marks the machine for repair.
create or replace function api.record_machine_check(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; a core.assets; v_ok boolean; v_id uuid; v_date date := coalesce(nullif(p ->> 'date', '')::date, current_date);
begin
  v_prev := app.request_seen(p_client_request_id, 'record_machine_check'); if v_prev is not null then return v_prev; end if;
  select * into a from core.assets where id = (p ->> 'asset_id')::uuid for update;
  if a.id is null then perform app.raise_rule('asset.missing', 'machine not found', 'P0002'); end if;
  perform app.require(a.company_id, 'production.create');
  if v_date > current_date then perform app.raise_rule('date.future', 'the date is in the future', '22023'); end if;
  if jsonb_typeof(p -> 'checklist') <> 'array' or jsonb_array_length(p -> 'checklist') = 0 then perform app.raise_rule('check.empty', 'tick the checklist', '22023'); end if;
  select bool_and(coalesce((x ->> 'ok')::boolean, false)) into v_ok from jsonb_array_elements(p -> 'checklist') x;
  insert into prod.machine_checks (company_id, asset_id, check_date, shift, checklist, all_ok, remarks, checked_by)
  values (a.company_id, a.id, v_date, nullif(p ->> 'shift', ''), p -> 'checklist', v_ok, nullif(p ->> 'remarks', ''), auth.uid()) returning id into v_id;
  if not v_ok and a.status = 'active' then
    update core.assets set status = 'repair' where id = a.id;
    insert into core.asset_events (company_id, asset_id, kind, event_date, detail, recorded_by)
    values (a.company_id, a.id, 'breakdown', v_date, jsonb_build_object('machine_check_id', v_id), auth.uid());
  end if;
  v_res := jsonb_build_object('id', v_id, 'all_ok', v_ok);
  return app.request_done(p_client_request_id, 'record_machine_check', v_res);
end $$;

revoke all on all functions in schema api from public, anon;
grant execute on all functions in schema api to authenticated;
grant execute on function api.log_sign_in_failure(text) to anon;
revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;

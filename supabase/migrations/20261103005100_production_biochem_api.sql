-- 20261103005100_production_biochem_api.sql
-- Phase 5 Biochem RPCs: licences (Admin), process families, formula versions (second-person approval, effective
-- dates), batches through their states (licence block on every production entry), weighing with a second-person
-- check (stock leaves the stores only on the check), samples and lab results against the formula's QC limits,
-- packaging issue and the packaging + bulk reconciliation (Bug fixer item on a difference; blocks close), finished
-- goods into quarantine, QC release / reject with the self-release block, close with batch costing, work
-- assignment with the conflict check, R&D trials and stability, assets and calibrations, packs with the per-pack
-- GST treatment (Q-23) and pack assembly. Every RPC: security definer, client_request_id first, idempotent, row
-- locks, rights + state + period + stock checks; history by triggers. Additive.

-- ─────────── Helpers ───────────
-- Internal document numbers: Phase 4 prefixes plus the Phase 5 ones (created on first use; Admin can change them before use).
create or replace function app.internal_doc_no(p_company uuid, p_doc_type text, p_date date) returns text
language plpgsql security definer set search_path = '' as $$
declare v_fy uuid; v_prefix text;
begin
  select id into v_fy from core.financial_years where company_id = p_company and p_date between starts_on and ends_on;
  if v_fy is null then perform app.raise_rule('period.no_fy', 'no financial year is open for this date; open it on Settings', '22023'); end if;
  if not exists (select 1 from core.doc_series where company_id = p_company and gstin_id is null and doc_type = p_doc_type and fy_id = v_fy) then
    v_prefix := case p_doc_type when 'purchase_request' then 'PR' when 'rfq' then 'RFQ' when 'purchase_order' then 'PO' when 'goods_receipt' then 'GRN'
                  when 'stock_transfer' then 'TR' when 'stock_issue' then 'ST' when 'stock_count' then 'CNT'
                  when 'batch' then 'BT' when 'lab_sample' then 'QC' when 'injection_shift' then 'SH' when 'assembly_order' then 'AS'
                  when 'pack_assembly' then 'PK' when 'pad_print' then 'PP' end;
    if v_prefix is null then perform app.raise_rule('numbering.no_series', 'no number series for ' || p_doc_type || ' in this FY', 'P0001'); end if;
    insert into core.doc_series (company_id, gstin_id, doc_type, fy_id, prefix) values (p_company, null, p_doc_type, v_fy, v_prefix) on conflict do nothing;
  end if;
  return app.take_doc_number(p_company, null, p_doc_type, v_fy);
end $$;

create or replace function app.batch_event(b prod.batches, p_to text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update prod.batches set status = p_to where id = b.id;
  insert into prod.batch_events (company_id, batch_id, from_status, to_status, note, by_user) values (b.company_id, b.id, b.status, p_to, p_note, auth.uid());
end $$;

-- The licence that covers production of a family at a place on a date, or a refusal (Cosmetics Rules 2020: an
-- expired or missing licence blocks production entry). Families without a licence kind need none.
create or replace function app.check_licence(p_company uuid, p_family uuid, p_place uuid, p_date date) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_kind text; v_branch uuid; v_id uuid;
begin
  select licence_kind into v_kind from prod.process_families where id = p_family;
  if v_kind is null then return null; end if;
  select branch_id into v_branch from core.places where id = p_place;
  select id into v_id from core.licences
   where company_id = p_company and kind = v_kind and status = 'active' and valid_from <= p_date and (valid_to is null or valid_to >= p_date)
     and (branch_id is null or branch_id = v_branch)
   order by valid_to desc nulls first limit 1;
  if v_id is null then
    if exists (select 1 from core.licences where company_id = p_company and kind = v_kind and (branch_id is null or branch_id = v_branch)) then
      perform app.raise_rule('licence.expired', 'the ' || replace(v_kind, '_', ' ') || ' licence has expired or is not active on this date; production entry is blocked until Admin records the renewed licence', 'P0001');
    end if;
    perform app.raise_rule('licence.missing', 'no ' || replace(v_kind, '_', ' ') || ' licence is recorded; production entry is blocked until Admin enters it on Licences', 'P0001');
  end if;
  return v_id;
end $$;

-- Instruments and scales must belong to the company, be in use and be within calibration.
create or replace function app.check_instrument(p_company uuid, p_asset uuid, p_date date) returns void
language plpgsql stable security definer set search_path = '' as $$
declare a core.assets;
begin
  if p_asset is null then return; end if;
  select * into a from core.assets where id = p_asset;
  if a.id is null or a.company_id <> p_company then perform app.raise_rule('asset.missing', 'choose an instrument of this company', '22023'); end if;
  if a.status <> 'active' then perform app.raise_rule('asset.not_in_use', a.code || ' is not in use (' || a.status || ')', 'P0001'); end if;
  if a.needs_calibration and (a.calibration_due is null or a.calibration_due < p_date) then
    perform app.raise_rule('asset.calibration_due', a.code || ' is due for calibration; calibrate it or pick another', 'P0001');
  end if;
end $$;

-- The formula version in force for an item on a date (approved, or superseded but still covering that date).
create or replace function app.current_formula_version(p_company uuid, p_product uuid, p_date date) returns uuid
language sql stable security definer set search_path = '' as $$
  select v.id from prod.formula_versions v join prod.formulas f on f.id = v.formula_id
  where f.company_id = p_company and f.product_id = p_product and v.status in ('approved', 'superseded')
    and v.effective_from <= p_date and (v.effective_to is null or v.effective_to >= p_date)
  order by v.effective_from desc, v.version desc limit 1
$$;

-- Bulk per pack in grams: the version's fill, else the item's net quantity when it is a weight.
create or replace function app.fill_g(p_version uuid, p_product uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select fill_qty_g from prod.formula_versions where id = p_version),
                  (select case p.net_qty_uom when 'GMS' then p.net_qty when 'KGS' then p.net_qty * 1000 end from master.products p where p.id = p_product))
$$;

create or replace function app.is_count_uom(p_uom text) returns boolean
language sql immutable set search_path = '' as $$ select p_uom in ('NOS', 'PCS', 'BOX', 'CTN', 'ROL', 'PAC', 'SET', 'DOZ', 'BAG') $$;

-- Everyone who made the batch: planner, weighers and checkers, starter, packaging issuers, packer and anyone assigned a
-- making duty on it. None of them may QC-release or reject it (AGENTS rule 9).
create or replace function app.batch_makers(p_batch uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct u) filter (where u is not null), '{}') from (
    select planned_by as u from prod.batches where id = p_batch
    union all select started_by from prod.batches where id = p_batch
    union all select packed_by from prod.batches where id = p_batch
    union all select weighed_by from prod.weighings where batch_id = p_batch
    union all select verified_by from prod.weighings where batch_id = p_batch
    union all select issued_by from prod.batch_packaging_issues where batch_id = p_batch
    union all select user_id from prod.shift_assignments where batch_id = p_batch and duty not in ('qc_tester', 'qc_releaser', 'inspector')
  ) x
$$;

-- QC limits: parameters outside the formula version's spec for this stage → [{parameter, value, min, max}].
create or replace function app.qc_out_of_spec(p_spec jsonb, p_params jsonb, p_stage text) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('parameter', e ->> 'parameter', 'value', p_params -> (e ->> 'parameter'), 'min', e -> 'min', 'max', e -> 'max')), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_spec, '[]'::jsonb)) e
  where (e ->> 'stage' is null or e ->> 'stage' = p_stage)
    and jsonb_typeof(p_params -> (e ->> 'parameter')) = 'number'
    and ((nullif(e ->> 'min', '') is not null and (p_params ->> (e ->> 'parameter'))::numeric < (e ->> 'min')::numeric)
      or (nullif(e ->> 'max', '') is not null and (p_params ->> (e ->> 'parameter'))::numeric > (e ->> 'max')::numeric))
$$;

-- Recompute the reconciliation of a packed batch.
--  Packaging, per item: issued = in good packs + in rejected packs + scrapped + returned + at the line (exact).
--  Bulk: bulk made (kg) = packs × fill (g) ÷ 1000 + bulk scrapped + bulk left, within production.bulk_loss_pct of the
--  bulk made (setting per company; unset = exact match required).
-- Writes recon_status on the batch and opens (or closes) the Bug fixer item. Never raises.
create or replace function app.batch_recon(p_batch uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  b prod.batches; v_pct numeric; v_packed numeric; v_diff numeric; v_tol numeric; v_bulk_ok boolean; v_pack_ok boolean; v_items jsonb; v_bulk jsonb; v_ok boolean; v_bug uuid;
begin
  select * into b from prod.batches where id = p_batch;
  update prod.packaging_recon r set issued = coalesce((select sum(i.qty) from prod.batch_packaging_issues i where i.batch_id = r.batch_id and i.product_id = r.product_id), 0),
         updated_at = now()
   where r.batch_id = b.id;
  v_pct := nullif(app.setting(b.company_id, 'production.bulk_loss_pct', coalesce(b.batch_date, current_date))::text, 'null')::numeric;
  v_packed := round((coalesce(b.good_packs, 0) + coalesce(b.rejected_packs, 0)) * coalesce(b.fill_qty_g, 0) / 1000, 3);
  v_diff := round(coalesce(b.bulk_qty, 0) - v_packed - b.bulk_scrap_kg - b.bulk_left_kg, 3);
  v_tol := round(coalesce(b.bulk_qty, 0) * coalesce(v_pct, 0) / 100, 3);
  v_bulk_ok := b.bulk_qty is not null and abs(v_diff) <= v_tol;
  select coalesce(bool_and(difference = 0), true),
         coalesce(jsonb_agg(jsonb_build_object('product_id', r.product_id, 'product_code', p.code, 'product_name', p.name, 'issued', r.issued, 'in_good', r.in_good,
                                               'in_rejected', r.in_rejected, 'scrapped', r.scrapped, 'returned', r.returned, 'at_line', r.at_line, 'difference', r.difference)
                            order by p.code), '[]'::jsonb)
    into v_pack_ok, v_items
    from prod.packaging_recon r join master.products p on p.id = r.product_id where r.batch_id = b.id;
  v_bulk := jsonb_build_object('bulk_qty', b.bulk_qty, 'packed_kg', v_packed, 'scrap_kg', b.bulk_scrap_kg, 'left_kg', b.bulk_left_kg, 'difference', v_diff,
                               'tolerance_pct', v_pct, 'tolerance_set', v_pct is not null, 'tolerance_kg', v_tol, 'ok', v_bulk_ok);
  v_ok := v_bulk_ok and v_pack_ok;
  update prod.batches set recon_status = case when v_ok then 'balanced' else 'mismatch' end where id = b.id;
  if v_ok then
    update ops.bug_items set status = 'fixed', fixed_at = now(), fixed_by = auth.uid(), resolution = 'Reconciled on the batch'
     where dedupe_key = 'prod.recon:' || b.id and status = 'open';
  else
    select id into v_bug from ops.bug_items where dedupe_key = 'prod.recon:' || b.id and status = 'open';
    if v_bug is null then
      update ops.bug_items set dedupe_key = dedupe_key || ':' || id where dedupe_key = 'prod.recon:' || b.id;   -- an earlier, fixed item keeps its history
      v_bug := app.open_bug(jsonb_build_object('company_id', b.company_id, 'area', 'production', 'kind', 'control_mismatch', 'severity', 'high',
        'title', 'Batch ' || b.batch_no || ' does not reconcile (packaging or bulk)', 'evidence', jsonb_build_object('batch_id', b.id, 'items', v_items, 'bulk', v_bulk),
        'suggested_fix', 'Recount the packaging at the line, record scrapped and returned items, then reconcile again on the batch',
        'who_fixes', 'production', 'ref_table', 'prod.batches', 'ref_id', b.id, 'dedupe_key', 'prod.recon:' || b.id));
    end if;
  end if;
  return jsonb_build_object('batch_id', b.id, 'balanced', v_ok, 'packaging_ok', v_pack_ok, 'bulk', v_bulk, 'items', v_items, 'bug_item_id', v_bug);
end $$;

-- Cost rate in force (null when not set).
create or replace function app.cost_rate(p_company uuid, p_kind text, p_date date) returns numeric
language sql stable security definer set search_path = '' as $$
  select rate from prod.cost_rates where company_id = p_company and kind = p_kind and effective_from <= p_date order by effective_from desc limit 1
$$;

-- Batch cost = materials at weighted average + packaging + labour hours × rate + machine hours × rate + overhead per kg of bulk.
-- Missing rates count as zero and are listed in rates_missing (never invented).
create or replace function app.batch_cost(p_batch uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare b prod.batches; v_mat numeric; v_pack numeric; v_lr numeric; v_mr numeric; v_or numeric; v_missing text[] := '{}'; v_lab numeric; v_mach numeric; v_ovh numeric; v_total numeric;
begin
  select * into b from prod.batches where id = p_batch;
  select coalesce(sum(value) filter (where kind = 'bulk_material'), 0), coalesce(sum(value) filter (where kind = 'packaging'), 0)
    into v_mat, v_pack from prod.material_consumption where batch_id = b.id;
  v_lr := app.cost_rate(b.company_id, 'labour_hour', b.batch_date); if v_lr is null and b.labour_hours > 0 then v_missing := v_missing || 'labour_hour'; end if;
  v_mr := app.cost_rate(b.company_id, 'machine_hour', b.batch_date); if v_mr is null and b.machine_hours > 0 then v_missing := v_missing || 'machine_hour'; end if;
  v_or := app.cost_rate(b.company_id, 'overhead_per_kg', b.batch_date); if v_or is null then v_missing := v_missing || 'overhead_per_kg'; end if;
  v_lab := round(b.labour_hours * coalesce(v_lr, 0), 2);
  v_mach := round(b.machine_hours * coalesce(v_mr, 0), 2);
  v_ovh := round(coalesce(b.bulk_qty, 0) * coalesce(v_or, 0), 2);
  v_total := round(v_mat + v_pack + v_lab + v_mach + v_ovh, 2);
  return jsonb_build_object('materials', round(v_mat, 2), 'packaging', round(v_pack, 2), 'labour', v_lab, 'machine', v_mach, 'overhead', v_ovh, 'total', v_total,
                            'good_packs', b.good_packs, 'cost_per_pack', case when coalesce(b.good_packs, 0) > 0 then round(v_total / b.good_packs, 4) end,
                            'rates_missing', to_jsonb(v_missing));
end $$;

-- Record consumption pieces returned by app.stock_take.
create or replace function app.record_consumption(p_company uuid, p_source_table text, p_source_id uuid, p_batch uuid, p_kind text, p_product uuid, p_place uuid,
                                                  p_pieces jsonb, p_date date) returns numeric
language plpgsql security definer set search_path = '' as $$
declare pc jsonb; v_total numeric := 0; v_val numeric;
begin
  for pc in select * from jsonb_array_elements(p_pieces) loop
    v_val := round((pc ->> 'qty')::numeric * coalesce((pc ->> 'unit_cost')::numeric, 0), 2);
    insert into prod.material_consumption (company_id, source_table, source_id, batch_id, kind, product_id, lot_id, place_id, qty, unit_cost, value, consumed_on, created_by)
    values (p_company, p_source_table, p_source_id, p_batch, p_kind, p_product, nullif(pc ->> 'lot_id', '')::uuid, p_place, (pc ->> 'qty')::numeric,
            coalesce((pc ->> 'unit_cost')::numeric, 0), v_val, p_date, auth.uid());
    v_total := v_total + v_val;
  end loop;
  return v_total;
end $$;

-- ─────────── Licences (Admin) ───────────
-- p: {id?, company_id, branch_id, kind, licence_no, issued_by, valid_from, valid_to, status, document_path, note}
create or replace function api.upsert_licence(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_company uuid := nullif(p ->> 'company_id', '')::uuid; v_branch uuid := nullif(p ->> 'branch_id', '')::uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_licence'); if v_prev is not null then return v_prev; end if;
  if v_id is not null then
    select company_id into v_company from core.licences where id = v_id for update;
    if v_company is null then perform app.raise_rule('licence.missing_row', 'licence not found', 'P0002'); end if;
  end if;
  perform app.require(v_company, 'settings.manage');
  if coalesce(length(trim(p ->> 'licence_no')), 0) = 0 then perform app.raise_rule('licence.no_number', 'enter the licence number exactly as printed on the licence', '22023'); end if;
  if nullif(p ->> 'valid_from', '') is null then perform app.raise_rule('licence.dates', 'enter the date the licence is valid from', '22023'); end if;
  if v_branch is not null and not exists (select 1 from core.branches where id = v_branch and company_id = v_company) then
    perform app.raise_rule('org.branch_other_company', 'the branch belongs to another company', '22023');
  end if;
  if v_id is null then
    insert into core.licences (company_id, branch_id, kind, licence_no, issued_by, valid_from, valid_to, status, document_path, note, created_by)
    values (v_company, v_branch, p ->> 'kind', trim(p ->> 'licence_no'), nullif(p ->> 'issued_by', ''), (p ->> 'valid_from')::date, nullif(p ->> 'valid_to', '')::date,
            coalesce(nullif(p ->> 'status', ''), 'active'), nullif(p ->> 'document_path', ''), nullif(p ->> 'note', ''), auth.uid())
    returning id into v_id;
  else
    update core.licences set branch_id = v_branch, kind = p ->> 'kind', licence_no = trim(p ->> 'licence_no'), issued_by = nullif(p ->> 'issued_by', ''),
      valid_from = (p ->> 'valid_from')::date, valid_to = nullif(p ->> 'valid_to', '')::date, status = coalesce(nullif(p ->> 'status', ''), status),
      document_path = coalesce(nullif(p ->> 'document_path', ''), document_path), note = nullif(p ->> 'note', ''), updated_at = now()
    where id = v_id;
  end if;
  perform app.log_event('setting_changed', jsonb_build_object('entity', 'licence', 'id', v_id, 'company_id', v_company, 'kind', p ->> 'kind', 'valid_to', p ->> 'valid_to'));
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_licence', v_res);
end $$;

-- ─────────── Families and formulas ───────────
-- p: {id?, company_id, code, name, licence_kind (null = none needed), steps [text], status}
create or replace function api.upsert_process_family(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_company uuid := nullif(p ->> 'company_id', '')::uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_process_family'); if v_prev is not null then return v_prev; end if;
  if v_id is not null then select company_id into v_company from prod.process_families where id = v_id for update; end if;
  perform app.require(v_company, 'production.edit');
  if coalesce(length(trim(p ->> 'code')), 0) = 0 or coalesce(length(trim(p ->> 'name')), 0) = 0 then perform app.raise_rule('prod.family_name', 'enter the family code and name', '22023'); end if;
  if v_id is null then
    insert into prod.process_families (company_id, code, name, licence_kind, steps, status, created_by)
    values (v_company, upper(trim(p ->> 'code')), trim(p ->> 'name'), nullif(p ->> 'licence_kind', ''), coalesce(p -> 'steps', '[]'::jsonb), coalesce(nullif(p ->> 'status', ''), 'active'), auth.uid())
    returning id into v_id;
  else
    update prod.process_families set code = upper(trim(p ->> 'code')), name = trim(p ->> 'name'), licence_kind = nullif(p ->> 'licence_kind', ''),
      steps = coalesce(p -> 'steps', steps), status = coalesce(nullif(p ->> 'status', ''), status) where id = v_id;
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_process_family', v_res);
end $$;

-- Save a draft formula version (new formula, new version, or edit of an own draft).
-- p: {company_id, formula_id? | (product_id, family_id, code, name), version_id? (draft to edit), batch_size (kg), fill_qty_g, notes,
--     qc_spec [{parameter, min, max, unit, stage}], lines [{line_kind bulk|packaging, product_id, qty, note}]}
create or replace function api.save_formula_version(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_res jsonb; v_company uuid := nullif(p ->> 'company_id', '')::uuid; v_formula uuid := nullif(p ->> 'formula_id', '')::uuid;
  v_version uuid := nullif(p ->> 'version_id', '')::uuid; f prod.formulas; v prod.formula_versions; l jsonb; v_n int := 0; v_bulk int := 0; v_uom text; v_fg_uom text; v_no int;
begin
  v_prev := app.request_seen(p_client_request_id, 'save_formula_version'); if v_prev is not null then return v_prev; end if;
  if v_version is not null then
    select * into v from prod.formula_versions where id = v_version for update;
    if v.id is null then perform app.raise_rule('formula.missing', 'formula version not found', 'P0002'); end if;
    v_formula := v.formula_id; v_company := v.company_id;
  end if;
  if v_formula is not null then
    select * into f from prod.formulas where id = v_formula for update;
    if f.id is null then perform app.raise_rule('formula.missing', 'formula not found', 'P0002'); end if;
    v_company := f.company_id;
  end if;
  perform app.require(v_company, 'production.create');
  if f.id is null then
    if not exists (select 1 from prod.process_families where id = (p ->> 'family_id')::uuid and company_id = v_company) then
      perform app.raise_rule('prod.family_missing', 'choose the process family of this company', '22023');
    end if;
    if coalesce(length(trim(p ->> 'code')), 0) = 0 then perform app.raise_rule('formula.code', 'enter the formula code', '22023'); end if;
    insert into prod.formulas (company_id, product_id, family_id, code, name, created_by)
    values (v_company, (p ->> 'product_id')::uuid, (p ->> 'family_id')::uuid, upper(trim(p ->> 'code')), coalesce(nullif(trim(p ->> 'name'), ''), upper(trim(p ->> 'code'))), auth.uid())
    returning * into f;
  end if;
  select uom into v_fg_uom from master.products where id = f.product_id;
  if not app.is_count_uom(v_fg_uom) then perform app.raise_rule('prod.pack_in_nos', 'the finished item must be counted in Nos (packs)', '22023'); end if;
  if coalesce((p ->> 'batch_size')::numeric, 0) <= 0 then perform app.raise_rule('formula.batch_size', 'enter the batch size in kg', '22023'); end if;
  if v.id is not null then
    if v.status <> 'draft' then perform app.raise_rule('formula.not_draft', 'only a draft can be changed; make a new version', '22023'); end if;
    update prod.formula_versions set batch_size = round((p ->> 'batch_size')::numeric, 3), fill_qty_g = nullif(p ->> 'fill_qty_g', '')::numeric,
      qc_spec = coalesce(p -> 'qc_spec', '[]'::jsonb), notes = nullif(p ->> 'notes', '') where id = v.id;
    delete from prod.formula_lines where version_id = v.id;
  else
    select coalesce(max(version), 0) + 1 into v_no from prod.formula_versions where formula_id = f.id;
    insert into prod.formula_versions (company_id, formula_id, version, batch_size, fill_qty_g, qc_spec, notes, created_by)
    values (v_company, f.id, v_no, round((p ->> 'batch_size')::numeric, 3), nullif(p ->> 'fill_qty_g', '')::numeric, coalesce(p -> 'qc_spec', '[]'::jsonb), nullif(p ->> 'notes', ''), auth.uid())
    returning * into v;
  end if;
  for l in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    select uom into v_uom from master.products where id = (l ->> 'product_id')::uuid;
    if v_uom is null then perform app.raise_rule('product.missing', 'item not found', 'P0002'); end if;
    if coalesce((l ->> 'qty')::numeric, 0) <= 0 then perform app.raise_rule('formula.qty', 'every line needs a quantity above zero', '22023'); end if;
    if l ->> 'line_kind' = 'bulk' then
      if v_uom <> 'KGS' then perform app.raise_rule('prod.bulk_by_weight', 'bulk materials are entered by weight (kg) only', '22023'); end if;
      v_bulk := v_bulk + 1;
    elsif l ->> 'line_kind' = 'packaging' then
      if not app.is_count_uom(v_uom) then perform app.raise_rule('prod.packaging_in_nos', 'packaging is entered in Nos only', '22023'); end if;
    else
      perform app.raise_rule('formula.line_kind', 'each line is bulk or packaging', '22023');
    end if;
    v_n := v_n + 1;
    insert into prod.formula_lines (company_id, version_id, line_no, line_kind, product_id, qty, note)
    values (v_company, v.id, v_n, l ->> 'line_kind', (l ->> 'product_id')::uuid, round((l ->> 'qty')::numeric, 3), nullif(l ->> 'note', ''));
  end loop;
  if v_bulk = 0 then perform app.raise_rule('formula.no_bulk', 'add at least one bulk material', '22023'); end if;
  v_res := jsonb_build_object('formula_id', f.id, 'version_id', v.id, 'version', v.version, 'status', 'draft');
  return app.request_done(p_client_request_id, 'save_formula_version', v_res);
end $$;

create or replace function api.submit_formula_version(p_client_request_id uuid, p_version_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v prod.formula_versions;
begin
  v_prev := app.request_seen(p_client_request_id, 'submit_formula_version'); if v_prev is not null then return v_prev; end if;
  select * into v from prod.formula_versions where id = p_version_id for update;
  if v.id is null then perform app.raise_rule('formula.missing', 'formula version not found', 'P0002'); end if;
  perform app.require(v.company_id, 'production.create');
  if v.status <> 'draft' then perform app.raise_rule('formula.state', 'only a draft can be sent for approval', '22023'); end if;
  update prod.formula_versions set status = 'submitted', submitted_by = auth.uid(), submitted_at = now() where id = v.id;
  v_res := jsonb_build_object('id', v.id, 'status', 'submitted');
  return app.request_done(p_client_request_id, 'submit_formula_version', v_res);
end $$;

-- Approve a submitted version (production.approve, never the person who wrote or submitted it). From its effective date it
-- replaces the version in force, which ends the day before.
create or replace function api.approve_formula_version(p_client_request_id uuid, p_version_id uuid, p_effective_from date default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v prod.formula_versions; v_eff date := coalesce(p_effective_from, current_date);
begin
  v_prev := app.request_seen(p_client_request_id, 'approve_formula_version'); if v_prev is not null then return v_prev; end if;
  select * into v from prod.formula_versions where id = p_version_id for update;
  if v.id is null then perform app.raise_rule('formula.missing', 'formula version not found', 'P0002'); end if;
  perform app.require(v.company_id, 'production.approve');
  if v.status <> 'submitted' then perform app.raise_rule('formula.state', 'send the version for approval first', '22023'); end if;
  if auth.uid() = v.created_by or auth.uid() = v.submitted_by then perform app.raise_rule('sod.own_formula', 'someone else must approve a formula you wrote or submitted', '42501'); end if;
  perform 1 from prod.formula_versions where formula_id = v.formula_id for update;
  if exists (select 1 from prod.formula_versions where formula_id = v.formula_id and id <> v.id and status = 'approved' and effective_from >= v_eff) then
    perform app.raise_rule('formula.effective_overlap', 'another approved version starts on or after this date; choose a later date', '22023');
  end if;
  update prod.formula_versions set status = 'superseded', effective_to = v_eff - 1 where formula_id = v.formula_id and id <> v.id and status = 'approved';
  update prod.formula_versions set status = 'approved', approved_by = auth.uid(), approved_at = now(), effective_from = v_eff where id = v.id;
  v_res := jsonb_build_object('id', v.id, 'status', 'approved', 'effective_from', v_eff);
  return app.request_done(p_client_request_id, 'approve_formula_version', v_res);
end $$;

create or replace function api.withdraw_formula_version(p_client_request_id uuid, p_version_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v prod.formula_versions;
begin
  v_prev := app.request_seen(p_client_request_id, 'withdraw_formula_version'); if v_prev is not null then return v_prev; end if;
  select * into v from prod.formula_versions where id = p_version_id for update;
  if v.id is null then perform app.raise_rule('formula.missing', 'formula version not found', 'P0002'); end if;
  perform app.require(v.company_id, 'production.approve');
  if v.status not in ('draft', 'submitted', 'approved') then perform app.raise_rule('formula.state', 'this version is already out of use', '22023'); end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'reason required', '22023'); end if;
  update prod.formula_versions set status = 'withdrawn', effective_to = case when status = 'approved' then greatest(current_date, effective_from) end,
    notes = coalesce(notes || ' · ', '') || 'Withdrawn: ' || trim(p_reason) where id = v.id;
  v_res := jsonb_build_object('id', v.id, 'status', 'withdrawn');
  return app.request_done(p_client_request_id, 'withdraw_formula_version', v_res);
end $$;

-- ─────────── Batches ───────────
-- p: {company_id, product_id, formula_version_id?, planned_qty (kg bulk), date, shift, line_place_id, stores_place_id, fg_place_id, note}
create or replace function api.plan_batch(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_res jsonb; v_company uuid := nullif(p ->> 'company_id', '')::uuid; v_product uuid := (p ->> 'product_id')::uuid; v_date date := coalesce(nullif(p ->> 'date', '')::date, current_date);
  v_version uuid := nullif(p ->> 'formula_version_id', '')::uuid; v_line uuid := (p ->> 'line_place_id')::uuid; v_stores uuid := (p ->> 'stores_place_id')::uuid; v_fg uuid := (p ->> 'fg_place_id')::uuid;
  v_family uuid; v_licence uuid; v_no text; v_id uuid; b prod.batches;
begin
  v_prev := app.request_seen(p_client_request_id, 'plan_batch'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'production.create');
  if coalesce((p ->> 'planned_qty')::numeric, 0) <= 0 then perform app.raise_rule('prod.qty', 'enter the bulk to make, in kg', '22023'); end if;
  if (select count(*) from core.places where id in (v_line, v_stores, v_fg) and company_id = v_company) <> (select count(distinct x) from unnest(array[v_line, v_stores, v_fg]) x) then
    perform app.raise_rule('stock.place_other_company', 'choose the line, stores and finished-goods places of this company', '22023');
  end if;
  if v_line = v_stores then perform app.raise_rule('stock.same_place', 'the production line must be a different place from the stores', '22023'); end if;
  perform app.check_stock_date(v_company, v_date);
  if v_version is null then
    v_version := app.current_formula_version(v_company, v_product, v_date);
  elsif v_version is distinct from (select v.id from prod.formula_versions v join prod.formulas f on f.id = v.formula_id
                                     where v.id = v_version and f.company_id = v_company and f.product_id = v_product and v.status in ('approved', 'superseded')
                                       and v.effective_from <= v_date and (v.effective_to is null or v.effective_to >= v_date)) then
    v_version := null;
  end if;
  if v_version is null then perform app.raise_rule('prod.no_approved_formula', 'no approved formula is in force for this item on this date; a batch cannot open', 'P0001'); end if;
  select f.family_id into v_family from prod.formula_versions v join prod.formulas f on f.id = v.formula_id where v.id = v_version;
  v_licence := app.check_licence(v_company, v_family, v_line, v_date);
  v_no := app.internal_doc_no(v_company, 'batch', v_date);
  insert into prod.batches (company_id, batch_no, product_id, formula_version_id, family_id, licence_id, line_place_id, stores_place_id, fg_place_id, batch_date, shift,
                            planned_qty, note, planned_by)
  values (v_company, v_no, v_product, v_version, v_family, v_licence, v_line, v_stores, v_fg, v_date, nullif(p ->> 'shift', ''), round((p ->> 'planned_qty')::numeric, 3),
          nullif(p ->> 'note', ''), auth.uid())
  returning id into v_id;
  insert into prod.batch_events (company_id, batch_id, from_status, to_status, by_user) values (v_company, v_id, null, 'planned', auth.uid());
  v_res := jsonb_build_object('id', v_id, 'batch_no', v_no, 'status', 'planned', 'formula_version_id', v_version, 'licence_id', v_licence);
  return app.request_done(p_client_request_id, 'plan_batch', v_res);
end $$;

-- Lock a batch, check the right and (optionally) the allowed states; re-check the licence for production entry.
create or replace function app.lock_batch(p_batch uuid, p_right text, p_states text[], p_licence boolean default true) returns prod.batches
language plpgsql security definer set search_path = '' as $$
declare b prod.batches;
begin
  select * into b from prod.batches where id = p_batch for update;
  if b.id is null then perform app.raise_rule('batch.missing', 'batch not found', 'P0002'); end if;
  perform app.require(b.company_id, p_right);
  if p_states is not null and not (b.status = any (p_states)) then
    perform app.raise_rule('batch.state', 'batch ' || b.batch_no || ' is ' || replace(b.status, '_', ' ') || '; this step is not open now', '22023');
  end if;
  if p_licence then perform app.check_licence(b.company_id, b.family_id, b.line_place_id, current_date); end if;
  return b;
end $$;

create or replace function api.reserve_batch_materials(p_client_request_id uuid, p_batch_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; b prod.batches; v prod.formula_versions; l record; v_need numeric; v_avail numeric; v_res_other numeric; v_n int := 0;
begin
  v_prev := app.request_seen(p_client_request_id, 'reserve_batch_materials'); if v_prev is not null then return v_prev; end if;
  b := app.lock_batch(p_batch_id, 'production.create', array['planned']);
  select * into v from prod.formula_versions where id = b.formula_version_id;
  for l in select * from prod.formula_lines where version_id = v.id and line_kind = 'bulk' order by line_no loop
    v_need := round(l.qty * b.planned_qty / v.batch_size, 3);
    perform pg_advisory_xact_lock(hashtextextended(b.company_id::text || '|' || l.product_id::text || '|' || b.stores_place_id::text, 0));
    select coalesce(sum(qty), 0) into v_avail from inv.stock_balances where company_id = b.company_id and product_id = l.product_id and place_id = b.stores_place_id and bucket = 'available';
    select coalesce(sum(qty), 0) into v_res_other from inv.reservations where status = 'active' and company_id = b.company_id and product_id = l.product_id and place_id = b.stores_place_id;
    if v_avail - v_res_other < v_need then
      perform app.raise_rule('stock.insufficient', format('not enough released stock of %s: %s free, %s needed', (select code from master.products where id = l.product_id),
                                                         greatest(v_avail - v_res_other, 0), v_need), 'P0001');
    end if;
    insert into inv.reservations (company_id, product_id, place_id, qty, source_table, source_id, source_line_id, created_by)
    values (b.company_id, l.product_id, b.stores_place_id, v_need, 'prod.batches', b.id, l.id, auth.uid());
    v_n := v_n + 1;
  end loop;
  perform app.batch_event(b, 'reserved');
  v_res := jsonb_build_object('id', b.id, 'status', 'reserved', 'lines', v_n);
  return app.request_done(p_client_request_id, 'reserve_batch_materials', v_res);
end $$;

-- p_lines: [{product_id, lot_id, qty (kg), scale_asset_id, note}]. Nothing leaves the stores until a second person checks it.
create or replace function api.record_weighing(p_client_request_id uuid, p_batch_id uuid, p_lines jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; b prod.batches; v prod.formula_versions; l jsonb; fl prod.formula_lines; v_id uuid; v_ids jsonb := '[]'::jsonb; v_lot uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'record_weighing'); if v_prev is not null then return v_prev; end if;
  b := app.lock_batch(p_batch_id, 'production.create', array['reserved', 'weighed']);
  select * into v from prod.formula_versions where id = b.formula_version_id;
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    select * into fl from prod.formula_lines where version_id = v.id and line_kind = 'bulk' and product_id = (l ->> 'product_id')::uuid limit 1;
    if fl.id is null then perform app.raise_rule('prod.not_in_formula', 'this material is not in the approved formula', '22023'); end if;
    if coalesce((l ->> 'qty')::numeric, 0) <= 0 then perform app.raise_rule('prod.qty', 'enter the weight in kg', '22023'); end if;
    v_lot := nullif(l ->> 'lot_id', '')::uuid;
    if v_lot is not null and not exists (select 1 from inv.lots where id = v_lot and product_id = fl.product_id and company_id = b.company_id and status = 'available') then
      perform app.raise_rule('stock.lot_not_released', 'this lot is not released for use', 'P0001');
    end if;
    perform app.check_instrument(b.company_id, nullif(l ->> 'scale_asset_id', '')::uuid, current_date);
    insert into prod.weighings (company_id, batch_id, product_id, lot_id, planned_qty, weighed_qty, scale_asset_id, weighed_by, note)
    values (b.company_id, b.id, fl.product_id, v_lot, round(fl.qty * b.planned_qty / v.batch_size, 3), round((l ->> 'qty')::numeric, 3), nullif(l ->> 'scale_asset_id', '')::uuid,
            auth.uid(), nullif(l ->> 'note', ''))
    returning id into v_id;
    v_ids := v_ids || to_jsonb(v_id);
  end loop;
  if jsonb_array_length(v_ids) = 0 then perform app.raise_rule('doc.no_lines', 'add at least one weighing', '22023'); end if;
  v_res := jsonb_build_object('batch_id', b.id, 'weighing_ids', v_ids);
  return app.request_done(p_client_request_id, 'record_weighing', v_res);
end $$;

-- Second-person check of one weighing. OK → the weight leaves the stores into the batch (consumption ledger); not OK → re-weigh.
create or replace function api.verify_weighing(p_client_request_id uuid, p_weighing_id uuid, p_ok boolean default true, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; w prod.weighings; b prod.batches; v_pieces jsonb; v_value numeric; v_missing int;
begin
  v_prev := app.request_seen(p_client_request_id, 'verify_weighing'); if v_prev is not null then return v_prev; end if;
  select * into w from prod.weighings where id = p_weighing_id for update;
  if w.id is null then perform app.raise_rule('weighing.missing', 'weighing not found', 'P0002'); end if;
  b := app.lock_batch(w.batch_id, 'production.create', array['reserved', 'weighed']);
  if w.status <> 'weighed' then perform app.raise_rule('weighing.state', 'this weighing is already checked', '22023'); end if;
  if w.weighed_by = auth.uid() then perform app.raise_rule('sod.own_weighing', 'a second person must check the weighing you made', '42501'); end if;
  if not coalesce(p_ok, true) then
    update prod.weighings set status = 'rejected', verified_by = auth.uid(), verified_at = now(), note = coalesce(p_note, note) where id = w.id;
    v_res := jsonb_build_object('id', w.id, 'status', 'rejected');
    return app.request_done(p_client_request_id, 'verify_weighing', v_res);
  end if;
  perform app.check_stock_date(b.company_id, current_date);
  v_pieces := app.stock_take(b.company_id, w.product_id, w.lot_id, b.stores_place_id, 'available', w.weighed_qty, 'consumption', 'prod.weighings', w.id, b.batch_no,
                             current_date, 'Weighed for batch ' || b.batch_no, b.id);
  v_value := app.record_consumption(b.company_id, 'prod.weighings', w.id, b.id, 'bulk_material', w.product_id, b.stores_place_id, v_pieces, current_date);
  update inv.reservations set qty = qty - w.weighed_qty where status = 'active' and source_id = b.id and product_id = w.product_id and qty > w.weighed_qty;
  if not found then
    update inv.reservations set status = 'consumed', closed_at = now() where status = 'active' and source_id = b.id and product_id = w.product_id;
  end if;
  update prod.weighings set status = 'verified', verified_by = auth.uid(), verified_at = now(), note = coalesce(p_note, note) where id = w.id;
  select count(*) into v_missing from prod.formula_lines fl where fl.version_id = b.formula_version_id and fl.line_kind = 'bulk'
     and not exists (select 1 from prod.weighings x where x.batch_id = b.id and x.product_id = fl.product_id and x.status = 'verified');
  if v_missing = 0 and b.status = 'reserved' then perform app.batch_event(b, 'weighed'); end if;
  v_res := jsonb_build_object('id', w.id, 'status', 'verified', 'value', v_value, 'batch_status', case when v_missing = 0 then 'weighed' else b.status end);
  return app.request_done(p_client_request_id, 'verify_weighing', v_res);
end $$;

create or replace function api.start_batch(p_client_request_id uuid, p_batch_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; b prod.batches;
begin
  v_prev := app.request_seen(p_client_request_id, 'start_batch'); if v_prev is not null then return v_prev; end if;
  b := app.lock_batch(p_batch_id, 'production.create', array['weighed']);
  if exists (select 1 from prod.weighings where batch_id = b.id and status = 'weighed') then
    perform app.raise_rule('weighing.pending', 'a weighing still waits for the second-person check', '22023');
  end if;
  update prod.batches set started_by = auth.uid(), started_at = now() where id = b.id;
  perform app.batch_event(b, 'in_process');
  v_res := jsonb_build_object('id', b.id, 'status', 'in_process');
  return app.request_done(p_client_request_id, 'start_batch', v_res);
end $$;

-- p: {kind in_process|bulk|finished|retained, bulk_qty (kg, required for bulk), labour_hours, machine_hours, assigned_to, retain_until, note}
create or replace function api.send_sample(p_client_request_id uuid, p_batch_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; b prod.batches; v_kind text := p ->> 'kind'; v_no text; v_id uuid; v_lot uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'send_sample'); if v_prev is not null then return v_prev; end if;
  b := app.lock_batch(p_batch_id, 'production.create',
                      case v_kind when 'in_process' then array['in_process'] when 'bulk' then array['in_process'] when 'finished' then array['packed_hold']
                                  when 'retained' then array['packed_hold', 'released', 'closed'] else array['-'] end,
                      v_kind in ('in_process', 'bulk'));
  if v_kind = 'bulk' then
    if coalesce((p ->> 'bulk_qty')::numeric, 0) <= 0 then perform app.raise_rule('prod.no_bulk_qty', 'enter the bulk made, by weight (kg)', '22023'); end if;
    update prod.batches set bulk_qty = round((p ->> 'bulk_qty')::numeric, 3),
      labour_hours = labour_hours + coalesce(nullif(p ->> 'labour_hours', '')::numeric, 0), machine_hours = machine_hours + coalesce(nullif(p ->> 'machine_hours', '')::numeric, 0)
    where id = b.id;
  end if;
  if v_kind in ('finished', 'retained') then v_lot := b.fg_lot_id; end if;
  v_no := app.internal_doc_no(b.company_id, 'lab_sample', current_date);
  insert into prod.lab_samples (company_id, sample_no, kind, batch_id, lot_id, assigned_to, status, retain_until, note, taken_by)
  values (b.company_id, v_no, v_kind, b.id, v_lot, nullif(p ->> 'assigned_to', '')::uuid, case when v_kind = 'retained' then 'retained' else 'pending' end,
          nullif(p ->> 'retain_until', '')::date, nullif(p ->> 'note', ''), auth.uid())
  returning id into v_id;
  if v_kind = 'bulk' then perform app.batch_event(b, 'sample_sent', v_no); end if;
  v_res := jsonb_build_object('sample_id', v_id, 'sample_no', v_no, 'batch_status', case when v_kind = 'bulk' then 'sample_sent' else b.status end);
  return app.request_done(p_client_request_id, 'send_sample', v_res);
end $$;

-- p: {result pass|fail|hold, parameters {name: number}, instrument_id, remarks, date}. A pass outside the formula's limits is refused.
create or replace function api.record_lab_result(p_client_request_id uuid, p_sample_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; s prod.lab_samples; b prod.batches; v_result text := p ->> 'result'; v_spec jsonb; v_oos jsonb; v_id uuid; v_inst uuid := nullif(p ->> 'instrument_id', '')::uuid;
        v_date date := coalesce(nullif(p ->> 'date', '')::date, current_date);
begin
  v_prev := app.request_seen(p_client_request_id, 'record_lab_result'); if v_prev is not null then return v_prev; end if;
  select * into s from prod.lab_samples where id = p_sample_id for update;
  if s.id is null then perform app.raise_rule('qc.sample_missing', 'sample not found', 'P0002'); end if;
  if s.kind = 'rnd' then perform app.require(s.company_id, 'lab.rnd'); else perform app.require(s.company_id, 'qc.test'); end if;
  if s.status not in ('pending', 'retained') then perform app.raise_rule('qc.sample_state', 'this sample already has its result', '22023'); end if;
  if v_result not in ('pass', 'fail', 'hold') then perform app.raise_rule('qc.result', 'the result is pass, fail or hold', '22023'); end if;
  if v_date > current_date then perform app.raise_rule('date.future', 'the date is in the future', '22023'); end if;
  perform app.check_instrument(s.company_id, v_inst, v_date);
  if s.batch_id is not null then
    select * into b from prod.batches where id = s.batch_id for update;
    select qc_spec into v_spec from prod.formula_versions where id = b.formula_version_id;
  elsif s.trial_id is not null then
    select v.qc_spec into v_spec from prod.rnd_trials t join prod.formula_versions v on v.id = t.formula_version_id where t.id = s.trial_id;
  end if;
  v_oos := app.qc_out_of_spec(v_spec, coalesce(p -> 'parameters', '{}'::jsonb), s.kind);
  if v_result = 'pass' and jsonb_array_length(v_oos) > 0 then
    perform app.raise_rule('qc.out_of_spec', 'some results are outside the approved limits; the sample cannot pass', 'P0001');
  end if;
  insert into prod.lab_tests (company_id, lot_id, kind, result, parameters, remarks, test_date, tested_by, batch_id, sample_id, instrument_id, out_of_spec)
  values (s.company_id, s.lot_id, s.kind, v_result, coalesce(p -> 'parameters', '{}'::jsonb), nullif(p ->> 'remarks', ''), v_date, auth.uid(), s.batch_id, s.id, v_inst, v_oos)
  returning id into v_id;
  if v_result <> 'hold' and s.status = 'pending' then update prod.lab_samples set status = 'tested' where id = s.id; end if;
  if s.kind = 'bulk' and b.status = 'sample_sent' and v_result in ('pass', 'fail') then
    perform app.batch_event(b, case v_result when 'pass' then 'bulk_passed' else 'bulk_failed' end, 'Lab result on ' || s.sample_no);
  end if;
  v_res := jsonb_build_object('id', v_id, 'result', v_result, 'out_of_spec', v_oos);
  return app.request_done(p_client_request_id, 'record_lab_result', v_res);
end $$;

-- Packaging to the line, in Nos. p_lines: [{product_id, lot_id, qty}]
create or replace function api.issue_batch_packaging(p_client_request_id uuid, p_batch_id uuid, p_lines jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; b prod.batches; l jsonb; v_pieces jsonb; pc jsonb; v_qty numeric; v_product uuid; v_n int := 0;
begin
  v_prev := app.request_seen(p_client_request_id, 'issue_batch_packaging'); if v_prev is not null then return v_prev; end if;
  b := app.lock_batch(p_batch_id, 'production.create', array['bulk_passed', 'packing']);
  perform app.check_stock_date(b.company_id, current_date);
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_product := (l ->> 'product_id')::uuid; v_qty := (l ->> 'qty')::numeric;
    if not app.is_count_uom((select uom from master.products where id = v_product)) then perform app.raise_rule('prod.packaging_in_nos', 'packaging is entered in Nos only', '22023'); end if;
    if coalesce(v_qty, 0) <= 0 or v_qty <> trunc(v_qty) then perform app.raise_rule('prod.packaging_whole', 'packaging is issued in whole numbers', '22023'); end if;
    v_pieces := app.stock_take(b.company_id, v_product, nullif(l ->> 'lot_id', '')::uuid, b.stores_place_id, 'available', v_qty, 'issue', 'prod.batches', b.id, b.batch_no,
                               current_date, 'Packaging to line for ' || b.batch_no);
    for pc in select * from jsonb_array_elements(v_pieces) loop
      perform app.stock_post(b.company_id, v_product, nullif(pc ->> 'lot_id', '')::uuid, b.line_place_id, 'available', (pc ->> 'qty')::numeric, 'issue_in', 'prod.batches', b.id,
                             b.batch_no, current_date, (pc ->> 'unit_cost')::numeric, 'Packaging to line for ' || b.batch_no);
    end loop;
    insert into prod.batch_packaging_issues (company_id, batch_id, product_id, qty, issued_by) values (b.company_id, b.id, v_product, v_qty, auth.uid());
    insert into prod.packaging_recon (company_id, batch_id, product_id, issued, updated_by) values (b.company_id, b.id, v_product, v_qty, auth.uid())
    on conflict (batch_id, product_id) do update set issued = prod.packaging_recon.issued + excluded.issued, updated_by = excluded.updated_by, updated_at = now();
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then perform app.raise_rule('doc.no_lines', 'add at least one packaging item', '22023'); end if;
  if b.status = 'bulk_passed' then perform app.batch_event(b, 'packing'); end if;
  v_res := jsonb_build_object('batch_id', b.id, 'lines', v_n, 'status', 'packing');
  return app.request_done(p_client_request_id, 'issue_batch_packaging', v_res);
end $$;

-- Apply packaging counts at the line: consume (scrapped), return to stores; at_line is the physical count left at the line.
create or replace function app.apply_packaging_counts(b prod.batches, p_counts jsonb, p_initial boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare c jsonb; r prod.packaging_recon; v_scr numeric; v_ret numeric; v_pieces jsonb; pc jsonb;
begin
  for c in select * from jsonb_array_elements(coalesce(p_counts, '[]'::jsonb)) loop
    select * into r from prod.packaging_recon where batch_id = b.id and product_id = (c ->> 'product_id')::uuid for update;
    if r.id is null then perform app.raise_rule('prod.not_issued', 'this item was not issued to the batch', '22023'); end if;
    v_scr := coalesce(nullif(c ->> 'scrapped', '')::numeric, r.scrapped);
    v_ret := coalesce(nullif(c ->> 'returned', '')::numeric, r.returned);
    if v_scr < r.scrapped or v_ret < r.returned then perform app.raise_rule('prod.recon_decrease', 'scrapped and returned counts can only go up; correct the line count instead', '22023'); end if;
    if v_scr <> trunc(v_scr) or v_ret <> trunc(v_ret) or coalesce(nullif(c ->> 'at_line', '')::numeric, 0) <> trunc(coalesce(nullif(c ->> 'at_line', '')::numeric, 0)) then
      perform app.raise_rule('prod.packaging_whole', 'packaging is counted in whole numbers', '22023');
    end if;
    if v_scr > r.scrapped then
      v_pieces := app.stock_take(b.company_id, r.product_id, null, b.line_place_id, 'available', v_scr - r.scrapped, 'consumption', 'prod.batches', b.id, b.batch_no, current_date, 'Scrapped at line');
      perform app.record_consumption(b.company_id, 'prod.batches', b.id, b.id, 'packaging', r.product_id, b.line_place_id, v_pieces, current_date);
    end if;
    if v_ret > r.returned then
      v_pieces := app.stock_take(b.company_id, r.product_id, null, b.line_place_id, 'available', v_ret - r.returned, 'return', 'prod.batches', b.id, b.batch_no, current_date, 'Returned from line');
      for pc in select * from jsonb_array_elements(v_pieces) loop
        perform app.stock_post(b.company_id, r.product_id, nullif(pc ->> 'lot_id', '')::uuid, b.stores_place_id, 'available', (pc ->> 'qty')::numeric, 'return', 'prod.batches', b.id,
                               b.batch_no, current_date, (pc ->> 'unit_cost')::numeric, 'Returned from line');
      end loop;
    end if;
    update prod.packaging_recon set scrapped = v_scr, returned = v_ret, at_line = coalesce(nullif(c ->> 'at_line', '')::numeric, at_line), updated_by = auth.uid(), updated_at = now()
     where id = r.id;
  end loop;
end $$;

-- Packing (once). p: {good_packs, rejected_packs, bulk_scrap_kg, bulk_left_kg, labour_hours, machine_hours, mfg_date, expiry_date,
--   packaging: [{product_id, scrapped, returned, at_line}]}. Good packs land in quarantine at the finished-goods place as lot = batch no.
create or replace function api.record_packing(p_client_request_id uuid, p_batch_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_res jsonb; b prod.batches; v_good numeric := (p ->> 'good_packs')::numeric; v_rej numeric := coalesce(nullif(p ->> 'rejected_packs', '')::numeric, 0);
  v_fill numeric; fl record; v_pieces jsonb; v_cost numeric; v_lot uuid; v_recon jsonb; v_consume numeric;
begin
  v_prev := app.request_seen(p_client_request_id, 'record_packing'); if v_prev is not null then return v_prev; end if;
  b := app.lock_batch(p_batch_id, 'production.create', array['packing']);
  if coalesce(v_good, 0) <= 0 or v_good <> trunc(v_good) or v_rej < 0 or v_rej <> trunc(v_rej) then
    perform app.raise_rule('prod.no_good_packs', 'enter the good packs (and rejected packs) as whole numbers', '22023');
  end if;
  if b.bulk_qty is null then perform app.raise_rule('prod.no_bulk_qty', 'the bulk weight was not recorded with the bulk sample', '22023'); end if;
  v_fill := app.fill_g(b.formula_version_id, b.product_id);
  if v_fill is null then perform app.raise_rule('prod.no_fill_weight', 'set the fill weight on the formula or the net quantity (g/kg) on the item', '22023'); end if;
  perform app.check_stock_date(b.company_id, current_date);
  update prod.batches set good_packs = v_good, rejected_packs = v_rej, fill_qty_g = v_fill,
    bulk_scrap_kg = round(coalesce(nullif(p ->> 'bulk_scrap_kg', '')::numeric, 0), 3), bulk_left_kg = round(coalesce(nullif(p ->> 'bulk_left_kg', '')::numeric, 0), 3),
    labour_hours = labour_hours + coalesce(nullif(p ->> 'labour_hours', '')::numeric, 0), machine_hours = machine_hours + coalesce(nullif(p ->> 'machine_hours', '')::numeric, 0),
    mfg_date = coalesce(nullif(p ->> 'mfg_date', '')::date, current_date), expiry_date = nullif(p ->> 'expiry_date', '')::date, packed_by = auth.uid(), packed_at = now()
  where id = b.id
  returning * into b;
  -- Packaging used in packs (per the formula), consumed from the line.
  for fl in select product_id, sum(qty) as per_unit from prod.formula_lines where version_id = b.formula_version_id and line_kind = 'packaging' group by product_id loop
    insert into prod.packaging_recon (company_id, batch_id, product_id, updated_by) values (b.company_id, b.id, fl.product_id, auth.uid()) on conflict (batch_id, product_id) do nothing;
    update prod.packaging_recon set in_good = fl.per_unit * v_good, in_rejected = fl.per_unit * v_rej where batch_id = b.id and product_id = fl.product_id;
    v_consume := fl.per_unit * (v_good + v_rej);
    if v_consume > 0 then
      v_pieces := app.stock_take(b.company_id, fl.product_id, null, b.line_place_id, 'available', v_consume, 'consumption', 'prod.batches', b.id, b.batch_no, current_date, 'Used in packs');
      perform app.record_consumption(b.company_id, 'prod.batches', b.id, b.id, 'packaging', fl.product_id, b.line_place_id, v_pieces, current_date);
    end if;
  end loop;
  perform app.apply_packaging_counts(b, p -> 'packaging', true);
  -- Finished goods into quarantine at material + packaging cost (labour and overhead are in the batch cost sheet).
  select round(coalesce(sum(value), 0) / v_good, 4) into v_cost from prod.material_consumption where batch_id = b.id;
  insert into inv.lots (company_id, product_id, lot_no, mfg_date, expiry_date, source, status, needs_test, received_by)
  values (b.company_id, b.product_id, b.batch_no, b.mfg_date, b.expiry_date, 'production', 'quarantine', true, auth.uid())
  returning id into v_lot;
  perform app.stock_post(b.company_id, b.product_id, v_lot, b.fg_place_id, 'quarantine', v_good, 'production_in', 'prod.batches', b.id, b.batch_no, current_date, v_cost,
                         'Packed; waits for QC release');
  update prod.batches set fg_lot_id = v_lot where id = b.id;
  perform app.batch_event(b, 'packed_hold');
  v_recon := app.batch_recon(b.id);
  v_res := jsonb_build_object('batch_id', b.id, 'status', 'packed_hold', 'fg_lot_id', v_lot, 'unit_cost', v_cost, 'recon', v_recon);
  return app.request_done(p_client_request_id, 'record_packing', v_res);
end $$;

-- Recount and reconcile. p_counts (optional): [{product_id, scrapped, returned, at_line}]. Returns the reconciliation; a difference opens a Bug fixer item.
create or replace function api.reconcile_packaging(p_client_request_id uuid, p_batch_id uuid, p_counts jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; b prod.batches;
begin
  v_prev := app.request_seen(p_client_request_id, 'reconcile_packaging'); if v_prev is not null then return v_prev; end if;
  b := app.lock_batch(p_batch_id, 'production.create', array['packed_hold', 'released', 'rejected'], false);
  if b.packed_at is null then perform app.raise_rule('batch.state', 'the batch was not packed', '22023'); end if;
  if p_counts is not null then
    perform app.check_stock_date(b.company_id, current_date);
    perform app.apply_packaging_counts(b, p_counts, false);
  end if;
  v_res := app.batch_recon(b.id);
  return app.request_done(p_client_request_id, 'reconcile_packaging', v_res);
end $$;

-- QC release of the finished lot. Never by anyone who made the batch; needs a passed bulk test and a passed finished test.
create or replace function api.qc_release_batch(p_client_request_id uuid, p_batch_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; b prod.batches; l inv.lots; v_last text; v_qty numeric;
begin
  v_prev := app.request_seen(p_client_request_id, 'qc_release_batch'); if v_prev is not null then return v_prev; end if;
  b := app.lock_batch(p_batch_id, 'qc.release', array['packed_hold'], false);
  if auth.uid() = any (app.batch_makers(b.id)) then perform app.raise_rule('sod.self_release', 'you helped make this batch, so another QC person must release it', '42501'); end if;
  if not exists (select 1 from prod.lab_tests where batch_id = b.id and kind = 'bulk' and result = 'pass') then
    perform app.raise_rule('qc.no_test', 'the batch has no passed bulk test record', 'P0001');
  end if;
  select result into v_last from prod.lab_tests where batch_id = b.id and kind = 'finished' order by created_at desc, id desc limit 1;
  if v_last is distinct from 'pass' then perform app.raise_rule('qc.no_pass', 'the latest finished-goods test must be a pass before release', 'P0001'); end if;
  perform app.check_stock_date(b.company_id, current_date);
  select * into l from inv.lots where id = b.fg_lot_id for update;
  v_qty := app.move_lot_out_of_quarantine(l, 'available', 'release', coalesce(p_note, 'QC released batch ' || b.batch_no));
  update inv.lots set status = 'available', released_by = auth.uid(), released_at = now() where id = l.id;
  update prod.batches set released_by = auth.uid(), released_at = now(), basis_locked = true where id = b.id;
  perform app.batch_event(b, 'released', p_note);
  v_res := jsonb_build_object('batch_id', b.id, 'status', 'released', 'released_qty', v_qty);
  return app.request_done(p_client_request_id, 'qc_release_batch', v_res);
end $$;

create or replace function api.qc_reject_batch(p_client_request_id uuid, p_batch_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; b prod.batches; l inv.lots; v_qty numeric := 0;
begin
  v_prev := app.request_seen(p_client_request_id, 'qc_reject_batch'); if v_prev is not null then return v_prev; end if;
  b := app.lock_batch(p_batch_id, 'qc.release', array['packed_hold', 'bulk_failed'], false);
  if auth.uid() = any (app.batch_makers(b.id)) then perform app.raise_rule('sod.self_release', 'you helped make this batch, so another QC person must decide on it', '42501'); end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'reason required', '22023'); end if;
  if not exists (select 1 from prod.lab_tests where batch_id = b.id and result = 'fail' and kind = case b.status when 'bulk_failed' then 'bulk' else 'finished' end) then
    perform app.raise_rule('qc.no_fail', 'record the failed test first', 'P0001');
  end if;
  if b.status = 'packed_hold' then
    perform app.check_stock_date(b.company_id, current_date);
    select * into l from inv.lots where id = b.fg_lot_id for update;
    v_qty := app.move_lot_out_of_quarantine(l, 'rejected', 'reject', 'Rejected: ' || trim(p_reason));
    update inv.lots set status = 'rejected', released_by = auth.uid(), released_at = now() where id = l.id;
  end if;
  update prod.batches set reject_reason = trim(p_reason), released_by = auth.uid(), released_at = now(), basis_locked = true where id = b.id;
  perform app.batch_event(b, 'rejected', trim(p_reason));
  v_res := jsonb_build_object('batch_id', b.id, 'status', 'rejected', 'rejected_qty', v_qty);
  return app.request_done(p_client_request_id, 'qc_reject_batch', v_res);
end $$;

-- Close: the reconciliation must balance (packed batches), leftover reservations are freed, the batch cost is fixed.
create or replace function api.close_batch(p_client_request_id uuid, p_batch_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; b prod.batches; v_recon jsonb; v_cost jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'close_batch'); if v_prev is not null then return v_prev; end if;
  b := app.lock_batch(p_batch_id, 'production.approve', array['released', 'rejected'], false);
  if b.packed_at is not null then
    -- Recompute without writing (a raise would roll the Bug fixer item back; reconcile_packaging / record_packing open it).
    if exists (select 1 from prod.packaging_recon r where r.batch_id = b.id and r.difference <> 0)
       or abs(coalesce(b.bulk_qty, 0) - round((coalesce(b.good_packs, 0) + coalesce(b.rejected_packs, 0)) * coalesce(b.fill_qty_g, 0) / 1000, 3) - b.bulk_scrap_kg - b.bulk_left_kg)
          > round(coalesce(b.bulk_qty, 0) * coalesce(nullif(app.setting(b.company_id, 'production.bulk_loss_pct', b.batch_date)::text, 'null')::numeric, 0) / 100, 3)
       or exists (select 1 from prod.batch_packaging_issues i where i.batch_id = b.id
                  group by i.product_id having sum(i.qty) <> coalesce((select r.issued from prod.packaging_recon r where r.batch_id = b.id and r.product_id = i.product_id), 0)) then
      perform app.raise_rule('prod.recon_mismatch', 'packaging or bulk does not reconcile; recount on the batch (a Bug fixer item is open) before closing', 'P0001');
    end if;
  end if;
  update inv.reservations set status = 'released', closed_at = now() where status = 'active' and source_table = 'prod.batches' and source_id = b.id;
  v_cost := app.batch_cost(b.id);
  insert into prod.batch_costs (company_id, batch_id, materials, packaging, labour, machine, overhead, total, good_packs, cost_per_pack, rates_missing, computed_by)
  values (b.company_id, b.id, (v_cost ->> 'materials')::numeric, (v_cost ->> 'packaging')::numeric, (v_cost ->> 'labour')::numeric, (v_cost ->> 'machine')::numeric,
          (v_cost ->> 'overhead')::numeric, (v_cost ->> 'total')::numeric, b.good_packs, nullif(v_cost ->> 'cost_per_pack', '')::numeric,
          array(select jsonb_array_elements_text(v_cost -> 'rates_missing')), auth.uid())
  on conflict (batch_id) do update set materials = excluded.materials, packaging = excluded.packaging, labour = excluded.labour, machine = excluded.machine,
    overhead = excluded.overhead, total = excluded.total, good_packs = excluded.good_packs, cost_per_pack = excluded.cost_per_pack, rates_missing = excluded.rates_missing,
    computed_by = excluded.computed_by, computed_at = now();
  update prod.batches set closed_by = auth.uid(), closed_at = now() where id = b.id;
  perform app.batch_event(b, 'closed');
  v_res := jsonb_build_object('batch_id', b.id, 'status', 'closed', 'cost', v_cost);
  return app.request_done(p_client_request_id, 'close_batch', v_res);
end $$;

create or replace function api.cancel_batch(p_client_request_id uuid, p_batch_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; b prod.batches;
begin
  v_prev := app.request_seen(p_client_request_id, 'cancel_batch'); if v_prev is not null then return v_prev; end if;
  b := app.lock_batch(p_batch_id, 'production.edit', array['planned', 'reserved'], false);
  if coalesce(length(trim(p_reason)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'reason required', '22023'); end if;
  if exists (select 1 from prod.weighings where batch_id = b.id and status = 'verified') then
    perform app.raise_rule('batch.has_issues', 'material has already been issued to this batch; finish or reject it instead', '22023');
  end if;
  update inv.reservations set status = 'released', closed_at = now() where status = 'active' and source_table = 'prod.batches' and source_id = b.id;
  perform app.batch_event(b, 'cancelled', trim(p_reason));
  v_res := jsonb_build_object('batch_id', b.id, 'status', 'cancelled');
  return app.request_done(p_client_request_id, 'cancel_batch', v_res);
end $$;

-- Cost rates (Admin; never invented). p: {company_id, kind labour_hour|machine_hour|overhead_per_kg|overhead_per_piece, rate, effective_from, note}
create or replace function api.set_cost_rate(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_company uuid := nullif(p ->> 'company_id', '')::uuid; v_id uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_cost_rate'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'settings.manage');
  if (p ->> 'rate') is null or (p ->> 'rate')::numeric < 0 then perform app.raise_rule('cost.rate', 'enter the rate (zero or more)', '22023'); end if;
  insert into prod.cost_rates (company_id, kind, rate, effective_from, note, set_by)
  values (v_company, p ->> 'kind', round((p ->> 'rate')::numeric, 2), coalesce(nullif(p ->> 'effective_from', '')::date, current_date), nullif(p ->> 'note', ''), auth.uid())
  on conflict (company_id, kind, effective_from) do update set rate = excluded.rate, note = excluded.note, set_by = excluded.set_by, set_at = now()
  returning id into v_id;
  perform app.log_event('setting_changed', jsonb_build_object('entity', 'cost_rate', 'id', v_id, 'company_id', v_company, 'kind', p ->> 'kind'));
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'set_cost_rate', v_res);
end $$;

-- ─────────── Factory work assignment ───────────
-- p: {company_id, place_id, work_date, shift, assignments: [{user_id, duty, batch_id, asset_id, hours}]}
-- Conflict check: nobody is QC releaser of a batch they make (either way round).
create or replace function api.assign_shift_duties(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_company uuid := nullif(p ->> 'company_id', '')::uuid; a jsonb; v_user uuid; v_batch uuid; v_duty text; v_id uuid; v_ids jsonb := '[]'::jsonb;
        v_date date := (p ->> 'work_date')::date;
begin
  v_prev := app.request_seen(p_client_request_id, 'assign_shift_duties'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'production.edit');
  if v_date is null then perform app.raise_rule('work.date', 'choose the work date', '22023'); end if;
  if nullif(p ->> 'place_id', '') is not null and not exists (select 1 from core.places where id = (p ->> 'place_id')::uuid and company_id = v_company) then
    perform app.raise_rule('stock.place_other_company', 'the place belongs to another company', '22023');
  end if;
  for a in select * from jsonb_array_elements(coalesce(p -> 'assignments', '[]'::jsonb)) loop
    v_user := (a ->> 'user_id')::uuid; v_batch := nullif(a ->> 'batch_id', '')::uuid; v_duty := a ->> 'duty';
    if not exists (select 1 from core.user_roles where user_id = v_user and (company_id is null or company_id = v_company)) then
      perform app.raise_rule('work.not_staff', 'this person has no role in this company', '22023');
    end if;
    if v_batch is not null then
      perform 1 from prod.batches where id = v_batch and company_id = v_company for update;
      if not found then perform app.raise_rule('batch.missing', 'batch not found in this company', 'P0002'); end if;
      if v_duty = 'qc_releaser' and (v_user = any (app.batch_makers(v_batch))) then
        perform app.raise_rule('sod.self_release', 'this person helps make the batch, so they cannot be its QC releaser', '42501');
      end if;
      if v_duty not in ('qc_tester', 'qc_releaser', 'inspector')
         and exists (select 1 from prod.shift_assignments where batch_id = v_batch and user_id = v_user and duty = 'qc_releaser') then
        perform app.raise_rule('sod.self_release', 'this person is the batch''s QC releaser, so they cannot help make it', '42501');
      end if;
    end if;
    insert into prod.shift_assignments (company_id, place_id, work_date, shift, user_id, duty, batch_id, asset_id, hours, assigned_by)
    values (v_company, nullif(p ->> 'place_id', '')::uuid, v_date, coalesce(nullif(p ->> 'shift', ''), 'day'), v_user, v_duty, v_batch, nullif(a ->> 'asset_id', '')::uuid,
            nullif(a ->> 'hours', '')::numeric, auth.uid())
    on conflict (work_date, shift, user_id, duty, batch_id, asset_id) do update set hours = excluded.hours, place_id = excluded.place_id, assigned_by = excluded.assigned_by, assigned_at = now()
    returning id into v_id;
    v_ids := v_ids || to_jsonb(v_id);
  end loop;
  v_res := jsonb_build_object('ids', v_ids);
  return app.request_done(p_client_request_id, 'assign_shift_duties', v_res);
end $$;

create or replace function api.remove_shift_duty(p_client_request_id uuid, p_assignment_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; a prod.shift_assignments;
begin
  v_prev := app.request_seen(p_client_request_id, 'remove_shift_duty'); if v_prev is not null then return v_prev; end if;
  select * into a from prod.shift_assignments where id = p_assignment_id for update;
  if a.id is null then perform app.raise_rule('work.missing', 'duty not found', 'P0002'); end if;
  perform app.require(a.company_id, 'production.edit');
  if coalesce(length(trim(p_reason)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'reason required', '22023'); end if;
  if a.batch_id is not null and a.duty not in ('qc_tester', 'qc_releaser', 'inspector')
     and exists (select 1 from prod.batches where id = a.batch_id and status not in ('planned', 'reserved', 'cancelled')) then
    perform app.raise_rule('work.batch_started', 'the batch has started; a making duty on it stays on record', '22023');
  end if;
  delete from prod.shift_assignments where id = a.id;
  perform app.log_event('admin_action', jsonb_build_object('entity', 'shift_assignment', 'id', a.id, 'removed', true, 'reason', trim(p_reason)));
  v_res := jsonb_build_object('id', a.id, 'removed', true);
  return app.request_done(p_client_request_id, 'remove_shift_duty', v_res);
end $$;

-- ─────────── R&D ───────────
-- p: {id?, company_id, code, title, family_id, formula_version_id, assigned_to, status, started_on, notes}
create or replace function api.save_rnd_trial(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_company uuid := nullif(p ->> 'company_id', '')::uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'save_rnd_trial'); if v_prev is not null then return v_prev; end if;
  if v_id is not null then select company_id into v_company from prod.rnd_trials where id = v_id for update; end if;
  perform app.require(v_company, 'lab.rnd');
  if coalesce(length(trim(p ->> 'code')), 0) = 0 or coalesce(length(trim(p ->> 'title')), 0) = 0 then perform app.raise_rule('rnd.code', 'enter the trial code and title', '22023'); end if;
  if v_id is null then
    insert into prod.rnd_trials (company_id, code, title, family_id, formula_version_id, assigned_to, status, started_on, notes, created_by)
    values (v_company, upper(trim(p ->> 'code')), trim(p ->> 'title'), nullif(p ->> 'family_id', '')::uuid, nullif(p ->> 'formula_version_id', '')::uuid,
            nullif(p ->> 'assigned_to', '')::uuid, coalesce(nullif(p ->> 'status', ''), 'planned'), nullif(p ->> 'started_on', '')::date, nullif(p ->> 'notes', ''), auth.uid())
    returning id into v_id;
  else
    update prod.rnd_trials set title = trim(p ->> 'title'), family_id = nullif(p ->> 'family_id', '')::uuid, formula_version_id = nullif(p ->> 'formula_version_id', '')::uuid,
      assigned_to = nullif(p ->> 'assigned_to', '')::uuid, status = coalesce(nullif(p ->> 'status', ''), status), started_on = nullif(p ->> 'started_on', '')::date,
      notes = nullif(p ->> 'notes', '') where id = v_id;
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'save_rnd_trial', v_res);
end $$;

-- p: {day_no, condition, due_on, result pass|fail|watch (null = plan only), observations {}}
create or replace function api.record_stability_check(p_client_request_id uuid, p_trial_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; t prod.rnd_trials; v_id uuid; v_result text := nullif(p ->> 'result', '');
begin
  v_prev := app.request_seen(p_client_request_id, 'record_stability_check'); if v_prev is not null then return v_prev; end if;
  select * into t from prod.rnd_trials where id = p_trial_id for update;
  if t.id is null then perform app.raise_rule('rnd.missing', 'trial not found', 'P0002'); end if;
  perform app.require(t.company_id, 'lab.rnd');
  if (p ->> 'day_no') is null or (p ->> 'day_no')::int < 0 then perform app.raise_rule('rnd.day', 'enter the stability day (0 or more)', '22023'); end if;
  insert into prod.stability_checks (company_id, trial_id, day_no, condition, due_on, result, observations, recorded_by, recorded_at)
  values (t.company_id, t.id, (p ->> 'day_no')::int, nullif(p ->> 'condition', ''), nullif(p ->> 'due_on', '')::date, v_result, coalesce(p -> 'observations', '{}'::jsonb),
          case when v_result is not null then auth.uid() end, case when v_result is not null then now() end)
  on conflict (trial_id, day_no, condition) do update set due_on = coalesce(excluded.due_on, prod.stability_checks.due_on), result = coalesce(excluded.result, prod.stability_checks.result),
    observations = excluded.observations, recorded_by = coalesce(excluded.recorded_by, prod.stability_checks.recorded_by), recorded_at = coalesce(excluded.recorded_at, prod.stability_checks.recorded_at)
  returning id into v_id;
  if t.status in ('planned', 'running') then update prod.rnd_trials set status = 'stability' where id = t.id; end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'record_stability_check', v_res);
end $$;

-- p: {kind in_process|rnd (default rnd), assigned_to, note} — a sample for an R&D trial.
create or replace function api.send_trial_sample(p_client_request_id uuid, p_trial_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; t prod.rnd_trials; v_no text; v_id uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'send_trial_sample'); if v_prev is not null then return v_prev; end if;
  select * into t from prod.rnd_trials where id = p_trial_id for update;
  if t.id is null then perform app.raise_rule('rnd.missing', 'trial not found', 'P0002'); end if;
  perform app.require(t.company_id, 'lab.rnd');
  v_no := app.internal_doc_no(t.company_id, 'lab_sample', current_date);
  insert into prod.lab_samples (company_id, sample_no, kind, trial_id, assigned_to, note, taken_by)
  values (t.company_id, v_no, 'rnd', t.id, nullif(p ->> 'assigned_to', '')::uuid, nullif(p ->> 'note', ''), auth.uid())
  returning id into v_id;
  v_res := jsonb_build_object('sample_id', v_id, 'sample_no', v_no);
  return app.request_done(p_client_request_id, 'send_trial_sample', v_res);
end $$;

-- ─────────── Assets ───────────
-- p: {id?, company_id, code, name, kind, place_id, make, model, serial_no, attrs, purchase_date, put_to_use_date, cost, useful_life_years,
--     residual_pct, needs_calibration, calibration_interval_days, calibration_due, amc_vendor, amc_until, status}
create or replace function api.upsert_asset(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_company uuid := nullif(p ->> 'company_id', '')::uuid; v_place uuid := nullif(p ->> 'place_id', '')::uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_asset'); if v_prev is not null then return v_prev; end if;
  if v_id is not null then select company_id into v_company from core.assets where id = v_id for update; end if;
  perform app.require(v_company, 'assets.manage');
  if coalesce(length(trim(p ->> 'code')), 0) = 0 or coalesce(length(trim(p ->> 'name')), 0) = 0 then perform app.raise_rule('asset.code', 'enter the asset code and name', '22023'); end if;
  if v_place is not null and not exists (select 1 from core.places where id = v_place and company_id = v_company) then
    perform app.raise_rule('stock.place_other_company', 'the place belongs to another company', '22023');
  end if;
  if v_id is null then
    insert into core.assets (company_id, code, name, kind, place_id, make, model, serial_no, attrs, purchase_date, put_to_use_date, cost, useful_life_years, residual_pct,
                             needs_calibration, calibration_interval_days, calibration_due, amc_vendor, amc_until, status, created_by)
    values (v_company, upper(trim(p ->> 'code')), trim(p ->> 'name'), p ->> 'kind', v_place, nullif(p ->> 'make', ''), nullif(p ->> 'model', ''), nullif(p ->> 'serial_no', ''),
            coalesce(p -> 'attrs', '{}'::jsonb), nullif(p ->> 'purchase_date', '')::date, nullif(p ->> 'put_to_use_date', '')::date, nullif(p ->> 'cost', '')::numeric,
            nullif(p ->> 'useful_life_years', '')::numeric, nullif(p ->> 'residual_pct', '')::numeric, coalesce((p ->> 'needs_calibration')::boolean, false),
            nullif(p ->> 'calibration_interval_days', '')::int, nullif(p ->> 'calibration_due', '')::date, nullif(p ->> 'amc_vendor', ''), nullif(p ->> 'amc_until', '')::date,
            coalesce(nullif(p ->> 'status', ''), 'active'), auth.uid())
    returning id into v_id;
    insert into core.asset_events (company_id, asset_id, kind, event_date, detail, recorded_by) values (v_company, v_id, 'added', current_date, '{}'::jsonb, auth.uid());
  else
    update core.assets set code = upper(trim(p ->> 'code')), name = trim(p ->> 'name'), kind = coalesce(nullif(p ->> 'kind', ''), kind), make = nullif(p ->> 'make', ''),
      model = nullif(p ->> 'model', ''), serial_no = nullif(p ->> 'serial_no', ''), attrs = coalesce(p -> 'attrs', attrs), purchase_date = nullif(p ->> 'purchase_date', '')::date,
      put_to_use_date = nullif(p ->> 'put_to_use_date', '')::date, cost = nullif(p ->> 'cost', '')::numeric, useful_life_years = nullif(p ->> 'useful_life_years', '')::numeric,
      residual_pct = nullif(p ->> 'residual_pct', '')::numeric, needs_calibration = coalesce((p ->> 'needs_calibration')::boolean, needs_calibration),
      calibration_interval_days = nullif(p ->> 'calibration_interval_days', '')::int, amc_vendor = nullif(p ->> 'amc_vendor', ''), amc_until = nullif(p ->> 'amc_until', '')::date
    where id = v_id;   -- place, status and calibration change only through events and calibrations
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_asset', v_res);
end $$;

-- p: {kind moved|repair|service|amc|breakdown|restored|disposed|note, date, place_id (moved), detail {}, amount}
create or replace function api.record_asset_event(p_client_request_id uuid, p_asset_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; a core.assets; v_kind text := p ->> 'kind'; v_date date := coalesce(nullif(p ->> 'date', '')::date, current_date); v_id bigint; v_place uuid := nullif(p ->> 'place_id', '')::uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'record_asset_event'); if v_prev is not null then return v_prev; end if;
  select * into a from core.assets where id = p_asset_id for update;
  if a.id is null then perform app.raise_rule('asset.missing', 'asset not found', 'P0002'); end if;
  perform app.require(a.company_id, 'assets.manage');
  if v_date > current_date then perform app.raise_rule('date.future', 'the date is in the future', '22023'); end if;
  if v_kind not in ('moved', 'repair', 'service', 'amc', 'breakdown', 'restored', 'disposed', 'note') then perform app.raise_rule('asset.event_kind', 'unknown event', '22023'); end if;
  if a.status = 'disposed' then perform app.raise_rule('asset.disposed', 'this asset is disposed', '22023'); end if;
  if v_kind = 'moved' then
    if v_place is null or not exists (select 1 from core.places where id = v_place and company_id = a.company_id) then
      perform app.raise_rule('stock.place_other_company', 'choose a place of this company', '22023');
    end if;
    update core.assets set place_id = v_place where id = a.id;
  end if;
  if v_kind in ('repair', 'breakdown') then update core.assets set status = 'repair' where id = a.id; end if;
  if v_kind = 'restored' then update core.assets set status = 'active' where id = a.id; end if;
  if v_kind = 'disposed' then update core.assets set status = 'disposed' where id = a.id; end if;
  if v_kind = 'amc' and nullif(p ->> 'amc_until', '') is not null then update core.assets set amc_until = (p ->> 'amc_until')::date where id = a.id; end if;
  insert into core.asset_events (company_id, asset_id, kind, event_date, detail, amount, recorded_by)
  values (a.company_id, a.id, v_kind, v_date, coalesce(p -> 'detail', '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('place_id', v_place, 'from_place_id', a.place_id)),
          nullif(p ->> 'amount', '')::numeric, auth.uid())
  returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'record_asset_event', v_res);
end $$;

-- p: {calibrated_on, next_due (default + interval), result pass|adjusted|fail, agency, certificate_path, remarks}. A fail takes the asset out of service.
create or replace function api.record_calibration(p_client_request_id uuid, p_asset_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; a core.assets; v_on date := coalesce(nullif(p ->> 'calibrated_on', '')::date, current_date); v_next date; v_result text := p ->> 'result'; v_id bigint;
begin
  v_prev := app.request_seen(p_client_request_id, 'record_calibration'); if v_prev is not null then return v_prev; end if;
  select * into a from core.assets where id = p_asset_id for update;
  if a.id is null then perform app.raise_rule('asset.missing', 'asset not found', 'P0002'); end if;
  if not (app.can(a.company_id, 'assets.manage') or app.can(a.company_id, 'qc.test')) then perform app.require(a.company_id, 'assets.manage'); end if;
  perform app.require(a.company_id, case when app.can(a.company_id, 'assets.manage') then 'assets.manage' else 'qc.test' end);
  if v_on > current_date then perform app.raise_rule('date.future', 'the date is in the future', '22023'); end if;
  if v_result not in ('pass', 'adjusted', 'fail') then perform app.raise_rule('asset.calibration_result', 'the result is pass, adjusted or fail', '22023'); end if;
  v_next := coalesce(nullif(p ->> 'next_due', '')::date, case when a.calibration_interval_days is not null then v_on + a.calibration_interval_days end);
  if v_result <> 'fail' and v_next is null then perform app.raise_rule('asset.next_due', 'enter the next calibration date (or set the interval on the asset)', '22023'); end if;
  insert into prod.calibrations (company_id, asset_id, calibrated_on, next_due, result, agency, certificate_path, remarks, recorded_by)
  values (a.company_id, a.id, v_on, case when v_result <> 'fail' then v_next end, v_result, nullif(p ->> 'agency', ''), nullif(p ->> 'certificate_path', ''), nullif(p ->> 'remarks', ''), auth.uid())
  returning id into v_id;
  if v_result = 'fail' then
    update core.assets set status = 'out_of_service' where id = a.id;
  else
    update core.assets set calibration_due = v_next, needs_calibration = true, status = case when status = 'out_of_service' then 'active' else status end where id = a.id;
  end if;
  v_res := jsonb_build_object('id', v_id, 'next_due', case when v_result <> 'fail' then v_next end);
  return app.request_done(p_client_request_id, 'record_calibration', v_res);
end $$;

-- p: {kind invoice|warranty|amc|manual|calibration_certificate|photo|other, path, valid_to}
create or replace function api.add_asset_document(p_client_request_id uuid, p_asset_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; a core.assets; v_id uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'add_asset_document'); if v_prev is not null then return v_prev; end if;
  select * into a from core.assets where id = p_asset_id for update;
  if a.id is null then perform app.raise_rule('asset.missing', 'asset not found', 'P0002'); end if;
  perform app.require(a.company_id, 'assets.manage');
  if coalesce(length(trim(p ->> 'path')), 0) = 0 then perform app.raise_rule('asset.document_path', 'upload the document first', '22023'); end if;
  insert into core.asset_documents (company_id, asset_id, kind, path, valid_to, uploaded_by)
  values (a.company_id, a.id, p ->> 'kind', trim(p ->> 'path'), nullif(p ->> 'valid_to', '')::date, auth.uid()) returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'add_asset_document', v_res);
end $$;

-- ─────────── Free items, gift and combo packs ───────────
-- p: {id?, company_id, product_id (the pack), kind free_item_pack|gift_pack|combo_pack, name, status, items: [{product_id, qty, is_free, note}]}
create or replace function api.upsert_pack(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_company uuid := nullif(p ->> 'company_id', '')::uuid; i jsonb; v_n int := 0; v_product uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_pack'); if v_prev is not null then return v_prev; end if;
  if v_id is not null then select company_id, product_id into v_company, v_product from prod.packs where id = v_id for update; end if;
  perform app.require(v_company, 'production.edit');
  if coalesce(length(trim(p ->> 'name')), 0) = 0 then perform app.raise_rule('pack.name', 'enter the pack name', '22023'); end if;
  if v_id is null then
    insert into prod.packs (company_id, product_id, kind, name, status, created_by)
    values (v_company, (p ->> 'product_id')::uuid, p ->> 'kind', trim(p ->> 'name'), coalesce(nullif(p ->> 'status', ''), 'active'), auth.uid())
    returning id, product_id into v_id, v_product;
  else
    update prod.packs set kind = coalesce(nullif(p ->> 'kind', ''), kind), name = trim(p ->> 'name'), status = coalesce(nullif(p ->> 'status', ''), status) where id = v_id;
  end if;
  if jsonb_typeof(p -> 'items') = 'array' then
    delete from prod.pack_items where pack_id = v_id;
    for i in select * from jsonb_array_elements(p -> 'items') loop
      if (i ->> 'product_id')::uuid = v_product then perform app.raise_rule('pack.self', 'a pack cannot contain itself', '22023'); end if;
      if coalesce((i ->> 'qty')::numeric, 0) <= 0 then perform app.raise_rule('pack.qty', 'every item needs a quantity above zero', '22023'); end if;
      insert into prod.pack_items (company_id, pack_id, product_id, qty, is_free, note)
      values (v_company, v_id, (i ->> 'product_id')::uuid, round((i ->> 'qty')::numeric, 3), coalesce((i ->> 'is_free')::boolean, false), nullif(i ->> 'note', ''));
      v_n := v_n + 1;
    end loop;
  end if;
  v_res := jsonb_build_object('id', v_id, 'items', v_n);
  return app.request_done(p_client_request_id, 'upsert_pack', v_res);
end $$;

-- Admin records the GST treatment agreed with the CA (Q-23); the note carries the CA's reference. Until set, the pack cannot be billed.
create or replace function api.set_pack_gst_treatment(p_client_request_id uuid, p_pack_id uuid, p_treatment text, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; k prod.packs;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_pack_gst_treatment'); if v_prev is not null then return v_prev; end if;
  select * into k from prod.packs where id = p_pack_id for update;
  if k.id is null then perform app.raise_rule('pack.missing', 'pack not found', 'P0002'); end if;
  perform app.require(k.company_id, 'settings.manage');
  if p_treatment not in ('free_with_sale_single_price', 'gift_without_consideration', 'mixed_supply', 'composite_supply') then
    perform app.raise_rule('pack.gst_treatment', 'choose the treatment agreed with the CA', '22023');
  end if;
  if coalesce(length(trim(p_note)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'note the CA''s advice (reference and date)', '22023'); end if;
  update prod.packs set gst_treatment = p_treatment, gst_treatment_note = trim(p_note), gst_treatment_set_by = auth.uid(), gst_treatment_set_at = now() where id = k.id;
  perform app.log_event('setting_changed', jsonb_build_object('entity', 'pack_gst_treatment', 'id', k.id, 'treatment', p_treatment));
  v_res := jsonb_build_object('id', k.id, 'gst_treatment', p_treatment);
  return app.request_done(p_client_request_id, 'set_pack_gst_treatment', v_res);
end $$;

-- Build packs from released stock. p: {pack_id, qty (whole packs), from_place_id, to_place_id, date}
create or replace function api.post_pack_assembly(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; k prod.packs; v_qty numeric := (p ->> 'qty')::numeric; v_from uuid := (p ->> 'from_place_id')::uuid; v_to uuid := (p ->> 'to_place_id')::uuid;
        v_date date := coalesce(nullif(p ->> 'date', '')::date, current_date); v_no text; v_id uuid; i record; v_pieces jsonb; v_value numeric := 0; v_cost numeric;
begin
  v_prev := app.request_seen(p_client_request_id, 'post_pack_assembly'); if v_prev is not null then return v_prev; end if;
  select * into k from prod.packs where id = (p ->> 'pack_id')::uuid for update;
  if k.id is null then perform app.raise_rule('pack.missing', 'pack not found', 'P0002'); end if;
  perform app.require(k.company_id, 'production.create');
  if k.status <> 'active' then perform app.raise_rule('pack.inactive', 'this pack is not in use', '22023'); end if;
  if coalesce(v_qty, 0) <= 0 or v_qty <> trunc(v_qty) then perform app.raise_rule('prod.qty', 'enter whole packs', '22023'); end if;
  if (select count(*) from core.places where id in (v_from, v_to) and company_id = k.company_id) <> (case when v_from = v_to then 1 else 2 end) then
    perform app.raise_rule('stock.place_other_company', 'choose places of this company', '22023');
  end if;
  if not exists (select 1 from prod.pack_items where pack_id = k.id) then perform app.raise_rule('pack.no_items', 'add the pack''s items first', '22023'); end if;
  perform app.check_stock_date(k.company_id, v_date);
  v_no := app.internal_doc_no(k.company_id, 'pack_assembly', v_date);
  insert into prod.pack_assemblies (company_id, doc_no, pack_id, qty, from_place_id, to_place_id, assembly_date, assembled_by)
  values (k.company_id, v_no, k.id, v_qty, v_from, v_to, v_date, auth.uid()) returning id into v_id;
  for i in select * from prod.pack_items where pack_id = k.id order by product_id loop
    v_pieces := app.stock_take(k.company_id, i.product_id, null, v_from, 'available', i.qty * v_qty, 'consumption', 'prod.pack_assemblies', v_id, v_no, v_date, 'Into pack ' || k.name);
    v_value := v_value + app.record_consumption(k.company_id, 'prod.pack_assemblies', v_id, null, case when i.is_free then 'free_item' else 'pack_item' end, i.product_id, v_from, v_pieces, v_date);
  end loop;
  v_cost := round(v_value / v_qty, 4);
  perform app.stock_post(k.company_id, k.product_id, null, v_to, 'available', v_qty, 'production_in', 'prod.pack_assemblies', v_id, v_no, v_date, v_cost, 'Packs assembled');
  update prod.pack_assemblies set unit_cost = v_cost where id = v_id;
  v_res := jsonb_build_object('id', v_id, 'doc_no', v_no, 'unit_cost', v_cost);
  return app.request_done(p_client_request_id, 'post_pack_assembly', v_res);
end $$;

-- A pack whose GST treatment is not set cannot go on a sales document (Q-23; CBIC circular 92/11/2019, s.17(5)(h), s.8).
create or replace function app.pack_billing_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.product_id is not null and exists (
       select 1 from prod.packs k join sales.documents d on d.id = new.document_id and d.company_id = k.company_id
       where k.product_id = new.product_id and k.gst_treatment is null) then
    raise exception 'the GST treatment of this pack is not set yet; Admin sets it with the CA before it can be billed' using errcode = 'P0001', hint = 'pack.gst_treatment_unset';
  end if;
  return new;
end $$;
create trigger pack_billing_guard before insert or update of product_id on sales.document_lines for each row execute function app.pack_billing_guard();

-- ─────────── Phase 4 quarantine RPCs: production lots go through the batch / inspection RPCs (self-release block) ───────────
create or replace function api.record_incoming_test(p_client_request_id uuid, p_lot_id uuid, p_result jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; l inv.lots; v_id uuid; v_result text := p_result ->> 'result';
begin
  v_prev := app.request_seen(p_client_request_id, 'record_incoming_test'); if v_prev is not null then return v_prev; end if;
  select * into l from inv.lots where id = p_lot_id for update;
  if l.id is null then perform app.raise_rule('qc.lot_missing', 'lot not found', 'P0002'); end if;
  perform app.require(l.company_id, 'qc.test');
  if l.source = 'production' then perform app.raise_rule('qc.use_batch_release', 'production lots are tested on the batch or the quality inspection', '22023'); end if;
  if l.status <> 'quarantine' then perform app.raise_rule('qc.not_in_quarantine', 'this lot is not waiting for a test', '22023'); end if;
  if l.received_by = auth.uid() then perform app.raise_rule('sod.tester_receiver', 'the person who received the goods cannot test them', '42501'); end if;
  if v_result not in ('pass', 'fail', 'hold') then perform app.raise_rule('qc.result', 'the result is pass, fail or hold', '22023'); end if;
  insert into prod.lab_tests (company_id, lot_id, kind, result, parameters, remarks, test_date, tested_by)
  values (l.company_id, l.id, 'incoming', v_result, coalesce(p_result -> 'parameters', '{}'::jsonb), nullif(p_result ->> 'remarks', ''),
          coalesce(nullif(p_result ->> 'date', '')::date, current_date), auth.uid())
  returning id into v_id;
  v_res := jsonb_build_object('id', v_id, 'result', v_result);
  return app.request_done(p_client_request_id, 'record_incoming_test', v_res);
end $$;

create or replace function api.release_from_quarantine(p_client_request_id uuid, p_lot_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; l inv.lots; v_last text; v_qty numeric;
begin
  v_prev := app.request_seen(p_client_request_id, 'release_from_quarantine'); if v_prev is not null then return v_prev; end if;
  select * into l from inv.lots where id = p_lot_id for update;
  if l.id is null then perform app.raise_rule('qc.lot_missing', 'lot not found', 'P0002'); end if;
  perform app.require(l.company_id, 'qc.release');
  if l.source = 'production' then perform app.raise_rule('qc.use_batch_release', 'production lots are released on the batch (QC release) or the quality inspection', '22023'); end if;
  if l.status <> 'quarantine' then perform app.raise_rule('qc.not_in_quarantine', 'this lot is not in quarantine', '22023'); end if;
  if l.received_by = auth.uid() then perform app.raise_rule('sod.releaser_receiver', 'the person who received the goods cannot release them', '42501'); end if;
  select result into v_last from prod.lab_tests where lot_id = l.id order by created_at desc, id desc limit 1;
  if v_last is distinct from 'pass' then perform app.raise_rule('qc.no_pass', 'the latest incoming test must be a pass before release', 'P0001'); end if;
  perform app.check_stock_date(l.company_id, current_date);
  v_qty := app.move_lot_out_of_quarantine(l, 'available', 'release', coalesce(p_note, 'Released after incoming test'));
  update inv.lots set status = 'available', released_by = auth.uid(), released_at = now() where id = l.id;
  update purch.grn_lines set qty_accepted = qty where lot_id = l.id;
  v_res := jsonb_build_object('lot_id', l.id, 'released_qty', v_qty);
  return app.request_done(p_client_request_id, 'release_from_quarantine', v_res);
end $$;

create or replace function api.reject_from_quarantine(p_client_request_id uuid, p_lot_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; l inv.lots; v_qty numeric;
begin
  v_prev := app.request_seen(p_client_request_id, 'reject_from_quarantine'); if v_prev is not null then return v_prev; end if;
  select * into l from inv.lots where id = p_lot_id for update;
  if l.id is null then perform app.raise_rule('qc.lot_missing', 'lot not found', 'P0002'); end if;
  perform app.require(l.company_id, 'qc.release');
  if l.source = 'production' then perform app.raise_rule('qc.use_batch_release', 'production lots are rejected on the batch or the quality inspection', '22023'); end if;
  if l.status <> 'quarantine' then perform app.raise_rule('qc.not_in_quarantine', 'this lot is not in quarantine', '22023'); end if;
  if l.received_by = auth.uid() then perform app.raise_rule('sod.releaser_receiver', 'the person who received the goods cannot decide on them', '42501'); end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'reason required', '22023'); end if;
  if not exists (select 1 from prod.lab_tests where lot_id = l.id and result = 'fail') then perform app.raise_rule('qc.no_fail', 'record the failed test first', 'P0001'); end if;
  perform app.check_stock_date(l.company_id, current_date);
  v_qty := app.move_lot_out_of_quarantine(l, 'rejected', 'reject', 'Rejected: ' || trim(p_reason));
  update inv.lots set status = 'rejected', released_by = auth.uid(), released_at = now() where id = l.id;
  update purch.grn_lines set qty_rejected = qty where lot_id = l.id;
  v_res := jsonb_build_object('lot_id', l.id, 'rejected_qty', v_qty);
  return app.request_done(p_client_request_id, 'reject_from_quarantine', v_res);
end $$;

revoke all on all functions in schema api from public, anon;
grant execute on all functions in schema api to authenticated;
grant execute on function api.log_sign_in_failure(text) to anon;
revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;

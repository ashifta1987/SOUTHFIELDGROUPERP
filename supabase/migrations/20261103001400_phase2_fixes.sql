-- 20261103001400_phase2_fixes.sql
-- Product duplicate candidates ordered by similarity (closest first); a second MRP on the same date gets a clear rule
-- message instead of a unique-key error. Additive (function replacements).

create or replace function api.upsert_product(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_res jsonb; v_dupes jsonb; v_cid uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_product'); if v_prev is not null then return v_prev; end if;
  perform app.require(null, 'products.manage');
  if v_id is null then
    select jsonb_agg(jsonb_build_object('id', x.id, 'code', x.code, 'name', x.name)) into v_dupes
    from (select id, code, name from master.products
          where (extensions.similarity(name_norm, app.norm_name(p ->> 'name')) >= 0.6 or (nullif(p ->> 'barcode', '') is not null and barcode = p ->> 'barcode'))
          order by extensions.similarity(name_norm, app.norm_name(p ->> 'name')) desc
          limit 5) x;
    if v_dupes is not null and not coalesce((p ->> 'force')::boolean, false) then
      raise exception 'possible_duplicate: %', v_dupes::text using errcode = 'P0001', hint = 'masters.possible_duplicate', detail = v_dupes::text;
    end if;
    insert into master.products (code, name, group_id, family, kind, hsn_code, uom, net_qty, net_qty_uom, pack_size, barcode, licence_no, label, status)
    values (upper(p ->> 'code'), p ->> 'name', nullif(p ->> 'group_id', '')::uuid, nullif(p ->> 'family', ''), coalesce(p ->> 'kind', 'finished'),
            nullif(p ->> 'hsn_code', ''), p ->> 'uom', nullif(p ->> 'net_qty', '')::numeric, nullif(p ->> 'net_qty_uom', ''), nullif(p ->> 'pack_size', ''),
            nullif(p ->> 'barcode', ''), nullif(p ->> 'licence_no', ''), coalesce(p -> 'label', '{}'::jsonb), coalesce(p ->> 'status', 'active'))
    returning id into v_id;
  else
    perform 1 from master.products where id = v_id for update;
    update master.products set
      name = coalesce(p ->> 'name', name),
      group_id = case when p ? 'group_id' then nullif(p ->> 'group_id', '')::uuid else group_id end,
      family = case when p ? 'family' then nullif(p ->> 'family', '') else family end,
      kind = coalesce(p ->> 'kind', kind),
      hsn_code = case when p ? 'hsn_code' then nullif(p ->> 'hsn_code', '') else hsn_code end,
      uom = coalesce(p ->> 'uom', uom),
      net_qty = case when p ? 'net_qty' then nullif(p ->> 'net_qty', '')::numeric else net_qty end,
      net_qty_uom = case when p ? 'net_qty_uom' then nullif(p ->> 'net_qty_uom', '') else net_qty_uom end,
      pack_size = case when p ? 'pack_size' then nullif(p ->> 'pack_size', '') else pack_size end,
      barcode = case when p ? 'barcode' then nullif(p ->> 'barcode', '') else barcode end,
      licence_no = case when p ? 'licence_no' then nullif(p ->> 'licence_no', '') else licence_no end,
      label = coalesce(p -> 'label', label),
      status = coalesce(p ->> 'status', status)
    where id = v_id;
  end if;
  if p ? 'company_ids' then
    delete from master.product_companies where product_id = v_id and company_id not in (select (jsonb_array_elements_text(p -> 'company_ids'))::uuid);
    for v_cid in select (jsonb_array_elements_text(p -> 'company_ids'))::uuid loop
      insert into master.product_companies (product_id, company_id) values (v_id, v_cid) on conflict do nothing;
    end loop;
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_product', v_res);
end $$;


create or replace function api.set_product_mrp(p_client_request_id uuid, p_product_id uuid, p_mrp numeric, p_effective_from date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_product_mrp'); if v_prev is not null then return v_prev; end if;
  perform app.require(null, 'products.manage');
  if exists (select 1 from master.product_mrp_history where product_id = p_product_id and effective_from = p_effective_from) then
    perform app.raise_rule('mrp.same_date', 'an MRP already starts on this date; MRP history is never edited, choose the next date', '22023');
  end if;
  insert into master.product_mrp_history (product_id, mrp, effective_from, set_by) values (p_product_id, p_mrp, p_effective_from, auth.uid()) returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'set_product_mrp', v_res);
end $$;

notify pgrst, 'reload schema';

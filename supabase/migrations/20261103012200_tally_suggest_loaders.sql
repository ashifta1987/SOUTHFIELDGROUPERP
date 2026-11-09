-- 20261103012200_tally_suggest_loaders.sql
-- Tally import, Stage 1 (part 3): the suggestion engine (api.suggest_tally_maps) and the loaders for the masters the first files lacked.
--   * app.tally_base_info / app.tally_sugg_*   : one suggestion per Tally name, written as status 'suggested' (never touches a confirmed row)
--   * api.suggest_tally_maps(company)          : voucher types, godowns, units, currencies, items and heads for one company; opens the "Map this ..." Bug fixer items
--   * app.imp_voucher_type / imp_godown / imp_cost_category / imp_cost_centre / imp_currency / imp_stock_category: new staged masters
--   * app.imp_unit / imp_stock_group / imp_stock_item: units fill tally_unit_map; groups keep default unit; items are created ONLY with an HSN and a known unit
--     (no HSN or unknown unit = Bug fixer item, nothing invented); item opening allocations stay staged data (not posted in Stage 1)
--   * order of posting: units → heads → ledgers → cost centres → voucher types → stock groups → godowns → items (app.imp_rank)
--   * api.import_undo also removes cost categories / centres created by the batch

-- ═════════════════════════ Voucher type knowledge ═════════════════════════
create or replace function app.tally_base_info(p_name text) returns jsonb
language sql immutable set search_path = '' as $$
  select case lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'))
    when 'sales' then '{"base":"Sales","doc":"sales_invoice","tax":"taxable","stock":true}'
    when 'purchase' then '{"base":"Purchase","doc":"purchase_bill","tax":"taxable","stock":true}'
    when 'credit note' then '{"base":"Credit Note","doc":"credit_note","tax":"taxable","stock":true}'
    when 'debit note' then '{"base":"Debit Note","doc":"debit_note","tax":"taxable","stock":true}'
    when 'receipt' then '{"base":"Receipt","doc":"receipt","tax":"none","stock":false}'
    when 'payment' then '{"base":"Payment","doc":"payment","tax":"none","stock":false}'
    when 'journal' then '{"base":"Journal","doc":"journal","tax":"none","stock":false}'
    when 'contra' then '{"base":"Contra","doc":"contra","tax":"none","stock":false}'
    when 'stock journal' then '{"base":"Stock Journal","doc":"stock_journal","tax":"none","stock":true}'
    when 'manufacturing journal' then '{"base":"Manufacturing Journal","doc":"manufacturing_journal","tax":"none","stock":true}'
    when 'delivery note' then '{"base":"Delivery Note","doc":"delivery_note","tax":"none","stock":false}'
    when 'receipt note' then '{"base":"Receipt Note","doc":"receipt_note","tax":"none","stock":false}'
    when 'sales order' then '{"base":"Sales Order","doc":"sales_order","tax":"none","stock":false}'
    when 'purchase order' then '{"base":"Purchase Order","doc":"purchase_order","tax":"none","stock":false}'
    when 'rejections in' then '{"base":"Rejections In","doc":"rejection_note","tax":"none","stock":false}'
    when 'rejections out' then '{"base":"Rejections Out","doc":"rejection_note","tax":"none","stock":false}'
    when 'memorandum' then '{"base":"Memorandum","doc":"memo","tax":"none","stock":false}'
    when 'reversing journal' then '{"base":"Reversing Journal","doc":"memo","tax":"none","stock":false}'
    when 'physical stock' then '{"base":"Physical Stock","doc":"memo","tax":"none","stock":false}'
    when 'job work in order' then '{"base":"Job Work In Order","doc":"memo","tax":"none","stock":false}'
    when 'job work out order' then '{"base":"Job Work Out Order","doc":"memo","tax":"none","stock":false}'
    when 'material in' then '{"base":"Material In","doc":"memo","tax":"none","stock":false}'
    when 'material out' then '{"base":"Material Out","doc":"memo","tax":"none","stock":false}'
    when 'payroll' then '{"base":"Payroll","doc":"other","tax":"none","stock":false}'
    when 'attendance' then '{"base":"Attendance","doc":"other","tax":"none","stock":false}'
    else null end::jsonb
$$;

-- The base type of a voucher type: its Parent when that is a Tally base type, else guessed from the name.
create or replace function app.tally_base_guess(p_parent text, p_name text) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(
    app.tally_base_info(p_parent),
    app.tally_base_info(p_name),
    app.tally_base_info(case
      when lower(p_name) like '%credit note%' then 'credit note'
      when lower(p_name) like '%debit note%' then 'debit note'
      when lower(p_name) like '%sales order%' then 'sales order'
      when lower(p_name) like '%purchase order%' then 'purchase order'
      when lower(p_name) like '%delivery note%' then 'delivery note'
      when lower(p_name) like '%receipt note%' then 'receipt note'
      when lower(p_name) like '%stock journal%' then 'stock journal'
      when lower(p_name) like '%manufactur%' then 'manufacturing journal'
      when lower(p_name) ~ 'sale' then 'sales'
      when lower(p_name) like '%purchase%' then 'purchase'
      when lower(p_name) like '%receipt%' then 'receipt'
      when lower(p_name) like '%payment%' then 'payment'
      when lower(p_name) like '%contra%' then 'contra'
      when lower(p_name) like '%journal%' then 'journal'
      else null end))
$$;

-- A name that suggests a bill without GST (the owner's types named "... WO" and "... Non GST" are the known cases).
create or replace function app.tally_name_without_gst(p_name text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(lower(p_name) ~ '(^|[^a-z0-9])(wo|w/o|without|non[ _-]?gst|nongst|no[ _-]?gst|exempt(ed)?|nil[ _-]?rated|bill of supply)([^a-z0-9]|$)', false)
$$;

create or replace function app.tally_yes(p jsonb, k text) returns boolean
language sql immutable set search_path = '' as $$
  select case lower(coalesce(p ->> k, '')) when 'true' then true when 'yes' then true when 'false' then false when 'no' then false else null end
$$;

-- ═════════════════════════ Per-name suggestions ═════════════════════════
create or replace function app.tally_sugg_vt(p_company uuid, p_name text, p jsonb, p_batch uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_info jsonb; v_tax text; v_ca boolean := false; v_exact boolean; v_reason text; v_doc text;
begin
  v_info := app.tally_base_guess(nullif(btrim(p ->> 'parent'), ''), p_name);
  v_doc := v_info ->> 'doc';
  v_tax := coalesce(v_info ->> 'tax', 'none');
  if v_info is not null and v_tax = 'taxable' and app.tally_name_without_gst(p_name) then
    v_tax := 'without_gst'; v_ca := true;
    v_reason := 'The name suggests bills without GST: on the CA review list. Admin confirms it one by one; it is never confirmed in bulk.';
  elsif v_info is null then
    v_reason := 'Base type not recognised: choose the document type.';
  elsif app.tally_base_info(p_name) is not null and lower(btrim(p_name)) = lower(v_info ->> 'base') then
    v_reason := 'Tally base type ' || (v_info ->> 'base') || '.';
  else
    v_reason := 'User-defined type: inherits its base type ' || (v_info ->> 'base') || '.';
  end if;
  v_exact := v_info is not null and not v_ca and lower(btrim(p_name)) = lower(v_info ->> 'base');
  insert into ops.tally_voucher_type_map (company_id, tally_type, base_type, erp_doc_type, tax_class, numbering, active, prevent_duplicates, affects_stock, optional, ca_review, status, exact, reason)
  values (p_company, p_name, coalesce(nullif(btrim(p ->> 'parent'), ''), v_info ->> 'base'), v_doc, v_tax, nullif(p ->> 'numbering', ''), coalesce(app.tally_yes(p, 'active'), true),
          app.tally_yes(p, 'prevent_duplicates'), coalesce(app.tally_yes(p, 'affects_stock'), (v_info ->> 'stock')::boolean, false), coalesce(app.tally_yes(p, 'optional'), false), v_ca, 'suggested', v_exact, v_reason)
  on conflict (company_id, tally_type) do update set
    base_type = excluded.base_type, erp_doc_type = excluded.erp_doc_type, tax_class = excluded.tax_class, numbering = coalesce(excluded.numbering, ops.tally_voucher_type_map.numbering),
    active = excluded.active, prevent_duplicates = coalesce(excluded.prevent_duplicates, ops.tally_voucher_type_map.prevent_duplicates), affects_stock = excluded.affects_stock,
    optional = excluded.optional, ca_review = excluded.ca_review, exact = excluded.exact, reason = excluded.reason
  where ops.tally_voucher_type_map.status = 'suggested';
  if not exists (select 1 from ops.tally_voucher_type_map where company_id = p_company and tally_type = p_name and status = 'confirmed') then
    perform app.open_bug(jsonb_build_object('company_id', p_company, 'area', 'import', 'kind', 'map_voucher_type', 'severity', 'high', 'batch_id', p_batch,
      'who_fixes', case when v_ca then 'ca' else 'admin' end, 'tax_class', case when v_ca then 'without_gst' else 'taxable' end,
      'title', 'Map this voucher type: ' || p_name, 'evidence', jsonb_build_object('name', p_name, 'base_type', v_info ->> 'base', 'tax_class', v_tax, 'ca_review', v_ca),
      'suggested_fix', 'Confirm the document type and tax class. Its vouchers wait until then.', 'dedupe_key', 'mapvt|' || p_company || '|' || app.norm_name(p_name)));
  end if;
end $$;

create or replace function app.tally_sugg_godown(p_company uuid, p_name text, p jsonb, p_batch uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_place uuid; v_exact boolean := false; v_reason text; v_score numeric; v_norm text := app.norm_name(p_name); v_nospace boolean := coalesce(app.tally_yes(p, 'has_no_space'), false);
begin
  select pl.id into v_place from core.places pl where pl.company_id = p_company and app.norm_name(pl.name) = v_norm and pl.status = 'active' limit 1;
  if v_place is not null then
    v_exact := true; v_reason := 'Same name as an ERP place.';
  else
    select x.id, x.s into v_place, v_score from (select pl.id, extensions.similarity(app.norm_name(pl.name), v_norm) as s from core.places pl
      where pl.company_id = p_company and pl.status = 'active') x where x.s >= 0.45 order by x.s desc limit 1;
    v_reason := case when v_place is null then 'No ERP place looks like this godown: choose one.' else 'Name looks like an ERP place (similarity ' || round(v_score, 2) || '): check it.' end;
  end if;
  insert into ops.tally_godown_map (company_id, tally_godown, tally_parent, place_id, has_no_space, is_external, is_internal, status, exact, reason)
  values (p_company, p_name, nullif(btrim(p ->> 'parent'), ''), v_place, v_nospace, coalesce(app.tally_yes(p, 'is_external'), false), coalesce(app.tally_yes(p, 'is_internal'), false), 'suggested', v_exact, v_reason)
  on conflict (company_id, tally_godown) do update set tally_parent = excluded.tally_parent, place_id = excluded.place_id, has_no_space = excluded.has_no_space,
    is_external = excluded.is_external, is_internal = excluded.is_internal, exact = excluded.exact, reason = excluded.reason
  where ops.tally_godown_map.status = 'suggested';
  if not exists (select 1 from ops.tally_godown_map where company_id = p_company and tally_godown = p_name and status = 'confirmed') then
    perform app.open_bug(jsonb_build_object('company_id', p_company, 'area', 'stock', 'kind', 'map_godown', 'severity', 'high', 'batch_id', p_batch, 'who_fixes', 'store',
      'title', 'Map this godown: ' || p_name, 'evidence', jsonb_build_object('name', p_name), 'suggested_fix', 'Choose the ERP place for this godown. Its stock entries wait until then.',
      'dedupe_key', 'mapgd|' || p_company || '|' || v_norm));
  end if;
end $$;

create or replace function app.tally_sugg_unit(p_company uuid, p_name text, p jsonb, p_batch uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uom text; v_simple boolean := coalesce(app.tally_yes(p, 'simple'), true); v_exact boolean; v_reason text; v_conv numeric;
begin
  v_uom := app.imp_uom(p_name);
  if v_uom is null and not v_simple then v_uom := app.imp_uom(p ->> 'base_units'); end if;
  v_exact := v_uom is not null and v_simple;
  v_reason := case when v_uom is null then 'Unknown unit: choose the ERP unit and its GST unit code.'
                   when not v_simple then 'Compound unit: check the conversion.' else 'Known unit symbol.' end;
  v_conv := case when coalesce(p ->> 'conversion', '') ~ '^[0-9]+(\.[0-9]+)?$' and (p ->> 'conversion')::numeric > 0 then (p ->> 'conversion')::numeric else null end;
  insert into ops.tally_unit_map (company_id, tally_unit, uom_code, is_simple, base_unit, additional_unit, conversion, decimals, gst_uqc, status, exact, reason)
  values (p_company, p_name, v_uom, v_simple, nullif(p ->> 'base_units', ''), nullif(p ->> 'additional_units', ''), v_conv,
          case when coalesce(p ->> 'decimals', '') ~ '^[0-6]$' then (p ->> 'decimals')::int end, coalesce(nullif(upper(p ->> 'gst_uqc'), ''), v_uom), 'suggested', v_exact, v_reason)
  on conflict (company_id, tally_unit) do update set uom_code = excluded.uom_code, is_simple = excluded.is_simple, base_unit = excluded.base_unit,
    additional_unit = excluded.additional_unit, conversion = excluded.conversion, decimals = coalesce(excluded.decimals, ops.tally_unit_map.decimals),
    gst_uqc = excluded.gst_uqc, exact = excluded.exact, reason = excluded.reason
  where ops.tally_unit_map.status = 'suggested';
  if not exists (select 1 from ops.tally_unit_map where company_id = p_company and tally_unit = p_name and status = 'confirmed') and v_uom is null then
    perform app.open_bug(jsonb_build_object('company_id', p_company, 'area', 'masters', 'kind', 'map_unit', 'severity', 'medium', 'batch_id', p_batch,
      'title', 'Map this unit: ' || p_name, 'evidence', jsonb_build_object('name', p_name, 'tally_unit', p_name),
      'suggested_fix', 'Choose the ERP unit with its GST unit code (UQC).', 'dedupe_key', 'mapun|' || p_company || '|' || lower(p_name)));
  end if;
end $$;

create or replace function app.tally_sugg_currency(p_company uuid, p_name text, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_iso text; v_exact boolean := false; v_orig text := btrim(coalesce(p ->> 'original_symbol', ''));
begin
  if upper(v_orig) ~ '^[A-Z]{3}$' then v_iso := upper(v_orig); v_exact := true;
  elsif upper(btrim(p_name)) ~ '^[A-Z]{3}$' then v_iso := upper(btrim(p_name)); v_exact := true;
  elsif btrim(p_name) in ('₹', 'Rs', 'Rs.') or v_orig in ('₹', 'Rs', 'Rs.') then v_iso := 'INR'; v_exact := true;
  elsif btrim(p_name) = '€' then v_iso := 'EUR';
  end if;
  insert into ops.tally_currency_map (company_id, tally_symbol, iso_code, mailing_name, expanded_symbol, decimals, status, exact, reason)
  values (p_company, p_name, v_iso, nullif(p ->> 'mailing_name', ''), nullif(p ->> 'expanded_symbol', ''), case when coalesce(p ->> 'decimals', '') ~ '^[0-6]$' then (p ->> 'decimals')::int end,
          'suggested', v_exact, case when v_iso is null then 'Enter the three-letter ISO code.' else 'ISO code from the symbol.' end)
  on conflict (company_id, tally_symbol) do update set iso_code = excluded.iso_code, mailing_name = excluded.mailing_name, expanded_symbol = excluded.expanded_symbol,
    decimals = excluded.decimals, exact = excluded.exact, reason = excluded.reason where ops.tally_currency_map.status = 'suggested';
end $$;

create or replace function app.tally_sugg_item(p_company uuid, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_prod uuid; v_exact boolean := false; v_reason text; v_norm text := app.norm_name(p_name); v_score numeric;
begin
  select id into v_prod from master.products where name_norm = v_norm limit 1;
  if v_prod is null then select product_id into v_prod from master.product_aliases where alias_norm = v_norm limit 1; end if;
  if v_prod is not null then v_exact := true; v_reason := 'Same name or alias as an ERP product.';
  else
    select x.id, x.s into v_prod, v_score from (select id, extensions.similarity(name_norm, v_norm) as s from master.products) x where x.s >= 0.7 order by x.s desc limit 1;
    v_reason := case when v_prod is null then 'No ERP product matches: the item master creates it when it has an HSN code and a unit.' else 'Name looks like an ERP product (similarity ' || round(v_score, 2) || '): check it.' end;
  end if;
  insert into ops.tally_item_map (company_id, tally_item, product_id, status, exact, reason) values (p_company, p_name, v_prod, 'suggested', v_exact, v_reason)
  on conflict (company_id, tally_item) do update set product_id = excluded.product_id, exact = excluded.exact, reason = excluded.reason where ops.tally_item_map.status = 'suggested';
end $$;

create or replace function app.tally_sugg_group(p_company uuid, p_name text, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_ag uuid; v_exact boolean := false; v_reason text; v_norm text := app.norm_name(p_name); v_parent text := nullif(btrim(p ->> 'parent'), ''); v_nat text; v_dp boolean := app.tally_yes(p, 'is_deemed_positive');
begin
  if exists (select 1 from ops.tally_group_map where company_id = p_company and tally_group = p_name) then return; end if;
  select id, nature into v_ag, v_nat from acct.account_groups where company_id = p_company and app.norm_name(name) = v_norm limit 1;
  if v_ag is not null then v_exact := true; v_reason := 'Same name as an ERP account group.';
  elsif v_parent is not null then
    select g.id, g.nature into v_ag, v_nat from ops.tally_group_map m join acct.account_groups g on g.id = m.account_group_id where m.company_id = p_company and m.tally_group = v_parent;
    if v_ag is not null then v_reason := 'Inherits the group of its parent (' || v_parent || ').'; end if;
  end if;
  if v_ag is null then v_reason := 'No ERP group looks like this head: choose one.'; end if;
  if v_ag is not null and v_dp is not null and ((v_dp and v_nat not in ('asset', 'expense')) or (not v_dp and v_nat in ('asset', 'expense'))) then
    v_exact := false; v_reason := coalesce(v_reason, '') || ' Debit/credit nature differs from Tally: check it.';
  end if;
  insert into ops.tally_group_suggest (company_id, tally_group, tally_parent, is_revenue, is_deemed_positive, account_group_id, status, exact, reason)
  values (p_company, p_name, v_parent, app.tally_yes(p, 'is_revenue'), v_dp, v_ag, 'suggested', v_exact, v_reason)
  on conflict (company_id, tally_group) do update set tally_parent = excluded.tally_parent, is_revenue = excluded.is_revenue, is_deemed_positive = excluded.is_deemed_positive,
    account_group_id = excluded.account_group_id, exact = excluded.exact, reason = excluded.reason where ops.tally_group_suggest.status = 'suggested';
end $$;

-- ═════════════════════════ The suggestion engine ═════════════════════════
create or replace function api.suggest_tally_maps(p_client_request_id uuid, p_company_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_res jsonb; x record; v_batch uuid;
  n_vt int := 0; n_gd int := 0; n_un int := 0; n_cu int := 0; n_it int := 0; n_gr int := 0;
begin
  v_prev := app.request_seen(p_client_request_id, 'suggest_tally_maps'); if v_prev is not null then return v_prev; end if;
  perform app.tally_map_admin(p_company_id);

  -- latest staged master row per name, then the names that vouchers actually use
  for x in
    select n.name, (select r.payload from ops.import_rows r join ops.import_batches b on b.id = r.batch_id
                    where b.company_id = p_company_id and r.object_type = 'voucher_type' and r.name = n.name order by r.id desc limit 1) as payload,
           (select r.batch_id from ops.import_rows r join ops.import_batches b on b.id = r.batch_id
             where b.company_id = p_company_id and r.object_type = 'voucher_type' and r.name = n.name order by r.id desc limit 1) as batch_id
    from (select r.name from ops.import_rows r join ops.import_batches b on b.id = r.batch_id where b.company_id = p_company_id and r.object_type = 'voucher_type' and r.name is not null
          union select voucher_type from ops.tally_vouchers where company_id = p_company_id and state <> 'reversed') n loop
    perform app.tally_sugg_vt(p_company_id, x.name, coalesce(x.payload, '{}'::jsonb), x.batch_id); n_vt := n_vt + 1;
  end loop;

  for x in
    select n.name, (select r.payload from ops.import_rows r join ops.import_batches b on b.id = r.batch_id
                    where b.company_id = p_company_id and r.object_type = 'godown' and r.name = n.name order by r.id desc limit 1) as payload
    from (select r.name from ops.import_rows r join ops.import_batches b on b.id = r.batch_id where b.company_id = p_company_id and r.object_type = 'godown' and r.name is not null
          union select godown_name from ops.tally_voucher_batches where company_id = p_company_id and godown_name is not null) n loop
    perform app.tally_sugg_godown(p_company_id, x.name, coalesce(x.payload, '{}'::jsonb), null); n_gd := n_gd + 1;
  end loop;

  for x in
    select n.name, (select r.payload from ops.import_rows r join ops.import_batches b on b.id = r.batch_id
                    where b.company_id = p_company_id and r.object_type = 'unit' and r.name = n.name order by r.id desc limit 1) as payload
    from (select r.name from ops.import_rows r join ops.import_batches b on b.id = r.batch_id where b.company_id = p_company_id and r.object_type = 'unit' and r.name is not null
          union select actual_unit from ops.tally_voucher_inventory where company_id = p_company_id and actual_unit is not null
          union select r.payload ->> 'unit' from ops.import_rows r join ops.import_batches b on b.id = r.batch_id
                 where b.company_id = p_company_id and r.object_type = 'stock_item' and r.payload ->> 'unit' is not null) n loop
    perform app.tally_sugg_unit(p_company_id, x.name, coalesce(x.payload, '{}'::jsonb), null); n_un := n_un + 1;
  end loop;

  for x in select distinct on (r.name) r.name, r.payload from ops.import_rows r join ops.import_batches b on b.id = r.batch_id
            where b.company_id = p_company_id and r.object_type = 'currency' and r.name is not null order by r.name, r.id desc loop
    perform app.tally_sugg_currency(p_company_id, x.name, x.payload); n_cu := n_cu + 1;
  end loop;

  for x in select n.name from (select r.name from ops.import_rows r join ops.import_batches b on b.id = r.batch_id where b.company_id = p_company_id and r.object_type = 'stock_item' and r.name is not null
          union select stock_item_name from ops.tally_voucher_inventory where company_id = p_company_id) n loop
    perform app.tally_sugg_item(p_company_id, x.name); n_it := n_it + 1;
  end loop;

  for x in select distinct on (r.name) r.name, r.payload from ops.import_rows r join ops.import_batches b on b.id = r.batch_id
            where b.company_id = p_company_id and r.object_type = 'group' and r.name is not null order by r.name, r.id desc loop
    perform app.tally_sugg_group(p_company_id, x.name, x.payload); n_gr := n_gr + 1;
  end loop;

  v_res := jsonb_build_object('voucher_types', n_vt, 'godowns', n_gd, 'units', n_un, 'currencies', n_cu, 'items', n_it, 'heads', n_gr,
    'ca_review', (select count(*) from ops.tally_voucher_type_map where company_id = p_company_id and ca_review));
  return app.request_done(p_client_request_id, 'suggest_tally_maps', v_res);
end $$;

-- ═════════════════════════ Loaders for the new masters ═════════════════════════
create or replace function app.imp_rank(p text) returns integer
language sql immutable set search_path = '' as $$
  select case p when 'currency' then 1 when 'unit' then 2 when 'group' then 3 when 'ledger' then 5 when 'cost_category' then 6 when 'cost_centre' then 7
                when 'voucher_type' then 8 when 'stock_category' then 9 when 'stock_group' then 10 when 'godown' then 11 when 'stock_item' then 12
                when 'employee' then 13 when 'voucher' then 14 else 15 end
$$;

create or replace function app.imp_voucher_type(b ops.import_batches, r ops.import_rows) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform app.tally_sugg_vt(b.company_id, r.name, r.payload, b.id);
  update ops.import_rows set erp_table = 'ops.tally_voucher_type_map' where id = r.id;
  return 'staged';
end $$;

create or replace function app.imp_godown(b ops.import_batches, r ops.import_rows) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform app.tally_sugg_godown(b.company_id, r.name, r.payload, b.id);
  update ops.import_rows set erp_table = 'ops.tally_godown_map' where id = r.id;
  return 'staged';
end $$;

create or replace function app.imp_currency(b ops.import_batches, r ops.import_rows) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform app.tally_sugg_currency(b.company_id, r.name, r.payload);
  update ops.import_rows set erp_table = 'ops.tally_currency_map' where id = r.id;
  return 'staged';
end $$;

create or replace function app.imp_unit(b ops.import_batches, r ops.import_rows) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform app.tally_sugg_unit(b.company_id, r.name, r.payload, b.id);
  update ops.import_rows set erp_table = 'ops.tally_unit_map' where id = r.id;
  if app.imp_uom(r.name) is not null then return 'linked'; end if;
  update ops.import_rows set bug_id = (select id from ops.bug_items where dedupe_key = 'mapun|' || b.company_id || '|' || lower(r.name)) where id = r.id;
  return 'bug';
end $$;

create or replace function app.imp_cost_category(b ops.import_batches, r ops.import_rows) returns text
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_norm text := app.norm_name(r.name);
begin
  select id into v_id from acct.cost_categories where company_id = b.company_id and name_norm = v_norm;
  if v_id is not null then
    update ops.import_rows set erp_table = 'acct.cost_categories', erp_id = v_id where id = r.id;
    return 'linked';
  end if;
  insert into acct.cost_categories (company_id, name, name_norm, revenue, non_revenue, guid, created_batch_id)
  values (b.company_id, r.name, v_norm, coalesce(app.tally_yes(r.payload, 'revenue'), true), coalesce(app.tally_yes(r.payload, 'non_revenue'), false), r.guid, b.id) returning id into v_id;
  update ops.import_rows set erp_table = 'acct.cost_categories', erp_id = v_id where id = r.id;
  perform app.imp_remember(b, r, 'acct.cost_categories', v_id);
  return 'created';
end $$;

create or replace function app.imp_cost_centre(b ops.import_batches, r ops.import_rows) returns text
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_norm text := app.norm_name(r.name); v_cat uuid; v_parent uuid; v_catname text := nullif(btrim(r.payload ->> 'category'), ''); v_parname text := nullif(btrim(r.payload ->> 'parent'), '');
begin
  if v_catname is not null then
    select id into v_cat from acct.cost_categories where company_id = b.company_id and name_norm = app.norm_name(v_catname);
    if v_cat is null then
      insert into acct.cost_categories (company_id, name, name_norm, created_batch_id) values (b.company_id, v_catname, app.norm_name(v_catname), b.id) returning id into v_cat;
    end if;
  end if;
  if v_parname is not null and app.norm_name(v_parname) not in ('primary', '') then
    select id into v_parent from acct.cost_centres where company_id = b.company_id and name_norm = app.norm_name(v_parname) and category_id is not distinct from v_cat limit 1;
    if v_parent is null then select id into v_parent from acct.cost_centres where company_id = b.company_id and name_norm = app.norm_name(v_parname) limit 1; end if;
  end if;
  select id into v_id from acct.cost_centres where company_id = b.company_id and name_norm = v_norm and category_id is not distinct from v_cat;
  if v_id is not null then
    update ops.import_rows set erp_table = 'acct.cost_centres', erp_id = v_id where id = r.id;
    return 'linked';
  end if;
  insert into acct.cost_centres (company_id, category_id, parent_id, name, name_norm, guid, created_batch_id) values (b.company_id, v_cat, v_parent, r.name, v_norm, r.guid, b.id) returning id into v_id;
  update ops.import_rows set erp_table = 'acct.cost_centres', erp_id = v_id where id = r.id;
  perform app.imp_remember(b, r, 'acct.cost_centres', v_id);
  return case when v_parname is not null and v_parent is null and app.norm_name(v_parname) <> 'primary' then 'created' else 'created' end;
end $$;

create or replace function app.imp_stock_category(b ops.import_batches, r ops.import_rows) returns text
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_norm text := app.norm_name(r.name); v_parent uuid; v_parname text := nullif(btrim(r.payload ->> 'parent'), '');
begin
  if v_parname is not null and app.norm_name(v_parname) <> 'primary' then
    select id into v_parent from master.item_categories where company_id is not distinct from b.company_id and name_norm = app.norm_name(v_parname) limit 1;
  end if;
  select id into v_id from master.item_categories where company_id is not distinct from b.company_id and name_norm = v_norm and parent_id is not distinct from v_parent;
  if v_id is not null then
    update ops.import_rows set erp_table = 'master.item_categories', erp_id = v_id where id = r.id;
    return 'linked';
  end if;
  insert into master.item_categories (company_id, parent_id, name, name_norm, tally_name) values (b.company_id, v_parent, r.name, v_norm, r.name) returning id into v_id;
  update ops.import_rows set erp_table = 'master.item_categories', erp_id = v_id where id = r.id;
  perform app.imp_remember(b, r, 'master.item_categories', v_id);
  return 'created';
end $$;

create or replace function app.imp_stock_group(b ops.import_batches, r ops.import_rows) returns text
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_seen text; v_parent uuid; v_parname text := nullif(btrim(r.payload ->> 'parent'), ''); v_uom text := app.imp_uom(r.payload ->> 'base_units');
begin
  v_seen := app.imp_seen(b, r, null);
  if v_seen is not null then return v_seen; end if;
  if v_parname is not null and app.norm_name(v_parname) <> 'primary' then
    select id into v_parent from master.product_groups where company_id is null and app.norm_name(name) = app.norm_name(v_parname) limit 1;
  end if;
  select id into v_id from master.product_groups where company_id is null and parent_id is not distinct from v_parent and app.norm_name(name) = app.norm_name(r.name);
  if v_id is null and v_parent is not null then
    select id into v_id from master.product_groups where company_id is null and parent_id is null and app.norm_name(name) = app.norm_name(r.name);
  end if;
  if v_id is not null then
    update master.product_groups set default_uom = coalesce(default_uom, v_uom), qty_addable = coalesce(qty_addable, app.tally_yes(r.payload, 'addable')) where id = v_id;
    update ops.import_rows set erp_table = 'master.product_groups', erp_id = v_id where id = r.id;
    perform app.imp_remember(b, r, 'master.product_groups', v_id);
    return 'linked';
  end if;
  insert into master.product_groups (company_id, parent_id, name, tally_name, default_uom, qty_addable) values (null, v_parent, r.name, r.name, v_uom, app.tally_yes(r.payload, 'addable')) returning id into v_id;
  update ops.import_rows set erp_table = 'master.product_groups', erp_id = v_id where id = r.id;
  perform app.imp_remember(b, r, 'master.product_groups', v_id);
  return 'created';
end $$;

-- Items: created only when the HSN and the unit come from Tally (never invented); batch / expiry / GST flags and the category are kept.
do $$
declare
  v_def text; v_new text;
  v_a constant text := $q$select (s.erp_id) into v_group from ops.source_keys s$q$;
  v_b constant text := $q$if nullif(p ->> 'mrp', '') is not null and (p ->> 'mrp')::numeric > 0 then$q$;
  v_gate constant text := $q$if v_hsn is null or v_uom = 'OTH' then
      update ops.import_rows set bug_id = app.open_bug(jsonb_build_object('company_id', b.company_id, 'area', case when v_hsn is null then 'tax' else 'masters' end,
        'kind', case when v_hsn is null then 'missing_hsn' else 'map_unit' end, 'severity', 'medium', 'batch_id', b.id,
        'title', case when v_hsn is null then 'Item without HSN, not created: ' || r.name else 'Item with an unknown unit, not created: ' || r.name end,
        'evidence', jsonb_build_object('name', r.name, 'item', r.name, 'tally_unit', p ->> 'unit', 'hsn', p ->> 'hsn'),
        'suggested_fix', case when v_hsn is null then 'Enter the HSN code in Tally (or add the product by hand); the item is created when it has an HSN code and a known unit.' else 'Map the Tally unit; the item is created afterwards.' end,
        'dedupe_key', 'itemgate|' || b.company_id || '|' || app.norm_name(r.name))), message = 'waiting_hsn' where id = r.id;
      return 'bug';
    end if;
    $q$;
  v_set constant text := $q$update master.products set batch_tracked = coalesce(app.tally_yes(p, 'batch_wise'), false), expiry_tracked = coalesce(app.tally_yes(p, 'perishable'), false),
      gst_applicable = case lower(coalesce(p ->> 'gst_applicable', '')) when 'applicable' then 'applicable' when 'not applicable' then 'not_applicable' when 'yes' then 'applicable' when 'no' then 'not_applicable' when '' then null else 'undefined' end,
      alt_uom = app.imp_uom(p ->> 'alt_unit'), alt_uom_conversion = case when coalesce(p ->> 'alt_conversion', '') ~ '^[0-9]+(\.[0-9]+)?$' and (p ->> 'alt_conversion')::numeric > 0 then (p ->> 'alt_conversion')::numeric end,
      category_id = (select id from master.item_categories where company_id is not distinct from b.company_id and name_norm = app.norm_name(p ->> 'category') limit 1)
      where id = v_id;
    $q$;
begin
  v_def := pg_get_functiondef('app.imp_stock_item(ops.import_batches, ops.import_rows)'::regprocedure);
  if length(v_def) - length(replace(v_def, v_a, '')) <> length(v_a) or length(v_def) - length(replace(v_def, v_b, '')) <> length(v_b) then
    raise exception 'imp_stock_item patch: anchors not found exactly once';
  end if;
  v_new := replace(v_def, v_a, v_gate || v_a);
  v_new := replace(v_new, v_b, v_set || v_b);
  execute v_new;
end $$;

-- Dispatch (adds the new object types) and undo of cost centres.
do $$
declare
  v_def text; v_new text;
  v_a constant text := $q$when 'voucher' then app.imp_voucher(b, r)$q$;
  v_u constant text := $q$delete from acct.open_bills where created_batch_id = b.id;$q$;
begin
  v_def := pg_get_functiondef('api.import_process_step(uuid, uuid, integer)'::regprocedure);
  if length(v_def) - length(replace(v_def, v_a, '')) <> length(v_a) then raise exception 'import_process_step patch: anchor not found exactly once'; end if;
  v_new := replace(v_def, v_a, v_a || $q$
        when 'voucher_type' then app.imp_voucher_type(b, r)
        when 'godown' then app.imp_godown(b, r)
        when 'currency' then app.imp_currency(b, r)
        when 'cost_category' then app.imp_cost_category(b, r)
        when 'cost_centre' then app.imp_cost_centre(b, r)
        when 'stock_category' then app.imp_stock_category(b, r)$q$);
  execute v_new;
  v_def := pg_get_functiondef('api.import_undo(uuid, uuid, text)'::regprocedure);
  if length(v_def) - length(replace(v_def, v_u, '')) <> length(v_u) then raise exception 'import_undo patch: anchor not found exactly once'; end if;
  v_new := replace(v_def, v_u, $q$delete from acct.cost_centres where created_batch_id = b.id;
  delete from acct.cost_categories c where c.created_batch_id = b.id and not exists (select 1 from acct.cost_centres x where x.category_id = c.id);
  $q$ || v_u);
  execute v_new;
end $$;

revoke all on function app.tally_base_info(text), app.tally_base_guess(text, text), app.tally_name_without_gst(text), app.tally_yes(jsonb, text),
  app.tally_sugg_vt(uuid, text, jsonb, uuid), app.tally_sugg_godown(uuid, text, jsonb, uuid), app.tally_sugg_unit(uuid, text, jsonb, uuid),
  app.tally_sugg_currency(uuid, text, jsonb), app.tally_sugg_item(uuid, text), app.tally_sugg_group(uuid, text, jsonb), api.suggest_tally_maps(uuid, uuid),
  app.imp_voucher_type(ops.import_batches, ops.import_rows), app.imp_godown(ops.import_batches, ops.import_rows), app.imp_currency(ops.import_batches, ops.import_rows),
  app.imp_cost_category(ops.import_batches, ops.import_rows), app.imp_cost_centre(ops.import_batches, ops.import_rows), app.imp_stock_category(ops.import_batches, ops.import_rows)
  from public, anon;
grant execute on function app.tally_base_info(text), app.tally_base_guess(text, text), app.tally_name_without_gst(text), app.tally_yes(jsonb, text),
  app.tally_sugg_vt(uuid, text, jsonb, uuid), app.tally_sugg_godown(uuid, text, jsonb, uuid), app.tally_sugg_unit(uuid, text, jsonb, uuid),
  app.tally_sugg_currency(uuid, text, jsonb), app.tally_sugg_item(uuid, text), app.tally_sugg_group(uuid, text, jsonb), api.suggest_tally_maps(uuid, uuid),
  app.imp_voucher_type(ops.import_batches, ops.import_rows), app.imp_godown(ops.import_batches, ops.import_rows), app.imp_currency(ops.import_batches, ops.import_rows),
  app.imp_cost_category(ops.import_batches, ops.import_rows), app.imp_cost_centre(ops.import_batches, ops.import_rows), app.imp_stock_category(ops.import_batches, ops.import_rows)
  to authenticated;

-- 20261103001300_import_engine.sql
-- Phase 2 Tally import engine (§25A). The browser only converts Tally XML / Excel into rows; every decision is
-- made here: match by Tally GUID, then strong keys, then normalised names; link, alias, create "to review", or
-- open a Bug fixer item. Nothing is silently fixed, skipped without a trace, or created when unsure.

create or replace function app.imp_rank(p text) returns int language sql immutable as $$
  select case p when 'group' then 1 when 'unit' then 2 when 'stock_group' then 3 when 'godown' then 4 when 'cost_centre' then 5
                when 'ledger' then 6 when 'stock_item' then 7 when 'employee' then 8 when 'voucher' then 9 else 10 end
$$;

create or replace function app.imp_phone(p text) returns text language sql immutable as $$
  select case when right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10) ~ '^[6-9][0-9]{9}$'
              then '+91' || right(regexp_replace(p, '\D', '', 'g'), 10) end
$$;

create or replace function app.imp_uom(p text) returns text language sql immutable as $$
  select case lower(regexp_replace(coalesce(p, ''), '[^a-zA-Z]', '', 'g'))
    when 'nos' then 'NOS' when 'no' then 'NOS' when 'number' then 'NOS' when 'numbers' then 'NOS'
    when 'pcs' then 'PCS' when 'pc' then 'PCS' when 'piece' then 'PCS' when 'pieces' then 'PCS'
    when 'kg' then 'KGS' when 'kgs' then 'KGS' when 'kilogram' then 'KGS' when 'kilograms' then 'KGS'
    when 'g' then 'GMS' when 'gm' then 'GMS' when 'gms' then 'GMS' when 'gram' then 'GMS' when 'grams' then 'GMS'
    when 'l' then 'LTR' when 'ltr' then 'LTR' when 'ltrs' then 'LTR' when 'litre' then 'LTR' when 'litres' then 'LTR' when 'liter' then 'LTR'
    when 'ml' then 'MLT' when 'mltr' then 'MLT' when 'box' then 'BOX' when 'boxes' then 'BOX' when 'bag' then 'BAG' when 'bags' then 'BAG'
    when 'ctn' then 'CTN' when 'carton' then 'CTN' when 'cartons' then 'CTN' when 'doz' then 'DOZ' when 'dozen' then 'DOZ'
    when 'set' then 'SET' when 'sets' then 'SET' when 'mtr' then 'MTR' when 'm' then 'MTR' when 'metre' then 'MTR' when 'roll' then 'ROL' when 'rolls' then 'ROL'
    when 'pkt' then 'PAC' when 'pack' then 'PAC' when 'packs' then 'PAC' when 'ton' then 'TON' when 'tonne' then 'TON' else null end
$$;

create or replace function app.imp_source(p_company uuid, p_type text, p_guid text) returns ops.source_keys
language sql stable security definer set search_path = '' as $$
  select * from ops.source_keys where source = 'tally' and company_id = p_company and object_type = p_type and guid = p_guid
$$;

create or replace function app.imp_remember(b ops.import_batches, r ops.import_rows, p_table text, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if r.guid is null then return; end if;
  insert into ops.source_keys (company_id, object_type, guid, master_id, alter_id, erp_table, erp_id, payload_hash, first_batch_id, last_batch_id)
  values (b.company_id, r.object_type, r.guid, r.master_id, r.alter_id, p_table, p_id, md5(r.payload::text), b.id, b.id)
  on conflict (source, company_id, object_type, guid) do update set alter_id = greatest(ops.source_keys.alter_id, excluded.alter_id), last_batch_id = excluded.last_batch_id;
end $$;

-- Common "changed in Tally" check for a GUID already loaded. Returns 'skipped', 'changed' or null (not loaded).
create or replace function app.imp_seen(b ops.import_batches, r ops.import_rows, p_before jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare sk ops.source_keys;
begin
  if r.guid is null then return null; end if;
  sk := app.imp_source(b.company_id, r.object_type, r.guid);
  if sk.id is null then return null; end if;
  update ops.import_rows set erp_table = sk.erp_table, erp_id = sk.erp_id where id = r.id;
  if r.alter_id is not null and sk.alter_id is not null and r.alter_id > sk.alter_id and md5(r.payload::text) is distinct from sk.payload_hash then
    perform app.open_bug(jsonb_build_object(
      'company_id', b.company_id, 'area', 'import', 'kind', 'changed_in_tally', 'severity', 'medium', 'batch_id', b.id,
      'title', 'Changed in Tally after loading: ' || coalesce(r.name, r.guid),
      'evidence', jsonb_build_object('object_type', r.object_type, 'guid', r.guid, 'before', p_before, 'after', r.payload, 'alter_id_before', sk.alter_id, 'alter_id_after', r.alter_id),
      'suggested_fix', 'Review the change. The loaded record is not edited automatically; accept it to apply the change (vouchers are reversed and posted again).',
      'ref_table', sk.erp_table, 'ref_id', sk.erp_id, 'dedupe_key', 'chg|' || b.company_id || '|' || r.guid || '|' || r.alter_id));
    return 'changed';
  end if;
  return 'skipped';
end $$;

-- ─────────── Groups (heads): never created automatically ───────────
create or replace function app.imp_group(b ops.import_batches, r ops.import_rows) returns text
language plpgsql security definer set search_path = '' as $$
declare v_ag uuid;
begin
  select account_group_id into v_ag from ops.tally_group_map where company_id = b.company_id and tally_group = r.name;
  if v_ag is not null then
    update ops.import_rows set erp_table = 'acct.account_groups', erp_id = v_ag where id = r.id;
    return 'linked';
  end if;
  update ops.import_rows set bug_id = app.open_bug(jsonb_build_object(
    'company_id', b.company_id, 'area', 'ledger', 'kind', 'map_head', 'severity', 'high', 'batch_id', b.id, 'who_fixes', 'ca',
    'title', 'Map this head: ' || r.name,
    'evidence', jsonb_build_object('tally_group', r.name, 'parent', r.payload ->> 'parent'),
    'suggested_fix', 'Map the Tally group to an ERP account group (Chart of accounts). Ledgers under it load after mapping.',
    'dedupe_key', 'map|' || b.company_id || '|' || app.norm_name(r.name))), message = 'waiting_map' where id = r.id;
  return 'bug';
end $$;

-- ─────────── Ledgers (accounts and parties) ───────────
create or replace function app.imp_ledger(b ops.import_batches, r ops.import_rows) returns text
language plpgsql security definer set search_path = '' as $$
declare
  p jsonb := r.payload; v_seen text; v_ag acct.account_groups; v_party uuid; v_acc acct.accounts; v_result text := 'created';
  v_gstin text := nullif(upper(trim(p ->> 'gstin')), ''); v_pan text := nullif(upper(trim(p ->> 'pan')), ''); v_phone text := app.imp_phone(p ->> 'phone');
  v_cand record; v_opening numeric := coalesce(nullif(p ->> 'opening', '')::numeric, 0); v_bill jsonb; v_bills_sum numeric := 0; v_nbills int := 0; v_new int;
  v_is_cust boolean; v_link master.party_companies;
begin
  v_seen := app.imp_seen(b, r, (select to_jsonb(a) from acct.accounts a join ops.source_keys s on s.erp_id = a.id where s.company_id = b.company_id and s.guid = r.guid and s.object_type = 'ledger'));
  if v_seen is not null then
    -- A rename under the same GUID keeps the Tally name as an alias.
    if v_seen = 'changed' then
      select a.* into v_acc from acct.accounts a join ops.source_keys s on s.erp_id = a.id where s.company_id = b.company_id and s.guid = r.guid and s.object_type = 'ledger';
      if v_acc.party_id is not null and app.norm_name(r.name) <> v_acc.name_norm then
        insert into master.party_aliases (party_id, alias, source) values (v_acc.party_id, r.name, 'tally') on conflict do nothing;
      end if;
    end if;
    return v_seen;
  end if;

  select g.* into v_ag from ops.tally_group_map m join acct.account_groups g on g.id = m.account_group_id
   where m.company_id = b.company_id and m.tally_group = p ->> 'parent';
  if v_ag.id is null then
    update ops.import_rows set bug_id = app.open_bug(jsonb_build_object(
      'company_id', b.company_id, 'area', 'ledger', 'kind', 'map_head', 'severity', 'high', 'batch_id', b.id, 'who_fixes', 'ca',
      'title', 'Map this head: ' || coalesce(p ->> 'parent', '(no group)'),
      'evidence', jsonb_build_object('tally_group', p ->> 'parent'),
      'suggested_fix', 'Map the Tally group to an ERP account group. Ledgers under it load after mapping.',
      'dedupe_key', 'map|' || b.company_id || '|' || app.norm_name(p ->> 'parent'))), message = 'waiting_map' where id = r.id;
    return 'bug';
  end if;

  if v_ag.is_party_group is not null then
    v_is_cust := v_ag.is_party_group = 'debtors';
    if v_gstin is not null and not app.gstin_valid(v_gstin) then
      perform app.open_bug(jsonb_build_object('company_id', b.company_id, 'area', 'masters', 'kind', 'invalid_gstin', 'severity', 'medium', 'batch_id', b.id,
        'title', 'GSTIN in Tally is not valid: ' || r.name, 'evidence', jsonb_build_object('ledger', r.name, 'gstin', v_gstin),
        'suggested_fix', 'Check the GSTIN on the certificate and correct it in KYC.', 'dedupe_key', 'gstin|' || b.company_id || '|' || app.norm_name(r.name)));
      v_gstin := null;
    end if;
    if v_gstin is not null and v_pan is null then v_pan := substr(v_gstin, 3, 10); end if;
    -- 1) strong keys
    if v_gstin is not null then select id into v_party from master.parties where gstin = v_gstin and status <> 'merged'; end if;
    if v_party is null and v_pan is not null then select id into v_party from master.parties where pan = v_pan and status <> 'merged' order by created_at limit 1; end if;
    if v_party is not null then
      if not exists (select 1 from master.parties where id = v_party and name_norm = app.norm_name(r.name))
         and not exists (select 1 from master.party_aliases where party_id = v_party and alias_norm = app.norm_name(r.name)) then
        insert into master.party_aliases (party_id, alias, source) values (v_party, r.name, 'tally') on conflict do nothing;
        v_result := 'aliased';
      else
        v_result := 'linked';
      end if;
    end if;
    -- 2) exact normalised name or alias
    if v_party is null then
      select id into v_party from master.parties where name_norm = app.norm_name(r.name) and status <> 'merged' limit 1;
      if v_party is null then select party_id into v_party from master.party_aliases where alias_norm = app.norm_name(r.name) limit 1; end if;
      if v_party is not null then v_result := 'linked'; end if;
    end if;
    -- 3) similar but not certain: create nothing
    if v_party is null then
      select c.* into v_cand from app.party_candidates(r.name, null, null, null) c where c.score >= 0.55 order by c.score desc limit 1;
      if v_cand.party_id is not null then
        update ops.import_rows set bug_id = app.open_bug(jsonb_build_object(
          'company_id', b.company_id, 'area', 'masters', 'kind', 'possible_duplicate', 'severity', 'medium', 'batch_id', b.id,
          'title', 'Possible duplicate: ' || r.name || ' ↔ ' || v_cand.legal_name,
          'evidence', jsonb_build_object('incoming', p || jsonb_build_object('name', r.name, 'guid', r.guid), 'existing', jsonb_build_object('id', v_cand.party_id, 'name', v_cand.legal_name, 'gstin', v_cand.gstin), 'score', v_cand.score, 'row_id', r.id),
          'suggested_fix', 'Merge into the existing party, or keep separate (creates a new party).',
          'ref_id', v_cand.party_id, 'dedupe_key', 'dup|' || b.company_id || '|' || app.norm_name(r.name))), message = 'waiting_decision' where id = r.id;
        return 'bug';
      end if;
    end if;
    -- 4) no match: create to review
    if v_party is null then
      insert into master.parties (legal_name, gst_status, gstin, pan, state_code, is_customer, is_supplier, kyc_status, created_batch_id)
      values (r.name, case when v_gstin is not null then 'registered' else 'unregistered' end, v_gstin, v_pan, coalesce(substr(v_gstin, 1, 2), nullif(p ->> 'state_code', '')),
              v_is_cust, not v_is_cust, 'draft', b.id)
      returning id into v_party;
      if v_phone is not null then
        insert into master.party_contacts (party_id, name, whatsapp, is_primary) values (v_party, r.name, v_phone, true);
      end if;
      if nullif(p ->> 'address', '') is not null then
        insert into master.party_addresses (party_id, kind, line1, state_code, pincode) values (v_party, 'billing', p ->> 'address', coalesce(substr(v_gstin, 1, 2), nullif(p ->> 'state_code', '')), nullif(p ->> 'pincode', ''));
      end if;
      v_result := 'created';
    end if;
    if v_gstin is null and lower(coalesce(p ->> 'gst_reg_type', '')) in ('regular', 'composition') then
      perform app.open_bug(jsonb_build_object('company_id', b.company_id, 'area', 'masters', 'kind', 'missing_gstin', 'severity', 'medium', 'batch_id', b.id,
        'title', 'Registered party without GSTIN: ' || r.name, 'evidence', jsonb_build_object('ledger', r.name, 'gst_reg_type', p ->> 'gst_reg_type'),
        'suggested_fix', 'Add the GSTIN in KYC.', 'ref_id', v_party, 'dedupe_key', 'nogstin|' || v_party));
    end if;
    -- Link to the company; the same name under both Sundry Debtors and Sundry Creditors is a Bug fixer item.
    select * into v_link from master.party_companies where party_id = v_party and company_id = b.company_id;
    if v_link.party_id is not null and ((v_is_cust and v_link.is_supplier and not v_link.is_customer) or (not v_is_cust and v_link.is_customer and not v_link.is_supplier)) then
      perform app.open_bug(jsonb_build_object('company_id', b.company_id, 'area', 'ledger', 'kind', 'same_name_two_groups', 'severity', 'medium', 'batch_id', b.id,
        'title', 'Same party under debtors and creditors: ' || r.name, 'evidence', jsonb_build_object('ledger', r.name, 'group', p ->> 'parent'),
        'suggested_fix', 'Confirm the party both buys and sells, or move one ledger.', 'ref_id', v_party, 'dedupe_key', 'twogroups|' || b.company_id || '|' || v_party));
    end if;
    insert into master.party_companies (party_id, company_id, is_customer, is_supplier) values (v_party, b.company_id, v_is_cust, not v_is_cust)
    on conflict (party_id, company_id) do update set is_customer = master.party_companies.is_customer or excluded.is_customer, is_supplier = master.party_companies.is_supplier or excluded.is_supplier;
    update master.parties set is_customer = is_customer or v_is_cust, is_supplier = is_supplier or not v_is_cust where id = v_party;
  end if;

  -- The account itself (unique per company by name).
  select * into v_acc from acct.accounts where company_id = b.company_id and name = r.name;
  if v_acc.id is null then
    insert into acct.accounts (company_id, group_id, name, party_id, opening_balance, opening_dc, opening_as_of, status, created_batch_id)
    values (b.company_id, v_ag.id, r.name, v_party, abs(v_opening), case when v_opening < 0 then 'D' else 'C' end, b.as_of, 'to_review', b.id)
    returning * into v_acc;
  else
    if v_acc.group_id <> v_ag.id then
      perform app.open_bug(jsonb_build_object('company_id', b.company_id, 'area', 'ledger', 'kind', 'same_name_two_groups', 'severity', 'medium', 'batch_id', b.id,
        'title', 'Ledger name under two groups: ' || r.name, 'evidence', jsonb_build_object('ledger', r.name, 'tally_group', p ->> 'parent'),
        'suggested_fix', 'Decide which group the ledger belongs to.', 'ref_id', v_acc.id, 'dedupe_key', 'acc2g|' || v_acc.id));
    end if;
    if v_result = 'created' then v_result := 'linked'; end if;
  end if;
  update ops.import_rows set erp_table = 'acct.accounts', erp_id = v_acc.id where id = r.id;
  perform app.imp_remember(b, r, 'acct.accounts', v_acc.id);

  -- Bill-wise opening outstanding.
  for v_bill in select * from jsonb_array_elements(coalesce(p -> 'bills', '[]'::jsonb)) loop
    v_nbills := v_nbills + 1;
    v_bills_sum := v_bills_sum + coalesce((v_bill ->> 'amount')::numeric, 0);
    insert into acct.open_bills (company_id, account_id, party_id, bill_ref, bill_date, due_date, amount, dc, as_of, created_batch_id)
    values (b.company_id, v_acc.id, v_party, coalesce(nullif(v_bill ->> 'ref', ''), '(no ref)'), nullif(v_bill ->> 'date', '')::date, nullif(v_bill ->> 'due', '')::date,
            abs(coalesce((v_bill ->> 'amount')::numeric, 0)), case when coalesce((v_bill ->> 'amount')::numeric, 0) < 0 then 'D' else 'C' end, coalesce(b.as_of, current_date), b.id)
    on conflict (company_id, account_id, bill_ref, as_of) do nothing;
    get diagnostics v_new = row_count;
    if v_new > 0 then
      perform app.open_bug(jsonb_build_object('company_id', b.company_id, 'area', 'tax', 'kind', 'classify_bills', 'severity', 'info', 'batch_id', b.id, 'tax_class', 'unclassified',
        'title', 'Classify the opening bills loaded from Tally', 'evidence', jsonb_build_object('batch', b.code),
        'suggested_fix', 'Mark each opening bill as with GST or without GST (with its lawful reason). Until then only Admin and the CA see them.',
        'dedupe_key', 'classify|' || b.id));
    end if;
  end loop;
  if v_nbills > 0 and abs(v_bills_sum - v_opening) > 0.01 then
    perform app.open_bug(jsonb_build_object('company_id', b.company_id, 'area', 'ledger', 'kind', 'total_mismatch', 'severity', 'medium', 'batch_id', b.id, 'who_fixes', 'ca',
      'title', 'Bills do not add up to the opening balance: ' || r.name, 'amount', abs(v_bills_sum - v_opening),
      'evidence', jsonb_build_object('ledger', r.name, 'opening', v_opening, 'bills_total', v_bills_sum), 'suggested_fix', 'Find the missing or extra bill in Tally.',
      'ref_id', v_acc.id, 'dedupe_key', 'billsum|' || v_acc.id || '|' || b.as_of));
  end if;
  return v_result;
end $$;

-- ─────────── Stock groups, units, stock items ───────────
create or replace function app.imp_stock_group(b ops.import_batches, r ops.import_rows) returns text
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_seen text;
begin
  v_seen := app.imp_seen(b, r, null);
  if v_seen is not null then return v_seen; end if;
  select id into v_id from master.product_groups where company_id is null and parent_id is null and app.norm_name(name) = app.norm_name(r.name);
  if v_id is not null then
    update ops.import_rows set erp_table = 'master.product_groups', erp_id = v_id where id = r.id;
    perform app.imp_remember(b, r, 'master.product_groups', v_id);
    return 'linked';
  end if;
  insert into master.product_groups (company_id, name, tally_name) values (null, r.name, r.name) returning id into v_id;
  update ops.import_rows set erp_table = 'master.product_groups', erp_id = v_id where id = r.id;
  perform app.imp_remember(b, r, 'master.product_groups', v_id);
  return 'created';
end $$;

create or replace function app.imp_unit(b ops.import_batches, r ops.import_rows) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if app.imp_uom(r.name) is not null then return 'linked'; end if;
  update ops.import_rows set bug_id = app.open_bug(jsonb_build_object('company_id', b.company_id, 'area', 'masters', 'kind', 'other', 'severity', 'medium', 'batch_id', b.id,
    'title', 'Map this unit: ' || r.name, 'evidence', jsonb_build_object('tally_unit', r.name),
    'suggested_fix', 'Choose the GST unit code (UQC) for this Tally unit.', 'dedupe_key', 'unit|' || lower(r.name))) where id = r.id;
  return 'bug';
end $$;

create or replace function app.imp_stock_item(b ops.import_batches, r ops.import_rows) returns text
language plpgsql security definer set search_path = '' as $$
declare
  p jsonb := r.payload; v_seen text; v_id uuid; v_result text := 'created'; v_uom text := coalesce(app.imp_uom(p ->> 'unit'), 'OTH');
  v_hsn text := nullif(regexp_replace(coalesce(p ->> 'hsn', ''), '\D', '', 'g'), ''); v_group uuid; v_cand record; v_code text;
begin
  v_seen := app.imp_seen(b, r, (select to_jsonb(x) from master.products x join ops.source_keys s on s.erp_id = x.id where s.company_id = b.company_id and s.guid = r.guid and s.object_type = 'stock_item'));
  if v_seen is not null then return v_seen; end if;
  if v_hsn is not null and length(v_hsn) not between 4 and 8 then v_hsn := null; end if;
  if v_hsn is not null and not exists (select 1 from master.hsn_codes where code = v_hsn) then
    insert into master.hsn_codes (code, description) values (v_hsn, 'From Tally: ' || r.name) on conflict do nothing;
  end if;
  -- strong key: HSN + name + unit
  select id into v_id from master.products where name_norm = app.norm_name(r.name) and uom = v_uom and hsn_code is not distinct from v_hsn limit 1;
  if v_id is null then
    select id into v_id from master.products where name_norm = app.norm_name(r.name) limit 1;
    if v_id is null then select product_id into v_id from master.product_aliases where alias_norm = app.norm_name(r.name) limit 1; end if;
  end if;
  if v_id is not null then
    v_result := 'linked';
  else
    select x.id, x.name, extensions.similarity(x.name_norm, app.norm_name(r.name)) as score into v_cand
    from master.products x where extensions.similarity(x.name_norm, app.norm_name(r.name)) >= 0.7 order by 3 desc limit 1;
    if v_cand.id is not null then
      update ops.import_rows set bug_id = app.open_bug(jsonb_build_object(
        'company_id', b.company_id, 'area', 'stock', 'kind', 'possible_duplicate', 'severity', 'medium', 'batch_id', b.id,
        'title', 'Possible duplicate item: ' || r.name || ' ↔ ' || v_cand.name,
        'evidence', jsonb_build_object('incoming', p || jsonb_build_object('name', r.name, 'guid', r.guid), 'existing', jsonb_build_object('id', v_cand.id, 'name', v_cand.name), 'score', v_cand.score, 'row_id', r.id),
        'suggested_fix', 'Merge into the existing item, or keep separate.', 'ref_table', 'master.products', 'ref_id', v_cand.id,
        'dedupe_key', 'dupi|' || app.norm_name(r.name))), message = 'waiting_decision' where id = r.id;
      return 'bug';
    end if;
    select (s.erp_id) into v_group from ops.source_keys s where s.company_id = b.company_id and s.object_type = 'stock_group'
      and s.erp_id in (select id from master.product_groups where app.norm_name(name) = app.norm_name(p ->> 'parent')) limit 1;
    if v_group is null then select id into v_group from master.product_groups where company_id is null and app.norm_name(name) = app.norm_name(p ->> 'parent') limit 1; end if;
    v_code := left(regexp_replace(upper(r.name), '[^A-Z0-9]+', '', 'g'), 12);
    if v_code = '' then v_code := 'ITEM'; end if;
    while exists (select 1 from master.products where code = v_code) loop
      v_code := left(v_code, 12) || '-' || substr(md5(random()::text), 1, 4);
    end loop;
    insert into master.products (code, name, group_id, hsn_code, uom, status, created_batch_id)
    values (upper(v_code), r.name, v_group, v_hsn, v_uom, 'to_review', b.id) returning id into v_id;
    if nullif(p ->> 'mrp', '') is not null and (p ->> 'mrp')::numeric > 0 then
      insert into master.product_mrp_history (product_id, mrp, effective_from) values (v_id, (p ->> 'mrp')::numeric, coalesce(b.as_of, current_date)) on conflict do nothing;
    end if;
  end if;
  insert into master.product_companies (product_id, company_id) values (v_id, b.company_id) on conflict do nothing;
  if v_hsn is null and not exists (select 1 from master.products where id = v_id and hsn_code is not null) then
    perform app.open_bug(jsonb_build_object('company_id', b.company_id, 'area', 'tax', 'kind', 'missing_hsn', 'severity', 'medium', 'batch_id', b.id,
      'title', 'Item without HSN: ' || r.name, 'evidence', jsonb_build_object('item', r.name), 'suggested_fix', 'Add the HSN code on the Product master.',
      'ref_table', 'master.products', 'ref_id', v_id, 'dedupe_key', 'nohsn|' || v_id));
  end if;
  if v_uom = 'OTH' then
    perform app.open_bug(jsonb_build_object('company_id', b.company_id, 'area', 'masters', 'kind', 'other', 'severity', 'info', 'batch_id', b.id,
      'title', 'Map this unit: ' || coalesce(p ->> 'unit', '(none)'), 'evidence', jsonb_build_object('tally_unit', p ->> 'unit', 'item', r.name),
      'suggested_fix', 'Choose the GST unit code (UQC).', 'dedupe_key', 'unit|' || lower(coalesce(p ->> 'unit', ''))));
  end if;
  if coalesce(nullif(p ->> 'opening_qty', '')::numeric, 0) < 0 then
    perform app.open_bug(jsonb_build_object('company_id', b.company_id, 'area', 'stock', 'kind', 'negative_stock', 'severity', 'high', 'batch_id', b.id, 'who_fixes', 'store',
      'title', 'Below zero in Tally: ' || r.name, 'evidence', jsonb_build_object('item', r.name, 'opening_qty', p ->> 'opening_qty', 'opening_value', p ->> 'opening_value'),
      'suggested_fix', 'Find the missing receipt or production entry; stock loads in Phase 4.', 'ref_table', 'master.products', 'ref_id', v_id,
      'dedupe_key', 'neg|' || b.company_id || '|' || v_id || '|' || coalesce(b.as_of::text, '')));
  end if;
  update ops.import_rows set erp_table = 'master.products', erp_id = v_id where id = r.id;
  perform app.imp_remember(b, r, 'master.products', v_id);
  return v_result;
end $$;

-- ─────────── Employees: one group-level person across both companies ───────────
create or replace function app.imp_employee(b ops.import_batches, r ops.import_rows) returns text
language plpgsql security definer set search_path = '' as $$
declare
  p jsonb := r.payload; v_seen text; v_id uuid; v_pan text := nullif(upper(trim(p ->> 'pan')), ''); v_phone text := app.imp_phone(p ->> 'phone');
  v_code text := nullif(trim(p ->> 'code'), ''); v_dob date := nullif(p ->> 'dob', '')::date; v_a4 text := nullif(right(regexp_replace(coalesce(p ->> 'aadhaar_last4', ''), '\D', '', 'g'), 4), '');
  v_same record; v_result text := 'linked';
begin
  v_seen := app.imp_seen(b, r, null);
  if v_seen is not null then return v_seen; end if;
  if v_pan is not null and v_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' then v_pan := null; end if;
  if v_pan is not null then select id into v_id from master.people where pan = v_pan; end if;
  if v_id is null and v_code is not null then select person_id into v_id from master.person_companies where company_id = b.company_id and employee_code = v_code; end if;
  if v_id is null and v_phone is not null then select id into v_id from master.people where phone = v_phone limit 1; end if;
  if v_id is null and v_dob is not null and v_a4 is not null then select id into v_id from master.people where dob = v_dob and aadhaar_last4 = v_a4 limit 1; end if;
  if v_id is null then
    select id, pan into v_same from master.people where name_norm = app.norm_name(r.name) limit 1;
    if v_same.id is not null then
      if v_same.pan is not null and v_pan is not null and v_same.pan <> v_pan then
        update ops.import_rows set bug_id = app.open_bug(jsonb_build_object('company_id', b.company_id, 'area', 'masters', 'kind', 'employee_conflict', 'severity', 'high', 'batch_id', b.id,
          'title', 'Same name, different PAN: ' || r.name, 'evidence', jsonb_build_object('incoming', p || jsonb_build_object('name', r.name), 'existing_id', v_same.id),
          'suggested_fix', 'Check both people; keep separate or correct the PAN.', 'ref_table', 'master.people', 'ref_id', v_same.id,
          'dedupe_key', 'empc|' || app.norm_name(r.name) || '|' || v_pan)), message = 'waiting_decision' where id = r.id;
        return 'bug';
      end if;
      v_id := v_same.id;
    end if;
  end if;
  if v_id is null then
    insert into master.people (name, pan, phone, dob, aadhaar_last4, status, created_batch_id) values (r.name, v_pan, v_phone, v_dob, v_a4, 'to_review', b.id) returning id into v_id;
    v_result := 'created';
  else
    update master.people set pan = coalesce(pan, v_pan), phone = coalesce(phone, v_phone), dob = coalesce(dob, v_dob), aadhaar_last4 = coalesce(aadhaar_last4, v_a4) where id = v_id;
  end if;
  insert into master.person_companies (person_id, company_id, employee_code) values (v_id, b.company_id, v_code)
  on conflict (person_id, company_id) do update set employee_code = coalesce(master.person_companies.employee_code, excluded.employee_code);
  update ops.import_rows set erp_table = 'master.people', erp_id = v_id where id = r.id;
  perform app.imp_remember(b, r, 'master.people', v_id);
  return v_result;
end $$;

-- ─────────── Vouchers: kept as loaded; same voucher skipped; changes and deletions go to the Bug fixer ───────────
create or replace function app.imp_voucher(b ops.import_batches, r ops.import_rows) returns text
language plpgsql security definer set search_path = '' as $$
declare
  p jsonb := r.payload; v_key text; v_existing ops.tally_vouchers; v_amount numeric := coalesce(nullif(p ->> 'amount', '')::numeric, 0); v_party uuid;
  v_sum numeric; v_id uuid; v_date date := nullif(p ->> 'date', '')::date;
begin
  if v_date is null then
    update ops.import_rows set message = 'no date' where id = r.id;
    return 'error';
  end if;
  v_key := coalesce(r.guid, concat_ws('|', p ->> 'type', p ->> 'number', p ->> 'date', p ->> 'amount', p ->> 'party'));
  select * into v_existing from ops.tally_vouchers where company_id = b.company_id and match_key = v_key;
  if v_existing.id is not null and v_existing.state <> 'reversed' then
    update ops.import_rows set erp_table = 'ops.tally_vouchers', erp_id = v_existing.id where id = r.id;
    if r.alter_id is not null and v_existing.alter_id is not null and r.alter_id > v_existing.alter_id
       and (v_existing.amount <> v_amount or v_existing.lines <> coalesce(p -> 'lines', '[]'::jsonb) or v_existing.voucher_date <> v_date) then
      update ops.import_rows set bug_id = app.open_bug(jsonb_build_object(
        'company_id', b.company_id, 'area', 'import', 'kind', 'changed_in_tally', 'severity', 'high', 'batch_id', b.id, 'amount', v_amount,
        'title', 'Changed in Tally after loading: ' || coalesce(p ->> 'type', '') || ' ' || coalesce(p ->> 'number', ''),
        'evidence', jsonb_build_object('before', to_jsonb(v_existing), 'after', p, 'alter_id_before', v_existing.alter_id, 'alter_id_after', r.alter_id),
        'suggested_fix', 'The loaded entry is untouched. After approval it is reversed and posted again.',
        'ref_table', 'ops.tally_vouchers', 'ref_id', v_existing.id, 'dedupe_key', 'chgv|' || v_existing.id || '|' || r.alter_id)) where id = r.id;
      return 'changed';
    end if;
    return 'skipped';
  end if;
  select id into v_party from master.parties where name_norm = app.norm_name(p ->> 'party') and status <> 'merged' limit 1;
  if v_party is null then select party_id into v_party from master.party_aliases where alias_norm = app.norm_name(p ->> 'party') limit 1; end if;
  if v_existing.id is not null then
    update ops.tally_vouchers set state = 'loaded', batch_id = b.id, alter_id = r.alter_id, lines = coalesce(p -> 'lines', '[]'::jsonb), amount = v_amount where id = v_existing.id returning id into v_id;
  else
    insert into ops.tally_vouchers (company_id, guid, voucher_type, voucher_no, voucher_date, party_name, party_id, amount, is_cancelled, is_optional, alter_id, lines, match_key, batch_id, state)
    values (b.company_id, r.guid, coalesce(p ->> 'type', 'Unknown'), p ->> 'number', v_date, p ->> 'party', v_party, v_amount,
            coalesce((p ->> 'cancelled')::boolean, false), coalesce((p ->> 'optional')::boolean, false), r.alter_id, coalesce(p -> 'lines', '[]'::jsonb), v_key, b.id,
            case when coalesce((p ->> 'cancelled')::boolean, false) or coalesce((p ->> 'optional')::boolean, false) then 'flagged' else 'loaded' end)
    returning id into v_id;
  end if;
  update ops.import_rows set erp_table = 'ops.tally_vouchers', erp_id = v_id where id = r.id;
  select sum((l ->> 'amount')::numeric) into v_sum from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) l;
  if v_sum is not null and abs(v_sum) > 0.01 then
    perform app.open_bug(jsonb_build_object('company_id', b.company_id, 'area', 'ledger', 'kind', 'unbalanced_voucher', 'severity', 'high', 'batch_id', b.id, 'who_fixes', 'ca',
      'title', 'Voucher does not balance: ' || coalesce(p ->> 'type', '') || ' ' || coalesce(p ->> 'number', ''), 'amount', abs(v_sum),
      'evidence', jsonb_build_object('voucher', p, 'difference', v_sum), 'suggested_fix', 'Correct it in Tally and load again, or post a correcting journal.',
      'ref_table', 'ops.tally_vouchers', 'ref_id', v_id, 'dedupe_key', 'unbal|' || v_id));
  end if;
  return 'created';
end $$;

-- ═══════════════════════════════ Batch RPCs ═══════════════════════════════
create or replace function api.import_create_batch(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid; v_code text; v_res jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_source text := p ->> 'source';
begin
  v_prev := app.request_seen(p_client_request_id, 'import_create_batch'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'data.import');
  select 'IMP-' || to_char(now() at time zone 'Asia/Kolkata', 'YYMMDD') || '-' || lpad((count(*) + 1)::text, 3, '0') into v_code
  from ops.import_batches where created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
  insert into ops.import_batches (code, company_id, source, kind, file_name, storage_path, status, totals, as_of, created_by)
  values (v_code, v_company, v_source, coalesce(p ->> 'kind', 'mixed'), p ->> 'file_name', p ->> 'storage_path',
          case when v_source = 'tbk' then 'awaiting_bridge' else 'uploaded' end, coalesce(p -> 'totals', '{}'::jsonb), nullif(p ->> 'as_of', '')::date, auth.uid())
  returning id into v_id;
  perform app.log_event('admin_action', jsonb_build_object('entity', 'import_batch', 'code', v_code, 'file', p ->> 'file_name'));
  v_res := jsonb_build_object('id', v_id, 'code', v_code);
  return app.request_done(p_client_request_id, 'import_create_batch', v_res);
end $$;

-- Rows arrive in chunks: [{object_type, name, guid, master_id, alter_id, payload}]
create or replace function api.import_stage_rows(p_batch_id uuid, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare b ops.import_batches; v_start int; v_n int;
begin
  select * into b from ops.import_batches where id = p_batch_id for update;
  if not found then perform app.raise_rule('import.missing', 'batch not found', 'P0002'); end if;
  perform app.require(b.company_id, 'data.import');
  if b.status not in ('uploaded', 'staged') then perform app.raise_rule('import.locked', 'this batch can no longer take rows', '22023'); end if;
  select coalesce(max(seq), 0) into v_start from ops.import_rows where batch_id = p_batch_id;
  insert into ops.import_rows (batch_id, seq, object_type, name, guid, master_id, alter_id, payload)
  select p_batch_id, v_start + ord::int, e ->> 'object_type', nullif(trim(e ->> 'name'), ''), nullif(e ->> 'guid', ''), nullif(e ->> 'master_id', ''),
         nullif(e ->> 'alter_id', '')::bigint, coalesce(e -> 'payload', '{}'::jsonb)
  from jsonb_array_elements(p_rows) with ordinality as t(e, ord);
  get diagnostics v_n = row_count;
  update ops.import_batches set status = 'staged' where id = p_batch_id;
  return jsonb_build_object('staged', v_n);
end $$;

-- Process every staged row (and rows waiting for a head mapping). Re-runnable; each row is decided once.
create or replace function api.import_process(p_client_request_id uuid, p_batch_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; b ops.import_batches; r ops.import_rows; v_result text; v_counts jsonb; v_res jsonb; v_t jsonb; v_dr numeric; v_cr numeric; v_n int;
begin
  v_prev := app.request_seen(p_client_request_id, 'import_process'); if v_prev is not null then return v_prev; end if;
  select * into b from ops.import_batches where id = p_batch_id for update;
  if not found then perform app.raise_rule('import.missing', 'batch not found', 'P0002'); end if;
  perform app.require(b.company_id, 'data.import');
  if b.status not in ('staged', 'processed') then perform app.raise_rule('import.locked', 'this batch cannot be processed now', '22023'); end if;

  for r in select * from ops.import_rows where batch_id = p_batch_id and (result is null or (result = 'bug' and message = 'waiting_map'))
           order by app.imp_rank(object_type), seq loop
    begin
      v_result := case r.object_type
        when 'group' then app.imp_group(b, r)
        when 'ledger' then app.imp_ledger(b, r)
        when 'stock_group' then app.imp_stock_group(b, r)
        when 'unit' then app.imp_unit(b, r)
        when 'stock_item' then app.imp_stock_item(b, r)
        when 'employee' then app.imp_employee(b, r)
        when 'voucher' then app.imp_voucher(b, r)
        else 'skipped' end;
      update ops.import_rows set result = v_result, message = case when v_result in ('bug') then message else null end where id = r.id;
    exception when others then
      update ops.import_rows set result = 'error', message = left(sqlerrm, 300) where id = r.id;
      perform app.open_bug(jsonb_build_object('company_id', b.company_id, 'area', 'import', 'kind', 'other', 'severity', 'high', 'batch_id', b.id,
        'title', 'Row could not be loaded: ' || coalesce(r.name, r.object_type), 'evidence', jsonb_build_object('row', r.payload, 'error', sqlerrm),
        'suggested_fix', 'Check the row in Tally and load again.', 'dedupe_key', 'err|' || r.id));
    end;
  end loop;

  -- Deleted in Tally: vouchers previously loaded inside this file's period that the file no longer has.
  if b.totals ? 'period_from' and b.totals ? 'period_to' then
    insert into ops.bug_items (company_id, area, kind, severity, title, evidence, suggested_fix, batch_id, ref_table, ref_id, dedupe_key, amount)
    select b.company_id, 'import', 'deleted_in_tally', 'high', 'Deleted in Tally after loading: ' || v.voucher_type || ' ' || coalesce(v.voucher_no, ''),
           to_jsonb(v), 'Confirm the deletion; the loaded entry is reversed after approval.', b.id, 'ops.tally_vouchers', v.id, 'del|' || v.id, v.amount
    from ops.tally_vouchers v
    where v.company_id = b.company_id and v.state in ('loaded', 'flagged') and v.batch_id is distinct from b.id
      and v.voucher_date between (b.totals ->> 'period_from')::date and (b.totals ->> 'period_to')::date
      and not exists (select 1 from ops.import_rows x where x.batch_id = b.id and x.object_type = 'voucher'
                      and coalesce(x.guid, concat_ws('|', x.payload ->> 'type', x.payload ->> 'number', x.payload ->> 'date', x.payload ->> 'amount', x.payload ->> 'party')) = v.match_key)
    on conflict (dedupe_key) do nothing;
  end if;

  -- Reconcile against the totals Tally declared in the file. Every difference is a Bug fixer item.
  v_t := b.totals;
  if v_t ? 'voucher_count' then
    select count(*) into v_n from ops.import_rows where batch_id = b.id and object_type = 'voucher';
    if v_n <> (v_t ->> 'voucher_count')::int then
      perform app.open_bug(jsonb_build_object('company_id', b.company_id, 'area', 'import', 'kind', 'total_mismatch', 'severity', 'high', 'batch_id', b.id,
        'title', 'Day book count differs from Tally', 'evidence', jsonb_build_object('tally', v_t ->> 'voucher_count', 'loaded', v_n), 'dedupe_key', 'vcount|' || b.id));
    end if;
  end if;
  if v_t ? 'opening_dr' or v_t ? 'opening_cr' then
    select coalesce(sum(case when opening_dc = 'D' then opening_balance end), 0), coalesce(sum(case when opening_dc = 'C' then opening_balance end), 0)
      into v_dr, v_cr from acct.accounts where company_id = b.company_id and opening_as_of is not distinct from b.as_of;
    if abs(v_dr - coalesce((v_t ->> 'opening_dr')::numeric, v_dr)) > 0.01 or abs(v_cr - coalesce((v_t ->> 'opening_cr')::numeric, v_cr)) > 0.01 then
      perform app.open_bug(jsonb_build_object('company_id', b.company_id, 'area', 'ledger', 'kind', 'total_mismatch', 'severity', 'high', 'batch_id', b.id, 'who_fixes', 'ca',
        'title', 'Trial balance differs from Tally', 'amount', greatest(abs(v_dr - coalesce((v_t ->> 'opening_dr')::numeric, v_dr)), abs(v_cr - coalesce((v_t ->> 'opening_cr')::numeric, v_cr))),
        'evidence', jsonb_build_object('tally_dr', v_t ->> 'opening_dr', 'tally_cr', v_t ->> 'opening_cr', 'erp_dr', v_dr, 'erp_cr', v_cr),
        'suggested_fix', 'Find the ledgers that did not load (see Bug fixer items of this batch).', 'dedupe_key', 'tb|' || b.id));
    end if;
  end if;

  select jsonb_object_agg(object_type, c) into v_counts from (
    select object_type, jsonb_object_agg(coalesce(result, 'pending'), n) as c
    from (select object_type, result, count(*)::int as n from ops.import_rows where batch_id = b.id group by 1, 2) x group by object_type) y;
  update ops.import_batches set status = 'processed', counts = coalesce(v_counts, '{}'::jsonb), processed_at = now() where id = b.id;
  v_res := jsonb_build_object('id', b.id, 'counts', coalesce(v_counts, '{}'::jsonb), 'open_bugs', (select count(*) from ops.bug_items where batch_id = b.id and status = 'open'));
  return app.request_done(p_client_request_id, 'import_process', v_res);
end $$;

create or replace function api.import_approve(p_client_request_id uuid, p_batch_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; b ops.import_batches; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'import_approve'); if v_prev is not null then return v_prev; end if;
  select * into b from ops.import_batches where id = p_batch_id for update;
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'only Admin approves an import batch', '42501'); end if;
  if b.status <> 'processed' then perform app.raise_rule('import.locked', 'only a processed batch can be approved', '22023'); end if;
  update ops.import_batches set status = 'approved', approved_by = auth.uid(), approved_at = now() where id = p_batch_id;
  perform app.log_event('admin_action', jsonb_build_object('entity', 'import_batch', 'code', b.code, 'action', 'approved'));
  v_res := jsonb_build_object('id', p_batch_id);
  return app.request_done(p_client_request_id, 'import_approve', v_res);
end $$;

-- Undo a batch that is not approved: removes what it created (still "to review"), forgets its Tally keys, reverses its
-- loaded vouchers and dismisses its open Bug fixer items. History keeps everything.
create or replace function api.import_undo(p_client_request_id uuid, p_batch_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; b ops.import_batches; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'import_undo'); if v_prev is not null then return v_prev; end if;
  select * into b from ops.import_batches where id = p_batch_id for update;
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'only Admin undoes an import batch', '42501'); end if;
  if b.status not in ('staged', 'processed', 'uploaded', 'awaiting_bridge') then perform app.raise_rule('import.locked', 'an approved batch cannot be undone', '22023'); end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'reason required', '22023'); end if;
  delete from acct.open_bills where created_batch_id = b.id;
  delete from ops.source_keys where first_batch_id = b.id;
  delete from acct.accounts a where a.created_batch_id = b.id and a.status = 'to_review' and not exists (select 1 from acct.open_bills x where x.account_id = a.id);
  delete from master.product_companies pc using master.products p where pc.product_id = p.id and p.created_batch_id = b.id and p.status = 'to_review';
  delete from master.products p where p.created_batch_id = b.id and p.status = 'to_review'
    and not exists (select 1 from master.product_mrp_history m where m.product_id = p.id) and not exists (select 1 from master.price_list_items i where i.product_id = p.id);
  delete from master.parties p where p.created_batch_id = b.id and p.kyc_status = 'draft' and not exists (select 1 from acct.accounts a where a.party_id = p.id);
  delete from master.person_companies pc using master.people pe where pc.person_id = pe.id and pe.created_batch_id = b.id and pe.status = 'to_review';
  delete from master.people where created_batch_id = b.id and status = 'to_review';
  update ops.tally_vouchers set state = 'reversed' where batch_id = b.id and state in ('loaded', 'flagged');
  update ops.bug_items set status = 'dismissed', resolution = 'batch undone: ' || p_reason, fixed_by = auth.uid(), fixed_at = now() where batch_id = b.id and status = 'open';
  update ops.import_batches set status = 'undone', undone_at = now() where id = b.id;
  perform app.log_event('admin_action', jsonb_build_object('entity', 'import_batch', 'code', b.code, 'action', 'undone', 'reason', p_reason));
  v_res := jsonb_build_object('id', p_batch_id);
  return app.request_done(p_client_request_id, 'import_undo', v_res);
end $$;

-- ═══════════════════════════════ Bug fixer actions ═══════════════════════════════
-- keep_separate: create the incoming record as new · link_existing: link the incoming row to the existing record
-- (alias kept) · accept_change: acknowledge a Tally change · dismiss / fixed: close with a note.
create or replace function api.bug_resolve(p_client_request_id uuid, p_bug_id uuid, p_action text, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; i ops.bug_items; v_res jsonb; v_row ops.import_rows; b ops.import_batches; v_new uuid; v_inc jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'bug_resolve'); if v_prev is not null then return v_prev; end if;
  select * into i from ops.bug_items where id = p_bug_id for update;
  if not found then perform app.raise_rule('bug.missing', 'item not found', 'P0002'); end if;
  perform app.require(i.company_id, 'bugfix.fix');
  if i.status <> 'open' then perform app.raise_rule('bug.closed', 'this item is already closed', '22023'); end if;
  if coalesce(length(trim(p_note)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'say what was decided', '22023'); end if;

  if p_action in ('keep_separate', 'link_existing') and i.kind = 'possible_duplicate' then
    select * into v_row from ops.import_rows where id = (i.evidence ->> 'row_id')::bigint;
    select * into b from ops.import_batches where id = v_row.batch_id;
    v_inc := i.evidence -> 'incoming';
    if v_row.object_type = 'ledger' then
      if p_action = 'keep_separate' then
        insert into master.parties (legal_name, gstin, pan, is_customer, is_supplier, kyc_status, created_batch_id)
        values (v_row.name, null, nullif(upper(v_inc ->> 'pan'), ''), true, false, 'draft', b.id) returning id into v_new;
      else
        v_new := i.ref_id;
        insert into master.party_aliases (party_id, alias, source) values (v_new, v_row.name, 'tally') on conflict do nothing;
      end if;
      -- Re-run the ledger now that the party decision exists (exact alias/name now matches).
      update ops.import_rows set result = null, message = null where id = v_row.id;
      if p_action = 'keep_separate' then
        insert into master.party_aliases (party_id, alias, source) values (v_new, v_row.name, 'tally') on conflict do nothing;
      end if;
      update ops.import_rows set result = app.imp_ledger(b, (select x from ops.import_rows x where x.id = v_row.id)) where id = v_row.id;
    elsif v_row.object_type = 'stock_item' then
      if p_action = 'link_existing' then
        insert into master.product_aliases (product_id, alias, source) values (i.ref_id, v_row.name, 'tally') on conflict do nothing;
        update ops.import_rows set result = app.imp_stock_item(b, (select x from ops.import_rows x where x.id = v_row.id)) where id = v_row.id;
      else
        insert into master.products (code, name, uom, status, created_batch_id)
        values (left(regexp_replace(upper(v_row.name), '[^A-Z0-9]+', '', 'g'), 12) || '-' || substr(md5(random()::text), 1, 4), v_row.name,
                coalesce(app.imp_uom(v_inc ->> 'unit'), 'OTH'), 'to_review', b.id) returning id into v_new;
        insert into master.product_companies (product_id, company_id) values (v_new, b.company_id) on conflict do nothing;
        update ops.import_rows set result = 'created', erp_table = 'master.products', erp_id = v_new where id = v_row.id;
        perform app.imp_remember(b, (select x from ops.import_rows x where x.id = v_row.id), 'master.products', v_new);
      end if;
    end if;
    update ops.bug_items set other_id = v_new where id = i.id;
  elsif p_action = 'accept_change' and i.kind = 'changed_in_tally' then
    if i.ref_table = 'ops.tally_vouchers' then
      update ops.tally_vouchers set lines = coalesce(i.evidence -> 'after' -> 'lines', lines), amount = coalesce((i.evidence -> 'after' ->> 'amount')::numeric, amount),
             alter_id = (i.evidence ->> 'alter_id_after')::bigint where id = i.ref_id;
    else
      update ops.source_keys set alter_id = (i.evidence ->> 'alter_id_after')::bigint, payload_hash = md5((i.evidence -> 'after')::text) where erp_id = i.ref_id;
    end if;
  elsif p_action not in ('dismiss', 'fixed') then
    perform app.raise_rule('bug.bad_action', 'this action does not fit this item', '22023');
  end if;

  update ops.bug_items set status = case when p_action = 'dismiss' then 'dismissed' else 'fixed' end, resolution = p_action || ': ' || p_note,
         fixed_by = auth.uid(), fixed_at = now() where id = i.id;
  perform app.log_event('admin_action', jsonb_build_object('entity', 'bug_item', 'code', i.code, 'action', p_action, 'note', p_note));
  v_res := jsonb_build_object('id', i.id, 'action', p_action, 'new_id', v_new);
  return app.request_done(p_client_request_id, 'bug_resolve', v_res);
end $$;

-- Run the master checks again (missing HSN, registered parties without GSTIN, KYC refresh due, unmapped groups).
create or replace function api.run_checks(p_client_request_id uuid, p_company_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_before int; v_after int; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'run_checks'); if v_prev is not null then return v_prev; end if;
  perform app.require(p_company_id, 'bugfix.fix');
  select count(*) into v_before from ops.bug_items where status = 'open';
  perform app.open_bug(jsonb_build_object('company_id', p_company_id, 'area', 'tax', 'kind', 'missing_hsn', 'severity', 'medium',
           'title', 'Item without HSN: ' || p.name, 'evidence', jsonb_build_object('item', p.name), 'suggested_fix', 'Add the HSN code on the Product master.',
           'ref_table', 'master.products', 'ref_id', p.id, 'dedupe_key', 'nohsn|' || p.id))
  from master.products p join master.product_companies pc on pc.product_id = p.id and pc.company_id = p_company_id
  where p.hsn_code is null and p.status <> 'inactive';
  perform app.open_bug(jsonb_build_object('company_id', p_company_id, 'area', 'masters', 'kind', 'missing_gstin', 'severity', 'medium',
           'title', 'Registered party without GSTIN: ' || p.legal_name, 'evidence', jsonb_build_object('party', p.legal_name),
           'suggested_fix', 'Add the GSTIN in KYC.', 'ref_id', p.id, 'dedupe_key', 'nogstin|' || p.id))
  from master.parties p join master.party_companies pc on pc.party_id = p.id and pc.company_id = p_company_id
  where p.gst_status = 'registered' and p.gstin is null and p.status = 'active';
  perform app.open_bug(jsonb_build_object('company_id', p_company_id, 'area', 'tax', 'kind', 'other', 'severity', 'medium',
           'title', 'GST rate not confirmed by the CA: HSN ' || r.hsn_code, 'evidence', jsonb_build_object('hsn', r.hsn_code, 'rate', r.rate, 'from', r.effective_from),
           'who_fixes', 'ca', 'suggested_fix', 'Ask the CA to confirm this rate; then mark it confirmed.', 'dedupe_key', 'rate|' || r.id))
  from master.hsn_rates r where not r.ca_confirmed and (r.effective_to is null or r.effective_to >= current_date);
  select count(*) into v_after from ops.bug_items where status = 'open';
  v_res := jsonb_build_object('new_items', v_after - v_before);
  return app.request_done(p_client_request_id, 'run_checks', v_res);
end $$;

revoke all on all functions in schema api from public, anon;
grant execute on all functions in schema api to authenticated;
grant execute on function api.log_sign_in_failure(text) to anon;
revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;
notify pgrst, 'reload schema';

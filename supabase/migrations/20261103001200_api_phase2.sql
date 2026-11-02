-- 20261103001200_api_phase2.sql
-- Phase 2 Data API: read views and RPCs for masters, KYC, chart of accounts, opening outstanding, price lists,
-- the Tally import (create batch → stage rows → process → approve / undo), the Bug fixer, merges and backups.
-- All business decisions (matching, duplicates, creation, bugs) happen here in Postgres.

-- ═══════════════════════════════ Read views ═══════════════════════════════
create or replace view api.uoms with (security_invoker = true) as select code, label, decimals from master.uoms;
create or replace view api.hsn_codes with (security_invoker = true) as
select h.code, h.description, h.kind,
       (select r.rate from master.hsn_rates r where r.hsn_code = h.code and r.effective_from <= current_date and (r.effective_to is null or r.effective_to >= current_date) order by r.effective_from desc limit 1) as current_rate,
       (select r.tax_class from master.hsn_rates r where r.hsn_code = h.code and r.effective_from <= current_date and (r.effective_to is null or r.effective_to >= current_date) order by r.effective_from desc limit 1) as current_tax_class,
       (select r.ca_confirmed from master.hsn_rates r where r.hsn_code = h.code and r.effective_from <= current_date and (r.effective_to is null or r.effective_to >= current_date) order by r.effective_from desc limit 1) as current_ca_confirmed
from master.hsn_codes h;
create or replace view api.hsn_rates with (security_invoker = true) as
select id, hsn_code, rate, cess_rate, tax_class, effective_from, effective_to, ca_confirmed, note, set_at from master.hsn_rates;

create or replace view api.product_groups with (security_invoker = true) as
select g.id, g.company_id, g.parent_id, g.name, g.kind, g.tally_name,
       (select count(*) from master.products p where p.group_id = g.id)::int as product_count
from master.product_groups g;

create or replace view api.products with (security_invoker = true) as
select p.id, p.code, p.name, p.group_id, g.name as group_name, p.family, p.kind, p.hsn_code, p.uom, p.net_qty, p.net_qty_uom, p.pack_size,
       p.barcode, p.licence_no, p.label, p.status, p.created_at,
       (select m.mrp from master.product_mrp_history m where m.product_id = p.id and m.effective_from <= current_date order by m.effective_from desc limit 1) as mrp,
       (select r.rate from master.hsn_rates r where r.hsn_code = p.hsn_code and r.effective_from <= current_date and (r.effective_to is null or r.effective_to >= current_date) order by r.effective_from desc limit 1) as gst_rate,
       coalesce((select array_agg(pc.company_id) from master.product_companies pc where pc.product_id = p.id and pc.active), '{}') as company_ids,
       (select count(*) from master.product_aliases a where a.product_id = p.id)::int as alias_count
from master.products p left join master.product_groups g on g.id = p.group_id;

create or replace view api.product_mrp_history with (security_invoker = true) as
select id, product_id, mrp, effective_from, set_at from master.product_mrp_history;

create or replace view api.parties with (security_invoker = true) as
select p.id, p.legal_name, p.trade_name, p.gst_status, p.gstin, p.pan, p.state_code, p.is_customer, p.is_supplier, p.customer_type, p.supplies,
       p.msme_category, p.udyam_no, p.gstin_checked_at, p.gstin_check_result, p.kyc_status, p.kyc_verified_at, p.kyc_refresh_due, p.status,
       p.merged_into, p.created_at,
       coalesce((select jsonb_agg(jsonb_build_object('company_id', pc.company_id, 'is_customer', pc.is_customer, 'is_supplier', pc.is_supplier,
                                                     'credit_term_id', pc.credit_term_id, 'credit_limit', pc.credit_limit, 'beat', pc.beat, 'tier', pc.tier, 'active', pc.active))
                 from master.party_companies pc where pc.party_id = p.id), '[]'::jsonb) as companies,
       (select c.whatsapp from master.party_contacts c where c.party_id = p.id order by c.is_primary desc limit 1) as primary_whatsapp,
       (select count(*) from master.party_documents d where d.party_id = p.id)::int as document_count,
       (select count(*) from master.party_aliases a where a.party_id = p.id)::int as alias_count,
       (select b.account_last4 from master.party_bank_accounts b where b.party_id = p.id and b.active limit 1) as bank_last4
from master.parties p;

-- Customers register (Customers screen). Receipt figures arrive with receipts in Phase 3 (null until then).
create or replace view api.customers with (security_invoker = true) as
select p.id, pc.company_id, p.legal_name as name, p.trade_name, p.gstin, p.customer_type,
       null::text as how_paid, null::numeric(18,2) as received_fy, null::int as payments_count, null::date as last_paid_on,
       case when p.status = 'inactive' or not pc.active then 'inactive'
            when p.kyc_status = 'verified' then 'active'
            when p.kyc_status = 'rejected' then 'check'
            else 'draft' end as status,
       case p.kyc_status when 'draft' then 'Draft · KYC' when 'review' then 'KYC to verify' else null end as status_note,
       p.kyc_status
from master.parties p join master.party_companies pc on pc.party_id = p.id and pc.is_customer
where p.status <> 'merged';

create or replace view api.suppliers with (security_invoker = true) as
select p.id, pc.company_id, p.legal_name as name, p.trade_name, p.gstin, p.pan, p.msme_category, p.udyam_no, p.supplies, p.kyc_status, p.status,
       t.label as terms, t.days as term_days,
       (select b.account_last4 from master.party_bank_accounts b where b.party_id = p.id and b.active limit 1) as bank_last4,
       exists (select 1 from master.bank_change_requests r where r.party_id = p.id and r.status = 'pending') as bank_change_pending
from master.parties p join master.party_companies pc on pc.party_id = p.id and pc.is_supplier
left join master.credit_terms t on t.id = pc.credit_term_id
where p.status <> 'merged';

create or replace view api.party_contacts with (security_invoker = true) as
select id, party_id, name, role, whatsapp, phone, email, language, whatsapp_consent, consent_at, is_primary from master.party_contacts;
create or replace view api.party_addresses with (security_invoker = true) as
select id, party_id, kind, line1, line2, city, state_code, pincode, lat, lng from master.party_addresses;
create or replace view api.party_bank_accounts with (security_invoker = true) as
select id, party_id, '••' || account_last4 as account_masked, ifsc, bank_name, verified_by, active, created_at from master.party_bank_accounts;
create or replace view api.bank_change_requests with (security_invoker = true) as
select r.id, r.party_id, p.legal_name as party_name, r.ifsc, r.bank_name, r.reason, r.requested_by, rp.display_name as requested_by_name, r.requested_at,
       r.callback_by, r.callback_note, r.callback_at, r.decided_by, r.decided_at, r.status
from master.bank_change_requests r join master.parties p on p.id = r.party_id left join core.user_profiles rp on rp.user_id = r.requested_by;
create or replace view api.party_documents with (security_invoker = true) as
select id, party_id, kind, storage_path, expires_on, uploaded_at from master.party_documents;
create or replace view api.party_aliases with (security_invoker = true) as
select id, party_id, alias, source from master.party_aliases;
create or replace view api.credit_terms with (security_invoker = true) as
select id, company_id, code, label, days, basis, active from master.credit_terms;

create or replace view api.price_lists with (security_invoker = true) as
select l.id, l.company_id, l.name, l.kind, l.tax_inclusive, l.active,
       (select count(distinct i.product_id) from master.price_list_items i where i.price_list_id = l.id)::int as item_count
from master.price_lists l;
create or replace view api.price_list_items with (security_invoker = true) as
select distinct on (i.price_list_id, i.product_id, i.min_qty)
       i.id, i.price_list_id, i.product_id, p.code as product_code, p.name as product_name, p.uom, i.price, i.min_qty, i.effective_from, i.set_at
from master.price_list_items i join master.products p on p.id = i.product_id
where i.effective_from <= current_date
order by i.price_list_id, i.product_id, i.min_qty, i.effective_from desc;

create or replace view api.people with (security_invoker = true) as
select pe.id, pe.person_code, pe.name, pe.pan, case when pe.phone is null then null else '••' || right(pe.phone, 4) end as phone_masked,
       pe.dob, case when pe.aadhaar_last4 is null then null else 'XXXX XXXX ' || pe.aadhaar_last4 end as aadhaar_masked, pe.status,
       coalesce((select jsonb_agg(jsonb_build_object('company_id', pc.company_id, 'employee_code', pc.employee_code, 'is_pay_company', pc.is_pay_company))
                 from master.person_companies pc where pc.person_id = pe.id), '[]'::jsonb) as companies
from master.people pe;

create or replace view api.account_groups with (security_invoker = true) as
select g.id, g.company_id, g.name, g.parent_id, g.nature, g.is_party_group,
       (select count(*) from acct.accounts a where a.group_id = g.id)::int as account_count,
       coalesce((select array_agg(m.tally_group) from ops.tally_group_map m where m.account_group_id = g.id), '{}') as tally_groups
from acct.account_groups g;
create or replace view api.accounts with (security_invoker = true) as
select a.id, a.company_id, a.group_id, g.name as group_name, g.nature, a.name, a.party_id, a.opening_balance, a.opening_dc, a.opening_as_of, a.status
from acct.accounts a join acct.account_groups g on g.id = a.group_id;
create or replace view api.open_bills with (security_invoker = true) as
select b.id, b.company_id, b.account_id, a.name as account_name, b.party_id, b.bill_ref, b.bill_date, b.due_date, b.amount, b.dc, b.tax_class, b.as_of,
       case when b.bill_date is null then 'unknown'
            when current_date - b.bill_date <= 30 then '0-30'
            when current_date - b.bill_date <= 60 then '31-60'
            when current_date - b.bill_date <= 90 then '61-90'
            else '90+' end as ageing_bucket
from acct.open_bills b join acct.accounts a on a.id = b.account_id;
create or replace view api.posting_rules with (security_invoker = true) as
select r.id, r.company_id, r.event, r.account_id, a.name as account_name, r.note from acct.posting_rules r join acct.accounts a on a.id = r.account_id;

create or replace view api.import_batches with (security_invoker = true) as
select b.id, b.code, b.company_id, c.short_name as company_name, b.source, b.kind, b.file_name, b.storage_path, b.status, b.counts, b.totals, b.as_of,
       b.created_by, p.display_name as created_by_name, b.created_at, b.processed_at, b.approved_at, b.undone_at,
       (select count(*) from ops.import_rows r where r.batch_id = b.id)::int as row_count,
       (select count(*) from ops.bug_items i where i.batch_id = b.id and i.status = 'open')::int as open_bugs
from ops.import_batches b join core.companies c on c.id = b.company_id left join core.user_profiles p on p.user_id = b.created_by;
create or replace view api.import_rows with (security_invoker = true) as
select id, batch_id, seq, object_type, name, guid, alter_id, result, erp_table, erp_id, bug_id, message from ops.import_rows;
create or replace view api.tally_group_map with (security_invoker = true) as
select m.company_id, m.tally_group, m.account_group_id, g.name as account_group_name, m.mapped_at
from ops.tally_group_map m join acct.account_groups g on g.id = m.account_group_id;
create or replace view api.tally_vouchers with (security_invoker = true) as
select id, company_id, guid, voucher_type, voucher_no, voucher_date, party_name, party_id, amount, is_cancelled, is_optional, alter_id, state, batch_id
from ops.tally_vouchers;
create or replace view api.source_key_counts with (security_invoker = true) as
select company_id, object_type, count(*)::int as n, max(alter_id) as max_alter_id from ops.source_keys group by company_id, object_type;

create or replace view api.bug_items with (security_invoker = true) as
select i.id, i.code, i.company_id, c.short_name as company_name, i.area, i.kind, i.severity, i.title, i.evidence, i.suggested_fix, i.who_fixes,
       i.amount, i.status, i.batch_id, b.code as batch_code, i.ref_table, i.ref_id, i.other_id, i.resolution, i.fixed_by, fp.display_name as fixed_by_name,
       i.fixed_at, i.created_at
from ops.bug_items i left join core.companies c on c.id = i.company_id left join ops.import_batches b on b.id = i.batch_id
left join core.user_profiles fp on fp.user_id = i.fixed_by;
create or replace view api.merge_log with (security_invoker = true) as
select m.id, m.kind, m.kept_id, m.merged_id, m.preview, m.reason, m.merged_by, p.display_name as merged_by_name, m.merged_at, m.undone_at
from ops.merge_log m left join core.user_profiles p on p.user_id = m.merged_by;
create or replace view api.backup_runs with (security_invoker = true) as
select r.id, r.kind, r.started_at, r.finished_at, r.status, r.location, r.size_bytes, r.checksum, r.note, p.display_name as recorded_by_name
from ops.backup_runs r left join core.user_profiles p on p.user_id = r.recorded_by;

grant select on all tables in schema api to authenticated;

-- Live count for the workflow strip (runs as the caller, so RLS and the view rule apply).
create or replace function api.bug_fixer_open_count() returns int
language sql stable security invoker set search_path = '' as $$
  select count(*)::int from ops.bug_items where status = 'open'
$$;

-- ═══════════════════════════════ Shared helpers ═══════════════════════════════
create or replace function app.raise_rule(p_code text, p_message text, p_errcode text default 'P0001') returns void
language plpgsql set search_path = '' as $$
begin
  raise exception '%', p_message using errcode = p_errcode, hint = p_code;
end $$;

-- Open a Bug fixer item once (dedupe_key), returning its id.
create or replace function app.open_bug(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p ? 'dedupe_key' then
    select id into v_id from ops.bug_items where dedupe_key = p ->> 'dedupe_key';
    if v_id is not null then return v_id; end if;
  end if;
  insert into ops.bug_items (company_id, area, kind, severity, title, evidence, suggested_fix, who_fixes, amount, tax_class, batch_id, ref_table, ref_id, other_id, dedupe_key)
  values (nullif(p ->> 'company_id', '')::uuid, p ->> 'area', p ->> 'kind', coalesce(p ->> 'severity', 'medium'), p ->> 'title',
          coalesce(p -> 'evidence', '{}'::jsonb), p ->> 'suggested_fix', coalesce(p ->> 'who_fixes', 'admin'), nullif(p ->> 'amount', '')::numeric,
          coalesce(p ->> 'tax_class', 'taxable'), nullif(p ->> 'batch_id', '')::uuid, p ->> 'ref_table', nullif(p ->> 'ref_id', '')::uuid,
          nullif(p ->> 'other_id', '')::uuid, p ->> 'dedupe_key')
  returning id into v_id;
  return v_id;
end $$;

-- Parties that look like the given one (same GSTIN/PAN/phone or a similar name).
create or replace function app.party_candidates(p_name text, p_gstin text, p_pan text, p_phone text, p_exclude uuid default null)
returns table (party_id uuid, legal_name text, gstin text, reason text, score real)
language sql stable security definer set search_path = '' as $$
  select p.id, p.legal_name, p.gstin::text,
         case when p_gstin is not null and p.gstin = p_gstin then 'gstin'
              when p_pan is not null and p.pan = p_pan then 'pan'
              when p_phone is not null and exists (select 1 from master.party_contacts c where c.party_id = p.id and (c.whatsapp = p_phone or c.phone = p_phone)) then 'phone'
              when p.name_norm = app.norm_name(p_name) then 'same_name'
              else 'similar_name' end,
         extensions.similarity(p.name_norm, app.norm_name(p_name))
  from master.parties p
  where p.status <> 'merged' and p.id is distinct from p_exclude
    and ((p_gstin is not null and p.gstin = p_gstin)
      or (p_pan is not null and p.pan = p_pan)
      or (p_phone is not null and exists (select 1 from master.party_contacts c where c.party_id = p.id and (c.whatsapp = p_phone or c.phone = p_phone)))
      or extensions.similarity(p.name_norm, app.norm_name(p_name)) >= 0.55
      or exists (select 1 from master.party_aliases a where a.party_id = p.id and a.alias_norm = app.norm_name(p_name)))
  order by 5 desc
  limit 10
$$;

-- ═══════════════════════════════ HSN and rates ═══════════════════════════════
create or replace function api.upsert_hsn(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_hsn'); if v_prev is not null then return v_prev; end if;
  perform app.require(null, 'hsn.manage');
  insert into master.hsn_codes (code, description, kind) values (p ->> 'code', p ->> 'description', coalesce(p ->> 'kind', 'goods'))
  on conflict (code) do update set description = excluded.description, kind = excluded.kind;
  v_res := jsonb_build_object('code', p ->> 'code');
  return app.request_done(p_client_request_id, 'upsert_hsn', v_res);
end $$;

-- A new rate version from a date. The previous open version is closed the day before. Never edited in place.
create or replace function api.add_hsn_rate(p_client_request_id uuid, p_hsn text, p_rate numeric, p_cess numeric, p_tax_class text, p_effective_from date, p_ca_confirmed boolean, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'add_hsn_rate'); if v_prev is not null then return v_prev; end if;
  perform app.require(null, 'hsn.manage');
  if not exists (select 1 from master.hsn_codes where code = p_hsn) then perform app.raise_rule('hsn.missing', 'HSN code not found', 'P0002'); end if;
  update master.hsn_rates set effective_to = p_effective_from - 1
   where hsn_code = p_hsn and effective_from < p_effective_from and (effective_to is null or effective_to >= p_effective_from);
  insert into master.hsn_rates (hsn_code, rate, cess_rate, tax_class, effective_from, ca_confirmed, note, set_by)
  values (p_hsn, p_rate, coalesce(p_cess, 0), coalesce(p_tax_class, 'taxable'), p_effective_from, coalesce(p_ca_confirmed, false), p_note, auth.uid())
  returning id into v_id;
  perform app.log_event('setting_changed', jsonb_build_object('entity', 'hsn_rate', 'hsn', p_hsn, 'rate', p_rate, 'from', p_effective_from));
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'add_hsn_rate', v_res);
end $$;

-- ═══════════════════════════════ Products ═══════════════════════════════
create or replace function api.upsert_product_group(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_product_group'); if v_prev is not null then return v_prev; end if;
  perform app.require(null, 'products.manage');
  if v_id is null then
    insert into master.product_groups (company_id, parent_id, name, kind)
    values (nullif(p ->> 'company_id', '')::uuid, nullif(p ->> 'parent_id', '')::uuid, p ->> 'name', coalesce(p ->> 'kind', 'finished'))
    returning id into v_id;
  else
    update master.product_groups set name = coalesce(p ->> 'name', name), kind = coalesce(p ->> 'kind', kind),
      parent_id = case when p ? 'parent_id' then nullif(p ->> 'parent_id', '')::uuid else parent_id end where id = v_id;
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_product_group', v_res);
end $$;

-- Create or edit a product. A similar existing product stops the save unless p.force = true (duplicate detection).
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
  insert into master.product_mrp_history (product_id, mrp, effective_from, set_by) values (p_product_id, p_mrp, p_effective_from, auth.uid()) returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'set_product_mrp', v_res);
end $$;

-- ═══════════════════════════════ Parties and KYC ═══════════════════════════════
-- Create or edit a customer/supplier and link it to a company. Duplicate GSTIN/PAN/phone or a similar name stops
-- the save (returns the candidates in DETAIL) unless p.force = true. GSTIN: format, check digit, PAN inside, state.
create or replace function api.upsert_party(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_res jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_company uuid := nullif(p ->> 'company_id', '')::uuid;
  v_gstin text := nullif(upper(trim(p ->> 'gstin')), ''); v_pan text := nullif(upper(trim(p ->> 'pan')), '');
  v_cust boolean := coalesce((p ->> 'is_customer')::boolean, false); v_supp boolean := coalesce((p ->> 'is_supplier')::boolean, false);
  v_phone text := nullif(p ->> 'whatsapp', ''); v_dupes jsonb; v_term uuid := nullif(p ->> 'credit_term_id', '')::uuid; v_days int;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_party'); if v_prev is not null then return v_prev; end if;
  if v_company is null and v_id is null then perform app.raise_rule('party.company_required', 'choose the company this party deals with', '22023'); end if;
  if v_cust then perform app.require(v_company, case when v_id is null then 'sales.create' else 'sales.edit' end); end if;
  if v_supp then perform app.require(v_company, case when v_id is null then 'purchase.create' else 'purchase.edit' end); end if;
  if not v_cust and not v_supp then perform app.raise_rule('party.role_required', 'a party is a customer, a supplier or both', '22023'); end if;
  if v_gstin is not null then
    if not app.gstin_valid(v_gstin) then perform app.raise_rule('party.gstin_invalid', 'GSTIN check digit or format is wrong', '22023'); end if;
    if v_pan is null then v_pan := substr(v_gstin, 3, 10); end if;
    if substr(v_gstin, 3, 10) <> v_pan then perform app.raise_rule('party.gstin_pan_mismatch', 'the PAN inside the GSTIN differs from the PAN', '22023'); end if;
  end if;
  if v_pan is not null and v_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' then perform app.raise_rule('party.pan_invalid', 'PAN format is wrong', '22023'); end if;
  -- MSME selling rule: terms over 45 days refused when the company's setting says the rule applies.
  if v_term is not null and v_cust then
    select days into v_days from master.credit_terms where id = v_term;
    if v_days > 45 and coalesce((app.setting(v_company, 'msme.selling_rule'))::text::boolean, false) then
      perform app.raise_rule('party.msme_terms', 'terms longer than 45 days are refused under the MSME rule', '22023');
    end if;
  end if;
  if v_id is null then
    select jsonb_agg(jsonb_build_object('id', c.party_id, 'name', c.legal_name, 'gstin', c.gstin, 'reason', c.reason)) into v_dupes
    from app.party_candidates(p ->> 'legal_name', v_gstin, v_pan, v_phone) c;
    if v_dupes is not null and not coalesce((p ->> 'force')::boolean, false) then
      raise exception 'possible_duplicate' using errcode = 'P0001', hint = 'masters.possible_duplicate', detail = v_dupes::text;
    end if;
    if v_gstin is not null and exists (select 1 from master.parties where gstin = v_gstin) then
      perform app.raise_rule('party.gstin_exists', 'a party with this GSTIN already exists; link it instead', '23505');
    end if;
    insert into master.parties (legal_name, trade_name, gst_status, gstin, pan, state_code, is_customer, is_supplier, customer_type, supplies, msme_category, udyam_no, created_by)
    values (trim(p ->> 'legal_name'), nullif(p ->> 'trade_name', ''), case when v_gstin is not null then 'registered' else coalesce(p ->> 'gst_status', 'unregistered') end,
            v_gstin, v_pan, coalesce(substr(v_gstin, 1, 2), nullif(p ->> 'state_code', '')), v_cust, v_supp, nullif(p ->> 'customer_type', ''), nullif(p ->> 'supplies', ''),
            nullif(p ->> 'msme_category', ''), nullif(upper(p ->> 'udyam_no'), ''), auth.uid())
    returning id into v_id;
    if v_phone is not null then
      insert into master.party_contacts (party_id, name, role, whatsapp, language, whatsapp_consent, consent_at, is_primary)
      values (v_id, coalesce(nullif(p ->> 'contact_name', ''), trim(p ->> 'legal_name')), nullif(p ->> 'contact_role', ''), v_phone, coalesce(p ->> 'language', 'en'),
              coalesce((p ->> 'whatsapp_consent')::boolean, false), case when coalesce((p ->> 'whatsapp_consent')::boolean, false) then now() end, true);
    end if;
    if nullif(p ->> 'address', '') is not null then
      insert into master.party_addresses (party_id, kind, line1, city, state_code, pincode)
      values (v_id, 'billing', p ->> 'address', nullif(p ->> 'city', ''), coalesce(substr(v_gstin, 1, 2), nullif(p ->> 'state_code', '')), nullif(p ->> 'pincode', ''));
    end if;
  else
    perform 1 from master.parties where id = v_id for update;
    if (select kyc_status from master.parties where id = v_id) = 'verified' and (p ? 'gstin' or p ? 'pan' or p ? 'legal_name') and not app.is_admin() then
      perform app.raise_rule('party.verified_locked', 'KYC is verified; only Admin can change name, GSTIN or PAN', '42501');
    end if;
    update master.parties set
      legal_name = coalesce(nullif(trim(p ->> 'legal_name'), ''), legal_name),
      trade_name = case when p ? 'trade_name' then nullif(p ->> 'trade_name', '') else trade_name end,
      gstin = case when p ? 'gstin' then v_gstin else gstin end,
      pan = case when p ? 'pan' or p ? 'gstin' then v_pan else pan end,
      gst_status = case when p ? 'gstin' and v_gstin is not null then 'registered' else coalesce(p ->> 'gst_status', gst_status) end,
      state_code = case when v_gstin is not null then substr(v_gstin, 1, 2) else coalesce(nullif(p ->> 'state_code', ''), state_code) end,
      is_customer = is_customer or v_cust, is_supplier = is_supplier or v_supp,
      customer_type = coalesce(nullif(p ->> 'customer_type', ''), customer_type), supplies = coalesce(nullif(p ->> 'supplies', ''), supplies),
      msme_category = case when p ? 'msme_category' then nullif(p ->> 'msme_category', '') else msme_category end,
      udyam_no = case when p ? 'udyam_no' then nullif(upper(p ->> 'udyam_no'), '') else udyam_no end,
      status = coalesce(p ->> 'status', status)
    where id = v_id;
  end if;
  if v_company is not null then
    insert into master.party_companies (party_id, company_id, is_customer, is_supplier, credit_term_id, beat, tier)
    values (v_id, v_company, v_cust, v_supp, v_term, nullif(p ->> 'beat', ''), nullif(p ->> 'tier', ''))
    on conflict (party_id, company_id) do update set
      is_customer = master.party_companies.is_customer or excluded.is_customer,
      is_supplier = master.party_companies.is_supplier or excluded.is_supplier,
      credit_term_id = coalesce(excluded.credit_term_id, master.party_companies.credit_term_id),
      beat = coalesce(excluded.beat, master.party_companies.beat), tier = coalesce(excluded.tier, master.party_companies.tier);
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_party', v_res);
end $$;

-- Read-only duplicate check for the KYC form (no save).
create or replace function api.party_duplicates(p_name text, p_gstin text, p_pan text, p_phone text, p_exclude uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.party_id, 'name', c.legal_name, 'gstin', c.gstin, 'reason', c.reason, 'score', round(c.score::numeric, 2))), '[]'::jsonb)
  from app.party_candidates(p_name, nullif(upper(p_gstin), ''), nullif(upper(p_pan), ''), nullif(p_phone, ''), p_exclude) c
  where app.can(null, 'sales.view') or app.can(null, 'purchase.view')
$$;

create or replace function api.check_gstin(p_gstin text) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('valid', app.gstin_valid(p_gstin), 'state_code', substr(upper(p_gstin), 1, 2), 'pan', substr(upper(p_gstin), 3, 10))
$$;

create or replace function api.upsert_party_contact(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_party uuid := (p ->> 'party_id')::uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_party_contact'); if v_prev is not null then return v_prev; end if;
  if not (app.can(null, 'sales.edit') or app.can(null, 'purchase.edit')) then perform app.require(null, 'sales.edit'); end if;
  if not app.can_see_party(v_party) then perform app.raise_rule('rights.missing', 'party not visible', '42501'); end if;
  if v_id is null then
    insert into master.party_contacts (party_id, name, role, whatsapp, phone, email, language, whatsapp_consent, consent_at, is_primary)
    values (v_party, p ->> 'name', nullif(p ->> 'role', ''), nullif(p ->> 'whatsapp', ''), nullif(p ->> 'phone', ''), nullif(p ->> 'email', ''), coalesce(p ->> 'language', 'en'),
            coalesce((p ->> 'whatsapp_consent')::boolean, false), case when coalesce((p ->> 'whatsapp_consent')::boolean, false) then now() end, coalesce((p ->> 'is_primary')::boolean, false))
    returning id into v_id;
  else
    update master.party_contacts set name = coalesce(p ->> 'name', name), role = coalesce(p ->> 'role', role), whatsapp = case when p ? 'whatsapp' then nullif(p ->> 'whatsapp', '') else whatsapp end,
      email = coalesce(p ->> 'email', email), language = coalesce(p ->> 'language', language),
      whatsapp_consent = coalesce((p ->> 'whatsapp_consent')::boolean, whatsapp_consent),
      consent_at = case when (p ->> 'whatsapp_consent')::boolean and not whatsapp_consent then now() when (p ->> 'whatsapp_consent')::boolean = false then null else consent_at end
    where id = v_id and party_id = v_party;
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_party_contact', v_res);
end $$;

create or replace function api.upsert_party_address(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_party uuid := (p ->> 'party_id')::uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_party_address'); if v_prev is not null then return v_prev; end if;
  if not (app.can(null, 'sales.edit') or app.can(null, 'purchase.edit')) then perform app.require(null, 'sales.edit'); end if;
  if not app.can_see_party(v_party) then perform app.raise_rule('rights.missing', 'party not visible', '42501'); end if;
  if v_id is null then
    insert into master.party_addresses (party_id, kind, line1, line2, city, state_code, pincode, lat, lng)
    values (v_party, coalesce(p ->> 'kind', 'billing'), p ->> 'line1', nullif(p ->> 'line2', ''), nullif(p ->> 'city', ''), nullif(p ->> 'state_code', ''),
            nullif(p ->> 'pincode', ''), nullif(p ->> 'lat', '')::numeric, nullif(p ->> 'lng', '')::numeric)
    returning id into v_id;
  else
    update master.party_addresses set line1 = coalesce(p ->> 'line1', line1), line2 = coalesce(p ->> 'line2', line2), city = coalesce(p ->> 'city', city),
      pincode = coalesce(p ->> 'pincode', pincode), lat = coalesce(nullif(p ->> 'lat', '')::numeric, lat), lng = coalesce(nullif(p ->> 'lng', '')::numeric, lng)
    where id = v_id and party_id = v_party;
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_party_address', v_res);
end $$;

-- KYC states: draft → review (proposer) → verified / rejected (the office; not the proposer, unless Admin).
create or replace function api.set_party_kyc(p_client_request_id uuid, p_party_id uuid, p_status text, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v record; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_party_kyc'); if v_prev is not null then return v_prev; end if;
  select * into v from master.parties where id = p_party_id for update;
  if not found then perform app.raise_rule('party.missing', 'party not found', 'P0002'); end if;
  if p_status = 'review' then
    if not (app.can(null, 'sales.edit') or app.can(null, 'purchase.edit') or app.can(null, 'sales.create')) then perform app.require(null, 'sales.edit'); end if;
  elsif p_status in ('verified', 'rejected') then
    if not (app.is_admin() or app.can(null, 'kyc.view')) then perform app.require(null, 'kyc.view'); end if;
    if v.created_by = auth.uid() and not app.is_admin() then
      perform app.raise_rule('sod.self_approval', 'the person who proposed the customer cannot verify its KYC', '42501');
    end if;
    if p_status = 'verified' and v.gst_status = 'registered' and v.gstin is null then
      perform app.raise_rule('party.gstin_required', 'a registered party needs its GSTIN before KYC is verified', '22023');
    end if;
  else
    perform app.raise_rule('party.bad_status', 'unknown KYC state', '22023');
  end if;
  update master.parties set kyc_status = p_status,
    kyc_verified_by = case when p_status = 'verified' then auth.uid() else kyc_verified_by end,
    kyc_verified_at = case when p_status = 'verified' then now() else kyc_verified_at end,
    kyc_refresh_due = case when p_status = 'verified' then (current_date + interval '1 year')::date else kyc_refresh_due end
  where id = p_party_id;
  perform app.log_event('admin_action', jsonb_build_object('entity', 'party_kyc', 'party_id', p_party_id, 'status', p_status, 'note', p_note));
  v_res := jsonb_build_object('id', p_party_id, 'kyc_status', p_status);
  return app.request_done(p_client_request_id, 'set_party_kyc', v_res);
end $$;

create or replace function api.add_party_document(p_client_request_id uuid, p_party_id uuid, p_kind text, p_storage_path text, p_expires_on date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'add_party_document'); if v_prev is not null then return v_prev; end if;
  if not (app.can(null, 'sales.edit') or app.can(null, 'purchase.edit') or app.can(null, 'kyc.view')) then perform app.require(null, 'kyc.view'); end if;
  insert into master.party_documents (party_id, kind, storage_path, expires_on, uploaded_by) values (p_party_id, p_kind, p_storage_path, p_expires_on, auth.uid()) returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'add_party_document', v_res);
end $$;

-- First bank account only. Any later change must go through request_bank_change (two people + call-back).
create or replace function api.add_party_bank_account(p_client_request_id uuid, p_party_id uuid, p_account_no text, p_ifsc text, p_bank_name text, p_verified_by text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'add_party_bank_account'); if v_prev is not null then return v_prev; end if;
  if not (app.can(null, 'purchase.edit') or app.can(null, 'sales.edit')) then perform app.require(null, 'purchase.edit'); end if;
  if exists (select 1 from master.party_bank_accounts where party_id = p_party_id and active) then
    perform app.raise_rule('bank.change_needs_approval', 'this party already has a bank account; request a change instead', '22023');
  end if;
  insert into master.party_bank_accounts (party_id, account_no, ifsc, bank_name, verified_by)
  values (p_party_id, regexp_replace(p_account_no, '\D', '', 'g'), upper(p_ifsc), p_bank_name, p_verified_by) returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'add_party_bank_account', v_res);
end $$;

create or replace function api.request_bank_change(p_client_request_id uuid, p_party_id uuid, p_account_no text, p_ifsc text, p_bank_name text, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'request_bank_change'); if v_prev is not null then return v_prev; end if;
  if not (app.can(null, 'purchase.edit') or app.can(null, 'sales.edit')) then perform app.require(null, 'purchase.edit'); end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'reason required', '22023'); end if;
  insert into master.bank_change_requests (party_id, account_no, ifsc, bank_name, reason, requested_by)
  values (p_party_id, regexp_replace(p_account_no, '\D', '', 'g'), upper(p_ifsc), p_bank_name, p_reason, auth.uid()) returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'request_bank_change', v_res);
end $$;

create or replace function api.record_bank_callback(p_client_request_id uuid, p_request_id uuid, p_number_called text, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; r record; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'record_bank_callback'); if v_prev is not null then return v_prev; end if;
  perform app.require(null, 'bank_change.approve');
  select * into r from master.bank_change_requests where id = p_request_id for update;
  if r.requested_by = auth.uid() then perform app.raise_rule('sod.self_approval', 'the requester cannot do the call-back', '42501'); end if;
  if coalesce(length(trim(p_note)), 0) < 5 then perform app.raise_rule('bank.callback_note', 'note what was confirmed on the call', '22023'); end if;
  update master.bank_change_requests set callback_by = auth.uid(), callback_number = p_number_called, callback_note = p_note, callback_at = now() where id = p_request_id;
  v_res := jsonb_build_object('id', p_request_id);
  return app.request_done(p_client_request_id, 'record_bank_callback', v_res);
end $$;

create or replace function api.decide_bank_change(p_client_request_id uuid, p_request_id uuid, p_approve boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; r master.bank_change_requests; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'decide_bank_change'); if v_prev is not null then return v_prev; end if;
  perform app.require(null, 'bank_change.approve');
  select * into r from master.bank_change_requests where id = p_request_id for update;
  if not found or r.status <> 'pending' then perform app.raise_rule('grant.already_decided', 'already decided', '22023'); end if;
  if r.requested_by = auth.uid() then perform app.raise_rule('sod.self_approval', 'nobody approves their own bank change', '42501'); end if;
  if p_approve and r.callback_at is null then perform app.raise_rule('bank.callback_required', 'record the call-back to a known number first', '22023'); end if;
  if p_approve then
    update master.party_bank_accounts set active = false where party_id = r.party_id and active;
    insert into master.party_bank_accounts (party_id, account_no, ifsc, bank_name, verified_by) values (r.party_id, r.account_no, r.ifsc, r.bank_name, 'cancelled_cheque');
  end if;
  update master.bank_change_requests set status = case when p_approve then 'approved' else 'refused' end, decided_by = auth.uid(), decided_at = now() where id = p_request_id;
  perform app.log_event('admin_action', jsonb_build_object('entity', 'bank_change', 'request', p_request_id, 'approved', p_approve));
  v_res := jsonb_build_object('id', p_request_id, 'approved', p_approve);
  return app.request_done(p_client_request_id, 'decide_bank_change', v_res);
end $$;

-- Full account number for finance, logged as a sensitive view.
create or replace function api.view_bank_account(p_account_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v text;
begin
  perform app.require(null, 'bank.view_full');
  select account_no into v from master.party_bank_accounts where id = p_account_id;
  perform app.log_event('view_sensitive', jsonb_build_object('entity', 'bank_account', 'id', p_account_id));
  return v;
end $$;

create or replace function api.upsert_credit_term(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_credit_term'); if v_prev is not null then return v_prev; end if;
  perform app.require(nullif(p ->> 'company_id', '')::uuid, 'settings.manage');
  if v_id is null then
    insert into master.credit_terms (company_id, code, label, days, basis) values (nullif(p ->> 'company_id', '')::uuid, upper(p ->> 'code'), p ->> 'label', (p ->> 'days')::int, coalesce(p ->> 'basis', 'invoice')) returning id into v_id;
  else
    update master.credit_terms set label = coalesce(p ->> 'label', label), active = coalesce((p ->> 'active')::boolean, active) where id = v_id;
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_credit_term', v_res);
end $$;

-- ═══════════════════════════════ Price lists ═══════════════════════════════
create or replace function api.upsert_price_list(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_price_list'); if v_prev is not null then return v_prev; end if;
  perform app.require((p ->> 'company_id')::uuid, 'products.manage');
  if v_id is null then
    insert into master.price_lists (company_id, name, kind, tax_inclusive) values ((p ->> 'company_id')::uuid, p ->> 'name', coalesce(p ->> 'kind', 'wholesale'), coalesce((p ->> 'tax_inclusive')::boolean, false)) returning id into v_id;
  else
    update master.price_lists set name = coalesce(p ->> 'name', name), kind = coalesce(p ->> 'kind', kind), active = coalesce((p ->> 'active')::boolean, active),
      tax_inclusive = coalesce((p ->> 'tax_inclusive')::boolean, tax_inclusive) where id = v_id;
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_price_list', v_res);
end $$;

-- A price takes effect from a date; earlier prices stay in history. Price above MRP is refused (Legal Metrology).
create or replace function api.set_price(p_client_request_id uuid, p_price_list_id uuid, p_product_id uuid, p_price numeric, p_min_qty numeric, p_effective_from date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid; v_res jsonb; v_company uuid; v_mrp numeric; v_incl boolean;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_price'); if v_prev is not null then return v_prev; end if;
  select company_id, tax_inclusive into v_company, v_incl from master.price_lists where id = p_price_list_id;
  perform app.require(v_company, 'products.manage');
  select mrp into v_mrp from master.product_mrp_history where product_id = p_product_id and effective_from <= p_effective_from order by effective_from desc limit 1;
  if v_incl and v_mrp is not null and p_price > v_mrp then
    perform app.raise_rule('price.above_mrp', 'a tax-inclusive price cannot be above MRP', '22023');
  end if;
  insert into master.price_list_items (price_list_id, product_id, price, min_qty, effective_from, set_by)
  values (p_price_list_id, p_product_id, p_price, coalesce(p_min_qty, 0), p_effective_from, auth.uid())
  on conflict (price_list_id, product_id, min_qty, effective_from) do update set price = excluded.price, set_by = excluded.set_by, set_at = now()
  returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'set_price', v_res);
end $$;

-- ═══════════════════════════════ Chart of accounts ═══════════════════════════════
create or replace function api.upsert_account_group(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_company uuid := (p ->> 'company_id')::uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_account_group'); if v_prev is not null then return v_prev; end if;
  if v_id is not null then select company_id into v_company from acct.account_groups where id = v_id; end if;
  perform app.require(v_company, 'settings.manage');
  if v_id is null then
    insert into acct.account_groups (company_id, name, parent_id, nature, is_party_group)
    values (v_company, p ->> 'name', nullif(p ->> 'parent_id', '')::uuid, p ->> 'nature', nullif(p ->> 'is_party_group', '')) returning id into v_id;
  else
    update acct.account_groups set name = coalesce(p ->> 'name', name), nature = coalesce(p ->> 'nature', nature),
      is_party_group = case when p ? 'is_party_group' then nullif(p ->> 'is_party_group', '') else is_party_group end where id = v_id;
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_account_group', v_res);
end $$;

create or replace function api.upsert_account(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_company uuid := (p ->> 'company_id')::uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_account'); if v_prev is not null then return v_prev; end if;
  if v_id is not null then select company_id into v_company from acct.accounts where id = v_id; end if;
  perform app.require(v_company, 'settings.manage');
  if v_id is null then
    insert into acct.accounts (company_id, group_id, name, party_id, opening_balance, opening_dc, opening_as_of, status)
    values (v_company, (p ->> 'group_id')::uuid, p ->> 'name', nullif(p ->> 'party_id', '')::uuid, coalesce((p ->> 'opening_balance')::numeric, 0),
            coalesce(p ->> 'opening_dc', 'D'), nullif(p ->> 'opening_as_of', '')::date, 'active') returning id into v_id;
  else
    update acct.accounts set name = coalesce(p ->> 'name', name), group_id = coalesce(nullif(p ->> 'group_id', '')::uuid, group_id),
      status = coalesce(p ->> 'status', status) where id = v_id;
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_account', v_res);
end $$;

-- Admin classifies opening bills (taxable / without GST with a reason later). Only Admin sees unclassified bills.
create or replace function api.classify_open_bills(p_client_request_id uuid, p_bill_ids uuid[], p_tax_class text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_n int; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'classify_open_bills'); if v_prev is not null then return v_prev; end if;
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'only Admin classifies opening bills', '42501'); end if;
  update acct.open_bills set tax_class = p_tax_class where id = any (p_bill_ids);
  get diagnostics v_n = row_count;
  v_res := jsonb_build_object('count', v_n);
  return app.request_done(p_client_request_id, 'classify_open_bills', v_res);
end $$;

create or replace function api.set_tally_group_map(p_client_request_id uuid, p_company_id uuid, p_tally_group text, p_account_group_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_tally_group_map'); if v_prev is not null then return v_prev; end if;
  perform app.require(p_company_id, 'settings.manage');
  if not exists (select 1 from acct.account_groups where id = p_account_group_id and company_id = p_company_id) then
    perform app.raise_rule('org.company_missing', 'the account group belongs to another company', '22023');
  end if;
  insert into ops.tally_group_map (company_id, tally_group, account_group_id, mapped_by) values (p_company_id, p_tally_group, p_account_group_id, auth.uid())
  on conflict (company_id, tally_group) do update set account_group_id = excluded.account_group_id, mapped_by = excluded.mapped_by, mapped_at = now();
  -- Close the matching "Map this head" items.
  update ops.bug_items set status = 'fixed', fixed_by = auth.uid(), fixed_at = now(), resolution = 'mapped'
   where kind = 'map_head' and company_id = p_company_id and evidence ->> 'tally_group' = p_tally_group and status = 'open';
  v_res := jsonb_build_object('ok', true);
  return app.request_done(p_client_request_id, 'set_tally_group_map', v_res);
end $$;

-- ═══════════════════════════════ Merge ═══════════════════════════════
create or replace function api.merge_preview(p_kind text, p_kept uuid, p_merged uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'only Admin merges', '42501'); end if;
  if p_kind = 'party' then
    return jsonb_build_object(
      'kept', (select jsonb_build_object('id', id, 'name', legal_name, 'gstin', gstin) from master.parties where id = p_kept),
      'merged', (select jsonb_build_object('id', id, 'name', legal_name, 'gstin', gstin) from master.parties where id = p_merged),
      'accounts', (select count(*) from acct.accounts where party_id = p_merged),
      'open_bills', (select count(*) from acct.open_bills where party_id = p_merged),
      'contacts', (select count(*) from master.party_contacts where party_id = p_merged),
      'addresses', (select count(*) from master.party_addresses where party_id = p_merged),
      'company_links', (select count(*) from master.party_companies where party_id = p_merged),
      'source_keys', (select count(*) from ops.source_keys where erp_id = p_merged),
      'vouchers', (select count(*) from ops.tally_vouchers where party_id = p_merged));
  elsif p_kind = 'product' then
    return jsonb_build_object(
      'kept', (select jsonb_build_object('id', id, 'name', name, 'code', code) from master.products where id = p_kept),
      'merged', (select jsonb_build_object('id', id, 'name', name, 'code', code) from master.products where id = p_merged),
      'prices', (select count(*) from master.price_list_items where product_id = p_merged),
      'source_keys', (select count(*) from ops.source_keys where erp_id = p_merged));
  end if;
  perform app.raise_rule('merge.bad_kind', 'unknown kind', '22023');
  return null;
end $$;

-- Two-step merge (preview first, then this). The merged name stays as an alias; logged; undo possible.
create or replace function api.merge_parties(p_client_request_id uuid, p_kept uuid, p_merged uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_preview jsonb; v_id uuid; m master.parties;
begin
  v_prev := app.request_seen(p_client_request_id, 'merge_parties'); if v_prev is not null then return v_prev; end if;
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'only Admin merges', '42501'); end if;
  if p_kept = p_merged then perform app.raise_rule('merge.same', 'choose two different parties', '22023'); end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'reason required', '22023'); end if;
  select * into m from master.parties where id = p_merged for update;
  perform 1 from master.parties where id = p_kept for update;
  v_preview := api.merge_preview('party', p_kept, p_merged);
  insert into master.party_aliases (party_id, alias, source) values (p_kept, m.legal_name, 'merge') on conflict do nothing;
  update master.party_aliases set party_id = p_kept where party_id = p_merged and alias_norm not in (select alias_norm from master.party_aliases where party_id = p_kept);
  update master.party_contacts set party_id = p_kept where party_id = p_merged;
  update master.party_addresses set party_id = p_kept where party_id = p_merged;
  insert into master.party_companies (party_id, company_id, is_customer, is_supplier, credit_term_id, beat, tier)
  select p_kept, company_id, is_customer, is_supplier, credit_term_id, beat, tier from master.party_companies where party_id = p_merged
  on conflict (party_id, company_id) do update set is_customer = master.party_companies.is_customer or excluded.is_customer, is_supplier = master.party_companies.is_supplier or excluded.is_supplier;
  update acct.accounts set party_id = p_kept where party_id = p_merged;
  update acct.open_bills set party_id = p_kept where party_id = p_merged;
  update ops.tally_vouchers set party_id = p_kept where party_id = p_merged;
  update ops.source_keys set erp_id = p_kept where erp_id = p_merged and erp_table = 'master.parties';
  update master.parties set status = 'merged', merged_into = p_kept, gstin = null where id = p_merged;
  update master.parties set gstin = coalesce(gstin, m.gstin), pan = coalesce(pan, m.pan), is_customer = is_customer or m.is_customer, is_supplier = is_supplier or m.is_supplier where id = p_kept;
  insert into ops.merge_log (kind, kept_id, merged_id, preview, reason, merged_by) values ('party', p_kept, p_merged, v_preview, p_reason, auth.uid()) returning id into v_id;
  update ops.bug_items set status = 'fixed', fixed_by = auth.uid(), fixed_at = now(), resolution = 'merged'
   where kind = 'possible_duplicate' and status = 'open' and ((ref_id = p_kept and other_id = p_merged) or (ref_id = p_merged and other_id = p_kept));
  perform app.log_event('admin_action', jsonb_build_object('entity', 'merge', 'kept', p_kept, 'merged', p_merged, 'reason', p_reason));
  v_res := jsonb_build_object('merge_id', v_id);
  return app.request_done(p_client_request_id, 'merge_parties', v_res);
end $$;

-- ═══════════════════════════════ Backups ═══════════════════════════════
create or replace function api.record_backup_run(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'record_backup_run'); if v_prev is not null then return v_prev; end if;
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'only Admin records backups', '42501'); end if;
  if coalesce(p ->> 'location', '') !~* '(india|mumbai|hyderabad|ap-south-1|ap-south-2|office)' then
    perform app.raise_rule('backup.outside_india', 'backups may be kept only in India; name the Indian location', '22023');
  end if;
  insert into ops.backup_runs (kind, started_at, finished_at, status, location, size_bytes, checksum, note, recorded_by)
  values (p ->> 'kind', coalesce(nullif(p ->> 'started_at', '')::timestamptz, now()), nullif(p ->> 'finished_at', '')::timestamptz, coalesce(p ->> 'status', 'ok'),
          p ->> 'location', nullif(p ->> 'size_bytes', '')::bigint, nullif(p ->> 'checksum', ''), nullif(p ->> 'note', ''), auth.uid())
  returning id into v_id;
  perform app.log_event('admin_action', jsonb_build_object('entity', 'backup_run', 'kind', p ->> 'kind', 'status', p ->> 'status'));
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'record_backup_run', v_res);
end $$;

revoke all on all functions in schema api from public, anon;
grant execute on all functions in schema api to authenticated;
grant execute on function api.log_sign_in_failure(text) to anon;
revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;

notify pgrst, 'reload schema';

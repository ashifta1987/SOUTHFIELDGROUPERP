-- 20261103012000_tally_maps.sql
-- Tally import, Stage 1 (part 1): the mapping tables of spec §4, the master tables they feed, and the Admin confirm RPCs.
-- Additive only.
--   * ops.tally_voucher_type_map / tally_godown_map / tally_unit_map / tally_currency_map / tally_item_map / tally_group_suggest
--     (every row is 'suggested' until Admin confirms it; bulk confirm covers exact matches only; the without-GST voucher types
--     carry ca_review = true and can only be confirmed one by one with an explicit acknowledgement)
--   * acct.cost_categories, acct.cost_centres (hierarchy, per company); master.item_categories; extra columns on
--     master.product_groups and master.products (batch / expiry tracking, GST applicability, alternate unit)
--   * Bug fixer kinds widened: map_voucher_type, map_godown, map_unit, map_currency, map_item, missing_master
--   * api.confirm_tally_map, api.confirm_tally_maps_bulk (Admin only, idempotent on client_request_id)

-- ═════════════════════════ Master tables ═════════════════════════
create table acct.cost_categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  name text not null,
  name_norm text not null,
  revenue boolean not null default true,
  non_revenue boolean not null default false,
  guid text,
  created_batch_id uuid references ops.import_batches (id),
  created_at timestamptz not null default now(),
  unique (company_id, name_norm)
);

create table acct.cost_centres (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  category_id uuid references acct.cost_categories (id),
  parent_id uuid references acct.cost_centres (id),
  name text not null,
  name_norm text not null,
  guid text,
  created_batch_id uuid references ops.import_batches (id),
  created_at timestamptz not null default now()
);
create unique index cost_centres_unique_name on acct.cost_centres (company_id, coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid), name_norm);
create index on acct.cost_centres (category_id);
create index on acct.cost_centres (parent_id);

create table master.item_categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references core.companies (id),
  parent_id uuid references master.item_categories (id),
  name text not null,
  name_norm text not null,
  tally_name text,
  created_at timestamptz not null default now()
);
create unique index item_categories_unique_name on master.item_categories (coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name_norm);

-- Stock group / item fields the spec needs (master.product_groups is the item-group table: reused, not duplicated)
alter table master.product_groups add column if not exists default_uom text references master.uoms (code);
alter table master.product_groups add column if not exists qty_addable boolean;
alter table master.products add column if not exists category_id uuid references master.item_categories (id);
alter table master.products add column if not exists batch_tracked boolean not null default false;
alter table master.products add column if not exists expiry_tracked boolean not null default false;
alter table master.products add column if not exists gst_applicable text check (gst_applicable in ('applicable', 'not_applicable', 'undefined'));
alter table master.products add column if not exists alt_uom text references master.uoms (code);
alter table master.products add column if not exists alt_uom_conversion numeric(18, 6) check (alt_uom_conversion is null or alt_uom_conversion > 0);

-- ═════════════════════════ Mapping tables ═════════════════════════
create table ops.tally_voucher_type_map (
  company_id uuid not null references core.companies (id),
  tally_type text not null,
  base_type text,
  erp_doc_type text check (erp_doc_type in ('sales_invoice', 'purchase_bill', 'receipt', 'payment', 'journal', 'contra', 'credit_note', 'debit_note',
    'stock_journal', 'manufacturing_journal', 'delivery_note', 'receipt_note', 'sales_order', 'purchase_order', 'rejection_note', 'memo', 'other')),
  tax_class text not null default 'none' check (tax_class in ('taxable', 'without_gst', 'none')),
  numbering text,
  active boolean not null default true,
  prevent_duplicates boolean,
  affects_stock boolean not null default false,
  optional boolean not null default false,
  ca_review boolean not null default false,
  status text not null default 'suggested' check (status in ('suggested', 'confirmed')),
  exact boolean not null default false,
  reason text,
  mapped_by uuid references auth.users (id),
  mapped_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (company_id, tally_type),
  check (status <> 'confirmed' or erp_doc_type is not null)
);

create table ops.tally_godown_map (
  company_id uuid not null references core.companies (id),
  tally_godown text not null,
  tally_parent text,
  place_id uuid references core.places (id),
  has_no_space boolean not null default false,
  is_external boolean not null default false,
  is_internal boolean not null default false,
  status text not null default 'suggested' check (status in ('suggested', 'confirmed')),
  exact boolean not null default false,
  reason text,
  mapped_by uuid references auth.users (id),
  mapped_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (company_id, tally_godown),
  check (status <> 'confirmed' or place_id is not null or has_no_space)
);
create index on ops.tally_godown_map (place_id);

create table ops.tally_unit_map (
  company_id uuid not null references core.companies (id),
  tally_unit text not null,
  uom_code text references master.uoms (code),
  is_simple boolean not null default true,
  base_unit text,
  additional_unit text,
  conversion numeric(18, 6) check (conversion is null or conversion > 0),
  decimals int check (decimals is null or decimals between 0 and 6),
  gst_uqc text,
  status text not null default 'suggested' check (status in ('suggested', 'confirmed')),
  exact boolean not null default false,
  reason text,
  mapped_by uuid references auth.users (id),
  mapped_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (company_id, tally_unit),
  check (status <> 'confirmed' or uom_code is not null)
);

create table ops.tally_currency_map (
  company_id uuid not null references core.companies (id),
  tally_symbol text not null,
  iso_code text check (iso_code ~ '^[A-Z]{3}$'),
  mailing_name text,
  expanded_symbol text,
  decimals int check (decimals is null or decimals between 0 and 6),
  status text not null default 'suggested' check (status in ('suggested', 'confirmed')),
  exact boolean not null default false,
  reason text,
  mapped_by uuid references auth.users (id),
  mapped_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (company_id, tally_symbol),
  check (status <> 'confirmed' or iso_code is not null)
);

create table ops.tally_item_map (
  company_id uuid not null references core.companies (id),
  tally_item text not null,
  product_id uuid references master.products (id),
  status text not null default 'suggested' check (status in ('suggested', 'confirmed')),
  exact boolean not null default false,
  reason text,
  mapped_by uuid references auth.users (id),
  mapped_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (company_id, tally_item),
  check (status <> 'confirmed' or product_id is not null)
);
create index on ops.tally_item_map (product_id);

-- Head suggestions: the existing ops.tally_group_map stays the confirmed map (rows exist only once confirmed).
create table ops.tally_group_suggest (
  company_id uuid not null references core.companies (id),
  tally_group text not null,
  tally_parent text,
  is_revenue boolean,
  is_deemed_positive boolean,
  account_group_id uuid references acct.account_groups (id),
  status text not null default 'suggested' check (status in ('suggested', 'confirmed')),
  exact boolean not null default false,
  reason text,
  mapped_by uuid references auth.users (id),
  mapped_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (company_id, tally_group),
  check (status <> 'confirmed' or account_group_id is not null)
);

-- ═════════════════════════ History, RLS, grants ═════════════════════════
do $$
declare t text;
begin
  foreach t in array array['ops.tally_voucher_type_map', 'ops.tally_godown_map', 'ops.tally_unit_map', 'ops.tally_currency_map', 'ops.tally_item_map',
                           'ops.tally_group_suggest', 'acct.cost_categories', 'acct.cost_centres', 'master.item_categories'] loop
    execute format('create trigger audit_row after insert or update or delete on %s for each row execute function app.audit_trigger()', t);
    execute format('alter table %s enable row level security', t);
    execute format('revoke all on %s from anon, authenticated', t);
    execute format('grant select on %s to authenticated', t);
  end loop;
  -- Mapping tables: Admin and the CA (read-only view) and anyone holding the import right for that company
  foreach t in array array['tally_voucher_type_map', 'tally_godown_map', 'tally_unit_map', 'tally_currency_map', 'tally_item_map', 'tally_group_suggest'] loop
    execute format($f$create policy %1$s_read on ops.%1$I for select to authenticated
      using (app.can(company_id, 'data.import') or app.current_view() in ('all', 'all-readonly'))$f$, t);
  end loop;
end $$;
create policy cost_categories_read on acct.cost_categories for select to authenticated
  using (app.can(company_id, 'accounts.view') or app.can(company_id, 'data.import') or app.current_view() in ('all', 'all-readonly'));
create policy cost_centres_read on acct.cost_centres for select to authenticated
  using (app.can(company_id, 'accounts.view') or app.can(company_id, 'data.import') or app.current_view() in ('all', 'all-readonly'));
create policy item_categories_read on master.item_categories for select to authenticated using (true);

-- ═════════════════════════ Bug fixer kinds ═════════════════════════
alter table ops.bug_items drop constraint bug_items_kind_check;
alter table ops.bug_items add constraint bug_items_kind_check check (kind = any (array[
  'possible_duplicate', 'map_head', 'changed_in_tally', 'deleted_in_tally', 'same_name_two_groups', 'missing_gstin', 'missing_hsn', 'invalid_gstin',
  'employee_conflict', 'total_mismatch', 'unbalanced_voucher', 'negative_stock', 'date_outside', 'cancelled_voucher', 'classify_bills',
  'control_mismatch', 'other', 'integration_dead_letter',
  'map_voucher_type', 'map_godown', 'map_unit', 'map_currency', 'map_item', 'missing_master']));

-- ═════════════════════════ Views for the Mapping screen ═════════════════════════
create or replace view api.tally_voucher_type_map with (security_invoker = true) as
select company_id, tally_type, base_type, erp_doc_type, tax_class, numbering, active, prevent_duplicates, affects_stock, optional, ca_review, status, exact, reason, mapped_at
from ops.tally_voucher_type_map;
create or replace view api.tally_godown_map with (security_invoker = true) as
select m.company_id, m.tally_godown, m.tally_parent, m.place_id, p.name as place_name, m.has_no_space, m.is_external, m.is_internal, m.status, m.exact, m.reason, m.mapped_at
from ops.tally_godown_map m left join core.places p on p.id = m.place_id;
create or replace view api.tally_unit_map with (security_invoker = true) as
select company_id, tally_unit, uom_code, is_simple, base_unit, additional_unit, conversion, decimals, gst_uqc, status, exact, reason, mapped_at from ops.tally_unit_map;
create or replace view api.tally_currency_map with (security_invoker = true) as
select company_id, tally_symbol, iso_code, mailing_name, expanded_symbol, decimals, status, exact, reason, mapped_at from ops.tally_currency_map;
create or replace view api.tally_item_map with (security_invoker = true) as
select m.company_id, m.tally_item, m.product_id, p.code as product_code, p.name as product_name, m.status, m.exact, m.reason, m.mapped_at
from ops.tally_item_map m left join master.products p on p.id = m.product_id;
create or replace view api.tally_group_suggest with (security_invoker = true) as
select s.company_id, s.tally_group, s.tally_parent, s.is_revenue, s.is_deemed_positive, s.account_group_id, g.name as account_group_name, s.status, s.exact, s.reason, s.mapped_at
from ops.tally_group_suggest s left join acct.account_groups g on g.id = s.account_group_id;
create or replace view api.cost_categories with (security_invoker = true) as
select id, company_id, name, revenue, non_revenue from acct.cost_categories;
create or replace view api.cost_centres with (security_invoker = true) as
select id, company_id, category_id, parent_id, name from acct.cost_centres;
grant select on api.tally_voucher_type_map, api.tally_godown_map, api.tally_unit_map, api.tally_currency_map, api.tally_item_map, api.tally_group_suggest,
  api.cost_categories, api.cost_centres to authenticated;

-- ═════════════════════════ Admin RPCs ═════════════════════════
create or replace function app.tally_map_admin(p_company_id uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(p_company_id, 'data.import');
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'only Admin confirms import mappings', '42501'); end if;
  if not exists (select 1 from core.companies where id = p_company_id) then perform app.raise_rule('org.company_missing', 'company not found', 'P0002'); end if;
end $$;

-- Close the "Map this ..." Bug fixer items for a name that has just been mapped.
create or replace function app.tally_map_close_bug(p_company_id uuid, p_kind text, p_name text) returns void
language sql security definer set search_path = '' as $$
  update ops.bug_items set status = 'fixed', fixed_by = auth.uid(), fixed_at = now(), resolution = 'mapped'
   where kind = p_kind and company_id = p_company_id and evidence ->> 'name' = p_name and status = 'open';
$$;

create or replace function api.confirm_tally_map(p_client_request_id uuid, p_company_id uuid, p_kind text, p_key text,
  p_target jsonb default '{}'::jsonb, p_ack_ca_review boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_res jsonb; v_t jsonb := coalesce(p_target, '{}'::jsonb);
  vt ops.tally_voucher_type_map; v_place uuid; v_uom text; v_iso text; v_prod uuid; v_ag uuid; v_bug text; v_alias text;
begin
  v_prev := app.request_seen(p_client_request_id, 'confirm_tally_map'); if v_prev is not null then return v_prev; end if;
  perform app.tally_map_admin(p_company_id);
  if p_key is null or btrim(p_key) = '' then perform app.raise_rule('map.key_missing', 'the Tally name is missing', '22023'); end if;

  if p_kind = 'voucher_type' then
    select * into vt from ops.tally_voucher_type_map where company_id = p_company_id and tally_type = p_key for update;
    if not found then
      insert into ops.tally_voucher_type_map (company_id, tally_type) values (p_company_id, p_key) returning * into vt;
    end if;
    if vt.ca_review and not coalesce(p_ack_ca_review, false) then
      perform app.raise_rule('map.ca_review', 'this voucher type is on the CA review list: confirm it one by one and acknowledge it', '22023');
    end if;
    update ops.tally_voucher_type_map set
      erp_doc_type = coalesce(nullif(v_t ->> 'erp_doc_type', ''), erp_doc_type),
      tax_class = coalesce(nullif(v_t ->> 'tax_class', ''), tax_class),
      affects_stock = coalesce((v_t ->> 'affects_stock')::boolean, affects_stock),
      optional = coalesce((v_t ->> 'optional')::boolean, optional),
      status = 'confirmed', mapped_by = auth.uid(), mapped_at = now()
    where company_id = p_company_id and tally_type = p_key;
    v_bug := 'map_voucher_type';
  elsif p_kind = 'godown' then
    v_place := coalesce(nullif(v_t ->> 'place_id', '')::uuid, (select place_id from ops.tally_godown_map where company_id = p_company_id and tally_godown = p_key));
    if v_place is not null and not exists (select 1 from core.places where id = v_place and company_id = p_company_id) then
      perform app.raise_rule('org.company_missing', 'the place belongs to another company', '22023');
    end if;
    insert into ops.tally_godown_map (company_id, tally_godown, place_id, has_no_space, status, mapped_by, mapped_at)
    values (p_company_id, p_key, v_place, coalesce((v_t ->> 'has_no_space')::boolean, false), 'confirmed', auth.uid(), now())
    on conflict (company_id, tally_godown) do update set place_id = excluded.place_id, status = 'confirmed', mapped_by = excluded.mapped_by, mapped_at = excluded.mapped_at,
      has_no_space = coalesce((v_t ->> 'has_no_space')::boolean, ops.tally_godown_map.has_no_space);
    v_bug := 'map_godown';
  elsif p_kind = 'unit' then
    v_uom := coalesce(nullif(v_t ->> 'uom_code', ''), (select uom_code from ops.tally_unit_map where company_id = p_company_id and tally_unit = p_key));
    if v_uom is null or not exists (select 1 from master.uoms where code = v_uom) then
      perform app.raise_rule('map.unit_missing', 'choose an ERP unit with its GST unit code', '22023');
    end if;
    insert into ops.tally_unit_map (company_id, tally_unit, uom_code, gst_uqc, status, mapped_by, mapped_at)
    values (p_company_id, p_key, v_uom, v_uom, 'confirmed', auth.uid(), now())
    on conflict (company_id, tally_unit) do update set uom_code = excluded.uom_code, gst_uqc = excluded.uom_code, status = 'confirmed', mapped_by = excluded.mapped_by, mapped_at = excluded.mapped_at;
    v_bug := 'map_unit';
  elsif p_kind = 'currency' then
    v_iso := upper(coalesce(nullif(v_t ->> 'iso_code', ''), (select iso_code from ops.tally_currency_map where company_id = p_company_id and tally_symbol = p_key)));
    if v_iso is null or v_iso !~ '^[A-Z]{3}$' then perform app.raise_rule('map.currency_missing', 'enter the three-letter ISO currency code', '22023'); end if;
    insert into ops.tally_currency_map (company_id, tally_symbol, iso_code, status, mapped_by, mapped_at)
    values (p_company_id, p_key, v_iso, 'confirmed', auth.uid(), now())
    on conflict (company_id, tally_symbol) do update set iso_code = excluded.iso_code, status = 'confirmed', mapped_by = excluded.mapped_by, mapped_at = excluded.mapped_at;
    v_bug := 'map_currency';
  elsif p_kind = 'item' then
    v_prod := coalesce(nullif(v_t ->> 'product_id', '')::uuid, (select product_id from ops.tally_item_map where company_id = p_company_id and tally_item = p_key));
    if v_prod is null or not exists (select 1 from master.products where id = v_prod) then
      perform app.raise_rule('map.item_missing', 'choose the ERP product for this Tally item', '22023');
    end if;
    insert into ops.tally_item_map (company_id, tally_item, product_id, status, mapped_by, mapped_at)
    values (p_company_id, p_key, v_prod, 'confirmed', auth.uid(), now())
    on conflict (company_id, tally_item) do update set product_id = excluded.product_id, status = 'confirmed', mapped_by = excluded.mapped_by, mapped_at = excluded.mapped_at;
    -- kept as an alias so later imports match without asking again
    v_alias := app.norm_name(p_key);
    if not exists (select 1 from master.product_aliases where product_id = v_prod and alias_norm = v_alias) then
      insert into master.product_aliases (product_id, alias, alias_norm, source) values (v_prod, p_key, v_alias, 'tally');
    end if;
    v_bug := 'map_item';
  elsif p_kind = 'group' then
    v_ag := coalesce(nullif(v_t ->> 'account_group_id', '')::uuid, (select account_group_id from ops.tally_group_suggest where company_id = p_company_id and tally_group = p_key));
    if v_ag is null or not exists (select 1 from acct.account_groups where id = v_ag and company_id = p_company_id) then
      perform app.raise_rule('map.group_missing', 'choose the ERP account group of this company', '22023');
    end if;
    insert into ops.tally_group_map (company_id, tally_group, account_group_id, mapped_by) values (p_company_id, p_key, v_ag, auth.uid())
    on conflict (company_id, tally_group) do update set account_group_id = excluded.account_group_id, mapped_by = excluded.mapped_by, mapped_at = now();
    insert into ops.tally_group_suggest (company_id, tally_group, account_group_id, status, mapped_by, mapped_at)
    values (p_company_id, p_key, v_ag, 'confirmed', auth.uid(), now())
    on conflict (company_id, tally_group) do update set account_group_id = excluded.account_group_id, status = 'confirmed', mapped_by = excluded.mapped_by, mapped_at = excluded.mapped_at;
    update ops.bug_items set status = 'fixed', fixed_by = auth.uid(), fixed_at = now(), resolution = 'mapped'
     where kind = 'map_head' and company_id = p_company_id and evidence ->> 'tally_group' = p_key and status = 'open';
  else
    perform app.raise_rule('map.bad_kind', 'unknown mapping kind', '22023');
  end if;
  if v_bug is not null then perform app.tally_map_close_bug(p_company_id, v_bug, p_key); end if;
  v_res := jsonb_build_object('ok', true, 'kind', p_kind, 'key', p_key);
  return app.request_done(p_client_request_id, 'confirm_tally_map', v_res);
end $$;

-- Bulk confirm: only rows that are an exact match, have a target, and are not on the CA review list.
create or replace function api.confirm_tally_maps_bulk(p_client_request_id uuid, p_company_id uuid, p_kind text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_n int := 0; v_skipped int := 0; v_names text[]; v_bug text;
begin
  v_prev := app.request_seen(p_client_request_id, 'confirm_tally_maps_bulk'); if v_prev is not null then return v_prev; end if;
  perform app.tally_map_admin(p_company_id);
  if p_kind = 'voucher_type' then
    select count(*) into v_skipped from ops.tally_voucher_type_map where company_id = p_company_id and status = 'suggested' and (ca_review or not exact or erp_doc_type is null);
    with u as (update ops.tally_voucher_type_map set status = 'confirmed', mapped_by = auth.uid(), mapped_at = now()
      where company_id = p_company_id and status = 'suggested' and exact and not ca_review and erp_doc_type is not null returning tally_type)
    select array_agg(tally_type) into v_names from u;
    v_bug := 'map_voucher_type';
  elsif p_kind = 'godown' then
    select count(*) into v_skipped from ops.tally_godown_map where company_id = p_company_id and status = 'suggested' and (not exact or (place_id is null and not has_no_space));
    with u as (update ops.tally_godown_map set status = 'confirmed', mapped_by = auth.uid(), mapped_at = now()
      where company_id = p_company_id and status = 'suggested' and exact and (place_id is not null or has_no_space) returning tally_godown)
    select array_agg(tally_godown) into v_names from u;
    v_bug := 'map_godown';
  elsif p_kind = 'unit' then
    select count(*) into v_skipped from ops.tally_unit_map where company_id = p_company_id and status = 'suggested' and (not exact or uom_code is null);
    with u as (update ops.tally_unit_map set status = 'confirmed', gst_uqc = coalesce(gst_uqc, uom_code), mapped_by = auth.uid(), mapped_at = now()
      where company_id = p_company_id and status = 'suggested' and exact and uom_code is not null returning tally_unit)
    select array_agg(tally_unit) into v_names from u;
    v_bug := 'map_unit';
  elsif p_kind = 'currency' then
    select count(*) into v_skipped from ops.tally_currency_map where company_id = p_company_id and status = 'suggested' and (not exact or iso_code is null);
    with u as (update ops.tally_currency_map set status = 'confirmed', mapped_by = auth.uid(), mapped_at = now()
      where company_id = p_company_id and status = 'suggested' and exact and iso_code is not null returning tally_symbol)
    select array_agg(tally_symbol) into v_names from u;
    v_bug := 'map_currency';
  elsif p_kind = 'item' then
    select count(*) into v_skipped from ops.tally_item_map where company_id = p_company_id and status = 'suggested' and (not exact or product_id is null);
    with u as (update ops.tally_item_map set status = 'confirmed', mapped_by = auth.uid(), mapped_at = now()
      where company_id = p_company_id and status = 'suggested' and exact and product_id is not null returning tally_item, product_id)
    select array_agg(tally_item) into v_names from u;
    v_bug := 'map_item';
  elsif p_kind = 'group' then
    select count(*) into v_skipped from ops.tally_group_suggest where company_id = p_company_id and status = 'suggested' and (not exact or account_group_id is null);
    with u as (update ops.tally_group_suggest set status = 'confirmed', mapped_by = auth.uid(), mapped_at = now()
      where company_id = p_company_id and status = 'suggested' and exact and account_group_id is not null returning tally_group, account_group_id),
    m as (insert into ops.tally_group_map (company_id, tally_group, account_group_id, mapped_by)
      select p_company_id, tally_group, account_group_id, auth.uid() from u
      on conflict (company_id, tally_group) do update set account_group_id = excluded.account_group_id, mapped_by = excluded.mapped_by, mapped_at = now() returning tally_group)
    select array_agg(tally_group) into v_names from m;
    update ops.bug_items set status = 'fixed', fixed_by = auth.uid(), fixed_at = now(), resolution = 'mapped'
     where kind = 'map_head' and company_id = p_company_id and status = 'open' and evidence ->> 'tally_group' = any (coalesce(v_names, '{}'));
  else
    perform app.raise_rule('map.bad_kind', 'unknown mapping kind', '22023');
  end if;
  v_n := coalesce(cardinality(v_names), 0);
  if v_bug is not null and v_n > 0 then
    update ops.bug_items set status = 'fixed', fixed_by = auth.uid(), fixed_at = now(), resolution = 'mapped'
     where kind = v_bug and company_id = p_company_id and status = 'open' and evidence ->> 'name' = any (v_names);
  end if;
  if p_kind = 'item' and v_n > 0 then
    insert into master.product_aliases (product_id, alias, alias_norm, source)
    select m.product_id, m.tally_item, app.norm_name(m.tally_item), 'tally' from ops.tally_item_map m
     where m.company_id = p_company_id and m.tally_item = any (v_names)
       and not exists (select 1 from master.product_aliases a where a.product_id = m.product_id and a.alias_norm = app.norm_name(m.tally_item));
  end if;
  v_res := jsonb_build_object('ok', true, 'kind', p_kind, 'confirmed', v_n, 'left_for_review', v_skipped);
  return app.request_done(p_client_request_id, 'confirm_tally_maps_bulk', v_res);
end $$;

revoke all on function app.tally_map_admin(uuid), app.tally_map_close_bug(uuid, text, text),
  api.confirm_tally_map(uuid, uuid, text, text, jsonb, boolean), api.confirm_tally_maps_bulk(uuid, uuid, text) from public, anon;
grant execute on function app.tally_map_admin(uuid), app.tally_map_close_bug(uuid, text, text),
  api.confirm_tally_map(uuid, uuid, text, text, jsonb, boolean), api.confirm_tally_maps_bulk(uuid, uuid, text) to authenticated;

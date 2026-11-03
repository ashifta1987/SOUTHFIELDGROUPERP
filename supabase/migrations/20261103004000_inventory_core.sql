-- 20261103004000_inventory_core.sql
-- Phase 4 inventory core: lots (batch/expiry/QC status), the append-only stock ledger, balances per
-- (company, item, lot, place, bucket) kept in the same transaction under a per-item+place lock, logged
-- negative-stock allowances, reservations, reorder levels, cycle counts, issues/returns, scrap and regrind,
-- incoming lab tests. Writes only through app.stock_post / app.stock_take (called by api RPCs). Additive.

create schema if not exists inv;
create schema if not exists prod;
revoke all on schema inv, prod from public, anon;
grant usage on schema inv, prod to authenticated;

-- Item flags used by stock (additive columns on the shared item list).
alter table master.products add column if not exists needs_incoming_test boolean not null default false;
alter table master.products add column if not exists is_scrap boolean not null default false;

-- Internal (non-GST) document types used by Phase 4 numbering.
insert into core.doc_types (key, label, gst_document, max_number_length, sort) values
  ('purchase_request', 'Purchase request', false, 20, 25),
  ('rfq', 'Request for quotation', false, 20, 26),
  ('stock_issue', 'Stock issue or return', false, 20, 27),
  ('stock_count', 'Stock count', false, 20, 28)
on conflict (key) do nothing;

-- ─────────── Lots ───────────
create table inv.lots (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  product_id uuid not null references master.products (id),
  lot_no text not null check (length(trim(lot_no)) > 0),
  supplier_lot_no text,
  mfg_date date,
  expiry_date date,
  source text not null check (source in ('goods_receipt', 'production', 'opening', 'return', 'adjustment')),
  status text not null default 'available' check (status in ('quarantine', 'available', 'hold', 'rejected')),
  needs_test boolean not null default false,
  grn_id uuid,
  received_by uuid references auth.users (id),
  received_at timestamptz not null default now(),
  released_by uuid references auth.users (id),
  released_at timestamptz,
  created_at timestamptz not null default now(),
  unique (company_id, product_id, lot_no),
  check (expiry_date is null or mfg_date is null or expiry_date >= mfg_date)
);
create index on inv.lots (company_id, status);
create index on inv.lots (product_id);

-- ─────────── Negative-stock allowances (Admin, logged) ───────────
create table inv.negative_stock_allowances (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  product_id uuid not null references master.products (id),
  place_id uuid references core.places (id),            -- null = every place of the company
  reason text not null check (length(trim(reason)) >= 5),
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  granted_by uuid not null references auth.users (id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id),
  revoke_reason text,
  check (valid_to is null or valid_to > valid_from)
);
create index on inv.negative_stock_allowances (company_id, product_id);

-- ─────────── Stock ledger (append-only) ───────────
create table inv.stock_ledger (
  id bigint generated always as identity primary key,
  company_id uuid not null references core.companies (id),
  product_id uuid not null references master.products (id),
  lot_id uuid references inv.lots (id),
  place_id uuid not null references core.places (id),
  bucket text not null check (bucket in ('available', 'quarantine', 'hold', 'in_transit', 'rejected')),
  qty numeric(18, 3) not null check (qty <> 0),
  unit_cost numeric(18, 4) not null default 0 check (unit_cost >= 0),
  value numeric(18, 2) not null default 0,
  move_type text not null check (move_type in ('opening', 'receipt', 'issue', 'issue_in', 'return', 'release', 'reject', 'adjustment',
                                               'transit_out', 'transit_in', 'transfer_in', 'transfer_return', 'write_off',
                                               'scrap_in', 'regrind', 'scrap_sale', 'reversal')),
  source_table text not null,
  source_id uuid,
  doc_no text,
  move_date date not null,
  note text,
  negative_allowance_id uuid references inv.negative_stock_allowances (id),
  reverses_id bigint references inv.stock_ledger (id),
  client_request_id uuid,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index on inv.stock_ledger (company_id, product_id);
create index on inv.stock_ledger (company_id, move_date);
create index on inv.stock_ledger (source_table, source_id);
create index on inv.stock_ledger (lot_id);

-- ─────────── Balances (kept by app.stock_post in the same transaction) ───────────
create table inv.stock_balances (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  product_id uuid not null references master.products (id),
  lot_id uuid references inv.lots (id),
  place_id uuid not null references core.places (id),
  bucket text not null check (bucket in ('available', 'quarantine', 'hold', 'in_transit', 'rejected')),
  qty numeric(18, 3) not null default 0,
  negative_allowance_id uuid references inv.negative_stock_allowances (id),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (company_id, product_id, lot_id, place_id, bucket),
  -- Never below zero unless a logged allowance covers this item and place.
  constraint stock_balances_not_negative check (qty >= 0 or negative_allowance_id is not null)
);
create index on inv.stock_balances (company_id, place_id);
create index on inv.stock_balances (product_id, place_id);

-- Every use of a negative-stock allowance (append-only).
create table inv.negative_stock_uses (
  id bigint generated always as identity primary key,
  allowance_id uuid not null references inv.negative_stock_allowances (id),
  ledger_id bigint not null references inv.stock_ledger (id),
  company_id uuid not null references core.companies (id),
  product_id uuid not null references master.products (id),
  place_id uuid not null references core.places (id),
  qty_after numeric(18, 3) not null,
  used_by uuid references auth.users (id),
  at timestamptz not null default now()
);

-- ─────────── Reservations, reorder levels ───────────
create table inv.reservations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  product_id uuid not null references master.products (id),
  lot_id uuid references inv.lots (id),
  place_id uuid not null references core.places (id),
  qty numeric(18, 3) not null check (qty > 0),
  source_table text not null,
  source_id uuid not null,
  source_line_id uuid,
  status text not null default 'active' check (status in ('active', 'consumed', 'released')),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index on inv.reservations (company_id, product_id, place_id) where status = 'active';
create index on inv.reservations (source_id);

create table inv.reorder_levels (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  product_id uuid not null references master.products (id),
  place_id uuid references core.places (id),
  min_qty numeric(18, 3) not null check (min_qty >= 0),
  reorder_qty numeric(18, 3) check (reorder_qty is null or reorder_qty > 0),
  max_qty numeric(18, 3) check (max_qty is null or max_qty >= min_qty),
  set_by uuid references auth.users (id),
  set_at timestamptz not null default now(),
  unique nulls not distinct (company_id, product_id, place_id)
);

-- ─────────── Cycle counts (blind) ───────────
create table inv.cycle_counts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  place_id uuid not null references core.places (id),
  doc_no text not null,
  count_date date not null,
  blind boolean not null default true,
  status text not null default 'counting' check (status in ('counting', 'submitted', 'posted', 'cancelled')),
  note text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  submitted_by uuid references auth.users (id),
  submitted_at timestamptz,
  approved_by uuid references auth.users (id),
  posted_at timestamptz,
  unique (company_id, doc_no),
  check (approved_by is null or approved_by is distinct from submitted_by)
);
create index on inv.cycle_counts (company_id, status);

create table inv.count_lines (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references inv.cycle_counts (id),
  product_id uuid not null references master.products (id),
  lot_id uuid references inv.lots (id),
  bucket text not null default 'available' check (bucket in ('available', 'quarantine', 'hold', 'rejected')),
  system_qty numeric(18, 3) not null default 0,
  counted_qty numeric(18, 3) check (counted_qty is null or counted_qty >= 0),
  counted_by uuid references auth.users (id),
  counted_at timestamptz,
  reason text,
  unique nulls not distinct (count_id, product_id, lot_id, bucket)
);

-- ─────────── Issues and returns (to production or a cost centre) ───────────
create table inv.stock_issues (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  doc_no text not null,
  kind text not null check (kind in ('issue', 'return')),
  product_id uuid not null references master.products (id),
  lot_id uuid references inv.lots (id),
  from_place_id uuid references core.places (id),
  to_place_id uuid references core.places (id),
  qty numeric(18, 3) not null check (qty > 0),
  target_kind text not null default 'production' check (target_kind in ('production', 'cost_centre', 'batch', 'job', 'maintenance', 'other')),
  target_ref text,
  cost_centre text,
  against_issue_id uuid references inv.stock_issues (id),
  bucket text not null default 'available' check (bucket in ('available', 'quarantine')),
  reason text,
  issue_date date not null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (company_id, doc_no),
  check (from_place_id is not null or to_place_id is not null)
);
create index on inv.stock_issues (company_id, issue_date);
create index on inv.stock_issues (against_issue_id);

-- ─────────── Scrap sales (stock out against a posted GST invoice) ───────────
create table inv.scrap_sales (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  sales_document_id uuid not null unique references sales.documents (id),
  place_id uuid not null references core.places (id),
  slip_path text,
  qty numeric(18, 3) not null check (qty > 0),
  sold_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

-- ─────────── Production-side tables used in Phase 4 ───────────
create table prod.regrind_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  entry_date date not null,
  kind text not null check (kind in ('scrap_in', 'regrind_reuse')),
  product_id uuid not null references master.products (id),        -- the scrap/regrind item (is_scrap)
  source_product_id uuid references master.products (id),           -- the granule it came from
  place_id uuid not null references core.places (id),
  qty numeric(18, 3) not null check (qty > 0),
  machine text,
  mould text,
  shift text,
  note text,
  recorded_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index on prod.regrind_entries (company_id, entry_date);

-- Incoming tests (extended with production tests in Phase 5).
create table prod.lab_tests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  lot_id uuid not null references inv.lots (id),
  kind text not null default 'incoming' check (kind in ('incoming')),
  result text not null check (result in ('pass', 'fail', 'hold')),
  parameters jsonb not null default '{}'::jsonb,
  remarks text,
  test_date date not null default current_date,
  tested_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);
create index on prod.lab_tests (lot_id);

-- ─────────── Guards ───────────
-- The ledger and balances change only inside app.stock_post (which sets app.stock_posting for the statement).
create or replace function app.stock_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_setting('app.stock_posting', true) is distinct from 'on' then
    raise exception 'stock rows change only through the stock posting RPCs' using errcode = '42501', hint = 'stock.direct_write';
  end if;
  return coalesce(new, old);
end $$;

create trigger stock_ledger_append_only before update or delete on inv.stock_ledger for each row execute function app.reject_change();
create trigger stock_ledger_no_truncate before truncate on inv.stock_ledger for each statement execute function app.reject_change();
create trigger stock_ledger_guard before insert on inv.stock_ledger for each row execute function app.stock_guard();
create trigger stock_balances_guard before insert or update or delete on inv.stock_balances for each row execute function app.stock_guard();
create trigger stock_balances_no_truncate before truncate on inv.stock_balances for each statement execute function app.reject_change();
create trigger negative_uses_append_only before update or delete on inv.negative_stock_uses for each row execute function app.reject_change();
create trigger lab_tests_append_only before update or delete on prod.lab_tests for each row execute function app.reject_change();
create trigger regrind_append_only before update or delete on prod.regrind_entries for each row execute function app.reject_change();
create trigger stock_issues_append_only before update or delete on inv.stock_issues for each row execute function app.reject_change();
create trigger scrap_sales_append_only before update or delete on inv.scrap_sales for each row execute function app.reject_change();

-- History (the ledger itself is the movement history; balances are derived from it).
do $$
declare t text;
begin
  foreach t in array array['inv.lots', 'inv.negative_stock_allowances', 'inv.reservations', 'inv.reorder_levels', 'inv.cycle_counts', 'inv.count_lines',
                           'inv.stock_issues', 'inv.scrap_sales', 'prod.regrind_entries', 'prod.lab_tests'] loop
    execute format('create trigger audit_row after insert or update or delete on %s for each row execute function app.audit_trigger()', t);
  end loop;
end $$;

-- RLS on, reads only.
do $$
declare t record;
begin
  for t in select schemaname, tablename from pg_tables where schemaname in ('inv', 'prod') loop
    execute format('alter table %I.%I enable row level security', t.schemaname, t.tablename);
    execute format('revoke all on %I.%I from anon, authenticated', t.schemaname, t.tablename);
    execute format('grant select on %I.%I to authenticated', t.schemaname, t.tablename);
  end loop;
end $$;

create policy lots_read on inv.lots for select to authenticated
  using (app.can(company_id, 'inventory.view') or app.can(company_id, 'purchase.view') or app.can(company_id, 'qc.test') or app.can(company_id, 'qc.release'));
create policy neg_allow_read on inv.negative_stock_allowances for select to authenticated using (app.can(company_id, 'inventory.view'));
create policy ledger_read on inv.stock_ledger for select to authenticated using (app.can(company_id, 'inventory.view'));
create policy balances_read on inv.stock_balances for select to authenticated using (app.can(company_id, 'inventory.view'));
create policy neg_uses_read on inv.negative_stock_uses for select to authenticated using (app.can(company_id, 'inventory.view'));
create policy reservations_read on inv.reservations for select to authenticated using (app.can(company_id, 'inventory.view') or app.can(company_id, 'transfer.view'));
create policy reorder_read on inv.reorder_levels for select to authenticated using (app.can(company_id, 'inventory.view') or app.can(company_id, 'purchase.view'));
create policy counts_read on inv.cycle_counts for select to authenticated using (app.can(company_id, 'inventory.view') or app.can(company_id, 'inventory.create'));
create policy count_lines_read on inv.count_lines for select to authenticated
  using (exists (select 1 from inv.cycle_counts c where c.id = count_id and (app.can(c.company_id, 'inventory.view') or app.can(c.company_id, 'inventory.create'))));
create policy issues_read on inv.stock_issues for select to authenticated using (app.can(company_id, 'inventory.view'));
create policy scrap_sales_read on inv.scrap_sales for select to authenticated using (app.can(company_id, 'inventory.view'));
create policy regrind_read on prod.regrind_entries for select to authenticated using (app.can(company_id, 'inventory.view') or app.can(company_id, 'production.view'));
create policy lab_tests_read on prod.lab_tests for select to authenticated
  using (app.can(company_id, 'inventory.view') or app.can(company_id, 'qc.test') or app.can(company_id, 'qc.release') or app.can(company_id, 'production.view'));

-- ─────────── Helpers ───────────
-- Internal document number (non-GST): uses the company's series for the type and FY; creates the series with
-- a standard prefix the first time (Admin can change the prefix on Numbering before first use).
create or replace function app.internal_doc_no(p_company uuid, p_doc_type text, p_date date) returns text
language plpgsql security definer set search_path = '' as $$
declare v_fy uuid; v_prefix text;
begin
  select id into v_fy from core.financial_years where company_id = p_company and p_date between starts_on and ends_on;
  if v_fy is null then perform app.raise_rule('period.no_fy', 'no financial year is open for this date; open it on Settings', '22023'); end if;
  if not exists (select 1 from core.doc_series where company_id = p_company and gstin_id is null and doc_type = p_doc_type and fy_id = v_fy) then
    v_prefix := case p_doc_type when 'purchase_request' then 'PR' when 'rfq' then 'RFQ' when 'purchase_order' then 'PO' when 'goods_receipt' then 'GRN'
                  when 'stock_transfer' then 'TR' when 'stock_issue' then 'ST' when 'stock_count' then 'CNT' end;
    if v_prefix is null then perform app.raise_rule('numbering.no_series', 'no number series for ' || p_doc_type || ' in this FY', 'P0001'); end if;
    insert into core.doc_series (company_id, gstin_id, doc_type, fy_id, prefix) values (p_company, null, p_doc_type, v_fy, v_prefix) on conflict do nothing;
  end if;
  return app.take_doc_number(p_company, null, p_doc_type, v_fy);
end $$;

-- Weighted average cost per company and item (valuation method pending CA confirmation, Q-P4-6).
create or replace function app.avg_cost(p_company uuid, p_product uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select case when sum(qty) > 0 and sum(value) > 0 then round(sum(value) / sum(qty), 4) end
  from inv.stock_ledger where company_id = p_company and product_id = p_product
$$;

-- The active allowance for negative stock of an item at a place (place-specific first), or null.
create or replace function app.negative_allowance(p_company uuid, p_product uuid, p_place uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select a.id from inv.negative_stock_allowances a
  where a.company_id = p_company and a.product_id = p_product and (a.place_id is null or a.place_id = p_place)
    and a.revoked_at is null and a.valid_from <= now() and (a.valid_to is null or a.valid_to > now())
  order by a.place_id nulls last, a.granted_at desc
  limit 1
$$;

-- The one way stock moves. One signed movement → one ledger row + the balance row, under a transaction-level
-- lock per (company, item, place) and a row lock on the balance, so two parallel issues of the last unit
-- cannot both pass. Below zero is refused unless a logged allowance covers the item and place.
create or replace function app.stock_post(p_company uuid, p_product uuid, p_lot uuid, p_place uuid, p_bucket text, p_qty numeric,
                                          p_move_type text, p_source_table text, p_source_id uuid, p_doc_no text, p_date date,
                                          p_unit_cost numeric default null, p_note text default null) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  b inv.stock_balances; v_new numeric; v_allow uuid; v_cost numeric; v_id bigint; v_place_company uuid; v_qty numeric := round(p_qty, 3);
begin
  if v_qty is null or v_qty = 0 then return null; end if;
  if p_bucket not in ('available', 'quarantine', 'hold', 'in_transit', 'rejected') then
    perform app.raise_rule('stock.bucket', 'unknown stock status ' || coalesce(p_bucket, '(none)'), '22023');
  end if;
  select company_id into v_place_company from core.places where id = p_place;
  if v_place_company is distinct from p_company then perform app.raise_rule('stock.place_other_company', 'the place belongs to another company', '22023'); end if;
  if p_lot is not null and not exists (select 1 from inv.lots where id = p_lot and company_id = p_company and product_id = p_product) then
    perform app.raise_rule('stock.lot_mismatch', 'the lot is not of this item and company', '22023');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_company::text || '|' || p_product::text || '|' || p_place::text, 0));
  select * into b from inv.stock_balances
   where company_id = p_company and product_id = p_product and lot_id is not distinct from p_lot and place_id = p_place and bucket = p_bucket
   for update;
  v_new := coalesce(b.qty, 0) + v_qty;
  if v_new < 0 then
    v_allow := app.negative_allowance(p_company, p_product, p_place);
    if v_allow is null then
      perform app.raise_rule('stock.insufficient', format('not enough stock: %s on hand here (%s), %s needed', coalesce(b.qty, 0), p_bucket, -v_qty), 'P0001');
    end if;
  end if;
  v_cost := coalesce(p_unit_cost, app.avg_cost(p_company, p_product), 0);
  perform set_config('app.stock_posting', 'on', true);
  insert into inv.stock_ledger (company_id, product_id, lot_id, place_id, bucket, qty, unit_cost, value, move_type, source_table, source_id, doc_no, move_date, note,
                                negative_allowance_id, client_request_id, created_by)
  values (p_company, p_product, p_lot, p_place, p_bucket, v_qty, v_cost, round(v_qty * v_cost, 2), p_move_type, p_source_table, p_source_id, p_doc_no, p_date, p_note,
          v_allow, nullif(current_setting('app.request_id', true), '')::uuid, auth.uid())
  returning id into v_id;
  if b.id is null then
    insert into inv.stock_balances (company_id, product_id, lot_id, place_id, bucket, qty, negative_allowance_id)
    values (p_company, p_product, p_lot, p_place, p_bucket, v_new, case when v_new < 0 then v_allow end);
  else
    update inv.stock_balances set qty = v_new, negative_allowance_id = case when v_new < 0 then v_allow end, updated_at = now() where id = b.id;
  end if;
  perform set_config('app.stock_posting', 'off', true);
  if v_new < 0 then
    insert into inv.negative_stock_uses (allowance_id, ledger_id, company_id, product_id, place_id, qty_after, used_by)
    values (v_allow, v_id, p_company, p_product, p_place, v_new, auth.uid());
    perform app.log_event('admin_action', jsonb_build_object('entity', 'negative_stock', 'allowance_id', v_allow, 'product_id', p_product, 'place_id', p_place, 'qty_after', v_new, 'ledger_id', v_id));
  end if;
  return v_id;
end $$;

-- Take a quantity out of a place and status, earliest expiry first (or from one lot). Respects reservations
-- of others (p_own_reservation = the source whose reservation is being used). Returns the pieces taken:
-- [{lot_id, qty, unit_cost}] so the caller can post the matching inward movements.
create or replace function app.stock_take(p_company uuid, p_product uuid, p_lot uuid, p_place uuid, p_bucket text, p_qty numeric,
                                          p_move_type text, p_source_table text, p_source_id uuid, p_doc_no text, p_date date,
                                          p_note text default null, p_own_reservation uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_left numeric := round(p_qty, 3); r record; v_take numeric; v_out jsonb := '[]'::jsonb; v_avail numeric; v_reserved numeric; v_cost numeric;
begin
  if v_left is null or v_left <= 0 then perform app.raise_rule('stock.qty', 'the quantity must be above zero', '22023'); end if;
  perform pg_advisory_xact_lock(hashtextextended(p_company::text || '|' || p_product::text || '|' || p_place::text, 0));
  if p_bucket = 'available' then
    select coalesce(sum(qty), 0) into v_avail from inv.stock_balances
     where company_id = p_company and product_id = p_product and place_id = p_place and bucket = 'available' and (p_lot is null or lot_id = p_lot);
    select coalesce(sum(qty), 0) into v_reserved from inv.reservations
     where status = 'active' and company_id = p_company and product_id = p_product and place_id = p_place
       and (p_lot is null or lot_id is null or lot_id = p_lot) and source_id is distinct from p_own_reservation;
    if v_avail >= v_left and v_avail - v_reserved < v_left and app.negative_allowance(p_company, p_product, p_place) is null then
      perform app.raise_rule('stock.reserved', format('only %s is free here; the rest is reserved for transfers', greatest(v_avail - v_reserved, 0)), 'P0001');
    end if;
  end if;
  v_cost := app.avg_cost(p_company, p_product);
  for r in select b.id, b.lot_id, b.qty from inv.stock_balances b left join inv.lots l on l.id = b.lot_id
            where b.company_id = p_company and b.product_id = p_product and b.place_id = p_place and b.bucket = p_bucket and b.qty > 0
              and (p_lot is null or b.lot_id = p_lot)
            order by l.expiry_date nulls last, l.created_at nulls first, b.updated_at
            for update of b loop
    exit when v_left <= 0;
    v_take := least(r.qty, v_left);
    perform app.stock_post(p_company, p_product, r.lot_id, p_place, p_bucket, -v_take, p_move_type, p_source_table, p_source_id, p_doc_no, p_date, v_cost, p_note);
    v_out := v_out || jsonb_build_object('lot_id', r.lot_id, 'qty', v_take, 'unit_cost', coalesce(v_cost, 0));
    v_left := v_left - v_take;
  end loop;
  if v_left > 0 then
    -- Short: refused by app.stock_post unless a logged allowance covers this item and place.
    perform app.stock_post(p_company, p_product, p_lot, p_place, p_bucket, -v_left, p_move_type, p_source_table, p_source_id, p_doc_no, p_date, v_cost, p_note);
    v_out := v_out || jsonb_build_object('lot_id', p_lot, 'qty', v_left, 'unit_cost', coalesce(v_cost, 0));
  end if;
  return v_out;
end $$;

-- Stock dates: refuse future, closed months and old dates without a back-date permission.
create or replace function app.check_stock_date(p_company uuid, p_date date) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.check_backdate(p_company, p_date);
  perform app.fy_for(p_company, p_date);
end $$;

-- ─────────── Rights (configuration seed, Phase 1 pattern) ───────────
insert into core.rights (key, module, action, label, sort) values
  ('transfer.view', 'transfer', 'view', 'Stock transfers · View', 150),
  ('transfer.create', 'transfer', 'create', 'Stock transfers · Request', 151),
  ('transfer.approve', 'transfer', 'approve', 'Stock transfers · Approve and reconcile', 152),
  ('transfer.pick', 'transfer', 'pick', 'Stock transfers · Pick and hand over', 153),
  ('transfer.carry', 'transfer', 'carry', 'Stock transfers · Carry (take over from the picker)', 154),
  ('transfer.receive', 'transfer', 'receive', 'Stock transfers · Receive (blind count)', 155),
  ('transfer.close', 'transfer', 'close', 'Stock transfers · Close', 156),
  ('qc.test', 'qc', 'test', 'Incoming tests · Record', 160),
  ('qc.release', 'qc', 'release', 'Quarantine · Release or reject a lot', 161)
on conflict (key) do nothing;
insert into core.rights (key, module, action, label, hint, kind, admin_only, never_grantable, grantable_by_permission, sort) values
  ('transfer.write_off', 'transfer', 'write_off', 'Write off a transfer shortage', 'Finance only · never the picker, carrier or receiver', 'special', false, false, false, 1040)
on conflict (key) do nothing;

insert into core.role_rights (role_key, right_key) values
  -- Buying, logistics and petty cash
  ('buyer_logistics', 'purchase.view'), ('buyer_logistics', 'purchase.create'), ('buyer_logistics', 'purchase.edit'), ('buyer_logistics', 'inventory.view'),
  ('buyer_logistics', 'transfer.view'), ('buyer_logistics', 'transfer.create'), ('buyer_logistics', 'transfer.carry'), ('buyer_logistics', 'purchase_bills.view'),
  -- Factory manager and working partner
  ('factory_manager', 'inventory.view'), ('factory_manager', 'inventory.create'), ('factory_manager', 'inventory.edit'), ('factory_manager', 'inventory.approve'),
  ('factory_manager', 'purchase.view'), ('factory_manager', 'purchase.approve'), ('factory_manager', 'transfer.view'), ('factory_manager', 'transfer.approve'),
  ('factory_manager', 'transfer.close'),
  -- Finance
  ('finance_head', 'inventory.view'), ('finance_head', 'purchase.view'), ('finance_head', 'purchase.approve'), ('finance_head', 'transfer.view'),
  ('finance_head', 'transfer.write_off'), ('finance_head', 'transfer.close'), ('finance_head', 'purchase_bills.view'), ('finance_head', 'purchase_bills.create'),
  ('accountant', 'transfer.view'),
  -- Management
  ('md', 'inventory.view'), ('md', 'purchase.view'), ('md', 'purchase.approve'), ('md', 'transfer.view'), ('md', 'transfer.approve'),
  ('gm', 'inventory.view'), ('gm', 'purchase.view'), ('gm', 'purchase.approve'), ('gm', 'transfer.view'), ('gm', 'transfer.approve'),
  -- Production and plastics heads (department requests, issues)
  ('production_manager', 'inventory.view'), ('production_manager', 'inventory.create'), ('production_manager', 'purchase.view'), ('production_manager', 'purchase.create'),
  ('production_manager', 'transfer.view'), ('production_manager', 'transfer.create'), ('production_manager', 'transfer.receive'),
  ('injection_manager', 'inventory.view'), ('injection_manager', 'inventory.create'), ('injection_manager', 'purchase.view'), ('injection_manager', 'purchase.create'),
  ('mould_manager', 'inventory.view'), ('mould_manager', 'inventory.create'), ('mould_manager', 'purchase.view'), ('mould_manager', 'purchase.create'),
  ('assembly', 'inventory.view'), ('assembly', 'inventory.create'), ('assembly', 'purchase.view'), ('assembly', 'purchase.create'),
  ('supervisor', 'inventory.view'), ('supervisor', 'inventory.create'), ('supervisor', 'transfer.view'), ('supervisor', 'transfer.pick'),
  -- Pickers see transfers to pick, not balances or prices
  ('factory_staff', 'transfer.view'), ('factory_staff', 'transfer.pick'),
  -- Quality: tests and releases
  ('qc_releaser', 'inventory.view'), ('qc_releaser', 'qc.test'), ('qc_releaser', 'qc.release'),
  ('quality', 'inventory.view'), ('quality', 'qc.test'), ('quality', 'qc.release'),
  ('chemist', 'qc.test'),
  -- Shops, sales and drivers
  ('shop_staff', 'transfer.view'), ('shop_staff', 'transfer.create'), ('shop_staff', 'transfer.receive'), ('shop_staff', 'inventory.view'),
  ('sales_manager', 'transfer.view'), ('sales_manager', 'transfer.approve'), ('sales_manager', 'inventory.view'),
  ('driver', 'transfer.view'), ('driver', 'transfer.carry')
on conflict do nothing;

revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;

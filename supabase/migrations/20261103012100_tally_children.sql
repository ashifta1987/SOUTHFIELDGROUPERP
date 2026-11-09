-- 20261103012100_tally_children.sql
-- Tally import, Stage 1 (part 2): the voucher child lists as staging tables, the missing voucher header fields, the
-- stage RPC (api.import_stage_voucher_children), the header fill in app.imp_voucher and the gaps view.
-- Additive only. Child rows hold parsed columns only (no raw JSON per row); the original text of a voucher is represented by
-- ops.tally_vouchers.row_hash and the batch's file hash and storage path. Child rows are written once per batch and never changed
-- (a trigger refuses update/delete; deleting a voucher removes its children with it, which only happens in tests).
--   ops.tally_voucher_lines      ALLLEDGERENTRIES / LEDGERENTRIES and the ACCOUNTINGALLOCATIONS of item lines
--   ops.tally_voucher_inventory  ALLINVENTORYENTRIES / INVENTORYENTRIES and the in / out lists of stock and manufacturing journals
--   ops.tally_voucher_batches    BATCHALLOCATIONS
--   ops.tally_voucher_bills      BILLALLOCATIONS
--   ops.tally_voucher_costcentres CATEGORYALLOCATIONS + COSTCENTREALLOCATIONS
--   ops.tally_voucher_banks      BANKALLOCATIONS

alter table ops.import_batches add column if not exists file_sha256 text;

alter table ops.tally_vouchers
  add column if not exists narration text,
  add column if not exists reference text,
  add column if not exists reference_date date,
  add column if not exists effective_date date,
  add column if not exists persisted_view text,
  add column if not exists is_invoice boolean,
  add column if not exists is_post_dated boolean,
  add column if not exists place_of_supply text,
  add column if not exists party_gstin text,
  add column if not exists buyer_name text,
  add column if not exists voucher_key text,
  add column if not exists irn text,
  add column if not exists ack_no text,
  add column if not exists ack_date date,
  add column if not exists eway_bill_no text,
  add column if not exists row_hash text,
  add column if not exists children_batch_id uuid references ops.import_batches (id),
  add column if not exists children_alter_id bigint,
  add column if not exists children_staged_at timestamptz;
create index if not exists tally_vouchers_company_guid on ops.tally_vouchers (company_id, guid) where guid is not null;

-- ═════════════════════════ Child tables ═════════════════════════
create table ops.tally_voucher_lines (
  company_id uuid not null references core.companies (id),
  voucher_id uuid not null references ops.tally_vouchers (id) on delete cascade,
  batch_id uuid not null references ops.import_batches (id),
  line_no int not null,
  source_list text not null check (source_list in ('ALLLEDGERENTRIES', 'LEDGERENTRIES', 'ACCOUNTINGALLOCATIONS')),
  inventory_line_no int,
  ledger_name text not null,
  amount numeric(18, 2) not null,
  amount_text text,
  is_deemed_positive boolean,
  is_party_ledger boolean,
  gst_class text,
  flags text[] not null default '{}',
  primary key (voucher_id, batch_id, line_no)
);
create index on ops.tally_voucher_lines (company_id, ledger_name);
create index on ops.tally_voucher_lines (batch_id);

create table ops.tally_voucher_inventory (
  company_id uuid not null references core.companies (id),
  voucher_id uuid not null references ops.tally_vouchers (id) on delete cascade,
  batch_id uuid not null references ops.import_batches (id),
  line_no int not null,
  list_kind text not null check (list_kind in ('entries', 'in', 'out')),
  stock_item_name text not null,
  actual_qty numeric(18, 3),
  actual_unit text,
  actual_qty_text text,
  billed_qty numeric(18, 3),
  billed_unit text,
  rate numeric(18, 4),
  rate_unit text,
  discount_pct numeric(9, 4),
  discount_text text,
  amount numeric(18, 2),
  is_deemed_positive boolean,
  gst_hsn text,
  flags text[] not null default '{}',
  primary key (voucher_id, batch_id, line_no)
);
create index on ops.tally_voucher_inventory (company_id, stock_item_name);
create index on ops.tally_voucher_inventory (company_id, actual_unit);
create index on ops.tally_voucher_inventory (batch_id);

create table ops.tally_voucher_batches (
  company_id uuid not null references core.companies (id),
  voucher_id uuid not null references ops.tally_vouchers (id) on delete cascade,
  batch_id uuid not null references ops.import_batches (id),
  line_no int not null,
  inventory_line_no int,
  godown_name text,
  batch_name text,
  actual_qty numeric(18, 3),
  actual_unit text,
  billed_qty numeric(18, 3),
  billed_unit text,
  amount numeric(18, 2),
  mfd_text text,
  mfd_on date,
  expiry_text text,
  expiry_on date,
  order_no text,
  tracking_number text,
  primary key (voucher_id, batch_id, line_no)
);
create index on ops.tally_voucher_batches (company_id, godown_name);
create index on ops.tally_voucher_batches (batch_id);

create table ops.tally_voucher_bills (
  company_id uuid not null references core.companies (id),
  voucher_id uuid not null references ops.tally_vouchers (id) on delete cascade,
  batch_id uuid not null references ops.import_batches (id),
  line_no int not null,
  ledger_line_no int,
  bill_name text,
  bill_type text check (bill_type in ('New Ref', 'Agst Ref', 'Advance', 'On Account', 'Other')),
  amount numeric(18, 2),
  credit_period_text text,
  credit_days int,
  primary key (voucher_id, batch_id, line_no)
);
create index on ops.tally_voucher_bills (batch_id);

create table ops.tally_voucher_costcentres (
  company_id uuid not null references core.companies (id),
  voucher_id uuid not null references ops.tally_vouchers (id) on delete cascade,
  batch_id uuid not null references ops.import_batches (id),
  line_no int not null,
  ledger_line_no int,
  category text,
  cost_centre text,
  amount numeric(18, 2),
  is_deemed_positive boolean,
  primary key (voucher_id, batch_id, line_no)
);
create index on ops.tally_voucher_costcentres (batch_id);

create table ops.tally_voucher_banks (
  company_id uuid not null references core.companies (id),
  voucher_id uuid not null references ops.tally_vouchers (id) on delete cascade,
  batch_id uuid not null references ops.import_batches (id),
  line_no int not null,
  ledger_line_no int,
  bank_date date,
  instrument_date date,
  instrument_number text,
  transaction_type text,
  payment_favouring text,
  bankers_date date,
  amount numeric(18, 2),
  primary key (voucher_id, batch_id, line_no)
);
create index on ops.tally_voucher_banks (batch_id);

-- Write-once: no update; delete only while the parent voucher is being deleted (cascade).
create or replace function app.tally_child_write_once() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    perform app.raise_rule('staging.write_once', 'staged voucher lines are written once and never changed', '42501');
  end if;
  if exists (select 1 from ops.tally_vouchers where id = old.voucher_id) then
    perform app.raise_rule('staging.write_once', 'staged voucher lines are written once and never deleted', '42501');
  end if;
  return old;
end $$;

do $$
declare t text;
begin
  foreach t in array array['tally_voucher_lines', 'tally_voucher_inventory', 'tally_voucher_batches', 'tally_voucher_bills', 'tally_voucher_costcentres', 'tally_voucher_banks'] loop
    execute format('create trigger write_once before update or delete on ops.%I for each row execute function app.tally_child_write_once()', t);
    execute format('alter table ops.%I enable row level security', t);
    execute format('revoke all on ops.%I from anon, authenticated', t);
    execute format('grant select on ops.%I to authenticated', t);
    -- staging for Admin and the CA only (bills without GST stay out of everyone else's view)
    execute format($f$create policy %1$s_read on ops.%1$I for select to authenticated using (app.current_view() in ('all', 'all-readonly'))$f$, t);
  end loop;
end $$;

-- ═════════════════════════ Header fill ═════════════════════════
-- Fills the header fields only where they are still empty (a later load never silently overwrites).
create or replace function app.tally_voucher_header(p_id uuid, p jsonb) returns void
language sql security definer set search_path = '' as $$
  update ops.tally_vouchers v set
    narration = coalesce(v.narration, nullif(p ->> 'narration', '')),
    reference = coalesce(v.reference, nullif(p ->> 'reference', '')),
    reference_date = coalesce(v.reference_date, nullif(p ->> 'reference_date', '')::date),
    effective_date = coalesce(v.effective_date, nullif(p ->> 'effective_date', '')::date),
    persisted_view = coalesce(v.persisted_view, nullif(p ->> 'persisted_view', '')),
    is_invoice = coalesce(v.is_invoice, (p ->> 'is_invoice')::boolean),
    is_post_dated = coalesce(v.is_post_dated, (p ->> 'is_post_dated')::boolean),
    place_of_supply = coalesce(v.place_of_supply, nullif(p ->> 'place_of_supply', '')),
    party_gstin = coalesce(v.party_gstin, nullif(p ->> 'party_gstin', '')),
    buyer_name = coalesce(v.buyer_name, nullif(p ->> 'buyer_name', '')),
    voucher_key = coalesce(v.voucher_key, nullif(p ->> 'voucher_key', '')),
    irn = coalesce(v.irn, nullif(p ->> 'irn', '')),
    ack_no = coalesce(v.ack_no, nullif(p ->> 'ack_no', '')),
    ack_date = coalesce(v.ack_date, nullif(p ->> 'ack_date', '')::date),
    eway_bill_no = coalesce(v.eway_bill_no, nullif(p ->> 'eway_bill_no', '')),
    row_hash = coalesce(v.row_hash, nullif(p ->> 'row_hash', ''))
  where v.id = p_id;
$$;

do $$
declare
  v_def text; v_new text;
  v_a constant text := $q$update ops.import_rows set erp_table = 'ops.tally_vouchers', erp_id = v_existing.id where id = r.id;$q$;
  v_b constant text := $q$return case when v_upgraded then 'linked' else 'created' end;$q$;
begin
  v_def := pg_get_functiondef('app.imp_voucher(ops.import_batches, ops.import_rows)'::regprocedure);
  if length(v_def) - length(replace(v_def, v_a, '')) <> length(v_a) or length(v_def) - length(replace(v_def, v_b, '')) <> length(v_b) then
    raise exception 'imp_voucher header patch: anchors not found exactly once';
  end if;
  v_new := replace(v_def, v_a, v_a || ' perform app.tally_voucher_header(v_existing.id, p);');
  v_new := replace(v_new, v_b, 'perform app.tally_voucher_header(v_id, p); ' || v_b);
  execute v_new;
end $$;

-- ═════════════════════════ Stage RPC ═════════════════════════
-- p_vouchers: [{guid, alter_id, header: {...}, lines: [...], inventory: [...], batches: [...], bills: [...], costcentres: [...], banks: [...]}]
-- The voucher must already be loaded (api.import_stage_rows + import_process_step) in the same company; children of a voucher that is not there are counted
-- as 'unlinked' and not stored. A voucher whose children are already staged for the batch is skipped, so a repeat changes nothing.
create or replace function api.import_stage_voucher_children(p_client_request_id uuid, p_batch_id uuid, p_vouchers jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_res jsonb; b ops.import_batches; e jsonb; v ops.tally_vouchers;
  n_v int := 0; n_skip int := 0; n_unlinked int := 0; n_newer int := 0; n_flags int := 0; k int;
  c_lines int := 0; c_inv int := 0; c_bat int := 0; c_bill int := 0; c_cc int := 0; c_bank int := 0;
begin
  v_prev := app.request_seen(p_client_request_id, 'import_stage_voucher_children'); if v_prev is not null then return v_prev; end if;
  select * into b from ops.import_batches where id = p_batch_id for update;
  if not found then perform app.raise_rule('import.missing', 'batch not found', 'P0002'); end if;
  perform app.require(b.company_id, 'data.import');
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'only Admin stages voucher lines (they can include bills without GST)', '42501'); end if;
  if b.status not in ('uploaded', 'staged', 'processed') then perform app.raise_rule('import.locked', 'this batch can no longer take rows', '22023'); end if;
  if jsonb_typeof(p_vouchers) <> 'array' then perform app.raise_rule('import.bad_rows', 'p_vouchers must be a list', '22023'); end if;

  for e in select x from jsonb_array_elements(p_vouchers) x loop
    select * into v from ops.tally_vouchers where company_id = b.company_id and guid = e ->> 'guid' and state <> 'reversed';
    if not found then n_unlinked := n_unlinked + 1; continue; end if;
    perform app.tally_voucher_header(v.id, coalesce(e -> 'header', '{}'::jsonb));
    if exists (select 1 from ops.tally_voucher_lines where voucher_id = v.id and batch_id = p_batch_id)
       or exists (select 1 from ops.tally_voucher_inventory where voucher_id = v.id and batch_id = p_batch_id)
       or v.children_batch_id = p_batch_id then
      n_skip := n_skip + 1; continue;
    end if;
    if v.children_batch_id is not null and v.children_batch_id <> p_batch_id then n_newer := n_newer + 1; end if;

    insert into ops.tally_voucher_lines (company_id, voucher_id, batch_id, line_no, source_list, inventory_line_no, ledger_name, amount, amount_text, is_deemed_positive, is_party_ledger, gst_class, flags)
    select b.company_id, v.id, p_batch_id, (x ->> 'no')::int, x ->> 'list', nullif(x ->> 'inv_no', '')::int, x ->> 'ledger', coalesce((x ->> 'amount')::numeric, 0), x ->> 'amount_text',
           (x ->> 'deemed_positive')::boolean, (x ->> 'party')::boolean, nullif(x ->> 'gst_class', ''), coalesce(array(select jsonb_array_elements_text(x -> 'flags')), '{}')
    from jsonb_array_elements(coalesce(e -> 'lines', '[]'::jsonb)) x;
    get diagnostics k = row_count; c_lines := c_lines + k;

    insert into ops.tally_voucher_inventory (company_id, voucher_id, batch_id, line_no, list_kind, stock_item_name, actual_qty, actual_unit, actual_qty_text, billed_qty, billed_unit,
      rate, rate_unit, discount_pct, discount_text, amount, is_deemed_positive, gst_hsn, flags)
    select b.company_id, v.id, p_batch_id, (x ->> 'no')::int, coalesce(x ->> 'list_kind', 'entries'), x ->> 'item', (x ->> 'actual_qty')::numeric, x ->> 'actual_unit', x ->> 'actual_qty_text',
           (x ->> 'billed_qty')::numeric, x ->> 'billed_unit', (x ->> 'rate')::numeric, x ->> 'rate_unit', (x ->> 'discount_pct')::numeric, x ->> 'discount_text',
           (x ->> 'amount')::numeric, (x ->> 'deemed_positive')::boolean, nullif(x ->> 'hsn', ''), coalesce(array(select jsonb_array_elements_text(x -> 'flags')), '{}')
    from jsonb_array_elements(coalesce(e -> 'inventory', '[]'::jsonb)) x;
    get diagnostics k = row_count; c_inv := c_inv + k;

    insert into ops.tally_voucher_batches (company_id, voucher_id, batch_id, line_no, inventory_line_no, godown_name, batch_name, actual_qty, actual_unit, billed_qty, billed_unit, amount,
      mfd_text, mfd_on, expiry_text, expiry_on, order_no, tracking_number)
    select b.company_id, v.id, p_batch_id, (x ->> 'no')::int, nullif(x ->> 'inv_no', '')::int, x ->> 'godown', x ->> 'batch', (x ->> 'actual_qty')::numeric, x ->> 'actual_unit',
           (x ->> 'billed_qty')::numeric, x ->> 'billed_unit', (x ->> 'amount')::numeric, x ->> 'mfd_text', nullif(x ->> 'mfd_on', '')::date, x ->> 'expiry_text', nullif(x ->> 'expiry_on', '')::date,
           x ->> 'order_no', x ->> 'tracking_no'
    from jsonb_array_elements(coalesce(e -> 'batches', '[]'::jsonb)) x;
    get diagnostics k = row_count; c_bat := c_bat + k;

    insert into ops.tally_voucher_bills (company_id, voucher_id, batch_id, line_no, ledger_line_no, bill_name, bill_type, amount, credit_period_text, credit_days)
    select b.company_id, v.id, p_batch_id, (x ->> 'no')::int, nullif(x ->> 'line_no', '')::int, x ->> 'name',
           case when x ->> 'bill_type' in ('New Ref', 'Agst Ref', 'Advance', 'On Account') then x ->> 'bill_type' when x ->> 'bill_type' is null then null else 'Other' end,
           (x ->> 'amount')::numeric, x ->> 'credit_period_text', nullif(x ->> 'credit_days', '')::int
    from jsonb_array_elements(coalesce(e -> 'bills', '[]'::jsonb)) x;
    get diagnostics k = row_count; c_bill := c_bill + k;

    insert into ops.tally_voucher_costcentres (company_id, voucher_id, batch_id, line_no, ledger_line_no, category, cost_centre, amount, is_deemed_positive)
    select b.company_id, v.id, p_batch_id, (x ->> 'no')::int, nullif(x ->> 'line_no', '')::int, x ->> 'category', x ->> 'centre', (x ->> 'amount')::numeric, (x ->> 'deemed_positive')::boolean
    from jsonb_array_elements(coalesce(e -> 'costcentres', '[]'::jsonb)) x;
    get diagnostics k = row_count; c_cc := c_cc + k;

    insert into ops.tally_voucher_banks (company_id, voucher_id, batch_id, line_no, ledger_line_no, bank_date, instrument_date, instrument_number, transaction_type, payment_favouring, bankers_date, amount)
    select b.company_id, v.id, p_batch_id, (x ->> 'no')::int, nullif(x ->> 'line_no', '')::int, nullif(x ->> 'date', '')::date, nullif(x ->> 'instrument_date', '')::date, x ->> 'instrument_number',
           x ->> 'transaction_type', x ->> 'favouring', nullif(x ->> 'bankers_date', '')::date, (x ->> 'amount')::numeric
    from jsonb_array_elements(coalesce(e -> 'banks', '[]'::jsonb)) x;
    get diagnostics k = row_count; c_bank := c_bank + k;

    update ops.tally_vouchers set children_batch_id = coalesce(children_batch_id, p_batch_id), children_alter_id = coalesce(children_alter_id, nullif(e ->> 'alter_id', '')::bigint),
           children_staged_at = coalesce(children_staged_at, now()) where id = v.id;
    n_v := n_v + 1;
  end loop;

  select count(*) into n_flags from ops.tally_voucher_lines where batch_id = p_batch_id and cardinality(flags) > 0 and voucher_id in (
    select (select id from ops.tally_vouchers where company_id = b.company_id and guid = x ->> 'guid' limit 1) from jsonb_array_elements(p_vouchers) x);
  v_res := jsonb_build_object('vouchers', n_v, 'skipped', n_skip, 'unlinked', n_unlinked, 'newer_version', n_newer, 'flagged_lines', n_flags,
    'lines', c_lines, 'inventory', c_inv, 'batches', c_bat, 'bills', c_bill, 'costcentres', c_cc, 'banks', c_bank);
  return app.request_done(p_client_request_id, 'import_stage_voucher_children', v_res);
end $$;

-- ═════════════════════════ Gaps: names used by staged vouchers that are not confirmed ═════════════════════════
create or replace view api.tally_map_gaps with (security_invoker = true) as
with vt as (
  select company_id, voucher_type as name, count(*) as used from ops.tally_vouchers where state <> 'reversed' group by 1, 2
), gd as (
  select company_id, godown_name as name, count(*) as used from ops.tally_voucher_batches where godown_name is not null group by 1, 2
), un as (
  select company_id, u as name, count(*) as used
  from (select company_id, actual_unit as u from ops.tally_voucher_inventory union all select company_id, billed_unit from ops.tally_voucher_inventory) x
  where u is not null group by 1, 2
), lg as (
  select company_id, ledger_name as name, count(*) as used from ops.tally_voucher_lines group by 1, 2
), it as (
  select company_id, stock_item_name as name, count(*) as used from ops.tally_voucher_inventory group by 1, 2
)
select vt.company_id, 'voucher_type'::text as kind, vt.name, vt.used as used_count, coalesce(m.status, 'unmapped') as status
  from vt left join ops.tally_voucher_type_map m on m.company_id = vt.company_id and m.tally_type = vt.name where m.status is distinct from 'confirmed'
union all
select gd.company_id, 'godown', gd.name, gd.used, coalesce(m.status, 'unmapped')
  from gd left join ops.tally_godown_map m on m.company_id = gd.company_id and m.tally_godown = gd.name where m.status is distinct from 'confirmed'
union all
select un.company_id, 'unit', un.name, un.used, coalesce(m.status, 'unmapped')
  from un left join ops.tally_unit_map m on m.company_id = un.company_id and m.tally_unit = un.name where m.status is distinct from 'confirmed'
union all
select lg.company_id, 'ledger', lg.name, lg.used, 'unmapped'
  from lg where not exists (select 1 from acct.accounts a where a.company_id = lg.company_id and a.name_norm = app.norm_name(lg.name))
union all
select it.company_id, 'item', it.name, it.used, coalesce(m.status, 'unmapped')
  from it left join ops.tally_item_map m on m.company_id = it.company_id and m.tally_item = it.name
  where m.status is distinct from 'confirmed'
    and not exists (select 1 from master.products p where p.name_norm = app.norm_name(it.name))
    and not exists (select 1 from master.product_aliases pa where pa.alias_norm = app.norm_name(it.name));
grant select on api.tally_map_gaps to authenticated;

revoke all on function app.tally_child_write_once(), app.tally_voucher_header(uuid, jsonb), api.import_stage_voucher_children(uuid, uuid, jsonb) from public, anon;
grant execute on function app.tally_child_write_once(), app.tally_voucher_header(uuid, jsonb), api.import_stage_voucher_children(uuid, uuid, jsonb) to authenticated;

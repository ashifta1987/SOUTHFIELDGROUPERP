-- 20261103004200_transfers.sql
-- Phase 4 stock transfers between places of one company: requested → approved → reserved → picked → handed_over →
-- in_transit → received (blind count) → reconciled → closed (or cancelled before dispatch). Two people at each end
-- (picker ≠ carrier, receiver ≠ picker; a carrier who also receives needs a witness), the balance rule
-- dispatched = accepted + quarantined + returned + approved loss + in transit (a generated column that can never go
-- below zero), shortage write-off only with the finance right, the picker never closes. GST (AGENTS rule 7): a move on
-- the same GSTIN carries a delivery challan (sales.documents, numbered from the challan series); a move to another
-- GSTIN needs a posted tax invoice to that GSTIN (IGST across states) before the goods leave. Additive.

-- A branch delivery challan has no customer: allow party_id to be empty for delivery challans only (additive relaxation).
alter table sales.documents alter column party_id drop not null;
alter table sales.documents add constraint sales_documents_party_required check (party_id is not null or doc_type = 'delivery_challan');

create table inv.transfers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  doc_no text not null,
  transfer_date date not null,
  from_place_id uuid not null references core.places (id),
  to_place_id uuid not null references core.places (id),
  from_gstin_id uuid not null references core.gstins (id),
  to_gstin_id uuid not null references core.gstins (id),
  gst_doc_kind text not null check (gst_doc_kind in ('delivery_challan', 'tax_invoice')),
  sales_document_id uuid unique references sales.documents (id),
  status text not null default 'requested' check (status in ('requested', 'approved', 'reserved', 'picked', 'handed_over', 'in_transit', 'received', 'reconciled', 'closed', 'cancelled')),
  needed_by date,
  note text,
  vehicle_no text,
  carrier_name text,
  requested_by uuid not null references auth.users (id),
  requested_at timestamptz not null default now(),
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  reserved_by uuid references auth.users (id),
  reserved_at timestamptz,
  picked_by uuid references auth.users (id),
  picked_at timestamptz,
  handed_over_at timestamptz,
  carried_by uuid references auth.users (id),
  dispatched_at timestamptz,
  received_by uuid references auth.users (id),
  witness_by uuid references auth.users (id),
  received_at timestamptz,
  reconciled_by uuid references auth.users (id),
  reconciled_at timestamptz,
  closed_by uuid references auth.users (id),
  closed_at timestamptz,
  cancelled_by uuid references auth.users (id),
  cancelled_at timestamptz,
  cancel_reason text,
  unique (company_id, doc_no),
  check (from_place_id <> to_place_id),
  check ((gst_doc_kind = 'delivery_challan') = (from_gstin_id = to_gstin_id)),
  check (approved_by is null or approved_by <> requested_by),                 -- nobody approves their own request
  check (carried_by is null or carried_by <> picked_by),                       -- picker and carrier on their own logins
  check (received_by is null or received_by <> picked_by),
  check (witness_by is null or witness_by <> received_by),
  check (closed_by is null or (closed_by is distinct from picked_by and closed_by is distinct from carried_by))   -- the picker never closes
);
create index on inv.transfers (company_id, status);
create index on inv.transfers (to_place_id, status);
create index on inv.transfers (from_place_id, status);

create table inv.transfer_lines (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references inv.transfers (id),
  line_no int not null,
  product_id uuid not null references master.products (id),
  lot_id uuid references inv.lots (id),
  qty_requested numeric(18, 3) not null check (qty_requested > 0),
  qty_approved numeric(18, 3) check (qty_approved is null or qty_approved >= 0),
  note text,
  unique (transfer_id, line_no)
);

-- One row per line and lot actually picked. The balance rule is structural: in transit is what is left.
create table inv.transfer_items (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references inv.transfers (id),
  line_id uuid not null references inv.transfer_lines (id),
  product_id uuid not null references master.products (id),
  lot_id uuid references inv.lots (id),
  qty_dispatched numeric(18, 3) not null check (qty_dispatched > 0),
  qty_accepted numeric(18, 3) not null default 0 check (qty_accepted >= 0),
  qty_quarantined numeric(18, 3) not null default 0 check (qty_quarantined >= 0),
  qty_returned numeric(18, 3) not null default 0 check (qty_returned >= 0),
  qty_lost numeric(18, 3) not null default 0 check (qty_lost >= 0),
  qty_in_transit numeric(18, 3) generated always as (qty_dispatched - qty_accepted - qty_quarantined - qty_returned - qty_lost) stored,
  unit_cost numeric(18, 4) not null default 0,
  counted_by uuid references auth.users (id),
  counted_at timestamptz,
  constraint transfer_items_balance check (qty_dispatched - qty_accepted - qty_quarantined - qty_returned - qty_lost >= 0),
  unique nulls not distinct (line_id, lot_id)
);
create index on inv.transfer_items (transfer_id);

create table inv.transfer_events (
  id bigint generated always as identity primary key,
  transfer_id uuid not null references inv.transfers (id),
  action text not null,
  from_status text,
  to_status text,
  actor uuid references auth.users (id),
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index on inv.transfer_events (transfer_id);
create trigger transfer_events_append_only before update or delete on inv.transfer_events for each row execute function app.reject_change();
create trigger transfers_no_delete before delete on inv.transfers for each row execute function app.reject_change();

do $$
declare t text;
begin
  foreach t in array array['inv.transfers', 'inv.transfer_lines', 'inv.transfer_items'] loop
    execute format('create trigger audit_row after insert or update or delete on %s for each row execute function app.audit_trigger()', t);
  end loop;
  foreach t in array array['transfers', 'transfer_lines', 'transfer_items', 'transfer_events'] loop
    execute format('alter table inv.%I enable row level security', t);
    execute format('revoke all on inv.%I from anon, authenticated', t);
    execute format('grant select on inv.%I to authenticated', t);
  end loop;
end $$;

create policy transfers_read on inv.transfers for select to authenticated using (app.can(company_id, 'transfer.view') or app.can(company_id, 'inventory.view'));
create policy transfer_lines_read on inv.transfer_lines for select to authenticated
  using (exists (select 1 from inv.transfers t where t.id = transfer_id and (app.can(t.company_id, 'transfer.view') or app.can(t.company_id, 'inventory.view'))));
create policy transfer_items_read on inv.transfer_items for select to authenticated
  using (exists (select 1 from inv.transfers t where t.id = transfer_id and (app.can(t.company_id, 'transfer.view') or app.can(t.company_id, 'inventory.view'))));
create policy transfer_events_read on inv.transfer_events for select to authenticated
  using (exists (select 1 from inv.transfers t where t.id = transfer_id and (app.can(t.company_id, 'transfer.view') or app.can(t.company_id, 'inventory.view'))));

-- ─────────── Helpers ───────────
create or replace function app.transfer_event(p_transfer uuid, p_action text, p_from text, p_to text, p_detail jsonb default '{}'::jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into inv.transfer_events (transfer_id, action, from_status, to_status, actor, detail) values (p_transfer, p_action, p_from, p_to, auth.uid(), coalesce(p_detail, '{}'::jsonb));
$$;

create or replace function app.lock_transfer(p_id uuid, p_states text[], p_right text) returns inv.transfers
language plpgsql security definer set search_path = '' as $$
declare t inv.transfers;
begin
  select * into t from inv.transfers where id = p_id for update;
  if t.id is null then perform app.raise_rule('transfer.missing', 'transfer not found', 'P0002'); end if;
  perform app.require(t.company_id, p_right);
  if not (t.status = any (p_states)) then
    perform app.raise_rule('transfer.state', format('this transfer is %s; this step needs %s', t.status, array_to_string(p_states, ' or ')), '22023');
  end if;
  return t;
end $$;

-- Put a received quantity into the destination: out of in_transit, into available (good) or quarantine (damaged).
create or replace function app.transfer_receive_item(t inv.transfers, i inv.transfer_items, p_good numeric, p_damaged numeric, p_date date) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(p_good, 0) < 0 or coalesce(p_damaged, 0) < 0 then perform app.raise_rule('transfer.count', 'counts cannot be negative', '22023'); end if;
  if coalesce(p_good, 0) + coalesce(p_damaged, 0) > i.qty_in_transit then
    perform app.raise_rule('transfer.extra_goods', 'more than was sent is not added here; the sending place checks and makes an extra dispatch', 'P0001');
  end if;
  if coalesce(p_good, 0) + coalesce(p_damaged, 0) = 0 then return; end if;
  perform app.stock_post(t.company_id, i.product_id, i.lot_id, t.to_place_id, 'in_transit', -(coalesce(p_good, 0) + coalesce(p_damaged, 0)), 'transfer_in', 'inv.transfers', t.id, t.doc_no, p_date, i.unit_cost);
  perform app.stock_post(t.company_id, i.product_id, i.lot_id, t.to_place_id, 'available', p_good, 'transfer_in', 'inv.transfers', t.id, t.doc_no, p_date, i.unit_cost);
  perform app.stock_post(t.company_id, i.product_id, i.lot_id, t.to_place_id, 'quarantine', p_damaged, 'transfer_in', 'inv.transfers', t.id, t.doc_no, p_date, i.unit_cost, 'Damaged on arrival');
  update inv.transfer_items set qty_accepted = qty_accepted + coalesce(p_good, 0), qty_quarantined = qty_quarantined + coalesce(p_damaged, 0),
         counted_by = auth.uid(), counted_at = now() where id = i.id;
end $$;

-- ─────────── RPCs ───────────
-- p: {company_id, from_place_id, to_place_id, date, needed_by, note, lines: [{product_id, lot_id, qty, note}]}
create or replace function api.request_transfer(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_res jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_from core.places; v_to core.places; v_gfrom uuid; v_gto uuid;
  v_date date := coalesce(nullif(p ->> 'date', '')::date, current_date); v_id uuid; v_no text; l jsonb; v_n int := 0;
begin
  v_prev := app.request_seen(p_client_request_id, 'request_transfer'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'transfer.create');
  select * into v_from from core.places where id = (p ->> 'from_place_id')::uuid and company_id = v_company and status = 'active';
  select * into v_to from core.places where id = (p ->> 'to_place_id')::uuid and company_id = v_company and status = 'active';
  if v_from.id is null or v_to.id is null then perform app.raise_rule('transfer.places', 'choose two active places of this company', '22023'); end if;
  if v_from.id = v_to.id then perform app.raise_rule('transfer.same_place', 'the two places must be different', '22023'); end if;
  select gstin_id into v_gfrom from core.branches where id = v_from.branch_id;
  select gstin_id into v_gto from core.branches where id = v_to.branch_id;
  if v_gfrom is null or v_gto is null then perform app.raise_rule('transfer.no_gstin', 'set the GSTIN of both branches on Branches first', '22023'); end if;
  v_no := app.internal_doc_no(v_company, 'stock_transfer', v_date);
  insert into inv.transfers (company_id, doc_no, transfer_date, from_place_id, to_place_id, from_gstin_id, to_gstin_id, gst_doc_kind, needed_by, note, requested_by)
  values (v_company, v_no, v_date, v_from.id, v_to.id, v_gfrom, v_gto, case when v_gfrom = v_gto then 'delivery_challan' else 'tax_invoice' end,
          nullif(p ->> 'needed_by', '')::date, nullif(p ->> 'note', ''), auth.uid())
  returning id into v_id;
  for l in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    v_n := v_n + 1;
    if coalesce((l ->> 'qty')::numeric, 0) <= 0 then perform app.raise_rule('stock.qty', 'every line needs a quantity above zero', '22023'); end if;
    if nullif(l ->> 'lot_id', '') is not null and not exists (select 1 from inv.lots where id = (l ->> 'lot_id')::uuid and product_id = (l ->> 'product_id')::uuid and company_id = v_company) then
      perform app.raise_rule('stock.lot_mismatch', 'the lot is not of this item and company', '22023');
    end if;
    insert into inv.transfer_lines (transfer_id, line_no, product_id, lot_id, qty_requested, note)
    values (v_id, v_n, (l ->> 'product_id')::uuid, nullif(l ->> 'lot_id', '')::uuid, round((l ->> 'qty')::numeric, 3), nullif(l ->> 'note', ''));
  end loop;
  if v_n = 0 then perform app.raise_rule('doc.no_lines', 'add at least one line', '22023'); end if;
  perform app.transfer_event(v_id, 'requested', null, 'requested');
  v_res := jsonb_build_object('id', v_id, 'doc_no', v_no, 'gst_doc_kind', case when v_gfrom = v_gto then 'delivery_challan' else 'tax_invoice' end);
  return app.request_done(p_client_request_id, 'request_transfer', v_res);
end $$;

-- p_lines (optional): [{line_id, qty_approved}] — otherwise the requested quantities are approved.
create or replace function api.approve_transfer(p_client_request_id uuid, p_transfer_id uuid, p_lines jsonb default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; t inv.transfers; l jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'approve_transfer'); if v_prev is not null then return v_prev; end if;
  t := app.lock_transfer(p_transfer_id, array['requested'], 'transfer.approve');
  if t.requested_by = auth.uid() then perform app.raise_rule('sod.own_request', 'you cannot approve your own request', '42501'); end if;
  update inv.transfer_lines set qty_approved = qty_requested where transfer_id = t.id;
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    if coalesce((l ->> 'qty_approved')::numeric, -1) < 0 then perform app.raise_rule('stock.qty', 'approved quantity cannot be negative', '22023'); end if;
    update inv.transfer_lines set qty_approved = round((l ->> 'qty_approved')::numeric, 3) where id = (l ->> 'line_id')::uuid and transfer_id = t.id;
  end loop;
  if not exists (select 1 from inv.transfer_lines where transfer_id = t.id and qty_approved > 0) then perform app.raise_rule('transfer.nothing_approved', 'approve at least one line', '22023'); end if;
  update inv.transfers set status = 'approved', approved_by = auth.uid(), approved_at = now(),
         note = case when nullif(trim(p_note), '') is null then note else coalesce(note || ' · ', '') || trim(p_note) end where id = t.id;
  perform app.transfer_event(t.id, 'approved', t.status, 'approved', jsonb_build_object('note', p_note));
  v_res := jsonb_build_object('id', t.id, 'status', 'approved');
  return app.request_done(p_client_request_id, 'approve_transfer', v_res);
end $$;

-- The factory custodian reserves released stock for the approved quantities (others cannot issue it meanwhile).
create or replace function api.reserve_transfer(p_client_request_id uuid, p_transfer_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; t inv.transfers; l record; v_avail numeric; v_reserved numeric;
begin
  v_prev := app.request_seen(p_client_request_id, 'reserve_transfer'); if v_prev is not null then return v_prev; end if;
  t := app.lock_transfer(p_transfer_id, array['approved'], 'inventory.edit');
  for l in select * from inv.transfer_lines where transfer_id = t.id and qty_approved > 0 order by line_no loop
    perform pg_advisory_xact_lock(hashtextextended(t.company_id::text || '|' || l.product_id::text || '|' || t.from_place_id::text, 0));
    select coalesce(sum(qty), 0) into v_avail from inv.stock_balances
     where company_id = t.company_id and product_id = l.product_id and place_id = t.from_place_id and bucket = 'available' and (l.lot_id is null or lot_id = l.lot_id);
    select coalesce(sum(qty), 0) into v_reserved from inv.reservations
     where status = 'active' and company_id = t.company_id and product_id = l.product_id and place_id = t.from_place_id and (l.lot_id is null or lot_id is null or lot_id = l.lot_id);
    if v_avail - v_reserved < l.qty_approved then
      perform app.raise_rule('stock.insufficient', format('line %s: only %s released and free at the sending place', l.line_no, greatest(v_avail - v_reserved, 0)), 'P0001');
    end if;
    insert into inv.reservations (company_id, product_id, lot_id, place_id, qty, source_table, source_id, source_line_id, created_by)
    values (t.company_id, l.product_id, l.lot_id, t.from_place_id, l.qty_approved, 'inv.transfers', t.id, l.id, auth.uid());
  end loop;
  update inv.transfers set status = 'reserved', reserved_by = auth.uid(), reserved_at = now() where id = t.id;
  perform app.transfer_event(t.id, 'reserved', t.status, 'reserved');
  v_res := jsonb_build_object('id', t.id, 'status', 'reserved');
  return app.request_done(p_client_request_id, 'reserve_transfer', v_res);
end $$;

-- The picker scans lots: p_picks [{line_id, lot_id, qty}]. Released lots only, never more than approved.
create or replace function api.pick_transfer(p_client_request_id uuid, p_transfer_id uuid, p_picks jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; t inv.transfers; pk jsonb; l inv.transfer_lines; v_lot uuid; v_total numeric; v_n int := 0;
begin
  v_prev := app.request_seen(p_client_request_id, 'pick_transfer'); if v_prev is not null then return v_prev; end if;
  t := app.lock_transfer(p_transfer_id, array['reserved'], 'transfer.pick');
  for pk in select * from jsonb_array_elements(coalesce(p_picks, '[]'::jsonb)) loop
    select * into l from inv.transfer_lines where id = (pk ->> 'line_id')::uuid and transfer_id = t.id;
    if l.id is null then perform app.raise_rule('transfer.line_missing', 'line not on this transfer', '22023'); end if;
    if coalesce((pk ->> 'qty')::numeric, 0) <= 0 then perform app.raise_rule('stock.qty', 'picked quantity must be above zero', '22023'); end if;
    v_lot := coalesce(nullif(pk ->> 'lot_id', '')::uuid, l.lot_id);
    if l.lot_id is not null and v_lot <> l.lot_id then perform app.raise_rule('transfer.wrong_lot', 'pick the lot that was asked for', '22023'); end if;
    if v_lot is not null and not exists (select 1 from inv.lots where id = v_lot and product_id = l.product_id and company_id = t.company_id and status = 'available') then
      perform app.raise_rule('stock.lot_not_released', 'only released lots of this item can be picked', 'P0001');
    end if;
    if v_lot is null and exists (select 1 from inv.stock_balances where company_id = t.company_id and product_id = l.product_id and place_id = t.from_place_id
                                   and bucket = 'available' and lot_id is not null and qty > 0) then
      perform app.raise_rule('transfer.lot_required', 'scan the lot (batch) being picked', '22023');
    end if;
    insert into inv.transfer_items (transfer_id, line_id, product_id, lot_id, qty_dispatched)
    values (t.id, l.id, l.product_id, v_lot, round((pk ->> 'qty')::numeric, 3))
    on conflict (line_id, lot_id) do update set qty_dispatched = inv.transfer_items.qty_dispatched + excluded.qty_dispatched;
    select coalesce(sum(qty_dispatched), 0) into v_total from inv.transfer_items where line_id = l.id;
    if v_total > coalesce(l.qty_approved, 0) then perform app.raise_rule('transfer.over_pick', format('line %s: pick only the approved %s', l.line_no, l.qty_approved), '22023'); end if;
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then perform app.raise_rule('doc.no_lines', 'scan at least one lot', '22023'); end if;
  update inv.transfers set status = 'picked', picked_by = auth.uid(), picked_at = now() where id = t.id;
  perform app.transfer_event(t.id, 'picked', t.status, 'picked', jsonb_build_object('items', v_n));
  v_res := jsonb_build_object('id', t.id, 'status', 'picked');
  return app.request_done(p_client_request_id, 'pick_transfer', v_res);
end $$;

-- The branch delivery challan (same GSTIN) for the dispatched items, numbered from the challan series.
create or replace function app.transfer_challan(t inv.transfers, p_date date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_fy uuid; v_no text; v_total numeric; v_pos text;
begin
  v_fy := app.fy_for(t.company_id, p_date);
  select state_code into v_pos from core.gstins where id = t.to_gstin_id;
  insert into sales.documents (company_id, gstin_id, doc_type, doc_date, party_id, place_of_supply, tax_class, lawful_reason, reason, notes, created_by)
  values (t.company_id, t.from_gstin_id, 'delivery_challan', p_date, null, v_pos, 'without_gst', 'challan_not_sold', 'Stock transfer ' || t.doc_no,
          'Branch transfer, same GSTIN: goods not sold', auth.uid())
  returning id into v_id;
  insert into sales.document_lines (document_id, line_no, product_id, description, hsn_code, uom, qty, rate, discount, taxable, gst_rate, cgst, sgst, igst, cess, total)
  select v_id, row_number() over (order by p.code)::int, i.product_id, p.name, p.hsn_code, p.uom, sum(i.qty_dispatched), round(max(i.unit_cost), 2), 0,
         round(sum(i.qty_dispatched * i.unit_cost), 2), 0, 0, 0, 0, 0, round(sum(i.qty_dispatched * i.unit_cost), 2)
  from inv.transfer_items i join master.products p on p.id = i.product_id
  where i.transfer_id = t.id group by i.product_id, p.code, p.name, p.hsn_code, p.uom;
  select coalesce(sum(total), 0) into v_total from sales.document_lines where document_id = v_id;
  v_no := app.take_doc_number(t.company_id, t.from_gstin_id, 'delivery_challan', v_fy);
  update sales.documents set taxable = v_total, total = v_total, status = 'posted', doc_no = v_no, posted_at = now(), posted_by = auth.uid() where id = v_id;
  return v_id;
end $$;

-- The tax invoice for a move to another GSTIN must be posted first: from our sending GSTIN, to a party carrying the
-- receiving GSTIN, IGST when the states differ, and covering every dispatched item.
create or replace function app.check_transfer_invoice(t inv.transfers, p_doc uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare d sales.documents; v_party_gstin text; v_to text; v_from_state text; v_to_state text; r record;
begin
  if p_doc is null then perform app.raise_rule('transfer.invoice_required', 'this move is to another GSTIN: post the tax invoice to that GSTIN first and link it', 'P0001'); end if;
  select * into d from sales.documents where id = p_doc;
  if d.id is null or d.status <> 'posted' or d.doc_type <> 'sales_invoice' or d.company_id <> t.company_id or d.gstin_id <> t.from_gstin_id then
    perform app.raise_rule('transfer.invoice_invalid', 'link a posted tax invoice from the sending GSTIN', 'P0001');
  end if;
  if exists (select 1 from inv.transfers x where x.sales_document_id = d.id and x.id <> t.id) then perform app.raise_rule('transfer.invoice_used', 'this invoice is linked to another transfer', '22023'); end if;
  select gstin into v_party_gstin from master.parties where id = d.party_id;
  select gstin, state_code into v_to, v_to_state from core.gstins where id = t.to_gstin_id;
  select state_code into v_from_state from core.gstins where id = t.from_gstin_id;
  if v_party_gstin is distinct from v_to then perform app.raise_rule('transfer.invoice_wrong_party', 'the invoice must be billed to the receiving GSTIN ' || v_to, 'P0001'); end if;
  if v_from_state <> v_to_state and (d.igst <= 0 or d.cgst > 0 or d.sgst > 0) then perform app.raise_rule('transfer.invoice_needs_igst', 'a move to another state is billed with IGST', 'P0001'); end if;
  for r in select i.product_id, sum(i.qty_dispatched) as qty from inv.transfer_items i where i.transfer_id = t.id group by i.product_id loop
    if coalesce((select sum(x.qty) from sales.document_lines x where x.document_id = d.id and x.product_id = r.product_id), 0) < r.qty then
      perform app.raise_rule('transfer.invoice_short', 'the invoice does not cover every item being sent', 'P0001');
    end if;
  end loop;
end $$;

-- Handover: p_role 'picker' (the picker confirms) then 'carrier' (another login takes over; stock goes into transit and
-- the GST document is made or checked). p: {vehicle_no, carrier_name, sales_document_id (tax invoice for another GSTIN), date}
create or replace function api.hand_over_transfer(p_client_request_id uuid, p_transfer_id uuid, p_role text, p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; t inv.transfers; i record; v_pieces jsonb; v_date date := coalesce(nullif(p ->> 'date', '')::date, current_date); v_doc uuid; v_cost numeric;
begin
  v_prev := app.request_seen(p_client_request_id, 'hand_over_transfer'); if v_prev is not null then return v_prev; end if;
  if p_role = 'picker' then
    t := app.lock_transfer(p_transfer_id, array['picked'], 'transfer.pick');
    if t.picked_by <> auth.uid() then perform app.raise_rule('sod.not_picker', 'only the person who picked confirms the handover', '42501'); end if;
    update inv.transfers set status = 'handed_over', handed_over_at = now() where id = t.id;
    perform app.transfer_event(t.id, 'handed_over', t.status, 'handed_over');
    v_res := jsonb_build_object('id', t.id, 'status', 'handed_over');
  elsif p_role = 'carrier' then
    t := app.lock_transfer(p_transfer_id, array['handed_over'], 'transfer.carry');
    if t.picked_by = auth.uid() then perform app.raise_rule('sod.picker_carrier', 'the carrier confirms on their own login, not the picker''s', '42501'); end if;
    perform app.check_stock_date(t.company_id, v_date);
    -- Stock leaves the sending place (using this transfer's reservation) and sits in transit at the receiving place.
    -- The same lot (or untracked stock) that was picked; the transfer's own reservation is consumed below.
    for i in select * from inv.transfer_items where transfer_id = t.id loop
      v_cost := coalesce(app.avg_cost(t.company_id, i.product_id), 0);
      perform app.stock_post(t.company_id, i.product_id, i.lot_id, t.from_place_id, 'available', -i.qty_dispatched, 'transit_out', 'inv.transfers', t.id, t.doc_no, v_date, v_cost);
      perform app.stock_post(t.company_id, i.product_id, i.lot_id, t.to_place_id, 'in_transit', i.qty_dispatched, 'transit_in', 'inv.transfers', t.id, t.doc_no, v_date, v_cost);
      update inv.transfer_items set unit_cost = v_cost where id = i.id;
    end loop;
    update inv.reservations set status = 'consumed', closed_at = now() where source_id = t.id and status = 'active';
    select * into t from inv.transfers where id = t.id;
    if t.gst_doc_kind = 'delivery_challan' then
      v_doc := app.transfer_challan(t, v_date);
    else
      v_doc := coalesce(nullif(p ->> 'sales_document_id', '')::uuid, t.sales_document_id);
      perform app.check_transfer_invoice(t, v_doc);
    end if;
    update inv.transfers set status = 'in_transit', carried_by = auth.uid(), dispatched_at = now(), sales_document_id = v_doc,
           vehicle_no = coalesce(nullif(p ->> 'vehicle_no', ''), vehicle_no), carrier_name = coalesce(nullif(p ->> 'carrier_name', ''), carrier_name)
     where id = t.id;
    perform app.transfer_event(t.id, 'dispatched', 'handed_over', 'in_transit', jsonb_build_object('gst_doc_kind', t.gst_doc_kind, 'sales_document_id', v_doc, 'vehicle_no', p ->> 'vehicle_no'));
    v_res := jsonb_build_object('id', t.id, 'status', 'in_transit', 'gst_doc_kind', t.gst_doc_kind, 'sales_document_id', v_doc,
                                'gst_doc_no', (select doc_no from sales.documents where id = v_doc));
  else
    perform app.raise_rule('transfer.role', 'the handover is confirmed by the picker or the carrier', '22023');
  end if;
  return app.request_done(p_client_request_id, 'hand_over_transfer', v_res);
end $$;

-- Blind receipt. p_blind_counts: [{item_id, good_qty, damaged_qty}] — items not listed count as zero (still in transit).
-- The receiver is never the picker; a carrier who receives needs a witness (another login).
create or replace function api.receive_transfer(p_client_request_id uuid, p_transfer_id uuid, p_blind_counts jsonb, p_witness_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; t inv.transfers; c jsonb; i inv.transfer_items; v_date date := current_date; v_left numeric;
begin
  v_prev := app.request_seen(p_client_request_id, 'receive_transfer'); if v_prev is not null then return v_prev; end if;
  t := app.lock_transfer(p_transfer_id, array['in_transit'], 'transfer.receive');
  if t.picked_by = auth.uid() then perform app.raise_rule('sod.picker_receiver', 'the picker cannot receive the same transfer', '42501'); end if;
  if t.carried_by = auth.uid() then
    if p_witness_id is null or p_witness_id = auth.uid() or p_witness_id = t.picked_by then
      perform app.raise_rule('sod.witness_required', 'you carried these goods: a second authorised person must witness the receipt', '42501');
    end if;
    if not exists (select 1 from core.user_profiles where user_id = p_witness_id and status = 'active') then perform app.raise_rule('sod.witness_required', 'the witness must be an active user', '42501'); end if;
  end if;
  perform app.check_stock_date(t.company_id, v_date);
  for c in select * from jsonb_array_elements(coalesce(p_blind_counts, '[]'::jsonb)) loop
    select * into i from inv.transfer_items where id = (c ->> 'item_id')::uuid and transfer_id = t.id for update;
    if i.id is null then perform app.raise_rule('transfer.line_missing', 'item not on this transfer', '22023'); end if;
    perform app.transfer_receive_item(t, i, coalesce((c ->> 'good_qty')::numeric, 0), coalesce((c ->> 'damaged_qty')::numeric, 0), v_date);
  end loop;
  update inv.transfers set status = 'received', received_by = auth.uid(), received_at = now(), witness_by = p_witness_id where id = t.id;
  select coalesce(sum(qty_in_transit), 0) into v_left from inv.transfer_items where transfer_id = t.id;
  perform app.transfer_event(t.id, 'received', t.status, 'received', jsonb_build_object('still_in_transit', v_left, 'witness', p_witness_id));
  v_res := jsonb_build_object('id', t.id, 'status', 'received', 'still_in_transit', v_left);
  return app.request_done(p_client_request_id, 'receive_transfer', v_res);
end $$;

-- Settle differences after receipt. p: {found: [{item_id, good_qty, damaged_qty}], returned: [{item_id, qty}], note}
-- Returned goods go back to quarantine at the sending place. When nothing is left in transit the transfer is reconciled.
create or replace function api.reconcile_transfer(p_client_request_id uuid, p_transfer_id uuid, p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; t inv.transfers; c jsonb; i inv.transfer_items; v_left numeric; v_date date := current_date; v_status text;
begin
  v_prev := app.request_seen(p_client_request_id, 'reconcile_transfer'); if v_prev is not null then return v_prev; end if;
  t := app.lock_transfer(p_transfer_id, array['received'], 'transfer.approve');
  perform app.check_stock_date(t.company_id, v_date);
  for c in select * from jsonb_array_elements(coalesce(p -> 'found', '[]'::jsonb)) loop
    select * into i from inv.transfer_items where id = (c ->> 'item_id')::uuid and transfer_id = t.id for update;
    if i.id is null then perform app.raise_rule('transfer.line_missing', 'item not on this transfer', '22023'); end if;
    perform app.transfer_receive_item(t, i, coalesce((c ->> 'good_qty')::numeric, 0), coalesce((c ->> 'damaged_qty')::numeric, 0), v_date);
  end loop;
  for c in select * from jsonb_array_elements(coalesce(p -> 'returned', '[]'::jsonb)) loop
    select * into i from inv.transfer_items where id = (c ->> 'item_id')::uuid and transfer_id = t.id for update;
    if i.id is null then perform app.raise_rule('transfer.line_missing', 'item not on this transfer', '22023'); end if;
    if coalesce((c ->> 'qty')::numeric, 0) <= 0 or (c ->> 'qty')::numeric > i.qty_in_transit then
      perform app.raise_rule('transfer.return_exceeds', 'return at most what is still in transit', '22023');
    end if;
    perform app.stock_post(t.company_id, i.product_id, i.lot_id, t.to_place_id, 'in_transit', -(c ->> 'qty')::numeric, 'transfer_return', 'inv.transfers', t.id, t.doc_no, v_date, i.unit_cost);
    perform app.stock_post(t.company_id, i.product_id, i.lot_id, t.from_place_id, 'quarantine', (c ->> 'qty')::numeric, 'transfer_return', 'inv.transfers', t.id, t.doc_no, v_date, i.unit_cost, 'Returned from transfer');
    update inv.transfer_items set qty_returned = qty_returned + (c ->> 'qty')::numeric where id = i.id;
  end loop;
  select coalesce(sum(qty_in_transit), 0) into v_left from inv.transfer_items where transfer_id = t.id;
  v_status := case when v_left = 0 then 'reconciled' else 'received' end;
  update inv.transfers set status = v_status, reconciled_by = case when v_left = 0 then auth.uid() end, reconciled_at = case when v_left = 0 then now() end where id = t.id;
  perform app.transfer_event(t.id, 'reconcile', t.status, v_status, jsonb_build_object('still_in_transit', v_left, 'note', p ->> 'note'));
  v_res := jsonb_build_object('id', t.id, 'status', v_status, 'still_in_transit', v_left);
  return app.request_done(p_client_request_id, 'reconcile_transfer', v_res);
end $$;

-- Finance writes off a shortage (never the picker, carrier or receiver). p_items: [{item_id, qty}]
create or replace function api.write_off_transfer_shortage(p_client_request_id uuid, p_transfer_id uuid, p_items jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; t inv.transfers; c jsonb; i inv.transfer_items; v_date date := current_date; v_left numeric; v_total numeric := 0;
begin
  v_prev := app.request_seen(p_client_request_id, 'write_off_transfer_shortage'); if v_prev is not null then return v_prev; end if;
  t := app.lock_transfer(p_transfer_id, array['received'], 'transfer.write_off');
  if auth.uid() in (t.picked_by, t.carried_by, t.received_by) then
    perform app.raise_rule('sod.write_off', 'a shortage is never written off by the picker, the carrier or the receiver', '42501');
  end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'give the reason for the write-off', '22023'); end if;
  perform app.check_stock_date(t.company_id, v_date);
  for c in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    select * into i from inv.transfer_items where id = (c ->> 'item_id')::uuid and transfer_id = t.id for update;
    if i.id is null then perform app.raise_rule('transfer.line_missing', 'item not on this transfer', '22023'); end if;
    if coalesce((c ->> 'qty')::numeric, 0) <= 0 or (c ->> 'qty')::numeric > i.qty_in_transit then
      perform app.raise_rule('transfer.write_off_exceeds', 'write off at most what is still in transit', '22023');
    end if;
    perform app.stock_post(t.company_id, i.product_id, i.lot_id, t.to_place_id, 'in_transit', -(c ->> 'qty')::numeric, 'write_off', 'inv.transfers', t.id, t.doc_no, v_date, i.unit_cost,
                           'Shortage written off: ' || trim(p_reason));
    update inv.transfer_items set qty_lost = qty_lost + (c ->> 'qty')::numeric where id = i.id;
    v_total := v_total + (c ->> 'qty')::numeric;
  end loop;
  select coalesce(sum(qty_in_transit), 0) into v_left from inv.transfer_items where transfer_id = t.id;
  perform app.transfer_event(t.id, 'write_off', t.status, t.status, jsonb_build_object('qty', v_total, 'reason', p_reason, 'still_in_transit', v_left));
  v_res := jsonb_build_object('id', t.id, 'written_off', v_total, 'still_in_transit', v_left);
  return app.request_done(p_client_request_id, 'write_off_transfer_shortage', v_res);
end $$;

-- Close: every unit accounted for (dispatched = accepted + quarantined + returned + approved loss, nothing in transit).
-- Never by the picker or the carrier.
create or replace function api.close_transfer(p_client_request_id uuid, p_transfer_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; t inv.transfers; v_bad int; v_left numeric;
begin
  v_prev := app.request_seen(p_client_request_id, 'close_transfer'); if v_prev is not null then return v_prev; end if;
  t := app.lock_transfer(p_transfer_id, array['received', 'reconciled'], 'transfer.close');
  if auth.uid() = t.picked_by then perform app.raise_rule('sod.picker_close', 'the picker cannot close the transfer', '42501'); end if;
  if auth.uid() = t.carried_by then perform app.raise_rule('sod.picker_close', 'the carrier cannot close the transfer', '42501'); end if;
  select count(*) filter (where qty_dispatched <> qty_accepted + qty_quarantined + qty_returned + qty_lost + qty_in_transit), coalesce(sum(qty_in_transit), 0)
    into v_bad, v_left from inv.transfer_items where transfer_id = t.id;
  if v_bad > 0 or v_left <> 0 then
    perform app.raise_rule('transfer.unbalanced', format('%s still in transit: find, return or write it off before closing', v_left), 'P0001');
  end if;
  update inv.transfers set status = 'closed', closed_by = auth.uid(), closed_at = now(),
         reconciled_by = coalesce(reconciled_by, auth.uid()), reconciled_at = coalesce(reconciled_at, now()) where id = t.id;
  perform app.transfer_event(t.id, 'closed', t.status, 'closed');
  v_res := jsonb_build_object('id', t.id, 'status', 'closed');
  return app.request_done(p_client_request_id, 'close_transfer', v_res);
end $$;

-- Cancel before dispatch (the requester, or someone with transfer.approve). Reservations are released.
create or replace function api.cancel_transfer(p_client_request_id uuid, p_transfer_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; t inv.transfers;
begin
  v_prev := app.request_seen(p_client_request_id, 'cancel_transfer'); if v_prev is not null then return v_prev; end if;
  select * into t from inv.transfers where id = p_transfer_id for update;
  if t.id is null then perform app.raise_rule('transfer.missing', 'transfer not found', 'P0002'); end if;
  if t.requested_by = auth.uid() then perform app.require(t.company_id, 'transfer.create'); else perform app.require(t.company_id, 'transfer.approve'); end if;
  if t.status not in ('requested', 'approved', 'reserved', 'picked', 'handed_over') then perform app.raise_rule('transfer.state', 'goods have left; reconcile instead of cancelling', '22023'); end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'reason required', '22023'); end if;
  update inv.reservations set status = 'released', closed_at = now() where source_id = t.id and status = 'active';
  update inv.transfers set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = trim(p_reason) where id = t.id;
  perform app.transfer_event(t.id, 'cancelled', t.status, 'cancelled', jsonb_build_object('reason', p_reason));
  v_res := jsonb_build_object('id', t.id, 'status', 'cancelled');
  return app.request_done(p_client_request_id, 'cancel_transfer', v_res);
end $$;

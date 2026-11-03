-- 20261103004100_inventory_api.sql
-- Phase 4 inventory RPCs: item stock flags, reorder levels, negative-stock allowances (Admin, logged), opening
-- stock, issue/return to production or a cost centre, blind cycle counts posted by someone else, regrind and
-- scrap entries (Plastics), scrap sales against a posted GST invoice, incoming tests and quarantine release
-- (tester and releaser are never the receiver). Every RPC: security definer, client_request_id first,
-- idempotent, rights + state + period + stock checked, history by triggers. Additive.

-- ─────────── Set-up ───────────
-- p: {needs_incoming_test boolean, is_scrap boolean}
create or replace function api.set_item_stock_settings(p_client_request_id uuid, p_product_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_item_stock_settings'); if v_prev is not null then return v_prev; end if;
  perform app.require(null, 'products.manage');
  perform 1 from master.products where id = p_product_id for update;
  if not found then perform app.raise_rule('product.missing', 'item not found', 'P0002'); end if;
  update master.products set
    needs_incoming_test = coalesce((p ->> 'needs_incoming_test')::boolean, needs_incoming_test),
    is_scrap = coalesce((p ->> 'is_scrap')::boolean, is_scrap)
  where id = p_product_id;
  v_res := jsonb_build_object('id', p_product_id);
  return app.request_done(p_client_request_id, 'set_item_stock_settings', v_res);
end $$;

-- p: {company_id, product_id, place_id (null = all places), min_qty, reorder_qty, max_qty}
create or replace function api.set_reorder_level(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_place uuid := nullif(p ->> 'place_id', '')::uuid; v_id uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_reorder_level'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'inventory.edit');
  if v_place is not null and not exists (select 1 from core.places where id = v_place and company_id = v_company) then
    perform app.raise_rule('stock.place_other_company', 'the place belongs to another company', '22023');
  end if;
  insert into inv.reorder_levels (company_id, product_id, place_id, min_qty, reorder_qty, max_qty, set_by)
  values (v_company, (p ->> 'product_id')::uuid, v_place, round((p ->> 'min_qty')::numeric, 3), nullif(p ->> 'reorder_qty', '')::numeric, nullif(p ->> 'max_qty', '')::numeric, auth.uid())
  on conflict (company_id, product_id, place_id) do update set min_qty = excluded.min_qty, reorder_qty = excluded.reorder_qty, max_qty = excluded.max_qty,
    set_by = excluded.set_by, set_at = now()
  returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'set_reorder_level', v_res);
end $$;

-- Admin only (settings.manage). p: {company_id, product_id, place_id (null = all places), reason, valid_to}
create or replace function api.set_negative_stock_allowance(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_id uuid; v_place uuid := nullif(p ->> 'place_id', '')::uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_negative_stock_allowance'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'settings.manage');
  if coalesce(length(trim(p ->> 'reason')), 0) < 5 then perform app.raise_rule('rights.reason_required', 'give the reason negative stock is allowed', '22023'); end if;
  if v_place is not null and not exists (select 1 from core.places where id = v_place and company_id = v_company) then
    perform app.raise_rule('stock.place_other_company', 'the place belongs to another company', '22023');
  end if;
  insert into inv.negative_stock_allowances (company_id, product_id, place_id, reason, valid_to, granted_by)
  values (v_company, (p ->> 'product_id')::uuid, v_place, trim(p ->> 'reason'), nullif(p ->> 'valid_to', '')::timestamptz, auth.uid())
  returning id into v_id;
  perform app.log_event('setting_changed', jsonb_build_object('entity', 'negative_stock_allowance', 'id', v_id, 'company_id', v_company, 'product_id', p ->> 'product_id',
                                                             'place_id', v_place, 'reason', p ->> 'reason'));
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'set_negative_stock_allowance', v_res);
end $$;

create or replace function api.revoke_negative_stock_allowance(p_client_request_id uuid, p_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; a inv.negative_stock_allowances;
begin
  v_prev := app.request_seen(p_client_request_id, 'revoke_negative_stock_allowance'); if v_prev is not null then return v_prev; end if;
  select * into a from inv.negative_stock_allowances where id = p_id for update;
  if a.id is null then perform app.raise_rule('stock.allowance_missing', 'allowance not found', 'P0002'); end if;
  perform app.require(a.company_id, 'settings.manage');
  if a.revoked_at is not null then perform app.raise_rule('stock.allowance_revoked', 'already stopped', '22023'); end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'reason required', '22023'); end if;
  update inv.negative_stock_allowances set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = trim(p_reason) where id = a.id;
  perform app.log_event('setting_changed', jsonb_build_object('entity', 'negative_stock_allowance', 'id', a.id, 'revoked', true, 'reason', p_reason));
  v_res := jsonb_build_object('id', a.id);
  return app.request_done(p_client_request_id, 'revoke_negative_stock_allowance', v_res);
end $$;

-- Opening stock (cut-over from Tally). p: {company_id, place_id, date, lines: [{product_id, qty, unit_cost, lot_no, expiry_date, mfg_date}]}
create or replace function api.post_opening_stock(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_place uuid := (p ->> 'place_id')::uuid; v_date date := coalesce(nullif(p ->> 'date', '')::date, current_date);
        l jsonb; v_lot uuid; v_n int := 0;
begin
  v_prev := app.request_seen(p_client_request_id, 'post_opening_stock'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'inventory.approve');
  perform app.check_stock_date(v_company, v_date);
  for l in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    if coalesce((l ->> 'qty')::numeric, 0) <= 0 then perform app.raise_rule('stock.qty', 'every line needs a quantity above zero', '22023'); end if;
    v_lot := null;
    if nullif(l ->> 'lot_no', '') is not null then
      insert into inv.lots (company_id, product_id, lot_no, expiry_date, mfg_date, source, status, received_by)
      values (v_company, (l ->> 'product_id')::uuid, trim(l ->> 'lot_no'), nullif(l ->> 'expiry_date', '')::date, nullif(l ->> 'mfg_date', '')::date, 'opening', 'available', auth.uid())
      on conflict (company_id, product_id, lot_no) do update set lot_no = excluded.lot_no
      returning id into v_lot;
    end if;
    perform app.stock_post(v_company, (l ->> 'product_id')::uuid, v_lot, v_place, 'available', (l ->> 'qty')::numeric, 'opening', 'inv.opening', null, 'OPENING', v_date,
                           coalesce(nullif(l ->> 'unit_cost', '')::numeric, 0), 'Opening stock');
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then perform app.raise_rule('doc.no_lines', 'add at least one line', '22023'); end if;
  v_res := jsonb_build_object('lines', v_n);
  return app.request_done(p_client_request_id, 'post_opening_stock', v_res);
end $$;

-- ─────────── Issue and return ───────────
-- Issue from released (available) stock, earliest expiry first unless a lot is given.
-- p_target: {kind production|cost_centre|batch|job|maintenance|other, ref, cost_centre, to_place_id (move into a line/WIP place
--            instead of consuming), date, reason}
create or replace function api.issue_stock(p_client_request_id uuid, p_item_id uuid, p_lot_id uuid, p_from_place uuid, p_qty numeric, p_target jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_res jsonb; v_company uuid; v_date date := coalesce(nullif(p_target ->> 'date', '')::date, current_date); v_no text; v_id uuid;
  v_pieces jsonb; pc jsonb; v_to uuid := nullif(p_target ->> 'to_place_id', '')::uuid; v_kind text := coalesce(nullif(p_target ->> 'kind', ''), 'production');
begin
  v_prev := app.request_seen(p_client_request_id, 'issue_stock'); if v_prev is not null then return v_prev; end if;
  select company_id into v_company from core.places where id = p_from_place;
  if v_company is null then perform app.raise_rule('stock.place_missing', 'choose the store to issue from', '22023'); end if;
  perform app.require(v_company, 'inventory.create');
  if coalesce(p_qty, 0) <= 0 then perform app.raise_rule('stock.qty', 'the quantity must be above zero', '22023'); end if;
  if v_kind not in ('production', 'cost_centre', 'batch', 'job', 'maintenance', 'other') then perform app.raise_rule('stock.target', 'say what the issue is for', '22023'); end if;
  if v_to is not null and not exists (select 1 from core.places where id = v_to and company_id = v_company) then
    perform app.raise_rule('stock.place_other_company', 'the place belongs to another company', '22023');
  end if;
  if v_to = p_from_place then perform app.raise_rule('stock.same_place', 'issue to another place', '22023'); end if;
  if p_lot_id is not null and exists (select 1 from inv.lots where id = p_lot_id and status <> 'available') then
    perform app.raise_rule('stock.lot_not_released', 'this lot is not released for use', 'P0001');
  end if;
  perform app.check_stock_date(v_company, v_date);
  v_no := app.internal_doc_no(v_company, 'stock_issue', v_date);
  insert into inv.stock_issues (company_id, doc_no, kind, product_id, lot_id, from_place_id, to_place_id, qty, target_kind, target_ref, cost_centre, reason, issue_date, created_by)
  values (v_company, v_no, 'issue', p_item_id, p_lot_id, p_from_place, v_to, round(p_qty, 3), v_kind, nullif(p_target ->> 'ref', ''), nullif(p_target ->> 'cost_centre', ''),
          nullif(p_target ->> 'reason', ''), v_date, auth.uid())
  returning id into v_id;
  v_pieces := app.stock_take(v_company, p_item_id, p_lot_id, p_from_place, 'available', p_qty, 'issue', 'inv.stock_issues', v_id, v_no, v_date, nullif(p_target ->> 'reason', ''));
  if v_to is not null then
    for pc in select * from jsonb_array_elements(v_pieces) loop
      perform app.stock_post(v_company, p_item_id, nullif(pc ->> 'lot_id', '')::uuid, v_to, 'available', (pc ->> 'qty')::numeric, 'issue_in', 'inv.stock_issues', v_id, v_no, v_date,
                             (pc ->> 'unit_cost')::numeric, nullif(p_target ->> 'reason', ''));
    end loop;
  end if;
  v_res := jsonb_build_object('issue_id', v_id, 'doc_no', v_no, 'pieces', v_pieces);
  return app.request_done(p_client_request_id, 'issue_stock', v_res);
end $$;

-- Return unused material. p: {issue_id (optional), company_id, product_id, lot_id, from_place_id (where it is now, if it was moved there),
--   to_place_id, qty, bucket available|quarantine (default quarantine for anything that left the stores), reason, date}
create or replace function api.return_stock(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_res jsonb; i inv.stock_issues; v_company uuid := nullif(p ->> 'company_id', '')::uuid; v_product uuid := nullif(p ->> 'product_id', '')::uuid;
  v_lot uuid := nullif(p ->> 'lot_id', '')::uuid; v_from uuid := nullif(p ->> 'from_place_id', '')::uuid; v_to uuid := (p ->> 'to_place_id')::uuid;
  v_qty numeric := round((p ->> 'qty')::numeric, 3); v_bucket text := coalesce(nullif(p ->> 'bucket', ''), 'quarantine'); v_date date := coalesce(nullif(p ->> 'date', '')::date, current_date);
  v_returned numeric; v_no text; v_id uuid; v_pieces jsonb; pc jsonb; v_cost numeric;
begin
  v_prev := app.request_seen(p_client_request_id, 'return_stock'); if v_prev is not null then return v_prev; end if;
  if nullif(p ->> 'issue_id', '') is not null then
    select * into i from inv.stock_issues where id = (p ->> 'issue_id')::uuid and kind = 'issue';
    if i.id is null then perform app.raise_rule('stock.issue_missing', 'issue not found', 'P0002'); end if;
    v_company := i.company_id; v_product := i.product_id; v_lot := coalesce(v_lot, i.lot_id); v_from := coalesce(v_from, i.to_place_id);
  end if;
  perform app.require(v_company, 'inventory.create');
  if coalesce(v_qty, 0) <= 0 then perform app.raise_rule('stock.qty', 'the quantity must be above zero', '22023'); end if;
  if v_bucket not in ('available', 'quarantine') then perform app.raise_rule('stock.bucket', 'returns go to stores or to quarantine', '22023'); end if;
  if not exists (select 1 from core.places where id = v_to and company_id = v_company) then perform app.raise_rule('stock.place_other_company', 'the place belongs to another company', '22023'); end if;
  if i.id is not null then
    perform 1 from inv.stock_issues where id = i.id for update;
    select coalesce(sum(qty), 0) into v_returned from inv.stock_issues where against_issue_id = i.id and kind = 'return';
    if v_returned + v_qty > i.qty then perform app.raise_rule('stock.return_exceeds', format('only %s of this issue is still out', i.qty - v_returned), '22023'); end if;
  end if;
  perform app.check_stock_date(v_company, v_date);
  v_no := app.internal_doc_no(v_company, 'stock_issue', v_date);
  insert into inv.stock_issues (company_id, doc_no, kind, product_id, lot_id, from_place_id, to_place_id, qty, target_kind, target_ref, against_issue_id, bucket, reason, issue_date, created_by)
  values (v_company, v_no, 'return', v_product, v_lot, v_from, v_to, v_qty, coalesce(i.target_kind, 'production'), i.target_ref, i.id, v_bucket, nullif(p ->> 'reason', ''), v_date, auth.uid())
  returning id into v_id;
  if v_from is not null then
    v_pieces := app.stock_take(v_company, v_product, v_lot, v_from, 'available', v_qty, 'return', 'inv.stock_issues', v_id, v_no, v_date, nullif(p ->> 'reason', ''));
    for pc in select * from jsonb_array_elements(v_pieces) loop
      perform app.stock_post(v_company, v_product, nullif(pc ->> 'lot_id', '')::uuid, v_to, v_bucket, (pc ->> 'qty')::numeric, 'return', 'inv.stock_issues', v_id, v_no, v_date,
                             (pc ->> 'unit_cost')::numeric, nullif(p ->> 'reason', ''));
    end loop;
  else
    select unit_cost into v_cost from inv.stock_ledger where source_table = 'inv.stock_issues' and source_id = i.id and qty < 0 order by id limit 1;
    perform app.stock_post(v_company, v_product, v_lot, v_to, v_bucket, v_qty, 'return', 'inv.stock_issues', v_id, v_no, v_date, v_cost, nullif(p ->> 'reason', ''));
  end if;
  v_res := jsonb_build_object('return_id', v_id, 'doc_no', v_no);
  return app.request_done(p_client_request_id, 'return_stock', v_res);
end $$;

-- ─────────── Cycle counts ───────────
-- p: {company_id, place_id, product_ids: [uuid] (optional; default every item with stock at the place), blind (default true), date, note}
create or replace function api.start_stock_count(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_place uuid := (p ->> 'place_id')::uuid; v_date date := coalesce(nullif(p ->> 'date', '')::date, current_date);
        v_id uuid; v_no text; v_n int; v_products uuid[];
begin
  v_prev := app.request_seen(p_client_request_id, 'start_stock_count'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'inventory.edit');
  if not exists (select 1 from core.places where id = v_place and company_id = v_company) then perform app.raise_rule('stock.place_other_company', 'the place belongs to another company', '22023'); end if;
  if jsonb_typeof(p -> 'product_ids') = 'array' then
    select array_agg(x::uuid) into v_products from jsonb_array_elements_text(p -> 'product_ids') x;
  end if;
  v_no := app.internal_doc_no(v_company, 'stock_count', v_date);
  insert into inv.cycle_counts (company_id, place_id, doc_no, count_date, blind, note, created_by)
  values (v_company, v_place, v_no, v_date, coalesce((p ->> 'blind')::boolean, true), nullif(p ->> 'note', ''), auth.uid())
  returning id into v_id;
  insert into inv.count_lines (count_id, product_id, lot_id, bucket, system_qty)
  select v_id, b.product_id, b.lot_id, b.bucket, b.qty from inv.stock_balances b
   where b.company_id = v_company and b.place_id = v_place and b.bucket in ('available', 'quarantine', 'hold', 'rejected')
     and (v_products is null or b.product_id = any (v_products)) and (b.qty <> 0 or v_products is not null);
  if v_products is not null then
    insert into inv.count_lines (count_id, product_id, lot_id, bucket, system_qty)
    select v_id, x, null, 'available', 0 from unnest(v_products) x
    where not exists (select 1 from inv.count_lines c where c.count_id = v_id and c.product_id = x)
    on conflict do nothing;
  end if;
  select count(*) into v_n from inv.count_lines where count_id = v_id;
  v_res := jsonb_build_object('id', v_id, 'doc_no', v_no, 'lines', v_n);
  return app.request_done(p_client_request_id, 'start_stock_count', v_res);
end $$;

-- p_lines: [{line_id} or {product_id, lot_id, bucket}, counted_qty, reason]. Counters do not see the system quantity (blind).
create or replace function api.record_stock_count(p_client_request_id uuid, p_count_id uuid, p_lines jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; c inv.cycle_counts; l jsonb; v_line uuid; v_n int := 0; v_sys numeric;
begin
  v_prev := app.request_seen(p_client_request_id, 'record_stock_count'); if v_prev is not null then return v_prev; end if;
  select * into c from inv.cycle_counts where id = p_count_id for update;
  if c.id is null then perform app.raise_rule('count.missing', 'count not found', 'P0002'); end if;
  perform app.require(c.company_id, 'inventory.create');
  if c.status <> 'counting' then perform app.raise_rule('count.state', 'this count is no longer open for counting', '22023'); end if;
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    if (l ->> 'counted_qty') is null or (l ->> 'counted_qty')::numeric < 0 then perform app.raise_rule('count.qty', 'enter the counted quantity (zero or more)', '22023'); end if;
    v_line := nullif(l ->> 'line_id', '')::uuid;
    if v_line is null then
      select id into v_line from inv.count_lines where count_id = c.id and product_id = (l ->> 'product_id')::uuid
         and lot_id is not distinct from nullif(l ->> 'lot_id', '')::uuid and bucket = coalesce(nullif(l ->> 'bucket', ''), 'available');
      if v_line is null then
        -- Found an item that was not on the list: its system quantity is taken now.
        select coalesce(sum(qty), 0) into v_sys from inv.stock_balances where company_id = c.company_id and place_id = c.place_id and product_id = (l ->> 'product_id')::uuid
           and lot_id is not distinct from nullif(l ->> 'lot_id', '')::uuid and bucket = coalesce(nullif(l ->> 'bucket', ''), 'available');
        insert into inv.count_lines (count_id, product_id, lot_id, bucket, system_qty)
        values (c.id, (l ->> 'product_id')::uuid, nullif(l ->> 'lot_id', '')::uuid, coalesce(nullif(l ->> 'bucket', ''), 'available'), v_sys)
        returning id into v_line;
      end if;
    end if;
    update inv.count_lines set counted_qty = round((l ->> 'counted_qty')::numeric, 3), counted_by = auth.uid(), counted_at = now(), reason = nullif(l ->> 'reason', '')
     where id = v_line and count_id = c.id;
    if not found then perform app.raise_rule('count.line_missing', 'line not on this count', '22023'); end if;
    v_n := v_n + 1;
  end loop;
  v_res := jsonb_build_object('id', c.id, 'counted', v_n);
  return app.request_done(p_client_request_id, 'record_stock_count', v_res);
end $$;

create or replace function api.submit_stock_count(p_client_request_id uuid, p_count_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; c inv.cycle_counts; v_open int;
begin
  v_prev := app.request_seen(p_client_request_id, 'submit_stock_count'); if v_prev is not null then return v_prev; end if;
  select * into c from inv.cycle_counts where id = p_count_id for update;
  if c.id is null then perform app.raise_rule('count.missing', 'count not found', 'P0002'); end if;
  perform app.require(c.company_id, 'inventory.create');
  if c.status <> 'counting' then perform app.raise_rule('count.state', 'this count is not open', '22023'); end if;
  select count(*) into v_open from inv.count_lines where count_id = c.id and counted_qty is null;
  if v_open > 0 then perform app.raise_rule('count.incomplete', v_open || ' lines are not counted yet', '22023'); end if;
  update inv.cycle_counts set status = 'submitted', submitted_by = auth.uid(), submitted_at = now() where id = c.id;
  v_res := jsonb_build_object('id', c.id, 'status', 'submitted');
  return app.request_done(p_client_request_id, 'submit_stock_count', v_res);
end $$;

-- Post the differences (counted − system quantity at the start of the count) as adjustments. Needs inventory.approve,
-- by someone who did not count or submit it.
create or replace function api.post_stock_count(p_client_request_id uuid, p_count_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; c inv.cycle_counts; l record; v_n int := 0;
begin
  v_prev := app.request_seen(p_client_request_id, 'post_stock_count'); if v_prev is not null then return v_prev; end if;
  select * into c from inv.cycle_counts where id = p_count_id for update;
  if c.id is null then perform app.raise_rule('count.missing', 'count not found', 'P0002'); end if;
  perform app.require(c.company_id, 'inventory.approve');
  if c.status <> 'submitted' then perform app.raise_rule('count.state', 'submit the count before posting it', '22023'); end if;
  if auth.uid() = c.submitted_by or exists (select 1 from inv.count_lines where count_id = c.id and counted_by = auth.uid()) then
    perform app.raise_rule('sod.own_count', 'someone who did not count this place must approve the differences', '42501');
  end if;
  perform app.check_stock_date(c.company_id, c.count_date);
  for l in select * from inv.count_lines where count_id = c.id and counted_qty <> system_qty loop
    perform app.stock_post(c.company_id, l.product_id, l.lot_id, c.place_id, l.bucket, l.counted_qty - l.system_qty, 'adjustment', 'inv.cycle_counts', c.id, c.doc_no, c.count_date,
                           null, coalesce(l.reason, 'Stock count difference'));
    v_n := v_n + 1;
  end loop;
  update inv.cycle_counts set status = 'posted', approved_by = auth.uid(), posted_at = now() where id = c.id;
  v_res := jsonb_build_object('id', c.id, 'adjustments', v_n);
  return app.request_done(p_client_request_id, 'post_stock_count', v_res);
end $$;

create or replace function api.cancel_stock_count(p_client_request_id uuid, p_count_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; c inv.cycle_counts;
begin
  v_prev := app.request_seen(p_client_request_id, 'cancel_stock_count'); if v_prev is not null then return v_prev; end if;
  select * into c from inv.cycle_counts where id = p_count_id for update;
  if c.id is null then perform app.raise_rule('count.missing', 'count not found', 'P0002'); end if;
  perform app.require(c.company_id, 'inventory.edit');
  if c.status not in ('counting', 'submitted') then perform app.raise_rule('count.state', 'a posted count cannot be cancelled', '22023'); end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'reason required', '22023'); end if;
  update inv.cycle_counts set status = 'cancelled', note = coalesce(note || ' · ', '') || 'Cancelled: ' || trim(p_reason) where id = c.id;
  v_res := jsonb_build_object('id', c.id, 'status', 'cancelled');
  return app.request_done(p_client_request_id, 'cancel_stock_count', v_res);
end $$;

-- ─────────── Regrind and scrap (Plastics) ───────────
-- p: {company_id, kind scrap_in|regrind_reuse, product_id (scrap item), source_product_id, place_id, qty, machine, mould, shift, date, note}
create or replace function api.record_regrind(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_kind text := p ->> 'kind'; v_product uuid := (p ->> 'product_id')::uuid;
        v_place uuid := (p ->> 'place_id')::uuid; v_qty numeric := round((p ->> 'qty')::numeric, 3); v_date date := coalesce(nullif(p ->> 'date', '')::date, current_date); v_id uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'record_regrind'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'inventory.create');
  if v_kind not in ('scrap_in', 'regrind_reuse') then perform app.raise_rule('scrap.kind', 'weigh in scrap or reuse regrind', '22023'); end if;
  if coalesce(v_qty, 0) <= 0 then perform app.raise_rule('stock.qty', 'the weight must be above zero', '22023'); end if;
  if not exists (select 1 from master.products where id = v_product and is_scrap) then perform app.raise_rule('scrap.not_scrap_item', 'choose a scrap or regrind item', '22023'); end if;
  perform app.check_stock_date(v_company, v_date);
  insert into prod.regrind_entries (company_id, entry_date, kind, product_id, source_product_id, place_id, qty, machine, mould, shift, note, recorded_by)
  values (v_company, v_date, v_kind, v_product, nullif(p ->> 'source_product_id', '')::uuid, v_place, v_qty, nullif(p ->> 'machine', ''), nullif(p ->> 'mould', ''),
          nullif(p ->> 'shift', ''), nullif(p ->> 'note', ''), auth.uid())
  returning id into v_id;
  if v_kind = 'scrap_in' then
    perform app.stock_post(v_company, v_product, null, v_place, 'available', v_qty, 'scrap_in', 'prod.regrind_entries', v_id, null, v_date, 0, nullif(p ->> 'note', ''));
  else
    perform app.stock_take(v_company, v_product, null, v_place, 'available', v_qty, 'regrind', 'prod.regrind_entries', v_id, null, v_date, nullif(p ->> 'note', ''));
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'record_regrind', v_res);
end $$;

-- Scrap sale: the GST invoice is made on the normal sales screen (buyer with KYC); this takes the scrap lines of that
-- posted invoice out of stock once. p: {sales_document_id, place_id, slip_path, date}
create or replace function api.post_scrap_sale(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; d sales.documents; v_place uuid := (p ->> 'place_id')::uuid; v_id uuid; l record; v_total numeric := 0;
begin
  v_prev := app.request_seen(p_client_request_id, 'post_scrap_sale'); if v_prev is not null then return v_prev; end if;
  select * into d from sales.documents where id = (p ->> 'sales_document_id')::uuid for update;
  if d.id is null then perform app.raise_rule('scrap.no_invoice', 'choose the posted GST invoice for this scrap sale', '22023'); end if;
  perform app.require(d.company_id, 'inventory.create');
  if d.status <> 'posted' or d.doc_type <> 'sales_invoice' then perform app.raise_rule('scrap.no_invoice', 'a scrap sale needs a posted tax invoice', '22023'); end if;
  if exists (select 1 from inv.scrap_sales where sales_document_id = d.id) then perform app.raise_rule('scrap.already_out', 'stock for this invoice is already out', '22023'); end if;
  if not exists (select 1 from core.places where id = v_place and company_id = d.company_id) then perform app.raise_rule('stock.place_other_company', 'the place belongs to another company', '22023'); end if;
  select coalesce(sum(x.qty), 0) into v_total from sales.document_lines x join master.products pr on pr.id = x.product_id where x.document_id = d.id and pr.is_scrap;
  if v_total <= 0 then perform app.raise_rule('scrap.no_scrap_lines', 'the invoice has no scrap items', '22023'); end if;
  insert into inv.scrap_sales (company_id, sales_document_id, place_id, slip_path, qty, sold_by) values (d.company_id, d.id, v_place, nullif(p ->> 'slip_path', ''), v_total, auth.uid())
  returning id into v_id;
  for l in select x.product_id, sum(x.qty) as qty from sales.document_lines x join master.products pr on pr.id = x.product_id
           where x.document_id = d.id and pr.is_scrap group by x.product_id loop
    perform app.stock_take(d.company_id, l.product_id, null, v_place, 'available', l.qty, 'scrap_sale', 'inv.scrap_sales', v_id, d.doc_no, d.doc_date, 'Scrap sale ' || d.doc_no);
  end loop;
  v_res := jsonb_build_object('id', v_id, 'qty', v_total);
  return app.request_done(p_client_request_id, 'post_scrap_sale', v_res);
end $$;

-- ─────────── Incoming tests and quarantine ───────────
-- p_result: {result pass|fail|hold, parameters {}, remarks, date}. The tester is never the person who received the lot.
create or replace function api.record_incoming_test(p_client_request_id uuid, p_lot_id uuid, p_result jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; l inv.lots; v_id uuid; v_result text := p_result ->> 'result';
begin
  v_prev := app.request_seen(p_client_request_id, 'record_incoming_test'); if v_prev is not null then return v_prev; end if;
  select * into l from inv.lots where id = p_lot_id for update;
  if l.id is null then perform app.raise_rule('qc.lot_missing', 'lot not found', 'P0002'); end if;
  perform app.require(l.company_id, 'qc.test');
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

-- Move every quarantined unit of a lot (at every place) into the given status, under the balance locks.
create or replace function app.move_lot_out_of_quarantine(l inv.lots, p_to_bucket text, p_move text, p_note text) returns numeric
language plpgsql security definer set search_path = '' as $$
declare b record; v_total numeric := 0; v_cost numeric := app.avg_cost(l.company_id, l.product_id);
begin
  for b in select place_id, qty from inv.stock_balances where lot_id = l.id and bucket = 'quarantine' and qty > 0 loop
    perform app.stock_post(l.company_id, l.product_id, l.id, b.place_id, 'quarantine', -b.qty, p_move, 'inv.lots', l.id, l.lot_no, current_date, v_cost, p_note);
    perform app.stock_post(l.company_id, l.product_id, l.id, b.place_id, p_to_bucket, b.qty, p_move, 'inv.lots', l.id, l.lot_no, current_date, v_cost, p_note);
    v_total := v_total + b.qty;
  end loop;
  return v_total;
end $$;

-- Release after a passing test. The releaser is never the receiver.
create or replace function api.release_from_quarantine(p_client_request_id uuid, p_lot_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; l inv.lots; v_last text; v_qty numeric;
begin
  v_prev := app.request_seen(p_client_request_id, 'release_from_quarantine'); if v_prev is not null then return v_prev; end if;
  select * into l from inv.lots where id = p_lot_id for update;
  if l.id is null then perform app.raise_rule('qc.lot_missing', 'lot not found', 'P0002'); end if;
  perform app.require(l.company_id, 'qc.release');
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

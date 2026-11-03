-- 20261103006100_orders_credit_logistics.sql
-- Phase 6 RPCs: shared helpers (numbering, distance, list rates, credit exposure), sales orders with credit control,
-- the 7-stage credit application, MD exceptions, dispatch (invoice link, e-way bill), trips, proof of delivery,
-- failed deliveries and vehicles. Every changing RPC: api.* security definer, p_client_request_id first, idempotent,
-- row locks, rights / state / period / stock / credit checks, history via audit triggers. Additive.

-- ─────────── Helpers ───────────
-- Internal (non-GST) numbers for Phase 6 documents; the FY series is created on first use (Admin may change prefixes before use).
create or replace function app.p6_doc_no(p_company uuid, p_doc_type text, p_date date) returns text
language plpgsql security definer set search_path = '' as $$
declare v_fy uuid; v_prefix text;
begin
  select id into v_fy from core.financial_years where company_id = p_company and p_date between starts_on and ends_on;
  if v_fy is null then perform app.raise_rule('period.no_fy', 'no financial year is open for this date; open it on Settings', '22023'); end if;
  if not exists (select 1 from core.doc_series where company_id = p_company and gstin_id is null and doc_type = p_doc_type and fy_id = v_fy) then
    v_prefix := case p_doc_type when 'sales_order' then 'SO' when 'dispatch' then 'DL' when 'trip' then 'TRIP' when 'complaint' then 'CMP'
                  when 'export_order' then 'EXP' when 'credit_application' then 'CR' end;
    if v_prefix is null then perform app.raise_rule('numbering.no_series', 'no number series for ' || p_doc_type, 'P0001'); end if;
    insert into core.doc_series (company_id, gstin_id, doc_type, fy_id, prefix) values (p_company, null, p_doc_type, v_fy, v_prefix) on conflict do nothing;
  end if;
  return app.take_doc_number(p_company, null, p_doc_type, v_fy);
end $$;

-- Great-circle distance in metres (haversine, mean Earth radius 6 371 008.8 m). Used for the geofence.
create or replace function app.distance_m(p_lat1 numeric, p_lng1 numeric, p_lat2 numeric, p_lng2 numeric) returns numeric
language sql immutable set search_path = '' as $$
  select round((2 * 6371008.8 * asin(sqrt(
           power(sin(radians((p_lat2 - p_lat1)::float8) / 2), 2)
         + cos(radians(p_lat1::float8)) * cos(radians(p_lat2::float8)) * power(sin(radians((p_lng2 - p_lng1)::float8) / 2), 2))))::numeric, 1)
$$;

-- Derived uuid for nested idempotent calls (same parent request → same child request id).
create or replace function app.child_crid(p_crid uuid, p_tag text) returns uuid
language sql immutable set search_path = '' as $$ select md5(p_crid::text || ':' || p_tag)::uuid $$;

-- Net (before GST) rate of an item on a price list on a date for a quantity; a tax-inclusive list is converted with
-- the HSN rate in force on that date. Null when the item is not on the list.
create or replace function app.list_rate(p_price_list uuid, p_product uuid, p_date date, p_qty numeric) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare v_price numeric; v_incl boolean; v_rate numeric;
begin
  select i.price, l.tax_inclusive into v_price, v_incl
  from master.price_list_items i join master.price_lists l on l.id = i.price_list_id
  where i.price_list_id = p_price_list and i.product_id = p_product and i.effective_from <= p_date and i.min_qty <= coalesce(p_qty, 0) and l.active
  order by i.min_qty desc, i.effective_from desc limit 1;
  if v_price is null then return null; end if;
  if v_incl then
    select r.rate into v_rate from master.hsn_rates r join master.products p on p.hsn_code = r.hsn_code
     where p.id = p_product and r.effective_from <= p_date and (r.effective_to is null or r.effective_to >= p_date) order by r.effective_from desc limit 1;
    return round(v_price / (1 + coalesce(v_rate, 0) / 100), 2);
  end if;
  return v_price;
end $$;

-- Credit exposure of a customer in a company (all classes; the decision is always on the full exposure).
-- exposure = open receivables (posted invoices / bills of supply / opening bills still owed) + approved orders not yet billed.
create or replace function app.credit_exposure(p_company uuid, p_party uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_all numeric; v_gst numeric; v_orders numeric; v_exc numeric; v_limit numeric; v_status text; v_term text;
begin
  select coalesce(sum(x.open), 0), coalesce(sum(x.open) filter (where x.tax_class not in ('without_gst', 'unclassified')), 0) into v_all, v_gst
  from (select d.total - coalesce((select sum(a.amount) from acct.bill_allocations a where a.against_kind = 'sales_document' and a.against_id = d.id), 0) as open, d.tax_class
        from sales.documents d where d.company_id = p_company and d.party_id = p_party and d.status = 'posted' and d.doc_type in ('sales_invoice', 'bill_of_supply')
        union all
        select o.amount - coalesce((select sum(a.amount) from acct.bill_allocations a where a.against_kind = 'open_bill' and a.against_id = o.id), 0), o.tax_class
        from acct.open_bills o where o.company_id = p_company and o.party_id = p_party and o.dc = 'D') x
  where x.open > 0;
  select coalesce(sum(round((l.qty - l.qty_invoiced) * l.total / l.qty, 2)), 0) into v_orders
  from sales.orders o join sales.order_lines l on l.order_id = o.id
  where o.company_id = p_company and o.party_id = p_party and o.status in ('confirmed', 'part_dispatched', 'dispatched') and o.payment = 'credit';
  select coalesce(sum(e.amount), 0) into v_exc from sales.credit_exceptions e
   where e.company_id = p_company and e.party_id = p_party and e.revoked_at is null and now() < e.valid_until;
  select case when pc.credit_status = 'active' then coalesce(pc.credit_limit, 0) else 0 end, pc.credit_status, t.label
    into v_limit, v_status, v_term
  from master.party_companies pc left join master.credit_terms t on t.id = pc.credit_term_id where pc.company_id = p_company and pc.party_id = p_party;
  return jsonb_build_object('limit', coalesce(v_limit, 0), 'credit_status', coalesce(v_status, 'none'), 'terms', v_term, 'receivables', v_all, 'receivables_gst', v_gst,
    'open_orders', v_orders, 'exception', v_exc, 'exposure', v_all + v_orders, 'available', coalesce(v_limit, 0) + v_exc - v_all - v_orders);
end $$;

-- Exposure as one user may see it: Admin/CA the full figures; everyone else only GST figures plus the decision.
create or replace function app.credit_view(p_exp jsonb, p_extra numeric) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_blocked boolean := (p_exp ->> 'exposure')::numeric + coalesce(p_extra, 0) > (p_exp ->> 'limit')::numeric + (p_exp ->> 'exception')::numeric;
        v_vis numeric;
begin
  if app.current_view() in ('all', 'all-readonly') then
    return p_exp || jsonb_build_object('extra', coalesce(p_extra, 0), 'blocked', v_blocked, 'hidden_items', false);
  end if;
  v_vis := (p_exp ->> 'receivables_gst')::numeric + (p_exp ->> 'open_orders')::numeric;
  return jsonb_build_object('limit', p_exp -> 'limit', 'credit_status', p_exp -> 'credit_status', 'terms', p_exp -> 'terms', 'receivables', p_exp -> 'receivables_gst',
    'open_orders', p_exp -> 'open_orders', 'exception', p_exp -> 'exception', 'exposure', v_vis,
    'available', (p_exp ->> 'limit')::numeric + (p_exp ->> 'exception')::numeric - v_vis, 'extra', coalesce(p_extra, 0), 'blocked', v_blocked,
    'hidden_items', (p_exp ->> 'receivables')::numeric <> (p_exp ->> 'receivables_gst')::numeric);
end $$;

-- Read: exposure check for a customer (+ an extra amount, e.g. the order being typed).
create or replace function api.check_credit_exposure(p_company_id uuid, p_party_id uuid, p_extra numeric) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.can_sales_party(p_company_id, p_party_id) then perform app.raise_rule('rights.missing', 'you cannot see this customer', '42501'); end if;
  return app.credit_view(app.credit_exposure(p_company_id, p_party_id), coalesce(p_extra, 0));
end $$;

-- Reserve free stock for a confirmed order (line by line, only when the whole line is free at the place).
create or replace function app.reserve_order(p_order uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare o sales.orders; l record; v_free numeric; n int := 0;
begin
  select * into o from sales.orders where id = p_order;
  if o.place_id is null then return 0; end if;
  for l in select * from sales.order_lines where order_id = o.id loop
    perform pg_advisory_xact_lock(hashtextextended(o.company_id::text || '|' || l.product_id::text || '|' || o.place_id::text, 0));
    select coalesce(sum(qty), 0) into v_free from inv.stock_balances where company_id = o.company_id and product_id = l.product_id and place_id = o.place_id and bucket = 'available';
    v_free := v_free - coalesce((select sum(qty) from inv.reservations where company_id = o.company_id and product_id = l.product_id and place_id = o.place_id and status = 'active'), 0);
    if v_free >= l.qty then
      insert into inv.reservations (company_id, product_id, place_id, qty, source_table, source_id, source_line_id, created_by)
      values (o.company_id, l.product_id, o.place_id, l.qty, 'sales.orders', o.id, l.id, auth.uid());
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

create or replace function app.order_message(o sales.orders, p_event text, p_template text, p_stage text, p_params jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  return app.enqueue_message(jsonb_build_object('company_id', o.company_id, 'event', p_event, 'template', p_template, 'party_id', o.party_id,
    'doc_type', 'sales.orders', 'doc_id', o.id, 'stage', p_stage,
    'params', p_params || jsonb_build_object('customer', (select legal_name from master.parties where id = o.party_id), 'company', (select short_name from core.companies where id = o.company_id))));
end $$;

-- ─────────── Sales orders ───────────
-- p_header: {company_id, gstin_id, party_id, order_date, delivery_date, channel, payment credit|cash|advance, place_id, price_list_id,
--            place_of_supply, buyer_po_no, buyer_po_date, notes, private_label_id, device_created_at}
-- p_lines:  [{product_id, qty, rate, discount}]  — a salesman (field.sell only) never sets a price: the customer's price list rate applies.
create or replace function api.confirm_sales_order(p_client_request_id uuid, p_header jsonb, p_lines jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_company uuid := (p_header ->> 'company_id')::uuid; v_gstin core.gstins; v_party master.parties; pc master.party_companies;
  v_office boolean; v_date date := coalesce(nullif(p_header ->> 'order_date', '')::date, current_date); v_channel text := coalesce(p_header ->> 'channel', 'direct');
  v_payment text := coalesce(p_header ->> 'payment', 'credit'); v_pl uuid; v_lines jsonb := '[]'::jsonb; l jsonb; v_rate numeric; v_list numeric;
  v_disc_pct numeric; v_calc jsonb; v_pos text; v_id uuid; v_no text; v_status text; v_exp jsonb; v_mrp numeric; c jsonb; v_res jsonb; v_place uuid;
  v_pl_order sales.private_label_orders; v_reserved int := 0;
begin
  v_prev := app.request_seen(p_client_request_id, 'confirm_sales_order'); if v_prev is not null then return v_prev; end if;
  if v_channel not in ('direct', 'field', 'shop', 'online', 'export', 'private_label') then perform app.raise_rule('order.channel', 'unknown channel', '22023'); end if;
  if v_payment not in ('credit', 'cash', 'advance') then perform app.raise_rule('order.payment', 'payment is credit, cash or advance', '22023'); end if;
  select * into v_party from master.parties where id = (p_header ->> 'party_id')::uuid;
  if v_party.id is null or not v_party.is_customer or v_party.status <> 'active' then perform app.raise_rule('party.missing', 'choose an active customer', '22023'); end if;
  select * into pc from master.party_companies where party_id = v_party.id and company_id = v_company and is_customer;
  if pc.party_id is null then perform app.raise_rule('party.not_linked', 'this customer is not linked to the company', '22023'); end if;
  if app.can(v_company, 'sales.create') then v_office := true; perform app.require(v_company, 'sales.create');
  elsif app.can(v_company, 'field.sell') and pc.salesman_user_id = auth.uid() then v_office := false; perform app.require(v_company, 'field.sell');
  else perform app.raise_rule('rights.missing', 'you cannot take orders for this customer', '42501'); end if;
  if v_date > current_date + 1 then perform app.raise_rule('date.future', 'the order date is in the future', '22023'); end if;
  if v_payment = 'credit' and v_party.kyc_status <> 'verified' then
    perform app.raise_rule('order.kyc_cash_only', 'KYC is not complete: cash or advance orders only', '22023');
  end if;
  select * into v_gstin from core.gstins where id = coalesce(nullif(p_header ->> 'gstin_id', '')::uuid, (select id from core.gstins where company_id = v_company and is_principal limit 1)) and company_id = v_company;
  if v_gstin.id is null then perform app.raise_rule('org.gstin_other_company', 'choose a GSTIN of this company', '22023'); end if;
  v_place := nullif(p_header ->> 'place_id', '')::uuid;
  if v_place is not null and not exists (select 1 from core.places where id = v_place and company_id = v_company) then perform app.raise_rule('stock.place_other_company', 'the place belongs to another company', '22023'); end if;
  v_pl := coalesce(case when v_office then nullif(p_header ->> 'price_list_id', '')::uuid end, pc.price_list_id);
  v_disc_pct := coalesce((app.setting(v_company, 'sales.salesman_discount_pct'))::text::numeric, 0);
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    if nullif(l ->> 'product_id', '') is null then perform app.raise_rule('order.product', 'every line needs an item', '22023'); end if;
    v_list := case when v_pl is null then null else app.list_rate(v_pl, (l ->> 'product_id')::uuid, v_date, (l ->> 'qty')::numeric) end;
    if v_office then
      v_rate := coalesce(nullif(l ->> 'rate', '')::numeric, v_list);
      if v_rate is null then perform app.raise_rule('order.no_rate', 'give a rate or choose a price list with this item', '22023'); end if;
    else
      if v_list is null then perform app.raise_rule('order.no_price_list', 'this item is not on the customer''s price list; ask the office', '22023'); end if;
      if nullif(l ->> 'rate', '') is not null and round((l ->> 'rate')::numeric, 2) <> v_list then
        perform app.raise_rule('order.price_locked', 'prices come from the price list and cannot be changed in the app', '42501');
      end if;
      v_rate := v_list;
      if coalesce((l ->> 'discount')::numeric, 0) > round(v_rate * (l ->> 'qty')::numeric * v_disc_pct / 100, 2) then
        perform app.raise_rule('order.discount_over_authority', 'this discount is above your authority; ask the sales manager', '42501');
      end if;
    end if;
    v_lines := v_lines || jsonb_build_object('product_id', l ->> 'product_id', 'qty', (l ->> 'qty')::numeric, 'rate', v_rate, 'discount', coalesce((l ->> 'discount')::numeric, 0));
  end loop;
  v_pos := coalesce(nullif(p_header ->> 'place_of_supply', ''), v_party.state_code, v_gstin.state_code);
  v_calc := app.compute_tax(v_gstin.state_code, v_pos, v_date, false, v_lines);
  for c in select * from jsonb_array_elements(v_calc -> 'lines') loop
    select mrp into v_mrp from master.product_mrp_history where product_id = (c ->> 'product_id')::uuid and effective_from <= v_date order by effective_from desc limit 1;
    if v_mrp is not null and (c ->> 'total')::numeric / (c ->> 'qty')::numeric > v_mrp + 0.005 then
      perform app.raise_rule('price.above_mrp', 'a price including tax is above the item''s MRP', '22023');
    end if;
  end loop;
  v_no := app.p6_doc_no(v_company, 'sales_order', v_date);
  insert into sales.orders (company_id, gstin_id, doc_no, order_date, delivery_date, party_id, place_of_supply, channel, payment, salesman_user_id, place_id, price_list_id,
                            buyer_po_no, buyer_po_date, notes, taxable, cgst, sgst, igst, round_off, total, status, private_label_id, created_by, device_created_at, client_request_id)
  values (v_company, v_gstin.id, v_no, v_date, nullif(p_header ->> 'delivery_date', '')::date, v_party.id, v_pos, v_channel, v_payment,
          case when v_office then coalesce(nullif(p_header ->> 'salesman_user_id', '')::uuid, pc.salesman_user_id) else auth.uid() end, v_place, v_pl,
          nullif(p_header ->> 'buyer_po_no', ''), nullif(p_header ->> 'buyer_po_date', '')::date, nullif(p_header ->> 'notes', ''),
          (v_calc ->> 'taxable')::numeric, (v_calc ->> 'cgst')::numeric, (v_calc ->> 'sgst')::numeric, (v_calc ->> 'igst')::numeric, (v_calc ->> 'round_off')::numeric,
          (v_calc ->> 'total')::numeric, 'pending_credit', nullif(p_header ->> 'private_label_id', '')::uuid, auth.uid(), nullif(p_header ->> 'device_created_at', '')::timestamptz, p_client_request_id)
  returning id into v_id;
  insert into sales.order_lines (order_id, line_no, product_id, description, hsn_code, uom, qty, rate, discount, taxable, gst_rate, cgst, sgst, igst, total)
  select v_id, (ln ->> 'line_no')::int, (ln ->> 'product_id')::uuid, ln ->> 'description', ln ->> 'hsn_code', ln ->> 'uom', (ln ->> 'qty')::numeric, (ln ->> 'rate')::numeric,
         (ln ->> 'discount')::numeric, (ln ->> 'taxable')::numeric, (ln ->> 'gst_rate')::numeric, (ln ->> 'cgst')::numeric, (ln ->> 'sgst')::numeric, (ln ->> 'igst')::numeric,
         (ln ->> 'total')::numeric
  from jsonb_array_elements(v_calc -> 'lines') ln;

  -- Private label: extra approvals first. Credit: exposure (with this order) against limit + live MD exceptions.
  if v_channel = 'private_label' then
    select * into v_pl_order from sales.private_label_orders where id = nullif(p_header ->> 'private_label_id', '')::uuid and party_id = v_party.id and company_id = v_company;
    if v_pl_order.id is null then perform app.raise_rule('order.private_label_missing', 'link the approved private-label request', '22023'); end if;
    if v_pl_order.status <> 'approved' then v_status := 'pending_approval'; end if;
  end if;
  v_exp := app.credit_exposure(v_company, v_party.id);
  if v_status is null and v_payment = 'credit' then
    -- the new order is already counted in open orders only once confirmed, so add it explicitly here
    if (v_exp ->> 'exposure')::numeric + (v_calc ->> 'total')::numeric > (v_exp ->> 'limit')::numeric + (v_exp ->> 'exception')::numeric then v_status := 'pending_credit'; end if;
  end if;
  v_status := coalesce(v_status, 'confirmed');
  update sales.orders set status = v_status, credit_check = app.credit_view(v_exp, (v_calc ->> 'total')::numeric),
         confirmed_by = case when v_status = 'confirmed' then auth.uid() end, confirmed_at = case when v_status = 'confirmed' then now() end
  where id = v_id;
  if v_status = 'confirmed' then
    v_reserved := app.reserve_order(v_id);
    perform app.order_message((select o from sales.orders o where o.id = v_id), 'sales.order_confirmed', 'order_confirmed', 'confirmed',
      jsonb_build_object('doc_no', v_no, 'items', jsonb_array_length(v_calc -> 'lines'), 'delivery_date', to_char(nullif(p_header ->> 'delivery_date', '')::date, 'DD-MM-YYYY')));
  end if;
  v_res := jsonb_build_object('id', v_id, 'doc_no', v_no, 'status', v_status, 'totals', v_calc - 'lines', 'reserved_lines', v_reserved,
                              'credit', app.credit_view(v_exp, (v_calc ->> 'total')::numeric));
  return app.request_done(p_client_request_id, 'confirm_sales_order', v_res);
end $$;

-- Re-check a held order (after payments or an MD exception). Never by the person who took the order.
create or replace function api.release_order(p_client_request_id uuid, p_order_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; o sales.orders; v_exp jsonb; v_res jsonb; v_pl text;
begin
  v_prev := app.request_seen(p_client_request_id, 'release_order'); if v_prev is not null then return v_prev; end if;
  select * into o from sales.orders where id = p_order_id for update;
  if o.id is null then perform app.raise_rule('order.missing', 'order not found', 'P0002'); end if;
  if not (app.can(o.company_id, 'sales.approve') or app.can(o.company_id, 'credit.md_exception')) then perform app.raise_rule('rights.missing', 'needs sales approval', '42501'); end if;
  perform app.require(o.company_id, case when app.can(o.company_id, 'sales.approve') then 'sales.approve' else 'credit.md_exception' end);
  if o.created_by = auth.uid() then perform app.raise_rule('sod.own_request', 'nobody releases their own order', '42501'); end if;
  if o.status not in ('pending_credit', 'pending_approval') then perform app.raise_rule('order.state', 'this order is not on hold', '22023'); end if;
  if o.status = 'pending_approval' then
    select status into v_pl from sales.private_label_orders where id = o.private_label_id;
    if v_pl is distinct from 'approved' then perform app.raise_rule('order.private_label_pending', 'the private-label approvals are not complete', '22023'); end if;
  end if;
  v_exp := app.credit_exposure(o.company_id, o.party_id);
  if o.payment = 'credit' and (v_exp ->> 'exposure')::numeric + o.total > (v_exp ->> 'limit')::numeric + (v_exp ->> 'exception')::numeric then
    perform app.raise_rule('credit.over_limit', 'still over the credit limit; an MD exception is needed', 'P0001');
  end if;
  update sales.orders set status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now(), credit_check = app.credit_view(v_exp, o.total) where id = o.id;
  perform app.reserve_order(o.id);
  perform app.order_message(o, 'sales.order_confirmed', 'order_confirmed', 'confirmed', jsonb_build_object('doc_no', o.doc_no, 'items', (select count(*) from sales.order_lines where order_id = o.id),
    'delivery_date', to_char(o.delivery_date, 'DD-MM-YYYY')));
  perform app.log_event('admin_action', jsonb_build_object('entity', 'order_released', 'order', o.doc_no));
  v_res := jsonb_build_object('id', o.id, 'status', 'confirmed');
  return app.request_done(p_client_request_id, 'release_order', v_res);
end $$;

-- MD exception: p {company_id, party_id, order_id?, amount, valid_until, reason}. Time-limited, logged, never by the requester.
create or replace function api.grant_md_exception(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_party uuid := (p ->> 'party_id')::uuid; o sales.orders; v_id uuid; v_until timestamptz;
        v_exp jsonb; v_status text; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'grant_md_exception'); if v_prev is not null then return v_prev; end if;
  if nullif(p ->> 'order_id', '') is not null then
    select * into o from sales.orders where id = (p ->> 'order_id')::uuid for update;
    if o.id is null then perform app.raise_rule('order.missing', 'order not found', 'P0002'); end if;
    v_company := o.company_id; v_party := o.party_id;
  end if;
  perform app.require(v_company, 'credit.md_exception');
  if o.id is not null and o.created_by = auth.uid() then perform app.raise_rule('sod.own_request', 'the MD exception must come from another person', '42501'); end if;
  v_until := (p ->> 'valid_until')::timestamptz;
  if v_until is null or v_until <= now() then perform app.raise_rule('credit.exception_until', 'an exception needs an end time in the future', '22023'); end if;
  if coalesce(length(trim(p ->> 'reason')), 0) < 5 then perform app.raise_rule('rights.reason_required', 'give a reason', '22023'); end if;
  if coalesce((p ->> 'amount')::numeric, 0) <= 0 then perform app.raise_rule('credit.exception_amount', 'the amount must be above zero', '22023'); end if;
  perform 1 from master.party_companies where party_id = v_party and company_id = v_company for update;
  insert into sales.credit_exceptions (company_id, party_id, order_id, amount, valid_until, reason, requested_by, granted_by)
  values (v_company, v_party, o.id, round((p ->> 'amount')::numeric, 2), v_until, trim(p ->> 'reason'), o.created_by, auth.uid()) returning id into v_id;
  perform app.log_event('admin_action', jsonb_build_object('entity', 'credit_exception', 'id', v_id, 'party_id', v_party, 'until', v_until, 'reason', p ->> 'reason'));
  v_status := o.status;
  if o.status = 'pending_credit' then
    v_exp := app.credit_exposure(v_company, v_party);
    if (v_exp ->> 'exposure')::numeric + o.total <= (v_exp ->> 'limit')::numeric + (v_exp ->> 'exception')::numeric then
      update sales.orders set status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now(), credit_exception_id = v_id, credit_check = app.credit_view(v_exp, o.total) where id = o.id;
      perform app.reserve_order(o.id);
      perform app.order_message(o, 'sales.order_confirmed', 'order_confirmed', 'confirmed', jsonb_build_object('doc_no', o.doc_no,
        'items', (select count(*) from sales.order_lines where order_id = o.id), 'delivery_date', to_char(o.delivery_date, 'DD-MM-YYYY')));
      v_status := 'confirmed';
    end if;
  end if;
  v_res := jsonb_build_object('id', v_id, 'order_status', v_status);
  return app.request_done(p_client_request_id, 'grant_md_exception', v_res);
end $$;

create or replace function api.cancel_sales_order(p_client_request_id uuid, p_order_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; o sales.orders; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'cancel_sales_order'); if v_prev is not null then return v_prev; end if;
  select * into o from sales.orders where id = p_order_id for update;
  if o.id is null then perform app.raise_rule('order.missing', 'order not found', 'P0002'); end if;
  perform app.require(o.company_id, 'sales.cancel');
  if coalesce(length(trim(p_reason)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'give a reason', '22023'); end if;
  if o.status not in ('pending_credit', 'pending_approval', 'confirmed') or exists (select 1 from sales.dispatches where order_id = o.id and status <> 'cancelled') then
    perform app.raise_rule('order.state', 'only an order with nothing dispatched can be cancelled', '22023');
  end if;
  update sales.orders set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = p_reason where id = o.id;
  update inv.reservations set status = 'released', closed_at = now() where source_id = o.id and status = 'active';
  v_res := jsonb_build_object('id', o.id, 'status', 'cancelled');
  return app.request_done(p_client_request_id, 'cancel_sales_order', v_res);
end $$;

-- ─────────── Credit applications (7 stages) ───────────
-- 1 prospect (party exists) · 2 request (credit.request) · 3 sales manager endorses (credit.endorse) · 4 file verified, KYC verified
-- (credit.verify) · 5 finance head recommends (credit.recommend) · 6 MD approves limit, terms and review date (credit.approve) · 7 active.
-- Nobody decides a stage they asked for or already decided.
create or replace function api.submit_credit_application(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_party uuid := (p ->> 'party_id')::uuid; v_id uuid; v_no text; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'submit_credit_application'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'credit.request');
  if not exists (select 1 from master.party_companies where party_id = v_party and company_id = v_company and is_customer) then
    perform app.raise_rule('party.not_linked', 'this customer is not linked to the company', '22023');
  end if;
  if not (app.can(v_company, 'sales.create') or app.is_my_customer(v_company, v_party)) then perform app.raise_rule('rights.missing', 'not your customer', '42501'); end if;
  perform 1 from master.party_companies where party_id = v_party and company_id = v_company for update;
  if exists (select 1 from sales.credit_applications where company_id = v_company and party_id = v_party and status = 'in_progress') then
    perform app.raise_rule('credit.application_open', 'an application for this customer is already in progress', '22023');
  end if;
  if coalesce((p ->> 'requested_limit')::numeric, 0) <= 0 then perform app.raise_rule('credit.limit_amount', 'ask for a limit above zero', '22023'); end if;
  v_no := app.p6_doc_no(v_company, 'credit_application', current_date);
  insert into sales.credit_applications (company_id, doc_no, party_id, requested_limit, requested_term_id, expected_monthly, security, note, stage, requested_by)
  values (v_company, v_no, v_party, round((p ->> 'requested_limit')::numeric, 2), nullif(p ->> 'requested_term_id', '')::uuid, nullif(p ->> 'expected_monthly', '')::numeric,
          nullif(p ->> 'security', ''), nullif(p ->> 'note', ''), 3, auth.uid())
  returning id into v_id;
  v_res := jsonb_build_object('id', v_id, 'doc_no', v_no, 'stage', 3);
  return app.request_done(p_client_request_id, 'submit_credit_application', v_res);
end $$;

-- p: {limit, term_id, review_on, note} (limit/term/review_on used at stage 6; note required to reject)
create or replace function api.approve_credit_stage(p_client_request_id uuid, p_application_id uuid, p_stage int, p_decision text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; a sales.credit_applications; v_right text; v_limit numeric; v_term uuid; v_days int; v_review date; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'approve_credit_stage'); if v_prev is not null then return v_prev; end if;
  select * into a from sales.credit_applications where id = p_application_id for update;
  if a.id is null then perform app.raise_rule('credit.missing', 'application not found', 'P0002'); end if;
  if a.status <> 'in_progress' then perform app.raise_rule('credit.state', 'this application is closed', '22023'); end if;
  if p_stage is distinct from a.stage then perform app.raise_rule('credit.wrong_stage', 'this application is waiting for stage ' || a.stage, '22023'); end if;
  if p_decision not in ('approved', 'rejected') then perform app.raise_rule('credit.decision', 'approve or reject', '22023'); end if;
  v_right := case p_stage when 3 then 'credit.endorse' when 4 then 'credit.verify' when 5 then 'credit.recommend' when 6 then 'credit.approve' end;
  perform app.require(a.company_id, v_right);
  if a.requested_by = auth.uid() then perform app.raise_rule('sod.own_request', 'nobody approves their own request', '42501'); end if;
  if exists (select 1 from sales.credit_approvals where application_id = a.id and decided_by = auth.uid()) then
    perform app.raise_rule('credit.same_person', 'you already decided an earlier stage of this application', '42501');
  end if;
  if p_decision = 'rejected' then
    if coalesce(length(trim(p ->> 'note')), 0) < 5 then perform app.raise_rule('rights.reason_required', 'a rejection goes back with a reason', '22023'); end if;
    insert into sales.credit_approvals (application_id, stage, decision, note, decided_by) values (a.id, p_stage, 'rejected', p ->> 'note', auth.uid());
    update sales.credit_applications set status = 'rejected', reject_reason = p ->> 'note' where id = a.id;
    v_res := jsonb_build_object('id', a.id, 'status', 'rejected', 'stage', p_stage);
    return app.request_done(p_client_request_id, 'approve_credit_stage', v_res);
  end if;
  if p_stage = 4 and (select kyc_status from master.parties where id = a.party_id) <> 'verified' then
    perform app.raise_rule('credit.kyc_not_verified', 'verify the customer''s KYC before the credit file', '22023');
  end if;
  v_limit := coalesce(nullif(p ->> 'limit', '')::numeric, a.requested_limit);
  v_term := coalesce(nullif(p ->> 'term_id', '')::uuid, a.requested_term_id);
  insert into sales.credit_approvals (application_id, stage, decision, limit_amount, term_id, note, decided_by) values (a.id, p_stage, 'approved', v_limit, v_term, p ->> 'note', auth.uid());
  if p_stage < 6 then
    update sales.credit_applications set stage = p_stage + 1 where id = a.id;
    v_res := jsonb_build_object('id', a.id, 'status', 'in_progress', 'stage', p_stage + 1);
  else
    v_review := nullif(p ->> 'review_on', '')::date;
    if v_review is null or v_review <= current_date then perform app.raise_rule('credit.review_date', 'the MD sets a review date in the future', '22023'); end if;
    if v_term is null then perform app.raise_rule('credit.terms_required', 'choose the credit terms', '22023'); end if;
    select days into v_days from master.credit_terms where id = v_term;
    if v_days > 45 and coalesce((app.setting(a.company_id, 'msme.selling_rule'))::text::boolean, false) then
      perform app.raise_rule('party.msme_terms', 'terms longer than 45 days are refused under the MSME rule', '22023');
    end if;
    perform 1 from master.party_companies where party_id = a.party_id and company_id = a.company_id for update;
    update master.party_companies set credit_limit = round(v_limit, 2), credit_term_id = v_term, credit_status = 'active', credit_review_on = v_review
     where party_id = a.party_id and company_id = a.company_id;
    update sales.credit_applications set stage = 7, status = 'active', decided_limit = round(v_limit, 2), decided_term_id = v_term, review_on = v_review where id = a.id;
    perform app.log_event('admin_action', jsonb_build_object('entity', 'credit_active', 'application', a.doc_no, 'party_id', a.party_id));
    v_res := jsonb_build_object('id', a.id, 'status', 'active', 'stage', 7);
  end if;
  return app.request_done(p_client_request_id, 'approve_credit_stage', v_res);
end $$;

-- Put a customer's credit on hold / review / back to active (finance head or MD); logged.
create or replace function api.set_credit_status(p_client_request_id uuid, p_company_id uuid, p_party_id uuid, p_status text, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_credit_status'); if v_prev is not null then return v_prev; end if;
  if not (app.can(p_company_id, 'credit.recommend') or app.can(p_company_id, 'credit.approve')) then perform app.raise_rule('rights.missing', 'finance head or MD only', '42501'); end if;
  perform app.require(p_company_id, case when app.can(p_company_id, 'credit.approve') then 'credit.approve' else 'credit.recommend' end);
  if p_status not in ('active', 'hold', 'review') then perform app.raise_rule('credit.status', 'active, hold or review', '22023'); end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'give a reason', '22023'); end if;
  if p_status = 'active' and not exists (select 1 from sales.credit_applications where company_id = p_company_id and party_id = p_party_id and status = 'active') then
    perform app.raise_rule('credit.no_approval', 'credit becomes active only through an approved application', '22023');
  end if;
  update master.party_companies set credit_status = p_status where party_id = p_party_id and company_id = p_company_id;
  perform app.log_event('admin_action', jsonb_build_object('entity', 'credit_status', 'party_id', p_party_id, 'status', p_status, 'reason', p_reason));
  v_res := jsonb_build_object('ok', true);
  return app.request_done(p_client_request_id, 'set_credit_status', v_res);
end $$;

-- ─────────── Vehicles ───────────
create or replace function api.upsert_vehicle(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_company uuid := (p ->> 'company_id')::uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_vehicle'); if v_prev is not null then return v_prev; end if;
  if v_id is not null then select company_id into v_company from ops.vehicles where id = v_id for update; end if;
  perform app.require(v_company, case when v_id is null then 'logistics.create' else 'logistics.edit' end);
  if v_id is null then
    insert into ops.vehicles (company_id, reg_no, kind, ownership, transporter, payload_kg, usual_driver_user_id, place_id)
    values (v_company, upper(regexp_replace(p ->> 'reg_no', '[^A-Za-z0-9]', '', 'g')), p ->> 'kind', coalesce(p ->> 'ownership', 'owned'), nullif(p ->> 'transporter', ''),
            nullif(p ->> 'payload_kg', '')::numeric, nullif(p ->> 'usual_driver_user_id', '')::uuid, nullif(p ->> 'place_id', '')::uuid)
    returning id into v_id;
  else
    update ops.vehicles set kind = coalesce(p ->> 'kind', kind), ownership = coalesce(p ->> 'ownership', ownership), transporter = coalesce(p ->> 'transporter', transporter),
      payload_kg = coalesce(nullif(p ->> 'payload_kg', '')::numeric, payload_kg), usual_driver_user_id = coalesce(nullif(p ->> 'usual_driver_user_id', '')::uuid, usual_driver_user_id),
      place_id = coalesce(nullif(p ->> 'place_id', '')::uuid, place_id), status = coalesce(p ->> 'status', status)
    where id = v_id;
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_vehicle', v_res);
end $$;

create or replace function api.set_vehicle_document(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid; v_id uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_vehicle_document'); if v_prev is not null then return v_prev; end if;
  select company_id into v_company from ops.vehicles where id = (p ->> 'vehicle_id')::uuid for update;
  if v_company is null then perform app.raise_rule('vehicle.missing', 'vehicle not found', 'P0002'); end if;
  perform app.require(v_company, 'logistics.edit');
  insert into ops.vehicle_documents (vehicle_id, kind, doc_no, valid_to, path, set_by)
  values ((p ->> 'vehicle_id')::uuid, p ->> 'kind', nullif(p ->> 'doc_no', ''), nullif(p ->> 'valid_to', '')::date, nullif(p ->> 'path', ''), auth.uid()) returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'set_vehicle_document', v_res);
end $$;

create or replace function api.record_vehicle_event(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid; v_id bigint; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'record_vehicle_event'); if v_prev is not null then return v_prev; end if;
  select company_id into v_company from ops.vehicles where id = (p ->> 'vehicle_id')::uuid;
  if v_company is null then perform app.raise_rule('vehicle.missing', 'vehicle not found', 'P0002'); end if;
  perform app.require(v_company, 'logistics.create');
  insert into ops.vehicle_events (company_id, vehicle_id, kind, event_date, odometer_km, litres, amount, trip_id, paid_by, note, recorded_by)
  values (v_company, (p ->> 'vehicle_id')::uuid, p ->> 'kind', coalesce(nullif(p ->> 'event_date', '')::date, current_date), nullif(p ->> 'odometer_km', '')::int,
          nullif(p ->> 'litres', '')::numeric, nullif(p ->> 'amount', '')::numeric, nullif(p ->> 'trip_id', '')::uuid, nullif(p ->> 'paid_by', ''), nullif(p ->> 'note', ''), auth.uid())
  returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'record_vehicle_event', v_res);
end $$;

-- Latest document of each kind expired on the date → the vehicle cannot take a trip (Admin may override).
create or replace function app.check_vehicle(p_vehicle uuid, p_date date) returns void
language plpgsql stable security definer set search_path = '' as $$
declare v ops.vehicles; v_expired text;
begin
  if p_vehicle is null then return; end if;
  select * into v from ops.vehicles where id = p_vehicle;
  if v.status <> 'active' then perform app.raise_rule('vehicle.not_active', 'this vehicle is not in service', '22023'); end if;
  select string_agg(kind, ', ') into v_expired from (select distinct on (kind) kind, valid_to from ops.vehicle_documents where vehicle_id = p_vehicle order by kind, set_at desc) d
   where d.valid_to is not null and d.valid_to < p_date;
  if v_expired is not null and not app.is_admin() then perform app.raise_rule('vehicle.document_expired', 'expired vehicle papers: ' || v_expired, '22023'); end if;
end $$;

-- ─────────── Dispatch ───────────
-- p: {order_id, place_id, scheduled_at, eway_bill_no, lines: [{order_line_id, qty}]} (no lines = everything still open)
create or replace function api.create_dispatch(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; o sales.orders; v_place uuid; v_id uuid; v_no text; l record; v_qty numeric; v_open numeric; v_value numeric := 0; v_res jsonb; v_given jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'create_dispatch'); if v_prev is not null then return v_prev; end if;
  select * into o from sales.orders where id = (p ->> 'order_id')::uuid for update;
  if o.id is null then perform app.raise_rule('order.missing', 'order not found', 'P0002'); end if;
  perform app.require(o.company_id, 'logistics.create');
  if o.status not in ('confirmed', 'part_dispatched') then perform app.raise_rule('order.not_confirmed', 'only a confirmed order can be dispatched (credit or approval hold?)', '22023'); end if;
  v_place := coalesce(nullif(p ->> 'place_id', '')::uuid, o.place_id);
  if v_place is null or not exists (select 1 from core.places where id = v_place and company_id = o.company_id) then perform app.raise_rule('dispatch.place', 'choose the place goods leave from', '22023'); end if;
  v_no := app.p6_doc_no(o.company_id, 'dispatch', current_date);
  insert into sales.dispatches (company_id, doc_no, order_id, party_id, place_id, scheduled_at, eway_bill_no, created_by)
  values (o.company_id, v_no, o.id, o.party_id, v_place, nullif(p ->> 'scheduled_at', '')::timestamptz, nullif(p ->> 'eway_bill_no', ''), auth.uid()) returning id into v_id;
  for l in select * from sales.order_lines where order_id = o.id order by line_no loop
    v_open := l.qty - l.qty_dispatched - coalesce((select sum(dl.qty) from sales.dispatch_lines dl join sales.dispatches d on d.id = dl.dispatch_id
                                                    where dl.order_line_id = l.id and d.status = 'planned' and d.id <> v_id), 0);
    select e into v_given from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) e where (e ->> 'order_line_id')::uuid = l.id;
    v_qty := case when jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) = 0 then v_open else coalesce((v_given ->> 'qty')::numeric, 0) end;
    if v_qty <= 0 then continue; end if;
    if v_qty > v_open then perform app.raise_rule('dispatch.over_order', 'more than the order still has open', '22023'); end if;
    insert into sales.dispatch_lines (dispatch_id, order_line_id, product_id, qty) values (v_id, l.id, l.product_id, v_qty);
    v_value := v_value + round(v_qty * l.total / l.qty, 2);
  end loop;
  if v_value = 0 then perform app.raise_rule('dispatch.no_lines', 'nothing to dispatch', '22023'); end if;
  update sales.dispatches set value = v_value where id = v_id;
  v_res := jsonb_build_object('id', v_id, 'doc_no', v_no, 'value', v_value);
  return app.request_done(p_client_request_id, 'create_dispatch', v_res);
end $$;

-- Link a posted tax invoice / bill of supply of the order's customer to a dispatch (it must cover every dispatched item).
create or replace function app.link_dispatch_doc(p_dispatch uuid, p_document uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare d sales.dispatches; doc sales.documents; v_short int;
begin
  select * into d from sales.dispatches where id = p_dispatch for update;
  select * into doc from sales.documents where id = p_document;
  if doc.id is null or doc.status <> 'posted' or doc.company_id <> d.company_id or doc.party_id is distinct from d.party_id or doc.doc_type not in ('sales_invoice', 'bill_of_supply') then
    perform app.raise_rule('dispatch.document', 'link a posted invoice of this customer and company', '22023');
  end if;
  if d.status <> 'planned' then perform app.raise_rule('dispatch.state', 'this dispatch has already left', '22023'); end if;
  select count(*) into v_short from sales.dispatch_lines dl
   where dl.dispatch_id = d.id and dl.qty > coalesce((select sum(x.qty) from sales.document_lines x where x.document_id = doc.id and x.product_id = dl.product_id), 0);
  if v_short > 0 then perform app.raise_rule('dispatch.document_short', 'the invoice does not cover every dispatched item', '22023'); end if;
  insert into sales.order_documents (order_id, document_id, dispatch_id, linked_by) values (d.order_id, doc.id, d.id, auth.uid());
  update sales.dispatches set document_id = doc.id where id = d.id;
  update sales.order_lines l set qty_invoiced = least(l.qty, l.qty_invoiced + dl.qty) from sales.dispatch_lines dl where dl.dispatch_id = d.id and dl.order_line_id = l.id;
end $$;

create or replace function api.link_dispatch_document(p_client_request_id uuid, p_dispatch_id uuid, p_document_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'link_dispatch_document'); if v_prev is not null then return v_prev; end if;
  select company_id into v_company from sales.dispatches where id = p_dispatch_id;
  if v_company is null then perform app.raise_rule('dispatch.missing', 'dispatch not found', 'P0002'); end if;
  perform app.require(v_company, case when app.can(v_company, 'logistics.edit') then 'logistics.edit' else 'sales_invoices.create' end);
  perform app.link_dispatch_doc(p_dispatch_id, p_document_id);
  v_res := jsonb_build_object('dispatch_id', p_dispatch_id, 'document_id', p_document_id);
  return app.request_done(p_client_request_id, 'link_dispatch_document', v_res);
end $$;

-- Make and post the tax invoice for a dispatch through the Phase 3 RPCs (same GST engine), then link it.
-- p: {doc_date, gstin_id, notes}
create or replace function api.invoice_dispatch(p_client_request_id uuid, p_dispatch_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; d sales.dispatches; o sales.orders; v_lines jsonb; v_draft jsonb; v_post jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'invoice_dispatch'); if v_prev is not null then return v_prev; end if;
  select * into d from sales.dispatches where id = p_dispatch_id for update;
  if d.id is null then perform app.raise_rule('dispatch.missing', 'dispatch not found', 'P0002'); end if;
  perform app.require(d.company_id, 'sales_invoices.create');
  if d.document_id is not null then perform app.raise_rule('dispatch.already_invoiced', 'this dispatch already has its invoice', '22023'); end if;
  select * into o from sales.orders where id = d.order_id;
  select jsonb_agg(jsonb_build_object('product_id', l.product_id, 'qty', dl.qty, 'rate', l.rate, 'discount', round(l.discount * dl.qty / l.qty, 2)) order by l.line_no) into v_lines
  from sales.dispatch_lines dl join sales.order_lines l on l.id = dl.order_line_id where dl.dispatch_id = d.id;
  v_draft := api.save_sales_draft(app.child_crid(p_client_request_id, 'draft'), jsonb_build_object('company_id', d.company_id, 'gstin_id', coalesce(nullif(p ->> 'gstin_id', '')::uuid, o.gstin_id),
    'party_id', d.party_id, 'doc_type', 'sales_invoice', 'doc_date', coalesce(nullif(p ->> 'doc_date', '')::date, current_date), 'place_of_supply', o.place_of_supply,
    'notes', coalesce(nullif(p ->> 'notes', ''), 'Order ' || o.doc_no || ' · dispatch ' || d.doc_no), 'lines', v_lines));
  v_post := api.post_sales_document(app.child_crid(p_client_request_id, 'post'), (v_draft ->> 'id')::uuid);
  perform app.link_dispatch_doc(d.id, (v_draft ->> 'id')::uuid);
  v_res := jsonb_build_object('dispatch_id', d.id, 'document_id', v_draft ->> 'id', 'doc_no', v_post ->> 'doc_no', 'total', v_post -> 'total');
  return app.request_done(p_client_request_id, 'invoice_dispatch', v_res);
end $$;

create or replace function api.set_dispatch_eway(p_client_request_id uuid, p_dispatch_id uuid, p_eway_bill_no text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; d sales.dispatches; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_dispatch_eway'); if v_prev is not null then return v_prev; end if;
  select * into d from sales.dispatches where id = p_dispatch_id for update;
  if d.id is null then perform app.raise_rule('dispatch.missing', 'dispatch not found', 'P0002'); end if;
  perform app.require(d.company_id, 'logistics.edit');
  if d.status <> 'planned' then perform app.raise_rule('dispatch.state', 'this dispatch has already left', '22023'); end if;
  if coalesce(p_eway_bill_no, '') !~ '^[0-9]{12}$' then perform app.raise_rule('dispatch.eway_format', 'an e-way bill number has 12 digits', '22023'); end if;
  update sales.dispatches set eway_bill_no = p_eway_bill_no where id = d.id;
  v_res := jsonb_build_object('id', d.id);
  return app.request_done(p_client_request_id, 'set_dispatch_eway', v_res);
end $$;

-- ─────────── Trips ───────────
-- p: {company_id, trip_date, vehicle_id | transporter, driver_user_id, lr_no, dispatch_ids: []}
create or replace function api.create_trip(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_id uuid; v_no text; v_date date := coalesce(nullif(p ->> 'trip_date', '')::date, current_date); v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'create_trip'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'logistics.create');
  if nullif(p ->> 'vehicle_id', '') is not null and not exists (select 1 from ops.vehicles where id = (p ->> 'vehicle_id')::uuid and company_id = v_company) then
    perform app.raise_rule('vehicle.missing', 'vehicle of another company', '22023');
  end if;
  perform app.check_vehicle(nullif(p ->> 'vehicle_id', '')::uuid, v_date);
  v_no := app.p6_doc_no(v_company, 'trip', v_date);
  insert into sales.trips (company_id, doc_no, trip_date, vehicle_id, driver_user_id, transporter, lr_no, created_by)
  values (v_company, v_no, v_date, nullif(p ->> 'vehicle_id', '')::uuid, nullif(p ->> 'driver_user_id', '')::uuid, nullif(p ->> 'transporter', ''), nullif(p ->> 'lr_no', ''), auth.uid())
  returning id into v_id;
  perform app.add_trip_stops(v_id, coalesce(p -> 'dispatch_ids', '[]'::jsonb));
  v_res := jsonb_build_object('id', v_id, 'doc_no', v_no);
  return app.request_done(p_client_request_id, 'create_trip', v_res);
end $$;

create or replace function app.add_trip_stops(p_trip uuid, p_dispatch_ids jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare t sales.trips; e jsonb; d sales.dispatches; v_seq int; n int := 0;
begin
  select * into t from sales.trips where id = p_trip for update;
  if t.status <> 'planned' then perform app.raise_rule('trip.state', 'stops can be added only before the trip starts', '22023'); end if;
  select coalesce(max(seq), 0) into v_seq from sales.trip_stops where trip_id = t.id;
  for e in select * from jsonb_array_elements(p_dispatch_ids) loop
    select * into d from sales.dispatches where id = (e #>> '{}')::uuid for update;
    if d.id is null or d.company_id <> t.company_id or d.status <> 'planned' or d.trip_id is not null then
      perform app.raise_rule('trip.dispatch', 'each stop must be a planned dispatch of this company not on another trip', '22023');
    end if;
    v_seq := v_seq + 1;
    insert into sales.trip_stops (trip_id, seq, dispatch_id) values (t.id, v_seq, d.id);
    update sales.dispatches set trip_id = t.id where id = d.id;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function api.assign_to_trip(p_client_request_id uuid, p_trip_id uuid, p_dispatch_ids jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid; n int; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'assign_to_trip'); if v_prev is not null then return v_prev; end if;
  select company_id into v_company from sales.trips where id = p_trip_id;
  if v_company is null then perform app.raise_rule('trip.missing', 'trip not found', 'P0002'); end if;
  perform app.require(v_company, 'logistics.edit');
  n := app.add_trip_stops(p_trip_id, coalesce(p_dispatch_ids, '[]'::jsonb));
  v_res := jsonb_build_object('trip_id', p_trip_id, 'added', n);
  return app.request_done(p_client_request_id, 'assign_to_trip', v_res);
end $$;

-- The trip's driver (trip.drive) or the dispatch desk (logistics.edit).
create or replace function app.lock_trip(p_trip uuid) returns sales.trips
language plpgsql security definer set search_path = '' as $$
declare t sales.trips;
begin
  select * into t from sales.trips where id = p_trip for update;
  if t.id is null then perform app.raise_rule('trip.missing', 'trip not found', 'P0002'); end if;
  if t.driver_user_id = auth.uid() and app.can(t.company_id, 'trip.drive') then perform app.require(t.company_id, 'trip.drive');
  else perform app.require(t.company_id, 'logistics.edit'); end if;
  return t;
end $$;

-- Start: every dispatch carries its posted invoice and an e-way bill (unless under the company's threshold setting; unset = always
-- required), credit is checked again, stock leaves the place (lots on hold never leave), the customer gets the dispatch message.
-- p: {odometer_start, gps_notice_ack}  — the driver's GPS is used only during the trip and only after the notice was acknowledged.
create or replace function api.start_trip(p_client_request_id uuid, p_trip_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; t sales.trips; d record; l record; v_taken jsonb; v_threshold numeric; v_exp jsonb; o sales.orders; v_veh text; v_res jsonb; v_n int := 0;
begin
  v_prev := app.request_seen(p_client_request_id, 'start_trip'); if v_prev is not null then return v_prev; end if;
  t := app.lock_trip(p_trip_id);
  if t.status <> 'planned' then perform app.raise_rule('trip.state', 'this trip has already started', '22023'); end if;
  if not exists (select 1 from sales.trip_stops where trip_id = t.id) then perform app.raise_rule('trip.no_stops', 'add the deliveries first', '22023'); end if;
  perform app.check_vehicle(t.vehicle_id, current_date);
  perform app.check_stock_date(t.company_id, current_date);
  v_threshold := (app.setting(t.company_id, 'eway.threshold_amount'))::text::numeric;
  select reg_no into v_veh from ops.vehicles where id = t.vehicle_id;
  for d in select x.* from sales.dispatches x join sales.trip_stops s on s.dispatch_id = x.id where s.trip_id = t.id order by s.seq for update of x loop
    select * into o from sales.orders where id = d.order_id for update;
    if d.document_id is null then perform app.raise_rule('dispatch.no_invoice', 'dispatch ' || d.doc_no || ' has no posted invoice', '22023'); end if;
    if d.eway_bill_no is null and (v_threshold is null or d.value >= v_threshold) then
      perform app.raise_rule('dispatch.eway_required', 'dispatch ' || d.doc_no || ' needs its e-way bill before the vehicle leaves', '22023');
    end if;
    if o.payment = 'credit' then
      v_exp := app.credit_exposure(o.company_id, o.party_id);
      if (v_exp ->> 'exposure')::numeric > (v_exp ->> 'limit')::numeric + (v_exp ->> 'exception')::numeric then
        perform app.raise_rule('credit.over_limit', 'customer of ' || d.doc_no || ' is over the credit limit; collect or ask for an MD exception', 'P0001');
      end if;
    end if;
    for l in select * from sales.dispatch_lines where dispatch_id = d.id loop
      v_taken := app.stock_take(d.company_id, l.product_id, null, d.place_id, 'available', l.qty, 'dispatch', 'sales.dispatches', d.id, d.doc_no, current_date, null, o.id);
      if exists (select 1 from jsonb_array_elements(v_taken) e join inv.lots lo on lo.id = (e ->> 'lot_id')::uuid where lo.status = 'hold') then
        perform app.raise_rule('stock.lot_on_hold', 'a lot on QC hold cannot be dispatched', 'P0001');
      end if;
      update sales.dispatch_lines set lots = v_taken where id = l.id;
      update sales.order_lines set qty_dispatched = qty_dispatched + l.qty where id = l.order_line_id;
      update inv.reservations set status = case when qty <= l.qty then 'consumed' else status end, qty = case when qty <= l.qty then qty else qty - l.qty end,
             closed_at = case when qty <= l.qty then now() end
       where source_id = o.id and source_line_id = l.order_line_id and status = 'active';
    end loop;
    update sales.dispatches set status = 'dispatched', dispatched_at = now() where id = d.id;
    update sales.orders set status = case when not exists (select 1 from sales.order_lines where order_id = o.id and qty_dispatched < qty) then 'dispatched' else 'part_dispatched' end where id = o.id;
    perform app.order_message(o, 'sales.dispatched', 'dispatched', 'dispatched:' || d.id, jsonb_build_object('doc_no', (select doc_no from sales.documents where id = d.document_id),
      'vehicle', coalesce(v_veh, t.transporter), 'eway_bill', coalesce(d.eway_bill_no, '-'), 'expected', to_char(coalesce(d.scheduled_at::date, current_date), 'DD-MM-YYYY')));
    v_n := v_n + 1;
  end loop;
  if coalesce((p ->> 'gps_notice_ack')::boolean, false) and t.driver_user_id = auth.uid() and not exists (select 1 from field.duty_sessions where user_id = auth.uid() and ended_at is null) then
    insert into field.duty_sessions (company_id, user_id, kind, notice_ack_at) values (t.company_id, auth.uid(), 'driver', now());
  end if;
  update sales.trips set status = 'started', started_by = auth.uid(), started_at = now(), odometer_start = nullif(p ->> 'odometer_start', '')::int where id = t.id;
  v_res := jsonb_build_object('id', t.id, 'status', 'started', 'dispatches', v_n);
  return app.request_done(p_client_request_id, 'start_trip', v_res);
end $$;

create or replace function api.mark_stop_arrived(p_client_request_id uuid, p_stop_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; s sales.trip_stops; t sales.trips; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'mark_stop_arrived'); if v_prev is not null then return v_prev; end if;
  select * into s from sales.trip_stops where id = p_stop_id for update;
  if s.id is null then perform app.raise_rule('trip.stop_missing', 'stop not found', 'P0002'); end if;
  t := app.lock_trip(s.trip_id);
  if t.status <> 'started' or s.status <> 'pending' then perform app.raise_rule('trip.state', 'the trip is not running or the stop is done', '22023'); end if;
  update sales.trip_stops set status = 'arrived', arrived_at = now() where id = s.id;
  v_res := jsonb_build_object('id', s.id, 'status', 'arrived');
  return app.request_done(p_client_request_id, 'mark_stop_arrived', v_res);
end $$;

-- Goods that come back (short, damaged, refused, failed delivery) return to the dispatch place in quarantine, lot by lot.
create or replace function app.return_dispatch_qty(p_line uuid, p_qty numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare dl sales.dispatch_lines; d sales.dispatches; e jsonb; v_left numeric := p_qty; v_take numeric;
begin
  if coalesce(p_qty, 0) <= 0 then return; end if;
  select * into dl from sales.dispatch_lines where id = p_line;
  select * into d from sales.dispatches where id = dl.dispatch_id;
  for e in select * from jsonb_array_elements(dl.lots) loop
    exit when v_left <= 0;
    v_take := least(v_left, (e ->> 'qty')::numeric);
    perform app.stock_post(d.company_id, dl.product_id, nullif(e ->> 'lot_id', '')::uuid, d.place_id, 'quarantine', v_take, 'dispatch_return', 'sales.dispatches', d.id, d.doc_no,
                           current_date, (e ->> 'unit_cost')::numeric, 'returned from delivery');
    v_left := v_left - v_take;
  end loop;
  update sales.order_lines set qty_dispatched = qty_dispatched - p_qty where id = dl.order_line_id;
end $$;

-- p: {received_by_name, receiver_phone, signature_path, photo_paths[], lat, lng, device_at, remarks,
--     lines: [{dispatch_line_id, qty_delivered, short_reason}]}  (no lines = everything delivered)
create or replace function api.record_pod(p_client_request_id uuid, p_stop_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; s sales.trip_stops; t sales.trips; d sales.dispatches; o sales.orders; l record; e jsonb; v_del numeric; v_short boolean := false;
        v_session uuid; v_lat numeric; v_lng numeric; v_path text; v_status text; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'record_pod'); if v_prev is not null then return v_prev; end if;
  select * into s from sales.trip_stops where id = p_stop_id for update;
  if s.id is null then perform app.raise_rule('trip.stop_missing', 'stop not found', 'P0002'); end if;
  t := app.lock_trip(s.trip_id);
  if t.status <> 'started' then perform app.raise_rule('trip.state', 'the trip has not started', '22023'); end if;
  if s.status not in ('pending', 'arrived') then perform app.raise_rule('pod.already', 'proof of delivery is already recorded for this stop', '22023'); end if;
  select * into d from sales.dispatches where id = s.dispatch_id for update;
  select * into o from sales.orders where id = d.order_id for update;
  if coalesce(length(trim(p ->> 'received_by_name')), 0) < 2 then perform app.raise_rule('pod.receiver', 'the receiver''s name is needed', '22023'); end if;
  if nullif(p ->> 'signature_path', '') is null and jsonb_array_length(coalesce(p -> 'photo_paths', '[]'::jsonb)) = 0 then
    perform app.raise_rule('pod.proof', 'a signature or a photo is needed', '22023');
  end if;
  for v_path in select nullif(p ->> 'signature_path', '') union all select x from jsonb_array_elements_text(coalesce(p -> 'photo_paths', '[]'::jsonb)) x loop
    if v_path is not null and app.storage_company(v_path) is distinct from d.company_id then
      perform app.raise_rule('pod.bad_path', 'proof files are kept in the company''s private folder', '22023');
    end if;
  end loop;
  for l in select * from sales.dispatch_lines where dispatch_id = d.id for update loop
    select x into e from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) x where (x ->> 'dispatch_line_id')::uuid = l.id;
    v_del := coalesce((e ->> 'qty_delivered')::numeric, l.qty);
    if v_del < 0 or v_del > l.qty then perform app.raise_rule('pod.qty', 'delivered quantity is between zero and the quantity sent', '22023'); end if;
    if v_del < l.qty then
      if coalesce(e ->> 'short_reason', '') not in ('damaged', 'rejected', 'short_loaded', 'not_available', 'other') then
        perform app.raise_rule('pod.short_reason', 'say why the full quantity was not delivered', '22023');
      end if;
      v_short := true;
      perform app.return_dispatch_qty(l.id, l.qty - v_del);
    end if;
    update sales.dispatch_lines set qty_delivered = v_del, qty_returned = l.qty - v_del, short_reason = case when v_del < l.qty then e ->> 'short_reason' end where id = l.id;
    update sales.order_lines set qty_delivered = qty_delivered + v_del where id = l.order_line_id;
  end loop;
  -- GPS only while on duty (driver's trip session after the notice); otherwise not stored.
  select id into v_session from field.duty_sessions where user_id = auth.uid() and ended_at is null;
  if v_session is not null and nullif(p ->> 'lat', '') is not null then
    v_lat := (p ->> 'lat')::numeric; v_lng := (p ->> 'lng')::numeric;
    insert into field.gps_points (company_id, user_id, session_id, at, lat, lng, source) values (d.company_id, auth.uid(), v_session, coalesce(nullif(p ->> 'device_at', '')::timestamptz, now()), v_lat, v_lng, 'pod');
  end if;
  insert into sales.pods (company_id, stop_id, dispatch_id, received_by_name, receiver_phone_last4, signature_path, photo_paths, lat, lng, remarks, device_at, recorded_by)
  values (d.company_id, s.id, d.id, trim(p ->> 'received_by_name'), nullif(right(regexp_replace(coalesce(p ->> 'receiver_phone', ''), '\D', '', 'g'), 4), ''),
          nullif(p ->> 'signature_path', ''), coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p -> 'photo_paths', '[]'::jsonb)) x), '{}'),
          v_lat, v_lng, nullif(p ->> 'remarks', ''), nullif(p ->> 'device_at', '')::timestamptz, auth.uid());
  v_status := case when v_short then 'part_delivered' else 'delivered' end;
  update sales.trip_stops set status = v_status, done_at = now() where id = s.id;
  update sales.dispatches set status = v_status, delivered_at = now() where id = d.id;
  update sales.orders set status = case when not exists (select 1 from sales.order_lines where order_id = o.id and (qty_delivered < qty or qty_invoiced < qty)) then 'closed'
                                        when not exists (select 1 from sales.order_lines where order_id = o.id and qty_dispatched < qty) then 'dispatched' else 'part_dispatched' end
   where id = o.id;
  perform app.order_message(o, 'sales.delivered', 'delivered', 'delivered:' || d.id, jsonb_build_object('doc_no', (select doc_no from sales.documents where id = d.document_id),
    'receiver', trim(p ->> 'received_by_name'), 'time', to_char(now() at time zone 'Asia/Kolkata', 'DD-MM-YYYY HH24:MI')));
  v_res := jsonb_build_object('stop_id', s.id, 'status', v_status, 'short', v_short);
  return app.request_done(p_client_request_id, 'record_pod', v_res);
end $$;

create or replace function api.record_failed_delivery(p_client_request_id uuid, p_stop_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; s sales.trip_stops; t sales.trips; d sales.dispatches; l record; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'record_failed_delivery'); if v_prev is not null then return v_prev; end if;
  select * into s from sales.trip_stops where id = p_stop_id for update;
  if s.id is null then perform app.raise_rule('trip.stop_missing', 'stop not found', 'P0002'); end if;
  t := app.lock_trip(s.trip_id);
  if t.status <> 'started' or s.status not in ('pending', 'arrived') then perform app.raise_rule('trip.state', 'the trip is not running or the stop is done', '22023'); end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'say why it could not be delivered', '22023'); end if;
  select * into d from sales.dispatches where id = s.dispatch_id for update;
  for l in select * from sales.dispatch_lines where dispatch_id = d.id loop
    perform app.return_dispatch_qty(l.id, l.qty);
    update sales.dispatch_lines set qty_returned = l.qty, short_reason = 'not_available' where id = l.id;
  end loop;
  update sales.trip_stops set status = 'failed', done_at = now(), fail_reason = p_reason where id = s.id;
  update sales.dispatches set status = 'failed' where id = d.id;
  update sales.orders o set status = 'part_dispatched' where o.id = d.order_id and o.status in ('dispatched', 'part_dispatched');
  v_res := jsonb_build_object('stop_id', s.id, 'status', 'failed');
  return app.request_done(p_client_request_id, 'record_failed_delivery', v_res);
end $$;

create or replace function api.close_trip(p_client_request_id uuid, p_trip_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; t sales.trips; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'close_trip'); if v_prev is not null then return v_prev; end if;
  t := app.lock_trip(p_trip_id);
  if t.status <> 'started' then perform app.raise_rule('trip.state', 'only a running trip can be closed', '22023'); end if;
  if exists (select 1 from sales.trip_stops where trip_id = t.id and status in ('pending', 'arrived')) then
    perform app.raise_rule('trip.open_stops', 'record delivery or failure for every stop first', '22023');
  end if;
  update sales.trips set status = 'closed', closed_by = auth.uid(), closed_at = now(), odometer_end = nullif(p ->> 'odometer_end', '')::int where id = t.id;
  update field.duty_sessions set ended_at = now() where user_id = t.driver_user_id and kind = 'driver' and ended_at is null;
  v_res := jsonb_build_object('id', t.id, 'status', 'closed');
  return app.request_done(p_client_request_id, 'close_trip', v_res);
end $$;

-- The driver's own current trip (driver app). Customer phone numbers are masked.
create or replace function api.my_trip() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select jsonb_build_object('trip_id', t.id, 'doc_no', t.doc_no, 'status', t.status, 'trip_date', t.trip_date, 'vehicle', v.reg_no,
      'stops', (select coalesce(jsonb_agg(jsonb_build_object('stop_id', s.id, 'seq', s.seq, 'status', s.status, 'dispatch_id', d.id, 'dispatch_no', d.doc_no,
                  'customer', pa.legal_name, 'scheduled_at', d.scheduled_at,
                  'address', (select concat_ws(', ', a.line1, a.city) from master.party_addresses a where a.party_id = d.party_id order by (a.kind = 'delivery') desc limit 1),
                  'contact_masked', (select '••' || right(c.whatsapp, 4) from master.party_contacts c where c.party_id = d.party_id and c.whatsapp is not null order by c.is_primary desc limit 1),
                  'lines', (select jsonb_agg(jsonb_build_object('dispatch_line_id', dl.id, 'product', pr.name, 'qty', dl.qty, 'uom', pr.uom)) from sales.dispatch_lines dl
                            join master.products pr on pr.id = dl.product_id where dl.dispatch_id = d.id)) order by s.seq), '[]'::jsonb)
                from sales.trip_stops s join sales.dispatches d on d.id = s.dispatch_id join master.parties pa on pa.id = d.party_id where s.trip_id = t.id))
    from sales.trips t left join ops.vehicles v on v.id = t.vehicle_id
    where t.driver_user_id = auth.uid() and t.status in ('planned', 'started')
    order by (t.status = 'started') desc, t.trip_date limit 1), '{}'::jsonb)
$$;

-- ─────────── WhatsApp templates (drafts; Meta approval is the owner's step) ───────────
insert into msg.templates (name, language, category, event, header_type, body, params, approval_status) values
  ('order_confirmed', 'en', 'utility', 'sales.order_confirmed', 'none', 'Dear {{1}}, your order {{2}} ({{3}} items) is confirmed. Expected dispatch: {{4}}. – {{5}}', '["customer","doc_no","items","delivery_date","company"]', 'draft'),
  ('dispatched', 'en', 'utility', 'sales.dispatched', 'none', 'Dear {{1}}, goods for {{2}} left on vehicle {{3}} (e-way bill {{4}}). Expected delivery: {{5}}. – {{6}}', '["customer","doc_no","vehicle","eway_bill","expected","company"]', 'draft'),
  ('delivered', 'en', 'utility', 'sales.delivered', 'none', 'Dear {{1}}, {{2}} was delivered and received by {{3}} at {{4}}. – {{5}}', '["customer","doc_no","receiver","time","company"]', 'draft'),
  ('payment_reminder', 'en', 'utility', 'sales.payment_reminder', 'none', 'Dear {{1}}, bill(s) {{2}} for ₹{{3}} are due on {{4}}. Please pay to our company account only. – {{5}}', '["customer","bills","amount","due_date","company"]', 'draft'),
  ('complaint_update', 'en', 'utility', 'sales.complaint_update', 'none', 'Dear {{1}}, complaint {{2}} is now: {{3}}. Next step: {{4}}. – {{5}}', '["customer","doc_no","stage","next_step","company"]', 'draft'),
  ('statement_request', 'en', 'utility', 'sales.statement', 'document', 'Dear {{1}}, your statement up to {{2}} is attached. Closing balance: ₹{{3}}. – {{4}}', '["customer","to_date","closing","company"]', 'draft')
on conflict do nothing;

grant select on all tables in schema api to authenticated;
revoke all on all functions in schema api from public, anon;
grant execute on all functions in schema api to authenticated;
grant execute on function api.log_sign_in_failure(text) to anon;
revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;
notify pgrst, 'reload schema';

-- 20261103006200_field_sales.sql
-- Phase 6 route sales and the salesman portal (§15, §15A): beats, salesman assignment, duty sessions (GPS only on duty,
-- after the notice), location pings, visits with the 150 m geofence computed in Postgres (haversine), out-of-fence approval
-- by the sales manager, collections with the Phase 3 cash limits (GST bills only under salesman_balance_scope = gst_only),
-- cash handover confirmed by a second login, end of day (refuses unsynced work), queries, promises to pay, statement on
-- WhatsApp, the salesman's reads and the route sales board, and the 90-day GPS purge. Additive.

-- ─────────── Beats and assignment ───────────
-- p: {company_id, id?, code, name, salesman_user_id, weekday 1-7, active, customers: [party_id, ...] in visit order}
-- Customers on a beat are assigned to the beat's salesman (the sales manager plans both).
create or replace function api.plan_beat(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_id uuid := nullif(p ->> 'id', '')::uuid; v_sm uuid := nullif(p ->> 'salesman_user_id', '')::uuid;
        e text; i int := 0; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'plan_beat'); if v_prev is not null then return v_prev; end if;
  if v_id is not null then select company_id into v_company from field.beats where id = v_id for update; end if;
  perform app.require(v_company, 'field.manage');
  if v_id is null then
    insert into field.beats (company_id, code, name, salesman_user_id, weekday, active)
    values (v_company, upper(trim(p ->> 'code')), trim(p ->> 'name'), v_sm, nullif(p ->> 'weekday', '')::int, coalesce((p ->> 'active')::boolean, true)) returning id into v_id;
  else
    update field.beats set name = coalesce(nullif(trim(p ->> 'name'), ''), name), salesman_user_id = coalesce(v_sm, salesman_user_id),
      weekday = coalesce(nullif(p ->> 'weekday', '')::int, weekday), active = coalesce((p ->> 'active')::boolean, active) where id = v_id;
  end if;
  if p ? 'customers' then
    delete from field.beat_customers where beat_id = v_id;
    for e in select jsonb_array_elements_text(p -> 'customers') loop
      i := i + 1;
      if not exists (select 1 from master.party_companies where party_id = e::uuid and company_id = v_company and is_customer) then
        perform app.raise_rule('party.not_linked', 'every beat customer must be a customer of this company', '22023');
      end if;
      insert into field.beat_customers (beat_id, party_id, seq) values (v_id, e::uuid, i);
      if v_sm is not null then update master.party_companies set salesman_user_id = v_sm where party_id = e::uuid and company_id = v_company; end if;
    end loop;
  end if;
  v_res := jsonb_build_object('id', v_id, 'customers', i);
  return app.request_done(p_client_request_id, 'plan_beat', v_res);
end $$;

create or replace function api.assign_salesman(p_client_request_id uuid, p_company_id uuid, p_party_id uuid, p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'assign_salesman'); if v_prev is not null then return v_prev; end if;
  perform app.require(p_company_id, 'field.manage');
  update master.party_companies set salesman_user_id = p_user_id where party_id = p_party_id and company_id = p_company_id and is_customer;
  if not found then perform app.raise_rule('party.not_linked', 'this customer is not linked to the company', '22023'); end if;
  v_res := jsonb_build_object('ok', true);
  return app.request_done(p_client_request_id, 'assign_salesman', v_res);
end $$;

-- ─────────── Duty and GPS ───────────
create or replace function app.my_session() returns field.duty_sessions
language sql stable security definer set search_path = '' as $$
  select * from field.duty_sessions where user_id = auth.uid() and ended_at is null limit 1
$$;

-- p: {company_id, notice_ack true, lat, lng, at}
create or replace function api.start_duty(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_id uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'start_duty'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'field.sell');
  if not coalesce((p ->> 'notice_ack')::boolean, false) then perform app.raise_rule('gps.notice_required', 'read and accept the location notice to start the day', '22023'); end if;
  if (app.my_session()).id is not null then perform app.raise_rule('duty.already_on', 'your day is already started', '22023'); end if;
  insert into field.duty_sessions (company_id, user_id, kind, notice_ack_at, client_request_id) values (v_company, auth.uid(), 'salesman', now(), p_client_request_id) returning id into v_id;
  if nullif(p ->> 'lat', '') is not null then
    insert into field.gps_points (company_id, user_id, session_id, at, lat, lng, source) values (v_company, auth.uid(), v_id, now(), (p ->> 'lat')::numeric, (p ->> 'lng')::numeric, 'ping');
  end if;
  v_res := jsonb_build_object('session_id', v_id);
  return app.request_done(p_client_request_id, 'start_duty', v_res);
end $$;

-- p_points: [{lat, lng, at, accuracy_m}] — refused when off duty; points outside the duty window are refused (offline batches keep their time).
create or replace function api.record_locations(p_client_request_id uuid, p_points jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; s field.duty_sessions; e jsonb; n int := 0; v_at timestamptz; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'record_locations'); if v_prev is not null then return v_prev; end if;
  s := app.my_session();
  if s.id is null then perform app.raise_rule('gps.off_duty', 'location is recorded only while you are on duty', '42501'); end if;
  for e in select * from jsonb_array_elements(coalesce(p_points, '[]'::jsonb)) loop
    v_at := coalesce(nullif(e ->> 'at', '')::timestamptz, now());
    if v_at < s.started_at or v_at > now() + interval '5 minutes' then perform app.raise_rule('gps.outside_duty', 'a point is outside your duty time', '22023'); end if;
    insert into field.gps_points (company_id, user_id, session_id, at, lat, lng, accuracy_m, source)
    values (s.company_id, auth.uid(), s.id, v_at, (e ->> 'lat')::numeric, (e ->> 'lng')::numeric, nullif(e ->> 'accuracy_m', '')::numeric, 'ping');
    n := n + 1;
  end loop;
  v_res := jsonb_build_object('recorded', n);
  return app.request_done(p_client_request_id, 'record_locations', v_res);
end $$;

-- The shop's saved pin: delivery address first, else billing.
create or replace function app.party_pin(p_party uuid) returns table (lat numeric, lng numeric)
language sql stable security definer set search_path = '' as $$
  select a.lat, a.lng from master.party_addresses a where a.party_id = p_party and a.lat is not null and a.lng is not null
  order by (a.kind = 'delivery') desc limit 1
$$;

-- ─────────── Visits ───────────
-- p: {company_id, party_id, lat, lng, at, beat_id, planned (default true), unplanned_reason, reason (out of the geofence)}
-- Within field.geofence_m (150 m) of the pin → accepted. Outside, or no pin → refused without a reason; with a reason it is
-- recorded as an exception waiting for the sales manager.
create or replace function api.check_in_visit(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_party uuid := (p ->> 'party_id')::uuid; s field.duty_sessions; v_pin record; v_dist numeric;
        v_radius numeric; v_ok boolean; v_id uuid; v_lat numeric := nullif(p ->> 'lat', '')::numeric; v_lng numeric := nullif(p ->> 'lng', '')::numeric;
        v_at timestamptz := coalesce(nullif(p ->> 'at', '')::timestamptz, now()); v_planned boolean := coalesce((p ->> 'planned')::boolean, true); v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'check_in_visit'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'field.sell');
  if not app.is_my_customer(v_company, v_party) then perform app.raise_rule('field.not_my_customer', 'this shop is not on your list', '42501'); end if;
  s := app.my_session();
  if s.id is null or s.company_id <> v_company then perform app.raise_rule('gps.off_duty', 'start your day before checking in', '42501'); end if;
  if exists (select 1 from field.visits where salesman_user_id = auth.uid() and check_out_at is null) then perform app.raise_rule('visit.open', 'check out of the last shop first', '22023'); end if;
  if not v_planned and coalesce(length(trim(p ->> 'unplanned_reason')), 0) < 3 then perform app.raise_rule('visit.unplanned_reason', 'an unplanned visit needs a reason', '22023'); end if;
  if v_lat is null or v_lng is null then perform app.raise_rule('visit.no_location', 'the phone did not give a location', '22023'); end if;
  v_radius := coalesce((app.setting(v_company, 'field.geofence_m'))::text::numeric, 150);
  select * into v_pin from app.party_pin(v_party);
  if v_pin.lat is not null then v_dist := app.distance_m(v_lat, v_lng, v_pin.lat, v_pin.lng); end if;
  v_ok := v_dist is not null and v_dist <= v_radius;
  if not v_ok and coalesce(length(trim(p ->> 'reason')), 0) < 3 then
    perform app.raise_rule('visit.out_of_fence', case when v_dist is null then 'this shop has no saved pin; give a reason for the sales manager'
                                                      else format('you are %s m from the shop pin (limit %s m); give a reason for the sales manager', round(v_dist), v_radius) end, '22023');
  end if;
  insert into field.visits (company_id, salesman_user_id, party_id, beat_id, session_id, planned, unplanned_reason, check_in_at, check_in_lat, check_in_lng, distance_m,
                            geofence_ok, out_of_fence_reason, approval, client_request_id)
  values (v_company, auth.uid(), v_party, nullif(p ->> 'beat_id', '')::uuid, s.id, v_planned, nullif(p ->> 'unplanned_reason', ''), v_at, v_lat, v_lng, v_dist,
          v_ok, case when not v_ok then trim(p ->> 'reason') end, case when v_ok then 'none' else 'pending' end, p_client_request_id)
  returning id into v_id;
  insert into field.gps_points (company_id, user_id, session_id, at, lat, lng, source) values (v_company, auth.uid(), s.id, v_at, v_lat, v_lng, 'check_in');
  v_res := jsonb_build_object('visit_id', v_id, 'geofence_ok', v_ok, 'distance_m', v_dist, 'radius_m', v_radius, 'approval', case when v_ok then 'none' else 'pending' end);
  return app.request_done(p_client_request_id, 'check_in_visit', v_res);
end $$;

create or replace function api.approve_out_of_geofence(p_client_request_id uuid, p_visit_id uuid, p_approve boolean, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v field.visits; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'approve_out_of_geofence'); if v_prev is not null then return v_prev; end if;
  select * into v from field.visits where id = p_visit_id for update;
  if v.id is null then perform app.raise_rule('visit.missing', 'visit not found', 'P0002'); end if;
  perform app.require(v.company_id, 'field.manage');
  if v.salesman_user_id = auth.uid() then perform app.raise_rule('sod.own_request', 'nobody approves their own check-in', '42501'); end if;
  if v.approval <> 'pending' then perform app.raise_rule('visit.not_pending', 'this check-in is not waiting for approval', '22023'); end if;
  update field.visits set approval = case when p_approve then 'approved' else 'refused' end, approved_by = auth.uid(), approved_at = now() where id = v.id;
  perform app.log_event('admin_action', jsonb_build_object('entity', 'geofence_exception', 'visit', v.id, 'approved', p_approve, 'note', p_note));
  v_res := jsonb_build_object('id', v.id, 'approval', case when p_approve then 'approved' else 'refused' end);
  return app.request_done(p_client_request_id, 'approve_out_of_geofence', v_res);
end $$;

-- p: {lat, lng, at, outcome order|no_order|collection|follow_up, no_order_reason, shelf, competitor_notes, photo_paths[], next_visit_on}
create or replace function api.check_out_visit(p_client_request_id uuid, p_visit_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v field.visits; v_pin record; v_dist numeric; v_at timestamptz := coalesce(nullif(p ->> 'at', '')::timestamptz, now()); v_res jsonb; v_path text;
begin
  v_prev := app.request_seen(p_client_request_id, 'check_out_visit'); if v_prev is not null then return v_prev; end if;
  select * into v from field.visits where id = p_visit_id for update;
  if v.id is null or v.salesman_user_id <> auth.uid() then perform app.raise_rule('visit.missing', 'not your visit', 'P0002'); end if;
  perform app.require(v.company_id, 'field.sell');
  if v.check_out_at is not null then perform app.raise_rule('visit.closed', 'already checked out', '22023'); end if;
  if coalesce(p ->> 'outcome', '') not in ('order', 'no_order', 'collection', 'follow_up') then perform app.raise_rule('visit.outcome', 'choose the outcome of the visit', '22023'); end if;
  if p ->> 'outcome' = 'no_order' and coalesce(length(trim(p ->> 'no_order_reason')), 0) < 3 then perform app.raise_rule('visit.no_order_reason', 'give the no-order reason', '22023'); end if;
  for v_path in select jsonb_array_elements_text(coalesce(p -> 'photo_paths', '[]'::jsonb)) loop
    if app.storage_company(v_path) is distinct from v.company_id then perform app.raise_rule('field.bad_path', 'photos are kept in the company''s private folder', '22023'); end if;
  end loop;
  select * into v_pin from app.party_pin(v.party_id);
  if v_pin.lat is not null and nullif(p ->> 'lat', '') is not null then v_dist := app.distance_m((p ->> 'lat')::numeric, (p ->> 'lng')::numeric, v_pin.lat, v_pin.lng); end if;
  update field.visits set check_out_at = v_at, check_out_lat = nullif(p ->> 'lat', '')::numeric, check_out_lng = nullif(p ->> 'lng', '')::numeric, check_out_distance_m = v_dist,
         outcome = p ->> 'outcome', no_order_reason = nullif(p ->> 'no_order_reason', ''), shelf = p -> 'shelf', competitor_notes = nullif(p ->> 'competitor_notes', ''),
         photo_paths = coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p -> 'photo_paths', '[]'::jsonb)) x), '{}'),
         next_visit_on = nullif(p ->> 'next_visit_on', '')::date
   where id = v.id;
  if nullif(p ->> 'lat', '') is not null and v.session_id is not null and exists (select 1 from field.duty_sessions where id = v.session_id and ended_at is null) then
    insert into field.gps_points (company_id, user_id, session_id, at, lat, lng, source) values (v.company_id, auth.uid(), v.session_id, v_at, (p ->> 'lat')::numeric, (p ->> 'lng')::numeric, 'check_out');
  end if;
  insert into sales.contact_attempts (company_id, party_id, kind, outcome, note, visit_id, by_user) values (v.company_id, v.party_id, 'visit', 'reached', nullif(p ->> 'no_order_reason', ''), v.id, auth.uid());
  v_res := jsonb_build_object('visit_id', v.id, 'check_out_distance_m', v_dist);
  return app.request_done(p_client_request_id, 'check_out_visit', v_res);
end $$;

-- ─────────── Collections (salesman) ───────────
-- Bills a salesman may see and collect against: GST bills only (scope gst_only, Q-12), or every bill when the owner sets 'full'.
create or replace function app.salesman_scope(p_company uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(app.setting(p_company, 'salesman_balance_scope') #>> '{}', 'gst_only')
$$;

create or replace function app.party_open_bills(p_company uuid, p_party uuid, p_gst_only boolean)
returns table (kind text, id uuid, bill_ref text, bill_date date, due_date date, amount numeric, open_amount numeric, tax_class text)
language sql stable security definer set search_path = '' as $$
  select * from (
    select 'sales_document'::text as kind, d.id, d.doc_no as bill_ref, d.doc_date as bill_date, d.due_date, d.total as amount,
           d.total - coalesce((select sum(a.amount) from acct.bill_allocations a where a.against_kind = 'sales_document' and a.against_id = d.id), 0) as open_amount, d.tax_class
    from sales.documents d where d.company_id = p_company and d.party_id = p_party and d.status = 'posted' and d.doc_type in ('sales_invoice', 'bill_of_supply')
      and (not p_gst_only or d.tax_class = 'taxable')
    union all
    select 'open_bill', o.id, o.bill_ref, o.bill_date, coalesce(o.due_date, o.bill_date), o.amount,
           o.amount - coalesce((select sum(a.amount) from acct.bill_allocations a where a.against_kind = 'open_bill' and a.against_id = o.id), 0), o.tax_class
    from acct.open_bills o where o.company_id = p_company and o.party_id = p_party and o.dc = 'D'
      and (not p_gst_only or o.tax_class not in ('without_gst', 'unclassified'))) x
  where x.open_amount > 0.005
$$;

-- p: {company_id, party_id, amount, mode cash|cheque|upi|bank, reference, cheque_photo_path, visit_id, date}
-- Cash: the ₹2 lakh per person per day refusal (Phase 3 app.cash_check). Allocation oldest bill first among the bills the salesman
-- may see; the rest stays on account. Money goes to the posting-rule accounts field.cash_in_hand (cash, "with me" until handover)
-- or field.collection_bank (company collection account).
create or replace function api.field_collect(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_party uuid := (p ->> 'party_id')::uuid; v_amount numeric := round((p ->> 'amount')::numeric, 2);
        v_mode text := coalesce(p ->> 'mode', 'cash'); v_date date := coalesce(nullif(p ->> 'date', '')::date, current_date); v_fy uuid; v_no text; v_acc uuid; v_party_acc uuid;
        v_voucher uuid; v_left numeric; b record; v_take numeric; v_alloc jsonb := '[]'::jsonb; v_gst boolean; v_balance numeric; v_res jsonb; v_name text;
begin
  v_prev := app.request_seen(p_client_request_id, 'field_collect'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'field.sell');
  if not app.is_my_customer(v_company, v_party) then perform app.raise_rule('field.not_my_customer', 'this shop is not on your list', '42501'); end if;
  if v_amount is null or v_amount <= 0 then perform app.raise_rule('money.amount', 'the amount must be above zero', '22023'); end if;
  if v_mode not in ('cash', 'cheque', 'upi', 'bank') then perform app.raise_rule('money.mode', 'cash, cheque, UPI or bank transfer', '22023'); end if;
  if v_mode = 'cheque' and (nullif(p ->> 'cheque_photo_path', '') is null or app.storage_company(p ->> 'cheque_photo_path') is distinct from v_company) then
    perform app.raise_rule('field.cheque_photo', 'take a photo of the cheque', '22023');
  end if;
  if v_mode in ('upi', 'bank') and coalesce(length(trim(p ->> 'reference')), 0) < 4 then perform app.raise_rule('field.reference', 'enter the UPI or bank reference', '22023'); end if;
  perform 1 from master.party_companies where party_id = v_party and company_id = v_company for update;
  perform app.check_backdate(v_company, v_date);
  v_fy := app.fy_for(v_company, v_date);
  if v_mode = 'cash' then perform app.cash_check(v_company, v_party, v_date, v_amount, 'receipt', null); end if;
  v_acc := app.rule_account(v_company, case when v_mode = 'cash' then 'field.cash_in_hand' else 'field.collection_bank' end);
  if (select kind from acct.accounts where id = v_acc) <> (case when v_mode = 'cash' then 'cash' else 'bank' end) then
    perform app.raise_rule('money.account', 'the field collection posting rule must point to a ' || case when v_mode = 'cash' then 'cash' else 'bank' end || ' account', '22023');
  end if;
  v_party_acc := app.party_account(v_company, v_party, 'debtors');
  v_no := app.take_doc_number(v_company, null, 'receipt', v_fy);
  v_voucher := app.post_voucher(jsonb_build_object('company_id', v_company, 'fy_id', v_fy, 'voucher_type', 'receipt', 'doc_no', v_no, 'voucher_date', v_date, 'party_id', v_party,
      'narration', 'Field collection' || coalesce(' · ' || nullif(p ->> 'reference', ''), ''), 'mode', case when v_mode = 'bank' then 'bank' else v_mode end,
      'source_table', 'field.collections', 'client_request_id', p_client_request_id),
    jsonb_build_array(jsonb_build_object('account_id', v_acc, 'dr', v_amount), jsonb_build_object('account_id', v_party_acc, 'party_id', v_party, 'cr', v_amount)));
  v_gst := app.salesman_scope(v_company) = 'gst_only';
  v_left := v_amount;
  for b in select * from app.party_open_bills(v_company, v_party, v_gst) order by due_date nulls last, bill_date, bill_ref loop
    exit when v_left <= 0;
    v_take := least(v_left, b.open_amount);
    insert into acct.bill_allocations (company_id, voucher_id, party_id, against_kind, against_id, amount) values (v_company, v_voucher, v_party, b.kind, b.id, v_take);
    v_alloc := v_alloc || jsonb_build_object('kind', b.kind, 'bill_ref', b.bill_ref, 'amount', v_take);
    v_left := v_left - v_take;
  end loop;
  if v_left > 0 then insert into acct.bill_allocations (company_id, voucher_id, party_id, against_kind, amount) values (v_company, v_voucher, v_party, 'on_account', v_left); end if;
  insert into field.collections (company_id, salesman_user_id, party_id, voucher_id, amount, mode, reference, cheque_photo_path, visit_id, client_request_id)
  values (v_company, auth.uid(), v_party, v_voucher, v_amount, v_mode, nullif(p ->> 'reference', ''), nullif(p ->> 'cheque_photo_path', ''), nullif(p ->> 'visit_id', '')::uuid, p_client_request_id);
  select coalesce(sum(open_amount), 0) into v_balance from app.party_open_bills(v_company, v_party, true);
  select legal_name into v_name from master.parties where id = v_party;
  perform app.enqueue_message(jsonb_build_object('company_id', v_company, 'event', 'sales.payment_received', 'template', 'payment_received', 'party_id', v_party,
    'doc_type', 'acct.vouchers', 'doc_id', v_voucher, 'stage', 'posted',
    'params', jsonb_build_object('customer', v_name, 'amount', v_amount, 'doc_no', v_no, 'balance', v_balance, 'company', (select short_name from core.companies where id = v_company))));
  v_res := jsonb_build_object('voucher_id', v_voucher, 'doc_no', v_no, 'allocated', v_alloc, 'on_account', v_left, 'balance_gst', v_balance);
  return app.request_done(p_client_request_id, 'field_collect', v_res);
end $$;

-- ─────────── Cash handover (two logins) ───────────
create or replace function app.count_total(p_count jsonb) returns numeric
language sql immutable set search_path = '' as $$
  select coalesce(sum(k::numeric * (v #>> '{}')::numeric), 0) from jsonb_each(coalesce(p_count, '{}'::jsonb)) as e(k, v)
$$;

-- p: {company_id, denominations: {"500": n, "200": n, ...}, cheques}
create or replace function api.cash_handover(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_expected numeric; v_id uuid; v_total numeric; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'cash_handover'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'field.sell');
  perform pg_advisory_xact_lock(hashtextextended('handover|' || auth.uid()::text, 0));
  if exists (select 1 from field.cash_handovers where salesman_user_id = auth.uid() and company_id = v_company and status = 'pending') then
    perform app.raise_rule('field.handover_pending', 'your last handover is waiting for the cashier', '22023');
  end if;
  select coalesce(sum(amount), 0) into v_expected from field.collections where salesman_user_id = auth.uid() and company_id = v_company and mode = 'cash' and handover_id is null;
  v_total := app.count_total(p -> 'denominations');
  insert into field.cash_handovers (company_id, salesman_user_id, handover_date, expected_cash, salesman_count, salesman_total, cheques, client_request_id)
  values (v_company, auth.uid(), current_date, v_expected, coalesce(p -> 'denominations', '{}'::jsonb), v_total, coalesce((p ->> 'cheques')::int, 0), p_client_request_id)
  returning id into v_id;
  update field.collections set handover_id = v_id where salesman_user_id = auth.uid() and company_id = v_company and mode = 'cash' and handover_id is null;
  v_res := jsonb_build_object('id', v_id, 'expected', v_expected, 'counted', v_total, 'difference', v_total - v_expected);
  return app.request_done(p_client_request_id, 'cash_handover', v_res);
end $$;

-- Contra from cash with the salesman to the counter cash account.
create or replace function app.handover_contra(h field.cash_handovers, p_amount numeric, p_crid uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_fy uuid; v_no text; v_from uuid;
begin
  if p_amount <= 0 then return null; end if;
  v_fy := app.fy_for(h.company_id, current_date);
  v_from := app.rule_account(h.company_id, 'field.cash_in_hand');
  if h.to_account_id is null or (select kind from acct.accounts where id = h.to_account_id and company_id = h.company_id) is distinct from 'cash' then
    perform app.raise_rule('money.account', 'choose the cash account the money goes into', '22023');
  end if;
  v_no := app.take_doc_number(h.company_id, null, 'contra', v_fy);
  return app.post_voucher(jsonb_build_object('company_id', h.company_id, 'fy_id', v_fy, 'voucher_type', 'contra', 'doc_no', v_no, 'voucher_date', current_date,
      'narration', 'Salesman cash handover', 'mode', 'cash', 'source_table', 'field.cash_handovers', 'source_id', h.id, 'client_request_id', p_crid),
    jsonb_build_array(jsonb_build_object('account_id', h.to_account_id, 'dr', p_amount), jsonb_build_object('account_id', v_from, 'cr', p_amount)));
end $$;

-- The cashier counts again on their own login. Counts and the expected cash must all agree, else the handover is flagged.
-- p: {denominations, to_account_id}
create or replace function api.confirm_cash_handover(p_client_request_id uuid, p_handover_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; h field.cash_handovers; v_total numeric; v_status text; v_bug uuid; v_contra uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'confirm_cash_handover'); if v_prev is not null then return v_prev; end if;
  select * into h from field.cash_handovers where id = p_handover_id for update;
  if h.id is null then perform app.raise_rule('field.handover_missing', 'handover not found', 'P0002'); end if;
  perform app.require(h.company_id, 'cash_book.create');
  if h.salesman_user_id = auth.uid() then perform app.raise_rule('sod.own_request', 'the cashier confirms on another login', '42501'); end if;
  if h.status <> 'pending' then perform app.raise_rule('field.handover_state', 'this handover is already confirmed', '22023'); end if;
  v_total := app.count_total(p -> 'denominations');
  update field.cash_handovers set cashier_user_id = auth.uid(), cashier_count = coalesce(p -> 'denominations', '{}'::jsonb), cashier_total = v_total,
         difference = v_total - h.expected_cash, to_account_id = nullif(p ->> 'to_account_id', '')::uuid, confirmed_at = now()
   where id = h.id returning * into h;
  if v_total = h.salesman_total and v_total = h.expected_cash then
    v_status := 'confirmed';
    v_contra := app.handover_contra(h, v_total, p_client_request_id);
  else
    v_status := 'mismatch';
    v_bug := app.open_bug(jsonb_build_object('company_id', h.company_id, 'area', 'cash', 'kind', 'total_mismatch', 'severity', 'high',
      'title', 'Salesman cash handover does not match', 'evidence', jsonb_build_object('handover_id', h.id, 'expected', h.expected_cash, 'salesman_count', h.salesman_total, 'cashier_count', v_total),
      'suggested_fix', 'Recount with both people; finance resolves the difference', 'who_fixes', 'accounts', 'ref_table', 'field.cash_handovers', 'ref_id', h.id,
      'dedupe_key', 'field.handover:' || h.id));
  end if;
  update field.cash_handovers set status = v_status, bug_item_id = v_bug, contra_voucher_id = v_contra where id = h.id;
  v_res := jsonb_build_object('id', h.id, 'status', v_status, 'difference', v_total - h.expected_cash, 'contra_voucher_id', v_contra);
  return app.request_done(p_client_request_id, 'confirm_cash_handover', v_res);
end $$;

-- Finance resolves a mismatch: the cashier's count goes into the cash account; the gap stays on the salesman's cash account.
create or replace function api.resolve_cash_handover(p_client_request_id uuid, p_handover_id uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; h field.cash_handovers; v_contra uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'resolve_cash_handover'); if v_prev is not null then return v_prev; end if;
  select * into h from field.cash_handovers where id = p_handover_id for update;
  if h.id is null then perform app.raise_rule('field.handover_missing', 'handover not found', 'P0002'); end if;
  perform app.require(h.company_id, 'cash_book.approve');
  if h.salesman_user_id = auth.uid() then perform app.raise_rule('sod.own_request', 'the salesman cannot resolve his own handover', '42501'); end if;
  if h.status <> 'mismatch' then perform app.raise_rule('field.handover_state', 'only a mismatch is resolved', '22023'); end if;
  if coalesce(length(trim(p_note)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'write what was found', '22023'); end if;
  v_contra := app.handover_contra(h, h.cashier_total, p_client_request_id);
  update field.cash_handovers set status = 'resolved', resolved_by = auth.uid(), resolution_note = p_note, contra_voucher_id = v_contra where id = h.id;
  update ops.bug_items set status = 'fixed', resolution = p_note, fixed_by = auth.uid(), fixed_at = now() where id = h.bug_item_id;
  v_res := jsonb_build_object('id', h.id, 'status', 'resolved', 'contra_voucher_id', v_contra);
  return app.request_done(p_client_request_id, 'resolve_cash_handover', v_res);
end $$;

-- End of day: refuses while anything is unsynced, a visit is open, cash is not handed over or the cashier has not confirmed.
-- p: {company_id, unsynced (count held on the phone), van_counts: [{product_id, qty}]}
create or replace function api.end_salesman_day(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid := (p ->> 'company_id')::uuid; s field.duty_sessions; v_id uuid; v_planned int; v_done int; v_orders numeric; v_coll numeric; v_ho uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'end_salesman_day'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'field.sell');
  if coalesce((p ->> 'unsynced')::int, 0) > 0 then perform app.raise_rule('field.unsynced', 'send everything on the phone before ending the day', '22023'); end if;
  s := app.my_session();
  if s.id is null then perform app.raise_rule('gps.off_duty', 'your day is not started', '22023'); end if;
  if exists (select 1 from field.visits where salesman_user_id = auth.uid() and check_out_at is null) then perform app.raise_rule('visit.open', 'check out of the last shop first', '22023'); end if;
  if exists (select 1 from field.collections where salesman_user_id = auth.uid() and company_id = v_company and mode = 'cash' and handover_id is null) then
    perform app.raise_rule('field.cash_not_handed_over', 'hand over the cash with you first', '22023');
  end if;
  if exists (select 1 from field.cash_handovers where salesman_user_id = auth.uid() and company_id = v_company and status = 'pending') then
    perform app.raise_rule('field.handover_pending', 'the cashier has not confirmed your handover yet', '22023');
  end if;
  select count(*) into v_planned from field.beat_customers bc join field.beats b on b.id = bc.beat_id
   where b.company_id = v_company and b.salesman_user_id = auth.uid() and b.active and b.weekday = extract(isodow from current_date);
  select count(*) into v_done from field.visits where salesman_user_id = auth.uid() and company_id = v_company and check_in_at >= s.started_at;
  select coalesce(sum(total), 0) into v_orders from sales.orders where created_by = auth.uid() and company_id = v_company and created_at >= s.started_at and status <> 'cancelled';
  select coalesce(sum(amount), 0) into v_coll from field.collections where salesman_user_id = auth.uid() and company_id = v_company and collected_at >= s.started_at;
  select id into v_ho from field.cash_handovers where salesman_user_id = auth.uid() and company_id = v_company order by created_at desc limit 1;
  insert into field.day_closes (company_id, user_id, close_date, session_id, visits_planned, visits_done, orders_total, collections_total, handover_id, van_counts)
  values (v_company, auth.uid(), current_date, s.id, v_planned, v_done, v_orders, v_coll, v_ho, p -> 'van_counts')
  on conflict (company_id, user_id, close_date) do update set session_id = excluded.session_id, visits_done = excluded.visits_done, orders_total = excluded.orders_total,
     collections_total = excluded.collections_total, handover_id = excluded.handover_id, van_counts = excluded.van_counts, closed_at = now()
  returning id into v_id;
  update field.duty_sessions set ended_at = now() where id = s.id;
  v_res := jsonb_build_object('id', v_id, 'visits_planned', v_planned, 'visits_done', v_done, 'orders_total', v_orders, 'collections_total', v_coll);
  return app.request_done(p_client_request_id, 'end_salesman_day', v_res);
end $$;

-- ─────────── Queries, promises, statement ───────────
create or replace function app.can_write_party(p_company uuid, p_party uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.can(p_company, 'sales.create') or (app.can(p_company, 'field.sell') and app.is_my_customer(p_company, p_party))
$$;

-- p: {company_id, party_id, kind, document_id, lot_id, description, photo_paths[]}. A product complaint also opens a complaint.
create or replace function api.log_query(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_party uuid := (p ->> 'party_id')::uuid; v_id uuid; v_cmp uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'log_query'); if v_prev is not null then return v_prev; end if;
  if not app.can_write_party(v_company, v_party) then perform app.raise_rule('rights.missing', 'you cannot log queries for this customer', '42501'); end if;
  perform app.require(v_company, case when app.can(v_company, 'sales.create') then 'sales.create' else 'field.sell' end);
  if nullif(p ->> 'document_id', '') is not null and not exists (select 1 from sales.documents where id = (p ->> 'document_id')::uuid and party_id = v_party and app.can_see_bill_class(tax_class)) then
    perform app.raise_rule('query.document', 'link one of this customer''s bills', '22023');
  end if;
  insert into field.queries (company_id, party_id, kind, document_id, lot_id, description, photo_paths, raised_by, client_request_id)
  values (v_company, v_party, p ->> 'kind', nullif(p ->> 'document_id', '')::uuid, nullif(p ->> 'lot_id', '')::uuid, trim(p ->> 'description'),
          coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p -> 'photo_paths', '[]'::jsonb)) x), '{}'), auth.uid(), p_client_request_id)
  returning id into v_id;
  if p ->> 'kind' = 'product_complaint' then
    v_cmp := app.create_complaint(jsonb_build_object('company_id', v_company, 'party_id', v_party, 'document_id', p ->> 'document_id', 'lot_id', p ->> 'lot_id',
                                                     'kind', 'product', 'description', p ->> 'description'));
    update field.queries set complaint_id = v_cmp where id = v_id;
  end if;
  v_res := jsonb_build_object('id', v_id, 'complaint_id', v_cmp);
  return app.request_done(p_client_request_id, 'log_query', v_res);
end $$;

-- p: {status, reply, next_step, assigned_to}
create or replace function api.answer_query(p_client_request_id uuid, p_query_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; q field.queries; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'answer_query'); if v_prev is not null then return v_prev; end if;
  select * into q from field.queries where id = p_query_id for update;
  if q.id is null then perform app.raise_rule('query.missing', 'query not found', 'P0002'); end if;
  perform app.require(q.company_id, 'sales.edit');
  if coalesce(p ->> 'status', q.status) not in ('open', 'in_progress', 'answered', 'closed') then perform app.raise_rule('query.status', 'unknown status', '22023'); end if;
  update field.queries set status = coalesce(p ->> 'status', status), reply = coalesce(nullif(p ->> 'reply', ''), reply), next_step = coalesce(nullif(p ->> 'next_step', ''), next_step),
         assigned_to = coalesce(nullif(p ->> 'assigned_to', '')::uuid, assigned_to), updated_at = now() where id = q.id;
  v_res := jsonb_build_object('id', q.id);
  return app.request_done(p_client_request_id, 'answer_query', v_res);
end $$;

-- p: {company_id, party_id, amount, promised_on, note}
create or replace function api.record_promise_to_pay(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_party uuid := (p ->> 'party_id')::uuid; v_id uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'record_promise_to_pay'); if v_prev is not null then return v_prev; end if;
  if not app.can_write_party(v_company, v_party) then perform app.raise_rule('rights.missing', 'not your customer', '42501'); end if;
  if (p ->> 'promised_on')::date < current_date then perform app.raise_rule('promise.date', 'the promised date cannot be in the past', '22023'); end if;
  insert into sales.promises_to_pay (company_id, party_id, amount, promised_on, note, recorded_by, client_request_id)
  values (v_company, v_party, round((p ->> 'amount')::numeric, 2), (p ->> 'promised_on')::date, nullif(p ->> 'note', ''), auth.uid(), p_client_request_id) returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'record_promise_to_pay', v_res);
end $$;

-- Statement of account on WhatsApp, only to the customer's registered consented number (§WA-3). A statement lists every
-- document as in the books, so one containing a bill without GST is sent only by Admin (same rule as api.statement_of_account).
create or replace function api.send_statement_whatsapp(p_client_request_id uuid, p_company_id uuid, p_party_id uuid, p_to date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_close numeric; v_id uuid; v_res jsonb; v_to date := coalesce(p_to, current_date);
begin
  v_prev := app.request_seen(p_client_request_id, 'send_statement_whatsapp'); if v_prev is not null then return v_prev; end if;
  if not (app.can(p_company_id, 'sales.view') or app.can(p_company_id, 'accounts.view') or (app.can(p_company_id, 'field.sell') and app.is_my_customer(p_company_id, p_party_id))) then
    perform app.raise_rule('rights.missing', 'you cannot send this statement', '42501');
  end if;
  if app.current_view() <> 'all' and (exists (select 1 from acct.gl_entries e where e.company_id = p_company_id and e.party_id = p_party_id and e.tax_class in ('without_gst', 'unclassified'))
      or exists (select 1 from acct.open_bills o where o.company_id = p_company_id and o.party_id = p_party_id and o.tax_class in ('without_gst', 'unclassified'))) then
    perform app.raise_rule('statement.admin_only', 'this statement includes documents only Admin can see; ask Admin to send it', '42501');
  end if;
  select coalesce(sum(case when a.opening_dc = 'D' then a.opening_balance else -a.opening_balance end), 0) into v_close from acct.accounts a where a.company_id = p_company_id and a.party_id = p_party_id;
  v_close := v_close + coalesce((select sum(e.dr - e.cr) from acct.gl_entries e where e.company_id = p_company_id and e.party_id = p_party_id and e.entry_date <= v_to), 0);
  v_id := app.enqueue_message(jsonb_build_object('company_id', p_company_id, 'event', 'sales.statement', 'template', 'statement_request', 'party_id', p_party_id,
    'doc_type', 'sales.statement', 'doc_id', p_party_id, 'stage', 'statement:' || v_to, 'window_kind', 'reminders',
    'params', jsonb_build_object('customer', (select legal_name from master.parties where id = p_party_id), 'to_date', to_char(v_to, 'DD-MM-YYYY'), 'closing', v_close,
                                 'company', (select short_name from core.companies where id = p_company_id))));
  v_res := jsonb_build_object('outbox_id', v_id, 'status', (select status from msg.outbox where id = v_id), 'skip_reason', (select skip_reason from msg.outbox where id = v_id));
  return app.request_done(p_client_request_id, 'send_statement_whatsapp', v_res);
end $$;

-- ─────────── Salesman reads ───────────
-- The customer's account as the salesman sees it (scope gst_only: GST bills only; every figure from the server, with as_of).
create or replace function api.salesman_customer_account(p_company_id uuid, p_party_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_scope text := app.salesman_scope(p_company_id); v_gst boolean; v_exp jsonb; v_bills jsonb; v_due numeric; v_age jsonb; v_last jsonb; v_prom jsonb; pc master.party_companies;
begin
  if not (app.can(p_company_id, 'sales.view') or (app.can(p_company_id, 'field.sell') and app.is_my_customer(p_company_id, p_party_id))) then
    perform app.raise_rule('field.not_my_customer', 'this shop is not on your list', '42501');
  end if;
  -- Admin/CA see every bill; everyone else follows the scope setting (gst_only until the owner decides, Q-12).
  v_gst := not (app.current_view() in ('all', 'all-readonly')) and (v_scope = 'gst_only' or not app.can_see_bill_class('without_gst'));
  select * into pc from master.party_companies where party_id = p_party_id and company_id = p_company_id;
  select coalesce(jsonb_agg(jsonb_build_object('kind', b.kind, 'id', b.id, 'bill_ref', b.bill_ref, 'bill_date', b.bill_date, 'due_date', b.due_date, 'amount', b.amount,
           'open_amount', b.open_amount, 'days_overdue', greatest(current_date - b.due_date, 0)) order by b.due_date, b.bill_date), '[]'::jsonb), coalesce(sum(b.open_amount), 0)
    into v_bills, v_due
  from app.party_open_bills(p_company_id, p_party_id, v_gst) b;
  select jsonb_build_object('not_due', coalesce(sum(b.open_amount) filter (where b.due_date is null or b.due_date >= current_date), 0),
                            '0-30', coalesce(sum(b.open_amount) filter (where current_date - b.due_date between 1 and 30), 0),
                            '31-60', coalesce(sum(b.open_amount) filter (where current_date - b.due_date between 31 and 60), 0),
                            '61-90', coalesce(sum(b.open_amount) filter (where current_date - b.due_date between 61 and 90), 0),
                            '90+', coalesce(sum(b.open_amount) filter (where current_date - b.due_date > 90), 0))
    into v_age from app.party_open_bills(p_company_id, p_party_id, v_gst) b;
  select jsonb_build_object('date', v.voucher_date, 'amount', v.amount) into v_last from acct.vouchers v
   where v.company_id = p_company_id and v.party_id = p_party_id and v.voucher_type = 'receipt' and v.status = 'posted' and (not v_gst or v.tax_class = 'taxable')
   order by v.voucher_date desc, v.posted_at desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'amount', amount, 'promised_on', promised_on, 'status', status) order by promised_on), '[]'::jsonb) into v_prom
  from sales.promises_to_pay where company_id = p_company_id and party_id = p_party_id and status = 'open';
  v_exp := app.credit_view(app.credit_exposure(p_company_id, p_party_id), 0);
  return jsonb_build_object('scope', case when v_gst then 'gst_only' else 'full' end, 'as_of', now(), 'balance_due', v_due, 'ageing', v_age,
    'overdue', v_due - (v_age ->> 'not_due')::numeric, 'credit_limit', coalesce(pc.credit_limit, 0), 'credit_status', pc.credit_status,
    'available_credit', v_exp -> 'available', 'credit_blocked', v_exp -> 'blocked', 'last_payment', v_last, 'promises', v_prom, 'open_bills', v_bills);
end $$;

-- The salesman's customers with flags (overdue GST amount, open query, credit hold, KYC missing, last visit, last order).
create or replace function api.my_customers(p_company_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('party_id', p.id, 'name', p.legal_name, 'trade_name', p.trade_name, 'gstin', p.gstin, 'kyc_status', p.kyc_status,
      'credit_status', pc.credit_status, 'tier', pc.tier,
      'overdue_gst', (select coalesce(sum(b.open_amount), 0) from app.party_open_bills(pc.company_id, p.id, true) b where b.due_date < current_date),
      'open_queries', (select count(*) from field.queries q where q.party_id = p.id and q.company_id = pc.company_id and q.status <> 'closed'),
      'last_visit', (select max(v.check_in_at) from field.visits v where v.party_id = p.id and v.company_id = pc.company_id),
      'last_order', (select max(o.order_date) from sales.orders o where o.party_id = p.id and o.company_id = pc.company_id and o.status <> 'cancelled'),
      'pin', (select jsonb_build_object('lat', x.lat, 'lng', x.lng) from app.party_pin(p.id) x),
      'phone_masked', (select '••' || right(c.whatsapp, 4) from master.party_contacts c where c.party_id = p.id and c.whatsapp is not null order by c.is_primary desc limit 1))
    order by p.legal_name), '[]'::jsonb)
  from master.party_companies pc join master.parties p on p.id = pc.party_id
  where pc.company_id = p_company_id and pc.salesman_user_id = auth.uid() and pc.active and app.can(p_company_id, 'field.sell')
$$;

-- Today's route: beats for the weekday in visit order, with why each shop is due and whether it was visited today.
create or replace function api.my_route_today(p_company_id uuid, p_date date) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('beat_id', b.id, 'beat', b.name, 'seq', bc.seq, 'party_id', p.id, 'name', p.legal_name,
      'pin', (select jsonb_build_object('lat', x.lat, 'lng', x.lng) from app.party_pin(p.id) x),
      'overdue_gst', (select coalesce(sum(o.open_amount), 0) from app.party_open_bills(b.company_id, p.id, true) o where o.due_date < coalesce(p_date, current_date)),
      'open_query', exists (select 1 from field.queries q where q.party_id = p.id and q.company_id = b.company_id and q.status <> 'closed'),
      'credit_hold', pc.credit_status = 'hold', 'kyc_missing', p.kyc_status <> 'verified',
      'visited', exists (select 1 from field.visits v where v.party_id = p.id and v.salesman_user_id = auth.uid() and (v.check_in_at at time zone 'Asia/Kolkata')::date = coalesce(p_date, current_date)),
      'last_visit', (select max(v.check_in_at) from field.visits v where v.party_id = p.id and v.company_id = b.company_id),
      'last_order', (select max(o.order_date) from sales.orders o where o.party_id = p.id and o.company_id = b.company_id and o.status <> 'cancelled'))
    order by b.code, bc.seq), '[]'::jsonb)
  from field.beats b join field.beat_customers bc on bc.beat_id = b.id join master.parties p on p.id = bc.party_id
  join master.party_companies pc on pc.party_id = p.id and pc.company_id = b.company_id
  where b.company_id = p_company_id and b.salesman_user_id = auth.uid() and b.active and b.weekday = extract(isodow from coalesce(p_date, current_date))
    and app.can(p_company_id, 'field.sell')
$$;

create or replace function api.my_day(p_company_id uuid, p_date date) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('date', coalesce(p_date, current_date),
    'on_duty', exists (select 1 from field.duty_sessions where user_id = auth.uid() and ended_at is null),
    'visits_planned', (select count(*) from field.beat_customers bc join field.beats b on b.id = bc.beat_id
                        where b.company_id = p_company_id and b.salesman_user_id = auth.uid() and b.active and b.weekday = extract(isodow from coalesce(p_date, current_date))),
    'visits_done', (select count(*) from field.visits where salesman_user_id = auth.uid() and company_id = p_company_id and (check_in_at at time zone 'Asia/Kolkata')::date = coalesce(p_date, current_date)),
    'orders_total', (select coalesce(sum(total), 0) from sales.orders where created_by = auth.uid() and company_id = p_company_id and order_date = coalesce(p_date, current_date) and status <> 'cancelled'),
    'collections_total', (select coalesce(sum(amount), 0) from field.collections where salesman_user_id = auth.uid() and company_id = p_company_id and (collected_at at time zone 'Asia/Kolkata')::date = coalesce(p_date, current_date)),
    'cash_with_me', (select coalesce(sum(amount), 0) from field.collections where salesman_user_id = auth.uid() and company_id = p_company_id and mode = 'cash' and handover_id is null),
    'cheques_with_me', (select count(*) from field.collections c where c.salesman_user_id = auth.uid() and c.company_id = p_company_id and c.mode = 'cheque'
                         and not exists (select 1 from field.day_closes d where d.user_id = auth.uid() and d.closed_at > c.collected_at)))
  where app.can(p_company_id, 'field.sell')
$$;

-- Sales manager board: every salesman's day, exceptions and cash with each salesman.
create or replace function api.route_sales_board(p_company_id uuid, p_date date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(p_company_id, 'field.manage');
  return (select coalesce(jsonb_agg(x order by x ->> 'name'), '[]'::jsonb) from (
    select jsonb_build_object('user_id', u.user_id, 'name', u.display_name,
      'on_duty', exists (select 1 from field.duty_sessions d where d.user_id = u.user_id and d.ended_at is null),
      'visits', (select coalesce(jsonb_agg(jsonb_build_object('visit_id', v.id, 'party', pa.legal_name, 'check_in_at', v.check_in_at, 'distance_m', v.distance_m,
                   'geofence_ok', v.geofence_ok, 'approval', v.approval, 'reason', v.out_of_fence_reason, 'outcome', v.outcome) order by v.check_in_at), '[]'::jsonb)
                 from field.visits v join master.parties pa on pa.id = v.party_id
                 where v.salesman_user_id = u.user_id and v.company_id = p_company_id and (v.check_in_at at time zone 'Asia/Kolkata')::date = coalesce(p_date, current_date)),
      'exceptions', (select count(*) from field.visits v where v.salesman_user_id = u.user_id and v.company_id = p_company_id and v.approval = 'pending'),
      'orders_total', (select coalesce(sum(o.total), 0) from sales.orders o where o.created_by = u.user_id and o.company_id = p_company_id and o.order_date = coalesce(p_date, current_date) and o.status <> 'cancelled'),
      'collected', (select coalesce(sum(c.amount), 0) from field.collections c where c.salesman_user_id = u.user_id and c.company_id = p_company_id and (c.collected_at at time zone 'Asia/Kolkata')::date = coalesce(p_date, current_date)),
      'cash_with_salesman', (select coalesce(sum(c.amount), 0) from field.collections c where c.salesman_user_id = u.user_id and c.company_id = p_company_id and c.mode = 'cash'
                             and (c.handover_id is null or exists (select 1 from field.cash_handovers h where h.id = c.handover_id and h.status in ('pending', 'mismatch')))),
      'last_point', (select jsonb_build_object('at', g.at, 'lat', g.lat, 'lng', g.lng) from field.gps_points g where g.user_id = u.user_id and g.company_id = p_company_id order by g.at desc limit 1)) as x
    from core.user_profiles u
    where exists (select 1 from core.user_roles r where r.user_id = u.user_id and r.role_key = 'salesman' and (r.company_id is null or r.company_id = p_company_id))) s);
end $$;

-- ─────────── GPS retention (DPDP: 90 days) ───────────
-- Deletes GPS points older than the retention period and clears the coordinates kept on visits and proofs of delivery.
create or replace function app.purge_gps(p_days int default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_days int := coalesce(p_days, (app.setting(null, 'field.gps_retention_days'))::text::int, 90); v_cut timestamptz; n1 int; n2 int; n3 int;
begin
  v_cut := now() - make_interval(days => v_days);
  delete from field.gps_points where at < v_cut;
  get diagnostics n1 = row_count;
  update field.visits set check_in_lat = null, check_in_lng = null, check_out_lat = null, check_out_lng = null
   where check_in_at < v_cut and (check_in_lat is not null or check_out_lat is not null);
  get diagnostics n2 = row_count;
  perform set_config('app.gps_purge', 'on', true);
  update sales.pods set lat = null, lng = null where created_at < v_cut and lat is not null;
  get diagnostics n3 = row_count;
  perform set_config('app.gps_purge', 'off', true);
  return jsonb_build_object('retention_days', v_days, 'points_deleted', n1, 'visits_cleared', n2, 'pods_cleared', n3);
end $$;

create or replace function api.purge_gps(p_client_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'purge_gps'); if v_prev is not null then return v_prev; end if;
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'Admin only', '42501'); end if;
  v_res := app.purge_gps(null);
  perform app.log_event('admin_action', jsonb_build_object('entity', 'gps_purge') || v_res);
  return app.request_done(p_client_request_id, 'purge_gps', v_res);
end $$;

-- Nightly purge with pg_cron when the extension can be enabled (Supabase supports it); otherwise documented in DEPLOYMENT_GUIDE.
do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron not available: %', sqlerrm;
  end;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.schedule('gps-retention-purge', '30 21 * * *', 'select app.purge_gps(null)');   -- 03:00 IST
    exception when others then
      raise notice 'could not schedule gps purge: %', sqlerrm;
    end;
  end if;
end $$;

grant select on all tables in schema api to authenticated;
revoke all on all functions in schema api from public, anon;
grant execute on all functions in schema api to authenticated;
grant execute on function api.log_sign_in_failure(text) to anon;
revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;
notify pgrst, 'reload schema';

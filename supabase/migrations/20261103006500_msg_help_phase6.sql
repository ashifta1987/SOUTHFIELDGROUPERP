-- 20261103006500_msg_help_phase6.sql
-- Phase 6 WhatsApp (§WA-9): payment reminders on the 7/3/0/3/7/14 schedule (setting msg.reminder_days) as one summary per customer
-- per day, only for consented contacts (others are recorded as skipped), never twice; disputed bills pause; a pending payment proof
-- holds the reminder; a settled bill cancels queued reminders. Monthly cost caps per company: estimated cost per message from Admin's
-- rates, an alert at the alert %, and non-urgent messages skipped (skip_reason) once the cap is reached. Inbox: inbound messages
-- deduplicated, STOP opts out, payment proofs create urgent finance tasks, replies only inside the 24-hour window.
-- Help assistant data tools (§HELP-9): security invoker, under the user's own rights; no salary, KYC, bank or without-GST figures
-- reach a non-Admin. Additive.

-- ─────────── Cost caps ───────────
create or replace function app.msg_rate(p_category text, p_on date) returns numeric
language sql stable security definer set search_path = '' as $$
  select est_cost from msg.message_rates where category = p_category and effective_from <= p_on order by effective_from desc limit 1
$$;

create or replace function app.msg_month_spend(p_company uuid, p_month date) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(est_cost), 0) from msg.outbox
  where company_id = p_company and status not in ('skipped', 'cancelled', 'failed')
    and date_trunc('month', created_at at time zone 'Asia/Kolkata')::date = p_month
$$;

-- Urgent = documents the customer must have (invoice, receipt, credit note, dispatch, delivery); everything else pauses at the cap.
create or replace function app.msg_is_urgent(p_event text, p_window text) returns boolean
language sql immutable set search_path = '' as $$
  select p_window = 'documents' and p_event in ('sales.invoice_posted', 'sales.payment_received', 'sales.credit_note', 'sales.dispatched', 'sales.delivered',
                                                'purchase.po_issued', 'purchase.payment_advice', 'hr.payslip_ready')
$$;

-- Every outbox insert (from any RPC) gets its estimated cost; non-urgent messages are skipped once the month's cap is reached.
create or replace function app.outbox_cost_cap() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_cap msg.cost_caps; v_month date := date_trunc('month', now() at time zone 'Asia/Kolkata')::date; v_spend numeric;
begin
  if new.est_cost is null then new.est_cost := round(app.msg_rate(new.category, current_date), 2); end if;
  if new.status <> 'queued' then return new; end if;
  select * into v_cap from msg.cost_caps where company_id = new.company_id;
  if v_cap.company_id is null then return new; end if;
  v_spend := app.msg_month_spend(new.company_id, v_month);
  if v_spend >= v_cap.monthly_cap and not app.msg_is_urgent(new.event, new.window_kind) then
    new.status := 'skipped'; new.skip_reason := 'monthly cost cap reached';
    insert into msg.cost_alerts (company_id, month, level) values (new.company_id, v_month, 'cap') on conflict do nothing;
    return new;
  end if;
  if v_spend + coalesce(new.est_cost, 0) >= v_cap.monthly_cap * v_cap.alert_pct / 100 then
    insert into msg.cost_alerts (company_id, month, level) values (new.company_id, v_month, 'alert') on conflict do nothing;
  end if;
  return new;
end $$;
create trigger outbox_cost_cap before insert on msg.outbox for each row execute function app.outbox_cost_cap();

create or replace function api.set_cost_cap(p_client_request_id uuid, p_company_id uuid, p_monthly_cap numeric, p_alert_pct numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_cost_cap'); if v_prev is not null then return v_prev; end if;
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'Admin only', '42501'); end if;
  insert into msg.cost_caps (company_id, monthly_cap, alert_pct, set_by) values (p_company_id, round(p_monthly_cap, 2), coalesce(p_alert_pct, 80), auth.uid())
  on conflict (company_id) do update set monthly_cap = excluded.monthly_cap, alert_pct = excluded.alert_pct, set_by = excluded.set_by, set_at = now();
  perform app.log_event('setting_changed', jsonb_build_object('entity', 'msg_cost_cap', 'company_id', p_company_id));
  v_res := jsonb_build_object('ok', true);
  return app.request_done(p_client_request_id, 'set_cost_cap', v_res);
end $$;

create or replace function api.set_message_rate(p_client_request_id uuid, p_category text, p_est_cost numeric, p_effective_from date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_message_rate'); if v_prev is not null then return v_prev; end if;
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'Admin only', '42501'); end if;
  insert into msg.message_rates (category, est_cost, effective_from, set_by) values (p_category, p_est_cost, coalesce(p_effective_from, current_date), auth.uid())
  on conflict (category, effective_from) do update set est_cost = excluded.est_cost, set_by = excluded.set_by, set_at = now();
  v_res := jsonb_build_object('ok', true);
  return app.request_done(p_client_request_id, 'set_message_rate', v_res);
end $$;

-- ─────────── Payment reminders ───────────
-- One summary message per customer per day for the GST bills whose (date − due date) is on the schedule. Bills without GST are not
-- put into reminder messages (Q-P6-6). Re-running the same day queues nothing new (idempotency key).
create or replace function app.schedule_reminders(p_company uuid, p_date date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_days int[]; r record; v_id uuid; v_status text; v_queued int := 0; v_skipped int := 0; v_proof boolean; v_company_name text;
begin
  select array_agg(x::int) into v_days from jsonb_array_elements_text(coalesce(app.setting(p_company, 'msg.reminder_days', p_date), '[]'::jsonb)) x;
  if v_days is null then return jsonb_build_object('queued', 0, 'skipped', 0, 'note', 'no reminder schedule set'); end if;
  select short_name into v_company_name from core.companies where id = p_company;
  for r in
    select d.party_id, p.legal_name, string_agg(d.doc_no, ', ' order by d.due_date, d.doc_no) as bills, sum(o.open_amt) as amount, min(d.due_date) as due,
           jsonb_agg(d.id order by d.doc_no) as bill_ids, array_agg(distinct (p_date - d.due_date)) as offsets
    from sales.documents d
    join master.parties p on p.id = d.party_id
    cross join lateral (select app.open_amount('sales_document', d.id) as open_amt) o
    where d.company_id = p_company and d.status = 'posted' and d.doc_type = 'sales_invoice' and d.tax_class = 'taxable' and d.due_date is not null
      and (p_date - d.due_date) = any (v_days) and o.open_amt > 0.005
      -- a disputed bill pauses its reminders while it is reviewed
      and not exists (select 1 from sales.complaints c where c.document_id = d.id and c.status not in ('closed', 'resolved', 'rejected'))
      and not exists (select 1 from field.queries q where q.document_id = d.id and q.kind = 'billing' and q.status <> 'closed')
    group by d.party_id, p.legal_name
  loop
    v_proof := exists (select 1 from msg.tasks t where t.party_id = r.party_id and t.kind = 'payment_proof' and t.status = 'open');
    v_id := app.enqueue_message(jsonb_build_object('company_id', p_company, 'event', 'sales.payment_reminder', 'template', 'payment_reminder', 'party_id', r.party_id,
      'doc_type', 'sales.reminder', 'doc_id', r.party_id, 'stage', 'reminder:' || p_date, 'window_kind', 'reminders',
      'params', jsonb_build_object('customer', r.legal_name, 'bills', r.bills, 'amount', r.amount, 'due_date', to_char(r.due, 'DD-MM-YYYY'), 'company', v_company_name,
                                   'bill_ids', r.bill_ids, 'offsets', to_jsonb(r.offsets))));
    if v_id is null then continue; end if;   -- already scheduled for this customer today
    update msg.outbox set send_after = greatest(now(), (p_date + time '10:00') at time zone 'Asia/Kolkata') where id = v_id;
    if v_proof then
      update msg.outbox set status = 'skipped', skip_reason = 'payment proof pending' where id = v_id and status = 'queued';
    end if;
    select status into v_status from msg.outbox where id = v_id;
    if v_status = 'queued' then v_queued := v_queued + 1; else v_skipped := v_skipped + 1; end if;
  end loop;
  return jsonb_build_object('queued', v_queued, 'skipped', v_skipped, 'date', p_date);
end $$;

create or replace function api.schedule_reminders(p_client_request_id uuid, p_company_id uuid, p_date date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'schedule_reminders'); if v_prev is not null then return v_prev; end if;
  if not (app.is_admin() or app.can(p_company_id, 'receipts_payments.create')) then perform app.raise_rule('rights.missing', 'Admin or accounts only', '42501'); end if;
  perform app.require(p_company_id, case when app.is_admin() then 'settings.manage' else 'receipts_payments.create' end);
  v_res := app.schedule_reminders(p_company_id, coalesce(p_date, current_date));
  return app.request_done(p_client_request_id, 'schedule_reminders', v_res);
end $$;

-- Daily job for every active company (pg_cron, IST morning).
create or replace function app.schedule_reminders_all() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c record; v jsonb := '{}'::jsonb;
begin
  for c in select id, code from core.companies where status = 'active' loop
    v := v || jsonb_build_object(c.code, app.schedule_reminders(c.id, (now() at time zone 'Asia/Kolkata')::date));
  end loop;
  return v;
end $$;

-- A settled bill cancels queued reminders whose bills are now all paid.
create or replace function app.cancel_settled_reminders() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.against_kind <> 'sales_document' or new.against_id is null then return new; end if;
  update msg.outbox o set status = 'cancelled', skip_reason = 'bill settled', updated_at = now()
   where o.event = 'sales.payment_reminder' and o.status = 'queued' and o.params -> 'bill_ids' ? new.against_id::text
     and not exists (select 1 from jsonb_array_elements_text(o.params -> 'bill_ids') b where app.open_amount('sales_document', b::uuid) > 0.005);
  return new;
end $$;
create trigger alloc_cancel_reminders after insert on acct.bill_allocations for each row execute function app.cancel_settled_reminders();

-- ─────────── Inbox ───────────
-- p: {wa_message_id, from_number, kind text|image|document|audio, body, media_path, company_id}. Called by the whatsapp-webhook
-- Edge Function (service role) after the signature check, or by Admin. Duplicates are ignored.
create or replace function app.record_inbound(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_party uuid; v_company uuid := nullif(p ->> 'company_id', '')::uuid; v_from text := p ->> 'from_number'; v_body text := coalesce(p ->> 'body', '');
        v_kind text := coalesce(p ->> 'kind', 'text'); v_task uuid; v_task_kind text; v_sm uuid; v_stop boolean;
begin
  select c.party_id into v_party from master.party_contacts c where c.whatsapp = v_from order by c.is_primary desc limit 1;
  if v_company is null then select company_id into v_company from msg.outbox where to_number = v_from order by created_at desc limit 1; end if;
  insert into msg.inbound (company_id, wa_message_id, from_number, kind, body, media_path, party_id, window_expires_at)
  values (v_company, p ->> 'wa_message_id', v_from, v_kind, nullif(v_body, ''), nullif(p ->> 'media_path', ''), v_party, now() + interval '24 hours')
  on conflict (wa_message_id) do nothing returning id into v_id;
  if v_id is null then return jsonb_build_object('duplicate', true); end if;
  v_stop := upper(trim(v_body)) in ('STOP', 'UNSUBSCRIBE', 'നിർത്തുക', 'நிறுத்து', 'बंद करें', 'रोकें');
  if v_stop then
    update master.party_contacts set whatsapp_consent = false where whatsapp = v_from;
    update msg.outbox set status = 'cancelled', skip_reason = 'opted out (STOP)', updated_at = now() where to_number = v_from and status = 'queued';
    update msg.inbound set handled_at = now() where id = v_id;
    return jsonb_build_object('inbound_id', v_id, 'opted_out', true);
  end if;
  v_task_kind := case when v_kind in ('image', 'document') or v_body ~* '(\mpaid\M|payment (done|made|sent)|\mtransferred\M|\mutr\M|\mneft\M|\mrtgs\M|\mimps\M|അടച്ചു|செலுத்தி|भुगतान)'
                      then 'payment_proof' else 'reply_needed' end;
  select pc.salesman_user_id into v_sm from master.party_companies pc where pc.party_id = v_party and pc.company_id = v_company;
  insert into msg.tasks (company_id, kind, party_id, inbound_id, priority, due_at, assigned_user_id)
  values (v_company, v_task_kind, v_party, v_id, case when v_task_kind = 'payment_proof' then 'urgent' else 'normal' end,
          case when v_task_kind = 'payment_proof' then now() + interval '2 days' else now() + interval '1 day' end, v_sm)
  returning id into v_task;
  update msg.inbound set task_id = v_task where id = v_id;
  return jsonb_build_object('inbound_id', v_id, 'task_id', v_task, 'task_kind', v_task_kind, 'party_id', v_party);
end $$;

create or replace function api.record_inbound(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'record_inbound'); if v_prev is not null then return v_prev; end if;
  if not (app.is_admin() or coalesce(auth.jwt() ->> 'role', '') = 'service_role') then perform app.raise_rule('rights.missing', 'webhook or Admin only', '42501'); end if;
  v_res := app.record_inbound(p);
  return app.request_done(p_client_request_id, 'record_inbound', v_res);
end $$;

create or replace function api.resolve_task(p_client_request_id uuid, p_task_id uuid, p_status text, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; t msg.tasks; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'resolve_task'); if v_prev is not null then return v_prev; end if;
  select * into t from msg.tasks where id = p_task_id for update;
  if t.id is null then perform app.raise_rule('task.missing', 'task not found', 'P0002'); end if;
  if not (app.is_admin() or (t.company_id is not null and app.can(t.company_id, 'receipts_payments.create')) or t.assigned_user_id = auth.uid()) then
    perform app.raise_rule('rights.missing', 'finance, the assigned person or Admin', '42501');
  end if;
  if t.kind = 'payment_proof' and t.assigned_user_id = auth.uid() and not (app.is_admin() or app.can(t.company_id, 'receipts_payments.create')) then
    perform app.raise_rule('task.finance_only', 'a payment proof is checked by finance against the bank', '42501');
  end if;
  if p_status not in ('done', 'dismissed') then perform app.raise_rule('task.status', 'done or dismissed', '22023'); end if;
  if t.status <> 'open' then perform app.raise_rule('task.closed', 'already closed', '22023'); end if;
  update msg.tasks set status = p_status, note = p_note, resolved_by = auth.uid(), resolved_at = now() where id = t.id;
  update msg.inbound set handled_by = auth.uid(), handled_at = now() where id = t.inbound_id;
  v_res := jsonb_build_object('id', t.id, 'status', p_status);
  return app.request_done(p_client_request_id, 'resolve_task', v_res);
end $$;

-- Free-text reply inside the 24-hour window, only to a consented number (§WA-6, AGENTS rule 10).
create or replace function api.reply_inbound(p_client_request_id uuid, p_inbound_id uuid, p_text text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; i msg.inbound; v_id uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'reply_inbound'); if v_prev is not null then return v_prev; end if;
  select * into i from msg.inbound where id = p_inbound_id for update;
  if i.id is null then perform app.raise_rule('msg.inbound_missing', 'message not found', 'P0002'); end if;
  if not (app.is_admin() or (i.company_id is not null and app.can(i.company_id, 'receipts_payments.create'))
          or exists (select 1 from master.party_companies pc where pc.party_id = i.party_id and pc.company_id = i.company_id and pc.salesman_user_id = auth.uid())) then
    perform app.raise_rule('rights.missing', 'finance, the customer''s salesperson or Admin', '42501');
  end if;
  if i.window_expires_at is null or i.window_expires_at < now() then perform app.raise_rule('msg.window_closed', 'the 24-hour window has closed; use an approved template', '22023'); end if;
  if not exists (select 1 from master.party_contacts c where c.whatsapp = i.from_number and c.whatsapp_consent) then
    perform app.raise_rule('msg.not_consented', 'this number has not given consent', '42501');
  end if;
  if coalesce(length(trim(p_text)), 0) < 1 then perform app.raise_rule('msg.empty', 'type the reply', '22023'); end if;
  insert into msg.outbox (company_id, event, template_name, to_number, party_id, params, doc_type, doc_id, idempotency_key, category, window_kind)
  values (i.company_id, 'msg.reply', 'free_text', i.from_number, i.party_id, jsonb_build_object('text', left(p_text, 1000)), 'msg.inbound', i.id, 'reply|' || p_client_request_id, 'service', 'documents')
  returning id into v_id;
  update msg.inbound set handled_by = auth.uid(), handled_at = now() where id = i.id;
  v_res := jsonb_build_object('outbox_id', v_id);
  return app.request_done(p_client_request_id, 'reply_inbound', v_res);
end $$;

-- ─────────── Help assistant data tools (security invoker: RLS and the view rule apply) ───────────
-- Status of a document by its number: sales documents, orders, dispatches, purchase bills/orders, transfers the user may see.
create or replace function api.help_get_document_status(p_doc_no text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  with hits as (
    select 'sales_document' as kind, d.doc_type as sub, d.doc_no, d.doc_date as date, d.status, d.total as amount, d.due_date from sales.documents d where d.doc_no = trim(p_doc_no)
    union all select 'sales_order', o.channel, o.doc_no, o.order_date, o.status, o.total, o.delivery_date from sales.orders o where o.doc_no = trim(p_doc_no)
    union all select 'dispatch', null, x.doc_no, x.created_at::date, x.status, null, null from sales.dispatches x where x.doc_no = trim(p_doc_no)
    union all select 'purchase_order', null, po.doc_no, po.order_date, po.status, po.total, po.delivery_date from purch.orders po where po.doc_no = trim(p_doc_no)
    union all select 'purchase_bill', null, b.doc_no, b.bill_date, b.status, b.total, b.due_date from purch.bills b where b.doc_no = trim(p_doc_no)
    union all select 'transfer', t.gst_doc_kind, t.doc_no, t.transfer_date, t.status, null, null from inv.transfers t where t.doc_no = trim(p_doc_no))
  select jsonb_build_object('found', count(*) > 0, 'documents', coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'type', sub, 'doc_no', doc_no, 'date', date, 'status', status,
                            'amount', amount, 'due_date', due_date)), '[]'::jsonb))
  from hits
$$;

-- What the user may do (roles, rights for a company or all, running special permissions). Never other people's data.
create or replace function api.help_check_my_rights(p_company_id uuid, p_right text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('view', app.current_view(),
    'roles', (select coalesce(jsonb_agg(jsonb_build_object('role', r.role_key, 'company_id', r.company_id)), '[]'::jsonb) from app.my_roles() r),
    'has_right', case when p_right is null then null else app.can(p_company_id, p_right) end,
    'rights', (select coalesce(jsonb_agg(distinct rr.right_key), '[]'::jsonb) from app.my_roles() r join core.role_rights rr on rr.role_key = r.role_key
               where p_company_id is null or r.company_id is null or r.company_id = p_company_id),
    'special_permissions', (select coalesce(jsonb_agg(jsonb_build_object('right', g.right_key, 'ends_at', g.ends_at)), '[]'::jsonb) from core.special_grants g
                            where g.user_id = auth.uid() and g.revoked_at is null and now() between g.starts_at and g.ends_at))
$$;

-- Stock of items matching a name or code (no cost or value).
create or replace function api.help_get_stock(p_query text, p_company_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('company_id', s.company_id, 'product_code', s.product_code, 'product', s.product_name, 'uom', s.uom, 'sellable', s.sellable,
                  'free', s.free, 'quarantine', s.quarantine, 'hold', s.hold, 'in_transit', s.in_transit) order by s.product_name), '[]'::jsonb)
  from (select * from api.item_stock i where (p_company_id is null or i.company_id = p_company_id)
          and (i.product_name ilike '%' || coalesce(p_query, '') || '%' or i.product_code ilike '%' || coalesce(p_query, '') || '%') limit 20) s
$$;

-- The user's own requests (special permissions, leave/advance — never amounts, purchase requests, credit applications).
create or replace function api.help_my_requests() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'special_permissions', (select coalesce(jsonb_agg(jsonb_build_object('right', r.right_key, 'status', r.status, 'requested_at', r.created_at) order by r.created_at desc), '[]'::jsonb)
                            from core.special_grant_requests r where r.requested_by = auth.uid()),
    'staff_requests', (select coalesce(jsonb_agg(jsonb_build_object('kind', h.kind, 'status', h.status, 'from_date', h.from_date, 'to_date', h.to_date, 'created_at', h.created_at)
                        order by h.created_at desc), '[]'::jsonb) from hr.requests h where h.requested_by = auth.uid()),
    'purchase_requests', (select coalesce(jsonb_agg(jsonb_build_object('doc_no', q.doc_no, 'status', q.status, 'request_date', q.request_date) order by q.request_date desc), '[]'::jsonb)
                          from purch.requests q where q.requested_by = auth.uid()),
    'credit_applications', (select coalesce(jsonb_agg(jsonb_build_object('doc_no', c.doc_no, 'stage', c.stage, 'status', c.status) order by c.created_at desc), '[]'::jsonb)
                            from sales.credit_applications c where c.requested_by = auth.uid()))
$$;

-- Ask Admin for a special permission (the existing request flow; Admin decides).
create or replace function api.help_request_permission(p_client_request_id uuid, p_right text, p_company_id uuid, p_hours int, p_reason text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  return api.request_special_permission(p_client_request_id, p_right, p_company_id, '{}'::jsonb, now(), now() + make_interval(hours => greatest(coalesce(p_hours, 8), 1)), p_reason);
end $$;

-- Daily reminder job with pg_cron when available (08:00 IST).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.schedule('payment-reminders', '30 2 * * *', 'select app.schedule_reminders_all()');
    exception when others then
      raise notice 'could not schedule reminders: %', sqlerrm;
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

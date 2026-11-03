-- 20261103006300_care_shops_exports_online.sql
-- Phase 6 customer care (complaints with QC hold of the lot everywhere, coverage tiers, call log, private label with three
-- approvals, agents and commission on verified collections only), own shops (counter sale = Phase 3 tax invoice + stock out of
-- the shop place + receipt; daily cash close), exports (orders, containers with ISO 6346 check, packing-list check, export
-- invoice under LUT via lawful reason export_lut — Admin only — or with IGST) and online channels (listings published by Admin,
-- marketplace orders become sales orders). Additive.

-- ─────────── Complaints and QC hold ───────────
create or replace function app.complaint_event(p_id uuid, p_to text, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare c sales.complaints;
begin
  select * into c from sales.complaints where id = p_id;
  insert into sales.complaint_events (complaint_id, from_status, to_status, note, by_user) values (c.id, c.status, p_to, p_note, auth.uid());
  update sales.complaints set status = p_to where id = c.id;
  perform app.enqueue_message(jsonb_build_object('company_id', c.company_id, 'event', 'sales.complaint_update', 'template', 'complaint_update', 'party_id', c.party_id,
    'doc_type', 'sales.complaints', 'doc_id', c.id, 'stage', p_to,
    'params', jsonb_build_object('customer', (select legal_name from master.parties where id = c.party_id), 'doc_no', c.doc_no, 'stage', p_to,
                                 'next_step', coalesce(p_note, '-'), 'company', (select short_name from core.companies where id = c.company_id))));
end $$;

-- p: {company_id, party_id, document_id, product_id, lot_id, kind, description, severity}
create or replace function app.create_complaint(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_company uuid := (p ->> 'company_id')::uuid; v_id uuid; v_product uuid := nullif(p ->> 'product_id', '')::uuid;
begin
  if nullif(p ->> 'lot_id', '') is not null then
    select product_id into v_product from inv.lots where id = (p ->> 'lot_id')::uuid and company_id = v_company;
    if v_product is null then perform app.raise_rule('complaint.lot', 'the batch is not of this company', '22023'); end if;
  end if;
  if coalesce(length(trim(p ->> 'description')), 0) < 3 then perform app.raise_rule('complaint.description', 'describe the complaint', '22023'); end if;
  insert into sales.complaints (company_id, doc_no, party_id, document_id, product_id, lot_id, kind, description, severity, logged_by, status)
  values (v_company, app.p6_doc_no(v_company, 'complaint', current_date), (p ->> 'party_id')::uuid, nullif(p ->> 'document_id', '')::uuid, v_product,
          nullif(p ->> 'lot_id', '')::uuid, coalesce(p ->> 'kind', 'product'), trim(p ->> 'description'), coalesce(p ->> 'severity', 'medium'), auth.uid(), 'logged')
  returning id into v_id;
  insert into sales.complaint_events (complaint_id, from_status, to_status, note, by_user) values (v_id, null, 'logged', null, auth.uid());
  perform app.enqueue_message(jsonb_build_object('company_id', v_company, 'event', 'sales.complaint_update', 'template', 'complaint_update', 'party_id', p ->> 'party_id',
    'doc_type', 'sales.complaints', 'doc_id', v_id, 'stage', 'logged',
    'params', jsonb_build_object('customer', (select legal_name from master.parties where id = (p ->> 'party_id')::uuid), 'doc_no', (select doc_no from sales.complaints where id = v_id),
                                 'stage', 'logged', 'next_step', 'quality check', 'company', (select short_name from core.companies where id = v_company))));
  return v_id;
end $$;

create or replace function api.log_complaint(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_id uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'log_complaint'); if v_prev is not null then return v_prev; end if;
  if not app.can_write_party(v_company, (p ->> 'party_id')::uuid) then perform app.raise_rule('rights.missing', 'you cannot log complaints for this customer', '42501'); end if;
  perform app.require(v_company, case when app.can(v_company, 'sales.create') then 'sales.create' else 'field.sell' end);
  v_id := app.create_complaint(p);
  v_res := jsonb_build_object('id', v_id, 'doc_no', (select doc_no from sales.complaints where id = v_id));
  return app.request_done(p_client_request_id, 'log_complaint', v_res);
end $$;

-- QC holds the lot everywhere: every available quantity of the lot at every place moves to the hold bucket (not sellable) and the
-- lot status becomes hold. p: {lot_id, complaint_id, reason}
create or replace function api.qc_hold_batch(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; lo inv.lots; b record; v_total numeric := 0; v_id uuid; v_res jsonb; v_cmp uuid := nullif(p ->> 'complaint_id', '')::uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'qc_hold_batch'); if v_prev is not null then return v_prev; end if;
  select * into lo from inv.lots where id = (p ->> 'lot_id')::uuid for update;
  if lo.id is null then perform app.raise_rule('lot.missing', 'batch not found', 'P0002'); end if;
  perform app.require(lo.company_id, case when app.can(lo.company_id, 'qc.release') then 'qc.release' else 'qc.test' end);
  if coalesce(length(trim(p ->> 'reason')), 0) < 5 then perform app.raise_rule('rights.reason_required', 'give the reason for the hold', '22023'); end if;
  if exists (select 1 from inv.qc_holds where lot_id = lo.id and status = 'on_hold') then perform app.raise_rule('qc.already_on_hold', 'this batch is already on hold', '22023'); end if;
  insert into inv.qc_holds (company_id, lot_id, complaint_id, reason, previous_lot_status, held_by) values (lo.company_id, lo.id, v_cmp, trim(p ->> 'reason'), lo.status, auth.uid())
  returning id into v_id;
  for b in select * from inv.stock_balances where lot_id = lo.id and bucket = 'available' and qty > 0 order by place_id loop
    perform app.stock_post(lo.company_id, lo.product_id, lo.id, b.place_id, 'available', -b.qty, 'qc_hold', 'inv.qc_holds', v_id, lo.lot_no, current_date, null, 'QC hold');
    perform app.stock_post(lo.company_id, lo.product_id, lo.id, b.place_id, 'hold', b.qty, 'qc_hold', 'inv.qc_holds', v_id, lo.lot_no, current_date, null, 'QC hold');
    v_total := v_total + b.qty;
  end loop;
  update inv.lots set status = 'hold' where id = lo.id;
  update inv.qc_holds set qty_held = v_total where id = v_id;
  if v_cmp is not null then
    update sales.complaints set qc_hold_id = v_id where id = v_cmp and company_id = lo.company_id;
    perform app.complaint_event(v_cmp, 'on_hold', 'batch held by QC');
  end if;
  v_res := jsonb_build_object('hold_id', v_id, 'qty_held', v_total);
  return app.request_done(p_client_request_id, 'qc_hold_batch', v_res);
end $$;

-- Lift a hold: release back to available (lot back to its previous status) or reject (moves to rejected).
create or replace function api.qc_release_hold(p_client_request_id uuid, p_hold_id uuid, p_decision text, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; h inv.qc_holds; lo inv.lots; b record; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'qc_release_hold'); if v_prev is not null then return v_prev; end if;
  select * into h from inv.qc_holds where id = p_hold_id for update;
  if h.id is null then perform app.raise_rule('qc.hold_missing', 'hold not found', 'P0002'); end if;
  perform app.require(h.company_id, 'qc.release');
  if h.status <> 'on_hold' then perform app.raise_rule('qc.hold_closed', 'this hold is already decided', '22023'); end if;
  if p_decision not in ('release', 'reject') then perform app.raise_rule('qc.decision', 'release or reject', '22023'); end if;
  if coalesce(length(trim(p_note)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'record the finding', '22023'); end if;
  select * into lo from inv.lots where id = h.lot_id for update;
  for b in select * from inv.stock_balances where lot_id = lo.id and bucket = 'hold' and qty > 0 loop
    perform app.stock_post(lo.company_id, lo.product_id, lo.id, b.place_id, 'hold', -b.qty, 'qc_release', 'inv.qc_holds', h.id, lo.lot_no, current_date, null, p_decision);
    perform app.stock_post(lo.company_id, lo.product_id, lo.id, b.place_id, case when p_decision = 'release' then 'available' else 'rejected' end, b.qty, 'qc_release', 'inv.qc_holds', h.id,
                           lo.lot_no, current_date, null, p_decision);
  end loop;
  update inv.lots set status = case when p_decision = 'release' then h.previous_lot_status else 'rejected' end where id = lo.id;
  update inv.qc_holds set status = case when p_decision = 'release' then 'released' else 'rejected' end, decided_by = auth.uid(), decided_at = now(), decision_note = p_note where id = h.id;
  v_res := jsonb_build_object('hold_id', h.id, 'status', case when p_decision = 'release' then 'released' else 'rejected' end);
  return app.request_done(p_client_request_id, 'qc_release_hold', v_res);
end $$;

-- p: {status investigating|resolved|rejected, note, assigned_to}
create or replace function api.update_complaint(p_client_request_id uuid, p_complaint_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; c sales.complaints; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'update_complaint'); if v_prev is not null then return v_prev; end if;
  select * into c from sales.complaints where id = p_complaint_id for update;
  if c.id is null then perform app.raise_rule('complaint.missing', 'complaint not found', 'P0002'); end if;
  if not (app.can(c.company_id, 'sales.edit') or app.can(c.company_id, 'qc.release') or app.can(c.company_id, 'qc.test')) then perform app.raise_rule('rights.missing', 'sales or QC only', '42501'); end if;
  if c.status in ('closed') then perform app.raise_rule('complaint.closed', 'this complaint is closed', '22023'); end if;
  if coalesce(p ->> 'status', '') not in ('investigating', 'resolved', 'rejected') then perform app.raise_rule('complaint.status', 'investigating, resolved or rejected', '22023'); end if;
  if nullif(p ->> 'assigned_to', '') is not null then update sales.complaints set assigned_to = (p ->> 'assigned_to')::uuid where id = c.id; end if;
  if p ->> 'status' = 'resolved' then update sales.complaints set resolution = coalesce(nullif(p ->> 'note', ''), resolution) where id = c.id; end if;
  perform app.complaint_event(c.id, p ->> 'status', nullif(p ->> 'note', ''));
  v_res := jsonb_build_object('id', c.id, 'status', p ->> 'status');
  return app.request_done(p_client_request_id, 'update_complaint', v_res);
end $$;

-- Close: never by the person who logged it (the salesperson cannot close alone) and not while the batch is on hold.
create or replace function api.close_complaint(p_client_request_id uuid, p_complaint_id uuid, p_resolution text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; c sales.complaints; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'close_complaint'); if v_prev is not null then return v_prev; end if;
  select * into c from sales.complaints where id = p_complaint_id for update;
  if c.id is null then perform app.raise_rule('complaint.missing', 'complaint not found', 'P0002'); end if;
  perform app.require(c.company_id, 'sales.approve');
  if c.logged_by = auth.uid() then perform app.raise_rule('complaint.not_alone', 'the person who logged a complaint cannot close it', '42501'); end if;
  if c.status = 'closed' then perform app.raise_rule('complaint.closed', 'already closed', '22023'); end if;
  if exists (select 1 from inv.qc_holds where id = c.qc_hold_id and status = 'on_hold') then perform app.raise_rule('complaint.hold_open', 'QC must decide the batch hold first', '22023'); end if;
  if coalesce(length(trim(p_resolution)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'write the resolution', '22023'); end if;
  update sales.complaints set resolution = p_resolution, closed_by = auth.uid(), closed_at = now() where id = c.id;
  perform app.complaint_event(c.id, 'closed', p_resolution);
  update field.queries set status = 'closed', reply = coalesce(reply, p_resolution), updated_at = now() where complaint_id = c.id;
  v_res := jsonb_build_object('id', c.id, 'status', 'closed');
  return app.request_done(p_client_request_id, 'close_complaint', v_res);
end $$;

-- ─────────── Coverage and calls ───────────
create or replace function api.set_coverage_tier(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_coverage_tier'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'field.manage');
  insert into sales.coverage_tiers (company_id, tier, call_every_days, visit_every_days, grace_days, set_by)
  values (v_company, trim(p ->> 'tier'), nullif(p ->> 'call_every_days', '')::int, nullif(p ->> 'visit_every_days', '')::int, coalesce((p ->> 'grace_days')::int, 0), auth.uid())
  on conflict (company_id, tier) do update set call_every_days = excluded.call_every_days, visit_every_days = excluded.visit_every_days, grace_days = excluded.grace_days,
     set_by = excluded.set_by, set_at = now();
  v_res := jsonb_build_object('ok', true);
  return app.request_done(p_client_request_id, 'set_coverage_tier', v_res);
end $$;

-- A customer's tier is set by the sales manager (not through upsert_party once coverage is in use).
create or replace function api.set_customer_tier(p_client_request_id uuid, p_company_id uuid, p_party_id uuid, p_tier text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_customer_tier'); if v_prev is not null then return v_prev; end if;
  perform app.require(p_company_id, 'field.manage');
  if not exists (select 1 from sales.coverage_tiers where company_id = p_company_id and tier = p_tier) then perform app.raise_rule('coverage.tier', 'set up this tier first', '22023'); end if;
  update master.party_companies set tier = p_tier where company_id = p_company_id and party_id = p_party_id and is_customer;
  v_res := jsonb_build_object('ok', true);
  return app.request_done(p_client_request_id, 'set_customer_tier', v_res);
end $$;

-- p: {company_id, party_id, outcome reached|no_answer|deferred, note, next_action}
create or replace function api.log_call(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_id bigint; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'log_call'); if v_prev is not null then return v_prev; end if;
  if not app.can_write_party(v_company, (p ->> 'party_id')::uuid) then perform app.raise_rule('rights.missing', 'not your customer', '42501'); end if;
  insert into sales.contact_attempts (company_id, party_id, kind, outcome, note, next_action, by_user)
  values (v_company, (p ->> 'party_id')::uuid, 'call', p ->> 'outcome', nullif(p ->> 'note', ''), nullif(p ->> 'next_action', ''), auth.uid()) returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'log_call', v_res);
end $$;

-- ─────────── Private label (three approvals by three other people) ───────────
create or replace function api.submit_private_label(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_id uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'submit_private_label'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'sales.create');
  if coalesce(length(trim(p ->> 'brand_name')), 0) < 2 then perform app.raise_rule('private_label.brand', 'give the brand name', '22023'); end if;
  insert into sales.private_label_orders (company_id, party_id, brand_name, spec, artwork_path, created_by)
  values (v_company, (p ->> 'party_id')::uuid, trim(p ->> 'brand_name'), coalesce(p -> 'spec', '{}'::jsonb), nullif(p ->> 'artwork_path', ''), auth.uid()) returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'submit_private_label', v_res);
end $$;

-- p_stage: sales (sales.approve) | quality (qc.release) | md (credit.approve). Each approver is a different person and not the creator.
create or replace function api.approve_private_label(p_client_request_id uuid, p_id uuid, p_stage text, p_approve boolean, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; r sales.private_label_orders; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'approve_private_label'); if v_prev is not null then return v_prev; end if;
  select * into r from sales.private_label_orders where id = p_id for update;
  if r.id is null then perform app.raise_rule('private_label.missing', 'request not found', 'P0002'); end if;
  if p_stage not in ('sales', 'quality', 'md') then perform app.raise_rule('private_label.stage', 'sales, quality or md', '22023'); end if;
  perform app.require(r.company_id, case p_stage when 'sales' then 'sales.approve' when 'quality' then 'qc.release' else 'credit.approve' end);
  if r.status <> 'submitted' then perform app.raise_rule('private_label.state', 'this request is already decided', '22023'); end if;
  if auth.uid() in (r.created_by) then perform app.raise_rule('sod.own_request', 'nobody approves their own request', '42501'); end if;
  if auth.uid() in (coalesce(r.sales_approved_by, '00000000-0000-0000-0000-000000000000'), coalesce(r.quality_approved_by, '00000000-0000-0000-0000-000000000000'),
                    coalesce(r.md_approved_by, '00000000-0000-0000-0000-000000000000')) then
    perform app.raise_rule('private_label.same_person', 'each approval comes from a different person', '42501');
  end if;
  if not p_approve then
    if coalesce(length(trim(p_note)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'give the reason', '22023'); end if;
    update sales.private_label_orders set status = 'rejected', rejected_by = auth.uid(), reject_reason = p_note where id = r.id;
  else
    update sales.private_label_orders set sales_approved_by = case when p_stage = 'sales' then auth.uid() else sales_approved_by end,
           quality_approved_by = case when p_stage = 'quality' then auth.uid() else quality_approved_by end,
           md_approved_by = case when p_stage = 'md' then auth.uid() else md_approved_by end
     where id = r.id returning * into r;
    if r.sales_approved_by is not null and r.quality_approved_by is not null and r.md_approved_by is not null then
      update sales.private_label_orders set status = 'approved' where id = r.id;
    end if;
  end if;
  v_res := jsonb_build_object('id', r.id, 'status', (select status from sales.private_label_orders where id = r.id));
  return app.request_done(p_client_request_id, 'approve_private_label', v_res);
end $$;

-- ─────────── Agents and commission ───────────
-- p: {company_id, party_id, model, commission_pct, customers: [party_id]}
create or replace function api.upsert_agent(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_id uuid; e text; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_agent'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'sales.approve');
  insert into sales.agents (company_id, party_id, model, commission_pct) values (v_company, (p ->> 'party_id')::uuid, coalesce(p ->> 'model', 'A'), (p ->> 'commission_pct')::numeric)
  on conflict (company_id, party_id) do update set model = excluded.model, commission_pct = excluded.commission_pct returning id into v_id;
  for e in select jsonb_array_elements_text(coalesce(p -> 'customers', '[]'::jsonb)) loop
    insert into sales.agent_customers (agent_id, party_id) values (v_id, e::uuid) on conflict do nothing;
  end loop;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_agent', v_res);
end $$;

-- Commission accrues only on verified collections: posted cash receipts, or bank receipts matched to a bank statement line;
-- allocated to taxable invoices of the agent's customers. Re-running a period adds nothing twice.
create or replace function api.accrue_agent_commissions(p_client_request_id uuid, p_company_id uuid, p_from date, p_to date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; n int; v_total numeric; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'accrue_agent_commissions'); if v_prev is not null then return v_prev; end if;
  perform app.require(p_company_id, 'accounts.create');
  with ins as (
    insert into sales.agent_commissions (company_id, agent_id, voucher_id, document_id, collected, commission, period_from, period_to, created_by)
    select p_company_id, ag.id, v.id, d.id, sum(a.amount), round(sum(a.amount) * ag.commission_pct / 100, 2), p_from, p_to, auth.uid()
    from sales.agents ag
    join sales.agent_customers ac on ac.agent_id = ag.id
    join sales.documents d on d.party_id = ac.party_id and d.company_id = p_company_id and d.status = 'posted' and d.tax_class = 'taxable'
    join acct.bill_allocations a on a.against_kind = 'sales_document' and a.against_id = d.id
    join acct.vouchers v on v.id = a.voucher_id and v.voucher_type = 'receipt' and v.status = 'posted' and v.voucher_date between p_from and p_to
    where ag.company_id = p_company_id and ag.status = 'active' and d.doc_date >= ac.from_date
      and (v.mode = 'cash' or exists (select 1 from acct.bank_statement_lines bl where bl.matched_voucher_id = v.id and bl.status = 'matched'))
    group by ag.id, ag.commission_pct, v.id, d.id
    on conflict (agent_id, voucher_id, document_id) do nothing
    returning commission)
  select count(*), coalesce(sum(commission), 0) into n, v_total from ins;
  v_res := jsonb_build_object('accrued', n, 'commission', v_total);
  return app.request_done(p_client_request_id, 'accrue_agent_commissions', v_res);
end $$;

-- ─────────── Own shops ───────────
-- p: {company_id, branch_id, place_id, walk_in_party_id, cash_account_id, bank_account_id, price_list_id, active}
create or replace function api.upsert_shop(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_id uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_shop'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'settings.manage');
  if not exists (select 1 from core.branches where id = (p ->> 'branch_id')::uuid and company_id = v_company and kind = 'shop') then perform app.raise_rule('shop.branch', 'choose a shop branch of this company', '22023'); end if;
  if not exists (select 1 from core.places where id = (p ->> 'place_id')::uuid and branch_id = (p ->> 'branch_id')::uuid) then perform app.raise_rule('shop.place', 'choose a stock place of this shop', '22023'); end if;
  insert into sales.shops (company_id, branch_id, place_id, walk_in_party_id, cash_account_id, bank_account_id, price_list_id, active)
  values (v_company, (p ->> 'branch_id')::uuid, (p ->> 'place_id')::uuid, nullif(p ->> 'walk_in_party_id', '')::uuid, nullif(p ->> 'cash_account_id', '')::uuid,
          nullif(p ->> 'bank_account_id', '')::uuid, nullif(p ->> 'price_list_id', '')::uuid, coalesce((p ->> 'active')::boolean, true))
  on conflict (branch_id) do update set place_id = excluded.place_id, walk_in_party_id = excluded.walk_in_party_id, cash_account_id = excluded.cash_account_id,
     bank_account_id = excluded.bank_account_id, price_list_id = excluded.price_list_id, active = excluded.active
  returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_shop', v_res);
end $$;

-- Counter sale: a Phase 3 tax invoice from the shop branch's GSTIN, stock out of the shop place (never a held lot), and the
-- receipt into the shop's cash or bank account (cash limit applies). p: {shop_id, party_id, doc_date, lines [{product_id, qty, rate, discount}],
-- payment: {mode cash|upi|card}}
create or replace function api.shop_sale(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; sh sales.shops; v_gstin uuid; v_party uuid; v_date date := coalesce(nullif(p ->> 'doc_date', '')::date, current_date); v_lines jsonb := '[]'::jsonb; l jsonb;
        v_rate numeric; v_draft jsonb; v_post jsonb; v_doc uuid; v_total numeric; x record; v_taken jsonb; v_mode text := coalesce(p #>> '{payment,mode}', 'cash');
        v_acc uuid; v_fy uuid; v_no text; v_voucher uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'shop_sale'); if v_prev is not null then return v_prev; end if;
  select * into sh from sales.shops where id = (p ->> 'shop_id')::uuid and active;
  if sh.id is null then perform app.raise_rule('shop.missing', 'shop not found', 'P0002'); end if;
  perform app.require(sh.company_id, 'shop.operate');
  if v_mode not in ('cash', 'upi', 'card') then perform app.raise_rule('money.mode', 'cash, UPI or card', '22023'); end if;
  select gstin_id into v_gstin from core.branches where id = sh.branch_id;
  v_party := coalesce(nullif(p ->> 'party_id', '')::uuid, sh.walk_in_party_id);
  if v_party is null then perform app.raise_rule('shop.no_customer', 'choose the customer or set the shop''s walk-in customer', '22023'); end if;
  for l in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    v_rate := coalesce(nullif(l ->> 'rate', '')::numeric, case when sh.price_list_id is not null then app.list_rate(sh.price_list_id, (l ->> 'product_id')::uuid, v_date, (l ->> 'qty')::numeric) end);
    if v_rate is null then perform app.raise_rule('order.no_rate', 'no shop price for an item', '22023'); end if;
    v_lines := v_lines || jsonb_build_object('product_id', l ->> 'product_id', 'qty', (l ->> 'qty')::numeric, 'rate', v_rate, 'discount', coalesce((l ->> 'discount')::numeric, 0));
  end loop;
  v_draft := api.save_sales_draft(app.child_crid(p_client_request_id, 'draft'), jsonb_build_object('company_id', sh.company_id, 'gstin_id', v_gstin, 'party_id', v_party,
    'doc_type', 'sales_invoice', 'doc_date', v_date, 'notes', 'Counter sale', 'lines', v_lines));
  v_doc := (v_draft ->> 'id')::uuid;
  v_post := api.post_sales_document(app.child_crid(p_client_request_id, 'post'), v_doc);
  select total into v_total from sales.documents where id = v_doc;
  perform app.check_stock_date(sh.company_id, v_date);
  for x in select * from sales.document_lines where document_id = v_doc and product_id is not null loop
    v_taken := app.stock_take(sh.company_id, x.product_id, null, sh.place_id, 'available', x.qty, 'sale', 'sales.documents', v_doc, v_post ->> 'doc_no', v_date);
    if exists (select 1 from jsonb_array_elements(v_taken) e join inv.lots lo on lo.id = (e ->> 'lot_id')::uuid where lo.status = 'hold') then
      perform app.raise_rule('stock.lot_on_hold', 'a lot on QC hold cannot be sold', 'P0001');
    end if;
  end loop;
  v_acc := case when v_mode = 'cash' then sh.cash_account_id else sh.bank_account_id end;
  if v_acc is null or (select kind from acct.accounts where id = v_acc) <> (case when v_mode = 'cash' then 'cash' else 'bank' end) then
    perform app.raise_rule('money.account', 'set the shop''s ' || case when v_mode = 'cash' then 'cash' else 'bank' end || ' account', '22023');
  end if;
  if v_mode = 'cash' then perform app.cash_check(sh.company_id, v_party, v_date, v_total, 'receipt', null); end if;
  v_fy := app.fy_for(sh.company_id, v_date);
  v_no := app.take_doc_number(sh.company_id, null, 'receipt', v_fy);
  v_voucher := app.post_voucher(jsonb_build_object('company_id', sh.company_id, 'fy_id', v_fy, 'voucher_type', 'receipt', 'doc_no', v_no, 'voucher_date', v_date, 'party_id', v_party,
      'narration', 'Counter sale ' || (v_post ->> 'doc_no'), 'mode', v_mode, 'source_table', 'sales.shops', 'source_id', sh.id, 'client_request_id', app.child_crid(p_client_request_id, 'receipt')),
    jsonb_build_array(jsonb_build_object('account_id', v_acc, 'dr', v_total), jsonb_build_object('account_id', app.party_account(sh.company_id, v_party, 'debtors'), 'party_id', v_party, 'cr', v_total)));
  insert into acct.bill_allocations (company_id, voucher_id, party_id, against_kind, against_id, amount) values (sh.company_id, v_voucher, v_party, 'sales_document', v_doc, v_total);
  v_res := jsonb_build_object('document_id', v_doc, 'doc_no', v_post ->> 'doc_no', 'total', v_total, 'receipt_voucher_id', v_voucher, 'receipt_no', v_no);
  return app.request_done(p_client_request_id, 'shop_sale', v_res);
end $$;

-- Day close: counted cash against the cash the shop took that day (counter receipts into the shop cash account). A difference is flagged.
-- p: {shop_id, day, denominations, upi_total, card_total}
create or replace function api.shop_day_close(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; sh sales.shops; v_day date := coalesce(nullif(p ->> 'day', '')::date, current_date); v_expected numeric; v_counted numeric; v_bills int; v_status text; v_bug uuid;
        v_id uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'shop_day_close'); if v_prev is not null then return v_prev; end if;
  select * into sh from sales.shops where id = (p ->> 'shop_id')::uuid for update;
  if sh.id is null then perform app.raise_rule('shop.missing', 'shop not found', 'P0002'); end if;
  perform app.require(sh.company_id, 'shop.operate');
  if exists (select 1 from sales.shop_days where shop_id = sh.id and day = v_day) then perform app.raise_rule('shop.day_closed', 'this day is already closed', '22023'); end if;
  select coalesce(sum(g.dr), 0) into v_expected from acct.vouchers v join acct.gl_entries g on g.voucher_id = v.id and g.account_id = sh.cash_account_id
   where v.source_table = 'sales.shops' and v.source_id = sh.id and v.voucher_date = v_day and v.status = 'posted';
  select count(*) into v_bills from acct.vouchers v where v.source_table = 'sales.shops' and v.source_id = sh.id and v.voucher_date = v_day and v.status = 'posted';
  v_counted := app.count_total(p -> 'denominations');
  v_status := case when v_counted = v_expected then 'closed' else 'mismatch' end;
  insert into sales.shop_days (company_id, shop_id, day, expected_cash, counted, counted_cash, upi_total, card_total, bills, difference, status, closed_by)
  values (sh.company_id, sh.id, v_day, v_expected, coalesce(p -> 'denominations', '{}'::jsonb), v_counted, coalesce((p ->> 'upi_total')::numeric, 0), coalesce((p ->> 'card_total')::numeric, 0),
          v_bills, v_counted - v_expected, v_status, auth.uid())
  returning id into v_id;
  if v_status = 'mismatch' then
    v_bug := app.open_bug(jsonb_build_object('company_id', sh.company_id, 'area', 'cash', 'kind', 'total_mismatch', 'severity', 'high', 'title', 'Shop cash close does not match',
      'evidence', jsonb_build_object('shop_day_id', v_id, 'expected', v_expected, 'counted', v_counted), 'who_fixes', 'accounts', 'ref_table', 'sales.shop_days', 'ref_id', v_id,
      'dedupe_key', 'shop.day:' || v_id));
    update sales.shop_days set bug_item_id = v_bug where id = v_id;
  end if;
  v_res := jsonb_build_object('id', v_id, 'status', v_status, 'expected_cash', v_expected, 'counted_cash', v_counted, 'difference', v_counted - v_expected);
  return app.request_done(p_client_request_id, 'shop_day_close', v_res);
end $$;

-- ─────────── Exports ───────────
-- ISO 6346 container number check digit.
create or replace function app.iso6346_valid(p text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare v_sum int := 0; ch text; v int; i int; v_map text := '0123456789A?BCDEFGHIJK?LMNOPQRSTU?VWXYZ';
begin
  if p is null or p !~ '^[A-Z]{4}[0-9]{7}$' then return false; end if;
  for i in 1..10 loop
    ch := substr(p, i, 1);
    v := position(ch in v_map) - 1;
    v_sum := v_sum + v * (2 ^ (i - 1))::int;
  end loop;
  return (v_sum % 11) % 10 = substr(p, 11, 1)::int;
end $$;

-- p: {company_id, party_id, order_date, currency, fx_rate, incoterm, port_of_loading, destination, lut_ref, lut_valid_to, lines [{product_id, qty, rate_fc}]}
create or replace function api.create_export_order(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_id uuid; v_no text; v_res jsonb; v_date date := coalesce(nullif(p ->> 'order_date', '')::date, current_date);
begin
  v_prev := app.request_seen(p_client_request_id, 'create_export_order'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'exports.create');
  if (select gst_status from master.parties where id = (p ->> 'party_id')::uuid) is distinct from 'overseas' then
    perform app.raise_rule('export.not_overseas', 'an export order is for an overseas buyer', '22023');
  end if;
  if coalesce((p ->> 'fx_rate')::numeric, 0) <= 0 then perform app.raise_rule('export.fx_rate', 'enter the exchange rate', '22023'); end if;
  v_no := app.p6_doc_no(v_company, 'export_order', v_date);
  insert into sales.export_orders (company_id, doc_no, party_id, order_date, currency, fx_rate, incoterm, port_of_loading, destination, lut_ref, lut_valid_to, lines, created_by)
  values (v_company, v_no, (p ->> 'party_id')::uuid, v_date, upper(p ->> 'currency'), (p ->> 'fx_rate')::numeric, nullif(upper(p ->> 'incoterm'), ''), nullif(p ->> 'port_of_loading', ''),
          nullif(p ->> 'destination', ''), nullif(p ->> 'lut_ref', ''), nullif(p ->> 'lut_valid_to', '')::date, coalesce(p -> 'lines', '[]'::jsonb), auth.uid())
  returning id into v_id;
  v_res := jsonb_build_object('id', v_id, 'doc_no', v_no);
  return app.request_done(p_client_request_id, 'create_export_order', v_res);
end $$;

-- p: {export_order_id, container_no, seal_no, packing_list [{product_id, cartons, pieces}]}
create or replace function api.add_container(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; e sales.export_orders; v_no text := upper(regexp_replace(coalesce(p ->> 'container_no', ''), '[^A-Za-z0-9]', '', 'g')); v_id uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'add_container'); if v_prev is not null then return v_prev; end if;
  select * into e from sales.export_orders where id = (p ->> 'export_order_id')::uuid for update;
  if e.id is null then perform app.raise_rule('export.missing', 'export order not found', 'P0002'); end if;
  perform app.require(e.company_id, 'exports.edit');
  if not app.iso6346_valid(v_no) then perform app.raise_rule('export.container_no', 'the container number or its check digit is wrong', '22023'); end if;
  insert into sales.containers (export_order_id, container_no, seal_no, packing_list) values (e.id, v_no, nullif(p ->> 'seal_no', ''), coalesce(p -> 'packing_list', '[]'::jsonb))
  returning id into v_id;
  v_res := jsonb_build_object('id', v_id, 'container_no', v_no);
  return app.request_done(p_client_request_id, 'add_container', v_res);
end $$;

-- Compare what was loaded with the packing list, item by item (cartons and pieces).
create or replace function api.check_packing_list(p_client_request_id uuid, p_container_id uuid, p_loaded jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; c sales.containers; v_company uuid; v_diff jsonb; v_status text; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'check_packing_list'); if v_prev is not null then return v_prev; end if;
  select * into c from sales.containers where id = p_container_id for update;
  if c.id is null then perform app.raise_rule('export.container_missing', 'container not found', 'P0002'); end if;
  select company_id into v_company from sales.export_orders where id = c.export_order_id;
  perform app.require(v_company, 'exports.edit');
  select coalesce(jsonb_agg(jsonb_build_object('product_id', k, 'list_cartons', lc, 'loaded_cartons', dc, 'list_pieces', lp, 'loaded_pieces', dp)), '[]'::jsonb) into v_diff
  from (select coalesce(a.k, b.k) as k, coalesce(a.c, 0) as lc, coalesce(b.c, 0) as dc, coalesce(a.p, 0) as lp, coalesce(b.p, 0) as dp
        from (select x ->> 'product_id' as k, sum((x ->> 'cartons')::numeric) as c, sum((x ->> 'pieces')::numeric) as p from jsonb_array_elements(c.packing_list) x group by 1) a
        full join (select x ->> 'product_id' as k, sum((x ->> 'cartons')::numeric) as c, sum((x ->> 'pieces')::numeric) as p from jsonb_array_elements(coalesce(p_loaded, '[]'::jsonb)) x group by 1) b
          on a.k = b.k) z
  where lc <> dc or lp <> dp;
  v_status := case when jsonb_array_length(v_diff) = 0 then 'matches' else 'mismatch' end;
  update sales.containers set loaded = p_loaded, check_status = v_status, check_result = v_diff, checked_by = auth.uid(), checked_at = now() where id = c.id;
  v_res := jsonb_build_object('id', c.id, 'status', v_status, 'differences', v_diff);
  return app.request_done(p_client_request_id, 'check_packing_list', v_res);
end $$;

-- Export invoice: foreign-currency rates × the order's recorded exchange rate = INR. Under LUT (zero-rated, lawful reason export_lut) only
-- Admin may post (AGENTS rule 7: a bill without GST is Admin only), and the LUT must be valid on the date. Without LUT: IGST (place of supply 96).
-- p: {export_order_id, gstin_id, doc_date, lut boolean, shipping_bill_no, shipping_bill_date, port_code, lines [{product_id, qty, rate_fc}] (default: the order lines)}
create or replace function api.post_export_invoice(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; e sales.export_orders; v_gstin core.gstins; v_date date := coalesce(nullif(p ->> 'doc_date', '')::date, current_date); v_lut boolean := coalesce((p ->> 'lut')::boolean, true);
        v_lines jsonb := '[]'::jsonb; l jsonb; v_fc numeric := 0; v_calc jsonb; v_doc uuid; v_post jsonb; v_draft jsonb; c jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'post_export_invoice'); if v_prev is not null then return v_prev; end if;
  select * into e from sales.export_orders where id = (p ->> 'export_order_id')::uuid for update;
  if e.id is null then perform app.raise_rule('export.missing', 'export order not found', 'P0002'); end if;
  perform app.require(e.company_id, 'exports.create');
  perform app.require(e.company_id, 'sales_invoices.create');
  select * into v_gstin from core.gstins where id = coalesce(nullif(p ->> 'gstin_id', '')::uuid, (select id from core.gstins where company_id = e.company_id and is_principal limit 1)) and company_id = e.company_id;
  if v_gstin.id is null then perform app.raise_rule('org.gstin_other_company', 'choose a GSTIN of this company', '22023'); end if;
  for l in select * from jsonb_array_elements(coalesce(nullif(p -> 'lines', 'null'::jsonb), e.lines)) loop
    v_fc := v_fc + round((l ->> 'qty')::numeric * (l ->> 'rate_fc')::numeric, 2);
    v_lines := v_lines || jsonb_build_object('product_id', l ->> 'product_id', 'qty', (l ->> 'qty')::numeric, 'rate', round((l ->> 'rate_fc')::numeric * e.fx_rate, 2), 'discount', 0);
  end loop;
  if v_lut then
    if not app.is_admin() then perform app.raise_rule('gst.without_admin_only', 'an export under LUT (without GST) is posted by Admin', '42501'); end if;
    if e.lut_ref is null or e.lut_valid_to is null or e.lut_valid_to < v_date then perform app.raise_rule('export.lut_expired', 'record a valid LUT for this date on the export order', '22023'); end if;
    v_calc := app.compute_tax(v_gstin.state_code, '96', v_date, true, v_lines);
    insert into sales.documents (company_id, gstin_id, doc_type, doc_date, party_id, place_of_supply, tax_class, lawful_reason, terms_days, notes, created_by,
                                 taxable, cgst, sgst, igst, round_off, total)
    values (e.company_id, v_gstin.id, 'sales_invoice', v_date, e.party_id, '96', 'without_gst', 'export_lut', 0, 'Export under LUT ' || e.lut_ref || ' · ' || e.doc_no, auth.uid(),
            (v_calc ->> 'taxable')::numeric, 0, 0, 0, (v_calc ->> 'round_off')::numeric, (v_calc ->> 'total')::numeric)
    returning id into v_doc;
    for c in select * from jsonb_array_elements(v_calc -> 'lines') loop
      insert into sales.document_lines (document_id, line_no, product_id, description, hsn_code, uom, qty, rate, discount, taxable, gst_rate, cgst, sgst, igst, cess, total)
      values (v_doc, (c ->> 'line_no')::int, (c ->> 'product_id')::uuid, c ->> 'description', c ->> 'hsn_code', c ->> 'uom', (c ->> 'qty')::numeric, (c ->> 'rate')::numeric, 0,
              (c ->> 'taxable')::numeric, 0, 0, 0, 0, 0, (c ->> 'total')::numeric);
    end loop;
  else
    v_draft := api.save_sales_draft(app.child_crid(p_client_request_id, 'draft'), jsonb_build_object('company_id', e.company_id, 'gstin_id', v_gstin.id, 'party_id', e.party_id,
      'doc_type', 'sales_invoice', 'doc_date', v_date, 'place_of_supply', '96', 'notes', 'Export with IGST · ' || e.doc_no, 'lines', v_lines));
    v_doc := (v_draft ->> 'id')::uuid;
  end if;
  v_post := api.post_sales_document(app.child_crid(p_client_request_id, 'post'), v_doc);
  insert into sales.export_invoices (document_id, export_order_id, currency, fx_rate, value_fc, lut, shipping_bill_no, shipping_bill_date, port_code)
  values (v_doc, e.id, e.currency, e.fx_rate, v_fc, v_lut, nullif(p ->> 'shipping_bill_no', ''), nullif(p ->> 'shipping_bill_date', '')::date, nullif(p ->> 'port_code', ''));
  update sales.export_orders set status = 'shipped' where id = e.id and status = 'confirmed';
  v_res := jsonb_build_object('document_id', v_doc, 'doc_no', v_post ->> 'doc_no', 'total_inr', v_post -> 'total', 'value_fc', v_fc, 'currency', e.currency, 'lut', v_lut);
  return app.request_done(p_client_request_id, 'post_export_invoice', v_res);
end $$;

-- ─────────── Online channels ───────────
create or replace function api.upsert_online_channel(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_id uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_online_channel'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'settings.manage');
  insert into sales.online_channels (company_id, code, gstin_id, party_id, place_id, tcs_applicable, status)
  values (v_company, p ->> 'code', (p ->> 'gstin_id')::uuid, (p ->> 'party_id')::uuid, nullif(p ->> 'place_id', '')::uuid, coalesce((p ->> 'tcs_applicable')::boolean, false),
          coalesce(p ->> 'status', 'not_connected'))
  on conflict (company_id, code) do update set gstin_id = excluded.gstin_id, party_id = excluded.party_id, place_id = excluded.place_id, tcs_applicable = excluded.tcs_applicable,
     status = excluded.status
  returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_online_channel', v_res);
end $$;

-- What stops an item from going live: barcode, MRP, price above MRP, item not active.
create or replace function app.listing_blockers(p_product uuid, p_price numeric) returns text[]
language sql stable security definer set search_path = '' as $$
  select array_remove(array[
    case when p.barcode is null then 'barcode' end,
    case when m.mrp is null then 'mrp' end,
    case when m.mrp is not null and p_price is not null and p_price > m.mrp then 'price_above_mrp' end,
    case when p_price is null then 'price' end,
    case when p.status <> 'active' then 'not_active' end], null)
  from master.products p
  left join lateral (select mrp from master.product_mrp_history h where h.product_id = p.id and h.effective_from <= current_date order by effective_from desc limit 1) m on true
  where p.id = p_product
$$;

-- Admin publishes listings (p: {channel_id, product_id, title, price (tax-inclusive selling price), publish boolean}).
create or replace function api.publish_listing(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; ch sales.online_channels; v_block text[]; v_publish boolean := coalesce((p ->> 'publish')::boolean, true); v_id uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'publish_listing'); if v_prev is not null then return v_prev; end if;
  select * into ch from sales.online_channels where id = (p ->> 'channel_id')::uuid;
  if ch.id is null then perform app.raise_rule('listing.channel', 'channel not found', 'P0002'); end if;
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'Admin publishes listings', '42501'); end if;
  v_block := app.listing_blockers((p ->> 'product_id')::uuid, nullif(p ->> 'price', '')::numeric);
  insert into sales.listings (channel_id, product_id, title, price, blockers, status)
  values (ch.id, (p ->> 'product_id')::uuid, nullif(p ->> 'title', ''), nullif(p ->> 'price', '')::numeric, coalesce(v_block, '{}'), 'draft')
  on conflict (channel_id, product_id) do update set title = coalesce(excluded.title, sales.listings.title), price = coalesce(excluded.price, sales.listings.price), blockers = excluded.blockers
  returning id into v_id;
  if v_publish then
    if cardinality(coalesce(v_block, '{}')) > 0 then perform app.raise_rule('listing.blocked', 'cannot list yet: ' || array_to_string(v_block, ', '), '22023'); end if;
    update sales.listings set status = 'listed', published_by = auth.uid(), published_at = now() where id = v_id;
  end if;
  v_res := jsonb_build_object('id', v_id, 'status', (select status from sales.listings where id = v_id), 'blockers', to_jsonb(coalesce(v_block, '{}')));
  return app.request_done(p_client_request_id, 'publish_listing', v_res);
end $$;

-- Marketplace order → sales order (channel online, paid in advance by the marketplace, place of supply = ship-to state).
-- Same external order twice → the first result. p: {channel_id, external_order_id, order_date, ship_state, lines [{product_id | sku, qty, price_incl_tax}]}
create or replace function api.ingest_online_order(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; ch sales.online_channels; v_exist sales.online_orders; v_lines jsonb := '[]'::jsonb; l jsonb; v_prod uuid; v_rate numeric; v_date date := coalesce(nullif(p ->> 'order_date', '')::date, current_date);
        v_order jsonb; v_id uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'ingest_online_order'); if v_prev is not null then return v_prev; end if;
  select * into ch from sales.online_channels where id = (p ->> 'channel_id')::uuid;
  if ch.id is null then perform app.raise_rule('listing.channel', 'channel not found', 'P0002'); end if;
  perform app.require(ch.company_id, 'sales.create');
  select * into v_exist from sales.online_orders where channel_id = ch.id and external_order_id = p ->> 'external_order_id';
  if v_exist.id is not null then
    v_res := jsonb_build_object('online_order_id', v_exist.id, 'order_id', v_exist.order_id, 'duplicate', true);
    return app.request_done(p_client_request_id, 'ingest_online_order', v_res);
  end if;
  for l in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    v_prod := coalesce(nullif(l ->> 'product_id', '')::uuid, (select id from master.products where code = l ->> 'sku'));
    if v_prod is null then perform app.raise_rule('online.unknown_item', 'unknown item ' || coalesce(l ->> 'sku', ''), '22023'); end if;
    select round((l ->> 'price_incl_tax')::numeric / (1 + coalesce(r.rate, 0) / 100), 2) into v_rate
      from master.products pr left join lateral (select rate from master.hsn_rates h where h.hsn_code = pr.hsn_code and h.effective_from <= v_date and (h.effective_to is null or h.effective_to >= v_date)
                                                 order by h.effective_from desc limit 1) r on true where pr.id = v_prod;
    v_lines := v_lines || jsonb_build_object('product_id', v_prod, 'qty', (l ->> 'qty')::numeric, 'rate', v_rate);
  end loop;
  insert into sales.online_orders (company_id, channel_id, external_order_id, order_date, ship_state, payload)
  values (ch.company_id, ch.id, p ->> 'external_order_id', v_date, p ->> 'ship_state', p) returning id into v_id;
  v_order := api.confirm_sales_order(app.child_crid(p_client_request_id, 'order'), jsonb_build_object('company_id', ch.company_id, 'gstin_id', ch.gstin_id, 'party_id', ch.party_id,
    'order_date', v_date, 'channel', 'online', 'payment', 'advance', 'place_id', ch.place_id, 'place_of_supply', p ->> 'ship_state',
    'notes', ch.code || ' order ' || (p ->> 'external_order_id')), v_lines);
  update sales.online_orders set order_id = (v_order ->> 'id')::uuid where id = v_id;
  update sales.orders set online_order_id = v_id where id = (v_order ->> 'id')::uuid;
  v_res := jsonb_build_object('online_order_id', v_id, 'order_id', v_order ->> 'id', 'doc_no', v_order ->> 'doc_no', 'duplicate', false);
  return app.request_done(p_client_request_id, 'ingest_online_order', v_res);
end $$;

grant select on all tables in schema api to authenticated;
revoke all on all functions in schema api from public, anon;
grant execute on all functions in schema api to authenticated;
grant execute on function api.log_sign_in_failure(text) to anon;
revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;
notify pgrst, 'reload schema';

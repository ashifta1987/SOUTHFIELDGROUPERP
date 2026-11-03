-- 20261103004300_purchase.sql
-- Phase 4 purchase to pay: department requests (approved by someone else, within approval limits), RFQs and
-- quotations, purchase orders (tax from the HSN table, MSME terms ≤ 45 days, price increases accepted explicitly,
-- WhatsApp "PO issued" to a consented supplier contact), goods receipts (stock into quarantine when the item needs an
-- incoming test, else available; partial deliveries; no over-receipt unless a tolerance is set), bill photo captures
-- (private bucket `bills`) with a 3-way match against PO and GRN (tolerances from settings; exact when unset), the
-- link to Phase 3 purchase bills, price history, and the supplier payment advice outbox row. Additive.

-- Links from Phase 3 purchase bills (additive columns).
alter table purch.bills add column if not exists order_id uuid;
alter table purch.bills add column if not exists grn_id uuid;
alter table purch.bills add column if not exists capture_id uuid;

-- ─────────── Requests ───────────
create table purch.requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  doc_no text not null,
  request_date date not null,
  department text not null check (length(trim(department)) > 0),
  for_job text,
  needed_by date,
  reason text,
  attachment_path text,
  est_total numeric(18, 2) not null default 0,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'refused', 'ordered', 'closed', 'cancelled')),
  requested_by uuid not null references auth.users (id),
  submitted_at timestamptz,
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  unique (company_id, doc_no),
  check (decided_by is null or decided_by <> requested_by)          -- nobody approves their own request
);
create index on purch.requests (company_id, status);

create table purch.request_lines (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references purch.requests (id) on delete cascade,
  line_no int not null,
  product_id uuid references master.products (id),
  description text not null,
  qty numeric(18, 3) not null check (qty > 0),
  uom text not null default 'NOS',
  est_rate numeric(18, 2) check (est_rate is null or est_rate >= 0),
  suggested_party_id uuid references master.parties (id),
  note text,
  unique (request_id, line_no)
);

-- ─────────── RFQs and quotations ───────────
create table purch.rfqs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  doc_no text not null,
  rfq_date date not null,
  request_id uuid references purch.requests (id),
  due_date date,
  status text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  note text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (company_id, doc_no)
);
create table purch.rfq_lines (
  id uuid primary key default gen_random_uuid(),
  rfq_id uuid not null references purch.rfqs (id) on delete cascade,
  line_no int not null,
  product_id uuid references master.products (id),
  description text not null,
  qty numeric(18, 3) not null check (qty > 0),
  uom text not null default 'NOS',
  request_line_id uuid references purch.request_lines (id),
  unique (rfq_id, line_no)
);
create table purch.rfq_suppliers (
  rfq_id uuid not null references purch.rfqs (id) on delete cascade,
  party_id uuid not null references master.parties (id),
  primary key (rfq_id, party_id)
);
create table purch.quotations (
  id uuid primary key default gen_random_uuid(),
  rfq_id uuid not null references purch.rfqs (id),
  company_id uuid not null references core.companies (id),
  party_id uuid not null references master.parties (id),
  quote_ref text,
  quote_date date not null,
  valid_until date,
  terms_days int check (terms_days is null or terms_days between 0 and 365),
  delivery_days int check (delivery_days is null or delivery_days >= 0),
  status text not null default 'received' check (status in ('received', 'selected', 'rejected')),
  attachment_path text,
  note text,
  recorded_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (rfq_id, party_id)
);
create table purch.quotation_lines (
  id uuid primary key default gen_random_uuid(),
  quotation_id uuid not null references purch.quotations (id) on delete cascade,
  rfq_line_id uuid not null references purch.rfq_lines (id),
  qty numeric(18, 3) not null check (qty > 0),
  rate numeric(18, 2) not null check (rate >= 0),
  discount numeric(18, 2) not null default 0 check (discount >= 0),
  note text,
  unique (quotation_id, rfq_line_id)
);

-- ─────────── Purchase orders ───────────
create table purch.orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  gstin_id uuid not null references core.gstins (id),
  doc_no text,
  party_id uuid not null references master.parties (id),
  request_id uuid references purch.requests (id),
  quotation_id uuid references purch.quotations (id),
  order_date date not null,
  delivery_date date,
  place_id uuid references core.places (id),
  place_of_supply char(2) not null,
  terms_days int not null default 0 check (terms_days between 0 and 365),
  msme boolean not null default false,
  taxable numeric(18, 2) not null default 0,
  cgst numeric(18, 2) not null default 0,
  sgst numeric(18, 2) not null default 0,
  igst numeric(18, 2) not null default 0,
  round_off numeric(18, 2) not null default 0,
  total numeric(18, 2) not null default 0,
  status text not null default 'draft' check (status in ('draft', 'issued', 'confirmed', 'part_received', 'received', 'closed', 'cancelled')),
  price_flags jsonb not null default '[]'::jsonb,
  price_rise_accepted_by uuid references auth.users (id),
  notes text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  issued_by uuid references auth.users (id),
  issued_at timestamptz,
  confirmed_at timestamptz,
  confirmation_note text,
  cancelled_at timestamptz,
  cancel_reason text,
  unique (company_id, doc_no),
  check (not msme or terms_days <= 45)                                -- MSMED Act s.15: at most 45 days
);
create index on purch.orders (company_id, status);
create index on purch.orders (party_id);

create table purch.order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references purch.orders (id) on delete cascade,
  line_no int not null,
  product_id uuid references master.products (id),
  description text not null,
  hsn_code text,
  uom text not null default 'NOS',
  qty numeric(18, 3) not null check (qty > 0),
  rate numeric(18, 2) not null check (rate >= 0),
  discount numeric(18, 2) not null default 0 check (discount >= 0),
  taxable numeric(18, 2) not null default 0,
  gst_rate numeric(9, 4) not null default 0,
  cgst numeric(18, 2) not null default 0,
  sgst numeric(18, 2) not null default 0,
  igst numeric(18, 2) not null default 0,
  total numeric(18, 2) not null default 0,
  qty_received numeric(18, 3) not null default 0 check (qty_received >= 0),
  request_line_id uuid references purch.request_lines (id),
  unique (order_id, line_no)
);

-- ─────────── Goods receipts ───────────
create table purch.goods_receipts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  gstin_id uuid references core.gstins (id),
  doc_no text not null,
  party_id uuid not null references master.parties (id),
  order_id uuid references purch.orders (id),
  place_id uuid not null references core.places (id),
  receipt_date date not null,
  supplier_invoice_no text,
  supplier_invoice_date date,
  eway_bill_no text,
  vehicle_no text,
  direct_purchase boolean not null default false,
  approved_by uuid references auth.users (id),
  status text not null default 'posted' check (status in ('posted', 'cancelled')),
  notes text,
  received_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  unique (company_id, doc_no),
  check (order_id is not null or (direct_purchase and approved_by is not null))
);
create index on purch.goods_receipts (company_id, receipt_date);
create index on purch.goods_receipts (order_id);

create table purch.grn_lines (
  id uuid primary key default gen_random_uuid(),
  grn_id uuid not null references purch.goods_receipts (id),
  line_no int not null,
  order_line_id uuid references purch.order_lines (id),
  product_id uuid not null references master.products (id),
  qty numeric(18, 3) not null check (qty > 0),
  uom text not null default 'NOS',
  rate numeric(18, 2) not null default 0 check (rate >= 0),
  lot_id uuid references inv.lots (id),
  supplier_lot_no text,
  bucket text not null check (bucket in ('quarantine', 'available')),
  qty_accepted numeric(18, 3) not null default 0,
  qty_rejected numeric(18, 3) not null default 0,
  unique (grn_id, line_no)
);
create index on purch.grn_lines (order_line_id);
create index on purch.grn_lines (lot_id);
alter table inv.lots add constraint lots_grn_fk foreign key (grn_id) references purch.goods_receipts (id);

-- ─────────── Bill captures and price history ───────────
create table purch.bill_captures (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  photo_path text not null,
  source text not null default 'phone' check (source in ('phone', 'whatsapp', 'email', 'pdf', 'upload')),
  status text not null default 'uploaded' check (status in ('uploaded', 'read', 'matched', 'mismatch', 'drafted', 'posted', 'rejected')),
  extracted jsonb not null default '{}'::jsonb,
  party_id uuid references master.parties (id),
  order_id uuid references purch.orders (id),
  grn_id uuid references purch.goods_receipts (id),
  bill_id uuid references purch.bills (id),
  match_result jsonb,
  uploaded_by uuid references auth.users (id),
  uploaded_at timestamptz not null default now(),
  read_at timestamptz,
  matched_by uuid references auth.users (id),
  matched_at timestamptz,
  reject_reason text
);
create index on purch.bill_captures (company_id, status);
alter table purch.bills add constraint bills_order_fk foreign key (order_id) references purch.orders (id);
alter table purch.bills add constraint bills_grn_fk foreign key (grn_id) references purch.goods_receipts (id);
alter table purch.bills add constraint bills_capture_fk foreign key (capture_id) references purch.bill_captures (id);

-- Every purchase rate (before GST, per unit after discount), append-only.
create table purch.price_history (
  id bigint generated always as identity primary key,
  company_id uuid not null references core.companies (id),
  product_id uuid not null references master.products (id),
  party_id uuid references master.parties (id),
  rate numeric(18, 2) not null check (rate >= 0),
  qty numeric(18, 3),
  uom text,
  source text not null check (source in ('bill', 'order')),
  source_id uuid not null,
  rate_date date not null,
  created_at timestamptz not null default now()
);
create index on purch.price_history (company_id, product_id, rate_date desc);
create trigger price_history_append_only before update or delete on purch.price_history for each row execute function app.reject_change();
create trigger grn_no_delete before delete on purch.goods_receipts for each row execute function app.reject_change();
create trigger grn_lines_no_delete before delete on purch.grn_lines for each row execute function app.reject_change();

do $$
declare t text;
begin
  foreach t in array array['purch.requests', 'purch.request_lines', 'purch.rfqs', 'purch.rfq_lines', 'purch.rfq_suppliers', 'purch.quotations', 'purch.quotation_lines',
                           'purch.orders', 'purch.order_lines', 'purch.goods_receipts', 'purch.grn_lines', 'purch.bill_captures'] loop
    execute format('create trigger audit_row after insert or update or delete on %s for each row execute function app.audit_trigger()', t);
  end loop;
  foreach t in array array['requests', 'request_lines', 'rfqs', 'rfq_lines', 'rfq_suppliers', 'quotations', 'quotation_lines', 'orders', 'order_lines',
                           'goods_receipts', 'grn_lines', 'bill_captures', 'price_history'] loop
    execute format('alter table purch.%I enable row level security', t);
    execute format('revoke all on purch.%I from anon, authenticated', t);
    execute format('grant select on purch.%I to authenticated', t);
  end loop;
end $$;

create policy requests_read on purch.requests for select to authenticated using (app.can(company_id, 'purchase.view') or requested_by = (select auth.uid()));
create policy request_lines_read on purch.request_lines for select to authenticated
  using (exists (select 1 from purch.requests r where r.id = request_id and (app.can(r.company_id, 'purchase.view') or r.requested_by = (select auth.uid()))));
create policy rfqs_read on purch.rfqs for select to authenticated using (app.can(company_id, 'purchase.view'));
create policy rfq_lines_read on purch.rfq_lines for select to authenticated using (exists (select 1 from purch.rfqs r where r.id = rfq_id and app.can(r.company_id, 'purchase.view')));
create policy rfq_suppliers_read on purch.rfq_suppliers for select to authenticated using (exists (select 1 from purch.rfqs r where r.id = rfq_id and app.can(r.company_id, 'purchase.view')));
create policy quotations_read on purch.quotations for select to authenticated using (app.can(company_id, 'purchase.view'));
create policy quotation_lines_read on purch.quotation_lines for select to authenticated
  using (exists (select 1 from purch.quotations q where q.id = quotation_id and app.can(q.company_id, 'purchase.view')));
create policy orders_read on purch.orders for select to authenticated using (app.can(company_id, 'purchase.view') or app.can(company_id, 'inventory.create'));
create policy order_lines_read on purch.order_lines for select to authenticated
  using (exists (select 1 from purch.orders o where o.id = order_id and (app.can(o.company_id, 'purchase.view') or app.can(o.company_id, 'inventory.create'))));
create policy grns_read on purch.goods_receipts for select to authenticated using (app.can(company_id, 'purchase.view') or app.can(company_id, 'inventory.view'));
create policy grn_lines_read on purch.grn_lines for select to authenticated
  using (exists (select 1 from purch.goods_receipts g where g.id = grn_id and (app.can(g.company_id, 'purchase.view') or app.can(g.company_id, 'inventory.view'))));
create policy captures_read on purch.bill_captures for select to authenticated
  using (app.can(company_id, 'purchase.view') or app.can(company_id, 'purchase_bills.view') or uploaded_by = (select auth.uid()));
create policy price_history_read on purch.price_history for select to authenticated using (app.can(company_id, 'purchase.view') or app.can(company_id, 'purchase_bills.view'));

-- Private bucket for bill photos (Mumbai). Paths: <company_id>/<capture uuid>.<ext>
insert into storage.buckets (id, name, public, file_size_limit) values ('bills', 'bills', false, 20971520) on conflict (id) do nothing;
-- The first folder is the company: rights are checked for that company only (a path without one is refused).
create or replace function app.storage_company(p_name text) returns uuid
language sql immutable set search_path = '' as $$
  select case when split_part(p_name, '/', 1) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              then split_part(p_name, '/', 1)::uuid end
$$;
create policy bills_read on storage.objects for select to authenticated
  using (bucket_id = 'bills' and app.storage_company(name) is not null
         and (app.can(app.storage_company(name), 'purchase.view') or app.can(app.storage_company(name), 'purchase_bills.view')));
create policy bills_write on storage.objects for insert to authenticated
  with check (bucket_id = 'bills' and app.storage_company(name) is not null
              and (app.can(app.storage_company(name), 'purchase.create') or app.can(app.storage_company(name), 'purchase_bills.create')));

-- WhatsApp utility templates (English drafts; Meta approval is the owner's step).
insert into msg.templates (name, language, category, event, header_type, body, params, approval_status) values
  ('po_issued', 'en', 'utility', 'purchase.po_issued', 'document', 'Dear {{1}}, please find our purchase order {{2}}. Delivery by {{3}}. – {{4}}', '["supplier","doc_no","delivery_date","company"]', 'draft'),
  ('payment_advice', 'en', 'utility', 'purchase.payment_advice', 'document', 'Dear {{1}}, we have paid ₹{{2}} (payment {{3}}) against: {{4}}. – {{5}}', '["supplier","amount","doc_no","bills","company"]', 'draft')
on conflict do nothing;

-- ─────────── Helpers ───────────
-- Last purchase rate of an item in a company (bills and issued orders), excluding one source.
create or replace function app.last_rate(p_company uuid, p_product uuid, p_exclude uuid default null) returns numeric
language sql stable security definer set search_path = '' as $$
  select h.rate from purch.price_history h where h.company_id = p_company and h.product_id = p_product and h.source_id is distinct from p_exclude
  order by h.rate_date desc, h.id desc limit 1
$$;

-- A numeric setting, or null when the owner/CA has not set it.
create or replace function app.setting_num(p_company uuid, p_key text) returns numeric
language sql stable security definer set search_path = '' as $$
  select nullif(app.setting(p_company, p_key)::text, 'null')::numeric
$$;

-- Price increases on an order against the last rate. Setting purchase.price_alert_pct (if set) is the threshold;
-- when it is not set, every increase is flagged (the safest reading).
create or replace function app.order_price_flags(p_order uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('line_no', x.line_no, 'product_id', x.product_id, 'last_rate', x.last_rate, 'new_rate', x.new_rate,
                                               'change_pct', round((x.new_rate - x.last_rate) * 100 / nullif(x.last_rate, 0), 2)) order by x.line_no), '[]'::jsonb)
  from (select l.line_no, l.product_id, round(l.taxable / l.qty, 2) as new_rate, app.last_rate(o.company_id, l.product_id, o.id) as last_rate,
               app.setting_num(o.company_id, 'purchase.price_alert_pct') as pct
        from purch.order_lines l join purch.orders o on o.id = l.order_id where l.order_id = p_order and l.product_id is not null) x
  where x.last_rate is not null and x.new_rate > x.last_rate
    and (x.pct is null or (x.new_rate - x.last_rate) * 100 / nullif(x.last_rate, 0) > x.pct)
$$;

-- ─────────── Requests ───────────
-- p: {id (edit a draft), company_id, department, for_job, needed_by, reason, attachment_path, date, submit boolean,
--     lines: [{product_id, description, qty, uom, est_rate, suggested_party_id, note}]}
create or replace function api.create_purchase_request(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_company uuid := (p ->> 'company_id')::uuid; v_no text; l jsonb; v_n int := 0;
        v_date date := coalesce(nullif(p ->> 'date', '')::date, current_date); r purch.requests; v_submit boolean := coalesce((p ->> 'submit')::boolean, false);
begin
  v_prev := app.request_seen(p_client_request_id, 'create_purchase_request'); if v_prev is not null then return v_prev; end if;
  if v_id is not null then
    select * into r from purch.requests where id = v_id for update;
    if r.id is null or r.status <> 'draft' then perform app.raise_rule('purchase.request_locked', 'only a draft request can be changed', '22023'); end if;
    if r.requested_by <> auth.uid() then perform app.raise_rule('purchase.request_not_yours', 'only the person who made the request can change it', '42501'); end if;
    v_company := r.company_id;
  end if;
  perform app.require(v_company, 'purchase.create');
  if coalesce(length(trim(p ->> 'department')), 0) = 0 then perform app.raise_rule('purchase.department', 'choose your department', '22023'); end if;
  if v_id is null then
    v_no := app.internal_doc_no(v_company, 'purchase_request', v_date);
    insert into purch.requests (company_id, doc_no, request_date, department, for_job, needed_by, reason, attachment_path, requested_by)
    values (v_company, v_no, v_date, trim(p ->> 'department'), nullif(p ->> 'for_job', ''), nullif(p ->> 'needed_by', '')::date, nullif(p ->> 'reason', ''), nullif(p ->> 'attachment_path', ''), auth.uid())
    returning id into v_id;
  else
    delete from purch.request_lines where request_id = v_id;
    update purch.requests set department = trim(p ->> 'department'), for_job = nullif(p ->> 'for_job', ''), needed_by = nullif(p ->> 'needed_by', '')::date,
           reason = nullif(p ->> 'reason', ''), attachment_path = nullif(p ->> 'attachment_path', '') where id = v_id;
    v_no := r.doc_no;
  end if;
  for l in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    v_n := v_n + 1;
    if coalesce((l ->> 'qty')::numeric, 0) <= 0 then perform app.raise_rule('doc.qty', 'every line needs a quantity above zero', '22023'); end if;
    insert into purch.request_lines (request_id, line_no, product_id, description, qty, uom, est_rate, suggested_party_id, note)
    select v_id, v_n, nullif(l ->> 'product_id', '')::uuid, coalesce(nullif(l ->> 'description', ''), pr.name, 'Item'), round((l ->> 'qty')::numeric, 3),
           coalesce(nullif(l ->> 'uom', ''), pr.uom, 'NOS'), nullif(l ->> 'est_rate', '')::numeric, nullif(l ->> 'suggested_party_id', '')::uuid, nullif(l ->> 'note', '')
    from (select 1) x left join master.products pr on pr.id = nullif(l ->> 'product_id', '')::uuid;
  end loop;
  if v_n = 0 then perform app.raise_rule('doc.no_lines', 'add at least one item', '22023'); end if;
  update purch.requests set est_total = (select coalesce(round(sum(qty * coalesce(est_rate, 0)), 2), 0) from purch.request_lines where request_id = v_id),
         status = case when v_submit then 'submitted' else 'draft' end, submitted_at = case when v_submit then now() end
   where id = v_id;
  v_res := jsonb_build_object('id', v_id, 'doc_no', v_no, 'status', case when v_submit then 'submitted' else 'draft' end);
  return app.request_done(p_client_request_id, 'create_purchase_request', v_res);
end $$;

-- Approve or refuse (purchase.approve, never your own). If approval limits are set for 'purchase_request', the approver's
-- limit must cover the estimate (Admin has no limit).
create or replace function api.approve_purchase_request(p_client_request_id uuid, p_request_id uuid, p_approve boolean, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; r purch.requests; v_limit numeric; v_has_limits boolean;
begin
  v_prev := app.request_seen(p_client_request_id, 'approve_purchase_request'); if v_prev is not null then return v_prev; end if;
  select * into r from purch.requests where id = p_request_id for update;
  if r.id is null then perform app.raise_rule('purchase.request_missing', 'request not found', 'P0002'); end if;
  perform app.require(r.company_id, 'purchase.approve');
  if r.status <> 'submitted' then perform app.raise_rule('purchase.request_state', 'only a request sent for approval can be decided', '22023'); end if;
  if r.requested_by = auth.uid() then perform app.raise_rule('sod.own_request', 'you cannot approve your own request', '42501'); end if;
  if coalesce(p_approve, false) and not app.is_admin() then
    select exists (select 1 from core.approval_limits where company_id = r.company_id and doc_type = 'purchase_request') into v_has_limits;
    if v_has_limits then
      select max(a.amount) into v_limit from core.approval_limits a join app.my_roles() m on m.role_key = a.role_key and (m.company_id is null or m.company_id = r.company_id)
       where a.company_id = r.company_id and a.doc_type = 'purchase_request';
      if coalesce(v_limit, -1) < r.est_total then perform app.raise_rule('purchase.over_limit', 'this request is above your approval limit; it goes to Admin', '42501'); end if;
    end if;
  end if;
  if not coalesce(p_approve, false) and coalesce(length(trim(p_note)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'give the reason for refusing', '22023'); end if;
  update purch.requests set status = case when p_approve then 'approved' else 'refused' end, decided_by = auth.uid(), decided_at = now(), decision_note = nullif(trim(p_note), '') where id = r.id;
  v_res := jsonb_build_object('id', r.id, 'status', case when p_approve then 'approved' else 'refused' end);
  return app.request_done(p_client_request_id, 'approve_purchase_request', v_res);
end $$;

-- ─────────── RFQs and quotations ───────────
-- p: {company_id, request_id, date, due_date, note, supplier_ids: [uuid], lines: [{product_id, description, qty, uom, request_line_id}]}
-- With a request_id and no lines, the request's lines are copied (the request must be approved).
create or replace function api.create_rfq(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_req purch.requests; v_id uuid; v_no text; l jsonb; v_n int := 0; s text;
        v_date date := coalesce(nullif(p ->> 'date', '')::date, current_date);
begin
  v_prev := app.request_seen(p_client_request_id, 'create_rfq'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'purchase.create');
  if nullif(p ->> 'request_id', '') is not null then
    select * into v_req from purch.requests where id = (p ->> 'request_id')::uuid and company_id = v_company;
    if v_req.id is null or v_req.status not in ('approved', 'ordered') then perform app.raise_rule('purchase.request_not_approved', 'the request must be approved first', '22023'); end if;
  end if;
  v_no := app.internal_doc_no(v_company, 'rfq', v_date);
  insert into purch.rfqs (company_id, doc_no, rfq_date, request_id, due_date, note, created_by)
  values (v_company, v_no, v_date, v_req.id, nullif(p ->> 'due_date', '')::date, nullif(p ->> 'note', ''), auth.uid()) returning id into v_id;
  if jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) = 0 and v_req.id is not null then
    insert into purch.rfq_lines (rfq_id, line_no, product_id, description, qty, uom, request_line_id)
    select v_id, line_no, product_id, description, qty, uom, id from purch.request_lines where request_id = v_req.id;
    get diagnostics v_n = row_count;
  else
    for l in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
      v_n := v_n + 1;
      if coalesce((l ->> 'qty')::numeric, 0) <= 0 then perform app.raise_rule('doc.qty', 'every line needs a quantity above zero', '22023'); end if;
      insert into purch.rfq_lines (rfq_id, line_no, product_id, description, qty, uom, request_line_id)
      select v_id, v_n, nullif(l ->> 'product_id', '')::uuid, coalesce(nullif(l ->> 'description', ''), pr.name, 'Item'), round((l ->> 'qty')::numeric, 3),
             coalesce(nullif(l ->> 'uom', ''), pr.uom, 'NOS'), nullif(l ->> 'request_line_id', '')::uuid
      from (select 1) x left join master.products pr on pr.id = nullif(l ->> 'product_id', '')::uuid;
    end loop;
  end if;
  if v_n = 0 then perform app.raise_rule('doc.no_lines', 'add at least one item', '22023'); end if;
  for s in select jsonb_array_elements_text(coalesce(p -> 'supplier_ids', '[]'::jsonb)) loop
    if not exists (select 1 from master.parties where id = s::uuid and is_supplier) then perform app.raise_rule('party.missing', 'choose suppliers', '22023'); end if;
    insert into purch.rfq_suppliers (rfq_id, party_id) values (v_id, s::uuid) on conflict do nothing;
  end loop;
  v_res := jsonb_build_object('id', v_id, 'doc_no', v_no, 'lines', v_n);
  return app.request_done(p_client_request_id, 'create_rfq', v_res);
end $$;

-- p: {rfq_id, party_id, quote_ref, quote_date, valid_until, terms_days, delivery_days, attachment_path, note, lines: [{rfq_line_id, rate, qty, discount}]}
create or replace function api.record_quotation(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; q purch.rfqs; v_id uuid; l jsonb; v_party master.parties; v_rl purch.rfq_lines;
begin
  v_prev := app.request_seen(p_client_request_id, 'record_quotation'); if v_prev is not null then return v_prev; end if;
  select * into q from purch.rfqs where id = (p ->> 'rfq_id')::uuid for update;
  if q.id is null then perform app.raise_rule('purchase.rfq_missing', 'RFQ not found', 'P0002'); end if;
  perform app.require(q.company_id, 'purchase.create');
  if q.status <> 'open' then perform app.raise_rule('purchase.rfq_closed', 'this RFQ is closed', '22023'); end if;
  select * into v_party from master.parties where id = (p ->> 'party_id')::uuid;
  if v_party.id is null or not v_party.is_supplier then perform app.raise_rule('party.missing', 'choose a supplier', '22023'); end if;
  if v_party.msme_category in ('micro', 'small') and coalesce((p ->> 'terms_days')::int, 0) > 45 then
    perform app.raise_rule('msme.terms_over_45', 'an MSME supplier is paid within 45 days at most (MSMED Act s.15)', '22023');
  end if;
  insert into purch.quotations (rfq_id, company_id, party_id, quote_ref, quote_date, valid_until, terms_days, delivery_days, attachment_path, note, recorded_by)
  values (q.id, q.company_id, v_party.id, nullif(p ->> 'quote_ref', ''), coalesce(nullif(p ->> 'quote_date', '')::date, current_date), nullif(p ->> 'valid_until', '')::date,
          nullif(p ->> 'terms_days', '')::int, nullif(p ->> 'delivery_days', '')::int, nullif(p ->> 'attachment_path', ''), nullif(p ->> 'note', ''), auth.uid())
  on conflict (rfq_id, party_id) do update set quote_ref = excluded.quote_ref, quote_date = excluded.quote_date, valid_until = excluded.valid_until, terms_days = excluded.terms_days,
     delivery_days = excluded.delivery_days, attachment_path = excluded.attachment_path, note = excluded.note, recorded_by = excluded.recorded_by
  returning id into v_id;
  delete from purch.quotation_lines where quotation_id = v_id;
  for l in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    select * into v_rl from purch.rfq_lines where id = (l ->> 'rfq_line_id')::uuid and rfq_id = q.id;
    if v_rl.id is null then perform app.raise_rule('purchase.rfq_line_missing', 'line not on this RFQ', '22023'); end if;
    if coalesce((l ->> 'rate')::numeric, -1) < 0 then perform app.raise_rule('doc.rate', 'enter the quoted rate', '22023'); end if;
    insert into purch.quotation_lines (quotation_id, rfq_line_id, qty, rate, discount, note)
    values (v_id, v_rl.id, coalesce(nullif(l ->> 'qty', '')::numeric, v_rl.qty), (l ->> 'rate')::numeric, coalesce(nullif(l ->> 'discount', '')::numeric, 0), nullif(l ->> 'note', ''));
  end loop;
  insert into purch.rfq_suppliers (rfq_id, party_id) values (q.id, v_party.id) on conflict do nothing;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'record_quotation', v_res);
end $$;

-- Choose a quotation (purchase.create): the others are marked rejected and the RFQ closes. Returns the new draft PO.
-- p: {gstin_id, place_id, delivery_date, order_date}
create or replace function api.select_quotation(p_client_request_id uuid, p_quotation_id uuid, p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; qt purch.quotations; v_rfq purch.rfqs; v_lines jsonb; v_po jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'select_quotation'); if v_prev is not null then return v_prev; end if;
  select * into qt from purch.quotations where id = p_quotation_id for update;
  if qt.id is null then perform app.raise_rule('purchase.quotation_missing', 'quotation not found', 'P0002'); end if;
  -- The buyer chooses (the draft order is theirs); an approver issues it (api.issue_purchase_order).
  perform app.require(qt.company_id, 'purchase.create');
  select * into v_rfq from purch.rfqs where id = qt.rfq_id for update;
  if v_rfq.status <> 'open' then perform app.raise_rule('purchase.rfq_closed', 'this RFQ is closed', '22023'); end if;
  update purch.quotations set status = case when id = qt.id then 'selected' else 'rejected' end where rfq_id = qt.rfq_id;
  update purch.rfqs set status = 'closed' where id = qt.rfq_id;
  select jsonb_agg(jsonb_build_object('product_id', rl.product_id, 'description', rl.description, 'uom', rl.uom, 'qty', ql.qty, 'rate', ql.rate, 'discount', ql.discount,
                                      'request_line_id', rl.request_line_id) order by rl.line_no)
    into v_lines from purch.quotation_lines ql join purch.rfq_lines rl on rl.id = ql.rfq_line_id where ql.quotation_id = qt.id;
  v_po := api.save_purchase_order(gen_random_uuid(), jsonb_build_object('company_id', qt.company_id, 'gstin_id', p ->> 'gstin_id', 'party_id', qt.party_id,
            'request_id', v_rfq.request_id, 'quotation_id', qt.id, 'place_id', p ->> 'place_id', 'delivery_date', p ->> 'delivery_date', 'order_date', p ->> 'order_date',
            'terms_days', qt.terms_days, 'lines', coalesce(v_lines, '[]'::jsonb)));
  v_res := jsonb_build_object('quotation_id', qt.id, 'order_id', v_po ->> 'id');
  return app.request_done(p_client_request_id, 'select_quotation', v_res);
end $$;

-- ─────────── Purchase orders ───────────
-- p: {id (edit a draft), company_id, gstin_id (default: principal GSTIN), party_id, request_id, quotation_id, order_date, delivery_date, place_id,
--     terms_days, notes, lines: [{product_id, description, hsn_code, uom, qty, rate, discount, request_line_id}]}
create or replace function api.save_purchase_order(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_res jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_company uuid := (p ->> 'company_id')::uuid; v_gstin core.gstins; v_party master.parties;
  v_calc jsonb; v_pos text; v_terms int; v_msme boolean; l jsonb; i int := 0; v_date date := coalesce(nullif(p ->> 'order_date', '')::date, current_date);
begin
  v_prev := app.request_seen(p_client_request_id, 'save_purchase_order'); if v_prev is not null then return v_prev; end if;
  if v_id is not null then
    select company_id into v_company from purch.orders where id = v_id and status = 'draft' for update;
    if v_company is null then perform app.raise_rule('posting.locked', 'only a draft order can be changed', '22023'); end if;
  end if;
  perform app.require(v_company, 'purchase.create');
  select * into v_gstin from core.gstins where company_id = v_company and status = 'active'
     and (id = nullif(p ->> 'gstin_id', '')::uuid or (nullif(p ->> 'gstin_id', '') is null and is_principal)) limit 1;
  if v_gstin.id is null then perform app.raise_rule('org.gstin_other_company', 'choose a GSTIN of this company', '22023'); end if;
  select * into v_party from master.parties where id = (p ->> 'party_id')::uuid;
  if v_party.id is null or not v_party.is_supplier then perform app.raise_rule('party.missing', 'choose a supplier', '22023'); end if;
  if nullif(p ->> 'place_id', '') is not null and not exists (select 1 from core.places where id = (p ->> 'place_id')::uuid and company_id = v_company) then
    perform app.raise_rule('stock.place_other_company', 'the place belongs to another company', '22023');
  end if;
  v_pos := coalesce(v_party.state_code, v_gstin.state_code);
  select coalesce(t.days, 0) into v_terms from master.party_companies pc left join master.credit_terms t on t.id = pc.credit_term_id where pc.party_id = v_party.id and pc.company_id = v_company;
  v_terms := coalesce(nullif(p ->> 'terms_days', '')::int, v_terms, 0);
  v_msme := coalesce(v_party.msme_category in ('micro', 'small'), false);
  if v_msme and v_terms > 45 then perform app.raise_rule('msme.terms_over_45', 'an MSME supplier is paid within 45 days at most (MSMED Act s.15)', '22023'); end if;
  v_calc := app.compute_tax(v_gstin.state_code, v_pos, v_date, false, coalesce(p -> 'lines', '[]'::jsonb));
  if v_id is null then
    insert into purch.orders (company_id, gstin_id, party_id, request_id, quotation_id, order_date, delivery_date, place_id, place_of_supply, terms_days, msme, notes, created_by)
    values (v_company, v_gstin.id, v_party.id, nullif(p ->> 'request_id', '')::uuid, nullif(p ->> 'quotation_id', '')::uuid, v_date, nullif(p ->> 'delivery_date', '')::date,
            nullif(p ->> 'place_id', '')::uuid, v_pos, v_terms, v_msme, nullif(p ->> 'notes', ''), auth.uid())
    returning id into v_id;
  else
    delete from purch.order_lines where order_id = v_id;
    update purch.orders set gstin_id = v_gstin.id, party_id = v_party.id, request_id = nullif(p ->> 'request_id', '')::uuid, quotation_id = nullif(p ->> 'quotation_id', '')::uuid,
           order_date = v_date, delivery_date = nullif(p ->> 'delivery_date', '')::date, place_id = nullif(p ->> 'place_id', '')::uuid, place_of_supply = v_pos,
           terms_days = v_terms, msme = v_msme, notes = nullif(p ->> 'notes', '')
     where id = v_id;
  end if;
  for l in select * from jsonb_array_elements(v_calc -> 'lines') loop
    i := i + 1;
    insert into purch.order_lines (order_id, line_no, product_id, description, hsn_code, uom, qty, rate, discount, taxable, gst_rate, cgst, sgst, igst, total, request_line_id)
    values (v_id, (l ->> 'line_no')::int, nullif(l ->> 'product_id', '')::uuid, l ->> 'description', l ->> 'hsn_code', l ->> 'uom', (l ->> 'qty')::numeric, (l ->> 'rate')::numeric,
            (l ->> 'discount')::numeric, (l ->> 'taxable')::numeric, (l ->> 'gst_rate')::numeric, (l ->> 'cgst')::numeric, (l ->> 'sgst')::numeric, (l ->> 'igst')::numeric,
            (l ->> 'total')::numeric, nullif((p -> 'lines' -> (i - 1)) ->> 'request_line_id', '')::uuid);
  end loop;
  update purch.orders set taxable = (v_calc ->> 'taxable')::numeric, cgst = (v_calc ->> 'cgst')::numeric, sgst = (v_calc ->> 'sgst')::numeric, igst = (v_calc ->> 'igst')::numeric,
         round_off = (v_calc ->> 'round_off')::numeric, total = (v_calc ->> 'total')::numeric where id = v_id;
  update purch.orders set price_flags = app.order_price_flags(v_id) where id = v_id;
  v_res := jsonb_build_object('id', v_id, 'totals', v_calc - 'lines', 'price_flags', (select price_flags from purch.orders where id = v_id));
  return app.request_done(p_client_request_id, 'save_purchase_order', v_res);
end $$;

-- Issue (purchase.approve, never the person who drafted it): number taken, price increases must be accepted, rates recorded, and the "PO issued" WhatsApp
-- row queued for the supplier's consented contact (skipped with a reason when there is none).
create or replace function api.issue_purchase_order(p_client_request_id uuid, p_order_id uuid, p_accept_price_increase boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; o purch.orders; v_flags jsonb; v_no text; v_party master.parties; v_msg uuid; v_company_name text;
begin
  v_prev := app.request_seen(p_client_request_id, 'issue_purchase_order'); if v_prev is not null then return v_prev; end if;
  select * into o from purch.orders where id = p_order_id for update;
  if o.id is null then perform app.raise_rule('purchase.order_missing', 'order not found', 'P0002'); end if;
  perform app.require(o.company_id, 'purchase.approve');
  if o.status <> 'draft' then perform app.raise_rule('purchase.order_state', 'only a draft order can be issued', '22023'); end if;
  if o.created_by = auth.uid() then perform app.raise_rule('sod.own_order', 'you drafted this order; another approver must issue it', '42501'); end if;
  if not exists (select 1 from purch.order_lines where order_id = o.id) then perform app.raise_rule('doc.no_lines', 'add at least one line', '22023'); end if;
  select * into v_party from master.parties where id = o.party_id;
  if v_party.msme_category in ('micro', 'small') and o.terms_days > 45 then perform app.raise_rule('msme.terms_over_45', 'an MSME supplier is paid within 45 days at most (MSMED Act s.15)', '22023'); end if;
  v_flags := app.order_price_flags(o.id);
  if jsonb_array_length(v_flags) > 0 and not coalesce(p_accept_price_increase, false) then
    perform app.raise_rule('purchase.price_increase', jsonb_array_length(v_flags) || ' lines are dearer than the last purchase; check and accept the increase to issue', '22023');
  end if;
  v_no := app.internal_doc_no(o.company_id, 'purchase_order', o.order_date);
  update purch.orders set status = 'issued', doc_no = v_no, issued_by = auth.uid(), issued_at = now(), price_flags = v_flags,
         price_rise_accepted_by = case when jsonb_array_length(v_flags) > 0 then auth.uid() end where id = o.id;
  insert into purch.price_history (company_id, product_id, party_id, rate, qty, uom, source, source_id, rate_date)
  select o.company_id, l.product_id, o.party_id, round(l.taxable / l.qty, 2), l.qty, l.uom, 'order', o.id, o.order_date from purch.order_lines l where l.order_id = o.id and l.product_id is not null;
  if o.request_id is not null then update purch.requests set status = 'ordered' where id = o.request_id and status = 'approved'; end if;
  select short_name into v_company_name from core.companies where id = o.company_id;
  v_msg := app.enqueue_message(jsonb_build_object('company_id', o.company_id, 'event', 'purchase.po_issued', 'template', 'po_issued', 'party_id', o.party_id,
    'doc_type', 'purch.orders', 'doc_id', o.id, 'stage', 'issued',
    'params', jsonb_build_object('supplier', v_party.legal_name, 'doc_no', v_no, 'delivery_date', coalesce(to_char(o.delivery_date, 'DD-MM-YYYY'), '—'), 'company', v_company_name)));
  v_res := jsonb_build_object('id', o.id, 'doc_no', v_no, 'price_flags', v_flags, 'message_id', v_msg);
  return app.request_done(p_client_request_id, 'issue_purchase_order', v_res);
end $$;

create or replace function api.confirm_purchase_order(p_client_request_id uuid, p_order_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; o purch.orders;
begin
  v_prev := app.request_seen(p_client_request_id, 'confirm_purchase_order'); if v_prev is not null then return v_prev; end if;
  select * into o from purch.orders where id = p_order_id for update;
  if o.id is null then perform app.raise_rule('purchase.order_missing', 'order not found', 'P0002'); end if;
  perform app.require(o.company_id, 'purchase.edit');
  if o.status <> 'issued' then perform app.raise_rule('purchase.order_state', 'only an issued order can be confirmed', '22023'); end if;
  update purch.orders set status = 'confirmed', confirmed_at = now(), confirmation_note = nullif(trim(p_note), '') where id = o.id;
  v_res := jsonb_build_object('id', o.id, 'status', 'confirmed');
  return app.request_done(p_client_request_id, 'confirm_purchase_order', v_res);
end $$;

create or replace function api.cancel_purchase_order(p_client_request_id uuid, p_order_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; o purch.orders;
begin
  v_prev := app.request_seen(p_client_request_id, 'cancel_purchase_order'); if v_prev is not null then return v_prev; end if;
  select * into o from purch.orders where id = p_order_id for update;
  if o.id is null then perform app.raise_rule('purchase.order_missing', 'order not found', 'P0002'); end if;
  perform app.require(o.company_id, 'purchase.cancel');
  if o.status not in ('draft', 'issued', 'confirmed') or exists (select 1 from purch.order_lines where order_id = o.id and qty_received > 0) then
    perform app.raise_rule('purchase.order_state', 'goods have been received against this order; close it instead', '22023');
  end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'reason required', '22023'); end if;
  update purch.orders set status = 'cancelled', cancelled_at = now(), cancel_reason = trim(p_reason) where id = o.id;
  update msg.outbox set status = 'cancelled', skip_reason = 'order cancelled' where doc_type = 'purch.orders' and doc_id = o.id and status = 'queued';
  v_res := jsonb_build_object('id', o.id, 'status', 'cancelled');
  return app.request_done(p_client_request_id, 'cancel_purchase_order', v_res);
end $$;

-- ─────────── Goods receipt ───────────
-- p_header: {company_id, party_id, order_id, place_id, receipt_date, gstin_id, supplier_invoice_no, supplier_invoice_date, eway_bill_no, vehicle_no, notes}
-- p_lines: [{order_line_id, product_id, qty, rate, lot_no, supplier_lot_no, expiry_date, mfg_date}]
-- Without an order it is a direct purchase and needs purchase.approve. Items that need an incoming test go into quarantine.
create or replace function api.post_goods_receipt(p_client_request_id uuid, p_header jsonb, p_lines jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_res jsonb; v_company uuid := (p_header ->> 'company_id')::uuid; o purch.orders; v_place uuid := (p_header ->> 'place_id')::uuid;
  v_date date := coalesce(nullif(p_header ->> 'receipt_date', '')::date, current_date); v_id uuid; v_no text; l jsonb; v_n int := 0; ol purch.order_lines;
  v_product master.products; v_qty numeric; v_rate numeric; v_lot uuid; v_lot_no text; v_bucket text; v_tol numeric; v_lots jsonb := '[]'::jsonb; v_direct boolean;
  v_party uuid := nullif(p_header ->> 'party_id', '')::uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'post_goods_receipt'); if v_prev is not null then return v_prev; end if;
  if nullif(p_header ->> 'order_id', '') is not null then
    select * into o from purch.orders where id = (p_header ->> 'order_id')::uuid for update;
    if o.id is null then perform app.raise_rule('purchase.order_missing', 'order not found', 'P0002'); end if;
    v_company := o.company_id; v_party := coalesce(v_party, o.party_id);
    if o.party_id <> v_party then perform app.raise_rule('purchase.grn_wrong_supplier', 'the goods are from another supplier than the order', '22023'); end if;
    if o.status not in ('issued', 'confirmed', 'part_received') then perform app.raise_rule('purchase.order_state', 'receive only against an issued order', '22023'); end if;
  end if;
  perform app.require(v_company, 'inventory.create');
  v_direct := o.id is null;
  if v_direct then
    if not app.can(v_company, 'purchase.approve') then
      perform app.raise_rule('purchase.direct_needs_approval', 'without a purchase order the receipt needs Admin approval as a direct purchase', '42501');
    end if;
    if not exists (select 1 from master.parties where id = v_party and is_supplier) then perform app.raise_rule('party.missing', 'choose the supplier', '22023'); end if;
  end if;
  if not exists (select 1 from core.places where id = v_place and company_id = v_company) then perform app.raise_rule('stock.place_other_company', 'choose a store of this company', '22023'); end if;
  perform app.check_stock_date(v_company, v_date);
  v_tol := coalesce(app.setting_num(v_company, 'purchase.grn_over_receipt_pct'), 0);
  v_no := app.internal_doc_no(v_company, 'goods_receipt', v_date);
  insert into purch.goods_receipts (company_id, gstin_id, doc_no, party_id, order_id, place_id, receipt_date, supplier_invoice_no, supplier_invoice_date, eway_bill_no, vehicle_no,
                                    direct_purchase, approved_by, notes, received_by)
  values (v_company, coalesce(o.gstin_id, nullif(p_header ->> 'gstin_id', '')::uuid), v_no, v_party, o.id, v_place, v_date, nullif(p_header ->> 'supplier_invoice_no', ''),
          nullif(p_header ->> 'supplier_invoice_date', '')::date, nullif(p_header ->> 'eway_bill_no', ''), nullif(p_header ->> 'vehicle_no', ''),
          v_direct, case when v_direct then auth.uid() end, nullif(p_header ->> 'notes', ''), auth.uid())
  returning id into v_id;
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_n := v_n + 1;
    v_qty := round((l ->> 'qty')::numeric, 3);
    if coalesce(v_qty, 0) <= 0 then perform app.raise_rule('stock.qty', 'every line needs a quantity above zero', '22023'); end if;
    ol := null;
    if o.id is not null then
      select * into ol from purch.order_lines where id = (l ->> 'order_line_id')::uuid and order_id = o.id for update;
      if ol.id is null then perform app.raise_rule('purchase.grn_line_not_on_order', 'each line must be a line of the order', '22023'); end if;
      if ol.qty_received + v_qty > ol.qty * (1 + v_tol / 100) then
        perform app.raise_rule('purchase.over_receipt', format('line %s: %s ordered, %s already received', ol.line_no, ol.qty, ol.qty_received), 'P0001');
      end if;
      update purch.order_lines set qty_received = qty_received + v_qty where id = ol.id;
    end if;
    select * into v_product from master.products where id = coalesce(ol.product_id, (l ->> 'product_id')::uuid);
    if v_product.id is null then perform app.raise_rule('product.missing', 'choose the item', '22023'); end if;
    v_rate := coalesce(nullif(l ->> 'rate', '')::numeric, case when ol.id is not null then round(ol.taxable / ol.qty, 2) end, 0);
    v_bucket := case when v_product.needs_incoming_test then 'quarantine' else 'available' end;
    v_lot_no := coalesce(nullif(trim(l ->> 'lot_no'), ''), v_no || '-' || v_n);
    insert into inv.lots (company_id, product_id, lot_no, supplier_lot_no, mfg_date, expiry_date, source, status, needs_test, grn_id, received_by)
    values (v_company, v_product.id, v_lot_no, nullif(l ->> 'supplier_lot_no', ''), nullif(l ->> 'mfg_date', '')::date, nullif(l ->> 'expiry_date', '')::date,
            'goods_receipt', v_bucket, v_product.needs_incoming_test, v_id, auth.uid())
    returning id into v_lot;
    insert into purch.grn_lines (grn_id, line_no, order_line_id, product_id, qty, uom, rate, lot_id, supplier_lot_no, bucket, qty_accepted)
    values (v_id, v_n, ol.id, v_product.id, v_qty, v_product.uom, v_rate, v_lot, nullif(l ->> 'supplier_lot_no', ''), v_bucket, case when v_bucket = 'available' then v_qty else 0 end);
    perform app.stock_post(v_company, v_product.id, v_lot, v_place, v_bucket, v_qty, 'receipt', 'purch.goods_receipts', v_id, v_no, v_date, v_rate, 'Goods receipt');
    v_lots := v_lots || jsonb_build_object('line_no', v_n, 'lot_id', v_lot, 'lot_no', v_lot_no, 'bucket', v_bucket);
  end loop;
  if v_n = 0 then perform app.raise_rule('doc.no_lines', 'add at least one line', '22023'); end if;
  if o.id is not null then
    update purch.orders set status = case when exists (select 1 from purch.order_lines where order_id = o.id and qty_received < qty) then 'part_received' else 'received' end
     where id = o.id;
  end if;
  v_res := jsonb_build_object('id', v_id, 'doc_no', v_no, 'lots', v_lots, 'direct_purchase', v_direct);
  return app.request_done(p_client_request_id, 'post_goods_receipt', v_res);
end $$;

-- ─────────── Bill photo capture and 3-way match ───────────
-- p: {company_id, photo_path (bucket bills), source}
create or replace function api.create_bill_capture(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_id uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'create_bill_capture'); if v_prev is not null then return v_prev; end if;
  if not app.can(v_company, 'purchase.create') then perform app.require(v_company, 'purchase_bills.create'); end if;
  if auth.uid() is null then perform app.require(v_company, 'purchase.create'); end if;
  if coalesce(length(trim(p ->> 'photo_path')), 0) = 0 then perform app.raise_rule('capture.photo', 'take or upload the photo first', '22023'); end if;
  if app.storage_company(trim(p ->> 'photo_path')) is distinct from v_company then
    perform app.raise_rule('capture.photo_path', 'the photo must be stored under this company''s folder in the bills bucket', '22023');
  end if;
  insert into purch.bill_captures (company_id, photo_path, source, uploaded_by)
  values (v_company, trim(p ->> 'photo_path'), coalesce(nullif(p ->> 'source', ''), 'phone'), auth.uid()) returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'create_bill_capture', v_res);
end $$;

-- The reader (or a person) fills the fields. p: {extracted: {supplier_gstin, invoice_no, invoice_date, irn, taxable, cgst, sgst, igst, total,
--   lines: [{product_id, description, hsn_code, uom, qty, rate, discount}]}, party_id, order_id, grn_id}
create or replace function api.set_bill_capture_fields(p_client_request_id uuid, p_capture_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; c purch.bill_captures; v_party uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_bill_capture_fields'); if v_prev is not null then return v_prev; end if;
  select * into c from purch.bill_captures where id = p_capture_id for update;
  if c.id is null then perform app.raise_rule('capture.missing', 'bill photo not found', 'P0002'); end if;
  if not app.can(c.company_id, 'purchase.create') then perform app.require(c.company_id, 'purchase_bills.create'); end if;
  if c.status in ('drafted', 'posted', 'rejected') then perform app.raise_rule('capture.locked', 'this bill photo is already used', '22023'); end if;
  v_party := coalesce(nullif(p ->> 'party_id', '')::uuid,
                      (select id from master.parties where gstin = nullif(upper(p -> 'extracted' ->> 'supplier_gstin'), '') and is_supplier limit 1), c.party_id);
  if nullif(p ->> 'order_id', '') is not null and not exists (select 1 from purch.orders where id = (p ->> 'order_id')::uuid and company_id = c.company_id) then
    perform app.raise_rule('purchase.order_missing', 'order not found in this company', '22023');
  end if;
  if nullif(p ->> 'grn_id', '') is not null and not exists (select 1 from purch.goods_receipts where id = (p ->> 'grn_id')::uuid and company_id = c.company_id) then
    perform app.raise_rule('purchase.grn_missing', 'goods receipt not found in this company', '22023');
  end if;
  update purch.bill_captures set extracted = coalesce(p -> 'extracted', extracted), party_id = v_party,
         order_id = coalesce(nullif(p ->> 'order_id', '')::uuid, order_id), grn_id = coalesce(nullif(p ->> 'grn_id', '')::uuid, grn_id),
         status = 'read', read_at = now(), match_result = null
   where id = c.id;
  v_res := jsonb_build_object('id', c.id, 'party_id', v_party, 'status', 'read');
  return app.request_done(p_client_request_id, 'set_bill_capture_fields', v_res);
end $$;

-- 3-way match: bill (extracted) vs order (rate) vs goods received (qty), and the tax worked out from the HSN table.
-- Tolerances: settings purchase.match_qty_tolerance_pct and purchase.match_rate_tolerance_pct; when unset, exact match.
create or replace function api.match_bill_to_po_grn(p_client_request_id uuid, p_capture_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_res jsonb; c purch.bill_captures; v_ex jsonb; v_party master.parties; v_qtol numeric; v_rtol numeric; v_checks jsonb := '[]'::jsonb; v_ok boolean := true;
  l jsonb; v_po_rate numeric; v_recv numeric; v_bill_qty numeric; v_bill_rate numeric; v_calc jsonb; v_our text; v_gstin uuid; v_last numeric; v_notes jsonb := '[]'::jsonb; v_n int := 0;
begin
  v_prev := app.request_seen(p_client_request_id, 'match_bill_to_po_grn'); if v_prev is not null then return v_prev; end if;
  select * into c from purch.bill_captures where id = p_capture_id for update;
  if c.id is null then perform app.raise_rule('capture.missing', 'bill photo not found', 'P0002'); end if;
  if not app.can(c.company_id, 'purchase.create') then perform app.require(c.company_id, 'purchase_bills.create'); end if;
  if c.status not in ('read', 'matched', 'mismatch') then perform app.raise_rule('capture.state', 'read the bill first', '22023'); end if;
  v_ex := c.extracted;
  select * into v_party from master.parties where id = c.party_id;
  if v_party.id is null then perform app.raise_rule('party.missing', 'choose the supplier of this bill', '22023'); end if;
  v_qtol := app.setting_num(c.company_id, 'purchase.match_qty_tolerance_pct');
  v_rtol := app.setting_num(c.company_id, 'purchase.match_rate_tolerance_pct');
  if v_qtol is null or v_rtol is null then
    v_notes := v_notes || jsonb_build_object('code', 'match.tolerance_not_set', 'text', 'No tolerance is set, so quantity and rate must match exactly');
  end if;
  v_qtol := coalesce(v_qtol, 0); v_rtol := coalesce(v_rtol, 0);
  -- Duplicate bill number for this supplier.
  if exists (select 1 from purch.bills b where b.party_id = v_party.id and b.supplier_bill_no = coalesce(v_ex ->> 'invoice_no', '') and b.status <> 'cancelled') then
    v_ok := false; v_checks := v_checks || jsonb_build_object('check', 'duplicate', 'ok', false, 'text', 'This bill number is already entered for this supplier');
  else
    v_checks := v_checks || jsonb_build_object('check', 'duplicate', 'ok', true, 'text', 'Bill number not entered before for this supplier');
  end if;
  if c.order_id is null then
    v_ok := false; v_checks := v_checks || jsonb_build_object('check', 'order', 'ok', false, 'text', 'No purchase order: posts as a direct purchase after Admin approves');
  end if;
  for l in select * from jsonb_array_elements(coalesce(v_ex -> 'lines', '[]'::jsonb)) loop
    v_n := v_n + 1;
    v_bill_qty := coalesce((l ->> 'qty')::numeric, 0);
    v_bill_rate := round((v_bill_qty * coalesce((l ->> 'rate')::numeric, 0) - coalesce((l ->> 'discount')::numeric, 0)) / nullif(v_bill_qty, 0), 2);
    if nullif(l ->> 'product_id', '') is null then
      v_ok := false; v_checks := v_checks || jsonb_build_object('check', 'item', 'line', v_n, 'ok', false, 'text', 'Choose our item for this line');
      continue;
    end if;
    if c.order_id is not null then
      select round(sum(ol.taxable) / nullif(sum(ol.qty), 0), 2) into v_po_rate from purch.order_lines ol where ol.order_id = c.order_id and ol.product_id = (l ->> 'product_id')::uuid;
      select coalesce(sum(g.qty), 0) into v_recv from purch.grn_lines g join purch.goods_receipts r on r.id = g.grn_id
       where r.status = 'posted' and g.product_id = (l ->> 'product_id')::uuid and ((c.grn_id is not null and r.id = c.grn_id) or (c.grn_id is null and r.order_id = c.order_id));
      if v_po_rate is null then
        v_ok := false; v_checks := v_checks || jsonb_build_object('check', 'item', 'line', v_n, 'ok', false, 'text', 'This item is not on the order');
      else
        if abs(v_bill_rate - v_po_rate) > v_po_rate * v_rtol / 100 then
          v_ok := false; v_checks := v_checks || jsonb_build_object('check', 'rate', 'line', v_n, 'ok', false, 'bill', v_bill_rate, 'order', v_po_rate);
        else
          v_checks := v_checks || jsonb_build_object('check', 'rate', 'line', v_n, 'ok', true, 'bill', v_bill_rate, 'order', v_po_rate);
        end if;
        if abs(v_bill_qty - v_recv) > v_recv * v_qtol / 100 or v_recv = 0 then
          v_ok := false; v_checks := v_checks || jsonb_build_object('check', 'qty', 'line', v_n, 'ok', false, 'bill', v_bill_qty, 'received', v_recv);
        else
          v_checks := v_checks || jsonb_build_object('check', 'qty', 'line', v_n, 'ok', true, 'bill', v_bill_qty, 'received', v_recv);
        end if;
      end if;
    end if;
    v_last := app.last_rate(c.company_id, (l ->> 'product_id')::uuid, c.order_id);
    if v_last is not null and v_bill_rate > v_last then
      v_notes := v_notes || jsonb_build_object('code', 'price.increase', 'line', v_n, 'last_rate', v_last, 'bill_rate', v_bill_rate);
    end if;
  end loop;
  if v_n = 0 then v_ok := false; v_checks := v_checks || jsonb_build_object('check', 'lines', 'ok', false, 'text', 'No lines were read from the bill'); end if;
  -- Tax: worked out from the HSN table on the bill date (place of supply = supplier state), compared exactly with the bill.
  if v_n > 0 then
    select g.id, g.state_code into v_gstin, v_our from core.gstins g
     where g.company_id = c.company_id and g.status = 'active'
       and (g.id = (select gstin_id from purch.orders where id = c.order_id) or (c.order_id is null and g.is_principal)) limit 1;
    v_calc := app.compute_tax(v_our, coalesce(v_party.state_code, v_our), coalesce(nullif(v_ex ->> 'invoice_date', '')::date, current_date), false, v_ex -> 'lines');
    if (v_calc ->> 'cgst')::numeric <> coalesce((v_ex ->> 'cgst')::numeric, 0) or (v_calc ->> 'sgst')::numeric <> coalesce((v_ex ->> 'sgst')::numeric, 0)
       or (v_calc ->> 'igst')::numeric <> coalesce((v_ex ->> 'igst')::numeric, 0) or (v_calc ->> 'taxable')::numeric <> coalesce((v_ex ->> 'taxable')::numeric, 0) then
      v_ok := false; v_checks := v_checks || jsonb_build_object('check', 'tax', 'ok', false, 'expected', v_calc - 'lines' - 'amount_in_words',
                                                                'bill', jsonb_build_object('taxable', v_ex -> 'taxable', 'cgst', v_ex -> 'cgst', 'sgst', v_ex -> 'sgst', 'igst', v_ex -> 'igst'));
    else
      v_checks := v_checks || jsonb_build_object('check', 'tax', 'ok', true, 'text', case when (v_calc ->> 'intra_state')::boolean then 'CGST + SGST' else 'IGST' end || ' as the HSN table gives');
    end if;
  end if;
  update purch.bill_captures set status = case when v_ok then 'matched' else 'mismatch' end, matched_by = auth.uid(), matched_at = now(),
         match_result = jsonb_build_object('ok', v_ok, 'checks', v_checks, 'notes', v_notes, 'qty_tolerance_pct', v_qtol, 'rate_tolerance_pct', v_rtol)
   where id = c.id;
  v_res := jsonb_build_object('id', c.id, 'status', case when v_ok then 'matched' else 'mismatch' end, 'ok', v_ok, 'checks', v_checks, 'notes', v_notes);
  return app.request_done(p_client_request_id, 'match_bill_to_po_grn', v_res);
end $$;

-- Turn a matched capture into a Phase 3 purchase bill draft (posted with api.post_purchase_bill). A capture that did not
-- match (or has no order) can be drafted only by Admin, as a direct purchase. p_gstin_id: default the order's GSTIN or the principal one.
create or replace function api.capture_to_purchase_draft(p_client_request_id uuid, p_capture_id uuid, p_gstin_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; c purch.bill_captures; v_draft jsonb; v_gstin uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'capture_to_purchase_draft'); if v_prev is not null then return v_prev; end if;
  select * into c from purch.bill_captures where id = p_capture_id for update;
  if c.id is null then perform app.raise_rule('capture.missing', 'bill photo not found', 'P0002'); end if;
  perform app.require(c.company_id, 'purchase_bills.create');
  if c.status = 'mismatch' and not app.is_admin() then perform app.raise_rule('capture.needs_admin', 'the bill does not match the order and receipt; Admin must approve it', '42501'); end if;
  if c.status not in ('matched', 'mismatch') then perform app.raise_rule('capture.state', 'match the bill with the order and receipt first', '22023'); end if;
  v_gstin := coalesce(p_gstin_id, (select gstin_id from purch.orders where id = c.order_id),
                      (select id from core.gstins where company_id = c.company_id and is_principal and status = 'active' limit 1));
  v_draft := api.save_purchase_draft(gen_random_uuid(), jsonb_build_object('company_id', c.company_id, 'gstin_id', v_gstin, 'party_id', c.party_id,
               'supplier_bill_no', c.extracted ->> 'invoice_no', 'supplier_bill_date', c.extracted ->> 'invoice_date', 'bill_date', current_date,
               'lines', coalesce(c.extracted -> 'lines', '[]'::jsonb)));
  update purch.bills set order_id = c.order_id, grn_id = c.grn_id, capture_id = c.id where id = (v_draft ->> 'id')::uuid;
  update purch.bill_captures set status = 'drafted', bill_id = (v_draft ->> 'id')::uuid where id = c.id;
  v_res := jsonb_build_object('capture_id', c.id, 'bill_id', v_draft ->> 'id', 'totals', v_draft -> 'totals');
  return app.request_done(p_client_request_id, 'capture_to_purchase_draft', v_res);
end $$;

create or replace function api.reject_bill_capture(p_client_request_id uuid, p_capture_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; c purch.bill_captures;
begin
  v_prev := app.request_seen(p_client_request_id, 'reject_bill_capture'); if v_prev is not null then return v_prev; end if;
  select * into c from purch.bill_captures where id = p_capture_id for update;
  if c.id is null then perform app.raise_rule('capture.missing', 'bill photo not found', 'P0002'); end if;
  if not app.can(c.company_id, 'purchase.create') then perform app.require(c.company_id, 'purchase_bills.create'); end if;
  if c.status in ('drafted', 'posted') then perform app.raise_rule('capture.locked', 'this bill photo is already used', '22023'); end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'reason required', '22023'); end if;
  update purch.bill_captures set status = 'rejected', reject_reason = trim(p_reason) where id = c.id;
  v_res := jsonb_build_object('id', c.id, 'status', 'rejected');
  return app.request_done(p_client_request_id, 'reject_bill_capture', v_res);
end $$;

-- When a purchase bill posts: record its rates in the price history and mark its photo capture posted.
create or replace function app.on_purchase_bill_posted() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'posted' and old.status = 'draft' then
    insert into purch.price_history (company_id, product_id, party_id, rate, qty, uom, source, source_id, rate_date)
    select new.company_id, l.product_id, new.party_id, round(l.taxable / l.qty, 2), l.qty, l.uom, 'bill', new.id, new.supplier_bill_date
    from purch.bill_lines l where l.bill_id = new.id and l.product_id is not null;
    update purch.bill_captures set status = 'posted' where bill_id = new.id;
  end if;
  return new;
end $$;
create trigger purchase_bill_posted after update of status on purch.bills for each row execute function app.on_purchase_bill_posted();

-- ─────────── Payment advice ───────────
-- Same payment posting as Phase 3, plus the supplier payment advice outbox row (consented contact only) in the same transaction.
create or replace function api.post_payment(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_party master.parties; v_bills text; v_company_name text;
begin
  v_prev := app.request_seen(p_client_request_id, 'post_payment'); if v_prev is not null then return v_prev; end if;
  v_res := app.post_money(p_client_request_id, p, 'payment');
  select * into v_party from master.parties where id = nullif(p ->> 'party_id', '')::uuid;
  if v_party.id is not null and v_party.is_supplier then
    select string_agg(b.supplier_bill_no, ', ' order by b.supplier_bill_date, b.supplier_bill_no) into v_bills
    from acct.bill_allocations a join purch.bills b on b.id = a.against_id
    where a.voucher_id = (v_res ->> 'voucher_id')::uuid and a.against_kind = 'purchase_bill';
    select short_name into v_company_name from core.companies where id = (p ->> 'company_id')::uuid;
    perform app.enqueue_message(jsonb_build_object('company_id', p ->> 'company_id', 'event', 'purchase.payment_advice', 'template', 'payment_advice', 'party_id', v_party.id,
      'doc_type', 'acct.vouchers', 'doc_id', v_res ->> 'voucher_id', 'stage', 'payment_advice',
      'params', jsonb_build_object('supplier', v_party.legal_name, 'amount', round((p ->> 'amount')::numeric, 2), 'doc_no', v_res ->> 'doc_no',
                                   'bills', coalesce(v_bills, 'on account'), 'company', v_company_name)));
  end if;
  return app.request_done(p_client_request_id, 'post_payment', v_res);
end $$;

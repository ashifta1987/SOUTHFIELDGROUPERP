-- 20261103006000_sales_core.sql
-- Phase 6 data model: sales orders with credit control (7-stage applications, MD exceptions), dispatch, trips and
-- proof of delivery, vehicles, route sales (beats, duty sessions, GPS points, visits with a 150 m geofence,
-- collections, cash handovers, day closes, queries), customer care (coverage tiers, contact attempts, complaints with
-- QC hold on the lot, private label, agents and commission), own shops (shop days), exports (orders, containers,
-- export invoices), online channels (listings, orders), Schedule III mapping, WhatsApp cost caps, rates and tasks.
-- Additive only: new tables; widened checks (stock move types); new nullable columns on master.party_companies and
-- msg.inbound. RLS on every new table; writes only through api RPCs (next migrations).

create schema if not exists field;
revoke all on schema field from public, anon;
grant usage on schema field to authenticated;

-- ─────────── Shared widening (non-destructive) ───────────
alter table inv.stock_ledger drop constraint if exists stock_ledger_move_type_check;
alter table inv.stock_ledger add constraint stock_ledger_move_type_check check (move_type in (
  'opening', 'receipt', 'issue', 'issue_in', 'return', 'release', 'reject', 'adjustment', 'transit_out', 'transit_in', 'transfer_in',
  'transfer_return', 'write_off', 'scrap_in', 'regrind', 'scrap_sale', 'reversal', 'consumption', 'production_in',
  'dispatch', 'dispatch_return', 'sale', 'qc_hold', 'qc_release'));

-- Credit fields per customer and company (set only by the credit RPCs; upsert_party never touches them).
alter table master.party_companies add column if not exists credit_status text not null default 'none' check (credit_status in ('none', 'active', 'hold', 'review'));
alter table master.party_companies add column if not exists credit_review_on date;
alter table master.party_companies add column if not exists price_list_id uuid references master.price_lists (id);

alter table msg.inbound add column if not exists task_id uuid;

-- Non-GST internal numbers used by Phase 6.
insert into core.doc_types (key, label, gst_document, max_number_length, sort) values
  ('dispatch', 'Dispatch / delivery', false, 20, 40),
  ('trip', 'Trip', false, 20, 41),
  ('complaint', 'Complaint', false, 20, 42),
  ('export_order', 'Export order', false, 20, 43),
  ('credit_application', 'Credit application', false, 20, 44)
on conflict (key) do nothing;

-- Settings (business defaults stated in the prompt; Admin changes them on Settings; never legal thresholds).
insert into core.settings (company_id, key, value, effective_from, note) values
  (null, 'field.geofence_m', '150'::jsonb, '2026-04-01', '§15: check-in and check-out within 150 m of the shop pin'),
  (null, 'field.gps_retention_days', '90'::jsonb, '2026-04-01', '§15 / DPDP: GPS kept for 90 days'),
  (null, 'salesman_balance_scope', '"gst_only"'::jsonb, '2026-04-01', '§15A Q-12: (b) GST bills only until the owner decides'),
  (null, 'msg.reminder_days', '[-7, -3, 0, 3, 7, 14]'::jsonb, '2026-04-01', '§WA-3: reminders 7 and 3 days before, on, and 3/7/14 days after the due date');

-- ─────────── Sales orders and credit ───────────
create table sales.orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  gstin_id uuid not null references core.gstins (id),
  doc_no text,
  order_date date not null,
  delivery_date date,
  party_id uuid not null references master.parties (id),
  place_of_supply char(2) not null,
  channel text not null default 'direct' check (channel in ('direct', 'field', 'shop', 'online', 'export', 'private_label')),
  payment text not null default 'credit' check (payment in ('credit', 'cash', 'advance')),
  salesman_user_id uuid references auth.users (id),
  place_id uuid references core.places (id),
  price_list_id uuid references master.price_lists (id),
  buyer_po_no text,
  buyer_po_date date,
  notes text,
  taxable numeric(18, 2) not null default 0,
  cgst numeric(18, 2) not null default 0,
  sgst numeric(18, 2) not null default 0,
  igst numeric(18, 2) not null default 0,
  round_off numeric(18, 2) not null default 0,
  total numeric(18, 2) not null default 0,
  status text not null default 'confirmed' check (status in ('pending_credit', 'pending_approval', 'confirmed', 'part_dispatched', 'dispatched', 'closed', 'cancelled')),
  credit_check jsonb,
  credit_exception_id uuid,
  private_label_id uuid,
  export_order_id uuid,
  online_order_id uuid,
  created_by uuid references auth.users (id),
  confirmed_by uuid references auth.users (id),
  confirmed_at timestamptz,
  cancelled_by uuid references auth.users (id),
  cancelled_at timestamptz,
  cancel_reason text,
  device_created_at timestamptz,
  client_request_id uuid not null unique,
  created_at timestamptz not null default now(),
  unique (company_id, doc_no)
);
create index on sales.orders (company_id, order_date);
create index on sales.orders (party_id, status);

create table sales.order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references sales.orders (id),
  line_no int not null,
  product_id uuid not null references master.products (id),
  description text not null,
  hsn_code text,
  uom text not null,
  qty numeric(18, 3) not null check (qty > 0),
  rate numeric(18, 2) not null check (rate >= 0),
  discount numeric(18, 2) not null default 0 check (discount >= 0),
  taxable numeric(18, 2) not null default 0,
  gst_rate numeric(9, 4) not null default 0,
  cgst numeric(18, 2) not null default 0,
  sgst numeric(18, 2) not null default 0,
  igst numeric(18, 2) not null default 0,
  total numeric(18, 2) not null default 0,
  qty_dispatched numeric(18, 3) not null default 0,
  qty_delivered numeric(18, 3) not null default 0,
  qty_invoiced numeric(18, 3) not null default 0,
  unique (order_id, line_no),
  check (qty_dispatched <= qty and qty_invoiced <= qty)
);

-- Which posted GST documents bill an order (and which dispatch they travel with).
create table sales.order_documents (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references sales.orders (id),
  document_id uuid not null unique references sales.documents (id),
  dispatch_id uuid,
  linked_by uuid references auth.users (id),
  linked_at timestamptz not null default now()
);
create index on sales.order_documents (order_id);

create table sales.credit_applications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  doc_no text not null,
  party_id uuid not null references master.parties (id),
  requested_limit numeric(18, 2) not null check (requested_limit > 0),
  requested_term_id uuid references master.credit_terms (id),
  expected_monthly numeric(18, 2),
  security text,
  note text,
  stage int not null default 2 check (stage between 2 and 7),
  status text not null default 'in_progress' check (status in ('in_progress', 'active', 'rejected', 'withdrawn')),
  decided_limit numeric(18, 2),
  decided_term_id uuid references master.credit_terms (id),
  review_on date,
  reject_reason text,
  requested_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  unique (company_id, doc_no)
);
create index on sales.credit_applications (party_id);

-- One row per decided stage (append-only). Stage 3 sales manager, 4 finance file check, 5 finance head, 6 MD.
create table sales.credit_approvals (
  id bigint generated always as identity primary key,
  application_id uuid not null references sales.credit_applications (id),
  stage int not null check (stage between 3 and 6),
  decision text not null check (decision in ('approved', 'rejected')),
  limit_amount numeric(18, 2),
  term_id uuid references master.credit_terms (id),
  note text,
  decided_by uuid not null references auth.users (id),
  decided_at timestamptz not null default now(),
  unique (application_id, stage)
);

-- MD exception: time-limited extra credit, granted by someone other than the person who asked (logged).
create table sales.credit_exceptions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  party_id uuid not null references master.parties (id),
  order_id uuid references sales.orders (id),
  amount numeric(18, 2) not null check (amount > 0),
  valid_until timestamptz not null,
  reason text not null check (length(trim(reason)) >= 5),
  requested_by uuid references auth.users (id),
  granted_by uuid not null references auth.users (id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id),
  check (requested_by is null or granted_by <> requested_by),
  check (valid_until > granted_at)
);
create index on sales.credit_exceptions (company_id, party_id);

create table sales.promises_to_pay (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  party_id uuid not null references master.parties (id),
  amount numeric(18, 2) not null check (amount > 0),
  promised_on date not null,
  note text,
  status text not null default 'open' check (status in ('open', 'kept', 'broken')),
  recorded_by uuid references auth.users (id),
  client_request_id uuid unique,
  created_at timestamptz not null default now()
);
create index on sales.promises_to_pay (party_id);

-- ─────────── Vehicles ───────────
create table ops.vehicles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  reg_no text not null unique check (reg_no ~ '^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{1,4}$'),
  kind text not null check (kind in ('pickup', 'mini_truck', 'truck', 'trailer', 'crane_truck', 'van', 'two_wheeler', 'other')),
  ownership text not null default 'owned' check (ownership in ('owned', 'hired')),
  transporter text,
  payload_kg numeric(18, 3) check (payload_kg is null or payload_kg > 0),
  usual_driver_user_id uuid references auth.users (id),
  place_id uuid references core.places (id),
  status text not null default 'active' check (status in ('active', 'repair', 'inactive')),
  created_at timestamptz not null default now()
);
create index on ops.vehicles (company_id);

create table ops.vehicle_documents (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references ops.vehicles (id),
  kind text not null check (kind in ('rc', 'insurance', 'fitness', 'permit', 'puc', 'road_tax', 'fastag')),
  doc_no text,
  valid_to date,
  path text,
  set_by uuid references auth.users (id),
  set_at timestamptz not null default now()
);
create index on ops.vehicle_documents (vehicle_id, kind);

create table ops.vehicle_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references core.companies (id),
  vehicle_id uuid not null references ops.vehicles (id),
  kind text not null check (kind in ('fuel', 'repair', 'service', 'emi', 'insurance', 'tax', 'toll', 'parking', 'bata', 'loading', 'washing', 'tyre', 'accident', 'fine', 'other')),
  event_date date not null,
  odometer_km int check (odometer_km is null or odometer_km >= 0),
  litres numeric(18, 3),
  amount numeric(18, 2) check (amount is null or amount >= 0),
  trip_id uuid,
  paid_by text,
  note text,
  recorded_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index on ops.vehicle_events (vehicle_id, event_date);

-- ─────────── Dispatch, trips, proof of delivery ───────────
create table sales.dispatches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  doc_no text not null,
  order_id uuid not null references sales.orders (id),
  party_id uuid not null references master.parties (id),
  place_id uuid not null references core.places (id),
  scheduled_at timestamptz,
  status text not null default 'planned' check (status in ('planned', 'dispatched', 'delivered', 'part_delivered', 'failed', 'cancelled')),
  trip_id uuid,
  document_id uuid references sales.documents (id),
  eway_bill_no text,
  value numeric(18, 2) not null default 0,
  created_by uuid references auth.users (id),
  dispatched_at timestamptz,
  delivered_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  unique (company_id, doc_no)
);
create index on sales.dispatches (order_id);
create index on sales.dispatches (company_id, status);

create table sales.dispatch_lines (
  id uuid primary key default gen_random_uuid(),
  dispatch_id uuid not null references sales.dispatches (id),
  order_line_id uuid not null references sales.order_lines (id),
  product_id uuid not null references master.products (id),
  qty numeric(18, 3) not null check (qty > 0),
  qty_delivered numeric(18, 3) not null default 0,
  qty_returned numeric(18, 3) not null default 0,
  short_reason text check (short_reason is null or short_reason in ('damaged', 'rejected', 'short_loaded', 'not_available', 'other')),
  lots jsonb not null default '[]'::jsonb,
  check (qty_delivered + qty_returned <= qty)
);
create index on sales.dispatch_lines (dispatch_id);

create table sales.trips (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  doc_no text not null,
  trip_date date not null,
  vehicle_id uuid references ops.vehicles (id),
  driver_user_id uuid references auth.users (id),
  transporter text,
  lr_no text,
  status text not null default 'planned' check (status in ('planned', 'started', 'closed', 'cancelled')),
  odometer_start int,
  odometer_end int,
  created_by uuid references auth.users (id),
  started_by uuid references auth.users (id),
  started_at timestamptz,
  closed_by uuid references auth.users (id),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (company_id, doc_no),
  check (vehicle_id is not null or transporter is not null),
  check (odometer_end is null or odometer_start is null or odometer_end >= odometer_start)
);

create table sales.trip_stops (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references sales.trips (id),
  seq int not null,
  dispatch_id uuid not null unique references sales.dispatches (id),
  status text not null default 'pending' check (status in ('pending', 'arrived', 'delivered', 'part_delivered', 'failed')),
  arrived_at timestamptz,
  done_at timestamptz,
  fail_reason text,
  unique (trip_id, seq)
);

-- Proof of delivery: photos and signature in the private `pod` bucket (paths only). Append-only, except that the
-- GPS purge clears lat/lng after the retention period.
create table sales.pods (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  stop_id uuid not null unique references sales.trip_stops (id),
  dispatch_id uuid not null references sales.dispatches (id),
  received_by_name text not null check (length(trim(received_by_name)) >= 2),
  receiver_phone_last4 char(4) check (receiver_phone_last4 is null or receiver_phone_last4 ~ '^[0-9]{4}$'),
  signature_path text,
  photo_paths text[] not null default '{}',
  lat numeric(9, 6),
  lng numeric(9, 6),
  remarks text,
  device_at timestamptz,
  recorded_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  check (signature_path is not null or cardinality(photo_paths) > 0)
);

-- ─────────── Route sales ───────────
create table field.beats (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  code text not null,
  name text not null,
  salesman_user_id uuid references auth.users (id),
  weekday int check (weekday between 1 and 7),
  active boolean not null default true,
  unique (company_id, code)
);

create table field.beat_customers (
  beat_id uuid not null references field.beats (id),
  party_id uuid not null references master.parties (id),
  seq int not null default 0,
  primary key (beat_id, party_id)
);

-- On-duty window: GPS is recorded only inside an open session started after the notice was acknowledged (DPDP).
create table field.duty_sessions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  user_id uuid not null references auth.users (id),
  kind text not null default 'salesman' check (kind in ('salesman', 'driver')),
  notice_ack_at timestamptz not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  client_request_id uuid unique,
  check (ended_at is null or ended_at >= started_at)
);
create unique index duty_one_open on field.duty_sessions (user_id) where ended_at is null;

-- GPS points (deleted after the retention period by app.purge_gps).
create table field.gps_points (
  id bigint generated always as identity primary key,
  company_id uuid not null references core.companies (id),
  user_id uuid not null references auth.users (id),
  session_id uuid not null references field.duty_sessions (id),
  at timestamptz not null,
  lat numeric(9, 6) not null check (lat between -90 and 90),
  lng numeric(9, 6) not null check (lng between -180 and 180),
  accuracy_m numeric(9, 2),
  source text not null default 'ping' check (source in ('ping', 'check_in', 'check_out', 'pod')),
  created_at timestamptz not null default now()
);
create index on field.gps_points (at);
create index on field.gps_points (user_id, at);

create table field.visits (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  salesman_user_id uuid not null references auth.users (id),
  party_id uuid not null references master.parties (id),
  beat_id uuid references field.beats (id),
  session_id uuid references field.duty_sessions (id),
  planned boolean not null default true,
  unplanned_reason text,
  check_in_at timestamptz not null,
  check_in_lat numeric(9, 6),
  check_in_lng numeric(9, 6),
  distance_m numeric(12, 1),
  geofence_ok boolean not null,
  out_of_fence_reason text,
  approval text not null default 'none' check (approval in ('none', 'pending', 'approved', 'refused')),
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  check_out_at timestamptz,
  check_out_lat numeric(9, 6),
  check_out_lng numeric(9, 6),
  check_out_distance_m numeric(12, 1),
  outcome text check (outcome in ('order', 'no_order', 'collection', 'follow_up')),
  no_order_reason text,
  shelf jsonb,
  competitor_notes text,
  photo_paths text[] not null default '{}',
  next_visit_on date,
  client_request_id uuid unique,
  created_at timestamptz not null default now(),
  check (approved_by is null or approved_by <> salesman_user_id),
  check (geofence_ok or length(trim(coalesce(out_of_fence_reason, ''))) >= 3)
);
create index on field.visits (salesman_user_id, check_in_at);
create index on field.visits (party_id);

create table field.cash_handovers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  salesman_user_id uuid not null references auth.users (id),
  cashier_user_id uuid references auth.users (id),
  handover_date date not null,
  expected_cash numeric(18, 2) not null,
  salesman_count jsonb not null,
  salesman_total numeric(18, 2) not null,
  cashier_count jsonb,
  cashier_total numeric(18, 2),
  cheques int not null default 0,
  difference numeric(18, 2),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'mismatch', 'resolved')),
  to_account_id uuid references acct.accounts (id),
  contra_voucher_id uuid references acct.vouchers (id),
  bug_item_id uuid,
  resolved_by uuid references auth.users (id),
  resolution_note text,
  client_request_id uuid unique,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  check (cashier_user_id is null or cashier_user_id <> salesman_user_id),
  check (resolved_by is null or resolved_by <> salesman_user_id)
);
create index on field.cash_handovers (salesman_user_id, handover_date);

create table field.collections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  salesman_user_id uuid not null references auth.users (id),
  party_id uuid not null references master.parties (id),
  voucher_id uuid not null references acct.vouchers (id),
  amount numeric(18, 2) not null check (amount > 0),
  mode text not null check (mode in ('cash', 'cheque', 'upi', 'bank')),
  reference text,
  cheque_photo_path text,
  handover_id uuid references field.cash_handovers (id),
  visit_id uuid references field.visits (id),
  collected_at timestamptz not null default now(),
  client_request_id uuid not null unique,
  check (mode <> 'cheque' or cheque_photo_path is not null)
);
create index on field.collections (salesman_user_id, collected_at);

create table field.day_closes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  user_id uuid not null references auth.users (id),
  close_date date not null,
  session_id uuid references field.duty_sessions (id),
  visits_planned int not null default 0,
  visits_done int not null default 0,
  orders_total numeric(18, 2) not null default 0,
  collections_total numeric(18, 2) not null default 0,
  handover_id uuid references field.cash_handovers (id),
  van_counts jsonb,
  closed_at timestamptz not null default now(),
  unique (company_id, user_id, close_date)
);

create table field.queries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  party_id uuid not null references master.parties (id),
  kind text not null check (kind in ('product_complaint', 'billing', 'delivery', 'price_scheme', 'return', 'other')),
  document_id uuid references sales.documents (id),
  lot_id uuid references inv.lots (id),
  description text not null check (length(trim(description)) >= 3),
  photo_paths text[] not null default '{}',
  status text not null default 'open' check (status in ('open', 'in_progress', 'answered', 'closed')),
  raised_by uuid references auth.users (id),
  assigned_to uuid references auth.users (id),
  next_step text,
  reply text,
  complaint_id uuid,
  client_request_id uuid unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on field.queries (party_id, status);

-- ─────────── Customer care ───────────
create table sales.coverage_tiers (
  company_id uuid not null references core.companies (id),
  tier text not null,
  call_every_days int check (call_every_days is null or call_every_days > 0),
  visit_every_days int check (visit_every_days is null or visit_every_days > 0),
  grace_days int not null default 0 check (grace_days >= 0),
  set_by uuid references auth.users (id),
  set_at timestamptz not null default now(),
  primary key (company_id, tier)
);

create table sales.contact_attempts (
  id bigint generated always as identity primary key,
  company_id uuid not null references core.companies (id),
  party_id uuid not null references master.parties (id),
  kind text not null check (kind in ('call', 'visit')),
  outcome text not null check (outcome in ('reached', 'no_answer', 'deferred')),
  note text,
  next_action text,
  visit_id uuid references field.visits (id),
  by_user uuid references auth.users (id),
  at timestamptz not null default now()
);
create index on sales.contact_attempts (party_id, at);

create table sales.complaints (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  doc_no text not null,
  party_id uuid not null references master.parties (id),
  document_id uuid references sales.documents (id),
  product_id uuid references master.products (id),
  lot_id uuid references inv.lots (id),
  kind text not null default 'product' check (kind in ('product', 'billing', 'delivery', 'price_scheme', 'return', 'other')),
  description text not null,
  severity text not null default 'medium' check (severity in ('high', 'medium', 'low')),
  status text not null default 'logged' check (status in ('logged', 'investigating', 'on_hold', 'resolved', 'closed', 'rejected')),
  logged_by uuid not null references auth.users (id),
  assigned_to uuid references auth.users (id),
  qc_hold_id uuid,
  resolution text,
  closed_by uuid references auth.users (id),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (company_id, doc_no),
  check (closed_by is null or closed_by <> logged_by)
);
create index on sales.complaints (party_id);

create table sales.complaint_events (
  id bigint generated always as identity primary key,
  complaint_id uuid not null references sales.complaints (id),
  from_status text,
  to_status text not null,
  note text,
  by_user uuid references auth.users (id),
  at timestamptz not null default now()
);

-- QC hold of a lot everywhere (stock moved from available to hold at every place).
create table inv.qc_holds (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  lot_id uuid not null references inv.lots (id),
  complaint_id uuid references sales.complaints (id),
  reason text not null check (length(trim(reason)) >= 5),
  status text not null default 'on_hold' check (status in ('on_hold', 'released', 'rejected')),
  qty_held numeric(18, 3) not null default 0,
  previous_lot_status text not null,
  held_by uuid not null references auth.users (id),
  held_at timestamptz not null default now(),
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  decision_note text
);
create unique index qc_hold_one_open on inv.qc_holds (lot_id) where status = 'on_hold';

create table sales.private_label_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  party_id uuid not null references master.parties (id),
  brand_name text not null,
  spec jsonb not null default '{}'::jsonb,
  artwork_path text,
  status text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected')),
  created_by uuid not null references auth.users (id),
  sales_approved_by uuid references auth.users (id),
  quality_approved_by uuid references auth.users (id),
  md_approved_by uuid references auth.users (id),
  rejected_by uuid references auth.users (id),
  reject_reason text,
  created_at timestamptz not null default now(),
  check (sales_approved_by is null or sales_approved_by <> created_by),
  check (quality_approved_by is null or quality_approved_by <> created_by),
  check (md_approved_by is null or md_approved_by <> created_by)
);

create table sales.agents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  party_id uuid not null references master.parties (id),
  model text not null default 'A' check (model in ('A', 'B', 'C', 'D')),
  commission_pct numeric(9, 4) not null check (commission_pct >= 0 and commission_pct <= 100),
  status text not null default 'active' check (status in ('active', 'inactive')),
  unique (company_id, party_id)
);

create table sales.agent_customers (
  agent_id uuid not null references sales.agents (id),
  party_id uuid not null references master.parties (id),
  from_date date not null default current_date,
  primary key (agent_id, party_id)
);

create table sales.agent_commissions (
  id bigint generated always as identity primary key,
  company_id uuid not null references core.companies (id),
  agent_id uuid not null references sales.agents (id),
  voucher_id uuid not null references acct.vouchers (id),
  document_id uuid not null references sales.documents (id),
  collected numeric(18, 2) not null,
  commission numeric(18, 2) not null,
  period_from date not null,
  period_to date not null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (agent_id, voucher_id, document_id)
);

-- ─────────── Own shops ───────────
create table sales.shops (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  branch_id uuid not null unique references core.branches (id),
  place_id uuid not null references core.places (id),
  walk_in_party_id uuid references master.parties (id),
  cash_account_id uuid references acct.accounts (id),
  bank_account_id uuid references acct.accounts (id),
  price_list_id uuid references master.price_lists (id),
  active boolean not null default true
);

create table sales.shop_days (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  shop_id uuid not null references sales.shops (id),
  day date not null,
  expected_cash numeric(18, 2) not null,
  counted jsonb not null,
  counted_cash numeric(18, 2) not null,
  upi_total numeric(18, 2) not null default 0,
  card_total numeric(18, 2) not null default 0,
  bills int not null default 0,
  difference numeric(18, 2) not null,
  status text not null check (status in ('closed', 'mismatch')),
  bug_item_id uuid,
  closed_by uuid references auth.users (id),
  closed_at timestamptz not null default now(),
  unique (shop_id, day)
);

-- ─────────── Exports ───────────
create table sales.export_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  doc_no text not null,
  party_id uuid not null references master.parties (id),
  order_date date not null,
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  fx_rate numeric(12, 4) not null check (fx_rate > 0),
  incoterm text check (incoterm is null or incoterm in ('EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP')),
  port_of_loading text,
  destination text,
  lut_ref text,
  lut_valid_to date,
  lines jsonb not null default '[]'::jsonb,
  status text not null default 'confirmed' check (status in ('confirmed', 'shipped', 'closed', 'cancelled')),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (company_id, doc_no)
);

create table sales.containers (
  id uuid primary key default gen_random_uuid(),
  export_order_id uuid not null references sales.export_orders (id),
  container_no text not null check (container_no ~ '^[A-Z]{4}[0-9]{7}$'),
  seal_no text,
  packing_list jsonb not null default '[]'::jsonb,
  loaded jsonb,
  check_status text not null default 'pending' check (check_status in ('pending', 'matches', 'mismatch')),
  check_result jsonb,
  checked_by uuid references auth.users (id),
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (export_order_id, container_no)
);

create table sales.export_invoices (
  document_id uuid primary key references sales.documents (id),
  export_order_id uuid not null references sales.export_orders (id),
  currency char(3) not null,
  fx_rate numeric(12, 4) not null,
  value_fc numeric(18, 2) not null,
  lut boolean not null,
  shipping_bill_no text,
  shipping_bill_date date,
  port_code text,
  created_at timestamptz not null default now()
);

-- ─────────── Online channels ───────────
create table sales.online_channels (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  code text not null check (code in ('shopify', 'amazon', 'flipkart', 'jiomart', 'meesho')),
  gstin_id uuid not null references core.gstins (id),
  party_id uuid not null references master.parties (id),
  place_id uuid references core.places (id),
  tcs_applicable boolean not null default false,
  status text not null default 'not_connected' check (status in ('not_connected', 'active', 'paused')),
  unique (company_id, code)
);

create table sales.listings (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references sales.online_channels (id),
  product_id uuid not null references master.products (id),
  title text,
  price numeric(18, 2) check (price is null or price > 0),
  status text not null default 'draft' check (status in ('draft', 'listed', 'paused')),
  blockers text[] not null default '{}',
  published_by uuid references auth.users (id),
  published_at timestamptz,
  unique (channel_id, product_id)
);

create table sales.online_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  channel_id uuid not null references sales.online_channels (id),
  external_order_id text not null,
  order_date date not null,
  ship_state char(2) not null,
  payload jsonb not null,
  order_id uuid references sales.orders (id),
  status text not null default 'ingested' check (status in ('ingested', 'cancelled')),
  created_at timestamptz not null default now(),
  unique (channel_id, external_order_id)
);

-- ─────────── Schedule III ───────────
create table acct.schedule3_lines (
  code text primary key,
  statement text not null check (statement in ('bs', 'pl')),
  side text check (side in ('equity_liabilities', 'assets')),
  section text not null,
  label text not null,
  note_ref text,
  sort int not null
);

-- Account group → Schedule III line, per company. Admin sets it; the CA's confirmation is recorded (Q-P6-4).
create table acct.schedule3_map (
  account_group_id uuid primary key references acct.account_groups (id),
  company_id uuid not null references core.companies (id),
  line_code text not null references acct.schedule3_lines (code),
  set_by uuid references auth.users (id),
  set_at timestamptz not null default now(),
  ca_confirmed boolean not null default false,
  ca_note text,
  confirmed_by uuid references auth.users (id),
  confirmed_at timestamptz
);
create index on acct.schedule3_map (company_id);

-- Schedule III, Division I line items (the statute's structure, not figures).
insert into acct.schedule3_lines (code, statement, side, section, label, sort) values
  ('share_capital', 'bs', 'equity_liabilities', 'Shareholders'' funds', 'Share capital', 10),
  ('reserves_surplus', 'bs', 'equity_liabilities', 'Shareholders'' funds', 'Reserves and surplus', 11),
  ('share_application_money', 'bs', 'equity_liabilities', 'Share application money pending allotment', 'Share application money pending allotment', 12),
  ('long_term_borrowings', 'bs', 'equity_liabilities', 'Non-current liabilities', 'Long-term borrowings', 20),
  ('deferred_tax_liabilities', 'bs', 'equity_liabilities', 'Non-current liabilities', 'Deferred tax liabilities (net)', 21),
  ('other_long_term_liabilities', 'bs', 'equity_liabilities', 'Non-current liabilities', 'Other long-term liabilities', 22),
  ('long_term_provisions', 'bs', 'equity_liabilities', 'Non-current liabilities', 'Long-term provisions', 23),
  ('short_term_borrowings', 'bs', 'equity_liabilities', 'Current liabilities', 'Short-term borrowings', 30),
  ('trade_payables', 'bs', 'equity_liabilities', 'Current liabilities', 'Trade payables', 31),
  ('other_current_liabilities', 'bs', 'equity_liabilities', 'Current liabilities', 'Other current liabilities', 32),
  ('short_term_provisions', 'bs', 'equity_liabilities', 'Current liabilities', 'Short-term provisions', 33),
  ('ppe', 'bs', 'assets', 'Non-current assets', 'Property, plant and equipment', 50),
  ('intangible_assets', 'bs', 'assets', 'Non-current assets', 'Intangible assets', 51),
  ('cwip', 'bs', 'assets', 'Non-current assets', 'Capital work-in-progress', 52),
  ('non_current_investments', 'bs', 'assets', 'Non-current assets', 'Non-current investments', 53),
  ('deferred_tax_assets', 'bs', 'assets', 'Non-current assets', 'Deferred tax assets (net)', 54),
  ('long_term_loans_advances', 'bs', 'assets', 'Non-current assets', 'Long-term loans and advances', 55),
  ('other_non_current_assets', 'bs', 'assets', 'Non-current assets', 'Other non-current assets', 56),
  ('current_investments', 'bs', 'assets', 'Current assets', 'Current investments', 60),
  ('inventories', 'bs', 'assets', 'Current assets', 'Inventories', 61),
  ('trade_receivables', 'bs', 'assets', 'Current assets', 'Trade receivables', 62),
  ('cash_equivalents', 'bs', 'assets', 'Current assets', 'Cash and cash equivalents', 63),
  ('short_term_loans_advances', 'bs', 'assets', 'Current assets', 'Short-term loans and advances', 64),
  ('other_current_assets', 'bs', 'assets', 'Current assets', 'Other current assets', 65),
  ('revenue_operations', 'pl', null, 'Income', 'Revenue from operations', 100),
  ('other_income', 'pl', null, 'Income', 'Other income', 101),
  ('cost_materials', 'pl', null, 'Expenses', 'Cost of materials consumed', 110),
  ('purchases_stock_in_trade', 'pl', null, 'Expenses', 'Purchases of stock-in-trade', 111),
  ('changes_in_inventories', 'pl', null, 'Expenses', 'Changes in inventories of finished goods, work-in-progress and stock-in-trade', 112),
  ('employee_benefits', 'pl', null, 'Expenses', 'Employee benefits expense', 113),
  ('finance_costs', 'pl', null, 'Expenses', 'Finance costs', 114),
  ('depreciation', 'pl', null, 'Expenses', 'Depreciation and amortisation expense', 115),
  ('other_expenses', 'pl', null, 'Expenses', 'Other expenses', 116),
  ('exceptional_items', 'pl', null, 'Exceptional and extraordinary items', 'Exceptional and extraordinary items', 120),
  ('tax_expense', 'pl', null, 'Tax expense', 'Tax expense (current and deferred)', 130)
on conflict (code) do nothing;

-- ─────────── WhatsApp: cost caps, rates, tasks ───────────
create table msg.cost_caps (
  company_id uuid primary key references core.companies (id),
  monthly_cap numeric(18, 2) not null check (monthly_cap >= 0),
  alert_pct numeric(9, 4) not null default 80 check (alert_pct > 0 and alert_pct <= 100),
  set_by uuid references auth.users (id),
  set_at timestamptz not null default now()
);

-- Estimated cost per message by category (Admin enters the provider's price; never invented).
create table msg.message_rates (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('utility', 'marketing', 'authentication', 'service')),
  est_cost numeric(18, 4) not null check (est_cost >= 0),
  effective_from date not null,
  set_by uuid references auth.users (id),
  set_at timestamptz not null default now(),
  unique (category, effective_from)
);

create table msg.cost_alerts (
  company_id uuid not null references core.companies (id),
  month date not null,
  level text not null check (level in ('alert', 'cap')),
  created_at timestamptz not null default now(),
  primary key (company_id, month, level)
);

-- Tasks raised by the inbox (payment proof pending, reply needed). Finance and the customer's salesperson act on them.
create table msg.tasks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references core.companies (id),
  kind text not null check (kind in ('payment_proof', 'reply_needed', 'send_failed')),
  party_id uuid references master.parties (id),
  inbound_id uuid references msg.inbound (id),
  priority text not null default 'normal' check (priority in ('urgent', 'normal')),
  status text not null default 'open' check (status in ('open', 'done', 'dismissed')),
  due_at timestamptz,
  assigned_user_id uuid references auth.users (id),
  note text,
  resolved_by uuid references auth.users (id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index on msg.tasks (company_id, status);
create index on msg.tasks (party_id, kind, status);

-- ─────────── Append-only guards ───────────
-- GPS-bearing append-only rows: only the retention purge (app.gps_purge = on) may clear coordinates.
create or replace function app.reject_change_except_purge() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and current_setting('app.gps_purge', true) = 'on' then return new; end if;
  raise exception '% is append-only', tg_table_schema || '.' || tg_table_name using errcode = 'P0001', hint = 'history.append_only';
end $$;

create trigger credit_approvals_append_only before update or delete on sales.credit_approvals for each row execute function app.reject_change();
create trigger vehicle_events_append_only before update or delete on ops.vehicle_events for each row execute function app.reject_change();
create trigger complaint_events_append_only before update or delete on sales.complaint_events for each row execute function app.reject_change();
create trigger contact_attempts_append_only before update or delete on sales.contact_attempts for each row execute function app.reject_change();
create trigger agent_commissions_append_only before update or delete on sales.agent_commissions for each row execute function app.reject_change();
create trigger pods_append_only before update or delete on sales.pods for each row execute function app.reject_change_except_purge();
create trigger orders_no_delete before delete on sales.orders for each row execute function app.reject_change();
create trigger dispatches_no_delete before delete on sales.dispatches for each row execute function app.reject_change();
create trigger collections_no_delete before delete on field.collections for each row execute function app.reject_change();
create trigger handovers_no_delete before delete on field.cash_handovers for each row execute function app.reject_change();

-- ─────────── History and RLS ───────────
do $$
declare t text;
begin
  foreach t in array array[
    'sales.orders', 'sales.order_lines', 'sales.order_documents', 'sales.credit_applications', 'sales.credit_exceptions', 'sales.promises_to_pay',
    'ops.vehicles', 'ops.vehicle_documents', 'sales.dispatches', 'sales.dispatch_lines', 'sales.trips', 'sales.trip_stops', 'sales.pods',
    'field.beats', 'field.beat_customers', 'field.duty_sessions', 'field.visits', 'field.cash_handovers', 'field.collections', 'field.day_closes', 'field.queries',
    'sales.coverage_tiers', 'sales.complaints', 'inv.qc_holds', 'sales.private_label_orders', 'sales.agents', 'sales.agent_customers',
    'sales.shops', 'sales.shop_days', 'sales.export_orders', 'sales.containers', 'sales.export_invoices', 'sales.online_channels', 'sales.listings', 'sales.online_orders',
    'acct.schedule3_map', 'msg.cost_caps', 'msg.message_rates', 'msg.tasks'
  ] loop
    execute format('create trigger audit_row after insert or update or delete on %s for each row execute function app.audit_trigger()', t);
  end loop;
  foreach t in array array[
    'sales.orders', 'sales.order_lines', 'sales.order_documents', 'sales.credit_applications', 'sales.credit_approvals', 'sales.credit_exceptions', 'sales.promises_to_pay',
    'ops.vehicles', 'ops.vehicle_documents', 'ops.vehicle_events', 'sales.dispatches', 'sales.dispatch_lines', 'sales.trips', 'sales.trip_stops', 'sales.pods',
    'field.beats', 'field.beat_customers', 'field.duty_sessions', 'field.gps_points', 'field.visits', 'field.cash_handovers', 'field.collections', 'field.day_closes', 'field.queries',
    'sales.coverage_tiers', 'sales.contact_attempts', 'sales.complaints', 'sales.complaint_events', 'inv.qc_holds', 'sales.private_label_orders', 'sales.agents',
    'sales.agent_customers', 'sales.agent_commissions', 'sales.shops', 'sales.shop_days', 'sales.export_orders', 'sales.containers', 'sales.export_invoices',
    'sales.online_channels', 'sales.listings', 'sales.online_orders', 'acct.schedule3_lines', 'acct.schedule3_map',
    'msg.cost_caps', 'msg.message_rates', 'msg.cost_alerts', 'msg.tasks'
  ] loop
    execute format('alter table %s enable row level security', t);
    execute format('revoke all on %s from anon, authenticated', t);
    execute format('grant select on %s to authenticated', t);
  end loop;
end $$;

-- The salesman assigned to a customer in a company (party_companies.salesman_user_id).
create or replace function app.is_my_customer(p_company uuid, p_party uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from master.party_companies pc where pc.company_id = p_company and pc.party_id = p_party and pc.salesman_user_id = auth.uid() and pc.active)
$$;

-- Sales-side readers: office (sales.view), finance (accounts.view), or the assigned salesman (field.sell).
create or replace function app.can_sales_party(p_company uuid, p_party uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.can(p_company, 'sales.view') or app.can(p_company, 'accounts.view') or (app.can(p_company, 'field.sell') and app.is_my_customer(p_company, p_party))
$$;

create policy orders_read on sales.orders for select to authenticated using (app.can_sales_party(company_id, party_id) or salesman_user_id = (select auth.uid()));
create policy order_lines_read on sales.order_lines for select to authenticated
  using (exists (select 1 from sales.orders o where o.id = order_id and (app.can_sales_party(o.company_id, o.party_id) or o.salesman_user_id = (select auth.uid()))));
create policy order_docs_read on sales.order_documents for select to authenticated
  using (exists (select 1 from sales.orders o where o.id = order_id and app.can_sales_party(o.company_id, o.party_id)));
create policy credit_apps_read on sales.credit_applications for select to authenticated
  using (app.can(company_id, 'sales.view') or app.can(company_id, 'accounts.view') or requested_by = (select auth.uid()));
create policy credit_approvals_read on sales.credit_approvals for select to authenticated
  using (exists (select 1 from sales.credit_applications a where a.id = application_id and (app.can(a.company_id, 'sales.view') or app.can(a.company_id, 'accounts.view') or a.requested_by = (select auth.uid()))));
create policy credit_exc_read on sales.credit_exceptions for select to authenticated using (app.can(company_id, 'sales.view') or app.can(company_id, 'accounts.view'));
create policy promises_read on sales.promises_to_pay for select to authenticated using (app.can_sales_party(company_id, party_id));

create policy vehicles_read on ops.vehicles for select to authenticated using (app.can(company_id, 'logistics.view') or usual_driver_user_id = (select auth.uid()));
create policy vehicle_docs_read on ops.vehicle_documents for select to authenticated
  using (exists (select 1 from ops.vehicles v where v.id = vehicle_id and app.can(v.company_id, 'logistics.view')));
create policy vehicle_events_read on ops.vehicle_events for select to authenticated using (app.can(company_id, 'logistics.view'));
create policy dispatches_read on sales.dispatches for select to authenticated
  using (app.can(company_id, 'logistics.view') or app.can_sales_party(company_id, party_id)
         or exists (select 1 from sales.trips t where t.id = trip_id and t.driver_user_id = (select auth.uid())));
create policy dispatch_lines_read on sales.dispatch_lines for select to authenticated
  using (exists (select 1 from sales.dispatches d where d.id = dispatch_id and (app.can(d.company_id, 'logistics.view') or app.can_sales_party(d.company_id, d.party_id)
         or exists (select 1 from sales.trips t where t.id = d.trip_id and t.driver_user_id = (select auth.uid())))));
create policy trips_read on sales.trips for select to authenticated using (app.can(company_id, 'logistics.view') or driver_user_id = (select auth.uid()));
create policy stops_read on sales.trip_stops for select to authenticated
  using (exists (select 1 from sales.trips t where t.id = trip_id and (app.can(t.company_id, 'logistics.view') or t.driver_user_id = (select auth.uid()))));
create policy pods_read on sales.pods for select to authenticated using (app.can(company_id, 'logistics.view') or app.can(company_id, 'sales.view') or recorded_by = (select auth.uid()));

create policy beats_read on field.beats for select to authenticated using (app.can(company_id, 'field.manage') or app.can(company_id, 'sales.view') or salesman_user_id = (select auth.uid()));
create policy beat_customers_read on field.beat_customers for select to authenticated
  using (exists (select 1 from field.beats b where b.id = beat_id and (app.can(b.company_id, 'field.manage') or app.can(b.company_id, 'sales.view') or b.salesman_user_id = (select auth.uid()))));
create policy duty_read on field.duty_sessions for select to authenticated using (user_id = (select auth.uid()) or app.can(company_id, 'field.manage'));
create policy gps_read on field.gps_points for select to authenticated using (user_id = (select auth.uid()) or app.can(company_id, 'field.manage'));
create policy visits_read on field.visits for select to authenticated using (salesman_user_id = (select auth.uid()) or app.can(company_id, 'field.manage') or app.can(company_id, 'sales.view'));
create policy handovers_read on field.cash_handovers for select to authenticated
  using (salesman_user_id = (select auth.uid()) or cashier_user_id = (select auth.uid()) or app.can(company_id, 'field.manage') or app.can(company_id, 'cash_book.view'));
create policy collections_read on field.collections for select to authenticated
  using (salesman_user_id = (select auth.uid()) or app.can(company_id, 'field.manage') or app.can(company_id, 'cash_book.view') or app.can(company_id, 'accounts.view'));
create policy day_closes_read on field.day_closes for select to authenticated using (user_id = (select auth.uid()) or app.can(company_id, 'field.manage'));
create policy queries_read on field.queries for select to authenticated using (app.can_sales_party(company_id, party_id) or raised_by = (select auth.uid()));

create policy tiers_read on sales.coverage_tiers for select to authenticated using (app.can_read_company(company_id));
create policy attempts_read on sales.contact_attempts for select to authenticated using (app.can_sales_party(company_id, party_id));
create policy complaints_read on sales.complaints for select to authenticated
  using (app.can_sales_party(company_id, party_id) or app.can(company_id, 'qc.release') or app.can(company_id, 'qc.test') or logged_by = (select auth.uid()));
create policy complaint_events_read on sales.complaint_events for select to authenticated
  using (exists (select 1 from sales.complaints c where c.id = complaint_id and (app.can_sales_party(c.company_id, c.party_id) or app.can(c.company_id, 'qc.release')
         or app.can(c.company_id, 'qc.test') or c.logged_by = (select auth.uid()))));
create policy qc_holds_read on inv.qc_holds for select to authenticated
  using (app.can(company_id, 'inventory.view') or app.can(company_id, 'qc.release') or app.can(company_id, 'qc.test') or app.can(company_id, 'sales.view'));
create policy private_label_read on sales.private_label_orders for select to authenticated using (app.can(company_id, 'sales.view') or app.can(company_id, 'qc.release'));
create policy agents_read on sales.agents for select to authenticated using (app.can(company_id, 'sales.view') or app.can(company_id, 'accounts.view'));
create policy agent_customers_read on sales.agent_customers for select to authenticated
  using (exists (select 1 from sales.agents a where a.id = agent_id and (app.can(a.company_id, 'sales.view') or app.can(a.company_id, 'accounts.view'))));
create policy agent_comm_read on sales.agent_commissions for select to authenticated using (app.can(company_id, 'sales.view') or app.can(company_id, 'accounts.view'));

create policy shops_read on sales.shops for select to authenticated using (app.can(company_id, 'shop.operate') or app.can(company_id, 'sales.view'));
create policy shop_days_read on sales.shop_days for select to authenticated using (app.can(company_id, 'shop.operate') or app.can(company_id, 'sales.view') or app.can(company_id, 'cash_book.view'));

create policy export_orders_read on sales.export_orders for select to authenticated using (app.can(company_id, 'exports.view'));
create policy containers_read on sales.containers for select to authenticated
  using (exists (select 1 from sales.export_orders e where e.id = export_order_id and app.can(e.company_id, 'exports.view')));
create policy export_invoices_read on sales.export_invoices for select to authenticated
  using (exists (select 1 from sales.export_orders e where e.id = export_order_id and app.can(e.company_id, 'exports.view'))
         and exists (select 1 from sales.documents d where d.id = document_id and app.can_see_bill_class(d.tax_class)));

create policy channels_read on sales.online_channels for select to authenticated using (app.can(company_id, 'sales.view'));
create policy listings_read on sales.listings for select to authenticated
  using (exists (select 1 from sales.online_channels c where c.id = channel_id and app.can(c.company_id, 'sales.view')));
create policy online_orders_read on sales.online_orders for select to authenticated using (app.can(company_id, 'sales.view'));

create policy s3_lines_read on acct.schedule3_lines for select to authenticated using (true);
create policy s3_map_read on acct.schedule3_map for select to authenticated using (app.can(company_id, 'reports.view') or app.can(company_id, 'accounts.view'));

create policy cost_caps_read on msg.cost_caps for select to authenticated using (app.is_admin() or app.current_view() = 'all-readonly');
create policy msg_rates_read on msg.message_rates for select to authenticated using (app.is_admin() or app.current_view() = 'all-readonly');
create policy cost_alerts_read on msg.cost_alerts for select to authenticated using (app.is_admin());
create policy msg_tasks_read on msg.tasks for select to authenticated
  using (app.is_admin() or (company_id is not null and app.can(company_id, 'accounts.view')) or assigned_user_id = (select auth.uid()));

-- ─────────── Storage: proof of delivery and field photos (private, company folder first) ───────────
insert into storage.buckets (id, name, public, file_size_limit) values ('pod', 'pod', false, 10485760), ('field', 'field', false, 10485760) on conflict (id) do nothing;
create policy pod_read on storage.objects for select to authenticated
  using (bucket_id = 'pod' and app.storage_company(name) is not null
         and (app.can(app.storage_company(name), 'logistics.view') or app.can(app.storage_company(name), 'sales.view') or owner = (select auth.uid())));
create policy pod_write on storage.objects for insert to authenticated
  with check (bucket_id = 'pod' and app.storage_company(name) is not null
              and (app.can(app.storage_company(name), 'trip.drive') or app.can(app.storage_company(name), 'logistics.edit')));
create policy field_read on storage.objects for select to authenticated
  using (bucket_id = 'field' and app.storage_company(name) is not null
         and (app.can(app.storage_company(name), 'field.manage') or app.can(app.storage_company(name), 'sales.view') or owner = (select auth.uid())));
create policy field_write on storage.objects for insert to authenticated
  with check (bucket_id = 'field' and app.storage_company(name) is not null
              and (app.can(app.storage_company(name), 'field.sell') or app.can(app.storage_company(name), 'sales.create')));

-- ─────────── Rights (configuration seed, Phase 1 pattern) ───────────
insert into core.rights (key, module, action, label, sort) values
  ('field.sell', 'field', 'sell', 'Salesman app · own customers, visits, orders, collections', 180),
  ('field.manage', 'field', 'manage', 'Route sales · beats, approvals, every salesman''s day', 181),
  ('trip.drive', 'trip', 'drive', 'Driver app · own trip and proof of delivery', 182),
  ('shop.operate', 'shop', 'operate', 'Own shop · counter sales and day close', 183),
  ('credit.request', 'credit', 'request', 'Credit · ask for a limit (stage 2)', 184),
  ('credit.endorse', 'credit', 'endorse', 'Credit · sales manager endorses (stage 3)', 185),
  ('credit.verify', 'credit', 'verify', 'Credit · finance verifies the file (stage 4)', 186),
  ('credit.recommend', 'credit', 'recommend', 'Credit · finance head recommends (stage 5)', 187),
  ('credit.approve', 'credit', 'approve', 'Credit · MD approves limit and terms (stage 6)', 188),
  ('credit.md_exception', 'credit', 'md_exception', 'Credit · MD exception above the limit (time-limited)', 189)
on conflict (key) do nothing;

insert into core.role_rights (role_key, right_key) values
  ('salesman', 'field.sell'), ('salesman', 'credit.request'),
  ('sales_manager', 'sales.view'), ('sales_manager', 'sales.create'), ('sales_manager', 'sales.edit'), ('sales_manager', 'sales.approve'),
  ('sales_manager', 'field.manage'), ('sales_manager', 'field.sell'), ('sales_manager', 'credit.request'), ('sales_manager', 'credit.endorse'),
  ('sales_manager', 'logistics.view'), ('sales_manager', 'sales_invoices.view'),
  ('driver', 'trip.drive'),
  ('shop_staff', 'shop.operate'), ('shop_staff', 'sales_invoices.create'),
  ('buyer_logistics', 'logistics.view'), ('buyer_logistics', 'logistics.create'), ('buyer_logistics', 'logistics.edit'),
  ('factory_manager', 'logistics.view'), ('factory_manager', 'logistics.approve'),
  ('accountant', 'credit.verify'),
  ('finance_head', 'credit.verify'), ('finance_head', 'credit.recommend'), ('finance_head', 'sales.view'), ('finance_head', 'accounts.view'),
  ('finance_head', 'cash_book.view'), ('finance_head', 'cash_book.create'), ('finance_head', 'cash_book.approve'), ('finance_head', 'gst.view'), ('finance_head', 'reports.view'),
  ('md', 'credit.approve'), ('md', 'credit.md_exception'), ('md', 'sales.view'), ('md', 'logistics.view'), ('md', 'reports.view'),
  ('gm', 'sales.view'), ('gm', 'logistics.view')
on conflict do nothing;

revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;

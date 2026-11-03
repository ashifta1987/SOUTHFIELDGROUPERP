-- 20261103008000_integrations_core.sql
-- Phase 8 tables: the outbound integration log with retries / back-off / dead letter (ops.integration_requests and
-- its append-only attempt log), inbound webhook events deduplicated per provider (ops.webhook_events), e-invoice IRNs
-- (sales.einvoice_irns) with the per-GSTIN switch and start date, e-way bills and their Part-B updates, bank statement
-- feeds per bank account, the online-channel sync log, marketplace settlements (TCS u/s 52 CGST reconciliation),
-- GPS devices of the GPS provider, and the help assistant on WhatsApp for verified staff numbers.
-- No provider account exists yet: providers are chosen by settings (`integrations.provider.<kind>`); the mock provider
-- is accepted only where `integrations.allow_mock` is true (DEV / tests), and every mock IRN is flagged as such.
-- Additive only: widened check constraints, new columns with defaults, new tables. RLS on every new table.

-- ─────────── Widening (non-destructive) ───────────
alter table ops.bug_items drop constraint if exists bug_items_area_check;
alter table ops.bug_items add constraint bug_items_area_check check (area in (
  'ledger', 'stock', 'production', 'cash', 'tax', 'between_companies', 'masters', 'import', 'integration'));
alter table ops.bug_items drop constraint if exists bug_items_kind_check;
alter table ops.bug_items add constraint bug_items_kind_check check (kind in (
  'possible_duplicate', 'map_head', 'changed_in_tally', 'deleted_in_tally', 'same_name_two_groups', 'missing_gstin', 'missing_hsn', 'invalid_gstin',
  'employee_conflict', 'total_mismatch', 'unbalanced_voucher', 'negative_stock', 'date_outside', 'cancelled_voucher', 'classify_bills', 'control_mismatch',
  'other', 'integration_dead_letter'));

-- E-invoice switch per GSTIN: einvoice_enabled (existing) + the date it applies from (Q-21: off until the CA confirms).
alter table core.gstins add column if not exists einvoice_from date;

-- ─────────── Outbound integration requests (retries with back-off, dead letter → Bug fixer) ───────────
create table ops.integration_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references core.companies (id),
  provider text not null check (provider ~ '^[a-z0-9_]+$'),
  kind text not null check (kind in ('einvoice_generate', 'einvoice_cancel', 'eway_generate', 'eway_update_partb', 'eway_cancel', 'bank_feed_sync',
                                     'channel_listing_sync', 'channel_order_ack', 'help_whatsapp_reply')),
  ref_table text,
  ref_id uuid,
  payload jsonb not null default '{}'::jsonb,          -- built on the server from business data; never secrets
  payload_hash text not null,
  idempotency_key text not null unique,
  status text not null default 'queued' check (status in ('queued', 'in_progress', 'done', 'dead', 'cancelled')),
  attempts int not null default 0 check (attempts >= 0),
  max_attempts int not null check (max_attempts between 1 and 50),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  response jsonb,
  bug_id uuid references ops.bug_items (id),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  done_at timestamptz
);
create index on ops.integration_requests (status, next_attempt_at);
create index on ops.integration_requests (ref_table, ref_id);
create index on ops.integration_requests (company_id, created_at desc);

-- One row per attempt (append-only).
create table ops.integration_attempts (
  id bigint generated always as identity primary key,
  request_id uuid not null references ops.integration_requests (id),
  attempt_no int not null,
  ok boolean not null,
  error text,
  retryable boolean,
  next_attempt_at timestamptz,
  at timestamptz not null default now()
);
create index on ops.integration_attempts (request_id);
create trigger integration_attempts_append_only before update or delete on ops.integration_attempts for each row execute function app.reject_change();

-- ─────────── Inbound webhooks (signature checked first, deduplicated by provider + external id) ───────────
create table ops.webhook_events (
  id bigint generated always as identity primary key,
  provider text not null check (provider ~ '^[a-z0-9_]+$'),
  external_id text not null check (length(external_id) between 1 and 200),
  topic text,
  signature_ok boolean not null,
  payload jsonb not null default '{}'::jsonb,           -- personal data inside is cleared after 90 days (app.integration_sweep)
  payload_hash text not null,
  status text not null default 'received' check (status in ('received', 'processed', 'rejected', 'failed', 'ignored')),
  result jsonb,
  error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
-- Only signed events take part in dedupe, so a forged event can never block the real one.
create unique index webhook_events_dedupe on ops.webhook_events (provider, external_id) where signature_ok;
create index on ops.webhook_events (received_at);

-- ─────────── E-invoice (IRN) ───────────
create table sales.einvoice_irns (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  gstin_id uuid not null references core.gstins (id),
  document_id uuid not null references sales.documents (id),
  irn text not null unique check (irn ~* '^[0-9a-f]{64}$'),
  ack_no text not null,
  ack_date timestamptz not null,
  signed_qr text not null,
  provider text not null,
  is_mock boolean not null default false,
  status text not null default 'active' check (status in ('active', 'cancelled')),
  cancel_reason text check (cancel_reason is null or cancel_reason in ('duplicate', 'data_entry_mistake', 'order_cancelled', 'other')),
  cancel_remark text,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users (id),
  request_id uuid references ops.integration_requests (id),
  created_at timestamptz not null default now()
);
create unique index einvoice_one_active on sales.einvoice_irns (document_id) where status = 'active';

-- An IRN is never edited or deleted; the only change is active → cancelled (with its reason).
create or replace function app.einvoice_irn_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'an IRN is never deleted' using errcode = 'P0001', hint = 'einvoice.locked'; end if;
  if old.status <> 'active' or new.status <> 'cancelled' or new.irn <> old.irn or new.ack_no <> old.ack_no or new.signed_qr <> old.signed_qr
     or new.document_id <> old.document_id or new.ack_date <> old.ack_date then
    raise exception 'an IRN can only be cancelled' using errcode = 'P0001', hint = 'einvoice.locked';
  end if;
  return new;
end $$;
create trigger einvoice_irn_guard before update or delete on sales.einvoice_irns for each row execute function app.einvoice_irn_guard();

-- ─────────── E-way bills ───────────
create table sales.eway_bills (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  dispatch_id uuid references sales.dispatches (id),
  document_id uuid references sales.documents (id),
  eway_bill_no text not null unique check (eway_bill_no ~ '^[0-9]{12}$'),
  generated_at timestamptz not null,
  valid_until timestamptz,
  vehicle_no text,
  transporter_gstin text,
  distance_km int check (distance_km is null or distance_km >= 0),
  transport_mode text not null default 'road' check (transport_mode in ('road', 'rail', 'air', 'ship')),
  provider text not null,
  is_mock boolean not null default false,
  status text not null default 'active' check (status in ('active', 'cancelled')),
  cancel_reason text,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users (id),
  request_id uuid references ops.integration_requests (id),
  created_at timestamptz not null default now()
);
create unique index eway_one_active on sales.eway_bills (dispatch_id) where status = 'active';

create table sales.eway_partb_updates (
  id uuid primary key default gen_random_uuid(),
  eway_bill_id uuid not null references sales.eway_bills (id),
  vehicle_no text not null,
  reason text not null,
  valid_until timestamptz,
  request_id uuid references ops.integration_requests (id),
  updated_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index on sales.eway_partb_updates (eway_bill_id);
create trigger eway_partb_append_only before update or delete on sales.eway_partb_updates for each row execute function app.reject_change();

-- ─────────── Bank statement feeds ───────────
-- external_ref is the provider's opaque link / consent id. Never an account number and never a statement password.
create table acct.bank_feeds (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  account_id uuid not null references acct.bank_accounts (account_id),
  provider text not null check (provider ~ '^[a-z0-9_]+$'),
  external_ref text check (external_ref is null or external_ref !~ '[0-9]{9,}'),
  status text not null default 'not_connected' check (status in ('not_connected', 'active', 'paused', 'error')),
  last_sync_at timestamptz,
  last_cursor text,
  last_result jsonb,
  last_error text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (account_id, provider)
);

-- ─────────── Online channels: sync log (inbound orders are staged, then brought in by a person with sales rights) ───────────
create table sales.channel_sync_log (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  channel_id uuid not null references sales.online_channels (id),
  direction text not null check (direction in ('inbound', 'outbound')),
  kind text not null check (kind in ('order', 'order_cancel', 'listing', 'inventory', 'settlement', 'return')),
  external_id text not null,
  status text not null default 'staged' check (status in ('staged', 'ingested', 'failed', 'sent', 'skipped')),
  detail jsonb not null default '{}'::jsonb,
  error text,
  webhook_event_id bigint references ops.webhook_events (id),
  request_id uuid references ops.integration_requests (id),
  online_order_id uuid references sales.online_orders (id),
  processed_by uuid references auth.users (id),
  processed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index channel_sync_inbound_once on sales.channel_sync_log (channel_id, kind, external_id) where direction = 'inbound';
create index on sales.channel_sync_log (company_id, created_at desc);

-- ─────────── Marketplace settlements (TCS u/s 52 CGST collected by the e-commerce operator) ───────────
-- Append-only: a wrong settlement is reversed by a row with reverses_id (negative figures), then recorded again.
create table sales.marketplace_settlements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  channel_id uuid not null references sales.online_channels (id),
  settlement_ref text not null check (length(trim(settlement_ref)) > 0),
  period_from date not null,
  period_to date not null,
  payout_date date,
  gross_sales numeric(18, 2) not null default 0,
  returns_value numeric(18, 2) not null default 0,
  net_taxable numeric(18, 2) not null default 0,       -- net value of taxable supplies as reported by the operator (s.52 basis)
  tcs_cgst numeric(18, 2) not null default 0,
  tcs_sgst numeric(18, 2) not null default 0,
  tcs_igst numeric(18, 2) not null default 0,
  tds_amount numeric(18, 2) not null default 0,         -- income-tax TDS by the operator, if any (CA decides the section)
  commission numeric(18, 2) not null default 0,
  other_fees numeric(18, 2) not null default 0,
  net_payout numeric(18, 2) not null,
  bank_line_id uuid references acct.bank_statement_lines (id),
  reverses_id uuid references sales.marketplace_settlements (id),
  source text not null default 'manual' check (source in ('manual', 'api')),
  note text,
  recorded_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (channel_id, settlement_ref),
  check (period_to >= period_from)
);
create index on sales.marketplace_settlements (company_id, period_to);
create trigger marketplace_settlements_append_only before update or delete on sales.marketplace_settlements for each row execute function app.reject_change();

-- ─────────── GPS provider devices (points accepted only inside the user's open duty session) ───────────
create table ops.gps_devices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  provider text not null check (provider ~ '^[a-z0-9_]+$'),
  device_ref text not null,
  user_id uuid not null references auth.users (id),
  vehicle_id uuid references ops.vehicles (id),
  active boolean not null default true,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (provider, device_ref)
);

-- ─────────── Help on WhatsApp for verified staff (§HELP-8) ───────────
create table help.whatsapp_staff (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references master.people (id),
  user_id uuid not null references auth.users (id),
  number char(13) not null check (number ~ '^\+91[6-9][0-9]{9}$'),
  language text not null default 'en' check (language in ('en', 'ml', 'hi', 'bho')),
  consent_at timestamptz not null,
  verified_at timestamptz not null default now(),
  verified_by uuid not null references auth.users (id),
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create unique index help_wa_number_active on help.whatsapp_staff (number) where revoked_at is null;

-- Conversation lines (redacted text only; kept 12 months — §HELP-6).
create table help.whatsapp_messages (
  id bigint generated always as identity primary key,
  staff_id uuid references help.whatsapp_staff (id),
  direction text not null check (direction in ('in', 'out')),
  kind text not null default 'text' check (kind in ('text', 'voice')),
  body text,
  tool text,
  webhook_event_id bigint references ops.webhook_events (id),
  created_at timestamptz not null default now()
);
create index on help.whatsapp_messages (created_at);

-- ─────────── Settings (operational defaults; legal values stay unset for the CA) ───────────
insert into core.settings (company_id, key, value, note)
select null, k, v, n from (values
  ('integrations.max_attempts', '5'::jsonb, 'Phase 8: outbound calls are dead-lettered to the Bug fixer after this many attempts (owner may change)'),
  ('integrations.backoff_base_seconds', '60'::jsonb, 'Phase 8: first retry after this many seconds, doubling each time'),
  ('integrations.backoff_max_seconds', '21600'::jsonb, 'Phase 8: longest wait between two retries'),
  ('einvoice.cancel_window_hours', '24'::jsonb, 'IRP rule: an IRN can be cancelled within 24 hours of acknowledgement; afterwards issue a credit note (CA to confirm)')
) x(k, v, n)
where not exists (select 1 from core.settings s where s.company_id is null and s.key = x.k);

-- ─────────── Audit, RLS, grants ───────────
do $$
declare t text;
begin
  foreach t in array array['sales.einvoice_irns', 'sales.eway_bills', 'sales.eway_partb_updates', 'acct.bank_feeds', 'sales.marketplace_settlements',
                           'ops.gps_devices', 'help.whatsapp_staff', 'ops.integration_requests'] loop
    execute format('create trigger audit_row after insert or update or delete on %s for each row execute function app.audit_trigger()', t);
  end loop;
  foreach t in array array['ops.integration_requests', 'ops.integration_attempts', 'ops.webhook_events', 'sales.einvoice_irns', 'sales.eway_bills',
                           'sales.eway_partb_updates', 'acct.bank_feeds', 'sales.channel_sync_log', 'sales.marketplace_settlements', 'ops.gps_devices',
                           'help.whatsapp_staff', 'help.whatsapp_messages'] loop
    execute format('alter table %s enable row level security', t);
    execute format('revoke all on %s from anon, authenticated', t);
    execute format('grant select on %s to authenticated', t);
  end loop;
end $$;

create policy integ_requests_read on ops.integration_requests for select to authenticated using (app.is_admin());
create policy integ_attempts_read on ops.integration_attempts for select to authenticated using (app.is_admin());
create policy webhook_events_read on ops.webhook_events for select to authenticated using (app.is_admin());
create policy einvoice_read on sales.einvoice_irns for select to authenticated
  using (app.can(company_id, 'sales_invoices.view') or app.can(company_id, 'sales.view'));
create policy eway_read on sales.eway_bills for select to authenticated
  using (app.can(company_id, 'logistics.view') or app.can(company_id, 'sales.view') or app.can(company_id, 'sales_invoices.view'));
create policy eway_partb_read on sales.eway_partb_updates for select to authenticated
  using (exists (select 1 from sales.eway_bills e where e.id = eway_bill_id and (app.can(e.company_id, 'logistics.view') or app.can(e.company_id, 'sales.view'))));
create policy bank_feeds_read on acct.bank_feeds for select to authenticated using (app.can(company_id, 'accounts.view'));
create policy channel_sync_read on sales.channel_sync_log for select to authenticated using (app.can(company_id, 'sales.view'));
create policy settlements_read on sales.marketplace_settlements for select to authenticated using (app.can(company_id, 'accounts.view'));
create policy gps_devices_read on ops.gps_devices for select to authenticated using (app.is_admin() or app.can(company_id, 'logistics.view'));
create policy help_wa_staff_read on help.whatsapp_staff for select to authenticated using (app.is_admin() or user_id = (select auth.uid()));
create policy help_wa_messages_read on help.whatsapp_messages for select to authenticated using (app.is_admin());

grant usage on schema ops, sales, acct, help to service_role;
grant select, insert, update on ops.integration_requests, ops.webhook_events, sales.channel_sync_log to service_role;
grant select, insert on ops.integration_attempts, help.whatsapp_messages to service_role;
grant select on sales.einvoice_irns, sales.eway_bills, acct.bank_feeds, ops.gps_devices, help.whatsapp_staff to service_role;

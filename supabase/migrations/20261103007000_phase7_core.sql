-- 20261103007000_phase7_core.sql
-- Phase 7 tables: job work (orders, lines, receipts, job-worker places), maintenance (repair requests, spares issues,
-- preventive schedules and logs), licences and documents (documents, renewals, reminders sent once each), asset
-- depreciation runs and disposals, partners / directors / investor portal (partners, investments, projects, requests,
-- director loans and declarations, profit-share minutes and runs), month-end close (checklists, tasks, period events).
-- Also: closed periods can never be posted into (no special grant overrides; a trigger on the GL and the stock ledger
-- backs up app.fy_for), reopening is Admin-only, the investor role reads no company data through can_read_company,
-- the private 'documents' bucket with company folder policies, rights and settings seeds (no figures invented).
-- Additive only: widened check constraints, new columns with defaults, new tables. RLS on every new table.

-- ─────────── Widening (non-destructive) ───────────
alter table core.places drop constraint if exists places_kind_check;
alter table core.places add constraint places_kind_check check (kind in (
  'stores', 'quarantine', 'wip', 'fg_hold', 'fg_released', 'damage', 'transit', 'van', 'agent_consignment', 'other', 'job_worker'));

alter table inv.stock_ledger drop constraint if exists stock_ledger_move_type_check;
alter table inv.stock_ledger add constraint stock_ledger_move_type_check check (move_type in (
  'opening', 'receipt', 'issue', 'issue_in', 'return', 'release', 'reject', 'adjustment', 'transit_out', 'transit_in', 'transfer_in',
  'transfer_return', 'write_off', 'scrap_in', 'regrind', 'scrap_sale', 'reversal', 'consumption', 'production_in',
  'dispatch', 'dispatch_return', 'sale', 'qc_hold', 'qc_release', 'job_work_out', 'job_work_in'));

-- Licences: the full register of §14 (kinds), owner, portal, blocking flag and what it blocks, renewal status.
alter table core.licences drop constraint if exists licences_kind_check;
alter table core.licences add constraint licences_kind_check check (kind in (
  'cosmetics_manufacturing', 'drug_manufacturing', 'factory', 'pollution_consent', 'fire', 'trade', 'fssai', 'legal_metrology', 'other',
  'gst_registration', 'company_registration', 'pan_tan', 'udyam', 'iec', 'lut', 'epf', 'esi', 'shops_establishment', 'trademark', 'iso', 'bis',
  'weighing_verification', 'spirit_permit'));
alter table core.licences add column if not exists title text;
alter table core.licences add column if not exists portal_url text;
alter table core.licences add column if not exists owner_person_id uuid references master.people (id);
alter table core.licences add column if not exists is_blocking boolean not null default false;
alter table core.licences add column if not exists blocks text[] not null default '{}'::text[];
alter table core.licences add column if not exists renewal_status text not null default 'ok';
alter table core.licences add column if not exists renewal_applied_on date;
alter table core.licences drop constraint if exists licences_blocks_check;
alter table core.licences add constraint licences_blocks_check check (blocks <@ array['production', 'packing']::text[]);
alter table core.licences drop constraint if exists licences_renewal_status_check;
alter table core.licences add constraint licences_renewal_status_check check (renewal_status in ('ok', 'renewal_due', 'applied', 'renewed', 'lapsed'));

alter table core.assets add column if not exists disposed_on date;

-- Internal (non-GST) document types used by Phase 7 numbering.
insert into core.doc_types (key, label, gst_document, max_number_length, sort) values
  ('job_work', 'Job work order', false, 20, 50),
  ('repair_request', 'Repair request', false, 20, 51),
  ('spares_issue', 'Spares issue', false, 20, 52),
  ('partner_request', 'Partner request', false, 20, 53)
on conflict (key) do nothing;

-- ─────────── Licences and documents ───────────
create table core.licence_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  licence_id uuid not null references core.licences (id),
  kind text not null check (kind in ('licence_copy', 'application', 'renewal_receipt', 'inspection', 'other')),
  path text not null check (length(trim(path)) > 0),        -- documents bucket: <company_id>/licences/<licence_id>/<file>
  valid_to date,
  uploaded_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index on core.licence_documents (licence_id);

create table core.licence_renewals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  licence_id uuid not null references core.licences (id),
  old_licence_no text not null,
  old_valid_from date not null,
  old_valid_to date,
  new_licence_no text not null,
  new_valid_from date not null,
  new_valid_to date not null,
  document_id uuid references core.licence_documents (id),
  note text,
  renewed_by uuid references auth.users (id),
  renewed_at timestamptz not null default now(),
  check (new_valid_to >= new_valid_from)
);
create index on core.licence_renewals (licence_id);

-- One row per licence, expiry date and threshold: a reminder is never sent twice (unique), even if the job runs again.
create table core.licence_reminders (
  id bigint generated always as identity primary key,
  company_id uuid not null references core.companies (id),
  licence_id uuid not null references core.licences (id),
  valid_to date not null,
  days_before int not null check (days_before > 0),
  due_on date not null,
  status text not null check (status in ('queued', 'skipped', 'alert_only', 'superseded')),
  outbox_id uuid references msg.outbox (id),
  run_date date not null,
  created_at timestamptz not null default now(),
  unique (licence_id, valid_to, days_before)
);
create index on core.licence_reminders (company_id, run_date);

-- ─────────── Job work (CGST Act s.143: goods out under challan, back within the limit) ───────────
create table prod.job_worker_places (
  company_id uuid not null references core.companies (id),
  party_id uuid not null references master.parties (id),
  place_id uuid not null unique references core.places (id),
  created_at timestamptz not null default now(),
  primary key (company_id, party_id)
);

create table prod.job_work_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  doc_no text not null,
  gstin_id uuid not null references core.gstins (id),
  job_worker_party_id uuid not null references master.parties (id),
  process text not null check (length(trim(process)) > 0),
  goods_kind text not null check (goods_kind in ('inputs', 'capital_goods', 'moulds_tools')),
  from_place_id uuid not null references core.places (id),
  jw_place_id uuid not null references core.places (id),
  sent_on date not null,
  return_by date,                                             -- null = no time limit (moulds, dies, jigs, fixtures, tools)
  challan_document_id uuid references sales.documents (id),
  challan_no text,                                            -- copied so production users see it (challans are without-GST documents)
  status text not null default 'sent' check (status in ('sent', 'part_received', 'received', 'cancelled')),
  note text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, doc_no),
  check (return_by is null or return_by > sent_on)
);
create index on prod.job_work_orders (company_id, status);
create index on prod.job_work_orders (job_worker_party_id);

create table prod.job_work_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  order_id uuid not null references prod.job_work_orders (id),
  line_no int not null,
  product_id uuid not null references master.products (id),
  lot_id uuid references inv.lots (id),
  qty_sent numeric(18, 3) not null check (qty_sent > 0),
  unit_cost numeric(18, 4) not null default 0 check (unit_cost >= 0),
  qty_settled numeric(18, 3) not null default 0 check (qty_settled >= 0),   -- inputs accounted for by receipts (kept by receive_job_work)
  unique (order_id, line_no),
  check (qty_settled <= qty_sent)
);
create index on prod.job_work_lines (order_id);

create table prod.job_work_receipts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  order_id uuid not null references prod.job_work_orders (id),
  line_id uuid not null references prod.job_work_lines (id),
  kind text not null check (kind in ('finished', 'returned', 'scrap', 'loss')),
  product_id uuid references master.products (id),
  qty numeric(18, 3) not null default 0 check (qty >= 0),
  input_qty numeric(18, 3) not null default 0 check (input_qty >= 0),
  to_place_id uuid references core.places (id),
  value numeric(18, 2) not null default 0,
  received_on date not null,
  challan_ref text,                                           -- the job worker's own challan number, if any
  received_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  check (qty > 0 or input_qty > 0),
  check (kind <> 'loss' or qty = 0)
);
create index on prod.job_work_receipts (order_id);

-- ─────────── Maintenance ───────────
create table prod.repair_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  doc_no text,
  asset_id uuid references core.assets (id),
  mould_id uuid references prod.moulds (id),
  source text not null default 'manual' check (source in ('operator_check', 'manual', 'breakdown', 'preventive')),
  machine_check_id uuid unique references prod.machine_checks (id),
  title text not null check (length(trim(title)) > 0),
  description text,
  photo_path text,
  priority text not null default 'normal' check (priority in ('urgent', 'normal', 'low')),
  is_breakdown boolean not null default false,
  broke_down_at timestamptz,
  restored_at timestamptz,
  downtime_minutes numeric(9, 2) check (downtime_minutes is null or downtime_minutes >= 0),
  status text not null default 'new' check (status in ('new', 'assigned', 'waiting_parts', 'done', 'cancelled')),
  assigned_to uuid references auth.users (id),
  outside_vendor text,
  purchase_request_id uuid references purch.requests (id),
  labour_cost numeric(18, 2) check (labour_cost is null or labour_cost >= 0),
  outside_cost numeric(18, 2) check (outside_cost is null or outside_cost >= 0),
  resolution text,
  raised_by uuid references auth.users (id),
  closed_by uuid references auth.users (id),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, doc_no),
  check (asset_id is not null or mould_id is not null),
  check (restored_at is null or broke_down_at is null or restored_at >= broke_down_at)
);
create index on prod.repair_requests (company_id, status);
create index on prod.repair_requests (asset_id);

create table prod.spares_issues (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  doc_no text not null,
  repair_request_id uuid references prod.repair_requests (id),
  asset_id uuid references core.assets (id),
  product_id uuid not null references master.products (id),
  place_id uuid not null references core.places (id),
  qty numeric(18, 3) not null check (qty > 0),
  value numeric(18, 2) not null default 0,
  issued_on date not null,
  issued_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index on prod.spares_issues (company_id, issued_on);
create index on prod.spares_issues (repair_request_id);

create table prod.maintenance_schedules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  asset_id uuid not null references core.assets (id),
  title text not null check (length(trim(title)) > 0),
  interval_days int not null check (interval_days > 0),
  checklist jsonb not null default '[]'::jsonb,
  last_done_on date,
  next_due_on date not null,
  active boolean not null default true,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on prod.maintenance_schedules (company_id, next_due_on);

create table prod.maintenance_logs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  schedule_id uuid not null references prod.maintenance_schedules (id),
  asset_id uuid not null references core.assets (id),
  done_on date not null,
  note text,
  cost numeric(18, 2) check (cost is null or cost >= 0),
  done_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index on prod.maintenance_logs (schedule_id);

-- ─────────── Asset register: depreciation and disposals (method and lives are CA settings) ───────────
create table acct.depreciation_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  period_id uuid not null references core.periods (id),
  method text not null check (method in ('slm', 'wdv')),
  total numeric(18, 2) not null default 0 check (total >= 0),
  voucher_id uuid references acct.vouchers (id),
  status text not null default 'posted' check (status in ('posted', 'reversed')),
  run_by uuid references auth.users (id),
  run_at timestamptz not null default now()
);
create unique index depreciation_runs_one_per_period on acct.depreciation_runs (company_id, period_id) where status = 'posted';

create table acct.depreciation_lines (
  id bigint generated always as identity primary key,
  run_id uuid not null references acct.depreciation_runs (id),
  company_id uuid not null references core.companies (id),
  asset_id uuid not null references core.assets (id),
  cost numeric(18, 2) not null,
  residual numeric(18, 2) not null default 0,
  useful_life_years numeric(5, 2) not null,
  opening_wdv numeric(18, 2) not null,
  days int not null check (days > 0),
  amount numeric(18, 2) not null check (amount >= 0),
  closing_wdv numeric(18, 2) not null
);
create index on acct.depreciation_lines (asset_id);
create index on acct.depreciation_lines (run_id);

create table core.asset_disposals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  asset_id uuid not null unique references core.assets (id),
  disposal_date date not null,
  proceeds numeric(18, 2) not null default 0 check (proceeds >= 0),
  cost numeric(18, 2) not null,
  accumulated_depreciation numeric(18, 2) not null default 0,
  wdv numeric(18, 2) not null,
  gain_loss numeric(18, 2) not null,
  reason text not null check (length(trim(reason)) >= 5),
  voucher_id uuid references acct.vouchers (id),
  disposed_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

-- ─────────── Partners, directors and the investor portal ───────────
create table acct.partners (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  person_id uuid references master.people (id),
  user_id uuid references auth.users (id),                    -- the investor-portal sign-in (role 'investor')
  display_name text not null check (length(trim(display_name)) > 0),
  is_legal_partner boolean not null default false,            -- shareholder
  is_investment_partner boolean not null default false,
  is_working_partner boolean not null default false,
  is_director boolean not null default false,
  director_interested boolean not null default false,         -- a relative of a director or a firm/body a director is interested in (s.185)
  din char(8) check (din is null or din ~ '^[0-9]{8}$'),
  shares bigint check (shares is null or shares >= 0),
  share_pct numeric(7, 4) not null default 0 check (share_pct between 0 and 100),
  capital_account_id uuid references acct.accounts (id),
  current_account_id uuid references acct.accounts (id),
  loan_account_id uuid references acct.accounts (id),
  language text not null default 'en' check (language in ('en', 'ml')),
  status text not null default 'active' check (status in ('active', 'left')),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, user_id),
  unique (company_id, person_id)
);
create index on acct.partners (user_id);

create table acct.partner_projects (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  name text not null check (length(trim(name)) > 0),
  status text not null default 'idea' check (status in ('idea', 'being_built', 'running', 'closed')),
  started_on date,
  summary text,
  investor_figures jsonb not null default '{}'::jsonb,        -- only what Admin chooses to show investors
  visible_to_investors boolean not null default false,
  updated_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on acct.partner_projects (company_id);

create table acct.partner_investments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  partner_id uuid not null references acct.partners (id),
  kind text not null check (kind in ('share_capital', 'capital_account', 'project', 'other')),
  amount numeric(18, 2) not null check (amount <> 0),
  invested_on date not null,
  agreement_ref text,
  project_id uuid references acct.partner_projects (id),
  note text,
  recorded_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  check (kind <> 'project' or (project_id is not null and agreement_ref is not null))
);
create index on acct.partner_investments (partner_id);

create table acct.partner_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  doc_no text not null,
  partner_id uuid not null references acct.partners (id),
  kind text not null check (kind in ('withdraw', 'loan_to_partner', 'loan_from_partner', 'info', 'project_offer')),
  source text check (source is null or source in ('land_rent', 'incentive', 'dividend', 'investment')),
  project_id uuid references acct.partner_projects (id),
  amount numeric(18, 2) check (amount is null or amount > 0),
  repay_months int check (repay_months is null or repay_months > 0),
  repay_from text check (repay_from is null or repay_from in ('land_rent', 'incentive', 'bank')),
  purpose text,
  note text,
  status text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected', 'paid', 'withdrawn')),
  requested_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  decided_amount numeric(18, 2) check (decided_amount is null or decided_amount > 0),
  decision_note text,
  checks jsonb not null default '{}'::jsonb,
  voucher_id uuid references acct.vouchers (id),
  paid_at timestamptz,
  unique (company_id, doc_no),
  check (decided_by is null or decided_by <> requested_by)  -- nobody approves their own request
);
create index on acct.partner_requests (partner_id);
create index on acct.partner_requests (company_id, status);

create table acct.director_declarations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  partner_id uuid not null references acct.partners (id),
  kind text not null check (kind in ('not_borrowed', 'interest_disclosure', 'other')),
  declared_on date not null,
  valid_to date,
  document_path text,
  note text,
  recorded_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_to >= declared_on)
);
create index on acct.director_declarations (partner_id);

create table acct.director_loans (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  partner_id uuid not null references acct.partners (id),
  direction text not null check (direction in ('given', 'taken')),        -- given = the company lends; taken = the company borrows
  movement text not null check (movement in ('advance', 'repayment')),
  amount numeric(18, 2) not null check (amount > 0),
  loan_date date not null,
  bank_account_id uuid not null references acct.accounts (id),
  request_id uuid references acct.partner_requests (id),
  declaration_id uuid references acct.director_declarations (id),
  legal_basis jsonb not null default '{}'::jsonb,
  voucher_id uuid references acct.vouchers (id),
  recorded_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index on acct.director_loans (partner_id);

create table acct.profit_share_minutes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  fy_id uuid not null references core.financial_years (id),
  meeting_date date not null,
  minutes_ref text not null check (length(trim(minutes_ref)) > 0),
  document_path text,
  basis jsonb not null default '{}'::jsonb,                   -- {incentives: [{partner_id, pct}]} (pct of net profit, taken first)
  status text not null default 'draft' check (status in ('draft', 'approved', 'superseded')),
  created_by uuid references auth.users (id),
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  check (approved_by is null or approved_by <> created_by)
);
create index on acct.profit_share_minutes (company_id, fy_id);

create table acct.profit_share_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  minutes_id uuid not null references acct.profit_share_minutes (id),
  fy_id uuid not null references core.financial_years (id),
  net_profit numeric(18, 2) not null,
  incentive_total numeric(18, 2) not null default 0,
  distributable numeric(18, 2) not null default 0,
  status text not null default 'computed' check (status in ('computed', 'posted', 'superseded')),
  voucher_id uuid references acct.vouchers (id),
  computed_by uuid references auth.users (id),
  computed_at timestamptz not null default now(),
  posted_by uuid references auth.users (id),
  posted_at timestamptz
);
create unique index profit_share_runs_one_posted on acct.profit_share_runs (minutes_id) where status = 'posted';

create table acct.profit_shares (
  id bigint generated always as identity primary key,
  run_id uuid not null references acct.profit_share_runs (id),
  company_id uuid not null references core.companies (id),
  partner_id uuid not null references acct.partners (id),
  kind text not null check (kind in ('incentive', 'share')),
  pct numeric(7, 4) not null,
  amount numeric(18, 2) not null
);
create index on acct.profit_shares (partner_id);
create index on acct.profit_shares (run_id);

-- ─────────── Month-end close ───────────
create table acct.close_checklists (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  period_id uuid not null unique references core.periods (id),
  due_on date not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

create table acct.close_tasks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  checklist_id uuid not null references acct.close_checklists (id),
  title text not null check (length(trim(title)) > 0),
  area text not null default 'other' check (area in ('bank', 'bills', 'payroll', 'stock', 'exports', 'review', 'gst', 'cash', 'depreciation', 'other')),
  sort int not null default 100,
  doer_user_id uuid references auth.users (id),
  checker_user_id uuid references auth.users (id),
  status text not null default 'open' check (status in ('open', 'done', 'checked', 'carried')),
  done_by uuid references auth.users (id),
  done_at timestamptz,
  done_note text,
  checked_by uuid references auth.users (id),
  checked_at timestamptz,
  check_note text,
  carried_to_task_id uuid references acct.close_tasks (id),
  carry_reason text,
  created_at timestamptz not null default now(),
  check (doer_user_id is null or checker_user_id is null or doer_user_id <> checker_user_id),
  check (checked_by is null or checked_by <> done_by)          -- the doer never checks their own task
);
create index on acct.close_tasks (checklist_id);

create table acct.period_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references core.companies (id),
  period_id uuid not null references core.periods (id),
  action text not null check (action in ('closed', 'reopened', 'relocked', 'auto_closed')),
  reason text,
  relock_at timestamptz,
  by_user uuid references auth.users (id),
  at timestamptz not null default now()
);
create index on acct.period_events (period_id, at desc);

-- ─────────── Guards: append-only ledgers and histories ───────────
do $$
declare t text;
begin
  foreach t in array array['core.licence_documents', 'core.licence_renewals', 'core.licence_reminders', 'prod.job_work_receipts', 'prod.spares_issues',
                           'prod.maintenance_logs', 'acct.depreciation_lines', 'core.asset_disposals', 'acct.partner_investments',
                           'acct.director_declarations', 'acct.director_loans', 'acct.profit_shares', 'acct.period_events'] loop
    execute format('create trigger append_only before update or delete on %s for each row execute function app.reject_change()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function app.reject_change()', t);
  end loop;
end $$;

-- History on every new table.
do $$
declare t text;
begin
  foreach t in array array['core.licence_documents', 'core.licence_renewals', 'core.licence_reminders', 'prod.job_worker_places', 'prod.job_work_orders',
                           'prod.job_work_lines', 'prod.job_work_receipts', 'prod.repair_requests', 'prod.spares_issues', 'prod.maintenance_schedules',
                           'prod.maintenance_logs', 'acct.depreciation_runs', 'acct.depreciation_lines', 'core.asset_disposals', 'acct.partners',
                           'acct.partner_projects', 'acct.partner_investments', 'acct.partner_requests', 'acct.director_declarations', 'acct.director_loans',
                           'acct.profit_share_minutes', 'acct.profit_share_runs', 'acct.profit_shares', 'acct.close_checklists', 'acct.close_tasks',
                           'acct.period_events'] loop
    execute format('create trigger audit_row after insert or update or delete on %s for each row execute function app.audit_trigger()', t);
    execute format('alter table %s enable row level security', t);
    execute format('revoke all on %s from anon, authenticated', t);
    execute format('grant select on %s to authenticated', t);
  end loop;
end $$;

-- ─────────── Investor role: never reads company data through "can see the company" ───────────
-- The investor role exists only for the portal. It must not open licences, places, periods or any other table whose
-- policy is "anyone who can see the company"; its own rows come through acct.partners.user_id and the investor RPCs.
create or replace function app.can_read_company(p_company_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.my_roles() r where r.role_key <> 'investor' and (r.company_id is null or r.company_id = p_company_id))
$$;

create or replace function app.is_partner_user(p_partner uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from acct.partners p where p.id = p_partner and p.user_id = auth.uid())
$$;

-- ─────────── RLS policies (reads only; writes only through api RPCs) ───────────
create policy licence_docs_read on core.licence_documents for select to authenticated using (app.can_read_company(company_id));
create policy licence_renewals_read on core.licence_renewals for select to authenticated using (app.can_read_company(company_id));
create policy licence_reminders_read on core.licence_reminders for select to authenticated using (app.can_read_company(company_id));

create policy jw_places_read on prod.job_worker_places for select to authenticated using (app.can_prod(company_id) or app.can(company_id, 'inventory.view'));
create policy jw_orders_read on prod.job_work_orders for select to authenticated using (app.can_prod(company_id) or app.can(company_id, 'inventory.view'));
create policy jw_lines_read on prod.job_work_lines for select to authenticated using (app.can_prod(company_id) or app.can(company_id, 'inventory.view'));
create policy jw_receipts_read on prod.job_work_receipts for select to authenticated using (app.can_prod(company_id) or app.can(company_id, 'inventory.view'));

create policy repairs_read on prod.repair_requests for select to authenticated
  using (app.can_prod(company_id) or app.can(company_id, 'assets.view') or raised_by = (select auth.uid()) or assigned_to = (select auth.uid()));
create policy spares_read on prod.spares_issues for select to authenticated using (app.can_prod(company_id) or app.can(company_id, 'assets.view'));
create policy schedules_read on prod.maintenance_schedules for select to authenticated using (app.can_prod(company_id) or app.can(company_id, 'assets.view'));
create policy maint_logs_read on prod.maintenance_logs for select to authenticated using (app.can_prod(company_id) or app.can(company_id, 'assets.view'));

create policy dep_runs_read on acct.depreciation_runs for select to authenticated using (app.can(company_id, 'accounts.view') or app.can(company_id, 'assets.view'));
create policy dep_lines_read on acct.depreciation_lines for select to authenticated using (app.can(company_id, 'accounts.view') or app.can(company_id, 'assets.view'));
create policy disposals_read on core.asset_disposals for select to authenticated using (app.can(company_id, 'accounts.view') or app.can(company_id, 'assets.view'));

-- An investor sees only their own partner rows and what hangs off them.
create policy partners_read on acct.partners for select to authenticated using (user_id = (select auth.uid()) or app.can(company_id, 'partners.view'));
create policy partner_inv_read on acct.partner_investments for select to authenticated using (app.is_partner_user(partner_id) or app.can(company_id, 'partners.view'));
create policy partner_req_read on acct.partner_requests for select to authenticated
  using (requested_by = (select auth.uid()) or app.is_partner_user(partner_id) or app.can(company_id, 'partners.view'));
create policy declarations_read on acct.director_declarations for select to authenticated using (app.is_partner_user(partner_id) or app.can(company_id, 'partners.view'));
create policy dir_loans_read on acct.director_loans for select to authenticated using (app.is_partner_user(partner_id) or app.can(company_id, 'partners.view'));
create policy profit_shares_read on acct.profit_shares for select to authenticated using (app.is_partner_user(partner_id) or app.can(company_id, 'partners.view'));
create policy ps_minutes_read on acct.profit_share_minutes for select to authenticated using (app.can(company_id, 'partners.view'));
create policy ps_runs_read on acct.profit_share_runs for select to authenticated using (app.can(company_id, 'partners.view'));
create policy projects_read on acct.partner_projects for select to authenticated
  using (app.can(company_id, 'partners.view')
         or (visible_to_investors and exists (select 1 from acct.partners p where p.company_id = partner_projects.company_id and p.user_id = (select auth.uid()) and p.status = 'active')));

create policy close_lists_read on acct.close_checklists for select to authenticated
  using (app.can(company_id, 'accounts.view') or app.can(company_id, 'close.manage')
         or exists (select 1 from acct.close_tasks t where t.checklist_id = close_checklists.id and (select auth.uid()) in (t.doer_user_id, t.checker_user_id)));
create policy close_tasks_read on acct.close_tasks for select to authenticated
  using (app.can(company_id, 'accounts.view') or app.can(company_id, 'close.manage') or (select auth.uid()) in (doer_user_id, checker_user_id));
create policy period_events_read on acct.period_events for select to authenticated using (app.can_read_company(company_id));

-- ─────────── Closed periods: never posted into (no grant overrides), reopening is Admin-only ───────────
-- Replaces the Phase 3 version, which let a "Reopen a closed day or month" grant post into a closed month.
create or replace function app.fy_for(p_company uuid, p_date date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_fy uuid; v_period text;
begin
  select id into v_fy from core.financial_years where company_id = p_company and p_date between starts_on and ends_on;
  if v_fy is null then perform app.raise_rule('period.no_fy', 'no financial year is open for this date; open it on Settings', '22023'); end if;
  select status into v_period from core.periods where company_id = p_company and month_start = date_trunc('month', p_date)::date;
  if v_period = 'closed' then
    perform app.raise_rule('period.closed', 'this month is closed; nothing can be posted into it. Admin can reopen it with a reason on Month-end close', '42501');
  end if;
  return v_fy;
end $$;

-- Defence in depth: the GL and the stock ledger refuse any row dated in a closed month, whoever inserts it.
create or replace function app.refuse_closed_period() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_date date := (to_jsonb(new) ->> tg_argv[0])::date;
begin
  if exists (select 1 from core.periods p where p.company_id = new.company_id and p.month_start = date_trunc('month', v_date)::date and p.status = 'closed') then
    raise exception 'this month is closed; nothing can be posted into it' using errcode = '42501', hint = 'period.closed';
  end if;
  return new;
end $$;
create trigger closed_period_guard before insert on acct.gl_entries for each row execute function app.refuse_closed_period('entry_date');
create trigger closed_period_guard before insert on inv.stock_ledger for each row execute function app.refuse_closed_period('move_date');

-- A closed period reopens only through api.reopen_period (Admin, reason, logged).
create or replace function app.periods_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status = 'closed' and new.status = 'open' and current_setting('app.period_reopen', true) is distinct from 'on' then
    raise exception 'a closed month reopens only through Month-end close (Admin, with a reason)' using errcode = '42501', hint = 'period.reopen_admin_only';
  end if;
  return new;
end $$;
create trigger periods_guard before update on core.periods for each row execute function app.periods_guard();

-- The "Reopen a closed day or month" right can no longer be handed out as a time-limited permission (config update).
update core.rights set admin_only = true, grantable_by_permission = false,
  hint = 'Admin only, with a reason and logged · a closed month is never posted into under a permission'
where key = 'period.reopen';

-- ─────────── Private documents bucket (Mumbai): <company_id>/licences/... and <company_id>/assets/... ───────────
insert into storage.buckets (id, name, public, file_size_limit) values ('documents', 'documents', false, 20971520) on conflict (id) do nothing;
create policy documents_read on storage.objects for select to authenticated
  using (bucket_id = 'documents' and app.storage_company(name) is not null
         and ((split_part(name, '/', 2) = 'licences' and app.can_read_company(app.storage_company(name)))
           or (split_part(name, '/', 2) = 'assets' and (app.can(app.storage_company(name), 'assets.view') or app.can_prod(app.storage_company(name))))));
create policy documents_write on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and app.storage_company(name) is not null
              and ((split_part(name, '/', 2) = 'licences' and app.can(app.storage_company(name), 'settings.manage'))
                or (split_part(name, '/', 2) = 'assets' and app.can(app.storage_company(name), 'assets.manage'))));

-- ─────────── Rights (configuration seed) ───────────
insert into core.rights (key, module, action, label, sort) values
  ('partners.view', 'partners', 'view', 'Partners, directors and investment · View', 180),
  ('investor.portal', 'investor', 'portal', 'Investor portal · Own analytics and requests to Admin (no transactions)', 181),
  ('close.manage', 'close', 'manage', 'Month-end close · Checklist, tasks and closing the month', 182)
on conflict (key) do nothing;
insert into core.rights (key, module, action, label, hint, kind, admin_only, never_grantable, grantable_by_permission, sort) values
  ('partners.manage', 'partners', 'manage', 'Manage partners, decide partner requests, profit sharing', 'Admin only · Companies Act checks', 'special', true, true, false, 1050)
on conflict (key) do nothing;

insert into core.role_rights (role_key, right_key) values
  ('investor', 'investor.portal'),
  ('finance_head', 'partners.view'), ('finance_head', 'close.manage'),
  ('md', 'partners.view')
on conflict do nothing;

-- ─────────── Settings (from the prompt or the Act; the CA confirms; never rates or limits we were not given) ───────────
insert into core.settings (company_id, key, value, effective_from, note) values
  (null, 'licence.reminder_days', '[90, 30, 7]'::jsonb, '2026-04-01', 'Prompt §14: licence reminders 90, 30 and 7 days before expiry'),
  (null, 'close.due_day', '10'::jsonb, '2026-04-01', 'Prompt §17: the month-end close is due on the 10th of the next month'),
  (null, 'jobwork.return_years', '{"inputs": 1, "capital_goods": 3, "moulds_tools": null}'::jsonb, '2026-04-01',
   'CGST Act s.143: inputs back within 1 year, capital goods within 3 years; moulds, dies, jigs, fixtures and tools have no limit (CA to confirm)'),
  (null, 'close.default_tasks', '[{"title": "Import the bank statement and reconcile", "area": "bank"}, {"title": "Confirm supplier bills read from photos", "area": "bills"},
     {"title": "Approve the salary sheets", "area": "payroll"}, {"title": "Record export invoices and shipping bills", "area": "exports"},
     {"title": "Match stock transfers between units", "area": "stock"}, {"title": "Approve stock count differences", "area": "stock"},
     {"title": "Post month-end entries (depreciation, provisions)", "area": "depreciation"}, {"title": "Check invoice numbering and e-invoice IRNs", "area": "review"},
     {"title": "Close the cash days", "area": "cash"}]'::jsonb, '2026-04-01', 'MonthClose design checklist (titles only; Admin may change)');

revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;

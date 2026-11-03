-- 20261103005000_production_core.sql
-- Phase 5 production tables (Biochem and Plastics): licences (Admin entry), process families, versioned formulas
-- (approved by a second person, effective dates), batches with their state history, weighings (second-person check),
-- the append-only material consumption ledger, packaging issues and reconciliation, lab samples and the extended
-- prod.lab_tests, R&D trials and stability checks, the asset register (machines, scales, lab instruments) with
-- calibrations and events, shift work assignments, free-item / gift / combo packs (GST treatment set per pack with
-- the CA, Q-23), cost rates and batch costs, moulds and mould projects, injection shifts with OEE, quality
-- inspections, assembly BOMs and orders, pad printing, material specs and operator machine checks.
-- Every stock movement still goes through app.stock_post / app.stock_take. Additive only.

-- ─────────── Shared widening (non-destructive) ───────────
-- Stock ledger: two production movement types.
alter table inv.stock_ledger drop constraint if exists stock_ledger_move_type_check;
alter table inv.stock_ledger add constraint stock_ledger_move_type_check check (move_type in (
  'opening', 'receipt', 'issue', 'issue_in', 'return', 'release', 'reject', 'adjustment', 'transit_out', 'transit_in', 'transfer_in',
  'transfer_return', 'write_off', 'scrap_in', 'regrind', 'scrap_sale', 'reversal', 'consumption', 'production_in'));

-- Lab tests: production and R&D kinds; a test belongs to a lot, a batch or a sample.
alter table prod.lab_tests drop constraint if exists lab_tests_kind_check;
alter table prod.lab_tests add constraint lab_tests_kind_check check (kind in ('incoming', 'in_process', 'bulk', 'finished', 'retained', 'stability', 'rnd', 'component'));
alter table prod.lab_tests alter column lot_id drop not null;

-- Internal (non-GST) document types for Phase 5 numbering.
insert into core.doc_types (key, label, gst_document, max_number_length, sort) values
  ('lab_sample', 'Lab sample', false, 20, 31),
  ('injection_shift', 'Injection shift entry', false, 20, 32),
  ('assembly_order', 'Assembly order', false, 20, 33),
  ('pack_assembly', 'Pack assembly', false, 20, 34),
  ('pad_print', 'Pad printing job', false, 20, 35)
on conflict (key) do nothing;

-- ─────────── Licences (Admin entry; numbers are never invented) ───────────
create table core.licences (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  branch_id uuid references core.branches (id),                 -- null = every branch of the company
  kind text not null check (kind in ('cosmetics_manufacturing', 'drug_manufacturing', 'factory', 'pollution_consent', 'fire', 'trade', 'fssai', 'legal_metrology', 'other')),
  licence_no text not null check (length(trim(licence_no)) > 0),
  issued_by text,
  valid_from date not null,
  valid_to date,
  status text not null default 'active' check (status in ('active', 'suspended', 'cancelled')),
  document_path text,
  note text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, kind, licence_no),
  check (valid_to is null or valid_to >= valid_from)
);
create index on core.licences (company_id, kind);

-- ─────────── Assets: machines, scales, lab instruments, injection machines (both companies) ───────────
create table core.assets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  code text not null check (length(trim(code)) > 0),
  name text not null,
  kind text not null check (kind in ('mixer', 'scale', 'filling', 'soap_line', 'lab_instrument', 'injection_machine', 'pad_printer', 'assembly_station',
                                     'compressor', 'chiller', 'utility', 'vehicle', 'it', 'other')),
  place_id uuid references core.places (id),
  make text,
  model text,
  serial_no text,
  attrs jsonb not null default '{}'::jsonb,                     -- e.g. tonnage, capacity, range
  purchase_date date,
  put_to_use_date date,
  cost numeric(18, 2) check (cost is null or cost >= 0),
  useful_life_years numeric(5, 2) check (useful_life_years is null or useful_life_years > 0),   -- Schedule II life, set with the CA
  residual_pct numeric(5, 2) check (residual_pct is null or residual_pct between 0 and 100),
  needs_calibration boolean not null default false,
  calibration_interval_days int check (calibration_interval_days is null or calibration_interval_days > 0),
  calibration_due date,
  amc_vendor text,
  amc_until date,
  status text not null default 'active' check (status in ('active', 'repair', 'out_of_service', 'disposed')),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (company_id, code)
);
create index on core.assets (company_id, kind);

create table core.asset_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references core.companies (id),
  asset_id uuid not null references core.assets (id),
  kind text not null check (kind in ('added', 'moved', 'repair', 'service', 'amc', 'breakdown', 'restored', 'disposed', 'note')),
  event_date date not null,
  detail jsonb not null default '{}'::jsonb,
  amount numeric(18, 2) check (amount is null or amount >= 0),
  recorded_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index on core.asset_events (asset_id);

create table core.asset_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  asset_id uuid not null references core.assets (id),
  kind text not null check (kind in ('invoice', 'warranty', 'amc', 'manual', 'calibration_certificate', 'photo', 'other')),
  path text not null,
  valid_to date,
  uploaded_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index on core.asset_documents (asset_id);

create table prod.calibrations (
  id bigint generated always as identity primary key,
  company_id uuid not null references core.companies (id),
  asset_id uuid not null references core.assets (id),
  calibrated_on date not null,
  next_due date,
  result text not null check (result in ('pass', 'adjusted', 'fail')),
  agency text,
  certificate_path text,
  remarks text,
  recorded_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  check (next_due is null or next_due > calibrated_on)
);
create index on prod.calibrations (asset_id);

-- ─────────── Process families and formulas ───────────
create table prod.process_families (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  code text not null check (length(trim(code)) > 0),
  name text not null,
  licence_kind text check (licence_kind is null or licence_kind in ('cosmetics_manufacturing', 'drug_manufacturing', 'factory', 'pollution_consent', 'fire', 'trade', 'fssai', 'legal_metrology', 'other')),
  steps jsonb not null default '[]'::jsonb,                    -- the route: ordered step names
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (company_id, code)
);

create table prod.formulas (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  product_id uuid not null references master.products (id),    -- the finished item made from this formula
  family_id uuid not null references prod.process_families (id),
  code text not null check (length(trim(code)) > 0),
  name text not null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (company_id, code)
);
create index on prod.formulas (company_id, product_id);

create table prod.formula_versions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  formula_id uuid not null references prod.formulas (id),
  version int not null check (version > 0),
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'superseded', 'withdrawn')),
  batch_size numeric(18, 3) not null check (batch_size > 0),   -- kg of bulk the lines are written for
  fill_qty_g numeric(18, 3) check (fill_qty_g is null or fill_qty_g > 0),   -- bulk per pack (g); else the product's net quantity
  qc_spec jsonb not null default '[]'::jsonb,                  -- [{parameter, min, max, unit, stage}]
  effective_from date,
  effective_to date,
  notes text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  submitted_by uuid references auth.users (id),
  submitted_at timestamptz,
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  unique (formula_id, version),
  check (approved_by is null or (approved_by is distinct from created_by and approved_by is distinct from submitted_by)),
  check (effective_to is null or effective_from is null or effective_to >= effective_from)
);
create index on prod.formula_versions (formula_id, status);

create table prod.formula_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  version_id uuid not null references prod.formula_versions (id),
  line_no int not null,
  line_kind text not null check (line_kind in ('bulk', 'packaging')),
  product_id uuid not null references master.products (id),
  qty numeric(18, 3) not null check (qty > 0),                 -- bulk: kg per batch_size; packaging: Nos per pack
  note text,
  unique (version_id, line_no)
);
create index on prod.formula_lines (version_id);

-- ─────────── Batches ───────────
create table prod.batches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  batch_no text not null,
  product_id uuid not null references master.products (id),
  formula_version_id uuid not null references prod.formula_versions (id),
  family_id uuid not null references prod.process_families (id),
  licence_id uuid references core.licences (id),
  line_place_id uuid not null references core.places (id),
  stores_place_id uuid not null references core.places (id),
  fg_place_id uuid not null references core.places (id),
  batch_date date not null,
  shift text check (shift in ('day', 'night', 'general')),
  planned_qty numeric(18, 3) not null check (planned_qty > 0),  -- kg of bulk
  status text not null default 'planned' check (status in ('planned', 'reserved', 'weighed', 'in_process', 'sample_sent', 'bulk_passed', 'bulk_failed',
                                                          'packing', 'packed_hold', 'released', 'rejected', 'closed', 'cancelled')),
  bulk_qty numeric(18, 3) check (bulk_qty is null or bulk_qty > 0),
  bulk_scrap_kg numeric(18, 3) not null default 0 check (bulk_scrap_kg >= 0),
  bulk_left_kg numeric(18, 3) not null default 0 check (bulk_left_kg >= 0),
  fill_qty_g numeric(18, 3),
  good_packs numeric(18, 3) check (good_packs is null or (good_packs >= 0 and good_packs = trunc(good_packs))),
  rejected_packs numeric(18, 3) check (rejected_packs is null or (rejected_packs >= 0 and rejected_packs = trunc(rejected_packs))),
  fg_lot_id uuid references inv.lots (id),
  mfg_date date,
  expiry_date date,
  labour_hours numeric(9, 2) not null default 0 check (labour_hours >= 0),
  machine_hours numeric(9, 2) not null default 0 check (machine_hours >= 0),
  recon_status text not null default 'pending' check (recon_status in ('pending', 'balanced', 'mismatch')),
  basis_locked boolean not null default false,
  note text,
  planned_by uuid references auth.users (id),
  started_by uuid references auth.users (id),
  started_at timestamptz,
  packed_by uuid references auth.users (id),
  packed_at timestamptz,
  released_by uuid references auth.users (id),
  released_at timestamptz,
  reject_reason text,
  closed_by uuid references auth.users (id),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (company_id, batch_no),
  check (expiry_date is null or mfg_date is null or expiry_date >= mfg_date)
);
create index on prod.batches (company_id, status);
create index on prod.batches (company_id, batch_date);

create table prod.batch_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references core.companies (id),
  batch_id uuid not null references prod.batches (id),
  from_status text,
  to_status text not null,
  note text,
  by_user uuid references auth.users (id),
  at timestamptz not null default now()
);
create index on prod.batch_events (batch_id);

create table prod.weighings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  batch_id uuid not null references prod.batches (id),
  product_id uuid not null references master.products (id),
  lot_id uuid references inv.lots (id),
  planned_qty numeric(18, 3),
  weighed_qty numeric(18, 3) not null check (weighed_qty > 0),
  scale_asset_id uuid references core.assets (id),
  status text not null default 'weighed' check (status in ('weighed', 'verified', 'rejected')),
  weighed_by uuid not null references auth.users (id),
  weighed_at timestamptz not null default now(),
  verified_by uuid references auth.users (id),
  verified_at timestamptz,
  note text,
  check (verified_by is null or verified_by <> weighed_by)      -- the second-person check
);
create index on prod.weighings (batch_id);

-- Material consumption ledger (append-only): every unit used by a batch, assembly, pack, shift or print job.
create table prod.material_consumption (
  id bigint generated always as identity primary key,
  company_id uuid not null references core.companies (id),
  source_table text not null,
  source_id uuid not null,
  batch_id uuid references prod.batches (id),
  kind text not null check (kind in ('bulk_material', 'packaging', 'free_item', 'pack_item', 'component', 'granule', 'ink', 'other')),
  product_id uuid not null references master.products (id),
  lot_id uuid references inv.lots (id),
  place_id uuid not null references core.places (id),
  qty numeric(18, 3) not null check (qty <> 0),
  unit_cost numeric(18, 4) not null default 0,
  value numeric(18, 2) not null default 0,
  consumed_on date not null,
  reverses_id bigint references prod.material_consumption (id),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index on prod.material_consumption (batch_id);
create index on prod.material_consumption (source_table, source_id);
create index on prod.material_consumption (company_id, consumed_on);

-- Packaging issued to a batch line (append-only; one row per issue).
create table prod.batch_packaging_issues (
  id bigint generated always as identity primary key,
  company_id uuid not null references core.companies (id),
  batch_id uuid not null references prod.batches (id),
  product_id uuid not null references master.products (id),
  qty numeric(18, 3) not null check (qty > 0),
  issued_by uuid references auth.users (id),
  issued_at timestamptz not null default now()
);
create index on prod.batch_packaging_issues (batch_id);

-- Packaging reconciliation per batch and item: issued = good + rejected + scrapped + returned + at the line.
create table prod.packaging_recon (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  batch_id uuid not null references prod.batches (id),
  product_id uuid not null references master.products (id),
  issued numeric(18, 3) not null default 0,
  in_good numeric(18, 3) not null default 0,
  in_rejected numeric(18, 3) not null default 0,
  scrapped numeric(18, 3) not null default 0 check (scrapped >= 0),
  returned numeric(18, 3) not null default 0 check (returned >= 0),
  at_line numeric(18, 3) not null default 0 check (at_line >= 0),
  difference numeric(18, 3) generated always as (issued - in_good - in_rejected - scrapped - returned - at_line) stored,
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  unique (batch_id, product_id)
);

-- ─────────── Labs ───────────
create table prod.lab_samples (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  sample_no text not null,
  kind text not null check (kind in ('in_process', 'bulk', 'finished', 'retained', 'rnd')),
  batch_id uuid references prod.batches (id),
  lot_id uuid references inv.lots (id),
  trial_id uuid,
  assigned_to uuid references auth.users (id),
  status text not null default 'pending' check (status in ('pending', 'tested', 'retained', 'disposed')),
  retain_until date,
  note text,
  taken_by uuid references auth.users (id),
  taken_at timestamptz not null default now(),
  unique (company_id, sample_no)
);
create index on prod.lab_samples (company_id, status);
create index on prod.lab_samples (batch_id);

alter table prod.lab_tests add column if not exists batch_id uuid references prod.batches (id);
alter table prod.lab_tests add column if not exists sample_id uuid references prod.lab_samples (id);
alter table prod.lab_tests add column if not exists instrument_id uuid references core.assets (id);
alter table prod.lab_tests add column if not exists out_of_spec jsonb not null default '[]'::jsonb;
create index if not exists lab_tests_batch_idx on prod.lab_tests (batch_id);
create index if not exists lab_tests_sample_idx on prod.lab_tests (sample_id);

create table prod.rnd_trials (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  code text not null check (length(trim(code)) > 0),
  title text not null,
  family_id uuid references prod.process_families (id),
  formula_version_id uuid references prod.formula_versions (id),
  assigned_to uuid references auth.users (id),
  status text not null default 'planned' check (status in ('planned', 'running', 'stability', 'passed', 'failed', 'dropped')),
  started_on date,
  notes text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (company_id, code)
);
alter table prod.lab_samples add constraint lab_samples_trial_fk foreign key (trial_id) references prod.rnd_trials (id);

create table prod.stability_checks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  trial_id uuid not null references prod.rnd_trials (id),
  day_no int not null check (day_no >= 0),
  condition text,
  due_on date,
  result text check (result is null or result in ('pass', 'fail', 'watch')),
  observations jsonb not null default '{}'::jsonb,
  recorded_by uuid references auth.users (id),
  recorded_at timestamptz,
  unique (trial_id, day_no, condition)
);

-- ─────────── Factory work assignment (one person can hold several duties) ───────────
create table prod.shift_assignments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  place_id uuid references core.places (id),
  work_date date not null,
  shift text not null check (shift in ('day', 'night', 'general')),
  user_id uuid not null references auth.users (id),
  duty text not null check (duty in ('batch_maker', 'weigher', 'weigh_checker', 'packer', 'labour', 'supervisor', 'qc_tester', 'qc_releaser',
                                     'rnd', 'operator', 'helper', 'inspector', 'assembler', 'printer')),
  batch_id uuid references prod.batches (id),
  asset_id uuid references core.assets (id),
  hours numeric(5, 2) check (hours is null or (hours > 0 and hours <= 24)),
  assigned_by uuid references auth.users (id),
  assigned_at timestamptz not null default now(),
  unique nulls not distinct (work_date, shift, user_id, duty, batch_id, asset_id)
);
create index on prod.shift_assignments (company_id, work_date);
create index on prod.shift_assignments (batch_id);

-- ─────────── Free items, gift and combo packs ───────────
create table prod.packs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  product_id uuid not null references master.products (id),   -- the pack as sold
  kind text not null check (kind in ('free_item_pack', 'gift_pack', 'combo_pack')),
  name text not null,
  -- GST treatment agreed with the CA (Q-23). Null = not set: the pack cannot be billed.
  gst_treatment text check (gst_treatment is null or gst_treatment in ('free_with_sale_single_price', 'gift_without_consideration', 'mixed_supply', 'composite_supply')),
  gst_treatment_note text,
  gst_treatment_set_by uuid references auth.users (id),
  gst_treatment_set_at timestamptz,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (company_id, product_id)
);

create table prod.pack_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  pack_id uuid not null references prod.packs (id),
  product_id uuid not null references master.products (id),
  qty numeric(18, 3) not null check (qty > 0),
  is_free boolean not null default false,
  note text,
  unique (pack_id, product_id)
);

create table prod.pack_assemblies (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  doc_no text not null,
  pack_id uuid not null references prod.packs (id),
  qty numeric(18, 3) not null check (qty > 0),
  from_place_id uuid not null references core.places (id),
  to_place_id uuid not null references core.places (id),
  unit_cost numeric(18, 4) not null default 0,
  assembly_date date not null,
  assembled_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (company_id, doc_no)
);

-- ─────────── Costing ───────────
create table prod.cost_rates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  kind text not null check (kind in ('labour_hour', 'machine_hour', 'overhead_per_kg', 'overhead_per_piece')),
  rate numeric(18, 2) not null check (rate >= 0),
  effective_from date not null,
  note text,
  set_by uuid references auth.users (id),
  set_at timestamptz not null default now(),
  unique (company_id, kind, effective_from)
);

create table prod.batch_costs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  batch_id uuid not null unique references prod.batches (id),
  materials numeric(18, 2) not null default 0,
  packaging numeric(18, 2) not null default 0,
  labour numeric(18, 2) not null default 0,
  machine numeric(18, 2) not null default 0,
  overhead numeric(18, 2) not null default 0,
  total numeric(18, 2) not null default 0,
  good_packs numeric(18, 3),
  cost_per_pack numeric(18, 4),
  rates_missing text[] not null default '{}',
  computed_by uuid references auth.users (id),
  computed_at timestamptz not null default now()
);

-- ─────────── Plastics: moulds ───────────
create table prod.mould_projects (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  code text not null check (length(trim(code)) > 0),
  name text not null,
  product_id uuid references master.products (id),
  ownership text not null default 'own' check (ownership in ('own', 'buyer')),
  buyer_party_id uuid references master.parties (id),
  stage text not null default 'design' check (stage in ('design', 'trial', 'approval', 'approved', 'dropped')),
  target_date date,
  estimated_cost numeric(18, 2) check (estimated_cost is null or estimated_cost >= 0),
  notes text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  unique (company_id, code),
  check (approved_by is null or approved_by is distinct from created_by)
);

create table prod.moulds (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  code text not null check (length(trim(code)) > 0),
  name text not null,
  project_id uuid references prod.mould_projects (id),
  product_id uuid references master.products (id),             -- the component it makes
  material_product_id uuid references master.products (id),    -- main granule
  cavities int not null check (cavities > 0),
  cycle_time_sec numeric(9, 2) not null check (cycle_time_sec > 0),
  part_weight_g numeric(18, 3) check (part_weight_g is null or part_weight_g > 0),
  runner_weight_g numeric(18, 3) check (runner_weight_g is null or runner_weight_g >= 0),
  ownership text not null default 'own' check (ownership in ('own', 'buyer')),
  buyer_party_id uuid references master.parties (id),
  location text not null default 'rack' check (location in ('rack', 'machine', 'repair', 'buyer', 'other')),
  place_id uuid references core.places (id),
  machine_asset_id uuid references core.assets (id),
  shot_count bigint not null default 0 check (shot_count >= 0),
  shots_at_last_service bigint not null default 0 check (shots_at_last_service >= 0),
  service_interval_shots bigint check (service_interval_shots is null or service_interval_shots > 0),
  life_shots bigint check (life_shots is null or life_shots > 0),
  cost numeric(18, 2) check (cost is null or cost >= 0),
  status text not null default 'active' check (status in ('active', 'repair', 'retired')),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (company_id, code)
);

create table prod.mould_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references core.companies (id),
  mould_id uuid references prod.moulds (id),
  project_id uuid references prod.mould_projects (id),
  kind text not null check (kind in ('created', 'stage', 'moved', 'mounted', 'unmounted', 'service', 'repair', 'shots', 'retired')),
  event_date date not null,
  detail jsonb not null default '{}'::jsonb,
  shots bigint,
  amount numeric(18, 2) check (amount is null or amount >= 0),
  source_id uuid,
  recorded_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  check (mould_id is not null or project_id is not null)
);
create index on prod.mould_events (mould_id);

-- ─────────── Plastics: injection shifts ───────────
create table prod.injection_shifts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  doc_no text not null,
  place_id uuid not null references core.places (id),           -- the unit / line
  output_place_id uuid not null references core.places (id),    -- where good pieces land (quarantine until inspected)
  shift_date date not null,
  shift text not null check (shift in ('day', 'night', 'general')),
  machine_asset_id uuid not null references core.assets (id),
  mould_id uuid not null references prod.moulds (id),
  product_id uuid not null references master.products (id),
  operator_user_id uuid references auth.users (id),
  operator_name text,
  cavities_running int not null check (cavities_running > 0),
  cycle_time_sec numeric(9, 2) not null check (cycle_time_sec > 0),
  planned_minutes numeric(9, 2) not null check (planned_minutes > 0),
  downtime_minutes numeric(9, 2) not null default 0 check (downtime_minutes >= 0),
  run_minutes numeric(9, 2) not null check (run_minutes >= 0),
  shot_start bigint,
  shot_end bigint,
  shots bigint not null default 0 check (shots >= 0),
  good_qty numeric(18, 3) not null check (good_qty >= 0),
  reject_qty numeric(18, 3) not null default 0 check (reject_qty >= 0),
  theoretical_qty numeric(18, 3) not null default 0,
  availability numeric(9, 4),
  performance numeric(9, 4),
  quality numeric(9, 4),
  oee numeric(9, 4),
  lot_id uuid references inv.lots (id),
  note text,
  recorded_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (company_id, doc_no),
  check (downtime_minutes <= planned_minutes),
  check (shot_end is null or shot_start is null or shot_end >= shot_start)
);
create index on prod.injection_shifts (company_id, shift_date);

create table prod.shift_rejects (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  shift_id uuid not null references prod.injection_shifts (id),
  reason text not null,
  qty numeric(18, 3) not null check (qty > 0)
);
create index on prod.shift_rejects (shift_id);

create table prod.downtime (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  shift_id uuid not null references prod.injection_shifts (id),
  kind text not null check (kind in ('setup', 'mould_change', 'breakdown', 'no_material', 'no_operator', 'power', 'quality', 'other')),
  reason text,
  minutes numeric(9, 2) not null check (minutes > 0)
);
create index on prod.downtime (shift_id);

create table prod.quality_inspections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  lot_id uuid not null references inv.lots (id),
  shift_id uuid references prod.injection_shifts (id),
  assembly_order_id uuid,
  kind text not null check (kind in ('first_piece', 'patrol', 'final', 'assembly')),
  sample_qty numeric(18, 3),
  accepted_qty numeric(18, 3) not null default 0 check (accepted_qty >= 0),
  rejected_qty numeric(18, 3) not null default 0 check (rejected_qty >= 0),
  result text not null check (result in ('pass', 'fail', 'hold')),
  defects jsonb not null default '[]'::jsonb,
  remarks text,
  inspection_date date not null,
  inspected_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);
create index on prod.quality_inspections (lot_id);

-- ─────────── Plastics: assembly (mixer grinder BOM), pad printing, material specs, machine checks ───────────
create table prod.assembly_boms (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  product_id uuid not null references master.products (id),
  version int not null check (version > 0),
  status text not null default 'draft' check (status in ('draft', 'approved', 'superseded')),
  notes text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  unique (company_id, product_id, version),
  check (approved_by is null or approved_by is distinct from created_by)
);

create table prod.assembly_bom_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  bom_id uuid not null references prod.assembly_boms (id),
  product_id uuid not null references master.products (id),
  qty_per numeric(18, 3) not null check (qty_per > 0),
  note text,
  unique (bom_id, product_id)
);

create table prod.assembly_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  doc_no text not null,
  bom_id uuid not null references prod.assembly_boms (id),
  product_id uuid not null references master.products (id),
  qty numeric(18, 3) not null check (qty > 0),
  from_place_id uuid not null references core.places (id),
  to_place_id uuid not null references core.places (id),
  lot_id uuid references inv.lots (id),
  unit_cost numeric(18, 4) not null default 0,
  labour_hours numeric(9, 2) not null default 0 check (labour_hours >= 0),
  order_date date not null,
  note text,
  assembled_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (company_id, doc_no)
);
alter table prod.quality_inspections add constraint quality_inspections_assembly_fk foreign key (assembly_order_id) references prod.assembly_orders (id);

create table prod.pad_print_jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  doc_no text not null,
  job_date date not null,
  product_id uuid not null references master.products (id),
  machine_asset_id uuid references core.assets (id),
  operator_user_id uuid references auth.users (id),
  qty_printed numeric(18, 3) not null check (qty_printed >= 0),
  qty_rejected numeric(18, 3) not null default 0 check (qty_rejected >= 0),
  prints_per_piece int not null default 1 check (prints_per_piece > 0),
  ink_product_id uuid references master.products (id),
  ink_qty numeric(18, 3) check (ink_qty is null or ink_qty > 0),
  ink_place_id uuid references core.places (id),
  ink_value numeric(18, 2) not null default 0,
  labour_minutes numeric(9, 2) not null default 0 check (labour_minutes >= 0),
  note text,
  recorded_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (company_id, doc_no)
);

create table prod.material_specs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  product_id uuid not null references master.products (id),     -- the component
  granule_product_id uuid references master.products (id),
  grade text,
  colour text,
  masterbatch_product_id uuid references master.products (id),
  masterbatch_pct numeric(9, 4) check (masterbatch_pct is null or masterbatch_pct between 0 and 100),
  part_weight_g numeric(18, 3) check (part_weight_g is null or part_weight_g > 0),
  runner_weight_g numeric(18, 3) check (runner_weight_g is null or runner_weight_g >= 0),
  cavities int check (cavities is null or cavities > 0),
  packing_cost_per_piece numeric(18, 4) check (packing_cost_per_piece is null or packing_cost_per_piece >= 0),
  set_by uuid references auth.users (id),
  set_at timestamptz not null default now(),
  unique (company_id, product_id)
);

create table prod.machine_checks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  asset_id uuid not null references core.assets (id),
  check_date date not null,
  shift text check (shift in ('day', 'night', 'general')),
  checklist jsonb not null default '[]'::jsonb,                -- [{item, ok, note}]
  all_ok boolean not null,
  remarks text,
  checked_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);
create index on prod.machine_checks (asset_id, check_date);

-- ─────────── Guards: append-only ledgers and histories ───────────
do $$
declare t text;
begin
  foreach t in array array['prod.material_consumption', 'prod.batch_events', 'prod.batch_packaging_issues', 'core.asset_events', 'prod.calibrations',
                           'prod.mould_events', 'prod.quality_inspections', 'prod.machine_checks'] loop
    execute format('create trigger append_only before update or delete on %s for each row execute function app.reject_change()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function app.reject_change()', t);
  end loop;
end $$;

-- An approved formula version and its lines never change (a new version is made instead).
create or replace function app.formula_lines_guard() returns trigger
language plpgsql set search_path = '' as $$
declare v_status text;
begin
  select status into v_status from prod.formula_versions where id = coalesce(new.version_id, old.version_id);
  if v_status is distinct from 'draft' then
    raise exception 'only a draft formula version can change; make a new version' using errcode = 'P0001', hint = 'formula.not_draft';
  end if;
  return coalesce(new, old);
end $$;
create trigger formula_lines_guard before insert or update or delete on prod.formula_lines for each row execute function app.formula_lines_guard();

create or replace function app.formula_version_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'formula versions are never deleted; withdraw them' using errcode = 'P0001', hint = 'formula.not_draft';
  end if;
  if old.status in ('approved', 'superseded', 'withdrawn') and (new.batch_size, new.fill_qty_g, new.qc_spec, new.effective_from, new.formula_id, new.version)
       is distinct from (old.batch_size, old.fill_qty_g, old.qc_spec, old.effective_from, old.formula_id, old.version) then
    raise exception 'an approved formula version cannot change; make a new version' using errcode = 'P0001', hint = 'formula.not_draft';
  end if;
  return new;
end $$;
create trigger formula_version_guard before update or delete on prod.formula_versions for each row execute function app.formula_version_guard();

-- History on every new table.
do $$
declare t text;
begin
  foreach t in array array['core.licences', 'core.assets', 'core.asset_documents', 'prod.process_families', 'prod.formulas', 'prod.formula_versions',
                           'prod.formula_lines', 'prod.batches', 'prod.weighings', 'prod.packaging_recon', 'prod.lab_samples', 'prod.rnd_trials',
                           'prod.stability_checks', 'prod.shift_assignments', 'prod.packs', 'prod.pack_items', 'prod.pack_assemblies', 'prod.cost_rates',
                           'prod.batch_costs', 'prod.mould_projects', 'prod.moulds', 'prod.injection_shifts', 'prod.shift_rejects', 'prod.downtime',
                           'prod.assembly_boms', 'prod.assembly_bom_lines', 'prod.assembly_orders', 'prod.pad_print_jobs', 'prod.material_specs',
                           'prod.material_consumption', 'prod.batch_events', 'prod.batch_packaging_issues', 'core.asset_events', 'prod.calibrations',
                           'prod.mould_events', 'prod.quality_inspections', 'prod.machine_checks'] loop
    execute format('create trigger audit_row after insert or update or delete on %s for each row execute function app.audit_trigger()', t);
  end loop;
end $$;

-- ─────────── RLS: on, reads only (writes only through the api RPCs) ───────────
do $$
declare t text;
begin
  foreach t in array array['core.licences', 'core.assets', 'core.asset_events', 'core.asset_documents'] loop
    execute format('alter table %s enable row level security', t);
    execute format('revoke all on %s from anon, authenticated', t);
    execute format('grant select on %s to authenticated', t);
  end loop;
end $$;
do $$
declare t record;
begin
  for t in select schemaname, tablename from pg_tables where schemaname = 'prod' loop
    execute format('alter table %I.%I enable row level security', t.schemaname, t.tablename);
    execute format('revoke all on %I.%I from anon, authenticated', t.schemaname, t.tablename);
    execute format('grant select on %I.%I to authenticated', t.schemaname, t.tablename);
  end loop;
end $$;

-- Who reads what. Production rows: production.view. Lab rows: also the testers, releasers and R&D.
-- Assets: assets.view or production.view. Licences: anyone who can see the company. Costs: cost.view.
create or replace function app.can_prod(p_company uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.can(p_company, 'production.view')
$$;
create or replace function app.can_lab(p_company uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.can(p_company, 'production.view') or app.can(p_company, 'qc.test') or app.can(p_company, 'qc.release') or app.can(p_company, 'lab.rnd')
$$;

create policy licences_read on core.licences for select to authenticated using (app.can_read_company(company_id));
create policy assets_read on core.assets for select to authenticated using (app.can(company_id, 'assets.view') or app.can_lab(company_id));
create policy asset_events_read on core.asset_events for select to authenticated using (app.can(company_id, 'assets.view') or app.can_lab(company_id));
create policy asset_docs_read on core.asset_documents for select to authenticated using (app.can(company_id, 'assets.view') or app.can_prod(company_id));
create policy calibrations_read on prod.calibrations for select to authenticated using (app.can(company_id, 'assets.view') or app.can_lab(company_id));

create policy families_read on prod.process_families for select to authenticated using (app.can_lab(company_id));
create policy formulas_read on prod.formulas for select to authenticated using (app.can_lab(company_id));
create policy formula_versions_read on prod.formula_versions for select to authenticated using (app.can_lab(company_id));
create policy formula_lines_read on prod.formula_lines for select to authenticated using (app.can_lab(company_id));
create policy batches_read on prod.batches for select to authenticated using (app.can_lab(company_id));
create policy batch_events_read on prod.batch_events for select to authenticated using (app.can_lab(company_id));
create policy weighings_read on prod.weighings for select to authenticated using (app.can_prod(company_id));
create policy consumption_read on prod.material_consumption for select to authenticated using (app.can_prod(company_id) or app.can(company_id, 'inventory.view'));
create policy pack_issues_read on prod.batch_packaging_issues for select to authenticated using (app.can_prod(company_id));
create policy recon_read on prod.packaging_recon for select to authenticated using (app.can_prod(company_id));
create policy samples_read on prod.lab_samples for select to authenticated using (app.can_lab(company_id));
create policy trials_read on prod.rnd_trials for select to authenticated using (app.can_lab(company_id));
create policy stability_read on prod.stability_checks for select to authenticated using (app.can_lab(company_id));
create policy assignments_read on prod.shift_assignments for select to authenticated using (app.can_prod(company_id) or user_id = (select auth.uid()));
create policy packs_read on prod.packs for select to authenticated using (app.can_prod(company_id) or app.can(company_id, 'sales.view'));
create policy pack_items_read on prod.pack_items for select to authenticated using (app.can_prod(company_id) or app.can(company_id, 'sales.view'));
create policy pack_assemblies_read on prod.pack_assemblies for select to authenticated using (app.can_prod(company_id));
create policy cost_rates_read on prod.cost_rates for select to authenticated using (app.can(company_id, 'cost.view'));
create policy batch_costs_read on prod.batch_costs for select to authenticated using (app.can(company_id, 'cost.view'));
create policy mould_projects_read on prod.mould_projects for select to authenticated using (app.can_prod(company_id));
create policy moulds_read on prod.moulds for select to authenticated using (app.can_prod(company_id));
create policy mould_events_read on prod.mould_events for select to authenticated using (app.can_prod(company_id));
create policy shifts_read on prod.injection_shifts for select to authenticated using (app.can_prod(company_id));
create policy shift_rejects_read on prod.shift_rejects for select to authenticated using (app.can_prod(company_id));
create policy downtime_read on prod.downtime for select to authenticated using (app.can_prod(company_id));
create policy inspections_read on prod.quality_inspections for select to authenticated using (app.can_lab(company_id));
create policy boms_read on prod.assembly_boms for select to authenticated using (app.can_prod(company_id));
create policy bom_lines_read on prod.assembly_bom_lines for select to authenticated using (app.can_prod(company_id));
create policy assembly_orders_read on prod.assembly_orders for select to authenticated using (app.can_prod(company_id));
create policy pad_print_read on prod.pad_print_jobs for select to authenticated using (app.can_prod(company_id));
create policy material_specs_read on prod.material_specs for select to authenticated using (app.can_prod(company_id));
create policy machine_checks_read on prod.machine_checks for select to authenticated using (app.can_prod(company_id) or app.can(company_id, 'assets.view'));

-- ─────────── Rights (configuration seed, Phase 1/4 pattern) ───────────
insert into core.rights (key, module, action, label, sort) values
  ('lab.rnd', 'lab', 'rnd', 'R&D lab · Trials and stability', 162),
  ('assets.view', 'assets', 'view', 'Machines and assets · View', 170),
  ('assets.manage', 'assets', 'manage', 'Machines and assets · Add, move, service, calibrate', 171)
on conflict (key) do nothing;

insert into core.role_rights (role_key, right_key) values
  -- Biochem production
  ('production_manager', 'production.view'), ('production_manager', 'production.create'), ('production_manager', 'production.edit'),
  ('production_manager', 'production.approve'), ('production_manager', 'lab.rnd'), ('production_manager', 'assets.view'), ('production_manager', 'assets.manage'),
  ('chemist', 'production.view'), ('chemist', 'production.create'), ('chemist', 'lab.rnd'), ('chemist', 'assets.view'),
  ('qc_releaser', 'production.view'), ('qc_releaser', 'assets.view'),
  ('supervisor', 'production.view'), ('supervisor', 'production.create'),
  ('factory_staff', 'production.view'), ('factory_staff', 'production.create'),
  -- Plastics production
  ('mould_manager', 'production.view'), ('mould_manager', 'production.create'), ('mould_manager', 'production.edit'), ('mould_manager', 'assets.view'), ('mould_manager', 'assets.manage'),
  ('injection_manager', 'production.view'), ('injection_manager', 'production.create'), ('injection_manager', 'production.edit'), ('injection_manager', 'assets.view'),
  ('injection_manager', 'assets.manage'),
  ('assembly', 'production.view'), ('assembly', 'production.create'),
  ('quality', 'production.view'),
  ('machine_operator', 'production.view'), ('machine_operator', 'production.create'),
  -- Oversight
  ('factory_manager', 'production.view'), ('factory_manager', 'production.edit'), ('factory_manager', 'production.approve'), ('factory_manager', 'assets.view'),
  ('factory_manager', 'assets.manage'),
  ('md', 'production.view'), ('md', 'assets.view'), ('gm', 'production.view'), ('gm', 'assets.view'),
  ('finance_head', 'production.view'), ('finance_head', 'assets.view'), ('accountant', 'assets.view')
on conflict do nothing;

revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;

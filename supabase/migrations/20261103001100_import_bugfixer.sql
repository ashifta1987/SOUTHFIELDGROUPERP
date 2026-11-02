-- 20261103001100_import_bugfixer.sql
-- Phase 2: Tally import (batches, staged rows, source keys with GUID/MASTERID/ALTERID, group→account-group map,
-- bridge devices, imported vouchers kept unposted until Phase 3), the Bug fixer queue, merges, backup runs and
-- restore drills, and the private storage buckets `imports` and `kyc` (Mumbai). Additive.

create table ops.import_batches (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  company_id uuid not null references core.companies (id),
  source text not null check (source in ('tally_xml', 'excel', 'tbk')),
  kind text not null default 'masters' check (kind in ('masters', 'vouchers', 'opening', 'products', 'parties', 'employees', 'mixed')),
  file_name text,
  storage_path text,
  status text not null default 'uploaded' check (status in ('uploaded', 'awaiting_bridge', 'staged', 'processed', 'approved', 'undone', 'failed')),
  counts jsonb not null default '{}'::jsonb,
  totals jsonb not null default '{}'::jsonb,               -- Tally totals declared in the file (for reconciliation)
  as_of date,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  undone_at timestamptz
);
create index on ops.import_batches (company_id);

create table ops.import_rows (
  id bigint generated always as identity primary key,
  batch_id uuid not null references ops.import_batches (id) on delete cascade,
  seq int not null,
  object_type text not null check (object_type in ('group', 'ledger', 'stock_group', 'stock_item', 'unit', 'godown', 'cost_centre', 'employee', 'voucher', 'opening_bill')),
  name text,
  guid text,
  master_id text,
  alter_id bigint,
  payload jsonb not null,
  result text check (result in ('created', 'linked', 'aliased', 'skipped', 'bug', 'changed', 'error')),
  erp_table text,
  erp_id uuid,
  bug_id uuid,
  message text,
  unique (batch_id, seq)
);
create index on ops.import_rows (batch_id, object_type);

-- The same GUID always means the same record (§25A).
create table ops.source_keys (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'tally',
  company_id uuid not null references core.companies (id),
  object_type text not null,
  guid text not null,
  master_id text,
  alter_id bigint,
  erp_table text not null,
  erp_id uuid not null,
  payload_hash text,
  first_batch_id uuid references ops.import_batches (id),
  last_batch_id uuid references ops.import_batches (id),
  unique (source, company_id, object_type, guid)
);
create index on ops.source_keys (erp_id);

create table ops.tally_group_map (
  company_id uuid not null references core.companies (id),
  tally_group text not null,
  account_group_id uuid not null references acct.account_groups (id),
  mapped_by uuid references auth.users (id),
  mapped_at timestamptz not null default now(),
  primary key (company_id, tally_group)
);

create table ops.bridge_devices (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  key_hash text not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

-- Vouchers read from Tally. Kept as imported (not posted) until the GL exists (Phase 3); never edited after loading.
create table ops.tally_vouchers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  guid text,
  voucher_type text not null,
  voucher_no text,
  voucher_date date not null,
  party_name text,
  party_id uuid references master.parties (id),
  amount numeric(18, 2) not null,
  is_cancelled boolean not null default false,
  is_optional boolean not null default false,
  alter_id bigint,
  lines jsonb not null default '[]'::jsonb,
  match_key text not null,                                  -- GUID, or type|no|date|amount|party when GUID is missing
  batch_id uuid references ops.import_batches (id),
  state text not null default 'loaded' check (state in ('loaded', 'flagged', 'posted', 'reversed')),
  unique (company_id, match_key)
);
create index on ops.tally_vouchers (company_id, voucher_date);
create trigger tally_vouchers_no_delete before delete on ops.tally_vouchers for each row execute function app.reject_change();

-- ─────────── Bug fixer ───────────
create sequence ops.bug_item_seq;
create table ops.bug_items (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default ('F-' || lpad(nextval('ops.bug_item_seq')::text, 4, '0')),
  company_id uuid references core.companies (id),
  area text not null check (area in ('ledger', 'stock', 'production', 'cash', 'tax', 'between_companies', 'masters', 'import')),
  kind text not null check (kind in ('possible_duplicate', 'map_head', 'changed_in_tally', 'deleted_in_tally', 'same_name_two_groups',
                                     'missing_gstin', 'missing_hsn', 'invalid_gstin', 'employee_conflict', 'total_mismatch', 'unbalanced_voucher',
                                     'negative_stock', 'date_outside', 'cancelled_voucher', 'classify_bills', 'control_mismatch', 'other')),
  severity text not null default 'medium' check (severity in ('high', 'medium', 'info')),
  title text not null,
  evidence jsonb not null default '{}'::jsonb,
  suggested_fix text,
  who_fixes text not null default 'admin' check (who_fixes in ('admin', 'ca', 'store', 'production', 'accounts', 'both_books')),
  amount numeric(18, 2),
  tax_class text not null default 'taxable' check (tax_class in ('taxable', 'without_gst', 'unclassified')),
  status text not null default 'open' check (status in ('open', 'fixed', 'dismissed')),
  batch_id uuid references ops.import_batches (id),
  ref_table text,
  ref_id uuid,
  other_id uuid,
  dedupe_key text unique,
  resolution text,
  fixed_by uuid references auth.users (id),
  fixed_at timestamptz,
  created_at timestamptz not null default now()
);
create index on ops.bug_items (company_id, status);
create index on ops.bug_items (batch_id);

create table ops.merge_log (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('party', 'product', 'person')),
  kept_id uuid not null,
  merged_id uuid not null,
  preview jsonb not null,
  reason text not null,
  merged_by uuid not null references auth.users (id),
  merged_at timestamptz not null default now(),
  undone_by uuid references auth.users (id),
  undone_at timestamptz
);

-- ─────────── Backups ───────────
create table ops.backup_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('supabase_daily', 'pitr', 'pg_dump', 'storage_sync', 'restore_drill', 'restore')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('running', 'ok', 'failed')),
  location text not null,                                   -- must be in India
  size_bytes bigint,
  checksum text,
  note text,
  recorded_by uuid references auth.users (id)
);

-- History triggers
do $$
declare t text;
begin
  foreach t in array array['ops.import_batches', 'ops.source_keys', 'ops.tally_group_map', 'ops.bridge_devices', 'ops.tally_vouchers', 'ops.bug_items', 'ops.merge_log', 'ops.backup_runs'] loop
    execute format('create trigger audit_row after insert or update or delete on %s for each row execute function app.audit_trigger()', t);
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array['import_batches', 'import_rows', 'source_keys', 'tally_group_map', 'bridge_devices', 'tally_vouchers', 'bug_items', 'merge_log', 'backup_runs'] loop
    execute format('alter table ops.%I enable row level security', t);
    execute format('revoke all on ops.%I from anon, authenticated', t);
  end loop;
end $$;
grant select on ops.import_batches, ops.import_rows, ops.source_keys, ops.tally_group_map, ops.tally_vouchers, ops.bug_items, ops.merge_log, ops.backup_runs to authenticated;

create policy import_batches_read on ops.import_batches for select to authenticated using (app.can(company_id, 'data.import') or app.current_view() in ('all', 'all-readonly'));
create policy import_rows_read on ops.import_rows for select to authenticated
  using (exists (select 1 from ops.import_batches b where b.id = batch_id and (app.can(b.company_id, 'data.import') or app.current_view() in ('all', 'all-readonly'))));
create policy source_keys_read on ops.source_keys for select to authenticated using (app.can(company_id, 'data.import') or app.current_view() in ('all', 'all-readonly'));
create policy group_map_read on ops.tally_group_map for select to authenticated using (app.can(company_id, 'accounts.view') or app.can(company_id, 'data.import'));
create policy tally_vouchers_read on ops.tally_vouchers for select to authenticated using (app.current_view() in ('all', 'all-readonly'));
-- The Bug fixer: Admin and the CA; anyone holding the "Fix in books" right for that company. Items about bills
-- without GST follow the view rule.
create policy bug_items_read on ops.bug_items for select to authenticated
  using ((app.current_view() in ('all', 'all-readonly') or app.can(company_id, 'bugfix.fix')) and app.can_see_bill_class(tax_class));
create policy merge_log_read on ops.merge_log for select to authenticated using (app.current_view() in ('all', 'all-readonly'));
create policy backup_runs_read on ops.backup_runs for select to authenticated using (app.can(null, 'backup.view'));

-- ─────────── Storage buckets (private, Mumbai) ───────────
insert into storage.buckets (id, name, public, file_size_limit)
values ('imports', 'imports', false, 524288000), ('kyc', 'kyc', false, 20971520)
on conflict (id) do nothing;

create policy imports_admin_read on storage.objects for select to authenticated
  using (bucket_id = 'imports' and app.can(null, 'data.import'));
create policy imports_admin_write on storage.objects for insert to authenticated
  with check (bucket_id = 'imports' and app.can(null, 'data.import'));
create policy kyc_read on storage.objects for select to authenticated
  using (bucket_id = 'kyc' and app.can(null, 'kyc.view'));
create policy kyc_write on storage.objects for insert to authenticated
  with check (bucket_id = 'kyc' and (app.can(null, 'sales.edit') or app.can(null, 'purchase.edit') or app.can(null, 'kyc.view')));


-- 20261103000100_foundation.sql
-- Phase 1 foundation: schemas, helper functions (app), group structure (core), users/roles/rights/views,
-- special permissions, settings, numbering, forms, law rules, audit trail (audit) and error log (ops).
-- Additive only. RLS is enabled on every table. Writes happen only through security-definer RPCs in `api`
-- (next migration); tables grant SELECT to `authenticated` and RLS decides which rows arrive.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pgtap with schema extensions;

create schema if not exists app;
create schema if not exists core;
create schema if not exists audit;
create schema if not exists ops;
create schema if not exists api;

revoke all on schema app, core, audit, ops from public, anon;
grant usage on schema core, audit, ops to authenticated;
grant usage on schema app to authenticated;
grant usage on schema api to anon, authenticated;

-- Only `api` (and GraphQL's public shim) is exposed through the Data API.
alter role authenticator set pgrst.db_schemas = 'api, graphql_public';

-- ─────────────────────────────── Identity helpers ───────────────────────────────
create or replace function app.uid() returns uuid
language sql stable set search_path = '' as $$ select auth.uid() $$;

-- ─────────────────────────────── Group structure ───────────────────────────────
create table core.companies (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{2,8}$'),
  legal_name text not null check (length(trim(legal_name)) > 1),
  short_name text not null,
  pan char(10) unique check (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  cin text unique,
  registered_address text,
  logo_key text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id)
);

create table core.gstins (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  gstin char(15) not null unique check (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  state_code char(2) generated always as (substr(gstin, 1, 2)) stored,
  legal_name text,
  trade_name text,
  registered_on date,
  is_principal boolean not null default false,
  einvoice_enabled boolean not null default false,
  status text not null default 'active' check (status in ('active', 'inactive', 'cancelled')),
  created_at timestamptz not null default now()
);
create index on core.gstins (company_id);

create table core.branches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  gstin_id uuid references core.gstins (id),
  code text not null,
  name text not null,
  kind text not null check (kind in ('factory', 'shop', 'branch', 'godown', 'office', 'unit')),
  address text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  unique (company_id, code)
);
create index on core.branches (company_id);
create index on core.branches (gstin_id);

create table core.places (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  branch_id uuid not null references core.branches (id),
  code text not null,
  name text not null,
  kind text not null check (kind in ('stores', 'quarantine', 'wip', 'fg_hold', 'fg_released', 'damage', 'transit', 'van', 'agent_consignment', 'other')),
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  unique (company_id, code)
);
create index on core.places (company_id);
create index on core.places (branch_id);

create table core.departments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references core.companies (id),
  name text not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  unique nulls not distinct (company_id, name)
);
create index on core.departments (company_id);

create table core.financial_years (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  label text not null check (label ~ '^[0-9]{4}-[0-9]{2}$'),
  starts_on date not null,
  ends_on date not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  unique (company_id, label),
  check (ends_on > starts_on)
);
create index on core.financial_years (company_id);

create table core.periods (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  fy_id uuid not null references core.financial_years (id),
  month_start date not null check (extract(day from month_start) = 1),
  status text not null default 'open' check (status in ('open', 'closed')),
  closed_at timestamptz,
  closed_by uuid references auth.users (id),
  unique (company_id, month_start)
);
create index on core.periods (fy_id);

-- ─────────────────────────────── Users, roles, rights ───────────────────────────────
create table core.roles (
  key text primary key check (key ~ '^[a-z_]+$'),
  label text not null,
  view_kind text not null check (view_kind in ('all', 'all-readonly', 'gst')),
  sign_in text not null default 'phone' check (sign_in in ('phone', 'email', 'both')),
  mfa_required boolean not null default false,
  sort int not null default 100
);

create table core.rights (
  key text primary key check (key ~ '^[a-z_]+\.[a-z_]+$'),
  module text not null,
  action text not null,
  label text not null,
  hint text,
  kind text not null default 'module' check (kind in ('module', 'special')),
  admin_only boolean not null default false,
  never_grantable boolean not null default false,
  grantable_by_permission boolean not null default false,
  sort int not null default 100
);

create table core.role_rights (
  role_key text not null references core.roles (key) on delete cascade,
  right_key text not null references core.rights (key) on delete cascade,
  primary key (role_key, right_key)
);

create table core.user_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  person_code text unique,
  language text not null default 'en' check (language in ('en', 'ml', 'hi', 'bho')),
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now()
);

-- A user's role, for all companies (company_id null) or one company. CA/auditor access ends at valid_to.
create table core.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  role_key text not null references core.roles (key),
  company_id uuid references core.companies (id),
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  assigned_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique nulls not distinct (user_id, role_key, company_id)
);
create index on core.user_roles (user_id);
create index on core.user_roles (company_id);

-- Place-level scope inside a company (optional). No rows = all places of the companies the roles cover.
create table core.user_scopes (
  user_id uuid not null references auth.users (id) on delete cascade,
  company_id uuid not null references core.companies (id),
  place_id uuid references core.places (id),
  primary key (user_id, company_id, place_id)
);

create table core.approval_limits (
  id uuid primary key default gen_random_uuid(),
  role_key text not null references core.roles (key),
  company_id uuid not null references core.companies (id),
  doc_type text not null,
  amount numeric(18, 2) not null check (amount >= 0),
  unique (role_key, company_id, doc_type)
);
create index on core.approval_limits (company_id);

-- Time-limited special permissions (§6). Never-grantable rights are refused by trigger and in the RPC.
create table core.special_grants (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  user_id uuid not null references auth.users (id),
  right_key text not null references core.rights (key),
  company_id uuid references core.companies (id),
  params jsonb not null default '{}'::jsonb,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  max_uses int check (max_uses is null or max_uses > 0),
  uses int not null default 0,
  reason text not null check (length(trim(reason)) >= 5),
  granted_by uuid not null references auth.users (id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id),
  revoke_reason text,
  check (ends_at > starts_at),
  check (granted_by <> user_id)
);
create index on core.special_grants (user_id);
create index on core.special_grants (company_id);

create table core.special_grant_requests (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references auth.users (id),
  right_key text not null references core.rights (key),
  company_id uuid references core.companies (id),
  params jsonb not null default '{}'::jsonb,
  wanted_from timestamptz not null,
  wanted_to timestamptz not null,
  reason text not null check (length(trim(reason)) >= 5),
  status text not null default 'pending' check (status in ('pending', 'approved', 'refused', 'withdrawn')),
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  grant_id uuid references core.special_grants (id),
  created_at timestamptz not null default now(),
  check (decided_by is null or decided_by <> requested_by)   -- nobody approves their own request
);
create index on core.special_grant_requests (requested_by);

-- ─────────────────────────────── Settings, numbering, forms, law ───────────────────────────────
-- Settings are versioned rows (append-only); the current value is the latest effective_from <= today.
create table core.settings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references core.companies (id),
  key text not null check (key ~ '^[a-z_.]+$'),
  value jsonb not null,
  effective_from date not null default current_date,
  note text,
  set_by uuid references auth.users (id),
  set_at timestamptz not null default now()
);
create index on core.settings (company_id, key, effective_from desc);

create table core.doc_types (
  key text primary key check (key ~ '^[a-z_]+$'),
  label text not null,
  gst_document boolean not null default false,
  max_number_length int not null default 16,
  sort int not null default 100
);

create table core.doc_series (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  gstin_id uuid references core.gstins (id),
  doc_type text not null references core.doc_types (key),
  fy_id uuid not null references core.financial_years (id),
  prefix text not null check (prefix ~ '^[A-Z0-9/-]{1,12}$'),
  pad int not null default 4 check (pad between 1 and 8),
  next_no bigint not null default 1 check (next_no >= 1),
  status text not null default 'active' check (status in ('active', 'closed')),
  created_at timestamptz not null default now(),
  unique nulls not distinct (company_id, gstin_id, doc_type, fy_id)
);
create index on core.doc_series (company_id);

-- Every number ever issued, so gaps are provable (there are none: numbers come only from app.take_doc_number).
create table core.doc_numbers_issued (
  series_id uuid not null references core.doc_series (id),
  seq bigint not null,
  doc_no text not null,
  issued_at timestamptz not null default now(),
  issued_by uuid,
  primary key (series_id, seq),
  unique (series_id, doc_no)
);

create table core.forms (
  key text primary key check (key ~ '^[a-z_]+$'),
  label text not null,
  module text not null
);

create table core.form_fields (
  id uuid primary key default gen_random_uuid(),
  form_key text not null references core.forms (key),
  company_id uuid references core.companies (id),
  field_key text not null check (field_key ~ '^[a-z_]+$'),
  label text not null,
  field_type text not null check (field_type in ('text', 'number', 'date', 'select', 'checkbox', 'phone', 'email')),
  required boolean not null default false,
  options jsonb not null default '[]'::jsonb,
  sort int not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique nulls not distinct (form_key, company_id, field_key)
);
create index on core.form_fields (company_id);

create table core.law_rules (
  code text primary key,
  area text not null,
  rule text not null,
  what_erp_does text not null,
  enforced_in text not null,
  test_ref text,
  status text not null default 'planned' check (status in ('planned', 'built', 'needs_ca')),
  phase int not null,
  sort int not null default 100
);

-- Idempotency: every mutating RPC records its client_request_id and result.
create table core.request_log (
  client_request_id uuid primary key,
  rpc text not null,
  user_id uuid,
  result jsonb,
  at timestamptz not null default now()
);

-- ─────────────────────────────── Audit trail (Rule 3(1)) ───────────────────────────────
create table audit.row_history (
  id bigint generated always as identity primary key,
  table_name text not null,
  row_pk text not null,
  op text not null check (op in ('INSERT', 'UPDATE', 'DELETE')),
  before jsonb,
  after jsonb,
  actor uuid,
  grant_id uuid,
  request_id uuid,
  app_version text,
  at timestamptz not null default now()
);
create index on audit.row_history (table_name, row_pk);
create index on audit.row_history (at desc);
create index on audit.row_history (actor);

create table audit.user_log (
  id bigint generated always as identity primary key,
  user_id uuid,
  event text not null check (event in ('sign_in', 'sign_in_failed', 'sign_out', 'export', 'print', 'view_sensitive', 'rights_changed', 'grant_given', 'grant_revoked', 'grant_used', 'setting_changed', 'user_changed', 'org_changed', 'admin_action')),
  detail jsonb not null default '{}'::jsonb,
  grant_id uuid,
  at timestamptz not null default now()
);
create index on audit.user_log (user_id);
create index on audit.user_log (at desc);

create table ops.error_log (
  ref text primary key check (ref ~ '^ERR-[A-Z0-9]{5}$'),
  user_id uuid,
  route text,
  rpc text,
  rule_code text,
  message text not null,
  payload_summary jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index on ops.error_log (user_id);

-- Append-only guard for ledgers and history: rejects UPDATE and DELETE (and TRUNCATE).
create or replace function app.reject_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'append_only: % on %.% is not allowed; post a reversal instead', tg_op, tg_table_schema, tg_table_name
    using errcode = 'P0001';
end $$;

create trigger row_history_append_only before update or delete on audit.row_history for each row execute function app.reject_change();
create trigger row_history_no_truncate before truncate on audit.row_history for each statement execute function app.reject_change();
create trigger user_log_append_only before update or delete on audit.user_log for each row execute function app.reject_change();
create trigger user_log_no_truncate before truncate on audit.user_log for each statement execute function app.reject_change();
create trigger doc_numbers_append_only before update or delete on core.doc_numbers_issued for each row execute function app.reject_change();
create trigger settings_append_only before update or delete on core.settings for each row execute function app.reject_change();

-- Row history writer (security definer: clients can never write history directly).
create or replace function app.audit_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_pk text;
  v_grant uuid := nullif(current_setting('app.grant_id', true), '')::uuid;
  v_req uuid := nullif(current_setting('app.request_id', true), '')::uuid;
begin
  if tg_op = 'DELETE' then
    v_pk := coalesce(to_jsonb(old) ->> 'id', to_jsonb(old) ->> 'key', to_jsonb(old) ->> 'user_id', to_jsonb(old) ->> 'code');
  else
    v_pk := coalesce(to_jsonb(new) ->> 'id', to_jsonb(new) ->> 'key', to_jsonb(new) ->> 'user_id', to_jsonb(new) ->> 'code');
  end if;
  insert into audit.row_history (table_name, row_pk, op, before, after, actor, grant_id, request_id, app_version)
  values (
    tg_table_schema || '.' || tg_table_name,
    coalesce(v_pk, '?'),
    tg_op,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end,
    auth.uid(),
    v_grant,
    v_req,
    nullif(current_setting('app.version', true), '')
  );
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'core.companies', 'core.gstins', 'core.branches', 'core.places', 'core.departments', 'core.financial_years', 'core.periods',
    'core.roles', 'core.rights', 'core.role_rights', 'core.user_profiles', 'core.user_roles', 'core.user_scopes', 'core.approval_limits',
    'core.special_grants', 'core.special_grant_requests', 'core.settings', 'core.doc_types', 'core.doc_series', 'core.forms', 'core.form_fields'
  ] loop
    execute format('create trigger audit_row after insert or update or delete on %s for each row execute function app.audit_trigger()', t);
  end loop;
end $$;

-- ─────────────────────────────── Rights and view helpers ───────────────────────────────
-- Active roles of the current user (CA/auditor windows end on their own).
create or replace function app.my_roles() returns table (role_key text, company_id uuid, view_kind text)
language sql stable security definer set search_path = '' as $$
  select ur.role_key, ur.company_id, r.view_kind
  from core.user_roles ur
  join core.roles r on r.key = ur.role_key
  join core.user_profiles p on p.user_id = ur.user_id and p.status = 'active'
  where ur.user_id = auth.uid()
    and ur.valid_from <= now()
    and (ur.valid_to is null or ur.valid_to > now())
$$;

-- 'all' (Admin/Owner) > 'all-readonly' (CA/auditor) > 'gst' (everyone else). No role → 'gst'.
create or replace function app.current_view() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select case
       when bool_or(view_kind = 'all') then 'all'
       when bool_or(view_kind = 'all-readonly') then 'all-readonly'
       else 'gst' end
     from app.my_roles()),
    'gst')
$$;

create or replace function app.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select app.current_view() = 'all'
$$;

-- Can the user see this company at all?
create or replace function app.can_read_company(p_company_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.my_roles() r where r.company_id is null or r.company_id = p_company_id)
$$;

-- Active special grant for a right (and company), or null. Expires on its own at ends_at.
create or replace function app.active_grant(p_right text, p_company_id uuid default null) returns uuid
language sql stable security definer set search_path = '' as $$
  select g.id from core.special_grants g
  where g.user_id = auth.uid()
    and g.right_key = p_right
    and g.revoked_at is null
    and now() >= g.starts_at and now() < g.ends_at
    and (g.max_uses is null or g.uses < g.max_uses)
    and (g.company_id is null or p_company_id is null or g.company_id = p_company_id)
  order by g.ends_at
  limit 1
$$;

-- The rights check used by RLS and inside every RPC.
--  Admin/Owner: every right. CA/auditor: only *.view and *.export (read-only, never writes).
--  Others: rights from their roles for that company, plus an active special grant.
create or replace function app.can(p_company_id uuid, p_right text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when exists (select 1 from app.my_roles() r where r.view_kind = 'all' and (r.company_id is null or r.company_id = p_company_id or p_company_id is null)) then true
    when exists (select 1 from app.my_roles() r where r.view_kind = 'all-readonly' and (r.company_id is null or r.company_id = p_company_id or p_company_id is null))
      then split_part(p_right, '.', 2) in ('view', 'export')
    when exists (
      select 1 from app.my_roles() r
      join core.role_rights rr on rr.role_key = r.role_key and rr.right_key = p_right
      where r.company_id is null or p_company_id is null or r.company_id = p_company_id
    ) then true
    else app.active_grant(p_right, p_company_id) is not null
  end
$$;

-- Bills without GST are visible only in the Admin and CA views (§6). Every later document table's RLS uses this.
create or replace function app.can_see_tax_class(p_tax_class text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_tax_class is distinct from 'without_gst' or app.current_view() in ('all', 'all-readonly')
$$;

-- Raise a rights error with a stable rule code (the UI maps it to a message with the next step).
create or replace function app.require(p_company_id uuid, p_right text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_grant uuid;
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = '42501', hint = 'auth.required';
  end if;
  if app.current_view() = 'all-readonly' and split_part(p_right, '.', 2) not in ('view', 'export') then
    raise exception 'read_only: CA and auditor access cannot change data' using errcode = '42501', hint = 'rights.read_only';
  end if;
  if not app.can(p_company_id, p_right) then
    raise exception 'no_right: % needs %', coalesce(p_company_id::text, 'group'), p_right using errcode = '42501', hint = 'rights.missing';
  end if;
  -- If the right comes only from a grant, return the grant id so the action is recorded under it.
  if not exists (
      select 1 from app.my_roles() r
      left join core.role_rights rr on rr.role_key = r.role_key and rr.right_key = p_right
      where (r.view_kind = 'all' or rr.right_key is not null)
        and (r.company_id is null or p_company_id is null or r.company_id = p_company_id)) then
    v_grant := app.active_grant(p_right, p_company_id);
  end if;
  return v_grant;
end $$;

-- Idempotency helpers.
create or replace function app.request_seen(p_crid uuid, p_rpc text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if p_crid is null then
    raise exception 'client_request_id is required' using errcode = '22023', hint = 'request.id_missing';
  end if;
  perform set_config('app.request_id', p_crid::text, true);
  select result into v from core.request_log where client_request_id = p_crid and rpc = p_rpc;
  return v;
end $$;

create or replace function app.request_done(p_crid uuid, p_rpc text, p_result jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  insert into core.request_log (client_request_id, rpc, user_id, result) values (p_crid, p_rpc, auth.uid(), p_result)
  on conflict (client_request_id) do nothing;
  select p_result;
$$;

create or replace function app.log_event(p_event text, p_detail jsonb, p_grant uuid default null) returns void
language sql security definer set search_path = '' as $$
  insert into audit.user_log (user_id, event, detail, grant_id) values (auth.uid(), p_event, coalesce(p_detail, '{}'::jsonb), p_grant);
$$;

-- Never-grantable rights can never sit in special_grants, whoever inserts (defence in depth).
create or replace function app.check_grant_right() returns trigger
language plpgsql set search_path = '' as $$
declare r core.rights;
begin
  select * into r from core.rights where key = new.right_key;
  if r.never_grantable or r.admin_only then
    raise exception 'never_grantable: % cannot be given as a special permission', new.right_key using errcode = '42501', hint = 'grant.never_grantable';
  end if;
  if not r.grantable_by_permission then
    raise exception 'not_grantable: % is not on the special permission list', new.right_key using errcode = '42501', hint = 'grant.not_on_list';
  end if;
  return new;
end $$;
create trigger special_grants_check_right before insert or update of right_key on core.special_grants
  for each row execute function app.check_grant_right();

-- Gap-free document number under a row lock (§23). Called only from posting RPCs.
create or replace function app.take_doc_number(p_company_id uuid, p_gstin_id uuid, p_doc_type text, p_fy_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  s core.doc_series;
  t core.doc_types;
  fy core.financial_years;
  v_no text;
begin
  select * into s from core.doc_series
   where company_id = p_company_id and gstin_id is not distinct from p_gstin_id and doc_type = p_doc_type and fy_id = p_fy_id and status = 'active'
   for update;
  if not found then
    raise exception 'no_series: no active number series for % in this FY', p_doc_type using errcode = 'P0001', hint = 'numbering.no_series';
  end if;
  select * into t from core.doc_types where key = p_doc_type;
  select * into fy from core.financial_years where id = p_fy_id;
  v_no := s.prefix || '/' || substr(fy.label, 3, 2) || '-' || substr(fy.label, 6, 2) || '/' || lpad(s.next_no::text, s.pad, '0');
  if length(v_no) > t.max_number_length then
    raise exception 'number_too_long: % is longer than % characters', v_no, t.max_number_length using errcode = 'P0001', hint = 'numbering.too_long';
  end if;
  insert into core.doc_numbers_issued (series_id, seq, doc_no, issued_by) values (s.id, s.next_no, v_no, auth.uid());
  update core.doc_series set next_no = next_no + 1 where id = s.id;
  return v_no;
end $$;

-- Current setting value for a company (falls back to the group-level value).
create or replace function app.setting(p_company_id uuid, p_key text, p_on date default current_date) returns jsonb
language sql stable security definer set search_path = '' as $$
  select value from core.settings
  where key = p_key and effective_from <= p_on and (company_id = p_company_id or company_id is null)
  order by (company_id is null), effective_from desc, set_at desc
  limit 1
$$;

-- Short error references (ERR-XXXXX).
create or replace function app.new_error_ref() returns text
language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v text;
begin
  loop
    v := 'ERR-';
    for i in 1..5 loop
      v := v || substr(alphabet, 1 + floor(random() * 32)::int, 1);
    end loop;
    exit when not exists (select 1 from ops.error_log where ref = v);
  end loop;
  return v;
end $$;

revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;

-- ─────────────────────────────── Row-level security ───────────────────────────────
do $$
declare t record;
begin
  for t in select schemaname, tablename from pg_tables where schemaname in ('core', 'audit', 'ops') loop
    execute format('alter table %I.%I enable row level security', t.schemaname, t.tablename);
    execute format('revoke all on %I.%I from anon, authenticated', t.schemaname, t.tablename);
  end loop;
end $$;

-- Reads only. All writes go through security-definer RPCs, so there are no insert/update/delete policies or grants.
grant select on core.companies, core.gstins, core.branches, core.places, core.departments, core.financial_years, core.periods,
  core.roles, core.rights, core.role_rights, core.user_profiles, core.user_roles, core.user_scopes, core.approval_limits,
  core.special_grants, core.special_grant_requests, core.settings, core.doc_types, core.doc_series, core.forms, core.form_fields,
  core.law_rules, audit.row_history, audit.user_log, ops.error_log to authenticated;

create policy companies_read on core.companies for select to authenticated using (app.can_read_company(id));
create policy gstins_read on core.gstins for select to authenticated using (app.can_read_company(company_id));
create policy branches_read on core.branches for select to authenticated using (app.can_read_company(company_id));
create policy places_read on core.places for select to authenticated using (app.can_read_company(company_id));
create policy departments_read on core.departments for select to authenticated using (company_id is null or app.can_read_company(company_id));
create policy fy_read on core.financial_years for select to authenticated using (app.can_read_company(company_id));
create policy periods_read on core.periods for select to authenticated using (app.can_read_company(company_id));
create policy roles_read on core.roles for select to authenticated using (true);
create policy rights_read on core.rights for select to authenticated using (true);
create policy role_rights_read on core.role_rights for select to authenticated using (true);
create policy profiles_read on core.user_profiles for select to authenticated
  using (user_id = (select auth.uid()) or app.can(null, 'users.view'));
create policy user_roles_read on core.user_roles for select to authenticated
  using (user_id = (select auth.uid()) or app.can(null, 'users.view'));
create policy user_scopes_read on core.user_scopes for select to authenticated
  using (user_id = (select auth.uid()) or app.can(null, 'users.view'));
create policy approval_limits_read on core.approval_limits for select to authenticated using (app.can_read_company(company_id));
create policy grants_read on core.special_grants for select to authenticated
  using (user_id = (select auth.uid()) or app.can(null, 'users.view'));
create policy grant_requests_read on core.special_grant_requests for select to authenticated
  using (requested_by = (select auth.uid()) or app.can(null, 'users.view'));
create policy settings_read on core.settings for select to authenticated using (company_id is null or app.can_read_company(company_id));
create policy doc_types_read on core.doc_types for select to authenticated using (true);
create policy doc_series_read on core.doc_series for select to authenticated using (app.can_read_company(company_id));
create policy forms_read on core.forms for select to authenticated using (true);
create policy form_fields_read on core.form_fields for select to authenticated using (company_id is null or app.can_read_company(company_id));
create policy law_rules_read on core.law_rules for select to authenticated using (true);
create policy row_history_read on audit.row_history for select to authenticated using (app.can(null, 'logs.view'));
create policy user_log_read on audit.user_log for select to authenticated using (user_id = (select auth.uid()) or app.can(null, 'logs.view'));
create policy error_log_read on ops.error_log for select to authenticated using (user_id = (select auth.uid()) or app.can(null, 'logs.view'));
-- core.request_log and core.doc_numbers_issued have RLS on and no policies: no direct client access at all.


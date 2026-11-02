-- 20261103001000_masters.sql
-- Phase 2 masters: units, HSN codes and effective-dated GST rates, product groups and products (MRP history,
-- label data, licence, barcode), parties (customers and suppliers, group-level, linked per company) with KYC,
-- contacts, addresses, masked bank accounts with two-person bank-change control, documents, credit terms,
-- price lists, group-level people (one staff list), chart of accounts, bill-wise opening outstanding and
-- posting rules as data. Additive. RLS on every table; writes only through api RPCs.

create extension if not exists pg_trgm with schema extensions;

create schema if not exists master;
create schema if not exists acct;
revoke all on schema master, acct from public, anon;
grant usage on schema master, acct to authenticated;

-- ─────────── Matching helpers (used by KYC duplicate checks and the Tally import) ───────────
-- Normalised name: case, spaces, punctuation, "M/s", Pvt Ltd vs Private Limited, & vs and.
create or replace function app.norm_name(p text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select trim(regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 regexp_replace(lower(coalesce(p, '')), '^\s*m\s*/\s*s\.?\s+', ''),
               '&', ' and ', 'g'),
             '\m(private|pvt)\.?\s*(limited|ltd)\.?', 'pvt ltd', 'g'),
           '[^a-z0-9 ]+', ' ', 'g'),
         '\s+', ' ', 'g'))
$$;

-- GSTIN check digit (mod-36 Luhn variant used by GSTN). True when the 15th character is correct.
create or replace function app.gstin_valid(p text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  chars constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  s text := upper(coalesce(p, ''));
  total int := 0; v int; f int; prod int;
begin
  if s !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then return false; end if;
  for i in 1..14 loop
    v := position(substr(s, i, 1) in chars) - 1;
    f := case when i % 2 = 0 then 2 else 1 end;
    prod := v * f;
    total := total + (prod / 36) + (prod % 36);
  end loop;
  return substr(chars, ((36 - (total % 36)) % 36) + 1, 1) = substr(s, 15, 1);
end $$;

-- ─────────── Units, HSN and rates ───────────
create table master.uoms (
  code text primary key check (code ~ '^[A-Z]{2,6}$'),     -- GST UQC codes
  label text not null,
  decimals int not null default 3 check (decimals between 0 and 3)
);

create table master.hsn_codes (
  code text primary key check (code ~ '^[0-9]{4,8}$'),
  description text not null,
  kind text not null default 'goods' check (kind in ('goods', 'services'))
);

-- Rates come from this table with effective dates, never from code. Entered by Admin, confirmed by the CA.
create table master.hsn_rates (
  id uuid primary key default gen_random_uuid(),
  hsn_code text not null references master.hsn_codes (code),
  rate numeric(9, 4) not null check (rate >= 0 and rate <= 100),
  cess_rate numeric(9, 4) not null default 0 check (cess_rate >= 0),
  tax_class text not null default 'taxable' check (tax_class in ('taxable', 'exempt', 'nil_rated', 'non_gst', 'zero_rated')),
  effective_from date not null,
  effective_to date,
  ca_confirmed boolean not null default false,
  note text,
  set_by uuid references auth.users (id),
  set_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  unique (hsn_code, effective_from)
);
create index on master.hsn_rates (hsn_code, effective_from desc);

-- ─────────── Products ───────────
create table master.product_groups (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references core.companies (id),           -- null = shared item list
  parent_id uuid references master.product_groups (id),
  name text not null,
  kind text not null default 'finished' check (kind in ('finished', 'raw_material', 'packaging', 'component', 'consumable', 'perfumery', 'spares', 'other')),
  tally_name text,
  unique nulls not distinct (company_id, parent_id, name)
);
create index on master.product_groups (company_id);

create table master.products (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9][A-Z0-9._/-]{0,31}$'),
  name text not null,
  name_norm text generated always as (app.norm_name(name)) stored,
  group_id uuid references master.product_groups (id),
  family text,
  kind text not null default 'finished' check (kind in ('finished', 'raw_material', 'packaging', 'component', 'consumable', 'perfumery', 'spares', 'other')),
  hsn_code text references master.hsn_codes (code),
  uom text not null references master.uoms (code),
  net_qty numeric(18, 3) check (net_qty is null or net_qty > 0),
  net_qty_uom text references master.uoms (code),
  pack_size text,
  barcode text unique,
  licence_no text,
  label jsonb not null default '{}'::jsonb,                  -- maker, net quantity text, batch/expiry rules, etc.
  status text not null default 'to_review' check (status in ('to_review', 'active', 'inactive')),
  created_batch_id uuid,
  created_at timestamptz not null default now()
);
create index on master.products (group_id);
create index on master.products using gin (name_norm extensions.gin_trgm_ops);

create table master.product_companies (
  product_id uuid not null references master.products (id) on delete cascade,
  company_id uuid not null references core.companies (id),
  active boolean not null default true,
  primary key (product_id, company_id)
);
create index on master.product_companies (company_id);

-- MRP history (append-only). The current MRP is the latest effective_from <= today.
create table master.product_mrp_history (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references master.products (id),
  mrp numeric(18, 2) not null check (mrp > 0),
  effective_from date not null,
  set_by uuid references auth.users (id),
  set_at timestamptz not null default now(),
  unique (product_id, effective_from)
);

create table master.product_aliases (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references master.products (id) on delete cascade,
  alias text not null,
  alias_norm text generated always as (app.norm_name(alias)) stored,
  source text not null default 'manual',
  unique (product_id, alias_norm)
);
create index on master.product_aliases (alias_norm);

-- ─────────── Parties (customers and suppliers), group-level, linked per company ───────────
create table master.parties (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null check (length(trim(legal_name)) > 1),
  trade_name text,
  name_norm text generated always as (app.norm_name(legal_name)) stored,
  gst_status text not null default 'unregistered' check (gst_status in ('registered', 'unregistered', 'composition', 'overseas', 'sez')),
  gstin char(15) unique check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  pan char(10) check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  state_code char(2),
  is_customer boolean not null default false,
  is_supplier boolean not null default false,
  customer_type text check (customer_type in ('retail_shop', 'wholesale', 'distributor', 'supermarket_chain', 'online_marketplace', 'export_buyer', 'private_label', 'agent', 'own_shop')),
  supplies text,
  msme_category text check (msme_category in ('micro', 'small', 'medium')),
  udyam_no text check (udyam_no is null or udyam_no ~ '^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$'),
  gstin_checked_at timestamptz,
  gstin_check_result text,                                    -- from the GSP check (Phase 8); format check now
  kyc_status text not null default 'draft' check (kyc_status in ('draft', 'review', 'verified', 'rejected')),
  kyc_verified_by uuid references auth.users (id),
  kyc_verified_at timestamptz,
  kyc_refresh_due date,
  status text not null default 'active' check (status in ('active', 'inactive', 'merged')),
  merged_into uuid references master.parties (id),
  created_batch_id uuid,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  check (is_customer or is_supplier),
  check (gstin is null or pan is null or substr(gstin, 3, 10) = pan)
);
create index on master.parties using gin (name_norm extensions.gin_trgm_ops);
create index on master.parties (pan);
create index on master.parties (merged_into);

create table master.party_companies (
  party_id uuid not null references master.parties (id) on delete cascade,
  company_id uuid not null references core.companies (id),
  is_customer boolean not null default false,
  is_supplier boolean not null default false,
  credit_term_id uuid,
  credit_limit numeric(18, 2) check (credit_limit is null or credit_limit >= 0),
  salesman_user_id uuid references auth.users (id),
  beat text,
  tier text,
  tds_section text,                                           -- set by the CA
  active boolean not null default true,
  primary key (party_id, company_id)
);
create index on master.party_companies (company_id);

create table master.party_aliases (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references master.parties (id) on delete cascade,
  alias text not null,
  alias_norm text generated always as (app.norm_name(alias)) stored,
  source text not null default 'manual',
  unique (party_id, alias_norm)
);
create index on master.party_aliases (alias_norm);

create table master.party_contacts (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references master.parties (id) on delete cascade,
  name text not null,
  role text,
  whatsapp char(13) check (whatsapp is null or whatsapp ~ '^\+91[6-9][0-9]{9}$'),
  phone text,
  email text,
  language text not null default 'en' check (language in ('en', 'ml', 'hi', 'bho', 'ta')),
  whatsapp_consent boolean not null default false,
  consent_at timestamptz,
  is_primary boolean not null default false
);
create index on master.party_contacts (party_id);
create index on master.party_contacts (whatsapp);

create table master.party_addresses (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references master.parties (id) on delete cascade,
  kind text not null check (kind in ('billing', 'delivery')),
  line1 text not null,
  line2 text,
  city text,
  state_code char(2),
  pincode char(6) check (pincode is null or pincode ~ '^[1-9][0-9]{5}$'),
  lat numeric(9, 6),
  lng numeric(9, 6)
);
create index on master.party_addresses (party_id);

-- Bank accounts: the full number is readable only through a definer RPC by finance/Admin; lists show ••last 4.
create table master.party_bank_accounts (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references master.parties (id) on delete cascade,
  account_no text not null check (account_no ~ '^[0-9]{6,20}$'),
  account_last4 text generated always as (right(account_no, 4)) stored,
  ifsc char(11) not null check (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  bank_name text,
  verified_by text check (verified_by in ('cancelled_cheque', 'penny_drop')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index on master.party_bank_accounts (party_id);

-- A change of bank account: two-person approval and a logged call-back to a known number (§8A).
create table master.bank_change_requests (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references master.parties (id),
  account_no text not null check (account_no ~ '^[0-9]{6,20}$'),
  ifsc char(11) not null check (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  bank_name text,
  reason text not null,
  requested_by uuid not null references auth.users (id),
  requested_at timestamptz not null default now(),
  callback_by uuid references auth.users (id),
  callback_number text,
  callback_note text,
  callback_at timestamptz,
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'approved', 'refused')),
  check (decided_by is null or decided_by <> requested_by)
);
create index on master.bank_change_requests (party_id);

create table master.party_documents (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references master.parties (id) on delete cascade,
  kind text not null check (kind in ('gst_certificate', 'pan', 'trade_licence', 'shop_photo', 'cancelled_cheque', 'credit_application', 'security_cheque', 'udyam', 'coa', 'msds', 'quality_certificate', 'other')),
  storage_path text not null,
  expires_on date,
  uploaded_by uuid references auth.users (id),
  uploaded_at timestamptz not null default now()
);
create index on master.party_documents (party_id);

create table master.credit_terms (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references core.companies (id),
  code text not null,
  label text not null,
  days int not null check (days >= 0 and days <= 365),
  basis text not null default 'invoice' check (basis in ('invoice', 'delivery')),
  active boolean not null default true,
  unique nulls not distinct (company_id, code)
);
alter table master.party_companies add constraint party_companies_term_fk foreign key (credit_term_id) references master.credit_terms (id);

-- ─────────── Price lists ───────────
create table master.price_lists (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  name text not null,
  kind text not null default 'wholesale' check (kind in ('wholesale', 'retail', 'distributor', 'export', 'online', 'other')),
  tax_inclusive boolean not null default false,
  active boolean not null default true,
  unique (company_id, name)
);
create table master.price_list_items (
  id uuid primary key default gen_random_uuid(),
  price_list_id uuid not null references master.price_lists (id) on delete cascade,
  product_id uuid not null references master.products (id),
  price numeric(18, 2) not null check (price >= 0),
  min_qty numeric(18, 3) not null default 0,
  effective_from date not null,
  set_by uuid references auth.users (id),
  set_at timestamptz not null default now(),
  unique (price_list_id, product_id, min_qty, effective_from)
);
create index on master.price_list_items (product_id);

-- ─────────── People: one group-level staff list (HR details arrive in Phase 3) ───────────
create table master.people (
  id uuid primary key default gen_random_uuid(),
  person_code text unique,
  name text not null,
  name_norm text generated always as (app.norm_name(name)) stored,
  pan char(10) unique check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  phone char(13) check (phone is null or phone ~ '^\+91[6-9][0-9]{9}$'),
  dob date,
  aadhaar_last4 char(4) check (aadhaar_last4 is null or aadhaar_last4 ~ '^[0-9]{4}$'),   -- masked: last 4 only
  user_id uuid unique references auth.users (id),
  status text not null default 'to_review' check (status in ('to_review', 'active', 'left')),
  created_batch_id uuid,
  created_at timestamptz not null default now()
);
create index on master.people (phone);
create table master.person_companies (
  person_id uuid not null references master.people (id) on delete cascade,
  company_id uuid not null references core.companies (id),
  employee_code text,
  is_pay_company boolean not null default false,
  primary key (person_id, company_id),
  unique (company_id, employee_code)
);
create index on master.person_companies (company_id);

-- ─────────── Chart of accounts, opening balances, opening bills, posting rules ───────────
create table acct.account_groups (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  name text not null,
  parent_id uuid references acct.account_groups (id),
  nature text not null check (nature in ('asset', 'liability', 'income', 'expense', 'equity')),
  is_party_group text check (is_party_group in ('debtors', 'creditors')),
  unique (company_id, name)
);
create index on acct.account_groups (company_id);

create table acct.accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  group_id uuid not null references acct.account_groups (id),
  name text not null,
  name_norm text generated always as (app.norm_name(name)) stored,
  party_id uuid references master.parties (id),
  opening_balance numeric(18, 2) not null default 0,
  opening_dc char(1) not null default 'D' check (opening_dc in ('D', 'C')),
  opening_as_of date,
  status text not null default 'to_review' check (status in ('to_review', 'active', 'inactive')),
  created_batch_id uuid,
  unique (company_id, name)
);
create index on acct.accounts (company_id);
create index on acct.accounts (group_id);
create index on acct.accounts (party_id);

-- Bill-wise opening outstanding from Tally. tax_class decides who may see each bill (§6): until Admin classifies
-- a bill it is 'unclassified' and visible only in the Admin and CA views (the safest reading).
create table acct.open_bills (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  account_id uuid not null references acct.accounts (id),
  party_id uuid references master.parties (id),
  bill_ref text not null,
  bill_date date,
  due_date date,
  amount numeric(18, 2) not null check (amount >= 0),
  dc char(1) not null check (dc in ('D', 'C')),
  tax_class text not null default 'unclassified' check (tax_class in ('unclassified', 'taxable', 'exempt', 'nil_rated', 'non_gst', 'zero_rated', 'without_gst')),
  as_of date not null,
  created_batch_id uuid,
  unique (company_id, account_id, bill_ref, as_of)
);
create index on acct.open_bills (company_id);
create index on acct.open_bills (party_id);

create table acct.posting_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  event text not null check (event ~ '^[a-z_.]+$'),          -- e.g. sales.taxable, sales.cgst, purchase.itc_igst
  account_id uuid not null references acct.accounts (id),
  note text,
  unique (company_id, event)
);

-- Visibility for `without_gst` and unclassified opening bills.
create or replace function app.can_see_bill_class(p_tax_class text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_tax_class not in ('without_gst', 'unclassified') or app.current_view() in ('all', 'all-readonly')
$$;

-- Append-only guards
create trigger mrp_append_only before update or delete on master.product_mrp_history for each row execute function app.reject_change();
create trigger hsn_rates_no_delete before delete on master.hsn_rates for each row execute function app.reject_change();

-- History triggers
do $$
declare t text;
begin
  foreach t in array array[
    'master.uoms', 'master.hsn_codes', 'master.hsn_rates', 'master.product_groups', 'master.products', 'master.product_companies',
    'master.product_mrp_history', 'master.product_aliases', 'master.parties', 'master.party_companies', 'master.party_aliases',
    'master.party_contacts', 'master.party_addresses', 'master.party_bank_accounts', 'master.bank_change_requests',
    'master.party_documents', 'master.credit_terms', 'master.price_lists', 'master.price_list_items', 'master.people',
    'master.person_companies', 'acct.account_groups', 'acct.accounts', 'acct.open_bills', 'acct.posting_rules'
  ] loop
    execute format('create trigger audit_row after insert or update or delete on %s for each row execute function app.audit_trigger()', t);
  end loop;
end $$;

-- RLS on, reads only
do $$
declare t record;
begin
  for t in select schemaname, tablename from pg_tables where schemaname in ('master', 'acct') loop
    execute format('alter table %I.%I enable row level security', t.schemaname, t.tablename);
    execute format('revoke all on %I.%I from anon, authenticated', t.schemaname, t.tablename);
    execute format('grant select on %I.%I to authenticated', t.schemaname, t.tablename);
  end loop;
end $$;
-- The full bank account number is never selectable by clients.
revoke select on master.party_bank_accounts from authenticated;
grant select (id, party_id, account_last4, ifsc, bank_name, verified_by, active, created_at) on master.party_bank_accounts to authenticated;
revoke select on master.bank_change_requests from authenticated;
grant select (id, party_id, ifsc, bank_name, reason, requested_by, requested_at, callback_by, callback_note, callback_at, decided_by, decided_at, status) on master.bank_change_requests to authenticated;

-- Party visibility: linked to a company the user can see, with sales or purchase rights there.
create or replace function app.can_see_party(p_party uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.current_view() in ('all', 'all-readonly')
      or exists (select 1 from master.party_companies pc
                 where pc.party_id = p_party
                   and app.can_read_company(pc.company_id)
                   and (app.can(pc.company_id, 'sales.view') or app.can(pc.company_id, 'purchase.view') or app.can(pc.company_id, 'accounts.view')))
$$;

create policy uoms_read on master.uoms for select to authenticated using (true);
create policy hsn_read on master.hsn_codes for select to authenticated using (true);
create policy hsn_rates_read on master.hsn_rates for select to authenticated using (true);
create policy pgroups_read on master.product_groups for select to authenticated using (company_id is null or app.can_read_company(company_id));
create policy products_read on master.products for select to authenticated using (true);
create policy pcompanies_read on master.product_companies for select to authenticated using (app.can_read_company(company_id));
create policy mrp_read on master.product_mrp_history for select to authenticated using (true);
create policy paliases_read on master.product_aliases for select to authenticated using (true);
create policy parties_read on master.parties for select to authenticated using (app.can_see_party(id));
create policy party_companies_read on master.party_companies for select to authenticated using (app.can_see_party(party_id) and app.can_read_company(company_id));
create policy party_aliases_read on master.party_aliases for select to authenticated using (app.can_see_party(party_id));
create policy party_contacts_read on master.party_contacts for select to authenticated using (app.can_see_party(party_id));
create policy party_addresses_read on master.party_addresses for select to authenticated using (app.can_see_party(party_id));
create policy party_banks_read on master.party_bank_accounts for select to authenticated using (app.can_see_party(party_id));
create policy bank_changes_read on master.bank_change_requests for select to authenticated using (app.can_see_party(party_id));
create policy party_docs_read on master.party_documents for select to authenticated using (app.can_see_party(party_id) and app.can(null, 'kyc.view'));
create policy terms_read on master.credit_terms for select to authenticated using (company_id is null or app.can_read_company(company_id));
create policy price_lists_read on master.price_lists for select to authenticated using (app.can_read_company(company_id));
create policy price_items_read on master.price_list_items for select to authenticated
  using (exists (select 1 from master.price_lists l where l.id = price_list_id and app.can_read_company(l.company_id)));
create policy people_read on master.people for select to authenticated using (app.can(null, 'hr.view') or user_id = (select auth.uid()));
create policy person_companies_read on master.person_companies for select to authenticated using (app.can(company_id, 'hr.view'));
create policy acc_groups_read on acct.account_groups for select to authenticated using (app.can(company_id, 'accounts.view'));
create policy accounts_read on acct.accounts for select to authenticated using (app.can(company_id, 'accounts.view'));
create policy open_bills_read on acct.open_bills for select to authenticated
  using (app.can(company_id, 'accounts.view') and app.can_see_bill_class(tax_class));
create policy posting_rules_read on acct.posting_rules for select to authenticated using (app.can(company_id, 'accounts.view'));

revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;

-- ─────────── Configuration seeds (GST UQC codes; standard term lengths; new rights) ───────────
insert into master.uoms (code, label, decimals) values
  ('NOS', 'Numbers', 0), ('PCS', 'Pieces', 0), ('KGS', 'Kilograms', 3), ('GMS', 'Grams', 3), ('LTR', 'Litres', 3),
  ('MLT', 'Millilitres', 3), ('BOX', 'Box', 0), ('BAG', 'Bag', 0), ('CTN', 'Cartons', 0), ('DOZ', 'Dozens', 0),
  ('SET', 'Sets', 0), ('MTR', 'Metres', 3), ('ROL', 'Rolls', 0), ('PAC', 'Packs', 0), ('TON', 'Tonnes', 3), ('OTH', 'Others', 3);

insert into master.credit_terms (company_id, code, label, days, basis) values
  (null, 'CASH', 'Cash', 0, 'invoice'), (null, 'D7', '7 days', 7, 'invoice'), (null, 'D15', '15 days', 15, 'invoice'),
  (null, 'D30', '30 days', 30, 'invoice'), (null, 'D45', '45 days', 45, 'invoice'), (null, 'D60', '60 days', 60, 'invoice');

insert into core.rights (key, module, action, label, hint, kind, admin_only, never_grantable, grantable_by_permission, sort) values
  ('bank_change.approve', 'bank_change', 'approve', 'Approve a party bank-account change', 'Second person, after a call-back to a known number', 'special', false, false, false, 1030),
  ('bank.view_full', 'bank', 'view_full', 'See full bank account numbers', 'Finance only · every view is logged', 'special', false, false, false, 1031),
  ('hsn.manage', 'hsn', 'manage', 'Set HSN codes and GST rates', 'Admin only · the CA confirms every rate', 'special', true, false, false, 1032),
  ('backup.view', 'backup', 'view', 'See backups and restore drills', 'Admin and the CA', 'special', false, false, false, 1033);


-- 20261103002000_accounting.sql
-- Phase 3 accounting core: vouchers and an append-only general ledger posted through posting rules held as data,
-- bill-wise allocations, cash-limit checks (₹2 lakh receipt block, ₹10,000 payment warning — values in settings),
-- period lock and back-dating checks, bank accounts and bank statement lines for reconciliation.
-- Additive. RLS on every table; posting only through api RPCs (next migrations).

-- Account kinds (cash and bank drive the cash book and reconciliation).
alter table acct.accounts add column if not exists kind text not null default 'other'
  check (kind in ('cash', 'bank', 'party', 'tax', 'income', 'expense', 'stock', 'capital', 'other'));

-- Cash limits from AGENTS.md rule 8 / Income-tax Act 2025 s.186 (receipt) and the ₹10,000 payment rule.
-- Kept as settings with an effective date so the CA can confirm or change them; never constants in code.
insert into core.settings (company_id, key, value, effective_from, note) values
  (null, 'cash.receipt_block_amount', '200000'::jsonb, '2026-04-01', 'AGENTS.md rule 8: refuse a cash receipt of ₹2 lakh or more from one person in a day (CA to confirm)'),
  (null, 'cash.payment_warn_amount', '10000'::jsonb, '2026-04-01', 'AGENTS.md rule 8: warn on a cash payment over ₹10,000 to one person in a day (CA to confirm)'),
  (null, 'payroll.ot_multiplier', '2'::jsonb, '2026-04-01', 'Labour codes from 21-Nov-2025: overtime at twice the normal rate (CA to confirm)');

create schema if not exists sales;
create schema if not exists purch;
create schema if not exists hr;
revoke all on schema sales, purch, hr from public, anon;
grant usage on schema sales, purch, hr to authenticated;

-- ─────────── Vouchers and GL ───────────
create table acct.vouchers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  fy_id uuid not null references core.financial_years (id),
  voucher_type text not null check (voucher_type in ('receipt', 'payment', 'journal', 'contra', 'sales', 'purchase', 'credit_note', 'debit_note', 'payroll', 'reversal')),
  doc_no text not null,
  voucher_date date not null,
  party_id uuid references master.parties (id),
  narration text,
  tax_class text not null default 'taxable' check (tax_class in ('taxable', 'without_gst', 'exempt', 'nil_rated', 'non_gst', 'zero_rated', 'unclassified')),
  amount numeric(18, 2) not null check (amount >= 0),
  status text not null default 'posted' check (status in ('posted', 'reversed')),
  reverses_id uuid references acct.vouchers (id),
  reversed_by_id uuid references acct.vouchers (id),
  source_table text,
  source_id uuid,
  mode text check (mode in ('cash', 'bank', 'upi', 'cheque', 'card', 'adjustment')),
  cash_reason text,
  client_request_id uuid not null unique,
  grant_id uuid references core.special_grants (id),
  created_by uuid references auth.users (id),
  posted_at timestamptz not null default now(),
  unique (company_id, voucher_type, doc_no)
);
create index on acct.vouchers (company_id, voucher_date);
create index on acct.vouchers (party_id);
create index on acct.vouchers (source_table, source_id);

create table acct.gl_entries (
  id bigint generated always as identity primary key,
  voucher_id uuid not null references acct.vouchers (id),
  company_id uuid not null references core.companies (id),
  account_id uuid not null references acct.accounts (id),
  party_id uuid references master.parties (id),
  entry_date date not null,
  dr numeric(18, 2) not null default 0 check (dr >= 0),
  cr numeric(18, 2) not null default 0 check (cr >= 0),
  tax_class text not null default 'taxable',
  narration text,
  check (dr = 0 or cr = 0)
);
create index on acct.gl_entries (company_id, account_id, entry_date);
create index on acct.gl_entries (party_id);
create index on acct.gl_entries (voucher_id);

-- Bill-wise allocation of receipts and payments (append-only; reversal adds negative rows).
create table acct.bill_allocations (
  id bigint generated always as identity primary key,
  company_id uuid not null references core.companies (id),
  voucher_id uuid not null references acct.vouchers (id),
  party_id uuid references master.parties (id),
  against_kind text not null check (against_kind in ('open_bill', 'sales_document', 'purchase_bill', 'advance', 'on_account')),
  against_id uuid,
  amount numeric(18, 2) not null,
  created_at timestamptz not null default now()
);
create index on acct.bill_allocations (against_kind, against_id);
create index on acct.bill_allocations (party_id);

create trigger gl_append_only before update or delete on acct.gl_entries for each row execute function app.reject_change();
create trigger gl_no_truncate before truncate on acct.gl_entries for each statement execute function app.reject_change();
create trigger alloc_append_only before update or delete on acct.bill_allocations for each row execute function app.reject_change();
create trigger vouchers_no_delete before delete on acct.vouchers for each row execute function app.reject_change();

-- ─────────── Bank ───────────
create table acct.bank_accounts (
  account_id uuid primary key references acct.accounts (id),
  company_id uuid not null references core.companies (id),
  bank_name text not null,
  account_last4 char(4) not null check (account_last4 ~ '^[0-9]{4}$'),   -- masked; the full number is not needed here
  ifsc char(11) check (ifsc is null or ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  branch text
);
create index on acct.bank_accounts (company_id);

-- Statement lines imported from the bank's CSV/Excel (passwords for protected files are typed each time, never stored).
create table acct.bank_statement_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  account_id uuid not null references acct.accounts (id),
  txn_date date not null,
  description text,
  ref text,
  amount numeric(18, 2) not null,                            -- + money in, − money out
  balance numeric(18, 2),
  line_hash text not null,
  import_ref text,
  matched_voucher_id uuid references acct.vouchers (id),
  matched_by uuid references auth.users (id),
  matched_at timestamptz,
  status text not null default 'unmatched' check (status in ('unmatched', 'matched', 'ignored')),
  unique (account_id, line_hash)
);
create index on acct.bank_statement_lines (account_id, txn_date);

do $$
declare t text;
begin
  foreach t in array array['acct.vouchers', 'acct.bank_accounts', 'acct.bank_statement_lines'] loop
    execute format('create trigger audit_row after insert or update or delete on %s for each row execute function app.audit_trigger()', t);
  end loop;
  foreach t in array array['vouchers', 'gl_entries', 'bill_allocations', 'bank_accounts', 'bank_statement_lines'] loop
    execute format('alter table acct.%I enable row level security', t);
    execute format('revoke all on acct.%I from anon, authenticated', t);
    execute format('grant select on acct.%I to authenticated', t);
  end loop;
end $$;

create policy vouchers_read on acct.vouchers for select to authenticated using (app.can(company_id, 'accounts.view') and app.can_see_bill_class(tax_class) or (app.can(company_id, 'cash_book.view') and mode = 'cash' and app.can_see_bill_class(tax_class)));
create policy gl_read on acct.gl_entries for select to authenticated using (app.can(company_id, 'accounts.view') and app.can_see_bill_class(tax_class));
create policy alloc_read on acct.bill_allocations for select to authenticated using (app.can(company_id, 'accounts.view'));
create policy bank_accounts_read on acct.bank_accounts for select to authenticated using (app.can(company_id, 'accounts.view'));
create policy bank_lines_read on acct.bank_statement_lines for select to authenticated using (app.can(company_id, 'accounts.view'));

-- ─────────── Posting helpers ───────────
-- The open financial year and period for a date; refuses closed periods unless a reopen grant runs.
create or replace function app.fy_for(p_company uuid, p_date date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_fy uuid; v_period text; v_grant uuid;
begin
  select id into v_fy from core.financial_years where company_id = p_company and p_date between starts_on and ends_on;
  if v_fy is null then perform app.raise_rule('period.no_fy', 'no financial year is open for this date; open it on Settings', '22023'); end if;
  select status into v_period from core.periods where company_id = p_company and month_start = date_trunc('month', p_date)::date;
  if v_period = 'closed' then
    v_grant := app.active_grant('period.reopen', p_company);
    if v_grant is null then perform app.raise_rule('period.closed', 'this month is closed; ask Admin for a "Reopen a closed day or month" permission', '42501'); end if;
    perform app.use_grant(v_grant, jsonb_build_object('reason', 'posting into a closed period', 'date', p_date));
  end if;
  return v_fy;
end $$;

-- Back-dating: entries older than `entries.backdate_days` (if set) need the entries.backdate permission.
create or replace function app.check_backdate(p_company uuid, p_date date) returns void
language plpgsql security definer set search_path = '' as $$
declare v_days int := nullif(app.setting(p_company, 'entries.backdate_days')::text, 'null')::int; v_grant uuid;
begin
  if p_date > current_date then perform app.raise_rule('date.future', 'the date is in the future', '22023'); end if;
  if v_days is null or app.is_admin() then return; end if;
  if p_date < current_date - v_days then
    v_grant := app.active_grant('entries.backdate', p_company);
    if v_grant is null then perform app.raise_rule('entries.backdate', 'this date is older than allowed; ask Admin for a "Back-date entries" permission', '42501'); end if;
    perform app.use_grant(v_grant, jsonb_build_object('reason', 'back-dated entry', 'date', p_date));
  end if;
end $$;

-- Account for a posting event (posting rules are data). Refuses with the missing event so Admin can set it.
create or replace function app.rule_account(p_company uuid, p_event text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v uuid;
begin
  select account_id into v from acct.posting_rules where company_id = p_company and event = p_event;
  if v is null then perform app.raise_rule('posting.rule_missing', 'set the posting rule "' || p_event || '" on Accounts → Posting rules', '22023'); end if;
  return v;
end $$;

-- The party's ledger account in a company, created under the debtors/creditors group on first use.
create or replace function app.party_account(p_company uuid, p_party uuid, p_side text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v uuid; v_group uuid; v_name text;
begin
  select id into v from acct.accounts where company_id = p_company and party_id = p_party order by (status = 'active') desc limit 1;
  if v is not null then return v; end if;
  select id into v_group from acct.account_groups where company_id = p_company and is_party_group = p_side order by name limit 1;
  if v_group is null then perform app.raise_rule('posting.no_party_group', 'add an account group marked ' || p_side || ' on Tally books → Chart of accounts', '22023'); end if;
  select legal_name into v_name from master.parties where id = p_party;
  insert into acct.accounts (company_id, group_id, name, party_id, status, kind) values (p_company, v_group, v_name, p_party, 'active', 'party')
  on conflict (company_id, name) do update set party_id = excluded.party_id returning id into v;
  return v;
end $$;

-- Write a balanced voucher with its GL lines. lines: [{account_id, party_id, dr, cr, narration}]
create or replace function app.post_voucher(p_header jsonb, p_lines jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_dr numeric := 0; v_cr numeric := 0; l jsonb; v_company uuid := (p_header ->> 'company_id')::uuid; v_date date := (p_header ->> 'voucher_date')::date;
begin
  for l in select * from jsonb_array_elements(p_lines) loop
    v_dr := v_dr + coalesce((l ->> 'dr')::numeric, 0);
    v_cr := v_cr + coalesce((l ->> 'cr')::numeric, 0);
  end loop;
  if round(v_dr, 2) <> round(v_cr, 2) or v_dr = 0 then
    perform app.raise_rule('posting.unbalanced', 'debits and credits must be equal', 'P0001');
  end if;
  insert into acct.vouchers (company_id, fy_id, voucher_type, doc_no, voucher_date, party_id, narration, tax_class, amount, source_table, source_id, mode, cash_reason,
                             client_request_id, grant_id, created_by, reverses_id)
  values (v_company, (p_header ->> 'fy_id')::uuid, p_header ->> 'voucher_type', p_header ->> 'doc_no', v_date, nullif(p_header ->> 'party_id', '')::uuid,
          p_header ->> 'narration', coalesce(p_header ->> 'tax_class', 'taxable'), round(v_dr, 2), p_header ->> 'source_table', nullif(p_header ->> 'source_id', '')::uuid,
          p_header ->> 'mode', p_header ->> 'cash_reason', (p_header ->> 'client_request_id')::uuid, nullif(current_setting('app.grant_id', true), '')::uuid, auth.uid(),
          nullif(p_header ->> 'reverses_id', '')::uuid)
  returning id into v_id;
  insert into acct.gl_entries (voucher_id, company_id, account_id, party_id, entry_date, dr, cr, tax_class, narration)
  select v_id, v_company, (e ->> 'account_id')::uuid, nullif(e ->> 'party_id', '')::uuid, v_date, round(coalesce((e ->> 'dr')::numeric, 0), 2), round(coalesce((e ->> 'cr')::numeric, 0), 2),
         coalesce(p_header ->> 'tax_class', 'taxable'), e ->> 'narration'
  from jsonb_array_elements(p_lines) e
  where coalesce((e ->> 'dr')::numeric, 0) <> 0 or coalesce((e ->> 'cr')::numeric, 0) <> 0;
  return v_id;
end $$;

-- A reversal voucher: same lines with Dr and Cr swapped, linked both ways. Posted vouchers are never edited.
create or replace function app.reverse_voucher(p_voucher uuid, p_crid uuid, p_reason text, p_date date default current_date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v acct.vouchers; v_new uuid; v_fy uuid;
begin
  select * into v from acct.vouchers where id = p_voucher for update;
  if v.status = 'reversed' then perform app.raise_rule('posting.already_reversed', 'already reversed', '22023'); end if;
  v_fy := app.fy_for(v.company_id, p_date);
  insert into acct.vouchers (company_id, fy_id, voucher_type, doc_no, voucher_date, party_id, narration, tax_class, amount, source_table, source_id, mode, client_request_id, created_by, reverses_id)
  values (v.company_id, v_fy, 'reversal', 'REV/' || v.doc_no, p_date, v.party_id, 'Reversal of ' || v.doc_no || ': ' || p_reason, v.tax_class, v.amount, v.source_table, v.source_id, v.mode, p_crid, auth.uid(), v.id)
  returning id into v_new;
  insert into acct.gl_entries (voucher_id, company_id, account_id, party_id, entry_date, dr, cr, tax_class, narration)
  select v_new, company_id, account_id, party_id, p_date, cr, dr, tax_class, 'Reversal' from acct.gl_entries where voucher_id = v.id;
  insert into acct.bill_allocations (company_id, voucher_id, party_id, against_kind, against_id, amount)
  select company_id, v_new, party_id, against_kind, against_id, -amount from acct.bill_allocations where voucher_id = v.id;
  update acct.vouchers set status = 'reversed', reversed_by_id = v_new where id = v.id;
  return v_new;
end $$;

-- Cash limits per person per day (§17). Receipts at or above the block amount are refused; payments above the warn
-- amount need a reason (Admin sees it). Returns the warning text when a payment is over the limit with a reason.
create or replace function app.cash_check(p_company uuid, p_party uuid, p_date date, p_amount numeric, p_direction text, p_reason text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_block numeric := (app.setting(p_company, 'cash.receipt_block_amount', p_date))::text::numeric;
        v_warn numeric := (app.setting(p_company, 'cash.payment_warn_amount', p_date))::text::numeric; v_today numeric;
begin
  if p_party is null then return null; end if;
  if p_direction = 'receipt' then
    if v_block is null then perform app.raise_rule('cash.limits_not_set', 'set the cash receipt limit on Settings first', '22023'); end if;
    select coalesce(sum(v.amount), 0) into v_today from acct.vouchers v
     where v.company_id = p_company and v.party_id = p_party and v.voucher_date = p_date and v.voucher_type = 'receipt' and v.mode = 'cash' and v.status = 'posted';
    if v_today + p_amount >= v_block then
      perform app.raise_rule('cash.receipt_blocked', 'this takes the party to the cash receipt limit for the day; take it by bank transfer', '42501');
    end if;
  else
    if v_warn is null then perform app.raise_rule('cash.limits_not_set', 'set the cash payment limit on Settings first', '22023'); end if;
    select coalesce(sum(v.amount), 0) into v_today from acct.vouchers v
     where v.company_id = p_company and v.party_id = p_party and v.voucher_date = p_date and v.voucher_type = 'payment' and v.mode = 'cash' and v.status = 'posted';
    if v_today + p_amount > v_warn then
      if coalesce(length(trim(p_reason)), 0) < 5 then
        perform app.raise_rule('cash.payment_over_limit', 'cash over the daily limit to one person is not deductible; pay by bank, or give a reason Admin will see', '22023');
      end if;
      return 'over_limit';
    end if;
  end if;
  return null;
end $$;

-- Amount in words (Indian system: crore, lakh, thousand, hundred) for documents.
create or replace function app.words_below_100(n int) returns text
language sql immutable set search_path = '' as $$
  select case when n < 20 then (array['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'])[n + 1]
              else (array['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'])[(n / 10) + 1]
                   || case when n % 10 > 0 then ' ' || (array['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'])[(n % 10) + 1] else '' end end
$$;

create or replace function app.words_int(n bigint) returns text
language plpgsql immutable set search_path = '' as $$
declare out text := '';
begin
  if n = 0 then return 'Zero'; end if;
  if n >= 10000000 then out := app.words_int(n / 10000000) || ' Crore'; n := n % 10000000; end if;
  if n >= 100000 then out := trim(out || ' ' || app.words_below_100((n / 100000)::int) || ' Lakh'); n := n % 100000; end if;
  if n >= 1000 then out := trim(out || ' ' || app.words_below_100((n / 1000)::int) || ' Thousand'); n := n % 1000; end if;
  if n >= 100 then out := trim(out || ' ' || app.words_below_100((n / 100)::int) || ' Hundred'); n := n % 100; end if;
  if n > 0 then out := trim(out || ' ' || app.words_below_100(n::int)); end if;
  return out;
end $$;

create or replace function app.amount_in_words(p numeric) returns text
language sql immutable set search_path = '' as $$
  select 'Rupees ' || app.words_int(floor(abs(p))::bigint)
         || case when round((abs(p) - floor(abs(p))) * 100) > 0 then ' and ' || app.words_below_100(round((abs(p) - floor(abs(p))) * 100)::int) || ' Paise' else '' end
         || ' Only'
$$;

revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;

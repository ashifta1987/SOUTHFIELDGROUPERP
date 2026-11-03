-- 20261103002300_money_reports.sql
-- Phase 3: receipts and payments allocated bill by bill (cash limits enforced), journal and contra vouchers,
-- reversal, posting-rule and cash/bank account set-up, bank statement import and matching, and the books:
-- day book, cash book, party ledger, general ledger, trial balance, receivables/payables ageing (MSME flagged),
-- statement of account. Every read follows RLS and the view rule. Additive.

-- ─────────── Set-up ───────────
create or replace function api.set_posting_rule(p_client_request_id uuid, p_company_id uuid, p_event text, p_account_id uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_posting_rule'); if v_prev is not null then return v_prev; end if;
  perform app.require(p_company_id, 'settings.manage');
  if not exists (select 1 from acct.accounts where id = p_account_id and company_id = p_company_id) then perform app.raise_rule('org.company_missing', 'the account belongs to another company', '22023'); end if;
  insert into acct.posting_rules (company_id, event, account_id, note) values (p_company_id, p_event, p_account_id, p_note)
  on conflict (company_id, event) do update set account_id = excluded.account_id, note = excluded.note;
  perform app.log_event('setting_changed', jsonb_build_object('entity', 'posting_rule', 'event', p_event, 'company_id', p_company_id));
  v_res := jsonb_build_object('ok', true);
  return app.request_done(p_client_request_id, 'set_posting_rule', v_res);
end $$;

-- Create a cash or bank account (bank: masked number only).
create or replace function api.add_money_account(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid; v_company uuid := (p ->> 'company_id')::uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'add_money_account'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'settings.manage');
  insert into acct.accounts (company_id, group_id, name, kind, status, opening_balance, opening_dc, opening_as_of)
  values (v_company, (p ->> 'group_id')::uuid, p ->> 'name', p ->> 'kind', 'active', coalesce((p ->> 'opening_balance')::numeric, 0), coalesce(p ->> 'opening_dc', 'D'), nullif(p ->> 'opening_as_of', '')::date)
  returning id into v_id;
  if p ->> 'kind' = 'bank' then
    insert into acct.bank_accounts (account_id, company_id, bank_name, account_last4, ifsc, branch)
    values (v_id, v_company, p ->> 'bank_name', right(regexp_replace(p ->> 'account_last4', '\D', '', 'g'), 4), nullif(upper(p ->> 'ifsc'), ''), nullif(p ->> 'branch', ''));
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'add_money_account', v_res);
end $$;

-- ─────────── Receipts and payments ───────────
-- p: {company_id, party_id, date, mode cash|bank|upi|cheque|card, account_id (cash or bank account), amount,
--     allocations: [{kind open_bill|sales_document|purchase_bill, id, amount}], narration, cash_reason}
create or replace function app.post_money(p_crid uuid, p jsonb, p_direction text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := (p ->> 'company_id')::uuid; v_party uuid := nullif(p ->> 'party_id', '')::uuid; v_date date := (p ->> 'date')::date; v_amount numeric := round((p ->> 'amount')::numeric, 2);
  v_mode text := coalesce(p ->> 'mode', 'cash'); v_acc acct.accounts; v_fy uuid; v_no text; v_voucher uuid; v_party_acc uuid; v_alloc jsonb; v_alloc_total numeric := 0;
  v_warn text; v_open numeric; v_side text; v_partyrec master.parties; v_company_name text;
begin
  if v_amount is null or v_amount <= 0 then perform app.raise_rule('money.amount', 'the amount must be above zero', '22023'); end if;
  perform app.require(v_company, case when v_mode = 'cash' then 'cash_book.create' else 'receipts_payments.create' end);
  perform app.check_backdate(v_company, v_date);
  v_fy := app.fy_for(v_company, v_date);
  select * into v_acc from acct.accounts where id = (p ->> 'account_id')::uuid and company_id = v_company;
  if v_acc.id is null or v_acc.kind not in ('cash', 'bank') then perform app.raise_rule('money.account', 'choose the cash or bank account', '22023'); end if;
  if v_mode = 'cash' and v_acc.kind <> 'cash' then perform app.raise_rule('money.account', 'a cash entry uses a cash account', '22023'); end if;
  if v_mode <> 'cash' and v_acc.kind <> 'bank' then perform app.raise_rule('money.account', 'a bank, UPI, cheque or card entry uses a bank account', '22023'); end if;
  if v_mode = 'cash' then
    v_warn := app.cash_check(v_company, v_party, v_date, v_amount, p_direction, p ->> 'cash_reason');
  end if;
  v_side := case when p_direction = 'receipt' then 'debtors' else 'creditors' end;
  select * into v_partyrec from master.parties where id = v_party;
  if v_party is not null then
    if v_partyrec.is_customer and p_direction = 'receipt' then v_side := 'debtors';
    elsif v_partyrec.is_supplier and p_direction = 'payment' then v_side := 'creditors';
    elsif v_partyrec.is_customer then v_side := 'debtors'; else v_side := 'creditors'; end if;
    v_party_acc := app.party_account(v_company, v_party, v_side);
  else
    v_party_acc := (p ->> 'counter_account_id')::uuid;
    if v_party_acc is null then perform app.raise_rule('money.counter', 'choose the party or the account', '22023'); end if;
  end if;
  v_no := app.take_doc_number(v_company, null, p_direction, v_fy);
  v_voucher := app.post_voucher(jsonb_build_object('company_id', v_company, 'fy_id', v_fy, 'voucher_type', p_direction, 'doc_no', v_no, 'voucher_date', v_date,
      'party_id', v_party, 'narration', p ->> 'narration', 'mode', v_mode, 'cash_reason', case when v_warn is not null then p ->> 'cash_reason' end, 'client_request_id', p_crid),
    case when p_direction = 'receipt'
      then jsonb_build_array(jsonb_build_object('account_id', v_acc.id, 'dr', v_amount), jsonb_build_object('account_id', v_party_acc, 'party_id', v_party, 'cr', v_amount))
      else jsonb_build_array(jsonb_build_object('account_id', v_party_acc, 'party_id', v_party, 'dr', v_amount), jsonb_build_object('account_id', v_acc.id, 'cr', v_amount)) end);
  -- Bill-wise allocation: each against an open amount; the rest stays on account (advance).
  for v_alloc in select * from jsonb_array_elements(coalesce(p -> 'allocations', '[]'::jsonb)) loop
    if coalesce((v_alloc ->> 'amount')::numeric, 0) <= 0 then continue; end if;
    v_open := app.open_amount(v_alloc ->> 'kind', (v_alloc ->> 'id')::uuid);
    if (v_alloc ->> 'amount')::numeric > v_open + 0.005 then perform app.raise_rule('money.over_allocated', 'an allocation is more than the bill still owes', '22023'); end if;
    v_alloc_total := v_alloc_total + (v_alloc ->> 'amount')::numeric;
    insert into acct.bill_allocations (company_id, voucher_id, party_id, against_kind, against_id, amount)
    values (v_company, v_voucher, v_party, v_alloc ->> 'kind', (v_alloc ->> 'id')::uuid, (v_alloc ->> 'amount')::numeric);
  end loop;
  if v_alloc_total > v_amount + 0.005 then perform app.raise_rule('money.over_allocated', 'allocations are more than the amount', '22023'); end if;
  if v_amount - v_alloc_total > 0.005 then
    insert into acct.bill_allocations (company_id, voucher_id, party_id, against_kind, amount) values (v_company, v_voucher, v_party, 'on_account', v_amount - v_alloc_total);
  end if;
  if v_warn is not null then
    perform app.log_event('admin_action', jsonb_build_object('entity', 'cash_payment_over_limit', 'voucher', v_no, 'reason', p ->> 'cash_reason'));
  end if;
  if p_direction = 'receipt' and v_party is not null then
    select short_name into v_company_name from core.companies where id = v_company;
    perform app.enqueue_message(jsonb_build_object('company_id', v_company, 'event', 'sales.payment_received', 'template', 'payment_received', 'party_id', v_party,
      'doc_type', 'acct.vouchers', 'doc_id', v_voucher, 'stage', 'posted',
      'params', jsonb_build_object('customer', v_partyrec.legal_name, 'amount', v_amount, 'doc_no', v_no, 'company', v_company_name)));
  end if;
  return jsonb_build_object('voucher_id', v_voucher, 'doc_no', v_no, 'warning', v_warn, 'on_account', v_amount - v_alloc_total);
end $$;

-- What a bill still owes (sales documents and opening bills; purchase bills for payments).
create or replace function app.open_amount(p_kind text, p_id uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select case p_kind
    when 'sales_document' then (select d.total from sales.documents d where d.id = p_id and d.status = 'posted' and d.doc_type in ('sales_invoice', 'bill_of_supply'))
    when 'purchase_bill' then (select b.total from purch.bills b where b.id = p_id and b.status = 'posted')
    when 'open_bill' then (select o.amount from acct.open_bills o where o.id = p_id)
  end - coalesce((select sum(a.amount) from acct.bill_allocations a where a.against_kind = p_kind and a.against_id = p_id), 0)
$$;

create or replace function api.post_receipt(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'post_receipt'); if v_prev is not null then return v_prev; end if;
  v_res := app.post_money(p_client_request_id, p, 'receipt');
  return app.request_done(p_client_request_id, 'post_receipt', v_res);
end $$;

create or replace function api.post_payment(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'post_payment'); if v_prev is not null then return v_prev; end if;
  v_res := app.post_money(p_client_request_id, p, 'payment');
  return app.request_done(p_client_request_id, 'post_payment', v_res);
end $$;

-- Journal (lines: [{account_id, party_id, dr, cr, narration}]) and contra (cash ↔ bank).
create or replace function api.post_journal(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_date date := (p ->> 'date')::date; v_fy uuid; v_no text; v_id uuid; v_type text := coalesce(p ->> 'type', 'journal'); v_res jsonb; v_bad int;
begin
  v_prev := app.request_seen(p_client_request_id, 'post_journal'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'accounts.create');
  if v_type not in ('journal', 'contra') then perform app.raise_rule('money.type', 'journal or contra', '22023'); end if;
  select count(*) into v_bad from jsonb_array_elements(p -> 'lines') e left join acct.accounts a on a.id = (e ->> 'account_id')::uuid
   where a.company_id is distinct from v_company or (v_type = 'contra' and a.kind not in ('cash', 'bank'));
  if v_bad > 0 then perform app.raise_rule('money.account', case when v_type = 'contra' then 'a contra moves money between cash and bank accounts only' else 'every line needs an account of this company' end, '22023'); end if;
  perform app.check_backdate(v_company, v_date);
  v_fy := app.fy_for(v_company, v_date);
  v_no := app.take_doc_number(v_company, null, v_type, v_fy);
  v_id := app.post_voucher(jsonb_build_object('company_id', v_company, 'fy_id', v_fy, 'voucher_type', v_type, 'doc_no', v_no, 'voucher_date', v_date, 'narration', p ->> 'narration',
                                              'client_request_id', p_client_request_id), p -> 'lines');
  v_res := jsonb_build_object('voucher_id', v_id, 'doc_no', v_no);
  return app.request_done(p_client_request_id, 'post_journal', v_res);
end $$;

create or replace function api.reverse_voucher(p_client_request_id uuid, p_voucher_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v acct.vouchers; v_new uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'reverse_voucher'); if v_prev is not null then return v_prev; end if;
  select * into v from acct.vouchers where id = p_voucher_id;
  perform app.require(v.company_id, 'accounts.cancel');
  if v.source_table = 'sales.documents' then perform app.raise_rule('posting.use_document', 'cancel the sales document instead', '22023'); end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'reason required', '22023'); end if;
  v_new := app.reverse_voucher(p_voucher_id, p_client_request_id, p_reason);
  v_res := jsonb_build_object('reversal_id', v_new);
  return app.request_done(p_client_request_id, 'reverse_voucher', v_res);
end $$;

-- ─────────── Bank statements and reconciliation ───────────
-- Lines: [{date, description, ref, amount (+in, −out), balance}] — the file password (if any) is used only in the browser.
create or replace function api.import_bank_lines(p_account_id uuid, p_lines jsonb, p_import_ref text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_company uuid; v_new int;
begin
  select company_id into v_company from acct.bank_accounts where account_id = p_account_id;
  if v_company is null then perform app.raise_rule('money.account', 'choose a bank account', '22023'); end if;
  perform app.require(v_company, 'receipts_payments.create');
  insert into acct.bank_statement_lines (company_id, account_id, txn_date, description, ref, amount, balance, line_hash, import_ref)
  select v_company, p_account_id, (e ->> 'date')::date, e ->> 'description', e ->> 'ref', (e ->> 'amount')::numeric, nullif(e ->> 'balance', '')::numeric,
         md5(concat_ws('|', e ->> 'date', e ->> 'description', e ->> 'ref', e ->> 'amount', e ->> 'balance')), p_import_ref
  from jsonb_array_elements(p_lines) e
  on conflict (account_id, line_hash) do nothing;
  get diagnostics v_new = row_count;
  return jsonb_build_object('added', v_new, 'skipped', jsonb_array_length(p_lines) - v_new);
end $$;

-- Candidate vouchers for a statement line: same bank account, same amount, within 7 days.
create or replace function api.bank_match_candidates(p_line_id uuid) returns table (voucher_id uuid, doc_no text, voucher_date date, voucher_type text, party_name text, amount numeric)
language sql stable security definer set search_path = '' as $$
  select v.id, v.doc_no, v.voucher_date, v.voucher_type, p.legal_name, v.amount
  from acct.bank_statement_lines l
  join acct.gl_entries g on g.account_id = l.account_id and ((l.amount > 0 and g.dr = l.amount) or (l.amount < 0 and g.cr = -l.amount))
  join acct.vouchers v on v.id = g.voucher_id and v.status = 'posted'
  left join master.parties p on p.id = v.party_id
  where l.id = p_line_id and abs(v.voucher_date - l.txn_date) <= 7 and app.can(l.company_id, 'accounts.view')
    and not exists (select 1 from acct.bank_statement_lines m where m.matched_voucher_id = v.id)
  order by abs(v.voucher_date - l.txn_date)
  limit 10
$$;

create or replace function api.match_bank_line(p_client_request_id uuid, p_line_id uuid, p_voucher_id uuid, p_ignore boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; l acct.bank_statement_lines; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'match_bank_line'); if v_prev is not null then return v_prev; end if;
  select * into l from acct.bank_statement_lines where id = p_line_id for update;
  perform app.require(l.company_id, 'receipts_payments.create');
  if coalesce(p_ignore, false) then
    update acct.bank_statement_lines set status = 'ignored', matched_by = auth.uid(), matched_at = now() where id = l.id;
  else
    if not exists (select 1 from acct.gl_entries g where g.voucher_id = p_voucher_id and g.account_id = l.account_id and ((l.amount > 0 and g.dr = l.amount) or (l.amount < 0 and g.cr = -l.amount))) then
      perform app.raise_rule('bank.no_match', 'this voucher does not move the same amount through this bank account', '22023');
    end if;
    update acct.bank_statement_lines set status = 'matched', matched_voucher_id = p_voucher_id, matched_by = auth.uid(), matched_at = now() where id = l.id;
  end if;
  v_res := jsonb_build_object('id', l.id);
  return app.request_done(p_client_request_id, 'match_bank_line', v_res);
end $$;

-- ─────────── Views: books and outstanding ───────────
create or replace view api.money_accounts with (security_invoker = true) as
select a.id, a.company_id, a.name, a.kind, a.group_id, b.bank_name, case when b.account_last4 is null then null else '••' || b.account_last4 end as account_masked, b.ifsc,
       a.opening_balance, a.opening_dc
from acct.accounts a left join acct.bank_accounts b on b.account_id = a.id
where a.kind in ('cash', 'bank') and a.status = 'active';

create or replace view api.vouchers with (security_invoker = true) as
select v.id, v.company_id, v.voucher_type, v.doc_no, v.voucher_date, v.party_id, p.legal_name as party_name, v.narration, v.tax_class, v.amount, v.status, v.mode, v.cash_reason,
       v.reverses_id, v.reversed_by_id, v.source_table, v.source_id, v.grant_id, g.code as grant_code, v.posted_at, u.display_name as posted_by_name
from acct.vouchers v left join master.parties p on p.id = v.party_id left join core.special_grants g on g.id = v.grant_id left join core.user_profiles u on u.user_id = v.created_by;

create or replace view api.gl_lines with (security_invoker = true) as
select e.id, e.voucher_id, v.doc_no, v.voucher_type, e.company_id, e.account_id, a.name as account_name, e.party_id, e.entry_date, e.dr, e.cr, e.tax_class, coalesce(e.narration, v.narration) as narration
from acct.gl_entries e join acct.vouchers v on v.id = e.voucher_id join acct.accounts a on a.id = e.account_id;

-- Receivables: posted invoices / bills of supply and opening bills, with what is still open and the ageing bucket.
create or replace view api.receivables with (security_invoker = true) as
select 'sales_document'::text as kind, d.id, d.company_id, d.party_id, p.legal_name as party_name, d.doc_no as bill_ref, d.doc_date as bill_date, d.due_date, d.total as amount,
       d.total - coalesce((select sum(a.amount) from acct.bill_allocations a where a.against_kind = 'sales_document' and a.against_id = d.id), 0) as open_amount,
       d.tax_class,
       case when d.due_date is null or d.due_date >= current_date then 'not_due' when current_date - d.due_date <= 30 then '0-30' when current_date - d.due_date <= 60 then '31-60'
            when current_date - d.due_date <= 90 then '61-90' else '90+' end as bucket,
       greatest(current_date - d.due_date, 0) as days_overdue
from sales.documents d join master.parties p on p.id = d.party_id
where d.status = 'posted' and d.doc_type in ('sales_invoice', 'bill_of_supply')
union all
select 'open_bill', o.id, o.company_id, o.party_id, p.legal_name, o.bill_ref, o.bill_date, coalesce(o.due_date, o.bill_date), o.amount,
       o.amount - coalesce((select sum(a.amount) from acct.bill_allocations a where a.against_kind = 'open_bill' and a.against_id = o.id), 0),
       o.tax_class,
       case when coalesce(o.due_date, o.bill_date) is null or coalesce(o.due_date, o.bill_date) >= current_date then 'not_due'
            when current_date - coalesce(o.due_date, o.bill_date) <= 30 then '0-30' when current_date - coalesce(o.due_date, o.bill_date) <= 60 then '31-60'
            when current_date - coalesce(o.due_date, o.bill_date) <= 90 then '61-90' else '90+' end,
       greatest(current_date - coalesce(o.due_date, o.bill_date), 0)
from acct.open_bills o left join master.parties p on p.id = o.party_id
where o.dc = 'D';

create or replace view api.payables with (security_invoker = true) as
select 'purchase_bill'::text as kind, b.id, b.company_id, b.party_id, p.legal_name as party_name, p.msme_category, b.supplier_bill_no as bill_ref, b.supplier_bill_date as bill_date, b.due_date,
       b.total as amount, b.total - coalesce((select sum(a.amount) from acct.bill_allocations a where a.against_kind = 'purchase_bill' and a.against_id = b.id), 0) as open_amount,
       b.msme_due, greatest(current_date - b.due_date, 0) as days_overdue
from purch.bills b join master.parties p on p.id = b.party_id where b.status = 'posted'
union all
select 'open_bill', o.id, o.company_id, o.party_id, p.legal_name, p.msme_category, o.bill_ref, o.bill_date, coalesce(o.due_date, o.bill_date), o.amount,
       o.amount - coalesce((select sum(a.amount) from acct.bill_allocations a where a.against_kind = 'open_bill' and a.against_id = o.id), 0),
       p.msme_category in ('micro', 'small'), greatest(current_date - coalesce(o.due_date, o.bill_date), 0)
from acct.open_bills o left join master.parties p on p.id = o.party_id where o.dc = 'C';

create or replace view api.bank_lines with (security_invoker = true) as
select l.id, l.company_id, l.account_id, l.txn_date, l.description, l.ref, l.amount, l.balance, l.status, l.matched_voucher_id, v.doc_no as matched_doc_no, l.matched_at
from acct.bank_statement_lines l left join acct.vouchers v on v.id = l.matched_voucher_id;

-- Trial balance for a company and period (opening balances + movements). Runs as the caller (RLS applies).
create or replace function api.trial_balance(p_company_id uuid, p_from date, p_to date) returns table (account_id uuid, account_name text, group_name text, nature text, opening numeric, dr numeric, cr numeric, closing numeric)
language sql stable security invoker set search_path = '' as $$
  select a.id, a.name, g.name, g.nature,
         (case when a.opening_dc = 'D' then a.opening_balance else -a.opening_balance end) + coalesce((select sum(e.dr - e.cr) from acct.gl_entries e where e.account_id = a.id and e.entry_date < p_from), 0),
         coalesce((select sum(e.dr) from acct.gl_entries e where e.account_id = a.id and e.entry_date between p_from and p_to), 0),
         coalesce((select sum(e.cr) from acct.gl_entries e where e.account_id = a.id and e.entry_date between p_from and p_to), 0),
         (case when a.opening_dc = 'D' then a.opening_balance else -a.opening_balance end) + coalesce((select sum(e.dr - e.cr) from acct.gl_entries e where e.account_id = a.id and e.entry_date <= p_to), 0)
  from acct.accounts a join acct.account_groups g on g.id = a.group_id
  where a.company_id = p_company_id
  order by g.nature, g.name, a.name
$$;

-- Ledger of one account (running balance), as the caller.
create or replace function api.account_ledger(p_account_id uuid, p_from date, p_to date) returns table (entry_date date, doc_no text, voucher_type text, narration text, dr numeric, cr numeric, balance numeric, voucher_id uuid)
language sql stable security invoker set search_path = '' as $$
  with opening as (
    select (case when a.opening_dc = 'D' then a.opening_balance else -a.opening_balance end) + coalesce((select sum(e.dr - e.cr) from acct.gl_entries e where e.account_id = a.id and e.entry_date < p_from), 0) as ob
    from acct.accounts a where a.id = p_account_id)
  select null::date, null::text, 'opening'::text, 'Opening balance'::text, null::numeric, null::numeric, (select ob from opening), null::uuid
  union all
  select x.entry_date, x.doc_no, x.voucher_type, x.narration, x.dr, x.cr,
         (select ob from opening) + sum(x.dr - x.cr) over (order by x.entry_date, x.id), x.voucher_id
  from (select e.id, e.entry_date, v.doc_no, v.voucher_type, coalesce(e.narration, v.narration) as narration, e.dr, e.cr, e.voucher_id
        from acct.gl_entries e join acct.vouchers v on v.id = e.voucher_id where e.account_id = p_account_id and e.entry_date between p_from and p_to) x
$$;

-- Statement of account for a customer (§8A, §WA-3): built by the server from the books. Because it lists every
-- document (with and without GST) exactly as in the books, only Admin/CA may open a statement that contains a
-- document without GST; others get the statement when the party has none.
create or replace function api.statement_of_account(p_company_id uuid, p_party_id uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_acc uuid; v_has_without boolean; v_lines jsonb; v_open numeric; v_close numeric; v_party master.parties;
begin
  if not (app.can(p_company_id, 'accounts.view') or app.can(p_company_id, 'sales.view')) then perform app.raise_rule('rights.missing', 'no right', '42501'); end if;
  select exists (select 1 from acct.gl_entries e where e.company_id = p_company_id and e.party_id = p_party_id and e.tax_class in ('without_gst', 'unclassified'))
      or exists (select 1 from acct.open_bills o where o.company_id = p_company_id and o.party_id = p_party_id and o.tax_class in ('without_gst', 'unclassified'))
    into v_has_without;
  if v_has_without and app.current_view() not in ('all', 'all-readonly') then
    perform app.raise_rule('statement.admin_only', 'this statement includes documents only Admin can see; ask Admin to send it', '42501');
  end if;
  select * into v_party from master.parties where id = p_party_id;
  select coalesce(sum(case when a.opening_dc = 'D' then a.opening_balance else -a.opening_balance end), 0) into v_open from acct.accounts a where a.company_id = p_company_id and a.party_id = p_party_id;
  v_open := v_open + coalesce((select sum(e.dr - e.cr) from acct.gl_entries e where e.company_id = p_company_id and e.party_id = p_party_id and e.entry_date < p_from), 0);
  select coalesce(jsonb_agg(jsonb_build_object('date', x.entry_date, 'doc_no', x.doc_no, 'type', x.voucher_type, 'dr', x.dr, 'cr', x.cr, 'balance', x.bal) order by x.entry_date, x.id), '[]'::jsonb) into v_lines
  from (select e.id, e.entry_date, v.doc_no, v.voucher_type, e.dr, e.cr, v_open + sum(e.dr - e.cr) over (order by e.entry_date, e.id) as bal
        from acct.gl_entries e join acct.vouchers v on v.id = e.voucher_id
        where e.company_id = p_company_id and e.party_id = p_party_id and e.entry_date between p_from and p_to) x;
  v_close := v_open + coalesce((select sum(e.dr - e.cr) from acct.gl_entries e where e.company_id = p_company_id and e.party_id = p_party_id and e.entry_date between p_from and p_to), 0);
  return jsonb_build_object('party', jsonb_build_object('id', v_party.id, 'name', v_party.legal_name, 'gstin', v_party.gstin), 'from', p_from, 'to', p_to,
    'opening', v_open, 'closing', v_close, 'lines', v_lines,
    'ageing', (select jsonb_object_agg(bucket, amt) from (select r.bucket, sum(r.open_amount) as amt from api.receivables r where r.company_id = p_company_id and r.party_id = p_party_id and r.open_amount > 0 group by r.bucket) b));
end $$;

grant select on all tables in schema api to authenticated;
revoke all on all functions in schema api from public, anon;
grant execute on all functions in schema api to authenticated;
grant execute on function api.log_sign_in_failure(text) to anon;
revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;
notify pgrst, 'reload schema';

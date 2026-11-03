-- 20261103002800_money_screens.sql
-- Phase 3 read RPCs for the money screens: the cash book check (month by month, where the cash went, cash paid
-- into the bank, flagged cash payments, cash given to staff) and cash flow (money in and out by month, the lowest
-- combined cash + bank balance, days below the minimum balance from Settings, and what falls due in the next 13
-- weeks from open receivables and payables). Read-only and security invoker: RLS and the view rule apply, so a
-- user sees only what the tables already let them read. Additive.

create or replace function api.cash_book_summary(p_account_id uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare v_acc acct.accounts; v_open numeric; v_res jsonb;
begin
  select * into v_acc from acct.accounts where id = p_account_id;
  if v_acc.id is null or v_acc.kind not in ('cash', 'bank') then perform app.raise_rule('money.account', 'choose the cash or bank account', '22023'); end if;
  if p_from is null or p_to is null or p_from > p_to then perform app.raise_rule('date.range', 'the from date must be on or before the to date', '22023'); end if;
  v_open := (case when v_acc.opening_dc = 'D' then v_acc.opening_balance else -v_acc.opening_balance end)
            + coalesce((select sum(e.dr - e.cr) from acct.gl_entries e where e.account_id = p_account_id and e.entry_date < p_from), 0);
  with e as (
    select g.voucher_id, g.entry_date, g.dr, g.cr from acct.gl_entries g where g.account_id = p_account_id and g.entry_date between p_from and p_to
  ), m as (
    select date_trunc('month', e.entry_date)::date as month, count(distinct e.entry_date) as days, sum(e.dr) as received, sum(e.cr) as paid,
           count(*) filter (where e.dr > 0) as received_lines, count(*) filter (where e.cr > 0) as paid_lines
    from e group by 1
  ), mm as (
    select m.*, v_open + coalesce(sum(m.received - m.paid) over (order by m.month rows between unbounded preceding and 1 preceding), 0) as opening from m
  ), side as (
    select o.account_id, 'out'::text as dir, sum(o.dr) as amount, count(distinct o.voucher_id) as n
    from acct.gl_entries o where o.voucher_id in (select e.voucher_id from e where e.cr > 0) and o.account_id <> p_account_id and o.dr > 0 group by o.account_id
    union all
    select o.account_id, 'in'::text, sum(o.cr), count(distinct o.voucher_id)
    from acct.gl_entries o where o.voucher_id in (select e.voucher_id from e where e.dr > 0) and o.account_id <> p_account_id and o.cr > 0 group by o.account_id
  )
  select jsonb_build_object(
    'account', jsonb_build_object('id', v_acc.id, 'name', v_acc.name, 'kind', v_acc.kind, 'company_id', v_acc.company_id),
    'from', p_from, 'to', p_to, 'opening', v_open,
    'received', coalesce((select sum(e.dr) from e), 0), 'paid', coalesce((select sum(e.cr) from e), 0),
    'received_lines', (select count(*) from e where e.dr > 0), 'paid_lines', (select count(*) from e where e.cr > 0),
    'closing', v_open + coalesce((select sum(e.dr - e.cr) from e), 0),
    'months', coalesce((select jsonb_agg(jsonb_build_object('month', mm.month, 'days', mm.days, 'opening', mm.opening, 'received', mm.received, 'paid', mm.paid,
                                                            'received_lines', mm.received_lines, 'paid_lines', mm.paid_lines, 'closing', mm.opening + mm.received - mm.paid) order by mm.month) from mm), '[]'::jsonb),
    'where', coalesce((select jsonb_agg(jsonb_build_object('account_id', s.account_id, 'account_name', a.name, 'kind', a.kind, 'dir', s.dir, 'amount', s.amount, 'vouchers', s.n) order by s.dir desc, s.amount desc)
                       from side s join acct.accounts a on a.id = s.account_id), '[]'::jsonb),
    'into_bank', jsonb_build_object(
      'amount', coalesce((select sum(s.amount) from side s join acct.accounts a on a.id = s.account_id where s.dir = 'out' and a.kind = 'bank'), 0),
      'times', coalesce((select sum(s.n) from side s join acct.accounts a on a.id = s.account_id where s.dir = 'out' and a.kind = 'bank'), 0)),
    'flagged', jsonb_build_object(
      'count', (select count(*) from acct.vouchers v where v.id in (select e.voucher_id from e) and v.voucher_type = 'payment' and v.mode = 'cash' and v.cash_reason is not null and v.status = 'posted'),
      'amount', coalesce((select sum(v.amount) from acct.vouchers v where v.id in (select e.voucher_id from e) and v.voucher_type = 'payment' and v.mode = 'cash' and v.cash_reason is not null and v.status = 'posted'), 0)),
    'reversed', (select count(*) from acct.vouchers v where v.id in (select e.voucher_id from e) and v.status = 'reversed'),
    'cash_given', jsonb_build_object(
      'count', (select count(*) from api.cash_given c where c.voucher_id in (select e.voucher_id from e)),
      'amount', coalesce((select sum(c.amount) from api.cash_given c where c.voucher_id in (select e.voucher_id from e)), 0))
  ) into v_res;
  return v_res;
end $$;

-- Cash flow for a company: cash + bank accounts together. Moves between the company's own cash and bank accounts
-- (contra and their reversals) are left out of money in / out; the balance includes everything.
create or replace function api.cash_flow_summary(p_company_id uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare v_open numeric; v_min numeric; v_res jsonb; v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if p_from is null or p_to is null or p_from > p_to then perform app.raise_rule('date.range', 'the from date must be on or before the to date', '22023'); end if;
  v_min := nullif(app.setting(p_company_id, 'cash.min_balance')::text, 'null')::numeric;
  select coalesce(sum(case when a.opening_dc = 'D' then a.opening_balance else -a.opening_balance end), 0)
       + coalesce((select sum(e.dr - e.cr) from acct.gl_entries e join acct.accounts x on x.id = e.account_id
                    where x.company_id = p_company_id and x.kind in ('cash', 'bank') and e.entry_date < p_from), 0)
    into v_open
  from acct.accounts a where a.company_id = p_company_id and a.kind in ('cash', 'bank');
  with money as (
    select a.id from acct.accounts a where a.company_id = p_company_id and a.kind in ('cash', 'bank')
  ), e as (
    select g.voucher_id, g.entry_date, g.dr, g.cr,
           exists (select 1 from acct.gl_entries o where o.voucher_id = g.voucher_id and o.account_id not in (select id from money)) as outside
    from acct.gl_entries g where g.account_id in (select id from money) and g.entry_date between p_from and p_to
  ), m as (
    select date_trunc('month', e.entry_date)::date as month, coalesce(sum(e.dr) filter (where e.outside), 0) as money_in, coalesce(sum(e.cr) filter (where e.outside), 0) as money_out
    from e group by 1
  ), d as (
    select e.entry_date as day, sum(e.dr - e.cr) as net from e group by 1
  ), dd as (
    select d.day, v_open + sum(d.net) over (order by d.day) as closing from d
  ), wk as (
    select gs::date as week_start from generate_series(date_trunc('week', v_today)::date, date_trunc('week', v_today)::date + 12 * 7, interval '7 days') gs
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'opening', v_open, 'min_balance', v_min,
    'accounts', (select count(*) from money),
    'months', coalesce((select jsonb_agg(jsonb_build_object('month', m.month, 'money_in', m.money_in, 'money_out', m.money_out, 'net', m.money_in - m.money_out) order by m.month) from m), '[]'::jsonb),
    'avg_in', (select round(avg(m.money_in), 2) from m), 'avg_out', (select round(avg(m.money_out), 2) from m),
    'lowest', (select jsonb_build_object('day', dd.day, 'balance', dd.closing) from dd order by dd.closing, dd.day limit 1),
    'closing', v_open + coalesce((select sum(d.net) from d), 0),
    'days_with_entries', (select count(*) from dd),
    'days_below', case when v_min is null then null else (select count(*) from dd where dd.closing < v_min) end,
    'weeks', (select jsonb_agg(jsonb_build_object('week_start', wk.week_start,
        'due_in', coalesce((select sum(r.open_amount) from api.receivables r where r.company_id = p_company_id and r.open_amount > 0
                             and greatest(coalesce(r.due_date, r.bill_date), v_today) >= wk.week_start and greatest(coalesce(r.due_date, r.bill_date), v_today) < wk.week_start + 7), 0),
        'due_out', coalesce((select sum(p.open_amount) from api.payables p where p.company_id = p_company_id and p.open_amount > 0
                             and greatest(coalesce(p.due_date, p.bill_date), v_today) >= wk.week_start and greatest(coalesce(p.due_date, p.bill_date), v_today) < wk.week_start + 7), 0))
      order by wk.week_start) from wk)
  ) into v_res;
  return v_res;
end $$;

grant execute on function api.cash_book_summary(uuid, date, date) to authenticated;
grant execute on function api.cash_flow_summary(uuid, date, date) to authenticated;
revoke all on function api.cash_book_summary(uuid, date, date) from public, anon;
revoke all on function api.cash_flow_summary(uuid, date, date) from public, anon;
notify pgrst, 'reload schema';

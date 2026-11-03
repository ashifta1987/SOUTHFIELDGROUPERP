-- 20261103002600_home_summary.sql
-- Home dashboard data (§UX-7.1), computed in Postgres for the signed-in user's view: KPIs per company, sales by month
-- (with/without GST split only for Admin/CA — the rows simply don't arrive for others because RLS filters them),
-- "Needs you" items with a link that fixes each one, and the latest bills. Security invoker: RLS applies. Additive.

create or replace function api.home_summary() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_month date := date_trunc('month', (now() at time zone 'Asia/Kolkata'))::date;
  v_fy_start date := make_date(case when extract(month from v_today) >= 4 then extract(year from v_today)::int else extract(year from v_today)::int - 1 end, 4, 1);
  v_kpis jsonb := '[]'::jsonb; v_months jsonb; v_tasks jsonb := '[]'::jsonb; v_bills jsonb; c record; v_n int;
begin
  for c in select id, short_name from core.companies where status = 'active' order by code loop
    v_kpis := v_kpis || jsonb_build_array(
      jsonb_build_object('key', 'sales_month_' || c.id, 'label', c.short_name || ' · sales this month',
        'value', coalesce((select sum(case when d.doc_type = 'credit_note' then -d.total else d.total end) from sales.documents d where d.company_id = c.id and d.status = 'posted' and d.doc_type in ('sales_invoice', 'bill_of_supply', 'credit_note') and d.doc_date >= v_month), 0),
        'sub', null, 'href', '/sales/invoices/sales-register'),
      jsonb_build_object('key', 'sales_fy_' || c.id, 'label', c.short_name || ' · sales this FY',
        'value', coalesce((select sum(case when d.doc_type = 'credit_note' then -d.total else d.total end) from sales.documents d where d.company_id = c.id and d.status = 'posted' and d.doc_type in ('sales_invoice', 'bill_of_supply', 'credit_note') and d.doc_date >= v_fy_start), 0),
        'sub', null, 'href', '/sales/invoices/sales-register'),
      jsonb_build_object('key', 'owed_' || c.id, 'label', c.short_name || ' · customers owe',
        'value', coalesce((select sum(r.open_amount) from api.receivables r where r.company_id = c.id and r.open_amount > 0), 0), 'sub', null, 'href', '/accounts/cash-flow-and-reminders'),
      jsonb_build_object('key', 'cash_' || c.id, 'label', c.short_name || ' · cash and bank',
        'value', coalesce((select sum(case when a.opening_dc = 'D' then a.opening_balance else -a.opening_balance end) + coalesce(sum((select sum(e.dr - e.cr) from acct.gl_entries e where e.account_id = a.id)), 0)
                           from acct.accounts a where a.company_id = c.id and a.kind in ('cash', 'bank') and a.status = 'active'), 0),
        'sub', null, 'href', '/accounts/cash-book'));
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'Mon'), 'with_gst', w, 'without_gst', wo, 'total', w + coalesce(wo, 0)) order by m), '[]'::jsonb) into v_months
  from (select gs::date as m,
               coalesce((select sum(case when d.doc_type = 'credit_note' then -d.total else d.total end) from sales.documents d where d.status = 'posted' and d.tax_class = 'taxable' and d.doc_type in ('sales_invoice', 'credit_note') and date_trunc('month', d.doc_date) = gs), 0) as w,
               case when app.current_view() in ('all', 'all-readonly') then coalesce((select sum(d.total) from sales.documents d where d.status = 'posted' and d.tax_class = 'without_gst' and d.doc_type = 'bill_of_supply' and date_trunc('month', d.doc_date) = gs), 0) end as wo
        from generate_series(v_fy_start, v_month, interval '1 month') gs) x;

  select count(*) into v_n from ops.bug_items where status = 'open' and severity = 'high';
  if v_n > 0 then v_tasks := v_tasks || jsonb_build_object('id', 'bugs', 'severity', 'high', 'title', v_n || ' serious problems in the Bug fixer', 'body', 'They come from Tally loads and checks. Fix them before relying on the books.', 'link_label', 'Bug fixer', 'href', '/admin/bug-fixer'); end if;
  select count(*) into v_n from hr.requests where status = 'pending';
  if v_n > 0 then v_tasks := v_tasks || jsonb_build_object('id', 'requests', 'severity', 'medium', 'title', v_n || ' leave or advance requests waiting', 'body', 'Staff are waiting for an answer in the staff app.', 'link_label', 'Leave & advance requests', 'href', '/hr-and-payroll/leave-and-advance-requests'); end if;
  select count(*) into v_n from acct.open_bills where tax_class = 'unclassified';
  if v_n > 0 then v_tasks := v_tasks || jsonb_build_object('id', 'classify', 'severity', 'medium', 'title', v_n || ' opening bills to classify', 'body', 'Mark each opening bill from Tally as with GST or without GST.', 'link_label', 'Tally books', 'href', '/admin/import-data/tally-biochem'); end if;
  select count(*) into v_n from sales.documents where status = 'draft';
  if v_n > 0 then v_tasks := v_tasks || jsonb_build_object('id', 'drafts', 'severity', 'info', 'title', v_n || ' draft documents not posted', 'body', 'Drafts are not in the books until they are posted.', 'link_label', 'Invoices', 'href', '/sales/invoices'); end if;
  select count(*) into v_n from msg.outbox where status in ('failed', 'skipped') and created_at > now() - interval '7 days';
  if v_n > 0 then v_tasks := v_tasks || jsonb_build_object('id', 'messages', 'severity', 'info', 'title', v_n || ' WhatsApp messages not sent this week', 'body', 'Usually a missing number or consent. Check the contact.', 'link_label', 'WhatsApp & email', 'href', '/admin/whatsapp-and-email'); end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'bill_date', d.doc_date, 'doc_no', d.doc_no, 'party_name', p.legal_name,
           'tax_class', case when d.tax_class = 'without_gst' then 'withoutGst' else 'taxable' end, 'lawful_reason', d.lawful_reason, 'amount', d.total) order by d.doc_date desc, d.posted_at desc), '[]'::jsonb) into v_bills
  from (select * from sales.documents where status = 'posted' and doc_type in ('sales_invoice', 'bill_of_supply') order by doc_date desc, posted_at desc limit 8) d
  join master.parties p on p.id = d.party_id;

  return jsonb_build_object('kpis', v_kpis, 'months', v_months, 'chart_title', 'Sales by month, ' || to_char(v_fy_start, 'YYYY') || '-' || to_char(v_fy_start + interval '1 year', 'YY'),
    'tasks', v_tasks, 'latest_bills', v_bills, 'latest_title', 'Latest bills', 'data_note', to_char(v_today, 'FMDay, DD-MM-YYYY') || ' · from the ERP books');
end $$;

grant execute on function api.home_summary() to authenticated;
notify pgrst, 'reload schema';

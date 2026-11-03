-- 20261103007300_phase7_views.sql
-- Phase 7 read views for the screens (security_invoker, so table RLS decides the rows; cost columns behind cost.view),
-- investor-portal views over definer functions that return only the caller's own rows, and the law register entries.

-- Names of people and users for lists (names only; nothing else about them).
create or replace function app.user_display_name(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$ select display_name from core.user_profiles where user_id = p_user $$;
create or replace function app.person_name(p_person uuid) returns text
language sql stable security definer set search_path = '' as $$ select name from master.people where id = p_person $$;

-- ─────────── Licences ───────────
create or replace view api.v_licence_register with (security_invoker = true) as
select l.id, l.company_id, c.short_name as company_name, l.branch_id, br.name as branch_name, l.kind, l.title, app.licence_label(l) as label, l.licence_no, l.issued_by,
       l.portal_url, l.valid_from, l.valid_to, l.status, l.renewal_status, l.renewal_applied_on, l.is_blocking, l.blocks, l.owner_person_id,
       app.person_name(l.owner_person_id) as owner_name, l.document_path, l.note,
       case when l.status <> 'active' then l.status
            when l.valid_to is null then 'no_expiry'
            when l.valid_to < current_date then 'expired'
            when l.valid_to - current_date <= coalesce((select max(x::int) from jsonb_array_elements_text(coalesce(app.setting(l.company_id, 'licence.reminder_days'), '[]'::jsonb)) x), 0) then 'expiring'
            else 'valid' end as state,
       case when l.valid_to is null then null else l.valid_to - current_date end as days_to_expiry,
       (l.is_blocking or exists (select 1 from prod.process_families f where f.company_id = l.company_id and f.licence_kind = l.kind)) as blocks_something,
       (select count(*)::int from core.licence_documents d where d.licence_id = l.id) as documents,
       (select coalesce(jsonb_agg(r.days_before order by r.days_before desc), '[]'::jsonb) from core.licence_reminders r where r.licence_id = l.id and r.valid_to = l.valid_to) as reminders_done,
       l.created_at, l.updated_at
from core.licences l join core.companies c on c.id = l.company_id left join core.branches br on br.id = l.branch_id;

create or replace view api.v_licence_documents with (security_invoker = true) as
select d.id, d.company_id, d.licence_id, d.kind, d.path, d.valid_to, d.uploaded_by, app.user_display_name(d.uploaded_by) as uploaded_by_name, d.created_at
from core.licence_documents d;

create or replace view api.v_licence_renewals with (security_invoker = true) as
select r.id, r.company_id, r.licence_id, r.old_licence_no, r.old_valid_from, r.old_valid_to, r.new_licence_no, r.new_valid_from, r.new_valid_to, r.document_id, r.note,
       r.renewed_by, app.user_display_name(r.renewed_by) as renewed_by_name, r.renewed_at
from core.licence_renewals r;

create or replace view api.v_licence_reminders with (security_invoker = true) as
select r.id, r.company_id, r.licence_id, app.licence_label(l) as label, l.licence_no, r.valid_to, r.days_before, r.due_on, r.status, r.outbox_id, o.status as message_status,
       r.run_date, r.created_at
from core.licence_reminders r join core.licences l on l.id = r.licence_id left join msg.outbox o on o.id = r.outbox_id;

-- ─────────── Job work ───────────
create or replace view api.v_job_work_orders with (security_invoker = true) as
select o.id, o.company_id, c.short_name as company_name, o.doc_no, o.challan_no, o.challan_document_id, o.sent_on, o.return_by, o.goods_kind, o.process, o.status,
       o.job_worker_party_id, pa.legal_name as job_worker_name, o.from_place_id, fp.name as from_place_name, o.jw_place_id, o.note,
       (select string_agg(pr.name, ', ' order by l.line_no) from prod.job_work_lines l join master.products pr on pr.id = l.product_id where l.order_id = o.id) as goods,
       (select coalesce(sum(l.qty_sent), 0) from prod.job_work_lines l where l.order_id = o.id) as qty_sent,
       (select coalesce(sum(l.qty_settled), 0) from prod.job_work_lines l where l.order_id = o.id) as qty_back,
       (select coalesce(sum(l.qty_sent - l.qty_settled), 0) from prod.job_work_lines l where l.order_id = o.id) as qty_balance,
       case when o.return_by is null then null else o.return_by - current_date end as days_left,
       (o.status in ('sent', 'part_received') and o.return_by is not null and o.return_by < current_date) as overdue,
       case when o.status in ('received', 'cancelled') then 'returned'
            when o.return_by is not null and o.return_by < current_date then 'overdue'
            when o.return_by is null then 'no_limit'
            else 'at_job_worker' end as return_state,
       case when app.can(o.company_id, 'cost.view') then (select round(coalesce(sum((l.qty_sent - l.qty_settled) * l.unit_cost), 0), 2) from prod.job_work_lines l where l.order_id = o.id) end as value_out,
       o.created_by, o.created_at
from prod.job_work_orders o join core.companies c on c.id = o.company_id left join master.parties pa on pa.id = o.job_worker_party_id left join core.places fp on fp.id = o.from_place_id;

create or replace view api.v_job_work_lines with (security_invoker = true) as
select l.id, l.company_id, l.order_id, l.line_no, l.product_id, pr.code as product_code, pr.name as product_name, pr.uom, l.lot_id, lt.lot_no, l.qty_sent, l.qty_settled,
       l.qty_sent - l.qty_settled as balance, case when app.can(l.company_id, 'cost.view') then l.unit_cost end as unit_cost
from prod.job_work_lines l join master.products pr on pr.id = l.product_id left join inv.lots lt on lt.id = l.lot_id;

create or replace view api.v_job_work_receipts with (security_invoker = true) as
select r.id, r.company_id, r.order_id, r.line_id, r.kind, r.product_id, pr.name as product_name, r.qty, r.input_qty, r.to_place_id, pl.name as to_place_name,
       case when app.can(r.company_id, 'cost.view') then r.value end as value, r.received_on, r.challan_ref, r.received_by, app.user_display_name(r.received_by) as received_by_name, r.created_at
from prod.job_work_receipts r left join master.products pr on pr.id = r.product_id left join core.places pl on pl.id = r.to_place_id;

-- ─────────── Maintenance ───────────
create or replace view api.v_repair_requests with (security_invoker = true) as
select r.id, r.company_id, r.doc_no, r.asset_id, a.code as asset_code, a.name as asset_name, r.mould_id, m.code as mould_code, r.source, r.machine_check_id, r.title, r.description,
       r.photo_path, r.priority, r.is_breakdown, r.broke_down_at, r.restored_at,
       coalesce(r.downtime_minutes, case when r.is_breakdown and r.status not in ('done', 'cancelled') then round(extract(epoch from (now() - r.broke_down_at)) / 60.0, 2) end) as downtime_minutes,
       r.status, r.assigned_to, app.user_display_name(r.assigned_to) as assigned_to_name, r.outside_vendor, r.purchase_request_id, r.resolution,
       case when app.can(r.company_id, 'cost.view') then r.labour_cost end as labour_cost, case when app.can(r.company_id, 'cost.view') then r.outside_cost end as outside_cost,
       case when app.can(r.company_id, 'cost.view') then (select coalesce(sum(s.value), 0) from prod.spares_issues s where s.repair_request_id = r.id) end as spares_value,
       r.raised_by, app.user_display_name(r.raised_by) as raised_by_name, r.closed_by, r.closed_at, r.created_at, r.updated_at
from prod.repair_requests r left join core.assets a on a.id = r.asset_id left join prod.moulds m on m.id = r.mould_id;

create or replace view api.v_spares_issues with (security_invoker = true) as
select s.id, s.company_id, s.doc_no, s.repair_request_id, s.asset_id, a.code as asset_code, s.product_id, pr.code as product_code, pr.name as product_name, pr.uom, s.place_id,
       s.qty, case when app.can(s.company_id, 'cost.view') then s.value end as value, s.issued_on, s.issued_by, app.user_display_name(s.issued_by) as issued_by_name, s.created_at
from prod.spares_issues s join master.products pr on pr.id = s.product_id left join core.assets a on a.id = s.asset_id;

create or replace view api.v_maintenance_schedules with (security_invoker = true) as
select s.id, s.company_id, s.asset_id, a.code as asset_code, a.name as asset_name, s.title, s.interval_days, s.checklist, s.last_done_on, s.next_due_on, s.active,
       s.next_due_on - current_date as days_to_due, (s.active and s.next_due_on < current_date) as overdue, s.created_at, s.updated_at
from prod.maintenance_schedules s join core.assets a on a.id = s.asset_id;

-- Maintenance tiles (runs as the caller; spend only with cost.view).
create or replace function api.maintenance_summary(p_company_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  with m as (select date_trunc('month', current_date)::date as m0)
  select jsonb_build_object(
    'machines', (select count(*)::int from core.assets a where a.company_id = p_company_id and a.status <> 'disposed' and a.kind in ('injection_machine', 'mixer', 'filling', 'soap_line', 'pad_printer', 'compressor', 'chiller')),
    'checked_today', (select count(distinct k.asset_id)::int from prod.machine_checks k where k.company_id = p_company_id and k.check_date = current_date),
    'open_requests', (select jsonb_object_agg(s, n) from (select r.status s, count(*)::int n from prod.repair_requests r where r.company_id = p_company_id and r.status not in ('done', 'cancelled') group by r.status) x),
    'done_this_month', (select count(*)::int from prod.repair_requests r, m where r.company_id = p_company_id and r.status = 'done' and r.closed_at >= m.m0),
    'breakdown_hours_month', (select round(coalesce(sum(coalesce(r.downtime_minutes, extract(epoch from (now() - greatest(r.broke_down_at, m.m0::timestamptz))) / 60.0)), 0) / 60.0, 2)
                              from prod.repair_requests r, m where r.company_id = p_company_id and r.is_breakdown and r.status <> 'cancelled'
                                and (r.restored_at >= m.m0 or r.restored_at is null)),
    'schedules_overdue', (select count(*)::int from prod.maintenance_schedules s where s.company_id = p_company_id and s.active and s.next_due_on < current_date),
    'spend_month', case when app.can(p_company_id, 'cost.view') then
        (select coalesce(sum(s.value), 0) from prod.spares_issues s, m where s.company_id = p_company_id and s.issued_on >= m.m0)
      + (select coalesce(sum(coalesce(r.labour_cost, 0) + coalesce(r.outside_cost, 0)), 0) from prod.repair_requests r, m where r.company_id = p_company_id and r.closed_at >= m.m0) end)
$$;

-- ─────────── Asset register ───────────
create or replace view api.v_asset_register with (security_invoker = true) as
select a.id, a.company_id, c.short_name as company_name, a.code, a.name, a.kind, a.place_id, pl.name as place_name, a.make, a.model, a.serial_no, a.purchase_date, a.put_to_use_date,
       a.useful_life_years, a.residual_pct, a.status, a.disposed_on, a.amc_until,
       case when app.can(a.company_id, 'cost.view') or app.can(a.company_id, 'accounts.view') then a.cost end as cost,
       case when app.can(a.company_id, 'cost.view') or app.can(a.company_id, 'accounts.view') then
         (select coalesce(sum(dl.amount), 0) from acct.depreciation_lines dl join acct.depreciation_runs dr on dr.id = dl.run_id and dr.status = 'posted' where dl.asset_id = a.id) end as accumulated_depreciation,
       case when app.can(a.company_id, 'cost.view') or app.can(a.company_id, 'accounts.view') then
         a.cost - (select coalesce(sum(dl.amount), 0) from acct.depreciation_lines dl join acct.depreciation_runs dr on dr.id = dl.run_id and dr.status = 'posted' where dl.asset_id = a.id) end as wdv,
       (select max(p.month_start) from acct.depreciation_lines dl join acct.depreciation_runs dr on dr.id = dl.run_id and dr.status = 'posted' join core.periods p on p.id = dr.period_id where dl.asset_id = a.id) as depreciated_to,
       (select count(*)::int from core.asset_documents d where d.asset_id = a.id) as documents,
       (select count(*)::int from prod.repair_requests r where r.asset_id = a.id and r.status not in ('done', 'cancelled')) as open_repairs
from core.assets a join core.companies c on c.id = a.company_id left join core.places pl on pl.id = a.place_id;

create or replace view api.v_depreciation_runs with (security_invoker = true) as
select r.id, r.company_id, r.period_id, p.month_start, r.method, r.total, r.voucher_id, v.doc_no as voucher_no, r.status, r.run_by, app.user_display_name(r.run_by) as run_by_name, r.run_at,
       (select count(*)::int from acct.depreciation_lines l where l.run_id = r.id) as assets
from acct.depreciation_runs r join core.periods p on p.id = r.period_id left join acct.vouchers v on v.id = r.voucher_id;

create or replace view api.v_depreciation_lines with (security_invoker = true) as
select l.id, l.run_id, l.company_id, l.asset_id, a.code as asset_code, a.name as asset_name, l.cost, l.residual, l.useful_life_years, l.opening_wdv, l.days, l.amount, l.closing_wdv
from acct.depreciation_lines l join core.assets a on a.id = l.asset_id;

create or replace view api.v_asset_disposals with (security_invoker = true) as
select d.id, d.company_id, d.asset_id, a.code as asset_code, a.name as asset_name, d.disposal_date, d.proceeds, d.cost, d.accumulated_depreciation, d.wdv, d.gain_loss, d.reason,
       d.voucher_id, d.disposed_by, d.created_at
from core.asset_disposals d join core.assets a on a.id = d.asset_id;

-- ─────────── Partners and directors (Admin / finance; an investor sees only their own rows) ───────────
create or replace view api.v_partners with (security_invoker = true) as
select p.id, p.company_id, c.short_name as company_name, p.person_id, p.user_id, p.display_name, p.is_legal_partner, p.is_investment_partner, p.is_working_partner, p.is_director,
       p.director_interested, p.din, p.shares, p.share_pct, p.capital_account_id, p.current_account_id, p.loan_account_id, p.language, p.status,
       (select coalesce(sum(i.amount), 0) from acct.partner_investments i where i.partner_id = p.id and i.kind = 'share_capital') as share_capital,
       (select coalesce(sum(i.amount), 0) from acct.partner_investments i where i.partner_id = p.id and i.kind <> 'share_capital') as investment,
       case when p.current_account_id is null then null else round(app.account_credit_balance(p.current_account_id, current_date), 2) end as current_account_balance,
       case when p.loan_account_id is null then null else round(app.account_credit_balance(p.loan_account_id, current_date), 2) end as loan_account_balance,
       exists (select 1 from acct.director_declarations d where d.partner_id = p.id and d.kind = 'not_borrowed' and d.declared_on <= current_date and (d.valid_to is null or d.valid_to >= current_date)) as declaration_on_file,
       exists (select 1 from core.user_roles ur where ur.user_id = p.user_id and ur.role_key = 'investor') as portal_set_up,
       p.created_at, p.updated_at
from acct.partners p join core.companies c on c.id = p.company_id;

create or replace view api.v_partner_requests with (security_invoker = true) as
select q.id, q.company_id, c.short_name as company_name, q.doc_no, q.partner_id, p.display_name as partner_name, p.is_director, q.kind, q.source, q.project_id, q.amount, q.repay_months,
       q.repay_from, q.purpose, q.note, q.status, q.requested_by, app.user_display_name(q.requested_by) as requested_by_name, q.created_at, q.decided_by,
       app.user_display_name(q.decided_by) as decided_by_name, q.decided_at, q.decided_amount, q.decision_note, q.checks, q.voucher_id, q.paid_at,
       case when q.kind = 'withdraw' and p.current_account_id is not null then round(app.account_credit_balance(p.current_account_id, current_date), 2) end as due_to_partner
from acct.partner_requests q join acct.partners p on p.id = q.partner_id join core.companies c on c.id = q.company_id;

create or replace view api.v_partner_investments with (security_invoker = true) as
select i.id, i.company_id, i.partner_id, p.display_name as partner_name, i.kind, i.amount, i.invested_on, i.agreement_ref, i.project_id, i.note, i.recorded_by, i.created_at
from acct.partner_investments i join acct.partners p on p.id = i.partner_id;

create or replace view api.v_partner_projects with (security_invoker = true) as
select pp.id, pp.company_id, c.short_name as company_name, pp.name, pp.status, pp.started_on, pp.summary, pp.investor_figures, pp.visible_to_investors, pp.updated_at, pp.created_at
from acct.partner_projects pp join core.companies c on c.id = pp.company_id;

create or replace view api.v_director_declarations with (security_invoker = true) as
select d.id, d.company_id, d.partner_id, p.display_name as partner_name, d.kind, d.declared_on, d.valid_to, d.document_path, d.note, d.recorded_by, d.created_at,
       (d.declared_on <= current_date and (d.valid_to is null or d.valid_to >= current_date)) as current
from acct.director_declarations d join acct.partners p on p.id = d.partner_id;

create or replace view api.v_director_loans with (security_invoker = true) as
select l.id, l.company_id, l.partner_id, p.display_name as partner_name, l.direction, l.movement, l.amount, l.loan_date, l.bank_account_id, l.request_id, l.declaration_id,
       l.legal_basis, l.voucher_id, v.doc_no as voucher_no, l.recorded_by, l.created_at,
       sum(case when l.movement = 'advance' then l.amount else -l.amount end) over (partition by l.partner_id, l.direction order by l.loan_date, l.created_at) as outstanding_after
from acct.director_loans l join acct.partners p on p.id = l.partner_id left join acct.vouchers v on v.id = l.voucher_id;

create or replace view api.v_profit_share_minutes with (security_invoker = true) as
select m.id, m.company_id, m.fy_id, fy.label as fy_label, m.meeting_date, m.minutes_ref, m.document_path, m.basis, m.status, m.created_by, app.user_display_name(m.created_by) as created_by_name,
       m.approved_by, app.user_display_name(m.approved_by) as approved_by_name, m.approved_at, m.created_at
from acct.profit_share_minutes m join core.financial_years fy on fy.id = m.fy_id;

create or replace view api.v_profit_share_runs with (security_invoker = true) as
select r.id, r.company_id, r.minutes_id, m.minutes_ref, r.fy_id, r.net_profit, r.incentive_total, r.distributable, r.status, r.voucher_id, v.doc_no as voucher_no, r.computed_at, r.posted_at,
       (select coalesce(jsonb_agg(jsonb_build_object('partner_id', s.partner_id, 'partner_name', p.display_name, 'kind', s.kind, 'pct', s.pct, 'amount', s.amount) order by s.id), '[]'::jsonb)
          from acct.profit_shares s join acct.partners p on p.id = s.partner_id where s.run_id = r.id) as lines
from acct.profit_share_runs r join acct.profit_share_minutes m on m.id = r.minutes_id left join acct.vouchers v on v.id = r.voucher_id;

-- ─────────── Investor portal (definer functions return only the caller's own rows) ───────────
create or replace view api.v_investor_partners with (security_invoker = true) as select * from app.investor_partner_rows();
create or replace view api.v_investor_requests with (security_invoker = true) as select * from app.investor_request_rows();
create or replace view api.v_investor_profit_shares with (security_invoker = true) as select * from app.investor_profit_share_rows();
create or replace view api.v_investor_projects with (security_invoker = true) as select * from app.investor_project_rows();
create or replace view api.v_investor_money_in with (security_invoker = true) as
select m.company_id, (select r.company_name from app.investor_partner_rows() r where r.company_id = m.company_id limit 1) as company_name, m.month, m.mode, m.receipts, m.amount
from app.investor_money_in_rows(12) m;

-- ─────────── Month-end close ───────────
create or replace view api.v_close_checklists with (security_invoker = true) as
select c.id, c.company_id, co.short_name as company_name, c.period_id, p.month_start, p.status as period_status, c.due_on, c.status, c.due_on - current_date as days_left,
       (select count(*)::int from acct.close_tasks t where t.checklist_id = c.id) as tasks,
       (select count(*)::int from acct.close_tasks t where t.checklist_id = c.id and t.status = 'open') as open_tasks,
       (select count(*)::int from acct.close_tasks t where t.checklist_id = c.id and t.status = 'done') as done_tasks,
       (select count(*)::int from acct.close_tasks t where t.checklist_id = c.id and t.status = 'checked') as checked_tasks,
       (select count(*)::int from acct.close_tasks t where t.checklist_id = c.id and t.status = 'carried') as carried_tasks,
       c.created_at
from acct.close_checklists c join core.periods p on p.id = c.period_id join core.companies co on co.id = c.company_id;

create or replace view api.v_close_tasks with (security_invoker = true) as
select t.id, t.company_id, t.checklist_id, t.title, t.area, t.sort, t.status, t.doer_user_id, app.user_display_name(t.doer_user_id) as doer_name, t.checker_user_id,
       app.user_display_name(t.checker_user_id) as checker_name, t.done_by, t.done_at, t.done_note, t.checked_by, t.checked_at, t.check_note, t.carried_to_task_id, t.carry_reason,
       (t.status = 'open' and t.doer_user_id = (select auth.uid())) or (t.status = 'done' and t.checker_user_id = (select auth.uid()) and t.done_by is distinct from (select auth.uid())) as my_turn,
       t.created_at
from acct.close_tasks t;

create or replace view api.v_period_status with (security_invoker = true) as
select p.id as period_id, p.company_id, p.fy_id, p.month_start, p.status, p.closed_at, p.closed_by, app.user_display_name(p.closed_by) as closed_by_name,
       c.id as checklist_id, c.due_on, e.action as last_action, e.reason as last_reason, e.relock_at, e.at as last_action_at
from core.periods p left join acct.close_checklists c on c.period_id = p.id
left join lateral (select x.action, x.reason, x.relock_at, x.at from acct.period_events x where x.period_id = p.id order by x.at desc limit 1) e on true;

-- ─────────── Law register ───────────
insert into core.law_rules (code, area, rule, what_erp_does, enforced_in, test_ref, status, phase, sort) values
  ('JW-1', 'GST job work', 'Goods sent to a job worker move under a challan and come back within 1 year (inputs) or 3 years (capital goods); moulds, dies, jigs, fixtures and tools have no limit (CGST Act s.143)',
   'Job-work challan from the challan series; return-by date from settings; balance per line; overdue flagged and a Bug fixer item for the CA', 'api.issue_job_work_challan, api.receive_job_work, app.job_work_overdue_run',
   'supabase/tests/21_jobwork_maintenance.sql', 'needs_ca', 7, 120),
  ('LIC-1', 'Licences', 'Reminders 90, 30 and 7 days before expiry; an expired blocking licence stops the transactions that depend on it (Prompt §14)',
   'Reminder rows unique per licence, expiry and threshold (never twice); daily pg_cron job; blocking licences checked on production, injection shifts and packing',
   'app.licence_reminders_run, app.check_blocking_licences, app.check_licence', 'supabase/tests/22_licences_assets.sql', 'built', 7, 121),
  ('DEP-1', 'Schedule II', 'Depreciation as per Schedule II with useful lives and method confirmed by the CA',
   'Method, lives and residual are settings; run_depreciation refuses (depreciation.settings_missing / life_not_set) when unset; pro-rata by days; posted through app.post_voucher',
   'api.run_depreciation, app.depreciation_readiness', 'supabase/tests/22_licences_assets.sql', 'needs_ca', 7, 122),
  ('CA-185', 'Companies Act', 'Loans to directors and to persons or firms they are interested in are restricted (s.185)',
   'Partner loan requests and loan entries refused unless the allowed exception is recorded in settings; Admin decides, never their own', 'app.check_partner_loan, api.decide_partner_request, api.record_director_loan',
   'supabase/tests/23_partners_investor_close.sql', 'needs_ca', 7, 123),
  ('CA-186', 'Companies Act', 'Loans and investments within the s.186 limit (special resolution above it)',
   'The limit is a setting; refused when unset or exceeded', 'app.check_partner_loan', 'supabase/tests/23_partners_investor_close.sql', 'needs_ca', 7, 124),
  ('DIR-1', 'Companies Act', 'Money lent by a director needs a written declaration that it is not borrowed (Deposit Rules, rule 2(1)(c)(viii))',
   'Approval and the loan entry refuse without a current declaration', 'app.director_declaration', 'supabase/tests/23_partners_investor_close.sql', 'built', 7, 125),
  ('PER-1', 'Period lock', 'A closed month is locked (books kept as per Companies (Accounts) Rules)',
   'No grant can post into a closed month (app.fy_for and GL / stock-ledger triggers); reopen only by Admin with a reason, logged', 'app.fy_for, app.refuse_closed_period, api.close_period, api.reopen_period',
   'supabase/tests/23_partners_investor_close.sql', 'built', 7, 126)
on conflict (code) do nothing;

grant select on all tables in schema api to authenticated;
revoke all on all functions in schema api from public, anon;
grant execute on all functions in schema api to authenticated;
grant execute on function api.log_sign_in_failure(text) to anon;
revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;
notify pgrst, 'reload schema';

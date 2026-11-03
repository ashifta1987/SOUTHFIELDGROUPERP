-- Phase 7 partners, directors, the investor portal and the month-end close: an investor sees only their own partner row, requests
-- and analytics (aggregates; without-GST receipts left out) and has no transaction rights (representative write RPCs refuse, and the
-- role carries no create / edit / approve / cancel / manage right); partner requests are decided only by Admin, never their own,
-- with the Companies Act checks (s.185 exception, s.186 limit, a director's declaration); profit sharing by approved minutes posted
-- through the books; close tasks with doer ≠ checker; a closed month refuses postings even with a special grant, and reopens only
-- by Admin with a reason. Synthetic data only.
select plan(42);

create temp table s as select tests.seed7(tests.seed5(tests.seed4(tests.seed3(tests.seed2(tests.seed()))))) as v;
grant select on s to authenticated;
create or replace function tests.k(p text) returns uuid language sql stable as $$ select (v ->> p)::uuid from s $$;
create temp table ids (k text primary key, v jsonb);
grant select, insert on ids to authenticated;
create or replace function tests.r(p text) returns jsonb language sql stable as $$ select v from ids where k = p $$;
create or replace function tests.id(p text, f text default 'id') returns uuid language sql stable as $$ select (v ->> f)::uuid from ids where k = p $$;
create or replace function tests.per(p date) returns uuid language sql stable security definer as $$
  select id from core.periods where company_id = tests.k('company_a') and month_start = p $$;
create or replace function tests.cbal(p text) returns numeric language sql stable security definer as $$ select app.account_credit_balance(tests.k(p), current_date) $$;
grant execute on all functions in schema tests to authenticated;

-- Books for October (synthetic): income, a taxable bank receipt and a without-GST cash receipt.
select app.post_voucher(jsonb_build_object('company_id', tests.k('company_a'), 'fy_id', tests.k('fy_a'), 'voucher_type', 'journal', 'doc_no', 'TEST-P7-J1', 'voucher_date', '2026-10-10',
  'client_request_id', gen_random_uuid(), 'narration', 'Test income'),
  jsonb_build_array(jsonb_build_object('account_id', tests.k('bank'), 'dr', 100000), jsonb_build_object('account_id', (select account_id from acct.posting_rules where company_id = tests.k('company_a') and event = 'sales.taxable'), 'cr', 100000)));
select app.post_voucher(jsonb_build_object('company_id', tests.k('company_a'), 'fy_id', tests.k('fy_a'), 'voucher_type', 'receipt', 'doc_no', 'TEST-P7-R1', 'voucher_date', '2026-10-12',
  'mode', 'bank', 'tax_class', 'taxable', 'client_request_id', gen_random_uuid()),
  jsonb_build_array(jsonb_build_object('account_id', tests.k('bank'), 'dr', 30000), jsonb_build_object('account_id', tests.k('share_capital'), 'cr', 30000)));
select app.post_voucher(jsonb_build_object('company_id', tests.k('company_a'), 'fy_id', tests.k('fy_a'), 'voucher_type', 'receipt', 'doc_no', 'TEST-P7-R2', 'voucher_date', '2026-10-13',
  'mode', 'cash', 'tax_class', 'without_gst', 'client_request_id', gen_random_uuid()),
  jsonb_build_array(jsonb_build_object('account_id', tests.k('cash'), 'dr', 7000), jsonb_build_object('account_id', tests.k('share_capital'), 'cr', 7000)));

-- ── Partners (Admin) ──
select tests.login(tests.k('admin'));
insert into ids select 'p1', api.upsert_partner(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'user_id', tests.k('investor1'), 'display_name', 'Test Partner One',
  'is_legal_partner', true, 'is_director', true, 'din', '00000001', 'share_pct', 60, 'current_account_id', tests.k('p1_current'), 'loan_account_id', tests.k('p1_loan')));
insert into ids select 'p2', api.upsert_partner(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'user_id', tests.k('investor2'), 'display_name', 'Test Partner Two',
  'is_legal_partner', true, 'share_pct', 40, 'current_account_id', tests.k('p2_current'), 'loan_account_id', tests.k('p2_loan')));
select api.upsert_partner_project(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'name', 'Test project shown', 'status', 'running', 'visible_to_investors', true));
select api.upsert_partner_project(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'name', 'Test project hidden', 'status', 'idea'));
select api.upsert_licence(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'kind', 'trade', 'licence_no', 'TEST-TRD-P7', 'valid_from', '2026-04-01'));
select tests.logout();

-- ── Investor: own rows only, no transaction rights ──
select tests.login(tests.k('investor1'));
select is((select string_agg(display_name, ',') from acct.partners), 'Test Partner One', 'an investor sees only their own partner row');
select is((select (api.investor_me() -> 'partners' -> 0 ->> 'name') || '|' || jsonb_array_length(api.investor_me() -> 'partners') || '|' || (api.investor_me() ->> 'can_transact')),
  'Test Partner One|1|false', 'investor_me: one partner row, no transactions');
select is((select count(*)::int from api.v_licence_register) + (select count(*)::int from acct.vouchers) + (select count(*)::int from api.companies) + (select count(*)::int from core.periods)
          + (select count(*)::int from api.v_job_work_orders) + (select count(*)::int from acct.gl_entries), 0,
  'the investor reads no licences, vouchers, companies, periods, job work or ledger rows');
select is((select sum(amount) from api.v_investor_money_in)::numeric, 30000.00::numeric, 'money in is an aggregate and leaves out without-GST receipts');
select is((api.investor_group_summary() -> 'companies' -> 0 ->> 'money_in_12m')::numeric, 30000.00::numeric, 'the group summary shows the same aggregate');
select is((select string_agg(name, ',') from api.v_investor_projects), 'Test project shown', 'only projects Admin shows to investors');
insert into ids select 'w1', api.submit_partner_request(gen_random_uuid(), 'withdraw', jsonb_build_object('partner_id', tests.id('p1'), 'source', 'land_rent', 'amount', 5000));
select is(tests.r('w1') ->> 'status', 'submitted', 'the investor sends a withdrawal request to Admin');
select is(tests.hint(format('select api.submit_partner_request(gen_random_uuid(), %L, jsonb_build_object(%L, %L, %L, %L))', 'info', 'partner_id', tests.id('p2'), 'purpose', 'Test')),
  'rights.missing', 'an investor cannot send a request as another partner');
select is((select array_agg(distinct h) from (select tests.hint(q) h from unnest(array[
    format('select api.decide_partner_request(gen_random_uuid(), %L, %L)', tests.id('w1'), 'approve'),
    format('select api.save_sales_draft(gen_random_uuid(), jsonb_build_object(%L, %L, %L, %L, %L, %L, %L, %L, %L, current_date, %L, jsonb_build_array(jsonb_build_object(%L, %L, %L, 1, %L, 100))))',
           'company_id', tests.k('company_a'), 'gstin_id', tests.k('gstin_a'), 'party_id', tests.k('cust'), 'doc_type', 'sales_invoice', 'doc_date', 'lines', 'product_id', tests.k('prod'), 'qty', 'rate'),
    format('select api.issue_job_work_challan(gen_random_uuid(), jsonb_build_object(%L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, jsonb_build_array(jsonb_build_object(%L, %L, %L, 1))))',
           'company_id', tests.k('company_a'), 'job_worker_party_id', tests.k('job_worker'), 'process', 'x', 'goods_kind', 'inputs', 'from_place_id', tests.k('stores'), 'lines', 'product_id', tests.k('rm2'), 'qty'),
    format('select api.upsert_licence(gen_random_uuid(), jsonb_build_object(%L, %L, %L, %L, %L, %L, %L, %L))', 'company_id', tests.k('company_a'), 'kind', 'trade', 'licence_no', 'X', 'valid_from', '2026-04-01'),
    format('select api.close_period(gen_random_uuid(), %L, %L)', tests.k('company_a'), tests.per('2026-10-01')),
    format('select api.open_close_checklist(gen_random_uuid(), %L, %L)', tests.k('company_a'), tests.per('2026-10-01')),
    format('select api.run_depreciation(gen_random_uuid(), %L, %L)', tests.k('company_a'), tests.per('2026-10-01')),
    format('select api.raise_repair_request(gen_random_uuid(), jsonb_build_object(%L, %L, %L, %L))', 'asset_id', tests.k('inj'), 'title', 'x'),
    format('select api.record_director_loan(gen_random_uuid(), jsonb_build_object(%L, %L, %L, %L, %L, %L, %L, 1))', 'partner_id', tests.id('p1'), 'direction', 'given', 'bank_account_id', tests.k('bank'), 'amount'),
    format('select api.set_setting(gen_random_uuid(), %L, %L, %L, null, %L)', tests.k('company_a'), 'investor.include_without_gst', 'true', 'x'),
    format('select api.post_opening_stock(gen_random_uuid(), jsonb_build_object(%L, %L, %L, %L, %L, jsonb_build_array(jsonb_build_object(%L, %L, %L, 1, %L, 1))))',
           'company_id', tests.k('company_a'), 'place_id', tests.k('stores'), 'lines', 'product_id', tests.k('rm2'), 'qty', 'unit_cost'),
    format('select api.upsert_partner(gen_random_uuid(), jsonb_build_object(%L, %L, %L, %L))', 'company_id', tests.k('company_a'), 'display_name', 'x'),
    format('select api.issue_spares(gen_random_uuid(), jsonb_build_object(%L, %L, %L, %L, %L, jsonb_build_array(jsonb_build_object(%L, %L, %L, 1))))',
           'company_id', tests.k('company_a'), 'place_id', tests.k('stores'), 'lines', 'product_id', tests.k('oil'), 'qty')]) q) x),
  array['rights.missing'], 'every representative write RPC refuses an investor');
select tests.logout();
select is((select count(*)::int from core.role_rights rr join core.rights r on r.key = rr.right_key where rr.role_key = 'investor' and r.action not in ('view', 'portal')), 0,
  'the investor role carries no create / edit / approve / cancel / manage right');
select tests.login(tests.k('investor2'));
select is((select count(*)::int from acct.partner_requests) + (select count(*)::int from api.v_investor_requests), 0, 'another investor sees none of these requests');
select tests.logout();

-- ── Admin decides: withdrawal against what is due ──
select tests.login(tests.k('admin'));
select is(tests.hint(format('select api.decide_partner_request(gen_random_uuid(), %L, %L)', tests.id('w1'), 'approve')), 'partner.over_due', 'nothing is due yet → the withdrawal is refused');
insert into ids select 'min', api.save_profit_share_minutes(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'fy_id', tests.k('fy_a'), 'meeting_date', '2026-05-11',
  'minutes_ref', 'TEST-MIN-1', 'basis', jsonb_build_object('incentives', jsonb_build_array(jsonb_build_object('partner_id', tests.id('p1'), 'pct', 10)))));
select is(tests.hint(format('select api.approve_profit_share_minutes(gen_random_uuid(), %L)', tests.id('min'))), 'sod.own_minutes', 'the Admin who entered the minutes cannot approve them');
select tests.logout();
select tests.login(tests.k('admin2'));
select api.approve_profit_share_minutes(gen_random_uuid(), tests.id('min'));
select tests.logout();
select tests.login(tests.k('admin'));
insert into ids select 'ps', api.compute_profit_share(gen_random_uuid(), tests.id('min'));
select is((tests.r('ps') ->> 'net_profit') || '|' || (tests.r('ps') ->> 'incentive_total') || '|' || (tests.r('ps') ->> 'distributable'), '100000.00|10000.00|90000.00',
  'net profit from the books; incentives (10%) first; the rest to share');
select is((select string_agg(x ->> 'kind' || ':' || (x ->> 'amount'), ',' order by (x ->> 'amount')::numeric) from jsonb_array_elements(tests.r('ps') -> 'lines') x),
  'incentive:10000.00,share:36000.00,share:54000.00', 'shares by 60 / 40');
select api.post_profit_share(gen_random_uuid(), tests.id('ps', 'run_id'));
select is(tests.cbal('p1_current'), 64000.00::numeric, 'the partner''s account is credited by the posted share');
insert into ids select 'w1_ok', api.decide_partner_request(gen_random_uuid(), tests.id('w1'), 'approve');
select is((tests.r('w1_ok') -> 'checks' ->> 'due')::numeric, 64000.00::numeric, 'now approved, with what was due recorded');
select is(api.pay_partner_request(gen_random_uuid(), tests.id('w1'), jsonb_build_object('bank_account_id', tests.k('bank'))) ->> 'status', 'paid', 'paid from the bank');
select is(tests.cbal('p1_current'), 59000.00::numeric, 'and the partner''s account goes down');
select tests.logout();

-- ── s.185: a loan to a director ──
select tests.login(tests.k('investor1'));
insert into ids select 'l185', api.submit_partner_request(gen_random_uuid(), 'loan_to_partner', jsonb_build_object('partner_id', tests.id('p1'), 'amount', 10000, 'repay_months', 6));
select tests.logout();
select tests.login(tests.k('admin'));
select is(tests.hint(format('select api.decide_partner_request(gen_random_uuid(), %L, %L, null, %L)', tests.id('l185'), 'approve', 'Test BR-1')), 'companies_act.s185',
  'a loan to a director is refused while no allowed exception is recorded (s.185)');
select api.set_setting(gen_random_uuid(), tests.k('company_a'), 'companies_act.director_loan_exception', '{"basis": "Test exception recorded with the CA"}', '2026-04-01', 'Test');
select is(tests.hint(format('select api.decide_partner_request(gen_random_uuid(), %L, %L)', tests.id('l185'), 'approve')), 'partner.board_resolution_required',
  'and needs the board resolution reference');
select is(api.decide_partner_request(gen_random_uuid(), tests.id('l185'), 'approve', null, 'Test BR-1') -> 'checks' ->> 'section', '185', 'approved with the s.185 basis recorded');
select tests.logout();

-- ── s.186: a loan to a partner who is not a director ──
select tests.login(tests.k('investor2'));
insert into ids select 'l186', api.submit_partner_request(gen_random_uuid(), 'loan_to_partner', jsonb_build_object('partner_id', tests.id('p2'), 'amount', 10000));
select tests.logout();
select tests.login(tests.k('admin'));
select is(tests.hint(format('select api.decide_partner_request(gen_random_uuid(), %L, %L, null, %L)', tests.id('l186'), 'approve', 'Test BR-2')), 'companies_act.s186_limit_not_set',
  'no s.186 limit recorded → refused, nothing assumed');
select api.set_setting(gen_random_uuid(), tests.k('company_a'), 'companies_act.loan_limit', '5000', '2026-04-01', 'Test limit');
select is(tests.hint(format('select api.decide_partner_request(gen_random_uuid(), %L, %L, null, %L)', tests.id('l186'), 'approve', 'Test BR-2')), 'companies_act.s186_limit',
  'over the s.186 limit → refused');
select tests.logout();

-- ── A director lends to the company: declaration first ──
select tests.login(tests.k('investor1'));
insert into ids select 'lfrom', api.submit_partner_request(gen_random_uuid(), 'loan_from_partner', jsonb_build_object('partner_id', tests.id('p1'), 'amount', 20000));
select tests.logout();
select tests.login(tests.k('admin'));
select is(tests.hint(format('select api.decide_partner_request(gen_random_uuid(), %L, %L)', tests.id('lfrom'), 'approve')), 'companies_act.director_declaration',
  'money from a director needs the written declaration first');
select api.record_director_declaration(gen_random_uuid(), jsonb_build_object('partner_id', tests.id('p1'), 'kind', 'not_borrowed', 'declared_on', current_date));
select api.decide_partner_request(gen_random_uuid(), tests.id('lfrom'), 'approve');
select is(api.record_director_loan(gen_random_uuid(), jsonb_build_object('partner_id', tests.id('p1'), 'direction', 'taken', 'amount', 20000, 'bank_account_id', tests.k('bank'),
  'request_id', tests.id('lfrom'))) -> 'legal_basis' ->> 'declaration_id', (select id::text from acct.director_declarations where partner_id = tests.id('p1')), 'the loan is posted against the declaration');
select is(tests.cbal('p1_loan'), 20000.00::numeric, 'the company owes the director on the loan account');

-- ── Nobody decides their own request ──
insert into ids select 'own', api.submit_partner_request(gen_random_uuid(), 'info', jsonb_build_object('partner_id', tests.id('p2'), 'purpose', 'Test question recorded by Admin'));
select is(tests.hint(format('select api.decide_partner_request(gen_random_uuid(), %L, %L)', tests.id('own'), 'approve')), 'sod.own_request', 'Admin cannot decide a request they entered');
select tests.logout();
select tests.login(tests.k('admin2'));
select is(api.decide_partner_request(gen_random_uuid(), tests.id('own'), 'approve') ->> 'status', 'approved', 'another Admin decides it');
select tests.logout();

-- ── Month-end close: doer ≠ checker ──
select tests.login(tests.k('finance'));
insert into ids select 'cl', api.open_close_checklist(gen_random_uuid(), tests.k('company_a'), tests.per('2026-10-01'),
  jsonb_build_object('doer_user_id', tests.k('finance'), 'checker_user_id', tests.k('acct')));
select is((tests.r('cl') ->> 'tasks')::int || '|' || (tests.r('cl') ->> 'due_on'), '9|2026-11-10', 'the October checklist is due on the 10th of November');
select is(tests.hint(format('select api.close_period(gen_random_uuid(), %L, %L)', tests.k('company_a'), tests.per('2026-10-01'))), 'close.tasks_open', 'the month cannot close with open tasks');
select tests.logout();
select tests.login(tests.k('acct'));
select is(tests.hint(format('select api.complete_close_task(gen_random_uuid(), %L, %L)', (select id from acct.close_tasks where checklist_id = tests.id('cl') limit 1), 'done')),
  'close.not_doer', 'the checker cannot do the task');
select tests.logout();
select tests.login(tests.k('finance'));
select count(api.complete_close_task(gen_random_uuid(), t.id, 'done')) from acct.close_tasks t where t.checklist_id = tests.id('cl');
select is(tests.hint(format('select api.complete_close_task(gen_random_uuid(), %L, %L)', (select id from acct.close_tasks where checklist_id = tests.id('cl') limit 1), 'check')),
  'sod.doer_is_checker', 'the doer cannot check their own task');
select tests.logout();
select tests.login(tests.k('acct'));
select count(api.complete_close_task(gen_random_uuid(), t.id, 'check')) from acct.close_tasks t where t.checklist_id = tests.id('cl');
select tests.logout();
select tests.login(tests.k('finance'));
select is(api.close_period(gen_random_uuid(), tests.k('company_a'), tests.per('2026-10-01')) ->> 'status', 'closed', 'every task done and checked → October closes');
select tests.logout();

-- ── A closed month refuses postings, even with a special grant ──
select is(tests.hint($q$ select app.post_voucher(jsonb_build_object('company_id', tests.k('company_a'), 'fy_id', tests.k('fy_a'), 'voucher_type', 'journal', 'doc_no', 'TEST-P7-J2',
  'voucher_date', '2026-10-20', 'client_request_id', gen_random_uuid()), jsonb_build_array(jsonb_build_object('account_id', tests.k('bank'), 'dr', 1), jsonb_build_object('account_id', tests.k('cash'), 'cr', 1))) $q$),
  'period.closed', 'the ledger itself refuses an entry dated in the closed month');
update core.rights set admin_only = false, grantable_by_permission = true where key = 'period.reopen';   -- test only: pretend the right could still be granted
insert into core.special_grants (code, user_id, right_key, company_id, starts_at, ends_at, reason, granted_by)
values ('TP7GRANT', tests.k('acct'), 'period.reopen', tests.k('company_a'), now() - interval '1 hour', now() + interval '1 hour', 'Test grant to post into a closed month', tests.k('admin'));
select tests.login(tests.k('acct'));
select is(tests.hint(format('select app.fy_for(%L, %L)', tests.k('company_a'), '2026-10-20')), 'period.closed', 'a "reopen" special grant does not let anyone post into a closed month');
select tests.logout();
select tests.login(tests.k('admin'));
select is(tests.hint(format('select api.run_depreciation(gen_random_uuid(), %L, %L)', tests.k('company_a'), tests.per('2026-10-01'))), 'period.closed', 'not even Admin posts into it');
select tests.logout();
select throws_ok(format('update core.periods set status = %L where id = %L', 'open', tests.per('2026-10-01')), '42501', null, 'a closed month cannot be opened by a direct update');

-- ── Reopen: Admin only, with a reason, logged ──
select tests.login(tests.k('finance'));
select is(tests.hint(format('select api.reopen_period(gen_random_uuid(), %L, %L, %L)', tests.k('company_a'), tests.per('2026-10-01'), 'Test late supplier bill')), 'period.reopen_admin_only',
  'only Admin reopens a month');
select tests.logout();
select tests.login(tests.k('admin'));
select is(tests.hint(format('select api.reopen_period(gen_random_uuid(), %L, %L, %L)', tests.k('company_a'), tests.per('2026-10-01'), 'late')), 'period.reason_required', 'a reason is required');
select api.reopen_period(gen_random_uuid(), tests.k('company_a'), tests.per('2026-10-01'), 'Test late supplier bill to record');
select tests.logout();
select is((select count(*)::int from acct.period_events where period_id = tests.per('2026-10-01') and action = 'reopened')
          + (select count(*)::int from audit.user_log where event = 'admin_action' and detail ->> 'action' = 'reopened' and detail ->> 'id' = tests.per('2026-10-01')::text), 2,
  'the reopening is logged with its reason');
select is(tests.hint(format('select app.fy_for(%L, %L)', tests.k('company_a'), '2026-10-20')), 'no error', 'once reopened, entries can be dated in October again');

select * from finish();

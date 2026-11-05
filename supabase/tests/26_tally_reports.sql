-- Tally reports (Day Book, Trial Balance, Stock Summary, Balance Sheet): staging is idempotent, opening balances only by Admin and
-- only when balanced and mapped, group-wise sheets refused, stock applied once, Day Book lines (one leg, never posted) keep
-- their Dr/Cr side and load twice-identical lines twice, voucher types sold without GST stay Admin/CA only, RLS between
-- companies, compare shows differences. Synthetic data only; everything is rolled back.
select plan(67);

create temp table s as select tests.seed4(tests.seed3(tests.seed2(tests.seed()))) as v;
grant select on s to authenticated;
create or replace function tests.k(p text) returns uuid language sql stable as $$ select (v ->> p)::uuid from s $$;
create or replace function tests.rule(p_sql text) returns text language plpgsql as $$
declare h text;
begin
  execute p_sql;
  return 'ok';
exception when others then
  get stacked diagnostics h = pg_exception_hint;
  return coalesce(nullif(h, ''), sqlstate);
end $$;
grant execute on all functions in schema tests to authenticated;
create temp table ids (k text primary key, v jsonb);
grant select, insert on ids to authenticated;
create or replace function tests.r(p text) returns jsonb language sql stable as $$ select v from ids where k = p $$;

-- "Load Tally data" is a special right; for this test the accountant roles hold it so we can see what a non-Admin importer may do.
insert into core.role_rights (role_key, right_key) values ('accountant', 'data.import') on conflict do nothing;

create or replace function tests.tb(p_sha text, p_asof text, p_lines jsonb, p_grain text default 'ledger', p_totals jsonb default '{}') returns jsonb
language sql as $$
  select api.stage_tally_report(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'kind', 'trial_balance', 'as_of', p_asof, 'file_name', 'tb.xlsx',
    'file_sha256', repeat(p_sha, 64), 'grain', p_grain, 'lines', p_lines, 'totals', p_totals))
$$;
grant execute on function tests.tb(text, text, jsonb, text, jsonb) to authenticated;

-- ── Staging: idempotent by company, kind, as-of and file checksum ──
select tests.login(tests.k('admin'));
insert into ids select 'tb1', tests.tb('1', '2026-03-31', jsonb_build_array(
  jsonb_build_object('name', 'Sundry Debtors', 'parents', '[]'::jsonb, 'is_group', true, 'dr', 500, 'cr', 0),
  jsonb_build_object('name', 'Test Cust X', 'parents', jsonb_build_array('Sundry Debtors'), 'is_group', false, 'dr', 500, 'cr', 0),
  jsonb_build_object('name', 'Test Bank Y', 'parents', jsonb_build_array('Bank Accounts'), 'is_group', false, 'dr', 300, 'cr', 0),
  jsonb_build_object('name', 'Test Creditor Z', 'parents', jsonb_build_array('Sundry Creditors'), 'is_group', false, 'dr', 0, 'cr', 800)),
  'ledger', '{"tally_dr":800,"tally_cr":800}');
select is((tests.r('tb1') ->> 'duplicate')::boolean, false, 'a new Trial Balance is staged');
select is((tests.r('tb1') -> 'totals' ->> 'dr')::numeric, 800::numeric, 'the server adds up the ledger lines itself (groups are not counted twice)');
select is((tests.tb('1', '2026-03-31', '[{"name":"x","dr":1,"cr":0}]') ->> 'duplicate')::boolean, true, 'the same file again is recognised, nothing new is staged');
select is((select count(*)::int from ops.tally_reports where kind = 'trial_balance' and company_id = tests.k('company_a')), 1, 'only one report row exists for that file');
select tests.logout();

-- ── Rights and RLS ──
select tests.login(tests.k('acct'));
select is(tests.rule($$ select tests.tb('2', '2026-03-31', '[{"name":"x","dr":1,"cr":0}]') $$), 'ok', 'the accountant holding Load Tally data may stage a report for the company');
select is(tests.rule($$ select api.apply_trial_balance_as_opening(gen_random_uuid(), (select (tests.r('tb1') ->> 'id')::uuid)) $$), 'rights.missing', 'only Admin applies a Trial Balance as opening balances');
select is((select count(*)::int from api.tally_reports where company_id = tests.k('company_a')), 2, 'a holder of Load Tally data sees the reports of their company');
select tests.logout();
select tests.login(tests.k('plastics_user'));
select is((select count(*)::int from api.tally_reports where company_id = tests.k('company_a')), 0, 'another company''s reports are invisible');
select is(tests.rule($$ select tests.tb('3', '2026-03-31', '[{"name":"x","dr":1,"cr":0}]') $$), 'rights.missing', 'a person without rights to company A cannot stage a report into it');
select tests.logout();
select tests.login(tests.k('ca'));
select is((select count(*)::int from api.tally_reports where company_id = tests.k('company_a')), 2, 'the CA reads the staged reports');
select is(tests.rule($$ select tests.tb('4', '2026-03-31', '[{"name":"x","dr":1,"cr":0}]') $$), 'rights.read_only', 'the CA cannot stage anything (read only)');
select tests.logout();
select tests.login(tests.k('admin'));
select throws_ok($$ update ops.tally_reports set lines = '[]' where kind = 'trial_balance' $$, '42501', null, 'staged lines are never edited');
select throws_ok($$ delete from ops.tally_reports $$, '42501', null, 'a staged report is never deleted');
select tests.logout();

-- ── Dr ≠ Cr is refused and shown as a Bug fixer total_mismatch ──
select tests.login(tests.k('admin'));
insert into ids select 'tb_bad', tests.tb('5', '2026-03-31', jsonb_build_array(
  jsonb_build_object('name', 'Test Cust X', 'parents', jsonb_build_array('Sundry Debtors'), 'is_group', false, 'dr', 500, 'cr', 0),
  jsonb_build_object('name', 'Test Creditor Z', 'parents', jsonb_build_array('Sundry Creditors'), 'is_group', false, 'dr', 0, 'cr', 400)));
insert into ids select 'ap_bad', api.apply_trial_balance_as_opening(gen_random_uuid(), (tests.r('tb_bad') ->> 'id')::uuid);
select is((tests.r('ap_bad') ->> 'applied')::boolean, false, 'a Trial Balance with Dr ≠ Cr is refused');
select is(tests.r('ap_bad') ->> 'refused', 'total_mismatch', 'the refusal says total_mismatch');
select is((select count(*)::int from ops.bug_items where kind = 'total_mismatch' and ref_id = (tests.r('tb_bad') ->> 'id')::uuid), 1, 'the difference is a Bug fixer item');
select is((select count(*)::int from acct.accounts where company_id = tests.k('company_a') and name_norm = app.norm_name('Test Cust X')), 0, 'nothing was created or changed');

-- ── A ledger under an unmapped Tally group → "Map this head", nothing applied ──
insert into ids select 'tb_odd', tests.tb('6', '2026-03-31', jsonb_build_array(
  jsonb_build_object('name', 'Test Cust X', 'parents', jsonb_build_array('Sundry Debtors'), 'is_group', false, 'dr', 500, 'cr', 0),
  jsonb_build_object('name', 'Test Odd Ledger', 'parents', jsonb_build_array('Test Odd Group'), 'is_group', false, 'dr', 0, 'cr', 500)));
insert into ids select 'ap_odd', api.apply_trial_balance_as_opening(gen_random_uuid(), (tests.r('tb_odd') ->> 'id')::uuid);
select is(tests.r('ap_odd') ->> 'refused', 'unmapped', 'a ledger under an unmapped group stops the apply');
select is((select count(*)::int from ops.bug_items where kind = 'map_head' and title = 'Map this head: Test Odd Group'), 1, 'a "Map this head" item is opened');
select is((select count(*)::int from acct.accounts where company_id = tests.k('company_a') and name_norm in (app.norm_name('Test Cust X'), app.norm_name('Test Odd Ledger'))), 0, 'no account was created while a head is unmapped');

-- ── Group-wise sheet: asked for the expanded export ──
insert into ids select 'tb_grp', tests.tb('7', '2026-03-31', jsonb_build_array(
  jsonb_build_object('name', 'Current Assets', 'parents', '[]'::jsonb, 'is_group', true, 'dr', 500, 'cr', 0),
  jsonb_build_object('name', 'Capital Account', 'parents', '[]'::jsonb, 'is_group', true, 'dr', 0, 'cr', 500)), 'group');
select is(tests.rule(format($$ select api.apply_trial_balance_as_opening(gen_random_uuid(), %L) $$, tests.r('tb_grp') ->> 'id')), 'report.group_wise', 'a group-wise Trial Balance is refused (export ledger-wise)');
select tests.logout();

-- ── The good apply: opening balances set, party ledgers' bills untouched, nothing posted ──
select tests.login(tests.k('admin'));
select is((select count(*)::int from acct.vouchers where company_id = tests.k('company_a')), 0, 'precondition: no posted vouchers');
insert into ids select 'ap_ok', api.apply_trial_balance_as_opening('bbbbbbbb-0000-4000-8000-000000000001', (tests.r('tb1') ->> 'id')::uuid);
select is((tests.r('ap_ok') ->> 'applied')::boolean, true, 'a balanced, mapped Trial Balance is applied');
select is((select opening_balance || opening_dc from acct.accounts where company_id = tests.k('company_a') and name = 'Test Cust X'), '500.00D', 'a debit ledger gets its opening balance as Dr');
select is((select opening_balance || opening_dc from acct.accounts where company_id = tests.k('company_a') and name = 'Test Creditor Z'), '800.00C', 'a credit ledger gets its opening balance as Cr');
select is((select opening_as_of from acct.accounts where company_id = tests.k('company_a') and name = 'Test Bank Y'), date '2026-03-31', 'the opening date is the report date');
select is((select group_id from acct.accounts where name = 'Test Cust X' and company_id = tests.k('company_a')), (select account_group_id from ops.tally_group_map where company_id = tests.k('company_a') and tally_group = 'Sundry Debtors'), 'a missing account is created in the group mapped to its Tally group');
select is((select count(*)::int from acct.vouchers where company_id = tests.k('company_a')) + (select count(*)::int from acct.gl_entries where company_id = tests.k('company_a')), 0, 'no voucher or ledger entry was posted');
select is(api.apply_trial_balance_as_opening('bbbbbbbb-0000-4000-8000-000000000001', (tests.r('tb1') ->> 'id')::uuid) ->> 'applied', 'true', 'repeating the same request returns the first result');
select is(tests.rule(format($$ select api.apply_trial_balance_as_opening(gen_random_uuid(), %L) $$, tests.r('tb1') ->> 'id')), 'report.already_applied', 'a report cannot be applied twice');
select is((select status from ops.tally_reports where id = (tests.r('tb1') ->> 'id')::uuid), 'applied', 'the report shows as applied');
select tests.logout();

-- ── Posted vouchers after the report date block the apply ──
insert into acct.vouchers (company_id, fy_id, voucher_type, doc_no, voucher_date, amount, client_request_id) values (tests.k('company_a'), tests.k('fy_a'), 'journal', 'TEST-J1', '2026-06-10', 0, gen_random_uuid());
select tests.login(tests.k('admin'));
insert into ids select 'tb_late', tests.tb('8', '2026-03-31', jsonb_build_array(
  jsonb_build_object('name', 'Test Cust X', 'parents', jsonb_build_array('Sundry Debtors'), 'is_group', false, 'dr', 100, 'cr', 0),
  jsonb_build_object('name', 'Test Creditor Z', 'parents', jsonb_build_array('Sundry Creditors'), 'is_group', false, 'dr', 0, 'cr', 100)));
select is(tests.rule(format($$ select api.apply_trial_balance_as_opening(gen_random_uuid(), %L) $$, tests.r('tb_late') ->> 'id')), 'report.vouchers_after', 'opening balances cannot be set once vouchers are posted after the date');
select tests.logout();

-- ── Compare with the ERP trial balance (parallel run) ──
select tests.login(tests.k('admin'));
insert into ids select 'tb_cmp', tests.tb('9', '2026-03-31', jsonb_build_array(
  jsonb_build_object('name', 'Test Cust X', 'parents', jsonb_build_array('Sundry Debtors'), 'is_group', false, 'dr', 520, 'cr', 0),
  jsonb_build_object('name', 'Test Bank Y', 'parents', jsonb_build_array('Bank Accounts'), 'is_group', false, 'dr', 300, 'cr', 0),
  jsonb_build_object('name', 'Test New Only Tally', 'parents', jsonb_build_array('Bank Accounts'), 'is_group', false, 'dr', 0, 'cr', 20)));
select is((select status from api.compare_trial_balance((tests.r('tb_cmp') ->> 'id')::uuid) where ledger = 'Test Bank Y'), 'match', 'a ledger that agrees shows match');
select is((select diff from api.compare_trial_balance((tests.r('tb_cmp') ->> 'id')::uuid) where ledger = 'Test Cust X'), -20.00::numeric, 'a difference shows ERP minus Tally');
select is((select status from api.compare_trial_balance((tests.r('tb_cmp') ->> 'id')::uuid) where ledger = 'Test New Only Tally'), 'only_in_tally', 'a ledger only in Tally is listed');
select is((select status from api.compare_trial_balance((tests.r('tb_cmp') ->> 'id')::uuid) where ledger = 'Test Creditor Z'), 'only_in_erp', 'a ledger only in the ERP is listed');
select is((select count(*)::int from api.tally_report_diffs where report_id = (tests.r('tb_cmp') ->> 'id')::uuid and status <> 'match'), 3, 'the differences view lists the three differences');
select tests.logout();
select tests.login(tests.k('plastics_user'));
select is(tests.rule(format($$ select * from api.compare_trial_balance(%L) $$, tests.r('tb_cmp') ->> 'id')), 'report.missing', 'another company cannot compare it');
select tests.logout();

-- ── Balance Sheet: stored for reconciliation only; mapped groups compared ──
select tests.login(tests.k('admin'));
insert into ids select 'bs1', api.stage_tally_report(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'kind', 'balance_sheet', 'as_of', '2026-03-31', 'file_name', 'bs.xlsx',
  'file_sha256', repeat('b', 64), 'lines', jsonb_build_array(
    jsonb_build_object('side', 'L', 'name', 'Sundry Creditors', 'depth', 0, 'is_group', true, 'is_total', false, 'amount', 800),
    jsonb_build_object('side', 'A', 'name', 'Sundry Debtors', 'depth', 0, 'is_group', true, 'is_total', false, 'amount', 500),
    jsonb_build_object('side', 'A', 'name', 'Bank Accounts', 'depth', 0, 'is_group', true, 'is_total', false, 'amount', 301),
    jsonb_build_object('side', 'A', 'name', 'Test Odd Group', 'depth', 0, 'is_group', true, 'is_total', false, 'amount', 10),
    jsonb_build_object('side', 'L', 'name', 'Total', 'depth', 0, 'is_group', false, 'is_total', true, 'amount', 800))));
select is((select status from api.compare_balance_sheet((tests.r('bs1') ->> 'id')::uuid) where line = 'Sundry Debtors'), 'match', 'a mapped group that agrees matches');
select is((select diff from api.compare_balance_sheet((tests.r('bs1') ->> 'id')::uuid) where line = 'Bank Accounts'), -1.00::numeric, 'a group that differs shows the difference');
select is((select status from api.compare_balance_sheet((tests.r('bs1') ->> 'id')::uuid) where line = 'Test Odd Group'), 'not_mapped', 'an unmapped group is flagged');
select is(tests.rule(format($$ select api.apply_trial_balance_as_opening(gen_random_uuid(), %L) $$, tests.r('bs1') ->> 'id')), 'report.kind', 'a Balance Sheet can never be applied');
select tests.logout();

-- ── Stock Summary → opening stock ──
insert into master.product_companies (product_id, company_id) values (tests.k('rm1'), tests.k('company_a')) on conflict do nothing;
select tests.login(tests.k('admin'));
insert into ids select 'ss1', api.stage_tally_report(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'kind', 'stock_summary', 'as_of', '2026-06-01', 'file_name', 'ss.xlsx',
  'file_sha256', repeat('c', 64), 'totals', '{"tally_value":78}', 'lines', jsonb_build_array(
    jsonb_build_object('name', (select name from master.products where id = tests.k('rm1')), 'parents', '[]'::jsonb, 'is_group', false, 'qty', 10, 'unit', 'Nos', 'rate', 5, 'value', 50),
    jsonb_build_object('name', 'Test Unknown Item', 'parents', '[]'::jsonb, 'is_group', false, 'qty', 7, 'unit', 'Nos', 'rate', 4, 'value', 28),
    jsonb_build_object('name', 'Test Negative Item', 'parents', '[]'::jsonb, 'is_group', false, 'qty', -2, 'unit', 'Nos', 'rate', 4, 'value', -8))));
select tests.logout();
select tests.login(tests.k('plastics_user'));
select is(tests.rule(format($$ select api.apply_stock_summary_as_opening_stock(gen_random_uuid(), %L, %L) $$, tests.r('ss1') ->> 'id', tests.k('stores'))), 'rights.missing', 'a person without stock approval for the company cannot post opening stock');
select tests.logout();
select tests.login(tests.k('admin'));
insert into ids select 'ss_ref', api.apply_stock_summary_as_opening_stock(gen_random_uuid(), (tests.r('ss1') ->> 'id')::uuid, tests.k('stores'));
select is(tests.r('ss_ref') ->> 'refused', 'unmatched', 'unmatched items stop the apply and are listed');
select is((tests.r('ss_ref') -> 'unmatched' -> 0 ->> 'name'), 'Test Unknown Item', 'the unmatched item is named');
select is((select count(*)::int from inv.stock_ledger where company_id = tests.k('company_a') and move_type = 'opening'), 0, 'nothing was posted');
select is((select count(*)::int from api.tally_report_stock_match where report_id = (tests.r('ss1') ->> 'id')::uuid and status = 'unmatched'), 1, 'the match view shows one unmatched item');
select lives_ok(format($$ select api.map_tally_stock_item(gen_random_uuid(), %L, 'Test Unknown Item', %L) $$, tests.r('ss1') ->> 'id', tests.k('rm2')), 'the item is mapped to an existing product (an alias, nothing new is created)');
insert into ids select 'ss_ok', api.apply_stock_summary_as_opening_stock(gen_random_uuid(), (tests.r('ss1') ->> 'id')::uuid, tests.k('stores'));
select is((tests.r('ss_ok') ->> 'applied')::boolean, true, 'with every item matched the opening stock is posted');
select is((select qty from inv.stock_balances where product_id = tests.k('rm1') and place_id = tests.k('stores') and bucket = 'available'), 10.000::numeric(18,3), 'the quantity is in the store');
select is((select qty from inv.stock_balances where product_id = tests.k('rm2') and place_id = tests.k('stores') and bucket = 'available'), 7.000::numeric(18,3), 'the mapped item is in the store');
select is((select count(*)::int from ops.bug_items where kind = 'negative_stock' and ref_id = (tests.r('ss1') ->> 'id')::uuid), 1, 'the negative line goes to the Bug fixer and is not posted');
select is(tests.rule(format($$ select api.apply_stock_summary_as_opening_stock(gen_random_uuid(), %L, %L) $$, tests.r('ss1') ->> 'id', tests.k('stores'))), 'report.already_applied', 'opening stock cannot be applied twice');
select is((tests.r('ss_ok') ->> 'value')::numeric, 78.00::numeric, 'the posted value uses the Tally rates (10×5 + 7×4)');
select tests.logout();

-- ── Day Book: one leg per line, Admin only, keys, chunked processing ──
select tests.login(tests.k('admin'));
insert into ids select 'db1', api.import_create_batch(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'source', 'excel', 'kind', 'vouchers', 'file_name', 'daybook.xlsx',
  'totals', jsonb_build_object('voucher_count', 4)));
select api.import_stage_rows((tests.r('db1') ->> 'id')::uuid, jsonb_build_array(
  jsonb_build_object('object_type', 'voucher', 'name', 'R-1', 'payload', jsonb_build_object('type', 'Receipt', 'number', 'R-1', 'date', '2021-04-01', 'party', 'Test Cust X', 'amount', 100, 'dc', 'cr', 'match_key', 'Receipt|R-1|2021-04-01|100.00|Test Cust X|cr')),
  jsonb_build_object('object_type', 'voucher', 'name', '7', 'payload', jsonb_build_object('type', 'SALES WO', 'number', '7', 'date', '2021-04-02', 'party', 'Test Walk-in', 'amount', 80, 'dc', 'dr', 'match_key', 'SALES WO|7|2021-04-02|80.00|Test Walk-in|dr')),
  jsonb_build_object('object_type', 'voucher', 'name', '7', 'payload', jsonb_build_object('type', 'SALES WO', 'number', '7', 'date', '2021-04-02', 'party', 'Test Walk-in', 'amount', 80, 'dc', 'dr', 'match_key', 'SALES WO|7|2021-04-02|80.00|Test Walk-in|dr|#2')),
  jsonb_build_object('object_type', 'voucher', 'name', 'S-1', 'payload', jsonb_build_object('type', 'Stock Journal', 'number', 'S-1', 'date', '2021-04-04', 'party', 'Test Item Move', 'amount', 0, 'match_key', 'Stock Journal|S-1|2021-04-04|0.00|Test Item Move|'))));
select is((api.import_process_step(gen_random_uuid(), (tests.r('db1') ->> 'id')::uuid, 3) ->> 'remaining')::int, 1, 'a processing step handles at most the given number of rows');
select is((api.import_process_step(gen_random_uuid(), (tests.r('db1') ->> 'id')::uuid, 3) ->> 'remaining')::int, 0, 'the next step finishes the rest');
select api.import_process(gen_random_uuid(), (tests.r('db1') ->> 'id')::uuid);
select is((select count(*)::int from ops.tally_vouchers where company_id = tests.k('company_a')), 4, 'two identical lines in one file both load');
select is((select dc::text from ops.tally_vouchers where voucher_no = 'R-1' and company_id = tests.k('company_a')), 'C', 'the credit side is kept');
select is((select count(*)::int from ops.bug_items where kind = 'unbalanced_voucher' and company_id = tests.k('company_a')), 0, 'a one-leg Day Book line is not an unbalanced voucher');
select is((select count(*)::int from acct.vouchers where company_id = tests.k('company_a') and doc_no <> 'TEST-J1'), 0, 'Day Book lines are not posted to the books');
insert into ids select 'db2', api.import_create_batch(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'source', 'excel', 'kind', 'vouchers', 'file_name', 'daybook.xlsx'));
select api.import_stage_rows((tests.r('db2') ->> 'id')::uuid, jsonb_build_array(
  jsonb_build_object('object_type', 'voucher', 'name', 'R-1', 'payload', jsonb_build_object('type', 'Receipt', 'number', 'R-1', 'date', '2021-04-01', 'party', 'Test Cust X', 'amount', 100, 'dc', 'cr', 'match_key', 'Receipt|R-1|2021-04-01|100.00|Test Cust X|cr'))));
select api.import_process(gen_random_uuid(), (tests.r('db2') ->> 'id')::uuid);
select is((select count(*)::int from ops.tally_vouchers where company_id = tests.k('company_a')), 4, 'the same Day Book again loads nothing new');
select is((select count(*)::int from ops.import_rows where batch_id = (tests.r('db2') ->> 'id')::uuid and result = 'skipped'), 1, 'and is counted as skipped');
select tests.logout();

-- A holder of Load Tally data who is not Admin cannot load or see vouchers (types sold without GST stay Admin/CA only).
select tests.login(tests.k('acct'));
insert into ids select 'db3', api.import_create_batch(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'source', 'excel', 'kind', 'vouchers', 'file_name', 'x.xlsx'));
select is(tests.rule(format($$ select api.import_stage_rows(%L, '[{"object_type":"voucher","name":"x","payload":{"type":"SALES WO","number":"9","date":"2021-04-05","amount":5,"dc":"dr"}}]'::jsonb) $$, tests.r('db3') ->> 'id')), 'rights.missing', 'only Admin loads vouchers');
select is((select count(*)::int from ops.import_rows where object_type = 'voucher'), 0, 'voucher rows of an Admin batch are invisible to a non-Admin importer');
select is((select count(*)::int from api.tally_vouchers), 0, 'the voucher list is empty for a non-Admin');
select tests.logout();
select tests.login(tests.k('ca'));
select is((select count(*)::int from api.tally_vouchers where voucher_type = 'SALES WO' and company_id = tests.k('company_a')), 2, 'the CA sees every voucher type');
select tests.logout();

-- Speed of the chunked path: 3,000 lines in steps of 500, each step well inside a request timeout.
select tests.login(tests.k('admin'));
insert into ids select 'db4', api.import_create_batch(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'source', 'excel', 'kind', 'vouchers', 'file_name', 'big.xlsx'));
select api.import_stage_rows((tests.r('db4') ->> 'id')::uuid, (select jsonb_agg(jsonb_build_object('object_type', 'voucher', 'name', n::text, 'payload', jsonb_build_object('type', 'Payment', 'number', n::text, 'date', '2022-01-01', 'party', 'Test Party ' || (n % 300), 'amount', 10 + n % 50, 'dc', 'dr', 'match_key', 'Payment|' || n || '|2022-01-01'))) from generate_series(1, 3000) n));
create temp table t0 as select clock_timestamp() as t;
select api.import_process_step(gen_random_uuid(), (tests.r('db4') ->> 'id')::uuid, 500);
select ok(clock_timestamp() - (select t from t0) < interval '8 seconds', 'one step of 500 Day Book lines runs well inside a request timeout');
select diag('500 Day Book lines took ' || (clock_timestamp() - (select t from t0))::text);
select tests.logout();

select * from finish();

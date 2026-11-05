-- Trial Balance as opening balances, extended: Tally's own difference carried in a named Suspense ledger (Admin, reason, never more
-- than the file declares), pseudo-lines (Opening Stock, Unadjusted Forex) never opened, unmapped ledgers skipped on request, unlisted
-- ledgers zeroed on request. Synthetic data only; everything is rolled back.
select plan(23);

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

create or replace function tests.tb(p_sha text, p_asof text, p_lines jsonb, p_totals jsonb default '{}') returns jsonb
language sql as $$
  select api.stage_tally_report(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'kind', 'trial_balance', 'as_of', p_asof, 'file_name', 'tb.xlsx',
    'file_sha256', repeat(p_sha, 64), 'grain', 'ledger', 'lines', p_lines, 'totals', p_totals))
$$;
grant execute on function tests.tb(text, text, jsonb, jsonb) to authenticated;
create or replace function tests.ln(p_name text, p_group text, p_dr numeric, p_cr numeric) returns jsonb language sql immutable as $$
  select jsonb_build_object('name', p_name, 'parents', case when p_group is null then '[]'::jsonb else jsonb_build_array(p_group) end, 'is_group', false, 'dr', p_dr, 'cr', p_cr)
$$;
grant execute on function tests.ln(text, text, numeric, numeric) to authenticated;

select tests.login(tests.k('admin'));
-- Report 1: ledgers Dr 800 / Cr 790, plus Tally's "Opening Stock" line (Dr 100): the file's gap is 110 and it declares 110.
insert into ids select 'r1', tests.tb('a', '2026-11-03', jsonb_build_array(
  tests.ln('Test Cust X', 'Sundry Debtors', 500, 0), tests.ln('Test Bank Y', 'Bank Accounts', 300, 0), tests.ln('Test Creditor Z', 'Sundry Creditors', 0, 790),
  tests.ln('Opening Stock', null, 100, 0)), '{"diff_dr":110,"diff_cr":0}');
-- Report 2: the same gap of 110 but the file declares only 100.
insert into ids select 'r2', tests.tb('b', '2026-11-03', jsonb_build_array(
  tests.ln('Test Cust X', 'Sundry Debtors', 500, 0), tests.ln('Test Bank Y', 'Bank Accounts', 300, 0), tests.ln('Test Creditor Z', 'Sundry Creditors', 0, 690)), '{"diff_dr":100,"diff_cr":0}');
select tests.logout();

-- ── Refusals ──
select tests.login(tests.k('admin'));
select is(api.apply_trial_balance_as_opening(gen_random_uuid(), (tests.r('r1') ->> 'id')::uuid) ->> 'refused', 'total_mismatch', 'without the option an unbalanced Trial Balance is refused as before');
select is(tests.rule($$ select api.apply_trial_balance_as_opening(gen_random_uuid(), (tests.r('r1') ->> 'id')::uuid, true) $$), 'rights.reason_required', 'carrying the difference needs a reason');
select is(api.apply_trial_balance_as_opening(gen_random_uuid(), (tests.r('r2') ->> 'id')::uuid, true, 'tally difference for the CA') ->> 'refused', 'difference_exceeds_declared', 'a gap larger than the file declares is refused, even by one rupee');
select is((select count(*)::int from acct.accounts where company_id = tests.k('company_a') and name like 'Test Cust X'), 0, 'nothing was changed by the refusals');
select ok(exists (select 1 from ops.bug_items where company_id = tests.k('company_a') and dedupe_key = 'tbgap|' || (tests.r('r2') ->> 'id') and severity = 'high'), 'the refused gap is a high Bug fixer item');
select tests.logout();
select tests.login(tests.k('acct'));
select is(tests.rule($$ select api.apply_trial_balance_as_opening(gen_random_uuid(), (tests.r('r1') ->> 'id')::uuid, true, 'tally difference for the CA') $$), 'rights.missing', 'only Admin may carry a difference');
select tests.logout();

-- ── Apply report 1 with the difference carried ──
select tests.login(tests.k('admin'));
insert into ids select 'a1', api.apply_trial_balance_as_opening(gen_random_uuid(), (tests.r('r1') ->> 'id')::uuid, true, 'tally difference for the CA');
select tests.logout();
select is((tests.r('a1') ->> 'applied')::boolean, true, 'the Trial Balance is applied with the difference carried');
select is(tests.r('a1') ->> 'status', 'applied', 'the report is applied');
select is((select (r.v -> 'suspense' ->> 'tally_difference_net_dr')::numeric from ids r where k = 'a1'), -110::numeric, 'Tally difference of 110 is booked on the credit side of a Suspense ledger');
select is((select opening_balance::numeric from acct.accounts where company_id = tests.k('company_a') and name like 'Difference in opening balances (Tally)%'), 110::numeric, 'the named Suspense ledger carries exactly the difference');
select is((select opening_dc::text from acct.accounts where company_id = tests.k('company_a') and name like 'Difference in opening balances (Tally)%'), 'C', 'on the credit side');
select is((select g.name from acct.accounts a join acct.account_groups g on g.id = a.group_id where a.company_id = tests.k('company_a') and a.name like 'Difference in opening balances (Tally)%'), 'Suspense A/c', 'it sits under the Suspense A/c group');
select is((select opening_balance::numeric from acct.accounts where company_id = tests.k('company_a') and name like 'Tally computed lines not carried%'), 100::numeric, 'the Opening Stock pseudo-line is parked, not opened as a ledger');
select is((select count(*)::int from acct.accounts where company_id = tests.k('company_a') and name = 'Opening Stock'), 0, 'no ledger called Opening Stock exists');
select is((select sum(opening_balance) filter (where opening_dc = 'D') = sum(opening_balance) filter (where opening_dc = 'C') from acct.accounts where company_id = tests.k('company_a')), true, 'debit equals credit for the company after the Suspense lines');
select is((select count(*)::int from ops.bug_items where company_id = tests.k('company_a') and dedupe_key in ('tbdiff|' || (tests.r('r1') ->> 'id'), 'tbpseudo|' || (tests.r('r1') ->> 'id')) and severity = 'high' and who_fixes = 'ca'), 2, 'two high Bug fixer items for the CA are open (the difference, the parked lines)');
select is((select count(*)::int from acct.gl_entries where company_id = tests.k('company_a')), 0, 'nothing was posted to the ledger');
select is((select count(*)::int from acct.accounts where company_id = tests.k('company_a') and name like 'Test Cust X' and opening_as_of = '2026-11-03'), 1, 'the opening date is the report date');

-- ── Skip the unmapped ones, zero the unlisted ones (report 3, another date) ──
select tests.login(tests.k('admin'));
insert into ids select 'r3', tests.tb('c', '2026-04-01', jsonb_build_array(
  tests.ln('Test Cust X', 'Sundry Debtors', 500, 0), tests.ln('Test Creditor Z', 'Sundry Creditors', 0, 500),
  tests.ln('Test Orphan A', null, 20, 0), tests.ln('Test Orphan B', null, 0, 20)));
select is(api.apply_trial_balance_as_opening(gen_random_uuid(), (tests.r('r3') ->> 'id')::uuid) ->> 'refused', 'unmapped', 'ledgers without a group refuse the whole apply by default');
insert into ids select 'a3', api.apply_trial_balance_as_opening(gen_random_uuid(), (tests.r('r3') ->> 'id')::uuid, false, null, true, true);
select tests.logout();
select is(tests.r('a3') ->> 'status', 'partly_applied', 'with the skip option the report is partly applied');
select is((tests.r('a3') ->> 'skipped_count')::int, 2, 'the two ledgers without a group are listed as skipped');
select is((select opening_balance::numeric from acct.accounts where company_id = tests.k('company_a') and name = 'Test Bank Y'), 0::numeric, 'a ledger not in the report is set to zero as of the report date');
select is((select sum(opening_balance) filter (where opening_dc = 'D') = sum(opening_balance) filter (where opening_dc = 'C') from acct.accounts where company_id = tests.k('company_a')), true, 'the company still balances after skipping and zeroing');

select * from finish();

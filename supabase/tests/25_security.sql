-- Phase 9 security review: catalogue-level guarantees (RLS everywhere, invoker views, pinned search_path, no anon
-- access beyond the sign-in RPC, writes only through RPCs) and server-side MFA enforcement (security.enforce_mfa).
-- Synthetic users only. Everything is rolled back.
select plan(35);

-- Act as a user with a chosen authenticator assurance level (aal1 = password only, aal2 = password + TOTP).
create or replace function tests.login_aal(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  execute 'set local role authenticated';
end $$;
grant execute on function tests.login_aal(uuid, text) to authenticated;

create temp table app_schemas as
select unnest(array['acct', 'audit', 'core', 'field', 'help', 'hr', 'inv', 'master', 'msg', 'ops', 'prod', 'purch', 'sales', 'public']) as s;

-- ─────────── Catalogue ───────────
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind in ('r', 'p') and n.nspname in (select s from app_schemas) and not c.relrowsecurity), 0,
          'every table in the app schemas has row-level security enabled');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind in ('r', 'p') and n.nspname in (select s from app_schemas)
             and not exists (select 1 from pg_policy p where p.polrelid = c.oid)), 0,
          'every table in the app schemas has at least one policy');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind = 'v' and n.nspname = 'api'
             and not coalesce(c.reloptions::text[] && array['security_invoker=true', 'security_invoker=on'], false)), 0,
          'every api view runs with security_invoker');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where p.prosecdef and n.nspname in (select s from app_schemas union all select 'api' union all select 'app')
             and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%')), 0,
          'no SECURITY DEFINER function without a pinned search_path');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('api', 'app') and p.prokind = 'f'
             and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%')), 0,
          'every api/app function pins its search_path');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('api', 'app') and has_function_privilege('anon', p.oid, 'execute') and p.proname <> 'log_sign_in_failure'), 0,
          'anon (signed out) can execute no api/app function except the failed sign-in log');
select ok(has_function_privilege('anon', 'api.log_sign_in_failure(text)', 'execute'), 'a failed sign-in can still be logged before there is a session');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind in ('r', 'p', 'v', 'm') and n.nspname in (select s from app_schemas union all select 'api')
             and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
               or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'))), 0,
          'anon holds no privilege on any table or view');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind in ('r', 'p', 'v') and n.nspname in (select s from app_schemas union all select 'api')
             and (has_table_privilege('authenticated', c.oid, 'insert') or has_table_privilege('authenticated', c.oid, 'update')
               or has_table_privilege('authenticated', c.oid, 'delete') or has_table_privilege('authenticated', c.oid, 'truncate'))), 0,
          'signed-in users cannot write any table or view directly (writes go through RPCs)');
select is((select count(*)::int from pg_policies
           where schemaname in (select s from app_schemas) and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
             and (coalesce(trim(qual), '') = 'true' or coalesce(trim(with_check), '') = 'true')), 0,
          'no write policy is "using (true)"');
select is((select count(*)::int from storage.buckets where public), 0, 'no public storage bucket');

-- ─────────── MFA enforcement ───────────
create temp table s as select tests.seed() as v;
grant select on s to authenticated;
-- A non-MFA role (salesman) and an investor-portal partner, both synthetic.
create temp table u as
select tests.create_user('test.salesman.sec@example.test') as sales, tests.create_user('test.investor.sec@example.test', 'investor') as inv;
grant select on u to authenticated;
insert into core.user_roles (user_id, role_key, company_id) select sales, 'salesman', (select (v ->> 'company_a')::uuid from s) from u;
insert into core.user_roles (user_id, role_key, company_id) select inv, 'investor', (select (v ->> 'company_a')::uuid from s) from u;
insert into acct.partners (company_id, user_id, display_name, is_investment_partner)
select (select (v ->> 'company_a')::uuid from s), inv, 'Test Investor Sec', true from u;

-- ─────────── Set-based RLS helpers (20261103009200) ───────────
-- app.companies_with / companies_with_any / readable_companies are computed in one pass for speed. They must give
-- exactly the companies that app.can() / app.can_read_company() give, company by company, for every kind of user:
-- Admin ('all'), CA (group-wide 'all-readonly'), company accountants, a salesman with a company special grant,
-- a user with a group-wide special grant, and an investor.
insert into core.special_grants (code, user_id, right_key, company_id, starts_at, ends_at, reason, granted_by)
select 'TSECG1', sales, 'data.export', (select (v ->> 'company_a')::uuid from s), now() - interval '1 hour', now() + interval '1 hour', 'Test grant (company)', (select (v ->> 'admin')::uuid from s) from u;
insert into core.special_grants (code, user_id, right_key, company_id, starts_at, ends_at, reason, granted_by)
select 'TSECG2', (select (v ->> 'plastics_user')::uuid from s), 'payments.approve', null, now() - interval '1 hour', now() + interval '1 hour', 'Test grant (group-wide)', (select (v ->> 'admin')::uuid from s);
insert into core.special_grants (code, user_id, right_key, company_id, starts_at, ends_at, reason, granted_by)
select 'TSECG3', sales, 'tax.override', (select (v ->> 'company_a')::uuid from s), now() - interval '2 hour', now() - interval '1 hour', 'Test grant (expired)', (select (v ->> 'admin')::uuid from s) from u;

-- The reference side reads every company id (taken here as the table owner), since core.companies itself is under RLS.
create temp table all_co as select id from core.companies;
grant select on all_co to authenticated;

create or replace function tests.helper_drift(p_aal text default 'aal1') returns int
language plpgsql as $$
declare v_bad int := 0; v_user uuid; v_rights text[] := array['accounts.view', 'accounts.export', 'sales.view', 'sales.export', 'cost.view',
  'logs.view', 'data.export', 'payments.approve', 'period.reopen', 'payroll.run', 'tax.override'];
begin
  for v_user in select x from (select (v ->> 'admin')::uuid x from s union all select (v ->> 'acct')::uuid from s union all select (v ->> 'ca')::uuid from s
                               union all select (v ->> 'plastics_user')::uuid from s union all select sales from u union all select inv from u) q loop
    perform tests.login_aal(v_user, p_aal);
    select v_bad + count(*) into v_bad from unnest(v_rights) r
    where coalesce((select array_agg(x order by x) from unnest(app.companies_with(r)) x), '{}')
          is distinct from coalesce((select array_agg(c.id order by c.id) from all_co c where app.can(c.id, r)), '{}');
    select v_bad + count(*) into v_bad
    where coalesce((select array_agg(x order by x) from unnest(app.companies_with_any(v_rights[1:3])) x), '{}')
          is distinct from coalesce((select array_agg(c.id order by c.id) from all_co c where exists (select 1 from unnest(v_rights[1:3]) r where app.can(c.id, r))), '{}');
    select v_bad + count(*) into v_bad
    where coalesce((select array_agg(x order by x) from unnest(app.readable_companies()) x), '{}')
          is distinct from coalesce((select array_agg(c.id order by c.id) from all_co c where app.can_read_company(c.id)), '{}');
    perform tests.logout();
  end loop;
  return v_bad;
end $$;

select is(tests.helper_drift(), 0, 'set-based helpers = app.can / app.can_read_company for every user kind and right');
select tests.login_aal((select sales from u), 'aal1');
select ok((select (v ->> 'company_a')::uuid from s) = any (app.companies_with('data.export'))
          and not ((select (v ->> 'company_b')::uuid from s) = any (app.companies_with('data.export'))), 'a company special grant reaches only that company');
select ok(not ((select (v ->> 'company_a')::uuid from s) = any (app.companies_with('tax.override'))), 'an expired special grant gives nothing');
select tests.logout();
select tests.login_aal((select (v ->> 'ca')::uuid from s), 'aal1');
select ok((select (v ->> 'company_b')::uuid from s) = any (app.companies_with('accounts.export'))
          and not ((select (v ->> 'company_b')::uuid from s) = any (app.companies_with('payments.approve'))), 'CA (all-readonly) gets view/export only, in every company');
select tests.logout();

-- Enforcement off (the DEV default): an aal1 session keeps every role.
select tests.login_aal((select (v ->> 'acct')::uuid from s), 'aal1');
select is(app.mfa_enforced(), false, 'enforcement is off by default (DEV)');
select ok(app.can_read_company((select (v ->> 'company_a')::uuid from s)), 'off: accountant at aal1 keeps the company');
select is((api.me() ->> 'mfa_needed')::boolean, false, 'off: me() does not ask for the second factor');
select tests.logout();

insert into core.settings (company_id, key, value, note) values (null, 'security.enforce_mfa', 'true'::jsonb, 'Test: enforce MFA');

-- Enforcement on: an MFA role at aal1 loses its access and RPCs answer mfa_required.
select tests.login_aal((select (v ->> 'acct')::uuid from s), 'aal1');
select is(app.mfa_enforced(), true, 'on: the setting is read');
select ok(not app.can_read_company((select (v ->> 'company_a')::uuid from s)), 'on: accountant at aal1 sees no company data');
select is(cardinality(app.companies_with('accounts.view')), 0, 'on: the set-based helper also gives an aal1 accountant nothing');
select throws_like($$ select app.require((select (v ->> 'company_a')::uuid from s), 'accounts.view') $$, 'mfa_required%', 'on: an RPC at aal1 answers mfa_required');
select ok((api.me() ->> 'mfa_needed')::boolean and (api.me() ->> 'mfa_required')::boolean, 'on: me() tells the client to show the TOTP step');
select tests.logout();

select tests.login_aal((select (v ->> 'acct')::uuid from s), 'aal2');
select ok(app.can_read_company((select (v ->> 'company_a')::uuid from s)), 'on: accountant at aal2 has the company again');
select is((api.me() ->> 'mfa_needed')::boolean, false, 'on: me() at aal2 needs nothing more');
select tests.logout();

select tests.login_aal((select (v ->> 'admin')::uuid from s), 'aal1');
select ok(not app.is_admin(), 'on: Admin at aal1 does not get the Admin view');
select tests.logout();
select tests.login_aal((select (v ->> 'admin')::uuid from s), 'aal2');
select ok(app.is_admin(), 'on: Admin at aal2 gets the Admin view');
select tests.logout();
select is(tests.helper_drift('aal1'), 0, 'on, aal1: set-based helpers still equal app.can for every user kind');
select is(tests.helper_drift('aal2'), 0, 'on, aal2: set-based helpers still equal app.can for every user kind');

select tests.login_aal((select sales from u), 'aal1');
select ok(app.can_read_company((select (v ->> 'company_a')::uuid from s)), 'on: a role without MFA (salesman) works at aal1');
select tests.logout();

select tests.login_aal((select inv from u), 'aal1');
select is((select count(*)::int from api.v_investor_partners), 0, 'on: investor portal shows nothing at aal1');
select tests.logout();
select tests.login_aal((select inv from u), 'aal2');
select is((select count(*)::int from api.v_investor_partners), 1, 'on: investor portal shows the own partner row at aal2');
select tests.logout();

-- ─────────── Audit history read gate (20261103009300) ───────────
-- (enforcement is still on here, so every session is aal2)
select tests.login_aal((select (v ->> 'acct')::uuid from s), 'aal2');
select is((select count(*)::int from api.transaction_log), 0, 'an accountant (no logs.view) reads no audit history');
select tests.logout();
select tests.login_aal((select (v ->> 'admin')::uuid from s), 'aal2');
select ok((select count(*) from api.transaction_log where table_name = 'core.user_roles') > 0, 'Admin (logs.view) still reads the audit history');
select tests.logout();
select tests.login_aal((select (v ->> 'ca')::uuid from s), 'aal2');
select ok((select count(*) from api.transaction_log where table_name = 'core.user_roles') > 0, 'CA (all read-only) still reads the audit history');
select tests.logout();

select * from finish();

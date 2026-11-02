-- Shared pgTAP setup, run inside the same transaction as each test file (everything is rolled back).
-- Synthetic users only ("Test …"). Never real people or data.
create schema if not exists tests;

create or replace function tests.create_user(p_email text, p_role text default null, p_name text default null) returns uuid
language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (v_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', p_email, '', now(),
          case when p_role is null then '{}'::jsonb else jsonb_build_object('role', p_role) end,
          jsonb_build_object('full_name', coalesce(p_name, 'Test ' || split_part(p_email, '@', 1))), now(), now());
  return v_id;
end $$;

-- Act as a signed-in user (role authenticated, JWT sub = user id), or as nobody.
create or replace function tests.login(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  execute 'set local role authenticated';
end $$;

create or replace function tests.logout() returns void
language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

grant usage on schema tests to authenticated;
grant execute on all functions in schema tests to authenticated;

-- A synthetic group: two companies, each with a GSTIN, a branch and a place; users with different roles.
create or replace function tests.seed() returns jsonb
language plpgsql as $$
declare
  v_admin uuid := tests.create_user('test.admin@example.test', 'admin');
  v_admin2 uuid := tests.create_user('test.admin2@example.test', 'admin');
  v_acct uuid := tests.create_user('test.accountant@example.test');
  v_ca uuid := tests.create_user('test.ca@example.test');
  v_pl uuid := tests.create_user('test.plastics@example.test');
  v_a uuid; v_b uuid; v_ga uuid; v_ba uuid; v_fy uuid;
begin
  insert into core.companies (code, legal_name, short_name, pan) values ('TCA', 'Test Company A Pvt Ltd', 'Test A', 'AAAAA1111A') returning id into v_a;
  insert into core.companies (code, legal_name, short_name, pan) values ('TCB', 'Test Company B Pvt Ltd', 'Test B', 'BBBBB2222B') returning id into v_b;
  insert into core.gstins (company_id, gstin, is_principal) values (v_a, '32AAAAA1111A1Z5', true) returning id into v_ga;
  insert into core.branches (company_id, gstin_id, code, name, kind) values (v_a, v_ga, 'F1', 'Test Factory', 'factory') returning id into v_ba;
  insert into core.financial_years (company_id, label, starts_on, ends_on) values (v_a, '2026-27', '2026-04-01', '2027-03-31') returning id into v_fy;
  insert into core.user_roles (user_id, role_key, company_id) values (v_acct, 'accountant', v_a);
  insert into core.user_roles (user_id, role_key, company_id, valid_to) values (v_ca, 'ca', null, now() + interval '30 days');
  insert into core.user_roles (user_id, role_key, company_id) values (v_pl, 'accountant', v_b);
  return jsonb_build_object('admin', v_admin, 'admin2', v_admin2, 'acct', v_acct, 'ca', v_ca, 'plastics_user', v_pl,
                            'company_a', v_a, 'company_b', v_b, 'gstin_a', v_ga, 'branch_a', v_ba, 'fy_a', v_fy);
end $$;

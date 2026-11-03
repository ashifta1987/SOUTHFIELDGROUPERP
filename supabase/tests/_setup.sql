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

-- A synthetic GSTIN with a correct check digit for the given state + PAN (tests only).
create or replace function tests.gstin(p_state text, p_pan text) returns text
language plpgsql as $$
declare c text;
begin
  foreach c in array string_to_array('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', null) loop
    if app.gstin_valid(p_state || p_pan || '1Z' || c) then return p_state || p_pan || '1Z' || c; end if;
  end loop;
  return null;
end $$;

-- Phase 2 seed on top of tests.seed(): chart of accounts groups mapped to Tally groups for company A.
create or replace function tests.seed2(s jsonb) returns jsonb
language plpgsql as $$
declare v_debtors uuid; v_creditors uuid; v_bank uuid;
begin
  insert into acct.account_groups (company_id, name, nature, is_party_group) values ((s ->> 'company_a')::uuid, 'Trade receivables', 'asset', 'debtors') returning id into v_debtors;
  insert into acct.account_groups (company_id, name, nature, is_party_group) values ((s ->> 'company_a')::uuid, 'Trade payables', 'liability', 'creditors') returning id into v_creditors;
  insert into acct.account_groups (company_id, name, nature) values ((s ->> 'company_a')::uuid, 'Bank accounts', 'asset') returning id into v_bank;
  insert into ops.tally_group_map (company_id, tally_group, account_group_id) values
    ((s ->> 'company_a')::uuid, 'Sundry Debtors', v_debtors), ((s ->> 'company_a')::uuid, 'Sundry Creditors', v_creditors), ((s ->> 'company_a')::uuid, 'Bank Accounts', v_bank);
  -- For these tests the accountant may also propose customers (Admin can give this on Users & rights).
  insert into core.role_rights (role_key, right_key) values ('accountant', 'sales.create'), ('accountant', 'sales.edit') on conflict do nothing;
  -- Company B needs its own map for the "same employee in both companies" test (employees need no map).
  return s || jsonb_build_object('debtors', v_debtors, 'creditors', v_creditors);
end $$;

-- Phase 3 seed: accounts, posting rules, cash/bank accounts, number series, HSN rates (synthetic), a customer
-- and supplier, a product with MRP, and a staff member linked to the staff test user.
create or replace function tests.seed3(s jsonb) returns jsonb
language plpgsql as $$
declare
  v_a uuid := (s ->> 'company_a')::uuid; v_fy uuid := (s ->> 'fy_a')::uuid; v_g uuid := (s ->> 'gstin_a')::uuid;
  g_inc uuid; g_exp uuid; g_tax uuid; g_cash uuid; g_liab uuid; acc record; v_cash uuid; v_bank uuid; v_cust uuid; v_cust_tn uuid; v_supp uuid; v_prod uuid; v_prod_free uuid;
  v_person uuid; v_staff_user uuid; e text; v_acc uuid;
begin
  insert into acct.account_groups (company_id, name, nature) values (v_a, 'Test Income', 'income') returning id into g_inc;
  insert into acct.account_groups (company_id, name, nature) values (v_a, 'Test Expenses', 'expense') returning id into g_exp;
  insert into acct.account_groups (company_id, name, nature) values (v_a, 'Test Duties and taxes', 'liability') returning id into g_tax;
  insert into acct.account_groups (company_id, name, nature) values (v_a, 'Test Cash and bank', 'asset') returning id into g_cash;
  insert into acct.account_groups (company_id, name, nature) values (v_a, 'Test Current liabilities', 'liability') returning id into g_liab;
  foreach e in array array['sales.taxable', 'sales.without_gst', 'sales.returns', 'gst.output_cgst', 'gst.output_sgst', 'gst.output_igst', 'gst.input_cgst', 'gst.input_sgst',
                           'gst.input_igst', 'round_off', 'purchase.taxable', 'payroll.salary_expense', 'payroll.salary_payable', 'payroll.advances', 'payroll.deductions'] loop
    insert into acct.accounts (company_id, group_id, name, status, kind)
    values (v_a, case when e like 'sales.%' then g_inc when e like 'gst.%' then g_tax when e in ('payroll.salary_payable', 'payroll.deductions') then g_liab else g_exp end, 'Test ' || e, 'active', 'other')
    returning id into v_acc;
    insert into acct.posting_rules (company_id, event, account_id) values (v_a, e, v_acc);
  end loop;
  insert into acct.accounts (company_id, group_id, name, status, kind) values (v_a, g_cash, 'Test Cash', 'active', 'cash') returning id into v_cash;
  insert into acct.accounts (company_id, group_id, name, status, kind) values (v_a, g_cash, 'Test Bank', 'active', 'bank') returning id into v_bank;
  insert into acct.bank_accounts (account_id, company_id, bank_name, account_last4) values (v_bank, v_a, 'Test Bank', '1234');
  insert into core.periods (company_id, fy_id, month_start) select v_a, v_fy, (date '2026-04-01' + (n || ' month')::interval)::date from generate_series(0, 11) n on conflict do nothing;
  insert into core.doc_series (company_id, gstin_id, doc_type, fy_id, prefix) values (v_a, v_g, 'sales_invoice', v_fy, 'TSI'), (v_a, v_g, 'bill_of_supply', v_fy, 'TBS'),
    (v_a, v_g, 'credit_note', v_fy, 'TCN'), (v_a, null, 'receipt', v_fy, 'TRC'), (v_a, null, 'payment', v_fy, 'TPY'), (v_a, null, 'journal', v_fy, 'TJV'), (v_a, null, 'contra', v_fy, 'TCT');
  insert into master.hsn_codes (code, description) values ('99999001', 'Test taxable goods'), ('99999002', 'Test exempt goods') on conflict do nothing;
  insert into master.hsn_rates (hsn_code, rate, tax_class, effective_from) values ('99999001', 18, 'taxable', '2026-04-01'), ('99999002', 0, 'exempt', '2026-04-01') on conflict do nothing;
  insert into master.products (code, name, hsn_code, uom, status) values ('TPROD1', 'Test Product One', '99999001', 'NOS', 'active') returning id into v_prod;
  insert into master.products (code, name, hsn_code, uom, status) values ('TPROD2', 'Test Exempt Product', '99999002', 'NOS', 'active') returning id into v_prod_free;
  insert into master.product_mrp_history (product_id, mrp, effective_from) values (v_prod, 200, '2026-04-01');
  insert into master.parties (legal_name, gst_status, state_code, is_customer, kyc_status) values ('Test Customer Kerala', 'unregistered', '32', true, 'verified') returning id into v_cust;
  insert into master.parties (legal_name, gst_status, state_code, is_customer, kyc_status) values ('Test Customer Tamil Nadu', 'unregistered', '33', true, 'verified') returning id into v_cust_tn;
  insert into master.parties (legal_name, gst_status, state_code, is_supplier, msme_category, kyc_status) values ('Test Supplier Micro', 'unregistered', '32', true, 'micro', 'verified') returning id into v_supp;
  insert into master.party_companies (party_id, company_id, is_customer, is_supplier) values (v_cust, v_a, true, false), (v_cust_tn, v_a, true, false), (v_supp, v_a, false, true);
  insert into master.party_contacts (party_id, name, whatsapp, whatsapp_consent, is_primary) values (v_cust, 'Test Contact', '+919000000101', true, true);
  select id into v_staff_user from auth.users where email = 'test.staff@example.test';
  if v_staff_user is null then v_staff_user := tests.create_user('test.staff@example.test', 'staff'); end if;
  insert into master.people (name, status, user_id) values ('Test Worker Payroll', 'active', v_staff_user) returning id into v_person;
  insert into hr.staff_profiles (person_id, pay_company_id, pay_basis, monthly_salary) values (v_person, v_a, 'monthly', 30000);
  return s || jsonb_build_object('cash', v_cash, 'bank', v_bank, 'cust', v_cust, 'cust_tn', v_cust_tn, 'supp', v_supp, 'prod', v_prod, 'prod_free', v_prod_free,
                                 'person', v_person, 'staff_user', v_staff_user);
end $$;


-- Phase 4 seed on top of seed3: places (stores, line, quarantine, a shop on the same GSTIN, a shop on a Tamil Nadu GSTIN
-- of company A), a place in company B, synthetic items (one needs an incoming test, one plain, one scrap), the
-- challan series, a second supplier without WhatsApp consent, company A's own TN registration as a party (for the
-- IGST transfer invoice), and one synthetic user per job (company A only).
create or replace function tests.seed4(s jsonb) returns jsonb
language plpgsql as $$
declare
  v_a uuid := (s ->> 'company_a')::uuid; v_b uuid := (s ->> 'company_b')::uuid; v_ga uuid := (s ->> 'gstin_a')::uuid; v_ba uuid := (s ->> 'branch_a')::uuid;
  v_fy uuid := (s ->> 'fy_a')::uuid; v_shop_br uuid; v_tn_g uuid; v_tn_br uuid; v_bb uuid;
  v_stores uuid; v_line uuid; v_qp uuid; v_shop uuid; v_tn uuid; v_pb uuid; v_rm1 uuid; v_rm2 uuid; v_scrap uuid; v_supp2 uuid; v_tn_party uuid;
  u jsonb := '{}'::jsonb; r record;
begin
  insert into core.financial_years (company_id, label, starts_on, ends_on) values (v_a, '2027-28', '2027-04-01', '2028-03-31'), (v_a, '2028-29', '2028-04-01', '2029-03-31')
  on conflict do nothing;
  insert into core.branches (company_id, gstin_id, code, name, kind) values (v_a, v_ga, 'S1', 'Test Shop Same GSTIN', 'shop') returning id into v_shop_br;
  insert into core.gstins (company_id, gstin) values (v_a, tests.gstin('33', 'AAAAA1111A')) returning id into v_tn_g;
  insert into core.branches (company_id, gstin_id, code, name, kind) values (v_a, v_tn_g, 'S2', 'Test Shop Other State', 'shop') returning id into v_tn_br;
  insert into core.places (company_id, branch_id, code, name, kind) values (v_a, v_ba, 'TST', 'Test Stores', 'stores') returning id into v_stores;
  insert into core.places (company_id, branch_id, code, name, kind) values (v_a, v_ba, 'TLN', 'Test Line', 'wip') returning id into v_line;
  insert into core.places (company_id, branch_id, code, name, kind) values (v_a, v_ba, 'TQN', 'Test Quarantine', 'quarantine') returning id into v_qp;
  insert into core.places (company_id, branch_id, code, name, kind) values (v_a, v_shop_br, 'TSH', 'Test Shop Stock', 'stores') returning id into v_shop;
  insert into core.places (company_id, branch_id, code, name, kind) values (v_a, v_tn_br, 'TTN', 'Test TN Shop Stock', 'stores') returning id into v_tn;
  insert into core.branches (company_id, code, name, kind) values (v_b, 'B1', 'Test B Factory', 'factory') returning id into v_bb;
  insert into core.places (company_id, branch_id, code, name, kind) values (v_b, v_bb, 'TBS', 'Test B Stores', 'stores') returning id into v_pb;
  insert into master.products (code, name, hsn_code, uom, status, kind, needs_incoming_test) values ('TRM1', 'Test Raw Material Tested', '99999001', 'KGS', 'active', 'raw_material', true) returning id into v_rm1;
  insert into master.products (code, name, hsn_code, uom, status, kind) values ('TRM2', 'Test Raw Material Plain', '99999001', 'KGS', 'active', 'raw_material') returning id into v_rm2;
  insert into master.products (code, name, hsn_code, uom, status, kind, is_scrap) values ('TSCR', 'Test Scrap', '99999001', 'KGS', 'active', 'other', true) returning id into v_scrap;
  insert into core.doc_series (company_id, gstin_id, doc_type, fy_id, prefix) values (v_a, v_ga, 'delivery_challan', v_fy, 'TDC');
  insert into master.parties (legal_name, gst_status, state_code, is_supplier, kyc_status) values ('Test Supplier Plain', 'unregistered', '32', true, 'verified') returning id into v_supp2;
  insert into master.party_companies (party_id, company_id, is_supplier) values (v_supp2, v_a, true);
  insert into master.party_contacts (party_id, name, whatsapp, whatsapp_consent, is_primary) values
    ((s ->> 'supp')::uuid, 'Test Supplier Contact', '+919000000202', true, true), (v_supp2, 'Test Supplier Two Contact', '+919000000203', false, true);
  insert into master.parties (legal_name, gst_status, gstin, pan, state_code, is_customer, kyc_status)
  values ('Test Company A Tamil Nadu registration', 'registered', tests.gstin('33', 'AAAAA1111A'), 'AAAAA1111A', '33', true, 'verified') returning id into v_tn_party;
  insert into master.party_companies (party_id, company_id, is_customer) values (v_tn_party, v_a, true);
  for r in select * from (values ('store', 'production_manager'), ('picker', 'factory_staff'), ('carrier', 'driver'), ('receiver', 'shop_staff'),
                                 ('finance', 'finance_head'), ('custodian', 'factory_manager'), ('tester', 'qc_releaser'), ('buyer', 'buyer_logistics')) x(k, role) loop
    u := u || jsonb_build_object(r.k, tests.create_user('test.p4' || r.k || '@example.test'));
    insert into core.user_roles (user_id, role_key, company_id) values ((u ->> r.k)::uuid, r.role, v_a);
  end loop;
  return s || u || jsonb_build_object('stores', v_stores, 'line', v_line, 'qplace', v_qp, 'shop', v_shop, 'tn_shop', v_tn, 'place_b', v_pb, 'rm1', v_rm1, 'rm2', v_rm2,
                                      'scrap', v_scrap, 'supp2', v_supp2, 'tn_party', v_tn_party, 'gstin_tn', v_tn_g);
end $$;
grant execute on all functions in schema tests to authenticated;

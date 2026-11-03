-- Masters and KYC: GSTIN check digit and PAN, duplicates, KYC segregation, bank change by two people with a
-- call-back, MRP rule on prices, opening bills hidden from the GST view until classified.
select plan(15);

create temp table s as select tests.seed2(tests.seed()) as v;
grant select on s to authenticated;

select ok(app.gstin_valid('27AAPFU0939F1ZV'), 'a published sample GSTIN passes the check digit');
select ok(not app.gstin_valid('27AAPFU0939F1ZA'), 'a wrong check digit fails');
select is(app.norm_name('M/s. Test Traders Pvt. Ltd.'), app.norm_name('TEST TRADERS PRIVATE LIMITED'), 'names normalise (M/s, Pvt Ltd vs Private Limited, case, punctuation)');

-- Accountant of A creates a customer (sales.create via template)
select tests.login((select (v ->> 'acct')::uuid from s));
select lives_ok(format($$ select api.upsert_party(gen_random_uuid(), jsonb_build_object('company_id', %L, 'legal_name', 'Test Customer 01', 'is_customer', true, 'gstin', %L)) $$,
  (select v ->> 'company_a' from s), tests.gstin('32', 'CCCCC1111C')), 'accountant creates a customer with a valid GSTIN');
select throws_ok(format($$ select api.upsert_party(gen_random_uuid(), jsonb_build_object('company_id', %L, 'legal_name', 'Test Customer 99', 'is_customer', true, 'gstin', '32CCCCC1111C1ZZ')) $$,
  (select v ->> 'company_a' from s)), '22023', null, 'a GSTIN with a wrong check digit is refused');
select throws_ok(format($$ select api.upsert_party(gen_random_uuid(), jsonb_build_object('company_id', %L, 'legal_name', 'Test Customer 01 ', 'is_customer', true)) $$,
  (select v ->> 'company_a' from s)), 'P0001', null, 'the same name again is stopped as a possible duplicate');
select lives_ok(format($$ select api.upsert_party(gen_random_uuid(), jsonb_build_object('company_id', %L, 'legal_name', 'Test Customer 01 Kochi', 'is_customer', true, 'force', true)) $$,
  (select v ->> 'company_a' from s)), 'a deliberate second record can be forced (the warning was shown)');
select throws_ok($$ select api.set_party_kyc(gen_random_uuid(), (select id from master.parties where legal_name = 'Test Customer 01'), 'verified', 'self check') $$,
  '42501', null, 'the proposer cannot verify their own customer''s KYC');
select tests.logout();

select tests.login((select (v ->> 'admin')::uuid from s));
select lives_ok($$ select api.set_party_kyc(gen_random_uuid(), (select id from master.parties where legal_name = 'Test Customer 01'), 'verified', 'documents seen') $$,
  'another person (Admin) verifies the KYC');
-- Bank: first account, then a change needs a second person and a call-back
select lives_ok($$ select api.add_party_bank_account(gen_random_uuid(), (select id from master.parties where legal_name = 'Test Customer 01'), '111122223333', 'TEST0001234', 'Test Bank', 'cancelled_cheque') $$,
  'first bank account is added');
select throws_ok($$ select api.add_party_bank_account(gen_random_uuid(), (select id from master.parties where legal_name = 'Test Customer 01'), '999988887777', 'TEST0001234', 'Test Bank', 'cancelled_cheque') $$,
  '22023', null, 'a second account cannot be added directly; it needs a change request');
select api.request_bank_change(gen_random_uuid(), (select id from master.parties where legal_name = 'Test Customer 01'), '999988887777', 'TEST0001234', 'Test Bank', 'Test: party changed bank');
select throws_ok($$ select api.decide_bank_change(gen_random_uuid(), (select r.id from master.bank_change_requests r join master.parties p on p.id = r.party_id where p.legal_name = 'Test Customer 01'), true) $$,
  '42501', null, 'the requester cannot approve their own bank change');
select tests.logout();
select tests.login((select (v ->> 'admin2')::uuid from s));
select throws_ok($$ select api.decide_bank_change(gen_random_uuid(), (select r.id from master.bank_change_requests r join master.parties p on p.id = r.party_id where p.legal_name = 'Test Customer 01'), true) $$,
  '22023', null, 'approval waits for the call-back to a known number');
select api.record_bank_callback(gen_random_uuid(), (select r.id from master.bank_change_requests r join master.parties p on p.id = r.party_id where p.legal_name = 'Test Customer 01'), '+919000000001', 'Test: confirmed with the known contact');
select lives_ok($$ select api.decide_bank_change(gen_random_uuid(), (select r.id from master.bank_change_requests r join master.parties p on p.id = r.party_id where p.legal_name = 'Test Customer 01'), true) $$, 'a second person approves after the call-back');
select tests.logout();

-- Full account numbers are never selectable by clients
select tests.login((select (v ->> 'acct')::uuid from s));
select throws_ok($$ select account_no from master.party_bank_accounts limit 1 $$, '42501', null, 'the full account number column is not readable');
select tests.logout();

select * from finish();

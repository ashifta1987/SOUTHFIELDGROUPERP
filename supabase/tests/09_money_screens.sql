-- Money screen reads: the cash book summary and cash flow come from the books, follow RLS (security invoker), and
-- reject a bad range.
select plan(8);

create temp table s as select tests.seed3(tests.seed2(tests.seed())) as v;
grant select on s to authenticated;
insert into core.role_rights (role_key, right_key) values ('accountant', 'accounts.create'), ('accountant', 'cash_book.create'), ('accountant', 'receipts_payments.create') on conflict do nothing;

select tests.login((select (v ->> 'acct')::uuid from s));
select api.post_receipt(gen_random_uuid(), jsonb_build_object('company_id', (select v ->> 'company_a' from s), 'party_id', (select v ->> 'cust' from s), 'date', '2026-06-02', 'mode', 'cash',
  'account_id', (select v ->> 'cash' from s), 'amount', 5000));
select api.post_payment(gen_random_uuid(), jsonb_build_object('company_id', (select v ->> 'company_a' from s), 'party_id', (select v ->> 'supp' from s), 'date', '2026-06-03', 'mode', 'cash',
  'account_id', (select v ->> 'cash' from s), 'amount', 1200));
create temp table cb as select api.cash_book_summary((select (v ->> 'cash')::uuid from s), '2026-06-01', '2026-06-30') as r;
select is((select (r ->> 'received')::numeric from cb), 5000.00::numeric, 'cash book summary: received is the sum of cash debits');
select is((select (r ->> 'paid')::numeric from cb), 1200.00::numeric, 'cash book summary: paid is the sum of cash credits');
select is((select (r ->> 'closing')::numeric - (r ->> 'opening')::numeric from cb), 3800.00::numeric, 'closing = opening + received − paid');
select is((select jsonb_array_length(r -> 'months') from cb), 1, 'one month with entries');
select throws_ok($$ select api.cash_book_summary((select (v ->> 'cash')::uuid from s), '2026-06-30', '2026-06-01') $$, '22023', null, 'a from date after the to date is refused');
select is((select (api.cash_flow_summary((select (v ->> 'company_a')::uuid from s), '2026-06-01', '2026-06-30') -> 'months' -> 0 ->> 'money_in')::numeric), 5000.00::numeric, 'cash flow: money in for the month');
select tests.logout();

select tests.login((select (v ->> 'staff_user')::uuid from s));
select throws_ok($$ select api.cash_book_summary((select (v ->> 'cash')::uuid from s), '2026-06-01', '2026-06-30') $$, '22023', null, 'a user without the accounts right cannot read the cash account (RLS hides it)');
select tests.logout();

-- A supplier with no MSME category and no terms row: the draft saves with msme_due false and 0 days.
update master.parties set msme_category = null where id = (select (v ->> 'supp')::uuid from s);
select tests.login((select (v ->> 'admin')::uuid from s));
create temp table pb as select api.save_purchase_draft(gen_random_uuid(), jsonb_build_object('company_id', (select v ->> 'company_a' from s),
  'gstin_id', (select v ->> 'gstin_a' from s), 'party_id', (select v ->> 'supp' from s), 'supplier_bill_no', 'T-1', 'supplier_bill_date', '2026-06-04',
  'lines', jsonb_build_array(jsonb_build_object('product_id', (select v ->> 'prod' from s), 'qty', 1, 'rate', 100)))) as r;
select is((select msme_due from purch.bills where id = (select (r ->> 'id')::uuid from pb)), false, 'a supplier bill saves for a supplier with no MSME category');
select tests.logout();

select * from finish();

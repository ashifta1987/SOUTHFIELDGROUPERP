-- GST documents: CGST+SGST in the state, IGST across states, rate from the HSN table, no taxable sale without GST,
-- without GST only by Admin with a lawful reason, MRP, gap-free numbers, balanced GL, idempotent posting,
-- credit note limits, cancellation by reversal, GST view hides bills without GST.
select plan(16);

create temp table s as select tests.seed3(tests.seed2(tests.seed())) as v;
grant select on s to authenticated;
-- The accountant may sell in these tests
insert into core.role_rights (role_key, right_key) values ('accountant', 'accounts.create'), ('accountant', 'accounts.cancel') on conflict do nothing;

select tests.login((select (v ->> 'acct')::uuid from s));
create temp table d1 as select api.save_sales_draft('a0000000-0000-0000-0000-000000000001', jsonb_build_object('company_id', (select v ->> 'company_a' from s), 'gstin_id', (select v ->> 'gstin_a' from s),
  'doc_type', 'sales_invoice', 'doc_date', '2026-05-10', 'party_id', (select v ->> 'cust' from s),
  'lines', jsonb_build_array(jsonb_build_object('product_id', (select v ->> 'prod' from s), 'qty', 2, 'rate', 100)))) as r;
select is((select (r -> 'totals' ->> 'cgst')::numeric from d1), 18.00, 'inside Kerala: CGST 9% of 200');
select is((select (r -> 'totals' ->> 'igst')::numeric from d1), 0.00, 'and no IGST');
create temp table p1 as select api.post_sales_document('a0000000-0000-0000-0000-000000000002', (select (r ->> 'id')::uuid from d1)) as r;
select is((select r ->> 'doc_no' from p1), 'TSI/26-27/0001', 'the first invoice number is taken at posting');
select is((select api.post_sales_document('a0000000-0000-0000-0000-000000000002', (select (r ->> 'id')::uuid from d1)) ->> 'doc_no'), 'TSI/26-27/0001', 'posting again with the same request id returns the same document');
select ok((select sum(dr) = sum(cr) and sum(dr) = 236 from acct.gl_entries where voucher_id = (select (r ->> 'voucher_id')::uuid from p1)), 'the GL entry balances at the invoice total');
create temp table d2 as select api.save_sales_draft(gen_random_uuid(), jsonb_build_object('company_id', (select v ->> 'company_a' from s), 'gstin_id', (select v ->> 'gstin_a' from s),
  'doc_type', 'sales_invoice', 'doc_date', '2026-05-10', 'party_id', (select v ->> 'cust_tn' from s),
  'lines', jsonb_build_array(jsonb_build_object('product_id', (select v ->> 'prod' from s), 'qty', 1, 'rate', 100)))) as r;
select is((select (r -> 'totals' ->> 'igst')::numeric from d2), 18.00, 'to Tamil Nadu: IGST 18%');
select throws_ok(format($$ select api.save_sales_draft(gen_random_uuid(), jsonb_build_object('company_id', %L, 'gstin_id', %L, 'doc_type', 'bill_of_supply', 'doc_date', '2026-05-10',
  'party_id', %L, 'lawful_reason', 'exempt_or_nil', 'lines', jsonb_build_array(jsonb_build_object('product_id', %L, 'qty', 1, 'rate', 100)))) $$,
  (select v ->> 'company_a' from s), (select v ->> 'gstin_a' from s), (select v ->> 'cust' from s), (select v ->> 'prod_free' from s)), '42501', null, 'only Admin can make a bill without GST');
create temp table d3 as select api.save_sales_draft(gen_random_uuid(), jsonb_build_object('company_id', (select v ->> 'company_a' from s), 'gstin_id', (select v ->> 'gstin_a' from s),
  'doc_type', 'sales_invoice', 'doc_date', '2026-05-11', 'party_id', (select v ->> 'cust' from s),
  'lines', jsonb_build_array(jsonb_build_object('product_id', (select v ->> 'prod' from s), 'qty', 1, 'rate', 180)))) as r;
select throws_ok($$ select api.post_sales_document(gen_random_uuid(), (select (r ->> 'id')::uuid from d3)) $$, '22023', null, 'a price above MRP (180 + 18% > 200) is refused');
select tests.logout();

-- Admin: a taxable product on a bill without GST is refused; an exempt product with a lawful reason is allowed
select tests.login((select (v ->> 'admin')::uuid from s));
create temp table d4 as select api.save_sales_draft(gen_random_uuid(), jsonb_build_object('company_id', (select v ->> 'company_a' from s), 'gstin_id', (select v ->> 'gstin_a' from s),
  'doc_type', 'bill_of_supply', 'lawful_reason', 'exempt_or_nil', 'doc_date', '2026-05-12', 'party_id', (select v ->> 'cust' from s),
  'lines', jsonb_build_array(jsonb_build_object('product_id', (select v ->> 'prod' from s), 'qty', 1, 'rate', 50)))) as r;
select throws_ok($$ select api.post_sales_document(gen_random_uuid(), (select (r ->> 'id')::uuid from d4)) $$, '42501', null, 'a taxable product cannot be billed without GST');
create temp table d5 as select api.save_sales_draft(gen_random_uuid(), jsonb_build_object('company_id', (select v ->> 'company_a' from s), 'gstin_id', (select v ->> 'gstin_a' from s),
  'doc_type', 'bill_of_supply', 'lawful_reason', 'exempt_or_nil', 'doc_date', '2026-05-12', 'party_id', (select v ->> 'cust' from s),
  'lines', jsonb_build_array(jsonb_build_object('product_id', (select v ->> 'prod_free' from s), 'qty', 1, 'rate', 50)))) as r;
select lives_ok($$ select api.post_sales_document(gen_random_uuid(), (select (r ->> 'id')::uuid from d5)) $$, 'an exempt product with a lawful reason is posted by Admin');
-- Credit note: cannot exceed the invoice
create temp table cn as select api.save_sales_draft(gen_random_uuid(), jsonb_build_object('company_id', (select v ->> 'company_a' from s), 'gstin_id', (select v ->> 'gstin_a' from s),
  'doc_type', 'credit_note', 'against_id', (select r ->> 'id' from p1), 'reason', 'Test return', 'doc_date', '2026-05-15', 'party_id', (select v ->> 'cust' from s),
  'lines', jsonb_build_array(jsonb_build_object('product_id', (select v ->> 'prod' from s), 'qty', 3, 'rate', 100)))) as r;
select throws_ok($$ select api.post_sales_document(gen_random_uuid(), (select (r ->> 'id')::uuid from cn)) $$, '22023', null, 'a credit note cannot exceed its invoice');
select tests.logout();

-- GST view: the accountant does not see the bill without GST
select tests.login((select (v ->> 'acct')::uuid from s));
select is((select count(*)::int from sales.documents where tax_class = 'without_gst'), 0, 'the GST view does not see bills without GST');
select is((select count(*)::int from api.receivables where tax_class = 'without_gst'), 0, 'nor their outstanding');
select tests.logout();

-- Posted documents cannot be edited; cancelling reverses the GL to zero
select throws_ok($$ update sales.documents set total = 1 where id = (select (r ->> 'id')::uuid from p1) $$, 'P0001', null, 'a posted document cannot be edited, even by the owner');
select tests.login((select (v ->> 'admin')::uuid from s));
select lives_ok($$ select api.cancel_sales_document(gen_random_uuid(), (select (r ->> 'id')::uuid from p1), 'Test cancellation') $$, 'cancelling posts a reversal');
select tests.logout();
select is((select sum(e.dr - e.cr) from acct.gl_entries e join acct.vouchers v on v.id = e.voucher_id where v.source_id = (select (r ->> 'id')::uuid from p1) and e.party_id is not null), 0.00::numeric, 'the customer''s balance from that invoice is back to zero');

select * from finish();

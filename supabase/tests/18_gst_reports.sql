-- Phase 6 GST page, Schedule III, WhatsApp reminders and cost caps, the inbox, and the help assistant's data tools. GSTR-1
-- B2B/B2C/HSN totals equal the posted documents; the GSTR-3B summary; ITC from purchase bills; bills without GST only in the
-- Admin/CA view; Schedule III balances (assets = equity + liabilities) from the GL; reminders on the schedule only for consented
-- contacts and never twice; a settled bill cancels its reminder; a payment proof creates a task and holds reminders; the cost cap
-- stops non-urgent messages with a skip reason; STOP opts out; help tools under the user's own rights. Synthetic data only.
select plan(38);

create temp table s as select tests.seed6(tests.seed4(tests.seed3(tests.seed2(tests.seed())))) as v;
grant select on s to authenticated;
create or replace function tests.k(p text) returns uuid language sql stable as $$ select (v ->> p)::uuid from s $$;
create temp table ids (k text primary key, v jsonb);
grant select, insert on ids to authenticated;
create or replace function tests.r(p text) returns jsonb language sql stable as $$ select v from ids where k = p $$;
create or replace function tests.id(p text, f text default 'id') returns uuid language sql stable as $$ select (v ->> f)::uuid from ids where k = p $$;
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
insert into master.parties (legal_name, gst_status, gstin, state_code, is_customer, kyc_status) values ('Test Registered Buyer', 'registered', tests.gstin('32', 'CCCCC3333C'), '32', true, 'verified');
insert into master.party_companies (party_id, company_id, is_customer) select id, tests.k('company_a'), true from master.parties where legal_name = 'Test Registered Buyer';
create or replace function tests.b2b() returns uuid language sql stable as $$ select id from master.parties where legal_name = 'Test Registered Buyer' $$;
grant execute on function tests.b2b() to authenticated;

-- Posted documents (Admin): B2B, B2C intra-state, B2C inter-state, a credit note, a bill of supply without GST; a purchase bill.
create or replace function tests.post_doc(p_key text, p jsonb) returns void language plpgsql as $$
begin
  insert into ids select p_key, api.save_sales_draft(gen_random_uuid(), p);
  insert into ids select p_key || '_post', api.post_sales_document(gen_random_uuid(), (select (v ->> 'id')::uuid from ids where k = p_key));
end $$;
grant execute on function tests.post_doc(text, jsonb) to authenticated;
select tests.login(tests.k('admin'));
select tests.post_doc('b2b', jsonb_build_object('company_id', tests.k('company_a'), 'gstin_id', tests.k('gstin_a'), 'party_id', tests.b2b(), 'doc_type', 'sales_invoice', 'doc_date', current_date,
  'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('prod'), 'qty', 10, 'rate', 100))));
select tests.post_doc('b2c', jsonb_build_object('company_id', tests.k('company_a'), 'gstin_id', tests.k('gstin_a'), 'party_id', tests.k('cust'), 'doc_type', 'sales_invoice', 'doc_date', current_date,
  'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('prod'), 'qty', 5, 'rate', 100))));
select tests.post_doc('tn', jsonb_build_object('company_id', tests.k('company_a'), 'gstin_id', tests.k('gstin_a'), 'party_id', tests.k('cust_tn'), 'doc_type', 'sales_invoice', 'doc_date', current_date,
  'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('prod'), 'qty', 4, 'rate', 100))));
select tests.post_doc('cn', jsonb_build_object('company_id', tests.k('company_a'), 'gstin_id', tests.k('gstin_a'), 'party_id', tests.k('cust'), 'doc_type', 'credit_note', 'doc_date', current_date,
  'against_id', tests.id('b2c'), 'reason', 'Test return', 'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('prod'), 'qty', 1, 'rate', 100))));
select tests.post_doc('bos', jsonb_build_object('company_id', tests.k('company_a'), 'gstin_id', tests.k('gstin_a'), 'party_id', tests.k('cust'), 'doc_type', 'bill_of_supply',
  'lawful_reason', 'exempt_or_nil', 'doc_date', current_date, 'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('prod_free'), 'qty', 5, 'rate', 100))));
insert into ids select 'pb', api.save_purchase_draft(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'gstin_id', tests.k('gstin_a'), 'party_id', tests.k('supp'),
  'supplier_bill_no', 'TSUP-1', 'supplier_bill_date', current_date, 'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('rm2'), 'qty', 10, 'rate', 50))));
select api.post_purchase_bill(gen_random_uuid(), tests.id('pb'));
select tests.logout();

-- ── GSTR-1 (accountant: GST view) ──
select tests.login(tests.k('acct'));
insert into ids select 'g1', api.gstr1_summary(tests.k('company_a'), null, current_date - 1, current_date);
insert into ids select 'g3', api.gstr3b_summary(tests.k('company_a'), null, current_date - 1, current_date);
select tests.logout();
select is((select sum((x ->> 'taxable')::numeric) from jsonb_array_elements(tests.r('g1') -> 'b2b') x),
  (select sum(taxable) from sales.documents where company_id = tests.k('company_a') and status = 'posted' and doc_type = 'sales_invoice' and party_id = tests.b2b()), 'GSTR-1 B2B equals the posted B2B invoices');
select is((select sum((x ->> 'taxable')::numeric) from jsonb_array_elements(tests.r('g1') -> 'b2cs') x), 900.00::numeric, 'GSTR-1 B2C equals the posted unregistered invoices');
select is((select sum((x ->> 'igst')::numeric) from jsonb_array_elements(tests.r('g1') -> 'b2cs') x where x ->> 'pos' = '33'), 72.00::numeric, 'the inter-state B2C line carries IGST');
select is((select sum((x ->> 'taxable')::numeric) from jsonb_array_elements(tests.r('g1') -> 'hsn') x),
  (select sum(case when doc_type = 'credit_note' then -taxable else taxable end) from sales.documents where company_id = tests.k('company_a') and status = 'posted' and tax_class = 'taxable'),
  'the HSN summary equals the posted GST documents (credit notes subtracted)');
select is((tests.r('g1') #>> '{totals,taxable}')::numeric, 1800.00::numeric, 'GSTR-1 totals: invoices less credit notes');
select is(jsonb_array_length(tests.r('g1') -> 'cdnur'), 1, 'the credit note to an unregistered customer is in CDNUR');
select ok(not (tests.r('g1') ? 'nil_exempt_non_gst'), 'the accountant does not get the without-GST section');
select is(array[tests.r('g3') #>> '{outward_taxable,taxable}', tests.r('g3') #>> '{outward_taxable,cgst}', tests.r('g3') #>> '{outward_taxable,igst}'], array['1800.00', '126.00', '72.00'],
  'GSTR-3B outward taxable supplies from posted documents');
select is(array[tests.r('g3') #>> '{itc_available,cgst}', tests.r('g3') #>> '{itc_available,sgst}'], array['45.00', '45.00'], 'GSTR-3B ITC from the posted purchase bill');
select ok(tests.r('g3') -> 'outward_nil_exempt' = 'null'::jsonb, 'GSTR-3B nil/exempt figures are not shown to the accountant');
select tests.login(tests.k('acct'));
select is((select count(*)::int from api.itc_register(tests.k('company_a'), current_date - 1, current_date)), 1, 'the ITC register lists the purchase bill');
select tests.logout();
select tests.login(tests.k('admin'));
insert into ids select 'g1a', api.gstr1_summary(tests.k('company_a'), null, current_date - 1, current_date);
select is((tests.r('g1a') #>> '{nil_exempt_non_gst,0,value}')::numeric, 500.00::numeric, 'Admin sees the exempt supply in table 8 — every supply is in the returns workings');
select is((api.gstr3b_summary(tests.k('company_a'), null, current_date - 1, current_date) #>> '{outward_nil_exempt,value}')::numeric, 500.00::numeric, 'and in GSTR-3B 3.1(c)');

-- ── Schedule III (Admin maps; the CA's confirmation is recorded) ──
select api.set_schedule3_map(gen_random_uuid(), jsonb_build_object('account_group_id', g.id, 'line_code', case g.name
         when 'Trade receivables' then 'trade_receivables' when 'Trade payables' then 'trade_payables' when 'Bank accounts' then 'cash_equivalents'
         when 'Test Income' then 'revenue_operations' when 'Test Expenses' then 'other_expenses' when 'Test Duties and taxes' then 'other_current_liabilities'
         when 'Test Cash and bank' then 'cash_equivalents' else 'other_current_liabilities' end))
from acct.account_groups g where g.company_id = tests.k('company_a');
insert into ids select 's3a', api.schedule3_statements(tests.k('company_a'), date '2026-04-01', current_date);
select tests.logout();
select is((tests.r('s3a') #>> '{totals,difference}')::numeric, 0.00::numeric, 'Schedule III: assets = equity + liabilities (Admin, all transactions)');
select is((tests.r('s3a') ->> 'profit_for_period')::numeric, 1800.00::numeric, 'profit = revenue (incl. the exempt sale) − expenses, from the GL');
select is(jsonb_array_length(tests.r('s3a') -> 'unmapped_groups'), 0, 'every group is mapped');
select tests.login(tests.k('acct'));
insert into ids select 's3g', api.schedule3_statements(tests.k('company_a'), date '2026-04-01', current_date);
select is(array[(tests.r('s3g') #>> '{totals,difference}'), tests.r('s3g') ->> 'profit_for_period'], array['0.00', '1300.00'],
  'the GST view balances too and leaves out the sale without GST');
select is(tests.rule(format('select api.set_schedule3_map(gen_random_uuid(), jsonb_build_object(%L, %L, %L, %L))', 'account_group_id',
  (select id from acct.account_groups where company_id = tests.k('company_a') limit 1), 'line_code', 'ppe')), 'rights.missing', 'only Admin changes the mapping');
select tests.logout();

-- ── Help assistant data tools (security invoker) ──
select tests.login(tests.k('acct'));
select is(api.help_get_document_status(tests.r('bos_post') ->> 'doc_no') ->> 'found', 'false', 'the accountant''s help tool finds nothing for a bill without GST');
select is(api.help_get_document_status(tests.r('b2b_post') ->> 'doc_no') ->> 'found', 'true', 'it finds the GST invoice');
select is(api.help_check_my_rights(tests.k('company_a'), 'sales_invoices.create') ->> 'has_right', 'true', 'check_my_rights answers for the user''s own rights');
select tests.logout();
select tests.login(tests.k('admin'));
select is(api.help_get_document_status(tests.r('bos_post') ->> 'doc_no') ->> 'found', 'true', 'Admin''s help tool sees the bill without GST');

-- ── Reminders ──
insert into ids select 'rem7', api.schedule_reminders(gen_random_uuid(), tests.k('company_a'), current_date - 7);
select is(array[tests.r('rem7') ->> 'queued', tests.r('rem7') ->> 'skipped'], array['1', '2'],
  'day −7: one reminder queued for the consented customer; customers without a consented number are recorded as skipped');
select is(api.schedule_reminders(gen_random_uuid(), tests.k('company_a'), current_date - 5) ->> 'queued', '0', 'no reminder on a day that is not on the schedule');
select is(api.schedule_reminders(gen_random_uuid(), tests.k('company_a'), current_date - 7) ->> 'queued', '0', 'the same day again queues nothing (never twice)');
select is((select count(*)::int from msg.outbox where company_id = tests.k('company_a') and event = 'sales.payment_reminder'), 3, 'one row per customer for that day');
select api.post_receipt(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'party_id', tests.k('cust'), 'date', current_date, 'mode', 'bank', 'account_id', tests.k('bank'),
  'amount', 472, 'allocations', jsonb_build_array(jsonb_build_object('kind', 'sales_document', 'id', tests.id('b2c'), 'amount', 472))));
select is((select array[status, skip_reason] from msg.outbox where event = 'sales.payment_reminder' and party_id = tests.k('cust')), array['cancelled', 'bill settled'],
  'a settled bill cancels its queued reminder');

-- ── Inbox: payment proof → task, reminders held ──
select tests.logout();
insert into master.party_contacts (party_id, name, whatsapp, whatsapp_consent, consent_at, is_primary) values (tests.k('cust_tn'), 'Test TN Contact', '+919000000102', true, now(), true);
select tests.login(tests.k('admin'));
insert into ids select 'in1', api.record_inbound(gen_random_uuid(), jsonb_build_object('wa_message_id', 'wamid.TEST.P6.1', 'from_number', '+919000000102', 'kind', 'image',
  'company_id', tests.k('company_a')));
select is(tests.r('in1') ->> 'task_kind', 'payment_proof', 'a payment screenshot creates a payment-proof task');
select is((select array[priority, status] from msg.tasks where id = tests.id('in1', 'task_id')), array['urgent', 'open'], 'the task is urgent for finance');
select is(api.record_inbound(gen_random_uuid(), jsonb_build_object('wa_message_id', 'wamid.TEST.P6.1', 'from_number', '+919000000102', 'kind', 'image')) ->> 'duplicate', 'true',
  'the same inbound message twice is ignored');
select api.schedule_reminders(gen_random_uuid(), tests.k('company_a'), current_date);
select is((select skip_reason from msg.outbox where event = 'sales.payment_reminder' and party_id = tests.k('cust_tn') and params ->> 'offsets' = '[0]'), 'payment proof pending',
  'a pending payment proof holds the reminder');
select api.resolve_task(gen_random_uuid(), tests.id('in1', 'task_id'), 'done', 'Test checked against bank');

-- ── Cost cap ──
select api.set_message_rate(gen_random_uuid(), 'utility', 0.50, current_date);
select api.set_cost_cap(gen_random_uuid(), tests.k('company_a'), 0.50, 80);
select api.schedule_reminders(gen_random_uuid(), tests.k('company_a'), current_date - 3);
select is((select array[status, est_cost::text] from msg.outbox where event = 'sales.payment_reminder' and party_id = tests.k('cust_tn') and params ->> 'offsets' = '[-3]'), array['queued', '0.50'],
  'under the cap the reminder is queued with its estimated cost');
select is(api.send_statement_whatsapp(gen_random_uuid(), tests.k('company_a'), tests.k('cust_tn'), current_date) ->> 'skip_reason', 'monthly cost cap reached',
  'at the cap a non-urgent message is stopped with a skip reason');
select tests.post_doc('tn2', jsonb_build_object('company_id', tests.k('company_a'), 'gstin_id', tests.k('gstin_a'), 'party_id', tests.k('cust_tn'), 'doc_type', 'sales_invoice', 'doc_date', current_date,
  'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('prod'), 'qty', 1, 'rate', 100))));
select is((select status from msg.outbox where doc_type = 'sales.documents' and doc_id = tests.id('tn2') and event = 'sales.invoice_posted'), 'queued', 'an invoice still goes out at the cap');
select ok(exists (select 1 from msg.cost_alerts where company_id = tests.k('company_a') and level = 'alert'), 'the alert at the alert percentage is recorded');

-- ── STOP and RLS ──
select api.record_inbound(gen_random_uuid(), jsonb_build_object('wa_message_id', 'wamid.TEST.P6.2', 'from_number', '+919000000102', 'body', 'STOP'));
select tests.logout();
select is((select whatsapp_consent from master.party_contacts where whatsapp = '+919000000102'), false, 'STOP opts the number out at once');
select tests.login(tests.k('plastics_user'));
select is(tests.rule(format('select api.gstr1_summary(%L, null, current_date - 1, current_date)', tests.k('company_a'))), 'rights.missing', 'another company''s user cannot open the GST page');
select is((select count(*)::int from api.msg_tasks where company_id = tests.k('company_a')), 0, 'and sees none of its inbox tasks');
select tests.logout();

select * from finish();

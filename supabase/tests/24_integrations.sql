-- Phase 8 integrations: webhook dedupe (same external id twice → one event; unsigned events never block the real one),
-- outbound retries with back-off timing and the dead letter → Bug fixer item (closed again when a retry succeeds), the
-- e-invoice switch (no IRN → not final: no print, the WhatsApp message waits, goods do not leave), the IRN cancel window,
-- the e-way bill required before the trip starts (and a cancelled e-way bill refused), service-only RPCs, the TCS u/s 52
-- reconciliation totals (rate is a CA setting; unset → rate_not_set), help on WhatsApp refusing unverified numbers and data
-- tools, GPS points only on duty, the stale-worker sweep, and RLS. Mock provider only (allowed by a test setting). Synthetic data.
select plan(65);

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

-- Test-only settings: the mock provider for e-invoice and e-way, allowed on this (test) database.
insert into core.settings (company_id, key, value, note) values
  (tests.k('company_a'), 'integrations.provider.einvoice', '"mock"', 'test'), (tests.k('company_a'), 'integrations.provider.eway', '"mock"', 'test'),
  (tests.k('company_a'), 'integrations.allow_mock', 'true', 'test');
-- A consented WhatsApp contact for the registered (B2B) customer, so the invoice message can be checked.
insert into master.party_contacts (party_id, name, whatsapp, whatsapp_consent, is_primary) values (tests.k('tn_party'), 'Test B2B Contact', '+919000000801', true, true);

-- ── Back-off schedule ──
select is(array[app.integration_backoff_seconds(1, 60, 21600), app.integration_backoff_seconds(2, 60, 21600), app.integration_backoff_seconds(3, 60, 21600),
                app.integration_backoff_seconds(4, 60, 21600), app.integration_backoff_seconds(20, 60, 21600)],
          array[60, 120, 240, 480, 21600], 'back-off doubles from the base and is capped');

-- ── E-invoice switch ──
select tests.login(tests.k('acct'));
insert into ids select 'b2b', api.save_sales_draft(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'gstin_id', tests.k('gstin_a'),
  'party_id', tests.k('tn_party'), 'doc_type', 'sales_invoice', 'doc_date', current_date, 'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('prod'), 'qty', 2, 'rate', 100))));
select api.post_sales_document(gen_random_uuid(), tests.id('b2b'));
select is(tests.rule(format('select api.request_einvoice(gen_random_uuid(), %L)', tests.id('b2b'))), 'einvoice.switch_off', 'no IRN is asked while the GSTIN''s switch is off');
select is(tests.rule(format('select api.set_einvoice_switch(gen_random_uuid(), %L, true, current_date - 30, %L)', tests.k('gstin_a'), 'Test CA note')), 'rights.missing',
  'only Admin switches e-invoicing');
select tests.logout();
select tests.login(tests.k('admin'));
select is(tests.rule(format('select api.set_einvoice_switch(gen_random_uuid(), %L, true, null, null)', tests.k('gstin_a'))), 'einvoice.ca_note',
  'switching on needs the CA''s note');
select is((api.set_einvoice_switch(gen_random_uuid(), tests.k('gstin_a'), true, current_date - 30, 'Test CA confirmation') ->> 'einvoice_enabled')::boolean, true,
  'Admin switches e-invoicing on with a start date');
select tests.logout();

select tests.login(tests.k('acct'));
insert into ids select 'b2c', api.save_sales_draft(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'gstin_id', tests.k('gstin_a'),
  'party_id', tests.k('cust'), 'doc_type', 'sales_invoice', 'doc_date', current_date, 'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('prod'), 'qty', 1, 'rate', 100))));
select api.post_sales_document(gen_random_uuid(), tests.id('b2c'));
select is(tests.rule(format('select api.request_einvoice(gen_random_uuid(), %L)', tests.id('b2c'))), 'einvoice.not_eligible', 'a sale to an unregistered customer gets no IRN');
select is((api.document_final_status(tests.id('b2c')) ->> 'final')::boolean, true, 'a B2C invoice is final when posted');
-- A B2B invoice posted after the switch: not final until its IRN.
insert into ids select 'b2b2', api.save_sales_draft(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'gstin_id', tests.k('gstin_a'),
  'party_id', tests.k('tn_party'), 'doc_type', 'sales_invoice', 'doc_date', current_date, 'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('prod'), 'qty', 1, 'rate', 100))));
select api.post_sales_document(gen_random_uuid(), tests.id('b2b2'));
select is(array[(api.document_final_status(tests.id('b2b2')) ->> 'einvoice_required'), (api.document_final_status(tests.id('b2b2')) ->> 'final')], array['true', 'false'],
  'a posted B2B invoice with the switch on is not final without its IRN');
select is(tests.rule(format('select api.check_document_printable(%L)', tests.id('b2b2'))), 'einvoice.irn_required', 'it cannot be printed without its IRN');
select is((select array[send_after::text, skip_reason] from msg.outbox where doc_type = 'sales.documents' and doc_id = tests.id('b2b2') and template_name = 'invoice_posted'),
  array['infinity', 'waiting for IRN'], 'the invoice message waits for the IRN');
insert into ids select 'rq', api.request_einvoice(gen_random_uuid(), tests.id('b2b2'));
select is(array[tests.r('rq') ->> 'status', tests.r('rq') ->> 'provider'], array['queued', 'mock'], 'the IRN request is queued for the provider');
select is(api.request_einvoice(gen_random_uuid(), tests.id('b2b2')) ->> 'request_id', tests.r('rq') ->> 'request_id', 'asking again returns the same request (idempotent)');
select is(tests.rule(format('select api.run_mock_integration(gen_random_uuid(), %L)', tests.id('rq', 'request_id'))), 'rights.missing', 'only Admin runs the mock provider');
select is(tests.rule(format('select api.apply_einvoice_result(%L, %L::jsonb)', tests.id('rq', 'request_id'), '{"ok": true}')), '42501',
  'a signed-in user cannot report a provider result (service only)');
select is(tests.rule('select api.integration_claim_due(10, null)'), '42501', 'a signed-in user cannot claim integration work');
select is((select count(*)::int from ops.integration_requests), 0, 'RLS: the accountant does not see the integration log');
select tests.logout();

-- ── Retries with back-off, then dead letter → Bug fixer ──
select tests.login(tests.k('admin'));
select is(api.run_mock_integration(gen_random_uuid(), tests.id('rq', 'request_id'), '{"fail": true, "error": "Test GSP timeout"}') ->> 'status', 'queued',
  'a failed attempt goes back to the queue');
select is((select array[attempts::text, extract(epoch from next_attempt_at - now())::int::text] from ops.integration_requests where id = tests.id('rq', 'request_id')),
  array['1', '60'], 'first retry after the base wait (60 s)');
select api.run_mock_integration(gen_random_uuid(), tests.id('rq', 'request_id'), '{"fail": true, "error": "Test GSP timeout"}');
select is((select extract(epoch from next_attempt_at - now())::int from ops.integration_requests where id = tests.id('rq', 'request_id')), 120, 'the wait doubles (120 s)');
select api.run_mock_integration(gen_random_uuid(), tests.id('rq', 'request_id'), '{"fail": true, "error": "Test GSP timeout"}');
select api.run_mock_integration(gen_random_uuid(), tests.id('rq', 'request_id'), '{"fail": true, "error": "Test GSP timeout"}');
select is(api.run_mock_integration(gen_random_uuid(), tests.id('rq', 'request_id'), '{"fail": true, "error": "Test GSP timeout"}') ->> 'status', 'dead',
  'after the fifth failed attempt the request is dead-lettered');
select is((select array[b.area, b.kind, b.status, b.severity] from ops.bug_items b join ops.integration_requests r on r.bug_id = b.id where r.id = tests.id('rq', 'request_id')),
  array['integration', 'integration_dead_letter', 'open', 'high'], 'the dead letter opens a Bug fixer item');
select is((select count(*)::int from ops.integration_attempts where request_id = tests.id('rq', 'request_id') and not ok), 5, 'every attempt is logged');
select is(api.integration_retry(gen_random_uuid(), tests.id('rq', 'request_id')) ->> 'status', 'queued', 'Admin retries the dead request');
insert into ids select 'ok', api.run_mock_integration(gen_random_uuid(), tests.id('rq', 'request_id'));
select is((select array[status, is_mock::text, (irn ~ '^[0-9a-f]{64}$')::text] from sales.einvoice_irns where document_id = tests.id('b2b2')), array['active', 'true', 'true'],
  'the IRN is stored (64 hex characters, flagged as mock)');
select is((select b.status from ops.bug_items b join ops.integration_requests r on r.bug_id = b.id where r.id = tests.id('rq', 'request_id')), 'fixed',
  'the Bug fixer item closes when the retry succeeds');
select is((select irn from sales.documents where id = tests.id('b2b2')), (select irn from sales.einvoice_irns where document_id = tests.id('b2b2')), 'the invoice carries its IRN');
select is((api.check_document_printable(tests.id('b2b2')) ->> 'final')::boolean, true, 'with its IRN the invoice is final and printable');
select ok(split_part(api.document_final_status(tests.id('b2b2')) #>> '{irn,signed_qr}', '.', 3) = 'MOCK', 'the signed QR payload is returned for printing');
select is((select skip_reason from msg.outbox where doc_type = 'sales.documents' and doc_id = tests.id('b2b2') and template_name = 'invoice_posted'), null,
  'the invoice message is released once the IRN arrives');
select is(tests.rule(format('select api.cancel_sales_document(gen_random_uuid(), %L, %L)', tests.id('b2b2'), 'Test cancel reason')), 'einvoice.cancel_irn_first',
  'a document with an active IRN is not cancelled before the IRN');
select tests.logout();
select is(api.apply_einvoice_result(tests.id('rq', 'request_id'), '{"ok": true}') ->> 'duplicate', 'true', 'a repeated provider answer changes nothing (idempotent)');

-- ── IRN cancel window ──
select tests.login(tests.k('acct'));
insert into ids select 'b2b3', api.save_sales_draft(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'gstin_id', tests.k('gstin_a'),
  'party_id', tests.k('tn_party'), 'doc_type', 'sales_invoice', 'doc_date', current_date, 'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('prod'), 'qty', 1, 'rate', 90))));
select api.post_sales_document(gen_random_uuid(), tests.id('b2b3'));
select tests.logout();
insert into sales.einvoice_irns (company_id, gstin_id, document_id, irn, ack_no, ack_date, signed_qr, provider, is_mock)
values (tests.k('company_a'), tests.k('gstin_a'), tests.id('b2b3'), repeat('ab', 32), '100000000000001', now() - interval '25 hours', 'x.y.MOCK', 'mock', true);
select tests.login(tests.k('admin'));
select is(tests.rule(format('select api.cancel_einvoice(gen_random_uuid(), %L, %L, %L)', tests.id('b2b3'), 'data_entry_mistake', 'Test wrong rate')), 'einvoice.cancel_window',
  'an IRN older than 24 hours cannot be cancelled (credit note instead)');
select is(tests.rule(format('select api.cancel_einvoice(gen_random_uuid(), %L, %L, %L)', tests.id('b2b2'), 'because', 'Test wrong rate')), 'einvoice.cancel_reason',
  'the cancel reason is one of the IRP reasons');
insert into ids select 'cn', api.cancel_einvoice(gen_random_uuid(), tests.id('b2b2'), 'data_entry_mistake', 'Test wrong rate');
select api.run_mock_integration(gen_random_uuid(), tests.id('cn', 'request_id'));
select is((select status from sales.einvoice_irns where document_id = tests.id('b2b2')), 'cancelled', 'an IRN inside the window is cancelled through the provider');
select tests.logout();
select is(tests.rule(format('update sales.einvoice_irns set signed_qr = %L where document_id = %L', 'tampered', tests.id('b2b3'))), 'einvoice.locked', 'an IRN is never edited');

-- ── Dispatch: e-way bill required, invoice must be final ──
select tests.login(tests.k('admin'));
insert into ids select 'o1', api.confirm_sales_order(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'party_id', tests.k('tn_party'), 'place_id', tests.k('stores'),
  'payment', 'cash'), jsonb_build_array(jsonb_build_object('product_id', tests.k('prod'), 'qty', 2, 'rate', 100)));
select tests.logout();
select tests.login(tests.k('buyer'));
insert into ids select 'd1', api.create_dispatch(gen_random_uuid(), jsonb_build_object('order_id', tests.id('o1')));
select tests.logout();
select tests.login(tests.k('acct'));
insert into ids select 'inv1', api.invoice_dispatch(gen_random_uuid(), tests.id('d1'), '{}');
select tests.logout();
select tests.login(tests.k('buyer'));
insert into ids select 'trip', api.create_trip(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'transporter', 'Test Transporter', 'driver_user_id', tests.k('carrier'),
  'dispatch_ids', jsonb_build_array(tests.id('d1'))));
select is(tests.rule(format('select api.request_eway_bill(gen_random_uuid(), %L, %L::jsonb)', tests.id('d1'), '{"vehicle_no": "KL08AB1234", "distance_km": 300}')),
  'einvoice.irn_required', 'the e-way bill waits for the invoice''s IRN');
select tests.logout();
select tests.login(tests.k('carrier'));
select is(tests.rule(format('select api.start_trip(gen_random_uuid(), %L, %L::jsonb)', tests.id('trip'), '{"gps_notice_ack": true}')), 'dispatch.eway_required',
  'the vehicle cannot leave without the e-way bill');
select tests.logout();
select tests.login(tests.k('admin'));
insert into ids select 'rq2', api.request_einvoice(gen_random_uuid(), tests.id('inv1', 'document_id'));
select api.run_mock_integration(gen_random_uuid(), tests.id('rq2', 'request_id'));
select tests.logout();
select tests.login(tests.k('buyer'));
insert into ids select 'ew', api.request_eway_bill(gen_random_uuid(), tests.id('d1'), '{"vehicle_no": "KL 08 AB 1234", "distance_km": 300}');
select is(tests.r('ew') ->> 'status', 'queued', 'the e-way bill request is queued');
select tests.logout();
select tests.login(tests.k('admin'));
select api.run_mock_integration(gen_random_uuid(), tests.id('ew', 'request_id'));
select tests.logout();
select is((select array[e.status, e.vehicle_no, (x.eway_bill_no = e.eway_bill_no)::text] from sales.eway_bills e join sales.dispatches x on x.id = e.dispatch_id where e.dispatch_id = tests.id('d1')),
  array['active', 'KL08AB1234', 'true'], 'the e-way bill is stored and put on the dispatch');
select tests.login(tests.k('carrier'));
select is(api.start_trip(gen_random_uuid(), tests.id('trip'), '{"gps_notice_ack": true}') ->> 'status', 'started', 'with IRN and e-way bill the trip starts');
select tests.logout();

-- A cancelled e-way bill number typed by hand is refused at the gate.
select tests.login(tests.k('admin'));
insert into ids select 'o2', api.confirm_sales_order(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'party_id', tests.k('cust'), 'place_id', tests.k('stores'),
  'payment', 'cash'), jsonb_build_array(jsonb_build_object('product_id', tests.k('prod'), 'qty', 1, 'rate', 100)));
select tests.logout();
select tests.login(tests.k('buyer'));
insert into ids select 'd2', api.create_dispatch(gen_random_uuid(), jsonb_build_object('order_id', tests.id('o2')));
select tests.logout();
select tests.login(tests.k('acct'));
select api.invoice_dispatch(gen_random_uuid(), tests.id('d2'), '{}');
select tests.logout();
insert into sales.eway_bills (company_id, dispatch_id, eway_bill_no, generated_at, provider, is_mock, status, cancelled_at)
values (tests.k('company_a'), null, '199999999991', now() - interval '2 hours', 'mock', true, 'cancelled', now());
select tests.login(tests.k('buyer'));
select api.set_dispatch_eway(gen_random_uuid(), tests.id('d2'), '199999999991');
insert into ids select 'trip2', api.create_trip(gen_random_uuid(), jsonb_build_object('company_id', tests.k('company_a'), 'transporter', 'Test Transporter', 'dispatch_ids', jsonb_build_array(tests.id('d2'))));
select is(tests.rule(format('select api.start_trip(gen_random_uuid(), %L, %L::jsonb)', tests.id('trip2'), '{}')), 'dispatch.eway_invalid', 'a cancelled e-way bill cannot carry goods');
select tests.logout();

-- ── GPS provider: only on duty ──
insert into ops.gps_devices (company_id, provider, device_ref, user_id) values (tests.k('company_a'), 'mock', 'TEST-DEV-1', tests.k('carrier')), (tests.k('company_a'), 'mock', 'TEST-DEV-2', tests.k('buyer'));
select is(api.gps_ingest('mock', 'TEST-DEV-2', jsonb_build_array(jsonb_build_object('at', now(), 'lat', 10.1, 'lng', 76.2))) ->> 'reason', 'off_duty', 'points off duty are refused');
select is((api.gps_ingest('mock', 'TEST-DEV-1', jsonb_build_array(jsonb_build_object('at', now(), 'lat', 10.1, 'lng', 76.2),
                                                                     jsonb_build_object('at', now() - interval '1 day', 'lat', 10.1, 'lng', 76.2))) ->> 'accepted')::int, 1,
  'only points inside the driver''s open duty session are kept');

-- ── Webhooks: signature first, deduplicated ──
select is(api.ingest_webhook('shopify', 'test-evt-1', true, 'orders/create', '{"id": 1}') ->> 'accepted', 'true', 'a signed webhook is recorded');
select is(api.ingest_webhook('shopify', 'test-evt-1', true, 'orders/create', '{"id": 1}') ->> 'duplicate', 'true', 'the same event id again is a duplicate');
select is(api.ingest_webhook('shopify', 'test-evt-2', false, 'orders/create', '{"id": 2}') ->> 'reason', 'bad_signature', 'an unsigned event is rejected');
select is(api.ingest_webhook('shopify', 'test-evt-2', true, 'orders/create', '{"id": 2}') ->> 'accepted', 'true', 'a forged event never blocks the real one');
select is((select count(*)::int from ops.webhook_events where provider = 'shopify' and external_id = 'test-evt-1'), 1, 'one stored event per provider and id');

-- ── Help on WhatsApp: verified staff only, no data tools ──
update master.people set phone = '+919000000901' where id = tests.k('person');
select tests.login(tests.k('admin'));
select is(tests.rule(format('select api.verify_help_whatsapp_staff(gen_random_uuid(), %L::jsonb)', jsonb_build_object('person_id', tests.k('person'), 'number', '+919000000909', 'consent', true))),
  'help_wa.number_mismatch', 'only the number on the staff record can be verified');
select api.verify_help_whatsapp_staff(gen_random_uuid(), jsonb_build_object('person_id', tests.k('person'), 'number', '+919000000901', 'consent', true));
select tests.logout();
select is(api.help_whatsapp_inbound(null, '+919000000902', 'text', 'how do I post an invoice') ->> 'allowed', 'false', 'an unverified number gets no assistant');
select is(tests.rule(format('select api.help_wa_tool(%L, %L, %L::jsonb)', '+919000000902', 'search_help', '{"query": "invoice"}')), 'help_wa.unverified',
  'tools refuse unverified numbers');
select is(api.help_whatsapp_inbound(null, '+919000000901', 'text', 'my aadhaar is 1234 5678 9012') ->> 'allowed', 'true', 'a verified staff number is served');
select is((select body from help.whatsapp_messages order by id desc limit 1), 'my aadhaar is [number]', 'numbers are masked before the line is kept');
select is(tests.rule(format('select api.help_wa_tool(%L, %L, %L::jsonb)', '+919000000901', 'help_get_stock', '{"query": "soap"}')), 'help_wa.tool_not_allowed',
  'no data tools on WhatsApp');
select ok((api.help_wa_tool('+919000000901', 'create_problem_report', '{"what_happened": "Test cannot print"}') ->> 'code') like 'HR-%', 'a staff member files a problem on WhatsApp');

-- ── TCS u/s 52 reconciliation ──
insert into sales.online_channels (company_id, code, gstin_id, party_id, place_id, tcs_applicable, status)
values (tests.k('company_a'), 'amazon', tests.k('gstin_a'), tests.k('cust'), tests.k('stores'), true, 'active');
select tests.login(tests.k('admin'));
insert into ids select 'oo', api.ingest_online_order(gen_random_uuid(), jsonb_build_object('channel_id', (select id from sales.online_channels where company_id = tests.k('company_a') and code = 'amazon'),
  'external_order_id', 'TEST-AMZ-1', 'ship_state', '32', 'lines', jsonb_build_array(jsonb_build_object('product_id', tests.k('prod'), 'qty', 1, 'price_incl_tax', 118))));
select tests.logout();
select tests.login(tests.k('buyer'));
insert into ids select 'd3', api.create_dispatch(gen_random_uuid(), jsonb_build_object('order_id', tests.id('oo', 'order_id')));
select tests.logout();
select tests.login(tests.k('acct'));
select api.invoice_dispatch(gen_random_uuid(), tests.id('d3'), '{}');
insert into ids select 'st', api.record_marketplace_settlement(gen_random_uuid(), jsonb_build_object('channel_id', (select id from sales.online_channels where company_id = tests.k('company_a') and code = 'amazon'),
  'settlement_ref', 'TEST-SET-1', 'period_from', date_trunc('month', current_date)::date, 'period_to', current_date, 'gross_sales', 118, 'net_taxable', 100,
  'tcs_cgst', 0.50, 'tcs_sgst', 0.50, 'commission', 10, 'net_payout', 106));
select is((select array[status, operator_net_taxable::text, books_net_taxable::text, operator_tcs::text] from api.tcs_reconciliation where channel_code = 'amazon' and company_id = tests.k('company_a')),
  array['rate_not_set', '100.00', '100.00', '1.00'], 'without the CA''s TCS rate the row says so (never invented)');
select tests.logout();
insert into core.settings (company_id, key, value, effective_from, note) values (tests.k('company_a'), 'marketplace.tcs_rate_pct', '1', date_trunc('month', current_date)::date, 'Test CA rate');
select tests.login(tests.k('acct'));
select is((select array[status, expected_tcs::text, tcs_difference::text] from api.tcs_reconciliation where channel_code = 'amazon' and company_id = tests.k('company_a')),
  array['matched', '1.00', '0.00'], 'operator TCS matches our books at the CA''s rate');
select api.record_marketplace_settlement(gen_random_uuid(), jsonb_build_object('reverses_id', tests.id('st'), 'note', 'Test wrong settlement'));
select is((select array[status, operator_tcs::text, settlements::text] from api.tcs_reconciliation where channel_code = 'amazon' and company_id = tests.k('company_a')),
  array['mismatch', '0.00', '2'], 'a reversed settlement shows the gap against the books');
select tests.logout();
select is(tests.rule(format('delete from sales.marketplace_settlements where id = %L', tests.id('st'))), 'P0001', 'settlements are append-only');
select tests.login(tests.k('plastics_user'));
select is((select count(*)::int from api.tcs_reconciliation where company_id = tests.k('company_a')), 0, 'RLS: another company''s user sees no reconciliation');
select is((select count(*)::int from sales.einvoice_irns where company_id = tests.k('company_a')), 0, 'RLS: another company''s user sees no IRNs');
select tests.logout();

-- ── Worker: claim and the stale sweep ──
insert into ops.integration_requests (company_id, provider, kind, payload_hash, idempotency_key, status, attempts, max_attempts, locked_at)
values (tests.k('company_a'), 'mock', 'channel_order_ack', 'x', 'test-stale-1', 'in_progress', 1, 5, now() - interval '11 minutes');
insert into ops.integration_requests (company_id, provider, kind, payload_hash, idempotency_key, max_attempts) values (tests.k('company_a'), 'mock', 'channel_order_ack', 'y', 'test-due-1', 5);
select ok(api.integration_claim_due(100, array['channel_order_ack']) @> jsonb_build_array(jsonb_build_object('kind', 'channel_order_ack', 'attempts', 1)), 'the worker claims due requests');
select is((select status from ops.integration_requests where idempotency_key = 'test-due-1'), 'in_progress', 'a claimed request is in progress');
select app.integration_sweep();
select is((select array[status, attempts::text] from ops.integration_requests where idempotency_key = 'test-stale-1'), array['queued', '1'],
  'a request whose worker never reported back is retried after back-off');
select is(api.integration_report((select id from ops.integration_requests where idempotency_key = 'test-due-1'), true, '{}', null) ->> 'status', 'done', 'the worker reports success');

select * from finish();

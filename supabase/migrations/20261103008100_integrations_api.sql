-- 20261103008100_integrations_api.sql
-- Phase 8 RPCs. Every outside call goes through ops.integration_requests: queued by a business RPC (rights, state and
-- idempotency checked here), claimed by the integration-worker Edge Function, reported back through a service-only RPC.
-- A failed attempt is retried with exponential back-off; after `integrations.max_attempts` (or a non-retryable error) the
-- request is dead-lettered and a Bug fixer item opens. Inbound webhooks are recorded once per provider + external id,
-- and only after the signature was checked. Service-only RPCs refuse every signed-in user (app.require_service) and are
-- not granted to `authenticated` at all (see the grants at the end).
-- Additive: new functions; api.cancel_sales_document is replaced with one extra rule (an active IRN is cancelled first).

-- ─────────── Helpers ───────────
-- The Edge Functions (service role), or the database owner itself (pg_cron, migrations, pgTAP) — never a signed-in user.
create or replace function app.is_service() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(auth.role(), '') = 'service_role'
      or (auth.uid() is null and coalesce(auth.role(), '') = '' and session_user = 'postgres')
$$;

create or replace function app.require_service() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_service() then perform app.raise_rule('rights.service_only', 'only the integration service may do this', '42501'); end if;
end $$;

create or replace function app.integ_setting(p_company uuid, p_key text, p_fallback numeric default null) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(app.setting(p_company, p_key) #>> '{}', '')::numeric, p_fallback)
$$;

-- Exponential back-off: base × 2^(attempts−1), capped. Mirrors supabase/functions/_shared/backoff.ts (unit-tested there).
create or replace function app.integration_backoff_seconds(p_attempts int, p_base int, p_max int) returns int
language sql immutable set search_path = '' as $$
  select least(p_max::numeric, p_base::numeric * power(2::numeric, greatest(least(p_attempts, 31) - 1, 0)))::int
$$;

create or replace function app.payload_hash(p jsonb) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(convert_to(coalesce(p, '{}'::jsonb)::text, 'UTF8'), 'sha256'), 'hex')
$$;

-- The provider chosen for a kind of integration (Settings → `integrations.provider.einvoice|eway|bank_feed|store|gps|whatsapp_help`).
-- The mock provider only where `integrations.allow_mock` is true (DEV and tests) — never on prod.
create or replace function app.integration_provider(p_company uuid, p_group text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v text := nullif(app.setting(p_company, 'integrations.provider.' || p_group) #>> '{}', '');
begin
  if v is null then
    perform app.raise_rule('integrations.provider_not_set', 'no ' || p_group || ' provider is chosen yet; the owner picks one on Settings', '22023');
  end if;
  if v = 'mock' and coalesce((app.setting(p_company, 'integrations.allow_mock') #>> '{}')::boolean, false) is not true then
    perform app.raise_rule('integrations.mock_not_allowed', 'the mock provider is allowed only on the development database', '42501');
  end if;
  return v;
end $$;

-- Queue an outbound request once per idempotency key. A dead or cancelled request with the same key is queued again.
create or replace function app.integration_enqueue(p_company uuid, p_provider text, p_kind text, p_ref_table text, p_ref_id uuid, p_payload jsonb, p_key text)
returns ops.integration_requests
language plpgsql security invoker set search_path = '' as $$
declare r ops.integration_requests; v_max int := app.integ_setting(p_company, 'integrations.max_attempts', 5)::int;
begin
  select * into r from ops.integration_requests where idempotency_key = p_key for update;
  if r.id is not null then
    if r.status in ('dead', 'cancelled') then
      update ops.integration_requests set status = 'queued', attempts = 0, max_attempts = v_max, next_attempt_at = now(), payload = p_payload,
             payload_hash = app.payload_hash(p_payload), updated_at = now(), locked_at = null
       where id = r.id returning * into r;
    end if;
    return r;
  end if;
  insert into ops.integration_requests (company_id, provider, kind, ref_table, ref_id, payload, payload_hash, idempotency_key, max_attempts, created_by)
  values (p_company, p_provider, p_kind, p_ref_table, p_ref_id, coalesce(p_payload, '{}'::jsonb), app.payload_hash(p_payload), p_key, v_max, auth.uid())
  returning * into r;
  return r;
end $$;

-- Start an attempt (the worker's claim does the same for a batch): counts the attempt before the call is made.
create or replace function app.integration_begin(p_id uuid) returns ops.integration_requests
language plpgsql security invoker set search_path = '' as $$
declare r ops.integration_requests;
begin
  update ops.integration_requests set status = 'in_progress', attempts = attempts + 1, locked_at = now(), updated_at = now()
   where id = p_id and status = 'queued' returning * into r;
  if r.id is null then perform app.raise_rule('integrations.not_queued', 'this request is not waiting to be sent', '22023'); end if;
  return r;
end $$;

create or replace function app.integration_succeed(p_id uuid, p_response jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
declare r ops.integration_requests;
begin
  update ops.integration_requests set status = 'done', response = p_response, done_at = now(), updated_at = now(), locked_at = null, last_error = null
   where id = p_id returning * into r;
  insert into ops.integration_attempts (request_id, attempt_no, ok) values (r.id, r.attempts, true);
  if r.bug_id is not null then
    update ops.bug_items set status = 'fixed', resolution = 'The integration request went through on a later try', fixed_at = now() where id = r.bug_id and status = 'open';
  end if;
end $$;

-- A failed attempt: retry later with back-off, or dead-letter it (and open one Bug fixer item for it).
create or replace function app.integration_fail(p_id uuid, p_error text, p_retryable boolean default true) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare r ops.integration_requests; v_wait int; v_next timestamptz; v_bug uuid;
begin
  select * into r from ops.integration_requests where id = p_id for update;
  if r.id is null then perform app.raise_rule('integrations.missing', 'request not found', 'P0002'); end if;
  if r.status in ('done', 'cancelled') then return jsonb_build_object('id', r.id, 'status', r.status); end if;
  if coalesce(p_retryable, true) and r.attempts < r.max_attempts then
    v_wait := app.integration_backoff_seconds(greatest(r.attempts, 1), app.integ_setting(r.company_id, 'integrations.backoff_base_seconds', 60)::int,
                                              app.integ_setting(r.company_id, 'integrations.backoff_max_seconds', 21600)::int);
    v_next := now() + make_interval(secs => v_wait);
    update ops.integration_requests set status = 'queued', next_attempt_at = v_next, last_error = left(p_error, 1000), locked_at = null, updated_at = now() where id = r.id;
    insert into ops.integration_attempts (request_id, attempt_no, ok, error, retryable, next_attempt_at) values (r.id, r.attempts, false, left(p_error, 1000), true, v_next);
    return jsonb_build_object('id', r.id, 'status', 'queued', 'next_attempt_at', v_next, 'wait_seconds', v_wait);
  end if;
  v_bug := app.open_bug(jsonb_build_object('company_id', r.company_id, 'area', 'integration', 'kind', 'integration_dead_letter', 'severity', 'high',
    'title', 'Integration gave up: ' || r.kind || ' (' || r.provider || ') after ' || r.attempts || ' attempt(s)',
    'evidence', jsonb_build_object('request_id', r.id, 'kind', r.kind, 'provider', r.provider, 'attempts', r.attempts, 'last_error', left(p_error, 500),
                                   'ref_table', r.ref_table, 'ref_id', r.ref_id),
    'suggested_fix', 'Check the provider status and the document, then retry from Bug fixer → Integrations', 'who_fixes', 'admin',
    'ref_table', 'ops.integration_requests', 'ref_id', r.id, 'dedupe_key', 'integration:' || r.id || ':' || r.attempts));
  update ops.integration_requests set status = 'dead', last_error = left(p_error, 1000), locked_at = null, updated_at = now(), bug_id = v_bug where id = r.id;
  insert into ops.integration_attempts (request_id, attempt_no, ok, error, retryable) values (r.id, r.attempts, false, left(p_error, 1000), coalesce(p_retryable, true));
  return jsonb_build_object('id', r.id, 'status', 'dead', 'bug_id', v_bug);
end $$;

-- ─────────── Worker RPCs (service only) ───────────
-- Claim due requests (skip locked, so two workers never take the same one).
create or replace function api.integration_claim_due(p_limit int default 20, p_kinds text[] default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app.require_service();
  with c as (
    select id from ops.integration_requests
    where status = 'queued' and next_attempt_at <= now() and (p_kinds is null or kind = any (p_kinds))
    order by next_attempt_at limit greatest(least(coalesce(p_limit, 20), 100), 1)
    for update skip locked),
  u as (
    update ops.integration_requests r set status = 'in_progress', attempts = r.attempts + 1, locked_at = now(), updated_at = now()
    from c where r.id = c.id
    returning r.id, r.company_id, r.provider, r.kind, r.ref_table, r.ref_id, r.payload, r.attempts, r.max_attempts)
  select coalesce(jsonb_agg(to_jsonb(u)), '[]'::jsonb) into v from u;
  return v;
end $$;

-- Generic report for kinds without their own apply RPC (bank feed sync, channel sync, help replies).
create or replace function api.integration_report(p_request_id uuid, p_ok boolean, p_response jsonb, p_error text, p_retryable boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r ops.integration_requests;
begin
  perform app.require_service();
  select * into r from ops.integration_requests where id = p_request_id for update;
  if r.id is null then perform app.raise_rule('integrations.missing', 'request not found', 'P0002'); end if;
  if r.status = 'done' then return jsonb_build_object('id', r.id, 'status', 'done', 'duplicate', true); end if;
  if r.kind in ('einvoice_generate', 'einvoice_cancel', 'eway_generate', 'eway_update_partb', 'eway_cancel') and p_ok then
    perform app.raise_rule('integrations.use_apply', 'report e-invoice and e-way results through their own apply RPC', '22023');
  end if;
  if p_ok then perform app.integration_succeed(r.id, coalesce(p_response, '{}'::jsonb)); return jsonb_build_object('id', r.id, 'status', 'done'); end if;
  return app.integration_fail(r.id, coalesce(p_error, 'unknown error'), p_retryable);
end $$;

-- ─────────── Admin RPCs ───────────
create or replace function api.integration_retry(p_client_request_id uuid, p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; r ops.integration_requests; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'integration_retry'); if v_prev is not null then return v_prev; end if;
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'only Admin retries integration requests', '42501'); end if;
  select * into r from ops.integration_requests where id = p_request_id for update;
  if r.id is null then perform app.raise_rule('integrations.missing', 'request not found', 'P0002'); end if;
  if r.status not in ('dead', 'queued') then perform app.raise_rule('integrations.state', 'only a waiting or dead request can be retried', '22023'); end if;
  update ops.integration_requests set status = 'queued', attempts = 0, max_attempts = app.integ_setting(r.company_id, 'integrations.max_attempts', 5)::int,
         next_attempt_at = now(), locked_at = null, updated_at = now() where id = r.id;
  perform app.log_event('admin_action', jsonb_build_object('entity', 'integration_request', 'action', 'retry', 'id', r.id, 'kind', r.kind));
  v_res := jsonb_build_object('id', r.id, 'status', 'queued');
  return app.request_done(p_client_request_id, 'integration_retry', v_res);
end $$;

create or replace function api.integration_cancel(p_client_request_id uuid, p_request_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; r ops.integration_requests; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'integration_cancel'); if v_prev is not null then return v_prev; end if;
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'only Admin cancels integration requests', '42501'); end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'say why in a few words', '22023'); end if;
  select * into r from ops.integration_requests where id = p_request_id for update;
  if r.id is null then perform app.raise_rule('integrations.missing', 'request not found', 'P0002'); end if;
  if r.status not in ('dead', 'queued') then perform app.raise_rule('integrations.state', 'only a waiting or dead request can be cancelled', '22023'); end if;
  update ops.integration_requests set status = 'cancelled', last_error = coalesce(last_error || ' · ', '') || 'Cancelled: ' || p_reason, updated_at = now() where id = r.id;
  perform app.log_event('admin_action', jsonb_build_object('entity', 'integration_request', 'action', 'cancel', 'id', r.id, 'reason', p_reason));
  v_res := jsonb_build_object('id', r.id, 'status', 'cancelled');
  return app.request_done(p_client_request_id, 'integration_cancel', v_res);
end $$;

-- ─────────── Webhooks (service only) ───────────
-- Record an inbound event. Unsigned events are kept as 'rejected' and never processed; signed ones are recorded once.
create or replace function api.ingest_webhook(p_provider text, p_external_id text, p_signature_ok boolean, p_topic text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id bigint; e ops.webhook_events;
begin
  perform app.require_service();
  if coalesce(length(trim(p_external_id)), 0) = 0 then perform app.raise_rule('webhook.no_id', 'the event has no id to deduplicate on', '22023'); end if;
  if not coalesce(p_signature_ok, false) then
    insert into ops.webhook_events (provider, external_id, topic, signature_ok, payload, payload_hash, status, error, processed_at)
    values (p_provider, left(p_external_id, 200), p_topic, false, '{}'::jsonb, app.payload_hash(p_payload), 'rejected', 'signature check failed', now())
    returning id into v_id;
    return jsonb_build_object('event_id', v_id, 'accepted', false, 'duplicate', false, 'reason', 'bad_signature');
  end if;
  insert into ops.webhook_events (provider, external_id, topic, signature_ok, payload, payload_hash)
  values (p_provider, left(p_external_id, 200), p_topic, true, coalesce(p_payload, '{}'::jsonb), app.payload_hash(p_payload))
  on conflict (provider, external_id) where signature_ok do nothing
  returning id into v_id;
  if v_id is null then
    select * into e from ops.webhook_events where provider = p_provider and external_id = left(p_external_id, 200) and signature_ok;
    return jsonb_build_object('event_id', e.id, 'accepted', false, 'duplicate', true, 'status', e.status);
  end if;
  return jsonb_build_object('event_id', v_id, 'accepted', true, 'duplicate', false);
end $$;

create or replace function api.finish_webhook(p_event_id bigint, p_status text, p_result jsonb, p_error text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_service();
  if p_status not in ('processed', 'failed', 'ignored') then perform app.raise_rule('webhook.status', 'processed, failed or ignored', '22023'); end if;
  update ops.webhook_events set status = p_status, result = p_result, error = left(p_error, 1000), processed_at = now() where id = p_event_id and signature_ok;
  return jsonb_build_object('event_id', p_event_id, 'status', p_status);
end $$;

-- ─────────── E-invoice ───────────
-- Does e-invoicing apply to this document? B2B tax invoice / credit note with GST, from a GSTIN whose switch is on, dated
-- on or after the GSTIN's start date (when one is recorded).
create or replace function app.einvoice_applies(d sales.documents) returns boolean
language sql stable security definer set search_path = '' as $$
  select d.doc_type in ('sales_invoice', 'credit_note') and d.tax_class = 'taxable'
     and exists (select 1 from core.gstins g where g.id = d.gstin_id and g.einvoice_enabled and (g.einvoice_from is null or d.doc_date >= g.einvoice_from))
     and exists (select 1 from master.parties p where p.id = d.party_id and p.gstin is not null and p.gst_status = 'registered')
$$;

-- Posted, e-invoicing applies, and no active IRN yet → the invoice is not final (no print, no WhatsApp, goods do not leave).
create or replace function app.einvoice_pending(p_document_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select d.status = 'posted' and app.einvoice_applies(d)
                          and not exists (select 1 from sales.einvoice_irns i where i.document_id = d.id and i.status = 'active')
                   from sales.documents d where d.id = p_document_id), false)
$$;

-- The IRP request body (INV-01 shape) built from the posted document. Addresses come from the GSTIN's branch and the
-- customer's billing address when recorded; the GSP adapter completes what its API needs.
create or replace function app.einvoice_payload(p_document_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'Version', '1.1',
    'TranDtls', jsonb_build_object('TaxSch', 'GST', 'SupTyp', 'B2B', 'RegRev', 'N', 'IgstOnIntra', 'N'),
    'DocDtls', jsonb_build_object('Typ', case d.doc_type when 'credit_note' then 'CRN' else 'INV' end, 'No', d.doc_no, 'Dt', to_char(d.doc_date, 'DD/MM/YYYY')),
    'SellerDtls', jsonb_build_object('Gstin', g.gstin, 'LglNm', coalesce(g.legal_name, c.legal_name), 'TrdNm', g.trade_name, 'Stcd', g.state_code),
    'BuyerDtls', jsonb_build_object('Gstin', p.gstin, 'LglNm', p.legal_name, 'Pos', d.place_of_supply, 'Stcd', p.state_code,
                                    'Addr1', a.addr ->> 'line1', 'Loc', a.addr ->> 'city', 'Pin', a.addr ->> 'pincode'),
    'ItemList', (select coalesce(jsonb_agg(jsonb_build_object('SlNo', l.line_no::text, 'PrdDesc', l.description, 'IsServc', 'N', 'HsnCd', l.hsn_code,
                   'Qty', l.qty, 'Unit', l.uom, 'UnitPrice', l.rate, 'TotAmt', round(l.qty * l.rate, 2), 'Discount', l.discount, 'AssAmt', l.taxable,
                   'GstRt', l.gst_rate, 'CgstAmt', l.cgst, 'SgstAmt', l.sgst, 'IgstAmt', l.igst, 'TotItemVal', l.total) order by l.line_no), '[]'::jsonb)
                 from sales.document_lines l where l.document_id = d.id),
    'ValDtls', jsonb_build_object('AssVal', d.taxable, 'CgstVal', d.cgst, 'SgstVal', d.sgst, 'IgstVal', d.igst, 'RndOffAmt', d.round_off, 'TotInvVal', d.total),
    'RefDtls', case when d.against_id is not null then jsonb_build_object('PrecDocNo', (select o.doc_no from sales.documents o where o.id = d.against_id)) end)
  from sales.documents d
  join core.gstins g on g.id = d.gstin_id
  join core.companies c on c.id = d.company_id
  join master.parties p on p.id = d.party_id
  left join lateral (select to_jsonb(x) as addr from master.party_addresses x where x.party_id = p.id order by (x.kind = 'billing') desc limit 1) a on true
  where d.id = p_document_id
$$;

create or replace function api.request_einvoice(p_client_request_id uuid, p_document_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; d sales.documents; g core.gstins; r ops.integration_requests; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'request_einvoice'); if v_prev is not null then return v_prev; end if;
  select * into d from sales.documents where id = p_document_id for update;
  if d.id is null then perform app.raise_rule('doc.missing', 'document not found', 'P0002'); end if;
  perform app.require(d.company_id, 'sales_invoices.create');
  select * into g from core.gstins where id = d.gstin_id;
  if not g.einvoice_enabled then perform app.raise_rule('einvoice.switch_off', 'e-invoicing is off for this GSTIN (Admin → Branches & GSTINs, after the CA confirms)', '22023'); end if;
  if d.status <> 'posted' then perform app.raise_rule('einvoice.not_posted', 'post the document first; the IRN is asked for the posted number', '22023'); end if;
  if not app.einvoice_applies(d) then
    perform app.raise_rule('einvoice.not_eligible', 'e-invoicing does not apply to this document (B2B tax invoices and credit notes with GST, on or after the GSTIN''s start date)', '22023');
  end if;
  if exists (select 1 from sales.einvoice_irns where document_id = d.id and status = 'active') then
    perform app.raise_rule('einvoice.already_issued', 'this document already has its IRN', '22023');
  end if;
  r := app.integration_enqueue(d.company_id, app.integration_provider(d.company_id, 'einvoice'), 'einvoice_generate', 'sales.documents', d.id,
                               app.einvoice_payload(d.id), 'einvoice_generate|' || d.id);
  v_res := jsonb_build_object('request_id', r.id, 'status', r.status, 'provider', r.provider);
  return app.request_done(p_client_request_id, 'request_einvoice', v_res);
end $$;

create or replace function api.cancel_einvoice(p_client_request_id uuid, p_document_id uuid, p_reason text, p_remark text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; i sales.einvoice_irns; r ops.integration_requests; v_hours numeric; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'cancel_einvoice'); if v_prev is not null then return v_prev; end if;
  select * into i from sales.einvoice_irns where document_id = p_document_id and status = 'active' for update;
  if i.id is null then perform app.raise_rule('einvoice.no_irn', 'this document has no active IRN', '22023'); end if;
  perform app.require(i.company_id, 'sales_invoices.cancel');
  if p_reason is null or p_reason not in ('duplicate', 'data_entry_mistake', 'order_cancelled', 'other') then
    perform app.raise_rule('einvoice.cancel_reason', 'choose why: duplicate, data entry mistake, order cancelled or other', '22023');
  end if;
  if coalesce(length(trim(p_remark)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'add a short remark', '22023'); end if;
  v_hours := app.integ_setting(i.company_id, 'einvoice.cancel_window_hours');
  if v_hours is null then perform app.raise_rule('einvoice.cancel_window_not_set', 'the IRN cancel window is not set on Settings', '22023'); end if;
  if now() > i.ack_date + make_interval(secs => (v_hours * 3600)::int) then
    perform app.raise_rule('einvoice.cancel_window', 'the IRN is older than ' || v_hours || ' hours and can no longer be cancelled; issue a credit note instead', '22023');
  end if;
  r := app.integration_enqueue(i.company_id, i.provider, 'einvoice_cancel', 'sales.einvoice_irns', i.id,
         jsonb_build_object('Irn', i.irn, 'CnlRsn', case p_reason when 'duplicate' then '1' when 'data_entry_mistake' then '2' when 'order_cancelled' then '3' else '4' end,
                            'CnlRem', left(p_remark, 100), 'reason', p_reason), 'einvoice_cancel|' || i.id);
  v_res := jsonb_build_object('request_id', r.id, 'status', r.status);
  return app.request_done(p_client_request_id, 'cancel_einvoice', v_res);
end $$;

-- Apply a provider result to an e-invoice request (called with the request locked).
create or replace function app.apply_einvoice(p_request_id uuid, p jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare r ops.integration_requests; d sales.documents; i sales.einvoice_irns; v_id uuid;
begin
  select * into r from ops.integration_requests where id = p_request_id for update;
  if r.id is null or r.kind not in ('einvoice_generate', 'einvoice_cancel') then perform app.raise_rule('integrations.missing', 'e-invoice request not found', 'P0002'); end if;
  if r.status = 'done' then return coalesce(r.response, '{}'::jsonb) || jsonb_build_object('duplicate', true); end if;
  if r.status not in ('in_progress', 'queued') then perform app.raise_rule('integrations.state', 'this request is ' || r.status, '22023'); end if;
  if not coalesce((p ->> 'ok')::boolean, false) then
    return app.integration_fail(r.id, coalesce(p ->> 'error', 'provider error'), coalesce((p ->> 'retryable')::boolean, true));
  end if;
  if r.kind = 'einvoice_generate' then
    select * into d from sales.documents where id = r.ref_id for update;
    if exists (select 1 from sales.einvoice_irns where document_id = d.id and status = 'active') then
      perform app.integration_succeed(r.id, p);
      return jsonb_build_object('request_id', r.id, 'status', 'done', 'duplicate', true);
    end if;
    if coalesce(p ->> 'irn', '') !~* '^[0-9a-f]{64}$' or coalesce(length(p ->> 'ack_no'), 0) = 0 or coalesce(length(p ->> 'signed_qr'), 0) = 0 then
      return app.integration_fail(r.id, 'the provider answer has no valid IRN, acknowledgement or signed QR', false);
    end if;
    insert into sales.einvoice_irns (company_id, gstin_id, document_id, irn, ack_no, ack_date, signed_qr, provider, is_mock, request_id)
    values (d.company_id, d.gstin_id, d.id, lower(p ->> 'irn'), p ->> 'ack_no', coalesce(nullif(p ->> 'ack_date', '')::timestamptz, now()), p ->> 'signed_qr',
            r.provider, r.provider = 'mock', r.id)
    returning id into v_id;
    perform set_config('app.allow_posted_update', 'on', true);
    update sales.documents set irn = lower(p ->> 'irn') where id = d.id;
    perform set_config('app.allow_posted_update', 'off', true);
    -- The invoice message waited for the IRN; it may go now.
    update msg.outbox set send_after = now(), skip_reason = null, updated_at = now()
     where doc_type = 'sales.documents' and doc_id = d.id and status = 'queued' and skip_reason = 'waiting for IRN';
    perform app.integration_succeed(r.id, p - 'signed_qr' || jsonb_build_object('irn_id', v_id));
    return jsonb_build_object('request_id', r.id, 'status', 'done', 'irn_id', v_id);
  end if;
  -- einvoice_cancel
  select * into i from sales.einvoice_irns where id = r.ref_id for update;
  if i.status = 'active' then
    update sales.einvoice_irns set status = 'cancelled', cancel_reason = r.payload ->> 'reason', cancel_remark = r.payload ->> 'CnlRem',
           cancelled_at = coalesce(nullif(p ->> 'cancel_date', '')::timestamptz, now()), cancelled_by = r.created_by
     where id = i.id;
  end if;
  perform app.integration_succeed(r.id, p);
  return jsonb_build_object('request_id', r.id, 'status', 'done', 'irn_id', i.id, 'cancelled', true);
end $$;

create or replace function api.apply_einvoice_result(p_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_service();
  return app.apply_einvoice(p_request_id, p);
end $$;

-- Is the document final (printable, sendable, may leave)? Read by the invoice screen before printing.
create or replace function api.document_final_status(p_document_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare d sales.documents; i sales.einvoice_irns; r ops.integration_requests; v_req boolean;
begin
  select * into d from sales.documents where id = p_document_id;
  if d.id is null or not ((app.can(d.company_id, 'sales_invoices.view') or app.can(d.company_id, 'sales.view')) and app.can_see_bill_class(d.tax_class)) then
    return jsonb_build_object('found', false);
  end if;
  v_req := app.einvoice_applies(d);
  select * into i from sales.einvoice_irns where document_id = d.id order by (status = 'active') desc, created_at desc limit 1;
  select * into r from ops.integration_requests where ref_table = 'sales.documents' and ref_id = d.id and kind = 'einvoice_generate' order by created_at desc limit 1;
  return jsonb_build_object('found', true, 'document_id', d.id, 'status', d.status, 'einvoice_required', v_req,
    'final', coalesce(d.status = 'posted' and (not v_req or i.status = 'active'), false),
    'irn', jsonb_strip_nulls(jsonb_build_object('irn', i.irn, 'ack_no', i.ack_no, 'ack_date', i.ack_date, 'signed_qr', i.signed_qr, 'status', i.status,
                                                'is_mock', i.is_mock, 'cancelled_at', i.cancelled_at)),
    'request', case when r.id is null then null else jsonb_build_object('id', r.id, 'status', r.status, 'attempts', r.attempts, 'next_attempt_at', r.next_attempt_at,
                                                                        'last_error', r.last_error) end);
end $$;

-- Before printing or sharing a posted invoice: refused while its IRN is missing (e-invoicing on). Logged.
create or replace function api.check_document_printable(p_document_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb := api.document_final_status(p_document_id);
begin
  if not coalesce((v ->> 'found')::boolean, false) then perform app.raise_rule('doc.missing', 'document not found', 'P0002'); end if;
  if v ->> 'status' = 'posted' and not (v ->> 'final')::boolean then
    perform app.raise_rule('einvoice.irn_required', 'this invoice needs its IRN before it is printed or sent (e-invoicing is on for the GSTIN)', '22023');
  end if;
  perform app.log_event('print', jsonb_build_object('entity', 'sales_document', 'document_id', p_document_id, 'status', v ->> 'status'));
  return v;
end $$;

-- Replaces 20261103002200: a document with an active IRN is cancelled at the IRP first (or a credit note is issued).
create or replace function api.cancel_sales_document(p_client_request_id uuid, p_document_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; d sales.documents; v_rev uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'cancel_sales_document'); if v_prev is not null then return v_prev; end if;
  select * into d from sales.documents where id = p_document_id for update;
  perform app.require(d.company_id, 'sales_invoices.cancel');
  if coalesce(length(trim(p_reason)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'reason required', '22023'); end if;
  if d.status = 'draft' then
    delete from sales.documents where id = d.id;
    v_res := jsonb_build_object('id', d.id, 'deleted_draft', true);
    return app.request_done(p_client_request_id, 'cancel_sales_document', v_res);
  end if;
  if d.status <> 'posted' then perform app.raise_rule('posting.already_reversed', 'already cancelled', '22023'); end if;
  if exists (select 1 from sales.einvoice_irns where document_id = d.id and status = 'active') then
    perform app.raise_rule('einvoice.cancel_irn_first', 'cancel the IRN first (within the IRP window) or issue a credit note', '22023');
  end if;
  if exists (select 1 from acct.bill_allocations a where a.against_kind = 'sales_document' and a.against_id = d.id group by a.against_id having sum(a.amount) <> 0) then
    perform app.raise_rule('doc.has_receipts', 'receipts or credit notes are set against this document; reverse them first', '22023');
  end if;
  if d.voucher_id is not null then v_rev := app.reverse_voucher(d.voucher_id, p_client_request_id, p_reason); end if;
  perform set_config('app.allow_posted_update', 'on', true);
  update sales.documents set status = 'cancelled', notes = coalesce(notes || ' · ', '') || 'Cancelled: ' || p_reason where id = d.id;
  perform set_config('app.allow_posted_update', 'off', true);
  update msg.outbox set status = 'cancelled', skip_reason = 'document cancelled' where doc_type = 'sales.documents' and doc_id = d.id and status = 'queued';
  v_res := jsonb_build_object('id', d.id, 'reversal_voucher_id', v_rev);
  return app.request_done(p_client_request_id, 'cancel_sales_document', v_res);
end $$;

-- The invoice WhatsApp message waits for the IRN when e-invoicing applies (§WA: "after the IRN when e-invoicing applies").
create or replace function app.outbox_wait_for_irn() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.doc_type = 'sales.documents' and new.doc_id is not null and new.status = 'queued' and app.einvoice_pending(new.doc_id) then
    new.send_after := 'infinity';
    new.skip_reason := 'waiting for IRN';
  end if;
  return new;
end $$;
create trigger outbox_wait_for_irn before insert on msg.outbox for each row execute function app.outbox_wait_for_irn();

-- Goods never leave on an invoice that is not final, nor on a cancelled or expired e-way bill (extends start_trip's check).
create or replace function app.dispatch_leave_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'planned' and new.status = 'dispatched' then
    if new.document_id is not null and app.einvoice_pending(new.document_id) then
      perform app.raise_rule('einvoice.irn_required', 'dispatch ' || new.doc_no || ': its invoice has no IRN yet', '22023');
    end if;
    if new.eway_bill_no is not null and exists (select 1 from sales.eway_bills e where e.eway_bill_no = new.eway_bill_no
                                                 and (e.status <> 'active' or (e.valid_until is not null and e.valid_until < now()))) then
      perform app.raise_rule('dispatch.eway_invalid', 'dispatch ' || new.doc_no || ': its e-way bill is cancelled or no longer valid', '22023');
    end if;
  end if;
  return new;
end $$;
create trigger dispatch_leave_guard before update of status on sales.dispatches for each row execute function app.dispatch_leave_guard();

-- ─────────── E-way bill ───────────
create or replace function app.eway_payload(p_dispatch_id uuid, p jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'supplyType', 'O', 'subSupplyType', '1', 'docType', 'INV', 'docNo', d.doc_no, 'docDate', to_char(d.doc_date, 'DD/MM/YYYY'),
    'fromGstin', g.gstin, 'fromStateCode', g.state_code, 'toGstin', coalesce(pt.gstin::text, 'URP'), 'toStateCode', d.place_of_supply,
    'totalValue', d.taxable, 'cgstValue', d.cgst, 'sgstValue', d.sgst, 'igstValue', d.igst, 'totInvValue', d.total,
    'transMode', case coalesce(p ->> 'transport_mode', 'road') when 'rail' then '2' when 'air' then '3' when 'ship' then '4' else '1' end,
    'transDistance', coalesce(nullif(p ->> 'distance_km', ''), '0'), 'vehicleNo', nullif(upper(regexp_replace(coalesce(p ->> 'vehicle_no', ''), '[^A-Za-z0-9]', '', 'g')), ''),
    'transporterId', nullif(p ->> 'transporter_gstin', ''), 'irn', (select i.irn from sales.einvoice_irns i where i.document_id = d.id and i.status = 'active'),
    'itemList', (select coalesce(jsonb_agg(jsonb_build_object('productDesc', l.description, 'hsnCode', l.hsn_code, 'quantity', l.qty, 'qtyUnit', l.uom,
                   'taxableAmount', l.taxable, 'cgstRate', case when l.cgst > 0 then l.gst_rate / 2 else 0 end, 'sgstRate', case when l.sgst > 0 then l.gst_rate / 2 else 0 end,
                   'igstRate', case when l.igst > 0 then l.gst_rate else 0 end) order by l.line_no), '[]'::jsonb) from sales.document_lines l where l.document_id = d.id))
  from sales.dispatches x
  join sales.documents d on d.id = x.document_id
  join core.gstins g on g.id = d.gstin_id
  join master.parties pt on pt.id = d.party_id
  where x.id = p_dispatch_id
$$;

-- p: {vehicle_no, transporter_gstin, distance_km, transport_mode road|rail|air|ship}
create or replace function api.request_eway_bill(p_client_request_id uuid, p_dispatch_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; x sales.dispatches; r ops.integration_requests; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'request_eway_bill'); if v_prev is not null then return v_prev; end if;
  select * into x from sales.dispatches where id = p_dispatch_id for update;
  if x.id is null then perform app.raise_rule('dispatch.missing', 'dispatch not found', 'P0002'); end if;
  perform app.require(x.company_id, 'logistics.edit');
  if x.status <> 'planned' then perform app.raise_rule('dispatch.state', 'this dispatch has already left', '22023'); end if;
  if x.document_id is null then perform app.raise_rule('eway.needs_invoice', 'link or make the invoice first; the e-way bill is made from it', '22023'); end if;
  if app.einvoice_pending(x.document_id) then perform app.raise_rule('einvoice.irn_required', 'the invoice needs its IRN first', '22023'); end if;
  if x.eway_bill_no is not null or exists (select 1 from sales.eway_bills where dispatch_id = x.id and status = 'active') then
    perform app.raise_rule('eway.already', 'this dispatch already has an e-way bill', '22023');
  end if;
  if coalesce(nullif(p ->> 'vehicle_no', ''), nullif(p ->> 'transporter_gstin', '')) is null then
    perform app.raise_rule('eway.vehicle', 'give the vehicle number or the transporter''s GSTIN', '22023');
  end if;
  if nullif(p ->> 'vehicle_no', '') is not null and upper(regexp_replace(p ->> 'vehicle_no', '[^A-Za-z0-9]', '', 'g')) !~ '^[A-Z0-9]{6,12}$' then
    perform app.raise_rule('eway.vehicle_format', 'the vehicle number looks wrong', '22023');
  end if;
  r := app.integration_enqueue(x.company_id, app.integration_provider(x.company_id, 'eway'), 'eway_generate', 'sales.dispatches', x.id,
                               app.eway_payload(x.id, p), 'eway_generate|' || x.id);
  v_res := jsonb_build_object('request_id', r.id, 'status', r.status, 'provider', r.provider);
  return app.request_done(p_client_request_id, 'request_eway_bill', v_res);
end $$;

create or replace function api.update_eway_partb(p_client_request_id uuid, p_eway_bill_id uuid, p_vehicle_no text, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; e sales.eway_bills; r ops.integration_requests; v_veh text := upper(regexp_replace(coalesce(p_vehicle_no, ''), '[^A-Za-z0-9]', '', 'g')); v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'update_eway_partb'); if v_prev is not null then return v_prev; end if;
  select * into e from sales.eway_bills where id = p_eway_bill_id for update;
  if e.id is null or e.status <> 'active' then perform app.raise_rule('eway.missing', 'no active e-way bill', 'P0002'); end if;
  perform app.require(e.company_id, 'logistics.edit');
  if v_veh !~ '^[A-Z0-9]{6,12}$' then perform app.raise_rule('eway.vehicle_format', 'the vehicle number looks wrong', '22023'); end if;
  if coalesce(length(trim(p_reason)), 0) < 3 then perform app.raise_rule('rights.reason_required', 'say why the vehicle changed', '22023'); end if;
  r := app.integration_enqueue(e.company_id, e.provider, 'eway_update_partb', 'sales.eway_bills', e.id,
         jsonb_build_object('ewbNo', e.eway_bill_no, 'vehicleNo', v_veh, 'reason', left(p_reason, 100)), 'eway_partb|' || e.id || '|' || p_client_request_id);
  v_res := jsonb_build_object('request_id', r.id, 'status', r.status);
  return app.request_done(p_client_request_id, 'update_eway_partb', v_res);
end $$;

create or replace function api.cancel_eway_bill(p_client_request_id uuid, p_eway_bill_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; e sales.eway_bills; r ops.integration_requests; v_hours numeric; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'cancel_eway_bill'); if v_prev is not null then return v_prev; end if;
  select * into e from sales.eway_bills where id = p_eway_bill_id for update;
  if e.id is null or e.status <> 'active' then perform app.raise_rule('eway.missing', 'no active e-way bill', 'P0002'); end if;
  perform app.require(e.company_id, 'logistics.edit');
  if exists (select 1 from sales.dispatches x where x.id = e.dispatch_id and x.status <> 'planned') then
    perform app.raise_rule('eway.goods_moved', 'the goods have left; an e-way bill of goods in transit is not cancelled', '22023');
  end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then perform app.raise_rule('rights.reason_required', 'say why', '22023'); end if;
  v_hours := app.integ_setting(e.company_id, 'eway.cancel_window_hours');
  if v_hours is null then perform app.raise_rule('eway.cancel_window_not_set', 'the e-way bill cancel window is not set on Settings (the CA confirms it)', '22023'); end if;
  if now() > e.generated_at + make_interval(secs => (v_hours * 3600)::int) then
    perform app.raise_rule('eway.cancel_window', 'the e-way bill is older than ' || v_hours || ' hours and can no longer be cancelled', '22023');
  end if;
  r := app.integration_enqueue(e.company_id, e.provider, 'eway_cancel', 'sales.eway_bills', e.id,
         jsonb_build_object('ewbNo', e.eway_bill_no, 'cancelRmrk', left(p_reason, 100)), 'eway_cancel|' || e.id);
  v_res := jsonb_build_object('request_id', r.id, 'status', r.status);
  return app.request_done(p_client_request_id, 'cancel_eway_bill', v_res);
end $$;

create or replace function app.apply_eway(p_request_id uuid, p jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare r ops.integration_requests; x sales.dispatches; e sales.eway_bills; v_id uuid;
begin
  select * into r from ops.integration_requests where id = p_request_id for update;
  if r.id is null or r.kind not in ('eway_generate', 'eway_update_partb', 'eway_cancel') then perform app.raise_rule('integrations.missing', 'e-way request not found', 'P0002'); end if;
  if r.status = 'done' then return coalesce(r.response, '{}'::jsonb) || jsonb_build_object('duplicate', true); end if;
  if r.status not in ('in_progress', 'queued') then perform app.raise_rule('integrations.state', 'this request is ' || r.status, '22023'); end if;
  if not coalesce((p ->> 'ok')::boolean, false) then
    return app.integration_fail(r.id, coalesce(p ->> 'error', 'provider error'), coalesce((p ->> 'retryable')::boolean, true));
  end if;
  if r.kind = 'eway_generate' then
    select * into x from sales.dispatches where id = r.ref_id for update;
    if coalesce(p ->> 'eway_bill_no', '') !~ '^[0-9]{12}$' then
      return app.integration_fail(r.id, 'the provider answer has no valid 12-digit e-way bill number', false);
    end if;
    insert into sales.eway_bills (company_id, dispatch_id, document_id, eway_bill_no, generated_at, valid_until, vehicle_no, transporter_gstin, distance_km,
                                  transport_mode, provider, is_mock, request_id)
    values (x.company_id, x.id, x.document_id, p ->> 'eway_bill_no', coalesce(nullif(p ->> 'generated_at', '')::timestamptz, now()), nullif(p ->> 'valid_until', '')::timestamptz,
            r.payload ->> 'vehicleNo', r.payload ->> 'transporterId', nullif(r.payload ->> 'transDistance', '')::int,
            case r.payload ->> 'transMode' when '2' then 'rail' when '3' then 'air' when '4' then 'ship' else 'road' end, r.provider, r.provider = 'mock', r.id)
    returning id into v_id;
    if x.status = 'planned' and x.eway_bill_no is null then update sales.dispatches set eway_bill_no = p ->> 'eway_bill_no' where id = x.id; end if;
    perform app.integration_succeed(r.id, p || jsonb_build_object('eway_bill_id', v_id));
    return jsonb_build_object('request_id', r.id, 'status', 'done', 'eway_bill_id', v_id);
  end if;
  select * into e from sales.eway_bills where id = r.ref_id for update;
  if r.kind = 'eway_update_partb' then
    insert into sales.eway_partb_updates (eway_bill_id, vehicle_no, reason, valid_until, request_id, updated_by)
    values (e.id, r.payload ->> 'vehicleNo', r.payload ->> 'reason', nullif(p ->> 'valid_until', '')::timestamptz, r.id, r.created_by);
    update sales.eway_bills set vehicle_no = r.payload ->> 'vehicleNo', valid_until = coalesce(nullif(p ->> 'valid_until', '')::timestamptz, valid_until) where id = e.id;
  else
    update sales.eway_bills set status = 'cancelled', cancel_reason = r.payload ->> 'cancelRmrk', cancelled_at = now(), cancelled_by = r.created_by where id = e.id and status = 'active';
    update sales.dispatches set eway_bill_no = null where id = e.dispatch_id and status = 'planned' and eway_bill_no = e.eway_bill_no;
  end if;
  perform app.integration_succeed(r.id, p);
  return jsonb_build_object('request_id', r.id, 'status', 'done', 'eway_bill_id', e.id);
end $$;

create or replace function api.apply_eway_result(p_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_service();
  return app.apply_eway(p_request_id, p);
end $$;

-- ─────────── Mock provider (DEV and tests only; the request's provider must be 'mock' and mock must be allowed) ───────────
-- base64url without padding
create or replace function app.b64url(p text) returns text
language sql immutable set search_path = '' as $$
  select replace(translate(encode(convert_to(p, 'UTF8'), 'base64'), E'+/\n', '-_'), '=', '')
$$;

create or replace function app.mock_provider_response(r ops.integration_requests) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_irn text; d sales.documents; g core.gstins; pt master.parties; v_qr jsonb; v_hsn text; v_fy text;
begin
  if r.kind = 'einvoice_generate' then
    select * into d from sales.documents where id = r.ref_id;
    select * into g from core.gstins where id = d.gstin_id;
    select * into pt from master.parties where id = d.party_id;
    select f.label into v_fy from core.financial_years f where f.company_id = d.company_id and d.doc_date between f.starts_on and f.ends_on limit 1;
    -- Same construction as the IRP: SHA-256 of supplier GSTIN, FY, document type and number.
    v_irn := encode(extensions.digest(convert_to(g.gstin || coalesce(v_fy, '') || (r.payload #>> '{DocDtls,Typ}') || d.doc_no, 'UTF8'), 'sha256'), 'hex');
    select l.hsn_code into v_hsn from sales.document_lines l where l.document_id = d.id order by l.taxable desc limit 1;
    v_qr := jsonb_build_object('SellerGstin', g.gstin, 'BuyerGstin', pt.gstin, 'DocNo', d.doc_no, 'DocTyp', r.payload #>> '{DocDtls,Typ}',
                               'DocDt', to_char(d.doc_date, 'DD/MM/YYYY'), 'TotInvVal', d.total, 'ItemCnt', (select count(*) from sales.document_lines where document_id = d.id),
                               'MainHsnCode', v_hsn, 'Irn', v_irn, 'IrnDt', to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS'));
    return jsonb_build_object('ok', true, 'irn', v_irn, 'ack_no', '1' || lpad((abs(hashtext(v_irn)::bigint) * 7919 % 100000000000000)::text, 14, '0'),
      'ack_date', now(), 'signed_qr', app.b64url('{"alg":"none","typ":"JWT"}') || '.' || app.b64url(jsonb_build_object('data', v_qr::text, 'iss', 'MOCK')::text) || '.MOCK');
  elsif r.kind = 'eway_generate' then
    return jsonb_build_object('ok', true, 'eway_bill_no', '1' || lpad((abs(hashtext(r.id::text)::bigint) * 104729 % 100000000000)::text, 11, '0'),
                              'generated_at', now(), 'valid_until', (date_trunc('day', now() at time zone 'Asia/Kolkata') + interval '1 day 23 hours 59 minutes') at time zone 'Asia/Kolkata');
  elsif r.kind = 'eway_update_partb' then
    return jsonb_build_object('ok', true, 'valid_until', (date_trunc('day', now() at time zone 'Asia/Kolkata') + interval '1 day 23 hours 59 minutes') at time zone 'Asia/Kolkata');
  end if;
  return jsonb_build_object('ok', true, 'mock', true);
end $$;

-- p: {fail: bool, error, retryable}
create or replace function api.run_mock_integration(p_client_request_id uuid, p_request_id uuid, p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; r ops.integration_requests; v_resp jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'run_mock_integration'); if v_prev is not null then return v_prev; end if;
  if not (app.is_admin() or app.is_service()) then perform app.raise_rule('rights.missing', 'only Admin runs the mock provider', '42501'); end if;
  select * into r from ops.integration_requests where id = p_request_id for update;
  if r.id is null then perform app.raise_rule('integrations.missing', 'request not found', 'P0002'); end if;
  if r.provider <> 'mock' or coalesce((app.setting(r.company_id, 'integrations.allow_mock') #>> '{}')::boolean, false) is not true then
    perform app.raise_rule('integrations.mock_not_allowed', 'only requests for the mock provider, on the development database', '42501');
  end if;
  if r.status = 'queued' then r := app.integration_begin(r.id); end if;
  v_resp := case when coalesce((p ->> 'fail')::boolean, false)
                 then jsonb_build_object('ok', false, 'error', coalesce(p ->> 'error', 'mock provider failure'), 'retryable', coalesce((p ->> 'retryable')::boolean, true))
                 else app.mock_provider_response(r) end;
  if r.kind like 'einvoice_%' then v_res := app.apply_einvoice(r.id, v_resp);
  elsif r.kind like 'eway_%' then v_res := app.apply_eway(r.id, v_resp);
  elsif (v_resp ->> 'ok')::boolean then perform app.integration_succeed(r.id, v_resp); v_res := jsonb_build_object('id', r.id, 'status', 'done');
  else v_res := app.integration_fail(r.id, v_resp ->> 'error', (v_resp ->> 'retryable')::boolean); end if;
  return app.request_done(p_client_request_id, 'run_mock_integration', v_res);
end $$;

-- Admin: e-invoice switch per GSTIN with its start date (Q-21). Logged; the CA's note is required to switch it on.
create or replace function api.set_einvoice_switch(p_client_request_id uuid, p_gstin_id uuid, p_enabled boolean, p_from date, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; g core.gstins; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_einvoice_switch'); if v_prev is not null then return v_prev; end if;
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'only Admin switches e-invoicing', '42501'); end if;
  select * into g from core.gstins where id = p_gstin_id for update;
  if g.id is null then perform app.raise_rule('org.gstin_missing', 'GSTIN not found', 'P0002'); end if;
  if coalesce(p_enabled, false) and coalesce(length(trim(p_note)), 0) < 5 then
    perform app.raise_rule('einvoice.ca_note', 'record the CA''s confirmation (turnover threshold and start date) in the note', '22023');
  end if;
  update core.gstins set einvoice_enabled = coalesce(p_enabled, false), einvoice_from = p_from where id = g.id;
  perform app.log_event('admin_action', jsonb_build_object('entity', 'einvoice_switch', 'gstin_id', g.id, 'enabled', p_enabled, 'from', p_from, 'note', p_note));
  v_res := jsonb_build_object('gstin_id', g.id, 'einvoice_enabled', coalesce(p_enabled, false), 'einvoice_from', p_from);
  return app.request_done(p_client_request_id, 'set_einvoice_switch', v_res);
end $$;

-- ─────────── Online stores ───────────
-- A verified store webhook stages the order (normalised by the Edge Function adapter); a person with sales rights brings
-- staged orders in through the Phase 6 ingest_online_order (rights, prices and GST checked there). Owner decision Q-P8-6.
-- p_detail: {external_order_id, order_date, ship_state, lines: [{sku, qty, price_incl_tax}]}
create or replace function api.stage_channel_event(p_event_id bigint, p_channel_id uuid, p_kind text, p_external_id text, p_detail jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ch sales.online_channels; v_id uuid;
begin
  perform app.require_service();
  select * into ch from sales.online_channels where id = p_channel_id;
  if ch.id is null then perform app.raise_rule('listing.channel', 'channel not found', 'P0002'); end if;
  insert into sales.channel_sync_log (company_id, channel_id, direction, kind, external_id, status, detail, webhook_event_id)
  values (ch.company_id, ch.id, 'inbound', p_kind, left(p_external_id, 200), case when p_kind = 'order' then 'staged' else 'skipped' end, coalesce(p_detail, '{}'::jsonb), p_event_id)
  on conflict (channel_id, kind, external_id) where direction = 'inbound' do nothing
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'duplicate', v_id is null);
end $$;

create or replace function api.ingest_staged_channel_orders(p_client_request_id uuid, p_channel_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; ch sales.online_channels; s record; v_r jsonb; n_ok int := 0; n_fail int := 0; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'ingest_staged_channel_orders'); if v_prev is not null then return v_prev; end if;
  select * into ch from sales.online_channels where id = p_channel_id;
  if ch.id is null then perform app.raise_rule('listing.channel', 'channel not found', 'P0002'); end if;
  perform app.require(ch.company_id, 'sales.create');
  for s in select * from sales.channel_sync_log where channel_id = ch.id and direction = 'inbound' and kind = 'order' and status in ('staged', 'failed')
           order by created_at limit 200 for update skip locked loop
    begin
      v_r := api.ingest_online_order(app.child_crid(p_client_request_id, s.id::text), s.detail || jsonb_build_object('channel_id', ch.id, 'external_order_id', s.external_id));
      update sales.channel_sync_log set status = 'ingested', online_order_id = (v_r ->> 'online_order_id')::uuid, error = null, processed_by = auth.uid(), processed_at = now()
       where id = s.id;
      n_ok := n_ok + 1;
    exception when others then
      update sales.channel_sync_log set status = 'failed', error = left(sqlerrm, 500), processed_by = auth.uid(), processed_at = now() where id = s.id;
      n_fail := n_fail + 1;
    end;
  end loop;
  v_res := jsonb_build_object('channel_id', ch.id, 'ingested', n_ok, 'failed', n_fail);
  return app.request_done(p_client_request_id, 'ingest_staged_channel_orders', v_res);
end $$;

-- Marketplace settlement as reported by the operator. p: {channel_id, settlement_ref, period_from, period_to, payout_date, gross_sales,
-- returns_value, net_taxable, tcs_cgst, tcs_sgst, tcs_igst, tds_amount, commission, other_fees, net_payout, bank_line_id, note}
-- or {reverses_id, note} to reverse a wrong one (append-only).
create or replace function api.record_marketplace_settlement(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; ch sales.online_channels; o sales.marketplace_settlements; v_id uuid; v_res jsonb; k text;
begin
  v_prev := app.request_seen(p_client_request_id, 'record_marketplace_settlement'); if v_prev is not null then return v_prev; end if;
  if nullif(p ->> 'reverses_id', '') is not null then
    select * into o from sales.marketplace_settlements where id = (p ->> 'reverses_id')::uuid;
    if o.id is null or o.reverses_id is not null then perform app.raise_rule('settlement.missing', 'settlement to reverse not found', 'P0002'); end if;
    perform app.require(o.company_id, 'receipts_payments.create');
    if exists (select 1 from sales.marketplace_settlements where reverses_id = o.id) then perform app.raise_rule('settlement.already_reversed', 'already reversed', '22023'); end if;
    if coalesce(length(trim(p ->> 'note')), 0) < 5 then perform app.raise_rule('rights.reason_required', 'say why it is reversed', '22023'); end if;
    insert into sales.marketplace_settlements (company_id, channel_id, settlement_ref, period_from, period_to, payout_date, gross_sales, returns_value, net_taxable,
      tcs_cgst, tcs_sgst, tcs_igst, tds_amount, commission, other_fees, net_payout, reverses_id, source, note, recorded_by)
    values (o.company_id, o.channel_id, o.settlement_ref || '-REV', o.period_from, o.period_to, o.payout_date, -o.gross_sales, -o.returns_value, -o.net_taxable,
      -o.tcs_cgst, -o.tcs_sgst, -o.tcs_igst, -o.tds_amount, -o.commission, -o.other_fees, -o.net_payout, o.id, 'manual', p ->> 'note', auth.uid())
    returning id into v_id;
  else
    select * into ch from sales.online_channels where id = (p ->> 'channel_id')::uuid;
    if ch.id is null then perform app.raise_rule('listing.channel', 'choose the channel', '22023'); end if;
    perform app.require(ch.company_id, 'receipts_payments.create');
    if coalesce(length(trim(p ->> 'settlement_ref')), 0) = 0 then perform app.raise_rule('settlement.ref', 'give the operator''s settlement reference', '22023'); end if;
    if nullif(p ->> 'period_from', '') is null or nullif(p ->> 'period_to', '') is null or (p ->> 'period_to')::date < (p ->> 'period_from')::date then
      perform app.raise_rule('settlement.period', 'give the settlement period', '22023');
    end if;
    foreach k in array array['tcs_cgst', 'tcs_sgst', 'tcs_igst', 'tds_amount', 'commission', 'other_fees'] loop
      if coalesce(nullif(p ->> k, '')::numeric, 0) < 0 then perform app.raise_rule('settlement.negative', k || ' cannot be negative (reverse the settlement instead)', '22023'); end if;
    end loop;
    if nullif(p ->> 'net_payout', '') is null then perform app.raise_rule('settlement.payout', 'give the net payout', '22023'); end if;
    if exists (select 1 from sales.marketplace_settlements where channel_id = ch.id and settlement_ref = trim(p ->> 'settlement_ref')) then
      perform app.raise_rule('settlement.duplicate', 'this settlement is already recorded', '22023');
    end if;
    if nullif(p ->> 'bank_line_id', '') is not null and not exists (select 1 from acct.bank_statement_lines where id = (p ->> 'bank_line_id')::uuid and company_id = ch.company_id) then
      perform app.raise_rule('settlement.bank_line', 'bank line of another company', '22023');
    end if;
    insert into sales.marketplace_settlements (company_id, channel_id, settlement_ref, period_from, period_to, payout_date, gross_sales, returns_value, net_taxable,
      tcs_cgst, tcs_sgst, tcs_igst, tds_amount, commission, other_fees, net_payout, bank_line_id, source, note, recorded_by)
    values (ch.company_id, ch.id, trim(p ->> 'settlement_ref'), (p ->> 'period_from')::date, (p ->> 'period_to')::date, nullif(p ->> 'payout_date', '')::date,
      coalesce(nullif(p ->> 'gross_sales', '')::numeric, 0), coalesce(nullif(p ->> 'returns_value', '')::numeric, 0), coalesce(nullif(p ->> 'net_taxable', '')::numeric, 0),
      coalesce(nullif(p ->> 'tcs_cgst', '')::numeric, 0), coalesce(nullif(p ->> 'tcs_sgst', '')::numeric, 0), coalesce(nullif(p ->> 'tcs_igst', '')::numeric, 0),
      coalesce(nullif(p ->> 'tds_amount', '')::numeric, 0), coalesce(nullif(p ->> 'commission', '')::numeric, 0), coalesce(nullif(p ->> 'other_fees', '')::numeric, 0),
      (p ->> 'net_payout')::numeric, nullif(p ->> 'bank_line_id', '')::uuid, coalesce(nullif(p ->> 'source', ''), 'manual'), nullif(p ->> 'note', ''), auth.uid())
    returning id into v_id;
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'record_marketplace_settlement', v_res);
end $$;

-- ─────────── Bank feeds ───────────
-- p: {account_id, provider, external_ref, status}
create or replace function api.upsert_bank_feed(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid; v_id uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_bank_feed'); if v_prev is not null then return v_prev; end if;
  select company_id into v_company from acct.bank_accounts where account_id = (p ->> 'account_id')::uuid;
  if v_company is null then perform app.raise_rule('money.account', 'choose a bank account', '22023'); end if;
  perform app.require(v_company, 'settings.manage');
  if coalesce(p ->> 'provider', '') !~ '^[a-z0-9_]+$' then perform app.raise_rule('bank_feed.provider', 'choose the feed provider', '22023'); end if;
  if coalesce(p ->> 'external_ref', '') ~ '[0-9]{9,}' then
    perform app.raise_rule('bank_feed.no_account_number', 'store only the provider''s link id, never the account number', '22023');
  end if;
  insert into acct.bank_feeds (company_id, account_id, provider, external_ref, status, created_by)
  values (v_company, (p ->> 'account_id')::uuid, p ->> 'provider', nullif(p ->> 'external_ref', ''), coalesce(nullif(p ->> 'status', ''), 'not_connected'), auth.uid())
  on conflict (account_id, provider) do update set external_ref = excluded.external_ref, status = excluded.status
  returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_bank_feed', v_res);
end $$;

create or replace function api.request_bank_feed_sync(p_client_request_id uuid, p_feed_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; f acct.bank_feeds; r ops.integration_requests; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'request_bank_feed_sync'); if v_prev is not null then return v_prev; end if;
  select * into f from acct.bank_feeds where id = p_feed_id;
  if f.id is null then perform app.raise_rule('bank_feed.missing', 'feed not found', 'P0002'); end if;
  perform app.require(f.company_id, 'receipts_payments.create');
  if f.status <> 'active' then perform app.raise_rule('bank_feed.not_active', 'connect the feed first', '22023'); end if;
  r := app.integration_enqueue(f.company_id, f.provider, 'bank_feed_sync', 'acct.bank_feeds', f.id,
         jsonb_build_object('feed_id', f.id, 'external_ref', f.external_ref, 'cursor', f.last_cursor), 'bank_feed_sync|' || f.id || '|' || p_client_request_id);
  v_res := jsonb_build_object('request_id', r.id, 'status', r.status);
  return app.request_done(p_client_request_id, 'request_bank_feed_sync', v_res);
end $$;

-- Service: statement lines fetched by the bank-feed function (same dedupe hash as api.import_bank_lines).
create or replace function api.bank_feed_import(p_request_id uuid, p_feed_id uuid, p_lines jsonb, p_cursor text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare f acct.bank_feeds; v_new int; v_res jsonb;
begin
  perform app.require_service();
  select * into f from acct.bank_feeds where id = p_feed_id for update;
  if f.id is null then perform app.raise_rule('bank_feed.missing', 'feed not found', 'P0002'); end if;
  insert into acct.bank_statement_lines (company_id, account_id, txn_date, description, ref, amount, balance, line_hash, import_ref)
  select f.company_id, f.account_id, (e ->> 'date')::date, e ->> 'description', e ->> 'ref', (e ->> 'amount')::numeric, nullif(e ->> 'balance', '')::numeric,
         md5(concat_ws('|', e ->> 'date', e ->> 'description', e ->> 'ref', e ->> 'amount', e ->> 'balance')), 'feed:' || f.provider || ':' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD')
  from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) e
  on conflict (account_id, line_hash) do nothing;
  get diagnostics v_new = row_count;
  v_res := jsonb_build_object('added', v_new, 'skipped', jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) - v_new);
  update acct.bank_feeds set last_sync_at = now(), last_cursor = coalesce(p_cursor, last_cursor), last_result = v_res, last_error = null where id = f.id;
  if p_request_id is not null and exists (select 1 from ops.integration_requests where id = p_request_id and status in ('in_progress', 'queued')) then
    perform app.integration_succeed(p_request_id, v_res);
  end if;
  return v_res;
end $$;

-- ─────────── GPS provider intake (service): points only inside the user's open duty session ───────────
-- p_points: [{at, lat, lng, accuracy_m}]
create or replace function api.gps_ingest(p_provider text, p_device_ref text, p_points jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare dv ops.gps_devices; s field.duty_sessions; v_total int := jsonb_array_length(coalesce(p_points, '[]'::jsonb)); v_new int;
begin
  perform app.require_service();
  select * into dv from ops.gps_devices where provider = p_provider and device_ref = p_device_ref and active;
  if dv.id is null then return jsonb_build_object('accepted', 0, 'rejected', v_total, 'reason', 'unknown_device'); end if;
  select * into s from field.duty_sessions where user_id = dv.user_id and ended_at is null;
  if s.id is null then return jsonb_build_object('accepted', 0, 'rejected', v_total, 'reason', 'off_duty'); end if;
  insert into field.gps_points (company_id, user_id, session_id, at, lat, lng, accuracy_m, source)
  select s.company_id, dv.user_id, s.id, (e ->> 'at')::timestamptz, (e ->> 'lat')::numeric, (e ->> 'lng')::numeric, nullif(e ->> 'accuracy_m', '')::numeric, 'ping'
  from jsonb_array_elements(coalesce(p_points, '[]'::jsonb)) e
  where (e ->> 'at')::timestamptz between s.started_at and now() + interval '5 minutes'
    and (e ->> 'lat')::numeric between -90 and 90 and (e ->> 'lng')::numeric between -180 and 180;
  get diagnostics v_new = row_count;
  return jsonb_build_object('accepted', v_new, 'rejected', v_total - v_new, 'reason', case when v_new < v_total then 'outside_duty' end);
end $$;

create or replace function api.upsert_gps_device(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_id uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_gps_device'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'logistics.edit');
  if coalesce(p ->> 'provider', '') !~ '^[a-z0-9_]+$' or coalesce(length(trim(p ->> 'device_ref')), 0) = 0 then
    perform app.raise_rule('gps.device', 'give the provider and the device id', '22023');
  end if;
  if not exists (select 1 from core.user_roles r where r.user_id = (p ->> 'user_id')::uuid and (r.company_id = v_company or r.company_id is null)) then
    perform app.raise_rule('gps.user', 'the device must belong to a person of this company', '22023');
  end if;
  insert into ops.gps_devices (company_id, provider, device_ref, user_id, vehicle_id, active, created_by)
  values (v_company, p ->> 'provider', trim(p ->> 'device_ref'), (p ->> 'user_id')::uuid, nullif(p ->> 'vehicle_id', '')::uuid, coalesce((p ->> 'active')::boolean, true), auth.uid())
  on conflict (provider, device_ref) do update set user_id = excluded.user_id, vehicle_id = excluded.vehicle_id, active = excluded.active
  returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_gps_device', v_res);
end $$;

-- ─────────── Help on WhatsApp for verified staff (§HELP-8): no data tools ───────────
-- Mask numbers that could be Aadhaar, phone or bank account numbers (defence in depth; the Edge Function redacts first).
create or replace function app.help_redact(p text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(regexp_replace(coalesce(p, ''), '(\+?91[ -]?)?[6-9][0-9]{9}', '[phone]', 'g'), '[0-9](?:[ -]?[0-9]){8,}', '[number]', 'g')
$$;

create or replace function app.help_wa_staff(p_number text) returns help.whatsapp_staff
language sql stable security definer set search_path = '' as $$
  select w.* from help.whatsapp_staff w join master.people pe on pe.id = w.person_id
  where w.number = p_number and w.revoked_at is null and pe.status = 'active' and pe.user_id = w.user_id
$$;

-- Admin verifies a staff member's own number (must be the number on the staff record) with their consent.
-- p: {person_id, number, language, consent}
create or replace function api.verify_help_whatsapp_staff(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; pe master.people; v_id uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'verify_help_whatsapp_staff'); if v_prev is not null then return v_prev; end if;
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'only Admin verifies staff numbers', '42501'); end if;
  select * into pe from master.people where id = (p ->> 'person_id')::uuid;
  if pe.id is null or pe.status <> 'active' then perform app.raise_rule('help_wa.person', 'choose an active staff member', '22023'); end if;
  if pe.user_id is null then perform app.raise_rule('help_wa.no_sign_in', 'the staff member needs their own sign-in first', '22023'); end if;
  if pe.user_id = auth.uid() then perform app.raise_rule('sod.own_request', 'another Admin verifies your own number', '42501'); end if;
  if pe.phone is null or pe.phone <> p ->> 'number' then perform app.raise_rule('help_wa.number_mismatch', 'the number must be the one on the staff record', '22023'); end if;
  if not coalesce((p ->> 'consent')::boolean, false) then perform app.raise_rule('help_wa.consent', 'the staff member must agree to use Help on WhatsApp', '22023'); end if;
  update help.whatsapp_staff set revoked_at = now(), revoked_by = auth.uid() where person_id = pe.id and revoked_at is null;
  insert into help.whatsapp_staff (person_id, user_id, number, language, consent_at, verified_by)
  values (pe.id, pe.user_id, pe.phone, coalesce(nullif(p ->> 'language', ''), 'en'), now(), auth.uid()) returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'verify_help_whatsapp_staff', v_res);
end $$;

create or replace function api.revoke_help_whatsapp_staff(p_client_request_id uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'revoke_help_whatsapp_staff'); if v_prev is not null then return v_prev; end if;
  if not (app.is_admin() or exists (select 1 from help.whatsapp_staff where id = p_id and user_id = auth.uid())) then
    perform app.raise_rule('rights.missing', 'Admin or the staff member', '42501');
  end if;
  update help.whatsapp_staff set revoked_at = now(), revoked_by = auth.uid() where id = p_id and revoked_at is null;
  v_res := jsonb_build_object('id', p_id);
  return app.request_done(p_client_request_id, 'revoke_help_whatsapp_staff', v_res);
end $$;

-- Service: an inbound WhatsApp message to the help number. Unverified numbers get nothing (no AI, nothing stored).
create or replace function api.help_whatsapp_inbound(p_event_id bigint, p_from text, p_kind text, p_text text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s help.whatsapp_staff;
begin
  perform app.require_service();
  s := app.help_wa_staff(p_from);
  if s.id is null then return jsonb_build_object('allowed', false, 'reason', 'unverified'); end if;
  insert into help.whatsapp_messages (staff_id, direction, kind, body, webhook_event_id)
  values (s.id, 'in', case when p_kind = 'voice' then 'voice' else 'text' end, left(app.help_redact(p_text), 2000), p_event_id);
  return jsonb_build_object('allowed', true, 'staff_id', s.id, 'language', s.language,
                            'tools', jsonb_build_array('search_help', 'help_page', 'explain_error', 'create_problem_report', 'ticket_status', 'handoff'));
end $$;

-- Service: the only tools the WhatsApp assistant may call. No stock, documents, rights or requests (no data tools).
create or replace function api.help_wa_tool(p_number text, p_tool text, p_args jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s help.whatsapp_staff; v jsonb; v_id uuid; v_code text; e ops.error_log;
begin
  perform app.require_service();
  s := app.help_wa_staff(p_number);
  if s.id is null then perform app.raise_rule('help_wa.unverified', 'this number is not a verified staff number', '42501'); end if;
  if p_tool is null or p_tool not in ('search_help', 'help_page', 'explain_error', 'create_problem_report', 'ticket_status', 'handoff') then
    perform app.raise_rule('help_wa.tool_not_allowed', 'Help on WhatsApp answers how-to questions, files problems and checks tickets only', '42501');
  end if;
  if p_tool = 'search_help' then
    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v from api.search_help(left(p_args ->> 'query', 200), null, s.language) x;
  elsif p_tool = 'help_page' then
    v := api.help_page(p_args ->> 'slug', s.language);
  elsif p_tool = 'explain_error' then
    select * into e from ops.error_log where ref = upper(trim(p_args ->> 'ref')) and user_id = s.user_id;
    v := case when e.ref is null then jsonb_build_object('found', false)
              else jsonb_build_object('found', true, 'ref', e.ref, 'at', e.at, 'rule_code', e.rule_code, 'message', e.message,
                                      'page', (select jsonb_build_object('slug', slug, 'title', title) from help.pages where rule_code = e.rule_code and language = 'en' limit 1)) end;
  elsif p_tool in ('create_problem_report', 'handoff') then
    if coalesce(length(trim(p_args ->> 'what_happened')), 0) < 5 then perform app.raise_rule('help.describe', 'say in a few words what happened', '22023'); end if;
    insert into help.problem_reports (user_id, screen, error_ref, what_happened)
    values (s.user_id, case when p_tool = 'handoff' then 'whatsapp:handoff' else 'whatsapp' end, nullif(upper(p_args ->> 'error_ref'), ''),
            left(app.help_redact(p_args ->> 'what_happened'), 2000))
    returning id, code into v_id, v_code;
    v := jsonb_build_object('id', v_id, 'code', v_code);
  else
    select coalesce(jsonb_agg(jsonb_build_object('code', code, 'status', status, 'reply', reply, 'created_at', created_at) order by created_at desc), '[]'::jsonb) into v
    from (select * from help.problem_reports where user_id = s.user_id order by created_at desc limit 5) t;
  end if;
  insert into help.whatsapp_messages (staff_id, direction, tool, body) values (s.id, 'out', p_tool, null);
  return v;
end $$;

create or replace function api.help_wa_log_reply(p_number text, p_text text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s help.whatsapp_staff;
begin
  perform app.require_service();
  s := app.help_wa_staff(p_number);
  if s.id is null then perform app.raise_rule('help_wa.unverified', 'this number is not a verified staff number', '42501'); end if;
  insert into help.whatsapp_messages (staff_id, direction, body) values (s.id, 'out', left(app.help_redact(p_text), 2000));
  return jsonb_build_object('ok', true);
end $$;

-- ─────────── Sweep (pg_cron every 5 minutes) ───────────
-- Requests whose worker never reported back count as a failed attempt; webhook payloads lose personal data after 90 days;
-- help WhatsApp lines are kept 12 months.
create or replace function app.integration_sweep() returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare r record; n_stale int := 0; n_purged int; n_help int;
begin
  for r in select id from ops.integration_requests where status = 'in_progress' and locked_at < now() - interval '10 minutes' for update skip locked loop
    perform app.integration_fail(r.id, 'the worker did not report back within 10 minutes', true);
    n_stale := n_stale + 1;
  end loop;
  update ops.webhook_events set payload = '{}'::jsonb where received_at < now() - interval '90 days' and payload <> '{}'::jsonb;
  get diagnostics n_purged = row_count;
  delete from help.whatsapp_messages where created_at < now() - interval '12 months';
  get diagnostics n_help = row_count;
  return jsonb_build_object('stale', n_stale, 'webhook_payloads_cleared', n_purged, 'help_lines_deleted', n_help);
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.schedule('integration-sweep', '*/5 * * * *', 'select app.integration_sweep()');
    exception when others then
      raise notice 'could not schedule the integration sweep: %', sqlerrm;
    end;
  end if;
end $$;

-- ─────────── Grants ───────────
revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;
revoke all on all functions in schema api from public, anon;
grant execute on all functions in schema api to authenticated;
-- Service-only RPCs: not callable by signed-in users at all (and they check app.require_service() inside as well).
do $$
declare f text;
begin
  foreach f in array array[
    'api.integration_claim_due(int, text[])', 'api.integration_report(uuid, boolean, jsonb, text, boolean)', 'api.ingest_webhook(text, text, boolean, text, jsonb)',
    'api.finish_webhook(bigint, text, jsonb, text)', 'api.apply_einvoice_result(uuid, jsonb)', 'api.apply_eway_result(uuid, jsonb)',
    'api.stage_channel_event(bigint, uuid, text, text, jsonb)', 'api.bank_feed_import(uuid, uuid, jsonb, text)', 'api.gps_ingest(text, text, jsonb)',
    'api.help_whatsapp_inbound(bigint, text, text, text)', 'api.help_wa_tool(text, text, jsonb)', 'api.help_wa_log_reply(text, text)'] loop
    execute format('revoke execute on function %s from authenticated, public, anon', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array['app.integration_sweep()', 'app.integration_fail(uuid, text, boolean)', 'app.integration_succeed(uuid, jsonb)',
                           'app.integration_begin(uuid)', 'app.apply_einvoice(uuid, jsonb)', 'app.apply_eway(uuid, jsonb)',
                           'app.integration_enqueue(uuid, text, text, text, uuid, jsonb, text)'] loop
    execute format('revoke execute on function %s from authenticated, public, anon', f);
  end loop;
end $$;

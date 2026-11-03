-- 20261103002100_msg_help.sql
-- Phase 3: WhatsApp data model (schema msg: channels, templates, contacts, outbox, inbound, events) and the staff
-- help assistant v1 (schema help: pages with full-text search, problem reports). The outbox row is written in the
-- same transaction as the posting RPC (§WA-2). Sending happens in the whatsapp-sender Edge Function (not deployed
-- yet); until then rows stay queued, and DEV/preview send only to an allow-list (§WA-4.7). Additive.

create schema if not exists msg;
create schema if not exists help;
revoke all on schema msg, help from public, anon;
grant usage on schema msg, help to authenticated;

create table msg.channels (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  provider text not null default 'meta' check (provider in ('meta', 'gupshup', 'interakt', 'aisensy', 'wati', 'twilio', 'mock')),
  phone_number_id text,
  waba_id text,
  display_name text not null,
  status text not null default 'not_connected' check (status in ('not_connected', 'active', 'paused')),
  quality_rating text,
  unique (company_id, display_name)
);

create table msg.templates (
  id uuid primary key default gen_random_uuid(),
  name text not null check (name ~ '^[a-z0-9_]+$'),
  language text not null check (language in ('en', 'ml', 'ta', 'hi')),
  category text not null check (category in ('utility', 'marketing', 'authentication')),
  event text not null,
  header_type text not null default 'none' check (header_type in ('none', 'text', 'document')),
  body text not null,
  params jsonb not null default '[]'::jsonb,
  approval_status text not null default 'draft' check (approval_status in ('draft', 'submitted', 'approved', 'rejected', 'paused')),
  version int not null default 1,
  active boolean not null default true,
  unique (name, language, version)
);

create table msg.allow_list (
  number char(13) primary key check (number ~ '^\+91[6-9][0-9]{9}$'),
  note text
);

create table msg.outbox (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  event text not null,
  template_name text not null,
  language text not null default 'en',
  to_number char(13),
  party_id uuid references master.parties (id),
  person_id uuid references master.people (id),
  params jsonb not null default '{}'::jsonb,
  doc_type text,
  doc_id uuid,
  idempotency_key text not null unique,
  send_after timestamptz not null default now(),
  window_kind text not null default 'documents' check (window_kind in ('documents', 'reminders')),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'cancelled', 'skipped')),
  skip_reason text,
  wa_message_id text unique,
  attempts int not null default 0,
  last_error text,
  category text not null default 'utility',
  est_cost numeric(18, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on msg.outbox (status, send_after);
create index on msg.outbox (doc_type, doc_id);

create table msg.inbound (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references core.companies (id),
  wa_message_id text not null unique,
  from_number text not null,
  kind text not null default 'text',
  body text,
  media_path text,
  party_id uuid references master.parties (id),
  window_expires_at timestamptz,
  handled_by uuid references auth.users (id),
  handled_at timestamptz,
  received_at timestamptz not null default now()
);

create table msg.events (
  id bigint generated always as identity primary key,
  wa_message_id text not null,
  status text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  unique (wa_message_id, status)
);

-- Help pages (one per screen and per rule), searched with Postgres full-text search in v1.
create table help.pages (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  language text not null default 'en' check (language in ('en', 'ml', 'hi', 'bho')),
  screen text,
  rule_code text,
  title text not null,
  body text not null,
  search tsvector generated always as (to_tsvector('english', title || ' ' || body)) stored,
  updated_at timestamptz not null default now(),
  unique (slug, language)
);
create index on help.pages using gin (search);
create index on help.pages (rule_code);

create table help.problem_reports (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default ('HR-' || to_char(now() at time zone 'Asia/Kolkata', 'YYMMDD') || '-' || substr(md5(random()::text), 1, 4)),
  user_id uuid not null references auth.users (id),
  screen text,
  error_ref text,
  what_happened text not null,
  status text not null default 'open' check (status in ('open', 'in_progress', 'closed')),
  handled_by uuid references auth.users (id),
  reply text,
  created_at timestamptz not null default now()
);
create index on help.problem_reports (user_id);

do $$
declare t text;
begin
  foreach t in array array['msg.channels', 'msg.templates', 'msg.allow_list', 'msg.outbox', 'help.pages', 'help.problem_reports'] loop
    execute format('create trigger audit_row after insert or update or delete on %s for each row execute function app.audit_trigger()', t);
  end loop;
end $$;
do $$
declare t record;
begin
  for t in select schemaname, tablename from pg_tables where schemaname in ('msg', 'help') loop
    execute format('alter table %I.%I enable row level security', t.schemaname, t.tablename);
    execute format('revoke all on %I.%I from anon, authenticated', t.schemaname, t.tablename);
    execute format('grant select on %I.%I to authenticated', t.schemaname, t.tablename);
  end loop;
end $$;
create policy channels_read on msg.channels for select to authenticated using (app.can_read_company(company_id));
create policy templates_read on msg.templates for select to authenticated using (true);
create policy allow_read on msg.allow_list for select to authenticated using (app.is_admin());
-- Outbox: Admin and accounts see messages of their companies; never message bodies about bills without GST to others.
create policy outbox_read on msg.outbox for select to authenticated using (app.is_admin() or app.current_view() = 'all-readonly' or app.can(company_id, 'accounts.view'));
create policy inbound_read on msg.inbound for select to authenticated using (app.is_admin() or (company_id is not null and app.can(company_id, 'accounts.view')));
create policy events_read on msg.events for select to authenticated using (app.is_admin());
create policy help_pages_read on help.pages for select to authenticated using (true);
create policy problem_reports_read on help.problem_reports for select to authenticated using (user_id = (select auth.uid()) or app.is_admin());

-- Enqueue one message (called inside posting RPCs). Consent and contact are resolved now and re-checked at send.
-- p: {company_id, event, template, party_id | person_id, doc_type, doc_id, params, stage, window_kind}
create or replace function app.enqueue_message(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_number text; v_consent boolean := false; v_lang text := 'en'; v_skip text; v_key text;
begin
  if p ? 'party_id' then
    select c.whatsapp, c.whatsapp_consent, c.language into v_number, v_consent, v_lang
    from master.party_contacts c where c.party_id = (p ->> 'party_id')::uuid and c.whatsapp is not null
    order by c.is_primary desc, c.whatsapp_consent desc limit 1;
  elsif p ? 'person_id' then
    select pe.phone, pe.user_id is not null into v_number, v_consent from master.people pe where pe.id = (p ->> 'person_id')::uuid;
  end if;
  if v_number is null then v_skip := 'no verified WhatsApp number';
  elsif not coalesce(v_consent, false) then v_skip := 'no consent recorded';
  end if;
  v_key := concat_ws('|', p ->> 'doc_type', p ->> 'doc_id', coalesce(p ->> 'stage', p ->> 'event'), coalesce(v_number, 'none'));
  insert into msg.outbox (company_id, event, template_name, language, to_number, party_id, person_id, params, doc_type, doc_id, idempotency_key, window_kind, status, skip_reason)
  values ((p ->> 'company_id')::uuid, p ->> 'event', p ->> 'template', case when v_lang in ('en', 'ml', 'ta', 'hi') then v_lang else 'en' end, v_number,
          nullif(p ->> 'party_id', '')::uuid, nullif(p ->> 'person_id', '')::uuid, coalesce(p -> 'params', '{}'::jsonb), p ->> 'doc_type', nullif(p ->> 'doc_id', '')::uuid,
          v_key, coalesce(p ->> 'window_kind', 'documents'), case when v_skip is null then 'queued' else 'skipped' end, v_skip)
  on conflict (idempotency_key) do nothing
  returning id into v_id;
  return v_id;
end $$;

-- Utility templates (English drafts; Meta approval is the owner's step). Bodies never carry salary or KYC.
insert into msg.templates (name, language, category, event, header_type, body, params, approval_status) values
  ('invoice_posted', 'en', 'utility', 'sales.invoice_posted', 'document', 'Dear {{1}}, your invoice {{2}} dated {{3}} for ₹{{4}} is attached. Due date: {{5}}. – {{6}}', '["customer","doc_no","date","amount","due_date","company"]', 'draft'),
  ('payment_received', 'en', 'utility', 'sales.payment_received', 'document', 'Dear {{1}}, we received ₹{{2}} (receipt {{3}}). Balance now due: ₹{{4}}. Thank you. – {{5}}', '["customer","amount","doc_no","balance","company"]', 'draft'),
  ('credit_note_issued', 'en', 'utility', 'sales.credit_note', 'document', 'Dear {{1}}, credit note {{2}} for ₹{{3}} is attached. Reason: {{4}}. – {{5}}', '["customer","doc_no","amount","reason","company"]', 'draft'),
  ('statement_monthly', 'en', 'utility', 'sales.statement', 'document', 'Dear {{1}}, your statement for {{2}} is attached. Closing balance: ₹{{3}}, overdue: ₹{{4}}. – {{5}}', '["customer","period","closing","overdue","company"]', 'draft'),
  ('payslip_ready', 'en', 'utility', 'hr.payslip_ready', 'none', 'Your {{1}} payslip is ready. Open the Southfield staff app to see it.', '["month"]', 'draft'),
  ('request_decided', 'en', 'utility', 'hr.request_decided', 'none', 'Your {{1}} request was {{2}}. Details are in the staff app.', '["kind","decision"]', 'draft');

-- ─────────── Help v1 RPCs ───────────
create or replace function api.search_help(p_query text, p_screen text, p_language text) returns table (slug text, title text, snippet text, screen text, rule_code text, rank real)
language sql stable security definer set search_path = '' as $$
  select p.slug, p.title, left(p.body, 280), p.screen, p.rule_code,
         case when p_screen is not null and p.screen = p_screen then 1.0 else 0 end + extensions.similarity(p.title, coalesce(p_query, '')) +
         ts_rank(p.search, websearch_to_tsquery('english', coalesce(nullif(p_query, ''), p.title)))
  from help.pages p
  where p.language = coalesce(nullif(p_language, ''), 'en')
    and (nullif(p_query, '') is null and (p_screen is null or p.screen = p_screen)
         or p.search @@ websearch_to_tsquery('english', p_query) or extensions.similarity(p.title, coalesce(p_query, '')) > 0.2)
  order by 6 desc
  limit 8
$$;

create or replace function api.help_page(p_slug text, p_language text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('slug', slug, 'title', title, 'body', body, 'screen', screen, 'rule_code', rule_code, 'language', language) from help.pages where slug = p_slug and language = coalesce(nullif(p_language, ''), 'en')),
    (select jsonb_build_object('slug', slug, 'title', title, 'body', body, 'screen', screen, 'rule_code', rule_code, 'language', language) from help.pages where slug = p_slug and language = 'en'))
$$;

-- Explain an error reference: only the user's own errors (Admin: any), with the help page for its rule.
create or replace function api.explain_error(p_ref text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare e ops.error_log; v_page jsonb;
begin
  select * into e from ops.error_log where ref = upper(trim(p_ref));
  if e.ref is null or (e.user_id is distinct from auth.uid() and not app.is_admin()) then
    return jsonb_build_object('found', false);
  end if;
  select jsonb_build_object('slug', slug, 'title', title, 'body', body) into v_page from help.pages where rule_code = e.rule_code and language = 'en' limit 1;
  return jsonb_build_object('found', true, 'ref', e.ref, 'at', e.at, 'route', e.route, 'rpc', e.rpc, 'rule_code', e.rule_code, 'message', e.message, 'page', v_page);
end $$;

create or replace function api.create_problem_report(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid; v_code text; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'create_problem_report'); if v_prev is not null then return v_prev; end if;
  if auth.uid() is null then perform app.raise_rule('auth.required', 'sign in', '42501'); end if;
  if coalesce(length(trim(p ->> 'what_happened')), 0) < 5 then perform app.raise_rule('help.describe', 'say in a few words what happened', '22023'); end if;
  insert into help.problem_reports (user_id, screen, error_ref, what_happened) values (auth.uid(), left(p ->> 'screen', 100), nullif(upper(p ->> 'error_ref'), ''), left(p ->> 'what_happened', 2000))
  returning id, code into v_id, v_code;
  v_res := jsonb_build_object('id', v_id, 'code', v_code);
  return app.request_done(p_client_request_id, 'create_problem_report', v_res);
end $$;

create or replace function api.answer_problem_report(p_client_request_id uuid, p_id uuid, p_reply text, p_status text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'answer_problem_report'); if v_prev is not null then return v_prev; end if;
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'only Admin answers problem reports', '42501'); end if;
  update help.problem_reports set reply = p_reply, status = coalesce(p_status, 'closed'), handled_by = auth.uid() where id = p_id;
  v_res := jsonb_build_object('id', p_id);
  return app.request_done(p_client_request_id, 'answer_problem_report', v_res);
end $$;

-- Admin loads/updates help pages from docs/help (scripts/help-seed.mjs runs as the owner; this RPC lets Admin edit).
create or replace function api.upsert_help_page(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_help_page'); if v_prev is not null then return v_prev; end if;
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'only Admin edits help pages', '42501'); end if;
  insert into help.pages (slug, language, screen, rule_code, title, body) values (p ->> 'slug', coalesce(p ->> 'language', 'en'), p ->> 'screen', p ->> 'rule_code', p ->> 'title', p ->> 'body')
  on conflict (slug, language) do update set screen = excluded.screen, rule_code = excluded.rule_code, title = excluded.title, body = excluded.body, updated_at = now();
  v_res := jsonb_build_object('slug', p ->> 'slug');
  return app.request_done(p_client_request_id, 'upsert_help_page', v_res);
end $$;

-- ─────────── WhatsApp admin RPCs ───────────
create or replace function api.upsert_channel(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_channel'); if v_prev is not null then return v_prev; end if;
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'Admin only', '42501'); end if;
  if v_id is null then
    insert into msg.channels (company_id, provider, phone_number_id, waba_id, display_name) values ((p ->> 'company_id')::uuid, coalesce(p ->> 'provider', 'meta'), p ->> 'phone_number_id', p ->> 'waba_id', p ->> 'display_name') returning id into v_id;
  else
    update msg.channels set provider = coalesce(p ->> 'provider', provider), phone_number_id = coalesce(p ->> 'phone_number_id', phone_number_id), waba_id = coalesce(p ->> 'waba_id', waba_id),
      display_name = coalesce(p ->> 'display_name', display_name), status = coalesce(p ->> 'status', status) where id = v_id;
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_channel', v_res);
end $$;

create or replace function api.set_allow_list(p_client_request_id uuid, p_number text, p_note text, p_remove boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_allow_list'); if v_prev is not null then return v_prev; end if;
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'Admin only', '42501'); end if;
  if p_remove then delete from msg.allow_list where number = p_number;
  else insert into msg.allow_list (number, note) values (p_number, p_note) on conflict (number) do update set note = excluded.note; end if;
  v_res := jsonb_build_object('ok', true);
  return app.request_done(p_client_request_id, 'set_allow_list', v_res);
end $$;

create or replace function api.cancel_message(p_client_request_id uuid, p_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'cancel_message'); if v_prev is not null then return v_prev; end if;
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'Admin only', '42501'); end if;
  update msg.outbox set status = 'cancelled', skip_reason = p_reason, updated_at = now() where id = p_id and status in ('queued', 'failed');
  v_res := jsonb_build_object('id', p_id);
  return app.request_done(p_client_request_id, 'cancel_message', v_res);
end $$;

create or replace view api.msg_channels with (security_invoker = true) as select id, company_id, provider, phone_number_id, waba_id, display_name, status, quality_rating from msg.channels;
create or replace view api.msg_templates with (security_invoker = true) as select id, name, language, category, event, header_type, body, params, approval_status, version, active from msg.templates;
create or replace view api.msg_outbox with (security_invoker = true) as
select o.id, o.company_id, o.event, o.template_name, o.language, case when o.to_number is null then null else '••' || right(o.to_number, 4) end as to_masked,
       o.party_id, p.legal_name as party_name, o.doc_type, o.doc_id, o.status, o.skip_reason, o.attempts, o.last_error, o.category, o.est_cost, o.send_after, o.created_at, o.updated_at
from msg.outbox o left join master.parties p on p.id = o.party_id;
create or replace view api.msg_allow_list with (security_invoker = true) as select number, note from msg.allow_list;
create or replace view api.problem_reports with (security_invoker = true) as
select r.id, r.code, r.user_id, u.display_name as user_name, r.screen, r.error_ref, r.what_happened, r.status, r.reply, r.created_at
from help.problem_reports r left join core.user_profiles u on u.user_id = r.user_id;
create or replace view api.help_pages with (security_invoker = true) as select slug, language, screen, rule_code, title, updated_at from help.pages;

grant select on all tables in schema api to authenticated;
revoke all on all functions in schema api from public, anon;
grant execute on all functions in schema api to authenticated;
grant execute on function api.log_sign_in_failure(text) to anon;
revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;
notify pgrst, 'reload schema';

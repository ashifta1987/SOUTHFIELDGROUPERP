-- 20261103007100_phase7_ops_api.sql
-- Phase 7 operations RPCs: job work out and back under a job-work challan (CGST Act s.143: return limits recorded from
-- settings, overdue flagged), maintenance (repair requests, breakdowns with downtime, spares issued through the stock
-- ledger, preventive schedules, a failed operator check opens a repair request), licences and documents (renewal with
-- history, documents in the private bucket, reminders at the set days before expiry sent once each, expired blocking
-- licences stop production / packing), the asset register (depreciation per period from the CA's settings only —
-- refused with a rule code when unset — and disposals). Every RPC: api.* security definer, p_client_request_id first,
-- idempotent, row locks, rights / state / period / stock checks; history by triggers. Additive.

-- ─────────── Helpers ───────────
-- Internal (non-GST) numbers for Phase 7 documents; the FY series is created on first use (Admin may change prefixes before use).
create or replace function app.p7_doc_no(p_company uuid, p_doc_type text, p_date date) returns text
language plpgsql security definer set search_path = '' as $$
declare v_fy uuid; v_prefix text;
begin
  select id into v_fy from core.financial_years where company_id = p_company and p_date between starts_on and ends_on;
  if v_fy is null then perform app.raise_rule('period.no_fy', 'no financial year is open for this date; open it on Settings', '22023'); end if;
  if not exists (select 1 from core.doc_series where company_id = p_company and gstin_id is null and doc_type = p_doc_type and fy_id = v_fy) then
    v_prefix := case p_doc_type when 'job_work' then 'JW' when 'repair_request' then 'RR' when 'spares_issue' then 'SP' when 'partner_request' then 'PRQ' end;
    if v_prefix is null then perform app.raise_rule('numbering.no_series', 'no number series for ' || p_doc_type, 'P0001'); end if;
    insert into core.doc_series (company_id, gstin_id, doc_type, fy_id, prefix) values (p_company, null, p_doc_type, v_fy, v_prefix) on conflict do nothing;
  end if;
  return app.take_doc_number(p_company, null, p_doc_type, v_fy);
end $$;

-- Readable licence name for messages and errors.
create or replace function app.licence_label(l core.licences) returns text
language sql immutable set search_path = '' as $$
  select coalesce(nullif(trim(l.title), ''), initcap(replace(l.kind, '_', ' ')) || ' licence')
$$;

-- ─────────── Licences: blocking ───────────
-- An expired (or suspended / cancelled) licence of a kind Admin marked blocking for an activity stops that activity at the
-- place's branch. Kinds with no licence marked blocking do not block (the cosmetics licence keeps its own family check).
create or replace function app.check_blocking_licences(p_company uuid, p_place uuid, p_activity text, p_date date) returns void
language plpgsql stable security definer set search_path = '' as $$
declare v_branch uuid; r record;
begin
  select branch_id into v_branch from core.places where id = p_place;
  for r in select distinct l.kind from core.licences l
            where l.company_id = p_company and l.is_blocking and p_activity = any (l.blocks) and (l.branch_id is null or l.branch_id = v_branch) loop
    if not exists (select 1 from core.licences v
                    where v.company_id = p_company and v.kind = r.kind and v.status = 'active' and v.valid_from <= p_date and (v.valid_to is null or v.valid_to >= p_date)
                      and (v.branch_id is null or v.branch_id = v_branch)) then
      perform app.raise_rule('licence.expired', 'the ' || replace(r.kind, '_', ' ') || ' licence has expired or is not active; ' || p_activity
                             || ' is blocked until Admin records the renewal on Licences', 'P0001');
    end if;
  end loop;
end $$;

-- Phase 5 licence check, now also enforcing blocking licences for production at the line's branch.
create or replace function app.check_licence(p_company uuid, p_family uuid, p_place uuid, p_date date) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_kind text; v_branch uuid; v_id uuid;
begin
  perform app.check_blocking_licences(p_company, p_place, 'production', p_date);
  select licence_kind into v_kind from prod.process_families where id = p_family;
  if v_kind is null then return null; end if;
  select branch_id into v_branch from core.places where id = p_place;
  select id into v_id from core.licences
   where company_id = p_company and kind = v_kind and status = 'active' and valid_from <= p_date and (valid_to is null or valid_to >= p_date)
     and (branch_id is null or branch_id = v_branch)
   order by valid_to desc nulls first limit 1;
  if v_id is null then
    if exists (select 1 from core.licences where company_id = p_company and kind = v_kind and (branch_id is null or branch_id = v_branch)) then
      perform app.raise_rule('licence.expired', 'the ' || replace(v_kind, '_', ' ') || ' licence has expired or is not active on this date; production entry is blocked until Admin records the renewed licence', 'P0001');
    end if;
    perform app.raise_rule('licence.missing', 'no ' || replace(v_kind, '_', ' ') || ' licence is recorded; production entry is blocked until Admin enters it on Licences', 'P0001');
  end if;
  return v_id;
end $$;

-- Packing (a batch moving to packing) and injection shift entries also respect blocking licences.
create or replace function app.batch_packing_licence_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'packing' and old.status is distinct from 'packing' then
    perform app.check_blocking_licences(new.company_id, new.line_place_id, 'packing', current_date);
  end if;
  return new;
end $$;
create trigger packing_licence_guard before update of status on prod.batches for each row execute function app.batch_packing_licence_guard();

create or replace function app.shift_licence_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform app.check_blocking_licences(new.company_id, new.place_id, 'production', new.shift_date);
  return new;
end $$;
create trigger shift_licence_guard before insert on prod.injection_shifts for each row execute function app.shift_licence_guard();

-- ─────────── Licences: register, renewal, documents ───────────
-- p: {id?, company_id, branch_id, kind, licence_no, issued_by, valid_from, valid_to, status, document_path, note,
--     title, portal_url, owner_person_id, is_blocking, blocks [production|packing], renewal_status, renewal_applied_on}
create or replace function api.upsert_licence(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_company uuid := nullif(p ->> 'company_id', '')::uuid; v_branch uuid := nullif(p ->> 'branch_id', '')::uuid;
        v_blocks text[];
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_licence'); if v_prev is not null then return v_prev; end if;
  if v_id is not null then
    select company_id into v_company from core.licences where id = v_id for update;
    if v_company is null then perform app.raise_rule('licence.missing_row', 'licence not found', 'P0002'); end if;
  end if;
  perform app.require(v_company, 'settings.manage');
  if coalesce(length(trim(p ->> 'licence_no')), 0) = 0 then perform app.raise_rule('licence.no_number', 'enter the licence number exactly as printed on the licence', '22023'); end if;
  if nullif(p ->> 'valid_from', '') is null then perform app.raise_rule('licence.dates', 'enter the date the licence is valid from', '22023'); end if;
  if v_branch is not null and not exists (select 1 from core.branches where id = v_branch and company_id = v_company) then
    perform app.raise_rule('org.branch_other_company', 'the branch belongs to another company', '22023');
  end if;
  if p ? 'blocks' then
    select coalesce(array_agg(x), '{}'::text[]) into v_blocks from jsonb_array_elements_text(p -> 'blocks') x;
    if not (v_blocks <@ array['production', 'packing']::text[]) then perform app.raise_rule('licence.blocks', 'a licence can block production or packing', '22023'); end if;
  end if;
  if nullif(p ->> 'owner_person_id', '') is not null and not exists (select 1 from master.people where id = (p ->> 'owner_person_id')::uuid) then
    perform app.raise_rule('licence.owner', 'choose the owner from the people list', '22023');
  end if;
  if v_id is null then
    insert into core.licences (company_id, branch_id, kind, licence_no, issued_by, valid_from, valid_to, status, document_path, note, created_by,
                               title, portal_url, owner_person_id, is_blocking, blocks, renewal_status, renewal_applied_on)
    values (v_company, v_branch, p ->> 'kind', trim(p ->> 'licence_no'), nullif(p ->> 'issued_by', ''), (p ->> 'valid_from')::date, nullif(p ->> 'valid_to', '')::date,
            coalesce(nullif(p ->> 'status', ''), 'active'), nullif(p ->> 'document_path', ''), nullif(p ->> 'note', ''), auth.uid(),
            nullif(p ->> 'title', ''), nullif(p ->> 'portal_url', ''), nullif(p ->> 'owner_person_id', '')::uuid, coalesce((p ->> 'is_blocking')::boolean, false),
            coalesce(v_blocks, '{}'::text[]), coalesce(nullif(p ->> 'renewal_status', ''), 'ok'), nullif(p ->> 'renewal_applied_on', '')::date)
    returning id into v_id;
  else
    update core.licences set branch_id = v_branch, kind = p ->> 'kind', licence_no = trim(p ->> 'licence_no'), issued_by = nullif(p ->> 'issued_by', ''),
      valid_from = (p ->> 'valid_from')::date, valid_to = nullif(p ->> 'valid_to', '')::date, status = coalesce(nullif(p ->> 'status', ''), status),
      document_path = coalesce(nullif(p ->> 'document_path', ''), document_path), note = nullif(p ->> 'note', ''), updated_at = now(),
      title = case when p ? 'title' then nullif(p ->> 'title', '') else title end,
      portal_url = case when p ? 'portal_url' then nullif(p ->> 'portal_url', '') else portal_url end,
      owner_person_id = case when p ? 'owner_person_id' then nullif(p ->> 'owner_person_id', '')::uuid else owner_person_id end,
      is_blocking = case when p ? 'is_blocking' then coalesce((p ->> 'is_blocking')::boolean, false) else is_blocking end,
      blocks = coalesce(v_blocks, blocks),
      renewal_status = coalesce(nullif(p ->> 'renewal_status', ''), renewal_status),
      renewal_applied_on = case when p ? 'renewal_applied_on' then nullif(p ->> 'renewal_applied_on', '')::date else renewal_applied_on end
    where id = v_id;
  end if;
  perform app.log_event('setting_changed', jsonb_build_object('entity', 'licence', 'id', v_id, 'company_id', v_company, 'kind', p ->> 'kind', 'valid_to', p ->> 'valid_to'));
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_licence', v_res);
end $$;

-- p: {kind licence_copy|application|renewal_receipt|inspection|other, path (<company_id>/licences/...), valid_to}
create or replace function api.add_licence_document(p_client_request_id uuid, p_licence_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; l core.licences; v_id uuid; v_path text := trim(coalesce(p ->> 'path', ''));
begin
  v_prev := app.request_seen(p_client_request_id, 'add_licence_document'); if v_prev is not null then return v_prev; end if;
  select * into l from core.licences where id = p_licence_id for update;
  if l.id is null then perform app.raise_rule('licence.missing_row', 'licence not found', 'P0002'); end if;
  perform app.require(l.company_id, 'settings.manage');
  if v_path = '' then perform app.raise_rule('licence.document_path', 'upload the file first', '22023'); end if;
  if split_part(v_path, '/', 1) <> l.company_id::text or split_part(v_path, '/', 2) <> 'licences' then
    perform app.raise_rule('licence.document_folder', 'licence files go in the company''s licences folder of the documents bucket', '22023');
  end if;
  insert into core.licence_documents (company_id, licence_id, kind, path, valid_to, uploaded_by)
  values (l.company_id, l.id, coalesce(nullif(p ->> 'kind', ''), 'licence_copy'), v_path, nullif(p ->> 'valid_to', '')::date, auth.uid()) returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'add_licence_document', v_res);
end $$;

-- Renewal: the old dates go to the renewal history (append-only); the licence carries the new number and dates.
-- p: {licence_no?, valid_from, valid_to, document_path?, note}
create or replace function api.renew_licence(p_client_request_id uuid, p_licence_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; l core.licences; v_from date := nullif(p ->> 'valid_from', '')::date; v_to date := nullif(p ->> 'valid_to', '')::date;
        v_no text := coalesce(nullif(trim(p ->> 'licence_no'), ''), null); v_doc uuid; v_path text := nullif(trim(coalesce(p ->> 'document_path', '')), ''); v_id uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'renew_licence'); if v_prev is not null then return v_prev; end if;
  select * into l from core.licences where id = p_licence_id for update;
  if l.id is null then perform app.raise_rule('licence.missing_row', 'licence not found', 'P0002'); end if;
  perform app.require(l.company_id, 'settings.manage');
  if l.status = 'cancelled' then perform app.raise_rule('licence.cancelled', 'a cancelled licence is not renewed; enter the new licence instead', '22023'); end if;
  if v_from is null or v_to is null then perform app.raise_rule('licence.dates', 'enter the new valid-from and valid-to dates exactly as on the renewed licence', '22023'); end if;
  if v_to < v_from then perform app.raise_rule('licence.dates', 'the valid-to date is before the valid-from date', '22023'); end if;
  if l.valid_to is not null and v_to <= l.valid_to then perform app.raise_rule('licence.not_later', 'the renewed licence must run beyond the current expiry date', '22023'); end if;
  v_no := coalesce(v_no, l.licence_no);
  if v_no <> l.licence_no and exists (select 1 from core.licences where company_id = l.company_id and kind = l.kind and licence_no = v_no and id <> l.id) then
    perform app.raise_rule('licence.duplicate', 'another licence of this kind already has that number', '22023');
  end if;
  if v_path is not null then
    if split_part(v_path, '/', 1) <> l.company_id::text or split_part(v_path, '/', 2) <> 'licences' then
      perform app.raise_rule('licence.document_folder', 'licence files go in the company''s licences folder of the documents bucket', '22023');
    end if;
    insert into core.licence_documents (company_id, licence_id, kind, path, valid_to, uploaded_by) values (l.company_id, l.id, 'licence_copy', v_path, v_to, auth.uid()) returning id into v_doc;
  end if;
  insert into core.licence_renewals (company_id, licence_id, old_licence_no, old_valid_from, old_valid_to, new_licence_no, new_valid_from, new_valid_to, document_id, note, renewed_by)
  values (l.company_id, l.id, l.licence_no, l.valid_from, l.valid_to, v_no, v_from, v_to, v_doc, nullif(p ->> 'note', ''), auth.uid()) returning id into v_id;
  update core.licences set licence_no = v_no, valid_from = v_from, valid_to = v_to, status = 'active', renewal_status = 'renewed',
         document_path = coalesce(v_path, document_path), updated_at = now()
  where id = l.id;
  perform app.log_event('setting_changed', jsonb_build_object('entity', 'licence_renewal', 'id', l.id, 'company_id', l.company_id, 'kind', l.kind, 'valid_to', v_to));
  v_res := jsonb_build_object('id', l.id, 'renewal_id', v_id, 'valid_to', v_to);
  return app.request_done(p_client_request_id, 'renew_licence', v_res);
end $$;

-- ─────────── Licences: reminders (90/30/7 days by default; once each) and expiry ───────────
-- For each active licence: every threshold crossed on p_date gets one row (unique per licence, expiry and threshold).
-- Only the tightest new threshold sends; a larger one crossed at the same time (a late first run) is recorded as
-- superseded so no one gets three messages at once. The owner gets an internal alert (no figures). An expired blocking
-- licence opens a Bug fixer item once.
create or replace function app.licence_reminders_run(p_company uuid, p_date date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l core.licences; v_days int[]; v_crossed int[]; v_min int; d int; v_out uuid; v_status text; v_sent int := 0; v_super int := 0; v_bugs int := 0;
begin
  for l in select * from core.licences
            where status = 'active' and valid_to is not null and (p_company is null or company_id = p_company)
            order by company_id, valid_to for update loop
    if l.valid_to < p_date then
      if l.is_blocking or exists (select 1 from prod.process_families f where f.company_id = l.company_id and f.licence_kind = l.kind) then
        if not exists (select 1 from ops.bug_items where dedupe_key = 'licence_expired:' || l.id || ':' || l.valid_to) then
          perform app.open_bug(jsonb_build_object('company_id', l.company_id, 'area', 'production', 'kind', 'other', 'severity', 'high',
            'title', app.licence_label(l) || ' ' || l.licence_no || ' expired on ' || to_char(l.valid_to, 'DD-MM-YYYY'),
            'suggested_fix', 'Record the renewed licence on Licences (Renew). Dependent transactions are blocked until then.',
            'who_fixes', 'admin', 'ref_table', 'core.licences', 'ref_id', l.id, 'dedupe_key', 'licence_expired:' || l.id || ':' || l.valid_to,
            'evidence', jsonb_build_object('licence_id', l.id, 'kind', l.kind, 'valid_to', l.valid_to)));
          v_bugs := v_bugs + 1;
        end if;
      end if;
      if l.renewal_status in ('ok', 'renewal_due') then update core.licences set renewal_status = 'lapsed' where id = l.id; end if;
      continue;
    end if;
    select array_agg(x::int order by x::int desc) into v_days
    from jsonb_array_elements_text(coalesce(app.setting(l.company_id, 'licence.reminder_days', p_date), '[]'::jsonb)) x;
    if v_days is null then continue; end if;
    select array_agg(t order by t) into v_crossed from unnest(v_days) t
     where p_date >= l.valid_to - t
       and not exists (select 1 from core.licence_reminders r where r.licence_id = l.id and r.valid_to = l.valid_to and r.days_before = t);
    if v_crossed is null then continue; end if;
    v_min := v_crossed[1];
    foreach d in array v_crossed loop
      if d = v_min then
        v_out := null;
        if l.owner_person_id is not null then
          v_out := app.enqueue_message(jsonb_build_object('company_id', l.company_id, 'event', 'internal.licence_expiring', 'template', 'licence_expiring',
            'person_id', l.owner_person_id, 'doc_type', 'core.licence', 'doc_id', l.id, 'stage', 'licence:' || l.valid_to || ':' || d, 'window_kind', 'reminders',
            'params', jsonb_build_object('licence', app.licence_label(l), 'licence_no', l.licence_no, 'valid_to', to_char(l.valid_to, 'DD-MM-YYYY'),
                                         'days_left', l.valid_to - p_date)));
        end if;
        select coalesce((select o.status from msg.outbox o where o.id = v_out), 'alert_only') into v_status;
        v_status := case when v_status in ('queued', 'skipped') then v_status else 'alert_only' end;
        insert into core.licence_reminders (company_id, licence_id, valid_to, days_before, due_on, status, outbox_id, run_date)
        values (l.company_id, l.id, l.valid_to, d, l.valid_to - d, v_status, v_out, p_date) on conflict do nothing;
        v_sent := v_sent + 1;
      else
        insert into core.licence_reminders (company_id, licence_id, valid_to, days_before, due_on, status, run_date)
        values (l.company_id, l.id, l.valid_to, d, l.valid_to - d, 'superseded', p_date) on conflict do nothing;
        v_super := v_super + 1;
      end if;
    end loop;
    if l.renewal_status = 'ok' then update core.licences set renewal_status = 'renewal_due' where id = l.id; end if;
  end loop;
  return jsonb_build_object('date', p_date, 'reminders', v_sent, 'superseded', v_super, 'expired_items', v_bugs);
end $$;

create or replace function api.run_licence_reminders(p_client_request_id uuid, p_company_id uuid, p_date date default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'run_licence_reminders'); if v_prev is not null then return v_prev; end if;
  perform app.require(p_company_id, 'settings.manage');
  if p_date is not null and p_date > (now() at time zone 'Asia/Kolkata')::date then perform app.raise_rule('date.future', 'the date is in the future', '22023'); end if;
  v_res := app.licence_reminders_run(p_company_id, coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date));
  return app.request_done(p_client_request_id, 'run_licence_reminders', v_res);
end $$;

insert into msg.templates (name, language, category, event, header_type, body, params, approval_status) values
  ('licence_expiring', 'en', 'utility', 'internal.licence_expiring', 'none',
   'Reminder: {{1}} ({{2}}) expires on {{3}}, {{4}} days from today. Open Licences in the ERP to record the renewal.',
   '["licence","licence_no","valid_to","days_left"]', 'draft')
on conflict do nothing;

-- ─────────── Job work ───────────
-- The job worker's place (kind job_worker) under the sending branch, created once per company and party.
create or replace function app.job_worker_place(p_company uuid, p_party uuid, p_branch uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v uuid; v_code text := 'JW-' || upper(substr(replace(p_party::text, '-', ''), 1, 8)); v_name text;
begin
  select place_id into v from prod.job_worker_places where company_id = p_company and party_id = p_party;
  if v is not null then return v; end if;
  select left('Job worker · ' || legal_name, 120) into v_name from master.parties where id = p_party;
  insert into core.places (company_id, branch_id, code, name, kind) values (p_company, p_branch, v_code, v_name, 'job_worker')
  on conflict (company_id, code) do nothing returning id into v;
  if v is null then select id into v from core.places where company_id = p_company and code = v_code; end if;
  insert into prod.job_worker_places (company_id, party_id, place_id) values (p_company, p_party, v) on conflict do nothing;
  return v;
end $$;

-- Goods out to a job worker: stock moves from the sending place to the job worker's place (still ours) through the
-- ledger, and a delivery challan (goods not sold) to the job worker is numbered from the challan series of the sending
-- GSTIN, with the return-by date from settings (inputs / capital goods; none for moulds, dies, jigs, fixtures, tools).
-- p: {company_id, job_worker_party_id, process, goods_kind inputs|capital_goods|moulds_tools, from_place_id, sent_on, note,
--     lines: [{product_id, lot_id?, qty}]}
create or replace function api.issue_job_work_challan(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_res jsonb; v_company uuid := nullif(p ->> 'company_id', '')::uuid; v_party uuid := nullif(p ->> 'job_worker_party_id', '')::uuid;
  v_from uuid := nullif(p ->> 'from_place_id', '')::uuid; v_date date := coalesce(nullif(p ->> 'sent_on', '')::date, current_date);
  v_kind text := p ->> 'goods_kind'; v_branch uuid; v_gstin uuid; v_years jsonb; v_return date; v_no text; v_id uuid; v_jw uuid; v_fy uuid;
  l jsonb; v_n int := 0; v_taken jsonb; pc jsonb; v_qty numeric; v_val numeric; v_doc uuid; v_doc_no text; v_total numeric; v_pos text; party master.parties;
begin
  v_prev := app.request_seen(p_client_request_id, 'issue_job_work_challan'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'production.create');
  select * into party from master.parties where id = v_party;
  if party.id is null or party.status = 'merged' then perform app.raise_rule('jobwork.party', 'choose the job worker from the supplier list', '22023'); end if;
  if not exists (select 1 from master.party_companies pc2 where pc2.party_id = v_party and pc2.company_id = v_company) then
    perform app.raise_rule('jobwork.party_other_company', 'this job worker is not set up for this company', '22023');
  end if;
  if coalesce(length(trim(p ->> 'process')), 0) = 0 then perform app.raise_rule('jobwork.process', 'say what the job worker will do (machining, plating …)', '22023'); end if;
  if v_kind is null or v_kind not in ('inputs', 'capital_goods', 'moulds_tools') then perform app.raise_rule('jobwork.goods_kind', 'choose inputs, capital goods or moulds and tools', '22023'); end if;
  if jsonb_typeof(p -> 'lines') <> 'array' or jsonb_array_length(p -> 'lines') = 0 then perform app.raise_rule('jobwork.no_lines', 'add the goods being sent', '22023'); end if;
  select pl.branch_id, br.gstin_id into v_branch, v_gstin from core.places pl join core.branches br on br.id = pl.branch_id where pl.id = v_from and pl.company_id = v_company;
  if v_branch is null then perform app.raise_rule('stock.place_other_company', 'choose a place of this company to send from', '22023'); end if;
  if v_gstin is null then perform app.raise_rule('jobwork.no_gstin', 'the sending branch has no GSTIN; set it on Branches and GSTINs', '22023'); end if;
  perform app.check_stock_date(v_company, v_date);
  v_years := app.setting(v_company, 'jobwork.return_years', v_date);
  if v_kind <> 'moulds_tools' then
    if v_years is null or jsonb_typeof(v_years -> v_kind) <> 'number' then
      perform app.raise_rule('jobwork.limit_not_set', 'the return limit for ' || replace(v_kind, '_', ' ') || ' is not set; Admin sets it on Settings with the CA', '22023');
    end if;
    v_return := (v_date + make_interval(years => (v_years ->> v_kind)::int))::date;
  end if;
  v_no := app.p7_doc_no(v_company, 'job_work', v_date);
  v_jw := app.job_worker_place(v_company, v_party, v_branch);
  insert into prod.job_work_orders (company_id, doc_no, gstin_id, job_worker_party_id, process, goods_kind, from_place_id, jw_place_id, sent_on, return_by, note, created_by)
  values (v_company, v_no, v_gstin, v_party, trim(p ->> 'process'), v_kind, v_from, v_jw, v_date, v_return, nullif(p ->> 'note', ''), auth.uid())
  returning id into v_id;
  for l in select * from jsonb_array_elements(p -> 'lines') loop
    v_qty := round((l ->> 'qty')::numeric, 3);
    if v_qty is null or v_qty <= 0 then perform app.raise_rule('stock.qty', 'the quantity must be above zero', '22023'); end if;
    v_n := v_n + 1;
    v_taken := app.stock_take(v_company, (l ->> 'product_id')::uuid, nullif(l ->> 'lot_id', '')::uuid, v_from, 'available', v_qty, 'job_work_out',
                              'prod.job_work_orders', v_id, v_no, v_date, 'Sent for job work');
    v_val := 0;
    for pc in select * from jsonb_array_elements(v_taken) loop
      perform app.stock_post(v_company, (l ->> 'product_id')::uuid, nullif(pc ->> 'lot_id', '')::uuid, v_jw, 'available', (pc ->> 'qty')::numeric, 'job_work_out',
                             'prod.job_work_orders', v_id, v_no, v_date, (pc ->> 'unit_cost')::numeric, 'At job worker');
      v_val := v_val + (pc ->> 'qty')::numeric * coalesce((pc ->> 'unit_cost')::numeric, 0);
    end loop;
    insert into prod.job_work_lines (company_id, order_id, line_no, product_id, lot_id, qty_sent, unit_cost)
    values (v_company, v_id, v_n, (l ->> 'product_id')::uuid, nullif(l ->> 'lot_id', '')::uuid, v_qty, round(v_val / v_qty, 4));
  end loop;
  -- The job-work challan (goods not sold), from the sending GSTIN's challan series.
  v_fy := app.fy_for(v_company, v_date);
  v_pos := coalesce(party.state_code, (select state_code from core.gstins where id = v_gstin));
  insert into sales.documents (company_id, gstin_id, doc_type, doc_date, party_id, place_of_supply, tax_class, lawful_reason, reason, notes, created_by)
  values (v_company, v_gstin, 'delivery_challan', v_date, v_party, v_pos, 'without_gst', 'challan_not_sold', 'Job work ' || v_no || ': ' || trim(p ->> 'process'),
          'Goods sent for job work (CGST Act s.143), not sold. ' || case when v_return is null then 'No time limit (moulds, dies, jigs, fixtures, tools).'
                                                                         else 'To come back by ' || to_char(v_return, 'DD-MM-YYYY') || '.' end, auth.uid())
  returning id into v_doc;
  insert into sales.document_lines (document_id, line_no, product_id, description, hsn_code, uom, qty, rate, discount, taxable, gst_rate, cgst, sgst, igst, cess, total)
  select v_doc, jl.line_no, jl.product_id, pr.name, pr.hsn_code, pr.uom, jl.qty_sent, round(jl.unit_cost, 2), 0, round(jl.qty_sent * jl.unit_cost, 2), 0, 0, 0, 0, 0,
         round(jl.qty_sent * jl.unit_cost, 2)
  from prod.job_work_lines jl join master.products pr on pr.id = jl.product_id where jl.order_id = v_id;
  select coalesce(sum(total), 0) into v_total from sales.document_lines where document_id = v_doc;
  v_doc_no := app.take_doc_number(v_company, v_gstin, 'delivery_challan', v_fy);
  update sales.documents set taxable = v_total, total = v_total, status = 'posted', doc_no = v_doc_no, posted_at = now(), posted_by = auth.uid() where id = v_doc;
  update prod.job_work_orders set challan_document_id = v_doc, challan_no = v_doc_no where id = v_id;
  v_res := jsonb_build_object('id', v_id, 'doc_no', v_no, 'challan_id', v_doc, 'challan_no', v_doc_no, 'return_by', v_return, 'jw_place_id', v_jw);
  return app.request_done(p_client_request_id, 'issue_job_work_challan', v_res);
end $$;

-- Goods back from the job worker. Each line settles some of what was sent (input_qty) and brings in what came back:
--   finished (the processed item, valued at the inputs it used), returned (unprocessed, same lots), scrap (scrap item,
--   no value), loss (process loss: settles input with nothing coming back). The balance per line can never go below zero.
-- p: {received_on, challan_ref, to_place_id, lines: [{line_id, kind, product_id?, qty, input_qty?, bucket?}]}
create or replace function api.receive_job_work(p_client_request_id uuid, p_order_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_res jsonb; o prod.job_work_orders; jl prod.job_work_lines; l jsonb; v_date date := coalesce(nullif(p ->> 'received_on', '')::date, current_date);
  v_to uuid := nullif(p ->> 'to_place_id', '')::uuid; v_kind text; v_prod uuid; v_qty numeric; v_in numeric; v_taken jsonb; pc jsonb; v_val numeric; v_bucket text;
  v_open numeric;
begin
  v_prev := app.request_seen(p_client_request_id, 'receive_job_work'); if v_prev is not null then return v_prev; end if;
  select * into o from prod.job_work_orders where id = p_order_id for update;
  if o.id is null then perform app.raise_rule('jobwork.missing', 'job work order not found', 'P0002'); end if;
  perform app.require(o.company_id, 'production.create');
  if o.status not in ('sent', 'part_received') then perform app.raise_rule('jobwork.closed', 'everything on ' || o.doc_no || ' is already back', '22023'); end if;
  if v_date < o.sent_on then perform app.raise_rule('jobwork.date', 'goods cannot come back before they were sent', '22023'); end if;
  perform app.check_stock_date(o.company_id, v_date);
  v_to := coalesce(v_to, o.from_place_id);
  if not exists (select 1 from core.places where id = v_to and company_id = o.company_id and kind <> 'job_worker') then
    perform app.raise_rule('stock.place_other_company', 'choose a place of this company to receive into', '22023');
  end if;
  if jsonb_typeof(p -> 'lines') <> 'array' or jsonb_array_length(p -> 'lines') = 0 then perform app.raise_rule('jobwork.no_lines', 'add what came back', '22023'); end if;
  for l in select * from jsonb_array_elements(p -> 'lines') loop
    select * into jl from prod.job_work_lines where id = (l ->> 'line_id')::uuid and order_id = o.id for update;
    if jl.id is null then perform app.raise_rule('jobwork.line', 'that line is not on this order', '22023'); end if;
    v_kind := l ->> 'kind';
    if v_kind is null or v_kind not in ('finished', 'returned', 'scrap', 'loss') then perform app.raise_rule('jobwork.kind', 'choose finished, returned, scrap or loss', '22023'); end if;
    v_prod := coalesce(nullif(l ->> 'product_id', '')::uuid, case when v_kind in ('finished', 'returned') then jl.product_id end);
    v_qty := round(coalesce((l ->> 'qty')::numeric, 0), 3);
    v_in := round(coalesce(nullif(l ->> 'input_qty', '')::numeric,
                           case when v_kind = 'returned' then v_qty when v_kind = 'finished' and v_prod = jl.product_id then v_qty else null end), 3);
    v_bucket := coalesce(nullif(l ->> 'bucket', ''), 'available');
    if v_bucket not in ('available', 'quarantine') then perform app.raise_rule('stock.bucket', 'receive into available or quarantine', '22023'); end if;
    if v_kind = 'returned' and v_prod <> jl.product_id then perform app.raise_rule('jobwork.returned_item', 'returned goods are the same item that was sent', '22023'); end if;
    if v_kind = 'returned' and v_in <> v_qty then perform app.raise_rule('jobwork.returned_qty', 'returned goods settle the same quantity', '22023'); end if;
    if v_kind = 'loss' and v_qty <> 0 then perform app.raise_rule('jobwork.loss_qty', 'a process loss brings nothing back; enter the input it used', '22023'); end if;
    if v_kind = 'scrap' and v_prod is null then perform app.raise_rule('jobwork.scrap_item', 'choose the scrap item', '22023'); end if;
    if v_kind = 'finished' and v_in is null then perform app.raise_rule('jobwork.input_qty', 'enter how much of the sent goods this used', '22023'); end if;
    v_in := coalesce(v_in, 0);
    if v_qty < 0 or v_in < 0 or (v_qty = 0 and v_in = 0) then perform app.raise_rule('stock.qty', 'the quantity must be above zero', '22023'); end if;
    v_open := jl.qty_sent - jl.qty_settled;
    if v_in > v_open then
      perform app.raise_rule('jobwork.over_balance', format('only %s of this line is still with the job worker', v_open), '22023');
    end if;
    v_val := 0; v_taken := '[]'::jsonb;
    if v_in > 0 then
      v_taken := app.stock_take(o.company_id, jl.product_id, jl.lot_id, o.jw_place_id, 'available', v_in, case when v_kind = 'loss' then 'write_off' else 'job_work_in' end,
                                'prod.job_work_orders', o.id, o.doc_no, v_date, 'Back from job worker (' || v_kind || ')');
      select coalesce(sum((x ->> 'qty')::numeric * coalesce((x ->> 'unit_cost')::numeric, 0)), 0) into v_val from jsonb_array_elements(v_taken) x;
    end if;
    if v_kind = 'returned' then
      for pc in select * from jsonb_array_elements(v_taken) loop
        perform app.stock_post(o.company_id, jl.product_id, nullif(pc ->> 'lot_id', '')::uuid, v_to, v_bucket, (pc ->> 'qty')::numeric, 'job_work_in',
                               'prod.job_work_orders', o.id, o.doc_no, v_date, (pc ->> 'unit_cost')::numeric, 'Returned unprocessed');
      end loop;
    elsif v_kind = 'finished' and v_qty > 0 then
      perform app.stock_post(o.company_id, v_prod, null, v_to, v_bucket, v_qty, 'job_work_in', 'prod.job_work_orders', o.id, o.doc_no, v_date,
                             round(v_val / v_qty, 4), 'Processed by job worker');
    elsif v_kind = 'scrap' and v_qty > 0 then
      perform app.stock_post(o.company_id, v_prod, null, v_to, v_bucket, v_qty, 'scrap_in', 'prod.job_work_orders', o.id, o.doc_no, v_date, 0, 'Scrap back from job worker');
    end if;
    update prod.job_work_lines set qty_settled = qty_settled + v_in where id = jl.id;
    insert into prod.job_work_receipts (company_id, order_id, line_id, kind, product_id, qty, input_qty, to_place_id, value, received_on, challan_ref, received_by)
    values (o.company_id, o.id, jl.id, v_kind, v_prod, v_qty, v_in, case when v_qty > 0 then v_to end, round(v_val, 2), v_date, nullif(p ->> 'challan_ref', ''), auth.uid());
  end loop;
  update prod.job_work_orders set status = case when exists (select 1 from prod.job_work_lines x where x.order_id = o.id and x.qty_settled < x.qty_sent) then 'part_received' else 'received' end,
         updated_at = now()
  where id = o.id;
  select jsonb_build_object('order_id', o.id, 'status', (select status from prod.job_work_orders where id = o.id),
           'balance', coalesce(jsonb_agg(jsonb_build_object('line_id', x.id, 'product_id', x.product_id, 'sent', x.qty_sent, 'settled', x.qty_settled, 'balance', x.qty_sent - x.qty_settled) order by x.line_no), '[]'::jsonb))
    into v_res from prod.job_work_lines x where x.order_id = o.id;
  return app.request_done(p_client_request_id, 'receive_job_work', v_res);
end $$;

-- Overdue job work (inputs or capital goods not back by the limit are treated as supplied; GST becomes payable): one Bug
-- fixer item per order, for the accounts team and the CA.
create or replace function app.job_work_overdue_run(p_company uuid, p_date date) returns int
language plpgsql security definer set search_path = '' as $$
declare r record; v_n int := 0;
begin
  for r in select o.id, o.company_id, o.doc_no, o.return_by, o.goods_kind from prod.job_work_orders o
            where o.status in ('sent', 'part_received') and o.return_by is not null and o.return_by < p_date and (p_company is null or o.company_id = p_company) loop
    if not exists (select 1 from ops.bug_items where dedupe_key = 'job_work_overdue:' || r.id) then
      perform app.open_bug(jsonb_build_object('company_id', r.company_id, 'area', 'tax', 'kind', 'other', 'severity', 'high',
        'title', 'Job work ' || r.doc_no || ' not back by ' || to_char(r.return_by, 'DD-MM-YYYY'),
        'suggested_fix', 'Goods not returned within the limit are treated as supplied by us on the day they were sent; the CA confirms the tax invoice and interest.',
        'who_fixes', 'ca', 'ref_table', 'prod.job_work_orders', 'ref_id', r.id, 'dedupe_key', 'job_work_overdue:' || r.id,
        'evidence', jsonb_build_object('order_id', r.id, 'return_by', r.return_by, 'goods_kind', r.goods_kind)));
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;

-- ─────────── Maintenance ───────────
-- p: {asset_id | mould_id, title, description, photo_path, priority, is_breakdown, broke_down_at}
create or replace function api.raise_repair_request(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; a core.assets; m prod.moulds; v_company uuid; v_id uuid; v_no text; v_brk boolean := coalesce((p ->> 'is_breakdown')::boolean, false);
        v_at timestamptz := coalesce(nullif(p ->> 'broke_down_at', '')::timestamptz, now());
begin
  v_prev := app.request_seen(p_client_request_id, 'raise_repair_request'); if v_prev is not null then return v_prev; end if;
  if nullif(p ->> 'asset_id', '') is not null then
    select * into a from core.assets where id = (p ->> 'asset_id')::uuid for update;
    if a.id is null then perform app.raise_rule('asset.missing', 'machine not found', 'P0002'); end if;
    v_company := a.company_id;
  elsif nullif(p ->> 'mould_id', '') is not null then
    select * into m from prod.moulds where id = (p ->> 'mould_id')::uuid for update;
    if m.id is null then perform app.raise_rule('mould.missing', 'mould not found', 'P0002'); end if;
    v_company := m.company_id;
  else
    perform app.raise_rule('repair.what', 'choose the machine or mould', '22023');
  end if;
  if not (app.can(v_company, 'production.create') or app.can(v_company, 'assets.manage')) then perform app.require(v_company, 'assets.manage'); end if;
  perform app.require(v_company, case when app.can(v_company, 'assets.manage') then 'assets.manage' else 'production.create' end);
  if coalesce(length(trim(p ->> 'title')), 0) = 0 then perform app.raise_rule('repair.title', 'say what is wrong', '22023'); end if;
  if v_at > now() + interval '5 minutes' then perform app.raise_rule('date.future', 'the breakdown time is in the future', '22023'); end if;
  v_no := app.p7_doc_no(v_company, 'repair_request', (v_at at time zone 'Asia/Kolkata')::date);
  insert into prod.repair_requests (company_id, doc_no, asset_id, mould_id, source, title, description, photo_path, priority, is_breakdown, broke_down_at, raised_by)
  values (v_company, v_no, a.id, m.id, case when v_brk then 'breakdown' else 'manual' end, trim(p ->> 'title'), nullif(p ->> 'description', ''), nullif(p ->> 'photo_path', ''),
          coalesce(nullif(p ->> 'priority', ''), case when v_brk then 'urgent' else 'normal' end), v_brk, case when v_brk then v_at end, auth.uid())
  returning id into v_id;
  if v_brk and a.id is not null then
    if a.status = 'active' then update core.assets set status = 'repair' where id = a.id; end if;
    insert into core.asset_events (company_id, asset_id, kind, event_date, detail, recorded_by)
    values (a.company_id, a.id, 'breakdown', (v_at at time zone 'Asia/Kolkata')::date, jsonb_build_object('repair_request_id', v_id), auth.uid());
  end if;
  v_res := jsonb_build_object('id', v_id, 'doc_no', v_no, 'status', 'new');
  return app.request_done(p_client_request_id, 'raise_repair_request', v_res);
end $$;

-- p: {status assigned|waiting_parts|cancelled, assigned_to, outside_vendor, purchase_request_id, priority}
create or replace function api.update_repair_request(p_client_request_id uuid, p_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; r prod.repair_requests; v_status text := coalesce(nullif(p ->> 'status', ''), null);
begin
  v_prev := app.request_seen(p_client_request_id, 'update_repair_request'); if v_prev is not null then return v_prev; end if;
  select * into r from prod.repair_requests where id = p_request_id for update;
  if r.id is null then perform app.raise_rule('repair.missing', 'repair request not found', 'P0002'); end if;
  perform app.require(r.company_id, 'assets.manage');
  if r.status in ('done', 'cancelled') then perform app.raise_rule('repair.closed', 'this request is closed', '22023'); end if;
  if v_status is not null and v_status not in ('assigned', 'waiting_parts', 'cancelled') then perform app.raise_rule('repair.status', 'close a request with Done instead', '22023'); end if;
  if nullif(p ->> 'purchase_request_id', '') is not null and not exists (select 1 from purch.requests where id = (p ->> 'purchase_request_id')::uuid and company_id = r.company_id) then
    perform app.raise_rule('repair.purchase_request', 'link a purchase request of this company', '22023');
  end if;
  update prod.repair_requests set status = coalesce(v_status, case when coalesce(p ->> 'assigned_to', p ->> 'outside_vendor') is not null and status = 'new' then 'assigned' else status end),
         assigned_to = case when p ? 'assigned_to' then nullif(p ->> 'assigned_to', '')::uuid else assigned_to end,
         outside_vendor = case when p ? 'outside_vendor' then nullif(p ->> 'outside_vendor', '') else outside_vendor end,
         purchase_request_id = case when p ? 'purchase_request_id' then nullif(p ->> 'purchase_request_id', '')::uuid else purchase_request_id end,
         priority = coalesce(nullif(p ->> 'priority', ''), priority),
         closed_by = case when v_status = 'cancelled' then auth.uid() else closed_by end, closed_at = case when v_status = 'cancelled' then now() else closed_at end,
         updated_at = now()
  where id = r.id;
  v_res := jsonb_build_object('id', r.id, 'status', (select status from prod.repair_requests where id = r.id));
  return app.request_done(p_client_request_id, 'update_repair_request', v_res);
end $$;

-- Done: downtime is computed from the breakdown and restore times; the machine runs again when nothing else holds it.
-- p: {restored_at, resolution, labour_cost, outside_cost}
create or replace function api.close_repair_request(p_client_request_id uuid, p_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; r prod.repair_requests; v_at timestamptz := coalesce(nullif(p ->> 'restored_at', '')::timestamptz, now()); v_mins numeric;
begin
  v_prev := app.request_seen(p_client_request_id, 'close_repair_request'); if v_prev is not null then return v_prev; end if;
  select * into r from prod.repair_requests where id = p_request_id for update;
  if r.id is null then perform app.raise_rule('repair.missing', 'repair request not found', 'P0002'); end if;
  perform app.require(r.company_id, 'assets.manage');
  if r.status in ('done', 'cancelled') then perform app.raise_rule('repair.closed', 'this request is closed', '22023'); end if;
  if coalesce(length(trim(p ->> 'resolution')), 0) = 0 then perform app.raise_rule('repair.resolution', 'say what was done', '22023'); end if;
  if v_at > now() + interval '5 minutes' then perform app.raise_rule('date.future', 'the restore time is in the future', '22023'); end if;
  if r.is_breakdown and r.broke_down_at is not null then
    if v_at < r.broke_down_at then perform app.raise_rule('repair.restore_before_breakdown', 'the machine cannot run again before it broke down', '22023'); end if;
    v_mins := round(extract(epoch from (v_at - r.broke_down_at)) / 60.0, 2);
  end if;
  update prod.repair_requests set status = 'done', restored_at = case when r.is_breakdown then v_at end, downtime_minutes = v_mins, resolution = trim(p ->> 'resolution'),
         labour_cost = nullif(p ->> 'labour_cost', '')::numeric, outside_cost = nullif(p ->> 'outside_cost', '')::numeric,
         closed_by = auth.uid(), closed_at = now(), updated_at = now()
  where id = r.id;
  if r.asset_id is not null then
    if not exists (select 1 from prod.repair_requests x where x.asset_id = r.asset_id and x.id <> r.id and x.is_breakdown and x.status not in ('done', 'cancelled')) then
      update core.assets set status = 'active' where id = r.asset_id and status = 'repair';
    end if;
    insert into core.asset_events (company_id, asset_id, kind, event_date, detail, amount, recorded_by)
    values (r.company_id, r.asset_id, case when r.is_breakdown then 'restored' else 'repair' end, (v_at at time zone 'Asia/Kolkata')::date,
            jsonb_build_object('repair_request_id', r.id, 'downtime_minutes', v_mins), nullif(coalesce(nullif(p ->> 'labour_cost', '')::numeric, 0) + coalesce(nullif(p ->> 'outside_cost', '')::numeric, 0), 0),
            auth.uid());
  end if;
  v_res := jsonb_build_object('id', r.id, 'status', 'done', 'downtime_minutes', v_mins);
  return app.request_done(p_client_request_id, 'close_repair_request', v_res);
end $$;

-- Spares and oil out of the stores for a machine (and its repair request), through the stock ledger.
-- p: {company_id, repair_request_id?, asset_id?, place_id, issued_on, lines: [{product_id, qty, lot_id?}]}
create or replace function api.issue_spares(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_company uuid := nullif(p ->> 'company_id', '')::uuid; r prod.repair_requests; v_asset uuid := nullif(p ->> 'asset_id', '')::uuid;
        v_place uuid := nullif(p ->> 'place_id', '')::uuid; v_date date := coalesce(nullif(p ->> 'issued_on', '')::date, current_date); v_no text; l jsonb; v_taken jsonb;
        v_val numeric; v_total numeric := 0; v_qty numeric;
begin
  v_prev := app.request_seen(p_client_request_id, 'issue_spares'); if v_prev is not null then return v_prev; end if;
  if nullif(p ->> 'repair_request_id', '') is not null then
    select * into r from prod.repair_requests where id = (p ->> 'repair_request_id')::uuid for update;
    if r.id is null then perform app.raise_rule('repair.missing', 'repair request not found', 'P0002'); end if;
    if r.status in ('done', 'cancelled') then perform app.raise_rule('repair.closed', 'this request is closed', '22023'); end if;
    v_company := r.company_id; v_asset := coalesce(v_asset, r.asset_id);
  end if;
  perform app.require(v_company, 'assets.manage');
  if v_asset is not null and not exists (select 1 from core.assets where id = v_asset and company_id = v_company) then perform app.raise_rule('asset.missing', 'choose a machine of this company', '22023'); end if;
  if jsonb_typeof(p -> 'lines') <> 'array' or jsonb_array_length(p -> 'lines') = 0 then perform app.raise_rule('spares.no_lines', 'add the spares or oil issued', '22023'); end if;
  perform app.check_stock_date(v_company, v_date);
  v_no := app.p7_doc_no(v_company, 'spares_issue', v_date);
  for l in select * from jsonb_array_elements(p -> 'lines') loop
    v_qty := round((l ->> 'qty')::numeric, 3);
    v_taken := app.stock_take(v_company, (l ->> 'product_id')::uuid, nullif(l ->> 'lot_id', '')::uuid, v_place, 'available', v_qty, 'issue', 'prod.spares_issues', null, v_no, v_date,
                              'Spares for maintenance');
    select coalesce(sum((x ->> 'qty')::numeric * coalesce((x ->> 'unit_cost')::numeric, 0)), 0) into v_val from jsonb_array_elements(v_taken) x;
    insert into prod.spares_issues (company_id, doc_no, repair_request_id, asset_id, product_id, place_id, qty, value, issued_on, issued_by)
    values (v_company, v_no, r.id, v_asset, (l ->> 'product_id')::uuid, v_place, v_qty, round(v_val, 2), v_date, auth.uid());
    v_total := v_total + round(v_val, 2);
  end loop;
  if r.id is not null and r.status = 'waiting_parts' then update prod.repair_requests set status = 'assigned', updated_at = now() where id = r.id; end if;
  v_res := jsonb_build_object('doc_no', v_no, 'value', v_total);
  return app.request_done(p_client_request_id, 'issue_spares', v_res);
end $$;

-- p: {id?, asset_id, title, interval_days, next_due_on, checklist, active}
create or replace function api.upsert_maintenance_schedule(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; a core.assets; s prod.maintenance_schedules;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_maintenance_schedule'); if v_prev is not null then return v_prev; end if;
  if v_id is not null then
    select * into s from prod.maintenance_schedules where id = v_id for update;
    if s.id is null then perform app.raise_rule('schedule.missing', 'schedule not found', 'P0002'); end if;
  end if;
  select * into a from core.assets where id = coalesce(nullif(p ->> 'asset_id', '')::uuid, s.asset_id);
  if a.id is null then perform app.raise_rule('asset.missing', 'choose the machine', '22023'); end if;
  perform app.require(a.company_id, 'assets.manage');
  if coalesce(length(trim(p ->> 'title')), 0) = 0 then perform app.raise_rule('schedule.title', 'name the service (oil change, heater check …)', '22023'); end if;
  if coalesce((p ->> 'interval_days')::int, 0) <= 0 then perform app.raise_rule('schedule.interval', 'enter how often, in days', '22023'); end if;
  if v_id is null then
    insert into prod.maintenance_schedules (company_id, asset_id, title, interval_days, checklist, next_due_on, active, created_by)
    values (a.company_id, a.id, trim(p ->> 'title'), (p ->> 'interval_days')::int, coalesce(p -> 'checklist', '[]'::jsonb),
            coalesce(nullif(p ->> 'next_due_on', '')::date, current_date + (p ->> 'interval_days')::int), coalesce((p ->> 'active')::boolean, true), auth.uid())
    returning id into v_id;
  else
    update prod.maintenance_schedules set title = trim(p ->> 'title'), interval_days = (p ->> 'interval_days')::int, checklist = coalesce(p -> 'checklist', checklist),
           next_due_on = coalesce(nullif(p ->> 'next_due_on', '')::date, next_due_on), active = coalesce((p ->> 'active')::boolean, active), updated_at = now()
    where id = v_id;
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_maintenance_schedule', v_res);
end $$;

-- p: {done_on, note, cost}
create or replace function api.record_maintenance_done(p_client_request_id uuid, p_schedule_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; s prod.maintenance_schedules; v_date date := coalesce(nullif(p ->> 'done_on', '')::date, current_date); v_next date;
begin
  v_prev := app.request_seen(p_client_request_id, 'record_maintenance_done'); if v_prev is not null then return v_prev; end if;
  select * into s from prod.maintenance_schedules where id = p_schedule_id for update;
  if s.id is null then perform app.raise_rule('schedule.missing', 'schedule not found', 'P0002'); end if;
  if not app.can(s.company_id, 'assets.manage') then perform app.require(s.company_id, 'production.create'); end if;
  if not s.active then perform app.raise_rule('schedule.inactive', 'this schedule is switched off', '22023'); end if;
  if v_date > current_date then perform app.raise_rule('date.future', 'the date is in the future', '22023'); end if;
  v_next := v_date + s.interval_days;
  insert into prod.maintenance_logs (company_id, schedule_id, asset_id, done_on, note, cost, done_by)
  values (s.company_id, s.id, s.asset_id, v_date, nullif(p ->> 'note', ''), nullif(p ->> 'cost', '')::numeric, auth.uid());
  update prod.maintenance_schedules set last_done_on = v_date, next_due_on = v_next, updated_at = now() where id = s.id;
  insert into core.asset_events (company_id, asset_id, kind, event_date, detail, amount, recorded_by)
  values (s.company_id, s.asset_id, 'service', v_date, jsonb_build_object('schedule_id', s.id, 'title', s.title), nullif(p ->> 'cost', '')::numeric, auth.uid());
  v_res := jsonb_build_object('id', s.id, 'next_due_on', v_next);
  return app.request_done(p_client_request_id, 'record_maintenance_done', v_res);
end $$;

-- A ✗ on the operator's daily check opens a repair request for the machine (once per check).
create or replace function app.machine_check_repair() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_no text; v_items text;
begin
  if new.all_ok then return new; end if;
  select string_agg(x ->> 'item', ', ') into v_items from jsonb_array_elements(new.checklist) x where not coalesce((x ->> 'ok')::boolean, false);
  begin
    v_no := app.p7_doc_no(new.company_id, 'repair_request', new.check_date);
  exception when others then v_no := null;   -- no FY open: the request still opens, numbered later by Admin
  end;
  insert into prod.repair_requests (company_id, doc_no, asset_id, source, machine_check_id, title, description, priority, is_breakdown, broke_down_at, raised_by)
  values (new.company_id, v_no, new.asset_id, 'operator_check', new.id, left('Daily check failed: ' || coalesce(v_items, 'see checklist'), 200), new.remarks, 'urgent',
          true, now(), new.checked_by)
  on conflict (machine_check_id) do nothing;
  return new;
end $$;
create trigger machine_check_repair after insert on prod.machine_checks for each row execute function app.machine_check_repair();

-- ─────────── Asset register: depreciation (CA settings only) and disposals ───────────
-- Settings the CA sets (Admin records them on Settings): depreciation.method = "slm" | "wdv"; useful lives by asset kind
-- in depreciation.useful_life_years ({kind: years}) unless the asset carries its own; residual % in
-- depreciation.residual_pct unless the asset carries its own (needed > 0 for WDV). Nothing is assumed when unset.
create or replace function app.depreciation_readiness(p_company uuid, p_on date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_method text := app.setting(p_company, 'depreciation.method', p_on) #>> '{}'; v_lives jsonb := app.setting(p_company, 'depreciation.useful_life_years', p_on);
        v_res numeric := nullif(app.setting(p_company, 'depreciation.residual_pct', p_on) #>> '{}', '')::numeric; v_missing jsonb; v_no_dates jsonb; v_no_res jsonb;
begin
  select coalesce(jsonb_agg(a.code order by a.code), '[]'::jsonb) into v_missing from core.assets a
   where a.company_id = p_company and a.cost > 0 and a.status <> 'disposed' and coalesce(a.useful_life_years, nullif(v_lives ->> a.kind, '')::numeric) is null;
  select coalesce(jsonb_agg(a.code order by a.code), '[]'::jsonb) into v_no_dates from core.assets a
   where a.company_id = p_company and a.cost > 0 and a.status <> 'disposed' and coalesce(a.put_to_use_date, a.purchase_date) is null;
  select coalesce(jsonb_agg(a.code order by a.code), '[]'::jsonb) into v_no_res from core.assets a
   where a.company_id = p_company and a.cost > 0 and a.status <> 'disposed' and coalesce(a.residual_pct, v_res, 0) <= 0;
  return jsonb_build_object('method', v_method, 'useful_life_years', v_lives, 'residual_pct', v_res, 'assets_without_life', v_missing, 'assets_without_dates', v_no_dates,
                            'assets_without_residual', v_no_res,
                            'ready', v_method in ('slm', 'wdv') and jsonb_array_length(v_missing) = 0 and jsonb_array_length(v_no_dates) = 0
                                     and (v_method = 'slm' or jsonb_array_length(v_no_res) = 0));
end $$;

create or replace function api.depreciation_readiness(p_company_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (app.can(p_company_id, 'accounts.view') or app.can(p_company_id, 'assets.view')) then perform app.require(p_company_id, 'accounts.view'); end if;
  return app.depreciation_readiness(p_company_id, current_date);
end $$;

-- One run per company and month: pro-rata by days in use (Schedule II), capped at cost less residual; posted as one journal
-- (Dr depreciation.expense, Cr depreciation.accumulated) through app.post_voucher, dated the last day of the month.
create or replace function api.run_depreciation(p_client_request_id uuid, p_company_id uuid, p_period_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_res jsonb; per core.periods; v_end date; v_ready jsonb; v_method text; v_lives jsonb; v_resp numeric; a record; v_life numeric; v_rpct numeric;
  v_resid numeric; v_acc numeric; v_start date; v_stop date; v_days int; v_fydays int; v_amt numeric; v_rate numeric; v_total numeric := 0; v_run uuid; v_fy uuid;
  v_no text; v_voucher uuid; fy core.financial_years; v_skipped jsonb := '[]'::jsonb; v_lines int := 0;
begin
  v_prev := app.request_seen(p_client_request_id, 'run_depreciation'); if v_prev is not null then return v_prev; end if;
  perform app.require(p_company_id, 'accounts.create');
  select * into per from core.periods where id = p_period_id and company_id = p_company_id for update;
  if per.id is null then perform app.raise_rule('period.missing', 'month not found for this company', 'P0002'); end if;
  v_end := (per.month_start + interval '1 month' - interval '1 day')::date;
  if per.status = 'closed' then perform app.raise_rule('period.closed', 'this month is closed; nothing can be posted into it', '42501'); end if;
  if v_end > current_date then perform app.raise_rule('depreciation.period_not_ended', 'depreciation for a month is run after the month ends', '22023'); end if;
  if exists (select 1 from acct.depreciation_runs where company_id = p_company_id and period_id = per.id and status = 'posted') then
    perform app.raise_rule('depreciation.already_run', 'depreciation for this month is already posted', '22023');
  end if;
  v_ready := app.depreciation_readiness(p_company_id, v_end);
  v_method := v_ready ->> 'method';
  if v_method is null or v_method not in ('slm', 'wdv') then
    perform app.raise_rule('depreciation.settings_missing', 'the depreciation method (Schedule II) is not set; the CA decides it and Admin records it on Settings', '22023');
  end if;
  if jsonb_array_length(v_ready -> 'assets_without_life') > 0 then
    perform app.raise_rule('depreciation.life_not_set', 'useful life is not set for ' || (select string_agg(x, ', ') from (select jsonb_array_elements_text(v_ready -> 'assets_without_life') x limit 10) s)
                           || '; the CA sets lives (Schedule II) and Admin records them', '22023');
  end if;
  if jsonb_array_length(v_ready -> 'assets_without_dates') > 0 then
    perform app.raise_rule('depreciation.asset_dates_missing', 'enter the put-to-use or purchase date for ' || (select string_agg(x, ', ') from (select jsonb_array_elements_text(v_ready -> 'assets_without_dates') x limit 10) s), '22023');
  end if;
  if v_method = 'wdv' and jsonb_array_length(v_ready -> 'assets_without_residual') > 0 then
    perform app.raise_rule('depreciation.residual_not_set', 'the written-down-value method needs a residual value; the CA sets it for '
                           || (select string_agg(x, ', ') from (select jsonb_array_elements_text(v_ready -> 'assets_without_residual') x limit 10) s), '22023');
  end if;
  v_fy := app.fy_for(p_company_id, v_end);
  select * into fy from core.financial_years where id = v_fy;
  v_fydays := fy.ends_on - fy.starts_on + 1;
  v_lives := v_ready -> 'useful_life_years'; v_resp := nullif(v_ready ->> 'residual_pct', '')::numeric;
  insert into acct.depreciation_runs (company_id, period_id, method, run_by) values (p_company_id, per.id, v_method, auth.uid()) returning id into v_run;
  for a in select * from core.assets x where x.company_id = p_company_id and x.cost > 0 and coalesce(x.put_to_use_date, x.purchase_date) <= v_end
              and (x.disposed_on is null or x.disposed_on > per.month_start) order by x.code for update loop
    v_life := coalesce(a.useful_life_years, nullif(v_lives ->> a.kind, '')::numeric);
    v_rpct := coalesce(a.residual_pct, v_resp, 0);
    v_resid := round(a.cost * v_rpct / 100, 2);
    select coalesce(sum(dl.amount), 0) into v_acc from acct.depreciation_lines dl join acct.depreciation_runs dr on dr.id = dl.run_id and dr.status = 'posted' where dl.asset_id = a.id;
    v_start := greatest(per.month_start, coalesce(a.put_to_use_date, a.purchase_date));
    v_stop := least(v_end, coalesce(a.disposed_on - 1, v_end));
    v_days := v_stop - v_start + 1;
    if v_days <= 0 or a.cost - v_resid - v_acc <= 0 then
      v_skipped := v_skipped || jsonb_build_object('asset', a.code, 'reason', case when v_days <= 0 then 'not in use this month' else 'fully depreciated' end);
      continue;
    end if;
    if v_method = 'slm' then
      v_amt := round((a.cost - v_resid) / v_life * v_days / v_fydays, 2);
    else
      v_rate := 1 - power(v_rpct / 100, 1 / v_life);
      v_amt := round((a.cost - v_acc) * v_rate * v_days / v_fydays, 2);
    end if;
    v_amt := least(v_amt, a.cost - v_resid - v_acc);
    if v_amt <= 0 then continue; end if;
    insert into acct.depreciation_lines (run_id, company_id, asset_id, cost, residual, useful_life_years, opening_wdv, days, amount, closing_wdv)
    values (v_run, p_company_id, a.id, a.cost, v_resid, v_life, a.cost - v_acc, v_days, v_amt, a.cost - v_acc - v_amt);
    v_total := v_total + v_amt; v_lines := v_lines + 1;
  end loop;
  if v_total > 0 then
    v_no := app.take_doc_number(p_company_id, null, 'journal', v_fy);
    v_voucher := app.post_voucher(jsonb_build_object('company_id', p_company_id, 'fy_id', v_fy, 'voucher_type', 'journal', 'doc_no', v_no, 'voucher_date', v_end,
                   'narration', 'Depreciation for ' || to_char(per.month_start, 'MM-YYYY') || ' (' || upper(v_method) || ', CA settings)', 'client_request_id', p_client_request_id,
                   'source_table', 'acct.depreciation_runs', 'source_id', v_run),
                 jsonb_build_array(jsonb_build_object('account_id', app.rule_account(p_company_id, 'depreciation.expense'), 'dr', v_total, 'narration', 'Depreciation'),
                                   jsonb_build_object('account_id', app.rule_account(p_company_id, 'depreciation.accumulated'), 'cr', v_total, 'narration', 'Accumulated depreciation')));
  end if;
  update acct.depreciation_runs set total = v_total, voucher_id = v_voucher where id = v_run;
  v_res := jsonb_build_object('run_id', v_run, 'method', v_method, 'total', v_total, 'assets', v_lines, 'voucher_id', v_voucher, 'doc_no', v_no, 'skipped', v_skipped);
  return app.request_done(p_client_request_id, 'run_depreciation', v_res);
end $$;

-- Disposal (book entry; the sale itself is billed through Sales with GST): Dr accumulated depreciation, Dr proceeds account,
-- Cr asset cost, gain or loss to asset.disposal_gain_loss. p: {disposal_date, proceeds, proceeds_account_id, reason}
create or replace function api.dispose_asset(p_client_request_id uuid, p_asset_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; a core.assets; v_date date := coalesce(nullif(p ->> 'disposal_date', '')::date, current_date); v_proceeds numeric := round(coalesce(nullif(p ->> 'proceeds', '')::numeric, 0), 2);
        v_acct uuid := nullif(p ->> 'proceeds_account_id', '')::uuid; v_acc numeric; v_wdv numeric; v_gl numeric; v_fy uuid; v_no text; v_voucher uuid; v_lines jsonb; v_id uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'dispose_asset'); if v_prev is not null then return v_prev; end if;
  select * into a from core.assets where id = p_asset_id for update;
  if a.id is null then perform app.raise_rule('asset.missing', 'asset not found', 'P0002'); end if;
  perform app.require(a.company_id, 'accounts.create');
  if a.status = 'disposed' then perform app.raise_rule('asset.disposed', 'this asset is already disposed of', '22023'); end if;
  if a.cost is null then perform app.raise_rule('asset.no_cost', 'the asset has no cost in the register; enter it before disposal', '22023'); end if;
  if coalesce(length(trim(p ->> 'reason')), 0) < 5 then perform app.raise_rule('asset.disposal_reason', 'give the reason (sold, scrapped, lost …)', '22023'); end if;
  if v_proceeds < 0 then perform app.raise_rule('asset.proceeds', 'proceeds cannot be negative', '22023'); end if;
  if v_proceeds > 0 and (v_acct is null or not exists (select 1 from acct.accounts where id = v_acct and company_id = a.company_id)) then
    perform app.raise_rule('asset.proceeds_account', 'choose the account the money went to (bank or the buyer)', '22023');
  end if;
  perform app.check_backdate(a.company_id, v_date);
  v_fy := app.fy_for(a.company_id, v_date);
  select coalesce(sum(dl.amount), 0) into v_acc from acct.depreciation_lines dl join acct.depreciation_runs dr on dr.id = dl.run_id and dr.status = 'posted' where dl.asset_id = a.id;
  v_wdv := a.cost - v_acc; v_gl := v_proceeds - v_wdv;
  v_lines := jsonb_build_array(jsonb_build_object('account_id', app.rule_account(a.company_id, 'asset.cost'), 'cr', a.cost, 'narration', 'Asset ' || a.code || ' cost'));
  if v_acc > 0 then v_lines := v_lines || jsonb_build_object('account_id', app.rule_account(a.company_id, 'depreciation.accumulated'), 'dr', v_acc, 'narration', 'Accumulated depreciation'); end if;
  if v_proceeds > 0 then v_lines := v_lines || jsonb_build_object('account_id', v_acct, 'dr', v_proceeds, 'narration', 'Disposal proceeds'); end if;
  if v_gl > 0 then v_lines := v_lines || jsonb_build_object('account_id', app.rule_account(a.company_id, 'asset.disposal_gain_loss'), 'cr', v_gl, 'narration', 'Gain on disposal');
  elsif v_gl < 0 then v_lines := v_lines || jsonb_build_object('account_id', app.rule_account(a.company_id, 'asset.disposal_gain_loss'), 'dr', -v_gl, 'narration', 'Loss on disposal'); end if;
  v_no := app.take_doc_number(a.company_id, null, 'journal', v_fy);
  v_voucher := app.post_voucher(jsonb_build_object('company_id', a.company_id, 'fy_id', v_fy, 'voucher_type', 'journal', 'doc_no', v_no, 'voucher_date', v_date,
                 'narration', 'Disposal of asset ' || a.code || ': ' || trim(p ->> 'reason'), 'client_request_id', p_client_request_id, 'source_table', 'core.asset_disposals'), v_lines);
  insert into core.asset_disposals (company_id, asset_id, disposal_date, proceeds, cost, accumulated_depreciation, wdv, gain_loss, reason, voucher_id, disposed_by)
  values (a.company_id, a.id, v_date, v_proceeds, a.cost, v_acc, v_wdv, v_gl, trim(p ->> 'reason'), v_voucher, auth.uid()) returning id into v_id;
  update core.assets set status = 'disposed', disposed_on = v_date where id = a.id;
  insert into core.asset_events (company_id, asset_id, kind, event_date, detail, amount, recorded_by)
  values (a.company_id, a.id, 'disposed', v_date, jsonb_build_object('disposal_id', v_id, 'reason', trim(p ->> 'reason')), nullif(v_proceeds, 0), auth.uid());
  v_res := jsonb_build_object('id', v_id, 'voucher_id', v_voucher, 'doc_no', v_no, 'wdv', v_wdv, 'gain_loss', v_gl);
  return app.request_done(p_client_request_id, 'dispose_asset', v_res);
end $$;

revoke all on all functions in schema api from public, anon;
grant execute on all functions in schema api to authenticated;
grant execute on function api.log_sign_in_failure(text) to anon;
revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;

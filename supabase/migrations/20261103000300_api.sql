-- 20261103000300_api.sql
-- Phase 1 Data API: read views (security_invoker, so RLS on core/audit/ops decides the rows) and the
-- RPCs that change data. Every RPC is security definer with search_path '', checks rights via app.require,
-- takes a client_request_id for idempotency, writes history (triggers) and the user log in one transaction.

-- ─────────────────────────────── Read views ───────────────────────────────
create or replace view api.companies with (security_invoker = true) as
select c.id, c.code, c.legal_name as name, c.short_name, c.pan, c.cin, c.registered_address, c.logo_key, c.status,
       (select count(*) from core.gstins g where g.company_id = c.id and g.status = 'active')::int as gstin_count,
       (select count(*) from core.branches b where b.company_id = c.id and b.status = 'active')::int as branch_count,
       c.created_at
from core.companies c;

create or replace view api.gstins with (security_invoker = true) as
select g.id, g.company_id, c.short_name as company_name, g.gstin, g.state_code, g.legal_name, g.trade_name,
       g.registered_on, g.is_principal, g.einvoice_enabled, g.status
from core.gstins g join core.companies c on c.id = g.company_id;

create or replace view api.branches with (security_invoker = true) as
select b.id, b.company_id, c.short_name as company_name, b.gstin_id, g.gstin, b.code, b.name, b.kind, b.address, b.status,
       (select count(*) from core.places p where p.branch_id = b.id and p.status = 'active')::int as place_count
from core.branches b join core.companies c on c.id = b.company_id left join core.gstins g on g.id = b.gstin_id;

create or replace view api.places with (security_invoker = true) as
select p.id, p.company_id, c.short_name as company_name, p.branch_id, b.name as branch_name, p.code, p.name, p.kind, p.status
from core.places p join core.branches b on b.id = p.branch_id join core.companies c on c.id = p.company_id;

create or replace view api.departments with (security_invoker = true) as
select d.id, d.company_id, d.name, d.status from core.departments d;

create or replace view api.financial_years with (security_invoker = true) as
select f.id, f.company_id, f.label, f.starts_on, f.ends_on, f.status,
       (select count(*) from core.periods p where p.fy_id = f.id and p.status = 'closed')::int as closed_periods
from core.financial_years f;

create or replace view api.roles with (security_invoker = true) as
select r.key, r.label, r.view_kind, r.sign_in, r.mfa_required, r.sort,
       coalesce((select array_agg(rr.right_key order by rr.right_key) from core.role_rights rr where rr.role_key = r.key), '{}') as rights
from core.roles r;

create or replace view api.rights with (security_invoker = true) as
select key, module, action, label, hint, kind, admin_only, never_grantable, grantable_by_permission, sort from core.rights;

create or replace view api.special_grants with (security_invoker = true) as
select g.id, g.code, g.user_id, p.display_name as user_name, g.right_key, r.label as right_label, g.company_id, c.short_name as company_name,
       g.params, g.starts_at, g.ends_at, g.max_uses, g.uses, g.reason, g.granted_by, gp.display_name as granted_by_name, g.granted_at,
       g.revoked_at, g.revoke_reason,
       case
         when g.revoked_at is not null then 'stopped'
         when now() < g.starts_at then 'scheduled'
         when now() >= g.ends_at or (g.max_uses is not null and g.uses >= g.max_uses) then 'ended'
         else 'running'
       end as state
from core.special_grants g
join core.rights r on r.key = g.right_key
left join core.user_profiles p on p.user_id = g.user_id
left join core.user_profiles gp on gp.user_id = g.granted_by
left join core.companies c on c.id = g.company_id;

create or replace view api.special_grant_requests with (security_invoker = true) as
select q.id, q.requested_by, p.display_name as requested_by_name, q.right_key, r.label as right_label, q.company_id, q.params,
       q.wanted_from, q.wanted_to, q.reason, q.status, q.decided_by, q.decided_at, q.grant_id, q.created_at
from core.special_grant_requests q join core.rights r on r.key = q.right_key left join core.user_profiles p on p.user_id = q.requested_by;

create or replace view api.user_log with (security_invoker = true) as
select l.id, l.user_id, p.display_name as user_name, l.event, l.detail, l.grant_id, g.code as grant_code, l.at
from audit.user_log l left join core.user_profiles p on p.user_id = l.user_id left join core.special_grants g on g.id = l.grant_id;

create or replace view api.transaction_log with (security_invoker = true) as
select h.id, h.table_name, h.row_pk, h.op, h.before, h.after, h.actor, p.display_name as actor_name, h.grant_id, g.code as grant_code,
       h.request_id, h.at
from audit.row_history h left join core.user_profiles p on p.user_id = h.actor left join core.special_grants g on g.id = h.grant_id;

create or replace view api.error_log with (security_invoker = true) as
select e.ref, e.user_id, e.route, e.rpc, e.rule_code, e.message, e.at from ops.error_log e;

create or replace view api.settings_current with (security_invoker = true) as
select distinct on (s.company_id, s.key) s.id, s.company_id, s.key, s.value, s.effective_from, s.note, s.set_by, s.set_at
from core.settings s
where s.effective_from <= current_date
order by s.company_id, s.key, s.effective_from desc, s.set_at desc;

create or replace view api.settings_history with (security_invoker = true) as
select s.id, s.company_id, s.key, s.value, s.effective_from, s.note, s.set_by, p.display_name as set_by_name, s.set_at
from core.settings s left join core.user_profiles p on p.user_id = s.set_by;

create or replace view api.doc_types with (security_invoker = true) as
select key, label, gst_document, max_number_length, sort from core.doc_types;

create or replace view api.doc_series with (security_invoker = true) as
select s.id, s.company_id, c.short_name as company_name, s.gstin_id, g.gstin, s.doc_type, t.label as doc_type_label, s.fy_id, f.label as fy_label,
       s.prefix, s.pad, s.next_no, s.status,
       s.prefix || '/' || substr(f.label, 3, 2) || '-' || substr(f.label, 6, 2) || '/' || lpad(s.next_no::text, s.pad, '0') as next_number,
       length(s.prefix || '/' || substr(f.label, 3, 2) || '-' || substr(f.label, 6, 2) || '/' || lpad(s.next_no::text, s.pad, '0')) <= t.max_number_length as fits_limit
from core.doc_series s
join core.companies c on c.id = s.company_id
join core.doc_types t on t.key = s.doc_type
join core.financial_years f on f.id = s.fy_id
left join core.gstins g on g.id = s.gstin_id;

create or replace view api.forms with (security_invoker = true) as
select f.key, f.label, f.module, (select count(*) from core.form_fields x where x.form_key = f.key and x.active)::int as field_count from core.forms f;

create or replace view api.form_fields with (security_invoker = true) as
select id, form_key, company_id, field_key, label, field_type, required, options, sort, active from core.form_fields;

create or replace view api.law_rules with (security_invoker = true) as
select code, area, rule, what_erp_does, enforced_in, test_ref, status, phase, sort from core.law_rules;

grant select on all tables in schema api to authenticated;

-- ─────────────────────────────── Me ───────────────────────────────
create or replace function api.me() returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when auth.uid() is null then null else jsonb_build_object(
    'user_id', auth.uid(),
    'display_name', p.display_name,
    'person_code', p.person_code,
    'language', p.language,
    'status', p.status,
    'view', app.current_view(),
    'roles', coalesce((select jsonb_agg(jsonb_build_object('role', ur.role_key, 'label', r.label, 'company_id', ur.company_id, 'valid_to', ur.valid_to) order by r.sort)
                       from core.user_roles ur join core.roles r on r.key = ur.role_key
                       where ur.user_id = auth.uid() and ur.valid_from <= now() and (ur.valid_to is null or ur.valid_to > now())), '[]'::jsonb),
    'rights', case when app.current_view() = 'all' then '["*"]'::jsonb
                   else coalesce((select jsonb_agg(distinct rr.right_key) from app.my_roles() m join core.role_rights rr on rr.role_key = m.role_key), '[]'::jsonb)
                        || case when app.current_view() = 'all-readonly' then '["*.view","*.export"]'::jsonb else '[]'::jsonb end end,
    'grants', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'code', g.code, 'right', g.right_key, 'label', r2.label, 'company_id', g.company_id,
                                                            'params', g.params, 'ends_at', g.ends_at))
                        from core.special_grants g join core.rights r2 on r2.key = g.right_key
                        where g.user_id = auth.uid() and g.revoked_at is null and now() >= g.starts_at and now() < g.ends_at
                          and (g.max_uses is null or g.uses < g.max_uses)), '[]'::jsonb),
    'read_only_until', (select min(ur.valid_to) from core.user_roles ur join core.roles r on r.key = ur.role_key
                        where ur.user_id = auth.uid() and r.view_kind = 'all-readonly' and ur.valid_to > now())
  ) end
  from (select 1) x left join core.user_profiles p on p.user_id = auth.uid()
$$;

-- ─────────────────────────────── Group structure RPCs ───────────────────────────────
create or replace function api.upsert_company(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_company');
  if v_prev is not null then return v_prev; end if;
  perform app.require(v_id, 'org.manage');
  if v_id is null then
    insert into core.companies (code, legal_name, short_name, pan, cin, registered_address, logo_key, created_by)
    values (upper(p ->> 'code'), p ->> 'legal_name', coalesce(nullif(p ->> 'short_name', ''), p ->> 'legal_name'), nullif(upper(p ->> 'pan'), ''),
            nullif(p ->> 'cin', ''), nullif(p ->> 'registered_address', ''), nullif(p ->> 'logo_key', ''), auth.uid())
    returning id into v_id;
  else
    perform 1 from core.companies where id = v_id for update;
    if not found then raise exception 'not_found: company' using errcode = 'P0002', hint = 'org.company_missing'; end if;
    update core.companies set
      legal_name = coalesce(p ->> 'legal_name', legal_name),
      short_name = coalesce(p ->> 'short_name', short_name),
      pan = case when p ? 'pan' then nullif(upper(p ->> 'pan'), '') else pan end,
      cin = case when p ? 'cin' then nullif(p ->> 'cin', '') else cin end,
      registered_address = case when p ? 'registered_address' then nullif(p ->> 'registered_address', '') else registered_address end,
      logo_key = case when p ? 'logo_key' then nullif(p ->> 'logo_key', '') else logo_key end,
      status = coalesce(p ->> 'status', status)
    where id = v_id;
  end if;
  perform app.log_event('org_changed', jsonb_build_object('entity', 'company', 'id', v_id));
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_company', v_res);
end $$;

create or replace function api.upsert_gstin(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_company uuid := (p ->> 'company_id')::uuid; v_res jsonb; v_gstin text := upper(trim(p ->> 'gstin'));
        v_pan text;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_gstin');
  if v_prev is not null then return v_prev; end if;
  if v_id is not null then select company_id into v_company from core.gstins where id = v_id for update; end if;
  perform app.require(v_company, 'org.manage');
  -- The PAN inside a GSTIN (characters 3–12) must be the company's PAN when the PAN is recorded.
  select pan into v_pan from core.companies where id = v_company;
  if v_pan is not null and v_gstin is not null and substr(v_gstin, 3, 10) <> v_pan then
    raise exception 'gstin_pan_mismatch: GSTIN % does not carry PAN %', v_gstin, v_pan using errcode = '22023', hint = 'org.gstin_pan_mismatch';
  end if;
  if coalesce((p ->> 'is_principal')::boolean, false) then
    update core.gstins set is_principal = false where company_id = v_company and is_principal and id is distinct from v_id;
  end if;
  if v_id is null then
    insert into core.gstins (company_id, gstin, legal_name, trade_name, registered_on, is_principal, einvoice_enabled)
    values (v_company, v_gstin, nullif(p ->> 'legal_name', ''), nullif(p ->> 'trade_name', ''), nullif(p ->> 'registered_on', '')::date,
            coalesce((p ->> 'is_principal')::boolean, false), coalesce((p ->> 'einvoice_enabled')::boolean, false))
    returning id into v_id;
  else
    update core.gstins set
      legal_name = case when p ? 'legal_name' then nullif(p ->> 'legal_name', '') else legal_name end,
      trade_name = case when p ? 'trade_name' then nullif(p ->> 'trade_name', '') else trade_name end,
      registered_on = case when p ? 'registered_on' then nullif(p ->> 'registered_on', '')::date else registered_on end,
      is_principal = coalesce((p ->> 'is_principal')::boolean, is_principal),
      einvoice_enabled = coalesce((p ->> 'einvoice_enabled')::boolean, einvoice_enabled),
      status = coalesce(p ->> 'status', status)
    where id = v_id;
  end if;
  perform app.log_event('org_changed', jsonb_build_object('entity', 'gstin', 'id', v_id));
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_gstin', v_res);
end $$;

create or replace function api.upsert_branch(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_company uuid := (p ->> 'company_id')::uuid; v_gstin uuid := nullif(p ->> 'gstin_id', '')::uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_branch');
  if v_prev is not null then return v_prev; end if;
  if v_id is not null then select company_id into v_company from core.branches where id = v_id for update; end if;
  perform app.require(v_company, 'org.manage');
  if v_gstin is not null and not exists (select 1 from core.gstins where id = v_gstin and company_id = v_company) then
    raise exception 'gstin_other_company: the GSTIN belongs to another company' using errcode = '22023', hint = 'org.gstin_other_company';
  end if;
  if v_id is null then
    insert into core.branches (company_id, gstin_id, code, name, kind, address)
    values (v_company, v_gstin, upper(p ->> 'code'), p ->> 'name', p ->> 'kind', nullif(p ->> 'address', ''))
    returning id into v_id;
  else
    update core.branches set
      gstin_id = case when p ? 'gstin_id' then v_gstin else gstin_id end,
      name = coalesce(p ->> 'name', name), kind = coalesce(p ->> 'kind', kind),
      address = case when p ? 'address' then nullif(p ->> 'address', '') else address end,
      status = coalesce(p ->> 'status', status)
    where id = v_id;
  end if;
  perform app.log_event('org_changed', jsonb_build_object('entity', 'branch', 'id', v_id));
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_branch', v_res);
end $$;

create or replace function api.upsert_place(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_branch uuid := (p ->> 'branch_id')::uuid; v_company uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_place');
  if v_prev is not null then return v_prev; end if;
  if v_id is not null then select branch_id into v_branch from core.places where id = v_id for update; end if;
  select company_id into v_company from core.branches where id = v_branch;
  if v_company is null then raise exception 'not_found: branch' using errcode = 'P0002', hint = 'org.branch_missing'; end if;
  perform app.require(v_company, 'org.manage');
  if v_id is null then
    insert into core.places (company_id, branch_id, code, name, kind)
    values (v_company, v_branch, upper(p ->> 'code'), p ->> 'name', p ->> 'kind')
    returning id into v_id;
  else
    update core.places set name = coalesce(p ->> 'name', name), kind = coalesce(p ->> 'kind', kind), status = coalesce(p ->> 'status', status)
    where id = v_id;
  end if;
  perform app.log_event('org_changed', jsonb_build_object('entity', 'place', 'id', v_id));
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_place', v_res);
end $$;

create or replace function api.upsert_department(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_company uuid := nullif(p ->> 'company_id', '')::uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_department');
  if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'org.manage');
  if v_id is null then
    insert into core.departments (company_id, name) values (v_company, p ->> 'name') returning id into v_id;
  else
    update core.departments set name = coalesce(p ->> 'name', name), status = coalesce(p ->> 'status', status) where id = v_id;
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_department', v_res);
end $$;

-- Opens a financial year (April–March) with its 12 monthly periods.
create or replace function api.open_financial_year(p_client_request_id uuid, p_company_id uuid, p_start_year int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid; v_start date := make_date(p_start_year, 4, 1); v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'open_financial_year');
  if v_prev is not null then return v_prev; end if;
  perform app.require(p_company_id, 'settings.manage');
  insert into core.financial_years (company_id, label, starts_on, ends_on)
  values (p_company_id, p_start_year::text || '-' || lpad(((p_start_year + 1) % 100)::text, 2, '0'), v_start, (v_start + interval '1 year' - interval '1 day')::date)
  returning id into v_id;
  insert into core.periods (company_id, fy_id, month_start)
  select p_company_id, v_id, (v_start + (n || ' month')::interval)::date from generate_series(0, 11) n;
  perform app.log_event('setting_changed', jsonb_build_object('entity', 'financial_year', 'id', v_id));
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'open_financial_year', v_res);
end $$;

-- ─────────────────────────────── Users and rights RPCs ───────────────────────────────
create or replace function api.list_users() returns table (
  user_id uuid, display_name text, person_code text, language text, status text, sign_in_email text, sign_in_phone text,
  last_sign_in_at timestamptz, roles jsonb, active_grants int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.can(null, 'users.view') then
    raise exception 'no_right: users.view' using errcode = '42501', hint = 'rights.missing';
  end if;
  return query
  select p.user_id, p.display_name, p.person_code, p.language, p.status,
         u.email::text,
         case when u.phone is null or u.phone = '' then null else '••' || right(u.phone, 4) end,  -- phone masked (DPDP)
         u.last_sign_in_at,
         coalesce((select jsonb_agg(jsonb_build_object('id', ur.id, 'role', ur.role_key, 'label', r.label, 'company_id', ur.company_id, 'valid_to', ur.valid_to) order by r.sort)
                   from core.user_roles ur join core.roles r on r.key = ur.role_key where ur.user_id = p.user_id), '[]'::jsonb),
         (select count(*)::int from core.special_grants g where g.user_id = p.user_id and g.revoked_at is null and now() between g.starts_at and g.ends_at)
  from core.user_profiles p join auth.users u on u.id = p.user_id
  order by p.display_name;
end $$;

create or replace function api.update_user_profile(p_client_request_id uuid, p_user_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'update_user_profile');
  if v_prev is not null then return v_prev; end if;
  -- A user may change their own language; everything else needs users.manage.
  if not (p_user_id = auth.uid() and (select array_agg(k) from jsonb_object_keys(p) k) <@ array['language']) then
    perform app.require(null, 'users.manage');
  end if;
  if p_user_id = auth.uid() and p ->> 'status' = 'disabled' then
    raise exception 'self_disable: you cannot switch off your own account' using errcode = '22023', hint = 'users.self_disable';
  end if;
  perform 1 from core.user_profiles where user_id = p_user_id for update;
  update core.user_profiles set
    display_name = coalesce(nullif(trim(p ->> 'display_name'), ''), display_name),
    person_code = case when p ? 'person_code' then nullif(p ->> 'person_code', '') else person_code end,
    language = coalesce(p ->> 'language', language),
    status = coalesce(p ->> 'status', status)
  where user_id = p_user_id;
  perform app.log_event('user_changed', jsonb_build_object('user_id', p_user_id, 'fields', (select jsonb_agg(k) from jsonb_object_keys(p) k)));
  v_res := jsonb_build_object('user_id', p_user_id);
  return app.request_done(p_client_request_id, 'update_user_profile', v_res);
end $$;

create or replace function api.assign_role(p_client_request_id uuid, p_user_id uuid, p_role text, p_company_id uuid, p_valid_to timestamptz, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid; v_view text; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'assign_role');
  if v_prev is not null then return v_prev; end if;
  perform app.require(null, 'users.manage');
  if coalesce(length(trim(p_reason)), 0) < 5 then
    raise exception 'reason_required: say why this right changes' using errcode = '22023', hint = 'rights.reason_required';
  end if;
  select view_kind into v_view from core.roles where key = p_role;
  if v_view is null then raise exception 'not_found: role %', p_role using errcode = 'P0002', hint = 'rights.role_missing'; end if;
  if v_view = 'all-readonly' and p_valid_to is null then
    raise exception 'ca_needs_end: CA and auditor access needs an end date' using errcode = '22023', hint = 'rights.ca_needs_end';
  end if;
  insert into core.user_roles (user_id, role_key, company_id, valid_to, assigned_by)
  values (p_user_id, p_role, p_company_id, p_valid_to, auth.uid())
  on conflict (user_id, role_key, company_id) do update set valid_to = excluded.valid_to, assigned_by = excluded.assigned_by
  returning id into v_id;
  perform app.log_event('rights_changed', jsonb_build_object('user_id', p_user_id, 'role', p_role, 'company_id', p_company_id, 'valid_to', p_valid_to, 'reason', p_reason));
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'assign_role', v_res);
end $$;

create or replace function api.remove_role(p_client_request_id uuid, p_user_role_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; r core.user_roles; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'remove_role');
  if v_prev is not null then return v_prev; end if;
  perform app.require(null, 'users.manage');
  if coalesce(length(trim(p_reason)), 0) < 5 then
    raise exception 'reason_required: say why this right changes' using errcode = '22023', hint = 'rights.reason_required';
  end if;
  select * into r from core.user_roles where id = p_user_role_id for update;
  if not found then raise exception 'not_found: role assignment' using errcode = 'P0002'; end if;
  if r.user_id = auth.uid() and r.role_key in ('owner', 'admin') then
    raise exception 'self_demote: you cannot remove your own Admin role' using errcode = '22023', hint = 'rights.self_demote';
  end if;
  delete from core.user_roles where id = p_user_role_id;   -- recorded in row history by the audit trigger
  perform app.log_event('rights_changed', jsonb_build_object('user_id', r.user_id, 'removed_role', r.role_key, 'company_id', r.company_id, 'reason', p_reason));
  v_res := jsonb_build_object('id', p_user_role_id);
  return app.request_done(p_client_request_id, 'remove_role', v_res);
end $$;

-- Replace a role's module rights. Admin-only and never-grantable rights cannot be put on non-Admin roles.
create or replace function api.set_role_rights(p_client_request_id uuid, p_role text, p_rights text[], p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_bad text; v_res jsonb; v_view text;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_role_rights');
  if v_prev is not null then return v_prev; end if;
  perform app.require(null, 'users.manage');
  if coalesce(length(trim(p_reason)), 0) < 5 then
    raise exception 'reason_required: say why these rights change' using errcode = '22023', hint = 'rights.reason_required';
  end if;
  select view_kind into v_view from core.roles where key = p_role for update;
  if v_view is null then raise exception 'not_found: role %', p_role using errcode = 'P0002'; end if;
  if v_view <> 'gst' then
    raise exception 'role_fixed: % rights are fixed by its view', p_role using errcode = '22023', hint = 'rights.role_fixed';
  end if;
  select key into v_bad from core.rights where key = any (p_rights) and (admin_only or never_grantable) limit 1;
  if v_bad is not null then
    raise exception 'admin_only: % cannot be given to this role', v_bad using errcode = '42501', hint = 'rights.admin_only';
  end if;
  delete from core.role_rights where role_key = p_role and right_key <> all (p_rights);
  insert into core.role_rights (role_key, right_key) select p_role, unnest(p_rights) on conflict do nothing;
  perform app.log_event('rights_changed', jsonb_build_object('role', p_role, 'rights', to_jsonb(p_rights), 'reason', p_reason));
  v_res := jsonb_build_object('role', p_role, 'count', coalesce(array_length(p_rights, 1), 0));
  return app.request_done(p_client_request_id, 'set_role_rights', v_res);
end $$;

-- ─────────────────────────────── Special permissions ───────────────────────────────
create or replace function app.next_grant_code() returns text
language sql volatile security definer set search_path = '' as $$
  select 'SP-' || to_char(now() at time zone 'Asia/Kolkata', 'YYMMDD') || '-' || lpad((count(*) + 1)::text, 3, '0')
  from core.special_grants where granted_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'
$$;

create or replace function api.grant_special_permission(
  p_client_request_id uuid, p_user_id uuid, p_right text, p_company_id uuid, p_params jsonb,
  p_starts_at timestamptz, p_ends_at timestamptz, p_max_uses int, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid; v_code text; v_max_days int; v_res jsonb; r core.rights;
begin
  v_prev := app.request_seen(p_client_request_id, 'grant_special_permission');
  if v_prev is not null then return v_prev; end if;
  perform app.require(null, 'users.manage');                                -- only Admin gives permissions
  select * into r from core.rights where key = p_right;
  if not found then raise exception 'not_found: right %', p_right using errcode = 'P0002'; end if;
  if r.never_grantable or r.admin_only or not r.grantable_by_permission then
    raise exception 'never_grantable: % cannot be given as a special permission', p_right using errcode = '42501', hint = 'grant.never_grantable';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'self_grant: you cannot give a permission to yourself' using errcode = '42501', hint = 'grant.self';
  end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then
    raise exception 'reason_required: a reason is required' using errcode = '22023', hint = 'grant.reason_required';
  end if;
  if p_ends_at <= p_starts_at then
    raise exception 'bad_window: the end must be after the start' using errcode = '22023', hint = 'grant.bad_window';
  end if;
  v_max_days := coalesce((app.setting(p_company_id, 'grants.max_days'))::text::int, 7);
  if p_ends_at - p_starts_at > make_interval(days => v_max_days) then
    raise exception 'too_long: a permission can last at most % days', v_max_days using errcode = '22023', hint = 'grant.too_long';
  end if;
  v_code := app.next_grant_code();
  insert into core.special_grants (code, user_id, right_key, company_id, params, starts_at, ends_at, max_uses, reason, granted_by)
  values (v_code, p_user_id, p_right, p_company_id, coalesce(p_params, '{}'::jsonb), p_starts_at, p_ends_at, p_max_uses, p_reason, auth.uid())
  returning id into v_id;
  perform app.log_event('grant_given', jsonb_build_object('grant', v_code, 'user_id', p_user_id, 'right', p_right, 'from', p_starts_at, 'to', p_ends_at), v_id);
  v_res := jsonb_build_object('id', v_id, 'code', v_code);
  return app.request_done(p_client_request_id, 'grant_special_permission', v_res);
end $$;

create or replace function api.revoke_special_permission(p_client_request_id uuid, p_grant_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; g core.special_grants; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'revoke_special_permission');
  if v_prev is not null then return v_prev; end if;
  perform app.require(null, 'users.manage');
  select * into g from core.special_grants where id = p_grant_id for update;
  if not found then raise exception 'not_found: permission' using errcode = 'P0002'; end if;
  if g.revoked_at is not null then raise exception 'already_stopped' using errcode = '22023', hint = 'grant.already_stopped'; end if;
  update core.special_grants set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = p_reason where id = p_grant_id;
  perform app.log_event('grant_revoked', jsonb_build_object('grant', g.code, 'reason', p_reason), p_grant_id);
  v_res := jsonb_build_object('id', p_grant_id);
  return app.request_done(p_client_request_id, 'revoke_special_permission', v_res);
end $$;

create or replace function api.request_special_permission(
  p_client_request_id uuid, p_right text, p_company_id uuid, p_params jsonb, p_from timestamptz, p_to timestamptz, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid; v_res jsonb; r core.rights;
begin
  v_prev := app.request_seen(p_client_request_id, 'request_special_permission');
  if v_prev is not null then return v_prev; end if;
  if auth.uid() is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  if app.current_view() = 'all-readonly' then raise exception 'read_only' using errcode = '42501', hint = 'rights.read_only'; end if;
  select * into r from core.rights where key = p_right;
  if not found or r.never_grantable or r.admin_only or not r.grantable_by_permission then
    raise exception 'never_grantable: % cannot be requested', p_right using errcode = '42501', hint = 'grant.never_grantable';
  end if;
  insert into core.special_grant_requests (requested_by, right_key, company_id, params, wanted_from, wanted_to, reason)
  values (auth.uid(), p_right, p_company_id, coalesce(p_params, '{}'::jsonb), p_from, p_to, p_reason)
  returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'request_special_permission', v_res);
end $$;

-- Admin decides a request. Nobody approves their own request (also a check constraint).
create or replace function api.decide_special_permission(p_client_request_id uuid, p_request_id uuid, p_approve boolean, p_max_uses int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; q core.special_grant_requests; v_grant jsonb; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'decide_special_permission');
  if v_prev is not null then return v_prev; end if;
  perform app.require(null, 'users.manage');
  select * into q from core.special_grant_requests where id = p_request_id for update;
  if not found then raise exception 'not_found: request' using errcode = 'P0002'; end if;
  if q.requested_by = auth.uid() then
    raise exception 'self_approval: nobody approves their own request' using errcode = '42501', hint = 'sod.self_approval';
  end if;
  if q.status <> 'pending' then raise exception 'already_decided' using errcode = '22023', hint = 'grant.already_decided'; end if;
  if p_approve then
    v_grant := api.grant_special_permission(gen_random_uuid(), q.requested_by, q.right_key, q.company_id, q.params, q.wanted_from, q.wanted_to, p_max_uses, q.reason);
    update core.special_grant_requests set status = 'approved', decided_by = auth.uid(), decided_at = now(), grant_id = (v_grant ->> 'id')::uuid where id = q.id;
  else
    update core.special_grant_requests set status = 'refused', decided_by = auth.uid(), decided_at = now() where id = q.id;
  end if;
  v_res := jsonb_build_object('id', q.id, 'approved', p_approve, 'grant', v_grant);
  return app.request_done(p_client_request_id, 'decide_special_permission', v_res);
end $$;

-- Records one use of a grant (called by posting RPCs when app.require returned a grant id).
create or replace function app.use_grant(p_grant_id uuid, p_detail jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_grant_id is null then return; end if;
  perform set_config('app.grant_id', p_grant_id::text, true);
  update core.special_grants set uses = uses + 1 where id = p_grant_id;
  perform app.log_event('grant_used', coalesce(p_detail, '{}'::jsonb), p_grant_id);
end $$;

-- ─────────────────────────────── Settings, numbering, forms ───────────────────────────────
create or replace function api.set_setting(p_client_request_id uuid, p_company_id uuid, p_key text, p_value jsonb, p_effective_from date, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'set_setting');
  if v_prev is not null then return v_prev; end if;
  perform app.require(p_company_id, 'settings.manage');
  insert into core.settings (company_id, key, value, effective_from, note, set_by)
  values (p_company_id, p_key, p_value, coalesce(p_effective_from, current_date), p_note, auth.uid())
  returning id into v_id;
  perform app.log_event('setting_changed', jsonb_build_object('key', p_key, 'company_id', p_company_id, 'effective_from', p_effective_from));
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'set_setting', v_res);
end $$;

create or replace function api.upsert_doc_series(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_company uuid := (p ->> 'company_id')::uuid; v_res jsonb; s core.doc_series;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_doc_series');
  if v_prev is not null then return v_prev; end if;
  if v_id is not null then select * into s from core.doc_series where id = v_id for update; v_company := s.company_id; end if;
  perform app.require(v_company, 'settings.manage');
  if v_id is null then
    insert into core.doc_series (company_id, gstin_id, doc_type, fy_id, prefix, pad, next_no)
    values (v_company, nullif(p ->> 'gstin_id', '')::uuid, p ->> 'doc_type', (p ->> 'fy_id')::uuid, upper(p ->> 'prefix'),
            coalesce((p ->> 'pad')::int, 4), coalesce((p ->> 'next_no')::bigint, 1))
    returning id into v_id;
  else
    -- Once a number is issued, the prefix and counter are locked (gap-free series).
    if exists (select 1 from core.doc_numbers_issued where series_id = v_id) and (p ? 'prefix' or p ? 'next_no' or p ? 'pad') then
      raise exception 'series_in_use: numbers are already issued from this series' using errcode = '22023', hint = 'numbering.in_use';
    end if;
    update core.doc_series set
      prefix = coalesce(upper(p ->> 'prefix'), prefix), pad = coalesce((p ->> 'pad')::int, pad),
      next_no = coalesce((p ->> 'next_no')::bigint, next_no), status = coalesce(p ->> 'status', status)
    where id = v_id;
  end if;
  perform app.log_event('setting_changed', jsonb_build_object('entity', 'doc_series', 'id', v_id));
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_doc_series', v_res);
end $$;

create or replace function api.upsert_form_field(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_company uuid := nullif(p ->> 'company_id', '')::uuid; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_form_field');
  if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'forms.manage');
  if v_id is null then
    insert into core.form_fields (form_key, company_id, field_key, label, field_type, required, options, sort)
    values (p ->> 'form_key', v_company, lower(p ->> 'field_key'), p ->> 'label', p ->> 'field_type', coalesce((p ->> 'required')::boolean, false),
            coalesce(p -> 'options', '[]'::jsonb), coalesce((p ->> 'sort')::int, 100))
    returning id into v_id;
  else
    update core.form_fields set
      label = coalesce(p ->> 'label', label), required = coalesce((p ->> 'required')::boolean, required),
      options = coalesce(p -> 'options', options), sort = coalesce((p ->> 'sort')::int, sort), active = coalesce((p ->> 'active')::boolean, active)
    where id = v_id;
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_form_field', v_res);
end $$;

-- ─────────────────────────────── Logs ───────────────────────────────
create or replace function api.log_error(p_route text, p_rpc text, p_rule_code text, p_message text, p_payload_summary jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare v_ref text := app.new_error_ref();
begin
  insert into ops.error_log (ref, user_id, route, rpc, rule_code, message, payload_summary)
  values (v_ref, auth.uid(), left(p_route, 200), left(p_rpc, 100), left(p_rule_code, 100), left(coalesce(p_message, ''), 1000), coalesce(p_payload_summary, '{}'::jsonb));
  return v_ref;
end $$;

-- Events the browser may report about itself (sign-in, sign-out, export, print, viewing a sensitive record).
create or replace function api.log_user_event(p_event text, p_detail jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  if p_event not in ('sign_in', 'sign_out', 'export', 'print', 'view_sensitive') then
    raise exception 'bad_event' using errcode = '22023';
  end if;
  perform app.log_event(p_event, coalesce(p_detail, '{}'::jsonb) - 'password');
end $$;

-- A failed sign-in, reported before there is a session. The identifier is stored masked; at most 20 per hour.
create or replace function api.log_sign_in_failure(p_identifier text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_masked text := case when position('@' in coalesce(p_identifier, '')) > 0
                              then left(p_identifier, 2) || '•••@' || split_part(p_identifier, '@', 2)
                              else '••' || right(regexp_replace(coalesce(p_identifier, ''), '\D', '', 'g'), 4) end;
begin
  if (select count(*) from audit.user_log where event = 'sign_in_failed' and detail ->> 'who' = v_masked and at > now() - interval '1 hour') >= 20 then
    return;
  end if;
  insert into audit.user_log (user_id, event, detail) values (null, 'sign_in_failed', jsonb_build_object('who', v_masked));
end $$;

revoke all on all functions in schema api from public, anon;
grant execute on all functions in schema api to authenticated;
grant execute on function api.log_sign_in_failure(text) to anon;

notify pgrst, 'reload config';
notify pgrst, 'reload schema';


-- 20261103009000_security_hardening.sql — Phase 9 security review (docs/SECURITY.md → "Phase 9 review"). Additive only.
--
-- Findings fixed here (from scripts/rls-audit.mjs):
--   1. Three tables had RLS on but no policy (deny-all by accident rather than by design): core.request_log,
--      core.doc_numbers_issued, ops.bridge_devices. Each gets an explicit, narrow read policy. Writes stay RPC-only.
--   2. api.log_sign_in_failure lost its anon EXECUTE grant (a later blanket "revoke … from anon" in an api migration),
--      so failed sign-ins were no longer written to the user log. Re-granted; 25_security.sql now guards it.
--   3. Three immutable helpers in app (imp_rank, imp_phone, imp_uom) had a mutable search_path. Pinned to ''.
--
-- MFA enforcement (Part 1 §24): roles with core.roles.mfa_required (owner, admin, CA, auditor, MD, finance head,
-- accountant, office admin, investor) need a second factor. When the group setting security.enforce_mfa is true, a
-- session whose JWT is not aal2:
--   • gets none of its MFA-required roles in app.my_roles() — so app.can / app.can_read_company / current_view and
--     every RLS policy built on them see no such role (this also covers Realtime, which applies RLS directly);
--   • gets a clear "mfa_required" error from app.require() (RPCs);
--   • sees no investor-portal rows (partner functions, views and policies keyed on acct.partners.user_id).
-- api.me() reports mfa_required / mfa_enforced / aal so the client shows the TOTP step.
-- Default: OFF (no setting row) — DEV and the pgTAP suite keep working. Production: Admin sets it ON at go-live
-- (docs/GO_LIVE_CHECKLIST.md) after every MFA-role account has enrolled an authenticator.

-- ─────────── MFA helpers ───────────
create or replace function app.mfa_enforced() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(app.setting(null, 'security.enforce_mfa') = 'true'::jsonb, false)
$$;

-- True when this session may use MFA-required access: enforcement is off, or the JWT carries aal2.
create or replace function app.mfa_satisfied() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2' or not app.mfa_enforced()
$$;

-- Active roles of the current user (CA/auditor windows end on their own). MFA-required roles count only when
-- app.mfa_satisfied() (replaces the Phase 1 definition; same columns).
create or replace function app.my_roles() returns table (role_key text, company_id uuid, view_kind text)
language sql stable security definer set search_path = '' as $$
  with m as (select app.mfa_satisfied() as ok)
  select ur.role_key, ur.company_id, r.view_kind
  from core.user_roles ur
  join core.roles r on r.key = ur.role_key
  join core.user_profiles p on p.user_id = ur.user_id and p.status = 'active'
  cross join m
  where ur.user_id = auth.uid()
    and ur.valid_from <= now()
    and (ur.valid_to is null or ur.valid_to > now())
    and (not r.mfa_required or m.ok)
$$;

-- Does the signed-in user hold any active MFA-required role (ignoring the MFA filter)?
create or replace function app.has_mfa_role() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from core.user_roles ur join core.roles r on r.key = ur.role_key
    where ur.user_id = auth.uid() and r.mfa_required and ur.valid_from <= now() and (ur.valid_to is null or ur.valid_to > now()))
  or exists (select 1 from acct.partners p where p.user_id = auth.uid() and p.status = 'active')
$$;

-- The rights check inside every RPC (Phase 1 behaviour, plus the MFA gate first).
create or replace function app.require(p_company_id uuid, p_right text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_grant uuid;
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = '42501', hint = 'auth.required';
  end if;
  if not app.mfa_satisfied() and app.has_mfa_role() then
    raise exception 'mfa_required: verify the code from your authenticator app to continue' using errcode = '42501', hint = 'auth.mfa_required';
  end if;
  if app.current_view() = 'all-readonly' and split_part(p_right, '.', 2) not in ('view', 'export') then
    raise exception 'read_only: CA and auditor access cannot change data' using errcode = '42501', hint = 'rights.read_only';
  end if;
  if not app.can(p_company_id, p_right) then
    raise exception 'no_right: % needs %', coalesce(p_company_id::text, 'group'), p_right using errcode = '42501', hint = 'rights.missing';
  end if;
  -- If the right comes only from a grant, return the grant id so the action is recorded under it.
  if not exists (
      select 1 from app.my_roles() r
      left join core.role_rights rr on rr.role_key = r.role_key and rr.right_key = p_right
      where (r.view_kind = 'all' or rr.right_key is not null)
        and (r.company_id is null or p_company_id is null or r.company_id = p_company_id)) then
    v_grant := app.active_grant(p_right, p_company_id);
  end if;
  return v_grant;
end $$;

-- ─────────── Investor portal: partner rows only after MFA (when enforced) ───────────
create or replace function app.is_partner_user(p_partner uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.mfa_satisfied() and exists (select 1 from acct.partners p where p.id = p_partner and p.user_id = auth.uid())
$$;

alter policy partners_read on acct.partners
  using ((user_id = (select auth.uid()) and app.mfa_satisfied()) or app.can(company_id, 'partners.view'));
alter policy projects_read on acct.partner_projects
  using (app.can(company_id, 'partners.view')
         or (visible_to_investors and app.mfa_satisfied()
             and exists (select 1 from acct.partners p where p.company_id = partner_projects.company_id and p.user_id = (select auth.uid()) and p.status = 'active')));

-- The investor row functions keep their bodies under *_base; the public names become gated wrappers. SQL functions
-- (api.investor_me, api.investor_group_summary) resolve the names at run time, so they pick up the gate; the views,
-- which bind by OID, are re-created below so they call the wrappers.
do $$
declare r record;
begin
  for r in select p.oid, p.proname, pg_get_function_arguments(p.oid) as args, pg_get_function_identity_arguments(p.oid) as idargs,
                  pg_get_function_result(p.oid) as res
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'app' and p.proname in ('investor_partner_rows', 'investor_request_rows', 'investor_profit_share_rows', 'investor_project_rows', 'investor_money_in_rows')
  loop
    execute format('alter function app.%I(%s) rename to %I', r.proname, r.idargs, r.proname || '_base');
    execute format('create function app.%I(%s) returns %s language sql stable security definer set search_path = '''' as $f$ select * from app.%I(%s) where app.mfa_satisfied() $f$',
                   r.proname, r.args, r.res, r.proname || '_base', case when r.idargs = '' then '' else 'p_months' end);
  end loop;
end $$;

create or replace view api.v_investor_partners with (security_invoker = true) as select * from app.investor_partner_rows();
create or replace view api.v_investor_requests with (security_invoker = true) as select * from app.investor_request_rows();
create or replace view api.v_investor_profit_shares with (security_invoker = true) as select * from app.investor_profit_share_rows();
create or replace view api.v_investor_projects with (security_invoker = true) as select * from app.investor_project_rows();
create or replace view api.v_investor_money_in with (security_invoker = true) as
select m.company_id, (select r.company_name from app.investor_partner_rows() r where r.company_id = m.company_id limit 1) as company_name, m.month, m.mode, m.receipts, m.amount
from app.investor_money_in_rows(12) m;

-- ─────────── api.me(): MFA state for the client ───────────
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
                        where ur.user_id = auth.uid() and r.view_kind = 'all-readonly' and ur.valid_to > now()),
    'aal', coalesce(auth.jwt() ->> 'aal', 'aal1'),
    'mfa_required', app.has_mfa_role(),
    'mfa_enforced', app.mfa_enforced(),
    'mfa_needed', app.has_mfa_role() and not app.mfa_satisfied()
  ) end
  from (select 1) x left join core.user_profiles p on p.user_id = auth.uid()
$$;

-- ─────────── Tables with RLS but no policy: explicit, narrow read policies ───────────
-- Idempotency log: a user may read only the results of their own requests.
create policy request_log_own on core.request_log for select to authenticated using (user_id = (select auth.uid()));
-- Issued document numbers (gap register): Admin/Owner and CA/auditor views only.
create policy doc_numbers_issued_read on core.doc_numbers_issued for select to authenticated using (app.current_view() in ('all', 'all-readonly'));
-- Tally bridge devices hold a key hash: Admin only.
create policy bridge_devices_admin on ops.bridge_devices for select to authenticated using (app.is_admin());

-- ─────────── Pinned search_path on the remaining app helpers ───────────
alter function app.imp_rank(text) set search_path = '';
alter function app.imp_phone(text) set search_path = '';
alter function app.imp_uom(text) set search_path = '';

-- ─────────── Grants ───────────
-- Only what this migration created or replaced (no blanket api grants: Phase 8 keeps some RPCs service-only).
revoke all on function app.mfa_enforced(), app.mfa_satisfied(), app.has_mfa_role() from public, anon;
grant execute on function app.mfa_enforced(), app.mfa_satisfied(), app.has_mfa_role() to authenticated;
revoke all on function app.investor_partner_rows(), app.investor_request_rows(), app.investor_profit_share_rows(), app.investor_project_rows(),
                       app.investor_money_in_rows(integer), app.investor_partner_rows_base(), app.investor_request_rows_base(),
                       app.investor_profit_share_rows_base(), app.investor_project_rows_base(), app.investor_money_in_rows_base(integer) from public, anon;
grant execute on function app.investor_partner_rows(), app.investor_request_rows(), app.investor_profit_share_rows(), app.investor_project_rows(),
                          app.investor_money_in_rows(integer) to authenticated;
revoke all on function api.me() from public, anon;
grant execute on function api.me() to authenticated;
-- A failed sign-in is reported before there is a session (masked identifier, throttled to 20/hour inside).
grant execute on function api.log_sign_in_failure(text) to anon;
grant select on api.v_investor_partners, api.v_investor_requests, api.v_investor_profit_shares, api.v_investor_projects, api.v_investor_money_in to authenticated;

insert into core.law_rules (code, area, rule, what_erp_does, enforced_in, test_ref, status, phase, sort)
select 'SEC-MFA', 'Security', 'Second factor for Admin, finance, CA/auditor and investor accounts (Part 1 §24)',
       'With security.enforce_mfa on, MFA-required roles and the investor portal work only in an aal2 session; RPCs answer mfa_required',
       'app.my_roles, app.require, app.mfa_satisfied, investor row functions', 'supabase/tests/25_security.sql', 'built', 9, 130
on conflict (code) do nothing;

notify pgrst, 'reload schema';

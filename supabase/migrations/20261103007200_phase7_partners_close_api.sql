-- 20261103007200_phase7_partners_close_api.sql
-- Phase 7 partners, directors and the investor portal, and the month-end close.
--  · Partners per company (legal / investment / working partner, director), investments, projects, declarations.
--  · Partner requests (withdraw, loan to or from the company, information, project offer) go to Admin; Admin decides with
--    the Companies Act checks: s.185 loans to directors (refused unless the allowed exception is recorded in settings),
--    s.186 limit for other loans (a setting; refused when unset), a director's written declaration before the company
--    takes money from a director. Nobody decides their own request. Payments and loans post through app.post_voucher.
--  · Profit sharing follows approved minutes (approved by a second Admin): net profit from the books, incentives first,
--    the rest by share %, posted as one journal to the partners' accounts.
--  · Investor portal: role 'investor' with no transaction rights; api.investor_me / api.investor_group_summary and
--    api.v_investor_* return the caller's own rows and analytics only (aggregates; no party names, salaries or
--    without-GST figures unless Admin records the investor.include_without_gst policy).
--  · Month-end close: checklist due on the 10th (setting), tasks with doer ≠ checker, close only when every task is
--    checked or carried, reopen only by Admin with a reason (logged), optional relock after set hours.
-- Every RPC: api.* security definer, p_client_request_id first, idempotent, row locks, rights / state / period checks. Additive.

-- ─────────── Helpers ───────────
-- What the company owes on an account (credit balance, opening included) up to a date.
create or replace function app.account_credit_balance(p_account uuid, p_upto date) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select case when a.opening_dc = 'C' then a.opening_balance else -a.opening_balance end from acct.accounts a where a.id = p_account), 0)
       + coalesce((select sum(g.cr - g.dr) from acct.gl_entries g where g.account_id = p_account and g.entry_date <= p_upto), 0)
$$;

create or replace function app.lock_partner(p_partner uuid) returns acct.partners
language plpgsql security definer set search_path = '' as $$
declare r acct.partners;
begin
  select * into r from acct.partners where id = p_partner for update;
  if r.id is null then perform app.raise_rule('partner.missing', 'partner not found', 'P0002'); end if;
  return r;
end $$;

-- Companies Act checks for the company lending to a partner. Returns the legal basis recorded with the decision.
--  s.185: a director, or a person / firm a director is interested in → only when the allowed exception is recorded
--         (setting companies_act.s185_exception = {basis, resolution_ref, ...}); otherwise refused.
--  s.186: anyone else → the limit Admin records with the CA (companies_act.s186_limit); refused when unset or exceeded.
create or replace function app.check_partner_loan(p acct.partners, p_amount numeric, p_on date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb; v_limit numeric; v_out numeric;
begin
  if p.is_director or p.director_interested then
    v := app.setting(p.company_id, 'companies_act.s185_exception', p_on);
    if v is null or jsonb_typeof(v) <> 'object' or coalesce(length(trim(v ->> 'basis')), 0) = 0 then
      perform app.raise_rule('companies_act.s185', 'loans to directors, and to people or firms they are interested in, are restricted by Companies Act s.185; '
                             || 'record the allowed exception with the CA on Settings first', '42501');
    end if;
    return jsonb_build_object('section', '185', 'exception', v);
  end if;
  v_limit := nullif(app.setting(p.company_id, 'companies_act.s186_limit', p_on) #>> '{}', '')::numeric;
  if v_limit is null then
    perform app.raise_rule('companies_act.s186_limit_not_set', 'the Companies Act s.186 limit for loans is not set; the CA works it out and Admin records it on Settings', '22023');
  end if;
  select coalesce(sum(case when movement = 'advance' then amount else -amount end), 0) into v_out from acct.director_loans where company_id = p.company_id and direction = 'given';
  v_out := v_out + coalesce((select sum(coalesce(decided_amount, amount)) from acct.partner_requests where company_id = p.company_id and kind = 'loan_to_partner' and status = 'approved'), 0);
  if v_out + p_amount > v_limit then
    perform app.raise_rule('companies_act.s186_limit', 'this loan takes the company over its s.186 limit; it needs a special resolution and the CA''s check', '42501');
  end if;
  return jsonb_build_object('section', '186', 'limit', v_limit, 'outstanding_before', v_out);
end $$;

-- A director lending to the company needs a current written declaration that the money is not borrowed.
create or replace function app.director_declaration(p acct.partners, p_on date) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v uuid;
begin
  if not p.is_director then return null; end if;
  select id into v from acct.director_declarations
   where partner_id = p.id and kind = 'not_borrowed' and declared_on <= p_on and (valid_to is null or valid_to >= p_on)
   order by declared_on desc limit 1;
  if v is null then
    perform app.raise_rule('companies_act.director_declaration', 'money lent by a director needs their written declaration that it is not borrowed; record it on Directors first', '42501');
  end if;
  return v;
end $$;

-- ─────────── Partners (Admin) ───────────
-- p: {id?, company_id, person_id, user_id, display_name, is_legal_partner, is_investment_partner, is_working_partner, is_director,
--     director_interested, din, shares, share_pct, capital_account_id, current_account_id, loan_account_id, language, status}
create or replace function api.upsert_partner(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_company uuid := nullif(p ->> 'company_id', '')::uuid; r acct.partners; k text; v_total numeric;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_partner'); if v_prev is not null then return v_prev; end if;
  if v_id is not null then r := app.lock_partner(v_id); v_company := r.company_id; end if;
  perform app.require(v_company, 'partners.manage');
  if coalesce(length(trim(p ->> 'display_name')), 0) = 0 then perform app.raise_rule('partner.name', 'enter the partner''s name', '22023'); end if;
  foreach k in array array['capital_account_id', 'current_account_id', 'loan_account_id'] loop
    if nullif(p ->> k, '') is not null and not exists (select 1 from acct.accounts where id = (p ->> k)::uuid and company_id = v_company) then
      perform app.raise_rule('partner.account_other_company', 'choose an account of this company', '22023');
    end if;
  end loop;
  if v_id is null then
    insert into acct.partners (company_id, person_id, user_id, display_name, is_legal_partner, is_investment_partner, is_working_partner, is_director, director_interested, din,
                               shares, share_pct, capital_account_id, current_account_id, loan_account_id, language, status, created_by)
    values (v_company, nullif(p ->> 'person_id', '')::uuid, nullif(p ->> 'user_id', '')::uuid, trim(p ->> 'display_name'), coalesce((p ->> 'is_legal_partner')::boolean, false),
            coalesce((p ->> 'is_investment_partner')::boolean, false), coalesce((p ->> 'is_working_partner')::boolean, false), coalesce((p ->> 'is_director')::boolean, false),
            coalesce((p ->> 'director_interested')::boolean, false), nullif(p ->> 'din', ''), nullif(p ->> 'shares', '')::bigint, coalesce(nullif(p ->> 'share_pct', '')::numeric, 0),
            nullif(p ->> 'capital_account_id', '')::uuid, nullif(p ->> 'current_account_id', '')::uuid, nullif(p ->> 'loan_account_id', '')::uuid,
            coalesce(nullif(p ->> 'language', ''), 'en'), coalesce(nullif(p ->> 'status', ''), 'active'), auth.uid())
    returning id into v_id;
  else
    update acct.partners set person_id = nullif(p ->> 'person_id', '')::uuid, user_id = nullif(p ->> 'user_id', '')::uuid, display_name = trim(p ->> 'display_name'),
      is_legal_partner = coalesce((p ->> 'is_legal_partner')::boolean, is_legal_partner), is_investment_partner = coalesce((p ->> 'is_investment_partner')::boolean, is_investment_partner),
      is_working_partner = coalesce((p ->> 'is_working_partner')::boolean, is_working_partner), is_director = coalesce((p ->> 'is_director')::boolean, is_director),
      director_interested = coalesce((p ->> 'director_interested')::boolean, director_interested), din = nullif(p ->> 'din', ''), shares = nullif(p ->> 'shares', '')::bigint,
      share_pct = coalesce(nullif(p ->> 'share_pct', '')::numeric, share_pct), capital_account_id = nullif(p ->> 'capital_account_id', '')::uuid,
      current_account_id = nullif(p ->> 'current_account_id', '')::uuid, loan_account_id = nullif(p ->> 'loan_account_id', '')::uuid,
      language = coalesce(nullif(p ->> 'language', ''), language), status = coalesce(nullif(p ->> 'status', ''), status), updated_at = now()
    where id = v_id;
  end if;
  select coalesce(sum(share_pct), 0) into v_total from acct.partners where company_id = v_company and status = 'active';
  if v_total > 100 then perform app.raise_rule('partner.share_over_100', 'share percentages of the company''s partners add up to more than 100', '22023'); end if;
  perform app.log_event('admin_action', jsonb_build_object('entity', 'partner', 'id', v_id, 'company_id', v_company));
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_partner', v_res);
end $$;

-- A recorded investment (memo; the CA restates capital accounts at cut-over). A project investment needs the agreement.
-- p: {partner_id, kind share_capital|capital_account|project|other, amount, invested_on, agreement_ref, project_id, note}
create or replace function api.record_partner_investment(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; r acct.partners; v_id uuid; v_kind text := p ->> 'kind';
begin
  v_prev := app.request_seen(p_client_request_id, 'record_partner_investment'); if v_prev is not null then return v_prev; end if;
  r := app.lock_partner(nullif(p ->> 'partner_id', '')::uuid);
  perform app.require(r.company_id, 'partners.manage');
  if coalesce(nullif(p ->> 'amount', '')::numeric, 0) = 0 then perform app.raise_rule('partner.amount', 'enter the amount', '22023'); end if;
  if v_kind = 'project' and (nullif(p ->> 'project_id', '') is null or coalesce(length(trim(p ->> 'agreement_ref')), 0) = 0) then
    perform app.raise_rule('partner.agreement_required', 'a project offer becomes an investment only with the project and the signed agreement', '22023');
  end if;
  if nullif(p ->> 'project_id', '') is not null and not exists (select 1 from acct.partner_projects where id = (p ->> 'project_id')::uuid and company_id = r.company_id) then
    perform app.raise_rule('partner.project', 'choose a project of this company', '22023');
  end if;
  insert into acct.partner_investments (company_id, partner_id, kind, amount, invested_on, agreement_ref, project_id, note, recorded_by)
  values (r.company_id, r.id, v_kind, round((p ->> 'amount')::numeric, 2), coalesce(nullif(p ->> 'invested_on', '')::date, current_date), nullif(trim(p ->> 'agreement_ref'), ''),
          nullif(p ->> 'project_id', '')::uuid, nullif(p ->> 'note', ''), auth.uid()) returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'record_partner_investment', v_res);
end $$;

-- p: {id?, company_id, name, status, started_on, summary, investor_figures, visible_to_investors}
create or replace function api.upsert_partner_project(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_company uuid := nullif(p ->> 'company_id', '')::uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'upsert_partner_project'); if v_prev is not null then return v_prev; end if;
  if v_id is not null then select company_id into v_company from acct.partner_projects where id = v_id for update; end if;
  perform app.require(v_company, 'partners.manage');
  if coalesce(length(trim(p ->> 'name')), 0) = 0 then perform app.raise_rule('project.name', 'name the project', '22023'); end if;
  if v_id is null then
    insert into acct.partner_projects (company_id, name, status, started_on, summary, investor_figures, visible_to_investors, updated_by)
    values (v_company, trim(p ->> 'name'), coalesce(nullif(p ->> 'status', ''), 'idea'), nullif(p ->> 'started_on', '')::date, nullif(p ->> 'summary', ''),
            coalesce(p -> 'investor_figures', '{}'::jsonb), coalesce((p ->> 'visible_to_investors')::boolean, false), auth.uid()) returning id into v_id;
  else
    update acct.partner_projects set name = trim(p ->> 'name'), status = coalesce(nullif(p ->> 'status', ''), status), started_on = nullif(p ->> 'started_on', '')::date,
      summary = nullif(p ->> 'summary', ''), investor_figures = coalesce(p -> 'investor_figures', investor_figures),
      visible_to_investors = coalesce((p ->> 'visible_to_investors')::boolean, visible_to_investors), updated_by = auth.uid(), updated_at = now()
    where id = v_id;
  end if;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'upsert_partner_project', v_res);
end $$;

-- p: {partner_id, kind not_borrowed|interest_disclosure|other, declared_on, valid_to, document_path, note}
create or replace function api.record_director_declaration(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; r acct.partners; v_id uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'record_director_declaration'); if v_prev is not null then return v_prev; end if;
  r := app.lock_partner(nullif(p ->> 'partner_id', '')::uuid);
  perform app.require(r.company_id, 'partners.manage');
  if nullif(p ->> 'declared_on', '') is null then perform app.raise_rule('declaration.date', 'enter the date on the signed declaration', '22023'); end if;
  if (p ->> 'declared_on')::date > current_date then perform app.raise_rule('date.future', 'the date is in the future', '22023'); end if;
  insert into acct.director_declarations (company_id, partner_id, kind, declared_on, valid_to, document_path, note, recorded_by)
  values (r.company_id, r.id, coalesce(nullif(p ->> 'kind', ''), 'not_borrowed'), (p ->> 'declared_on')::date, nullif(p ->> 'valid_to', '')::date, nullif(p ->> 'document_path', ''),
          nullif(p ->> 'note', ''), auth.uid()) returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'record_director_declaration', v_res);
end $$;

-- ─────────── Partner requests ───────────
-- From the portal (the partner's own row, investor.portal) or recorded by Admin on the partner's behalf.
-- p: {partner_id, source, project_id, amount, repay_months, repay_from, purpose, note}
create or replace function api.submit_partner_request(p_client_request_id uuid, p_kind text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; r acct.partners; v_id uuid; v_no text; v_amt numeric := round(nullif(p ->> 'amount', '')::numeric, 2);
begin
  v_prev := app.request_seen(p_client_request_id, 'submit_partner_request'); if v_prev is not null then return v_prev; end if;
  select * into r from acct.partners where id = nullif(p ->> 'partner_id', '')::uuid;
  if r.id is null then
    -- The portal may send no partner id when the investor has one partner row in the chosen company.
    select * into r from acct.partners where user_id = auth.uid() and company_id = nullif(p ->> 'company_id', '')::uuid and status = 'active';
  end if;
  if r.id is null then perform app.raise_rule('partner.missing', 'partner not found', 'P0002'); end if;
  if r.user_id is not distinct from auth.uid() then perform app.require(r.company_id, 'investor.portal');
  else perform app.require(r.company_id, 'partners.manage'); end if;
  if r.status <> 'active' then perform app.raise_rule('partner.inactive', 'this partner is no longer active', '22023'); end if;
  if p_kind is null or p_kind not in ('withdraw', 'loan_to_partner', 'loan_from_partner', 'info', 'project_offer') then
    perform app.raise_rule('partner_request.kind', 'choose withdraw, loan, information or project offer', '22023');
  end if;
  if p_kind in ('withdraw', 'loan_to_partner', 'loan_from_partner') and coalesce(v_amt, 0) <= 0 then perform app.raise_rule('partner.amount', 'enter the amount', '22023'); end if;
  if p_kind = 'withdraw' and coalesce(p ->> 'source', '') not in ('land_rent', 'incentive', 'dividend', 'investment') then
    perform app.raise_rule('partner_request.source', 'choose what to draw from', '22023');
  end if;
  if p_kind = 'project_offer' and nullif(p ->> 'project_id', '') is null and coalesce(length(trim(p ->> 'purpose')), 0) = 0 then
    perform app.raise_rule('partner_request.project', 'choose the project or describe the offer', '22023');
  end if;
  if p_kind = 'info' and coalesce(length(trim(coalesce(p ->> 'purpose', p ->> 'note'))), 0) = 0 then perform app.raise_rule('partner_request.question', 'write your question', '22023'); end if;
  if nullif(p ->> 'project_id', '') is not null and not exists (select 1 from acct.partner_projects where id = (p ->> 'project_id')::uuid and company_id = r.company_id) then
    perform app.raise_rule('partner.project', 'choose a project of this company', '22023');
  end if;
  v_no := app.p7_doc_no(r.company_id, 'partner_request', current_date);
  insert into acct.partner_requests (company_id, doc_no, partner_id, kind, source, project_id, amount, repay_months, repay_from, purpose, note, requested_by)
  values (r.company_id, v_no, r.id, p_kind, case when p_kind = 'withdraw' then p ->> 'source' end, nullif(p ->> 'project_id', '')::uuid, case when p_kind in ('withdraw', 'loan_to_partner', 'loan_from_partner', 'project_offer') then v_amt end,
          nullif(p ->> 'repay_months', '')::int, nullif(p ->> 'repay_from', ''), nullif(trim(p ->> 'purpose'), ''), nullif(trim(p ->> 'note'), ''), auth.uid())
  returning id into v_id;
  perform app.log_event('admin_action', jsonb_build_object('entity', 'partner_request', 'id', v_id, 'kind', p_kind, 'action', 'submitted'));
  v_res := jsonb_build_object('id', v_id, 'doc_no', v_no, 'status', 'submitted');
  return app.request_done(p_client_request_id, 'submit_partner_request', v_res);
end $$;

create or replace function api.withdraw_partner_request(p_client_request_id uuid, p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; q acct.partner_requests;
begin
  v_prev := app.request_seen(p_client_request_id, 'withdraw_partner_request'); if v_prev is not null then return v_prev; end if;
  select * into q from acct.partner_requests where id = p_request_id for update;
  if q.id is null then perform app.raise_rule('partner_request.missing', 'request not found', 'P0002'); end if;
  if q.requested_by <> auth.uid() then perform app.raise_rule('rights.missing', 'only the person who sent it can withdraw it', '42501'); end if;
  if q.status <> 'submitted' then perform app.raise_rule('partner_request.state', 'only a request not yet decided can be withdrawn', '22023'); end if;
  update acct.partner_requests set status = 'withdrawn' where id = q.id;
  v_res := jsonb_build_object('id', q.id, 'status', 'withdrawn');
  return app.request_done(p_client_request_id, 'withdraw_partner_request', v_res);
end $$;

-- Admin decides (approve / reject, optionally a changed amount) with the Companies Act checks. Never one's own request.
create or replace function api.decide_partner_request(p_client_request_id uuid, p_request_id uuid, p_decision text, p_amount numeric default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; q acct.partner_requests; r acct.partners; v_amt numeric; v_checks jsonb := '{}'::jsonb; v_due numeric; v_decl uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'decide_partner_request'); if v_prev is not null then return v_prev; end if;
  select * into q from acct.partner_requests where id = p_request_id for update;
  if q.id is null then perform app.raise_rule('partner_request.missing', 'request not found', 'P0002'); end if;
  perform app.require(q.company_id, 'partners.manage');
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'partner requests are decided by Admin', '42501'); end if;
  r := app.lock_partner(q.partner_id);
  if q.requested_by = auth.uid() or r.user_id is not distinct from auth.uid() then
    perform app.raise_rule('sod.own_request', 'nobody decides their own request; another Admin decides it', '42501');
  end if;
  if q.status <> 'submitted' then perform app.raise_rule('partner_request.state', 'this request is already ' || q.status, '22023'); end if;
  if p_decision is null or p_decision not in ('approve', 'reject') then perform app.raise_rule('partner_request.decision', 'approve or reject', '22023'); end if;
  if p_decision = 'reject' then
    if coalesce(length(trim(p_note)), 0) < 5 then perform app.raise_rule('partner_request.reason', 'give the reason for rejecting', '22023'); end if;
    update acct.partner_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = trim(p_note) where id = q.id;
  else
    v_amt := round(coalesce(p_amount, q.amount), 2);
    if q.kind in ('withdraw', 'loan_to_partner', 'loan_from_partner') and coalesce(v_amt, 0) <= 0 then perform app.raise_rule('partner.amount', 'enter the amount', '22023'); end if;
    if q.kind = 'withdraw' then
      if r.current_account_id is null then perform app.raise_rule('partner.account_not_set', 'set the partner''s current account on Partners first', '22023'); end if;
      v_due := app.account_credit_balance(r.current_account_id, current_date);
      if v_amt > v_due then perform app.raise_rule('partner.over_due', format('the company owes this partner %s on their account; the withdrawal cannot be more', greatest(v_due, 0)), '22023'); end if;
      v_checks := jsonb_build_object('due', v_due);
    elsif q.kind = 'loan_to_partner' then
      v_checks := app.check_partner_loan(r, v_amt, current_date);
      if coalesce(length(trim(p_note)), 0) < 5 then
        perform app.raise_rule('partner.board_resolution_required', 'enter the board resolution reference (and the CA''s check) in the note', '22023');
      end if;
    elsif q.kind = 'loan_from_partner' then
      v_decl := app.director_declaration(r, current_date);
      v_checks := jsonb_build_object('declaration_id', v_decl, 'director', r.is_director);
    end if;
    update acct.partner_requests set status = 'approved', decided_by = auth.uid(), decided_at = now(), decided_amount = v_amt, decision_note = nullif(trim(p_note), ''),
           checks = v_checks
    where id = q.id;
  end if;
  perform app.log_event('admin_action', jsonb_build_object('entity', 'partner_request', 'id', q.id, 'decision', p_decision, 'amount_changed', p_amount is not null and p_amount is distinct from q.amount));
  if r.person_id is not null then
    perform app.enqueue_message(jsonb_build_object('company_id', q.company_id, 'event', 'partner.request_decided', 'template', 'partner_request_decided', 'person_id', r.person_id,
      'doc_type', 'acct.partner_request', 'doc_id', q.id, 'stage', 'decided', 'params', jsonb_build_object('request_no', q.doc_no, 'status', case when p_decision = 'approve' then 'approved' else 'rejected' end)));
  end if;
  v_res := jsonb_build_object('id', q.id, 'status', case when p_decision = 'approve' then 'approved' else 'rejected' end, 'checks', v_checks);
  return app.request_done(p_client_request_id, 'decide_partner_request', v_res);
end $$;

insert into msg.templates (name, language, category, event, header_type, body, params, approval_status) values
  ('partner_request_decided', 'en', 'utility', 'partner.request_decided', 'none', 'Your request {{1}} is {{2}}. Open the investor portal for details.', '["request_no","status"]', 'draft')
on conflict do nothing;

-- Pay an approved withdrawal from the bank: Dr the partner's current account, Cr the bank (payment voucher).
-- p: {bank_account_id, paid_on}
create or replace function api.pay_partner_request(p_client_request_id uuid, p_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; q acct.partner_requests; r acct.partners; v_bank uuid := nullif(p ->> 'bank_account_id', '')::uuid; v_date date := coalesce(nullif(p ->> 'paid_on', '')::date, current_date);
        v_fy uuid; v_no text; v_voucher uuid; v_amt numeric;
begin
  v_prev := app.request_seen(p_client_request_id, 'pay_partner_request'); if v_prev is not null then return v_prev; end if;
  select * into q from acct.partner_requests where id = p_request_id for update;
  if q.id is null then perform app.raise_rule('partner_request.missing', 'request not found', 'P0002'); end if;
  perform app.require(q.company_id, 'partners.manage');
  r := app.lock_partner(q.partner_id);
  if r.user_id is not distinct from auth.uid() then perform app.raise_rule('sod.own_request', 'nobody pays their own request', '42501'); end if;
  if q.kind <> 'withdraw' then perform app.raise_rule('partner_request.kind', 'loans are recorded on Directors (Record money in or out)', '22023'); end if;
  if q.status <> 'approved' then perform app.raise_rule('partner_request.state', 'only an approved request is paid', '22023'); end if;
  if not exists (select 1 from acct.accounts where id = v_bank and company_id = q.company_id and kind = 'bank') then perform app.raise_rule('partner.bank', 'choose the company''s bank account', '22023'); end if;
  v_amt := coalesce(q.decided_amount, q.amount);
  if v_amt > app.account_credit_balance(r.current_account_id, v_date) then perform app.raise_rule('partner.over_due', 'the partner''s account no longer covers this amount', '22023'); end if;
  perform app.check_backdate(q.company_id, v_date);
  v_fy := app.fy_for(q.company_id, v_date);
  v_no := app.take_doc_number(q.company_id, null, 'payment', v_fy);
  v_voucher := app.post_voucher(jsonb_build_object('company_id', q.company_id, 'fy_id', v_fy, 'voucher_type', 'payment', 'doc_no', v_no, 'voucher_date', v_date, 'mode', 'bank',
                 'narration', 'Partner withdrawal ' || q.doc_no, 'client_request_id', p_client_request_id, 'source_table', 'acct.partner_requests', 'source_id', q.id),
               jsonb_build_array(jsonb_build_object('account_id', r.current_account_id, 'dr', v_amt, 'narration', 'Withdrawal'),
                                 jsonb_build_object('account_id', v_bank, 'cr', v_amt, 'narration', 'Paid by bank')));
  update acct.partner_requests set status = 'paid', voucher_id = v_voucher, paid_at = now() where id = q.id;
  v_res := jsonb_build_object('id', q.id, 'status', 'paid', 'voucher_id', v_voucher, 'doc_no', v_no);
  return app.request_done(p_client_request_id, 'pay_partner_request', v_res);
end $$;

-- Money lent to or by a partner / director, posted to their loan account and the bank, with the same Companies Act checks.
-- p: {partner_id, direction given|taken, movement advance|repayment, amount, loan_date, bank_account_id, request_id}
create or replace function api.record_director_loan(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; r acct.partners; q acct.partner_requests; v_dir text := p ->> 'direction'; v_mov text := coalesce(nullif(p ->> 'movement', ''), 'advance');
        v_amt numeric := round(nullif(p ->> 'amount', '')::numeric, 2); v_date date := coalesce(nullif(p ->> 'loan_date', '')::date, current_date); v_bank uuid := nullif(p ->> 'bank_account_id', '')::uuid;
        v_basis jsonb := '{}'::jsonb; v_decl uuid; v_fy uuid; v_no text; v_type text; v_voucher uuid; v_id uuid; v_out numeric;
begin
  v_prev := app.request_seen(p_client_request_id, 'record_director_loan'); if v_prev is not null then return v_prev; end if;
  r := app.lock_partner(nullif(p ->> 'partner_id', '')::uuid);
  perform app.require(r.company_id, 'partners.manage');
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'loans with partners and directors are recorded by Admin', '42501'); end if;
  if r.user_id is not distinct from auth.uid() then perform app.raise_rule('sod.own_request', 'nobody records a loan to or from themselves', '42501'); end if;
  if v_dir is null or v_dir not in ('given', 'taken') or v_mov not in ('advance', 'repayment') then perform app.raise_rule('loan.kind', 'choose given or taken, advance or repayment', '22023'); end if;
  if coalesce(v_amt, 0) <= 0 then perform app.raise_rule('partner.amount', 'enter the amount', '22023'); end if;
  if r.loan_account_id is null then perform app.raise_rule('partner.account_not_set', 'set the partner''s loan account on Partners first', '22023'); end if;
  if not exists (select 1 from acct.accounts where id = v_bank and company_id = r.company_id and kind = 'bank') then perform app.raise_rule('partner.bank', 'choose the company''s bank account', '22023'); end if;
  if nullif(p ->> 'request_id', '') is not null then
    select * into q from acct.partner_requests where id = (p ->> 'request_id')::uuid for update;
    if q.id is null or q.partner_id <> r.id or q.status <> 'approved' or q.kind <> (case when v_dir = 'given' then 'loan_to_partner' else 'loan_from_partner' end) then
      perform app.raise_rule('loan.request', 'link the approved loan request of this partner', '22023');
    end if;
  end if;
  if v_dir = 'given' and v_mov = 'advance' then
    v_basis := app.check_partner_loan(r, v_amt, v_date);
  elsif v_dir = 'taken' and v_mov = 'advance' then
    v_decl := app.director_declaration(r, v_date);
    v_basis := jsonb_build_object('declaration_id', v_decl);
  else
    select coalesce(sum(case when movement = 'advance' then amount else -amount end), 0) into v_out from acct.director_loans where partner_id = r.id and direction = v_dir;
    if v_amt > v_out then perform app.raise_rule('loan.over_repaid', format('only %s is outstanding on this loan', v_out), '22023'); end if;
  end if;
  perform app.check_backdate(r.company_id, v_date);
  v_fy := app.fy_for(r.company_id, v_date);
  v_type := case when (v_dir = 'given' and v_mov = 'advance') or (v_dir = 'taken' and v_mov = 'repayment') then 'payment' else 'receipt' end;
  v_no := app.take_doc_number(r.company_id, null, v_type, v_fy);
  v_voucher := app.post_voucher(jsonb_build_object('company_id', r.company_id, 'fy_id', v_fy, 'voucher_type', v_type, 'doc_no', v_no, 'voucher_date', v_date, 'mode', 'bank',
                 'narration', 'Loan ' || v_dir || ' · ' || v_mov || ' · ' || r.display_name, 'client_request_id', p_client_request_id, 'source_table', 'acct.director_loans'),
               case when v_type = 'payment'
                    then jsonb_build_array(jsonb_build_object('account_id', r.loan_account_id, 'dr', v_amt), jsonb_build_object('account_id', v_bank, 'cr', v_amt))
                    else jsonb_build_array(jsonb_build_object('account_id', v_bank, 'dr', v_amt), jsonb_build_object('account_id', r.loan_account_id, 'cr', v_amt)) end);
  insert into acct.director_loans (company_id, partner_id, direction, movement, amount, loan_date, bank_account_id, request_id, declaration_id, legal_basis, voucher_id, recorded_by)
  values (r.company_id, r.id, v_dir, v_mov, v_amt, v_date, v_bank, q.id, v_decl, v_basis, v_voucher, auth.uid()) returning id into v_id;
  if q.id is not null then update acct.partner_requests set status = 'paid', voucher_id = v_voucher, paid_at = now() where id = q.id; end if;
  v_res := jsonb_build_object('id', v_id, 'voucher_id', v_voucher, 'doc_no', v_no, 'legal_basis', v_basis);
  return app.request_done(p_client_request_id, 'record_director_loan', v_res);
end $$;

-- ─────────── Profit sharing (by the recorded minutes) ───────────
-- p: {id?, company_id, fy_id, meeting_date, minutes_ref, document_path, basis: {incentives: [{partner_id, pct}]}}
create or replace function api.save_profit_share_minutes(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; v_id uuid := nullif(p ->> 'id', '')::uuid; v_company uuid := nullif(p ->> 'company_id', '')::uuid; m acct.profit_share_minutes; i jsonb; v_sum numeric := 0;
begin
  v_prev := app.request_seen(p_client_request_id, 'save_profit_share_minutes'); if v_prev is not null then return v_prev; end if;
  if v_id is not null then
    select * into m from acct.profit_share_minutes where id = v_id for update;
    if m.id is null then perform app.raise_rule('minutes.missing', 'minutes not found', 'P0002'); end if;
    if m.status <> 'draft' then perform app.raise_rule('minutes.not_draft', 'approved minutes do not change; record new minutes', '22023'); end if;
    v_company := m.company_id;
  end if;
  perform app.require(v_company, 'partners.manage');
  if not exists (select 1 from core.financial_years where id = nullif(p ->> 'fy_id', '')::uuid and company_id = v_company) then perform app.raise_rule('minutes.fy', 'choose the financial year', '22023'); end if;
  if coalesce(length(trim(p ->> 'minutes_ref')), 0) = 0 or nullif(p ->> 'meeting_date', '') is null then
    perform app.raise_rule('minutes.ref', 'enter the meeting date and the minutes reference', '22023');
  end if;
  for i in select * from jsonb_array_elements(coalesce(p #> '{basis,incentives}', '[]'::jsonb)) loop
    if not exists (select 1 from acct.partners where id = (i ->> 'partner_id')::uuid and company_id = v_company) then perform app.raise_rule('minutes.partner', 'an incentive goes to a partner of this company', '22023'); end if;
    if coalesce((i ->> 'pct')::numeric, 0) <= 0 then perform app.raise_rule('minutes.pct', 'each incentive needs its % of net profit', '22023'); end if;
    v_sum := v_sum + (i ->> 'pct')::numeric;
  end loop;
  if v_sum > 100 then perform app.raise_rule('minutes.pct_over_100', 'incentives cannot exceed the net profit', '22023'); end if;
  if v_id is null then
    insert into acct.profit_share_minutes (company_id, fy_id, meeting_date, minutes_ref, document_path, basis, created_by)
    values (v_company, (p ->> 'fy_id')::uuid, (p ->> 'meeting_date')::date, trim(p ->> 'minutes_ref'), nullif(p ->> 'document_path', ''), coalesce(p -> 'basis', '{}'::jsonb), auth.uid())
    returning id into v_id;
  else
    update acct.profit_share_minutes set fy_id = (p ->> 'fy_id')::uuid, meeting_date = (p ->> 'meeting_date')::date, minutes_ref = trim(p ->> 'minutes_ref'),
      document_path = nullif(p ->> 'document_path', ''), basis = coalesce(p -> 'basis', basis) where id = v_id;
  end if;
  v_res := jsonb_build_object('id', v_id, 'status', 'draft');
  return app.request_done(p_client_request_id, 'save_profit_share_minutes', v_res);
end $$;

create or replace function api.approve_profit_share_minutes(p_client_request_id uuid, p_minutes_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; m acct.profit_share_minutes;
begin
  v_prev := app.request_seen(p_client_request_id, 'approve_profit_share_minutes'); if v_prev is not null then return v_prev; end if;
  select * into m from acct.profit_share_minutes where id = p_minutes_id for update;
  if m.id is null then perform app.raise_rule('minutes.missing', 'minutes not found', 'P0002'); end if;
  perform app.require(m.company_id, 'partners.manage');
  if m.status <> 'draft' then perform app.raise_rule('minutes.not_draft', 'these minutes are already ' || m.status, '22023'); end if;
  if m.created_by = auth.uid() then perform app.raise_rule('sod.own_minutes', 'another Admin approves the minutes you entered', '42501'); end if;
  update acct.profit_share_minutes set status = 'superseded' where company_id = m.company_id and fy_id = m.fy_id and status = 'approved';
  update acct.profit_share_minutes set status = 'approved', approved_by = auth.uid(), approved_at = now() where id = m.id;
  v_res := jsonb_build_object('id', m.id, 'status', 'approved');
  return app.request_done(p_client_request_id, 'approve_profit_share_minutes', v_res);
end $$;

-- Net profit of the FY from the books (income less expenses, every class of entry; Admin only), incentives first, the
-- rest by share %. A new computation supersedes an earlier unposted one.
create or replace function api.compute_profit_share(p_client_request_id uuid, p_minutes_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; m acct.profit_share_minutes; fy core.financial_years; v_net numeric; v_inc numeric := 0; v_dist numeric; v_run uuid; i jsonb; v_amt numeric;
        v_pct numeric; r record; v_alloc numeric := 0; v_last bigint;
begin
  v_prev := app.request_seen(p_client_request_id, 'compute_profit_share'); if v_prev is not null then return v_prev; end if;
  select * into m from acct.profit_share_minutes where id = p_minutes_id for update;
  if m.id is null then perform app.raise_rule('minutes.missing', 'minutes not found', 'P0002'); end if;
  perform app.require(m.company_id, 'partners.manage');
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'profit sharing is Admin only', '42501'); end if;
  if m.status <> 'approved' then perform app.raise_rule('minutes.not_approved', 'profit is shared only by approved minutes', '22023'); end if;
  if exists (select 1 from acct.profit_share_runs where minutes_id = m.id and status = 'posted') then perform app.raise_rule('profit_share.already_posted', 'the profit share for these minutes is already posted', '22023'); end if;
  select * into fy from core.financial_years where id = m.fy_id;
  select coalesce(sum(g.cr - g.dr), 0) into v_net
  from acct.gl_entries g join acct.accounts a on a.id = g.account_id join acct.account_groups ag on ag.id = a.group_id
  where g.company_id = m.company_id and ag.nature in ('income', 'expense') and g.entry_date between fy.starts_on and fy.ends_on;
  if v_net <= 0 then perform app.raise_rule('profit_share.no_profit', 'the books show no net profit for this year', '22023'); end if;
  select coalesce(sum(share_pct), 0) into v_pct from acct.partners where company_id = m.company_id and status = 'active';
  if v_pct <> 100 then perform app.raise_rule('profit_share.share_pct_not_100', format('partners'' share percentages add up to %s, not 100; correct them on Partners', v_pct), '22023'); end if;
  update acct.profit_share_runs set status = 'superseded' where minutes_id = m.id and status = 'computed';
  insert into acct.profit_share_runs (company_id, minutes_id, fy_id, net_profit, computed_by) values (m.company_id, m.id, m.fy_id, round(v_net, 2), auth.uid()) returning id into v_run;
  for i in select * from jsonb_array_elements(coalesce(m.basis -> 'incentives', '[]'::jsonb)) loop
    v_amt := round(v_net * (i ->> 'pct')::numeric / 100, 2);
    insert into acct.profit_shares (run_id, company_id, partner_id, kind, pct, amount) values (v_run, m.company_id, (i ->> 'partner_id')::uuid, 'incentive', (i ->> 'pct')::numeric, v_amt);
    v_inc := v_inc + v_amt;
  end loop;
  v_dist := round(v_net, 2) - v_inc;
  for r in select id, share_pct from acct.partners where company_id = m.company_id and status = 'active' and share_pct > 0 order by share_pct, id loop
    v_amt := round(v_dist * r.share_pct / 100, 2);
    insert into acct.profit_shares (run_id, company_id, partner_id, kind, pct, amount) values (v_run, m.company_id, r.id, 'share', r.share_pct, v_amt) returning id into v_last;
    v_alloc := v_alloc + v_amt;
  end loop;
  -- Rounding difference goes to the largest share (the last row in share order).
  if v_last is not null and v_alloc <> v_dist then
    -- profit_shares is append-only, so the run is rebuilt: post a correcting row for the same partner.
    insert into acct.profit_shares (run_id, company_id, partner_id, kind, pct, amount)
    select v_run, m.company_id, partner_id, 'share', 0, v_dist - v_alloc from acct.profit_shares where id = v_last;
  end if;
  update acct.profit_share_runs set incentive_total = v_inc, distributable = v_dist where id = v_run;
  select jsonb_build_object('run_id', v_run, 'net_profit', round(v_net, 2), 'incentive_total', v_inc, 'distributable', v_dist,
           'lines', coalesce(jsonb_agg(jsonb_build_object('partner_id', s.partner_id, 'kind', s.kind, 'pct', s.pct, 'amount', s.amount) order by s.id), '[]'::jsonb))
    into v_res from acct.profit_shares s where s.run_id = v_run;
  return app.request_done(p_client_request_id, 'compute_profit_share', v_res);
end $$;

-- Post the computed share: Dr profit_share.incentive (incentives) and profit_share.distribution (the rest), Cr each partner's
-- current account. Posting rules are the CA's (data); the date must be in an open month.
create or replace function api.post_profit_share(p_client_request_id uuid, p_run_id uuid, p_post_date date default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; run acct.profit_share_runs; m acct.profit_share_minutes; v_date date := coalesce(p_post_date, current_date); v_fy uuid; v_no text; v_voucher uuid;
        v_lines jsonb := '[]'::jsonb; r record;
begin
  v_prev := app.request_seen(p_client_request_id, 'post_profit_share'); if v_prev is not null then return v_prev; end if;
  select * into run from acct.profit_share_runs where id = p_run_id for update;
  if run.id is null then perform app.raise_rule('profit_share.missing', 'computation not found', 'P0002'); end if;
  perform app.require(run.company_id, 'partners.manage');
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'profit sharing is Admin only', '42501'); end if;
  if run.status <> 'computed' then perform app.raise_rule('profit_share.state', 'this computation is ' || run.status, '22023'); end if;
  select * into m from acct.profit_share_minutes where id = run.minutes_id for update;
  if m.status <> 'approved' then perform app.raise_rule('minutes.not_approved', 'profit is shared only by approved minutes', '22023'); end if;
  if exists (select 1 from acct.profit_shares s join acct.partners p on p.id = s.partner_id where s.run_id = run.id and p.current_account_id is null) then
    perform app.raise_rule('partner.account_not_set', 'every partner sharing needs a current account on Partners', '22023');
  end if;
  perform app.check_backdate(run.company_id, v_date);
  v_fy := app.fy_for(run.company_id, v_date);
  if run.incentive_total > 0 then v_lines := v_lines || jsonb_build_object('account_id', app.rule_account(run.company_id, 'profit_share.incentive'), 'dr', run.incentive_total, 'narration', 'Incentives by minutes'); end if;
  if run.distributable > 0 then v_lines := v_lines || jsonb_build_object('account_id', app.rule_account(run.company_id, 'profit_share.distribution'), 'dr', run.distributable, 'narration', 'Profit share by minutes'); end if;
  for r in select p.current_account_id, sum(s.amount) amt from acct.profit_shares s join acct.partners p on p.id = s.partner_id where s.run_id = run.id group by p.current_account_id loop
    if r.amt <> 0 then v_lines := v_lines || jsonb_build_object('account_id', r.current_account_id, 'cr', r.amt, 'narration', 'Share by minutes ' || m.minutes_ref); end if;
  end loop;
  v_no := app.take_doc_number(run.company_id, null, 'journal', v_fy);
  v_voucher := app.post_voucher(jsonb_build_object('company_id', run.company_id, 'fy_id', v_fy, 'voucher_type', 'journal', 'doc_no', v_no, 'voucher_date', v_date,
                 'narration', 'Profit share by minutes ' || m.minutes_ref, 'client_request_id', p_client_request_id, 'source_table', 'acct.profit_share_runs', 'source_id', run.id), v_lines);
  update acct.profit_share_runs set status = 'posted', voucher_id = v_voucher, posted_by = auth.uid(), posted_at = now() where id = run.id;
  perform app.log_event('admin_action', jsonb_build_object('entity', 'profit_share', 'run_id', run.id, 'voucher_id', v_voucher));
  v_res := jsonb_build_object('run_id', run.id, 'status', 'posted', 'voucher_id', v_voucher, 'doc_no', v_no);
  return app.request_done(p_client_request_id, 'post_profit_share', v_res);
end $$;

-- ─────────── Investor portal (own rows and analytics only) ───────────
create or replace function app.investor_include_without_gst(p_company uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((app.setting(p_company, 'investor.include_without_gst') #>> '{}')::boolean, false)
$$;

-- Book net worth: equity accounts (opening + entries) plus the profit to date; without-GST entries excluded unless the policy allows.
create or replace function app.company_net_worth(p_company uuid, p_upto date) returns numeric
language sql stable security definer set search_path = '' as $$
  with inc as (select app.investor_include_without_gst(p_company) as w)
  select coalesce((select sum(case when a.opening_dc = 'C' then a.opening_balance else -a.opening_balance end)
                   from acct.accounts a join acct.account_groups ag on ag.id = a.group_id where a.company_id = p_company and ag.nature = 'equity'), 0)
       + coalesce((select sum(g.cr - g.dr) from acct.gl_entries g join acct.accounts a on a.id = g.account_id join acct.account_groups ag on ag.id = a.group_id, inc
                   where g.company_id = p_company and ag.nature in ('equity', 'income', 'expense') and g.entry_date <= p_upto
                     and (inc.w or g.tax_class <> 'without_gst')), 0)
$$;

create or replace function app.investor_partner_rows() returns table (
  partner_id uuid, company_id uuid, company_name text, display_name text, is_legal_partner boolean, is_investment_partner boolean, is_working_partner boolean,
  is_director boolean, shares bigint, share_pct numeric, language text, share_capital numeric, investment numeric)
language sql stable security definer set search_path = '' as $$
  select p.id, p.company_id, c.short_name, p.display_name, p.is_legal_partner, p.is_investment_partner, p.is_working_partner, p.is_director, p.shares, p.share_pct, p.language,
         coalesce((select sum(i.amount) from acct.partner_investments i where i.partner_id = p.id and i.kind = 'share_capital'), 0),
         coalesce((select sum(i.amount) from acct.partner_investments i where i.partner_id = p.id and i.kind in ('capital_account', 'project', 'other')), 0)
  from acct.partners p join core.companies c on c.id = p.company_id
  where p.user_id = auth.uid() and p.status = 'active'
$$;

-- Receipts by month and mode for the caller's companies (no party names). Without-GST receipts only under the policy.
create or replace function app.investor_money_in_rows(p_months int default 12) returns table (company_id uuid, month date, mode text, receipts int, amount numeric)
language sql stable security definer set search_path = '' as $$
  select v.company_id, date_trunc('month', v.voucher_date)::date, coalesce(v.mode, 'other'), count(*)::int, sum(v.amount)
  from acct.vouchers v
  where v.voucher_type = 'receipt' and v.status = 'posted'
    and v.company_id in (select p.company_id from acct.partners p where p.user_id = auth.uid() and p.status = 'active')
    and v.voucher_date >= (date_trunc('month', current_date) - make_interval(months => greatest(coalesce(p_months, 12), 1) - 1))::date
    and (v.tax_class <> 'without_gst' or app.investor_include_without_gst(v.company_id))
  group by 1, 2, 3
$$;

create or replace function api.investor_me() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'user_id', auth.uid(),
    'display_name', (select display_name from core.user_profiles where user_id = auth.uid()),
    'portal', app.can(null, 'investor.portal') or exists (select 1 from acct.partners where user_id = auth.uid()),
    'can_transact', false,
    'partners', coalesce((select jsonb_agg(jsonb_build_object('partner_id', r.partner_id, 'company_id', r.company_id, 'company', r.company_name, 'name', r.display_name,
                                   'legal_partner', r.is_legal_partner, 'investment_partner', r.is_investment_partner, 'working_partner', r.is_working_partner,
                                   'director', r.is_director, 'shares', r.shares, 'share_pct', r.share_pct, 'language', r.language) order by r.company_name)
                          from app.investor_partner_rows() r), '[]'::jsonb),
    'open_requests', (select count(*)::int from acct.partner_requests q join acct.partners p on p.id = q.partner_id where p.user_id = auth.uid() and q.status in ('submitted', 'approved')))
$$;

-- Group view: per company, own holding, investment, book net worth and the value of own shares, profit shares posted, own
-- loan account, and the last 12 months of money in (aggregate). FY optional (default: the current one of each company).
create or replace function api.investor_group_summary(p_on date default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  with d as (select coalesce(p_on, current_date) as on_date),
  rows as (select r.*, app.company_net_worth(r.company_id, d.on_date) as net_worth, d.on_date from app.investor_partner_rows() r, d)
  select jsonb_build_object(
    'as_of', (select on_date from d),
    'companies', coalesce((select jsonb_agg(jsonb_build_object(
        'partner_id', x.partner_id, 'company_id', x.company_id, 'company', x.company_name, 'shares', x.shares, 'share_pct', x.share_pct,
        'share_capital', x.share_capital, 'investment', x.investment, 'net_worth_book', round(x.net_worth, 2), 'value_of_my_shares', round(x.net_worth * x.share_pct / 100, 2),
        'profit_share_posted', coalesce((select sum(s.amount) from acct.profit_shares s join acct.profit_share_runs pr on pr.id = s.run_id and pr.status = 'posted' where s.partner_id = x.partner_id), 0),
        'my_loan_account', (select case when p.loan_account_id is null then null else round(app.account_credit_balance(p.loan_account_id, x.on_date), 2) end from acct.partners p where p.id = x.partner_id),
        'money_in_12m', coalesce((select sum(m.amount) from app.investor_money_in_rows(12) m where m.company_id = x.company_id), 0),
        'buyers_paying_12m', coalesce((select sum(m.receipts) from app.investor_money_in_rows(12) m where m.company_id = x.company_id), 0)) order by x.company_name)
      from rows x), '[]'::jsonb),
    'totals', jsonb_build_object('share_capital', coalesce((select sum(share_capital) from rows), 0), 'investment', coalesce((select sum(investment) from rows), 0),
                                 'value_of_my_shares', coalesce((select round(sum(net_worth * share_pct / 100), 2) from rows), 0)))
$$;

create or replace function app.investor_request_rows() returns table (
  id uuid, company_id uuid, company_name text, doc_no text, kind text, source text, project_id uuid, amount numeric, repay_months int, repay_from text, purpose text,
  status text, created_at timestamptz, decided_at timestamptz, decided_amount numeric, decision_note text, paid_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select q.id, q.company_id, c.short_name, q.doc_no, q.kind, q.source, q.project_id, q.amount, q.repay_months, q.repay_from, q.purpose, q.status, q.created_at, q.decided_at,
         q.decided_amount, q.decision_note, q.paid_at
  from acct.partner_requests q join acct.partners p on p.id = q.partner_id join core.companies c on c.id = q.company_id
  where p.user_id = auth.uid()
$$;

create or replace function app.investor_profit_share_rows() returns table (company_id uuid, company_name text, fy_label text, minutes_ref text, kind text, pct numeric, amount numeric, posted_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select s.company_id, c.short_name, fy.label, m.minutes_ref, s.kind, s.pct, s.amount, pr.posted_at
  from acct.profit_shares s join acct.profit_share_runs pr on pr.id = s.run_id and pr.status = 'posted' join acct.profit_share_minutes m on m.id = pr.minutes_id
  join core.financial_years fy on fy.id = pr.fy_id join acct.partners p on p.id = s.partner_id join core.companies c on c.id = s.company_id
  where p.user_id = auth.uid()
$$;

create or replace function app.investor_project_rows() returns table (id uuid, company_id uuid, company_name text, name text, status text, started_on date, summary text, investor_figures jsonb, updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select pp.id, pp.company_id, c.short_name, pp.name, pp.status, pp.started_on, pp.summary, pp.investor_figures, pp.updated_at
  from acct.partner_projects pp join core.companies c on c.id = pp.company_id
  where pp.visible_to_investors and pp.company_id in (select p.company_id from acct.partners p where p.user_id = auth.uid() and p.status = 'active')
$$;

-- ─────────── Month-end close ───────────
create or replace function app.close_due_on(p_company uuid, p_month date) returns date
language sql stable security definer set search_path = '' as $$
  select (p_month + interval '1 month')::date + (coalesce((app.setting(p_company, 'close.due_day') #>> '{}')::int, 10) - 1)
$$;

-- Open the month's checklist with the standard tasks (setting close.default_tasks). p: {doer_user_id?, checker_user_id?}
create or replace function api.open_close_checklist(p_client_request_id uuid, p_company_id uuid, p_period_id uuid, p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; per core.periods; v_id uuid; t jsonb; v_n int := 0; v_doer uuid := nullif(p ->> 'doer_user_id', '')::uuid; v_chk uuid := nullif(p ->> 'checker_user_id', '')::uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'open_close_checklist'); if v_prev is not null then return v_prev; end if;
  perform app.require(p_company_id, 'close.manage');
  select * into per from core.periods where id = p_period_id and company_id = p_company_id for update;
  if per.id is null then perform app.raise_rule('period.missing', 'month not found for this company', 'P0002'); end if;
  if per.status = 'closed' then perform app.raise_rule('period.already_closed', 'this month is already closed', '22023'); end if;
  if exists (select 1 from acct.close_checklists where period_id = per.id) then perform app.raise_rule('close.exists', 'this month already has a checklist', '22023'); end if;
  if v_doer is not null and v_doer = v_chk then perform app.raise_rule('sod.doer_is_checker', 'the person who does a task cannot also check it', '22023'); end if;
  insert into acct.close_checklists (company_id, period_id, due_on, created_by) values (p_company_id, per.id, app.close_due_on(p_company_id, per.month_start), auth.uid()) returning id into v_id;
  for t in select * from jsonb_array_elements(coalesce(app.setting(p_company_id, 'close.default_tasks'), '[]'::jsonb)) loop
    v_n := v_n + 1;
    insert into acct.close_tasks (company_id, checklist_id, title, area, sort, doer_user_id, checker_user_id)
    values (p_company_id, v_id, t ->> 'title', coalesce(t ->> 'area', 'other'), v_n * 10, v_doer, v_chk);
  end loop;
  v_res := jsonb_build_object('id', v_id, 'due_on', app.close_due_on(p_company_id, per.month_start), 'tasks', v_n);
  return app.request_done(p_client_request_id, 'open_close_checklist', v_res);
end $$;

-- p: {title, area, doer_user_id, checker_user_id}
create or replace function api.add_close_task(p_client_request_id uuid, p_checklist_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; c acct.close_checklists; v_id uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'add_close_task'); if v_prev is not null then return v_prev; end if;
  select * into c from acct.close_checklists where id = p_checklist_id for update;
  if c.id is null then perform app.raise_rule('close.missing', 'checklist not found', 'P0002'); end if;
  perform app.require(c.company_id, 'close.manage');
  if c.status <> 'open' then perform app.raise_rule('close.closed', 'this month is closed', '22023'); end if;
  if coalesce(length(trim(p ->> 'title')), 0) = 0 then perform app.raise_rule('close.title', 'name the task', '22023'); end if;
  if nullif(p ->> 'doer_user_id', '') is not null and p ->> 'doer_user_id' = p ->> 'checker_user_id' then perform app.raise_rule('sod.doer_is_checker', 'the person who does a task cannot also check it', '22023'); end if;
  insert into acct.close_tasks (company_id, checklist_id, title, area, sort, doer_user_id, checker_user_id)
  values (c.company_id, c.id, trim(p ->> 'title'), coalesce(nullif(p ->> 'area', ''), 'other'), coalesce(nullif(p ->> 'sort', '')::int, 500),
          nullif(p ->> 'doer_user_id', '')::uuid, nullif(p ->> 'checker_user_id', '')::uuid) returning id into v_id;
  v_res := jsonb_build_object('id', v_id);
  return app.request_done(p_client_request_id, 'add_close_task', v_res);
end $$;

-- p: {doer_user_id, checker_user_id}
create or replace function api.assign_close_task(p_client_request_id uuid, p_task_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; t acct.close_tasks;
begin
  v_prev := app.request_seen(p_client_request_id, 'assign_close_task'); if v_prev is not null then return v_prev; end if;
  select * into t from acct.close_tasks where id = p_task_id for update;
  if t.id is null then perform app.raise_rule('close.task_missing', 'task not found', 'P0002'); end if;
  perform app.require(t.company_id, 'close.manage');
  if t.status not in ('open', 'done') then perform app.raise_rule('close.task_state', 'this task is already ' || t.status, '22023'); end if;
  if coalesce(nullif(p ->> 'doer_user_id', '')::uuid, t.doer_user_id) = coalesce(nullif(p ->> 'checker_user_id', '')::uuid, t.checker_user_id) then
    perform app.raise_rule('sod.doer_is_checker', 'the person who does a task cannot also check it', '22023');
  end if;
  update acct.close_tasks set doer_user_id = coalesce(nullif(p ->> 'doer_user_id', '')::uuid, doer_user_id), checker_user_id = coalesce(nullif(p ->> 'checker_user_id', '')::uuid, checker_user_id)
  where id = t.id;
  v_res := jsonb_build_object('id', t.id);
  return app.request_done(p_client_request_id, 'assign_close_task', v_res);
end $$;

-- done (the doer) → check (someone else: the checker) ; return (the checker sends it back with a note).
create or replace function api.complete_close_task(p_client_request_id uuid, p_task_id uuid, p_action text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; t acct.close_tasks; c acct.close_checklists; v_mgr boolean;
begin
  v_prev := app.request_seen(p_client_request_id, 'complete_close_task'); if v_prev is not null then return v_prev; end if;
  select * into t from acct.close_tasks where id = p_task_id for update;
  if t.id is null then perform app.raise_rule('close.task_missing', 'task not found', 'P0002'); end if;
  select * into c from acct.close_checklists where id = t.checklist_id;
  if auth.uid() is null then perform app.raise_rule('auth.required', 'sign in', '42501'); end if;
  if app.current_view() = 'all-readonly' then perform app.raise_rule('rights.read_only', 'CA and auditor access cannot change data', '42501'); end if;
  v_mgr := app.can(t.company_id, 'close.manage');
  if not (v_mgr or auth.uid() = t.doer_user_id or auth.uid() = t.checker_user_id) then perform app.require(t.company_id, 'close.manage'); end if;
  if c.status <> 'open' then perform app.raise_rule('close.closed', 'this month is closed', '22023'); end if;
  if p_action = 'done' then
    if t.status <> 'open' then perform app.raise_rule('close.task_state', 'this task is already ' || t.status, '22023'); end if;
    if not (auth.uid() = t.doer_user_id or (t.doer_user_id is null and v_mgr)) then perform app.raise_rule('close.not_doer', 'this task is assigned to someone else', '42501'); end if;
    update acct.close_tasks set status = 'done', done_by = auth.uid(), done_at = now(), done_note = nullif(trim(p_note), '') where id = t.id;
  elsif p_action = 'check' then
    if t.status <> 'done' then perform app.raise_rule('close.task_state', 'only a done task is checked', '22023'); end if;
    if t.done_by = auth.uid() then perform app.raise_rule('sod.doer_is_checker', 'the person who did the task cannot check it', '42501'); end if;
    if not (auth.uid() = t.checker_user_id or (t.checker_user_id is null and v_mgr)) then perform app.raise_rule('close.not_checker', 'this task is checked by someone else', '42501'); end if;
    update acct.close_tasks set status = 'checked', checked_by = auth.uid(), checked_at = now(), check_note = nullif(trim(p_note), '') where id = t.id;
  elsif p_action = 'return' then
    if t.status <> 'done' then perform app.raise_rule('close.task_state', 'only a done task is sent back', '22023'); end if;
    if t.done_by = auth.uid() then perform app.raise_rule('sod.doer_is_checker', 'the person who did the task cannot check it', '42501'); end if;
    if not (auth.uid() = t.checker_user_id or (t.checker_user_id is null and v_mgr)) then perform app.raise_rule('close.not_checker', 'this task is checked by someone else', '42501'); end if;
    if coalesce(length(trim(p_note)), 0) < 5 then perform app.raise_rule('close.note', 'say what needs fixing', '22023'); end if;
    update acct.close_tasks set status = 'open', done_by = null, done_at = null, check_note = trim(p_note) where id = t.id;
  else
    perform app.raise_rule('close.action', 'done, check or return', '22023');
  end if;
  v_res := jsonb_build_object('id', t.id, 'status', (select status from acct.close_tasks where id = t.id));
  return app.request_done(p_client_request_id, 'complete_close_task', v_res);
end $$;

-- Move an open task to next month's checklist (opened if needed), with the reason.
create or replace function api.carry_close_task(p_client_request_id uuid, p_task_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; t acct.close_tasks; c acct.close_checklists; per core.periods; nxt core.periods; v_cl uuid; v_new uuid;
begin
  v_prev := app.request_seen(p_client_request_id, 'carry_close_task'); if v_prev is not null then return v_prev; end if;
  select * into t from acct.close_tasks where id = p_task_id for update;
  if t.id is null then perform app.raise_rule('close.task_missing', 'task not found', 'P0002'); end if;
  perform app.require(t.company_id, 'close.manage');
  if t.status not in ('open', 'done') then perform app.raise_rule('close.task_state', 'this task is already ' || t.status, '22023'); end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then perform app.raise_rule('close.reason', 'say why it moves to next month', '22023'); end if;
  select * into c from acct.close_checklists where id = t.checklist_id;
  select * into per from core.periods where id = c.period_id;
  select * into nxt from core.periods where company_id = t.company_id and month_start = (per.month_start + interval '1 month')::date;
  if nxt.id is null then perform app.raise_rule('period.missing', 'next month is not open yet; open the financial year first', '22023'); end if;
  select id into v_cl from acct.close_checklists where period_id = nxt.id;
  if v_cl is null then
    insert into acct.close_checklists (company_id, period_id, due_on, created_by) values (t.company_id, nxt.id, app.close_due_on(t.company_id, nxt.month_start), auth.uid()) returning id into v_cl;
  end if;
  insert into acct.close_tasks (company_id, checklist_id, title, area, sort, doer_user_id, checker_user_id)
  values (t.company_id, v_cl, t.title || ' (from ' || to_char(per.month_start, 'MM-YYYY') || ')', t.area, t.sort, t.doer_user_id, t.checker_user_id) returning id into v_new;
  update acct.close_tasks set status = 'carried', carried_to_task_id = v_new, carry_reason = trim(p_reason) where id = t.id;
  v_res := jsonb_build_object('id', t.id, 'status', 'carried', 'new_task_id', v_new);
  return app.request_done(p_client_request_id, 'carry_close_task', v_res);
end $$;

-- Close the month: every task checked or carried. After this nothing can be posted into it (app.fy_for + ledger triggers).
create or replace function api.close_period(p_client_request_id uuid, p_company_id uuid, p_period_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; per core.periods; c acct.close_checklists; v_open int;
begin
  v_prev := app.request_seen(p_client_request_id, 'close_period'); if v_prev is not null then return v_prev; end if;
  perform app.require(p_company_id, 'close.manage');
  select * into per from core.periods where id = p_period_id and company_id = p_company_id for update;
  if per.id is null then perform app.raise_rule('period.missing', 'month not found for this company', 'P0002'); end if;
  if per.status = 'closed' then perform app.raise_rule('period.already_closed', 'this month is already closed', '22023'); end if;
  if (per.month_start + interval '1 month')::date > current_date then perform app.raise_rule('close.month_not_over', 'a month is closed after it ends', '22023'); end if;
  select * into c from acct.close_checklists where period_id = per.id for update;
  if c.id is null then perform app.raise_rule('close.no_checklist', 'open the month-end checklist first', '22023'); end if;
  select count(*) into v_open from acct.close_tasks where checklist_id = c.id and status not in ('checked', 'carried');
  if v_open > 0 then perform app.raise_rule('close.tasks_open', format('%s checklist task(s) are not done and checked; finish them or move them to next month', v_open), '22023'); end if;
  update core.periods set status = 'closed', closed_at = now(), closed_by = auth.uid() where id = per.id;
  update acct.close_checklists set status = 'closed' where id = c.id;
  insert into acct.period_events (company_id, period_id, action, by_user) values (p_company_id, per.id, 'closed', auth.uid());
  perform app.log_event('admin_action', jsonb_build_object('entity', 'period', 'id', per.id, 'action', 'closed', 'month', per.month_start));
  v_res := jsonb_build_object('period_id', per.id, 'status', 'closed');
  return app.request_done(p_client_request_id, 'close_period', v_res);
end $$;

-- Reopen: Admin only, with a reason; logged. Locks again after close.reopen_hours (if set) via the hourly job.
create or replace function api.reopen_period(p_client_request_id uuid, p_company_id uuid, p_period_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; v_res jsonb; per core.periods; v_hours numeric; v_relock timestamptz;
begin
  v_prev := app.request_seen(p_client_request_id, 'reopen_period'); if v_prev is not null then return v_prev; end if;
  if auth.uid() is null then perform app.raise_rule('auth.required', 'sign in', '42501'); end if;
  if not app.is_admin() then perform app.raise_rule('period.reopen_admin_only', 'only Admin can reopen a closed month', '42501'); end if;
  if coalesce(length(trim(p_reason)), 0) < 10 then perform app.raise_rule('period.reason_required', 'give the reason for reopening (it goes to the user log)', '22023'); end if;
  select * into per from core.periods where id = p_period_id and company_id = p_company_id for update;
  if per.id is null then perform app.raise_rule('period.missing', 'month not found for this company', 'P0002'); end if;
  if per.status <> 'closed' then perform app.raise_rule('period.not_closed', 'this month is open', '22023'); end if;
  v_hours := nullif(app.setting(p_company_id, 'close.reopen_hours') #>> '{}', '')::numeric;
  if v_hours is not null then v_relock := now() + make_interval(secs => v_hours * 3600); end if;
  perform set_config('app.period_reopen', 'on', true);
  update core.periods set status = 'open', closed_at = null, closed_by = null where id = per.id;
  perform set_config('app.period_reopen', 'off', true);
  update acct.close_checklists set status = 'open' where period_id = per.id;
  insert into acct.period_events (company_id, period_id, action, reason, relock_at, by_user) values (p_company_id, per.id, 'reopened', trim(p_reason), v_relock, auth.uid());
  perform app.log_event('admin_action', jsonb_build_object('entity', 'period', 'id', per.id, 'action', 'reopened', 'reason', trim(p_reason), 'relock_at', v_relock));
  v_res := jsonb_build_object('period_id', per.id, 'status', 'open', 'relock_at', v_relock);
  return app.request_done(p_client_request_id, 'reopen_period', v_res);
end $$;

-- Relock reopened months whose window has passed; and, only when Admin switches on close.auto_lock, lock months past their
-- due date (open tasks move to the next month). Run by pg_cron.
create or replace function app.period_jobs(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; v_relocked int := 0; v_auto int := 0; t record; v_today date := (p_now at time zone 'Asia/Kolkata')::date; nxt uuid; v_cl uuid;
begin
  for r in select distinct on (e.period_id) e.period_id, e.company_id, e.action, e.relock_at from acct.period_events e order by e.period_id, e.at desc loop
    if r.action = 'reopened' and r.relock_at is not null and r.relock_at <= p_now
       and exists (select 1 from core.periods where id = r.period_id and status = 'open') then
      update core.periods set status = 'closed', closed_at = p_now where id = r.period_id;
      update acct.close_checklists set status = 'closed' where period_id = r.period_id;
      insert into acct.period_events (company_id, period_id, action, reason) values (r.company_id, r.period_id, 'relocked', 'reopen window ended');
      v_relocked := v_relocked + 1;
    end if;
  end loop;
  for r in select c.id, c.company_id, c.period_id, pe.month_start from acct.close_checklists c join core.periods pe on pe.id = c.period_id
            where pe.status = 'open' and c.due_on < v_today and coalesce((app.setting(c.company_id, 'close.auto_lock', v_today) #>> '{}')::boolean, false) loop
    select id into nxt from core.periods where company_id = r.company_id and month_start = (r.month_start + interval '1 month')::date;
    if nxt is not null then
      select id into v_cl from acct.close_checklists where period_id = nxt;
      if v_cl is null then
        insert into acct.close_checklists (company_id, period_id, due_on) values (r.company_id, nxt, app.close_due_on(r.company_id, (r.month_start + interval '1 month')::date)) returning id into v_cl;
      end if;
      for t in select * from acct.close_tasks where checklist_id = r.id and status in ('open', 'done') loop
        insert into acct.close_tasks (company_id, checklist_id, title, area, sort, doer_user_id, checker_user_id)
        values (t.company_id, v_cl, t.title || ' (from ' || to_char(r.month_start, 'MM-YYYY') || ')', t.area, t.sort, t.doer_user_id, t.checker_user_id);
        update acct.close_tasks set status = 'carried', carry_reason = 'month locked on its due date' where id = t.id;
      end loop;
    end if;
    update core.periods set status = 'closed', closed_at = p_now where id = r.period_id;
    update acct.close_checklists set status = 'closed' where id = r.id;
    insert into acct.period_events (company_id, period_id, action, reason) values (r.company_id, r.period_id, 'auto_closed', 'due date passed (close.auto_lock)');
    v_auto := v_auto + 1;
  end loop;
  return jsonb_build_object('relocked', v_relocked, 'auto_closed', v_auto);
end $$;

-- Daily Phase 7 job (IST morning): licence reminders and expiries, overdue job work.
create or replace function app.phase7_daily(p_date date default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_date date := coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date);
begin
  return jsonb_build_object('licences', app.licence_reminders_run(null, v_date), 'job_work_overdue', app.job_work_overdue_run(null, v_date));
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.schedule('phase7-daily', '0 2 * * *', 'select app.phase7_daily()');          -- 07:30 IST
      perform cron.schedule('period-relock', '15 * * * *', 'select app.period_jobs()');
    exception when others then
      raise notice 'could not schedule Phase 7 jobs: %', sqlerrm;
    end;
  end if;
end $$;

revoke all on all functions in schema api from public, anon;
grant execute on all functions in schema api to authenticated;
grant execute on function api.log_sign_in_failure(text) to anon;
revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;

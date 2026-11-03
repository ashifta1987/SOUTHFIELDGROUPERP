-- 20261103007400_phase7_setting_keys.sql
-- Settings keys may hold only letters, dots and underscores (core.settings key check), so the Companies Act settings are
-- named without section numbers: companies_act.director_loan_exception (s.185) and companies_act.loan_limit (s.186).
-- Replaces app.check_partner_loan from 20261103007200 with those keys; behaviour is otherwise unchanged. Additive.

create or replace function app.check_partner_loan(p acct.partners, p_amount numeric, p_on date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb; v_limit numeric; v_out numeric;
begin
  if p.is_director or p.director_interested then
    -- s.185: only when the allowed exception is recorded with the CA ({basis, resolution_ref, ...}).
    v := app.setting(p.company_id, 'companies_act.director_loan_exception', p_on);
    if v is null or jsonb_typeof(v) <> 'object' or coalesce(length(trim(v ->> 'basis')), 0) = 0 then
      perform app.raise_rule('companies_act.s185', 'loans to directors, and to people or firms they are interested in, are restricted by Companies Act s.185; '
                             || 'record the allowed exception with the CA on Settings first', '42501');
    end if;
    return jsonb_build_object('section', '185', 'exception', v);
  end if;
  -- s.186: the limit the CA works out, recorded by Admin.
  v_limit := nullif(app.setting(p.company_id, 'companies_act.loan_limit', p_on) #>> '{}', '')::numeric;
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

revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;

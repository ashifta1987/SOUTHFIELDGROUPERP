-- 20261103002500_payroll_fix.sql
-- Fix: a PL/pgSQL loop variable shadowed a SQL alias in api.approve_payroll. Function replacement only.

create or replace function api.approve_payroll(p_client_request_id uuid, p_run_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; r hr.payroll_runs; v_fy uuid; v_no text; v_voucher uuid; v_gross numeric; v_net numeric; v_adv numeric; v_ded numeric; v_round numeric; v_res jsonb; v_slip record; v_date date;
begin
  v_prev := app.request_seen(p_client_request_id, 'approve_payroll'); if v_prev is not null then return v_prev; end if;
  select * into r from hr.payroll_runs where id = p_run_id for update;
  perform app.require(r.company_id, 'payroll.run');
  if r.status <> 'draft' then perform app.raise_rule('payroll.month_locked', 'already approved', '22023'); end if;
  if r.prepared_by = auth.uid() then perform app.raise_rule('sod.self_approval', 'the person who prepared the payroll cannot approve it', '42501'); end if;
  select coalesce(sum(gross), 0), coalesce(sum(net), 0), coalesce(sum(advance_recovery), 0), coalesce(sum(deductions), 0), coalesce(sum(round_off), 0)
    into v_gross, v_net, v_adv, v_ded, v_round from hr.payslips where run_id = r.id;
  v_date := (r.month + interval '1 month - 1 day')::date;
  if v_gross > 0 then
    v_fy := app.fy_for(r.company_id, v_date);
    v_no := 'PAY/' || to_char(r.month, 'YYYY-MM');
    v_voucher := app.post_voucher(jsonb_build_object('company_id', r.company_id, 'fy_id', v_fy, 'voucher_type', 'payroll', 'doc_no', v_no, 'voucher_date', v_date,
        'narration', 'Payroll ' || to_char(r.month, 'Mon YYYY'), 'source_table', 'hr.payroll_runs', 'source_id', r.id, 'client_request_id', p_client_request_id),
      (select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(jsonb_build_array(
        jsonb_build_object('account_id', app.rule_account(r.company_id, 'payroll.salary_expense'), 'dr', v_gross),
        jsonb_build_object('account_id', case when v_round <> 0 then app.rule_account(r.company_id, 'round_off') end, 'dr', greatest(v_round, 0), 'cr', greatest(-v_round, 0)),
        jsonb_build_object('account_id', case when v_adv > 0 then app.rule_account(r.company_id, 'payroll.advances') end, 'cr', v_adv),
        jsonb_build_object('account_id', case when v_ded > 0 then app.rule_account(r.company_id, 'payroll.deductions') end, 'cr', v_ded),
        jsonb_build_object('account_id', app.rule_account(r.company_id, 'payroll.salary_payable'), 'cr', v_net))) e where e ->> 'account_id' is not null));
  end if;
  update hr.cash_given c set recovered_run_id = r.id from hr.payslips ps
   where ps.run_id = r.id and ps.person_id = c.person_id and c.company_id = r.company_id and c.recovered_run_id is null and ps.advance_recovery > 0;
  update hr.payroll_runs set status = 'posted', approved_by = auth.uid(), approved_at = now(), voucher_id = v_voucher where id = r.id;
  for v_slip in select person_id from hr.payslips where run_id = r.id loop
    perform app.enqueue_message(jsonb_build_object('company_id', r.company_id, 'event', 'hr.payslip_ready', 'template', 'payslip_ready', 'person_id', v_slip.person_id,
      'doc_type', 'hr.payroll_runs', 'doc_id', r.id, 'stage', 'payslip_ready', 'params', jsonb_build_object('month', to_char(r.month, 'FMMonth YYYY'))));
  end loop;
  v_res := jsonb_build_object('run_id', r.id, 'voucher_id', v_voucher);
  return app.request_done(p_client_request_id, 'approve_payroll', v_res);
end $$;

notify pgrst, 'reload schema';

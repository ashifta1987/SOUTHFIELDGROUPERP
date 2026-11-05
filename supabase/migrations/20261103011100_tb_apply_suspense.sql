-- 20261103011100_tb_apply_suspense.sql
-- Trial Balance → opening balances, extended (additive, Admin only):
--   * p_book_difference + p_reason : books Tally's OWN "Difference in opening balances" into a clearly named Suspense ledger
--     ("CA to clear"). Refused when the difference is larger than the file itself declares (Trial Balance totals, or the staged
--     Balance Sheet whose two sides differ by it) - it can never absorb an unexplained gap. Opens a HIGH Bug fixer item for the CA.
--   * Tally's pseudo-lines (Opening Stock, Closing Stock, Unadjusted Forex Gain/Loss) are not ledgers: never opened. When the file
--     carries them, their net is parked in a second Suspense ledger, so the books stay visibly honest.
--   * p_skip_unmapped : apply the ledgers that can be placed, list the rest in the report result, status 'partly_applied'.
--   * p_zero_unlisted : ledgers that still carry a start-of-year opening but are not in the Trial Balance (Tally lists every ledger
--     with a closing balance) are set to zero as of the report date.
--   * A ledger line with no group in the file (Tally XML) takes the group of the same ledger in the loaded Tally masters.
-- Nothing is posted to the GL, stock or vouchers. Also: when a duplicate decision later re-runs a ledger whose account already
-- exists (created here), the party is linked to that account.

-- A report can be partly applied (a later apply may complete it).
do $$
declare v_name text;
begin
  select conname into v_name from pg_constraint where conrelid = 'ops.tally_reports'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%superseded%';
  if v_name is not null then execute format('alter table ops.tally_reports drop constraint %I', v_name); end if;
  alter table ops.tally_reports add constraint tally_reports_status_check check (status in ('staged', 'partly_applied', 'applied', 'superseded'));
end $$;

-- imp_ledger: an account that already exists without a party gets the party once the ledger is decided.
do $$
declare
  v_def text; v_new text;
  v_old constant text := $q$    if v_acc.group_id <> v_ag.id then$q$;
  v_rep constant text := $q$    if v_acc.party_id is null and v_party is not null then update acct.accounts set party_id = v_party where id = v_acc.id; end if;
    if v_acc.group_id <> v_ag.id then$q$;
begin
  v_def := pg_get_functiondef('app.imp_ledger(ops.import_batches, ops.import_rows)'::regprocedure);
  v_new := replace(v_def, v_old, v_rep);
  if v_new = v_def then raise exception 'imp_ledger party-link patch did not match'; end if;
  execute v_new;
end $$;

-- Group for a Trial Balance ledger: the file's own group chain, else (flat XML) the group of the same ledger in the loaded masters.
create or replace function app.tb_resolve_group(p_company uuid, p_name text, p_parents jsonb) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_grp uuid; v_parent text;
begin
  for v_parent in select jsonb_array_elements_text(coalesce(p_parents, '[]'::jsonb)) loop
    select account_group_id into v_grp from ops.tally_group_map where company_id = p_company and tally_group = v_parent;
    exit when v_grp is not null;
  end loop;
  if v_grp is null and jsonb_array_length(coalesce(p_parents, '[]'::jsonb)) = 0 then
    select m.account_group_id into v_grp
    from ops.import_rows x join ops.import_batches b on b.id = x.batch_id
    join ops.tally_group_map m on m.company_id = p_company and m.tally_group = x.payload ->> 'parent'
    where b.company_id = p_company and b.status <> 'undone' and x.object_type = 'ledger' and app.norm_name(x.name) = app.norm_name(p_name)
    order by x.id desc limit 1;
  end if;
  return v_grp;
end $$;

-- Tally's pseudo-lines in a Trial Balance (valuation and computed lines, not ledgers).
create or replace function app.tb_is_pseudo(p_name text, p_parents jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_array_length(coalesce(p_parents, '[]'::jsonb)) = 0
     and lower(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g')) in ('opening stock', 'closing stock', 'unadjusted forex gain/loss')
$$;

-- The difference the file itself declares: its own "Diff in opening balances" row, else the gap between the two sides of the
-- staged Balance Sheet of the same company and date (Tally shows the same difference there).
create or replace function app.tb_declared_difference(p_report ops.tally_reports) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_d numeric; v_bs ops.tally_reports;
begin
  v_d := abs(coalesce(nullif(p_report.totals ->> 'diff_dr', '')::numeric, 0) - coalesce(nullif(p_report.totals ->> 'diff_cr', '')::numeric, 0));
  if v_d > 0.004 then return jsonb_build_object('amount', round(v_d, 2), 'source', 'trial_balance_file'); end if;
  select * into v_bs from ops.tally_reports where company_id = p_report.company_id and kind = 'balance_sheet' and as_of = p_report.as_of and status <> 'superseded'
   order by uploaded_at desc limit 1;
  if v_bs.id is not null then
    v_d := abs(coalesce(nullif(v_bs.totals ->> 'liabilities', '')::numeric, 0) - coalesce(nullif(v_bs.totals ->> 'assets', '')::numeric, 0));
    return jsonb_build_object('amount', round(v_d, 2), 'source', 'balance_sheet_file', 'report_id', v_bs.id);
  end if;
  return jsonb_build_object('amount', 0, 'source', 'none');
end $$;

-- Find or open a Suspense ledger (under the company's Suspense A/c group, else Current Liabilities / Current Assets by sign).
create or replace function app.tb_suspense_account(p_company uuid, p_name text, p_net numeric, p_as_of date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_grp uuid; v_id uuid;
begin
  select id into v_grp from acct.account_groups where company_id = p_company and parent_id is null and name = 'Suspense A/c';
  if v_grp is null then select account_group_id into v_grp from ops.tally_group_map where company_id = p_company and tally_group = 'Suspense A/c'; end if;
  if v_grp is null then
    select id into v_grp from acct.account_groups where company_id = p_company and parent_id is null and name = case when p_net < 0 then 'Current Liabilities' else 'Current Assets' end;
  end if;
  if v_grp is null then perform app.raise_rule('report.no_suspense_group', 'the company has no Suspense or Current group to hold the difference', '22023'); end if;
  insert into acct.accounts (company_id, group_id, name, opening_balance, opening_dc, opening_as_of, status)
  values (p_company, v_grp, p_name, abs(p_net), case when p_net >= 0 then 'D' else 'C' end, p_as_of, 'to_review')
  on conflict (company_id, name) do update set opening_balance = excluded.opening_balance, opening_dc = excluded.opening_dc, opening_as_of = excluded.opening_as_of
  returning id into v_id;
  return v_id;
end $$;

drop function if exists api.apply_trial_balance_as_opening(uuid, uuid);

create or replace function api.apply_trial_balance_as_opening(
  p_client_request_id uuid, p_report_id uuid,
  p_book_difference boolean default false, p_reason text default null,
  p_skip_unmapped boolean default false, p_zero_unlisted boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; rp ops.tally_reports; l jsonb; v_net numeric; v_acc acct.accounts; v_grp uuid; v_party uuid; v_is_party text;
  v_all_dr numeric := 0; v_all_cr numeric := 0; v_all numeric; v_excl numeric := 0; v_skipped_net numeric := 0;
  v_unmapped text[] := '{}'; v_skipped jsonb := '[]'::jsonb; v_excluded jsonb := '[]'::jsonb; v_created int := 0; v_updated int := 0; v_n int := 0; v_zeroed int := 0; v_zero_net numeric := 0;
  v_res jsonb; v_cdr numeric; v_ccr numeric; v_bills numeric; v_tally_dr numeric; v_tally_cr numeric; v_decl jsonb; v_decl_amt numeric;
  v_s1 uuid; v_s2 uuid; v_s1_net numeric := 0; v_s2_net numeric := 0; v_status text; v_applied_dr numeric := 0; v_applied_cr numeric := 0; z record;
  v_ledgers jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'apply_trial_balance_as_opening'); if v_prev is not null then return v_prev; end if;
  select * into rp from ops.tally_reports where id = p_report_id for update;
  if not found then perform app.raise_rule('report.missing', 'report not found', 'P0002'); end if;
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'only Admin sets opening balances from a Trial Balance', '42501'); end if;
  if rp.kind <> 'trial_balance' then perform app.raise_rule('report.kind', 'this is not a Trial Balance', '22023'); end if;
  if rp.status not in ('staged', 'partly_applied') then perform app.raise_rule('report.already_applied', 'this report was already applied (a report is applied once)', '22023'); end if;
  if rp.grain <> 'ledger' then
    perform app.raise_rule('report.group_wise', 'this Trial Balance lists groups only. Export the ledger-wise (expanded) Trial Balance from TallyPrime and load that file.', '22023');
  end if;
  if exists (select 1 from acct.vouchers where company_id = rp.company_id and voucher_date > rp.as_of) then
    perform app.raise_rule('report.vouchers_after', 'the company already has posted vouchers after ' || to_char(rp.as_of, 'DD-MM-YYYY') || '; opening balances can only be set before posting starts', '22023');
  end if;
  if p_book_difference and coalesce(length(trim(p_reason)), 0) < 5 then
    perform app.raise_rule('rights.reason_required', 'say why the difference is carried (reason required)', '22023');
  end if;

  select coalesce(sum((x ->> 'dr')::numeric), 0), coalesce(sum((x ->> 'cr')::numeric), 0) into v_all_dr, v_all_cr
  from jsonb_array_elements(rp.lines) x where not coalesce((x ->> 'is_group')::boolean, false);
  v_all := round(v_all_dr - v_all_cr, 2);
  v_tally_dr := nullif(rp.totals ->> 'tally_dr', '')::numeric; v_tally_cr := nullif(rp.totals ->> 'tally_cr', '')::numeric;
  v_decl := app.tb_declared_difference(rp); v_decl_amt := (v_decl ->> 'amount')::numeric;

  -- Dr = Cr is required unless the explicit option is used; the file's own grand totals must agree with its lines.
  if (v_tally_dr is not null and abs(v_tally_dr - v_all_dr) > 0.01) or (v_tally_cr is not null and abs(v_tally_cr - v_all_cr) > 0.01)
     or (abs(v_all) > 0.01 and not p_book_difference) then
    perform app.open_bug(jsonb_build_object('company_id', rp.company_id, 'area', 'ledger', 'kind', 'total_mismatch', 'severity', 'high', 'who_fixes', 'ca',
      'title', 'Trial Balance does not balance: Dr ' || v_all_dr || ' and Cr ' || v_all_cr, 'amount', abs(v_all),
      'evidence', jsonb_build_object('report_id', rp.id, 'ledger_dr', v_all_dr, 'ledger_cr', v_all_cr, 'tally_grand_dr', v_tally_dr, 'tally_grand_cr', v_tally_cr, 'as_of', rp.as_of, 'declared_difference', v_decl),
      'suggested_fix', 'Export the Trial Balance again with every ledger shown (expanded), or find the ledger missing from the file. If the file carries Tally''s own "Difference in opening balances", Admin can apply with the option to carry it in a Suspense ledger. Nothing was changed.',
      'ref_table', 'ops.tally_reports', 'ref_id', rp.id, 'dedupe_key', 'tbmis|' || rp.id));
    v_res := jsonb_build_object('applied', false, 'refused', 'total_mismatch', 'dr', v_all_dr, 'cr', v_all_cr, 'difference', v_all, 'declared_difference', v_decl,
                                'message', 'Debit and credit totals differ. Nothing was changed; see the Bug fixer item.');
    return app.request_done(p_client_request_id, 'apply_trial_balance_as_opening', v_res);
  end if;
  if p_book_difference and round(abs(v_all) - v_decl_amt, 2) > 0 then
    perform app.open_bug(jsonb_build_object('company_id', rp.company_id, 'area', 'ledger', 'kind', 'total_mismatch', 'severity', 'high', 'who_fixes', 'ca',
      'title', 'Trial Balance gap is larger than the difference the file declares', 'amount', round(abs(v_all) - v_decl_amt, 2),
      'evidence', jsonb_build_object('report_id', rp.id, 'ledger_difference', v_all, 'declared_difference', v_decl, 'as_of', rp.as_of),
      'suggested_fix', 'Part of the gap is not explained by the file. Find the missing or extra ledger. Nothing was changed.',
      'ref_table', 'ops.tally_reports', 'ref_id', rp.id, 'dedupe_key', 'tbgap|' || rp.id));
    v_res := jsonb_build_object('applied', false, 'refused', 'difference_exceeds_declared', 'difference', v_all, 'declared_difference', v_decl,
                                'message', 'The gap is larger than the difference Tally declares in the file. Nothing was changed; see the Bug fixer item.');
    return app.request_done(p_client_request_id, 'apply_trial_balance_as_opening', v_res);
  end if;

  -- Place every ledger; pseudo-lines are set aside, the rest need a group (existing accounts keep theirs).
  for l in select x from jsonb_array_elements(rp.lines) x where not coalesce((x ->> 'is_group')::boolean, false) loop
    v_net := coalesce((l ->> 'dr')::numeric, 0) - coalesce((l ->> 'cr')::numeric, 0);
    if app.tb_is_pseudo(l ->> 'name', l -> 'parents') then
      v_excl := v_excl + v_net;
      v_excluded := v_excluded || jsonb_build_array(jsonb_build_object('name', l ->> 'name', 'dr', coalesce((l ->> 'dr')::numeric, 0), 'cr', coalesce((l ->> 'cr')::numeric, 0)));
      continue;
    end if;
    select * into v_acc from acct.accounts where company_id = rp.company_id and name_norm = app.norm_name(l ->> 'name');
    if v_acc.id is null and app.tb_resolve_group(rp.company_id, l ->> 'name', l -> 'parents') is null then
      v_unmapped := v_unmapped || coalesce((l -> 'parents' ->> 0), '(no group)');
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('name', l ->> 'name', 'group', coalesce(l -> 'parents' ->> 0, '(no group)'), 'dr', coalesce((l ->> 'dr')::numeric, 0), 'cr', coalesce((l ->> 'cr')::numeric, 0)));
      v_skipped_net := v_skipped_net + v_net;
    end if;
  end loop;

  if cardinality(v_unmapped) > 0 and not p_skip_unmapped then
    for z in select distinct u from unnest(v_unmapped) u where u <> '(no group)' loop
      perform app.open_bug(jsonb_build_object('company_id', rp.company_id, 'area', 'ledger', 'kind', 'map_head', 'severity', 'high', 'who_fixes', 'ca',
        'title', 'Map this head: ' || z.u, 'evidence', jsonb_build_object('tally_group', z.u, 'report_id', rp.id),
        'suggested_fix', 'Map the Tally group to an ERP account group (Chart of accounts), then apply the Trial Balance again. Nothing was changed.',
        'ref_table', 'ops.tally_reports', 'ref_id', rp.id, 'dedupe_key', 'map|' || rp.company_id || '|' || app.norm_name(z.u)));
    end loop;
    v_res := jsonb_build_object('applied', false, 'refused', 'unmapped', 'groups', (select jsonb_agg(distinct u) from unnest(v_unmapped) u), 'ledgers', cardinality(v_unmapped),
                                'message', 'Some ledgers are under Tally groups that are not mapped yet (or have no group in the file). Nothing was changed; map them (Bug fixer: Map this head) and apply again, or apply the rest with the skip option.');
    return app.request_done(p_client_request_id, 'apply_trial_balance_as_opening', v_res);
  end if;

  for l in select x from jsonb_array_elements(rp.lines) x where not coalesce((x ->> 'is_group')::boolean, false) loop
    if app.tb_is_pseudo(l ->> 'name', l -> 'parents') then continue; end if;
    v_net := coalesce((l ->> 'dr')::numeric, 0) - coalesce((l ->> 'cr')::numeric, 0);
    select * into v_acc from acct.accounts where company_id = rp.company_id and name_norm = app.norm_name(l ->> 'name');
    if v_acc.id is null then
      v_grp := app.tb_resolve_group(rp.company_id, l ->> 'name', l -> 'parents');
      if v_grp is null then continue; end if; -- skipped (listed above)
      select is_party_group into v_is_party from acct.account_groups where id = v_grp;
      v_party := null;
      if v_is_party is not null then
        select id into v_party from master.parties where name_norm = app.norm_name(l ->> 'name') and status <> 'merged' limit 1;
        if v_party is null then select party_id into v_party from master.party_aliases where alias_norm = app.norm_name(l ->> 'name') limit 1; end if;
      end if;
      insert into acct.accounts (company_id, group_id, name, party_id, opening_balance, opening_dc, opening_as_of, status)
      values (rp.company_id, v_grp, trim(l ->> 'name'), v_party, abs(v_net), case when v_net >= 0 then 'D' else 'C' end, rp.as_of, 'to_review')
      returning * into v_acc;
      v_created := v_created + 1;
    else
      update acct.accounts set opening_balance = abs(v_net), opening_dc = case when v_net >= 0 then 'D' else 'C' end, opening_as_of = rp.as_of where id = v_acc.id;
      v_updated := v_updated + 1;
    end if;
    v_n := v_n + 1;
    if v_net >= 0 then v_applied_dr := v_applied_dr + v_net; else v_applied_cr := v_applied_cr - v_net; end if;
    -- Bill-wise detail stays as loaded (unclassified opening bills); a difference with the new opening is a Bug fixer item.
    select coalesce(sum(case when dc = 'D' then amount else -amount end), 0) into v_bills from acct.open_bills where account_id = v_acc.id;
    if exists (select 1 from acct.open_bills where account_id = v_acc.id) and abs(v_bills - v_net) > 0.01 then
      perform app.open_bug(jsonb_build_object('company_id', rp.company_id, 'area', 'ledger', 'kind', 'total_mismatch', 'severity', 'medium', 'who_fixes', 'ca',
        'title', 'Bills do not add up to the opening balance: ' || (l ->> 'name'), 'amount', abs(v_bills - v_net),
        'evidence', jsonb_build_object('ledger', l ->> 'name', 'opening', v_net, 'bills_total', v_bills, 'report_id', rp.id),
        'suggested_fix', 'Find the missing or extra bill in Tally. Bill-wise detail is not changed by the Trial Balance.', 'ref_id', v_acc.id, 'dedupe_key', 'billsum|' || v_acc.id || '|' || rp.as_of));
    end if;
  end loop;

  -- Ledgers that still carry a start-of-year opening but are not in the report (Tally lists every ledger with a closing balance).
  if p_zero_unlisted then
    for z in select a.id, a.opening_balance, a.opening_dc from acct.accounts a
             where a.company_id = rp.company_id and a.opening_balance <> 0 and a.opening_as_of is distinct from rp.as_of
               and not exists (select 1 from jsonb_array_elements(rp.lines) x where app.norm_name(x ->> 'name') = a.name_norm and not coalesce((x ->> 'is_group')::boolean, false)) loop
      update acct.accounts set opening_balance = 0, opening_dc = 'D', opening_as_of = rp.as_of where id = z.id;
      v_zeroed := v_zeroed + 1; v_zero_net := v_zero_net + case when z.opening_dc = 'D' then z.opening_balance else -z.opening_balance end;
    end loop;
  end if;

  -- Tally's own difference and its pseudo-lines go to named Suspense ledgers (never hidden).
  if p_book_difference then
    if abs(v_all) > 0.004 then
      v_s1_net := -v_all;
      v_s1 := app.tb_suspense_account(rp.company_id, 'Difference in opening balances (Tally) — CA to clear', v_s1_net, rp.as_of);
      perform app.open_bug(jsonb_build_object('company_id', rp.company_id, 'area', 'ledger', 'kind', 'total_mismatch', 'severity', 'high', 'who_fixes', 'ca',
        'title', 'Opening balances carry Tally''s own difference of ' || abs(v_all), 'amount', abs(v_all),
        'evidence', jsonb_build_object('report_id', rp.id, 'as_of', rp.as_of, 'difference_dr_minus_cr', v_all, 'declared_difference', v_decl, 'suspense_account_id', v_s1, 'reason', p_reason),
        'suggested_fix', 'Find the cause in Tally (Difference in opening balances) and clear the Suspense ledger with a journal approved by the CA.',
        'ref_table', 'acct.accounts', 'ref_id', v_s1, 'dedupe_key', 'tbdiff|' || rp.id));
    end if;
    if abs(v_excl) > 0.004 then
      v_s2_net := v_excl;
      v_s2 := app.tb_suspense_account(rp.company_id, 'Tally computed lines not carried (Opening Stock, Unadjusted Forex) — CA to clear', v_s2_net, rp.as_of);
      perform app.open_bug(jsonb_build_object('company_id', rp.company_id, 'area', 'ledger', 'kind', 'total_mismatch', 'severity', 'high', 'who_fixes', 'ca',
        'title', 'Tally lines that are not ledgers were parked in Suspense: ' || abs(v_excl), 'amount', abs(v_excl),
        'evidence', jsonb_build_object('report_id', rp.id, 'as_of', rp.as_of, 'lines', v_excluded, 'net_dr_minus_cr', v_excl, 'suspense_account_id', v_s2),
        'suggested_fix', 'Opening Stock comes in with the opening stock posting; Unadjusted Forex Gain/Loss is computed by Tally. The CA decides how both are carried, then clears this Suspense ledger.',
        'ref_table', 'acct.accounts', 'ref_id', v_s2, 'dedupe_key', 'tbpseudo|' || rp.id));
    end if;
  end if;

  if jsonb_array_length(v_skipped) > 0 then
    perform app.open_bug(jsonb_build_object('company_id', rp.company_id, 'area', 'ledger', 'kind', 'other', 'severity', 'high', 'who_fixes', 'admin',
      'title', 'Trial Balance ledgers not opened: ' || jsonb_array_length(v_skipped) || ' (no ERP ledger and no group)', 'amount', abs(v_skipped_net),
      'evidence', jsonb_build_object('report_id', rp.id, 'as_of', rp.as_of, 'skipped', v_skipped, 'net_dr_minus_cr', v_skipped_net),
      'suggested_fix', 'Decide the group of each ledger (or map its Tally group), then apply the Trial Balance again to open them.',
      'ref_table', 'ops.tally_reports', 'ref_id', rp.id, 'dedupe_key', 'tbskip|' || rp.id));
  end if;

  -- The whole company's opening must balance (nothing else may carry an opening that is not in the report).
  select coalesce(sum(opening_balance) filter (where opening_dc = 'D'), 0), coalesce(sum(opening_balance) filter (where opening_dc = 'C'), 0) into v_cdr, v_ccr
  from acct.accounts where company_id = rp.company_id;
  if abs(v_cdr - v_ccr) > 0.01 then
    perform app.raise_rule('report.opening_unbalanced', 'opening balances would not balance (Dr ' || v_cdr || ', Cr ' || v_ccr || '): other ledgers of this company carry opening balances that are not in the report, or ledgers were skipped. Nothing was changed.', '22023');
  end if;

  v_status := case when jsonb_array_length(v_skipped) > 0 then 'partly_applied' else 'applied' end;
  update ops.tally_reports set status = 'superseded' where company_id = rp.company_id and kind = 'trial_balance' and status in ('applied', 'partly_applied') and id <> rp.id;
  v_res := jsonb_build_object('applied', true, 'status', v_status, 'ledgers', v_n, 'created', v_created, 'updated', v_updated, 'zeroed_unlisted', v_zeroed, 'zeroed_unlisted_net', v_zero_net,
                              'dr', v_all_dr, 'cr', v_all_cr, 'difference', v_all, 'declared_difference', v_decl,
                              'excluded_pseudo_lines', v_excluded, 'excluded_net', v_excl,
                              'suspense', jsonb_build_object('tally_difference_account', v_s1, 'tally_difference_net_dr', v_s1_net, 'pseudo_lines_account', v_s2, 'pseudo_lines_net_dr', v_s2_net, 'reason', p_reason),
                              'skipped', v_skipped, 'skipped_count', jsonb_array_length(v_skipped), 'as_of', rp.as_of,
                              'company_dr', v_cdr, 'company_cr', v_ccr,
                              'message', 'Opening balances set for ' || v_n || ' ledgers' || case when v_status = 'partly_applied' then ' (' || jsonb_array_length(v_skipped) || ' not opened, see Bug fixer)' else '' end || '. No ledger entries were posted. Bill-wise detail is unchanged.');
  update ops.tally_reports set status = v_status, applied_by = auth.uid(), applied_at = now(), result = v_res where id = rp.id;
  perform app.log_event('admin_action', jsonb_build_object('entity', 'tally_report', 'action', 'applied_opening', 'report', rp.id, 'ledgers', v_n, 'booked_difference', p_book_difference,
                        'reason', p_reason, 'skipped', jsonb_array_length(v_skipped), 'zeroed_unlisted', v_zeroed));
  return app.request_done(p_client_request_id, 'apply_trial_balance_as_opening', v_res);
end $$;

revoke all on function app.tb_resolve_group(uuid, text, jsonb), app.tb_is_pseudo(text, jsonb), app.tb_declared_difference(ops.tally_reports), app.tb_suspense_account(uuid, text, numeric, date) from public, anon;
grant execute on function app.tb_resolve_group(uuid, text, jsonb), app.tb_is_pseudo(text, jsonb), app.tb_declared_difference(ops.tally_reports), app.tb_suspense_account(uuid, text, numeric, date) to authenticated;
revoke all on function api.apply_trial_balance_as_opening(uuid, uuid, boolean, text, boolean, boolean) from public, anon;
grant execute on function api.apply_trial_balance_as_opening(uuid, uuid, boolean, text, boolean, boolean) to authenticated;
notify pgrst, 'reload schema';

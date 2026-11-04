-- 20261103010000_tally_reports.sql
-- Tally reports import: Day Book (reference history), Trial Balance (opening balances), Stock Summary (opening stock)
-- and Balance Sheet (reconciliation). Additive only.
--   * ops.tally_vouchers.dc  : Debit / Credit side of a one-leg Day Book line (no counter-legs, never posted)
--   * app.imp_voucher        : Day Book lines carry their own match_key (type|no|date|amount|party|dr-or-cr|#n)
--   * api.import_process_step: process staged rows in slices so 45,000+ lines never hit a request timeout
--   * Voucher rows are Admin-only (bills without GST must stay hidden from everyone but Admin and the CA)
--   * ops.tally_reports      : staged Trial Balance / Stock Summary / Balance Sheet (append-only history)
--   * RPCs: stage_tally_report, apply_trial_balance_as_opening, apply_stock_summary_as_opening_stock,
--           map_tally_stock_item, compare_trial_balance, compare_balance_sheet; views for lists and differences.

-- ═════════════════════════ Day Book: the debit/credit side and the key ═════════════════════════
alter table ops.tally_vouchers add column if not exists dc char(1) check (dc in ('D', 'C'));

create or replace function app.imp_voucher(b ops.import_batches, r ops.import_rows) returns text
language plpgsql security definer set search_path = '' as $$
declare
  p jsonb := r.payload; v_key text; v_existing ops.tally_vouchers; v_amount numeric := coalesce(nullif(p ->> 'amount', '')::numeric, 0); v_party uuid;
  v_sum numeric; v_id uuid; v_date date := nullif(p ->> 'date', '')::date;
  v_dc char(1) := case lower(coalesce(p ->> 'dc', '')) when 'dr' then 'D' when 'd' then 'D' when 'cr' then 'C' when 'c' then 'C' else null end;
begin
  if v_date is null then
    update ops.import_rows set message = 'no date' where id = r.id;
    return 'error';
  end if;
  v_key := coalesce(r.guid, nullif(p ->> 'match_key', ''), concat_ws('|', p ->> 'type', p ->> 'number', p ->> 'date', p ->> 'amount', p ->> 'party'));
  select * into v_existing from ops.tally_vouchers where company_id = b.company_id and match_key = v_key;
  if v_existing.id is not null and v_existing.state <> 'reversed' then
    update ops.import_rows set erp_table = 'ops.tally_vouchers', erp_id = v_existing.id where id = r.id;
    if r.alter_id is not null and v_existing.alter_id is not null and r.alter_id > v_existing.alter_id
       and (v_existing.amount <> v_amount or v_existing.lines <> coalesce(p -> 'lines', '[]'::jsonb) or v_existing.voucher_date <> v_date) then
      update ops.import_rows set bug_id = app.open_bug(jsonb_build_object(
        'company_id', b.company_id, 'area', 'import', 'kind', 'changed_in_tally', 'severity', 'high', 'batch_id', b.id, 'amount', v_amount,
        'title', 'Changed in Tally after loading: ' || coalesce(p ->> 'type', '') || ' ' || coalesce(p ->> 'number', ''),
        'evidence', jsonb_build_object('before', to_jsonb(v_existing), 'after', p, 'alter_id_before', v_existing.alter_id, 'alter_id_after', r.alter_id),
        'suggested_fix', 'The loaded entry is untouched. After approval it is reversed and posted again.',
        'ref_table', 'ops.tally_vouchers', 'ref_id', v_existing.id, 'dedupe_key', 'chgv|' || v_existing.id || '|' || r.alter_id)) where id = r.id;
      return 'changed';
    end if;
    return 'skipped';
  end if;
  select id into v_party from master.parties where name_norm = app.norm_name(p ->> 'party') and status <> 'merged' limit 1;
  if v_party is null then select party_id into v_party from master.party_aliases where alias_norm = app.norm_name(p ->> 'party') limit 1; end if;
  if v_existing.id is not null then
    update ops.tally_vouchers set state = 'loaded', batch_id = b.id, alter_id = r.alter_id, lines = coalesce(p -> 'lines', '[]'::jsonb), amount = v_amount, dc = coalesce(v_dc, dc) where id = v_existing.id returning id into v_id;
  else
    insert into ops.tally_vouchers (company_id, guid, voucher_type, voucher_no, voucher_date, party_name, party_id, amount, is_cancelled, is_optional, alter_id, lines, match_key, batch_id, state, dc)
    values (b.company_id, r.guid, coalesce(p ->> 'type', 'Unknown'), p ->> 'number', v_date, p ->> 'party', v_party, v_amount,
            coalesce((p ->> 'cancelled')::boolean, false), coalesce((p ->> 'optional')::boolean, false), r.alter_id, coalesce(p -> 'lines', '[]'::jsonb), v_key, b.id,
            case when coalesce((p ->> 'cancelled')::boolean, false) or coalesce((p ->> 'optional')::boolean, false) then 'flagged' else 'loaded' end, v_dc)
    returning id into v_id;
  end if;
  update ops.import_rows set erp_table = 'ops.tally_vouchers', erp_id = v_id where id = r.id;
  select sum((l ->> 'amount')::numeric) into v_sum from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) l;
  if v_sum is not null and abs(v_sum) > 0.01 then
    perform app.open_bug(jsonb_build_object('company_id', b.company_id, 'area', 'ledger', 'kind', 'unbalanced_voucher', 'severity', 'high', 'batch_id', b.id, 'who_fixes', 'ca',
      'title', 'Voucher does not balance: ' || coalesce(p ->> 'type', '') || ' ' || coalesce(p ->> 'number', ''), 'amount', abs(v_sum),
      'evidence', jsonb_build_object('voucher', p, 'difference', v_sum), 'suggested_fix', 'Correct it in Tally and load again, or post a correcting journal.',
      'ref_table', 'ops.tally_vouchers', 'ref_id', v_id, 'dedupe_key', 'unbal|' || v_id));
  end if;
  return 'created';
end $$;

-- Voucher rows (any Day Book / voucher type, including types that are sold without GST) are visible only to Admin and the CA.
-- Additive: a RESTRICTIVE policy is ANDed with the existing read policy.
create policy import_rows_voucher_admin_ca on ops.import_rows as restrictive for select to authenticated
  using (object_type <> 'voucher' or app.current_view() in ('all', 'all-readonly'));

-- Staging voucher rows needs Admin (same reading as the policy above): a person with only "Load Tally data" cannot load vouchers.
create or replace function api.import_stage_rows(p_batch_id uuid, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare b ops.import_batches; v_start int; v_n int;
begin
  select * into b from ops.import_batches where id = p_batch_id for update;
  if not found then perform app.raise_rule('import.missing', 'batch not found', 'P0002'); end if;
  perform app.require(b.company_id, 'data.import');
  if b.status not in ('uploaded', 'staged') then perform app.raise_rule('import.locked', 'this batch can no longer take rows', '22023'); end if;
  if not app.is_admin() and exists (select 1 from jsonb_array_elements(p_rows) e where e ->> 'object_type' = 'voucher') then
    perform app.raise_rule('rights.missing', 'only Admin loads vouchers (they can include bills without GST)', '42501');
  end if;
  select coalesce(max(seq), 0) into v_start from ops.import_rows where batch_id = p_batch_id;
  insert into ops.import_rows (batch_id, seq, object_type, name, guid, master_id, alter_id, payload)
  select p_batch_id, v_start + ord::int, e ->> 'object_type', nullif(trim(e ->> 'name'), ''), nullif(e ->> 'guid', ''), nullif(e ->> 'master_id', ''),
         nullif(e ->> 'alter_id', '')::bigint, coalesce(e -> 'payload', '{}'::jsonb)
  from jsonb_array_elements(p_rows) with ordinality as t(e, ord);
  get diagnostics v_n = row_count;
  update ops.import_batches set status = 'staged' where id = p_batch_id;
  return jsonb_build_object('staged', v_n);
end $$;

-- Process at most p_limit pending rows (same decisions as api.import_process); call until remaining = 0, then call
-- api.import_process once to finish the batch (it finds nothing left to decide, then counts and reconciles).
create or replace function api.import_process_step(p_client_request_id uuid, p_batch_id uuid, p_limit int default 500) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; b ops.import_batches; r ops.import_rows; v_result text; v_res jsonb; v_left int;
begin
  v_prev := app.request_seen(p_client_request_id, 'import_process_step'); if v_prev is not null then return v_prev; end if;
  select * into b from ops.import_batches where id = p_batch_id for update;
  if not found then perform app.raise_rule('import.missing', 'batch not found', 'P0002'); end if;
  perform app.require(b.company_id, 'data.import');
  if b.status not in ('staged', 'processed') then perform app.raise_rule('import.locked', 'this batch cannot be processed now', '22023'); end if;
  for r in select * from ops.import_rows where batch_id = p_batch_id and result is null order by app.imp_rank(object_type), seq limit greatest(least(coalesce(p_limit, 500), 2000), 1) loop
    begin
      v_result := case r.object_type
        when 'group' then app.imp_group(b, r)
        when 'ledger' then app.imp_ledger(b, r)
        when 'stock_group' then app.imp_stock_group(b, r)
        when 'unit' then app.imp_unit(b, r)
        when 'stock_item' then app.imp_stock_item(b, r)
        when 'employee' then app.imp_employee(b, r)
        when 'voucher' then app.imp_voucher(b, r)
        else 'skipped' end;
      update ops.import_rows set result = v_result, message = case when v_result in ('bug') then message else null end where id = r.id;
    exception when others then
      update ops.import_rows set result = 'error', message = left(sqlerrm, 300) where id = r.id;
      perform app.open_bug(jsonb_build_object('company_id', b.company_id, 'area', 'import', 'kind', 'other', 'severity', 'high', 'batch_id', b.id,
        'title', 'Row could not be loaded: ' || coalesce(r.name, r.object_type), 'evidence', jsonb_build_object('row', r.payload, 'error', sqlerrm),
        'suggested_fix', 'Check the row in Tally and load again.', 'dedupe_key', 'err|' || r.id));
    end;
  end loop;
  select count(*) into v_left from ops.import_rows where batch_id = p_batch_id and result is null;
  v_res := jsonb_build_object('id', p_batch_id, 'remaining', v_left);
  return app.request_done(p_client_request_id, 'import_process_step', v_res);
end $$;

-- ═════════════════════════ Reports from Tally ═════════════════════════
create table ops.tally_reports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies (id),
  kind text not null check (kind in ('trial_balance', 'stock_summary', 'balance_sheet')),
  as_of date not null,
  period_from date,
  period_to date,
  file_name text,
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  company_name_in_file text,
  grain text not null default 'ledger' check (grain in ('ledger', 'group', 'unknown')),
  lines jsonb not null check (jsonb_typeof(lines) = 'array'),
  totals jsonb not null default '{}'::jsonb,
  status text not null default 'staged' check (status in ('staged', 'applied', 'superseded')),
  result jsonb,
  uploaded_by uuid references auth.users (id),
  uploaded_at timestamptz not null default now(),
  applied_by uuid references auth.users (id),
  applied_at timestamptz,
  unique (company_id, kind, as_of, file_sha256)
);
create index on ops.tally_reports (company_id, kind, as_of);

-- Append-only: the staged lines and totals never change; only the status moves forward (staged → applied → superseded).
create or replace function app.tally_reports_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.company_id <> old.company_id or new.kind <> old.kind or new.as_of <> old.as_of or new.file_sha256 <> old.file_sha256
     or new.lines is distinct from old.lines or new.totals is distinct from old.totals or new.grain <> old.grain or new.uploaded_by is distinct from old.uploaded_by then
    raise exception 'a staged Tally report is history and is never edited' using errcode = '42501', hint = 'ledger.append_only';
  end if;
  if old.status = 'superseded' and new.status <> 'superseded' then
    raise exception 'a superseded report stays superseded' using errcode = '22023', hint = 'ledger.append_only';
  end if;
  return new;
end $$;
create trigger tally_reports_guard before update on ops.tally_reports for each row execute function app.tally_reports_guard();
create trigger tally_reports_no_delete before delete on ops.tally_reports for each row execute function app.reject_change();
create trigger audit_row after insert or update or delete on ops.tally_reports for each row execute function app.audit_trigger();

alter table ops.tally_reports enable row level security;
revoke all on ops.tally_reports from anon, authenticated;
grant select on ops.tally_reports to authenticated;
create policy tally_reports_read on ops.tally_reports for select to authenticated
  using (app.can(company_id, 'data.import') or app.current_view() in ('all', 'all-readonly'));

create or replace function app.can_read_report(p_company uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.can(p_company, 'data.import') or app.current_view() in ('all', 'all-readonly')
$$;

-- ─────────── Stage a report (any of the three kinds) ───────────
-- p: {company_id, kind, as_of, period_from, period_to, file_name, file_sha256, company_name, grain, lines: [...], totals: {...}}
-- Trial Balance line: {name, parents: [closest group first], is_group, dr, cr}
-- Stock Summary line: {name, parents, is_group, qty, unit, rate, value}
-- Balance Sheet line: {side 'L'|'A', name, depth, is_group, is_total, amount}
-- The server recomputes the sums from the ledger / item lines; the file's own grand total is kept as "tally_*" for comparison.
create or replace function api.stage_tally_report(p_client_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; v_company uuid := (p ->> 'company_id')::uuid; v_kind text := p ->> 'kind'; v_asof date := nullif(p ->> 'as_of', '')::date;
  v_sha text := lower(coalesce(p ->> 'file_sha256', '')); v_lines jsonb := coalesce(p -> 'lines', '[]'::jsonb); v_tot jsonb := coalesce(p -> 'totals', '{}'::jsonb);
  v_id uuid; v_existing ops.tally_reports; v_grain text := coalesce(nullif(p ->> 'grain', ''), 'ledger'); v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'stage_tally_report'); if v_prev is not null then return v_prev; end if;
  perform app.require(v_company, 'data.import');
  if v_kind not in ('trial_balance', 'stock_summary', 'balance_sheet') then perform app.raise_rule('report.kind', 'unknown report kind', '22023'); end if;
  if v_asof is null then perform app.raise_rule('report.as_of', 'the report date (as of) is required', '22023'); end if;
  if v_sha !~ '^[0-9a-f]{64}$' then perform app.raise_rule('report.sha', 'the file checksum (sha256) is required', '22023'); end if;
  if jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) = 0 then perform app.raise_rule('report.no_lines', 'the report has no lines', '22023'); end if;
  if v_grain not in ('ledger', 'group', 'unknown') then v_grain := 'unknown'; end if;
  select * into v_existing from ops.tally_reports where company_id = v_company and kind = v_kind and as_of = v_asof and file_sha256 = v_sha;
  if v_existing.id is not null then
    v_res := jsonb_build_object('id', v_existing.id, 'duplicate', true, 'status', v_existing.status);
    return app.request_done(p_client_request_id, 'stage_tally_report', v_res);
  end if;
  if v_kind = 'trial_balance' then
    v_tot := v_tot || (select jsonb_build_object('dr', coalesce(sum((l ->> 'dr')::numeric), 0), 'cr', coalesce(sum((l ->> 'cr')::numeric), 0), 'ledgers', count(*))
                       from jsonb_array_elements(v_lines) l where not coalesce((l ->> 'is_group')::boolean, false));
    if v_tot ->> 'ledgers' = '0' then v_grain := 'group'; end if;
  elsif v_kind = 'stock_summary' then
    v_tot := v_tot || (select jsonb_build_object('qty', coalesce(sum((l ->> 'qty')::numeric), 0), 'value', coalesce(sum((l ->> 'value')::numeric), 0), 'items', count(*))
                       from jsonb_array_elements(v_lines) l where not coalesce((l ->> 'is_group')::boolean, false));
  else
    v_tot := v_tot || (select jsonb_build_object('liabilities', coalesce(sum((l ->> 'amount')::numeric) filter (where l ->> 'side' = 'L' and coalesce((l ->> 'is_total')::boolean, false)), 0),
                                                 'assets', coalesce(sum((l ->> 'amount')::numeric) filter (where l ->> 'side' = 'A' and coalesce((l ->> 'is_total')::boolean, false)), 0))
                       from jsonb_array_elements(v_lines) l);
  end if;
  insert into ops.tally_reports (company_id, kind, as_of, period_from, period_to, file_name, file_sha256, company_name_in_file, grain, lines, totals, uploaded_by)
  values (v_company, v_kind, v_asof, nullif(p ->> 'period_from', '')::date, nullif(p ->> 'period_to', '')::date, left(p ->> 'file_name', 200), v_sha,
          left(p ->> 'company_name', 200), v_grain, v_lines, v_tot, auth.uid())
  returning id into v_id;
  perform app.log_event('admin_action', jsonb_build_object('entity', 'tally_report', 'kind', v_kind, 'as_of', v_asof, 'file', p ->> 'file_name'));
  v_res := jsonb_build_object('id', v_id, 'duplicate', false, 'status', 'staged', 'totals', v_tot, 'grain', v_grain);
  return app.request_done(p_client_request_id, 'stage_tally_report', v_res);
end $$;

-- ─────────── Trial Balance → opening balances (Admin only; the CA signs the numbers) ───────────
create or replace function api.apply_trial_balance_as_opening(p_client_request_id uuid, p_report_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; rp ops.tally_reports; l jsonb; v_dr numeric := 0; v_cr numeric := 0; v_net numeric; v_acc acct.accounts; v_grp uuid; v_parent text; v_party uuid;
  v_unmapped text[] := '{}'; v_created int := 0; v_updated int := 0; v_n int := 0; v_res jsonb; v_cdr numeric; v_ccr numeric; v_bills numeric;
  v_tally_dr numeric; v_tally_cr numeric; v_is_party text;
begin
  v_prev := app.request_seen(p_client_request_id, 'apply_trial_balance_as_opening'); if v_prev is not null then return v_prev; end if;
  select * into rp from ops.tally_reports where id = p_report_id for update;
  if not found then perform app.raise_rule('report.missing', 'report not found', 'P0002'); end if;
  if not app.is_admin() then perform app.raise_rule('rights.missing', 'only Admin sets opening balances from a Trial Balance', '42501'); end if;
  if rp.kind <> 'trial_balance' then perform app.raise_rule('report.kind', 'this is not a Trial Balance', '22023'); end if;
  if rp.status <> 'staged' then perform app.raise_rule('report.already_applied', 'this report was already applied (a report is applied once)', '22023'); end if;
  if rp.grain <> 'ledger' then
    perform app.raise_rule('report.group_wise', 'this Trial Balance lists groups only. Export the ledger-wise (expanded) Trial Balance from TallyPrime and load that file.', '22023');
  end if;
  if exists (select 1 from acct.vouchers where company_id = rp.company_id and voucher_date > rp.as_of) then
    perform app.raise_rule('report.vouchers_after', 'the company already has posted vouchers after ' || to_char(rp.as_of, 'DD-MM-YYYY') || '; opening balances can only be set before posting starts', '22023');
  end if;

  select coalesce(sum((x ->> 'dr')::numeric), 0), coalesce(sum((x ->> 'cr')::numeric), 0) into v_dr, v_cr
  from jsonb_array_elements(rp.lines) x where not coalesce((x ->> 'is_group')::boolean, false);
  v_tally_dr := nullif(rp.totals ->> 'tally_dr', '')::numeric; v_tally_cr := nullif(rp.totals ->> 'tally_cr', '')::numeric;
  if abs(v_dr - v_cr) > 0.01 or (v_tally_dr is not null and abs(v_tally_dr - v_dr) > 0.01) or (v_tally_cr is not null and abs(v_tally_cr - v_cr) > 0.01) then
    perform app.open_bug(jsonb_build_object('company_id', rp.company_id, 'area', 'ledger', 'kind', 'total_mismatch', 'severity', 'high', 'who_fixes', 'ca',
      'title', 'Trial Balance does not balance: Dr ' || v_dr || ' and Cr ' || v_cr, 'amount', abs(v_dr - v_cr),
      'evidence', jsonb_build_object('report_id', rp.id, 'ledger_dr', v_dr, 'ledger_cr', v_cr, 'tally_grand_dr', v_tally_dr, 'tally_grand_cr', v_tally_cr, 'as_of', rp.as_of),
      'suggested_fix', 'Export the Trial Balance again with every ledger shown (expanded), or find the ledger missing from the file. Nothing was changed.',
      'ref_table', 'ops.tally_reports', 'ref_id', rp.id, 'dedupe_key', 'tbmis|' || rp.id));
    v_res := jsonb_build_object('applied', false, 'refused', 'total_mismatch', 'dr', v_dr, 'cr', v_cr, 'difference', round(v_dr - v_cr, 2),
                                'message', 'Debit and credit totals differ. Nothing was changed; see the Bug fixer item.');
    return app.request_done(p_client_request_id, 'apply_trial_balance_as_opening', v_res);
  end if;

  -- Resolve every ledger first; apply nothing unless all of them can be placed.
  for l in select x from jsonb_array_elements(rp.lines) x where not coalesce((x ->> 'is_group')::boolean, false) loop
    v_net := coalesce((l ->> 'dr')::numeric, 0) - coalesce((l ->> 'cr')::numeric, 0);
    select * into v_acc from acct.accounts where company_id = rp.company_id and name_norm = app.norm_name(l ->> 'name');
    v_grp := null;
    if v_acc.id is null then
      for v_parent in select jsonb_array_elements_text(coalesce(l -> 'parents', '[]'::jsonb)) loop
        select account_group_id into v_grp from ops.tally_group_map where company_id = rp.company_id and tally_group = v_parent;
        exit when v_grp is not null;
      end loop;
      if v_grp is null then
        v_unmapped := v_unmapped || coalesce((l -> 'parents' ->> 0), '(no group)');
      end if;
    end if;
  end loop;
  if cardinality(v_unmapped) > 0 then
    for v_parent in select distinct u from unnest(v_unmapped) u loop
      perform app.open_bug(jsonb_build_object('company_id', rp.company_id, 'area', 'ledger', 'kind', 'map_head', 'severity', 'high', 'who_fixes', 'ca',
        'title', 'Map this head: ' || v_parent, 'evidence', jsonb_build_object('tally_group', v_parent, 'report_id', rp.id),
        'suggested_fix', 'Map the Tally group to an ERP account group (Chart of accounts), then apply the Trial Balance again. Nothing was changed.',
        'ref_table', 'ops.tally_reports', 'ref_id', rp.id, 'dedupe_key', 'map|' || rp.company_id || '|' || app.norm_name(v_parent)));
    end loop;
    v_res := jsonb_build_object('applied', false, 'refused', 'unmapped', 'groups', (select jsonb_agg(distinct u) from unnest(v_unmapped) u), 'ledgers', cardinality(v_unmapped),
                                'message', 'Some ledgers are under Tally groups that are not mapped yet. Nothing was changed; map them (Bug fixer: Map this head) and apply again.');
    return app.request_done(p_client_request_id, 'apply_trial_balance_as_opening', v_res);
  end if;

  for l in select x from jsonb_array_elements(rp.lines) x where not coalesce((x ->> 'is_group')::boolean, false) loop
    v_net := coalesce((l ->> 'dr')::numeric, 0) - coalesce((l ->> 'cr')::numeric, 0);
    select * into v_acc from acct.accounts where company_id = rp.company_id and name_norm = app.norm_name(l ->> 'name');
    if v_acc.id is null then
      v_grp := null;
      for v_parent in select jsonb_array_elements_text(coalesce(l -> 'parents', '[]'::jsonb)) loop
        select account_group_id into v_grp from ops.tally_group_map where company_id = rp.company_id and tally_group = v_parent;
        exit when v_grp is not null;
      end loop;
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
    -- Bill-wise detail stays as loaded (unclassified opening bills); a difference with the new opening is a Bug fixer item.
    select coalesce(sum(case when dc = 'D' then amount else -amount end), 0) into v_bills from acct.open_bills where account_id = v_acc.id;
    if exists (select 1 from acct.open_bills where account_id = v_acc.id) and abs(v_bills - v_net) > 0.01 then
      perform app.open_bug(jsonb_build_object('company_id', rp.company_id, 'area', 'ledger', 'kind', 'total_mismatch', 'severity', 'medium', 'who_fixes', 'ca',
        'title', 'Bills do not add up to the opening balance: ' || (l ->> 'name'), 'amount', abs(v_bills - v_net),
        'evidence', jsonb_build_object('ledger', l ->> 'name', 'opening', v_net, 'bills_total', v_bills, 'report_id', rp.id),
        'suggested_fix', 'Find the missing or extra bill in Tally. Bill-wise detail is not changed by the Trial Balance.', 'ref_id', v_acc.id, 'dedupe_key', 'billsum|' || v_acc.id || '|' || rp.as_of));
    end if;
  end loop;

  -- The whole company's opening must stay balanced.
  select coalesce(sum(opening_balance) filter (where opening_dc = 'D'), 0), coalesce(sum(opening_balance) filter (where opening_dc = 'C'), 0) into v_cdr, v_ccr
  from acct.accounts where company_id = rp.company_id;
  if abs(v_cdr - v_ccr) > 0.01 then
    perform app.raise_rule('report.opening_unbalanced', 'opening balances would not balance (Dr ' || v_cdr || ', Cr ' || v_ccr || '): other ledgers of this company carry opening balances that are not in the report. Nothing was changed.', '22023');
  end if;

  update ops.tally_reports set status = 'superseded' where company_id = rp.company_id and kind = 'trial_balance' and status = 'applied' and id <> rp.id;
  v_res := jsonb_build_object('applied', true, 'ledgers', v_n, 'created', v_created, 'updated', v_updated, 'dr', v_dr, 'cr', v_cr, 'as_of', rp.as_of,
                              'message', 'Opening balances set for ' || v_n || ' ledgers. No ledger entries were posted. Bill-wise detail is unchanged.');
  update ops.tally_reports set status = 'applied', applied_by = auth.uid(), applied_at = now(), result = v_res where id = rp.id;
  perform app.log_event('admin_action', jsonb_build_object('entity', 'tally_report', 'action', 'applied_opening', 'report', rp.id, 'ledgers', v_n));
  return app.request_done(p_client_request_id, 'apply_trial_balance_as_opening', v_res);
end $$;

-- ─────────── Stock Summary: matching to products ───────────
create or replace function app.tally_stock_match(p_report uuid) returns table (name text, parents jsonb, qty numeric, unit text, rate numeric, value numeric, product_id uuid, product_name text, product_uom text, status text)
language sql stable security definer set search_path = '' as $$
  select x.name, x.parents, x.qty, x.unit, x.rate, x.value, m.id, m.name, m.uom,
         case when x.qty is null or x.qty <= 0 then 'not_posted' when m.id is null then 'unmatched' else 'matched' end
  from ops.tally_reports r
  cross join lateral (
    select l ->> 'name' as name, l -> 'parents' as parents, (l ->> 'qty')::numeric as qty, l ->> 'unit' as unit, (l ->> 'rate')::numeric as rate, (l ->> 'value')::numeric as value
    from jsonb_array_elements(r.lines) l where not coalesce((l ->> 'is_group')::boolean, false)) x
  left join lateral (
    select p.id, p.name, p.uom from master.products p
    where (p.name_norm = app.norm_name(x.name) or exists (select 1 from master.product_aliases a where a.product_id = p.id and a.alias_norm = app.norm_name(x.name)))
      and exists (select 1 from master.product_companies pc where pc.product_id = p.id and pc.company_id = r.company_id)
    order by (p.name_norm = app.norm_name(x.name)) desc, p.created_at limit 1) m on true
  where r.id = p_report and r.kind = 'stock_summary' and app.can_read_report(r.company_id)
$$;

create or replace view api.tally_report_stock_match with (security_invoker = true) as
select r.id as report_id, r.company_id, m.name, m.qty, m.unit, m.rate, m.value, m.product_id, m.product_name, m.product_uom, m.status
from ops.tally_reports r cross join lateral app.tally_stock_match(r.id) m where r.kind = 'stock_summary';

-- Map a Tally item name to an existing product (an alias, never a new product).
create or replace function api.map_tally_stock_item(p_client_request_id uuid, p_report_id uuid, p_tally_name text, p_product_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; rp ops.tally_reports; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'map_tally_stock_item'); if v_prev is not null then return v_prev; end if;
  select * into rp from ops.tally_reports where id = p_report_id;
  if not found then perform app.raise_rule('report.missing', 'report not found', 'P0002'); end if;
  perform app.require(rp.company_id, 'data.import');
  if rp.kind <> 'stock_summary' or rp.status <> 'staged' then perform app.raise_rule('report.locked', 'only a staged Stock Summary can be mapped', '22023'); end if;
  if not exists (select 1 from jsonb_array_elements(rp.lines) l where l ->> 'name' = p_tally_name and not coalesce((l ->> 'is_group')::boolean, false)) then
    perform app.raise_rule('report.item_missing', 'that item is not in the report', '22023');
  end if;
  if not exists (select 1 from master.products where id = p_product_id) then perform app.raise_rule('report.product_missing', 'product not found', 'P0002'); end if;
  insert into master.product_companies (product_id, company_id) values (p_product_id, rp.company_id) on conflict do nothing;
  insert into master.product_aliases (product_id, alias, source) values (p_product_id, trim(p_tally_name), 'tally') on conflict do nothing;
  v_res := jsonb_build_object('product_id', p_product_id, 'alias', trim(p_tally_name));
  return app.request_done(p_client_request_id, 'map_tally_stock_item', v_res);
end $$;

-- ─────────── Stock Summary → opening stock (Admin or inventory.approve) ───────────
create or replace function api.apply_stock_summary_as_opening_stock(p_client_request_id uuid, p_report_id uuid, p_place_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; rp ops.tally_reports; m record; v_lines jsonb := '[]'::jsonb; v_unmatched jsonb := '[]'::jsonb; v_skipped int := 0; v_n int := 0;
  v_qty numeric := 0; v_val numeric := 0; v_res jsonb; v_post jsonb; v_unit text; v_cost numeric; v_lot text;
begin
  v_prev := app.request_seen(p_client_request_id, 'apply_stock_summary_as_opening_stock'); if v_prev is not null then return v_prev; end if;
  select * into rp from ops.tally_reports where id = p_report_id for update;
  if not found then perform app.raise_rule('report.missing', 'report not found', 'P0002'); end if;
  perform app.require(rp.company_id, 'inventory.approve');
  if rp.kind <> 'stock_summary' then perform app.raise_rule('report.kind', 'this is not a Stock Summary', '22023'); end if;
  if rp.status <> 'staged' then perform app.raise_rule('report.already_applied', 'this report was already applied (opening stock is posted once)', '22023'); end if;
  if not exists (select 1 from core.places where id = p_place_id and company_id = rp.company_id) then
    perform app.raise_rule('stock.place_missing', 'choose a store of this company to receive the opening stock', '22023');
  end if;
  v_lot := 'OPEN-' || to_char(rp.as_of, 'YYMMDD');
  for m in select * from app.tally_stock_match(p_report_id) loop
    if m.status = 'not_posted' then
      v_skipped := v_skipped + 1;
      perform app.open_bug(jsonb_build_object('company_id', rp.company_id, 'area', 'stock', 'kind', 'negative_stock', 'severity', 'high', 'who_fixes', 'store',
        'title', case when coalesce(m.qty, 0) < 0 then 'Below zero in Tally: ' else 'Zero quantity in the Stock Summary: ' end || m.name,
        'evidence', jsonb_build_object('item', m.name, 'qty', m.qty, 'value', m.value, 'report_id', rp.id),
        'suggested_fix', 'Find the missing receipt or production entry in Tally. This line was not posted as opening stock.', 'ref_table', 'ops.tally_reports', 'ref_id', rp.id,
        'dedupe_key', 'stkneg|' || rp.id || '|' || app.norm_name(m.name)));
    elsif m.status = 'unmatched' then
      v_unmatched := v_unmatched || jsonb_build_array(jsonb_build_object('name', m.name, 'qty', m.qty, 'unit', m.unit, 'rate', m.rate, 'value', m.value));
    else
      v_cost := coalesce(m.rate, case when m.qty > 0 then round(m.value / m.qty, 4) end, 0);
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('product_id', m.product_id, 'qty', m.qty, 'unit_cost', v_cost, 'lot_no', v_lot));
      v_qty := v_qty + m.qty; v_val := v_val + round(m.qty * v_cost, 2);
      v_unit := app.imp_uom(m.unit);
      if v_unit is not null and m.product_uom is not null and v_unit <> m.product_uom then
        perform app.open_bug(jsonb_build_object('company_id', rp.company_id, 'area', 'stock', 'kind', 'other', 'severity', 'medium', 'who_fixes', 'store',
          'title', 'Unit differs from the product: ' || m.name, 'evidence', jsonb_build_object('item', m.name, 'tally_unit', m.unit, 'product_uom', m.product_uom, 'report_id', rp.id),
          'suggested_fix', 'Check the unit on the product. The quantity was posted as given in Tally.', 'ref_table', 'master.products', 'ref_id', m.product_id,
          'dedupe_key', 'stkuom|' || rp.id || '|' || m.product_id));
      end if;
      v_n := v_n + 1;
    end if;
  end loop;
  if jsonb_array_length(v_unmatched) > 0 then
    v_res := jsonb_build_object('applied', false, 'refused', 'unmatched', 'unmatched', v_unmatched,
                                'message', 'Some items are not in the product master. Nothing was posted. Map each to an existing product or create the product (with its HSN and unit), then apply again.');
    return app.request_done(p_client_request_id, 'apply_stock_summary_as_opening_stock', v_res);
  end if;
  if v_n = 0 then perform app.raise_rule('doc.no_lines', 'there is no positive quantity to post', '22023'); end if;
  v_post := api.post_opening_stock(md5(rp.id::text || '|opening_stock')::uuid, jsonb_build_object('company_id', rp.company_id, 'place_id', p_place_id, 'date', rp.as_of, 'lines', v_lines));
  v_res := jsonb_build_object('applied', true, 'items', v_n, 'not_posted', v_skipped, 'qty', v_qty, 'value', v_val, 'tally_value', nullif(rp.totals ->> 'tally_value', '')::numeric,
                              'as_of', rp.as_of, 'place_id', p_place_id, 'post', v_post,
                              'message', 'Opening stock posted for ' || v_n || ' items' || case when v_skipped > 0 then '; ' || v_skipped || ' zero or negative lines were not posted (see Bug fixer)' else '' end || '.');
  update ops.tally_reports set status = 'applied', applied_by = auth.uid(), applied_at = now(), result = v_res where id = rp.id;
  perform app.log_event('admin_action', jsonb_build_object('entity', 'tally_report', 'action', 'applied_opening_stock', 'report', rp.id, 'items', v_n));
  return app.request_done(p_client_request_id, 'apply_stock_summary_as_opening_stock', v_res);
end $$;

-- ─────────── ERP side of the reconciliation ───────────
create or replace function app.erp_closing(p_company uuid, p_as_of date) returns table (account_id uuid, name text, name_norm text, group_id uuid, group_name text, net numeric)
language sql stable security definer set search_path = '' as $$
  select a.id, a.name, a.name_norm, g.id, g.name,
         (case when a.opening_dc = 'D' then a.opening_balance else -a.opening_balance end)
         + coalesce((select sum(e.dr - e.cr) from acct.gl_entries e where e.account_id = a.id and e.entry_date <= p_as_of), 0)
  from acct.accounts a join acct.account_groups g on g.id = a.group_id where a.company_id = p_company
$$;

-- Per ledger: Tally closing (Dr positive) against the ERP trial balance at the report date.
create or replace function app.tb_diffs(p_report uuid) returns table (report_id uuid, ledger text, tally_group text, account_id uuid, erp_name text, erp_group text, tally_net numeric, erp_net numeric, diff numeric, status text)
language sql stable security definer set search_path = '' as $$
  with r as (select * from ops.tally_reports where id = p_report and kind = 'trial_balance' and app.can_read_report(company_id)),
  t as (
    select app.norm_name(l ->> 'name') as k, min(l ->> 'name') as name, min(l -> 'parents' ->> 0) as grp,
           sum(coalesce((l ->> 'dr')::numeric, 0) - coalesce((l ->> 'cr')::numeric, 0)) as net
    from r cross join lateral jsonb_array_elements(r.lines) l where not coalesce((l ->> 'is_group')::boolean, false) group by 1),
  e as (select c.* from r cross join lateral app.erp_closing(r.company_id, r.as_of) c)
  select (select id from r), coalesce(t.name, e.name), t.grp, e.account_id, e.name, e.group_name, t.net, e.net,
         round(coalesce(e.net, 0) - coalesce(t.net, 0), 2),
         case when t.k is null and abs(e.net) < 0.005 then 'zero_in_erp'
              when t.k is null then 'only_in_erp' when e.name_norm is null then 'only_in_tally'
              when abs(coalesce(e.net, 0) - t.net) < 0.01 then 'match' else 'differs' end
  from t full join e on e.name_norm = t.k
  where not (t.k is null and abs(e.net) < 0.005)
  order by 1, 2
$$;

create or replace function api.compare_trial_balance(p_report_id uuid) returns table (report_id uuid, ledger text, tally_group text, account_id uuid, erp_name text, erp_group text, tally_net numeric, erp_net numeric, diff numeric, status text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from ops.tally_reports where id = p_report_id and kind = 'trial_balance' and app.can_read_report(company_id)) then
    perform app.raise_rule('report.missing', 'Trial Balance report not found', 'P0002');
  end if;
  return query select * from app.tb_diffs(p_report_id);
end $$;

create or replace view api.tally_report_diffs with (security_invoker = true) as
select d.* from ops.tally_reports r cross join lateral app.tb_diffs(r.id) d where r.kind = 'trial_balance';

-- Balance Sheet group totals against the ERP, for Tally groups that are mapped (ops.tally_group_map) to an account group
-- (and its sub-groups). Assets are shown Dr-positive, liabilities Cr-positive, like the Tally sheet.
create or replace function app.bs_diffs(p_report uuid) returns table (report_id uuid, side text, line text, depth int, is_total boolean, tally_amount numeric, erp_amount numeric, diff numeric, status text)
language sql stable security definer set search_path = '' as $$
  with recursive r as (select * from ops.tally_reports where id = p_report and kind = 'balance_sheet' and app.can_read_report(company_id)),
  e as (select c.* from r cross join lateral app.erp_closing(r.company_id, r.as_of) c),
  l as (
    select x.l ->> 'side' as side, x.l ->> 'name' as name, coalesce((x.l ->> 'depth')::int, 0) as depth, coalesce((x.l ->> 'is_total')::boolean, false) as is_total,
           coalesce((x.l ->> 'is_group')::boolean, false) as is_group, (x.l ->> 'amount')::numeric as amount, x.ord
    from r cross join lateral jsonb_array_elements(r.lines) with ordinality as x(l, ord)),
  mapped as (
    select l.*, m.account_group_id from l left join ops.tally_group_map m on m.company_id = (select company_id from r) and m.tally_group = l.name where l.is_group and not l.is_total),
  tree as (
    select mp.ord, mp.account_group_id as root, mp.account_group_id as gid from mapped mp where mp.account_group_id is not null
    union all
    select t.ord, t.root, g.id from tree t join acct.account_groups g on g.parent_id = t.gid),
  erpsum as (select t.ord, sum(e.net) as net from tree t join e on e.group_id = t.gid group by t.ord)
  select (select id from r), l.side, l.name, l.depth, l.is_total, l.amount,
         case when s.net is null then null when l.side = 'L' then round(-s.net, 2) else round(s.net, 2) end,
         case when s.net is null then null else round((case when l.side = 'L' then -s.net else s.net end) - l.amount, 2) end,
         case when l.is_total then 'total' when not l.is_group then 'detail' when m.account_group_id is null then 'not_mapped'
              when abs((case when l.side = 'L' then -coalesce(s.net, 0) else coalesce(s.net, 0) end) - l.amount) < 0.01 then 'match' else 'differs' end
  from l left join mapped m on m.ord = l.ord left join erpsum s on s.ord = l.ord
  order by l.side desc, l.ord
$$;

create or replace function api.compare_balance_sheet(p_report_id uuid) returns table (report_id uuid, side text, line text, depth int, is_total boolean, tally_amount numeric, erp_amount numeric, diff numeric, status text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from ops.tally_reports where id = p_report_id and kind = 'balance_sheet' and app.can_read_report(company_id)) then
    perform app.raise_rule('report.missing', 'Balance Sheet report not found', 'P0002');
  end if;
  return query select * from app.bs_diffs(p_report_id);
end $$;

create or replace view api.tally_report_bs_diffs with (security_invoker = true) as
select d.* from ops.tally_reports r cross join lateral app.bs_diffs(r.id) d where r.kind = 'balance_sheet';

-- ─────────── Lists for the screen ───────────
create or replace view api.tally_reports with (security_invoker = true) as
select r.id, r.company_id, c.short_name as company_name, r.kind, r.as_of, r.period_from, r.period_to, r.file_name, r.file_sha256, r.company_name_in_file, r.grain,
       r.totals, r.status, r.result, r.uploaded_by, p.display_name as uploaded_by_name, r.uploaded_at, r.applied_at, jsonb_array_length(r.lines)::int as line_count
from ops.tally_reports r join core.companies c on c.id = r.company_id left join core.user_profiles p on p.user_id = r.uploaded_by;

create or replace view api.tally_report_lines with (security_invoker = true) as
select r.id as report_id, r.company_id, x.ord::int as ord, x.l as line
from ops.tally_reports r cross join lateral jsonb_array_elements(r.lines) with ordinality as x(l, ord);

grant execute on all functions in schema api to authenticated;
grant execute on function api.log_sign_in_failure(text) to anon;
grant execute on all functions in schema app to authenticated;
grant select on api.tally_reports, api.tally_report_lines, api.tally_report_diffs, api.tally_report_bs_diffs, api.tally_report_stock_match to authenticated;

-- 20261103011000_import_pincode_sanitise.sql
-- A bad PIN code, state code or PAN in a Tally ledger must never abort the row.
-- Root cause: app.imp_ledger wrote p->>'pincode' and p->>'state_code' straight into char(6) / char(2) columns guarded by CHECK
-- (party_addresses_pincode_check). A PIN such as '0', '682 030' or a 7+ digit number failed the check or overflowed char(6),
-- the row ended as result='error' and its ledger was missing.
-- Fix (additive): sanitising helpers + a targeted patch of the live app.imp_ledger definition (everything else identical) +
-- api.import_retry_errors to re-run stale 'error' rows of a batch.

-- Digits only; accepted only when it is a valid Indian PIN (6 digits, first not 0); otherwise NULL.
create or replace function app.imp_pincode(p_raw text) returns text
language sql immutable set search_path = '' as $$
  select case when d ~ '^[1-9][0-9]{5}$' then d else null end
  from (select regexp_replace(coalesce(p_raw, ''), '[^0-9]', '', 'g') as d) x
$$;

-- Two-digit GST state code, or NULL (state names, long text and one-digit values are ignored, never abort the row).
create or replace function app.imp_state2(p_raw text) returns text
language sql immutable set search_path = '' as $$
  select case when s ~ '^[0-9]{2}$' then s else null end from (select trim(coalesce(p_raw, '')) as s) x
$$;

-- Valid PAN or NULL.
create or replace function app.imp_pan(p_raw text) returns text
language sql immutable set search_path = '' as $$
  select case when s ~ '^[A-Z]{5}[0-9]{4}[A-Z]$' then s else null end from (select upper(trim(coalesce(p_raw, ''))) as s) x
$$;

do $$
declare
  v_def text; v_new text;
  v_state_old constant text := $q$coalesce(substr(v_gstin, 1, 2), nullif(p ->> 'state_code', ''))$q$;
  v_state_new constant text := $q$coalesce(substr(v_gstin, 1, 2), app.imp_state2(p ->> 'state_code'))$q$;
  v_addr_old constant text := $q$insert into master.party_addresses (party_id, kind, line1, state_code, pincode) values (v_party, 'billing', p ->> 'address', coalesce(substr(v_gstin, 1, 2), app.imp_state2(p ->> 'state_code')), nullif(p ->> 'pincode', ''));$q$;
  v_addr_new constant text := $q$insert into master.party_addresses (party_id, kind, line1, line2, state_code, pincode)
        values (v_party, 'billing', p ->> 'address',
                case when nullif(trim(p ->> 'pincode'), '') is not null and app.imp_pincode(p ->> 'pincode') is null then 'PIN in Tally (not valid): ' || left(trim(p ->> 'pincode'), 40) end,
                coalesce(substr(v_gstin, 1, 2), app.imp_state2(p ->> 'state_code')), app.imp_pincode(p ->> 'pincode'));$q$;
  v_pan_old constant text := $q$if v_gstin is not null and v_pan is null then v_pan := substr(v_gstin, 3, 10); end if;$q$;
  v_pan_new constant text := $q$v_pan := app.imp_pan(v_pan);
    if v_gstin is not null and (v_pan is null or v_pan <> substr(v_gstin, 3, 10)) then v_pan := substr(v_gstin, 3, 10); end if;$q$;
begin
  v_def := pg_get_functiondef('app.imp_ledger(ops.import_batches, ops.import_rows)'::regprocedure);
  v_new := replace(v_def, v_state_old, v_state_new);
  if v_new = v_def then raise exception 'imp_ledger patch 1 (state_code) did not match'; end if;
  v_def := v_new;
  v_new := replace(v_def, v_addr_old, v_addr_new);
  if v_new = v_def then raise exception 'imp_ledger patch 2 (address) did not match'; end if;
  v_def := v_new;
  v_new := replace(v_def, v_pan_old, v_pan_new);
  if v_new = v_def then raise exception 'imp_ledger patch 3 (pan) did not match'; end if;
  execute v_new;
end $$;

-- ─────────── Re-run the rows of a batch that ended as 'error' ───────────
-- Admin (or the right "Load Tally data"; voucher rows are Admin only). Idempotent through the client request id. Locks the batch.
-- A row that now resolves becomes created / linked / aliased / skipped / bug; the stale "Row could not be loaded" item is closed.
create or replace function api.import_retry_errors(p_client_request_id uuid, p_batch_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb; b ops.import_batches; r ops.import_rows; v_result text; v_res jsonb; v_before int; v_after int; v_counts jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'import_retry_errors'); if v_prev is not null then return v_prev; end if;
  select * into b from ops.import_batches where id = p_batch_id for update;
  if not found then perform app.raise_rule('import.missing', 'batch not found', 'P0002'); end if;
  perform app.require(b.company_id, 'data.import');
  if b.status not in ('staged', 'processed') then perform app.raise_rule('import.locked', 'this batch cannot be re-run now', '22023'); end if;
  select count(*) into v_before from ops.import_rows where batch_id = p_batch_id and result = 'error';
  if not app.is_admin() and exists (select 1 from ops.import_rows where batch_id = p_batch_id and result = 'error' and object_type = 'voucher') then
    perform app.raise_rule('rights.missing', 'only Admin re-runs voucher rows', '42501');
  end if;

  for r in select * from ops.import_rows where batch_id = p_batch_id and result = 'error' order by app.imp_rank(object_type), seq loop
    update ops.import_rows set result = null, message = null where id = r.id;
    select * into r from ops.import_rows where id = r.id;
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
      update ops.bug_items set status = 'fixed', resolution = 'row loaded again after the loader was fixed', fixed_by = auth.uid(), fixed_at = now()
       where dedupe_key = 'err|' || r.id and status = 'open';
    exception when others then
      update ops.import_rows set result = 'error', message = left(sqlerrm, 300) where id = r.id;
    end;
  end loop;

  select count(*) into v_after from ops.import_rows where batch_id = p_batch_id and result = 'error';
  select jsonb_object_agg(object_type, c) into v_counts from (
    select object_type, jsonb_object_agg(coalesce(result, 'pending'), n) as c
    from (select object_type, result, count(*)::int as n from ops.import_rows where batch_id = b.id group by 1, 2) x group by object_type) y;
  update ops.import_batches set counts = coalesce(v_counts, '{}'::jsonb) where id = b.id;
  perform app.log_event('admin_action', jsonb_build_object('entity', 'import_batch', 'code', b.code, 'action', 'retry_errors', 'before', v_before, 'after', v_after));
  v_res := jsonb_build_object('id', b.id, 'error_before', v_before, 'error_after', v_after, 'counts', coalesce(v_counts, '{}'::jsonb));
  return app.request_done(p_client_request_id, 'import_retry_errors', v_res);
end $$;

revoke all on function app.imp_pincode(text), app.imp_state2(text), app.imp_pan(text) from public, anon;
revoke all on function api.import_retry_errors(uuid, uuid) from public, anon;
grant execute on function app.imp_pincode(text), app.imp_state2(text), app.imp_pan(text) to authenticated;
grant execute on function api.import_retry_errors(uuid, uuid) to authenticated;
notify pgrst, 'reload schema';

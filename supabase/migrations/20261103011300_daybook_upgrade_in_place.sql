-- 20261103011300_daybook_upgrade_in_place.sql
-- A Day Book XML (full entries, one voucher with all its ledger lines) loaded after the Excel Day Book (one leg per voucher):
-- when the XML voucher matches existing one-leg Excel vouchers on type | number | date, the FIRST leg is upgraded in place
-- (full lines, XML guid and key, voucher amount) and the other legs of the same voucher are marked reversed and linked to it
-- (upgraded_into). One voucher stays one voucher: nothing is counted twice and nothing is deleted. Loading the Excel again never
-- resurrects a leg that was upgraded. Additive.
alter table ops.tally_vouchers add column if not exists upgraded_into uuid references ops.tally_vouchers (id);
alter table ops.tally_vouchers add column if not exists upgraded_at timestamptz;
alter table ops.tally_vouchers add column if not exists upgraded_from jsonb;
create index if not exists tally_vouchers_upgraded_into_idx on ops.tally_vouchers (upgraded_into) where upgraded_into is not null;

do $$
declare
  v_def text; v_new text;
  v_decl_old constant text := $q$v_sum numeric; v_id uuid; v_date date := nullif(p ->> 'date', '')::date;$q$;
  v_decl_new constant text := $q$v_sum numeric; v_id uuid; v_date date := nullif(p ->> 'date', '')::date; v_leg uuid[]; v_upgraded boolean := false;$q$;
  v_guard_old constant text := $q$  if v_existing.id is not null and v_existing.state <> 'reversed' then$q$;
  v_guard_new constant text := $q$  if v_existing.upgraded_into is not null then
    update ops.import_rows set erp_table = 'ops.tally_vouchers', erp_id = v_existing.upgraded_into where id = r.id;
    return 'skipped';
  end if;
  if v_existing.id is not null and v_existing.state <> 'reversed' then$q$;
  v_up_old constant text := $q$  if v_existing.id is not null then
    update ops.tally_vouchers set state = 'loaded'$q$;
  v_up_new constant text := $q$  if v_existing.id is null and r.guid is not null and nullif(p ->> 'number', '') is not null and jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) > 0 then
    select array_agg(x.id order by x.match_key) into v_leg from ops.tally_vouchers x
     where x.company_id = b.company_id and x.voucher_type = coalesce(p ->> 'type', 'Unknown') and x.voucher_no = p ->> 'number' and x.voucher_date = v_date
       and x.guid is null and x.upgraded_into is null and x.state in ('loaded', 'flagged') and jsonb_array_length(x.lines) = 0 and x.batch_id is distinct from b.id;
    if v_leg is not null then
      update ops.tally_vouchers set
        upgraded_from = jsonb_build_object('legs', cardinality(v_leg), 'match_key', match_key, 'amount', amount, 'batch_id', batch_id,
                          'other_amounts', (select coalesce(jsonb_agg(y.amount), '[]'::jsonb) from ops.tally_vouchers y where y.id = any (v_leg[2:]))),
        upgraded_at = now(), guid = r.guid, match_key = v_key, party_name = p ->> 'party', party_id = v_party, dc = null
      where id = v_leg[1];
      update ops.tally_vouchers set state = 'reversed', upgraded_into = v_leg[1], upgraded_at = now() where id = any (v_leg[2:]);
      select * into v_existing from ops.tally_vouchers where id = v_leg[1];
      v_upgraded := true;
    end if;
  end if;
  if v_existing.id is not null then
    update ops.tally_vouchers set state = 'loaded'$q$;
  v_ret_old constant text := $q$  return 'created';$q$;
  v_ret_new constant text := $q$  return case when v_upgraded then 'linked' else 'created' end;$q$;
begin
  v_def := pg_get_functiondef('app.imp_voucher(ops.import_batches, ops.import_rows)'::regprocedure);
  v_new := replace(v_def, v_decl_old, v_decl_new);
  if v_new = v_def then raise exception 'imp_voucher patch 1 (declare) did not match'; end if;
  v_def := v_new; v_new := replace(v_def, v_guard_old, v_guard_new);
  if v_new = v_def then raise exception 'imp_voucher patch 2 (guard) did not match'; end if;
  v_def := v_new; v_new := replace(v_def, v_up_old, v_up_new);
  if v_new = v_def then raise exception 'imp_voucher patch 3 (upgrade) did not match'; end if;
  v_def := v_new; v_new := replace(v_def, v_ret_old, v_ret_new);
  if v_new = v_def then raise exception 'imp_voucher patch 4 (return) did not match'; end if;
  execute v_new;
end $$;

notify pgrst, 'reload schema';

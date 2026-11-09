-- 20261103012500_import_staged_result.sql
-- The staged mapping loaders report an allowed import_rows.result: 'created' (a suggestion row was written) or 'linked' (already confirmed).
create or replace function app.imp_voucher_type(b ops.import_batches, r ops.import_rows) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform app.tally_sugg_vt(b.company_id, r.name, r.payload, b.id);
  update ops.import_rows set erp_table = 'ops.tally_voucher_type_map' where id = r.id;
  return case when exists (select 1 from ops.tally_voucher_type_map where company_id = b.company_id and tally_type = r.name and status = 'confirmed') then 'linked' else 'created' end;
end $$;

create or replace function app.imp_godown(b ops.import_batches, r ops.import_rows) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform app.tally_sugg_godown(b.company_id, r.name, r.payload, b.id);
  update ops.import_rows set erp_table = 'ops.tally_godown_map' where id = r.id;
  return case when exists (select 1 from ops.tally_godown_map where company_id = b.company_id and tally_godown = r.name and status = 'confirmed') then 'linked' else 'created' end;
end $$;

create or replace function app.imp_currency(b ops.import_batches, r ops.import_rows) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform app.tally_sugg_currency(b.company_id, r.name, r.payload);
  update ops.import_rows set erp_table = 'ops.tally_currency_map' where id = r.id;
  return case when exists (select 1 from ops.tally_currency_map where company_id = b.company_id and tally_symbol = r.name and status = 'confirmed') then 'linked' else 'created' end;
end $$;

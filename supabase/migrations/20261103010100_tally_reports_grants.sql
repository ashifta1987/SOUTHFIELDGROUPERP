-- 20261103010100_tally_reports_grants.sql
-- Repairs the grants after 20261103010000: new functions are not executable by anon/public, and the service-only
-- functions stay closed to signed-in users (the blanket grant in the previous file had re-opened them).
-- Also shows the Dr/Cr side of a Day Book line on api.tally_vouchers (new column added at the end).
revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;
revoke all on all functions in schema api from public, anon;
grant execute on all functions in schema api to authenticated;
grant execute on function api.log_sign_in_failure(text) to anon;
do $$
declare f text;
begin
  foreach f in array array[
    'api.integration_claim_due(int, text[])', 'api.integration_report(uuid, boolean, jsonb, text, boolean)', 'api.ingest_webhook(text, text, boolean, text, jsonb)',
    'api.finish_webhook(bigint, text, jsonb, text)', 'api.apply_einvoice_result(uuid, jsonb)', 'api.apply_eway_result(uuid, jsonb)',
    'api.stage_channel_event(bigint, uuid, text, text, jsonb)', 'api.bank_feed_import(uuid, uuid, jsonb, text)', 'api.gps_ingest(text, text, jsonb)',
    'api.help_whatsapp_inbound(bigint, text, text, text)', 'api.help_wa_tool(text, text, jsonb)', 'api.help_wa_log_reply(text, text)'] loop
    execute format('revoke execute on function %s from authenticated, public, anon', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array['app.integration_sweep()', 'app.integration_fail(uuid, text, boolean)', 'app.integration_succeed(uuid, jsonb)',
                           'app.integration_begin(uuid)', 'app.apply_einvoice(uuid, jsonb)', 'app.apply_eway(uuid, jsonb)',
                           'app.integration_enqueue(uuid, text, text, text, uuid, jsonb, text)'] loop
    execute format('revoke execute on function %s from authenticated, public, anon', f);
  end loop;
end $$;

create or replace view api.tally_vouchers with (security_invoker = true) as
select id, company_id, guid, voucher_type, voucher_no, voucher_date, party_name, party_id, amount, is_cancelled, is_optional, alter_id, state, batch_id, dc
from ops.tally_vouchers;

-- 20261103000400_revoke_reason.sql
-- Stopping a special permission needs a reason on the server too (not only in the UI). Additive.
create or replace function api.revoke_special_permission(p_client_request_id uuid, p_grant_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prev jsonb; g core.special_grants; v_res jsonb;
begin
  v_prev := app.request_seen(p_client_request_id, 'revoke_special_permission');
  if v_prev is not null then return v_prev; end if;
  perform app.require(null, 'users.manage');
  if coalesce(length(trim(p_reason)), 0) < 5 then
    raise exception 'reason_required: say why the permission stops' using errcode = '22023', hint = 'grant.reason_required';
  end if;
  select * into g from core.special_grants where id = p_grant_id for update;
  if not found then raise exception 'not_found: permission' using errcode = 'P0002'; end if;
  if g.revoked_at is not null then raise exception 'already_stopped' using errcode = '22023', hint = 'grant.already_stopped'; end if;
  update core.special_grants set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = p_reason where id = p_grant_id;
  perform app.log_event('grant_revoked', jsonb_build_object('grant', g.code, 'reason', p_reason), p_grant_id);
  v_res := jsonb_build_object('id', p_grant_id);
  return app.request_done(p_client_request_id, 'revoke_special_permission', v_res);
end $$;
revoke all on function api.revoke_special_permission(uuid, uuid, text) from public, anon;
grant execute on function api.revoke_special_permission(uuid, uuid, text) to authenticated;

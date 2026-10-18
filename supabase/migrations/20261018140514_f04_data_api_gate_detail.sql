-- F-04 follow-up: PostgREST requires a RAISE SQLSTATE 'PGRST' DETAIL to carry
-- both "status" and "headers". Without "headers" every refused request came
-- back as 500 PGRST121 instead of 403 GATEWAY_REQUIRED.
-- Applied to the live database on 18 Oct 2026 as version 20261018140514.

create or replace function private.require_gateway_key() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_key text := current_setting('request.headers', true)::json ->> 'x-ohouse-gateway-key';
begin
  if current_setting('request.jwt.claims', true)::json ->> 'role' = 'service_role' then
    return;
  end if;
  if v_key is not null and exists (
       select 1 from private.gateway_keys
        where key_sha256 = encode(extensions.digest(v_key, 'sha256'), 'hex')) then
    return;
  end if;
  -- PostgREST requires DETAIL to carry both status and headers.
  raise sqlstate 'PGRST' using
    message = json_build_object('code', 'GATEWAY_REQUIRED', 'message', 'Direct Data API access is disabled')::text,
    detail  = json_build_object('status', 403, 'headers', json_build_object())::text;
end $$;

-- Switched on by hand (not a migration, so a new club enables it only once its
-- key hashes are in private.gateway_keys):
--   alter role authenticator set pgrst.db_pre_request = 'private.require_gateway_key';
--   notify pgrst, 'reload config';
-- Undo:
--   alter role authenticator reset pgrst.db_pre_request;
--   notify pgrst, 'reload config';

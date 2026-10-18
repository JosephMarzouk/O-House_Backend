-- F-04 (qa/05-review-findings.md), story PLAT-02: only our servers can use
-- the Data API (PLAN.md "The four rules", rule 2).
--
-- A PostgREST pre-request function refuses every request that is neither
-- service_role nor carrying a known x-ohouse-gateway-key. The API sends
-- CLUBS.<slug>.gatewayKey on its user-scoped calls
-- (src/supabase/supabase.module.ts:47-52) and the portal sends
-- OHOUSE_GATEWAY_KEY (o-house-admin/lib/supabase/server.ts:48,55); the
-- secret-key clients are service_role. Everyone else (the publishable key,
-- a legacy Supabase Auth token) gets 403 GATEWAY_REQUIRED.
--
-- Only the keys' SHA-256 hashes are stored, in private.gateway_keys, and
-- they are NOT in this file (PLAN.md: outside git). They are inserted
-- separately, before the pre-request hook is switched on; rotating a key is
-- an insert plus a delete, no deploy.
--
-- The old web checklist is gone (18 Oct), so nothing legitimate is shut out.
--
-- Undo in one statement (then notify, as below):
--   alter role authenticator reset pgrst.db_pre_request;
--
-- Applied to the live database on 18 Oct 2026 as version 20261018140404.
-- The raise below lacked 'headers' in its DETAIL, which PostgREST rejects
-- (500 PGRST121); fixed by 20261018140514_f04_data_api_gate_detail. The four
-- key hashes (local and Railway, API and portal) were inserted by hand and
-- the hook switched on the same day; verified: the publishable key alone
-- gets 403 GATEWAY_REQUIRED, the Railway API's key passes.

begin;

create table if not exists private.gateway_keys (
  key_sha256 text primary key,
  label      text not null,
  created_at timestamptz not null default now()
);
alter table private.gateway_keys enable row level security;
revoke all on table private.gateway_keys from public, anon, authenticated;

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
  raise sqlstate 'PGRST' using
    message = json_build_object('code', 'GATEWAY_REQUIRED', 'message', 'Direct Data API access is disabled')::text,
    detail  = json_build_object('status', 403)::text;
end $$;

-- PostgREST calls it as the request's role.
grant usage on schema private to anon, authenticated, service_role;
revoke all on function private.require_gateway_key() from public;
grant execute on function private.require_gateway_key() to anon, authenticated, service_role;

commit;

-- Switched on separately, once the four key hashes are in private.gateway_keys:
--   alter role authenticator set pgrst.db_pre_request = 'private.require_gateway_key';
--   notify pgrst, 'reload config';
--
-- Verification — expect each value shown:
--   curl <url>/rest/v1/assignments_v -H "apikey: <publishable key>"     -- 403 GATEWAY_REQUIRED
--   Portal: sign in, dashboard, a checklist with photos: all work.
--   Phone (Railway API): pull to refresh, answer, submit: all work.

-- F-11 (qa/05-review-findings.md), story MOB-01: old app builds are told to
-- update.
--
-- One row per club database: the lowest app build (Android versionCode) the
-- API still accepts, and where the update is downloaded (the Play Store
-- listing later; during the pilot, wherever the APK is shared). The API
-- (src/app-release/app-release.ts) reads it once a minute through
-- app_release(), and answers 426 UPGRADE_REQUIRED to an app whose
-- X-App-Version is lower. Raising it needs no deploy:
--   update public.app_release set min_build = 3, update_url = 'https://…';
-- A field on the portal's Club settings comes after the pilot (MOB-01 AC4).
--
-- min_build 0 = nobody is held back.
--
-- Applied to the live database on 18 Oct 2026 as version 20261018140341.
-- Verified: app_release() answers (0, null).

begin;

create table if not exists public.app_release (
  id         boolean primary key default true check (id),   -- one row
  min_build  integer not null default 0 check (min_build >= 0),
  update_url text check (update_url is null or update_url ~ '^https://'),
  updated_at timestamptz not null default now()
);
insert into public.app_release default values on conflict do nothing;

alter table public.app_release enable row level security;
revoke all on table public.app_release from public, anon, authenticated;

-- The app asks before anyone signs in, so anon may call this, and only this:
-- it returns nothing but the minimum and the link.
create or replace function public.app_release()
returns table (min_build integer, update_url text)
language sql stable security definer set search_path = '' as $$
  select r.min_build, r.update_url from public.app_release r
$$;
revoke all on function public.app_release() from public;
grant execute on function public.app_release() to anon, authenticated, service_role;

commit;

-- Verification:
--   select * from public.app_release();                         -- (0, null)
--   As anon through the API's gateway client: rpc('app_release') answers.
--   App with X-App-Version below min_build → 426 UPGRADE_REQUIRED.

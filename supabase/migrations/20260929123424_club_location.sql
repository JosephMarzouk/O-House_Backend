-- =====================================================================
-- club_location: where the club is (a point and a radius)
--
-- The staff app refuses to open or submit a fillable checklist outside this
-- circle. The check is in the app only: no server-side geofence, and no
-- coordinates are stored with a submission.
--
--   * One row at most (the id is always true). Every signed-in user reads
--     it (the app caches it from GET /me); an admin sets it from the portal.
--   * Set once: set_club_location() refuses when a row exists, and there is
--     no update or delete path. A wrong pin is fixed by support with
--       delete from public.club_location;
--     after which an admin sets it again.
-- =====================================================================

begin;

create table public.club_location (
  id       boolean primary key default true check (id),
  lat      numeric not null check (lat between -90 and 90),
  lng      numeric not null check (lng between -180 and 180),
  radius_m integer not null check (radius_m between 50 and 2000),
  set_by   uuid references public.profiles(id),
  set_at   timestamptz not null default now()
);

alter table public.club_location enable row level security;

revoke all on public.club_location from anon, authenticated;
grant select on public.club_location to authenticated;

create policy club_location_select on public.club_location for select to authenticated using (true);

create function public.set_club_location(p_lat numeric, p_lng numeric, p_radius_m integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.current_role() <> 'admin' then raise exception 'Only admins can set the club location'; end if;
  -- on conflict, not an exists() check: two admins saving at once still get one row
  insert into public.club_location (lat, lng, radius_m, set_by)
  values (p_lat, p_lng, p_radius_m, auth.uid())
  on conflict (id) do nothing;
  if not found then raise exception 'LOCATION_ALREADY_SET'; end if;
end $$;

revoke execute on function public.set_club_location(numeric, numeric, integer) from public, anon;
grant execute on function public.set_club_location(numeric, numeric, integer) to authenticated;

commit;

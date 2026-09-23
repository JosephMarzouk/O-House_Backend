-- =====================================================================
-- club_pages: the staff app's "About" and "Policies" text, per club
--
-- One row per page, both languages. Every signed-in user reads them (the
-- app shows them on Profile); only an admin changes them, from the portal.
--
--   * Writes only through set_club_page(), which checks the role. No
--     insert/update/delete policy, and the table grants are cut to select.
--   * The two rows are seeded here and the key is checked, so a page can be
--     edited but never added or removed.
--   * Empty text means "not written yet": the app shows its built-in line.
-- =====================================================================

begin;

create table public.club_pages (
  key        text primary key check (key in ('about', 'policies')),
  body_en    text not null default '' check (length(body_en) <= 20000),
  body_ar    text not null default '' check (length(body_ar) <= 20000),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

insert into public.club_pages (key) values ('about'), ('policies');

alter table public.club_pages enable row level security;

revoke all on public.club_pages from anon, authenticated;
grant select on public.club_pages to authenticated;

create policy club_pages_select on public.club_pages for select to authenticated using (true);

create function public.set_club_page(p_key text, p_body_en text, p_body_ar text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.current_role() <> 'admin' then raise exception 'Only admins can edit club pages'; end if;
  update public.club_pages
     set body_en = coalesce(btrim(p_body_en), ''),
         body_ar = coalesce(btrim(p_body_ar), ''),
         updated_at = now(),
         updated_by = auth.uid()
   where key = p_key;
  if not found then raise exception 'Unknown page %', p_key; end if;
end $$;

revoke execute on function public.set_club_page(text, text, text) from public, anon;
grant execute on function public.set_club_page(text, text, text) to authenticated;

commit;

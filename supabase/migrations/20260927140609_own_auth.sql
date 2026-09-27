-- =====================================================================
-- Our own authentication (expand only)
--
-- The API signs people in, not Supabase Auth. It keeps:
--   * user_logins    — how each person signs in (a phone number, an email,
--                      or both) and their bcrypt password hash;
--   * refresh_tokens — hashed, rotated refresh tokens, grouped in families
--                      so a reused (stolen) token revokes its whole family.
-- Both are closed to clients: RLS on, no policies, no grants. Only the API's
-- auth module reads them, with the club's secret key.
--
-- The database itself does not change how it trusts callers: the API mints a
-- short-lived JWT per user, signed with a key imported into this project's
-- JWT signing keys, so auth.uid(), every RLS policy and every RPC guard work
-- exactly as before.
--
-- Supabase Auth's users are copied, hashes and all (they are bcrypt, which
-- the API verifies), so nobody has to reset a password.
-- private.copy_auth_logins() is re-runnable: until the old portal and app
-- are retired they can still change a password in Supabase Auth, and the
-- newer of the two hashes wins.
--
-- profiles_id_fkey (→ auth.users) is dropped so the API can create people
-- without Supabase Auth. auth.users stays as it is, an archive, until a
-- later cleanup.
-- =====================================================================

begin;

create table if not exists public.user_logins (
  user_id             uuid primary key references public.profiles (id) on delete cascade,
  phone               text unique,   -- E.164, like profiles.phone: +20XXXXXXXXXX
  email               text unique,   -- always stored lower-case
  password_hash       text not null, -- bcrypt
  failed_count        int not null default 0,
  locked_until        timestamptz,
  password_changed_at timestamptz not null default now(),
  constraint user_logins_identifier check (phone is not null or email is not null),
  constraint user_logins_phone_e164 check (phone is null or phone ~ '^\+[0-9]{8,15}$'),
  constraint user_logins_email_lower check (email is null or email = lower(email))
);

create table if not exists public.refresh_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  token_sha256 text not null unique,
  family       uuid not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  -- rotated: replaced by its successor on refresh (a 60 s grace covers two
  -- parallel refreshes); logout; reset: a new password; reuse: theft suspected.
  revoked_reason text check (revoked_reason in ('rotated', 'logout', 'reset', 'reuse'))
);
create index if not exists refresh_tokens_user_idx on public.refresh_tokens (user_id);
create index if not exists refresh_tokens_family_idx on public.refresh_tokens (family);

alter table public.user_logins enable row level security;
alter table public.refresh_tokens enable row level security;
revoke all on public.user_logins from anon, authenticated;
revoke all on public.refresh_tokens from anon, authenticated;

-- Copies (or refreshes) sign-in details from Supabase Auth. A phone account's
-- login is its synthetic address's digits; an email account's its address.
create or replace function private.copy_auth_logins()
returns int language sql security definer set search_path = '' as $$
  with src as (
    select u.id,
           case when u.email like '%@ohouse.internal'
                then coalesce(p.phone, '+' || split_part(u.email, '@', 1))
                else p.phone end                                        as phone,
           case when u.email like '%@ohouse.internal' then null
                else lower(u.email) end                                 as email,
           u.encrypted_password                                         as hash,
           coalesce(u.updated_at, u.created_at)                         as changed_at
      from auth.users u
      join public.profiles p on p.id = u.id
     where u.encrypted_password like '$2%'
       and (u.email is not null or p.phone is not null)
  ), up as (
    insert into public.user_logins (user_id, phone, email, password_hash, password_changed_at)
    select id, phone, email, hash, changed_at from src
    on conflict (user_id) do update
       set password_hash = excluded.password_hash,
           password_changed_at = excluded.password_changed_at
     where public.user_logins.password_changed_at < excluded.password_changed_at
    returning 1
  )
  select count(*)::int from up;
$$;
revoke all on function private.copy_auth_logins() from public;

select private.copy_auth_logins();

alter table public.profiles drop constraint if exists profiles_id_fkey;

commit;

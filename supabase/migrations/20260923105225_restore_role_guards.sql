-- =====================================================================
-- Restore the role guards that a re-run of the legacy schema.sql reverted
--
-- The 2026-09-22 audit found that the legacy web client's schema file
-- (O-House-AdminPortal-main/supabase/schema.sql, "Safe to re-run") had been
-- run again after 0012. It put back:
--
--   * current_role() as a bare select, which returns NULL for a caller with
--     no profiles row. set_user_role (`<> 'admin'`), set_user_department and
--     set_user_manager (`not in (...)`) then never raise, because PL/pgSQL
--     reads a NULL condition as false. That is fail-open on the three
--     functions that edit roles and the reporting line.
--   * set_user_role's whitelist accepting 'admin' and rejecting 'cleaner'.
--
-- This restores exactly two pieces, taken from 0008 and 0010:
--   1. current_role() returns 'none' instead of NULL. That one change closes
--      the fail-open in all three functions, and in any future guard written
--      the same way. Checked live: nothing tests current_role() for NULL
--      (create_assignment already wraps it in coalesce).
--   2. set_user_role in 0010's form: a positive guard, and 'admin' out of
--      the whitelist, 'cleaner' back in. Admins are made only by the manual
--      SQL path in o-house-admin/supabase/README.md.
--
-- Deliberately NOT restored here:
--   * 0011's phone column restriction. The shipped app reads its profile with
--     select('*') (lib/data/providers.dart), which a column revoke would
--     break. The phone exposure closes when the app moves to the API
--     (plan Step 3) and the Data API gate goes on (Step 4).
--   * 0007/0009's other guard rewrites. Custom roles (plan Step 6) replace
--     every role check with has_permission(), so they would be written twice.
-- =====================================================================

begin;

create or replace function public.current_role()
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  -- coalesce, NOT a bare select: a NULL here silently disables every guard
  -- written as `if current_role() not in (...) then raise`.
  select coalesce(
    (select role from public.profiles where id = auth.uid()),
    'none'
  );
$function$;

create or replace function public.set_user_role(target_user_id uuid, new_role text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Positive shape on purpose: `if current_role() <> 'admin' then raise`
  -- is what failed open. Do not "simplify" it back.
  if public.current_role() = 'admin' then
    null;
  else
    raise exception 'Only admins can change user roles';
  end if;

  -- 'admin' deliberately absent: nothing callable may mint an admin.
  if new_role not in ('manager', 'inspector', 'cleaner') then
    raise exception 'Invalid role: %', new_role;
  end if;

  update public.profiles set role = new_role where id = target_user_id;
end;
$function$;

commit;

-- ---------------------------------------------------------------------
-- Verification (read-only). Expect: current_role_is_null = false,
-- and fail_open = false on every row.
-- ---------------------------------------------------------------------
-- select public.current_role() is null as current_role_is_null;
-- select p.proname,
--        pg_get_functiondef(p.oid) ~* 'current_role\(\)\s*(<>|!=)' as fail_open
--   from pg_proc p
--  where p.pronamespace = 'public'::regnamespace
--    and pg_get_functiondef(p.oid) ~ 'current_role';

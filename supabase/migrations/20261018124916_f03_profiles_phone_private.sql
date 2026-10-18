-- F-03 (qa/05-review-findings.md), story PLAT-09: staff phone numbers are
-- readable only through admin_staff_list, which checks phones.view.
--
-- Re-applies o-house-admin/supabase/migrations/0011 lines 427-437, which the
-- live database lost (the 22 Sep schema.sql re-run). Live on 18 Oct:
-- authenticated = ardm on profiles, i.e. table-wide SELECT (phone included),
-- INSERT, DELETE and MAINTAIN. A Manager holds users.view without
-- phones.view, and profiles_select plus can_see_staff let a team scope see
-- every staff row, so GET /rest/v1/profiles?select=name,phone returned
-- every phone number.
--
-- After this, signed-in users read every profile column except phone, the
-- same list as PROFILE_COLUMNS in the API (src/auth/current-user.ts) and the
-- portal (lib/types/database.ts), plus role_id, which 0011 predates.
-- assignments_v reads only profiles.id and name. Nothing inserts or deletes
-- a profile as the signed-in user: the API's createStaff uses the secret
-- key, and handle_new_user is SECURITY DEFINER.
--
-- Unchanged: the column UPDATE grants (name, phone, locale) behind
-- profiles_update_self. Whether staff should be able to change their own
-- name or phone directly is a separate question (noted, not in this fix).
--
-- Applied to the live database on 18 Oct 2026 as version 20261018124916.
-- Verified: no table-wide SELECT, phone not selectable, name and role_id
-- selectable; as a Manager, the API/portal profile columns read 16 rows,
-- assignments_v reads, and `select name, phone` is "permission denied".

begin;

revoke select, insert, delete, truncate, trigger, references, maintain
  on table public.profiles from authenticated;
grant select (id, name, email, role, role_id, created_at, department_id,
              manager_id, active, must_change_password, locale)
  on table public.profiles to authenticated;

revoke all on table public.profiles from anon;

commit;

-- Verification — expect each value shown:
--   select has_table_privilege('authenticated', 'public.profiles', 'SELECT');           -- false
--   select has_column_privilege('authenticated', 'public.profiles', 'phone', 'SELECT'); -- false
--   select has_column_privilege('authenticated', 'public.profiles', 'name', 'SELECT');  -- true
--   select has_table_privilege('authenticated', 'public.profiles', 'INSERT');           -- false
--   As a Manager's DB token: GET /rest/v1/profiles?select=name,phone   -- 401/42501 permission denied
--   Portal: sign-in, Users (phones only with phones.view), dashboard, checklist detail all work.
--   Phone: sign-in and GET /me work.

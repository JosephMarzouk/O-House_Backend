-- F-02 (qa/05-review-findings.md), stories PLAT-02, LEGACY-02, TASK-06:
-- checklists are written only through the database functions.
--
-- Live on 18 Oct, left over from the old web checklist:
--   * submissions_insert (TO public) let a signed-in user insert a checklist
--     with any column, status 'approved', score and reviewed_by included;
--     its only checks (own inspector_id, open window, own claim) are easy to
--     meet, because template_claims_insert lets anyone claim a template.
--   * authenticated and anon held INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER,
--     REFERENCES and MAINTAIN on submissions and template_claims.
--   * submissions_delete let checklists.delete hard-delete a checklist and
--     cascade away its items and history, where the decision is
--     "cancel only, keep history" (TASK-Q1; F-20).
--
-- Nothing in the API, the portal or the app writes these tables directly:
-- every write is a SECURITY DEFINER function (create_assignment,
-- schedule_rounds, mark_item_done, attach_item_photo, submit_assignment,
-- reject_items, approve_assignment, extend_assignment), which run as their
-- owner and don't need the caller's grants. SELECT stays: assignments_v is
-- security_invoker and reads submissions as the caller, under
-- submissions_select.
--
-- Breaks on purpose: the old web checklist's own writes (LEGACY-Q1). The
-- tables themselves are exported and dropped later (LEGACY-02).
--
-- Applied to the live database on 18 Oct 2026 as version 20261018124905.
-- Verified: authenticated INSERT/DELETE false, SELECT true; anon SELECT
-- false; only submissions_select and template_claims_select remain.

begin;

drop policy if exists submissions_insert       on public.submissions;
drop policy if exists submissions_delete       on public.submissions;
drop policy if exists template_claims_insert   on public.template_claims;
drop policy if exists template_claims_release  on public.template_claims;

revoke insert, update, delete, truncate, trigger, references, maintain
  on table public.submissions     from authenticated;
revoke insert, update, delete, truncate, trigger, references, maintain
  on table public.template_claims from authenticated;
revoke all on table public.submissions     from anon;
revoke all on table public.template_claims from anon;

commit;

-- Verification — expect each value shown:
--   select has_table_privilege('authenticated', 'public.submissions', 'INSERT');   -- false
--   select has_table_privilege('authenticated', 'public.submissions', 'DELETE');   -- false
--   select has_table_privilege('authenticated', 'public.submissions', 'SELECT');   -- true (the view needs it)
--   select has_table_privilege('anon', 'public.submissions', 'SELECT');            -- false
--   select policyname from pg_policies
--    where tablename in ('submissions', 'template_claims');   -- submissions_select, template_claims_select
--   Portal: create a checklist, plan a week, approve, send back, extend: all work.
--   Phone: answer, photo, submit: all work.

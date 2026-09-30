-- =====================================================================
-- reject_items: the rejection reason is required again
--
-- 20260923131847 made it optional (a blank reason was stored as NULL). The
-- decision is reversed: a manager or admin who sends a checklist back must
-- say why. Enforced here as well as in the portal, so no other caller (the
-- API, a script, a stale portal tab) can send items back without a reason.
--
-- Body is the LIVE definition (read 2026-09-29), with only the
-- REASON_REQUIRED check added. It sits AFTER the role checks, so a caller who
-- may not reject learns nothing, and BEFORE any update, so a refused call
-- changes nothing.
--
-- Same argument list as before, so CREATE OR REPLACE makes no overload and no
-- drop is needed; the grants (authenticated, service_role; not anon) are kept
-- by CREATE OR REPLACE and re-stated below anyway.
--
-- The portal maps the message to its own text (lib/actions/assignments.ts,
-- friendly()): keep the literal REASON_REQUIRED.
-- =====================================================================

begin;

create or replace function public.reject_items(p_assignment_id uuid, p_item_ids uuid[], p_reason text default null)
returns void language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_reason text := nullif(btrim(p_reason), '');
begin
  if coalesce(public.current_role(), 'none') not in ('admin', 'manager', 'inspector') then
    raise exception 'Only admins/managers/inspectors can reject items';
  end if;

  if coalesce(public.current_role(), 'none') <> 'admin'
     and exists (
       select 1 from public.submissions
        where id = p_assignment_id and inspector_id = auth.uid()
     ) then
    raise exception 'You cannot review an assignment you carried out';
  end if;

  if v_reason is null then
    raise exception 'REASON_REQUIRED';
  end if;

  update public.assignment_items
     set status = 'rejected', reject_note = v_reason, done_at = null
   where assignment_id = p_assignment_id and id = any(p_item_ids);

  update public.submissions
     set status = 'in_progress', review_note = v_reason,
         reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_assignment_id;
end;
$function$;

revoke execute on function public.reject_items(uuid, uuid[], text) from public, anon;
grant  execute on function public.reject_items(uuid, uuid[], text) to authenticated, service_role;

commit;

-- ---------------------------------------------------------------------
-- Verification (read-only). Expect one row, count = 1, anon_can_execute = false:
-- ---------------------------------------------------------------------
-- select p.proname, count(*), bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')) as anon_can_execute
--   from pg_proc p
--  where p.pronamespace = 'public'::regnamespace and p.proname = 'reject_items'
--  group by 1;

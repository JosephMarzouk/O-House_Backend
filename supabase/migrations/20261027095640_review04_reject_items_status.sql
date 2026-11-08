-- REVIEW-04 / F-16: send back only from 'submitted' or 'follow_up'.
-- Before this, reject_items worked from any status, so it could reopen an
-- approved checklist, and an empty or foreign list of item ids still moved
-- the checklist to in_progress (and fired the E5 push).
--
-- The row is locked first, so a send-back racing an approval waits for it,
-- then sees 'approved' and is refused (REVIEW-04-TC04). Same signature, so
-- create or replace is enough (no second copy for PostgREST).

create or replace function public.reject_items(p_assignment_id uuid, p_item_ids uuid[], p_reason text default null)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_reason text := nullif(btrim(p_reason), '');
  v_status text;
begin
  perform private.require('review.edit');
  perform private.require_in_scope(p_assignment_id);

  if (private.my_role()).key is distinct from 'admin'
     and exists (
       select 1 from public.submissions
        where id = p_assignment_id and inspector_id = auth.uid()
     ) then
    raise exception 'You cannot review an assignment you carried out';
  end if;

  -- 20260929123420: after the permission checks, before any update.
  if v_reason is null then
    raise exception 'REASON_REQUIRED';
  end if;

  select status into v_status from public.submissions
   where id = p_assignment_id
     for update;
  if v_status is distinct from 'submitted' and v_status is distinct from 'follow_up' then
    raise exception 'NOT_REVIEWABLE: status %', coalesce(v_status, 'missing');
  end if;

  -- Every id must be an item of this checklist, and there must be at least one.
  if coalesce(cardinality(p_item_ids), 0) = 0
     or (select count(*) from public.assignment_items
          where assignment_id = p_assignment_id and id = any(p_item_ids))
        <> (select count(distinct x) from unnest(p_item_ids) x) then
    raise exception 'NO_ITEMS: item ids missing or not on this checklist';
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

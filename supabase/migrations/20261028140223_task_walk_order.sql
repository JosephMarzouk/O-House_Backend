-- =====================================================================
-- Walk order for multi-place tasks (follow-up to 20261028123023_qr_places)
--
-- A task's places share one window when the New task form gives them none
-- of their own, and create_assignment stamps them all with the same
-- created_at (one transaction), so nothing kept the order the admin put
-- them in: the app's walk order (window, then arrival) came out shuffled.
--
-- * submissions.group_position: a one-off task's place number (1, 2, 3 …),
--   set by create_task_group in the form's order.
-- * A zone round needs no column: its order is round_templates.places, read
--   in the view, so schedule_rounds (tested, unchanged) is left alone.
-- * assignments_v.group_position: whichever of the two applies, null outside
--   a task. Display only (QF): places still unlock in any order.
--
-- Expand only, re-runnable.
-- =====================================================================

begin;

alter table public.submissions add column if not exists group_position smallint;

-- create_task_group as in qr_places, plus group_position.
create or replace function public.create_task_group(
  p_title_en text, p_title_ar text, p_places jsonb, p_assignee_ids uuid[],
  p_scheduled_date date, p_end_date date, p_task_note text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_group uuid; v_place record; v_new uuid; v_n int := 0;
begin
  perform private.require('checklists.create');
  perform private.check_assignees(p_assignee_ids);
  if nullif(btrim(p_title_en), '') is null then raise exception 'TITLE_REQUIRED'; end if;
  if jsonb_typeof(p_places) is distinct from 'array' or jsonb_array_length(p_places) = 0 then
    raise exception 'INVALID_PLACES';
  end if;
  if (select count(distinct e ->> 'template_id') from jsonb_array_elements(p_places) e)
     <> jsonb_array_length(p_places) then
    raise exception 'DUPLICATE_PLACE';
  end if;

  insert into public.task_groups (title_en, title_ar, created_by)
  values (btrim(p_title_en), nullif(btrim(p_title_ar), ''), auth.uid())
  returning id into v_group;

  for v_place in
    select t.id, t.title_en, t.title_ar, t.site_id, t.items,
           nullif(e.p ->> 'window_start', '')::time as ws,
           nullif(e.p ->> 'window_end', '')::time   as we
      from jsonb_array_elements(p_places) with ordinality as e(p, ord)
      join public.templates t on t.id::text = e.p ->> 'template_id'
     order by e.ord
  loop
    v_new := private.create_assignment(
      v_place.title_en, v_place.title_ar, v_place.site_id, p_assignee_ids,
      p_scheduled_date, v_place.ws, v_place.we, v_place.items, v_place.id, null::uuid,
      p_task_note, p_end_date);
    update public.submissions set task_group_id = v_group, group_position = v_n + 1
     where id = v_new;
    v_n := v_n + 1;
  end loop;

  if v_n <> jsonb_array_length(p_places) then raise exception 'Place not found'; end if;
  return v_group;
end $$;
revoke all on function public.create_task_group(text, text, jsonb, uuid[], date, date, text) from public, anon;
grant execute on function public.create_task_group(text, text, jsonb, uuid[], date, date, text) to authenticated;

-- assignments_v as in qr_places, plus group_position at the end.
create or replace view public.assignments_v with (security_invoker = on) as
 SELECT a.id,
    a.template_id,
    a.template_title_ar,
    a.template_title_en,
    a.site_id,
    a.site_name_ar,
    a.site_name_en,
    a.inspector_id,
    a.inspector_name,
    a.answers,
    a.signature_url,
    a.score,
    a.submitted_at,
    a.created_by,
    a.created_at,
    a.title_en,
    a.title_ar,
    a.source_template_id,
    a.scheduled_date,
    a.window_start,
    a.window_end,
    a.status,
    a.reviewed_by,
    a.reviewed_at,
    a.review_note,
    a.client_id,
    a.extended_until,
    a.extended_by,
    a.extended_at,
    a.extension_note,
    a.completed_at,
    a.late_sync,
    a.round_id,
    COALESCE(a.extended_until, ((COALESCE(a.end_date, a.scheduled_date) +
        CASE
            WHEN a.window_end < a.window_start THEN 1
            ELSE 0
        END + a.window_end) AT TIME ZONE 'Africa/Cairo'::text)) AS deadline,
        CASE
            WHEN a.status = ANY (ARRAY['submitted'::text, 'approved'::text, 'rejected'::text, 'follow_up'::text]) THEN a.status
            WHEN a.scheduled_date IS NULL OR a.window_end IS NULL THEN a.status
            WHEN now() > COALESCE(a.extended_until, ((COALESCE(a.end_date, a.scheduled_date) +
            CASE
                WHEN a.window_end < a.window_start THEN 1
                ELSE 0
            END + a.window_end) AT TIME ZONE 'Africa/Cairo'::text)) THEN 'expired'::text
            ELSE a.status
        END AS effective_status,
    a.extended_until IS NOT NULL AS was_extended,
    rt.title_en AS round_title_en,
    rt.title_ar AS round_title_ar,
    a.task_note,
    a.submit_note,
    a.end_date,
    a.assignee_ids,
    ARRAY( SELECT p.name
           FROM unnest(a.assignee_ids) WITH ORDINALITY u(id, n)
             JOIN profiles p ON p.id = u.id
          ORDER BY u.n) AS assignee_names,
    -- 20261028123023: QR-locked places and multi-place tasks.
    a.qr_required,
    COALESCE(a.round_id, a.task_group_id) AS group_id,
    COALESCE(rt.title_en, tg.title_en) AS group_title_en,
    COALESCE(rt.title_ar, tg.title_ar) AS group_title_ar,
    -- Checklists of the task the caller can see (RLS), by the indexed column.
        CASE
            WHEN a.round_id IS NOT NULL THEN ( SELECT count(*)::integer FROM submissions g WHERE g.round_id = a.round_id)
            WHEN a.task_group_id IS NOT NULL THEN ( SELECT count(*)::integer FROM submissions g WHERE g.task_group_id = a.task_group_id)
            ELSE 1
        END AS group_size,
        CASE
            WHEN a.qr_required THEN private.place_qr_hash(a.source_template_id)
            ELSE NULL::text
        END AS qr_hash,
    (EXISTS ( SELECT 1
           FROM place_scans ps
          WHERE ps.assignment_id = a.id AND (ps.kind = ANY (ARRAY['scan'::text, 'unlock'::text])))) AS unlocked,
    COALESCE(a.group_position::integer, ( SELECT e.ord::integer
           FROM jsonb_array_elements(rt.places) WITH ORDINALITY e(p, ord)
          WHERE (e.p ->> 'template_id') = a.source_template_id::text
         LIMIT 1)) AS group_position
   FROM submissions a
     LEFT JOIN rounds r ON r.id = a.round_id
     LEFT JOIN round_templates rt ON rt.id = r.round_template_id
     LEFT JOIN task_groups tg ON tg.id = a.task_group_id;

do $$
begin
  if (select reloptions from pg_class where oid = 'public.assignments_v'::regclass)
     is distinct from array['security_invoker=on'] then
    raise exception 'assignments_v lost security_invoker';
  end if;
end $$;

commit;

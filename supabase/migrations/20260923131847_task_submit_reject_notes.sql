-- =====================================================================
-- Notes on create, submit and send-back
--
--   * submissions.task_note   — optional instructions from whoever creates the task
--   * submissions.submit_note — optional note from the staff member at submit
--   * reject_items' reason    — now optional (was required by the portal)
--
-- Function bodies are the LIVE definitions (read 2026-09-23), not 0013's
-- file, with only the note handling added.
--
-- Two traps this migration is written around:
--   1. create_assignment and submit_assignment gain a parameter. CREATE OR
--      REPLACE with a different argument list makes a SECOND function (an
--      overload), and PostgREST then refuses every call as ambiguous. So each
--      old signature is dropped first, in this same transaction, and its
--      grants are re-applied. The new parameters have defaults, so every
--      existing caller (the shipped app, the portal) keeps working unchanged.
--   2. assignments_v is recreated to expose the two columns. It MUST keep
--      security_invoker = on: without it the view runs as its owner and every
--      signed-in user could read every round. Stated explicitly below, and
--      checked at the foot.
-- =====================================================================

begin;

alter table public.submissions
  add column if not exists task_note   text,
  add column if not exists submit_note text;

-- ---------------------------------------------------------------------
-- create_assignment + p_task_note
-- ---------------------------------------------------------------------
drop function public.create_assignment(text, text, uuid, uuid, date, time, time, jsonb, uuid, uuid);

create function public.create_assignment(
  p_title_en text, p_title_ar text, p_site_id uuid, p_assignee_id uuid,
  p_scheduled_date date, p_window_start time, p_window_end time,
  p_items jsonb, p_source_template_id uuid default null, p_client_id uuid default null,
  p_task_note text default null
) returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_id uuid; v_site_ar text; v_site_en text; v_assignee_name text;
  v_item jsonb; v_i int := 0;
begin
  if coalesce(public.current_role(), 'none') not in ('admin', 'manager', 'inspector') then
    raise exception 'Only admins/managers/inspectors can create assignments';
  end if;

  if p_client_id is not null then
    select id into v_id from public.submissions where client_id = p_client_id;
    if v_id is not null then return v_id; end if;      -- idempotent
  end if;

  select name_ar, name_en into v_site_ar, v_site_en
    from public.sites where id = p_site_id;

  select name into v_assignee_name from public.profiles where id = p_assignee_id;
  if v_assignee_name is null then raise exception 'Assignee not found'; end if;

  insert into public.submissions (
    template_id, template_title_ar, template_title_en,
    site_id, site_name_ar, site_name_en,
    inspector_id, inspector_name,
    title_en, title_ar, source_template_id,
    scheduled_date, window_start, window_end,
    status, created_by, client_id, submitted_at, answers,
    task_note
  ) values (
    p_source_template_id, p_title_ar, p_title_en,
    p_site_id, v_site_ar, v_site_en,
    p_assignee_id, v_assignee_name,
    p_title_en, p_title_ar, p_source_template_id,
    p_scheduled_date, p_window_start, p_window_end,
    'pending', auth.uid(), p_client_id, null, '[]'::jsonb,
    nullif(btrim(p_task_note), '')
  ) returning id into v_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    insert into public.assignment_items (
      assignment_id, template_item_id, text_en, text_ar,
      type, critical, requires_photo, sort_order, correct
    ) values (
      v_id,
      v_item ->> 'id',
      coalesce(v_item ->> 'text_en', ''),
      coalesce(v_item ->> 'text_ar', ''),
      coalesce(v_item ->> 'type', 'yesno'),
      coalesce((v_item ->> 'critical')::bool, false),
      coalesce((v_item ->> 'requires_photo')::bool, false),
      v_i,
      case when jsonb_typeof(v_item -> 'correct') = 'object' then v_item -> 'correct' end
    );
    v_i := v_i + 1;
  end loop;

  return v_id;
end;
$function$;

revoke execute on function public.create_assignment(text, text, uuid, uuid, date, time, time, jsonb, uuid, uuid, text) from public, anon;
grant  execute on function public.create_assignment(text, text, uuid, uuid, date, time, time, jsonb, uuid, uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- submit_assignment + p_note
-- ---------------------------------------------------------------------
drop function public.submit_assignment(uuid, text, timestamptz);

create function public.submit_assignment(
  p_assignment_id uuid,
  p_signature_path text,
  p_completed_at timestamptz default null,
  p_note text default null
) returns void language plpgsql security definer set search_path to 'public' as $fn$
declare
  v_assignee uuid; v_status text; v_deadline timestamptz;
  v_answered int; v_flagged int; v_missing_photo int; v_late bool := false;
begin
  select a.inspector_id, a.status, v.deadline
    into v_assignee, v_status, v_deadline
  from public.submissions a
  join public.assignments_v v on v.id = a.id
  where a.id = p_assignment_id;

  if v_assignee is null then raise exception 'Assignment not found'; end if;
  if v_assignee is distinct from auth.uid() then raise exception 'Not authorized'; end if;
  if v_status in ('submitted','approved') then return; end if;   -- idempotent replay

  select count(*) filter (where status in ('done', 'follow_up')),
         count(*) filter (where status = 'follow_up'),
         count(*) filter (where status in ('done', 'follow_up') and requires_photo
                            and coalesce(array_length(photo_paths, 1), 0) = 0)
    into v_answered, v_flagged, v_missing_photo
    from public.assignment_items
   where assignment_id = p_assignment_id;

  if v_answered = 0 then
    raise exception 'EMPTY_SUBMISSION: no item(s) done';
  end if;
  if v_missing_photo > 0 then
    raise exception 'MISSING_PHOTO: % item(s) require a photo', v_missing_photo;
  end if;

  if v_status <> 'follow_up' and v_deadline is not null then
    if p_completed_at is not null and p_completed_at <= v_deadline then
      v_late := now() > v_deadline;
    elsif now() > v_deadline then
      raise exception 'ASSIGNMENT_EXPIRED';
    end if;
  end if;

  update public.submissions
     set status        = case when v_flagged > 0 then 'follow_up' else 'submitted' end,
         submitted_at  = case when v_status = 'follow_up' then submitted_at else now() end,
         completed_at  = case when v_status = 'follow_up' then completed_at
                              else coalesce(p_completed_at, now()) end,
         late_sync     = case when v_status = 'follow_up' then late_sync else v_late end,
         signature_url = p_signature_path,
         -- A follow-up resubmission without a new note keeps the earlier one.
         submit_note   = coalesce(nullif(btrim(p_note), ''), submit_note)
   where id = p_assignment_id;
end;
$fn$;

revoke execute on function public.submit_assignment(uuid, text, timestamptz, text) from public, anon;
grant  execute on function public.submit_assignment(uuid, text, timestamptz, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- reject_items: the reason becomes optional. Same argument types, so
-- CREATE OR REPLACE may add the default without creating an overload.
-- An empty or blank reason is stored as NULL, never ''.
-- ---------------------------------------------------------------------
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

  update public.assignment_items
     set status = 'rejected', reject_note = v_reason, done_at = null
   where assignment_id = p_assignment_id and id = any(p_item_ids);

  update public.submissions
     set status = 'in_progress', review_note = v_reason,
         reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_assignment_id;
end;
$function$;

-- ---------------------------------------------------------------------
-- assignments_v: the live definition, plus the two notes at the END (the
-- only place CREATE OR REPLACE VIEW may add columns). security_invoker is
-- stated explicitly — see the header.
-- ---------------------------------------------------------------------
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
    COALESCE(a.extended_until, ((a.scheduled_date +
        CASE
            WHEN a.window_end < a.window_start THEN 1
            ELSE 0
        END + a.window_end) AT TIME ZONE 'Africa/Cairo'::text)) AS deadline,
        CASE
            WHEN a.status = ANY (ARRAY['submitted'::text, 'approved'::text, 'rejected'::text, 'follow_up'::text]) THEN a.status
            WHEN a.scheduled_date IS NULL OR a.window_end IS NULL THEN a.status
            WHEN now() > COALESCE(a.extended_until, ((a.scheduled_date +
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
    a.submit_note
   FROM submissions a
     LEFT JOIN rounds r ON r.id = a.round_id
     LEFT JOIN round_templates rt ON rt.id = r.round_template_id;

commit;

-- ---------------------------------------------------------------------
-- Verification (read-only). Expect:
--   view_options            = {security_invoker=on}
--   one row per function, count = 1
--   anon_can_execute        = false on all three
-- ---------------------------------------------------------------------
-- select reloptions as view_options from pg_class where oid = 'public.assignments_v'::regclass;
-- select p.proname, count(*), bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')) as anon_can_execute
--   from pg_proc p
--  where p.pronamespace = 'public'::regnamespace
--    and p.proname in ('create_assignment', 'submit_assignment', 'reject_items')
--  group by 1;

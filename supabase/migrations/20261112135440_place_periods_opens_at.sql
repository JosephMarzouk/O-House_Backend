-- The same place more than once in a round or a multi-place task, each time in its own period;
-- and the time a checklist opens, for the app's "not open yet" gate.
--
-- 1. private.place_windows_overlap(places): true when two entries for the same place have
--    overlapping windows. A window whose end is at or before its start runs overnight. Back to back
--    (08:00-09:00 then 09:00-10:00) is not an overlap.
-- 2. create_task_group: a repeated place is fine; an overlapping one raises PLACE_WINDOW_OVERLAP
--    (was DUPLICATE_PLACE for any repeat). Same signature, so no drop.
-- 3. round_templates: a trigger raises PLACE_WINDOW_OVERLAP (the portal writes the table directly).
-- 4. schedule_rounds: was "skip a place the round already has", so a repeated place got one
--    checklist. Now each place's entries are numbered in list order, and an entry is created only
--    when the round has fewer checklists of that place than its number: still safe to re-run. New
--    round checklists store group_position (the entry's position), so repeats keep their own.
-- 5. assignments_v gains opens_at: scheduled_date + window_start in Cairo (the first day for a
--    multi-day task). The app keeps a checklist shut until 5 minutes before it; the server refuses
--    nothing (enforcement stays app-only, as for QR). Recreated with security_invoker.

begin;

-- 1 ------------------------------------------------------------------------------------------
create or replace function private.place_windows_overlap(p_places jsonb)
returns boolean language sql immutable set search_path = '' as $$
  with w as (
    select e.ord, e.p ->> 'template_id' as tid,
           extract(epoch from (e.p ->> 'window_start')::time)::int / 60 as s,
           extract(epoch from (e.p ->> 'window_end')::time)::int / 60
             + case when (e.p ->> 'window_end')::time <= (e.p ->> 'window_start')::time
                    then 1440 else 0 end as e
      from jsonb_array_elements(case when jsonb_typeof(p_places) = 'array' then p_places
                                     else '[]'::jsonb end) with ordinality as e(p, ord)
     where nullif(e.p ->> 'window_start', '') is not null
       and nullif(e.p ->> 'window_end', '') is not null
  )
  select exists (
    select 1 from w a join w b on a.tid = b.tid and a.ord < b.ord
     cross join (values (-1440), (0), (1440)) k(shift)
     where a.s < b.e + k.shift and b.s + k.shift < a.e)
$$;

-- 2 ------------------------------------------------------------------------------------------
create or replace function public.create_task_group(p_title_en text, p_title_ar text, p_places jsonb,
  p_assignee_ids uuid[], p_scheduled_date date, p_end_date date, p_task_note text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_group uuid; v_place record; v_new uuid; v_n int := 0;
begin
  perform private.require('checklists.create');
  perform private.check_assignees(p_assignee_ids);
  if nullif(btrim(p_title_en), '') is null then raise exception 'TITLE_REQUIRED'; end if;
  if jsonb_typeof(p_places) is distinct from 'array' or jsonb_array_length(p_places) = 0 then
    raise exception 'INVALID_PLACES';
  end if;
  if private.place_windows_overlap(p_places) then
    raise exception 'PLACE_WINDOW_OVERLAP';
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

-- 3 ------------------------------------------------------------------------------------------
create or replace function private.round_template_places_check()
returns trigger language plpgsql set search_path = '' as $$
begin
  if private.place_windows_overlap(new.places) then
    raise exception 'PLACE_WINDOW_OVERLAP';
  end if;
  return new;
end $$;

drop trigger if exists round_templates_places_check on public.round_templates;
create trigger round_templates_places_check
  before insert or update of places on public.round_templates
  for each row execute function private.round_template_places_check();

-- 4 ------------------------------------------------------------------------------------------
create or replace function public.schedule_rounds(p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = 'public' as $$
declare
  v_cell jsonb; v_rt uuid; v_date date; v_ids uuid[]; v_name text;
  v_round uuid; v_place record; v_new uuid; v_n int;
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_created int := 0; v_moved int := 0; v_removed int := 0; v_kept int := 0; v_skipped int := 0;
begin
  perform private.require('planner.create');
  if jsonb_typeof(p_plan) is distinct from 'array' then
    raise exception 'INVALID_PLAN';
  end if;

  for v_cell in select value from jsonb_array_elements(p_plan)
  loop
    v_rt   := nullif(v_cell ->> 'round_template_id', '')::uuid;
    v_date := nullif(v_cell ->> 'date', '')::date;
    select coalesce(array_agg(distinct x order by x), '{}') into v_ids
      from (select nullif(e, '')::uuid as x
              from jsonb_array_elements_text(
                     case when jsonb_typeof(v_cell -> 'assignee_ids') = 'array' then v_cell -> 'assignee_ids'
                          else jsonb_build_array(v_cell ->> 'assignee_id') end) as e) s
     where x is not null;

    if v_rt is null or v_date is null then raise exception 'INVALID_PLAN'; end if;
    if v_date < v_today then raise exception 'PAST_DATE'; end if;

    if cardinality(v_ids) = 0 then
      select id into v_round from public.rounds
       where round_template_id = v_rt and scheduled_date = v_date
       for update;
      continue when v_round is null;

      delete from public.submissions s
       where s.round_id = v_round and s.status = 'pending'
         and not exists (select 1 from public.assignment_items i
                          where i.assignment_id = s.id
                            and (i.status <> 'pending' or cardinality(i.photo_paths) > 0));
      get diagnostics v_n = row_count;
      v_removed := v_removed + v_n;

      select count(*) into v_n from public.submissions where round_id = v_round;
      v_kept := v_kept + v_n;
      if v_n = 0 then
        delete from public.rounds where id = v_round;
      else
        update public.rounds set assignee_id = null, assignee_ids = '{}' where id = v_round;
      end if;
      continue;
    end if;

    -- was: active cleaners or inspectors, the two roles that hold staff_app.view
    perform private.check_assignees(v_ids);
    v_name := case when cardinality(v_ids) = 1
                   then (select name from public.profiles where id = v_ids[1]) end;

    insert into public.rounds (round_template_id, scheduled_date, assignee_id, assignee_ids, created_by)
    values (v_rt, v_date, v_ids[1], v_ids, auth.uid())
    on conflict (round_template_id, scheduled_date)
      do update set assignee_id = excluded.assignee_id, assignee_ids = excluded.assignee_ids
    returning id into v_round;

    update public.submissions s
       set assignee_ids   = v_ids,
           inspector_id   = case when cardinality(v_ids) = 1 then v_ids[1] end,
           inspector_name = v_name
     where s.round_id = v_round
       and s.assignee_ids is distinct from v_ids
       and s.status = 'pending'
       and not exists (select 1 from public.assignment_items i
                        where i.assignment_id = s.id
                          and (i.status <> 'pending' or cardinality(i.photo_paths) > 0));
    get diagnostics v_n = row_count;
    v_moved := v_moved + v_n;

    select count(*) into v_n from public.submissions
     where round_id = v_round and assignee_ids is distinct from v_ids;
    v_kept := v_kept + v_n;

    for v_place in
      select t.id, t.title_en, t.title_ar, t.site_id, t.items, e.ord,
             row_number() over (partition by t.id order by e.ord) as occurrence,
             nullif(e.p ->> 'window_start', '')::time as ws,
             nullif(e.p ->> 'window_end', '')::time   as we
        from public.round_templates rt
       cross join lateral jsonb_array_elements(rt.places) with ordinality as e(p, ord)
        join public.templates t on t.id::text = e.p ->> 'template_id'
       where rt.id = v_rt
       order by e.ord
    loop
      -- The round already has this many checklists of the place: this entry exists.
      continue when v_place.occurrence <= (select count(*) from public.submissions s
                                            where s.round_id = v_round
                                              and s.source_template_id = v_place.id);
      if v_place.site_id is null or v_place.ws is null or v_place.we is null
         or (case when jsonb_typeof(v_place.items) = 'array'
                  then jsonb_array_length(v_place.items) else 0 end) = 0 then
        v_skipped := v_skipped + 1;
        continue;
      end if;

      v_new := private.create_assignment(
        v_place.title_en, v_place.title_ar, v_place.site_id, v_ids,
        v_date, v_place.ws, v_place.we, v_place.items, v_place.id, null::uuid);
      update public.submissions set round_id = v_round, group_position = v_place.ord
       where id = v_new;
      v_created := v_created + 1;
    end loop;
  end loop;

  return jsonb_build_object('created', v_created, 'moved', v_moved, 'removed', v_removed,
                            'kept', v_kept, 'skipped', v_skipped);
end $$;

-- 5 ------------------------------------------------------------------------------------------
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
    a.qr_required,
    COALESCE(a.round_id, a.task_group_id) AS group_id,
    COALESCE(rt.title_en, tg.title_en) AS group_title_en,
    COALESCE(rt.title_ar, tg.title_ar) AS group_title_ar,
        CASE
            WHEN a.round_id IS NOT NULL THEN ( SELECT count(*)::integer AS count
               FROM submissions g
              WHERE g.round_id = a.round_id)
            WHEN a.task_group_id IS NOT NULL THEN ( SELECT count(*)::integer AS count
               FROM submissions g
              WHERE g.task_group_id = a.task_group_id)
            ELSE 1
        END AS group_size,
        CASE
            WHEN a.qr_required THEN private.place_qr_hash(a.source_template_id)
            ELSE NULL::text
        END AS qr_hash,
    (EXISTS ( SELECT 1
           FROM place_scans ps
          WHERE ps.assignment_id = a.id AND (ps.kind = ANY (ARRAY['scan'::text, 'unlock'::text])))) AS unlocked,
    COALESCE(a.group_position::integer, ( SELECT e.ord::integer AS ord
           FROM jsonb_array_elements(rt.places) WITH ORDINALITY e(p, ord)
          WHERE (e.p ->> 'template_id'::text) = a.source_template_id::text
         LIMIT 1)) AS group_position,
    ((a.scheduled_date + a.window_start) AT TIME ZONE 'Africa/Cairo'::text) AS opens_at
   FROM submissions a
     LEFT JOIN rounds r ON r.id = a.round_id
     LEFT JOIN round_templates rt ON rt.id = r.round_template_id
     LEFT JOIN task_groups tg ON tg.id = a.task_group_id;

commit;

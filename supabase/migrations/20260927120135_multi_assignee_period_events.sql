-- =====================================================================
-- Several assignees, multi-day tasks, status history (expand only)
--
--   * submissions.assignee_ids — everyone the task was given to. inspector_id
--     now means the OWNER: set at creation when there is one assignee,
--     otherwise NULL until the first assignee acts (answer, photo or
--     submit). private.claim_assignment() does the claiming; the others then
--     get ASSIGNMENT_TAKEN.
--   * submissions.end_date — the last day of a multi-day task (NULL = one day).
--     assignments_v's deadline runs to end_date + window_end.
--   * rounds.assignee_ids — the planner cell's people. rounds.assignee_id is
--     kept filled (first id) for the portal build still on main; it goes in
--     a later contract migration.
--   * submission_events — the status history the daily report prints.
--
-- Function bodies are the LIVE definitions (read 2026-09-27) with only the
-- assignee / end-date handling changed.
--
-- Compatibility (the shipped app and the portal on main keep working):
--   * mark_item_done / attach_item_photo / submit_assignment keep their
--     signatures. Existing rows are backfilled so their one assignee is
--     already the owner, which makes the claim a no-op for them.
--   * create_assignment gains a second signature (p_assignee_ids uuid[],
--     p_end_date). The old one stays as a thin wrapper. PostgREST tells them
--     apart by argument NAME (p_assignee_id vs p_assignee_ids), so there is
--     no "could not choose the best candidate" ambiguity.
--   * schedule_rounds accepts a cell's assignee_ids or the old assignee_id.
--   * assignments_v gains columns at the END only, and keeps
--     security_invoker = on (stated explicitly, checked at the foot).
-- =====================================================================

begin;

create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------
alter table public.submissions
  add column if not exists assignee_ids uuid[] not null default '{}',
  add column if not exists end_date date;

alter table public.submissions
  alter column inspector_id drop not null,
  alter column inspector_name drop not null;

alter table public.submissions
  drop constraint if exists submissions_end_date_check,
  add constraint submissions_end_date_check check (end_date is null or end_date > scheduled_date);

update public.submissions
   set assignee_ids = array[inspector_id]
 where inspector_id is not null and assignee_ids = '{}';

create index if not exists submissions_assignee_ids_idx on public.submissions using gin (assignee_ids);

alter table public.rounds
  add column if not exists assignee_ids uuid[] not null default '{}';
update public.rounds
   set assignee_ids = array[assignee_id]
 where assignee_id is not null and assignee_ids = '{}';

-- ---------------------------------------------------------------------
-- Claiming: the first assignee to act owns the task
-- ---------------------------------------------------------------------
create or replace function private.claim_assignment(p_assignment_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_owner_name text;
begin
  if not exists (select 1 from public.submissions
                  where id = p_assignment_id and auth.uid() = any (assignee_ids)) then
    raise exception 'Not authorized';
  end if;

  -- The row lock serialises two assignees acting at once: the second waits,
  -- then finds inspector_id set and falls through to the check below.
  update public.submissions
     set inspector_id   = auth.uid(),
         inspector_name = (select name from public.profiles where id = auth.uid())
   where id = p_assignment_id and inspector_id is null;

  select inspector_id, inspector_name into v_owner, v_owner_name
    from public.submissions where id = p_assignment_id;
  if v_owner is distinct from auth.uid() then
    raise exception 'ASSIGNMENT_TAKEN: %', coalesce(v_owner_name, '');
  end if;
end $$;
revoke all on function private.claim_assignment(uuid) from public;

-- ---------------------------------------------------------------------
-- The three staff RPCs: same signatures, the assignee check becomes a claim
-- ---------------------------------------------------------------------
create or replace function public.mark_item_done(p_item_id uuid, p_note text default null, p_answer text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
declare
  v_assignment uuid; v_status text; v_correct jsonb; v_ok boolean;
  v_answer text := nullif(btrim(p_answer), '');
begin
  select i.assignment_id, s.status, i.correct
    into v_assignment, v_status, v_correct
  from public.assignment_items i
  join public.submissions s on s.id = i.assignment_id
  where i.id = p_item_id;

  if v_assignment is null then raise exception 'Item not found'; end if;
  perform private.claim_assignment(v_assignment);
  if v_status in ('submitted', 'approved') then raise exception 'Assignment is closed'; end if;

  v_ok := coalesce(public.answer_ok(v_correct, v_answer), false);

  update public.assignment_items
     set status         = case when v_ok then 'done' else 'follow_up' end,
         done_at        = case when v_ok then now() end,
         note           = coalesce(p_note, note),
         reject_note    = null,
         answer         = coalesce(v_answer, answer),
         flagged_answer = case when v_ok then flagged_answer else coalesce(flagged_answer, v_answer) end,
         flagged_at     = case when v_ok then flagged_at     else coalesce(flagged_at, now()) end
   where id = p_item_id;

  update public.submissions set status = 'in_progress'
   where id = v_assignment and status = 'pending';
end $$;

create or replace function public.attach_item_photo(p_item_id uuid, p_storage_path text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_assignment uuid; v_status text;
begin
  select i.assignment_id, s.status into v_assignment, v_status
  from public.assignment_items i
  join public.submissions s on s.id = i.assignment_id
  where i.id = p_item_id;

  if v_assignment is null then raise exception 'Item not found'; end if;
  perform private.claim_assignment(v_assignment);
  if v_status in ('submitted','approved') then raise exception 'Assignment is closed'; end if;

  update public.assignment_items
     set photo_paths = array_append(photo_paths, p_storage_path)
   where id = p_item_id
     and not (p_storage_path = any (photo_paths));   -- idempotent on replay
end $$;

create or replace function public.submit_assignment(
  p_assignment_id uuid, p_signature_path text,
  p_completed_at timestamptz default null, p_note text default null
) returns void language plpgsql security definer set search_path to 'public' as $$
declare
  v_found uuid; v_status text; v_deadline timestamptz;
  v_answered int; v_flagged int; v_missing_photo int; v_late bool := false;
begin
  select a.id, a.status, v.deadline
    into v_found, v_status, v_deadline
  from public.submissions a
  join public.assignments_v v on v.id = a.id
  where a.id = p_assignment_id;

  if v_found is null then raise exception 'Assignment not found'; end if;
  perform private.claim_assignment(p_assignment_id);
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
end $$;

-- ---------------------------------------------------------------------
-- create_assignment: several assignees + an optional end date
-- ---------------------------------------------------------------------
create function public.create_assignment(
  p_title_en text, p_title_ar text, p_site_id uuid, p_assignee_ids uuid[],
  p_scheduled_date date, p_window_start time, p_window_end time,
  p_items jsonb, p_source_template_id uuid default null, p_client_id uuid default null,
  p_task_note text default null, p_end_date date default null
) returns uuid language plpgsql security definer set search_path to 'public' as $$
declare
  v_id uuid; v_site_ar text; v_site_en text; v_owner uuid; v_owner_name text;
  v_ids uuid[]; v_item jsonb; v_i int := 0;
begin
  if coalesce(public.current_role(), 'none') not in ('admin', 'manager', 'inspector') then
    raise exception 'Only admins/managers/inspectors can create assignments';
  end if;

  if p_client_id is not null then
    select id into v_id from public.submissions where client_id = p_client_id;
    if v_id is not null then return v_id; end if;      -- idempotent
  end if;

  -- Sorted and de-duplicated, so the planner can compare two sets with =.
  select coalesce(array_agg(distinct x order by x), '{}') into v_ids
    from unnest(p_assignee_ids) as u(x) where x is not null;
  if cardinality(v_ids) = 0
     or exists (select 1 from unnest(v_ids) as u(x)
                 where not exists (select 1 from public.profiles p where p.id = u.x)) then
    raise exception 'Assignee not found';
  end if;
  if p_end_date is not null and p_scheduled_date is not null and p_end_date < p_scheduled_date then
    raise exception 'INVALID_END_DATE';
  end if;

  -- One person owns it from the start; several claim it by acting first.
  if cardinality(v_ids) = 1 then
    v_owner := v_ids[1];
    select name into v_owner_name from public.profiles where id = v_owner;
  end if;

  select name_ar, name_en into v_site_ar, v_site_en
    from public.sites where id = p_site_id;

  insert into public.submissions (
    template_id, template_title_ar, template_title_en,
    site_id, site_name_ar, site_name_en,
    inspector_id, inspector_name, assignee_ids,
    title_en, title_ar, source_template_id,
    scheduled_date, end_date, window_start, window_end,
    status, created_by, client_id, submitted_at, answers,
    task_note
  ) values (
    p_source_template_id, p_title_ar, p_title_en,
    p_site_id, v_site_ar, v_site_en,
    v_owner, v_owner_name, v_ids,
    p_title_en, p_title_ar, p_source_template_id,
    p_scheduled_date, nullif(p_end_date, p_scheduled_date), p_window_start, p_window_end,
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
end $$;
revoke execute on function public.create_assignment(text, text, uuid, uuid[], date, time, time, jsonb, uuid, uuid, text, date) from public, anon;
grant  execute on function public.create_assignment(text, text, uuid, uuid[], date, time, time, jsonb, uuid, uuid, text, date) to authenticated, service_role;

-- The old single-assignee signature, for the portal build still on main.
-- Dropped in the contract migration once that build is gone.
create or replace function public.create_assignment(
  p_title_en text, p_title_ar text, p_site_id uuid, p_assignee_id uuid,
  p_scheduled_date date, p_window_start time, p_window_end time,
  p_items jsonb, p_source_template_id uuid default null, p_client_id uuid default null,
  p_task_note text default null
) returns uuid language sql security definer set search_path to 'public' as $$
  select public.create_assignment(p_title_en, p_title_ar, p_site_id, array[p_assignee_id],
    p_scheduled_date, p_window_start, p_window_end, p_items, p_source_template_id,
    p_client_id, p_task_note, null::date);
$$;

-- ---------------------------------------------------------------------
-- schedule_rounds: a cell holds several people
-- ---------------------------------------------------------------------
create or replace function public.schedule_rounds(p_plan jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_cell jsonb; v_rt uuid; v_date date; v_ids uuid[]; v_name text;
  v_round uuid; v_place record; v_new uuid; v_n int;
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_created int := 0; v_moved int := 0; v_removed int := 0; v_kept int := 0; v_skipped int := 0;
begin
  if coalesce(public.current_role(), 'none') not in ('admin', 'manager') then
    raise exception 'Only admins/managers can schedule rounds';
  end if;
  if jsonb_typeof(p_plan) is distinct from 'array' then
    raise exception 'INVALID_PLAN';
  end if;

  for v_cell in select value from jsonb_array_elements(p_plan)
  loop
    v_rt   := nullif(v_cell ->> 'round_template_id', '')::uuid;
    v_date := nullif(v_cell ->> 'date', '')::date;
    -- assignee_ids from this portal; assignee_id from the build on main.
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

    if exists (select 1 from unnest(v_ids) as u(x)
                where not exists (select 1 from public.profiles p
                                   where p.id = u.x and p.active and p.role in ('cleaner', 'inspector'))) then
      raise exception 'INVALID_ASSIGNEE';
    end if;
    v_name := case when cardinality(v_ids) = 1
                   then (select name from public.profiles where id = v_ids[1]) end;

    insert into public.rounds (round_template_id, scheduled_date, assignee_id, assignee_ids, created_by)
    values (v_rt, v_date, v_ids[1], v_ids, auth.uid())
    on conflict (round_template_id, scheduled_date)
      do update set assignee_id = excluded.assignee_id, assignee_ids = excluded.assignee_ids
    returning id into v_round;

    -- Untouched tasks follow the cell. A claimed task has an answer or a
    -- photo, so it is never untouched and keeps its owner.
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
      select t.id, t.title_en, t.title_ar, t.site_id, t.items,
             nullif(e.p ->> 'window_start', '')::time as ws,
             nullif(e.p ->> 'window_end', '')::time   as we
        from public.round_templates rt
       cross join lateral jsonb_array_elements(rt.places) with ordinality as e(p, ord)
        join public.templates t on t.id::text = e.p ->> 'template_id'
       where rt.id = v_rt
         and not exists (select 1 from public.submissions s
                          where s.round_id = v_round and s.source_template_id = t.id)
       order by e.ord
    loop
      if v_place.site_id is null or v_place.ws is null or v_place.we is null
         or (case when jsonb_typeof(v_place.items) = 'array'
                  then jsonb_array_length(v_place.items) else 0 end) = 0 then
        v_skipped := v_skipped + 1;   -- a place with no site, window or checklist
        continue;
      end if;

      -- Item ids are kept, so assignment_items.template_item_id links back.
      v_new := public.create_assignment(
        v_place.title_en, v_place.title_ar, v_place.site_id, v_ids,
        v_date, v_place.ws, v_place.we, v_place.items, v_place.id, null::uuid);
      update public.submissions set round_id = v_round where id = v_new;
      v_created := v_created + 1;
    end loop;
  end loop;

  return jsonb_build_object('created', v_created, 'moved', v_moved, 'removed', v_removed,
                            'kept', v_kept, 'skipped', v_skipped);
end $$;

-- ---------------------------------------------------------------------
-- RLS: assignees see their tasks; managers see tasks given to their reports
-- ---------------------------------------------------------------------
drop policy submissions_select on public.submissions;
create policy submissions_select on public.submissions for select to authenticated using (
  inspector_id = auth.uid()
  or auth.uid() = any (assignee_ids)
  or public.current_role() = 'admin'
  or (public.current_role() = 'manager'
      and (inspector_id in (select p.id from public.profiles p where p.manager_id = auth.uid())
           or assignee_ids && array(select p.id from public.profiles p where p.manager_id = auth.uid())))
);

drop policy assignment_items_select on public.assignment_items;
create policy assignment_items_select on public.assignment_items for select to authenticated using (
  exists (select 1 from public.submissions s
           where s.id = assignment_items.assignment_id
             and (s.inspector_id = auth.uid()
                  or auth.uid() = any (s.assignee_ids)
                  or public.current_role() = 'admin'
                  or (public.current_role() in ('manager', 'inspector')
                      and (s.inspector_id in (select p.id from public.profiles p where p.manager_id = auth.uid())
                           or s.assignee_ids && array(select p.id from public.profiles p where p.manager_id = auth.uid())))))
);

drop policy rounds_select on public.rounds;
create policy rounds_select on public.rounds for select to authenticated using (
  coalesce(public.current_role(), 'none') in ('admin', 'manager', 'inspector')
  or exists (select 1 from public.submissions s
              where s.round_id = rounds.id
                and (s.inspector_id = auth.uid() or auth.uid() = any (s.assignee_ids)))
);

-- ---------------------------------------------------------------------
-- Status history
-- ---------------------------------------------------------------------
create table if not exists public.submission_events (
  id            bigint generated always as identity primary key,
  submission_id uuid not null references public.submissions (id) on delete cascade,
  event         text not null check (event in ('created', 'claimed', 'reassigned', 'started', 'submitted',
                                               'follow_up', 'sent_back', 'approved', 'extended')),
  actor_id      uuid,
  at            timestamptz not null default now(),
  note          text
);
create index if not exists submission_events_submission_idx on public.submission_events (submission_id, at);

alter table public.submission_events enable row level security;
revoke all on public.submission_events from anon, authenticated;
grant select on public.submission_events to authenticated;
drop policy if exists submission_events_select on public.submission_events;
-- Whoever can see the task (submissions_select) can see its history.
create policy submission_events_select on public.submission_events for select to authenticated using (
  exists (select 1 from public.submissions s where s.id = submission_events.submission_id)
);

create or replace function private.log_submission_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- History must never block the change it records: a failure here is a
  -- warning in the log, never a rolled-back submit or planner save.
  begin
    if tg_op = 'INSERT' then
      insert into public.submission_events (submission_id, event, actor_id, at)
      values (new.id, 'created', coalesce(auth.uid(), new.created_by), coalesce(new.created_at, now()));
      return null;
    end if;

    if old.inspector_id is null and new.inspector_id is not null then
      insert into public.submission_events (submission_id, event, actor_id) values (new.id, 'claimed', new.inspector_id);
    elsif new.assignee_ids is distinct from old.assignee_ids then
      insert into public.submission_events (submission_id, event, actor_id) values (new.id, 'reassigned', auth.uid());
    end if;

    if old.status = 'pending' and new.status = 'in_progress' then
      insert into public.submission_events (submission_id, event, actor_id) values (new.id, 'started', auth.uid());
    end if;

    if new.status = 'in_progress' and new.reviewed_at is distinct from old.reviewed_at then
      insert into public.submission_events (submission_id, event, actor_id, note)
      values (new.id, 'sent_back', auth.uid(), new.review_note);
    end if;

    if new.status in ('submitted', 'follow_up', 'approved') and new.status is distinct from old.status then
      insert into public.submission_events (submission_id, event, actor_id, note)
      values (new.id, new.status, auth.uid(),
              case when new.status in ('submitted', 'follow_up') then new.submit_note end);
    end if;

    if new.extended_until is not null and new.extended_until is distinct from old.extended_until then
      insert into public.submission_events (submission_id, event, actor_id, note)
      values (new.id, 'extended', auth.uid(), new.extension_note);
    end if;
  exception when others then
    raise warning 'submission_events: % (%)', sqlerrm, sqlstate;
  end;
  return null;
end $$;
revoke all on function private.log_submission_event() from public;

drop trigger if exists submissions_log_event on public.submissions;
create trigger submissions_log_event
  after insert or update on public.submissions
  for each row execute function private.log_submission_event();

-- Backfill from what the rows still remember. Anything in between (a
-- send-back later resubmitted) was overwritten and is gone.
insert into public.submission_events (submission_id, event, actor_id, at)
select id, 'created', created_by, created_at from public.submissions s
 where not exists (select 1 from public.submission_events e where e.submission_id = s.id);
insert into public.submission_events (submission_id, event, actor_id, at, note)
select id, case when status = 'follow_up' then 'follow_up' else 'submitted' end, inspector_id, submitted_at, submit_note
  from public.submissions where submitted_at is not null;
insert into public.submission_events (submission_id, event, actor_id, at, note)
select id, case when status = 'approved' then 'approved' else 'sent_back' end, reviewed_by, reviewed_at, review_note
  from public.submissions where reviewed_at is not null;
insert into public.submission_events (submission_id, event, actor_id, at, note)
select id, 'extended', extended_by, coalesce(extended_at, extended_until), extension_note
  from public.submissions where extended_until is not null;

-- ---------------------------------------------------------------------
-- assignments_v: deadline to the end day; assignees at the end
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
    -- In assignee order. Names follow profiles' RLS, so a cleaner sees only
    -- their own; the portal's roles see everyone's.
    ARRAY(SELECT p.name FROM unnest(a.assignee_ids) WITH ORDINALITY u(id, n)
            JOIN profiles p ON p.id = u.id ORDER BY u.n) AS assignee_names
   FROM submissions a
     LEFT JOIN rounds r ON r.id = a.round_id
     LEFT JOIN round_templates rt ON rt.id = r.round_template_id;

do $$
begin
  if (select reloptions from pg_class where oid = 'public.assignments_v'::regclass)
     is distinct from array['security_invoker=on'] then
    raise exception 'assignments_v lost security_invoker';
  end if;
end $$;

commit;

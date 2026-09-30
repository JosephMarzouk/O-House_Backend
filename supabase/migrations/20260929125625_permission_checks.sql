-- =====================================================================
-- Custom roles, part B: every role check becomes a permission + scope check
--
-- 20260929125516_custom_roles.sql seeded the catalog and four default roles
-- that match today. This moves the functions and policies that tested
-- current_role() onto has_permission() and the caller's scope, so a custom
-- role works everywhere a default one does.
--
-- Parity: the four default roles read exactly what they read before (dry
-- run, 29 Sep: all 15 profiles plus a stranger, 13 reads each, no row
-- changed). By design, assignment_items now follow their checklist, so an
-- inspector with direct reports would no longer see those reports' ITEMS.
-- The portal never showed them (their checklists were already invisible
-- to inspectors), and no inspector has reports today.
--
-- Deliberate tightenings:
--   * approve / reject / extend also need the checklist in the caller's
--     scope. Before, any inspector could act on any id.
--   * create_assignment's assignees must be active and hold staff_app.view
--     (before: any profile). For the defaults that is inspectors and
--     cleaners, which is all the portal offered.
--   * set_user_department / set_user_manager need can_manage_user: a
--     Manager changes Inspectors and Cleaners only, an Admin every
--     non-Admin, nobody themselves.
--   * has_permission() is false for active = false, so a deactivated
--     account loses every permission (it keeps seeing its own work).
--   * The rewritten policies are `to authenticated` (several were
--     `to public`). anon saw nothing through them before, except a
--     template with no department; it now sees none.
--
-- Not touched: the legacy follow-up objects (actions, action_events,
-- template_claims, can_act_on_action, set_action_status, resolve_action,
-- reopen_action, template_claims_release). No current client uses them, and
-- they keep reading the profiles.role mirror through current_role() until
-- flag day. submission_events_select already follows submissions' policy.
--
-- Every function keeps its signature (CREATE OR REPLACE, no overload, grants
-- kept). reject_items keeps 20260929123420's REASON_REQUIRED.
-- set_club_location stays Admin-role only (not a grantable permission).
--
-- Refusals raise 'FORBIDDEN: permission denied (...)': the new portal
-- matches FORBIDDEN, and the production portal on main maps "permission
-- denied" to not_authorized (lib/actions/result.ts toErrorCode).
-- =====================================================================

begin;

-- Policies call the scope helpers as the querying user. The private schema
-- isn't exposed through the Data API, so this only lets policies reach
-- the functions granted below.
grant usage on schema private to authenticated;
grant execute on function private.my_role(), private.can_see_user(uuid), private.can_see_staff(uuid),
  private.can_see_department(uuid), private.can_see_submission(uuid, uuid[], uuid, uuid)
  to authenticated;

-- ---------------------------------------------------------------------
-- 1. Guards the functions share
-- ---------------------------------------------------------------------
create function private.require(p_key text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if public.has_permission(p_key) is not true then
    raise exception 'FORBIDDEN: permission denied (%)', p_key;
  end if;
end $$;

-- A checklist outside the caller's scope is refused. A missing id passes:
-- the caller's update then touches nothing, as before.
create function private.require_in_scope(p_assignment_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from public.submissions s
              where s.id = p_assignment_id
                and not private.can_see_submission(s.inspector_id, s.assignee_ids,
                                                   s.template_id, s.source_template_id)) then
    raise exception 'FORBIDDEN: permission denied (scope)';
  end if;
end $$;

-- Who can be given work: an active profile holding staff_app.view and, for
-- a caller scoped to departments, in one of them.
create function private.check_assignees(p_ids uuid[])
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1
               from unnest(p_ids) u(id)
               left join public.profiles p on p.id = u.id
              where u.id is not null
                and (not private.user_has_permission(u.id, 'staff_app.view')
                     or ((private.my_role()).scope = 'departments'
                         and not private.can_see_department(p.department_id)))) then
    raise exception 'INVALID_ASSIGNEE';
  end if;
end $$;

revoke all on function private.require(text), private.require_in_scope(uuid),
  private.check_assignees(uuid[]) from public;

-- ---------------------------------------------------------------------
-- 2. Functions (bodies are the live definitions, read 29 Sep; only the
--    guards change)
-- ---------------------------------------------------------------------

create or replace function public.admin_staff_list()
 returns table(id uuid, name text, email text, phone text, role text, department_id uuid,
               manager_id uuid, active boolean, must_change_password boolean)
 language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_phones boolean := public.has_permission('phones.view');
begin
  perform private.require('users.view');

  return query
    select p.id, p.name, p.email,
           case when v_phones then p.phone end,
           p.role, p.department_id, p.manager_id, p.active, p.must_change_password
      from public.profiles p
     where private.can_see_staff(p.id)
     order by p.role, p.name;
end;
$function$;

create or replace function public.approve_assignment(p_assignment_id uuid, p_score integer default null)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
begin
  perform private.require('review.edit');
  perform private.require_in_scope(p_assignment_id);

  -- Nobody signs off their own work (0011), except the Admin role.
  if (private.my_role()).key is distinct from 'admin'
     and exists (
       select 1 from public.submissions
        where id = p_assignment_id and inspector_id = auth.uid()
     ) then
    raise exception 'You cannot approve an assignment you carried out';
  end if;

  update public.submissions
     set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(),
         score = coalesce(p_score, score)
   where id = p_assignment_id and status = 'submitted';
end;
$function$;

create or replace function public.reject_items(p_assignment_id uuid, p_item_ids uuid[], p_reason text default null)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_reason text := nullif(btrim(p_reason), '');
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

  update public.assignment_items
     set status = 'rejected', reject_note = v_reason, done_at = null
   where assignment_id = p_assignment_id and id = any(p_item_ids);

  update public.submissions
     set status = 'in_progress', review_note = v_reason,
         reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_assignment_id;
end;
$function$;

create or replace function public.extend_assignment(p_assignment_id uuid, p_new_deadline timestamp with time zone,
                                                    p_note text default null)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
begin
  perform private.require('checklists.edit');
  perform private.require_in_scope(p_assignment_id);
  if p_new_deadline <= now() then
    raise exception 'New deadline must be in the future';
  end if;

  update public.submissions
     set extended_until = p_new_deadline,
         extended_by    = auth.uid(),
         extended_at    = now(),
         extension_note = p_note
   where id = p_assignment_id
     and status not in ('submitted', 'approved', 'follow_up');   -- 0013: follow_up never expires
end;
$function$;

-- create_assignment's body moves to private.create_assignment, unchanged
-- but for the role check, so schedule_rounds (planner.create) can create
-- its checklists without also needing checklists.create. The public
-- function is the guard. The 11-argument overload calls the public one and
-- is untouched.
create function private.create_assignment(p_title_en text, p_title_ar text, p_site_id uuid, p_assignee_ids uuid[],
  p_scheduled_date date, p_window_start time without time zone, p_window_end time without time zone,
  p_items jsonb, p_source_template_id uuid default null, p_client_id uuid default null,
  p_task_note text default null, p_end_date date default null)
 returns uuid language plpgsql security definer set search_path = ''
as $function$
declare
  v_id uuid; v_site_ar text; v_site_en text; v_owner uuid; v_owner_name text;
  v_ids uuid[]; v_item jsonb; v_i int := 0;
begin
  if p_client_id is not null then
    select id into v_id from public.submissions where client_id = p_client_id;
    if v_id is not null then return v_id; end if;
  end if;

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
end $function$;
revoke all on function private.create_assignment(text, text, uuid, uuid[], date, time without time zone,
  time without time zone, jsonb, uuid, uuid, text, date) from public;

create or replace function public.create_assignment(p_title_en text, p_title_ar text, p_site_id uuid, p_assignee_ids uuid[],
  p_scheduled_date date, p_window_start time without time zone, p_window_end time without time zone,
  p_items jsonb, p_source_template_id uuid default null, p_client_id uuid default null,
  p_task_note text default null, p_end_date date default null)
 returns uuid language plpgsql security definer set search_path to 'public'
as $function$
begin
  perform private.require('checklists.create');
  perform private.check_assignees(p_assignee_ids);
  return private.create_assignment(p_title_en, p_title_ar, p_site_id, p_assignee_ids,
    p_scheduled_date, p_window_start, p_window_end, p_items, p_source_template_id,
    p_client_id, p_task_note, p_end_date);
end $function$;

create or replace function public.schedule_rounds(p_plan jsonb)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
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
        v_skipped := v_skipped + 1;
        continue;
      end if;

      v_new := private.create_assignment(
        v_place.title_en, v_place.title_ar, v_place.site_id, v_ids,
        v_date, v_place.ws, v_place.we, v_place.items, v_place.id, null::uuid);
      update public.submissions set round_id = v_round where id = v_new;
      v_created := v_created + 1;
    end loop;
  end loop;

  return jsonb_build_object('created', v_created, 'moved', v_moved, 'removed', v_removed,
                            'kept', v_kept, 'skipped', v_skipped);
end $function$;

create or replace function public.set_club_page(p_key text, p_body_en text, p_body_ar text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require('club_settings.edit');
  update public.club_pages
     set body_en = coalesce(btrim(p_body_en), ''),
         body_ar = coalesce(btrim(p_body_ar), ''),
         updated_at = now(),
         updated_by = auth.uid()
   where key = p_key;
  if not found then raise exception 'Unknown page %', p_key; end if;
end $$;

-- The Admin ROLE, not a permission: only admins set the location, once.
create or replace function public.set_club_location(p_lat numeric, p_lng numeric, p_radius_m integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if (private.my_role()).key is distinct from 'admin' then
    raise exception 'Only admins can set the club location';
  end if;
  -- on conflict, not an exists() check: two admins saving at once still get one row
  insert into public.club_location (lat, lng, radius_m, set_by)
  values (p_lat, p_lng, p_radius_m, auth.uid())
  on conflict (id) do nothing;
  if not found then raise exception 'LOCATION_ALREADY_SET'; end if;
end $$;

create or replace function public.set_user_department(target_user_id uuid, new_department_id uuid)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
begin
  -- A caller scoped to departments may only move people into their own.
  if (public.can_manage_user(target_user_id)
      and private.can_see_department(new_department_id)) is not true then
    raise exception 'FORBIDDEN: permission denied (users.edit)';
  end if;
  update public.profiles set department_id = new_department_id where id = target_user_id;
end;
$function$;

create or replace function public.set_user_manager(target_user_id uuid, new_manager_id uuid)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
begin
  if public.can_manage_user(target_user_id) is not true then
    raise exception 'FORBIDDEN: permission denied (users.edit)';
  end if;
  if new_manager_id = target_user_id then
    raise exception 'A user cannot be their own manager';
  end if;
  update public.profiles set manager_id = new_manager_id where id = target_user_id;
end;
$function$;

-- ---------------------------------------------------------------------
-- 3. Policies. `(select public.has_permission(...))` so Postgres runs it once
--    per query, not once per row.
-- ---------------------------------------------------------------------

-- Checklists: own work, or checklists.view within scope.
drop policy submissions_select on public.submissions;
create policy submissions_select on public.submissions for select to authenticated using (
  inspector_id = (select auth.uid())
  or (select auth.uid()) = any (assignee_ids)
  or ((select public.has_permission('checklists.view'))
      and ((select (private.my_role()).scope) = 'all'
           or private.can_see_submission(inspector_id, assignee_ids, template_id, source_template_id))));

drop policy submissions_delete on public.submissions;
create policy submissions_delete on public.submissions for delete to authenticated using (
  (select public.has_permission('checklists.delete'))
  and private.can_see_submission(inspector_id, assignee_ids, template_id, source_template_id));

-- Items follow their checklist (submission_events already do).
drop policy assignment_items_select on public.assignment_items;
create policy assignment_items_select on public.assignment_items for select to authenticated using (
  exists (select 1 from public.submissions s where s.id = assignment_items.assignment_id));

drop policy sync_refusals_select on public.sync_refusals;
create policy sync_refusals_select on public.sync_refusals for select to authenticated using (
  user_id = (select auth.uid())
  or ((select public.has_permission('checklists.view')) and private.can_see_user(user_id)));

drop policy rounds_select on public.rounds;
create policy rounds_select on public.rounds for select to authenticated using (
  (select public.has_permission('planner.view'))
  or exists (select 1 from public.submissions s
              where s.round_id = rounds.id
                and (s.inspector_id = (select auth.uid()) or (select auth.uid()) = any (s.assignee_ids))));

-- Places: templates with no department, your own department's, and the
-- departments in your scope ('all' and 'team' reach every one); places.edit
-- sees them all.
drop policy templates_select on public.templates;
create policy templates_select on public.templates for select to authenticated using (
  department_id is null
  or department_id = (select public.current_department_id())
  or (select public.has_permission('places.edit'))
  or private.can_see_department(department_id));

-- Staff: yourself, or users.view over your staff list.
drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (
  id = (select auth.uid())
  or ((select public.has_permission('users.view')) and private.can_see_staff(id)));

-- Writes, one policy per command (the old FOR ALL policies also ORed into
-- SELECT; every row they showed is still shown by the *_select policies).
drop policy departments_write on public.departments;
create policy departments_insert on public.departments for insert to authenticated
  with check ((select public.has_permission('departments.create')));
create policy departments_update on public.departments for update to authenticated
  using ((select public.has_permission('departments.edit')))
  with check ((select public.has_permission('departments.edit')));
create policy departments_delete on public.departments for delete to authenticated
  using ((select public.has_permission('departments.delete')));

drop policy sites_write on public.sites;
create policy sites_insert on public.sites for insert to authenticated
  with check ((select public.has_permission('places.create')));
create policy sites_update on public.sites for update to authenticated
  using ((select public.has_permission('places.edit')))
  with check ((select public.has_permission('places.edit')));
create policy sites_delete on public.sites for delete to authenticated
  using ((select public.has_permission('places.delete')));

drop policy templates_write on public.templates;
create policy templates_insert on public.templates for insert to authenticated
  with check ((select public.has_permission('places.create')));
create policy templates_update on public.templates for update to authenticated
  using ((select public.has_permission('places.edit')))
  with check ((select public.has_permission('places.edit')));
create policy templates_delete on public.templates for delete to authenticated
  using ((select public.has_permission('places.delete')));

drop policy round_templates_write on public.round_templates;
create policy round_templates_insert on public.round_templates for insert to authenticated
  with check ((select public.has_permission('planner.create')));
create policy round_templates_update on public.round_templates for update to authenticated
  using ((select public.has_permission('planner.edit')))
  with check ((select public.has_permission('planner.edit')));
create policy round_templates_delete on public.round_templates for delete to authenticated
  using ((select public.has_permission('planner.delete')));

commit;

-- ---------------------------------------------------------------------
-- Verification (read-only). Expect only the legacy follow-up objects:
-- ---------------------------------------------------------------------
-- select p.proname from pg_proc p
--  where p.pronamespace = 'public'::regnamespace and pg_get_functiondef(p.oid) ~ 'current_role\(\)'
--    and p.proname <> 'current_role';
--   -> can_act_on_action, set_action_status (resolve_action / reopen_action go through can_act_on_action)
-- select tablename, policyname from pg_policies
--  where schemaname = 'public' and (qual ~ 'current_role' or with_check ~ 'current_role');
--   -> action_events, actions (3), template_claims_release

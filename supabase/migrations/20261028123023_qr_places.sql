-- =====================================================================
-- QR-locked places on multi-place tasks (plan "QR-locked places", 28 Oct)
--
-- A zone round is already one checklist (submissions row) per place, tied
-- by round_id. A one-off multi-place task is now the same shape, tied by
-- task_group_id. A printed QR per place (templates.qr_code) unlocks that
-- place's checklist in the app; the server only LOGS scans (place_scans),
-- it never refuses an answer or a submit (Q10: enforcement is app-only).
--
-- Expand only. Everything new defaults to off:
--   * templates.qr_required false, submissions.qr_required false: a
--     checklist locks only if its place had the switch on when the
--     checklist was MADE (create_assignment copies it), so nothing handed
--     out locks mid-day.
--   * Old RPC signatures are unchanged; create_assignment keeps its
--     signature (create or replace, no second copy for PostgREST).
--   * assignments_v keeps every column in place; the new ones are at the end.
--
-- New RPCs: record_place_scan (the phone, through the API), unlock_place,
-- replace_place_qr, create_task_group (the portal). Permission
-- assignments.unlock_place, Admin only by default.
--
-- Re-runnable: if not exists / create or replace / on conflict throughout.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- Places: the switch and the code printed on the sticker
-- ---------------------------------------------------------------------
-- 16 random bytes: unguessable, so a sticker can't be forged from another.
-- The volatile default gives every existing place its own code.
alter table public.templates
  add column if not exists qr_required boolean not null default false,
  add column if not exists qr_code text not null default encode(extensions.gen_random_bytes(16), 'hex');
create unique index if not exists templates_qr_code_key on public.templates (qr_code);

-- ---------------------------------------------------------------------
-- One-off multi-place tasks (a zone round's "rounds" row, for the New task form)
-- ---------------------------------------------------------------------
create table if not exists public.task_groups (
  id         uuid primary key default gen_random_uuid(),
  title_en   text not null,
  title_ar   text,
  created_by uuid references public.profiles (id),
  created_at timestamptz default now()
);

alter table public.submissions
  add column if not exists qr_required boolean not null default false,
  add column if not exists task_group_id uuid references public.task_groups (id);
create index if not exists submissions_task_group_idx on public.submissions (task_group_id)
  where task_group_id is not null;

-- Readable by whoever can see one of its checklists (submissions' own RLS
-- runs inside the exists, as rounds_select does). Written only by
-- create_task_group.
alter table public.task_groups enable row level security;
revoke all on public.task_groups from anon, authenticated;
grant select on public.task_groups to authenticated;
drop policy if exists task_groups_select on public.task_groups;
create policy task_groups_select on public.task_groups for select to authenticated using (
  exists (select 1 from public.submissions s where s.task_group_id = task_groups.id)
);

-- ---------------------------------------------------------------------
-- The scan log
-- ---------------------------------------------------------------------
--   scan      the right code, scanned on the phone (scanned_at = phone time)
--   bad_code  a code that isn't this place's (an old sticker, another place)
--   unlock    a supervisor opened the place on the portal (scanned_at = now())
-- client_id is the phone's scanId: a replayed upload is recorded once.
create table if not exists public.place_scans (
  id            uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.submissions (id) on delete cascade,
  user_id       uuid not null references public.profiles (id),
  kind          text not null check (kind in ('scan', 'bad_code', 'unlock')),
  scanned_at    timestamptz not null,
  received_at   timestamptz not null default now(),
  client_id     uuid unique
);
create index if not exists place_scans_assignment_idx on public.place_scans (assignment_id, received_at);

-- Same reach as the checklist (assignment_items_select's shape): the
-- submissions policy, with its scope helpers, decides. No direct writes.
alter table public.place_scans enable row level security;
revoke all on public.place_scans from anon, authenticated;
grant select on public.place_scans to authenticated;
drop policy if exists place_scans_select on public.place_scans;
create policy place_scans_select on public.place_scans for select to authenticated using (
  exists (select 1 from public.submissions s where s.id = place_scans.assignment_id)
);

-- ---------------------------------------------------------------------
-- Permission: unlock a place without its QR (a lost or damaged sticker)
-- ---------------------------------------------------------------------
-- The catalog's actions were view/create/edit/delete; the key the portal
-- gates on is assignments.unlock_place, and key = module || '.' || action.
alter table public.permissions drop constraint if exists permissions_action_check;
alter table public.permissions add constraint permissions_action_check
  check (action in ('view', 'create', 'edit', 'delete', 'unlock_place'));

insert into public.permissions (key, section, module, action, label_en, label_ar, sort) values
  ('assignments.unlock_place', 'checklists', 'assignments', 'unlock_place',
   'Unlock a place without scanning its QR', 'فتح مكان دون مسح رمز QR', 75)
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, 'assignments.unlock_place' from public.roles r where r.key = 'admin'
on conflict do nothing;

-- ---------------------------------------------------------------------
-- create_assignment: copies the place's switch onto the new checklist.
-- Body as live (28 Oct) plus qr_required; same signature.
-- ---------------------------------------------------------------------
create or replace function private.create_assignment(p_title_en text, p_title_ar text, p_site_id uuid, p_assignee_ids uuid[], p_scheduled_date date, p_window_start time without time zone, p_window_end time without time zone, p_items jsonb, p_source_template_id uuid DEFAULT NULL::uuid, p_client_id uuid DEFAULT NULL::uuid, p_task_note text DEFAULT NULL::text, p_end_date date DEFAULT NULL::date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    task_note, qr_required
  ) values (
    p_source_template_id, p_title_ar, p_title_en,
    p_site_id, v_site_ar, v_site_en,
    v_owner, v_owner_name, v_ids,
    p_title_en, p_title_ar, p_source_template_id,
    p_scheduled_date, nullif(p_end_date, p_scheduled_date), p_window_start, p_window_end,
    'pending', auth.uid(), p_client_id, null, '[]'::jsonb,
    nullif(btrim(p_task_note), ''),
    -- Fixed at creation (QE/Q2): turning the switch on later never locks
    -- a checklist someone already has.
    coalesce((select t.qr_required from public.templates t where t.id = p_source_template_id), false)
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

-- ---------------------------------------------------------------------
-- The phone's check value: sha256 of the place's code, never the code.
-- ---------------------------------------------------------------------
-- Security definer so a cleaner gets the hash of a place in another
-- department too (templates_select would hide that row from them, and the
-- checklist would stay locked for good). A hash can't be turned back into
-- a printable code, so handing it to any signed-in user gives nothing away.
create or replace function private.place_qr_hash(p_template_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select encode(extensions.digest(t.qr_code, 'sha256'), 'hex')
    from public.templates t where t.id = p_template_id
$$;
revoke all on function private.place_qr_hash(uuid) from public;
grant execute on function private.place_qr_hash(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- record_place_scan: the phone's scan, sent by the API as the user
-- ---------------------------------------------------------------------
-- Returns 'scan' or 'bad_code'. Never refuses for a bad code (Q10): it is
-- logged for the supervisor. A good code claims this checklist and every
-- unclaimed open one of the same task for the scanner (QC); this one
-- already owned by someone else raises claim_assignment's ASSIGNMENT_TAKEN
-- (the API's refusal list maps it), and nothing is logged.
create or replace function public.record_place_scan(
  p_assignment_id uuid, p_code text, p_scanned_at timestamptz, p_client_id uuid
) returns text language plpgsql security definer set search_path = '' as $$
declare
  v_me    uuid := auth.uid();
  v_sub   record;
  v_kind  text;
  v_group uuid;
begin
  if v_me is null then raise exception 'Not authorized'; end if;

  -- A replay (the reply was lost): the first answer, nothing redone.
  if p_client_id is not null then
    select ps.kind into v_kind from public.place_scans ps
     where ps.client_id = p_client_id and ps.user_id = v_me;
    if v_kind is not null then return v_kind; end if;
  end if;

  select s.id, s.inspector_id, s.assignee_ids, s.source_template_id,
         coalesce(s.round_id, s.task_group_id) as group_id
    into v_sub
    from public.submissions s where s.id = p_assignment_id;
  if not found then raise exception 'Assignment not found'; end if;
  if not coalesce(v_me = any (v_sub.assignee_ids) or v_me = v_sub.inspector_id, false) then
    raise exception 'Not authorized';
  end if;

  v_kind := case when exists (select 1 from public.templates t
                               where t.id = v_sub.source_template_id and t.qr_code = p_code)
                 then 'scan' else 'bad_code' end;

  if v_kind = 'scan' then
    if v_sub.inspector_id is distinct from v_me then
      perform private.claim_assignment(p_assignment_id); -- raises ASSIGNMENT_TAKEN
    end if;
    -- The rest of the task, as claim_assignment would claim each (one
    -- statement, so a sibling someone else just took is skipped, not an error).
    v_group := v_sub.group_id;
    if v_group is not null then
      update public.submissions s
         set inspector_id   = v_me,
             inspector_name = (select p.name from public.profiles p where p.id = v_me)
       where coalesce(s.round_id, s.task_group_id) = v_group
         and s.id <> p_assignment_id
         and s.inspector_id is null
         and v_me = any (s.assignee_ids)
         and s.status not in ('submitted', 'approved', 'rejected');
    end if;
  end if;

  insert into public.place_scans (assignment_id, user_id, kind, scanned_at, client_id)
  values (p_assignment_id, v_me, v_kind, coalesce(p_scanned_at, now()), p_client_id)
  on conflict (client_id) do nothing;
  if not found then
    -- Raced by its own replay: that one's answer. Someone else's id: refused.
    select ps.kind into v_kind from public.place_scans ps
     where ps.client_id = p_client_id and ps.user_id = v_me;
    if v_kind is null then raise exception 'Not authorized'; end if;
  end if;
  return v_kind;
end $$;
revoke all on function public.record_place_scan(uuid, text, timestamptz, uuid) from public, anon;
grant execute on function public.record_place_scan(uuid, text, timestamptz, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- unlock_place: a supervisor opens a place whose sticker is lost (Q6/QJ)
-- ---------------------------------------------------------------------
-- The reviewer's checks (reject_items): the permission, then the scope.
create or replace function public.unlock_place(p_assignment_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require('assignments.unlock_place');
  perform private.require_in_scope(p_assignment_id);
  if not exists (select 1 from public.submissions where id = p_assignment_id) then
    raise exception 'Assignment not found';
  end if;
  insert into public.place_scans (assignment_id, user_id, kind, scanned_at)
  values (p_assignment_id, auth.uid(), 'unlock', now());
end $$;
revoke all on function public.unlock_place(uuid) from public, anon;
grant execute on function public.unlock_place(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- replace_place_qr: a new code; the old sticker stops working at once (QH)
-- ---------------------------------------------------------------------
create or replace function public.replace_place_qr(p_template_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require('places.edit');
  update public.templates
     set qr_code = encode(extensions.gen_random_bytes(16), 'hex')
   where id = p_template_id;
  if not found then raise exception 'Place not found'; end if;
end $$;
revoke all on function public.replace_place_qr(uuid) from public, anon;
grant execute on function public.replace_place_qr(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- create_task_group: the New task form with several places (QD)
-- ---------------------------------------------------------------------
-- p_places: [{"template_id", "window_start", "window_end"}] in walk order,
-- windows "HH:MM" or null. One checklist per place with that place's own
-- title and items, as schedule_rounds does for a zone round, all sharing
-- the new task_group_id. One transaction, so the E1 trigger's rows share a
-- txid and the push worker sends one push for the task.
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
    update public.submissions set task_group_id = v_group where id = v_new;
    v_n := v_n + 1;
  end loop;

  if v_n <> jsonb_array_length(p_places) then raise exception 'Place not found'; end if;
  return v_group;
end $$;
revoke all on function public.create_task_group(text, text, jsonb, uuid[], date, date, text) from public, anon;
grant execute on function public.create_task_group(text, text, jsonb, uuid[], date, date, text) to authenticated;

-- ---------------------------------------------------------------------
-- assignments_v: as live (28 Oct), new columns at the end
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
          WHERE ps.assignment_id = a.id AND (ps.kind = ANY (ARRAY['scan'::text, 'unlock'::text])))) AS unlocked
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

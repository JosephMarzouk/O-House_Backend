-- =====================================================================
-- Push notifications (plan Step 5, PRD §12), expand only
--
--   * notifications — the queue and its history (PN-3). Database events and
--     the API's every-minute enqueue_due_notifications() insert rows; the
--     API worker claims them every 5 s (claim_notifications), renders the
--     text in the recipient's language, sends through FCM and writes the
--     outcome back with the title and body it sent.
--   * Only the first-release events are enqueued (PN-5): E1 new round,
--     E3 due soon, E4 overdue, E5 sent back, E8 follow-up raised. E2, E6,
--     E7 and E9 join later as more branches here; E10 never touches the
--     server (the phone shows it).
--   * device_tokens already exists (app 0001); this adds the two functions
--     the API calls as the user (PN-1) and an index on user_id.
--
-- A push can never roll back a submit or a planner save: the trigger's body
-- is wrapped like log_submission_event's, a failure is a warning.
--
-- Dedupe keys always include the recipient. E1 carries the transaction id
-- so one planner save is one summary per person (the worker groups by it)
-- and reassigning someone back still notifies them. E3/E4 carry the
-- deadline, so an extension re-arms them.
-- =====================================================================

begin;

create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------
-- The queue
-- ---------------------------------------------------------------------
create table if not exists public.notifications (
  id            bigint generated always as identity primary key,
  recipient_id  uuid not null references public.profiles (id) on delete cascade,
  event         text not null check (event in ('E1', 'E3', 'E4', 'E5', 'E8')),
  assignment_id uuid references public.submissions (id) on delete cascade,
  params        jsonb not null default '{}',
  dedupe_key    text not null unique,
  status        text not null default 'queued'
                check (status in ('queued', 'claimed', 'sent', 'failed', 'skipped')),
  attempts      int not null default 0,
  available_at  timestamptz not null default now(),
  claimed_at    timestamptz,
  sent_at       timestamptz,
  title         text,
  body          text,
  last_error    text,
  created_at    timestamptz not null default now()
);
create index if not exists notifications_due_idx on public.notifications (available_at)
  where status in ('queued', 'claimed');
create index if not exists notifications_recipient_idx on public.notifications (recipient_id, created_at);

-- No client reads or writes it: only the API's secret key (service_role).
alter table public.notifications enable row level security;
revoke all on public.notifications from anon, authenticated;

-- Made by the app's 0001; restated in case the live database lost it (a
-- legacy schema.sql re-run once undid other work). A no-op when it exists.
create table if not exists public.device_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  fcm_token  text not null unique,
  platform   text not null check (platform in ('android', 'ios')),
  updated_at timestamptz not null default now()
);
alter table public.device_tokens enable row level security;
drop policy if exists device_tokens_own on public.device_tokens;
create policy device_tokens_own on public.device_tokens
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create index if not exists device_tokens_user_idx on public.device_tokens (user_id);

-- ---------------------------------------------------------------------
-- Enqueueing
-- ---------------------------------------------------------------------
create or replace function private.enqueue_notification(
  p_recipient uuid, p_event text, p_assignment uuid, p_key text, p_params jsonb default '{}'
) returns void language sql security definer set search_path = '' as $$
  insert into public.notifications (recipient_id, event, assignment_id, params, dedupe_key)
  select p_recipient, p_event, p_assignment, coalesce(p_params, '{}'), p_key
   where p_recipient is not null
  on conflict (dedupe_key) do nothing;
$$;
revoke all on function private.enqueue_notification(uuid, text, uuid, text, jsonb) from public;

-- Who does the round's work: its owner once someone claimed it, else everyone it was given to.
create or replace function private.round_workers(p_owner uuid, p_assignees uuid[])
returns uuid[] language sql immutable set search_path = '' as $$
  select case when p_owner is not null then array[p_owner] else coalesce(p_assignees, '{}') end;
$$;
revoke all on function private.round_workers(uuid, uuid[]) from public;

create or replace function private.notify_submission_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_tx       text := txid_current()::text;
  v_r        uuid;
  v_n        int;
  -- OLD is read only on an UPDATE; on an INSERT these stay null / empty.
  v_old_ids  uuid[] := '{}';
begin
  begin
    if tg_op = 'UPDATE' then
      v_old_ids := old.assignee_ids;
    end if;

    -- E1: a dated round given to someone, on creation or when the planner
    -- moves it to new people (only the newly added hear about it). Never to
    -- the person who made the change.
    if new.scheduled_date is not null and new.status = 'pending'
       and (tg_op = 'INSERT' or new.assignee_ids is distinct from v_old_ids) then
      foreach v_r in array new.assignee_ids loop
        if not (v_r = any (v_old_ids)) and v_r is distinct from auth.uid() then
          perform private.enqueue_notification(v_r, 'E1', new.id,
            'E1:' || new.id || ':' || v_r || ':' || v_tx, jsonb_build_object('txid', v_tx));
        end if;
      end loop;
    end if;

    if tg_op = 'UPDATE' then
      -- E5: reject_items sends items back (status back to in_progress, a new
      -- reviewed_at). It updates the items first, so the count is current.
      if new.status = 'in_progress' and new.reviewed_at is not null
         and new.reviewed_at is distinct from old.reviewed_at then
        select count(*) into v_n from public.assignment_items
         where assignment_id = new.id and status = 'rejected';
        foreach v_r in array private.round_workers(new.inspector_id, new.assignee_ids) loop
          perform private.enqueue_notification(v_r, 'E5', new.id,
            'E5:' || new.id || ':' || v_r || ':' || extract(epoch from new.reviewed_at),
            jsonb_build_object('count', v_n, 'reason', new.review_note));
        end loop;
      end if;

      -- E8: a submit raised a follow-up; the owner's manager hears about it.
      if new.status = 'follow_up' and old.status is distinct from 'follow_up' then
        perform private.enqueue_notification(
          (select p.manager_id from public.profiles p where p.id = new.inspector_id),
          'E8', new.id,
          'E8:' || new.id || ':' || coalesce((select p.manager_id::text from public.profiles p
                                               where p.id = new.inspector_id), '') || ':' || v_tx);
      end if;
    end if;
  exception when others then
    raise warning 'notifications: % (%)', sqlerrm, sqlstate;
  end;
  return null;
end $$;
revoke all on function private.notify_submission_change() from public;

drop trigger if exists submissions_notify on public.submissions;
create trigger submissions_notify
  after insert or update on public.submissions
  for each row execute function private.notify_submission_change();

-- E3 (30 min before the deadline) and E4 (at the deadline, to the workers
-- and each worker's manager). The API calls it every minute with its
-- secret key. Only deadlines in the last 15 minutes count as "now" for E4,
-- so the first run, or a run after an outage, never floods phones with
-- every round that ever went overdue.
create or replace function public.enqueue_due_notifications()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_row record;
  v_r   uuid;
  v_at  text;
begin
  for v_row in
    select v.id, v.deadline, v.inspector_id, v.assignee_ids
      from public.assignments_v v
     where v.status in ('pending', 'in_progress')
       and v.deadline >  now() - interval '15 minutes'
       and v.deadline <= now() + interval '30 minutes'
  loop
    v_at := extract(epoch from v_row.deadline)::bigint::text;
    foreach v_r in array private.round_workers(v_row.inspector_id, v_row.assignee_ids) loop
      if v_row.deadline > now() then
        perform private.enqueue_notification(v_r, 'E3', v_row.id, 'E3:' || v_row.id || ':' || v_r || ':' || v_at);
      else
        perform private.enqueue_notification(v_r, 'E4', v_row.id, 'E4:' || v_row.id || ':' || v_r || ':' || v_at);
        perform private.enqueue_notification(m.manager_id, 'E4', v_row.id,
                  'E4:' || v_row.id || ':' || m.manager_id || ':' || v_at, '{"manager": true}')
           from public.profiles m where m.id = v_r and m.manager_id is not null;
      end if;
    end loop;
  end loop;
end $$;
revoke execute on function public.enqueue_due_notifications() from public, anon, authenticated;
grant  execute on function public.enqueue_due_notifications() to service_role;

-- The worker's claim. SKIP LOCKED lets two API instances share the queue; a
-- row left 'claimed' for 2 minutes (an instance died mid-send) is taken
-- again. attempts counts claims, so a row that keeps killing the worker
-- stops being re-claimed after 5.
create or replace function public.claim_notifications(p_limit int default 500)
returns setof public.notifications language sql security definer set search_path = '' as $$
  update public.notifications n
     set status = 'claimed', claimed_at = now(), attempts = n.attempts + 1
   where n.id in (
     select q.id from public.notifications q
      where q.attempts < 5
        and ((q.status = 'queued' and q.available_at <= now())
          or (q.status = 'claimed' and q.claimed_at < now() - interval '2 minutes'))
      order by q.id
      limit p_limit
      for update skip locked)
  returning n.*;
$$;
revoke execute on function public.claim_notifications(int) from public, anon, authenticated;
grant  execute on function public.claim_notifications(int) to service_role;

-- ---------------------------------------------------------------------
-- Device tokens (PN-1): the API calls these as the user
-- ---------------------------------------------------------------------
-- SECURITY DEFINER because a token is unique and RLS shows only your own
-- rows: when a shared phone changes hands, a plain upsert would hit the
-- previous user's row and fail. The token now belongs to the caller.
create or replace function public.register_device_token(p_token text, p_platform text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Not authorized'; end if;
  if coalesce(btrim(p_token), '') = '' or length(p_token) > 4096 then
    raise exception 'INVALID_TOKEN';
  end if;
  if p_platform is null or p_platform not in ('android', 'ios') then
    raise exception 'INVALID_TOKEN';
  end if;
  insert into public.device_tokens (user_id, fcm_token, platform, updated_at)
  values (auth.uid(), p_token, p_platform, now())
  on conflict (fcm_token) do update
    set user_id = excluded.user_id, platform = excluded.platform, updated_at = now();
end $$;
revoke execute on function public.register_device_token(text, text) from public, anon;
grant  execute on function public.register_device_token(text, text) to authenticated, service_role;

create or replace function public.unregister_device_token(p_token text)
returns void language sql security definer set search_path = '' as $$
  delete from public.device_tokens where fcm_token = p_token and user_id = auth.uid();
$$;
revoke execute on function public.unregister_device_token(text) from public, anon;
grant  execute on function public.unregister_device_token(text) to authenticated, service_role;

commit;

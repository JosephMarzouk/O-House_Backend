-- =====================================================================
-- sync_refusals: what the phone's outbox parked, and why (plan SY-6, SY-10)
--
-- The API writes a row whenever it answers 422 refused, and the phone
-- writes one through POST /sync/refusals for refusals it decides itself
-- (an evidence file the OS purged). Staff see their own rows, managers
-- their reports', admins all: the same shape as submissions_select.
--
--   * No foreign key to submissions or assignment_items: a planner delete
--     must never break (or cascade away) the record of refused work.
--   * Writes only through record_sync_refusal(), as the caller. No insert
--     policy, and the table grants are cut to select.
--   * (user_id, idempotency_key) is unique, so a parked op that is retried
--     and refused again is recorded once.
-- =====================================================================

begin;

create table public.sync_refusals (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  assignment_id   uuid,
  item_id         uuid,
  op              text not null,
  code            text not null,
  message         text,
  idempotency_key uuid,
  created_at      timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create index sync_refusals_created_at on public.sync_refusals (created_at desc);

alter table public.sync_refusals enable row level security;

revoke all on public.sync_refusals from anon, authenticated;
grant select on public.sync_refusals to authenticated;

create policy sync_refusals_select on public.sync_refusals for select to authenticated using (
  user_id = auth.uid()
  or public.current_role() = 'admin'
  or (public.current_role() = 'manager'
      and user_id in (select p.id from public.profiles p where p.manager_id = auth.uid()))
);

create function public.record_sync_refusal(
  p_op text, p_code text, p_message text default null,
  p_assignment_id uuid default null, p_item_id uuid default null,
  p_idempotency_key uuid default null
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Not authorized'; end if;
  insert into public.sync_refusals (user_id, assignment_id, item_id, op, code, message, idempotency_key)
  values (auth.uid(), p_assignment_id, p_item_id, left(p_op, 40), left(p_code, 60), left(p_message, 500),
          p_idempotency_key)
  on conflict (user_id, idempotency_key) do nothing;
end $$;

revoke execute on function public.record_sync_refusal(text, text, text, uuid, uuid, uuid) from public, anon;
grant execute on function public.record_sync_refusal(text, text, text, uuid, uuid, uuid) to authenticated;

commit;

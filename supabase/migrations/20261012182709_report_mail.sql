-- =====================================================================
-- Report emails: the day's (or week's) report PDF to each department's
-- recipients, at 23:30 Cairo time.
--
--   * report_mail_settings — one row: daily / weekly / off, and who last
--     saved it. The API renders every emailed PDF signed in as that person,
--     so a report never shows more than they can see in the portal.
--   * report_mail_recipients — the addresses per department, typed by an
--     admin on Club settings. Outside addresses are allowed.
--   * report_mail_log — one row per (period, department). The API claims a
--     row before it sends (claim_report_mail), so two API instances on the
--     same database send once; the portal shows the last outcome.
--
-- Writes only through set_report_mail (club_settings.edit + reports.view)
-- and the API's secret key (service_role).
-- =====================================================================

begin;

create table public.report_mail_settings (
  id         boolean primary key default true check (id),
  frequency  text not null default 'off' check (frequency in ('off', 'daily', 'weekly')),
  set_by     uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);
insert into public.report_mail_settings default values;

create table public.report_mail_recipients (
  department_id uuid not null references public.departments (id) on delete cascade,
  email         text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254),
  primary key (department_id, email)
);

create table public.report_mail_log (
  period_start  date not null,
  period_end    date not null,
  department_id uuid not null references public.departments (id) on delete cascade,
  recipients    text[] not null,
  status        text not null check (status in ('claimed', 'sent', 'failed')),
  attempts      int not null default 1,
  error         text,
  updated_at    timestamptz not null default now(),
  primary key (period_start, period_end, department_id)
);

alter table public.report_mail_settings   enable row level security;
alter table public.report_mail_recipients enable row level security;
alter table public.report_mail_log        enable row level security;
revoke all on public.report_mail_settings, public.report_mail_recipients, public.report_mail_log from anon, authenticated;
grant select on public.report_mail_settings, public.report_mail_recipients, public.report_mail_log to authenticated;

create policy report_mail_settings_select on public.report_mail_settings
  for select to authenticated using (public.has_permission('club_settings.view'));
create policy report_mail_recipients_select on public.report_mail_recipients
  for select to authenticated using (public.has_permission('club_settings.view'));
create policy report_mail_log_select on public.report_mail_log
  for select to authenticated using (public.has_permission('club_settings.view'));

-- p_recipients: {"<department id>": ["a@club.com", ...], ...}. Departments
-- left out lose their addresses: the form always sends the whole list.
create function public.set_report_mail(p_frequency text, p_recipients jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require('club_settings.edit');
  -- The PDFs are rendered as the saver: they must be able to see reports.
  perform private.require('reports.view');
  if p_frequency is null or p_frequency not in ('off', 'daily', 'weekly') then
    raise exception 'INVALID_FREQUENCY';
  end if;
  if jsonb_typeof(coalesce(p_recipients, '{}')) <> 'object' then
    raise exception 'INVALID_RECIPIENTS';
  end if;

  update public.report_mail_settings
     set frequency = p_frequency, set_by = auth.uid(), updated_at = now();

  delete from public.report_mail_recipients where true;
  insert into public.report_mail_recipients (department_id, email)
  select distinct d.key::uuid, lower(btrim(e.value))
    from jsonb_each(coalesce(p_recipients, '{}')) d,
         jsonb_array_elements_text(d.value) e
   where btrim(e.value) <> '';
end $$;
revoke execute on function public.set_report_mail(text, jsonb) from public, anon;
grant  execute on function public.set_report_mail(text, jsonb) to authenticated;

-- The worker's claim for one period: a row per department with recipients.
-- A new row, or one not sent yet whose last try is 5 minutes old (a failure,
-- or an instance that died mid-send), is returned; after 3 tries it stays
-- failed. Returns nothing when another instance has it.
create function public.claim_report_mail(p_start date, p_end date)
returns table (department_id uuid, name_en text, name_ar text, recipients text[], set_by uuid)
language sql security definer set search_path = '' as $$
  with claimed as (
    insert into public.report_mail_log as l (period_start, period_end, department_id, recipients, status)
    select p_start, p_end, r.department_id, array_agg(r.email order by r.email), 'claimed'
      from public.report_mail_recipients r
     group by r.department_id
    on conflict (period_start, period_end, department_id) do update
       set status = 'claimed', attempts = l.attempts + 1, error = null,
           recipients = excluded.recipients, updated_at = now()
     where l.status <> 'sent' and l.attempts < 3 and l.updated_at < now() - interval '5 minutes'
    returning l.department_id, l.recipients
  )
  select c.department_id, d.name_en, d.name_ar, c.recipients, s.set_by
    from claimed c
    join public.departments d on d.id = c.department_id
   cross join public.report_mail_settings s;
$$;
revoke execute on function public.claim_report_mail(date, date) from public, anon, authenticated;
grant  execute on function public.claim_report_mail(date, date) to service_role;

commit;

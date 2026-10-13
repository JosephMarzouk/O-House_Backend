-- =====================================================================
-- Report emails: an "all departments" list (the general manager).
--
-- A recipient row with no department gets ONE email a period: the report
-- of every department together (the portal's dept=all PDF). The log keeps
-- that send under no department too. NULLS NOT DISTINCT keeps both keys
-- unique with the null (Postgres 15+), so claim_report_mail's ON CONFLICT
-- still dedupes the "all" row across API instances.
--
-- set_report_mail's p_recipients takes the key "all" for that list.
-- =====================================================================

begin;

alter table public.report_mail_recipients drop constraint report_mail_recipients_pkey;
alter table public.report_mail_recipients alter column department_id drop not null;
alter table public.report_mail_recipients
  add constraint report_mail_recipients_key unique nulls not distinct (department_id, email);

alter table public.report_mail_log drop constraint report_mail_log_pkey;
alter table public.report_mail_log alter column department_id drop not null;
alter table public.report_mail_log
  add constraint report_mail_log_key unique nulls not distinct (period_start, period_end, department_id);

create or replace function public.set_report_mail(p_frequency text, p_sender text, p_recipients jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require('club_settings.edit');
  -- The PDFs are rendered as the saver: they must be able to see reports.
  perform private.require('reports.view');
  if p_frequency is null or p_frequency not in ('off', 'daily', 'weekly') then
    raise exception 'INVALID_FREQUENCY';
  end if;
  if p_frequency <> 'off' and coalesce(btrim(p_sender), '') = '' then
    raise exception 'SENDER_REQUIRED';
  end if;
  if jsonb_typeof(coalesce(p_recipients, '{}')) <> 'object' then
    raise exception 'INVALID_RECIPIENTS';
  end if;

  update public.report_mail_settings
     set frequency = p_frequency,
         sender = nullif(lower(btrim(p_sender)), ''),
         set_by = auth.uid(),
         updated_at = now()
   where id;

  delete from public.report_mail_recipients where true;
  insert into public.report_mail_recipients (department_id, email)
  select distinct nullif(d.key, 'all')::uuid, lower(btrim(e.value))
    from jsonb_each(coalesce(p_recipients, '{}')) d,
         jsonb_array_elements_text(d.value) e
   where btrim(e.value) <> '';
end $$;

-- Same signature; the "all" row comes back with no department and no names.
create or replace function public.claim_report_mail(p_start date, p_end date)
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
    left join public.departments d on d.id = c.department_id
   cross join public.report_mail_settings s;
$$;

commit;

-- set_report_mail: the Data API runs with pg_safeupdate, which refuses an
-- UPDATE with no WHERE ("UPDATE requires a WHERE clause"), even on a
-- one-row table. `where id` names that row. Same signature, so no drop.

begin;

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
  select distinct d.key::uuid, lower(btrim(e.value))
    from jsonb_each(coalesce(p_recipients, '{}')) d,
         jsonb_array_elements_text(d.value) e
   where btrim(e.value) <> '';
end $$;

commit;

-- set_report_mail: "Send from" may be empty. Each club can carry a default
-- sender in the API's CLUBS.<slug>.mail.sender; Club settings overrides it.
-- With neither, the API records the send as failed with the reason, which
-- Club settings shows. Same signature, so no drop.

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

commit;

-- =====================================================================
-- Report emails: the sender address is the club's, set on Club settings.
--
-- One fixed mailbox per club (e.g. reports@club.com), whoever is signed in.
-- An admin may change it; the club's Microsoft app (CLUBS.<slug>.mail) must
-- be allowed to send as the new mailbox (its Exchange access policy group).
-- set_report_mail gains p_sender, so the old signature is dropped here.
-- =====================================================================

begin;

alter table public.report_mail_settings
  add column sender text check (sender ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(sender) <= 254);

drop function public.set_report_mail(text, jsonb);

create function public.set_report_mail(p_frequency text, p_sender text, p_recipients jsonb)
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
         updated_at = now();

  delete from public.report_mail_recipients where true;
  insert into public.report_mail_recipients (department_id, email)
  select distinct d.key::uuid, lower(btrim(e.value))
    from jsonb_each(coalesce(p_recipients, '{}')) d,
         jsonb_array_elements_text(d.value) e
   where btrim(e.value) <> '';
end $$;
revoke execute on function public.set_report_mail(text, text, jsonb) from public, anon;
grant  execute on function public.set_report_mail(text, text, jsonb) to authenticated;

commit;

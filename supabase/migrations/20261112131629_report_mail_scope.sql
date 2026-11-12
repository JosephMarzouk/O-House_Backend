-- set_report_mail stays within the caller's scope.
--
-- Before, anyone with club_settings.edit + reports.view replaced every list
-- and became set_by, and the API renders every PDF as set_by. A caller
-- scoped to some departments would have overwritten other departments'
-- lists and made every other department's report come out empty (their
-- checklists are outside that caller's scope). Today only the Admin role
-- (scope 'all') has club_settings.edit, so nothing was lost; this closes it
-- before a scoped role is given the permission.
--
-- Now:
--   * frequency, sender, set_by and the "all departments" list: scope 'all'
--     only (set_by must see every report). A scoped caller sending other
--     values is refused, not silently ignored.
--   * a department's list: only departments private.can_see_department()
--     allows; a list for any other department is refused. Lists outside the
--     caller's scope are left as they are.
-- Same signature, so no drop.

begin;

create or replace function public.set_report_mail(p_frequency text, p_sender text, p_recipients jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_full boolean := coalesce((private.my_role()).scope = 'all', false);
  v_sender text := nullif(lower(btrim(p_sender)), '');
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
  if exists (select 1 from jsonb_object_keys(coalesce(p_recipients, '{}')) k
              where case when k = 'all' then not v_full
                         else not private.can_see_department(k::uuid) end) then
    raise exception 'FORBIDDEN: permission denied (scope)';
  end if;

  if v_full then
    update public.report_mail_settings
       set frequency = p_frequency,
           sender = v_sender,
           set_by = auth.uid(),
           updated_at = now()
     where id;
  elsif exists (select 1 from public.report_mail_settings
                 where frequency <> p_frequency or sender is distinct from v_sender) then
    raise exception 'FORBIDDEN: permission denied (scope)';
  end if;

  delete from public.report_mail_recipients r
   where case when r.department_id is null then v_full
              else private.can_see_department(r.department_id) end;
  insert into public.report_mail_recipients (department_id, email)
  select distinct nullif(d.key, 'all')::uuid, lower(btrim(e.value))
    from jsonb_each(coalesce(p_recipients, '{}')) d,
         jsonb_array_elements_text(d.value) e
   where btrim(e.value) <> '';
end $$;

commit;

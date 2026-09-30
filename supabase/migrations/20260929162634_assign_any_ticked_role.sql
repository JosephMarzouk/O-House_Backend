-- =====================================================================
-- A role can create (and assign) whichever roles you tick for it
--
-- Until now a role could only hand out roles no stronger than itself, at two
-- points: private.assignable_role_ids() dropped every role holding a
-- permission the caller lacks, and private.save_role() refused to list a role
-- holding a permission outside the listing role's own new permissions. So a
-- "Head of Sports" with Users -> Create could not create Managers unless it
-- also held everything a Manager can do.
--
-- The decision: ticking a role under "Can create users with these roles" is
-- enough. A role with Users -> Create / Edit may create and assign any role
-- ticked for it, even a stronger one. Both "no stronger than me" rules go.
--
-- Unchanged, and still enforced inside the functions:
--   * The Admin role is never assignable, for anyone (assignable_role_ids
--     excludes it, and save_role's `v_assign <@ assignable_role_ids()` keeps
--     it out of every list). An Admin is still made only by the manual SQL
--     path.
--   * The Admin role sees every non-Admin role; anyone else, their
--     role_assignable rows.
--   * A role's permissions stay a subset of the editor's (staff_app.view
--     exempt), and its assignable roles a subset of the editor's own
--     assignable roles: a role manager can't tick a role it can't assign.
--   * Managing roles needs roles.create / edit AND scope 'all'; the Admin
--     role and your own role are never edited.
--
-- can_assign_role, can_manage_user and assign_role are built on
-- assignable_role_ids, so they follow without being touched.
--
-- Both functions are re-created from the live definitions with only the two
-- blocks above removed (create or replace: signatures, security definer,
-- search_path and grants are unchanged).
-- =====================================================================

begin;

create or replace function private.assignable_role_ids()
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(r.id order by r.id), '{}')
    from public.roles r, private.my_role() me
   where r.key is distinct from 'admin'
     and (me.key = 'admin'
          or exists (select 1 from public.role_assignable a
                      where a.role_id = me.id and a.assignable_role_id = r.id))
$$;

create or replace function private.save_role(p_role_id uuid, p_name_en text, p_name_ar text, p_scope text,
                                             p_permissions text[], p_department_ids uuid[], p_assignable_role_ids uuid[])
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_me      public.roles := private.my_role();
  v_role    public.roles;
  v_before  jsonb;
  v_name_en text   := btrim(p_name_en);
  v_name_ar text   := btrim(p_name_ar);
  v_perms   text[] := array(select distinct x from unnest(p_permissions) x where x is not null);
  v_depts   uuid[] := array(select distinct x from unnest(p_department_ids) x where x is not null);
  v_assign  uuid[] := array(select distinct x from unnest(p_assignable_role_ids) x where x is not null);
begin
  -- `is not true`, never `not (...)`: a NULL must refuse, not pass.
  if (public.has_permission(case when p_role_id is null then 'roles.create' else 'roles.edit' end)
      and v_me.scope = 'all') is not true then
    raise exception 'FORBIDDEN: permission denied (roles)';
  end if;

  if p_role_id is not null then
    select * into v_role from public.roles where id = p_role_id for update;
    if not found then raise exception 'NOT_FOUND'; end if;
    if v_role.locked then raise exception 'ROLE_LOCKED'; end if;
    if v_role.id = v_me.id then raise exception 'OWN_ROLE'; end if;
    v_before := private.role_snapshot(p_role_id);
  end if;

  if coalesce(v_name_en, '') = '' or coalesce(v_name_ar, '') = '' then
    raise exception 'NAME_REQUIRED';
  end if;
  if exists (select 1 from public.roles
              where lower(name_en) = lower(v_name_en) and id is distinct from p_role_id) then
    raise exception 'NAME_TAKEN';
  end if;
  if p_scope is null or p_scope not in ('own', 'team', 'departments', 'all') then
    raise exception 'INVALID_SCOPE';
  end if;
  if (p_scope = 'departments') <> (cardinality(v_depts) > 0) then
    raise exception 'DEPARTMENTS_REQUIRED';  -- given iff scope = 'departments'
  end if;
  -- No escalation: nothing the caller doesn't hold, no one the caller can't
  -- assign (which also keeps the Admin role out of every assignable list).
  -- staff_app.view is a trait, not a power: anyone managing roles may give it.
  -- A listed role MAY be stronger than the role being saved: ticking it is
  -- the permission to create it.
  if exists (select 1 from unnest(v_perms) k
              where k <> 'staff_app.view' and not public.has_permission(k))
     or (v_assign <@ private.assignable_role_ids()) is not true then
    raise exception 'NOT_A_SUBSET';
  end if;

  if p_role_id is null then
    insert into public.roles (name_en, name_ar, scope)
    values (v_name_en, v_name_ar, p_scope)
    returning * into v_role;
  else
    update public.roles
       set name_en = v_name_en, name_ar = v_name_ar, scope = p_scope, updated_at = now()
     where id = p_role_id
    returning * into v_role;
    delete from public.role_permissions where role_id = v_role.id;
    delete from public.role_departments where role_id = v_role.id;
    delete from public.role_assignable  where role_id = v_role.id;
  end if;

  insert into public.role_permissions (role_id, permission_key) select v_role.id, unnest(v_perms);
  insert into public.role_departments (role_id, department_id)  select v_role.id, unnest(v_depts);
  insert into public.role_assignable (role_id, assignable_role_id) select v_role.id, unnest(v_assign);

  insert into public.role_audit (actor, action, role_id, before, after)
  values (auth.uid(), case when p_role_id is null then 'create_role' else 'update_role' end,
          v_role.id, v_before, private.role_snapshot(v_role.id));
  return v_role.id;
end $$;

-- create or replace keeps the privileges; stated again so this file stands alone.
revoke all on function private.assignable_role_ids(),
  private.save_role(uuid, text, text, text, text[], uuid[], uuid[]) from public;

commit;

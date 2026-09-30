-- =====================================================================
-- Custom roles, part A: the catalog, the roles, and the role functions
--
-- A club's admin can make roles ("Head of Sports", "Night supervisor"),
-- tick what each may do, and give them to staff. What a role CAN do comes
-- from a fixed catalog (permissions): a key only means something where a
-- function or policy checks it, so admins combine keys but never invent them.
-- New features add keys in their own migrations.
--
--   permissions       the catalog, key = module.action, labels EN + AR
--   roles             defaults carry a key (admin/manager/inspector/cleaner),
--                     custom roles have none; scope = whose work it sees:
--                       own          only your own work
--                       team         your direct reports (profiles.manager_id)
--                       departments  work in the departments in role_departments
--                       all          everything
--                     Your own work is always visible, whatever the scope.
--   role_permissions  what each role may do
--   role_departments  the departments of a 'departments'-scoped role
--   role_assignable   which roles a role may create users with / assign.
--                     The Admin role may assign every non-Admin role by rule
--                     (private.assignable_role_ids), not rows, so new roles
--                     are covered without anyone ticking them.
--   role_audit        every role change and every role assignment
--
-- The four default roles are seeded to match what each role can do today;
-- 20260929125625_permission_checks.sql moves every check onto them.
--
-- The rails (enforced here, inside the functions, not in the portal):
--   * Managing roles needs roles.create / edit / delete AND scope 'all'.
--   * A role's permissions must be a subset of the caller's, and its
--     assignable roles a subset of the caller's assignable roles and within
--     the role's own permissions.
--   * Nobody hands out a role holding a permission they lack. Checked at
--     assign time too, so widening a role later can't leak power.
--   * staff_app.view ("can be given checklists") is a trait, not a power:
--     it is left out of every subset comparison.
--   * Nobody edits or deletes a locked role (Admin) or their own role.
--   * A role someone holds can't be deleted; nor can a default role until
--     flag day (handle_new_user and set_user_role still look them up by key).
--   * Assigning a role needs users.edit over the target (can_manage_user:
--     not yourself, in your scope, and their CURRENT role one you may assign,
--     so nobody touches an Admin), and the new role one you may assign.
--   * Nothing callable grants the Admin role. An Admin is still made only by
--     the manual SQL path (o-house-admin/supabase/README.md,
--     `update profiles set role = 'admin' ...`), which the trigger below
--     turns into role_id.
--
-- Compat until flag day (Step 4), then dropped:
--   * profiles.role stays as a mirror of profiles.role_id, kept in step by
--     profiles_sync_role. A custom role mirrors as 'cleaner' (least
--     privilege): the production portal on main and the old web checklist
--     still read the text.
--   * current_role() stays, reading that mirror, for the unused legacy
--     follow-up tables (actions, action_events, template_claims).
--   * set_user_role(uuid, text) becomes a wrapper around assign_role.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. The catalog
-- ---------------------------------------------------------------------
create table public.permissions (
  key      text primary key,
  section  text not null check (section in ('access', 'checklists', 'places', 'staff', 'club')),
  module   text not null,
  action   text not null check (action in ('view', 'create', 'edit', 'delete')),
  label_en text not null,
  label_ar text not null,
  sort     int  not null,
  check (key = module || '.' || action)
);

insert into public.permissions (key, section, module, action, label_en, label_ar, sort) values
  ('portal.view',        'access',     'portal',        'view',   'Sign in to the admin portal',                          'الدخول إلى لوحة الإدارة',                    10),
  ('staff_app.view',     'access',     'staff_app',     'view',   'Use the staff app and be assigned checklists',         'استخدام تطبيق الموظفين وتلقي المهام',        20),
  ('checklists.view',    'checklists', 'checklists',    'view',   'See checklists',                                       'عرض المهام',                                 30),
  ('checklists.create',  'checklists', 'checklists',    'create', 'Create and assign checklists',                         'إنشاء المهام وإسنادها',                      40),
  ('checklists.edit',    'checklists', 'checklists',    'edit',   'Extend deadlines and move checklists on the tracker',  'تمديد موعد المهام ونقلها في متابعة المهام',  50),
  ('checklists.delete',  'checklists', 'checklists',    'delete', 'Delete checklists',                                    'حذف المهام',                                 60),
  ('review.edit',        'checklists', 'review',        'edit',   'Approve checklists or send them back',                 'اعتماد المهام أو إعادتها',                   70),
  ('planner.view',       'checklists', 'planner',       'view',   'See the rounds planner',                               'عرض مخطط الجولات',                           80),
  ('planner.create',     'checklists', 'planner',       'create', 'Schedule rounds and add round templates',              'جدولة الجولات وإضافة قوالبها',               90),
  ('planner.edit',       'checklists', 'planner',       'edit',   'Edit round templates',                                 'تعديل قوالب الجولات',                       100),
  ('planner.delete',     'checklists', 'planner',       'delete', 'Delete round templates',                               'حذف قوالب الجولات',                         110),
  ('reports.view',       'checklists', 'reports',       'view',   'See reports',                                          'عرض التقارير',                              120),
  ('places.view',        'places',     'places',        'view',   'See places and templates',                             'عرض الأماكن والقوالب',                      130),
  ('places.create',      'places',     'places',        'create', 'Add places and templates',                             'إضافة الأماكن والقوالب',                    140),
  ('places.edit',        'places',     'places',        'edit',   'Edit places and templates',                            'تعديل الأماكن والقوالب',                    150),
  ('places.delete',      'places',     'places',        'delete', 'Delete places and templates',                          'حذف الأماكن والقوالب',                      160),
  ('departments.view',   'places',     'departments',   'view',   'See departments',                                      'عرض الأقسام',                               170),
  ('departments.create', 'places',     'departments',   'create', 'Add departments',                                      'إضافة الأقسام',                             180),
  ('departments.edit',   'places',     'departments',   'edit',   'Rename departments',                                   'تعديل الأقسام',                             190),
  ('departments.delete', 'places',     'departments',   'delete', 'Delete departments',                                   'حذف الأقسام',                               200),
  ('users.view',         'staff',      'users',         'view',   'See the staff list',                                   'عرض قائمة المستخدمين',                      210),
  ('users.create',       'staff',      'users',         'create', 'Add staff accounts',                                   'إضافة حسابات الموظفين',                     220),
  ('users.edit',         'staff',      'users',         'edit',   'Change a person''s department, manager, role and password', 'تغيير قسم الموظف ومديره ودوره وكلمة المرور', 230),
  ('phones.view',        'staff',      'phones',        'view',   'See phone numbers',                                    'عرض أرقام الهواتف',                         240),
  ('roles.view',         'staff',      'roles',         'view',   'See roles and their history',                          'عرض الأدوار وسجل تغييراتها',                250),
  ('roles.create',       'staff',      'roles',         'create', 'Create roles',                                         'إنشاء الأدوار',                             260),
  ('roles.edit',         'staff',      'roles',         'edit',   'Edit roles',                                           'تعديل الأدوار',                             270),
  ('roles.delete',       'staff',      'roles',         'delete', 'Delete roles',                                         'حذف الأدوار',                               280),
  ('club_settings.view', 'club',       'club_settings', 'view',   'See club settings',                                    'عرض إعدادات النادي',                        290),
  ('club_settings.edit', 'club',       'club_settings', 'edit',   'Edit the About and Policies text',                     'تعديل نص «عن التطبيق» و«السياسات»',          300);

-- ---------------------------------------------------------------------
-- 2. Roles and what they hold
-- ---------------------------------------------------------------------
create table public.roles (
  id         uuid primary key default gen_random_uuid(),
  key        text unique check (key in ('admin', 'manager', 'inspector', 'cleaner')),
  name_en    text not null check (name_en = btrim(name_en) and name_en <> '' and length(name_en) <= 60),
  name_ar    text not null check (name_ar = btrim(name_ar) and name_ar <> '' and length(name_ar) <= 60),
  scope      text not null check (scope in ('own', 'team', 'departments', 'all')),
  locked     boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index roles_name_en_unique on public.roles (lower(name_en));

create table public.role_permissions (
  role_id        uuid not null references public.roles (id) on delete cascade,
  permission_key text not null references public.permissions (key),
  primary key (role_id, permission_key)
);

create table public.role_departments (
  role_id       uuid not null references public.roles (id) on delete cascade,
  department_id uuid not null references public.departments (id) on delete cascade,
  primary key (role_id, department_id)
);

create table public.role_assignable (
  role_id            uuid not null references public.roles (id) on delete cascade,
  assignable_role_id uuid not null references public.roles (id) on delete cascade,
  primary key (role_id, assignable_role_id),
  check (role_id <> assignable_role_id)
);

-- No foreign keys on purpose: the history outlives the role and the person.
create table public.role_audit (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor       uuid,
  action      text not null,  -- create_role / update_role / delete_role / assign_role
  role_id     uuid,
  target_user uuid,
  before      jsonb,
  after       jsonb
);

-- The defaults, matching what each role can do today.
insert into public.roles (key, name_en, name_ar, scope, locked) values
  ('admin',     'Admin',     'مدير',        'all',  true),
  ('manager',   'Manager',   'مشرف',        'team', false),
  ('inspector', 'Inspector', 'مفتش',        'own',  false),
  ('cleaner',   'Cleaner',   'عامل نظافة',  'own',  false);

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
  from public.roles r cross join public.permissions p
 where (r.key = 'admin' and p.key <> 'staff_app.view')   -- admins aren't assignees today
    or (r.key = 'manager'
        and (p.module in ('planner', 'places', 'departments')
             or p.key in ('portal.view', 'checklists.view', 'checklists.create', 'checklists.edit',
                          'review.edit', 'reports.view', 'users.view', 'users.create', 'users.edit')))
    or (r.key = 'inspector'
        and p.key in ('portal.view', 'staff_app.view', 'checklists.view', 'checklists.create',
                      'checklists.edit', 'review.edit', 'planner.view', 'places.view', 'departments.view'))
    or (r.key = 'cleaner' and p.key = 'staff_app.view');

insert into public.role_assignable (role_id, assignable_role_id)
select m.id, r.id
  from public.roles m, public.roles r
 where m.key = 'manager' and r.key in ('inspector', 'cleaner');

-- ---------------------------------------------------------------------
-- 3. profiles.role_id, with profiles.role kept as a mirror (see header)
-- ---------------------------------------------------------------------
alter table public.profiles add column role_id uuid references public.roles (id);
update public.profiles p set role_id = r.id from public.roles r where r.key = p.role;
alter table public.profiles alter column role_id set not null;

-- role_id wins. It is derived from the text only when a writer set the text
-- alone: handle_new_user and the API's staff insert (role_id null), and the
-- manual admin path (`update ... set role = 'admin'`). An unknown text leaves
-- role_id null, and the NOT NULL refuses the row.
create function private.profiles_sync_role()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.role_id is null
     or (tg_op = 'UPDATE' and new.role is distinct from old.role
         and new.role_id is not distinct from old.role_id) then
    new.role_id := (select r.id from public.roles r where r.key = new.role);
  end if;
  -- custom roles mirror as 'cleaner', the least privileged text
  new.role := coalesce((select r.key from public.roles r where r.id = new.role_id), 'cleaner');
  return new;
end $$;
revoke all on function private.profiles_sync_role() from public;

create trigger profiles_sync_role
  before insert or update of role, role_id on public.profiles
  for each row execute function private.profiles_sync_role();

-- ---------------------------------------------------------------------
-- 4. Helpers. All SECURITY DEFINER (they read profiles and roles whatever
--    the caller may see) and fail closed: no profile, no role or
--    active = false means no role, no scope, no permission.
-- ---------------------------------------------------------------------

-- The caller's role; a row of NULLs when there is none.
create function private.my_role()
returns public.roles language sql stable security definer set search_path = '' as $$
  select r.*
    from public.profiles p
    join public.roles r on r.id = p.role_id
   where p.id = auth.uid() and p.active
$$;

create function private.user_has_permission(p_user_id uuid, p_key text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.profiles p
      join public.role_permissions rp on rp.role_id = p.role_id
     where p.id = p_user_id and p.active and rp.permission_key = p_key)
$$;

create function public.has_permission(p_key text)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.user_has_permission(auth.uid(), p_key)
$$;

-- Departments in the caller's reach. 'team' reaches every department (a
-- team is people, not departments; today's managers pick any department).
create function private.can_see_department(p_department_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
           case r.scope
             when 'all'  then true
             when 'team' then true
             when 'departments' then exists (select 1 from public.role_departments d
                                              where d.role_id = r.id and d.department_id = p_department_id)
           end, false)
    from private.my_role() r
$$;

-- Whose WORK the caller sees (checklists, sync refusals): yourself, plus
-- your direct reports (team), people in your departments, or everyone.
create function private.can_see_user(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
           p_user_id = auth.uid()
           or case r.scope
                when 'all'  then true
                when 'team' then exists (select 1 from public.profiles p
                                          where p.id = p_user_id and p.manager_id = auth.uid())
                when 'departments' then exists (select 1 from public.profiles p
                                                  join public.role_departments d on d.department_id = p.department_id
                                                 where p.id = p_user_id and d.role_id = r.id)
              end, false)
    from private.my_role() r
$$;

-- Who is on the caller's STAFF LIST. Same as can_see_user, except that
-- 'team' sees all staff: today's managers see (and manage) everyone, and
-- what they may do to a person is limited by role_assignable instead.
create function private.can_see_staff(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((private.my_role()).scope = 'team', false) or private.can_see_user(p_user_id)
$$;

-- A checklist's department: its place's (template_id, else
-- source_template_id), else the first of its owner and assignees who has
-- one. The portal's report uses the same rule (lib/report.ts roundDepartment).
create function private.submission_department(p_template_id uuid, p_source_template_id uuid,
                                              p_inspector_id uuid, p_assignee_ids uuid[])
returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select t.department_id from public.templates t
      where t.id = coalesce(p_template_id, p_source_template_id)),
    (select p.department_id
       from unnest(array[p_inspector_id] || p_assignee_ids) with ordinality u(id, n)
       join public.profiles p on p.id = u.id
      where p.department_id is not null
      order by u.n limit 1))
$$;

-- Is this checklist in the caller's scope? Own work always is.
create function private.can_see_submission(p_inspector_id uuid, p_assignee_ids uuid[],
                                           p_template_id uuid, p_source_template_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
           auth.uid() = p_inspector_id
           or auth.uid() = any (p_assignee_ids)
           or case r.scope
                when 'all'  then true
                when 'team' then exists (select 1 from public.profiles p
                                          where p.manager_id = auth.uid()
                                            and (p.id = p_inspector_id or p.id = any (p_assignee_ids)))
                when 'departments' then exists (
                  select 1 from public.role_departments d
                   where d.role_id = r.id
                     and d.department_id = private.submission_department(
                           p_template_id, p_source_template_id, p_inspector_id, p_assignee_ids))
              end, false)
    from private.my_role() r
$$;

-- The roles the caller may create users with or assign. The Admin role:
-- every role except Admin (by rule, so new roles are covered). Anyone else:
-- their role_assignable rows. Never the Admin role, for anyone.
-- And never a role holding a permission the caller lacks, checked NOW rather
-- than only when the role was saved: widening role X later must not let a
-- role that lists X hand out more than it has. staff_app.view is a trait
-- ("can be given checklists"), not a power, so it is left out of the
-- comparison (Admin doesn't hold it, yet assigns Inspectors and Cleaners).
create function private.assignable_role_ids()
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(r.id order by r.id), '{}')
    from public.roles r, private.my_role() me
   where r.key is distinct from 'admin'
     and (me.key = 'admin'
          or exists (select 1 from public.role_assignable a
                      where a.role_id = me.id and a.assignable_role_id = r.id))
     and not exists (select 1 from public.role_permissions theirs
                      where theirs.role_id = r.id
                        and theirs.permission_key <> 'staff_app.view'
                        and not exists (select 1 from public.role_permissions mine
                                         where mine.role_id = me.id
                                           and mine.permission_key = theirs.permission_key))
$$;

-- A role as one jsonb value, for role_audit.
create function private.role_snapshot(p_role_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select to_jsonb(r) || jsonb_build_object(
           'permissions', coalesce((select jsonb_agg(x.permission_key order by x.permission_key)
                                      from public.role_permissions x where x.role_id = r.id), '[]'),
           'departments', coalesce((select jsonb_agg(x.department_id order by x.department_id)
                                      from public.role_departments x where x.role_id = r.id), '[]'),
           'assignable',  coalesce((select jsonb_agg(x.assignable_role_id order by x.assignable_role_id)
                                      from public.role_assignable x where x.role_id = r.id), '[]'))
    from public.roles r
   where r.id = p_role_id
$$;

revoke all on function private.my_role(), private.user_has_permission(uuid, text),
  private.can_see_department(uuid), private.can_see_user(uuid), private.can_see_staff(uuid),
  private.submission_department(uuid, uuid, uuid, uuid[]),
  private.can_see_submission(uuid, uuid[], uuid, uuid),
  private.assignable_role_ids(), private.role_snapshot(uuid) from public;

-- ---------------------------------------------------------------------
-- 5. What the portal, the API and the app call
-- ---------------------------------------------------------------------

-- Everything a client needs to draw itself: NULL when the caller has no
-- (active) role.
create function public.my_access()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
           'role', jsonb_build_object('id', r.id, 'key', r.key, 'name_en', r.name_en,
                                      'name_ar', r.name_ar, 'locked', r.locked),
           'scope', r.scope,
           'departments', coalesce((select jsonb_agg(d.department_id order by d.department_id)
                                      from public.role_departments d where d.role_id = r.id), '[]'),
           'permissions', coalesce((select jsonb_agg(p.permission_key order by p.permission_key)
                                      from public.role_permissions p where p.role_id = r.id), '[]'),
           'assignable', to_jsonb(private.assignable_role_ids()))
    from private.my_role() r
   where r.id is not null
$$;

-- May the caller create a user with this role (in this department)? The
-- API inserts new staff with the secret key, so this call, made as the
-- user, is the only rail.
create function public.can_assign_role(p_role_id uuid, p_department_id uuid default null)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
           public.has_permission('users.create')
           and p_role_id = any (private.assignable_role_ids())
           and ((private.my_role()).scope <> 'departments' or private.can_see_department(p_department_id)),
         false)
$$;

-- May the caller change this person (department, manager, role, password)?
-- Their CURRENT role must be one the caller may assign, so nobody touches an
-- Admin, and a Manager can't touch another Manager.
create function public.can_manage_user(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
           public.has_permission('users.edit')
           and p_user_id <> auth.uid()
           and private.can_see_staff(p_user_id)
           and exists (select 1 from public.profiles p
                        where p.id = p_user_id and p.role_id = any (private.assignable_role_ids())),
         false)
$$;

-- create_role and update_role share this. p_role_id NULL = create.
create function private.save_role(p_role_id uuid, p_name_en text, p_name_ar text, p_scope text,
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
  if exists (select 1 from unnest(v_perms) k
              where k <> 'staff_app.view' and not public.has_permission(k))
     or (v_assign <@ private.assignable_role_ids()) is not true then
    raise exception 'NOT_A_SUBSET';
  end if;
  -- The role may only list roles within its OWN new permissions: anything
  -- more is dropped at runtime by assignable_role_ids, so the tick would
  -- silently do nothing.
  if exists (select 1 from public.role_permissions rp
              where rp.role_id = any (v_assign)
                and rp.permission_key <> 'staff_app.view'
                and rp.permission_key <> all (v_perms)) then
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
revoke all on function private.save_role(uuid, text, text, text, text[], uuid[], uuid[]) from public;

create function public.create_role(p_name_en text, p_name_ar text, p_scope text, p_permissions text[],
                                   p_department_ids uuid[], p_assignable_role_ids uuid[])
returns uuid language sql security definer set search_path = '' as $$
  select private.save_role(null, p_name_en, p_name_ar, p_scope, p_permissions,
                           p_department_ids, p_assignable_role_ids)
$$;

create function public.update_role(p_role_id uuid, p_name_en text, p_name_ar text, p_scope text,
                                   p_permissions text[], p_department_ids uuid[], p_assignable_role_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_role_id is null then raise exception 'NOT_FOUND'; end if;
  perform private.save_role(p_role_id, p_name_en, p_name_ar, p_scope, p_permissions,
                            p_department_ids, p_assignable_role_ids);
end $$;

create function public.delete_role(p_role_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_me   public.roles := private.my_role();
  v_role public.roles;
begin
  if (public.has_permission('roles.delete') and v_me.scope = 'all') is not true then
    raise exception 'FORBIDDEN: permission denied (roles.delete)';
  end if;
  select * into v_role from public.roles where id = p_role_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_role.locked then raise exception 'ROLE_LOCKED'; end if;
  if v_role.id = v_me.id then raise exception 'OWN_ROLE'; end if;
  -- handle_new_user, set_user_role and the API look the defaults up by key.
  -- They can be renamed and edited; deleting waits for flag day.
  if v_role.key is not null then raise exception 'DEFAULT_ROLE'; end if;
  if exists (select 1 from public.profiles where role_id = p_role_id) then
    raise exception 'ROLE_IN_USE';
  end if;

  insert into public.role_audit (actor, action, role_id, before)
  values (auth.uid(), 'delete_role', p_role_id, private.role_snapshot(p_role_id));
  delete from public.roles where id = p_role_id;
end $$;

create function public.assign_role(p_user_id uuid, p_role_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_old uuid;
begin
  -- can_manage_user: users.edit, not yourself, in your scope, their current
  -- role one you may assign. assignable_role_ids never holds the Admin role.
  if (public.can_manage_user(p_user_id)
      and p_role_id = any (private.assignable_role_ids())) is not true then
    raise exception 'FORBIDDEN: permission denied (users.edit)';
  end if;

  select role_id into v_old from public.profiles where id = p_user_id for update;
  if v_old = p_role_id then return; end if;

  update public.profiles set role_id = p_role_id where id = p_user_id;
  insert into public.role_audit (actor, action, role_id, target_user, before, after)
  values (auth.uid(), 'assign_role', p_role_id, p_user_id,
          jsonb_build_object('role_id', v_old), jsonb_build_object('role_id', p_role_id));
end $$;

-- Compat: the production portal on main still calls this. Drop at flag day.
create or replace function public.set_user_role(target_user_id uuid, new_role text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_role uuid := (select r.id from public.roles r where r.key = new_role and r.key <> 'admin');
begin
  if v_role is null then raise exception 'Invalid role: %', new_role; end if;
  perform public.assign_role(target_user_id, v_role);
end $$;

revoke execute on function
  public.has_permission(text), public.my_access(), public.can_assign_role(uuid, uuid),
  public.can_manage_user(uuid),
  public.create_role(text, text, text, text[], uuid[], uuid[]),
  public.update_role(uuid, text, text, text, text[], uuid[], uuid[]),
  public.delete_role(uuid), public.assign_role(uuid, uuid), public.set_user_role(uuid, text)
  from public, anon;
grant execute on function
  public.has_permission(text), public.my_access(), public.can_assign_role(uuid, uuid),
  public.can_manage_user(uuid),
  public.create_role(text, text, text, text[], uuid[], uuid[]),
  public.update_role(uuid, text, text, text, text[], uuid[], uuid[]),
  public.delete_role(uuid), public.assign_role(uuid, uuid), public.set_user_role(uuid, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 6. Access to the new tables: everyone signed in reads the catalog and the
--    roles (the portal draws menus from them); writes go through the
--    functions above only. The audit needs roles.view.
-- ---------------------------------------------------------------------
alter table public.permissions      enable row level security;
alter table public.roles            enable row level security;
alter table public.role_permissions enable row level security;
alter table public.role_departments enable row level security;
alter table public.role_assignable  enable row level security;
alter table public.role_audit       enable row level security;

revoke all on public.permissions, public.roles, public.role_permissions, public.role_departments,
  public.role_assignable, public.role_audit from anon, authenticated;
revoke all on sequence public.role_audit_id_seq from anon, authenticated;
grant select on public.permissions, public.roles, public.role_permissions, public.role_departments,
  public.role_assignable, public.role_audit to authenticated;

create policy permissions_select      on public.permissions      for select to authenticated using (true);
create policy roles_select            on public.roles            for select to authenticated using (true);
create policy role_permissions_select on public.role_permissions for select to authenticated using (true);
create policy role_departments_select on public.role_departments for select to authenticated using (true);
create policy role_assignable_select  on public.role_assignable  for select to authenticated using (true);
create policy role_audit_select       on public.role_audit       for select to authenticated
  using ((select public.has_permission('roles.view')));

commit;

-- ---------------------------------------------------------------------
-- Verification (read-only). Expect 30 / 4 / 0 / 0:
-- ---------------------------------------------------------------------
-- select count(*) from public.permissions;
-- select count(*) from public.roles where key is not null;
-- select count(*) from public.profiles p join public.roles r on r.id = p.role_id where r.key is distinct from p.role;
-- select count(*) from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
--    and p.prosecdef and p.proconfig is null;   -- a SECURITY DEFINER function without search_path

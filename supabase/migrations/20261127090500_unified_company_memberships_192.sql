-- Keep one User per Company while exposing every real Membership and its scope.
-- JSON aggregates keep both Users and nested Memberships complete above the API row cap.
create or replace function public.list_company_access(target_company_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  target_organization_id uuid;
  effective_access jsonb;
begin
  select c.organization_id into target_organization_id
  from public.company c
  where c.id = target_company_id and c.deleted_at is null;

  if target_organization_id is null
    or not private.can_administrate_company_memberships(target_company_id, target_organization_id) then
    raise insufficient_privilege;
  end if;

  with access_rows as (
    select m.id, m.user_id, m.email, m.role, m.organization_id, m.company_id,
      c.name as scope_name, 'company'::text as access_source,
      private.can_administrate_company_memberships(m.company_id, m.organization_id) as manageable
    from public.membership m
    join public.company c on c.id = m.company_id
    where m.organization_id = target_organization_id
      and m.company_id = target_company_id
    union all
    select m.id, m.user_id, m.email, m.role, m.organization_id, m.company_id,
      o.name as scope_name, 'organization'::text as access_source,
      private.is_organization_administrator(m.organization_id) as manageable
    from public.membership m
    join public.organization o on o.id = m.organization_id
    where m.organization_id = target_organization_id
      and m.company_id is null
      and m.role = 'administrator'
  ), effective_users as (
  select
    (array_agg(a.id order by a.access_source))[1] as membership_id,
    a.user_id as user_id,
    max(a.email) as email,
    case
      when bool_or(a.role = 'administrator') then 'administrator'::public.membership_role
      else 'user'::public.membership_role
    end as role,
    case
      when bool_or(a.access_source = 'company') and bool_or(a.access_source = 'organization')
        then 'company_and_organization'
      when bool_or(a.access_source = 'organization') then 'organization'
      else 'company'
    end as source,
    case
      when bool_or(a.access_source = 'organization') then null
      else (array_agg(a.id) filter (where a.access_source = 'company'))[1]
    end as manageable_membership_id,
    jsonb_agg(jsonb_build_object(
      'id', a.id, 'organization_id', a.organization_id, 'company_id', a.company_id,
      'scope_name', a.scope_name, 'source', a.access_source, 'role', a.role,
      'manageable', a.manageable
    ) order by a.access_source, a.id) as memberships
  from access_rows a
  where not private.is_super_admin(a.user_id)
  group by a.user_id
  )
  select coalesce(
    jsonb_agg(to_jsonb(effective_users) order by effective_users.email),
    '[]'::jsonb
  ) into effective_access
  from effective_users;

  return effective_access;
end;
$$;

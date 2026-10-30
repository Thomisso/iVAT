-- Presentation queries omit platform operators while retaining every historical
-- Membership and all existing access predicates. One JSON value avoids the
-- PostgREST row cap truncating active-user rows or their displayed counts.
create function public.list_active_memberships(target_organization_id uuid, target_company_id uuid default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(m) order by m.created_at, m.id), '[]'::jsonb)
  from public.membership m
  where m.organization_id = target_organization_id
    and m.company_id is not distinct from target_company_id
    and not private.is_super_admin(m.user_id)
    and (
      private.is_organization_administrator(m.organization_id)
      or (
        private.organization_mfa_satisfied(m.organization_id)
        and (
          m.user_id = auth.uid()
          or (m.company_id is not null and private.is_company_administrator(m.company_id, m.organization_id))
        )
      )
    );
$$;
revoke execute on function public.list_active_memberships(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_active_memberships(uuid, uuid) to authenticated;

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
    select m.id, m.user_id, m.email, m.role, 'company'::text as access_source
    from public.membership m
    where m.organization_id = target_organization_id
      and m.company_id = target_company_id
    union all
    select m.id, m.user_id, m.email, m.role, 'organization'::text as access_source
    from public.membership m
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
    end as manageable_membership_id
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

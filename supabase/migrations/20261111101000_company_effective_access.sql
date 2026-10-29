-- The Company access screen shows both direct Memberships and inherited
-- Organization Administrator access without broadening Membership table RLS.

create function public.list_company_access(target_company_id uuid)
returns table (
  membership_id uuid,
  user_id uuid,
  email text,
  role public.membership_role,
  source text,
  manageable_membership_id uuid
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  target_organization_id uuid;
begin
  select c.organization_id into target_organization_id
  from public.company c
  where c.id = target_company_id and c.deleted_at is null;

  if target_organization_id is null
    or not private.is_company_administrator(target_company_id, target_organization_id) then
    raise insufficient_privilege;
  end if;

  return query
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
  )
  select
    (array_agg(a.id order by a.access_source))[1],
    a.user_id,
    max(a.email),
    case
      when bool_or(a.role = 'administrator') then 'administrator'::public.membership_role
      else 'user'::public.membership_role
    end,
    case
      when bool_or(a.access_source = 'company') and bool_or(a.access_source = 'organization')
        then 'company_and_organization'
      when bool_or(a.access_source = 'organization') then 'organization'
      else 'company'
    end,
    case
      when bool_or(a.access_source = 'organization') then null
      else (array_agg(a.id) filter (where a.access_source = 'company'))[1]
    end
  from access_rows a
  group by a.user_id
  order by max(a.email);
end;
$$;

revoke execute on function public.list_company_access(uuid) from public, anon;
grant execute on function public.list_company_access(uuid) to authenticated;

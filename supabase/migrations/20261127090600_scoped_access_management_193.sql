-- One concrete Organization/Company context, with database-authorized scope
-- choices. JSON aggregation preserves complete people, Memberships and scopes.
create function public.list_access_management(target_organization_id uuid, target_company_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  scopes jsonb;
  selected_scope jsonb;
  users jsonb;
begin
  select coalesce(jsonb_agg(s.scope order by s.kind, s.name, s.id), '[]'::jsonb)
  into scopes
  from (
    select 0 as kind, o.name, o.id,
      jsonb_build_object('organizationId', o.id, 'companyId', null, 'name', o.name) as scope
    from public.organization o
    where o.id = target_organization_id and private.is_organization_administrator(o.id)
    union all
    select 1, c.name, c.id,
      jsonb_build_object('organizationId', c.organization_id, 'companyId', c.id, 'name', c.name)
    from public.company c
    where c.organization_id = target_organization_id and c.deleted_at is null
      and private.can_administrate_company_memberships(c.id, c.organization_id)
  ) s;

  select s into selected_scope from jsonb_array_elements(scopes) s
  where (s ->> 'companyId')::uuid is not distinct from target_company_id;
  if selected_scope is null then raise insufficient_privilege; end if;

  if target_company_id is not null then
    users := public.list_company_access(target_company_id);
  else
    select coalesce(jsonb_agg(to_jsonb(u) order by u.email, u.user_id), '[]'::jsonb) into users
    from (
      select m.user_id, max(m.email) as email,
        jsonb_agg(jsonb_build_object(
          'id', m.id, 'organization_id', m.organization_id, 'company_id', m.company_id,
          'scope_name', coalesce(c.name, o.name),
          'source', case when m.company_id is null then 'organization' else 'company' end,
          'role', m.role, 'manageable', true
        ) order by coalesce(c.name, o.name), m.id) as memberships
      from public.membership m
      join public.organization o on o.id = m.organization_id
      left join public.company c on c.id = m.company_id
      where m.organization_id = target_organization_id
        and (m.company_id is null or (c.deleted_at is null and c.id is not null))
        and not private.is_super_admin(m.user_id)
      group by m.user_id
    ) u;
  end if;

  return jsonb_build_object('scope', selected_scope, 'scopes', scopes, 'users', users,
    'pendingInvitations', public.list_pending_invitations(target_organization_id, target_company_id),
    'blocked', (select o.blocked_at is not null from public.organization o where o.id = target_organization_id));
end;
$$;
revoke execute on function public.list_access_management(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_access_management(uuid, uuid) to authenticated;

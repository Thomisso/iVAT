-- Return the complete SuperAdmin Organization inventory as one JSON value so
-- PostgREST's row limit cannot silently hide later Organizations.

create function public.list_platform_organizations_complete(target_provider text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', organization.id,
      'name', organization.name,
      'platformKeyEnabled', coalesce(access.enabled, false)
    ) order by organization.name, organization.id)
    from public.organization organization
    left join public.organization_platform_ai_access access
      on access.organization_id = organization.id
      and access.provider = target_provider
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.list_platform_organizations_complete(text)
  from public, anon, service_role;
grant execute on function public.list_platform_organizations_complete(text)
  to authenticated;

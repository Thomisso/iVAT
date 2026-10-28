-- Resolve audit actors at read time so removed Memberships remain filterable
-- without putting User personal data into the append-only audit log (ADR-0009).

create function public.audit_actors(target_organization_id uuid)
returns table (user_id uuid, email text)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_organization_administrator(target_organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    with actor as (
      select membership.user_id
      from public.membership
      where membership.organization_id = target_organization_id
      union
      select event.actor_user_id
      from public.audit_event event
      where event.organization_id = target_organization_id
        and event.actor_user_id is not null
    )
    select actor.user_id, coalesce("user".email, actor.user_id::text)::text
    from actor
    left join auth.users "user" on "user".id = actor.user_id
    order by coalesce("user".email, actor.user_id::text);
end;
$$;

revoke execute on function public.audit_actors(uuid) from public, anon;
grant execute on function public.audit_actors(uuid) to authenticated;

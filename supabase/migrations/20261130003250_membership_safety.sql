-- Every Membership reduction in an Organization takes the same parent lock
-- before locking its concrete target. Counts and mutation share one transaction;
-- a waiter re-reads current Memberships after acquiring the lock.
create function private.lock_membership_change(target_membership_id uuid)
returns public.membership
language plpgsql security definer set search_path = ''
as $$
declare target public.membership;
begin
  select * into target from public.membership where id = target_membership_id;
  if target.id is null then raise insufficient_privilege; end if;
  perform 1 from public.organization where id = target.organization_id for update;
  select * into target from public.membership where id = target_membership_id for update;
  if target.id is null then raise insufficient_privilege; end if;
  return target;
end;
$$;
revoke execute on function private.lock_membership_change(uuid) from public, anon, authenticated, service_role;

create function private.check_membership_change(target public.membership, next_role public.membership_role)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if target.company_id is null then
    if not private.is_organization_administrator(target.organization_id) then raise insufficient_privilege; end if;
  elsif not private.can_administrate_company_memberships(target.company_id, target.organization_id) then
    raise insufficient_privilege;
  end if;
  if target.user_id = auth.uid() and (next_role is null or (target.role = 'administrator' and next_role = 'user')) then
    raise exception 'Self change refused' using errcode = 'P0001', hint = 'membership_self_change';
  end if;
  if target.company_id is null and next_role = 'user' then raise insufficient_privilege; end if;
  if target.role <> 'administrator' or next_role = 'administrator' then return; end if;

  if target.company_id is null and not exists (
    select 1 from public.membership m where m.organization_id = target.organization_id
      and m.company_id is null and m.role = 'administrator' and m.id <> target.id
  ) then
    raise exception 'Last scoped Administrator' using errcode = 'P0001', hint = 'membership_last_administrator';
  end if;
  if exists (
    select 1 from public.company c
    where c.organization_id = target.organization_id and c.deleted_at is null
      and (target.company_id is null or c.id = target.company_id)
      and not exists (
        select 1 from public.membership m where m.organization_id = c.organization_id
          and (m.company_id is null or m.company_id = c.id)
          and m.role = 'administrator' and m.id <> target.id
      )
  ) then
    raise exception 'Last scoped Administrator' using errcode = 'P0001', hint = 'membership_last_administrator';
  end if;
end;
$$;
revoke execute on function private.check_membership_change(public.membership, public.membership_role) from public, anon, authenticated, service_role;

create or replace function public.change_membership_role(
  target_membership_id uuid,
  target_role public.membership_role
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target public.membership;
  old_role public.membership_role;
begin
  target := private.lock_membership_change(target_membership_id);
  perform private.check_membership_change(target, target_role);
  old_role := target.role;
  update public.membership set role = target_role where id = target.id;
  perform private.record_audit_event(
    'membership.role_changed', target.organization_id, target.company_id,
    'membership', target.id,
    jsonb_build_object('user_id', target.user_id, 'old_role', old_role, 'new_role', target_role)
  );
end;
$$;

create or replace function public.remove_membership(target_membership_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target public.membership;
begin
  target := private.lock_membership_change(target_membership_id);
  perform private.check_membership_change(target, null);
  delete from public.membership where id = target.id;
  perform private.record_audit_event(
    'membership.removed', target.organization_id, target.company_id,
    'membership', target.id,
    jsonb_build_object('user_id', target.user_id, 'role', target.role)
  );
end;
$$;

-- A read-only, authorized preview. Scalar JSON includes every impacted Company
-- and surviving concrete path without the PostgREST row limit truncating it.
create function public.preview_membership_change(target_membership_id uuid, next_role public.membership_role)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  target public.membership;
  impact jsonb;
begin
  select * into target from public.membership where id = target_membership_id;
  if target.id is null then raise insufficient_privilege; end if;
  perform private.check_membership_change(target, next_role);
  select jsonb_build_object(
    'membership', jsonb_build_object('id', target.id, 'userId', target.user_id,
      'organizationId', target.organization_id, 'companyId', target.company_id,
      'email', target.email, 'role', target.role, 'scopeName', coalesce(c.name, o.name)),
    'role', next_role,
    'platformAccess', private.is_super_admin(target.user_id),
    'companies', coalesce((
      select jsonb_agg(jsonb_build_object('companyId', company.id, 'name', company.name,
        'role', paths.role, 'memberships', paths.memberships) order by company.name, company.id)
      from public.company company
      cross join lateral (
        select case when bool_or(m.role = 'administrator') then 'administrator'
          when count(*) > 0 then 'user' else null end as role,
          coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'role', m.role,
            'source', case when m.company_id is null then 'organization' else 'company' end,
            'scopeName', case when m.company_id is null then o.name else company.name end)
            order by m.company_id nulls first, m.id), '[]'::jsonb) as memberships
        from (
          select remaining.id, remaining.company_id, remaining.role
          from public.membership remaining
          where remaining.user_id = target.user_id and remaining.organization_id = target.organization_id
            and (remaining.company_id is null or remaining.company_id = company.id)
            and remaining.id <> target.id
          union all
          select target.id, target.company_id, next_role where next_role is not null
        ) m
      ) paths
      where company.organization_id = target.organization_id and company.deleted_at is null
        and (target.company_id is null or company.id = target.company_id)
    ), '[]'::jsonb)
  ) into impact
  from public.organization o left join public.company c on c.id = target.company_id
  where o.id = target.organization_id;
  return impact || jsonb_build_object('confirmationToken', md5(impact::text));
end;
$$;
revoke execute on function public.preview_membership_change(uuid, public.membership_role) from public, anon, authenticated, service_role;
grant execute on function public.preview_membership_change(uuid, public.membership_role) to authenticated;

-- Confirmation never trusts a client projection. Recompute under the same
-- reduction lock, reject stale impact, and retain the ordinary command's checks.
create function public.confirm_membership_change(target_membership_id uuid, next_role public.membership_role, confirmation_token text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare current_impact jsonb;
begin
  perform private.lock_membership_change(target_membership_id);
  current_impact := public.preview_membership_change(target_membership_id, next_role);
  if confirmation_token is null or confirmation_token <> current_impact ->> 'confirmationToken' then
    raise exception 'Membership impact changed' using errcode = 'P0001', hint = 'membership_change_stale';
  end if;
  if next_role is null then
    perform public.remove_membership(target_membership_id);
  else
    perform public.change_membership_role(target_membership_id, next_role);
  end if;
end;
$$;
revoke execute on function public.confirm_membership_change(uuid, public.membership_role, text) from public, anon, authenticated, service_role;
grant execute on function public.confirm_membership_change(uuid, public.membership_role, text) to authenticated;

-- Invitation acceptance upserts an existing Membership under the invitee's own
-- identity. Keep that route from providing an alternate self-demotion command.
create function private.prevent_self_membership_reduction()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.user_id = auth.uid() and (
    tg_op = 'DELETE' or (old.role = 'administrator' and new.role = 'user')
  ) then
    raise exception 'Self change refused' using errcode = 'P0001', hint = 'membership_self_change';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke execute on function private.prevent_self_membership_reduction() from public, anon, authenticated, service_role;
create trigger protect_own_membership before update or delete on public.membership
for each row execute function private.prevent_self_membership_reduction();

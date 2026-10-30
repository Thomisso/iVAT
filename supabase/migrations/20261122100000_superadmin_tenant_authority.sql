-- ADR-0014: platform authority belongs to the authenticated SuperAdmin, not
-- to synthetic tenant Memberships. MFA, blocking and Company deletion remain
-- part of the shared access predicates; business transitions retain their rules.
create or replace function private.is_organization_administrator(target_organization_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.organization_mfa_satisfied(target_organization_id)
    and (
      private.can_administrate_platform()
      or exists (
        select 1 from public.membership m
        where m.user_id = auth.uid()
          and m.organization_id = target_organization_id
          and m.company_id is null and m.role = 'administrator'
      )
    );
$$;

create or replace function private.is_organization_member(target_organization_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.organization_mfa_satisfied(target_organization_id)
    and (
      private.can_administrate_platform()
      or exists (
        select 1 from public.membership m
        where m.user_id = auth.uid() and m.organization_id = target_organization_id
      )
    );
$$;

create or replace function private.can_access_company(target_company_id uuid, target_organization_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.company c
    where c.id = target_company_id and c.organization_id = target_organization_id
      and c.deleted_at is null
  )
  and private.organization_mfa_satisfied(target_organization_id)
  and (
    private.is_organization_administrator(target_organization_id)
    or exists (
      select 1 from public.membership m
      where m.user_id = auth.uid() and m.company_id = target_company_id
        and m.organization_id = target_organization_id
    )
  );
$$;

create or replace function private.is_company_administrator(target_company_id uuid, target_organization_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.company c
    where c.id = target_company_id and c.organization_id = target_organization_id
      and c.deleted_at is null
  )
  and private.organization_mfa_satisfied(target_organization_id)
  and (
    private.is_organization_administrator(target_organization_id)
    or exists (
      select 1 from public.membership m
      where m.user_id = auth.uid() and m.organization_id = target_organization_id
        and m.company_id = target_company_id and m.role = 'administrator'
    )
  );
$$;

-- UI hints are derived from the same database authority as writes. A single
-- JSON aggregate preserves the complete administration list past row limits.
create function public.list_organization_administrations()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', o.id, 'name', o.name, 'role', 'administrator', 'mfaRequired', o.mfa_required
  ) order by o.created_at, o.id), '[]'::jsonb)
  from public.organization o
  where private.is_organization_administrator(o.id);
$$;

create function public.current_company_role(target_company_id uuid)
returns public.membership_role
language sql stable security definer set search_path = ''
as $$
  select case
    when private.is_company_administrator(c.id, c.organization_id) then 'administrator'::public.membership_role
    when private.can_access_company(c.id, c.organization_id) then 'user'::public.membership_role
    else null
  end
  from public.company c where c.id = target_company_id;
$$;

revoke execute on function public.list_organization_administrations(), public.current_company_role(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_organization_administrations(), public.current_company_role(uuid)
  to authenticated;

-- This command previously checked a Membership directly instead of the shared
-- authority. Enforcing the predicate also keeps insufficient-MFA writes out.
create or replace function public.set_organization_mfa_required(target_organization_id uuid, required boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_organization_administrator(target_organization_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.organization set mfa_required = required
  where id = target_organization_id and mfa_required is distinct from required;
  if found then
    perform private.record_audit_event(
      'organization.mfa_enforcement_changed', target_organization_id, null,
      'organization', target_organization_id, jsonb_build_object('required', required)
    );
  end if;
end;
$$;

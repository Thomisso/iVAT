-- MFA policy and audit integration. Supabase Auth owns factors and assurance
-- levels; iVAT owns which Organizations require the second factor.

alter table public.organization
  add column mfa_required boolean not null default false;

create type public.platform_role as enum ('super_admin');

create table public.platform_user (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role public.platform_role not null,
  created_at timestamptz not null default now()
);

revoke all on public.platform_user from anon, authenticated;
grant select, insert, update, delete on public.platform_user to service_role;
alter table public.platform_user enable row level security;

create function private.is_super_admin(target_user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.platform_user
    where user_id = target_user_id and role = 'super_admin'
  );
$$;

revoke execute on function private.is_super_admin from public;

create function private.record_user_mfa_change(event_action text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target_user_id uuid := auth.uid();
  target_organization_id uuid;
begin
  if target_user_id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if event_action not in ('user.mfa_enrolled', 'user.mfa_disenrolled') then
    raise exception 'invalid_action' using errcode = '22023';
  end if;

  for target_organization_id in
    select distinct membership.organization_id
    from public.membership
    where membership.user_id = target_user_id
  loop
    perform private.record_audit_event(
      event_action,
      target_organization_id,
      null,
      'user',
      target_user_id,
      '{}'::jsonb
    );
  end loop;
end;
$$;

revoke execute on function private.record_user_mfa_change from public;
grant execute on function private.record_user_mfa_change(text) to authenticated;

create table private.mfa_recovery_code (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  code_hash bytea not null,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  unique (user_id, code_hash)
);

create table private.mfa_recovery_session (
  session_id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  verified_at timestamptz not null default now()
);

-- Generates the codes only after Supabase Auth has upgraded the session to
-- aal2 by verifying the newly enrolled authenticator. Plaintext is returned
-- once; only SHA-256 digests remain in PostgreSQL.
create function public.finish_mfa_enrollment()
returns text[]
language plpgsql security definer set search_path = ''
as $$
declare
  target_user_id uuid := auth.uid();
  codes text[] := '{}'::text[];
  code text;
  i integer;
begin
  if target_user_id is null or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  delete from private.mfa_recovery_code where user_id = target_user_id;
  for i in 1..10 loop
    code := encode(extensions.gen_random_bytes(8), 'hex');
    insert into private.mfa_recovery_code (user_id, code_hash)
    values (target_user_id, extensions.digest(code, 'sha256'));
    codes := array_append(codes, code);
  end loop;
  perform private.record_user_mfa_change('user.mfa_enrolled');
  return codes;
end;
$$;

create function public.mfa_recovery_codes_remaining()
returns bigint
language sql stable security definer set search_path = ''
as $$
  select count(*)
  from private.mfa_recovery_code
  where user_id = auth.uid() and used_at is null;
$$;

create function public.verify_mfa_recovery_code(input_code text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  target_user_id uuid := auth.uid();
  target_session_id text := auth.jwt() ->> 'session_id';
  consumed_id uuid;
  normalized_code text := lower(regexp_replace(input_code, '[^a-zA-Z0-9]', '', 'g'));
begin
  if target_user_id is null or nullif(target_session_id, '') is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update private.mfa_recovery_code
  set used_at = now()
  where id = (
    select id
    from private.mfa_recovery_code
    where user_id = target_user_id
      and used_at is null
      and code_hash = extensions.digest(normalized_code, 'sha256')
    for update skip locked
    limit 1
  )
  returning id into consumed_id;

  if consumed_id is null then
    return false;
  end if;

  insert into private.mfa_recovery_session (session_id, user_id)
  values (target_session_id, target_user_id)
  on conflict (session_id) do update
    set user_id = excluded.user_id, verified_at = now();
  return true;
end;
$$;

create function public.finish_mfa_disenrollment()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target_user_id uuid := auth.uid();
begin
  if target_user_id is null or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from private.mfa_recovery_code where user_id = target_user_id;
  delete from private.mfa_recovery_session where user_id = target_user_id;
  perform private.record_user_mfa_change('user.mfa_disenrolled');
end;
$$;

create function private.current_user_mfa_satisfied()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
    or exists (
      select 1
      from private.mfa_recovery_session
      where user_id = auth.uid()
        and session_id = auth.jwt() ->> 'session_id'
    );
$$;

create function private.current_user_has_totp()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from auth.mfa_factors
    where user_id = auth.uid()
      and factor_type::text = 'totp'
      and status::text = 'verified'
  );
$$;

create function private.organization_mfa_satisfied(target_organization_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select not (
      organization.mfa_required
      or private.is_super_admin(auth.uid())
      or private.current_user_has_totp()
    )
      or private.current_user_mfa_satisfied()
    from public.organization
    where id = target_organization_id
  ), false);
$$;

-- Replace the tenancy predicates so enforced Organizations are inaccessible at
-- aal1 even if a caller bypasses the web application and queries PostgREST.
create or replace function private.is_organization_administrator(target_organization_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.organization_mfa_satisfied(target_organization_id)
    and exists (
      select 1 from public.membership m
      where m.user_id = auth.uid()
        and m.organization_id = target_organization_id
        and m.company_id is null
        and m.role = 'administrator'
    );
$$;

create or replace function private.is_organization_member(target_organization_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.organization_mfa_satisfied(target_organization_id)
    and exists (
      select 1 from public.membership m
      where m.user_id = auth.uid() and m.organization_id = target_organization_id
    );
$$;

create or replace function private.can_access_company(
  target_company_id uuid,
  target_organization_id uuid
)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.organization_mfa_satisfied(target_organization_id)
    and (
      exists (
        select 1 from public.membership m
        where m.user_id = auth.uid()
          and m.organization_id = target_organization_id
          and m.company_id is null
          and m.role = 'administrator'
      )
      or exists (
        select 1 from public.membership m
        where m.user_id = auth.uid() and m.company_id = target_company_id
      )
    );
$$;

drop policy "users read own memberships; organization administrators read all"
  on public.membership;
create policy "MFA-verified users read own memberships; organization administrators read all"
  on public.membership for select to authenticated
  using (
    private.organization_mfa_satisfied(organization_id)
      and (user_id = auth.uid() or private.is_organization_administrator(organization_id))
  );

create function public.set_organization_mfa_required(
  target_organization_id uuid,
  required boolean
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.membership
    where user_id = auth.uid()
      and organization_id = target_organization_id
      and company_id is null
      and role = 'administrator'
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.organization
  set mfa_required = required
  where id = target_organization_id and mfa_required is distinct from required;
  if found then
    perform private.record_audit_event(
      'organization.mfa_enforcement_changed',
      target_organization_id,
      null,
      'organization',
      target_organization_id,
      jsonb_build_object('required', required)
    );
  end if;
end;
$$;

create function public.current_mfa_policy()
returns table (required boolean, enrolled boolean, satisfied boolean)
language sql stable security definer set search_path = ''
as $$
  with policy as (
    select private.is_super_admin(auth.uid())
      or exists (
        select 1
        from public.membership
        join public.organization on organization.id = membership.organization_id
        where membership.user_id = auth.uid() and organization.mfa_required
      ) as required
  )
  select
    policy.required,
    exists (
      select 1
      from auth.mfa_factors
      where user_id = auth.uid()
        and factor_type::text = 'totp'
        and status::text = 'verified'
    ) as enrolled,
    not policy.required or private.current_user_mfa_satisfied() as satisfied
  from policy;
$$;

revoke execute on function public.finish_mfa_enrollment, public.mfa_recovery_codes_remaining,
  public.verify_mfa_recovery_code, public.finish_mfa_disenrollment,
  public.set_organization_mfa_required, public.current_mfa_policy from public;
grant execute on function public.finish_mfa_enrollment(), public.mfa_recovery_codes_remaining(),
  public.verify_mfa_recovery_code(text), public.finish_mfa_disenrollment(),
  public.set_organization_mfa_required(uuid, boolean), public.current_mfa_policy() to authenticated;

revoke execute on function private.current_user_mfa_satisfied,
  private.current_user_has_totp, private.organization_mfa_satisfied from public;
grant execute on function private.organization_mfa_satisfied(uuid) to authenticated;

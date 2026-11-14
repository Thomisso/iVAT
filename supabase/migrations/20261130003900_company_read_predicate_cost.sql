-- Preserve the canonical access interfaces and every financial SELECT policy.
-- Recovery normally has no history: plan/read native sessions and factors only
-- after a history row exists. Do not retain any permission across statements.
create or replace function private.recovery_data_access_allowed()
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare replacement record; caller uuid := auth.uid();
begin
  select session_id, completed_at, access_after, replacement_factor_id, trusted_factor_ids
    into replacement from private.mfa_replacement where user_id = caller;
  if not found then return true; end if;
  if replacement.completed_at is null then return false; end if;
  return exists (
    select 1 from auth.sessions s
    where s.user_id = caller and s.id::text = auth.jwt() ->> 'session_id'
      and (s.id = replacement.session_id or s.created_at >= replacement.access_after)
      and (replacement.replacement_factor_id is null or (
        s.factor_id = any(replacement.trusted_factor_ids) and s.aal::text = 'aal2'
        and exists(select 1 from auth.mfa_factors f where f.id = s.factor_id
          and f.user_id = caller and f.status::text = 'verified')
      ))
  );
end;
$$;
revoke execute on function private.recovery_data_access_allowed() from public, anon, authenticated, service_role;

-- Membership and platform authority remain live database state. A concrete
-- Membership already establishes this branch, so platform authority need only
-- be evaluated when no such Membership exists. MFA/recovery still gates both.
create or replace function private.can_access_company(target_company_id uuid, target_organization_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := auth.uid();
begin
  if not exists (select 1 from public.company c where c.id = target_company_id
    and c.organization_id = target_organization_id and c.deleted_at is null) then return false; end if;
  if private.organization_mfa_satisfied(target_organization_id) is not true then return false; end if;
  return exists (select 1 from public.membership m where m.user_id = caller
    and m.organization_id = target_organization_id and (m.company_id = target_company_id
      or (m.company_id is null and m.role = 'administrator')))
    or private.can_administrate_platform();
end;
$$;
revoke execute on function private.can_access_company(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function private.can_access_company(uuid, uuid) to authenticated;

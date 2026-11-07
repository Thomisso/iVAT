-- The active Company and its Organization foreign key establish existence.
-- Its MFA/recovery check already gates every branch, including platform support,
-- so repeating that check through is_organization_administrator adds no authority.
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
    private.can_administrate_platform()
    or exists (
      select 1 from public.membership m
      where m.user_id = auth.uid() and m.organization_id = target_organization_id
        and m.company_id is null and m.role = 'administrator'
    )
    or exists (
      select 1 from public.membership m
      where m.user_id = auth.uid() and m.company_id = target_company_id
        and m.organization_id = target_organization_id
    )
  );
$$;

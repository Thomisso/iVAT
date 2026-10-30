create or replace function private.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  new_organization_id uuid;
  given_organization_name text;
  given_display_name text;
begin
  -- This marker is injected by the trusted Invitation claim guard, never by
  -- public user metadata. Invitation acceptance provisions its own Membership.
  if new.raw_app_meta_data ? 'ivat_invitation_claim' then
    return new;
  end if;

  -- Auth's global signup switch also refuses new OAuth identities. Keep the
  -- database atomic if an operator later enables a provider or changes Auth.
  if coalesce(new.raw_app_meta_data ->> 'provider', 'email') <> 'email' then
    raise exception using errcode = '42501', message = 'Public OAuth account creation is closed';
  end if;

  if exists (
    select 1 from public.invitation i
    where i.email = lower(new.email) and i.accepted_at is null and i.expires_at > now()
      and (to_jsonb(i) ->> 'cancelled_at') is null
      and (to_jsonb(i) ->> 'replaced_by') is null
  ) then
    return new;
  end if;

  given_organization_name := nullif(trim(new.raw_user_meta_data ->> 'organization_name'), '');
  given_display_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'name'), '')
  );
  insert into public.organization (name)
  values (coalesce(given_organization_name, given_display_name, new.email))
  returning id into new_organization_id;

  insert into public.membership (user_id, organization_id, role, email)
  values (new.id, new_organization_id, 'administrator', lower(new.email));

  perform private.record_audit_event(
    'user.signed_up', new_organization_id, null, 'user', new.id,
    jsonb_strip_nulls(jsonb_build_object('organization_name', given_organization_name)), new.id
  );
  return new;
end;
$$;

revoke all on function private.handle_new_user() from public, anon, authenticated;

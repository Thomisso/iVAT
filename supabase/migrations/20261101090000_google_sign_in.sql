-- OAuth providers do not send iVAT's organization_name metadata. Google sends
-- the user's display name as full_name/name, so use it before falling back to
-- the email address while preserving the same atomic Organization + Membership
-- creation path as email sign-up.

create or replace function private.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  new_organization_id uuid;
  given_organization_name text;
  oauth_display_name text;
begin
  given_organization_name := nullif(trim(new.raw_user_meta_data ->> 'organization_name'), '');
  oauth_display_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'name'), '')
  );

  insert into public.organization (name)
  values (coalesce(given_organization_name, oauth_display_name, new.email))
  returning id into new_organization_id;

  insert into public.membership (user_id, organization_id, role)
  values (new.id, new_organization_id, 'administrator');

  perform private.record_audit_event(
    'user.signed_up', new_organization_id, null, 'user', new.id,
    jsonb_strip_nulls(jsonb_build_object('organization_name', given_organization_name)),
    new.id
  );

  return new;
end;
$$;

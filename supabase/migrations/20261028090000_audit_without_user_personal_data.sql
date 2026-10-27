-- Audit payloads hold no personal data of Users (ADR-0009): the sign-up event
-- identifies the User by actor_user_id and target_id only. When no Organization
-- name was given, the Organization is named after the email, so the payload
-- then leaves the name out.

create or replace function private.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  new_organization_id uuid;
  given_organization_name text;
begin
  given_organization_name := nullif(trim(new.raw_user_meta_data ->> 'organization_name'), '');

  insert into public.organization (name)
  values (coalesce(given_organization_name, new.email))
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

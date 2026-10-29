-- Invitation onboarding distinguishes a User with durable Membership state
-- from the passwordless Auth user created only so local/hosted Supabase can
-- deliver the invitation email.

alter table public.invitation
  add column invitee_existed boolean not null default false;

create or replace function public.create_invitation(
  target_organization_id uuid,
  target_company_id uuid,
  target_email text,
  target_role public.membership_role
)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  normalized_email text := lower(trim(target_email));
  token text := gen_random_uuid()::text || gen_random_uuid()::text;
  invitation_id uuid;
begin
  if target_company_id is null then
    if target_role <> 'administrator' or not private.is_organization_administrator(target_organization_id) then
      raise insufficient_privilege;
    end if;
  elsif not exists (
    select 1 from public.company c
    where c.id = target_company_id and c.organization_id = target_organization_id
  ) or not private.is_company_administrator(target_company_id, target_organization_id) then
    raise insufficient_privilege;
  end if;

  insert into public.invitation (
    organization_id, company_id, email, role, token_hash, invitee_existed
  )
  values (
    target_organization_id,
    target_company_id,
    normalized_email,
    target_role,
    encode(extensions.digest(token, 'sha256'), 'hex'),
    exists (
      select 1
      from public.membership
      where lower(membership.email) = normalized_email
    )
  )
  returning id into invitation_id;

  perform private.record_audit_event(
    'invitation.created', target_organization_id, target_company_id,
    'invitation', invitation_id,
    jsonb_build_object('role', target_role, 'scope', case when target_company_id is null then 'organization' else 'company' end)
  );

  return token;
end;
$$;

create function public.invitation_onboarding(invitation_token text)
returns table (
  onboarding_status text,
  invitee_existed boolean,
  invitee_email text,
  target_company_id uuid
)
language plpgsql security definer set search_path = ''
as $$
declare
  target public.invitation;
begin
  select invitation.* into target
  from public.invitation invitation
  where invitation.token_hash = encode(extensions.digest(invitation_token, 'sha256'), 'hex');

  if target.id is null then
    return query select 'invalid'::text, null::boolean, null::text, null::uuid;
  elsif target.accepted_at is not null then
    return query select 'used'::text, null::boolean, null::text, null::uuid;
  elsif target.expires_at <= now() then
    return query select 'expired'::text, null::boolean, null::text, null::uuid;
  else
    return query select 'valid'::text, target.invitee_existed, target.email, target.company_id;
  end if;
end;
$$;

revoke execute on function public.invitation_onboarding(text) from public;
grant execute on function public.invitation_onboarding(text) to anon, authenticated;

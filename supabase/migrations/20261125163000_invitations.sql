-- Application capabilities live for seven days independently of Auth email OTPs.
-- Recoverable tokens are encrypted in Vault and returned only to scoped admins.
alter table public.invitation
  add column token_secret_id uuid references vault.secrets(id),
  add column cancelled_at timestamptz,
  add column replaced_by uuid references public.invitation(id);



create table private.invitation_acceptance_claim (
  id uuid primary key default gen_random_uuid(),
  invitation_id uuid not null references public.invitation(id),
  organization_id uuid not null references public.organization(id),
  company_id uuid,
  email text not null,
  expected_user_id uuid,
  provisioned_user_id uuid,
  state text not null default 'active' check (state in ('active', 'accepted', 'aborted', 'expired')),
  expires_at timestamptz not null default now() + interval '1 minute',
  foreign key (company_id, organization_id) references public.company(id, organization_id)
);
alter table private.invitation_acceptance_claim enable row level security;
revoke all on private.invitation_acceptance_claim from public, anon, authenticated, service_role;
create unique index invitation_active_email_claim on private.invitation_acceptance_claim(email) where state = 'active';



create function private.invitation_status(target public.invitation)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when target.id is null then 'invalid'
    when target.accepted_at is not null then 'used'
    when target.cancelled_at is not null then 'cancelled'
    when target.replaced_by is not null then 'replaced'
    when target.expires_at <= now() then 'expired'
    else 'valid' end;
$$;

revoke execute on function private.invitation_status(public.invitation) from public, anon, authenticated, service_role;

create function private.require_valid_invitation(target public.invitation)
returns void language plpgsql security definer set search_path = '' as $$
declare state text := private.invitation_status(target);
begin
  if state <> 'valid' then
    raise exception 'invitation unavailable' using errcode = 'P0001', hint = 'invitation_' || state;
  end if;
end;
$$;

revoke execute on function private.require_valid_invitation(public.invitation) from public, anon, authenticated, service_role;

create function private.accept_invitation_target(target_invitation_id uuid, acceptance_claim_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare target public.invitation; claim private.invitation_acceptance_claim; member_id uuid;
begin
  select * into target from public.invitation where id = target_invitation_id for update;
  perform private.require_valid_invitation(target);
  if auth.uid() is null or lower(coalesce(auth.jwt() ->> 'email', '')) <> target.email then
    raise insufficient_privilege;
  end if;
  if acceptance_claim_id is not null then
    select * into claim from private.invitation_acceptance_claim where id = acceptance_claim_id for update;
    if claim.id is null or claim.invitation_id <> target.id or claim.state <> 'active' or claim.expires_at <= now()
      or auth.uid() is distinct from coalesce(claim.expected_user_id, claim.provisioned_user_id) then
      raise insufficient_privilege;
    end if;
  elsif exists (
    select 1 from auth.users u join private.invitation_acceptance_claim c
      on c.id::text = u.raw_app_meta_data ->> 'ivat_invitation_claim'
    where u.id = auth.uid() and c.state <> 'accepted'
  ) then raise insufficient_privilege;
  end if;
  insert into public.membership(user_id, organization_id, company_id, role, email)
  values(auth.uid(), target.organization_id, target.company_id, target.role, target.email)
  on conflict (user_id, organization_id, company_id) do update set role = excluded.role, email = excluded.email
    returning id into member_id;
  update public.invitation set accepted_at = clock_timestamp(), accepted_by = auth.uid() where id = target.id;
  if acceptance_claim_id is not null then
    update private.invitation_acceptance_claim set state = 'accepted' where id = acceptance_claim_id;
  end if;
  perform private.record_audit_event('membership.created', target.organization_id, target.company_id,
    'membership', member_id, jsonb_build_object('role', target.role, 'user_id', auth.uid()));
end;
$$;

revoke execute on function private.accept_invitation_target(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.create_invitation(
  target_organization_id uuid, target_company_id uuid,
  target_email text, target_role public.membership_role
)
returns text language plpgsql security definer set search_path = '' as $$
declare
  normalized_email text := lower(trim(target_email));
  token text := encode(extensions.gen_random_bytes(32), 'hex');
  invitation_id uuid := gen_random_uuid();
  secret_id uuid;
begin
  if target_company_id is null then
    if target_role <> 'administrator' or not private.is_organization_administrator(target_organization_id) then
      raise insufficient_privilege;
    end if;
  elsif not exists (
    select 1 from public.company c
    where c.id = target_company_id and c.organization_id = target_organization_id
  ) or not private.can_administrate_company_memberships(target_company_id, target_organization_id) then
    raise insufficient_privilege;
  end if;
  if normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'invalid invitation' using errcode = 'P0001', hint = 'invalid_invitation';
  end if;

  secret_id := vault.create_secret(token, 'invitation_' || invitation_id::text, 'Invitation capability');
  insert into public.invitation (
    id, organization_id, company_id, email, role, token_hash, token_secret_id,
    invitee_existed
  ) values (
    invitation_id, target_organization_id, target_company_id, normalized_email,
    target_role, encode(extensions.digest(token, 'sha256'), 'hex'), secret_id,
    exists (select 1 from auth.users u where lower(u.email) = normalized_email)
  );
  perform private.record_audit_event(
    'invitation.created', target_organization_id, target_company_id,
    'invitation', invitation_id,
    jsonb_build_object('role', target_role, 'scope', case when target_company_id is null then 'organization' else 'company' end)
  );
  return token;
end;
$$;

create function public.list_pending_invitations(target_organization_id uuid, target_company_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id, 'email', i.email, 'role', i.role,
    'createdAt', i.created_at, 'expiresAt', i.expires_at,
    'status', case
      when i.cancelled_at is not null then 'cancelled'
      when i.replaced_by is not null then 'replaced'
      when i.expires_at <= now() then 'expired'
      else 'pending' end,
    'token', case when i.cancelled_at is null and i.replaced_by is null and i.expires_at > now()
      then secret.decrypted_secret else null end
  ) order by i.created_at, i.id), '[]'::jsonb)
  from public.invitation i
  left join vault.decrypted_secrets secret on secret.id = i.token_secret_id
  where i.organization_id = target_organization_id
    and i.company_id is not distinct from target_company_id
    and i.accepted_at is null
    and (private.is_organization_administrator(i.organization_id)
      or (i.company_id is not null and private.is_company_administrator(i.company_id, i.organization_id)));
$$;

revoke execute on function public.list_pending_invitations(uuid, uuid) from public, anon, authenticated, service_role;

grant execute on function public.list_pending_invitations(uuid, uuid) to authenticated;

create or replace function public.cancel_invitation_by_id(target_invitation_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare target public.invitation; claim_id uuid;
begin
  select * into target from public.invitation where id = target_invitation_id for update;
  if target.id is null or not (private.is_organization_administrator(target.organization_id)
    or (target.company_id is not null and private.is_company_administrator(target.company_id, target.organization_id))) then
    raise insufficient_privilege;
  end if;
  if target.cancelled_at is not null then return; end if;
  if target.accepted_at is not null or target.replaced_by is not null then
    perform private.require_valid_invitation(target);
  end if;
  update public.invitation set cancelled_at = clock_timestamp() where id = target.id;
  for claim_id in select id from private.invitation_acceptance_claim
    where invitation_id = target.id and state = 'active'
  loop perform public.abort_invitation_acceptance(claim_id); end loop;
  perform private.record_audit_event('invitation.cancelled', target.organization_id,
    target.company_id, 'invitation', target.id, '{}'::jsonb);
end;
$$;

revoke execute on function public.cancel_invitation_by_id(uuid) from public, anon, authenticated, service_role;

grant execute on function public.cancel_invitation_by_id(uuid) to authenticated;

create or replace function public.cancel_invitation(invitation_token text)
returns void language plpgsql security definer set search_path = '' as $$
declare target_id uuid;
begin
  select id into target_id from public.invitation
    where token_hash = encode(extensions.digest(invitation_token, 'sha256'), 'hex');
  perform public.cancel_invitation_by_id(target_id);
end;
$$;

create or replace function public.invitation_onboarding(invitation_token text)
returns table (onboarding_status text, invitee_existed boolean, invitee_email text, target_company_id uuid)
language plpgsql security definer set search_path = '' as $$
declare target public.invitation; state text;
begin
  select * into target from public.invitation
    where token_hash = encode(extensions.digest(invitation_token, 'sha256'), 'hex');
  state := private.invitation_status(target);
  if state <> 'valid' then
    return query select state, null::boolean, null::text, null::uuid;
  else
    return query select 'valid'::text,
      exists(select 1 from auth.users u where lower(u.email) = target.email),
      target.email, target.company_id;
  end if;
end;
$$;

create or replace function public.accept_invitation(invitation_token text)
returns void language plpgsql security definer set search_path = '' as $$
declare target_id uuid;
begin
  select id into target_id from public.invitation
    where token_hash = encode(extensions.digest(invitation_token, 'sha256'), 'hex');
  perform private.accept_invitation_target(target_id, null);
end;
$$;

create or replace function public.replace_invitation(target_invitation_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare target public.invitation; token text; replacement_id uuid; claim_id uuid;
begin
  select * into target from public.invitation where id = target_invitation_id for update;
  if target.id is null or not (private.is_organization_administrator(target.organization_id)
    or (target.company_id is not null and private.is_company_administrator(target.company_id, target.organization_id))) then
    raise insufficient_privilege;
  end if;
  -- An expired offer can be renewed, but a terminal invitation stays terminal.
  if target.accepted_at is not null or target.cancelled_at is not null or target.replaced_by is not null then
    perform private.require_valid_invitation(target);
  end if;
  token := public.create_invitation(target.organization_id, target.company_id, target.email, target.role);
  select id into replacement_id from public.invitation
    where token_hash = encode(extensions.digest(token, 'sha256'), 'hex');
  update public.invitation set replaced_by = replacement_id where id = target.id;
  for claim_id in select id from private.invitation_acceptance_claim
    where invitation_id = target.id and state = 'active'
  loop perform public.abort_invitation_acceptance(claim_id); end loop;
  perform private.record_audit_event('invitation.replaced', target.organization_id, target.company_id,
    'invitation', target.id, jsonb_build_object('replacement_id', replacement_id));
  return token;
end;
$$;

revoke execute on function public.replace_invitation(uuid) from public, anon, authenticated, service_role;

grant execute on function public.replace_invitation(uuid) to authenticated;

create function public.begin_invitation_acceptance(invitation_token text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare target public.invitation; claim_id uuid; expired_claim_id uuid; existing_user_id uuid;
begin
  select * into target from public.invitation
    where token_hash = encode(extensions.digest(invitation_token, 'sha256'), 'hex');
  perform private.require_valid_invitation(target);
  -- All acceptance starts take the email lock before any invitation row lock.
  -- This also permits safe cleanup of an interrupted older claim for this email.
  perform pg_advisory_xact_lock(hashtextextended(target.email, 166));
  select * into target from public.invitation where id = target.id for update;
  perform private.require_valid_invitation(target);
  for expired_claim_id in select id from private.invitation_acceptance_claim
    where email = target.email and state = 'active' and expires_at <= now()
  loop perform public.abort_invitation_acceptance(expired_claim_id); end loop;
  if exists(select 1 from private.invitation_acceptance_claim where email = target.email and state = 'active') then
    raise exception 'acceptance in progress' using errcode = 'P0001', hint = 'invitation_busy';
  end if;
  select u.id into existing_user_id from auth.users u where lower(u.email) = target.email;
  insert into private.invitation_acceptance_claim(invitation_id, organization_id, company_id, email, expected_user_id, provisioned_user_id)
  values (target.id, target.organization_id, target.company_id, target.email, existing_user_id,
    case when existing_user_id is null then gen_random_uuid() else null end) returning id into claim_id;
  return claim_id;
end;
$$;

revoke execute on function public.begin_invitation_acceptance(text) from public, anon, authenticated, service_role;

grant execute on function public.begin_invitation_acceptance(text) to anon, authenticated;

create function public.invitation_authentication_authority(acceptance_claim_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare claim private.invitation_acceptance_claim; target public.invitation;
begin
  select * into claim from private.invitation_acceptance_claim where id = acceptance_claim_id;
  if claim.id is null or claim.state <> 'active' or claim.expires_at <= now() then
    raise insufficient_privilege;
  end if;
  select * into target from public.invitation where id = claim.invitation_id;
  perform private.require_valid_invitation(target);
  return jsonb_build_object('email', claim.email, 'existingUserId', claim.expected_user_id, 'newUserId', claim.provisioned_user_id);
end;
$$;

revoke execute on function public.invitation_authentication_authority(uuid) from public, anon, authenticated, service_role;

grant execute on function public.invitation_authentication_authority(uuid) to service_role;

create function private.guard_invitation_identity_creation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare claim_id uuid; claim private.invitation_acceptance_claim; target public.invitation;
begin
  select id into claim_id from private.invitation_acceptance_claim where provisioned_user_id = new.id;
  if claim_id is null then return new; end if;
  select i.* into target from public.invitation i join private.invitation_acceptance_claim c on c.invitation_id = i.id
    where c.id = claim_id for update of i;
  perform private.require_valid_invitation(target);
  select * into claim from private.invitation_acceptance_claim where id = claim_id for update;
  if claim.state <> 'active' or claim.expires_at <= now() or claim.expected_user_id is not null
    or claim.provisioned_user_id <> new.id or lower(new.email) <> claim.email then
    raise insufficient_privilege;
  end if;
  -- GoTrue applies caller app_metadata after the initial INSERT. Bind the private
  -- reserved id here and inject the trusted origin before tenant creation runs.
  new.raw_app_meta_data := coalesce(new.raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('ivat_invitation_claim', claim.id::text);
  return new;
end;
$$;

revoke execute on function private.guard_invitation_identity_creation() from public, anon, authenticated, service_role;

create or replace function public.complete_invitation_acceptance(acceptance_claim_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare target_id uuid;
begin
  select invitation_id into target_id from private.invitation_acceptance_claim where id = acceptance_claim_id;
  perform private.accept_invitation_target(target_id, acceptance_claim_id);
end;
$$;

revoke execute on function public.complete_invitation_acceptance(uuid) from public, anon, authenticated, service_role;

grant execute on function public.complete_invitation_acceptance(uuid) to authenticated;

create function public.abort_invitation_acceptance(acceptance_claim_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare claim private.invitation_acceptance_claim; target public.invitation; orphan auth.users;
begin
  select i.* into target from public.invitation i join private.invitation_acceptance_claim c on c.invitation_id = i.id
    where c.id = acceptance_claim_id for update of i;
  select * into claim from private.invitation_acceptance_claim where id = acceptance_claim_id for update;
  if claim.id is null or claim.state = 'accepted' then return; end if;
  update private.invitation_acceptance_claim set state = case when expires_at <= now() then 'expired' else 'aborted' end where id = claim.id;
  if claim.expected_user_id is not null or claim.provisioned_user_id is null then return; end if;
  select * into orphan from auth.users where id = claim.provisioned_user_id for update;
  if orphan.raw_app_meta_data ->> 'ivat_invitation_claim' = claim.id::text
    and not exists(select 1 from public.membership where user_id = orphan.id) then
    -- Delete only the identity created by this exact claim, under its row lock.
    -- Auth's foreign keys remove its temporary sessions/identities atomically.
    delete from auth.users where id = orphan.id;
  end if;
end;
$$;

revoke execute on function public.abort_invitation_acceptance(uuid) from public, anon, authenticated, service_role;

grant execute on function public.abort_invitation_acceptance(uuid) to service_role;

create or replace function private.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  new_organization_id uuid;
  given_organization_name text;
  oauth_display_name text;
begin
  if new.raw_app_meta_data ->> 'ivat_invitation_claim' is not null then return new; end if;
  if exists (
    select 1 from public.invitation i
    where i.email = lower(new.email) and i.accepted_at is null and i.expires_at > now()
      and to_jsonb(i) ->> 'cancelled_at' is null and to_jsonb(i) ->> 'replaced_by' is null
  ) then
    return new;
  end if;

  given_organization_name := nullif(trim(new.raw_user_meta_data ->> 'organization_name'), '');
  oauth_display_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'name'), '')
  );
  insert into public.organization (name)
  values (coalesce(given_organization_name, oauth_display_name, new.email))
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

create or replace function public.current_mfa_policy()
returns table (required boolean, enrolled boolean, satisfied boolean)
language sql stable security definer set search_path = '' as $$
  with policy as (
    select private.is_super_admin(auth.uid()) or exists (
      select 1 from public.membership m join public.organization o on o.id = m.organization_id
      where m.user_id = auth.uid() and o.mfa_required
    ) as required,
    private.current_user_has_totp() as enrolled
  )
  select policy.required, policy.enrolled,
    not (policy.required or policy.enrolled) or private.current_user_mfa_satisfied()
  from policy;
$$;

create trigger guard_invitation_identity_creation before insert on auth.users
  for each row execute function private.guard_invitation_identity_creation();

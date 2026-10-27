-- Invitations and Membership management (#23). Access and Role checks stay in
-- the database so every caller observes the same authorization rules.

alter table public.membership add column email text;

update public.membership m
set email = lower(u.email)
from auth.users u
where u.id = m.user_id;

alter table public.membership
  alter column email set not null,
  add constraint membership_email_normalized check (email = lower(trim(email)));

create table public.invitation (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organization (id),
  company_id uuid,
  email text not null check (email = lower(trim(email)) and position('@' in email) > 1),
  role public.membership_role not null,
  token_hash text not null unique,
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id),
  created_by uuid not null default auth.uid() references auth.users (id),
  created_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.company (id, organization_id),
  check (company_id is not null or role = 'administrator')
);

create index invitation_organization_id_idx on public.invitation (organization_id);
create index invitation_email_idx on public.invitation (email) where accepted_at is null;

revoke all on public.invitation from anon, authenticated, service_role;
alter table public.invitation enable row level security;

drop policy "users read own memberships; organization administrators read all" on public.membership;
create policy "users read own memberships; administrators read their scope" on public.membership
  for select to authenticated
  using (
    user_id = auth.uid()
    or private.is_organization_administrator(organization_id)
    or (company_id is not null and private.is_company_administrator(company_id, organization_id))
  );

create policy "administrators read invitations in their scope" on public.invitation
  for select to authenticated
  using (
    private.is_organization_administrator(organization_id)
    or (company_id is not null and private.is_company_administrator(company_id, organization_id))
  );

grant select on public.invitation to authenticated;

create function public.create_invitation(
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

  insert into public.invitation (organization_id, company_id, email, role, token_hash)
  values (
    target_organization_id,
    target_company_id,
    normalized_email,
    target_role,
    encode(extensions.digest(token, 'sha256'), 'hex')
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
revoke execute on function public.create_invitation from public, anon;
grant execute on function public.create_invitation(uuid, uuid, text, public.membership_role) to authenticated;

create function public.cancel_invitation(invitation_token text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  cancelled public.invitation;
begin
  delete from public.invitation i
  where i.token_hash = encode(extensions.digest(invitation_token, 'sha256'), 'hex')
    and i.created_by = auth.uid()
    and i.accepted_at is null
  returning * into cancelled;
  if cancelled.id is null then raise insufficient_privilege; end if;
  perform private.record_audit_event(
    'invitation.cancelled', cancelled.organization_id, cancelled.company_id,
    'invitation', cancelled.id, '{}'
  );
end;
$$;
revoke execute on function public.cancel_invitation from public, anon;
grant execute on function public.cancel_invitation(text) to authenticated;

create function public.accept_invitation(invitation_token text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  pending public.invitation;
  accepting_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  membership_id uuid;
begin
  select * into pending
  from public.invitation i
  where i.token_hash = encode(extensions.digest(invitation_token, 'sha256'), 'hex')
  for update;

  if pending.id is null then
    raise exception 'invalid invitation' using errcode = 'P0001', hint = 'invitation_invalid';
  end if;
  if pending.accepted_at is not null then
    raise exception 'used invitation' using errcode = 'P0001', hint = 'invitation_used';
  end if;
  if pending.expires_at <= now() then
    raise exception 'expired invitation' using errcode = 'P0001', hint = 'invitation_expired';
  end if;
  if auth.uid() is null or accepting_email <> pending.email then
    raise insufficient_privilege;
  end if;

  insert into public.membership (user_id, organization_id, company_id, role, email)
  values (auth.uid(), pending.organization_id, pending.company_id, pending.role, accepting_email)
  on conflict (user_id, organization_id, company_id)
  do update set role = excluded.role, email = excluded.email
  returning id into membership_id;

  update public.invitation
  set accepted_at = now(), accepted_by = auth.uid()
  where id = pending.id;

  perform private.record_audit_event(
    'membership.created', pending.organization_id, pending.company_id,
    'membership', membership_id,
    jsonb_build_object('role', pending.role, 'user_id', auth.uid())
  );
end;
$$;

revoke execute on function public.accept_invitation from public, anon;
grant execute on function public.accept_invitation(text) to authenticated;

create function public.change_membership_role(
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
  select * into target from public.membership where id = target_membership_id for update;
  if target.id is null then raise insufficient_privilege; end if;
  if target.company_id is null then
    if target_role <> 'administrator' or not private.is_organization_administrator(target.organization_id) then
      raise insufficient_privilege;
    end if;
  elsif not private.is_company_administrator(target.company_id, target.organization_id) then
    raise insufficient_privilege;
  end if;

  old_role := target.role;
  update public.membership set role = target_role where id = target.id;
  perform private.record_audit_event(
    'membership.role_changed', target.organization_id, target.company_id,
    'membership', target.id,
    jsonb_build_object('user_id', target.user_id, 'old_role', old_role, 'new_role', target_role)
  );
end;
$$;

revoke execute on function public.change_membership_role from public, anon;
grant execute on function public.change_membership_role(uuid, public.membership_role) to authenticated;

create function public.remove_membership(target_membership_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target public.membership;
begin
  select * into target from public.membership where id = target_membership_id for update;
  if target.id is null then raise insufficient_privilege; end if;
  if target.company_id is null then
    if not private.is_organization_administrator(target.organization_id) then raise insufficient_privilege; end if;
  elsif not private.is_company_administrator(target.company_id, target.organization_id) then
    raise insufficient_privilege;
  end if;

  delete from public.membership where id = target.id;
  perform private.record_audit_event(
    'membership.removed', target.organization_id, target.company_id,
    'membership', target.id,
    jsonb_build_object('user_id', target.user_id, 'role', target.role)
  );
end;
$$;

revoke execute on function public.remove_membership from public, anon;
grant execute on function public.remove_membership(uuid) to authenticated;

-- Invited auth users join through accept_invitation instead of receiving an
-- unrelated Organization of their own.
create or replace function private.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  new_organization_id uuid;
  given_organization_name text;
  oauth_display_name text;
begin
  if exists (
    select 1 from public.invitation i
    where i.email = lower(new.email) and i.accepted_at is null and i.expires_at > now()
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

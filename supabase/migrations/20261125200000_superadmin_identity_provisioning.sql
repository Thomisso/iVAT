-- Reserve a native Auth id before GoTrue inserts it. Caller app_metadata is
-- applied only after INSERT, so it cannot safely select tenant provisioning.
create table private.superadmin_identity_reservation (
  user_id uuid primary key default gen_random_uuid(),
  email text not null,
  released boolean not null default false,
  expires_at timestamptz not null default now() + interval '10 minutes'
);
revoke all on private.superadmin_identity_reservation from public, anon, authenticated, service_role;

create function public.reserve_superadmin_identity(target_email text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare reserved_id uuid;
begin
  if nullif(btrim(target_email), '') is null then raise invalid_parameter_value; end if;
  update private.superadmin_identity_reservation set released = true, email = ''
    where expires_at <= now() and not released;
  insert into private.superadmin_identity_reservation(email)
    values (lower(btrim(target_email))) returning user_id into reserved_id;
  return reserved_id;
end;
$$;
revoke execute on function public.reserve_superadmin_identity(text) from public, anon, authenticated, service_role;
grant execute on function public.reserve_superadmin_identity(text) to service_role;

create function public.release_superadmin_identity(reserved_user_id uuid)
returns void language sql security definer set search_path = '' as $$
  -- Keep the retired id so a delayed Auth request cannot fall through to
  -- ordinary tenant provisioning after cleanup. No email needs to be retained.
  update private.superadmin_identity_reservation set released = true, email = ''
    where user_id = reserved_user_id;
$$;
revoke execute on function public.release_superadmin_identity(uuid) from public, anon, authenticated, service_role;
grant execute on function public.release_superadmin_identity(uuid) to service_role;

create function private.guard_superadmin_identity_creation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare reservation private.superadmin_identity_reservation;
begin
  select * into reservation from private.superadmin_identity_reservation
    where user_id = new.id for update;
  if not found then return new; end if;
  if reservation.released or reservation.expires_at <= now()
    or reservation.email is distinct from lower(new.email) then
    raise insufficient_privilege;
  end if;
  return new;
end;
$$;
revoke execute on function private.guard_superadmin_identity_creation() from public, anon, authenticated, service_role;
create trigger guard_superadmin_identity_creation before insert on auth.users
  for each row execute function private.guard_superadmin_identity_creation();

create or replace function private.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  new_organization_id uuid;
  given_organization_name text;
  given_display_name text;
begin
  -- The reservation only suppresses synthetic tenancy; platform authority is
  -- still granted separately by the trusted bootstrap command after Auth.
  if exists (select 1 from private.superadmin_identity_reservation r
    where r.user_id = new.id and r.email = lower(new.email) and not r.released and r.expires_at > now()) then
    return new;
  end if;

  -- Injected by the trusted Invitation claim guard, never public user metadata.
  if new.raw_app_meta_data ? 'ivat_invitation_claim' then return new; end if;

  if coalesce(new.raw_app_meta_data ->> 'provider', 'email') <> 'email' then
    raise exception using errcode = '42501', message = 'Public OAuth account creation is closed';
  end if;

  if exists (
    select 1 from public.invitation i
    where i.email = lower(new.email) and i.accepted_at is null and i.expires_at > now()
      and (to_jsonb(i) ->> 'cancelled_at') is null
      and (to_jsonb(i) ->> 'replaced_by') is null
  ) then return new; end if;

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

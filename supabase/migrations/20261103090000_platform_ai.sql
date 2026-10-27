-- Platform AI settings (#28): only SuperAdmins configure provider availability,
-- models and encrypted platform keys. Authenticated clients never receive a key.

create extension if not exists supabase_vault with schema vault;

create function private.is_super_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role' = 'super_admin', false);
$$;

revoke execute on function private.is_super_admin() from public;
grant execute on function private.is_super_admin() to authenticated;

create table public.platform_ai_provider (
  provider text primary key,
  available boolean not null default false,
  split_model text not null,
  extract_model text not null,
  platform_key_secret_id uuid,
  platform_key_last_four text,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  check (length(trim(provider)) > 0),
  check (length(trim(split_model)) > 0),
  check (length(trim(extract_model)) > 0),
  check ((platform_key_secret_id is null) = (platform_key_last_four is null)),
  check (platform_key_last_four is null or length(platform_key_last_four) = 4)
);

insert into public.platform_ai_provider (provider, split_model, extract_model)
values ('anthropic', 'claude-sonnet-4-5', 'claude-sonnet-4-5');

revoke all on public.platform_ai_provider from anon, authenticated, service_role;
grant select on public.platform_ai_provider to service_role;
alter table public.platform_ai_provider enable row level security;

create function public.configure_platform_ai_provider(
  target_provider text,
  provider_available boolean,
  target_split_model text,
  target_extract_model text,
  platform_key text default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  settings public.platform_ai_provider;
  secret_id uuid;
begin
  if not private.is_super_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if length(trim(target_split_model)) = 0 or length(trim(target_extract_model)) = 0 then
    raise exception 'model required' using errcode = 'P0001', hint = 'model_required';
  end if;

  select * into settings
  from public.platform_ai_provider p
  where p.provider = target_provider
  for update;
  if not found then
    raise exception 'unknown provider' using errcode = 'P0001', hint = 'unknown_provider';
  end if;

  secret_id := settings.platform_key_secret_id;
  if platform_key is not null then
    if length(platform_key) < 4 then
      raise exception 'invalid key' using errcode = 'P0001', hint = 'invalid_platform_key';
    end if;
    if secret_id is null then
      secret_id := vault.create_secret(
        platform_key,
        'platform_ai_' || target_provider,
        'iVAT platform key for ' || target_provider
      );
    else
      perform vault.update_secret(secret_id, platform_key);
    end if;
  end if;

  update public.platform_ai_provider
  set available = provider_available,
      split_model = trim(target_split_model),
      extract_model = trim(target_extract_model),
      platform_key_secret_id = secret_id,
      platform_key_last_four = case
        when platform_key is not null then right(platform_key, 4)
        else settings.platform_key_last_four
      end,
      updated_at = now(),
      updated_by = auth.uid()
  where provider = target_provider;
end;
$$;

revoke execute on function public.configure_platform_ai_provider(text, boolean, text, text, text)
  from public, anon;
grant execute on function public.configure_platform_ai_provider(text, boolean, text, text, text)
  to authenticated;

create function public.list_platform_ai_providers()
returns table (
  provider text,
  available boolean,
  split_model text,
  extract_model text,
  has_platform_key boolean,
  platform_key_last_four text
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_super_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select p.provider, p.available, p.split_model, p.extract_model,
      p.platform_key_secret_id is not null, p.platform_key_last_four
    from public.platform_ai_provider p
    order by p.provider;
end;
$$;

revoke execute on function public.list_platform_ai_providers() from public, anon;
grant execute on function public.list_platform_ai_providers() to authenticated;

create table public.organization_platform_ai_access (
  organization_id uuid not null references public.organization (id) on delete cascade,
  provider text not null references public.platform_ai_provider (provider) on delete cascade,
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (organization_id, provider)
);

revoke all on public.organization_platform_ai_access from anon, authenticated, service_role;
grant select on public.organization_platform_ai_access to service_role;
alter table public.organization_platform_ai_access enable row level security;

create function public.list_platform_organizations(target_provider text)
returns table (
  id uuid,
  name text,
  platform_key_enabled boolean
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_super_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select o.id, o.name, coalesce(a.enabled, false)
    from public.organization o
    left join public.organization_platform_ai_access a
      on a.organization_id = o.id and a.provider = target_provider
    order by o.name, o.id;
end;
$$;

revoke execute on function public.list_platform_organizations(text) from public, anon;
grant execute on function public.list_platform_organizations(text) to authenticated;

create function public.set_organization_platform_ai_access(
  target_organization_id uuid,
  target_provider text,
  access_enabled boolean
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_super_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.organization_platform_ai_access (
    organization_id, provider, enabled, updated_at, updated_by
  ) values (
    target_organization_id, target_provider, access_enabled, now(), auth.uid()
  )
  on conflict (organization_id, provider) do update
  set enabled = excluded.enabled,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by;
end;
$$;

revoke execute on function public.set_organization_platform_ai_access(uuid, text, boolean)
  from public, anon;
grant execute on function public.set_organization_platform_ai_access(uuid, text, boolean)
  to authenticated;

-- The worker is the only caller that can decrypt a platform key. The function
-- refuses unless the provider and this Organization are both enabled.
create function public.resolve_platform_ai_provider(
  target_organization_id uuid,
  target_provider text
)
returns table (api_key text, split_model text, extract_model text)
language plpgsql stable security definer set search_path = ''
as $$
declare
  settings public.platform_ai_provider;
  access_enabled boolean;
begin
  select * into settings
  from public.platform_ai_provider p
  where p.provider = target_provider;

  if not found or not settings.available then
    raise exception 'provider unavailable' using errcode = 'P0001', hint = 'provider_unavailable';
  end if;
  if settings.platform_key_secret_id is null then
    raise exception 'platform key not configured' using errcode = 'P0001', hint = 'platform_key_not_configured';
  end if;
  select a.enabled into access_enabled
  from public.organization_platform_ai_access a
  where a.organization_id = target_organization_id and a.provider = target_provider;
  if not coalesce(access_enabled, false) then
    raise exception 'platform key not enabled' using errcode = 'P0001', hint = 'platform_key_not_enabled';
  end if;

  return query
    select v.decrypted_secret, settings.split_model, settings.extract_model
    from vault.decrypted_secrets v
    where v.id = settings.platform_key_secret_id;
end;
$$;

revoke execute on function public.resolve_platform_ai_provider(uuid, text)
  from public, anon, authenticated;
grant execute on function public.resolve_platform_ai_provider(uuid, text)
  to service_role;

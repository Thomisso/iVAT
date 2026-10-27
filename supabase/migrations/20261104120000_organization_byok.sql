-- Organization AI keys (#30): Organization Administrators manage provider
-- credentials, while only the worker may decrypt the selected credential.

create table public.organization_ai_provider_key (
  organization_id uuid not null references public.organization (id) on delete cascade,
  provider text not null references public.platform_ai_provider (provider) on delete cascade,
  key_secret_id uuid not null unique,
  key_last_four text not null check (length(key_last_four) = 4),
  dpa_acknowledged_at timestamptz not null,
  dpa_acknowledged_by uuid not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null,
  primary key (organization_id, provider)
);

revoke all on public.organization_ai_provider_key from anon, authenticated, service_role;
alter table public.organization_ai_provider_key enable row level security;

create function public.save_organization_ai_provider_key(
  target_organization_id uuid,
  target_provider text,
  organization_key text,
  dpa_acknowledged boolean
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  existing public.organization_ai_provider_key;
  secret_id uuid;
begin
  if not private.is_organization_administrator(target_organization_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not dpa_acknowledged then
    raise exception 'DPA acknowledgement required'
      using errcode = 'P0001', hint = 'dpa_acknowledgement_required';
  end if;
  if length(organization_key) < 4 then
    raise exception 'invalid Organization key'
      using errcode = 'P0001', hint = 'invalid_organization_key';
  end if;
  if not exists (
    select 1 from public.platform_ai_provider p where p.provider = target_provider
  ) then
    raise exception 'unknown provider'
      using errcode = 'P0001', hint = 'unknown_provider';
  end if;

  select * into existing
  from public.organization_ai_provider_key k
  where k.organization_id = target_organization_id
    and k.provider = target_provider
  for update;

  if found then
    secret_id := existing.key_secret_id;
    perform vault.update_secret(secret_id, organization_key);
  else
    secret_id := vault.create_secret(
      organization_key,
      'organization_ai_' || target_organization_id::text || '_' || target_provider,
      'iVAT Organization key for ' || target_provider
    );
  end if;

  insert into public.organization_ai_provider_key (
    organization_id,
    provider,
    key_secret_id,
    key_last_four,
    dpa_acknowledged_at,
    dpa_acknowledged_by,
    updated_at,
    updated_by
  ) values (
    target_organization_id,
    target_provider,
    secret_id,
    right(organization_key, 4),
    now(),
    auth.uid(),
    now(),
    auth.uid()
  )
  on conflict (organization_id, provider) do update
  set key_last_four = excluded.key_last_four,
      dpa_acknowledged_at = excluded.dpa_acknowledged_at,
      dpa_acknowledged_by = excluded.dpa_acknowledged_by,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by;

  perform private.record_audit_event(
    'organization_ai_key.saved',
    target_organization_id,
    null,
    'organization_ai_key',
    target_organization_id,
    jsonb_build_object('provider', target_provider, 'dpa_acknowledged', true)
  );
end;
$$;

revoke execute on function public.save_organization_ai_provider_key(uuid, text, text, boolean)
  from public, anon;
grant execute on function public.save_organization_ai_provider_key(uuid, text, text, boolean)
  to authenticated;

create function public.list_organization_ai_provider_keys(target_organization_id uuid)
returns table (
  provider text,
  has_organization_key boolean,
  organization_key_last_four text
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_organization_administrator(target_organization_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select p.provider, k.key_secret_id is not null, k.key_last_four
    from public.platform_ai_provider p
    left join public.organization_ai_provider_key k
      on k.organization_id = target_organization_id
      and k.provider = p.provider
    order by p.provider;
end;
$$;

revoke execute on function public.list_organization_ai_provider_keys(uuid) from public, anon;
grant execute on function public.list_organization_ai_provider_keys(uuid) to authenticated;

create function public.remove_organization_ai_provider_key(
  target_organization_id uuid,
  target_provider text
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  secret_id uuid;
begin
  if not private.is_organization_administrator(target_organization_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  delete from public.organization_ai_provider_key k
  where k.organization_id = target_organization_id
    and k.provider = target_provider
  returning k.key_secret_id into secret_id;

  if secret_id is not null then
    delete from vault.secrets v where v.id = secret_id;
    perform private.record_audit_event(
      'organization_ai_key.removed',
      target_organization_id,
      null,
      'organization_ai_key',
      target_organization_id,
      jsonb_build_object('provider', target_provider)
    );
  end if;
end;
$$;

revoke execute on function public.remove_organization_ai_provider_key(uuid, text)
  from public, anon;
grant execute on function public.remove_organization_ai_provider_key(uuid, text)
  to authenticated;

-- Organization keys take precedence. Only if none is set do the platform-key
-- availability, presence and per-Organization enablement gates apply.
create or replace function public.resolve_platform_ai_provider(
  target_organization_id uuid,
  target_provider text
)
returns table (api_key text, split_model text, extract_model text)
language plpgsql stable security definer set search_path = ''
as $$
declare
  settings public.platform_ai_provider;
  organization_key public.organization_ai_provider_key;
  access_enabled boolean;
begin
  select * into settings
  from public.platform_ai_provider p
  where p.provider = target_provider;

  if not found or not settings.available then
    raise exception 'provider unavailable' using errcode = 'P0001', hint = 'provider_unavailable';
  end if;

  select * into organization_key
  from public.organization_ai_provider_key k
  where k.organization_id = target_organization_id
    and k.provider = target_provider;

  if found then
    return query
      select v.decrypted_secret, settings.split_model, settings.extract_model
      from vault.decrypted_secrets v
      where v.id = organization_key.key_secret_id;
    return;
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

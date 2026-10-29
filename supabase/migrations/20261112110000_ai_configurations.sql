-- Platform-owned AI Configurations (#98). This is an expand migration: the
-- existing provider/Organization credential path remains intact while a
-- Company assignment takes precedence in worker resolution.

alter table public.audit_event
  alter column organization_id drop not null;

-- Policies execute as the caller; authenticated already has private schema
-- usage, but this predicate was previously called only by definer functions.
grant execute on function private.can_administrate_platform() to authenticated;

create policy "SuperAdmins read the platform audit log" on public.audit_event
  for select to authenticated
  using (
    organization_id is null
    and private.can_administrate_platform()
  );

create table public.ai_configuration (
  id uuid primary key default gen_random_uuid(),
  label text not null unique,
  provider text not null references public.platform_ai_provider (provider) on delete restrict,
  split_model text not null,
  extract_model text not null,
  credential_secret_id uuid not null unique,
  credential_last_four text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  check (length(trim(label)) > 0),
  check (length(trim(split_model)) > 0),
  check (length(trim(extract_model)) > 0),
  check (length(credential_last_four) = 4)
);

create unique index ai_configuration_one_default_idx
  on public.ai_configuration (is_default)
  where is_default;

revoke all on public.ai_configuration from anon, authenticated, service_role;
alter table public.ai_configuration enable row level security;

create table public.company_ai_configuration (
  company_id uuid primary key references public.company (id) on delete cascade,
  configuration_id uuid not null references public.ai_configuration (id) on delete restrict,
  assigned_at timestamptz not null default now(),
  assigned_by uuid
);

create index company_ai_configuration_configuration_id_idx
  on public.company_ai_configuration (configuration_id, company_id);

revoke all on public.company_ai_configuration from anon, authenticated, service_role;
alter table public.company_ai_configuration enable row level security;

create function private.assign_default_ai_configuration()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  default_configuration_id uuid;
begin
  select id into default_configuration_id
  from public.ai_configuration
  where is_default;

  if default_configuration_id is not null then
    insert into public.company_ai_configuration (
      company_id, configuration_id, assigned_at, assigned_by
    ) values (
      new.id, default_configuration_id, now(), null
    )
    on conflict (company_id) do nothing;
  end if;

  return new;
end;
$$;

revoke execute on function private.assign_default_ai_configuration() from public;

create trigger company_assign_default_ai_configuration
  after insert on public.company
  for each row execute function private.assign_default_ai_configuration();

create function private.record_ai_configuration_audit_event(
  event_action text,
  target_configuration_id uuid,
  event_payload jsonb
)
returns void
language sql security definer set search_path = ''
as $$
  select private.record_audit_event(
    event_action,
    null,
    null,
    'ai_configuration',
    target_configuration_id,
    event_payload
  );
$$;

revoke execute on function private.record_ai_configuration_audit_event(text, uuid, jsonb)
  from public;

create function public.create_ai_configuration(
  configuration_label text,
  target_provider text,
  target_split_model text,
  target_extract_model text,
  provider_credential text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  configuration_id uuid := gen_random_uuid();
  secret_id uuid;
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if length(trim(configuration_label)) = 0 then
    raise exception 'label required' using errcode = 'P0001', hint = 'label_required';
  end if;
  if length(trim(target_split_model)) = 0 or length(trim(target_extract_model)) = 0 then
    raise exception 'model required' using errcode = 'P0001', hint = 'model_required';
  end if;
  if length(provider_credential) < 4 then
    raise exception 'invalid credential' using errcode = 'P0001', hint = 'invalid_credential';
  end if;
  if not exists (
    select 1 from public.platform_ai_provider provider
    where provider.provider = target_provider
  ) then
    raise exception 'unknown provider' using errcode = 'P0001', hint = 'unknown_provider';
  end if;

  secret_id := vault.create_secret(
    provider_credential,
    'ai_configuration_' || configuration_id::text,
    'iVAT AI Configuration credential'
  );

  insert into public.ai_configuration (
    id,
    label,
    provider,
    split_model,
    extract_model,
    credential_secret_id,
    credential_last_four,
    created_by,
    updated_by
  ) values (
    configuration_id,
    trim(configuration_label),
    target_provider,
    trim(target_split_model),
    trim(target_extract_model),
    secret_id,
    right(provider_credential, 4),
    auth.uid(),
    auth.uid()
  );

  perform private.record_ai_configuration_audit_event(
    'ai_configuration.created',
    configuration_id,
    jsonb_build_object('label', trim(configuration_label), 'provider', target_provider)
  );
  return configuration_id;
end;
$$;

create function public.update_ai_configuration(
  target_configuration_id uuid,
  configuration_label text,
  target_provider text,
  target_split_model text,
  target_extract_model text,
  provider_credential text default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  configuration public.ai_configuration;
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if length(trim(configuration_label)) = 0 then
    raise exception 'label required' using errcode = 'P0001', hint = 'label_required';
  end if;
  if length(trim(target_split_model)) = 0 or length(trim(target_extract_model)) = 0 then
    raise exception 'model required' using errcode = 'P0001', hint = 'model_required';
  end if;
  if provider_credential is not null and length(provider_credential) < 4 then
    raise exception 'invalid credential' using errcode = 'P0001', hint = 'invalid_credential';
  end if;
  if not exists (
    select 1 from public.platform_ai_provider provider
    where provider.provider = target_provider
  ) then
    raise exception 'unknown provider' using errcode = 'P0001', hint = 'unknown_provider';
  end if;

  select * into configuration
  from public.ai_configuration
  where id = target_configuration_id
  for update;
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if configuration.provider <> target_provider and provider_credential is null then
    raise exception 'credential required when provider changes'
      using errcode = 'P0001', hint = 'credential_required';
  end if;
  if provider_credential is not null then
    perform vault.update_secret(configuration.credential_secret_id, provider_credential);
  end if;

  update public.ai_configuration
  set label = trim(configuration_label),
      provider = target_provider,
      split_model = trim(target_split_model),
      extract_model = trim(target_extract_model),
      credential_last_four = case
        when provider_credential is null then configuration.credential_last_four
        else right(provider_credential, 4)
      end,
      updated_at = now(),
      updated_by = auth.uid()
  where id = target_configuration_id;

  perform private.record_ai_configuration_audit_event(
    'ai_configuration.updated',
    target_configuration_id,
    jsonb_build_object('label', trim(configuration_label), 'provider', target_provider)
  );
end;
$$;

create function public.list_ai_configurations()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', configuration.id,
      'label', configuration.label,
      'provider', configuration.provider,
      'credentialLastFour', configuration.credential_last_four,
      'isDefault', configuration.is_default,
      'assignedCompanyIds', coalesce((
        select jsonb_agg(assignment.company_id order by assignment.company_id)
        from public.company_ai_configuration assignment
        where assignment.configuration_id = configuration.id
      ), '[]'::jsonb)
    ) order by configuration.label, configuration.id)
    from public.ai_configuration configuration
  ), '[]'::jsonb);
end;
$$;

create function public.assign_company_ai_configuration(
  target_company_id uuid,
  target_configuration_id uuid
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target_company public.company;
  configuration_label text;
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into target_company
  from public.company
  where id = target_company_id and deleted_at is null;
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select label into configuration_label
  from public.ai_configuration
  where id = target_configuration_id;
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into public.company_ai_configuration (
    company_id, configuration_id, assigned_at, assigned_by
  ) values (
    target_company.id, target_configuration_id, now(), auth.uid()
  )
  on conflict (company_id) do update
  set configuration_id = excluded.configuration_id,
      assigned_at = excluded.assigned_at,
      assigned_by = excluded.assigned_by;

  perform private.record_audit_event(
    'company.ai_configuration_assigned',
    null,
    null,
    'company',
    target_company.id,
    jsonb_build_object(
      'ai_configuration_id', target_configuration_id,
      'ai_configuration_label', configuration_label
    )
  );
end;
$$;

create function public.set_default_ai_configuration(target_configuration_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  configuration_label text;
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  lock table public.ai_configuration in share row exclusive mode;
  select label into configuration_label
  from public.ai_configuration
  where id = target_configuration_id;
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.ai_configuration
  set is_default = false,
      updated_at = now(),
      updated_by = auth.uid()
  where is_default and id <> target_configuration_id;

  update public.ai_configuration
  set is_default = true,
      updated_at = now(),
      updated_by = auth.uid()
  where id = target_configuration_id and not is_default;

  perform private.record_ai_configuration_audit_event(
    'ai_configuration.default_selected',
    target_configuration_id,
    jsonb_build_object('label', configuration_label)
  );
end;
$$;

-- Only the worker may cross the credential boundary. No authenticated RPC can
-- return a secret, model name, or decrypted Vault value.
create function public.resolve_assigned_ai_configuration(target_company_id uuid)
returns table (
  provider text,
  api_key text,
  split_model text,
  extract_model text,
  is_explicit boolean
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select configuration.provider,
      secret.decrypted_secret,
      configuration.split_model,
      configuration.extract_model,
      assignment.assigned_by is not null
    from public.company_ai_configuration assignment
    join public.ai_configuration configuration
      on configuration.id = assignment.configuration_id
    join vault.decrypted_secrets secret
      on secret.id = configuration.credential_secret_id
    where assignment.company_id = target_company_id;
end;
$$;

revoke execute on function public.create_ai_configuration(text, text, text, text, text),
  public.update_ai_configuration(uuid, text, text, text, text, text),
  public.list_ai_configurations(),
  public.assign_company_ai_configuration(uuid, uuid),
  public.set_default_ai_configuration(uuid),
  public.resolve_assigned_ai_configuration(uuid)
  from public, anon;

revoke execute on function public.resolve_assigned_ai_configuration(uuid)
  from authenticated;

grant execute on function public.create_ai_configuration(text, text, text, text, text),
  public.update_ai_configuration(uuid, text, text, text, text, text),
  public.list_ai_configurations(),
  public.assign_company_ai_configuration(uuid, uuid),
  public.set_default_ai_configuration(uuid)
  to authenticated;

grant execute on function public.resolve_assigned_ai_configuration(uuid)
  to service_role;

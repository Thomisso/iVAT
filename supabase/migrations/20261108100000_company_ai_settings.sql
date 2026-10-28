-- Explicit Company AI configuration (#79). A consent records both the provider
-- location and which credential boundary may be used. Browser callers receive
-- only usable, secret-free options; the worker alone resolves a selected key.

create type public.ai_credential_source as enum ('platform', 'organization', 'local');

alter table public.company
  add column ai_credential_source public.ai_credential_source;

-- Existing consent did not say which key could be used. Safely pause it instead
-- of guessing a credential boundary; the Administrator must explicitly consent
-- again while every uploaded original remains stored.
with disabled as (
  update public.company set
    ai_processing_enabled = false,
    ai_provider = null,
    ai_region = null
  where ai_processing_enabled
  returning id, organization_id
)
insert into public.company_setup_step_state (
  company_id, organization_id, step, state, changed_by
)
select id, organization_id, 'ai_processing', 'skipped', null from disabled
on conflict (company_id, step) do update set
  state = excluded.state, changed_by = null, changed_at = now();

alter table public.company
  drop constraint company_ai_consent_names_provider,
  add constraint company_ai_consent_names_provider check (
    (ai_processing_enabled and ai_provider is not null and ai_region is not null
      and ai_credential_source is not null)
    or (not ai_processing_enabled and ai_provider is null and ai_region is null
      and ai_credential_source is null)
  );

-- Older deletion functions turn consent off without knowing the new column.
-- Keep those operations valid while the consistency constraint remains strict.
create function private.clear_disabled_ai_credential_source()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if not new.ai_processing_enabled then
    new.ai_credential_source := null;
  end if;
  return new;
end;
$$;

create trigger company_clear_disabled_ai_credential_source
  before update of ai_processing_enabled on public.company
  for each row execute function private.clear_disabled_ai_credential_source();

revoke execute on function private.clear_disabled_ai_credential_source() from public;

-- Consent can now change only through the validating commands below. RLS still
-- protects all other Company settings, but cannot validate credential usability.
revoke update (ai_processing_enabled, ai_provider, ai_region) on public.company from authenticated;

create function public.list_company_ai_options(target_company_id uuid)
returns table (
  provider text,
  region text,
  credential_source public.ai_credential_source
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  target public.company;
begin
  select * into target from public.company where id = target_company_id;
  if not found or target.deleted_at is not null
    or not private.can_administrate_company(target.id, target.organization_id)
  then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  return query
    select p.provider, 'global'::text, 'platform'::public.ai_credential_source
    from public.platform_ai_provider p
    join public.organization_platform_ai_access a
      on a.organization_id = target.organization_id
      and a.provider = p.provider
      and a.enabled
    where p.available and p.platform_key_secret_id is not null
    union all
    select p.provider, 'global'::text, 'organization'::public.ai_credential_source
    from public.platform_ai_provider p
    join public.organization_ai_provider_key k
      on k.organization_id = target.organization_id
      and k.provider = p.provider
    order by 1, 3;
end;
$$;

revoke execute on function public.list_company_ai_options(uuid) from public, anon;
grant execute on function public.list_company_ai_options(uuid) to authenticated;

create function public.configure_company_ai_processing(
  target_company_id uuid,
  target_provider text,
  target_region text,
  target_credential_source public.ai_credential_source
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target public.company;
  usable boolean := false;
begin
  select * into target from public.company where id = target_company_id for update;
  if not found or target.deleted_at is not null
    or not private.can_administrate_company(target.id, target.organization_id)
  then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  if target_credential_source = 'platform' then
    select exists (
      select 1
      from public.platform_ai_provider p
      join public.organization_platform_ai_access a
        on a.organization_id = target.organization_id
        and a.provider = p.provider
        and a.enabled
      where p.provider = target_provider
        and p.available
        and p.platform_key_secret_id is not null
        and target_region = 'global'
    ) into usable;
  elsif target_credential_source = 'organization' then
    -- Provider availability gates the shared platform service, not a supported
    -- provider used with the Organization's own key.
    select exists (
      select 1
      from public.platform_ai_provider p
      join public.organization_ai_provider_key k
        on k.organization_id = target.organization_id
        and k.provider = p.provider
      where p.provider = target_provider and target_region = 'global'
    ) into usable;
  elsif target_credential_source = 'local' then
    -- Never listed by the database. The application exposes this deterministic
    -- adapter only when AI_PROVIDER=fake in local development and tests.
    usable := target_provider = 'fake' and target_region = 'local';
  end if;

  if not usable then
    raise exception 'AI provider option is unavailable'
      using errcode = 'P0001', hint = 'provider_unavailable';
  end if;

  update public.company set
    ai_processing_enabled = true,
    ai_provider = target_provider,
    ai_region = target_region,
    ai_credential_source = target_credential_source
  where id = target.id;

  insert into public.company_setup_step_state (
    company_id, organization_id, step, state, changed_by
  ) values (target.id, target.organization_id, 'ai_processing', 'completed', auth.uid())
  on conflict (company_id, step) do update set
    state = excluded.state, changed_by = excluded.changed_by, changed_at = now()
    where company_setup_step_state.state is distinct from excluded.state;
end;
$$;

create function public.disable_company_ai_processing(target_company_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target public.company;
begin
  select * into target from public.company where id = target_company_id for update;
  if not found or target.deleted_at is not null
    or not private.can_administrate_company(target.id, target.organization_id)
  then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  update public.company set
    ai_processing_enabled = false,
    ai_provider = null,
    ai_region = null,
    ai_credential_source = null
  where id = target.id;

  insert into public.company_setup_step_state (
    company_id, organization_id, step, state, changed_by
  ) values (target.id, target.organization_id, 'ai_processing', 'skipped', auth.uid())
  on conflict (company_id, step) do update set
    state = excluded.state, changed_by = excluded.changed_by, changed_at = now()
    where company_setup_step_state.state is distinct from excluded.state;
end;
$$;

revoke execute on function public.configure_company_ai_processing(
  uuid, text, text, public.ai_credential_source
), public.disable_company_ai_processing(uuid) from public, anon;
grant execute on function public.configure_company_ai_processing(
  uuid, text, text, public.ai_credential_source
), public.disable_company_ai_processing(uuid) to authenticated;

-- The selected source is authoritative. This deliberately removes the old
-- implicit "Organization key first, platform fallback" behavior from jobs.
create function public.resolve_company_ai_provider(
  target_organization_id uuid,
  target_provider text,
  target_credential_source public.ai_credential_source
)
returns table (api_key text, split_model text, extract_model text)
language plpgsql stable security definer set search_path = ''
as $$
declare
  settings public.platform_ai_provider;
  secret_id uuid;
  access_enabled boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into settings
  from public.platform_ai_provider p where p.provider = target_provider;
  if not found then
    raise exception 'provider unavailable' using errcode = 'P0001', hint = 'provider_unavailable';
  end if;

  if target_credential_source = 'organization' then
    select k.key_secret_id into secret_id
    from public.organization_ai_provider_key k
    where k.organization_id = target_organization_id and k.provider = target_provider;
    if secret_id is null then
      raise exception 'Organization key not configured'
        using errcode = 'P0001', hint = 'organization_key_not_configured';
    end if;
  elsif target_credential_source = 'platform' then
    if not settings.available then
      raise exception 'provider unavailable' using errcode = 'P0001', hint = 'provider_unavailable';
    end if;
    if settings.platform_key_secret_id is null then
      raise exception 'platform key not configured'
        using errcode = 'P0001', hint = 'platform_key_not_configured';
    end if;
    select a.enabled into access_enabled
    from public.organization_platform_ai_access a
    where a.organization_id = target_organization_id and a.provider = target_provider;
    if not coalesce(access_enabled, false) then
      raise exception 'platform key not enabled'
        using errcode = 'P0001', hint = 'platform_key_not_enabled';
    end if;
    secret_id := settings.platform_key_secret_id;
  else
    raise exception 'local provider has no stored key'
      using errcode = 'P0001', hint = 'provider_unavailable';
  end if;

  return query
    select v.decrypted_secret, settings.split_model, settings.extract_model
    from vault.decrypted_secrets v where v.id = secret_id;
end;
$$;

revoke execute on function public.resolve_company_ai_provider(
  uuid, text, public.ai_credential_source
) from public, anon, authenticated;
grant execute on function public.resolve_company_ai_provider(
  uuid, text, public.ai_credential_source
) to service_role;

-- Include the credential boundary in consent audit events.
drop trigger company_ai_processing_changed_audit on public.company;
create or replace function private.audit_company_ai_processing_changed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.ai_processing_enabled then
    perform private.record_audit_event(
      'company.ai_processing_enabled', new.organization_id, new.id, 'company', new.id,
      jsonb_build_object(
        'provider', new.ai_provider,
        'region', new.ai_region,
        'credential_source', new.ai_credential_source
      )
    );
  else
    perform private.record_audit_event(
      'company.ai_processing_disabled', new.organization_id, new.id, 'company', new.id,
      jsonb_build_object(
        'provider', old.ai_provider,
        'region', old.ai_region,
        'credential_source', old.ai_credential_source
      )
    );
  end if;
  return new;
end;
$$;

create trigger company_ai_processing_changed_audit
  after update of ai_processing_enabled, ai_provider, ai_region, ai_credential_source on public.company
  for each row
  when (old.ai_processing_enabled is distinct from new.ai_processing_enabled
    or old.ai_provider is distinct from new.ai_provider
    or old.ai_region is distinct from new.ai_region
    or old.ai_credential_source is distinct from new.ai_credential_source)
  execute function private.audit_company_ai_processing_changed();

-- Extend the stable archive contract without copying its large snapshot query.
alter function public.company_export_snapshot(uuid)
  rename to company_export_snapshot_without_ai_credential_source;
alter function public.company_export_snapshot_without_ai_credential_source(uuid)
  set schema private;

create function public.company_export_snapshot(target_company_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  snapshot jsonb;
  credential_source public.ai_credential_source;
begin
  snapshot := private.company_export_snapshot_without_ai_credential_source(target_company_id);
  select c.ai_credential_source into credential_source
  from public.company c where c.id = target_company_id;
  if credential_source is not null then
    snapshot := jsonb_set(
      snapshot,
      '{company,aiProcessing,credentialSource}',
      to_jsonb(credential_source),
      true
    );
  end if;
  return snapshot;
end;
$$;

revoke execute on function private.company_export_snapshot_without_ai_credential_source(uuid),
  public.company_export_snapshot(uuid) from public, anon, authenticated, service_role;

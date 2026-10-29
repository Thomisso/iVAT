-- Contract Organization-managed credentials and every legacy provider-selection
-- path (#110). Platform-owned AI Configurations become the only production
-- credential/model boundary used by Split and Extraction.

-- Preserve an unambiguous legacy platform configuration before removing its
-- old settings columns. Organization credentials are deliberately excluded.
insert into public.ai_configuration (
  label,
  provider,
  split_model,
  extract_model,
  credential_secret_id,
  credential_last_four,
  is_default,
  created_by,
  updated_by
)
select
  'Migrated platform ' || provider.provider || ' ' || left(provider.platform_key_secret_id::text, 8),
  provider.provider,
  provider.split_model,
  provider.extract_model,
  provider.platform_key_secret_id,
  provider.platform_key_last_four,
  false,
  null,
  null
from public.platform_ai_provider provider
where provider.available
  and provider.platform_key_secret_id is not null
  and not exists (
    select 1
    from public.ai_configuration configuration
    where configuration.credential_secret_id = provider.platform_key_secret_id
  );

create temporary table migrated_company_ai_assignment on commit drop as
select
  company.id as company_id,
  company.organization_id,
  configuration.id as configuration_id,
  configuration.label as configuration_label
from public.company company
join public.organization_platform_ai_access access
  on access.organization_id = company.organization_id
  and access.provider = company.ai_provider
  and access.enabled
join public.platform_ai_provider provider
  on provider.provider = company.ai_provider
  and provider.available
  and provider.platform_key_secret_id is not null
join public.ai_configuration configuration
  on configuration.credential_secret_id = provider.platform_key_secret_id
where company.deleted_at is null
  and company.ai_processing_enabled
  and company.ai_credential_source = 'platform'
  and not exists (
    select 1 from public.company_ai_configuration assignment
    where assignment.company_id = company.id
  );

insert into public.company_ai_configuration (
  company_id, configuration_id, assigned_at, assigned_by
)
select company_id, configuration_id, now(), null
from migrated_company_ai_assignment;

do $$
declare
  assignment record;
begin
  for assignment in select * from migrated_company_ai_assignment loop
    perform private.record_audit_event(
      'company.ai_configuration_assigned',
      null,
      null,
      'company',
      assignment.company_id,
      jsonb_build_object(
        'ai_configuration_id', assignment.configuration_id,
        'ai_configuration_label', assignment.configuration_label,
        'migration', true
      ),
      null
    );
  end loop;
end;
$$;

-- Work that depended on an Organization key, local adapter, disabled platform
-- provider, or missing platform access cannot be mapped safely. Keep its bytes
-- and processing identity intact while making the intervention visible only to
-- SuperAdmins through the existing incident model.
with waiting as (
  update public.source_file source
  set status = 'waiting_for_platform'
  from public.company company
  where company.id = source.company_id
    and company.ai_processing_enabled
    and not exists (
      select 1 from public.company_ai_configuration assignment
      where assignment.company_id = company.id
    )
    and source.status in ('uploaded', 'processing')
  returning source.id, source.organization_id, source.company_id, company.ai_provider
)
insert into public.ai_processing_issue (
  target_kind, target_id, organization_id, company_id, configuration_id,
  provider, classification, state
)
select
  'source_file', waiting.id, waiting.organization_id, waiting.company_id, null,
  waiting.ai_provider, 'configuration_missing', 'waiting_for_platform'
from waiting
on conflict on constraint ai_processing_issue_pkey do update
set configuration_id = null,
    provider = excluded.provider,
    classification = excluded.classification,
    state = excluded.state,
    updated_at = now();

with waiting as (
  update public.document document
  set status = 'waiting_for_platform'
  from public.company company
  where company.id = document.company_id
    and company.ai_processing_enabled
    and not exists (
      select 1 from public.company_ai_configuration assignment
      where assignment.company_id = company.id
    )
    and document.superseded_at is null
    and document.status in ('uploaded', 'waiting_for_allowance', 'processing')
  returning document.id, document.organization_id, document.company_id, company.ai_provider
)
insert into public.ai_processing_issue (
  target_kind, target_id, organization_id, company_id, configuration_id,
  provider, classification, state
)
select
  'document', waiting.id, waiting.organization_id, waiting.company_id, null,
  waiting.ai_provider, 'configuration_missing', 'waiting_for_platform'
from waiting
on conflict on constraint ai_processing_issue_pkey do update
set configuration_id = null,
    provider = excluded.provider,
    classification = excluded.classification,
    state = excluded.state,
    updated_at = now();

-- Automatic and explicit platform assignment own the generic enabled state.
create or replace function private.assign_default_ai_configuration()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  default_configuration_id uuid;
  default_configuration_label text;
begin
  select id, label into default_configuration_id, default_configuration_label
  from public.ai_configuration
  where is_default;

  if default_configuration_id is not null then
    insert into public.company_ai_configuration (
      company_id, configuration_id, assigned_at, assigned_by
    ) values (
      new.id, default_configuration_id, now(), null
    )
    on conflict (company_id) do nothing;

    perform set_config('app.platform_default_ai_assignment', 'on', true);
    update public.company set ai_processing_enabled = true where id = new.id;
    insert into public.company_setup_step_state (
      company_id, organization_id, step, state, changed_by
    ) values (
      new.id, new.organization_id, 'ai_processing', 'completed', null
    )
    on conflict (company_id, step) do update set
      state = excluded.state,
      changed_by = excluded.changed_by,
      changed_at = now();
    perform set_config('app.platform_default_ai_assignment', 'off', true);

    perform private.record_audit_event(
      'company.ai_configuration_assigned',
      null,
      null,
      'company',
      new.id,
      jsonb_build_object(
        'ai_configuration_id', default_configuration_id,
        'ai_configuration_label', default_configuration_label
      ),
      null
    );
  end if;
  return new;
end;
$$;

create or replace function public.assign_company_ai_configuration(
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
  where id = target_company_id and deleted_at is null
  for update;
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

  perform set_config('app.platform_default_ai_assignment', 'on', true);
  update public.company set ai_processing_enabled = true where id = target_company.id;
  insert into public.company_setup_step_state (
    company_id, organization_id, step, state, changed_by
  ) values (
    target_company.id, target_company.organization_id, 'ai_processing', 'completed', null
  )
  on conflict (company_id, step) do update set
    state = excluded.state,
    changed_by = excluded.changed_by,
    changed_at = now();
  perform set_config('app.platform_default_ai_assignment', 'off', true);

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

create function public.list_ai_configuration_providers()
returns text[]
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select array_agg(provider.provider order by provider.provider)
    from public.platform_ai_provider provider
  ), array[]::text[]);
end;
$$;
revoke execute on function public.list_ai_configuration_providers() from public, anon, service_role;
grant execute on function public.list_ai_configuration_providers() to authenticated;

-- Remove Organization credentials from Vault before dropping their metadata.
create temporary table removed_organization_ai_key on commit drop as
select organization_id, provider, key_secret_id
from public.organization_ai_provider_key;

delete from vault.secrets secret
using removed_organization_ai_key removed
where secret.id = removed.key_secret_id;

-- Also remove any orphan left by an interrupted replacement or older build.
delete from vault.secrets
where name like 'organization_ai_%';

do $$
declare
  removed record;
begin
  for removed in select * from removed_organization_ai_key loop
    perform private.record_audit_event(
      'organization_ai_key.removed',
      removed.organization_id,
      null,
      'organization_ai_key',
      removed.organization_id,
      jsonb_build_object('provider', removed.provider, 'migration', true),
      null
    );
  end loop;
end;
$$;

drop function public.save_organization_ai_provider_key(uuid, text, text, boolean);
drop function public.list_organization_ai_provider_keys(uuid);
drop function public.remove_organization_ai_provider_key(uuid, text);
drop function public.list_company_ai_options(uuid);
drop function public.configure_company_ai_processing(uuid, text, text, public.ai_credential_source);
drop function public.disable_company_ai_processing(uuid);
drop function public.resolve_company_ai_provider(uuid, text, public.ai_credential_source);
drop function public.resolve_platform_ai_provider(uuid, text);
drop function public.list_available_ai_providers();
drop function public.configure_platform_ai_provider(text, boolean, text, text, text);
drop function public.list_platform_ai_providers();
drop function public.list_platform_organizations(text);
drop function public.list_platform_organizations_complete(text);
drop function public.set_organization_platform_ai_access(uuid, text, boolean);
drop function public.list_organization_ai_usage(uuid, date, date, uuid);

drop trigger company_ai_processing_changed_audit on public.company;
drop function private.audit_company_ai_processing_changed();
drop trigger company_clear_disabled_ai_credential_source on public.company;
drop function private.clear_disabled_ai_credential_source();

-- The filing-default wrapper still called the legacy credential-source wrapper.
-- Point that one layer at the prior canonical snapshot so later filing-default
-- and VAT-output wrappers remain intact after removing the enum and column.
create or replace function private.company_export_snapshot_without_filing_defaults(target_company_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select private.company_export_snapshot_without_ai_credential_source(target_company_id);
$$;

alter table public.company drop constraint company_ai_consent_names_provider;

update public.company company
set ai_processing_enabled = assignment.company_id is not null,
    ai_provider = null,
    ai_region = null,
    ai_credential_source = null
from (select id from public.company) existing
left join public.company_ai_configuration assignment on assignment.company_id = existing.id
where company.id = existing.id;

drop table public.organization_ai_provider_key;
drop table public.organization_platform_ai_access;

alter table public.company drop column ai_credential_source;
drop type public.ai_credential_source;

alter table public.platform_ai_provider
  drop column available,
  drop column split_model,
  drop column extract_model,
  drop column platform_key_secret_id,
  drop column platform_key_last_four,
  drop column updated_at,
  drop column updated_by;

-- Ordinary clients retain only the generic processing state. Platform-owned
-- assignment/configuration rows remain inaccessible through RLS and grants.
revoke update (ai_processing_enabled, ai_provider, ai_region) on public.company from authenticated;

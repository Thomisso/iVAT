-- AI processing states requiring platform intervention (#108). Technical
-- causes live behind a SuperAdmin-only query; Company users observe only the
-- neutral waiting/terminal status of their own work.

alter type public.source_file_status add value if not exists 'waiting_for_platform' after 'uploaded';
alter type public.document_status add value if not exists 'waiting_for_platform' after 'waiting_for_allowance';

create type public.ai_processing_issue_classification as enum (
  'configuration_missing',
  'configuration_unusable',
  'invalid_credentials',
  'provider_credits_exhausted',
  'provider_unavailable',
  'provider_response_invalid',
  'processing_failed'
);
create type public.ai_processing_issue_state as enum ('waiting_for_platform', 'terminal');
create type public.ai_processing_target_kind as enum ('source_file', 'document');

create table public.ai_processing_issue (
  target_kind public.ai_processing_target_kind not null,
  target_id uuid not null,
  organization_id uuid not null references public.organization (id) on delete cascade,
  company_id uuid not null references public.company (id) on delete cascade,
  configuration_id uuid references public.ai_configuration (id) on delete set null,
  provider text,
  classification public.ai_processing_issue_classification not null,
  state public.ai_processing_issue_state not null,
  first_detected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (target_kind, target_id)
);

create index ai_processing_issue_configuration_idx
  on public.ai_processing_issue (configuration_id, state, first_detected_at);
create index ai_processing_issue_company_idx
  on public.ai_processing_issue (company_id, state, first_detected_at);

revoke all on public.ai_processing_issue from anon, authenticated, service_role;
alter table public.ai_processing_issue enable row level security;

create or replace view public.upload_batch_summary
with (security_invoker = true)
as
select
  batch.id,
  batch.company_id,
  batch.file_count,
  batch.upload_finished_at,
  batch.processing_finished_at,
  batch.created_at,
  count(distinct source.id)::integer as actual_file_count,
  case when batch.upload_finished_at is null
    then greatest(batch.file_count - count(distinct source.id)::integer, 0)
    else 0
  end as transport_count,
  case when batch.upload_finished_at is not null
    then greatest(batch.file_count - count(distinct source.id)::integer, 0)
    else 0
  end as transport_failure_count,
  (
    count(distinct source.id) filter (
      where source.status::text in ('uploaded', 'waiting_for_platform')
    )
    + count(distinct document.id) filter (
      where document.status::text in ('uploaded', 'waiting_for_allowance', 'waiting_for_platform')
    )
  )::integer as waiting_count,
  count(distinct source.id) filter (where source.status = 'processing')::integer as splitting_count,
  count(distinct source.id) filter (where source.status = 'failed')::integer as source_failure_count,
  count(distinct document.id) filter (where document.status = 'processing')::integer as extracting_count,
  count(distinct document.id) filter (where document.status = 'needs_review')::integer as review_count,
  count(distinct document.id) filter (where document.status in ('approved', 'rejected'))::integer as reviewed_count,
  count(distinct document.id) filter (where document.status = 'failed')::integer as document_failure_count
from public.upload_batch batch
left join public.source_file source on source.upload_batch_id = batch.id
left join public.document document on document.source_file_id = source.id and document.superseded_at is null
group by batch.id;

create or replace function private.maybe_complete_upload_batch(target_batch_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  batch public.upload_batch;
  uploaded_file_count integer;
  transport_failure_count integer;
  source_failure_count integer;
  document_failure_count integer;
  review_count integer;
  reviewed_count integer;
  outcome text;
  notification_payload jsonb;
begin
  select * into batch from public.upload_batch where id = target_batch_id for update;
  if not found or batch.upload_finished_at is null or batch.processing_finished_at is not null then
    return;
  end if;
  if exists (
    select 1 from public.source_file source
    where source.upload_batch_id = batch.id
      and source.status in ('uploaded', 'waiting_for_platform', 'processing')
  ) or exists (
    select 1
    from public.document document
    join public.source_file source on source.id = document.source_file_id
    where source.upload_batch_id = batch.id
      and document.superseded_at is null
      and document.status in ('uploaded', 'waiting_for_allowance', 'waiting_for_platform', 'processing')
  ) then
    return;
  end if;

  select
    count(*)::integer,
    count(*) filter (where source.status = 'failed')::integer
  into uploaded_file_count, source_failure_count
  from public.source_file source
  where source.upload_batch_id = batch.id;

  select
    count(*) filter (where document.status = 'failed')::integer,
    count(*) filter (where document.status = 'needs_review')::integer,
    count(*) filter (where document.status in ('approved', 'rejected'))::integer
  into document_failure_count, review_count, reviewed_count
  from public.document document
  join public.source_file source on source.id = document.source_file_id
  where source.upload_batch_id = batch.id and document.superseded_at is null;

  transport_failure_count := greatest(batch.file_count - uploaded_file_count, 0);
  if transport_failure_count + source_failure_count + document_failure_count = 0 then
    outcome := 'success';
  elsif review_count + reviewed_count > 0 then
    outcome := 'partial';
  else
    outcome := 'failure';
  end if;

  notification_payload := jsonb_build_object(
    'batchId', batch.id,
    'fileCount', uploaded_file_count,
    'outcome', outcome,
    'reviewCount', review_count,
    'transportFailureCount', transport_failure_count,
    'sourceFailureCount', source_failure_count,
    'documentFailureCount', document_failure_count
  );
  update public.upload_batch set processing_finished_at = now() where id = batch.id;
  update public.notification
  set payload = notification_payload, read_at = null, created_at = now()
  where user_id = batch.created_by
    and kind = 'upload_batch_finished'
    and payload ->> 'batchId' = batch.id::text;
  if not found then
    insert into public.notification (organization_id, company_id, user_id, kind, payload)
    values (
      batch.organization_id,
      batch.company_id,
      batch.created_by,
      'upload_batch_finished',
      notification_payload
    );
  end if;
end;
$$;

create function private.clear_resolved_ai_processing_issue()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status::text not in ('waiting_for_platform', 'failed') then
    delete from public.ai_processing_issue issue
    where issue.target_kind = tg_argv[0]::public.ai_processing_target_kind
      and issue.target_id = new.id;
  end if;
  return new;
end;
$$;
revoke execute on function private.clear_resolved_ai_processing_issue() from public;

create trigger source_file_clear_resolved_ai_processing_issue
  after update of status on public.source_file
  for each row execute function private.clear_resolved_ai_processing_issue('source_file');
create trigger document_clear_resolved_ai_processing_issue
  after update of status on public.document
  for each row execute function private.clear_resolved_ai_processing_issue('document');

-- Include the assignment id in the worker-only credential receipt so an
-- intervention can point at the exact configuration that must be repaired.
drop function public.resolve_assigned_ai_configuration(uuid);
create function public.resolve_assigned_ai_configuration(target_company_id uuid)
returns table (
  configuration_id uuid,
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
    select configuration.id,
      configuration.provider,
      secret.decrypted_secret,
      configuration.split_model,
      configuration.extract_model,
      assignment.assigned_by is not null
    from public.company_ai_configuration assignment
    join public.ai_configuration configuration
      on configuration.id = assignment.configuration_id
    left join vault.decrypted_secrets secret
      on secret.id = configuration.credential_secret_id
    where assignment.company_id = target_company_id;
end;
$$;
revoke execute on function public.resolve_assigned_ai_configuration(uuid) from public, anon, authenticated;
grant execute on function public.resolve_assigned_ai_configuration(uuid) to service_role;

create function public.record_ai_processing_issue(
  target_kind public.ai_processing_target_kind,
  target_id uuid,
  target_classification public.ai_processing_issue_classification,
  target_state public.ai_processing_issue_state,
  target_configuration_id uuid default null,
  target_provider text default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target_organization_id uuid;
  target_company_id uuid;
  changed_rows bigint;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if target_kind = 'source_file' then
    select organization_id, company_id into target_organization_id, target_company_id
    from public.source_file where id = target_id for update;
    if not found then return; end if;
    update public.source_file
    set status = case target_state
      when 'waiting_for_platform' then 'waiting_for_platform'::public.source_file_status
      else 'failed'::public.source_file_status
    end
    where id = target_id
      and status in (
        'uploaded',
        'processing',
        case target_state
          when 'waiting_for_platform' then 'waiting_for_platform'::public.source_file_status
          else 'failed'::public.source_file_status
        end
      );
  else
    select organization_id, company_id into target_organization_id, target_company_id
    from public.document where id = target_id for update;
    if not found then return; end if;
    update public.document
    set status = case target_state
      when 'waiting_for_platform' then 'waiting_for_platform'::public.document_status
      else 'failed'::public.document_status
    end
    where id = target_id
      and superseded_at is null
      and status in (
        'uploaded',
        'waiting_for_allowance',
        'processing',
        case target_state
          when 'waiting_for_platform' then 'waiting_for_platform'::public.document_status
          else 'failed'::public.document_status
        end
      );
  end if;

  get diagnostics changed_rows = row_count;
  if changed_rows = 0 then return; end if;
  insert into public.ai_processing_issue (
    target_kind, target_id, organization_id, company_id, configuration_id,
    provider, classification, state
  ) values (
    target_kind, target_id, target_organization_id, target_company_id,
    target_configuration_id, target_provider, target_classification, target_state
  )
  on conflict on constraint ai_processing_issue_pkey do update
  set configuration_id = excluded.configuration_id,
      provider = excluded.provider,
      classification = excluded.classification,
      state = excluded.state,
      updated_at = now()
  where ai_processing_issue.state = excluded.state;
end;
$$;

create function public.list_platform_ai_processing_issues()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'target_kind', issue.target_kind,
      'target_id', issue.target_id,
      'state', issue.state,
      'classification', issue.classification,
      'company_id', issue.company_id,
      'company_name', company.name,
      'configuration_id', issue.configuration_id,
      'configuration_label', configuration.label,
      'provider', coalesce(configuration.provider, issue.provider),
      'first_detected_at', issue.first_detected_at
    ) order by issue.first_detected_at, issue.target_kind, issue.target_id), '[]'::jsonb)
    from public.ai_processing_issue issue
    join public.company company on company.id = issue.company_id
    left join public.ai_configuration configuration on configuration.id = issue.configuration_id
  );
end;
$$;

create function public.resume_platform_ai_processing(
  target_company_id uuid default null,
  target_configuration_id uuid default null
)
returns table (
  target_kind public.ai_processing_target_kind,
  target_id uuid,
  classification public.ai_processing_issue_classification,
  configuration_id uuid,
  provider text
)
language plpgsql security definer set search_path = ''
as $$
declare
  resumed_count bigint;
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if target_company_id is null and target_configuration_id is null then
    raise exception 'recovery target required' using errcode = '42501';
  end if;

  return query
    with selected as (
      select issue.target_kind, issue.target_id, issue.classification,
        issue.configuration_id, issue.provider, issue.first_detected_at
      from public.ai_processing_issue issue
      where issue.state = 'waiting_for_platform'
        and (target_company_id is null or issue.company_id = target_company_id)
        and (target_configuration_id is null or issue.configuration_id = target_configuration_id)
      for update
    ), reset_sources as (
      update public.source_file source
      set status = 'uploaded'
      from selected
      where selected.target_kind = 'source_file'
        and source.id = selected.target_id
        and source.status = 'waiting_for_platform'
      returning selected.target_kind, selected.target_id, selected.classification,
        selected.configuration_id, selected.provider, selected.first_detected_at
    ), reset_documents as (
      update public.document document
      set status = 'uploaded'
      from selected
      where selected.target_kind = 'document'
        and document.id = selected.target_id
        and document.status = 'waiting_for_platform'
      returning selected.target_kind, selected.target_id, selected.classification,
        selected.configuration_id, selected.provider, selected.first_detected_at
    ), recovered as (
      select * from reset_sources
      union all
      select * from reset_documents
    ), removed as (
      delete from public.ai_processing_issue issue
      using recovered
      where issue.target_kind = recovered.target_kind and issue.target_id = recovered.target_id
    )
    select recovered.target_kind, recovered.target_id, recovered.classification,
      recovered.configuration_id, recovered.provider
    from recovered
    order by recovered.first_detected_at, recovered.target_kind, recovered.target_id;

  get diagnostics resumed_count = row_count;
  perform private.record_audit_event(
    'ai_processing.remediation_requested',
    null,
    null,
    case when target_configuration_id is not null then 'ai_configuration' else 'company' end,
    coalesce(target_configuration_id, target_company_id),
    jsonb_build_object(
      'company_id', target_company_id,
      'configuration_id', target_configuration_id,
      'resumed_count', resumed_count
    )
  );
end;
$$;

-- The broker may accept a job and lose its acknowledgement. Restore only the
-- undispatched suffix that has not started yet, including the exact technical
-- issue removed by the remediation transaction. An accepted job can safely
-- move the target out of this visible wait state when it eventually starts.
create function public.restore_platform_ai_processing_wait(target_work jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  work record;
  target_organization_id uuid;
  target_company_id uuid;
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(target_work) <> 'array' then
    raise exception 'invalid recovery work' using errcode = '22023';
  end if;

  for work in
    select *
    from jsonb_to_recordset(target_work) as item(
      target_kind public.ai_processing_target_kind,
      target_id uuid,
      classification public.ai_processing_issue_classification,
      configuration_id uuid,
      provider text
    )
  loop
    target_organization_id := null;
    target_company_id := null;
    if work.target_kind = 'source_file' then
      update public.source_file source
      set status = 'waiting_for_platform'
      where source.id = work.target_id and source.status = 'uploaded'
      returning source.organization_id, source.company_id
      into target_organization_id, target_company_id;
    else
      update public.document document
      set status = 'waiting_for_platform'
      where document.id = work.target_id
        and document.status = 'uploaded'
        and document.superseded_at is null
      returning document.organization_id, document.company_id
      into target_organization_id, target_company_id;
    end if;

    if target_organization_id is not null then
      insert into public.ai_processing_issue (
        target_kind, target_id, organization_id, company_id, configuration_id,
        provider, classification, state
      ) values (
        work.target_kind, work.target_id, target_organization_id, target_company_id,
        work.configuration_id, work.provider, work.classification, 'waiting_for_platform'
      )
      on conflict on constraint ai_processing_issue_pkey do update
      set configuration_id = excluded.configuration_id,
          provider = excluded.provider,
          classification = excluded.classification,
          updated_at = now()
      where ai_processing_issue.state = 'waiting_for_platform';
    end if;
  end loop;
end;
$$;

revoke execute on function public.record_ai_processing_issue(
  public.ai_processing_target_kind, uuid, public.ai_processing_issue_classification,
  public.ai_processing_issue_state, uuid, text
), public.list_platform_ai_processing_issues(),
  public.resume_platform_ai_processing(uuid, uuid),
  public.restore_platform_ai_processing_wait(jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.record_ai_processing_issue(
  public.ai_processing_target_kind, uuid, public.ai_processing_issue_classification,
  public.ai_processing_issue_state, uuid, text
) to service_role;
grant execute on function public.list_platform_ai_processing_issues(),
  public.resume_platform_ai_processing(uuid, uuid),
  public.restore_platform_ai_processing_wait(jsonb)
to authenticated;

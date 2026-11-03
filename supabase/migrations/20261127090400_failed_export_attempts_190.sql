-- Share exact-attempt closure across inventory, totals and remediation.
create function private.is_active_processing_failure(job_name text, job_data jsonb, attempt_started_at timestamptz, attempt_retry_count integer)
returns boolean language sql stable security definer set search_path = '' as $$
  select case job_name
    when 'split-source-file' then exists (
      select 1 from public.source_file source
      join public.company company on company.id = source.company_id
      where source.id = private.processing_job_target_id(job_name, job_data)
        and (source.status in ('uploaded', 'processing', 'failed') or (
          source.status = 'split' and source.split_dispatch_request_id is distinct from source.split_request_id
          and exists (select 1 from public.document pending where pending.source_file_id = source.id
            and pending.superseded_at is null and pending.status = 'uploaded'
            -- A dated child request cannot belong to an unknown pre-migration
            -- Split dispatch. It is later Extraction work, even on a locked
            -- Source whose completion metadata must remain untouched.
            and (source.split_requested_at is not null or pending.extraction_requested_at is null))
        )) and company.deleted_at is null
        and case when job_data ? 'processingRequestId'
          then job_data ->> 'processingRequestId' = source.split_request_id::text
          else source.split_requested_at is null or attempt_started_at >= source.split_requested_at end
    )
    when 'extract-document' then exists (
      select 1 from public.document document
      join public.company company on company.id = document.company_id
      where document.id = private.processing_job_target_id(job_name, job_data)
        and document.superseded_at is null and document.status in ('uploaded', 'processing', 'failed')
        and company.deleted_at is null
        and case when job_data ? 'processingRequestId'
          then job_data ->> 'processingRequestId' = document.extraction_request_id::text
          else document.extraction_requested_at is null or attempt_started_at >= document.extraction_requested_at end
    )
    when 'complete-company-export' then exists (
      select 1 from public.company_data_export export
      join public.company company on company.id = export.company_id
      where export.id = private.processing_job_target_id(job_name, job_data)
        and export.status in ('pending', 'failed') and export.used_at is null
        and coalesce(job_data -> 'closedExportRetryCount' <> to_jsonb(attempt_retry_count), true)
        and company.deleted_at is null and export.data_revision = company.data_revision
        and not exists (
          select 1 from public.company_data_export completed
          where completed.company_id = export.company_id
            and completed.created_by = export.created_by
            and completed.data_revision = export.data_revision
            and completed.id <> export.id and completed.status = 'completed'
            -- An earlier success cannot hide a later failed retry of this request.
            and completed.completed_at > attempt_started_at
        )
    )
    else false end;
$$;
revoke all on function private.is_active_processing_failure(text, jsonb, timestamptz, integer) from public, anon, authenticated, service_role;

drop function public.list_failed_processing_jobs_complete();
drop function public.list_failed_processing_jobs();
create function public.list_failed_processing_jobs()
returns table (id uuid, name text, target_id uuid, failed_at timestamptz, error text, retry_count integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if to_regclass('pgboss.job') is null then return; end if;
  return query execute $query$
    select job.id, job.name, private.processing_job_target_id(job.name, job.data),
      coalesce(job.completed_on, job.started_on, job.created_on),
      coalesce(job.output ->> 'message', job.output::text, ''), job.retry_count
    from pgboss.job job
    where job.state::text = 'failed'
      and private.is_active_processing_failure(job.name, job.data, coalesce(job.started_on, job.created_on), job.retry_count)
    order by coalesce(job.completed_on, job.started_on, job.created_on) desc, job.id
  $query$;
end;
$$;

create or replace function public.list_platform_operational_context()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  failed_jobs jsonb := '[]'::jsonb;
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'name', grouped.name, 'companyId', grouped.company_id,
    'companyName', grouped.company_name, 'affectedCount', grouped.affected_count,
    'firstFailedAt', grouped.first_failed_at, 'targetIds', grouped.target_ids
  ) order by grouped.first_failed_at), '[]'::jsonb) into failed_jobs
  from (
    select job.name, company.id as company_id, company.name as company_name,
      count(distinct job.target_id)::integer as affected_count,
      min(job.failed_at) as first_failed_at,
      jsonb_agg(distinct job.target_id order by job.target_id) as target_ids
    from public.list_failed_processing_jobs() job
    left join public.source_file source on job.name = 'split-source-file' and source.id = job.target_id
    left join public.company_data_export export on job.name = 'complete-company-export' and export.id = job.target_id
    left join public.document document on job.name = 'extract-document' and document.id = job.target_id
    join public.company company on company.id = coalesce(source.company_id, document.company_id, export.company_id)
    group by job.name, company.id, company.name
  ) grouped;

  return jsonb_build_object(
    'companies', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'companyId', company.id,
        'companyName', company.name,
        'aiProcessingEnabled', company.ai_processing_enabled,
        'uploadedDocumentCount', coalesce(waiting.uploaded_count, 0),
        'oldestUploadedAt', waiting.oldest_uploaded_at,
        'oldestWaitingAt', waiting.oldest_waiting_at
      ) order by company.name, company.id), '[]'::jsonb)
      from public.company company
      left join lateral (
        select
          count(*) filter (where document.status = 'uploaded')::integer as uploaded_count,
          min(document.created_at) filter (where document.status = 'uploaded') as oldest_uploaded_at,
          min(document.created_at) as oldest_waiting_at
        from public.document document
        where document.company_id = company.id
          and document.superseded_at is null
          and document.status in ('uploaded', 'waiting_for_allowance', 'waiting_for_platform')
      ) waiting on true
      where company.deleted_at is null
    ),
    'failedJobs', failed_jobs
  );
end;
$$;


create or replace function public.take_over_failed_processing_job(target_failed_job_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  job_name text; job_data jsonb; job_state text; attempt_started_at timestamptz; attempt_retry_count integer;
  target_id uuid; file public.source_file; document_id uuid; target_company_id uuid;
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if to_regclass('pgboss.job') is null then
    raise exception 'no active failure' using errcode = 'P0001', hint = 'not_recoverable';
  end if;
  execute 'select name, data, state::text, coalesce(started_on, created_on), retry_count from pgboss.job where id = $1 for update'
    into job_name, job_data, job_state, attempt_started_at, attempt_retry_count using target_failed_job_id;
  target_id := private.processing_job_target_id(job_name, job_data);
  if job_name = 'split-source-file' then
    select company_id into target_company_id from public.source_file where id = target_id;
  elsif job_name = 'extract-document' then
    select company_id into target_company_id from public.document where id = target_id;
  end if;
  perform 1 from public.company where id = target_company_id for update;
  if job_state is distinct from 'failed' or job_name not in ('split-source-file', 'extract-document')
    or not private.is_active_processing_failure(job_name, job_data, attempt_started_at, attempt_retry_count) then
    raise exception 'no active AI failure' using errcode = 'P0001', hint = 'not_recoverable';
  end if;
  if job_name = 'extract-document' then
    perform public.start_manual_document_review(target_id);
  else
    file := private.source_file_for_recovery(target_id);
    if not exists (select 1 from public.document where source_file_id = file.id) then
      perform public.start_manual_source_review(file.id);
    else
      -- A Split that already persisted Documents must continue through them.
      for document_id in select id from public.document where source_file_id = file.id
        and superseded_at is null and status in ('uploaded', 'processing', 'failed', 'waiting_for_allowance', 'waiting_for_platform') order by id
      loop
        perform public.start_manual_document_review(document_id);
      end loop;
      update public.source_file set status = 'split', split_request_id = gen_random_uuid() where id = file.id;
      perform private.record_audit_event('source_file.manual_review_started', file.organization_id, file.company_id,
        'source_file', file.id, '{}'::jsonb);
    end if;
  end if;
end;
$$;
revoke all on function public.take_over_failed_processing_job(uuid) from public, anon, service_role;
grant execute on function public.take_over_failed_processing_job(uuid) to authenticated;

CREATE OR REPLACE FUNCTION public.retry_failed_processing_job(target_failed_job_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  job_name text;
  job_data jsonb;
  job_state text;
  target_id uuid;
  target_organization_id uuid;
  target_company_id uuid;
  affected integer;
  attempt_started_at timestamptz; attempt_retry_count integer;
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if to_regclass('pgboss.job') is null then
    raise exception 'processing job not found' using errcode = 'P0001', hint = 'not_retryable';
  end if;

  execute 'select name, data, state::text, coalesce(started_on, created_on), retry_count from pgboss.job where id = $1 for update'
    into job_name, job_data, job_state, attempt_started_at, attempt_retry_count using target_failed_job_id;
  target_id := private.processing_job_target_id(job_name, job_data);
  if job_state <> 'failed' or target_id is null then
    raise exception 'processing job is not retryable' using errcode = 'P0001', hint = 'not_retryable';
  end if;

  if job_name = 'split-source-file' then
    select company_id into target_company_id from public.source_file where id = target_id;
    perform 1 from public.company where id = target_company_id for update;
    if not private.is_active_processing_failure(job_name, job_data, attempt_started_at, attempt_retry_count) then
      raise exception 'obsolete processing failure' using errcode = 'P0001', hint = 'not_retryable';
    end if;
    -- Retrying the stored Split job resumes dispatch when Documents already exist.
    -- The handler observes split and enqueues their Extraction without new AI boundaries.
    update public.source_file set status = case
      when exists (select 1 from public.document where source_file_id = target_id)
        then 'split'::public.source_file_status else 'uploaded'::public.source_file_status end,
      split_request_id = gen_random_uuid()
    where id = target_id and status in ('uploaded', 'processing', 'failed', 'split')
    returning organization_id, company_id into target_organization_id, target_company_id;
  elsif job_name = 'extract-document' then
    select company_id into target_company_id from public.document where id = target_id;
    perform 1 from public.company where id = target_company_id for update;
    if not private.is_active_processing_failure(job_name, job_data, attempt_started_at, attempt_retry_count) then
      raise exception 'obsolete processing failure' using errcode = 'P0001', hint = 'not_retryable';
    end if;
    perform 1 from public.document where id = target_id for update;
    delete from public.ai_processing_reservation where document_id = target_id;
    update public.document set status = 'uploaded', extraction_request_id = gen_random_uuid()
    where id = target_id and superseded_at is null and status in ('uploaded', 'processing', 'failed')
    returning organization_id, company_id into target_organization_id, target_company_id;
  else
    select company_id into target_company_id from public.company_data_export where id = target_id;
    perform 1 from public.company where id = target_company_id for update;
    if not private.is_active_processing_failure(job_name, job_data, attempt_started_at, attempt_retry_count) then
      raise exception 'obsolete export failure' using errcode = 'P0001', hint = 'not_retryable';
    end if;
    update public.company_data_export
    set status = 'pending', failed_at = null
    where id = target_id and status in ('pending', 'failed') and used_at is null
    returning organization_id, company_id into target_organization_id, target_company_id;
  end if;
  if not found then
    raise exception 'processing job target is not retryable' using errcode = 'P0001', hint = 'not_retryable';
  end if;

  execute $query$
    update pgboss.job
    set data = data - 'processingRequestId', state = 'retry', retry_limit = retry_limit + 1,
        completed_on = null, start_after = greatest(start_after, now())
    where id = $1 and name = $2 and state::text = 'failed'
  $query$ using target_failed_job_id, job_name;
  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'processing job is not retryable' using errcode = 'P0001', hint = 'not_retryable';
  end if;

  perform private.record_audit_event(
    'processing.job_retried', target_organization_id, target_company_id,
    'processing_job', target_failed_job_id,
    jsonb_build_object('job_name', job_name, 'target_id', target_id)
  );
end;
$function$;


-- The marker belongs to a pg-boss attempt, not the immutable export receipt.
-- pg-boss retains its unsuccessful state/output. The append-only audit survives
-- ordinary queue retention. A later queue retry counter never matches this one.
create function public.close_failed_export_attempt(target_failed_job_id uuid, expected_retry_count integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  job_name text; job_data jsonb; job_state text;
  attempt_started_at timestamptz; attempt_retry_count integer;
  target public.company_data_export;
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if to_regclass('pgboss.job') is null then
    raise exception 'no active export failure' using errcode = 'P0001', hint = 'not_closable';
  end if;
  execute 'select name, data, state::text, coalesce(started_on, created_on), retry_count from pgboss.job where id = $1 for update'
    into job_name, job_data, job_state, attempt_started_at, attempt_retry_count using target_failed_job_id;
  select * into target from public.company_data_export
    where id = private.processing_job_target_id(job_name, job_data);
  perform 1 from public.company where id = target.company_id for update;
  if expected_retry_count is null or expected_retry_count < 0 or expected_retry_count is distinct from attempt_retry_count
    or job_name is distinct from 'complete-company-export' or job_state is distinct from 'failed'
    or not private.is_active_processing_failure(job_name, job_data, attempt_started_at, attempt_retry_count) then
    raise exception 'no active export failure' using errcode = 'P0001', hint = 'not_closable';
  end if;
  -- An expired process may never have marked its receipt failed. Closing that
  -- abandoned attempt makes the terminal failure truthful for its author too.
  update public.company_data_export set status = 'failed', failed_at = clock_timestamp()
    where id = target.id and status = 'pending';
  execute 'update pgboss.job set data = data || jsonb_build_object(''closedExportRetryCount'', $2) where id = $1'
    using target_failed_job_id, attempt_retry_count;
  perform private.record_audit_event(
    'company.export_attempt_closed', target.organization_id, target.company_id,
    'company_data_export', target.id,
    jsonb_build_object('job_id', target_failed_job_id, 'retry_count', attempt_retry_count)
  );
end;
$$;
revoke all on function public.close_failed_export_attempt(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.close_failed_export_attempt(uuid, integer) to authenticated;

-- No caller retains the previous boundary without an exact queue attempt.
drop function private.is_active_processing_failure(text, jsonb, timestamptz);

-- The complete scalar inventory also carries the displayed attempt identity.
create function public.list_failed_processing_jobs_complete()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(job) order by job.failed_at desc, job.id), '[]'::jsonb)
  from public.list_failed_processing_jobs() job;
$$;
revoke all on function public.list_failed_processing_jobs_complete() from public, anon, service_role;
grant execute on function public.list_failed_processing_jobs_complete() to authenticated;
revoke all on function public.list_failed_processing_jobs() from public, anon, service_role;
grant execute on function public.list_failed_processing_jobs() to authenticated;

-- Keep Company-first serialization when a queue attempt expired before the handler.
create or replace function public.complete_company_data_export(
  target_export_id uuid,
  target_byte_size bigint,
  target_sha256 text
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  pending public.company_data_export;
  current_revision bigint;
  target_company_id uuid;
begin
  if target_byte_size <= 0 or target_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid archive metadata' using errcode = '22023';
  end if;
  -- Serialize with request creation, deletion and privileged remediation before
  -- taking the receipt lock. A late worker then observes a closed failure.
  select company_id into target_company_id from public.company_data_export where id = target_export_id;
  select data_revision into current_revision from public.company where id = target_company_id for update;
  select * into pending
  from public.company_data_export
  where id = target_export_id
  for update;
  if not found then
    raise exception 'export is not completable'
      using errcode = 'P0001', hint = 'export_failed';
  end if;
  if pending.status = 'completed' then
    if pending.byte_size = target_byte_size and pending.sha256 = target_sha256 then
      return;
    end if;
    raise exception 'export was completed with different metadata'
      using errcode = 'P0001', hint = 'export_failed';
  end if;
  if pending.status <> 'pending' then
    raise exception 'export is not completable'
      using errcode = 'P0001', hint = 'export_failed';
  end if;
  if current_revision is distinct from pending.data_revision then
    raise exception 'Company data changed during export'
      using errcode = 'P0001', hint = 'stale_export';
  end if;

  update public.company_data_export
  set status = 'completed',
      byte_size = target_byte_size,
      sha256 = target_sha256,
      completed_at = clock_timestamp()
  where id = pending.id;

  perform private.record_audit_event(
    'company.data_exported', pending.organization_id, pending.company_id,
    'company', pending.company_id,
    jsonb_build_object(
      'export_id', pending.id,
      'file_name', pending.file_name,
      'byte_size', target_byte_size,
      'sha256', target_sha256
    ),
    pending.created_by
  );
end;
$$;


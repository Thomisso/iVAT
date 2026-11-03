-- Existing requests have an unknown start boundary: preserve their genuine
-- failures until a new authoritative generation establishes one. New requests
-- are dated only by PostgreSQL, never by worker or browser clocks.
alter table public.source_file add column split_requested_at timestamptz, add column split_dispatch_request_id uuid;
alter table public.document add column extraction_requested_at timestamptz;
alter table public.source_file alter column split_requested_at set default now();
alter table public.document alter column extraction_requested_at set default now();

create function private.date_processing_request()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'source_file' then
    if new.split_request_id is distinct from old.split_request_id then new.split_requested_at := clock_timestamp(); end if;
  else
    if new.extraction_request_id is distinct from old.extraction_request_id then new.extraction_requested_at := clock_timestamp(); end if;
  end if;
  return new;
end;
$$;
revoke all on function private.date_processing_request() from public, anon, authenticated, service_role;
create trigger source_file_date_processing_request before update on public.source_file
  for each row execute function private.date_processing_request();
create trigger document_date_processing_request before update on public.document
  for each row execute function private.date_processing_request();

-- A recorded Split still owns dispatching its uploaded Documents. Record that
-- generation's successful handoff independently of later Document requests.
create function public.complete_source_processing_dispatch(target_source_file_id uuid, target_split_request_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare target_company_id uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'forbidden' using errcode = '42501'; end if;
  select company_id into target_company_id from public.source_file where id = target_source_file_id;
  perform 1 from public.company where id = target_company_id for update;
  update public.source_file set split_dispatch_request_id = target_split_request_id
  where id = target_source_file_id and split_request_id = target_split_request_id
    and status = 'split' and split_dispatch_request_id is distinct from target_split_request_id;
end;
$$;
revoke all on function public.complete_source_processing_dispatch(uuid, uuid) from public, anon, authenticated;
grant execute on function public.complete_source_processing_dispatch(uuid, uuid) to service_role;

-- Child progress proves there is no remaining dispatch work once none of the
-- current Documents is uploaded. In particular, ordinary manual takeover must
-- resolve the Source incident durably before a later Document reprocess.
-- Processing and human transitions already hold Company before their Document.
create function private.resolve_source_dispatch_after_document_progress()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.source_file_id is null or (new.status = 'uploaded' and new.superseded_at is null) then return new; end if;
  update public.source_file source set split_dispatch_request_id = source.split_request_id
  where source.id = new.source_file_id and source.status = 'split'
    and source.split_dispatch_request_id is distinct from source.split_request_id
    and not exists (select 1 from public.document document where document.source_file_id = source.id
      and document.superseded_at is null and document.status = 'uploaded');
  return new;
end;
$$;
revoke all on function private.resolve_source_dispatch_after_document_progress() from public, anon, authenticated, service_role;
create trigger document_resolve_source_dispatch after update of status, superseded_at on public.document
  for each row execute function private.resolve_source_dispatch_after_document_progress();

-- Bind the generation actually read by the handler, rather than guessing it
-- from pg-boss.started_on (which precedes that read). Only ID metadata is stored;
-- A matching attempt may already have expired. Its retry counter prevents a
-- late worker from overwriting the binding of a newer attempt of the same job.
-- pg-boss continues to own job state, attempts and failure output.
create function public.bind_processing_job_request(target_job_id uuid, target_request_id uuid, target_retry_count integer default 0)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then raise exception 'forbidden' using errcode = '42501'; end if;
  if to_regclass('pgboss.job') is null then return; end if;
  execute $query$
    update pgboss.job set data = data || jsonb_build_object('processingRequestId', $2)
    where id = $1 and name in ('split-source-file', 'extract-document') and state::text in ('active', 'failed') and retry_count = $3
  $query$ using target_job_id, target_request_id, target_retry_count;
end;
$$;
revoke all on function public.bind_processing_job_request(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.bind_processing_job_request(uuid, uuid, integer) to service_role;

-- One live failure boundary for rows, grouped alerts and privileged remediation.
-- Queue attempts remain historical failures after authoritative target recovery.
create function private.is_active_processing_failure(job_name text, job_data jsonb, attempt_started_at timestamptz)
returns boolean language sql stable security definer set search_path = '' as $$
  select case job_name
    when 'split-source-file' then exists (
      select 1 from public.source_file source
      join public.company company on company.id = source.company_id
      where source.id = private.processing_job_target_id(job_name, job_data)
        and (source.status in ('uploaded', 'processing', 'failed') or (
          source.status = 'split' and source.split_dispatch_request_id is distinct from source.split_request_id
          and exists (select 1 from public.document pending where pending.source_file_id = source.id
            and pending.superseded_at is null and pending.status = 'uploaded')
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
      where export.id = private.processing_job_target_id(job_name, job_data)
        and export.status = 'failed' and export.used_at is null
    )
    else false end;
$$;
revoke all on function private.is_active_processing_failure(text, jsonb, timestamptz) from public, anon, authenticated, service_role;

create or replace function public.list_failed_processing_jobs()
returns table (id uuid, name text, target_id uuid, failed_at timestamptz, error text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if to_regclass('pgboss.job') is null then return; end if;
  return query execute $query$
    select job.id, job.name, private.processing_job_target_id(job.name, job.data),
      coalesce(job.completed_on, job.started_on, job.created_on),
      coalesce(job.output ->> 'message', job.output::text, '')
    from pgboss.job job
    where job.state::text = 'failed'
      and private.is_active_processing_failure(job.name, job.data, coalesce(job.started_on, job.created_on))
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
    left join public.document document on job.name = 'extract-document' and document.id = job.target_id
    join public.company company on company.id = coalesce(source.company_id, document.company_id)
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


-- Platform-only entry point. Reuse the ordinary recovery transitions so locks,
-- generation invalidation, reservations and their attributable audits agree.
create function public.take_over_failed_processing_job(target_failed_job_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  job_name text; job_data jsonb; job_state text; attempt_started_at timestamptz;
  target_id uuid; file public.source_file; document_id uuid; target_company_id uuid;
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if to_regclass('pgboss.job') is null then
    raise exception 'no active failure' using errcode = 'P0001', hint = 'not_recoverable';
  end if;
  execute 'select name, data, state::text, coalesce(started_on, created_on) from pgboss.job where id = $1 for update'
    into job_name, job_data, job_state, attempt_started_at using target_failed_job_id;
  target_id := private.processing_job_target_id(job_name, job_data);
  if job_name = 'split-source-file' then
    select company_id into target_company_id from public.source_file where id = target_id;
  elsif job_name = 'extract-document' then
    select company_id into target_company_id from public.document where id = target_id;
  end if;
  perform 1 from public.company where id = target_company_id for update;
  if job_state is distinct from 'failed' or job_name not in ('split-source-file', 'extract-document')
    or not private.is_active_processing_failure(job_name, job_data, attempt_started_at) then
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
  attempt_started_at timestamptz;
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if to_regclass('pgboss.job') is null then
    raise exception 'processing job not found' using errcode = 'P0001', hint = 'not_retryable';
  end if;

  execute 'select name, data, state::text, coalesce(started_on, created_on) from pgboss.job where id = $1 for update'
    into job_name, job_data, job_state, attempt_started_at using target_failed_job_id;
  target_id := private.processing_job_target_id(job_name, job_data);
  if job_state <> 'failed' or target_id is null then
    raise exception 'processing job is not retryable' using errcode = 'P0001', hint = 'not_retryable';
  end if;

  if job_name = 'split-source-file' then
    select company_id into target_company_id from public.source_file where id = target_id;
    perform 1 from public.company where id = target_company_id for update;
    if not private.is_active_processing_failure(job_name, job_data, attempt_started_at) then
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
    if not private.is_active_processing_failure(job_name, job_data, attempt_started_at) then
      raise exception 'obsolete processing failure' using errcode = 'P0001', hint = 'not_retryable';
    end if;
    perform 1 from public.document where id = target_id for update;
    delete from public.ai_processing_reservation where document_id = target_id;
    update public.document set status = 'uploaded', extraction_request_id = gen_random_uuid()
    where id = target_id and superseded_at is null and status in ('uploaded', 'processing', 'failed')
    returning organization_id, company_id into target_organization_id, target_company_id;
  else
    update public.company_data_export
    set status = 'pending', failed_at = null
    where id = target_id and status = 'failed' and used_at is null
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

-- Scalar JSON inventory is complete beyond PostgREST's configured row cap.
create function public.list_failed_processing_jobs_complete()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(job) order by job.failed_at desc, job.id), '[]'::jsonb)
  from public.list_failed_processing_jobs() job;
$$;
revoke all on function public.list_failed_processing_jobs_complete() from public, anon, service_role;
grant execute on function public.list_failed_processing_jobs_complete() to authenticated;

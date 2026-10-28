-- Make the database the sole authority for processing administration. pg-boss
-- creates its schema at runtime, so dynamic SQL keeps fresh database resets valid.

create function public.list_failed_processing_jobs()
returns table (
  id uuid,
  name text,
  target_id uuid,
  failed_at timestamptz,
  error text
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if to_regclass('pgboss.job') is null then
    return;
  end if;
  return query execute $query$
    select
      job.id,
      job.name,
      case job.name
        when 'split-source-file' then job.data ->> 'sourceFileId'
        when 'extract-document' then job.data ->> 'documentId'
      end::uuid,
      coalesce(job.completed_on, job.started_on, job.created_on),
      coalesce(job.output ->> 'message', job.output::text, '')
    from pgboss.job job
    where job.state::text = 'failed'
      and job.name in ('split-source-file', 'extract-document')
      and case job.name
        when 'split-source-file' then job.data ->> 'sourceFileId'
        when 'extract-document' then job.data ->> 'documentId'
      end ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    order by coalesce(job.completed_on, job.started_on, job.created_on) desc
  $query$;
end;
$$;

create function public.retry_failed_processing_job(target_failed_job_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  job_name text;
  job_data jsonb;
  job_state text;
  target_id uuid;
  target_organization_id uuid;
  target_company_id uuid;
  affected integer;
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if to_regclass('pgboss.job') is null then
    raise exception 'processing job not found' using errcode = 'P0001', hint = 'not_retryable';
  end if;

  execute 'select name, data, state::text from pgboss.job where id = $1 for update'
    into job_name, job_data, job_state
    using target_failed_job_id;
  if job_name is null or job_state <> 'failed' or job_name not in ('split-source-file', 'extract-document') then
    raise exception 'processing job is not retryable' using errcode = 'P0001', hint = 'not_retryable';
  end if;

  begin
    target_id := case job_name
      when 'split-source-file' then (job_data ->> 'sourceFileId')::uuid
      when 'extract-document' then (job_data ->> 'documentId')::uuid
    end;
  exception when invalid_text_representation then
    raise exception 'processing job target is invalid' using errcode = 'P0001', hint = 'not_retryable';
  end;

  if job_name = 'split-source-file' then
    update public.source_file
    set status = 'uploaded'
    where id = target_id and status in ('processing', 'failed')
    returning organization_id, company_id into target_organization_id, target_company_id;
  else
    update public.document
    set status = 'uploaded', extraction_request_id = gen_random_uuid()
    where id = target_id and superseded_at is null and status in ('processing', 'failed')
    returning organization_id, company_id into target_organization_id, target_company_id;
  end if;
  if not found then
    raise exception 'processing job target is not retryable' using errcode = 'P0001', hint = 'not_retryable';
  end if;

  execute $query$
    update pgboss.job
    set state = 'retry',
        retry_limit = retry_limit + 1,
        completed_on = null,
        start_after = greatest(start_after, now())
    where id = $1 and name = $2 and state::text = 'failed'
  $query$ using target_failed_job_id, job_name;
  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'processing job is not retryable' using errcode = 'P0001', hint = 'not_retryable';
  end if;

  perform private.record_audit_event(
    'processing.job_retried',
    target_organization_id,
    target_company_id,
    'processing_job',
    target_failed_job_id,
    jsonb_build_object('job_name', job_name, 'target_id', target_id)
  );
end;
$$;

drop function public.prepare_processing_job_retry(uuid, text, uuid);

revoke execute on function public.list_failed_processing_jobs(),
  public.retry_failed_processing_job(uuid) from public, anon;
grant execute on function public.list_failed_processing_jobs(),
  public.retry_failed_processing_job(uuid) to authenticated;

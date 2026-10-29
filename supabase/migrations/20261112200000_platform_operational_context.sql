-- Read-only live context for the SuperAdmin operational dashboard. Problems
-- are derived from authoritative state and disappear when that state resolves.

create function public.list_platform_operational_context()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  failed_jobs jsonb := '[]'::jsonb;
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if to_regclass('pgboss.job') is not null then
    execute $query$
      with parsed as (
        select
          job.name,
          case job.name
            when 'split-source-file' then job.data ->> 'sourceFileId'
            when 'extract-document' then job.data ->> 'documentId'
          end::uuid as target_id,
          coalesce(job.completed_on, job.started_on, job.created_on) as failed_at
        from pgboss.job job
        where job.state::text = 'failed'
          and job.name in ('split-source-file', 'extract-document')
          and case job.name
            when 'split-source-file' then job.data ->> 'sourceFileId'
            when 'extract-document' then job.data ->> 'documentId'
          end ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      ), grouped as (
        select
          parsed.name,
          coalesce(source.company_id, document.company_id) as company_id,
          company.name as company_name,
          count(distinct parsed.target_id)::integer as affected_count,
          min(parsed.failed_at) as first_failed_at
        from parsed
        left join public.source_file source
          on parsed.name = 'split-source-file' and source.id = parsed.target_id
        left join public.document document
          on parsed.name = 'extract-document' and document.id = parsed.target_id
        join public.company company
          on company.id = coalesce(source.company_id, document.company_id)
        group by parsed.name, coalesce(source.company_id, document.company_id), company.name
      )
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', grouped.name,
        'companyId', grouped.company_id,
        'companyName', grouped.company_name,
        'affectedCount', grouped.affected_count,
        'firstFailedAt', grouped.first_failed_at
      ) order by grouped.first_failed_at), '[]'::jsonb)
      from grouped
    $query$ into failed_jobs;
  end if;

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

revoke execute on function public.list_platform_operational_context()
  from public, anon;
grant execute on function public.list_platform_operational_context()
  to authenticated;

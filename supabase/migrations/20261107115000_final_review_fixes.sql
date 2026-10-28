-- Final review hardening: a user can begin an export, but only the trusted
-- server can complete its receipt after every original has been archived.
alter table public.company_data_export
  alter column byte_size drop not null,
  alter column sha256 drop not null,
  add column completion_token_hash bytea,
  add column completed_at timestamptz;

update public.company_data_export
set completed_at = created_at
where byte_size is not null and sha256 is not null;

alter table public.company_data_export
  add constraint company_data_export_completion_state check (
    (
      completed_at is null
      and completion_token_hash is not null
      and byte_size is null
      and sha256 is null
    )
    or (
      completed_at is not null
      and completion_token_hash is null
      and byte_size is not null
      and sha256 is not null
    )
  );

drop function public.record_company_data_export(uuid, uuid, text, bigint, text, bigint);

create function public.create_company_data_export(target_company_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  target public.company;
  export_id uuid := gen_random_uuid();
  completion_token text := encode(extensions.gen_random_bytes(32), 'hex');
  export_file_name text;
  snapshot jsonb;
begin
  select * into target
  from public.company
  where id = target_company_id
  for update;
  if not found
    or not private.can_administrate_company(target.id, target.organization_id)
  then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  snapshot := public.company_export_snapshot(target.id);
  export_file_name := 'iVAT-company-' || target.ico || '-' || current_date || '.zip';
  insert into public.company_data_export (
    id, company_id, organization_id, created_by, file_name,
    byte_size, sha256, data_revision, completion_token_hash
  ) values (
    export_id, target.id, target.organization_id, auth.uid(), export_file_name,
    null, null, target.data_revision,
    extensions.digest(completion_token, 'sha256')
  );

  return jsonb_build_object(
    'exportId', export_id,
    'fileName', export_file_name,
    'completionToken', completion_token,
    'snapshot', snapshot
  );
end;
$$;

create function public.complete_company_data_export(
  target_export_id uuid,
  completion_token text,
  target_byte_size bigint,
  target_sha256 text
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  pending public.company_data_export;
  current_revision bigint;
begin
  if target_byte_size <= 0 or target_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid archive metadata' using errcode = '22023';
  end if;
  select * into pending
  from public.company_data_export
  where id = target_export_id and completed_at is null
  for update;
  if not found
    or pending.completion_token_hash is null
    or pending.completion_token_hash <> extensions.digest(completion_token, 'sha256')
  then
    raise exception 'export is not completable'
      using errcode = 'P0001', hint = 'export_failed';
  end if;
  select data_revision into current_revision
  from public.company where id = pending.company_id for update;
  if current_revision is distinct from pending.data_revision then
    raise exception 'Company data changed during export'
      using errcode = 'P0001', hint = 'stale_export';
  end if;

  update public.company_data_export
  set byte_size = target_byte_size,
      sha256 = target_sha256,
      completion_token_hash = null,
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

create or replace function public.soft_delete_company(
  target_company_id uuid,
  target_export_id uuid
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  target public.company;
  completed_export public.company_data_export;
  source_file_count bigint;
  document_count bigint;
  approved_document_count bigint;
  period_lock_count bigint;
begin
  select * into target from public.company where id = target_company_id for update;
  if not found or target.deleted_at is not null
    or not private.can_administrate_company(target.id, target.organization_id)
  then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select * into completed_export
  from public.company_data_export export
  where export.id = target_export_id
    and export.company_id = target.id
    and export.created_by = auth.uid()
    and export.completed_at is not null
    and export.used_at is null
  for update;
  if not found then
    raise exception 'a completed Company export is required'
      using errcode = 'P0001', hint = 'export_required';
  end if;
  if completed_export.data_revision <> target.data_revision then
    raise exception 'Company data changed after export'
      using errcode = 'P0001', hint = 'stale_export';
  end if;

  select count(*) into source_file_count from public.source_file where company_id = target.id;
  select count(*), count(*) filter (where status = 'approved')
    into document_count, approved_document_count
    from public.document where company_id = target.id;
  select count(*) into period_lock_count from public.period_lock where company_id = target.id;

  update public.company
  set deleted_at = clock_timestamp(), deleted_by = auth.uid(),
      ai_processing_enabled = false, ai_provider = null, ai_region = null
  where id = target.id;
  update public.company_data_export set used_at = clock_timestamp() where id = completed_export.id;

  perform private.record_audit_event(
    'company.deleted', target.organization_id, target.id, 'company', target.id,
    jsonb_build_object(
      'export_id', completed_export.id,
      'source_file_count', source_file_count,
      'document_count', document_count
    )
  );

  return jsonb_build_object(
    'sourceFileCount', source_file_count,
    'documentCount', document_count,
    'approvedDocumentCount', approved_document_count,
    'periodLockCount', period_lock_count
  );
end;
$$;

revoke execute on function public.company_export_snapshot(uuid),
  public.create_company_data_export(uuid),
  public.complete_company_data_export(uuid, text, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_company_data_export(uuid) to authenticated;
grant execute on function public.complete_company_data_export(uuid, text, bigint, text) to service_role;

-- Historical Companies stay hidden from ordinary Company queries, but an
-- Organization Administrator can resolve them for audit display and filters.
create function public.audit_companies(target_organization_id uuid)
returns table (id uuid, name text)
language sql stable security definer set search_path = ''
as $$
  select company.id, company.name
  from public.company company
  where company.organization_id = target_organization_id
    and private.is_organization_administrator(target_organization_id)
  order by company.name, company.id;
$$;

revoke execute on function public.audit_companies(uuid) from public, anon;
grant execute on function public.audit_companies(uuid) to authenticated;

-- One canonical extraction of a processing target id is shared by listing and
-- retry. Transitions remain explicit because the two aggregates have different
-- statutory state and extraction-request rules.
create function private.processing_job_target_id(job_name text, job_data jsonb)
returns uuid
language plpgsql immutable set search_path = ''
as $$
declare
  data_key text;
begin
  data_key := case job_name
    when 'split-source-file' then 'sourceFileId'
    when 'extract-document' then 'documentId'
  end;
  if data_key is null or coalesce(job_data ->> data_key, '') !~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    return null;
  end if;
  return (job_data ->> data_key)::uuid;
end;
$$;

create or replace function public.list_failed_processing_jobs()
returns table (id uuid, name text, target_id uuid, failed_at timestamptz, error text)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if to_regclass('pgboss.job') is null then return; end if;
  return query execute $query$
    select job.id, job.name,
      private.processing_job_target_id(job.name, job.data),
      coalesce(job.completed_on, job.started_on, job.created_on),
      coalesce(job.output ->> 'message', job.output::text, '')
    from pgboss.job job
    where job.state::text = 'failed'
      and private.processing_job_target_id(job.name, job.data) is not null
    order by coalesce(job.completed_on, job.started_on, job.created_on) desc
  $query$;
end;
$$;

create or replace function public.retry_failed_processing_job(target_failed_job_id uuid)
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
    into job_name, job_data, job_state using target_failed_job_id;
  target_id := private.processing_job_target_id(job_name, job_data);
  if job_state <> 'failed' or target_id is null then
    raise exception 'processing job is not retryable' using errcode = 'P0001', hint = 'not_retryable';
  end if;

  if job_name = 'split-source-file' then
    update public.source_file set status = 'uploaded'
    where id = target_id and status in ('processing', 'failed')
    returning organization_id, company_id into target_organization_id, target_company_id;
  else
    update public.document set status = 'uploaded', extraction_request_id = gen_random_uuid()
    where id = target_id and superseded_at is null and status in ('processing', 'failed')
    returning organization_id, company_id into target_organization_id, target_company_id;
  end if;
  if not found then
    raise exception 'processing job target is not retryable' using errcode = 'P0001', hint = 'not_retryable';
  end if;

  execute $query$
    update pgboss.job
    set state = 'retry', retry_limit = retry_limit + 1,
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
$$;

revoke execute on function private.processing_job_target_id(text, jsonb) from public;

-- Worker requests are generation-bound, including late failures and retry compensation.
drop function public.record_split(uuid, jsonb);
CREATE OR REPLACE FUNCTION public.record_split(target_source_file_id uuid, source_ranges jsonb, target_split_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  file public.source_file;
  source_range jsonb;
  previous_last_page integer := 0;
begin
  if auth.role() <> 'service_role' then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into file from public.source_file where id = target_source_file_id;
  if not found then return; end if;
  perform 1 from public.company where id = file.company_id for update;
  select * into file from public.source_file where id = target_source_file_id for update;
  if not found then
    raise exception 'source file % does not exist', target_source_file_id;
  end if;
  if file.split_request_id is distinct from target_split_request_id
    or file.status not in ('uploaded', 'processing') then
    return;
  end if;
  if jsonb_array_length(source_ranges) = 0 then
    raise exception 'a Split yields at least one Document';
  end if;

  for source_range in select value from jsonb_array_elements(source_ranges) loop
    if file.format::text in ('xlsx', 'xls') then
      if coalesce(trim(source_range ->> 'sheetName'), '') = ''
        or (source_range ->> 'firstRow')::integer < 1
        or (source_range ->> 'lastRow')::integer < (source_range ->> 'firstRow')::integer then
        raise exception 'workbook row sets must name a sheet and contain positive ascending rows';
      end if;
      insert into public.document (
        organization_id, company_id, source_file_id, first_page, last_page,
        source_sheet, first_row, last_row, has_document_image
      ) values (
        file.organization_id, file.company_id, file.id,
        (source_range ->> 'firstRow')::integer, (source_range ->> 'lastRow')::integer,
        source_range ->> 'sheetName',
        (source_range ->> 'firstRow')::integer, (source_range ->> 'lastRow')::integer,
        false
      );
    else
      if (source_range ->> 'firstPage')::integer <= previous_last_page
        or (source_range ->> 'lastPage')::integer < (source_range ->> 'firstPage')::integer
        or (source_range ->> 'lastPage')::integer > file.page_count then
        raise exception 'page ranges must be ascending, disjoint and within the % pages', file.page_count;
      end if;
      previous_last_page := (source_range ->> 'lastPage')::integer;
      insert into public.document (organization_id, company_id, source_file_id, first_page, last_page)
      values (
        file.organization_id, file.company_id, file.id,
        (source_range ->> 'firstPage')::integer, (source_range ->> 'lastPage')::integer
      );
    end if;
  end loop;

  update public.source_file set status = 'split' where id = file.id;
end;
$function$;
revoke all on function public.record_split(uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.record_split(uuid, jsonb, uuid) to service_role;

create function public.move_source_processing_status(target_source_file_id uuid, target_split_request_id uuid,
  target_status public.source_file_status, expected_statuses public.source_file_status[])
returns boolean language plpgsql security definer set search_path = '' as $$
declare company_id uuid; changed_rows bigint;
begin
  if auth.role() <> 'service_role' or target_status not in ('uploaded', 'processing', 'failed', 'waiting_for_platform') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select source.company_id into company_id from public.source_file source where source.id = target_source_file_id;
  if not found then return false; end if;
  perform 1 from public.company company where company.id = company_id for update;
  update public.source_file source set status = target_status
  where source.id = target_source_file_id and source.split_request_id = target_split_request_id
    and source.status = any(expected_statuses) and source.status in ('uploaded', 'processing', 'waiting_for_platform');
  get diagnostics changed_rows = row_count;
  return changed_rows > 0;
end;
$$;
revoke all on function public.move_source_processing_status(uuid, uuid, public.source_file_status, public.source_file_status[]) from public, anon, authenticated;
grant execute on function public.move_source_processing_status(uuid, uuid, public.source_file_status, public.source_file_status[]) to service_role;
drop function public.record_ai_processing_issue(public.ai_processing_target_kind, uuid, public.ai_processing_issue_classification, public.ai_processing_issue_state, uuid, text, uuid);
CREATE OR REPLACE FUNCTION public.record_ai_processing_issue(target_kind ai_processing_target_kind, target_id uuid, target_classification ai_processing_issue_classification, target_state ai_processing_issue_state, target_configuration_id uuid DEFAULT NULL::uuid, target_provider text DEFAULT NULL::text, target_extraction_request_id uuid DEFAULT NULL::uuid, target_split_request_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    from public.source_file where id = target_id;
    if not found then return; end if;
    perform 1 from public.company where id = target_company_id for update;
    update public.source_file
    set status = case target_state
      when 'waiting_for_platform' then 'waiting_for_platform'::public.source_file_status
      else 'failed'::public.source_file_status
    end
    where id = target_id
      and split_request_id = target_split_request_id
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
    from public.document where id = target_id;
    if not found then return; end if;
    perform 1 from public.company where id = target_company_id for update;
    update public.document
    set status = case target_state
      when 'waiting_for_platform' then 'waiting_for_platform'::public.document_status
      else 'failed'::public.document_status
    end
    where id = target_id
      and extraction_request_id = target_extraction_request_id
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
$function$;
revoke all on function public.record_ai_processing_issue(public.ai_processing_target_kind, uuid, public.ai_processing_issue_classification, public.ai_processing_issue_state, uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_ai_processing_issue(public.ai_processing_target_kind, uuid, public.ai_processing_issue_classification, public.ai_processing_issue_state, uuid, text, uuid, uuid) to service_role;

create or replace function public.retry_split(target_source_file_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare file public.source_file;
begin
  file := private.source_file_for_recovery(target_source_file_id);
  if file.status not in ('failed', 'needs_review') then
    raise exception 'the Source is not retryable' using errcode = 'P0001', hint = 'not_retryable';
  end if;
  if exists (select 1 from public.document where source_file_id = file.id) then
    raise exception 'use the concrete Documents' using errcode = 'P0001', hint = 'source_already_resolved';
  end if;
  update public.upload_batch set processing_finished_at = null where id = file.upload_batch_id;
  update public.notification set read_at = coalesce(read_at, now())
    where kind = 'upload_batch_finished' and payload ->> 'batchId' = file.upload_batch_id::text;
  update public.source_file set status = 'uploaded', split_request_id = gen_random_uuid() where id = file.id;
end;
$$;
drop function public.resume_platform_ai_processing(uuid, uuid);
CREATE OR REPLACE FUNCTION public.resume_platform_ai_processing(target_company_id uuid DEFAULT NULL::uuid, target_configuration_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(target_kind ai_processing_target_kind, target_id uuid, classification ai_processing_issue_classification, configuration_id uuid, provider text, first_detected_at timestamp with time zone, extraction_request_id uuid, split_request_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  resumed_count bigint;
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if target_company_id is null and target_configuration_id is null then
    raise exception 'recovery target required' using errcode = '42501';
  end if;

  -- Serialize each Company's reservations and human decisions before issue rows.
  perform 1 from public.company company
  where company.id in (
    select issue.company_id from public.ai_processing_issue issue
    where issue.state = 'waiting_for_platform'
      and (target_company_id is null or issue.company_id = target_company_id)
      and (target_configuration_id is null or issue.configuration_id = target_configuration_id)
  ) order by company.id for update;

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
      set status = 'uploaded', split_request_id = gen_random_uuid()
      from selected
      where selected.target_kind = 'source_file'
        and source.id = selected.target_id
        and source.status = 'waiting_for_platform'
      returning selected.target_kind, selected.target_id, selected.classification,
        selected.configuration_id, selected.provider, selected.first_detected_at, null::uuid as extraction_request_id, source.split_request_id
    ), released_reservations as (
      delete from public.ai_processing_reservation reservation using selected
      where selected.target_kind = 'document' and reservation.document_id = selected.target_id
    ), reset_documents as (
      update public.document document
      set status = 'uploaded', extraction_request_id = gen_random_uuid()
      from selected
      where selected.target_kind = 'document'
        and document.id = selected.target_id
        and document.status = 'waiting_for_platform'
      returning selected.target_kind, selected.target_id, selected.classification,
        selected.configuration_id, selected.provider, selected.first_detected_at, document.extraction_request_id, null::uuid as split_request_id
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
      recovered.configuration_id, recovered.provider, recovered.first_detected_at, recovered.extraction_request_id, recovered.split_request_id
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
$function$;
revoke all on function public.resume_platform_ai_processing(uuid, uuid) from public, anon, service_role;
grant execute on function public.resume_platform_ai_processing(uuid, uuid) to authenticated;
CREATE OR REPLACE FUNCTION public.restore_platform_ai_processing_wait(target_work jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  -- Compensation can span Companies; acquire Document ownership in stable order.
  perform 1 from public.company company
  where company.id in (
    select document.company_id from public.document document
    join jsonb_to_recordset(target_work) as item(target_kind public.ai_processing_target_kind, target_id uuid)
      on item.target_kind = 'document' and item.target_id = document.id
    union
    select source.company_id from public.source_file source
    join jsonb_to_recordset(target_work) as item(target_kind public.ai_processing_target_kind, target_id uuid)
      on item.target_kind = 'source_file' and item.target_id = source.id
  ) order by company.id for update;

  for work in
    select *
    from jsonb_to_recordset(target_work) as item(
      target_kind public.ai_processing_target_kind,
      target_id uuid,
      classification public.ai_processing_issue_classification,
      configuration_id uuid,
      provider text,
      first_detected_at timestamptz,
      extraction_request_id uuid,
      split_request_id uuid
    )
  loop
    target_organization_id := null;
    target_company_id := null;
    if work.target_kind = 'source_file' then
      update public.source_file source
      set status = 'waiting_for_platform'
      where source.id = work.target_id and source.status = 'uploaded'
        and source.split_request_id = work.split_request_id
      returning source.organization_id, source.company_id
      into target_organization_id, target_company_id;
    else
      update public.document document
      set status = 'waiting_for_platform'
      where document.id = work.target_id
        and document.status = 'uploaded'
        and document.extraction_request_id = work.extraction_request_id
        and document.superseded_at is null
      returning document.organization_id, document.company_id
      into target_organization_id, target_company_id;
    end if;

    if target_organization_id is not null then
      insert into public.ai_processing_issue (
        target_kind, target_id, organization_id, company_id, configuration_id,
        provider, classification, state, first_detected_at
      ) values (
        work.target_kind, work.target_id, target_organization_id, target_company_id,
        work.configuration_id, work.provider, work.classification, 'waiting_for_platform',
        work.first_detected_at
      )
      on conflict on constraint ai_processing_issue_pkey do update
      set configuration_id = excluded.configuration_id,
          provider = excluded.provider,
          classification = excluded.classification,
          first_detected_at = excluded.first_detected_at,
          updated_at = now()
      where ai_processing_issue.state = 'waiting_for_platform';
    end if;
  end loop;
end;
$function$;
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
    select company_id into target_company_id from public.source_file where id = target_id;
    perform 1 from public.company where id = target_company_id for update;
    update public.source_file set status = 'uploaded', split_request_id = gen_random_uuid()
    where id = target_id and status in ('processing', 'failed')
    returning organization_id, company_id into target_organization_id, target_company_id;
  elsif job_name = 'extract-document' then
    select company_id into target_company_id from public.document where id = target_id;
    perform 1 from public.company where id = target_company_id for update;
    perform 1 from public.document where id = target_id for update;
    delete from public.ai_processing_reservation where document_id = target_id;
    update public.document set status = 'uploaded', extraction_request_id = gen_random_uuid()
    where id = target_id and superseded_at is null and status in ('processing', 'failed')
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
$function$;

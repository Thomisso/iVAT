-- Existing transitions acquire Company before Document; shared page guards retain their Role, Period Lock and real source prerequisites.
CREATE OR REPLACE FUNCTION public.return_document_to_review(target_document_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  doc public.document;
begin
  select * into doc from public.document where id = target_document_id;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform 1 from public.company where id = doc.company_id for update;
  select * into doc from public.document where id = target_document_id for update;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if doc.superseded_at is not null or doc.status <> 'approved' then
    raise exception 'only an Approved Document can be returned to review'
      using errcode = 'P0001', hint = 'not_approved';
  end if;

  update public.document set status = 'needs_review' where id = doc.id;
  perform private.record_audit_event(
    'document.returned_to_review', doc.organization_id, doc.company_id, 'document', doc.id, '{}'
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.update_document_reporting(target_document_id uuid, new_claimed_reporting_period text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  doc public.document;
  payload jsonb;
  tax_point_date date;
  assigned_period text;
  claimed_start date;
begin
  select * into doc from public.document where id = target_document_id;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform 1 from public.company where id = doc.company_id for update;
  select * into doc from public.document where id = target_document_id for update;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select version.payload into payload
  from public.extraction_version version
  where version.document_id = doc.id
  order by version.version desc
  limit 1;
  if coalesce(payload ->> 'direction', '') <> 'incoming' then
    raise exception 'only an incoming Document has a Deferred Claim'
      using errcode = 'P0001', hint = 'incoming_required';
  end if;
  begin
    tax_point_date := (payload ->> 'taxPointDate')::date;
  exception when datetime_field_overflow or invalid_datetime_format then
    raise exception 'a valid Tax Point Date is required'
      using errcode = 'P0001', hint = 'invalid_tax_point_date';
  end;
  if tax_point_date is null then
    raise exception 'a valid Tax Point Date is required'
      using errcode = 'P0001', hint = 'invalid_tax_point_date';
  end if;

  assigned_period := private.reporting_period_for_date(doc.company_id, tax_point_date);
  if assigned_period is null then
    raise exception 'the Tax Point Date is outside every Reporting Year'
      using errcode = 'P0001', hint = 'invalid_reporting_period';
  end if;

  if new_claimed_reporting_period is not null then
    claimed_start := private.reporting_period_start(new_claimed_reporting_period);
    if claimed_start is null
      or claimed_start > tax_point_date + interval '3 years'
      or private.reporting_period_for_date(doc.company_id, claimed_start)
        is distinct from new_claimed_reporting_period then
      raise exception 'the claimed Reporting Period is not a Reporting Period of the Company'
        using errcode = 'P0001', hint = 'invalid_reporting_period';
    end if;
    if claimed_start <= private.reporting_period_start(assigned_period) then
      raise exception 'the claimed Reporting Period must be later'
        using errcode = 'P0001', hint = 'claimed_period_not_later';
    end if;
  end if;

  if doc.claimed_reporting_period is not distinct from new_claimed_reporting_period then
    return;
  end if;

  update public.document
  set claimed_reporting_period = new_claimed_reporting_period
  where id = doc.id;

  perform private.record_audit_event(
    'document.reporting_assignment_changed',
    doc.organization_id,
    doc.company_id,
    'document',
    doc.id,
    jsonb_build_object(
      'claimed_reporting_period', jsonb_build_object(
        'from', doc.claimed_reporting_period,
        'to', new_claimed_reporting_period
      )
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.split_document(target_document_id uuid, split_after_page integer)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  doc public.document;
  new_document_id uuid;
begin
  select * into doc from public.document where id = target_document_id;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform 1 from public.company where id = doc.company_id for update;
  select * into doc from public.document where id = target_document_id for update;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform private.assert_split_document_correctable(doc);
  if split_after_page < doc.first_page or split_after_page >= doc.last_page then
    raise exception 'Split point must be inside the Document'
      using errcode = 'P0001', hint = 'invalid_split_boundary';
  end if;

  update public.document
    set last_page = split_after_page,
        status = 'uploaded',
        extraction_request_id = gen_random_uuid()
    where id = doc.id;
  insert into public.document (
    organization_id, company_id, source_file_id, first_page, last_page, status
  ) values (
    doc.organization_id, doc.company_id, doc.source_file_id,
    split_after_page + 1, doc.last_page, 'uploaded'
  ) returning id into new_document_id;

  perform private.record_audit_event(
    'source_file.split_corrected', doc.organization_id, doc.company_id,
    'source_file', doc.source_file_id,
    jsonb_build_object(
      'operation', 'split',
      'affected_document_ids', jsonb_build_array(doc.id, new_document_id),
      'superseded_document_ids', '[]'::jsonb
    )
  );
  return array[doc.id, new_document_id];
end;
$function$;

CREATE OR REPLACE FUNCTION public.merge_documents(left_document_id uuid, right_document_id uuid)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  left_doc public.document;
  right_doc public.document;
begin
  -- Validate the single-Company boundary before any row locks.
  select * into left_doc from public.document where id = left_document_id;
  select * into right_doc from public.document where id = right_document_id;
  if not found or left_doc.id is null
    or not private.can_access_company(left_doc.company_id, left_doc.organization_id)
    or not private.can_access_company(right_doc.company_id, right_doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if left_doc.company_id is distinct from right_doc.company_id then
    raise exception 'page correction requires one Company' using errcode = 'P0001', hint = 'invalid_split_boundary';
  end if;
  perform 1 from public.company where id = left_doc.company_id for update;
  perform id from public.document
    where id in (left_document_id, right_document_id)
    order by id for update;
  select * into left_doc from public.document where id = left_document_id;
  select * into right_doc from public.document where id = right_document_id;
  if not found or left_doc.id is null
    or not private.can_access_company(left_doc.company_id, left_doc.organization_id)
    or not private.can_access_company(right_doc.company_id, right_doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform private.assert_split_document_correctable(left_doc);
  perform private.assert_split_document_correctable(right_doc);
  if left_doc.source_file_id <> right_doc.source_file_id
    or left_doc.last_page + 1 <> right_doc.first_page then
    raise exception 'Documents must be adjacent and in page order'
      using errcode = 'P0001', hint = 'invalid_split_boundary';
  end if;

  update public.document
    set superseded_at = clock_timestamp()
    where id = right_doc.id;
  update public.document
    set last_page = right_doc.last_page,
        status = 'uploaded',
        extraction_request_id = gen_random_uuid()
    where id = left_doc.id;

  perform private.record_audit_event(
    'source_file.split_corrected', left_doc.organization_id, left_doc.company_id,
    'source_file', left_doc.source_file_id,
    jsonb_build_object(
      'operation', 'merge',
      'affected_document_ids', jsonb_build_array(left_doc.id),
      'superseded_document_ids', jsonb_build_array(right_doc.id)
    )
  );
  return array[left_doc.id];
end;
$function$;

CREATE OR REPLACE FUNCTION public.move_document_page(source_document_id uuid, target_document_id uuid, page integer)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  source_doc public.document;
  target_doc public.document;
begin
  -- Validate the single-Company boundary before any row locks.
  select * into source_doc from public.document where id = source_document_id;
  select * into target_doc from public.document where id = target_document_id;
  if not found or source_doc.id is null
    or not private.can_access_company(source_doc.company_id, source_doc.organization_id)
    or not private.can_access_company(target_doc.company_id, target_doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if source_doc.company_id is distinct from target_doc.company_id then
    raise exception 'page correction requires one Company' using errcode = 'P0001', hint = 'invalid_split_boundary';
  end if;
  perform 1 from public.company where id = source_doc.company_id for update;
  perform id from public.document
    where id in (source_document_id, target_document_id)
    order by id for update;
  select * into source_doc from public.document where id = source_document_id;
  select * into target_doc from public.document where id = target_document_id;
  if not found or source_doc.id is null
    or not private.can_access_company(source_doc.company_id, source_doc.organization_id)
    or not private.can_access_company(target_doc.company_id, target_doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform private.assert_split_document_correctable(source_doc);
  perform private.assert_split_document_correctable(target_doc);
  if source_doc.source_file_id <> target_doc.source_file_id
    or source_doc.first_page = source_doc.last_page then
    raise exception 'A boundary page can only move between adjacent Documents'
      using errcode = 'P0001', hint = 'invalid_split_boundary';
  end if;

  if source_doc.last_page + 1 = target_doc.first_page and page = source_doc.last_page then
    update public.document set last_page = page - 1 where id = source_doc.id;
    update public.document set first_page = page where id = target_doc.id;
  elsif target_doc.last_page + 1 = source_doc.first_page and page = source_doc.first_page then
    update public.document set last_page = page where id = target_doc.id;
    update public.document set first_page = page + 1 where id = source_doc.id;
  else
    raise exception 'Only the shared boundary page can move'
      using errcode = 'P0001', hint = 'invalid_split_boundary';
  end if;

  update public.document
    set status = 'uploaded', extraction_request_id = gen_random_uuid()
    where id in (source_doc.id, target_doc.id);
  perform private.record_audit_event(
    'source_file.split_corrected', source_doc.organization_id, source_doc.company_id,
    'source_file', source_doc.source_file_id,
    jsonb_build_object(
      'operation', 'move_page',
      'page', page,
      'affected_document_ids', jsonb_build_array(source_doc.id, target_doc.id),
      'superseded_document_ids', '[]'::jsonb
    )
  );
  return array[source_doc.id, target_doc.id];
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_upload_batch(target_batch_id uuid)
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  batch public.upload_batch;
  refusal text;
  source_ids uuid[];
  document_ids uuid[];
  object_names text[];
  document_count integer;
  approved_document_count integer;
begin
  select * into batch from public.upload_batch where id = target_batch_id;
  if not found
    or not private.can_access_company(batch.company_id, batch.organization_id)
    or not (
      batch.created_by = auth.uid()
      or private.is_company_administrator(batch.company_id, batch.organization_id)
    ) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform 1 from public.company where id = batch.company_id for update;
  select * into batch from public.upload_batch where id = target_batch_id for update;
  if not found
    or not private.can_access_company(batch.company_id, batch.organization_id)
    or not (
      batch.created_by = auth.uid()
      or private.is_company_administrator(batch.company_id, batch.organization_id)
    ) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  refusal := private.upload_batch_deletion_refusal(batch);
  if refusal = 'batch_processing' then
    raise exception 'the Upload Batch is still processing'
      using errcode = 'P0001', hint = 'batch_processing';
  elsif refusal = 'period_locked' then
    raise exception 'the Reporting Period is locked'
      using errcode = 'P0001', hint = 'period_locked';
  end if;

  select coalesce(array_agg(sf.id), '{}') into source_ids
  from public.source_file sf
  where sf.upload_batch_id = batch.id;

  select
    count(*) filter (where d.superseded_at is null),
    count(*) filter (where d.superseded_at is null and d.status = 'approved')
  into document_count, approved_document_count
  from public.document d
  where d.source_file_id = any(source_ids);

  set constraints public.extraction_version_document_id_company_id_organization_id_fkey deferred;
  -- The Period Lock trigger still guards each deleted Document.
  with deleted as (
    delete from public.document d
    where d.source_file_id = any(source_ids)
    returning d.id
  )
  select coalesce(array_agg(deleted.id), '{}') into document_ids from deleted;
  delete from public.extraction_version v where v.document_id = any(document_ids);
  set constraints public.extraction_version_document_id_company_id_organization_id_fkey immediate;

  delete from public.ai_processing_issue i
  where (i.target_kind = 'document' and i.target_id = any(document_ids))
    or (i.target_kind = 'source_file' and i.target_id = any(source_ids));

  insert into private.deleted_source_file_object (name, organization_id, company_id)
  select o.name, batch.organization_id, batch.company_id
  from storage.objects o
  join unnest(source_ids) as source(id)
    on o.name = batch.company_id::text || '/' || source.id::text
    or o.name like batch.company_id::text || '/' || source.id::text || '/%'
  where o.bucket_id = 'source-files'
  on conflict (name) do nothing;

  delete from public.source_file sf where sf.id = any(source_ids);
  delete from public.notification n
  where n.kind = 'upload_batch_finished' and n.payload ->> 'batchId' = batch.id::text;
  delete from public.upload_batch b where b.id = batch.id;

  perform private.record_audit_event(
    'upload_batch.deleted',
    batch.organization_id,
    batch.company_id,
    'upload_batch',
    batch.id,
    jsonb_build_object(
      'sourceFileCount', cardinality(source_ids),
      'documentCount', document_count,
      'approvedDocumentCount', approved_document_count
    )
  );

  select coalesce(array_agg(o.name order by o.name), '{}') into object_names
  from private.deleted_source_file_object o
  where o.company_id = batch.company_id;
  return object_names;
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
    update public.source_file set status = 'uploaded'
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
      extraction_request_id uuid
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

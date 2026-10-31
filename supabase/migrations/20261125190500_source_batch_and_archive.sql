-- Manual Source work is pending human work, not a fabricated Document or AI queue.
create function private.restart_source_upload_batch(file public.source_file)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.upload_batch set processing_finished_at = null where id = file.upload_batch_id;
  update public.notification set read_at = coalesce(read_at, now())
    where kind = 'upload_batch_finished' and payload ->> 'batchId' = file.upload_batch_id::text;
end;
$$;
revoke all on function private.restart_source_upload_batch(public.source_file) from public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.maybe_complete_upload_batch(target_batch_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      and source.status in ('uploaded', 'waiting_for_platform', 'processing', 'needs_review')
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
$function$;

create or replace function private.upload_batch_deletion_refusal(batch public.upload_batch)
returns text
language sql stable security definer set search_path = ''
as $$
  select case
    when batch.upload_finished_at is null or batch.processing_finished_at is null then 'batch_processing'
    when exists (select 1 from public.source_file source where source.upload_batch_id = batch.id and private.source_file_locked_period(source.id) is not null) then 'period_locked'
    when exists (
      select 1
      from public.source_file sf
      join public.document d on d.source_file_id = sf.id
      cross join lateral (
        select private.document_reporting_period_for(d, (
          select v.payload from public.extraction_version v
          where v.document_id = d.id
          order by v.version desc
          limit 1
        )) as period
      ) assigned
      where sf.upload_batch_id = batch.id
        and assigned.period is not null
        and private.is_reporting_period_locked(d.company_id, assigned.period)
    ) then 'period_locked'
  end;
$$;


-- Preserve the Source resolution receipt alongside actual originals in archives.
alter function public.company_export_snapshot(uuid) rename to company_export_snapshot_without_source_recovery;
alter function public.company_export_snapshot_without_source_recovery(uuid) set schema private;
create function public.company_export_snapshot(target_company_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare snapshot jsonb;
begin
  snapshot := private.company_export_snapshot_without_source_recovery(target_company_id);
  return jsonb_set(snapshot, '{sourceFiles}', coalesce((
    select jsonb_agg(entry.value
      || case when source.exclusion_reason is not null then jsonb_build_object('exclusion', jsonb_build_object(
        'reason', source.exclusion_reason, 'at', source.excluded_at, 'userId', source.excluded_by
      )) else '{}'::jsonb end
      || case when source.manually_defined_at is not null then jsonb_build_object('manualDefinition', jsonb_build_object(
        'at', source.manually_defined_at, 'userId', source.manually_defined_by, 'ranges', source.manual_definition
      )) else '{}'::jsonb end order by entry.ordinality)
    from jsonb_array_elements(snapshot -> 'sourceFiles') with ordinality entry(value, ordinality)
    join public.source_file source on source.id = (entry.value ->> 'id')::uuid and source.company_id = target_company_id
  ), '[]'::jsonb));
end;
$$;
revoke all on function public.company_export_snapshot(uuid), private.company_export_snapshot_without_source_recovery(uuid) from public, anon, authenticated, service_role;

-- Persistent upload workspaces and actionable completion notifications.

alter table public.notification
  add column read_at timestamptz;

create view public.upload_batch_summary
with (security_invoker = true)
as
select
  b.id,
  b.company_id,
  b.file_count,
  b.upload_finished_at,
  b.processing_finished_at,
  b.created_at,
  count(distinct sf.id)::integer as actual_file_count,
  case when b.upload_finished_at is null
    then greatest(b.file_count - count(distinct sf.id)::integer, 0)
    else 0
  end as transport_count,
  case when b.upload_finished_at is not null
    then greatest(b.file_count - count(distinct sf.id)::integer, 0)
    else 0
  end as transport_failure_count,
  (
    count(distinct sf.id) filter (where sf.status = 'uploaded')
    + count(distinct d.id) filter (where d.status = 'uploaded')
  )::integer as waiting_count,
  count(distinct sf.id) filter (where sf.status = 'processing')::integer as splitting_count,
  count(distinct sf.id) filter (where sf.status = 'failed')::integer as source_failure_count,
  count(distinct d.id) filter (where d.status = 'processing')::integer as extracting_count,
  count(distinct d.id) filter (where d.status = 'needs_review')::integer as review_count,
  count(distinct d.id) filter (where d.status in ('approved', 'rejected'))::integer as reviewed_count,
  count(distinct d.id) filter (where d.status = 'failed')::integer as document_failure_count
from public.upload_batch b
left join public.source_file sf on sf.upload_batch_id = b.id
left join public.document d on d.source_file_id = sf.id and d.superseded_at is null
group by b.id;

revoke all on public.upload_batch_summary from public, anon;
grant select on public.upload_batch_summary to authenticated;

create index notification_user_unread_idx
  on public.notification (user_id, created_at desc)
  where read_at is null;

-- Notifications created before this migration only identified the batch. Fill
-- their outcome from durable batch state so an old failure can never be shown
-- with success copy after deployment.
with batch_outcome as (
  select
    b.id,
    count(distinct sf.id)::integer as file_count,
    greatest(b.file_count - count(distinct sf.id)::integer, 0) as transport_failure_count,
    count(distinct sf.id) filter (where sf.status = 'failed')::integer as source_failure_count,
    count(distinct d.id) filter (where d.status = 'failed')::integer as document_failure_count,
    count(distinct d.id) filter (where d.status = 'needs_review')::integer as review_count,
    count(distinct d.id) filter (where d.status in ('approved', 'rejected'))::integer as reviewed_count
  from public.upload_batch b
  left join public.source_file sf on sf.upload_batch_id = b.id
  left join public.document d on d.source_file_id = sf.id and d.superseded_at is null
  group by b.id
), payloads as (
  select
    n.id,
    jsonb_build_object(
      'fileCount', o.file_count,
      'outcome', case
        when o.transport_failure_count + o.source_failure_count + o.document_failure_count = 0 then 'success'
        when o.review_count + o.reviewed_count > 0 then 'partial'
        else 'failure'
      end,
      'reviewCount', o.review_count,
      'transportFailureCount', o.transport_failure_count,
      'sourceFailureCount', o.source_failure_count,
      'documentFailureCount', o.document_failure_count
    ) as patch
  from public.notification n
  join batch_outcome o on n.payload ->> 'batchId' = o.id::text
  where n.kind = 'upload_batch_finished'
)
update public.notification n
set payload = n.payload || payloads.patch
from payloads
where n.id = payloads.id;

create function public.mark_upload_notification_read(target_notification_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target public.notification;
begin
  select * into target
  from public.notification
  where id = target_notification_id
  for update;

  if not found
    or target.user_id <> auth.uid()
    or not private.can_access_company(target.company_id, target.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  update public.notification
  set read_at = coalesce(read_at, now())
  where id = target.id;
end;
$$;

-- A batch completes only when no active Source File or Document remains. Its
-- notification records the real outcome, including transport gaps between the
-- selected file count and Source Files that were actually stored.
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
    select 1 from public.source_file sf
    where sf.upload_batch_id = batch.id and sf.status in ('uploaded', 'processing')
  ) or exists (
    select 1
    from public.document d
    join public.source_file sf on sf.id = d.source_file_id
    where sf.upload_batch_id = batch.id
      and d.superseded_at is null
      and d.status in ('uploaded', 'processing')
  ) then
    return;
  end if;

  select
    count(*)::integer,
    count(*) filter (where sf.status = 'failed')::integer
  into uploaded_file_count, source_failure_count
  from public.source_file sf
  where sf.upload_batch_id = batch.id;

  select
    count(*) filter (where d.status = 'failed')::integer,
    count(*) filter (where d.status = 'needs_review')::integer,
    count(*) filter (where d.status in ('approved', 'rejected'))::integer
  into document_failure_count, review_count, reviewed_count
  from public.document d
  join public.source_file sf on sf.id = d.source_file_id
  where sf.upload_batch_id = batch.id and d.superseded_at is null;

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

create or replace function public.retry_split(target_source_file_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  file public.source_file;
begin
  select * into file from public.source_file where id = target_source_file_id for update;
  if not found or not private.can_access_company(file.company_id, file.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if file.status <> 'failed' then
    raise exception 'only a failed Split can be retried' using errcode = 'P0001', hint = 'not_retryable';
  end if;
  update public.upload_batch set processing_finished_at = null where id = file.upload_batch_id;
  update public.notification
  set read_at = coalesce(read_at, now())
  where kind = 'upload_batch_finished' and payload ->> 'batchId' = file.upload_batch_id::text;
  update public.source_file set status = 'uploaded' where id = file.id;
end;
$$;

create or replace function public.reprocess_document(target_document_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  doc public.document;
  batch_id uuid;
begin
  select * into doc from public.document where id = target_document_id for update;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if doc.status not in ('failed', 'needs_review') then
    raise exception 'the Document is still being processed' using errcode = 'P0001', hint = 'not_reprocessable';
  end if;
  select sf.upload_batch_id into batch_id from public.source_file sf where sf.id = doc.source_file_id;
  update public.upload_batch set processing_finished_at = null where id = batch_id;
  update public.notification
  set read_at = coalesce(read_at, now())
  where kind = 'upload_batch_finished' and payload ->> 'batchId' = batch_id::text;
  update public.document
  set status = 'uploaded', extraction_request_id = gen_random_uuid()
  where id = doc.id;
end;
$$;

revoke execute on function public.mark_upload_notification_read(uuid) from public, anon;
grant execute on function public.mark_upload_notification_read(uuid) to authenticated;

-- Deleting a finished Upload Batch all or nothing, and marking its notification
-- read when its detail is opened.

-- An Extraction Version stays immutable while its Document exists. Only
-- public.delete_upload_batch removes Documents; it defers this constraint so
-- the Period Lock trigger still sees each Document's Extraction while the
-- Document is deleted, then removes the orphaned versions.
alter table public.extraction_version
  alter constraint extraction_version_document_id_company_id_organization_id_fkey
  deferrable initially immediate;

create or replace function private.prevent_extraction_version_change()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
    and not exists (select 1 from public.document d where d.id = old.document_id) then
    return old;
  end if;
  raise exception 'extraction_version is immutable' using errcode = '42501';
end;
$$;

-- Stored objects of deleted Source Files. The database deletes the rows; the
-- application then removes the objects through the Storage API, which only
-- deletes objects listed here.
create table private.deleted_source_file_object (
  name text primary key,
  organization_id uuid not null,
  company_id uuid not null,
  deleted_at timestamptz not null default now()
);

revoke all on private.deleted_source_file_object from public, anon, authenticated, service_role;

create function private.can_remove_deleted_source_file_object(object_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from private.deleted_source_file_object o
    where o.name = object_name
      and private.can_access_company(o.company_id, o.organization_id)
  );
$$;

revoke execute on function private.can_remove_deleted_source_file_object(text) from public;
grant execute on function private.can_remove_deleted_source_file_object(text) to authenticated;

create policy "company members remove deleted source file objects" on storage.objects
  for delete to authenticated
  using (bucket_id = 'source-files' and private.can_remove_deleted_source_file_object(name));

create function public.delete_upload_batch(target_batch_id uuid)
returns text[]
language plpgsql security definer set search_path = ''
as $$
declare
  batch public.upload_batch;
  source_ids uuid[];
  document_ids uuid[];
  object_names text[];
  document_count integer;
  approved_document_count integer;
begin
  select * into batch from public.upload_batch where id = target_batch_id for update;
  if not found
    or not private.can_access_company(batch.company_id, batch.organization_id)
    or not (
      batch.created_by = auth.uid()
      or private.is_company_administrator(batch.company_id, batch.organization_id)
    ) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if batch.upload_finished_at is null or batch.processing_finished_at is null then
    raise exception 'the Upload Batch is still processing'
      using errcode = 'P0001', hint = 'batch_processing';
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
  -- The Period Lock trigger refuses the whole deletion (period_locked) when
  -- any Document lies in a locked Reporting Period.
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

  select coalesce(array_agg(o.name), '{}') into object_names
  from storage.objects o
  join unnest(source_ids) as source(id)
    on o.name = batch.company_id::text || '/' || source.id::text
    or o.name like batch.company_id::text || '/' || source.id::text || '/%'
  where o.bucket_id = 'source-files';
  insert into private.deleted_source_file_object (name, organization_id, company_id)
  select name, batch.organization_id, batch.company_id from unnest(object_names) as name
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
  return object_names;
end;
$$;

-- Opening a finished batch marks the caller's notification for it as read. A
-- batch still processing keeps it unread, so its completion is still announced.
create function public.mark_upload_batch_notification_read(target_batch_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  batch public.upload_batch;
begin
  select * into batch from public.upload_batch where id = target_batch_id;
  if not found or not private.can_access_company(batch.company_id, batch.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if batch.processing_finished_at is null then
    return;
  end if;
  update public.notification
  set read_at = coalesce(read_at, now())
  where user_id = auth.uid()
    and kind = 'upload_batch_finished'
    and payload ->> 'batchId' = batch.id::text;
end;
$$;

revoke execute on function public.delete_upload_batch(uuid) from public, anon;
revoke execute on function public.mark_upload_batch_notification_read(uuid) from public, anon;
grant execute on function public.delete_upload_batch(uuid) to authenticated;
grant execute on function public.mark_upload_batch_notification_read(uuid) to authenticated;

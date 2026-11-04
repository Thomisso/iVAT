-- Upload and worker transitions must both lock Company before Upload Batch.
-- Otherwise a new sibling upload holds the Batch while its data-revision
-- trigger waits for the Company already held by the processing worker.
create or replace function private.validate_source_file_batch()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  batch public.upload_batch;
  existing_files integer;
begin
  if new.upload_batch_id is null then return new; end if;
  perform 1 from public.company where id = new.company_id for update;
  select * into batch from public.upload_batch where id = new.upload_batch_id for update;
  if not found
    or batch.organization_id <> new.organization_id
    or batch.company_id <> new.company_id
    or batch.created_by <> auth.uid()
    or batch.upload_finished_at is not null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if batch.selected_files is not null and not exists (
    select 1 from jsonb_array_elements(batch.selected_files) entry
    where entry->>'id' = new.id::text and entry->>'sha256' = new.sha256
  ) then
    raise exception 'Source File does not match the started selection' using errcode = 'P0001', hint = 'invalid_choice';
  end if;
  if exists (select 1 from public.source_file where upload_batch_id = batch.id and sha256 = new.sha256) then
    raise exception 'identical Source File already belongs to this batch'
      using errcode = 'P0001', hint = 'identical_file';
  end if;
  select count(*) into existing_files from public.source_file where upload_batch_id = batch.id;
  if existing_files >= batch.file_count then
    raise exception 'the upload batch already has every selected Source File'
      using errcode = 'P0001', hint = 'too_many_files';
  end if;
  return new;
end;
$$;

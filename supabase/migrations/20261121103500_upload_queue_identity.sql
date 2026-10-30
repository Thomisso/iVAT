-- Serialize content equality against the same batch lock used for its capacity.
-- Historical batches and their Source Files are left intact.
alter table public.upload_batch add column selected_files jsonb;

drop function public.begin_upload_batch(uuid, integer);
create function public.begin_upload_batch(
  target_company_id uuid,
  selected_file_count integer,
  requested_batch_id uuid default null,
  selected_files jsonb default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  company public.company;
  maximum integer;
  batch public.upload_batch;
  batch_id uuid := coalesce(requested_batch_id, gen_random_uuid());
begin
  select * into company from public.company where id = target_company_id;
  if not found or not private.can_access_company(company.id, company.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select max_upload_batch_files into maximum from public.platform_settings where singleton;
  if selected_file_count < 1 then
    raise exception 'a batch needs at least one Source File' using errcode = 'P0001', hint = 'file_required';
  end if;
  if selected_file_count > maximum then
    raise exception 'batch exceeds platform limit' using errcode = 'P0001', hint = 'too_many_files';
  end if;
  if selected_files is not null then
    if jsonb_typeof(selected_files) <> 'array' then
      raise exception 'invalid selection' using errcode = 'P0001', hint = 'invalid_choice';
    end if;
    if jsonb_array_length(selected_files) <> selected_file_count
      or exists (select 1 from jsonb_array_elements(selected_files) entry
        where jsonb_typeof(entry) <> 'object'
          or coalesce(entry->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          or coalesce(entry->>'sha256', '') !~ '^[0-9a-f]{64}$')
      or (select count(distinct entry->>'id') from jsonb_array_elements(selected_files) entry) <> selected_file_count then
      raise exception 'invalid selection' using errcode = 'P0001', hint = 'invalid_choice';
    end if;
    if (select count(distinct entry->>'sha256') from jsonb_array_elements(selected_files) entry) <> selected_file_count then
      raise exception 'identical Source Files selected' using errcode = 'P0001', hint = 'identical_file';
    end if;
  end if;
  insert into public.upload_batch (id, organization_id, company_id, created_by, file_count, selected_files)
  values (batch_id, company.organization_id, company.id, auth.uid(), selected_file_count, selected_files)
  on conflict (id) do nothing;
  select * into batch from public.upload_batch where id = batch_id for update;
  if batch.company_id <> company.id or batch.created_by <> auth.uid() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- Pre-migration started batches have only a frozen count; keep their retries usable.
  if batch.file_count <> selected_file_count
    or (batch.selected_files is not null and batch.selected_files is distinct from selected_files) then
    raise exception 'started selection is immutable' using errcode = 'P0001', hint = 'invalid_choice';
  end if;
  return batch.id;
end;
$$;
revoke execute on function public.begin_upload_batch(uuid, integer, uuid, jsonb) from public, anon;
grant execute on function public.begin_upload_batch(uuid, integer, uuid, jsonb) to authenticated;

create or replace function private.validate_source_file_batch()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  batch public.upload_batch;
  existing_files integer;
begin
  if new.upload_batch_id is null then return new; end if;
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

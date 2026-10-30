-- Require a frozen manifest on every current Batch creation path. Historical rows stay untouched.
create or replace function public.begin_upload_batch(
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
  if selected_files is null then
    -- Count-only retries belong only to a batch that already existed before manifests.
    -- A supplied UUID does not make a new manifest-less selection a legacy batch.
    select * into batch from public.upload_batch where id = requested_batch_id for update;
    if not found then
      raise exception 'new batches require a frozen selection' using errcode = 'P0001', hint = 'invalid_choice';
    end if;
  else
    insert into public.upload_batch (id, organization_id, company_id, created_by, file_count, selected_files)
    values (batch_id, company.organization_id, company.id, auth.uid(), selected_file_count, selected_files)
    on conflict (id) do nothing;
    select * into batch from public.upload_batch where id = batch_id for update;
  end if;
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


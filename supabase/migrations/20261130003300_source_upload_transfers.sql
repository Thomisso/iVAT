-- Partial bytes are private transport objects, never Source Files or worker inputs.
create table public.source_upload_transfer (
  source_file_id uuid primary key,
  organization_id uuid not null,
  company_id uuid not null,
  upload_batch_id uuid not null references public.upload_batch(id) on delete cascade,
  created_by uuid not null,
  file_name text not null check (length(trim(file_name)) > 0),
  byte_size bigint not null check (byte_size > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  confirmed_bytes bigint not null default 0 check (confirmed_bytes >= 0 and confirmed_bytes <= byte_size),
  last_progress_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.company(id, organization_id)
);
create table public.source_upload_chunk (
  source_file_id uuid not null references public.source_upload_transfer(source_file_id) on delete cascade,
  organization_id uuid not null,
  company_id uuid not null,
  byte_offset bigint not null check (byte_offset >= 0),
  byte_size integer not null check (byte_size between 1 and 1048576),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  primary key (source_file_id, byte_offset),
  foreign key (company_id, organization_id) references public.company(id, organization_id)
);
revoke all on public.source_upload_transfer, public.source_upload_chunk from public, anon, authenticated;
alter table public.source_upload_transfer enable row level security;
alter table public.source_upload_chunk enable row level security;
grant select on public.source_upload_transfer, public.source_upload_chunk to authenticated;
create policy "owner reads authorized transfers" on public.source_upload_transfer for select to authenticated
  using (created_by = auth.uid() and private.can_access_company(company_id, organization_id));
create policy "owner reads authorized chunks" on public.source_upload_chunk for select to authenticated
  using (private.can_access_company(company_id, organization_id) and exists (
    select 1 from public.source_upload_transfer t where t.source_file_id = source_upload_chunk.source_file_id and t.created_by = auth.uid()));

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('source-upload-chunks', 'source-upload-chunks', false, 1048576, array['application/octet-stream']);

create function private.can_access_source_upload_object(object_name text, writing boolean)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.source_upload_transfer t join public.upload_batch b on b.id = t.upload_batch_id
    where t.company_id::text = split_part(object_name, '/', 1)
      and t.source_file_id::text = split_part(object_name, '/', 2)
      and t.created_by = auth.uid() and private.can_access_company(t.company_id, t.organization_id)
      and (not writing or (b.upload_finished_at is null
        and not exists (select 1 from public.source_file s where s.id = t.source_file_id)
        and split_part(object_name, '/', 3) ~ '^[0-9]{1,12}$'
        and split_part(object_name, '/', 4) ~ '^[0-9a-f]{64}$'
        and array_length(string_to_array(object_name, '/'), 1) = 4
        and (split_part(object_name, '/', 3)::bigint = t.confirmed_bytes or exists (
          select 1 from public.source_upload_chunk c where c.source_file_id = t.source_file_id
            and c.byte_offset::text = split_part(object_name, '/', 3) and c.sha256 = split_part(object_name, '/', 4)))))
  );
$$;
revoke all on function private.can_access_source_upload_object(text, boolean) from public;
grant execute on function private.can_access_source_upload_object(text, boolean) to authenticated;
create policy "owner reads authorized temporary bytes" on storage.objects for select to authenticated
  using (bucket_id = 'source-upload-chunks' and private.can_access_source_upload_object(name, false));
create policy "owner stores next immutable portion" on storage.objects for insert to authenticated
  with check (bucket_id = 'source-upload-chunks' and private.can_access_source_upload_object(name, true));

create function public.reconcile_source_upload(target_company_id uuid, target_batch_id uuid, target_source_file_id uuid,
  original_file_name text, original_byte_size bigint, original_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare batch public.upload_batch; transfer public.source_upload_transfer; maximum bigint; maximum_files integer;
begin
  select * into batch from public.upload_batch where id = target_batch_id;
  if not found or batch.company_id <> target_company_id or batch.created_by <> auth.uid()
    or not private.can_access_company(batch.company_id, batch.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from jsonb_array_elements(batch.selected_files) entry
    where entry->>'id' = target_source_file_id::text and entry->>'sha256' = original_sha256)
    or original_byte_size is null or original_byte_size < 1 or coalesce(length(trim(original_file_name)), 0) = 0 then
    raise exception 'immutable identity mismatch' using errcode = 'P0001', hint = 'invalid_choice';
  end if;
  select max_source_file_bytes, max_upload_batch_files into maximum, maximum_files from public.platform_settings where singleton;
  -- Completed evidence is retained and remains reconcilable if limits later change.
  if not exists (select 1 from public.source_file where id = target_source_file_id) then
    if batch.upload_finished_at is not null then raise exception 'not allowed' using errcode = '42501'; end if;
    if original_byte_size > maximum then raise exception 'file too large' using errcode = 'P0001', hint = 'file_too_large'; end if;
    if batch.file_count > maximum_files then raise exception 'too many files' using errcode = 'P0001', hint = 'too_many_files'; end if;
  end if;
  insert into public.source_upload_transfer(source_file_id, organization_id, company_id, upload_batch_id, created_by, file_name, byte_size, sha256)
    values(target_source_file_id, batch.organization_id, batch.company_id, batch.id, auth.uid(), trim(original_file_name), original_byte_size, original_sha256)
    on conflict (source_file_id) do nothing;
  select * into transfer from public.source_upload_transfer where source_file_id = target_source_file_id for update;
  if transfer.company_id <> batch.company_id or transfer.upload_batch_id <> batch.id or transfer.created_by <> auth.uid()
    or transfer.file_name <> trim(original_file_name) or transfer.byte_size <> original_byte_size or transfer.sha256 <> original_sha256 then
    raise exception 'immutable identity mismatch' using errcode = 'P0001', hint = 'invalid_choice';
  end if;
  return jsonb_build_object('confirmedBytes', transfer.confirmed_bytes, 'byteSize', transfer.byte_size,
    'complete', exists (select 1 from public.source_file s where s.id = transfer.source_file_id and s.company_id = transfer.company_id
      and s.upload_batch_id = transfer.upload_batch_id and s.sha256 = transfer.sha256 and s.byte_size = transfer.byte_size and s.file_name = transfer.file_name));
end;
$$;

create function public.confirm_source_upload_chunk(target_source_file_id uuid, chunk_offset bigint, chunk_byte_size integer, chunk_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare transfer public.source_upload_transfer; chunk public.source_upload_chunk; maximum bigint; maximum_files integer; batch public.upload_batch;
begin
  select * into transfer from public.source_upload_transfer where source_file_id = target_source_file_id for update;
  if not found or transfer.created_by <> auth.uid() or not private.can_access_company(transfer.company_id, transfer.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into batch from public.upload_batch where id = transfer.upload_batch_id;
  if batch.upload_finished_at is not null or exists (select 1 from public.source_file where id = target_source_file_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select max_source_file_bytes, max_upload_batch_files into maximum, maximum_files from public.platform_settings where singleton;
  if transfer.byte_size > maximum then raise exception 'file too large' using errcode = 'P0001', hint = 'file_too_large'; end if;
  if batch.file_count > maximum_files then raise exception 'too many files' using errcode = 'P0001', hint = 'too_many_files'; end if;
  if chunk_offset is null or chunk_offset < 0 or chunk_byte_size is null or chunk_byte_size not between 1 and 1048576
    or chunk_offset + chunk_byte_size > transfer.byte_size or coalesce(chunk_sha256, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid portion' using errcode = 'P0001', hint = 'invalid_choice';
  end if;
  select * into chunk from public.source_upload_chunk where source_file_id = transfer.source_file_id and byte_offset = chunk_offset;
  if found then
    if chunk.byte_size <> chunk_byte_size or chunk.sha256 <> chunk_sha256 then
      raise exception 'different bytes at confirmed offset' using errcode = 'P0001', hint = 'invalid_choice';
    end if;
  else
    if chunk_offset <> transfer.confirmed_bytes or not exists (select 1 from storage.objects o
      where o.bucket_id = 'source-upload-chunks' and o.name = transfer.company_id::text || '/' || transfer.source_file_id::text || '/' || chunk_offset::text || '/' || chunk_sha256
        and (o.metadata->>'size')::bigint = chunk_byte_size) then
      raise exception 'missing or out of order portion' using errcode = 'P0001', hint = 'invalid_choice';
    end if;
    insert into public.source_upload_chunk(source_file_id, organization_id, company_id, byte_offset, byte_size, sha256)
      values(transfer.source_file_id, transfer.organization_id, transfer.company_id, chunk_offset, chunk_byte_size, chunk_sha256);
    update public.source_upload_transfer set confirmed_bytes = confirmed_bytes + chunk_byte_size, last_progress_at = clock_timestamp()
      where source_file_id = transfer.source_file_id returning * into transfer;
  end if;
  return jsonb_build_object('confirmedBytes', transfer.confirmed_bytes, 'byteSize', transfer.byte_size, 'complete', false);
end;
$$;
revoke all on function public.reconcile_source_upload(uuid, uuid, uuid, text, bigint, text), public.confirm_source_upload_chunk(uuid, bigint, integer, text) from public, anon, service_role;
grant execute on function public.reconcile_source_upload(uuid, uuid, uuid, text, bigint, text), public.confirm_source_upload_chunk(uuid, bigint, integer, text) to authenticated;

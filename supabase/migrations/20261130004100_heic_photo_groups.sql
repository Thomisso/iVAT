-- HEIC/HEIF Photo Groups consume the immutable stored JPEG normalization.
-- Existing manifests and processed objects remain unchanged.
create or replace function private.validate_photo_group_source() returns trigger language plpgsql security definer set search_path='' as $$
declare group_ids uuid[]; maximum bigint; existing_bytes bigint; existing_normalized_bytes bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('photo-group-source:'||new.id::text,0));
  if exists(select 1 from public.photo_group where new.id=any(source_file_ids) and (upload_batch_id is distinct from new.upload_batch_id or company_id<>new.company_id)) then raise exception 'reserved source identity' using errcode='P0001',hint='invalid_choice'; end if;
  select g.source_file_ids into group_ids from public.photo_group g where g.upload_batch_id=new.upload_batch_id and new.id=any(g.source_file_ids);
  if group_ids is not null then
    perform 1 from public.upload_batch where id=new.upload_batch_id for update;
    select max_source_file_bytes into maximum from public.platform_settings where singleton;
    select coalesce(sum(byte_size),0),coalesce(sum(coalesce(normalized_byte_size,byte_size)),0) into existing_bytes,existing_normalized_bytes from public.source_file where id=any(group_ids);
    if existing_bytes+new.byte_size>maximum or existing_normalized_bytes+coalesce(new.normalized_byte_size,new.byte_size)>maximum then raise exception 'group exceeds original byte limit' using errcode='P0001',hint='file_too_large'; end if;
  end if;
  if exists(select 1 from public.photo_group g where g.upload_batch_id=new.upload_batch_id and new.id=any(g.source_file_ids))
    and (new.format::text not in ('jpeg','png','heic','heif') or new.page_count<>1) then
    raise exception 'group supports JPEG, PNG, HEIC and HEIF photographs' using errcode='P0001',hint='unsupported_format';
  end if;
  return new;
end;
$$;

create or replace function public.complete_photo_group(target_group_id uuid, processed_basis jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare g public.photo_group; settings public.platform_settings; total_bytes bigint; source_count integer; entry jsonb; object_name text; ai_enabled boolean; normalized_bytes bigint; member public.source_file; page_index integer:=0;
begin
  select * into g from public.photo_group where id=target_group_id;
  if not found then raise exception 'group missing'; end if;
  perform 1 from public.company where id=g.company_id for update;
  perform 1 from public.upload_batch where id=g.upload_batch_id for update;
  select * into g from public.photo_group where id=target_group_id for update;
  if g.basis is not null then return g.id; end if;
  select * into settings from public.platform_settings where singleton;
  select count(*),sum(byte_size),sum(coalesce(normalized_byte_size,byte_size)) into source_count,total_bytes,normalized_bytes from public.source_file
    where id=any(g.source_file_ids) and upload_batch_id=g.upload_batch_id and company_id=g.company_id and format::text in ('jpeg','png','heic','heif') and page_count=1 and status in ('uploaded','processing','waiting_for_platform');
  if source_count<>cardinality(g.source_file_ids) then raise exception 'group incomplete' using errcode='P0001',hint='upload_incomplete'; end if;
  if cardinality(g.source_file_ids)>settings.max_source_file_pages then raise exception 'group page limit' using errcode='P0001',hint='too_many_pages'; end if;
  if total_bytes>settings.max_source_file_bytes or normalized_bytes>settings.max_source_file_bytes or (processed_basis->>'byteSize')::bigint>settings.max_source_file_bytes then
    raise exception 'group byte limit' using errcode='P0001',hint='file_too_large';
  end if;
  if processed_basis->>'sha256' !~ '^[0-9a-f]{64}$' or jsonb_array_length(processed_basis->'pages')<>source_count then raise exception 'invalid basis'; end if;
  object_name:=g.company_id::text||'/'||g.source_file_ids[1]::text||'/group/basis.pdf';
  if not exists(select 1 from storage.objects where bucket_id='source-files' and name=object_name and (metadata->>'size')::bigint=(processed_basis->>'byteSize')::bigint) then raise exception 'basis not stored'; end if;
  for entry in select value from jsonb_array_elements(processed_basis->'pages') loop
    page_index:=page_index+1;
    select * into member from public.source_file where id=g.source_file_ids[page_index];
    if (entry->>'page')::integer is distinct from page_index or entry->>'sourceFileId' is distinct from member.id::text
      or entry->>'sourceSha256' is distinct from member.sha256 then raise exception 'basis source order mismatch'; end if;
    if member.format::text in ('heic','heif') then
      if entry->'normalizedDerivative' is distinct from jsonb_build_object('format','jpeg','sha256',member.normalized_sha256,'byteSize',member.normalized_byte_size)
        or not exists(select 1 from storage.objects where bucket_id='source-files'
          and name=g.company_id::text||'/'||member.id::text||'/normalized.jpeg'
          and (metadata->>'size')::bigint=member.normalized_byte_size) then raise exception 'normalization basis mismatch'; end if;
    elsif entry ? 'normalizedDerivative' then raise exception 'unexpected normalization basis';
    end if;
    if entry->>'sha256' !~ '^[0-9a-f]{64}$' or not exists(select 1 from storage.objects where bucket_id='source-files'
      and name=g.company_id::text||'/'||g.source_file_ids[1]::text||'/group/'||(entry->>'page')||'.png'
      and (metadata->>'size')::bigint=(entry->>'byteSize')::bigint) then raise exception 'page basis not stored'; end if;
  end loop;
  update public.photo_group set basis=processed_basis where id=g.id;
  select ai_processing_enabled into ai_enabled from public.company where id=g.company_id;
  insert into public.document(id,organization_id,company_id,source_file_id,first_page,last_page,status)
    values(g.id,g.organization_id,g.company_id,g.source_file_ids[1],1,cardinality(g.source_file_ids),case when ai_enabled then 'uploaded'::public.document_status else 'needs_review'::public.document_status end);
  update public.source_file set status='split' where id=any(g.source_file_ids);
  perform private.record_audit_event('photo_group.prepared',g.organization_id,g.company_id,'photo_group',g.id,
    jsonb_build_object('sourceFileIds',to_jsonb(g.source_file_ids),'createdBy',g.created_by,'createdAt',g.created_at,'basis',processed_basis));
  return g.id;
end;
$$;

-- Extend the latest complete snapshot, retaining representative and PDF artifacts.
-- Saved snapshots are untouched.
alter function public.company_export_snapshot(uuid) rename to company_export_snapshot_without_group_normalizations;
alter function public.company_export_snapshot_without_group_normalizations(uuid) set schema private;
create function public.company_export_snapshot(target_company_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare snapshot jsonb;
begin
  snapshot:=private.company_export_snapshot_without_group_normalizations(target_company_id);
  snapshot:=jsonb_set(snapshot,'{sourceFiles}',coalesce((
    select jsonb_agg(item.value || jsonb_build_object('normalizedDerivative',case when source.normalized_format is null then null else
      jsonb_build_object('format',source.normalized_format,'sha256',source.normalized_sha256,'byteSize',source.normalized_byte_size) end) order by item.ordinality)
    from jsonb_array_elements(snapshot->'sourceFiles') with ordinality as item(value,ordinality)
    join public.source_file source on source.id=(item.value->>'id')::uuid
  ),'[]'::jsonb));
  return snapshot;
end;
$$;

revoke all on function public.company_export_snapshot(uuid), private.company_export_snapshot_without_group_normalizations(uuid) from public,anon,authenticated,service_role;

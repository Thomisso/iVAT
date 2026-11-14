-- Explicit human boundaries; Source Files remain unchanged individual originals.
create table public.photo_group (
  id uuid primary key,
  organization_id uuid not null,
  company_id uuid not null,
  upload_batch_id uuid not null references public.upload_batch(id) on delete cascade,
  source_file_ids uuid[] not null check (cardinality(source_file_ids) >= 2),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  basis jsonb,
  foreign key (company_id, organization_id) references public.company(id, organization_id)
);
create index photo_group_sources_idx on public.photo_group using gin(source_file_ids);
create index photo_group_batch_idx on public.photo_group(upload_batch_id);
create index photo_group_company_idx on public.photo_group(company_id);
alter table public.photo_group enable row level security;
revoke all on public.photo_group from anon, authenticated, service_role;
grant select on public.photo_group to authenticated, service_role;
create policy "company members read photo groups" on public.photo_group for select to authenticated
  using (private.can_access_company(company_id, organization_id));

alter function public.begin_upload_batch(uuid, integer, uuid, jsonb) rename to begin_upload_batch_without_photo_groups;
alter function public.begin_upload_batch_without_photo_groups(uuid, integer, uuid, jsonb) set schema private;
revoke all on function private.begin_upload_batch_without_photo_groups(uuid, integer, uuid, jsonb) from public, anon, authenticated, service_role;
create function public.begin_upload_batch(target_company_id uuid, selected_file_count integer, requested_batch_id uuid default null, selected_files jsonb default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare batch_id uuid; entry record; ids uuid[]; org_id uuid; maximum integer; reserved_id text;
begin
  perform 1 from public.company where id=target_company_id and private.can_access_company(id,organization_id) for update;
  batch_id := private.begin_upload_batch_without_photo_groups(target_company_id, selected_file_count, requested_batch_id, selected_files);
  select organization_id into org_id from public.upload_batch where id = batch_id;
  select max_source_file_pages into maximum from public.platform_settings where singleton;
  if exists (select 1 from jsonb_array_elements(selected_files) x where x ? 'groupId'
    and (jsonb_typeof(x->'groupId') <> 'string' or x->>'groupId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then
    raise exception 'invalid group identity' using errcode='P0001', hint='invalid_choice';
  end if;
  -- Serialize reservations and actual Source inserts by identity, including across Companies.
  for reserved_id in select x->>'id' from jsonb_array_elements(selected_files) x where x ? 'groupId' order by x->>'id' loop
    perform pg_advisory_xact_lock(hashtextextended('photo-group-source:'||reserved_id,0));
  end loop;
  for entry in select x->>'groupId' as id from jsonb_array_elements(selected_files) x where x ? 'groupId' group by x->>'groupId' loop
    select array_agg((x->>'id')::uuid order by n) into ids
      from jsonb_array_elements(selected_files) with ordinality f(x,n) where x->>'groupId' = entry.id;
    if exists(select 1 from public.photo_group g where g.id<>entry.id::uuid and g.source_file_ids && ids) then raise exception 'source identity already reserved' using errcode='P0001',hint='invalid_choice'; end if;
    if cardinality(ids) < 2 then raise exception 'a group needs two photos' using errcode='P0001',hint='invalid_choice'; end if;
    if cardinality(ids) > maximum then raise exception 'group exceeds page limit' using errcode='P0001',hint='too_many_pages'; end if;
    if not exists(select 1 from public.photo_group where id=entry.id::uuid) and (exists(select 1 from public.source_file where id=any(ids)) or exists(select 1 from public.document where id=entry.id::uuid)) then raise exception 'sources must be new' using errcode='P0001',hint='invalid_choice'; end if;
    insert into public.photo_group(id,organization_id,company_id,upload_batch_id,source_file_ids,created_by)
      values(entry.id::uuid,org_id,target_company_id,batch_id,ids,auth.uid()) on conflict do nothing;
    if not exists(select 1 from public.photo_group where id=entry.id::uuid and upload_batch_id=batch_id and source_file_ids=ids and created_by=auth.uid()) then
      raise exception 'invalid group identity' using errcode='P0001',hint='invalid_choice';
    end if;
  end loop;
  return batch_id;
end;
$$;
revoke all on function public.begin_upload_batch(uuid,integer,uuid,jsonb) from public,anon,service_role;
grant execute on function public.begin_upload_batch(uuid,integer,uuid,jsonb) to authenticated;

-- Group members cannot enter a different input format through direct INSERT/HTTP.
create function private.validate_photo_group_source() returns trigger language plpgsql security definer set search_path='' as $$
declare group_ids uuid[]; maximum bigint; existing_bytes bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('photo-group-source:'||new.id::text,0));
  if exists(select 1 from public.photo_group where new.id=any(source_file_ids) and (upload_batch_id is distinct from new.upload_batch_id or company_id<>new.company_id)) then raise exception 'reserved source identity' using errcode='P0001',hint='invalid_choice'; end if;
  select g.source_file_ids into group_ids from public.photo_group g where g.upload_batch_id=new.upload_batch_id and new.id=any(g.source_file_ids);
  if group_ids is not null then
    perform 1 from public.upload_batch where id=new.upload_batch_id for update;
    select max_source_file_bytes into maximum from public.platform_settings where singleton;
    select coalesce(sum(byte_size),0) into existing_bytes from public.source_file where id=any(group_ids);
    if existing_bytes+new.byte_size>maximum then raise exception 'group exceeds original byte limit' using errcode='P0001',hint='file_too_large'; end if;
  end if;
  if exists(select 1 from public.photo_group g where g.upload_batch_id=new.upload_batch_id and new.id=any(g.source_file_ids))
    and (new.format::text not in ('jpeg','png') or new.page_count<>1) then
    raise exception 'group supports JPEG and PNG photographs' using errcode='P0001',hint='unsupported_format';
  end if;
  return new;
end;
$$;
revoke all on function private.validate_photo_group_source() from public,anon,authenticated,service_role;
create trigger validate_photo_group_source before insert on public.source_file for each row execute function private.validate_photo_group_source();

-- The worker distinguishes pending original transfers from a finished missing
-- group; it needs only these two Batch metadata columns for that check.
grant select (id, upload_finished_at) on public.upload_batch to service_role;

-- Only the worker may bind a real stored basis and create the one Document.
create function public.complete_photo_group(target_group_id uuid, processed_basis jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare g public.photo_group; settings public.platform_settings; total_bytes bigint; source_count integer; entry jsonb; object_name text; ai_enabled boolean;
begin
  select * into g from public.photo_group where id=target_group_id;
  if not found then raise exception 'group missing'; end if;
  perform 1 from public.company where id=g.company_id for update;
  perform 1 from public.upload_batch where id=g.upload_batch_id for update;
  select * into g from public.photo_group where id=target_group_id for update;
  if g.basis is not null then return g.id; end if;
  select * into settings from public.platform_settings where singleton;
  select count(*),sum(byte_size) into source_count,total_bytes from public.source_file
    where id=any(g.source_file_ids) and upload_batch_id=g.upload_batch_id and company_id=g.company_id and format::text in ('jpeg','png') and page_count=1 and status in ('uploaded','processing','waiting_for_platform');
  if source_count<>cardinality(g.source_file_ids) then raise exception 'group incomplete' using errcode='P0001',hint='upload_incomplete'; end if;
  if cardinality(g.source_file_ids)>settings.max_source_file_pages then raise exception 'group page limit' using errcode='P0001',hint='too_many_pages'; end if;
  if total_bytes>settings.max_source_file_bytes or (processed_basis->>'byteSize')::bigint>settings.max_source_file_bytes then
    raise exception 'group byte limit' using errcode='P0001',hint='file_too_large';
  end if;
  if processed_basis->>'sha256' !~ '^[0-9a-f]{64}$' or jsonb_array_length(processed_basis->'pages')<>source_count then raise exception 'invalid basis'; end if;
  object_name:=g.company_id::text||'/'||g.source_file_ids[1]::text||'/group/basis.pdf';
  if not exists(select 1 from storage.objects where bucket_id='source-files' and name=object_name and (metadata->>'size')::bigint=(processed_basis->>'byteSize')::bigint) then raise exception 'basis not stored'; end if;
  for entry in select value from jsonb_array_elements(processed_basis->'pages') loop
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
revoke all on function public.complete_photo_group(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.complete_photo_group(uuid,jsonb) to service_role;

-- The immutable human boundaries cannot be silently changed by existing page tools.
create function private.protect_photo_group_document() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.photo_group where id=old.id) and
    (new.source_file_id is distinct from old.source_file_id or new.first_page is distinct from old.first_page or new.last_page is distinct from old.last_page or new.superseded_at is distinct from old.superseded_at) then
    raise exception 'human group boundaries are immutable' using errcode='P0001',hint='not_correctable';
  end if;
  return new;
end;
$$;
revoke all on function private.protect_photo_group_document() from public,anon,authenticated,service_role;
create trigger protect_photo_group_document before update on public.document for each row execute function private.protect_photo_group_document();

-- Page correction requires real source pages. NULL source/range comparisons
-- must never let source-independent Documents pass adjacency checks, and
-- workbook row sets retain their separate non-image semantics.
create or replace function private.assert_split_document_correctable(doc public.document)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  assigned_period text;
begin
  if exists(select 1 from public.photo_group where id=doc.id) then raise exception 'human group boundaries cannot change' using errcode='P0001',hint='not_correctable'; end if;
  if doc.superseded_at is not null or doc.status in ('uploaded', 'processing') then
    raise exception 'the Split is being processed' using errcode = 'P0001', hint = 'not_correctable';
  end if;
  assigned_period := private.document_current_reporting_period(doc.id);
  if assigned_period is not null
    and private.is_reporting_period_locked(doc.company_id, assigned_period) then
    raise exception 'the Reporting Period is locked'
      using errcode = 'P0001', hint = 'period_locked';
  end if;
  if doc.source_file_id is null or doc.first_page is null or doc.last_page is null
    or doc.has_document_image is distinct from true then
    raise exception 'page correction requires real source pages'
      using errcode = 'P0001', hint = 'not_correctable';
  end if;
end;
$$;
revoke execute on function private.assert_split_document_correctable(public.document)
  from public, anon, authenticated, service_role;


create or replace function private.bind_extraction_source_evidence()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  doc public.document;
  source_hash text;
  source_format text;
  normalized_hash text;
  source_normalized_format text;
  base_payload jsonb;
  evidence jsonb;
  fields jsonb := '{}'::jsonb;
  entry record;
  path text;
  old_index integer;
  new_index integer;
  row_map jsonb;
  map_valid boolean := false;
  base_count integer;
  new_count integer;
begin
  select * into doc from public.document where id = new.document_id;
  select sha256, format::text, normalized_sha256, normalized_format::text into source_hash, source_format, normalized_hash, source_normalized_format from public.source_file where id = doc.source_file_id;
  if new.author_user_id is null then
    evidence := new.payload -> 'sourceEvidence';
  else
    row_map := new.payload -> 'sourceRateRows';
    new.payload := new.payload - 'sourceEvidence' - 'sourceLocations' - 'sourceRateRows' - 'confidence';
    select payload into base_payload from public.extraction_version
      where document_id = new.document_id and version < new.version order by version desc limit 1;
    evidence := base_payload -> 'sourceEvidence';
    base_count := jsonb_array_length(coalesce(base_payload -> 'rateBreakdown', '[]'::jsonb));
    new_count := jsonb_array_length(coalesce(new.payload -> 'rateBreakdown', '[]'::jsonb));
    if row_map is null and base_count = new_count then
      select coalesce(jsonb_agg(i), '[]'::jsonb) into row_map from generate_series(0, new_count - 1) i;
    end if;
    if jsonb_typeof(row_map) = 'array' and jsonb_array_length(row_map) = new_count then
      map_valid := not exists (select 1 from jsonb_array_elements(row_map) x where x <> 'null'::jsonb
        and (jsonb_typeof(x) <> 'number' or x::text !~ '^[0-9]+$'));
      if map_valid then
        map_valid := not exists (select 1 from jsonb_array_elements(row_map) x where x <> 'null'::jsonb and (x::text::numeric >= base_count))
          and (select count(*) = count(distinct x) from jsonb_array_elements(row_map) x where x <> 'null'::jsonb);
      end if;
    end if;
    if jsonb_typeof(evidence -> 'fields') = 'object' then
      for entry in select * from jsonb_each(evidence -> 'fields') loop
        path := entry.key;
        if path ~ '^rateBreakdown\.[0-9]+\.' then
          if not map_valid then continue; end if;
          old_index := split_part(path, '.', 2)::integer;
          select (ordinality - 1)::integer into new_index from jsonb_array_elements(row_map) with ordinality m(value, ordinality)
            where value <> 'null'::jsonb and value::text::numeric = old_index;
          if new_index is null then continue; end if;
          path := 'rateBreakdown.' || new_index || '.' || split_part(path, '.', 3);
        end if;
        if (new.payload #> string_to_array(path, '.')) is distinct from (base_payload #> string_to_array(entry.key, '.')) then
          entry.value := jsonb_set(entry.value, '{origin}', '"manual"'::jsonb);
        end if;
        fields := fields || jsonb_build_object(path, entry.value);
      end loop;
      evidence := jsonb_set(evidence, '{fields}', fields);
    end if;
  end if;
  -- A reference cannot switch Sources or oriented bases, even through an RPC.
  -- Missing/invalid evidence is removed without rejecting financial data.
  if jsonb_typeof(evidence) = 'object'
    and evidence ->> 'schemaVersion' = '1'
    and evidence ->> 'sourceFileId' = doc.source_file_id::text
    and evidence ->> 'documentId' = new.document_id::text
    and evidence ->> 'sourceSha256' = source_hash
    and ((source_format in ('pdf', 'png', 'jpeg', 'xls', 'xlsx')
      and evidence #>> '{basis,kind}' = 'original'
      and evidence #>> '{basis,format}' = source_format
      and evidence #>> '{basis,sha256}' = source_hash)
      or (exists(select 1 from public.photo_group g where g.id=doc.id and g.source_file_ids[1]=doc.source_file_id and g.basis->>'sha256'=evidence #>> '{basis,sha256}' and evidence #>> '{basis,kind}'='photo_group' and evidence #>> '{basis,format}'='pdf' and evidence #>> '{basis,groupId}'=g.id::text))
      or (source_format in ('heic', 'heif') and source_normalized_format = 'jpeg'
        and evidence #>> '{basis,kind}' = 'normalized'
        and evidence #>> '{basis,format}' = 'jpeg'
        and evidence #>> '{basis,sha256}' = normalized_hash))
    and ((doc.source_sheet is null
      and evidence #>> '{range,firstPage}' = doc.first_page::text
      and evidence #>> '{range,lastPage}' = doc.last_page::text)
      or (source_format in ('xls', 'xlsx') and doc.source_sheet is not null
        and evidence #>> '{range,sheetName}' = doc.source_sheet
        and evidence #>> '{range,firstRow}' = doc.first_row::text
        and evidence #>> '{range,lastRow}' = doc.last_row::text))
    and jsonb_typeof(evidence -> 'fields') = 'object' then
    new.payload := jsonb_set(new.payload, '{sourceEvidence}', jsonb_set(evidence, '{extractionVersionId}', to_jsonb(new.id::text)));
  else
    new.payload := new.payload - 'sourceEvidence';
  end if;
  new.payload := new.payload - 'sourceLocations' - 'sourceRateRows';
  return new;
end;
$$;
revoke all on function private.bind_extraction_source_evidence() from public, anon, authenticated, service_role;

-- The export snapshot preserves both the decision and the exact processed basis manifest.
alter function public.company_export_snapshot(uuid) rename to company_export_snapshot_without_photo_groups;
alter function public.company_export_snapshot_without_photo_groups(uuid) set schema private;
create function public.company_export_snapshot(target_company_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare snapshot jsonb;
begin
  snapshot:=private.company_export_snapshot_without_photo_groups(target_company_id);
  return snapshot || jsonb_build_object('photoGroups',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'companyId',g.company_id,'batchId',g.upload_batch_id,'sourceFileIds',g.source_file_ids,'createdBy',g.created_by,'createdAt',g.created_at,'basis',g.basis) order by g.id) from public.photo_group g where g.company_id=target_company_id),'[]'::jsonb));
end;
$$;
revoke all on function public.company_export_snapshot(uuid),private.company_export_snapshot_without_photo_groups(uuid) from public,anon,authenticated,service_role;

create function private.audit_photo_group_confirmed() returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform private.record_audit_event('photo_group.confirmed',new.organization_id,new.company_id,'photo_group',new.id,
    jsonb_build_object('sourceFileIds',new.source_file_ids,'createdAt',new.created_at,'selection',(select selected_files from public.upload_batch where id=new.upload_batch_id)),new.created_by);
  return new;
end;
$$;
revoke all on function private.audit_photo_group_confirmed() from public,anon,authenticated,service_role;
create trigger photo_group_confirmed after insert on public.photo_group for each row execute function private.audit_photo_group_confirmed();
create trigger photo_group_data_revision after insert or update or delete on public.photo_group for each row execute function private.bump_company_data_revision();

create function private.protect_photo_group_source() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.photo_group where old.id=any(source_file_ids)) and auth.role() is distinct from 'service_role' then
    raise exception 'a group is resolved as one Document' using errcode='P0001',hint='source_already_resolved';
  end if;
  return new;
end;
$$;
revoke all on function private.protect_photo_group_source() from public,anon,authenticated,service_role;
create trigger protect_photo_group_source before update on public.source_file for each row execute function private.protect_photo_group_source();
create function private.protect_photo_group_document_insert() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.photo_group where new.source_file_id=any(source_file_ids) and id<>new.id) then
    raise exception 'group boundaries already confirmed' using errcode='P0001',hint='source_already_resolved';
  end if;
  return new;
end;
$$;
revoke all on function private.protect_photo_group_document_insert() from public,anon,authenticated,service_role;
create trigger protect_photo_group_document_insert before insert on public.document for each row execute function private.protect_photo_group_document_insert();

create function public.fail_photo_group(target_source_file_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare g public.photo_group;
begin
  select * into g from public.photo_group where target_source_file_id=any(source_file_ids);
  if not found then return; end if;
  perform 1 from public.company where id=g.company_id for update;
  perform 1 from public.upload_batch where id=g.upload_batch_id for update;
  select * into g from public.photo_group where id=g.id for update;
  if g.basis is not null then return; end if;
  update public.source_file set status='failed' where id=any(g.source_file_ids) and status in ('uploaded','processing');
end;
$$;
revoke all on function public.fail_photo_group(uuid) from public,anon,authenticated;
grant execute on function public.fail_photo_group(uuid) to service_role;

-- Include reserved group identities whose bytes arrived but whose Source File row
-- was refused; the ordinary delete command still owns all authority and lock gates.
alter function public.delete_upload_batch(uuid) rename to delete_upload_batch_without_photo_groups;
alter function public.delete_upload_batch_without_photo_groups(uuid) set schema private;
revoke all on function private.delete_upload_batch_without_photo_groups(uuid) from public,anon,authenticated,service_role;
create function public.delete_upload_batch(target_batch_id uuid) returns text[] language plpgsql security definer set search_path='' as $$
declare batch public.upload_batch; extra_names text[]; names text[];
begin
  select * into batch from public.upload_batch where id=target_batch_id;
  if not found or not private.can_access_company(batch.company_id,batch.organization_id) then raise exception 'not allowed' using errcode='42501'; end if;
  select coalesce(array_agg(o.name),'{}') into extra_names from storage.objects o where o.bucket_id='source-files'
    and exists(select 1 from public.photo_group g cross join unnest(g.source_file_ids) source(id) where g.upload_batch_id=target_batch_id
      and (o.name=batch.company_id::text||'/'||source.id::text or o.name like batch.company_id::text||'/'||source.id::text||'/%'));
  names:=private.delete_upload_batch_without_photo_groups(target_batch_id);
  insert into private.deleted_source_file_object(name,organization_id,company_id)
    select name,batch.organization_id,batch.company_id from unnest(extra_names) name on conflict(name) do nothing;
  return array(select distinct name from unnest(names||extra_names) name order by name);
end;
$$;
revoke all on function public.delete_upload_batch(uuid) from public,anon,service_role;
grant execute on function public.delete_upload_batch(uuid) to authenticated;

-- Attachment records real evidence on the existing Document. It never requests
-- Split/Extraction, changes approval, or inserts an Extraction Version.
create function private.lock_document_source_attachment(target_company_id uuid, target_document_id uuid, target_source_file_id uuid)
returns public.document language plpgsql security definer set search_path = '' as $$
declare doc public.document; source_company_id uuid; period text;
begin
  select * into doc from public.document where id = target_document_id;
  if not found or doc.company_id <> target_company_id or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise insufficient_privilege;
  end if;
  select company_id into source_company_id from public.source_file where id = target_source_file_id;
  if found and source_company_id <> doc.company_id then raise insufficient_privilege; end if;
  perform 1 from public.company where id = doc.company_id for update;
  select * into doc from public.document where id = target_document_id for update;
  if not found or doc.company_id <> target_company_id or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise insufficient_privilege;
  end if;
  if doc.superseded_at is not null or not exists (
    select 1 from public.extraction_version where document_id = doc.id and author_user_id is not null
  ) then raise exception 'not a manual Document' using errcode = 'P0001', hint = 'not_attachable'; end if;
  period := private.document_current_reporting_period(doc.id);
  if (period is not null and private.is_reporting_period_locked(doc.company_id, period))
    or private.source_file_locked_period(target_source_file_id) is not null then
    raise exception 'the Reporting Period is locked' using errcode = 'P0001', hint = 'period_locked';
  end if;
  if doc.source_file_id is not null and doc.source_file_id <> target_source_file_id then
    raise exception 'a Source is already attached' using errcode = 'P0001', hint = 'source_already_attached';
  end if;
  if source_company_id is not null and doc.source_file_id is distinct from target_source_file_id then
    raise exception 'Source identity already recorded' using errcode = 'P0001', hint = 'invalid_choice';
  end if;
  return doc;
end;
$$;
revoke all on function private.lock_document_source_attachment(uuid, uuid, uuid) from public, anon, authenticated, service_role;

create function public.prepare_document_source_attachment(target_company_id uuid, target_document_id uuid, target_source_file_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_document_source_attachment(target_company_id, target_document_id, target_source_file_id);
end;
$$;
revoke all on function public.prepare_document_source_attachment(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.prepare_document_source_attachment(uuid, uuid, uuid) to authenticated;

create function public.attach_document_source(target_company_id uuid, target_document_id uuid, target_source_file_id uuid, source_metadata jsonb, source_range jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare doc public.document; file public.source_file; attachment_first_page integer; attachment_last_page integer; sheet_name text; workbook boolean;
begin
  doc := private.lock_document_source_attachment(target_company_id, target_document_id, target_source_file_id);
  if jsonb_typeof(source_metadata) is distinct from 'object'
    or coalesce(source_metadata ->> 'format', '') not in ('pdf', 'png', 'jpeg', 'heic', 'heif', 'xlsx', 'xls')
    or nullif(btrim(source_metadata ->> 'fileName'), '') is null
    or coalesce(source_metadata ->> 'byteSize', '') !~ '^[1-9][0-9]*$'
    or coalesce(source_metadata ->> 'pageCount', '') !~ '^[1-9][0-9]*$'
    or coalesce(source_metadata ->> 'sha256', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid Source metadata' using errcode = 'P0001', hint = 'invalid_choice';
  end if;
  if (source_metadata ->> 'pageCount')::numeric > 2147483647
    or (source_metadata ->> 'byteSize')::numeric > 9223372036854775807 then
    raise exception 'invalid Source metadata' using errcode = 'P0001', hint = 'invalid_choice';
  end if;
  workbook := source_metadata ->> 'format' in ('xlsx', 'xls');
  if workbook then
    if jsonb_typeof(source_range) is distinct from 'object'
      or source_range - array['sheetName','firstRow','lastRow'] <> '{}'::jsonb
      or jsonb_typeof(source_range -> 'sheetName') is distinct from 'string'
      or nullif(btrim(source_range ->> 'sheetName'), '') is null
      or jsonb_typeof(source_range -> 'firstRow') is distinct from 'number'
      or jsonb_typeof(source_range -> 'lastRow') is distinct from 'number'
      or coalesce(source_range ->> 'firstRow', '') !~ '^[1-9][0-9]*$'
      or coalesce(source_range ->> 'lastRow', '') !~ '^[1-9][0-9]*$' then
      raise exception 'invalid worksheet range' using errcode = 'P0001', hint = 'invalid_workbook_ranges';
    end if;
    if (source_range ->> 'firstRow')::numeric > 2147483647 or (source_range ->> 'lastRow')::numeric > 2147483647
      or (source_range ->> 'lastRow')::numeric < (source_range ->> 'firstRow')::numeric then
      raise exception 'invalid worksheet range' using errcode = 'P0001', hint = 'invalid_workbook_ranges';
    end if;
    sheet_name := source_range ->> 'sheetName';
    attachment_first_page := (source_range ->> 'firstRow')::integer;
    attachment_last_page := (source_range ->> 'lastRow')::integer;
  else
    if jsonb_typeof(source_range) is distinct from 'object'
      or source_range - array['firstPage','lastPage'] <> '{}'::jsonb
      or jsonb_typeof(source_range -> 'firstPage') is distinct from 'number'
      or jsonb_typeof(source_range -> 'lastPage') is distinct from 'number'
      or coalesce(source_range ->> 'firstPage', '') !~ '^[1-9][0-9]*$'
      or coalesce(source_range ->> 'lastPage', '') !~ '^[1-9][0-9]*$' then
      raise exception 'invalid page range' using errcode = 'P0001', hint = 'invalid_source_range';
    end if;
    if (source_range ->> 'lastPage')::numeric < (source_range ->> 'firstPage')::numeric
      or (source_range ->> 'lastPage')::numeric > (source_metadata ->> 'pageCount')::numeric
      or (source_metadata ->> 'format' <> 'pdf' and source_range <> '{"firstPage":1,"lastPage":1}') then
      raise exception 'range outside original' using errcode = 'P0001', hint = 'invalid_source_range';
    end if;
    attachment_first_page := (source_range ->> 'firstPage')::integer;
    attachment_last_page := (source_range ->> 'lastPage')::integer;
  end if;
  select * into file from public.source_file where id = target_source_file_id for update;
  if found then
    if file.company_id <> doc.company_id then raise insufficient_privilege; end if;
    if doc.source_file_id is distinct from file.id then
      raise exception 'Source identity already recorded' using errcode = 'P0001', hint = 'invalid_choice';
    end if;
    if file.file_name <> source_metadata ->> 'fileName' or file.format::text <> source_metadata ->> 'format'
      or file.byte_size <> (source_metadata ->> 'byteSize')::bigint or file.sha256 <> source_metadata ->> 'sha256'
      or file.page_count <> (source_metadata ->> 'pageCount')::integer
      or doc.first_page <> attachment_first_page or doc.last_page <> attachment_last_page or doc.source_sheet is distinct from sheet_name then
      raise exception 'attachment identity differs' using errcode = 'P0001', hint = 'invalid_choice';
    end if;
    return file.id;
  end if;
  -- SECURITY DEFINER bypasses the ordinary Source insert policy, so repeat
  -- its real-original requirement before recording any evidence association.
  if not private.source_file_object_exists(doc.company_id, target_source_file_id) then
    raise exception 'the original must be stored first' using errcode = 'P0001', hint = 'invalid_choice';
  end if;
  insert into public.source_file(id, organization_id, company_id, file_name, format, byte_size, sha256, page_count,
    normalized_format, normalized_byte_size, normalized_sha256, status, manual_definition, manually_defined_at, manually_defined_by)
  values (target_source_file_id, doc.organization_id, doc.company_id, source_metadata ->> 'fileName', (source_metadata ->> 'format')::public.source_file_format,
    (source_metadata ->> 'byteSize')::bigint, source_metadata ->> 'sha256', (source_metadata ->> 'pageCount')::integer,
    (source_metadata ->> 'normalizedFormat')::public.source_file_format, (source_metadata ->> 'normalizedByteSize')::bigint, source_metadata ->> 'normalizedSha256',
    'split', jsonb_build_array(source_range), now(), auth.uid());
  update public.document set source_file_id = target_source_file_id, first_page = attachment_first_page, last_page = attachment_last_page,
    source_sheet = sheet_name, first_row = case when workbook then attachment_first_page else null end,
    last_row = case when workbook then attachment_last_page else null end, has_document_image = not workbook where id = doc.id;
  perform private.record_audit_event('document.source_attached', doc.organization_id, doc.company_id, 'document', doc.id,
    jsonb_build_object('source_file_id', target_source_file_id, 'range', source_range));
  return target_source_file_id;
end;
$$;
revoke all on function public.attach_document_source(uuid, uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.attach_document_source(uuid, uuid, uuid, jsonb, jsonb) to authenticated;

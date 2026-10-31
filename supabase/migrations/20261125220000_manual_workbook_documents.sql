-- Workbook recovery uses the same Company-first Source ownership transition.
-- Actual worksheet bounds are validated from immutable original bytes by the application.
-- Boundaries create review work, never structured accounting values or AI jobs.
create or replace function public.define_source_documents(target_source_file_id uuid, document_ranges jsonb)
returns uuid[] language plpgsql security definer set search_path = '' as $$
declare file public.source_file; entry jsonb; first_page integer; last_page integer;
  previous_last integer := 0; previous_rows jsonb := '{}'; sheet_name text; first_row integer; last_row integer; document_ids uuid[] := '{}'; new_id uuid;
begin
  select * into file from public.source_file where id = target_source_file_id;
  if not found or not private.can_access_company(file.company_id, file.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform 1 from public.company where id = file.company_id for update;
  select * into file from public.source_file where id = target_source_file_id for update;
  if not found or not private.can_access_company(file.company_id, file.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if private.source_file_locked_period(file.id) is not null then
    raise exception 'the Source belongs to a locked report snapshot' using errcode = 'P0001', hint = 'period_locked';
  end if;
  if file.status = 'split' and file.manual_definition = document_ranges then
    return (select coalesce(array_agg(document.id order by document.first_page, document.id), '{}')
      from public.document document where document.source_file_id = file.id and document.superseded_at is null);
  end if;
  if file.status in ('split', 'rejected') or exists (select 1 from public.document where source_file_id = file.id) then
    raise exception 'use the existing Documents' using errcode = 'P0001', hint = 'source_already_resolved';
  end if;
  if jsonb_typeof(document_ranges) is distinct from 'array' then
    raise exception 'Document Source ranges are required' using errcode = 'P0001', hint = 'invalid_source_ranges';
  end if;
  if jsonb_array_length(document_ranges) = 0 then
    raise exception 'Document Source ranges are required' using errcode = 'P0001', hint = 'invalid_source_ranges';
  end if;
  perform private.restart_source_upload_batch(file);
  for entry in select value from jsonb_array_elements(document_ranges) loop
    if jsonb_typeof(entry) is distinct from 'object' then
      raise exception 'a Source range is required' using errcode = 'P0001', hint = 'invalid_source_ranges';
    end if;
    if file.format::text in ('xlsx', 'xls') then
      if entry - 'sheetName' - 'firstRow' - 'lastRow' <> '{}'::jsonb
        or jsonb_typeof(entry -> 'sheetName') is distinct from 'string'
        or length(trim(entry ->> 'sheetName')) = 0
        or jsonb_typeof(entry -> 'firstRow') is distinct from 'number'
        or jsonb_typeof(entry -> 'lastRow') is distinct from 'number'
        or (entry ->> 'firstRow') !~ '^[1-9][0-9]*$'
        or (entry ->> 'lastRow') !~ '^[1-9][0-9]*$'
        or (entry ->> 'firstRow')::numeric > 2147483647
        or (entry ->> 'lastRow')::numeric > 2147483647 then
        raise exception 'worksheet row ranges are required' using errcode = 'P0001', hint = 'invalid_source_ranges';
      end if;
      sheet_name := entry ->> 'sheetName';
      first_row := (entry ->> 'firstRow')::integer;
      last_row := (entry ->> 'lastRow')::integer;
      if first_row <= coalesce((previous_rows ->> sheet_name)::integer, 0) or last_row < first_row then
        raise exception 'worksheet row ranges must be ascending and disjoint per sheet' using errcode = 'P0001', hint = 'invalid_source_ranges';
      end if;
      previous_rows := jsonb_set(previous_rows, array[sheet_name], to_jsonb(last_row));
      insert into public.document (organization_id, company_id, source_file_id, first_page, last_page, source_sheet, first_row, last_row, has_document_image, status)
      values (file.organization_id, file.company_id, file.id, first_row, last_row, sheet_name, first_row, last_row, false, 'needs_review') returning id into new_id;
    else
      if entry - 'firstPage' - 'lastPage' <> '{}'::jsonb
        or jsonb_typeof(entry -> 'firstPage') is distinct from 'number'
        or jsonb_typeof(entry -> 'lastPage') is distinct from 'number'
        or (entry ->> 'firstPage') !~ '^[1-9][0-9]*$'
        or (entry ->> 'lastPage') !~ '^[1-9][0-9]*$'
        or (entry ->> 'firstPage')::numeric > file.page_count
        or (entry ->> 'lastPage')::numeric > file.page_count then
        raise exception 'ranges must name actual source pages' using errcode = 'P0001', hint = 'invalid_source_ranges';
      end if;
      first_page := (entry ->> 'firstPage')::integer;
      last_page := (entry ->> 'lastPage')::integer;
      if first_page <= previous_last or last_page < first_page
        or (file.format::text <> 'pdf' and (first_page <> 1 or last_page <> 1 or jsonb_array_length(document_ranges) <> 1)) then
        raise exception 'ranges must be ascending and disjoint' using errcode = 'P0001', hint = 'invalid_source_ranges';
      end if;
      previous_last := last_page;
      insert into public.document (organization_id, company_id, source_file_id, first_page, last_page, status)
      values (file.organization_id, file.company_id, file.id, first_page, last_page, 'needs_review') returning id into new_id;
    end if;
    document_ids := array_append(document_ids, new_id);
  end loop;
  update public.source_file set status = 'split', split_request_id = gen_random_uuid(),
    manual_definition = document_ranges, manually_defined_by = auth.uid(), manually_defined_at = now()
  where id = file.id;
  perform private.record_audit_event('source_file.manually_split', file.organization_id, file.company_id, 'source_file', file.id,
    jsonb_build_object('ranges', document_ranges, 'document_ids', to_jsonb(document_ids)));
  return (select coalesce(array_agg(document.id order by document.first_page, document.id), '{}')
    from public.document document where document.source_file_id = file.id and document.superseded_at is null);
end;
$$;
revoke all on function public.define_source_documents(uuid, jsonb) from public, anon, service_role;
grant execute on function public.define_source_documents(uuid, jsonb) to authenticated;

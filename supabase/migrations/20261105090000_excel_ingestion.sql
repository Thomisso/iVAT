-- Excel Source Files are preserved unchanged, converted to row-numbered text
-- for AI processing, and Split into Documents that reference workbook row sets.

alter type public.source_file_format add value 'xlsx';
alter type public.source_file_format add value 'xls';

update storage.buckets
set allowed_mime_types = array[
  'application/pdf',
  'image/png',
  'image/jpeg',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel'
]
where id = 'source-files';

alter table public.document
  add column source_sheet text,
  add column first_row integer,
  add column last_row integer,
  add column has_document_image boolean not null default true,
  add constraint document_row_set_complete check (
    (source_sheet is null and first_row is null and last_row is null)
    or (
      source_sheet is not null and length(trim(source_sheet)) > 0
      and first_row >= 1 and last_row >= first_row
    )
  ),
  add constraint document_image_matches_source check (
    has_document_image = (source_sheet is null)
  );

drop index public.document_active_source_file_first_page_key;
create unique index document_active_source_file_first_page_key
  on public.document (source_file_id, first_page)
  where superseded_at is null and source_sheet is null;
create unique index document_active_source_file_first_row_key
  on public.document (source_file_id, source_sheet, first_row)
  where superseded_at is null and source_sheet is not null;

-- Row-based Documents cannot use page-boundary correction controls.
create or replace function private.assert_split_document_correctable(doc public.document)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if doc.superseded_at is not null or doc.status in ('uploaded', 'processing') then
    raise exception 'the Split is being processed' using errcode = 'P0001', hint = 'not_correctable';
  end if;
  if not doc.has_document_image then
    raise exception 'row-based Documents do not have page boundaries'
      using errcode = 'P0001', hint = 'not_correctable';
  end if;
  -- Ticket #46 extends this guard with the Period Lock check.
end;
$$;

drop function public.record_split(uuid, jsonb);

-- Records either page ranges for PDFs/images or row sets for workbooks.
create function public.record_split(target_source_file_id uuid, source_ranges jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  file public.source_file;
  source_range jsonb;
  previous_last_page integer := 0;
begin
  select * into file from public.source_file where id = target_source_file_id for update;
  if not found then
    raise exception 'source file % does not exist', target_source_file_id;
  end if;
  if file.status = 'split' then
    return;
  end if;
  if jsonb_array_length(source_ranges) = 0 then
    raise exception 'a Split yields at least one Document';
  end if;

  for source_range in select value from jsonb_array_elements(source_ranges) loop
    if file.format::text in ('xlsx', 'xls') then
      if coalesce(trim(source_range ->> 'sheetName'), '') = ''
        or (source_range ->> 'firstRow')::integer < 1
        or (source_range ->> 'lastRow')::integer < (source_range ->> 'firstRow')::integer then
        raise exception 'workbook row sets must name a sheet and contain positive ascending rows';
      end if;
      insert into public.document (
        organization_id, company_id, source_file_id, first_page, last_page,
        source_sheet, first_row, last_row, has_document_image
      ) values (
        file.organization_id, file.company_id, file.id,
        (source_range ->> 'firstRow')::integer, (source_range ->> 'lastRow')::integer,
        source_range ->> 'sheetName',
        (source_range ->> 'firstRow')::integer, (source_range ->> 'lastRow')::integer,
        false
      );
    else
      if (source_range ->> 'firstPage')::integer <= previous_last_page
        or (source_range ->> 'lastPage')::integer < (source_range ->> 'firstPage')::integer
        or (source_range ->> 'lastPage')::integer > file.page_count then
        raise exception 'page ranges must be ascending, disjoint and within the % pages', file.page_count;
      end if;
      previous_last_page := (source_range ->> 'lastPage')::integer;
      insert into public.document (organization_id, company_id, source_file_id, first_page, last_page)
      values (
        file.organization_id, file.company_id, file.id,
        (source_range ->> 'firstPage')::integer, (source_range ->> 'lastPage')::integer
      );
    end if;
  end loop;

  update public.source_file set status = 'split' where id = file.id;
end;
$$;

revoke execute on function public.record_split(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_split(uuid, jsonb) to service_role;

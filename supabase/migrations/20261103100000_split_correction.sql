-- A corrected Split keeps superseded Documents and their immutable Extraction
-- Versions for history, while only active Documents participate in review and
-- VAT Reports. Corrections atomically reset the resulting Documents for a new
-- Extraction request and audit the operation.

alter table public.document add column superseded_at timestamptz;

alter table public.document drop constraint document_source_file_id_first_page_key;
create unique index document_active_source_file_first_page_key
  on public.document (source_file_id, first_page)
  where superseded_at is null;

-- The existing views are replaced below with the same shape and grants, but
-- superseded Documents are excluded from user work and report generation.
create or replace view public.document_overview with (security_invoker = true) as
select
  d.id,
  d.organization_id,
  d.company_id,
  d.source_file_id,
  d.first_page,
  d.last_page,
  d.status,
  d.created_at,
  v.version,
  v.payload ->> 'documentNumber' as document_number,
  v.payload ->> 'direction' as direction,
  v.payload ->> 'taxPointDate' as tax_point_date,
  case when v.payload ->> 'taxPointDate' ~ '^\d{4}-(0[1-9]|1[0-2])-\d{2}$'
    then left(v.payload ->> 'taxPointDate', 7)
  end as reporting_period,
  c.party ->> 'name' as counterparty_name,
  c.party ->> 'vatId' as counterparty_vat_id,
  c.party ->> 'ico' as counterparty_ico,
  concat_ws(E'\n', c.party ->> 'name', c.party ->> 'vatId', c.party ->> 'ico') as counterparty_search,
  v.payload ->> 'currency' as currency,
  v.payload -> 'totals' ->> 'grossAmount' as gross_amount
from public.document d
left join lateral (
  select ev.version, ev.payload
  from public.extraction_version ev
  where ev.document_id = d.id
  order by ev.version desc
  limit 1
) v on true
left join lateral (
  select case v.payload ->> 'direction'
    when 'incoming' then v.payload -> 'supplier'
    when 'outgoing' then v.payload -> 'customer'
  end as party
) c on true
where d.superseded_at is null;

create or replace view public.vat_report_document with (security_invoker = true) as
select d.id, d.organization_id, d.company_id, d.status, v.id as extraction_version_id, v.payload
from public.document d
left join lateral (
  select ev.id, ev.payload from public.extraction_version ev
  where ev.document_id = d.id order by ev.version desc limit 1
) v on true
where d.superseded_at is null;

create function private.assert_split_document_correctable(doc public.document)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if doc.superseded_at is not null or doc.status in ('uploaded', 'processing') then
    raise exception 'the Split is being processed' using errcode = 'P0001', hint = 'not_correctable';
  end if;
  -- Ticket #46 extends this guard with the Period Lock check.
end;
$$;

revoke execute on function private.assert_split_document_correctable from public;

create function public.merge_documents(left_document_id uuid, right_document_id uuid)
returns uuid[]
language plpgsql security definer set search_path = ''
as $$
declare
  left_doc public.document;
  right_doc public.document;
begin
  perform id from public.document
    where id in (left_document_id, right_document_id)
    order by id for update;
  select * into left_doc from public.document where id = left_document_id;
  select * into right_doc from public.document where id = right_document_id;
  if not found or left_doc.id is null
    or not private.can_access_company(left_doc.company_id, left_doc.organization_id)
    or not private.can_access_company(right_doc.company_id, right_doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform private.assert_split_document_correctable(left_doc);
  perform private.assert_split_document_correctable(right_doc);
  if left_doc.source_file_id <> right_doc.source_file_id
    or left_doc.last_page + 1 <> right_doc.first_page then
    raise exception 'Documents must be adjacent and in page order'
      using errcode = 'P0001', hint = 'invalid_split_boundary';
  end if;

  update public.document
    set superseded_at = clock_timestamp()
    where id = right_doc.id;
  update public.document
    set last_page = right_doc.last_page,
        status = 'uploaded',
        extraction_request_id = gen_random_uuid()
    where id = left_doc.id;

  perform private.record_audit_event(
    'source_file.split_corrected', left_doc.organization_id, left_doc.company_id,
    'source_file', left_doc.source_file_id,
    jsonb_build_object(
      'operation', 'merge',
      'affected_document_ids', jsonb_build_array(left_doc.id),
      'superseded_document_ids', jsonb_build_array(right_doc.id)
    )
  );
  return array[left_doc.id];
end;
$$;

create function public.split_document(target_document_id uuid, split_after_page integer)
returns uuid[]
language plpgsql security definer set search_path = ''
as $$
declare
  doc public.document;
  new_document_id uuid;
begin
  select * into doc from public.document where id = target_document_id for update;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform private.assert_split_document_correctable(doc);
  if split_after_page < doc.first_page or split_after_page >= doc.last_page then
    raise exception 'Split point must be inside the Document'
      using errcode = 'P0001', hint = 'invalid_split_boundary';
  end if;

  update public.document
    set last_page = split_after_page,
        status = 'uploaded',
        extraction_request_id = gen_random_uuid()
    where id = doc.id;
  insert into public.document (
    organization_id, company_id, source_file_id, first_page, last_page, status
  ) values (
    doc.organization_id, doc.company_id, doc.source_file_id,
    split_after_page + 1, doc.last_page, 'uploaded'
  ) returning id into new_document_id;

  perform private.record_audit_event(
    'source_file.split_corrected', doc.organization_id, doc.company_id,
    'source_file', doc.source_file_id,
    jsonb_build_object(
      'operation', 'split',
      'affected_document_ids', jsonb_build_array(doc.id, new_document_id),
      'superseded_document_ids', '[]'::jsonb
    )
  );
  return array[doc.id, new_document_id];
end;
$$;

create function public.move_document_page(source_document_id uuid, target_document_id uuid, page integer)
returns uuid[]
language plpgsql security definer set search_path = ''
as $$
declare
  source_doc public.document;
  target_doc public.document;
begin
  perform id from public.document
    where id in (source_document_id, target_document_id)
    order by id for update;
  select * into source_doc from public.document where id = source_document_id;
  select * into target_doc from public.document where id = target_document_id;
  if not found or source_doc.id is null
    or not private.can_access_company(source_doc.company_id, source_doc.organization_id)
    or not private.can_access_company(target_doc.company_id, target_doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform private.assert_split_document_correctable(source_doc);
  perform private.assert_split_document_correctable(target_doc);
  if source_doc.source_file_id <> target_doc.source_file_id
    or source_doc.first_page = source_doc.last_page then
    raise exception 'A boundary page can only move between adjacent Documents'
      using errcode = 'P0001', hint = 'invalid_split_boundary';
  end if;

  if source_doc.last_page + 1 = target_doc.first_page and page = source_doc.last_page then
    update public.document set last_page = page - 1 where id = source_doc.id;
    update public.document set first_page = page where id = target_doc.id;
  elsif target_doc.last_page + 1 = source_doc.first_page and page = source_doc.first_page then
    update public.document set last_page = page where id = target_doc.id;
    update public.document set first_page = page + 1 where id = source_doc.id;
  else
    raise exception 'Only the shared boundary page can move'
      using errcode = 'P0001', hint = 'invalid_split_boundary';
  end if;

  update public.document
    set status = 'uploaded', extraction_request_id = gen_random_uuid()
    where id in (source_doc.id, target_doc.id);
  perform private.record_audit_event(
    'source_file.split_corrected', source_doc.organization_id, source_doc.company_id,
    'source_file', source_doc.source_file_id,
    jsonb_build_object(
      'operation', 'move_page',
      'page', page,
      'affected_document_ids', jsonb_build_array(source_doc.id, target_doc.id),
      'superseded_document_ids', '[]'::jsonb
    )
  );
  return array[source_doc.id, target_doc.id];
end;
$$;

revoke execute on function public.merge_documents, public.split_document, public.move_document_page from public, anon;
grant execute on function public.merge_documents(uuid, uuid), public.split_document(uuid, integer),
  public.move_document_page(uuid, uuid, integer) to authenticated;

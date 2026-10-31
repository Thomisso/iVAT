-- Approval shares the correction/recovery Company -> Document lock order.
create or replace function public.approve_document(
  target_document_id uuid,
  reviewed_version integer
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  doc public.document;
  current_version integer;
  current_payload jsonb;
begin
  select * into doc from public.document where id = target_document_id;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform 1 from public.company where id = doc.company_id for update;
  select * into doc from public.document where id = target_document_id for update;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if doc.status <> 'needs_review' then
    raise exception 'only a Document in review can be approved'
      using errcode = 'P0001', hint = 'not_in_review';
  end if;

  select v.version, v.payload into current_version, current_payload
  from public.extraction_version v
  where v.document_id = doc.id
  order by v.version desc
  limit 1;

  if current_version is distinct from reviewed_version then
    raise exception 'the Document has a newer Extraction Version'
      using errcode = 'P0001', hint = 'stale_version';
  end if;
  if coalesce(current_payload ->> 'direction', '') not in ('incoming', 'outgoing') then
    raise exception 'Direction must be set before approval'
      using errcode = 'P0001', hint = 'direction_required';
  end if;

  update public.document set status = 'approved' where id = doc.id;
  perform private.record_audit_event(
    'document.approved', doc.organization_id, doc.company_id, 'document', doc.id,
    jsonb_build_object('version', reviewed_version)
  );
end;
$$;

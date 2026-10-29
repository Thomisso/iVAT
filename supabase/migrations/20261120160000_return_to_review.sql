-- Return to Review withdraws a Document's approval so it can be corrected and
-- approved again. Every Role that may approve may return a Document. The
-- document_period_lock trigger refuses the status change while the Document's
-- Reporting Period has a Period Lock (ADR-0007).
create function public.return_document_to_review(target_document_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  doc public.document;
begin
  select * into doc from public.document where id = target_document_id for update;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if doc.superseded_at is not null or doc.status <> 'approved' then
    raise exception 'only an Approved Document can be returned to review'
      using errcode = 'P0001', hint = 'not_approved';
  end if;

  update public.document set status = 'needs_review' where id = doc.id;
  perform private.record_audit_event(
    'document.returned_to_review', doc.organization_id, doc.company_id, 'document', doc.id, '{}'
  );
end;
$$;
revoke execute on function public.return_document_to_review(uuid) from public, anon;
grant execute on function public.return_document_to_review(uuid) to authenticated;

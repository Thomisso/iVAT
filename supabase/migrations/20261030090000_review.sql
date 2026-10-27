-- Review (ADR-0003, ADR-0005): a User corrects a Document in NeedsReview, which
-- adds an Extraction Version authored by them, and approves or rejects it. Only
-- Approved Documents count towards VAT Reports. Both Users and Administrators of
-- the Company review; every review action is a state transition, so it runs
-- through the security-definer functions below (ADR-0008) and is audited.

-- approved: a human confirmed the current Extraction Version; it counts towards VAT Reports.
-- rejected: a human excluded the Document (for example, it is not a tax document).
alter type public.document_status add value 'approved';
alter type public.document_status add value 'rejected';

-- Corrections ------------------------------------------------------------------

-- Records a User's corrections as the Document's next Extraction Version. The
-- corrections are based on the version the User saw; if another has been
-- recorded since, they are refused rather than silently overwriting it.
create function public.correct_document(target_document_id uuid, based_on_version integer, payload jsonb)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  doc public.document;
  current_version integer;
begin
  select * into doc from public.document where id = target_document_id for update;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if doc.status <> 'needs_review' then
    raise exception 'only a Document in review can be corrected' using errcode = 'P0001', hint = 'not_in_review';
  end if;
  select max(v.version) into current_version from public.extraction_version v where v.document_id = doc.id;
  if current_version is distinct from based_on_version then
    raise exception 'the Document has a newer Extraction Version' using errcode = 'P0001', hint = 'stale_version';
  end if;

  insert into public.extraction_version (organization_id, company_id, document_id, version, author_user_id, payload)
  values (doc.organization_id, doc.company_id, doc.id, current_version + 1, auth.uid(), payload);

  perform private.record_audit_event(
    'document.corrected', doc.organization_id, doc.company_id, 'document', doc.id,
    jsonb_build_object('version', current_version + 1)
  );
  return current_version + 1;
end;
$$;

revoke execute on function public.correct_document from public, anon;
grant execute on function public.correct_document(uuid, integer, jsonb) to authenticated;

-- Decisions --------------------------------------------------------------------

-- Approves the Document's current data. The User names the version they
-- reviewed, so a version recorded in the meantime is never approved unseen.
create function public.approve_document(target_document_id uuid, reviewed_version integer)
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
  if doc.status <> 'needs_review' then
    raise exception 'only a Document in review can be approved' using errcode = 'P0001', hint = 'not_in_review';
  end if;
  if (select max(v.version) from public.extraction_version v where v.document_id = doc.id) is distinct from reviewed_version then
    raise exception 'the Document has a newer Extraction Version' using errcode = 'P0001', hint = 'stale_version';
  end if;

  update public.document set status = 'approved' where id = doc.id;
  perform private.record_audit_event(
    'document.approved', doc.organization_id, doc.company_id, 'document', doc.id,
    jsonb_build_object('version', reviewed_version)
  );
end;
$$;

-- Excludes the Document from VAT Reports and from the review queue.
create function public.reject_document(target_document_id uuid)
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
  if doc.status <> 'needs_review' then
    raise exception 'only a Document in review can be rejected' using errcode = 'P0001', hint = 'not_in_review';
  end if;

  update public.document set status = 'rejected' where id = doc.id;
  perform private.record_audit_event('document.rejected', doc.organization_id, doc.company_id, 'document', doc.id, '{}');
end;
$$;

revoke execute on function public.approve_document, public.reject_document from public, anon;
grant execute on function public.approve_document(uuid, integer), public.reject_document(uuid) to authenticated;

-- Document list ----------------------------------------------------------------

-- Each Document with the fields of its current (latest) Extraction Version that
-- the Document list shows and filters by. The counterparty is the supplier of an
-- incoming Document and the customer of an outgoing one. Until Receipt Dates and
-- filing frequencies exist (#43), the Reporting Period is the month of the Tax
-- Point Date. The view runs with the caller's privileges, so RLS applies.
create view public.document_overview with (security_invoker = true) as
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
  -- Read from the text, never cast: an AI payload is not validated, and one
  -- malformed date must not break the whole list.
  case when v.payload ->> 'taxPointDate' ~ '^\d{4}-(0[1-9]|1[0-2])-\d{2}$'
    then left(v.payload ->> 'taxPointDate', 7)
  end as reporting_period,
  c.party ->> 'name' as counterparty_name,
  c.party ->> 'vatId' as counterparty_vat_id,
  c.party ->> 'ico' as counterparty_ico,
  -- What the counterparty filter searches: name, VAT ID and IČO, one per line.
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
) c on true;

revoke all on public.document_overview from anon, authenticated, service_role;
grant select on public.document_overview to authenticated;

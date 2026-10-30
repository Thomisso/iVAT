-- Source-dependent operations require real evidence; identity Duplicate
-- Warnings also apply when one or both Documents were entered manually.
create or replace function public.reprocess_document(target_document_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  doc public.document;
  batch_id uuid;
begin
  select * into doc from public.document where id = target_document_id for update;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if doc.source_file_id is null or doc.status not in ('failed', 'needs_review') then
    raise exception 'the Document is still being processed' using errcode = 'P0001', hint = 'not_reprocessable';
  end if;
  select sf.upload_batch_id into batch_id from public.source_file sf where sf.id = doc.source_file_id;
  update public.upload_batch set processing_finished_at = null where id = batch_id;
  update public.notification
  set read_at = coalesce(read_at, now())
  where kind = 'upload_batch_finished' and payload ->> 'batchId' = batch_id::text;
  update public.document
  set status = 'uploaded', extraction_request_id = gen_random_uuid()
  where id = doc.id;
end;
$$;

-- Duplicate Warnings are derived from the current Extraction Versions. They
-- never change a Document's state and therefore never block review or approval.
-- Only the later Document is warned; the earlier matching Document is linked.

create or replace view public.document_duplicate_warning with (security_invoker = true) as
with current_document as (
  select
    d.id,
    d.organization_id,
    d.company_id,
    d.source_file_id,
    d.created_at,
    sf.sha256,
    v.payload ->> 'documentNumber' as document_number,
    v.payload ->> 'direction' as direction,
    case v.payload ->> 'direction'
      when 'incoming' then v.payload -> 'supplier' ->> 'vatId'
      when 'outgoing' then v.payload -> 'customer' ->> 'vatId'
    end as counterparty_vat_id
  from public.document d
  left join public.source_file sf on sf.id = d.source_file_id
  left join lateral (
    select ev.payload
    from public.extraction_version ev
    where ev.document_id = d.id
    order by ev.version desc
    limit 1
  ) v on true
  where d.superseded_at is null
)
select
  document.id as document_id,
  document.organization_id,
  document.company_id,
  matching.matched_document_id,
  matching.kind
from current_document document
join lateral (
  select candidate.id as matched_document_id, candidate.kind
  from (
    select
      existing.id,
      'document_identity'::text as kind,
      1 as priority,
      existing.created_at
    from current_document existing
    where existing.company_id = document.company_id
      and (existing.created_at, existing.id) < (document.created_at, document.id)
      and nullif(trim(document.document_number), '') is not null
      and nullif(trim(document.direction), '') is not null
      and nullif(regexp_replace(upper(document.counterparty_vat_id), '\s+', '', 'g'), '') is not null
      and lower(trim(existing.document_number)) = lower(trim(document.document_number))
      and existing.direction = document.direction
      and regexp_replace(upper(existing.counterparty_vat_id), '\s+', '', 'g')
        = regexp_replace(upper(document.counterparty_vat_id), '\s+', '', 'g')

    union all

    select
      existing.id,
      'source_file_hash'::text as kind,
      2 as priority,
      existing.created_at
    from current_document existing
    where existing.company_id = document.company_id
      and existing.source_file_id <> document.source_file_id
      and (existing.created_at, existing.id) < (document.created_at, document.id)
      and existing.sha256 = document.sha256
  ) candidate
  order by candidate.priority, candidate.created_at, candidate.id
  limit 1
) matching on true;

revoke all on public.document_duplicate_warning from anon, authenticated, service_role;
grant select on public.document_duplicate_warning to authenticated;

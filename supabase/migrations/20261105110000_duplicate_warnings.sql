-- Duplicate Warnings are derived from the current Extraction Versions. They
-- never change a Document's state and therefore never block review or approval.
-- Only the later Document is warned; the earlier matching Document is linked.

create view public.document_duplicate_warning with (security_invoker = true) as
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
  join public.source_file sf on sf.id = d.source_file_id
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

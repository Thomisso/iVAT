-- Deterministic validation findings belong to the immutable Extraction Version
-- whose payload they describe. Both AI results and User corrections provide
-- the findings computed by the pure application module.

alter table public.extraction_version
  add column findings jsonb not null default '[]'::jsonb,
  add constraint extraction_version_findings_array
    check (jsonb_typeof(findings) = 'array');

drop function public.record_ai_extraction(uuid, uuid, text, text, jsonb);

create function public.record_ai_extraction(
  target_document_id uuid,
  target_extraction_request_id uuid,
  provider text,
  model text,
  payload jsonb,
  findings jsonb
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  doc public.document;
begin
  select * into doc from public.document where id = target_document_id for update;
  if not found then
    raise exception 'document % does not exist', target_document_id;
  end if;
  if jsonb_typeof(findings) <> 'array' then
    raise exception 'findings must be an array';
  end if;
  if doc.extraction_request_id <> target_extraction_request_id
    or exists (
      select 1 from public.extraction_version v
      where v.document_id = doc.id and v.extraction_request_id = target_extraction_request_id
    ) then
    return;
  end if;

  insert into public.extraction_version
    (organization_id, company_id, document_id, version, provider, model, extraction_request_id, payload, findings)
  values (
    doc.organization_id, doc.company_id, doc.id,
    coalesce((select max(v.version) from public.extraction_version v where v.document_id = doc.id), 0) + 1,
    provider, model, target_extraction_request_id, payload, findings
  );

  update public.document set status = 'needs_review' where id = doc.id;
end;
$$;

revoke execute on function public.record_ai_extraction(uuid, uuid, text, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_ai_extraction(uuid, uuid, text, text, jsonb, jsonb)
  to service_role;

drop function public.correct_document(uuid, integer, jsonb);

create function public.correct_document(
  target_document_id uuid,
  based_on_version integer,
  payload jsonb,
  findings jsonb
)
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
  if jsonb_typeof(findings) <> 'array' then
    raise exception 'findings must be an array';
  end if;
  if doc.status <> 'needs_review' then
    raise exception 'only a Document in review can be corrected' using errcode = 'P0001', hint = 'not_in_review';
  end if;
  select max(v.version) into current_version from public.extraction_version v where v.document_id = doc.id;
  if current_version is distinct from based_on_version then
    raise exception 'the Document has a newer Extraction Version' using errcode = 'P0001', hint = 'stale_version';
  end if;

  insert into public.extraction_version
    (organization_id, company_id, document_id, version, author_user_id, payload, findings)
  values (
    doc.organization_id, doc.company_id, doc.id, current_version + 1,
    auth.uid(), payload, findings
  );

  perform private.record_audit_event(
    'document.corrected', doc.organization_id, doc.company_id, 'document', doc.id,
    jsonb_build_object('version', current_version + 1)
  );
  return current_version + 1;
end;
$$;

revoke execute on function public.correct_document(uuid, integer, jsonb, jsonb)
  from public, anon;
grant execute on function public.correct_document(uuid, integer, jsonb, jsonb)
  to authenticated;

-- Expose only the finding count of the current immutable Extraction Version
-- to the Document list. The findings themselves stay with that Version.
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
  v.payload -> 'totals' ->> 'grossAmount' as gross_amount,
  coalesce(jsonb_array_length(v.findings), 0) as finding_count
from public.document d
left join lateral (
  select ev.version, ev.payload, ev.findings
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

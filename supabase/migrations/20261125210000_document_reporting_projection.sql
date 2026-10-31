-- Current data for shared reporting preparation; existing security-invoker/RLS boundaries remain.
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
  private.document_reporting_period(
    d.company_id,
    v.payload ->> 'direction',
    v.payload ->> 'taxPointDate',
    d.claimed_reporting_period
  ) as reporting_period,
  c.party ->> 'name' as counterparty_name,
  c.party ->> 'vatId' as counterparty_vat_id,
  c.party ->> 'ico' as counterparty_ico,
  concat_ws(E'\n', c.party ->> 'name', c.party ->> 'vatId', c.party ->> 'ico') as counterparty_search,
  v.payload ->> 'currency' as currency,
  v.payload -> 'totals' ->> 'grossAmount' as gross_amount,
  coalesce(jsonb_array_length(v.findings), 0)
    + case when v.payload is not null
      and nullif(v.payload ->> 'proposedVatRegime', '') is null
      and not exists (
        select 1 from jsonb_array_elements(coalesce(v.findings, '[]'::jsonb)) finding
        where finding ->> 'code' = 'vat_regime_required'
      ) then 1 else 0 end as finding_count,
  (sf.uploaded_at at time zone 'Europe/Prague')::date as import_date,
  d.claimed_reporting_period,
  nullif(v.payload ->> 'proposedVatRegime', '') as proposed_vat_regime,
  v.id as extraction_version_id,
  v.payload as reporting_payload,
  v.findings as reporting_findings
from public.document d
left join public.source_file sf on sf.id = d.source_file_id
left join lateral (
  select ev.id, ev.version, ev.payload, ev.findings
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




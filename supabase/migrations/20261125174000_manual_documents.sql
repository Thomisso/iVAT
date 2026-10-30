-- A Document belongs directly to its Company; a real Source File is optional.
alter table public.document
  alter column source_file_id drop not null,
  alter column first_page drop not null,
  alter column last_page drop not null,
  drop constraint document_image_matches_source,
  add constraint document_company_tenant foreign key (company_id, organization_id)
    references public.company (id, organization_id),
  add constraint document_source_range_complete check (
    (source_file_id is null and first_page is null and last_page is null
      and source_sheet is null and first_row is null and last_row is null
      and not has_document_image)
    or (source_file_id is not null and first_page is not null and last_page is not null)
  ),
  add constraint document_image_matches_source check (
    has_document_image = (source_file_id is not null and source_sheet is null)
  );

create function public.create_manual_document(target_company_id uuid, payload jsonb, findings jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  company public.company;
  document_id uuid;
begin
  select * into company from public.company where id = target_company_id for update;
  if not found or not private.can_access_company(company.id, company.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(findings) is distinct from 'array' then
    raise exception 'invalid findings' using errcode = 'P0001', hint = 'invalid_choice';
  end if;
  insert into public.document (company_id, organization_id, status, has_document_image)
  values (company.id, company.organization_id, 'needs_review', false) returning id into document_id;
  insert into public.extraction_version
    (company_id, organization_id, document_id, version, author_user_id, payload, findings)
  values (company.id, company.organization_id, document_id, 1, auth.uid(), payload, findings);
  perform private.record_audit_event(
    'document.created', company.organization_id, company.id, 'document', document_id,
    jsonb_build_object('version', 1)
  );
  return document_id;
end;
$$;
revoke execute on function public.create_manual_document(uuid, jsonb, jsonb) from public, anon, service_role;
grant execute on function public.create_manual_document(uuid, jsonb, jsonb) to authenticated;

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
  nullif(v.payload ->> 'proposedVatRegime', '') as proposed_vat_regime
from public.document d
left join public.source_file sf on sf.id = d.source_file_id
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



create or replace function private.reporting_period_readiness_documents(
  target_company_id uuid,
  target_period text
)
returns table (
  document_id uuid,
  status public.document_status,
  extraction_version_id uuid,
  payload jsonb,
  findings jsonb,
  claimed_reporting_period text
)
language sql stable security definer set search_path = ''
as $$
  select
    document.id,
    document.status,
    version.id,
    version.payload,
    (select coalesce(jsonb_agg(
      case when finding ->> 'code' = 'total_gross_amount_mismatch'
        then finding || '{"severity":"warning"}'::jsonb
        else finding end order by position
    ), '[]'::jsonb)
    from jsonb_array_elements(coalesce(version.findings, '[]'::jsonb))
      with ordinality as entry(finding, position))
    || case when version.payload is not null
      and nullif(btrim(version.payload #>> '{payment,bankAccount}'), '') is null
      and nullif(btrim(version.payload #>> '{payment,iban}'), '') is null
      and not exists (
        select 1 from jsonb_array_elements(coalesce(version.findings, '[]'::jsonb)) finding
        where finding ->> 'code' = 'missing_bank_account'
      ) then '[{"field":"payment.bankAccount","severity":"warning","code":"missing_bank_account"}]'::jsonb
      else '[]'::jsonb end,
    document.claimed_reporting_period
  from public.document document
  left join public.source_file source on source.id = document.source_file_id
  left join lateral (
    select extraction.id, extraction.payload, extraction.findings
    from public.extraction_version extraction
    where extraction.document_id = document.id
    order by extraction.version desc
    limit 1
  ) version on true
  cross join lateral (
    select private.document_reporting_period(
      document.company_id,
      version.payload ->> 'direction',
      version.payload ->> 'taxPointDate',
      document.claimed_reporting_period
    ) as period
  ) assignment
  where document.company_id = target_company_id
    and document.superseded_at is null
    and (
      assignment.period = target_period
      or (
        assignment.period is null
        and private.reporting_period_for_date(
          document.company_id,
          (source.uploaded_at at time zone 'Europe/Prague')::date
        ) = target_period
      )
    );
$$;

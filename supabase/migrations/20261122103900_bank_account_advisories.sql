-- Current readiness includes missing-account advisories for older Versions
-- without rewriting immutable payloads/findings. These remain warnings only.
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
  join public.source_file source on source.id = document.source_file_id
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

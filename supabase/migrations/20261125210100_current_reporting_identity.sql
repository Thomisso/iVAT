-- Current mandatory identity, matching the existing Rules Engine and approval
-- guard. It only feeds Document readiness; Source readiness wrappers stay intact.
create function private.missing_required_reporting_vat_id(payload jsonb)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((payload ->> 'direction') in ('incoming', 'outgoing') and (
    (((payload ->> 'proposedVatRegime') = 'domestic' and (payload ->> 'direction') = 'incoming')
      or (payload ->> 'proposedVatRegime') = 'domestic_reverse_charge')
      and coalesce(case payload ->> 'direction' when 'incoming' then payload #>> '{supplier,vatId}' else payload #>> '{customer,vatId}' end, '') !~ '^CZ[0-9]{8,10}$'
    or (payload ->> 'direction') = 'incoming'
      and (payload ->> 'proposedVatRegime') in ('eu_acquisition_of_goods', 'eu_received_service')
      and coalesce(payload #>> '{supplier,vatId}', '') !~ '^[A-Z]{2}[A-Z0-9+*.]{2,12}$'
  ), false);
$$;
revoke execute on function private.missing_required_reporting_vat_id(jsonb) from public, anon, authenticated, service_role;

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
      case when finding ->> 'code' = 'counterparty_vat_id_required'
        and private.missing_required_reporting_vat_id(version.payload)
        then finding || '{"severity":"error"}'::jsonb
        when finding ->> 'code' = 'total_gross_amount_mismatch'
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
      else '[]'::jsonb end
    || case when private.missing_required_reporting_vat_id(version.payload)
      and not exists (
        select 1 from jsonb_array_elements(coalesce(version.findings, '[]'::jsonb)) finding
        where finding ->> 'code' = 'counterparty_vat_id_required'
      ) then jsonb_build_array(jsonb_build_object(
        'field', case version.payload ->> 'direction' when 'incoming' then 'supplier.vatId' else 'customer.vatId' end,
        'severity', 'error', 'code', 'counterparty_vat_id_required'))
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

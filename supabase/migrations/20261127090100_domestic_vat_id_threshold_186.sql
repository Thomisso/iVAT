-- Review, approval and reporting share the existing absolute CZK gross threshold.
-- These projections never rewrite immutable Extraction Versions.
create function private.domestic_counterparty_vat_id_optional(payload jsonb)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  gross text;
begin
  if payload ->> 'proposedVatRegime' is distinct from 'domestic' then return false; end if;
  if payload ->> 'currency' = 'CZK' then
    gross := payload #>> '{totals,grossAmount}';
  elsif payload #>> '{czkConversion,originalCurrency}' = payload ->> 'currency'
    and nullif(payload #>> '{czkConversion,rateDate}', '') is not null
    and payload #>> '{czkConversion,rateDate}' <= payload ->> 'taxPointDate' then
    gross := payload #>> '{czkConversion,totals,grossAmount}';
  end if;
  if coalesce(gross, '') !~ '^-?[0-9]+\.[0-9]{2}$' then return false; end if;
  return abs(gross::numeric) <= 10000;
end;
$$;
revoke execute on function private.domestic_counterparty_vat_id_optional(jsonb) from public, anon, authenticated, service_role;

create or replace function private.missing_required_reporting_vat_id(payload jsonb)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((payload ->> 'direction') in ('incoming', 'outgoing') and (
    (payload ->> 'proposedVatRegime') = 'domestic_reverse_charge'
      and coalesce(case payload ->> 'direction' when 'incoming' then payload #>> '{supplier,vatId}' else payload #>> '{customer,vatId}' end, '') !~ '^CZ[0-9]{8,10}$'
    or (payload ->> 'direction') = 'incoming'
      and (payload ->> 'proposedVatRegime') in ('eu_acquisition_of_goods', 'eu_received_service')
      and coalesce(payload #>> '{supplier,vatId}', '') !~ '^[A-Z]{2}[A-Z0-9+*.]{2,12}$'
    or (payload ->> 'proposedVatRegime') = 'domestic' and (
      (nullif(case payload ->> 'direction' when 'incoming' then payload #>> '{supplier,vatId}' else payload #>> '{customer,vatId}' end, '') is null
        and not private.domestic_counterparty_vat_id_optional(payload))
      or ((payload ->> 'direction') = 'incoming'
        and nullif(payload #>> '{supplier,vatId}', '') is not null
        and payload #>> '{supplier,vatId}' !~ '^CZ[0-9]{8,10}$')
    )
  ), false);
$$;

create function private.current_document_validation_findings(payload jsonb, findings jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
  select (select coalesce(jsonb_agg(
      case when finding ->> 'code' = 'total_gross_amount_mismatch'
        then finding || '{"severity":"warning"}'::jsonb else finding end order by position
    ), '[]'::jsonb)
    from jsonb_array_elements(coalesce(findings, '[]'::jsonb)) with ordinality as entry(finding, position)
    where finding ->> 'code' not in ('counterparty_vat_id_required', 'missing_supplier_vat_id'))
    || case when private.missing_required_reporting_vat_id(payload)
      then jsonb_build_array(jsonb_build_object(
        'field', case payload ->> 'direction' when 'incoming' then 'supplier.vatId' else 'customer.vatId' end,
        'severity', 'error', 'code', 'counterparty_vat_id_required'))
      when payload ->> 'direction' = 'incoming'
        and nullif(payload #>> '{supplier,vatId}', '') is null
        and private.domestic_counterparty_vat_id_optional(payload)
      then '[{"field":"supplier.vatId","severity":"warning","code":"missing_supplier_vat_id"}]'::jsonb
      else '[]'::jsonb end;
$$;
revoke execute on function private.current_document_validation_findings(jsonb, jsonb) from public, anon, authenticated, service_role;

-- Match the existing deterministic identifier checks independently of caller findings.
create function private.valid_document_ico(candidate text)
returns boolean language plpgsql immutable security definer set search_path = '' as $$
declare
  weighted integer := 0;
  remainder integer;
begin
  if coalesce(candidate, '') !~ '^[0-9]{8}$' then return false; end if;
  for position in 1..7 loop
    weighted := weighted + substring(candidate, position, 1)::integer * (9 - position);
  end loop;
  remainder := weighted % 11;
  return right(candidate, 1)::integer = case remainder when 0 then 1 when 1 then 0 else 11 - remainder end;
end;
$$;
revoke execute on function private.valid_document_ico(text) from public, anon, authenticated, service_role;

create function private.valid_document_vat_id(candidate text)
returns boolean language plpgsql immutable security definer set search_path = '' as $$
declare
  digits text;
  birth_year integer;
  birth_month integer;
begin
  if left(candidate, 2) <> 'CZ' then
    return coalesce(candidate ~ '^[A-Z]{2}[A-Z0-9+*.]{2,12}$', false);
  end if;
  if candidate !~ '^CZ[0-9]{8,10}$' then return false; end if;
  digits := substring(candidate from 3);
  if length(digits) = 8 then return private.valid_document_ico(digits); end if;
  birth_year := left(digits, 2)::integer;
  birth_month := substring(digits, 3, 2)::integer;
  birth_month := birth_month - case when birth_month > 70 then 70 when birth_month > 50 then 50 when birth_month > 20 then 20 else 0 end;
  if not private.valid_document_tax_point_date(
    (case when length(digits) = 9 or birth_year >= 54 then 1900 else 2000 end + birth_year)::text
    || '-' || lpad(birth_month::text, 2, '0') || '-' || substring(digits, 5, 2)
  ) then return false; end if;
  return case when length(digits) = 9 then birth_year < 54 else digits::bigint % 11 = 0 end;
end;
$$;
revoke execute on function private.valid_document_vat_id(text) from public, anon, authenticated, service_role;

create or replace function private.refuse_incomplete_document_approval()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  payload jsonb;
  findings jsonb;
  amount_text text;
  line jsonb;
  regime text;
  party jsonb;
  valid_rates numeric[];
begin
  if new.status <> 'approved' or old.status = 'approved' then return new; end if;
  select version.payload, version.findings into payload, findings
  from public.extraction_version version
  where version.document_id = new.id order by version.version desc limit 1;
  if nullif(btrim(payload ->> 'documentNumber'), '') is null
    or not private.valid_document_tax_point_date(payload ->> 'taxPointDate')
    or coalesce(payload ->> 'currency', '') !~ '^[A-Z]{3}$'
    or jsonb_typeof(payload -> 'rateBreakdown') is distinct from 'array'
    or jsonb_array_length(payload -> 'rateBreakdown') = 0 then
    raise exception 'required Document data is incomplete'
      using errcode = 'P0001', hint = 'document_incomplete';
  end if;
  for amount_text in
    select payload #>> '{totals,netAmount}' union all
    select payload #>> '{totals,vatAmount}' union all
    select payload #>> '{totals,grossAmount}'
  loop
    if coalesce(amount_text, '') !~ '^-?[0-9]+\.[0-9]{2}$' then
      raise exception 'Document totals are incomplete'
        using errcode = 'P0001', hint = 'document_incomplete';
    end if;
  end loop;
  regime := payload ->> 'proposedVatRegime';
  valid_rates := case
    when payload ->> 'taxPointDate' >= '2024-01-01' then array[0,12,21]
    when payload ->> 'taxPointDate' >= '2015-01-01' then array[0,10,15,21]
    when payload ->> 'taxPointDate' >= '2013-01-01' then array[0,15,21]
    when payload ->> 'taxPointDate' >= '2012-01-01' then array[0,14,20]
    when payload ->> 'taxPointDate' >= '2010-01-01' then array[0,10,20]
    when payload ->> 'taxPointDate' >= '2008-01-01' then array[0,9,19]
    when payload ->> 'taxPointDate' >= '2004-05-01' then array[0,5,19]
  end;
  for line in select value from jsonb_array_elements(payload -> 'rateBreakdown') loop
    if jsonb_typeof(line -> 'rate') is distinct from 'number'
      or (line ->> 'rate')::numeric < 0 or (line ->> 'rate')::numeric > 100
      or coalesce(line ->> 'netAmount', '') !~ '^-?[0-9]+\.[0-9]{2}$'
      or coalesce(line ->> 'vatAmount', '') !~ '^-?[0-9]+\.[0-9]{2}$' then
      raise exception 'Rate Breakdown is incomplete'
        using errcode = 'P0001', hint = 'document_incomplete';
    end if;
    if valid_rates is not null and not ((line ->> 'rate')::numeric = any(valid_rates)) then
      raise exception 'VAT rate is not valid on the Tax Point Date'
        using errcode = 'P0001', hint = 'document_validation_failed';
    end if;
    -- Match current deterministic VAT validation, including its two-haler
    -- tolerance and Math.round-style cent rounding for negative amounts.
    if regime not in ('domestic_reverse_charge', 'eu_acquisition_of_goods', 'eu_received_service')
      and abs(floor((line ->> 'netAmount')::numeric * (line ->> 'rate')::numeric + 0.5)
        - (line ->> 'vatAmount')::numeric * 100) > 2 then
      raise exception 'VAT does not match the Rate Breakdown'
        using errcode = 'P0001', hint = 'document_validation_failed';
    end if;
  end loop;
  if regime not in ('domestic', 'domestic_reverse_charge', 'eu_acquisition_of_goods', 'eu_received_service', 'other') then
    raise exception 'invalid VAT Regime' using errcode = 'P0001', hint = 'document_validation_failed';
  end if;
  for party in select payload -> 'supplier' union all select payload -> 'customer' loop
    if (nullif(party ->> 'vatId', '') is not null and not private.valid_document_vat_id(party ->> 'vatId'))
      or (nullif(party ->> 'ico', '') is not null and not private.valid_document_ico(party ->> 'ico')) then
      raise exception 'Document identifiers are invalid'
        using errcode = 'P0001', hint = 'document_validation_failed';
    end if;
  end loop;
  if private.missing_required_reporting_vat_id(payload)
    or (regime in ('eu_acquisition_of_goods', 'eu_received_service')
      and coalesce(payload #>> '{supplier,vatId}', '') !~ '^[A-Z]{2}[A-Z0-9+*.]{2,12}$') then
    raise exception 'counterparty VAT ID is required'
      using errcode = 'P0001', hint = 'counterparty_vat_id_required';
  end if;
  if regime = 'domestic_reverse_charge' and coalesce(payload ->> 'reverseChargeCode', '') !~ '^[0-9]{1,3}$' then
    raise exception 'reverse charge subject code is required'
      using errcode = 'P0001', hint = 'document_incomplete';
  end if;
  if regime <> 'other' and payload ->> 'currency' <> 'CZK' and (
    payload #>> '{czkConversion,originalCurrency}' is distinct from payload ->> 'currency'
    or nullif(payload #>> '{czkConversion,rateDate}', '') is null
    or payload #>> '{czkConversion,rateDate}' > payload ->> 'taxPointDate'
  ) then
    raise exception 'currency conversion is required'
      using errcode = 'P0001', hint = 'currency_conversion_required';
  end if;
  if exists (select 1 from jsonb_array_elements(private.current_document_validation_findings(payload, findings)) finding
    where finding ->> 'severity' = 'error'
      and finding ->> 'code' not in ('total_gross_amount_mismatch', 'vat_regime_required',
        'total_net_amount_mismatch', 'total_vat_amount_mismatch')) then
    raise exception 'Document validation errors must be resolved'
      using errcode = 'P0001', hint = 'document_validation_failed';
  end if;
  return new;
end;
$$;
revoke execute on function private.refuse_incomplete_document_approval() from public;

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
    private.current_document_validation_findings(version.payload, version.findings)
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

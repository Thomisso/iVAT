-- Saving a draft is intentionally weaker than approving a complete Document.
-- Completeness is checked independently of caller-provided validation findings.
create function private.refuse_incomplete_document_approval()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  payload jsonb;
  findings jsonb;
  amount_text text;
  line jsonb;
  counterparty jsonb;
  regime text;
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
  counterparty := case payload ->> 'direction' when 'incoming' then payload -> 'supplier' else payload -> 'customer' end;
  if ((regime = 'domestic' and payload ->> 'direction' = 'incoming') or regime = 'domestic_reverse_charge')
      and coalesce(counterparty ->> 'vatId', '') !~ '^CZ[0-9]{8,10}$'
    or regime in ('eu_acquisition_of_goods', 'eu_received_service')
      and coalesce(payload #>> '{supplier,vatId}', '') !~ '^[A-Z]{2}[A-Z0-9+*.]{2,12}$' then
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
  if exists (select 1 from jsonb_array_elements(coalesce(findings, '[]'::jsonb)) finding
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
create trigger document_completeness_before_approval
  before update of status on public.document
  for each row execute function private.refuse_incomplete_document_approval();

-- Source totals and each source rate row must match the saved full-Document conversion.
-- Older weekend/holiday fixings remain valid; no live rate lookup or age guess occurs here.
create function private.document_proportional_conversion_valid(candidate jsonb)
returns boolean language plpgsql immutable security definer set search_path = '' as $$
declare saved jsonb := candidate -> 'czkConversion'; original jsonb; converted jsonb;
  fixing numeric; units numeric; amount_key text; matched integer; seen text[] := '{}';
begin
  if jsonb_typeof(saved) is distinct from 'object'
    or coalesce(candidate ->> 'currency', '') !~ '^[A-Z]{3}$' or candidate ->> 'currency' = 'CZK'
    or saved ->> 'originalCurrency' is distinct from candidate ->> 'currency'
    or saved ->> 'source' is distinct from 'CNB'
    or coalesce(saved ->> 'rateDate', '') !~ '^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or not pg_catalog.pg_input_is_valid(saved ->> 'rateDate', 'date')
    or coalesce(candidate ->> 'taxPointDate', '') !~ '^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or not pg_catalog.pg_input_is_valid(candidate ->> 'taxPointDate', 'date')
    or saved ->> 'rateDate' > candidate ->> 'taxPointDate'
    or jsonb_typeof(saved -> 'rate') is distinct from 'string'
    or coalesce(saved ->> 'rate', '') !~ '^[0-9]+(\.[0-9]+)?$'
    or not pg_catalog.pg_input_is_valid(saved ->> 'rate', 'numeric')
    or jsonb_typeof(saved -> 'unit') is distinct from 'number'
    or coalesce(saved ->> 'unit', '') !~ '^[0-9]+$'
    or not pg_catalog.pg_input_is_valid(saved ->> 'unit', 'numeric')
    or jsonb_typeof(saved -> 'totals') is distinct from 'object'
    or jsonb_typeof(saved -> 'rateBreakdown') is distinct from 'array'
    or jsonb_typeof(candidate -> 'rateBreakdown') is distinct from 'array' then return false; end if;
  fixing := (saved ->> 'rate')::numeric; units := (saved ->> 'unit')::numeric;
  if fixing <= 0 or units <= 0 or units > 9007199254740991 then return false; end if;
  foreach amount_key in array array['netAmount','vatAmount','grossAmount'] loop
    if jsonb_typeof(candidate #> array['totals',amount_key]) is distinct from 'string'
      or coalesce(candidate #>> array['totals',amount_key], '') !~ '^-?[0-9]+\.[0-9]{2}$'
      or jsonb_typeof(saved #> array['totals',amount_key]) is distinct from 'string'
      or round((candidate #>> array['totals',amount_key])::numeric * fixing / units, 2)::text
        is distinct from saved #>> array['totals',amount_key] then return false; end if;
  end loop;
  for original in select value from jsonb_array_elements(candidate -> 'rateBreakdown') loop
    if original ->> 'netAmount' ~ '^-?0+\.00$' and original ->> 'vatAmount' ~ '^-?0+\.00$' then continue; end if;
    if original ->> 'rate' is null or original ->> 'rate' = any(seen) then return false; end if;
    select count(*) into matched from jsonb_array_elements(saved -> 'rateBreakdown') row where row -> 'rate' = original -> 'rate';
    if matched <> 1 then return false; end if;
    select value into converted from jsonb_array_elements(saved -> 'rateBreakdown') where value -> 'rate' = original -> 'rate';
    foreach amount_key in array array['netAmount','vatAmount'] loop
      if jsonb_typeof(original -> amount_key) is distinct from 'string'
        or coalesce(original ->> amount_key, '') !~ '^-?[0-9]+\.[0-9]{2}$'
        or jsonb_typeof(converted -> amount_key) is distinct from 'string'
        or round((original ->> amount_key)::numeric * fixing / units, 2)::text is distinct from converted ->> amount_key then return false; end if;
    end loop;
    seen := array_append(seen, original ->> 'rate');
  end loop;
  return cardinality(seen) = jsonb_array_length(saved -> 'rateBreakdown');
exception when others then return false;
end;
$$;
revoke all on function private.document_proportional_conversion_valid(jsonb) from public, anon, authenticated, service_role;

-- Reduce in source currency before using the full Document stored conversion.
create or replace function private.document_proportional_deduction_valid(candidate jsonb)
returns boolean language plpgsql immutable security definer set search_path = '' as $$
declare choice jsonb := candidate -> 'proportionalDeduction'; original jsonb; net numeric := 0; vat numeric := 0; seen text[] := '{}';
begin
  if choice is null then return true; end if;
  if jsonb_typeof(choice) is distinct from 'object' or choice -> 'confirmed' is distinct from 'true'::jsonb
    or choice -> 'operatingExpenseConfirmed' is distinct from 'true'::jsonb or choice -> 'actualUseConfirmed' is distinct from 'true'::jsonb
    or choice ->> 'origin' is distinct from 'user' or jsonb_typeof(choice -> 'percentage') is distinct from 'number'
    or choice ->> 'percentage' !~ '^[1-9][0-9]?$' or (choice ->> 'percentage')::numeric > 99
    or choice -> 'basis' is distinct from private.document_claim_basis(candidate)
    or candidate ? 'partialClaim' or candidate ->> 'direction' is distinct from 'incoming'
    or candidate ->> 'proposedVatRegime' is distinct from 'domestic' or coalesce(candidate ->> 'currency', '') !~ '^[A-Z]{3}$'
    or coalesce(candidate ->> 'documentType','') not in ('invoice','receipt','simplified_tax_document')
    or jsonb_typeof(candidate #> '{totals,netAmount}') is distinct from 'string' or coalesce(candidate #>> '{totals,netAmount}', '') !~ '^[0-9]+\.[0-9]{2}$'
    or jsonb_typeof(candidate #> '{totals,vatAmount}') is distinct from 'string' or coalesce(candidate #>> '{totals,vatAmount}', '') !~ '^[0-9]+\.[0-9]{2}$'
    or jsonb_typeof(candidate -> 'rateBreakdown') is distinct from 'array' or jsonb_array_length(candidate -> 'rateBreakdown') = 0
    or exists (select 1 from jsonb_object_keys(choice) key where key not in ('percentage','confirmed','operatingExpenseConfirmed','actualUseConfirmed','origin','basis')) then return false; end if;
  if candidate ->> 'currency' <> 'CZK' and not private.document_proportional_conversion_valid(candidate) then return false; end if;
  for original in select value from jsonb_array_elements(candidate -> 'rateBreakdown') loop
    if coalesce(original ->> 'rate','') not in ('21','12') or original ->> 'rate' = any(seen)
      or jsonb_typeof(original -> 'netAmount') is distinct from 'string' or jsonb_typeof(original -> 'vatAmount') is distinct from 'string'
      or original ->> 'netAmount' !~ '^[0-9]+\.[0-9]{2}$' or original ->> 'vatAmount' !~ '^[0-9]+\.[0-9]{2}$'
      or abs((original ->> 'vatAmount')::numeric - round((original ->> 'netAmount')::numeric * (original ->> 'rate')::numeric / 100,2)) > 0.02 then return false; end if;
    seen := array_append(seen, original ->> 'rate'); net := net + (original ->> 'netAmount')::numeric; vat := vat + (original ->> 'vatAmount')::numeric;
  end loop;
  return coalesce(abs((candidate #>> '{totals,netAmount}')::numeric - net) <= 0.02 and abs((candidate #>> '{totals,vatAmount}')::numeric - vat) <= 0.02, false);
exception when others then return false;
end;
$$;
revoke all on function private.document_proportional_deduction_valid(jsonb) from public, anon, authenticated, service_role;

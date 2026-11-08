-- Extend the validation used by 013's approval trigger. The installed metadata
-- delegates remain in place for directory intent and the later 015/017 wrappers.
create or replace function private.document_partial_claim_valid(candidate jsonb)
returns boolean language plpgsql immutable security definer set search_path = '' as $$
declare claim jsonb := candidate -> 'partialClaim'; selected jsonb; original jsonb;
  net numeric; vat numeric; full_net numeric; full_vat numeric; rate numeric;
  net_sum numeric := 0; vat_sum numeric := 0; selected_net numeric := 0; selected_vat numeric := 0; seen text[] := '{}';
begin
  if claim is null then return true; end if;
  if jsonb_typeof(claim) is distinct from 'object' or claim -> 'confirmed' is distinct from 'true'::jsonb
    or claim -> 'basis' is distinct from private.document_claim_basis(candidate)
    or candidate ->> 'direction' is distinct from 'incoming' or candidate ->> 'proposedVatRegime' is distinct from 'domestic'
    or coalesce(candidate ->> 'currency', '') !~ '^[A-Z]{3}$' or candidate ->> 'documentType' = 'credit_note'
    or jsonb_typeof(candidate -> 'rateBreakdown') is distinct from 'array'
    or jsonb_typeof(claim -> 'rateBreakdown') is distinct from 'array'
    or jsonb_array_length(candidate -> 'rateBreakdown') = 0
    or jsonb_array_length(candidate -> 'rateBreakdown') <> jsonb_array_length(claim -> 'rateBreakdown') then return false; end if;
  if exists (select 1 from jsonb_object_keys(claim) key where key <> all(array['basis','confirmed','zeroConfirmed','rateBreakdown'])) then return false; end if;
  if candidate ->> 'currency' <> 'CZK' and not coalesce(
    candidate #>> '{czkConversion,originalCurrency}' = candidate ->> 'currency'
    and (candidate #>> '{czkConversion,rate}')::numeric > 0
    and (candidate #>> '{czkConversion,unit}')::numeric > 0
    and (candidate #>> '{czkConversion,unit}')::numeric = trunc((candidate #>> '{czkConversion,unit}')::numeric)
    and (candidate #>> '{czkConversion,rateDate}')::date <= (candidate ->> 'taxPointDate')::date, false) then return false; end if;
  for selected in select value from jsonb_array_elements(claim -> 'rateBreakdown') loop
    if selected ->> 'rate' not in ('21','12') or selected ->> 'rate' = any(seen)
      or (select count(*) from jsonb_array_elements(candidate -> 'rateBreakdown') row where row -> 'rate' = selected -> 'rate') <> 1
      or jsonb_typeof(selected -> 'netAmount') is distinct from 'string' or jsonb_typeof(selected -> 'vatAmount') is distinct from 'string'
      or selected ->> 'netAmount' !~ '^[0-9]+\.[0-9]{2}$' or selected ->> 'vatAmount' !~ '^[0-9]+\.[0-9]{2}$' then return false; end if;
    select value into original from jsonb_array_elements(candidate -> 'rateBreakdown') where value -> 'rate' = selected -> 'rate';
    net := (selected ->> 'netAmount')::numeric; vat := (selected ->> 'vatAmount')::numeric;
    full_net := (original ->> 'netAmount')::numeric; full_vat := (original ->> 'vatAmount')::numeric; rate := (selected ->> 'rate')::numeric;
    if not coalesce(net >= 0 and vat >= 0 and (net <> 0 or vat = 0) and net <= full_net and vat <= full_vat
      and abs(vat - round(net * rate / 100, 2)) <= 0.02
      and abs(full_vat - round(full_net * rate / 100, 2)) <= 0.02, false) then return false; end if;
    net_sum := net_sum + full_net; vat_sum := vat_sum + full_vat; seen := array_append(seen, selected ->> 'rate');
    selected_net := selected_net + net; selected_vat := selected_vat + vat;
  end loop;
  if selected_net = 0 and selected_vat = 0 and claim -> 'zeroConfirmed' is distinct from 'true'::jsonb then return false; end if;
  return coalesce(abs((candidate #>> '{totals,netAmount}')::numeric - net_sum) <= 0.02
    and abs((candidate #>> '{totals,vatAmount}')::numeric - vat_sum) <= 0.02, false);
exception when others then return false;
end;
$$;
revoke all on function private.document_partial_claim_valid(jsonb) from public, anon, authenticated, service_role;

-- 013 preserves an omitted choice and strips an explicit human JSON null.
-- Observe the resulting immutable Version after all metadata binders ran.
create function private.audit_document_full_claim_choice()
returns trigger language plpgsql security definer set search_path = '' as $$
declare previous public.extraction_version;
begin
  select * into previous from public.extraction_version
    where document_id = new.document_id and version < new.version order by version desc limit 1;
  if new.author_user_id is not null and previous.payload ? 'partialClaim' and not (new.payload ? 'partialClaim') then
    perform private.record_audit_event('document.partial_claim_cleared', new.organization_id, new.company_id, 'document', new.document_id,
      jsonb_build_object('previousVersion', previous.version, 'version', new.version));
  end if;
  return new;
end;
$$;
revoke all on function private.audit_document_full_claim_choice() from public, anon, authenticated, service_role;
create trigger extraction_version_full_claim_choice after insert on public.extraction_version
  for each row execute function private.audit_document_full_claim_choice();

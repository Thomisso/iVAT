-- A separate manual §75 actual-use choice, never a reinterpretation of Partial Claim.
alter function private.document_review_data(jsonb) rename to document_review_data_before_proportional;
create function private.document_review_data(candidate jsonb)
returns jsonb language sql immutable security definer set search_path = '' as $$
  select private.document_review_data_before_proportional(candidate)
    || case when candidate ? 'proportionalDeduction' then jsonb_build_object('proportionalDeduction', candidate -> 'proportionalDeduction') else '{}'::jsonb end;
$$;
revoke all on function private.document_review_data(jsonb) from public, anon, authenticated, service_role;

create function private.document_proportional_payload(base jsonb, candidate jsonb)
returns jsonb language plpgsql immutable security definer set search_path = '' as $$
declare choice jsonb; basis jsonb;
begin
  if candidate -> 'proportionalDeduction' = 'null'::jsonb then return candidate; end if;
  choice := coalesce(candidate -> 'proportionalDeduction', base -> 'proportionalDeduction');
  if choice is null then return candidate; end if;
  if jsonb_typeof(choice) <> 'object' then
    raise exception 'invalid proportional deduction' using errcode = 'P0001', hint = 'document_validation_failed';
  end if;
  basis := coalesce(choice -> 'basis', base #> '{proportionalDeduction,basis}', private.document_claim_basis(candidate));
  choice := choice || jsonb_build_object('basis', basis);
  if basis is distinct from private.document_claim_basis(candidate) then choice := choice || '{"confirmed":false}'::jsonb; end if;
  return jsonb_set(candidate, '{proportionalDeduction}', choice);
end;
$$;
revoke all on function private.document_proportional_payload(jsonb, jsonb) from public, anon, authenticated, service_role;

alter function private.document_manual_review_payload(jsonb, jsonb) rename to document_manual_review_payload_before_proportional;
create function private.document_manual_review_payload(base jsonb, candidate jsonb)
returns jsonb language sql immutable security definer set search_path = '' as $$
  select private.document_proportional_payload(base, private.document_manual_review_payload_before_proportional(base, candidate));
$$;
revoke all on function private.document_manual_review_payload(jsonb, jsonb) from public, anon, authenticated, service_role;

create function private.bind_document_proportional_deduction()
returns trigger language plpgsql security definer set search_path = '' as $$
declare base jsonb;
begin
  select payload into base from public.extraction_version where document_id = new.document_id order by version desc limit 1;
  if new.author_user_id is null then
    new.payload := new.payload - 'proportionalDeduction';
    if base ? 'proportionalDeduction' then new.payload := jsonb_set(new.payload, '{proportionalDeduction}', (base -> 'proportionalDeduction') || '{"confirmed":false}'::jsonb); end if;
  else
    new.payload := private.document_proportional_payload(coalesce(base, '{}'::jsonb), new.payload);
    if new.payload -> 'proportionalDeduction' = 'null'::jsonb then new.payload := new.payload - 'proportionalDeduction'; end if;
  end if;
  return new;
end;
$$;
revoke all on function private.bind_document_proportional_deduction() from public, anon, authenticated, service_role;
create trigger extraction_version_proportional_deduction before insert on public.extraction_version
  for each row execute function private.bind_document_proportional_deduction();

create function private.document_proportional_deduction_valid(candidate jsonb)
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
    or candidate ->> 'proposedVatRegime' is distinct from 'domestic' or candidate ->> 'currency' is distinct from 'CZK'
    or coalesce(candidate ->> 'documentType','') not in ('invoice','receipt','simplified_tax_document')
    or jsonb_typeof(candidate #> '{totals,netAmount}') is distinct from 'string' or coalesce(candidate #>> '{totals,netAmount}', '') !~ '^[0-9]+\.[0-9]{2}$'
    or jsonb_typeof(candidate #> '{totals,vatAmount}') is distinct from 'string' or coalesce(candidate #>> '{totals,vatAmount}', '') !~ '^[0-9]+\.[0-9]{2}$'
    or jsonb_typeof(candidate -> 'rateBreakdown') is distinct from 'array' or jsonb_array_length(candidate -> 'rateBreakdown') = 0
    or exists (select 1 from jsonb_object_keys(choice) key where key not in ('percentage','confirmed','operatingExpenseConfirmed','actualUseConfirmed','origin','basis')) then return false; end if;
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

create function private.refuse_invalid_proportional_approval()
returns trigger language plpgsql security definer set search_path = '' as $$
declare candidate jsonb;
begin
  select payload into candidate from public.extraction_version where document_id = new.id order by version desc limit 1;
  if not private.document_proportional_deduction_valid(candidate) then
    raise exception 'confirm a supported actual-use proportional deduction' using errcode = 'P0001', hint = 'document_validation_failed';
  end if;
  return new;
end;
$$;
revoke all on function private.refuse_invalid_proportional_approval() from public, anon, authenticated, service_role;
create trigger document_proportional_approval before update of status on public.document
  for each row when (new.status = 'approved') execute function private.refuse_invalid_proportional_approval();

create function private.audit_document_proportional_deduction()
returns trigger language plpgsql security definer set search_path = '' as $$
declare base jsonb;
begin
  select payload into base from public.extraction_version where document_id = new.document_id and version < new.version order by version desc limit 1;
  if new.author_user_id is not null and new.payload -> 'proportionalDeduction' is distinct from base -> 'proportionalDeduction' then
    if new.payload ? 'proportionalDeduction' or base ? 'proportionalDeduction' then
      perform private.record_audit_event('document.proportional_deduction_changed', new.organization_id, new.company_id, 'document', new.document_id,
        jsonb_build_object('version', new.version, 'extractionVersionId', new.id, 'percentage', new.payload #> '{proportionalDeduction,percentage}', 'confirmed', new.payload #> '{proportionalDeduction,confirmed}'));
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.audit_document_proportional_deduction() from public, anon, authenticated, service_role;
create trigger extraction_version_proportional_audit after insert on public.extraction_version
  for each row execute function private.audit_document_proportional_deduction();

-- Existing preparation, finalization and new-artifact guards delegate here.
-- Historical stored payloads/results/bytes are never rewritten.
alter function private.document_eligibility_error(uuid, uuid, jsonb, text) rename to document_eligibility_error_before_proportional;
create function private.document_eligibility_error(target_company_id uuid, target_document_id uuid, candidate jsonb, claimed_period text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare refusal text; chosen text;
begin
  refusal := private.document_eligibility_error_before_proportional(target_company_id, target_document_id, candidate, claimed_period);
  if refusal is not null then return refusal; end if;
  if candidate ? 'proportionalDeduction' then
    if not private.document_proportional_deduction_valid(candidate) then return 'proportional_deduction_invalid'; end if;
    chosen := coalesce(claimed_period, private.reporting_period_for_date(target_company_id, (candidate ->> 'taxPointDate')::date));
    if left(chosen,4) is distinct from left(candidate #>> '{claimEligibility,period}',4) then return 'proportional_claim_year_mismatch'; end if;
  end if;
  return null;
end;
$$;
revoke all on function private.document_eligibility_error(uuid, uuid, jsonb, text) from public, anon, authenticated, service_role;

-- A missing possession-year confirmation must not bypass assignment checks.
alter function public.update_document_reporting(uuid, text) rename to update_document_reporting_before_proportional;
revoke all on function public.update_document_reporting_before_proportional(uuid, text) from public, anon, authenticated, service_role;
create function public.update_document_reporting(target_document_id uuid, new_claimed_reporting_period text)
returns void language plpgsql security definer set search_path = '' as $$
declare doc public.document; candidate jsonb; refusal text;
begin
  select * into doc from public.document where id = target_document_id;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then raise insufficient_privilege; end if;
  perform 1 from public.company where id = doc.company_id for update;
  select * into doc from public.document where id = target_document_id for update;
  select payload into candidate from public.extraction_version where document_id = doc.id order by version desc limit 1;
  if private.is_reporting_period_locked(doc.company_id, private.document_reporting_period_for(doc, candidate))
    or private.is_reporting_period_locked(doc.company_id, new_claimed_reporting_period) then
    raise exception 'the Reporting Period is locked' using errcode = 'P0001', hint = 'period_locked';
  end if;
  if doc.status <> 'needs_review' then raise exception 'return the Document to review first' using errcode = 'P0001', hint = 'not_in_review'; end if;
  if candidate ? 'proportionalDeduction' then
    refusal := private.document_eligibility_error(doc.company_id, doc.id, candidate, new_claimed_reporting_period);
    if refusal is not null then raise exception 'resolve the proportional claim period' using errcode = 'P0001', hint = refusal; end if;
  end if;
  perform public.update_document_reporting_before_proportional(target_document_id, new_claimed_reporting_period);
end;
$$;
revoke all on function public.update_document_reporting(uuid, text) from public, anon, service_role;
grant execute on function public.update_document_reporting(uuid, text) to authenticated;

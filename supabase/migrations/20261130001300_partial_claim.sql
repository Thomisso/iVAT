-- Extend the installed directory projection instead of copying its whitelist.
-- The later source-evidence helper delegates dynamically through this projection.
alter function private.document_review_data(jsonb) rename to document_review_data_before_partial_claim;
create function private.document_review_data(candidate jsonb)
returns jsonb language sql immutable security definer set search_path = '' as $$
  select private.document_review_data_before_partial_claim(candidate)
    || case when candidate ? 'partialClaim' then jsonb_build_object('partialClaim', candidate -> 'partialClaim') else '{}'::jsonb end;
$$;
revoke all on function private.document_review_data(jsonb) from public, anon, authenticated, service_role;

create function private.document_claim_basis(candidate jsonb)
returns jsonb language sql immutable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(candidate)
  where key = any(array['documentType','direction','currency','proposedVatRegime','taxPointDate','rateBreakdown','totals']);
$$;
revoke all on function private.document_claim_basis(jsonb) from public, anon, authenticated, service_role;

-- Missing metadata never silently restores full deduction. Explicit JSON null
-- is a human command to return to full amounts; it is removed before storage.
create function private.document_partial_claim_payload(base jsonb, candidate jsonb)
returns jsonb language plpgsql immutable security definer set search_path = '' as $$
declare claim jsonb; basis jsonb;
begin
  if candidate ? 'partialClaim' and candidate -> 'partialClaim' = 'null'::jsonb then return candidate; end if;
  claim := coalesce(candidate -> 'partialClaim', base -> 'partialClaim');
  if claim is null then return candidate; end if;
  if jsonb_typeof(claim) <> 'object' then
    raise exception 'invalid Partial Claim' using errcode = 'P0001', hint = 'document_validation_failed';
  end if;
  basis := coalesce(claim -> 'basis', base #> '{partialClaim,basis}', private.document_claim_basis(candidate));
  claim := jsonb_set(claim, '{basis}', basis);
  if basis is distinct from private.document_claim_basis(candidate) then claim := jsonb_set(claim, '{confirmed}', 'false'::jsonb); end if;
  return jsonb_set(candidate, '{partialClaim}', claim);
end;
$$;
revoke all on function private.document_partial_claim_payload(jsonb, jsonb) from public, anon, authenticated, service_role;

-- Inherit the actual installed helper (including any earlier creation intent).
-- 017 subsequently delegates through this function rather than replacing it.
alter function private.document_manual_review_payload(jsonb, jsonb) rename to document_manual_review_payload_before_partial_claim;
create function private.document_manual_review_payload(base jsonb, candidate jsonb)
returns jsonb language sql immutable security definer set search_path = '' as $$
  select private.document_partial_claim_payload(base, private.document_manual_review_payload_before_partial_claim(base, candidate));
$$;
revoke all on function private.document_manual_review_payload(jsonb, jsonb) from public, anon, authenticated, service_role;

create function private.preserve_document_partial_claim()
returns trigger language plpgsql security definer set search_path = '' as $$
declare base jsonb;
begin
  select payload into base from public.extraction_version where document_id = new.document_id order by version desc limit 1;
  if new.author_user_id is null then
    new.payload := new.payload - 'partialClaim';
    if base ? 'partialClaim' then new.payload := jsonb_set(new.payload, '{partialClaim}', jsonb_set(base -> 'partialClaim', '{confirmed}', 'false'::jsonb)); end if;
  else
    new.payload := private.document_partial_claim_payload(coalesce(base, '{}'::jsonb), new.payload);
    if new.payload -> 'partialClaim' = 'null'::jsonb then new.payload := new.payload - 'partialClaim'; end if;
  end if;
  return new;
end;
$$;
revoke all on function private.preserve_document_partial_claim() from public, anon, authenticated, service_role;
create trigger extraction_version_partial_claim before insert on public.extraction_version
  for each row execute function private.preserve_document_partial_claim();

create function private.document_partial_claim_valid(candidate jsonb)
returns boolean language plpgsql immutable security definer set search_path = '' as $$
declare claim jsonb := candidate -> 'partialClaim'; selected jsonb; original jsonb; net numeric; vat numeric; full_net numeric; full_vat numeric; rate numeric;
begin
  if claim is null then return true; end if;
  if jsonb_typeof(claim) <> 'object' or claim -> 'confirmed' is distinct from 'true'::jsonb
    or claim -> 'basis' is distinct from private.document_claim_basis(candidate)
    or candidate ->> 'direction' <> 'incoming' or candidate ->> 'proposedVatRegime' <> 'domestic'
    or candidate ->> 'currency' <> 'CZK' or candidate ->> 'documentType' = 'credit_note'
    or jsonb_array_length(candidate -> 'rateBreakdown') <> 1 or jsonb_array_length(claim -> 'rateBreakdown') <> 1 then return false; end if;
  selected := claim #> '{rateBreakdown,0}'; original := candidate #> '{rateBreakdown,0}';
  if selected -> 'rate' is distinct from original -> 'rate' or selected ->> 'rate' not in ('21','12')
    or jsonb_typeof(selected -> 'netAmount') is distinct from 'string' or jsonb_typeof(selected -> 'vatAmount') is distinct from 'string'
    or selected ->> 'netAmount' !~ '^[0-9]+\.[0-9]{2}$' or selected ->> 'vatAmount' !~ '^[0-9]+\.[0-9]{2}$' then return false; end if;
  net := (selected ->> 'netAmount')::numeric; vat := (selected ->> 'vatAmount')::numeric;
  full_net := (original ->> 'netAmount')::numeric; full_vat := (original ->> 'vatAmount')::numeric; rate := (selected ->> 'rate')::numeric;
  return coalesce(net > 0 and vat >= 0 and net <= full_net and vat <= full_vat
    and abs(vat - round(net * rate / 100, 2)) <= 0.02
    and abs(full_vat - round(full_net * rate / 100, 2)) <= 0.02
    and abs((candidate #>> '{totals,netAmount}')::numeric - full_net) <= 0.02
    and abs((candidate #>> '{totals,vatAmount}')::numeric - full_vat) <= 0.02, false);
exception when others then return false;
end;
$$;
revoke all on function private.document_partial_claim_valid(jsonb) from public, anon, authenticated, service_role;

create function private.refuse_invalid_partial_claim_approval()
returns trigger language plpgsql security definer set search_path = '' as $$
declare candidate jsonb;
begin
  select payload into candidate from public.extraction_version where document_id = new.id order by version desc limit 1;
  if not private.document_partial_claim_valid(candidate) then
    raise exception 'resolve the Partial Claim before approval' using errcode = 'P0001', hint = 'document_validation_failed';
  end if;
  return new;
end;
$$;
revoke all on function private.refuse_invalid_partial_claim_approval() from public, anon, authenticated, service_role;
create trigger document_partial_claim_approval before update of status on public.document
  for each row when (new.status = 'approved') execute function private.refuse_invalid_partial_claim_approval();

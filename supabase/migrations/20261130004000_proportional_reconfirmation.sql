-- Preserve the original human percentage while binding new §75 decisions to
-- their Earliest Claim Period. An allowed assignment does not change that basis.
create or replace function private.document_proportional_payload(base jsonb, candidate jsonb)
returns jsonb language plpgsql immutable security definer set search_path = '' as $$
declare choice jsonb; basis jsonb; current_basis jsonb; previous_period jsonb;
begin
  if candidate -> 'proportionalDeduction' = 'null'::jsonb then return candidate; end if;
  choice := coalesce(candidate -> 'proportionalDeduction', base -> 'proportionalDeduction');
  if choice is null then return candidate; end if;
  if jsonb_typeof(choice) <> 'object' then
    raise exception 'invalid proportional deduction' using errcode = 'P0001', hint = 'document_validation_failed';
  end if;
  current_basis := private.document_claim_basis(candidate)
    || jsonb_build_object('earliestClaimPeriod', candidate #> '{claimEligibility,period}');
  basis := coalesce(choice -> 'basis', base #> '{proportionalDeduction,basis}', current_basis);
  -- Upgrade only the NEW Version's legacy basis, using the prior decision's
  -- period rather than silently rebinding an old choice to changed eligibility.
  if not (basis ? 'earliestClaimPeriod') then
    previous_period := case when base ? 'proportionalDeduction' then base #> '{claimEligibility,period}'
      else candidate #> '{claimEligibility,period}' end;
    basis := basis || jsonb_build_object('earliestClaimPeriod', previous_period);
  end if;
  choice := choice || jsonb_build_object('basis', basis);
  if basis is distinct from current_basis then choice := choice || '{"confirmed":false}'::jsonb; end if;
  return jsonb_set(candidate, '{proportionalDeduction}', choice);
end;
$$;
revoke all on function private.document_proportional_payload(jsonb, jsonb) from public, anon, authenticated, service_role;

-- Reuse the approved financial/foreign-conversion validator unchanged. Historical
-- Versions retain their old shape; every new manual insertion binds the period.
alter function private.document_proportional_deduction_valid(jsonb) rename to document_proportional_deduction_valid_before_reconfirmation;
create function private.document_proportional_deduction_valid(candidate jsonb)
returns boolean language plpgsql immutable security definer set search_path = '' as $$
declare basis jsonb := candidate #> '{proportionalDeduction,basis}';
begin
  if basis ? 'earliestClaimPeriod' then
    if basis -> 'earliestClaimPeriod' is distinct from coalesce(candidate #> '{claimEligibility,period}', 'null'::jsonb) then return false; end if;
    candidate := jsonb_set(candidate, '{proportionalDeduction,basis}', basis - 'earliestClaimPeriod');
  end if;
  return private.document_proportional_deduction_valid_before_reconfirmation(candidate);
end;
$$;
revoke all on function private.document_proportional_deduction_valid(jsonb) from public, anon, authenticated, service_role;

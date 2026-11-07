-- Keep the installed transition and its lock/audit invariants behind a narrow guard.
alter function public.update_document_reporting(uuid, text) rename to update_document_reporting_before_claim_eligibility;
revoke all on function public.update_document_reporting_before_claim_eligibility(uuid, text) from public, anon, authenticated, service_role;
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
  if new_claimed_reporting_period is not null and candidate ->> 'direction' = 'incoming'
    and not private.ordinary_domestic_claim(candidate) then
    raise exception 'shared deferral is not supported for this Document' using errcode = 'P0001', hint = 'deferred_claim_not_supported';
  end if;
  if candidate #>> '{claimEligibility,confirmed}' = 'true' and private.ordinary_domestic_claim(candidate) then
    refusal := private.document_eligibility_error(doc.company_id, doc.id, candidate, new_claimed_reporting_period);
    if refusal is not null then raise exception 'resolve the chosen claim period' using errcode = 'P0001', hint = refusal; end if;
  end if;
  perform public.update_document_reporting_before_claim_eligibility(target_document_id, new_claimed_reporting_period);
end;
$$;
revoke all on function public.update_document_reporting(uuid, text) from public, anon, service_role;
grant execute on function public.update_document_reporting(uuid, text) to authenticated;

-- Eligibility is human accounting metadata, independent of AI's proposal.
-- Extend the actual installed directory/Partial Claim delegates in place.
alter function private.document_review_data(jsonb) rename to document_review_data_before_eligibility;
create function private.document_review_data(candidate jsonb)
returns jsonb language sql immutable security definer set search_path = '' as $$
  select private.document_review_data_before_eligibility(candidate)
    || case when candidate ? 'claimEligibility' then jsonb_build_object('claimEligibility', candidate -> 'claimEligibility') else '{}'::jsonb end;
$$;
revoke all on function private.document_review_data(jsonb) from public, anon, authenticated, service_role;
alter function private.document_manual_review_payload(jsonb, jsonb) rename to document_manual_review_payload_before_eligibility;
create function private.document_manual_review_payload(base jsonb, candidate jsonb)
returns jsonb language sql immutable security definer set search_path = '' as $$
  select private.document_manual_review_payload_before_eligibility(base, candidate)
    || case when not (candidate ? 'claimEligibility') and base ? 'claimEligibility'
      then jsonb_build_object('claimEligibility', base -> 'claimEligibility') else '{}'::jsonb end;
$$;
revoke all on function private.document_manual_review_payload(jsonb, jsonb) from public, anon, authenticated, service_role;

create function private.ordinary_domestic_claim(candidate jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(candidate ->> 'direction' = 'incoming' and candidate ->> 'proposedVatRegime' = 'domestic'
    and candidate ->> 'documentType' in ('invoice', 'receipt', 'simplified_tax_document'), false);
$$;
revoke all on function private.ordinary_domestic_claim(jsonb) from public, anon, authenticated, service_role;

create function private.document_eligibility_basis(target_document_id uuid, candidate jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('documentType', candidate -> 'documentType', 'direction', candidate -> 'direction',
    'proposedVatRegime', candidate -> 'proposedVatRegime', 'taxPointDate', candidate -> 'taxPointDate', 'issueDate', candidate -> 'issueDate',
    'sourceFileId', d.source_file_id, 'importDate', (s.uploaded_at at time zone 'Europe/Prague')::date)
  from (select 1) seed left join public.document d on d.id = target_document_id
  left join public.source_file s on s.id = d.source_file_id;
$$;
revoke all on function private.document_eligibility_basis(uuid, jsonb) from public, anon, authenticated, service_role;

create function private.document_eligibility_payload(target_company_id uuid, target_document_id uuid, base jsonb, candidate jsonb, manual boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare claim jsonb; basis jsonb; tax_period text; issue_period text; import_period text;
begin
  basis := private.document_eligibility_basis(target_document_id, candidate);
  claim := case when manual then coalesce(candidate -> 'claimEligibility', base -> 'claimEligibility')
    else base -> 'claimEligibility' end;
  if jsonb_typeof(claim) = 'object' and claim ->> 'origin' = 'user' then
    claim := claim || jsonb_build_object('confirmed', manual and claim -> 'confirmed' = 'true'::jsonb
      and (not (claim ? 'basis') or claim -> 'basis' = basis));
    if claim -> 'confirmed' = 'true'::jsonb then claim := claim || jsonb_build_object('basis', basis); end if;
    return jsonb_set(candidate, '{claimEligibility}', claim);
  end if;
  candidate := candidate - 'claimEligibility';
  if not private.ordinary_domestic_claim(candidate) then return candidate; end if;
  begin
    tax_period := private.reporting_period_for_date(target_company_id, (candidate ->> 'taxPointDate')::date);
    issue_period := private.reporting_period_for_date(target_company_id, (candidate ->> 'issueDate')::date);
    import_period := private.reporting_period_for_date(target_company_id, (basis ->> 'importDate')::date);
  exception when datetime_field_overflow or invalid_datetime_format then return candidate;
  end;
  if tax_period is not null and tax_period = issue_period and tax_period = import_period then
    return jsonb_set(candidate, '{claimEligibility}', jsonb_build_object('period', tax_period,
      'origin', 'same_period', 'confirmed', true, 'basis', basis));
  end if;
  return candidate;
end;
$$;
revoke all on function private.document_eligibility_payload(uuid, uuid, jsonb, jsonb, boolean) from public, anon, authenticated, service_role;

create function private.bind_document_claim_eligibility()
returns trigger language plpgsql security definer set search_path = '' as $$
declare base jsonb;
begin
  select payload into base from public.extraction_version where document_id = new.document_id order by version desc limit 1;
  new.payload := private.document_eligibility_payload(new.company_id, new.document_id, base, new.payload, new.author_user_id is not null);
  return new;
end;
$$;
revoke all on function private.bind_document_claim_eligibility() from public, anon, authenticated, service_role;
create trigger extraction_version_claim_eligibility before insert on public.extraction_version
  for each row execute function private.bind_document_claim_eligibility();

create function private.document_eligibility_error(target_company_id uuid, target_document_id uuid, candidate jsonb, claimed_period text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare claim jsonb := candidate -> 'claimEligibility'; tax_period text; earliest_start date; chosen_start date;
begin
  if candidate ->> 'direction' = 'incoming' and claimed_period is not null and not private.ordinary_domestic_claim(candidate) then
    return 'deferred_claim_not_supported';
  end if;
  if not private.ordinary_domestic_claim(candidate) then return null; end if;
  if jsonb_typeof(claim) is distinct from 'object' or claim -> 'confirmed' is distinct from 'true'::jsonb
    or claim ->> 'origin' not in ('user', 'same_period')
    or claim -> 'basis' is distinct from private.document_eligibility_basis(target_document_id, candidate) then return 'claim_eligibility_required'; end if;
  tax_period := private.reporting_period_for_date(target_company_id, (candidate ->> 'taxPointDate')::date);
  earliest_start := private.reporting_period_start(claim ->> 'period');
  if tax_period is null or earliest_start is null or private.reporting_period_for_date(target_company_id, earliest_start) is distinct from claim ->> 'period'
    or earliest_start < private.reporting_period_start(tax_period) then return 'invalid_earliest_claim_period'; end if;
  if claim ->> 'origin' = 'same_period' and (claim ->> 'period' is distinct from tax_period
    or private.reporting_period_for_date(target_company_id, (candidate ->> 'issueDate')::date) is distinct from tax_period
    or private.reporting_period_for_date(target_company_id, (claim #>> '{basis,importDate}')::date) is distinct from tax_period) then return 'claim_eligibility_required'; end if;
  chosen_start := private.reporting_period_start(coalesce(claimed_period, tax_period));
  if chosen_start < earliest_start then return 'claimed_period_before_earliest'; end if;
  return null;
exception when datetime_field_overflow or invalid_datetime_format then return 'claim_eligibility_required';
end;
$$;
revoke all on function private.document_eligibility_error(uuid, uuid, jsonb, text) from public, anon, authenticated, service_role;
create function private.refuse_ineligible_claim_approval()
returns trigger language plpgsql security definer set search_path = '' as $$
declare candidate jsonb; refusal text;
begin
  select payload into candidate from public.extraction_version where document_id = new.id order by version desc limit 1;
  refusal := private.document_eligibility_error(new.company_id, new.id, candidate, new.claimed_reporting_period);
  if refusal is not null then raise exception 'resolve claim eligibility before approval' using errcode = 'P0001', hint = refusal; end if;
  return new;
end;
$$;
revoke all on function private.refuse_ineligible_claim_approval() from public, anon, authenticated, service_role;
create trigger zz_document_claim_approval before update of status on public.document
  for each row when (new.status = 'approved') execute function private.refuse_ineligible_claim_approval();

-- Consider BOTH the DUZP proposal and stored assignment: filtering by only
-- the latter would conceal legacy self-assessment from its output-tax period.
create function private.reporting_period_claim_issues(target_company_id uuid, target_period text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('documentId', d.id, 'code', issue.code) order by d.id), '[]'::jsonb)
  from public.vat_report_document d
  cross join lateral (select private.document_eligibility_error(d.company_id, d.id, d.payload, d.claimed_reporting_period) as code) issue
  where d.company_id = target_company_id and d.status <> 'rejected' and issue.code is not null
    and (d.status = 'approved' or issue.code = 'deferred_claim_not_supported')
    and (d.claimed_reporting_period = target_period
      or private.document_reporting_period(d.company_id, d.payload ->> 'direction', d.payload ->> 'taxPointDate', d.claimed_reporting_period) = target_period
      or (issue.code = 'deferred_claim_not_supported' and private.document_reporting_period(d.company_id, d.payload ->> 'direction', d.payload ->> 'taxPointDate', null) = target_period));
$$;
revoke all on function private.reporting_period_claim_issues(uuid, text) from public, anon, authenticated, service_role;
create function public.reporting_period_claim_issues(target_company_id uuid, target_period text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.company c where c.id = target_company_id and private.can_access_company(c.id, c.organization_id)) then raise insufficient_privilege; end if;
  return private.reporting_period_claim_issues(target_company_id, target_period);
end;
$$;
revoke all on function public.reporting_period_claim_issues(uuid, text) from public, anon, service_role;
grant execute on function public.reporting_period_claim_issues(uuid, text) to authenticated;

alter function public.save_vat_report(uuid, text, jsonb, jsonb) rename to save_vat_report_before_claim_eligibility;
revoke all on function public.save_vat_report_before_claim_eligibility(uuid, text, jsonb, jsonb) from public, anon, authenticated, service_role;
create function public.save_vat_report(target_company_id uuid, target_period text, expected_documents jsonb, computed_result jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.company c where c.id = target_company_id and private.can_access_company(c.id, c.organization_id) for update;
  if not found then raise insufficient_privilege; end if;
  perform id from public.source_file where company_id = target_company_id order by id for share;
  perform id from public.document where company_id = target_company_id order by id for share;
  if private.reporting_period_claim_issues(target_company_id, target_period) <> '[]'::jsonb then
    raise exception 'resolve Document claim eligibility before new preparation' using errcode = 'P0001', hint = 'claim_eligibility_unresolved';
  end if;
  return public.save_vat_report_before_claim_eligibility(target_company_id, target_period, expected_documents, computed_result);
end;
$$;
revoke all on function public.save_vat_report(uuid, text, jsonb, jsonb) from public, anon, service_role;
grant execute on function public.save_vat_report(uuid, text, jsonb, jsonb) to authenticated;

-- New currentness identities include actual source facts as well as provenance.
-- Historical saved report JSON and immutable Version payloads remain untouched.
alter function public.vat_report_documents(uuid, text) rename to vat_report_documents_before_claim_eligibility;
revoke all on function public.vat_report_documents_before_claim_eligibility(uuid, text) from public, anon, authenticated, service_role;
create function public.vat_report_documents(target_company_id uuid, target_period text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(item || jsonb_build_object('importDate', (s.uploaded_at at time zone 'Europe/Prague')::date, 'sourceFileId', d.source_file_id) order by item ->> 'id'), '[]'::jsonb)
  from public.vat_report_document v
  join public.document d on d.id = v.id
  left join public.source_file s on s.id = d.source_file_id
  cross join lateral (select jsonb_build_object('id', v.id, 'status', v.status, 'extractionVersionId', v.extraction_version_id,
    'payload', v.payload, 'claimedReportingPeriod', v.claimed_reporting_period) as item) data
  where v.company_id = target_company_id
    and private.document_reporting_period(v.company_id, v.payload ->> 'direction', v.payload ->> 'taxPointDate', v.claimed_reporting_period) = target_period;
$$;
revoke all on function public.vat_report_documents(uuid, text) from public, anon, service_role;
grant execute on function public.vat_report_documents(uuid, text) to authenticated;

alter function private.reporting_period_readiness_source(uuid, text) rename to reporting_period_readiness_source_before_claim_eligibility;
create function private.reporting_period_readiness_source(target_company_id uuid, target_period text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(item || jsonb_build_object('claimEligibility', v.payload -> 'claimEligibility',
    'importDate', (s.uploaded_at at time zone 'Europe/Prague')::date) order by item ->> 'documentId'), '[]'::jsonb)
  from jsonb_array_elements(private.reporting_period_readiness_source_before_claim_eligibility(target_company_id, target_period)) item
  join public.document d on d.id = (item ->> 'documentId')::uuid
  left join public.source_file s on s.id = d.source_file_id
  left join public.extraction_version v on v.id = (item ->> 'extractionVersionId')::uuid;
$$;
revoke all on function private.reporting_period_readiness_source(uuid, text) from public, anon, authenticated, service_role;

alter function public.finalize_vat_report(uuid, text, boolean) rename to finalize_vat_report_before_claim_eligibility;
revoke all on function public.finalize_vat_report_before_claim_eligibility(uuid, text, boolean) from public, anon, authenticated, service_role;
create function public.finalize_vat_report(target_company_id uuid, target_period text, finalization_confirmed boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.company c where c.id = target_company_id and private.can_access_company(c.id, c.organization_id) for update;
  if not found then raise insufficient_privilege; end if;
  perform id from public.source_file where company_id = target_company_id order by id for share;
  perform id from public.document where company_id = target_company_id order by id for update;
  if not private.is_reporting_period_locked(target_company_id, target_period)
    and private.reporting_period_claim_issues(target_company_id, target_period) <> '[]'::jsonb then
    raise exception 'resolve Document claim eligibility before finalization' using errcode = 'P0001', hint = 'readiness_blocked';
  end if;
  perform public.finalize_vat_report_before_claim_eligibility(target_company_id, target_period, finalization_confirmed);
end;
$$;
revoke all on function public.finalize_vat_report(uuid, text, boolean) from public, anon, service_role;
grant execute on function public.finalize_vat_report(uuid, text, boolean) to authenticated;

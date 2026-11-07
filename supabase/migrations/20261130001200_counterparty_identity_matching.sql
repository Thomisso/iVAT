-- Preserve explicit selection validation and immutable recorded directory data.
alter function private.document_counterparty_payload(uuid, uuid, jsonb)
  rename to document_counterparty_payload_explicit;
create function private.document_counterparty_payload(target_company_id uuid, target_document_id uuid, candidate jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare party jsonb; candidate_ico text; candidate_vat_id text; entry public.counterparty; matches integer;
begin
  -- JSON null is an explicit human unlink, unlike an absent automatic choice.
  if candidate -> 'counterpartyLink' = 'null'::jsonb then return candidate; end if;
  if candidate -> 'counterpartyLink' is not null and candidate -> 'counterpartyLink' <> 'null'::jsonb then
    return private.document_counterparty_payload_explicit(target_company_id, target_document_id, candidate);
  end if;
  party := candidate -> case candidate ->> 'direction' when 'incoming' then 'supplier' when 'outgoing' then 'customer' end;
  candidate_ico := nullif(private.counterparty_comparison(party ->> 'ico', 'ico'), '');
  candidate_vat_id := nullif(private.counterparty_comparison(party ->> 'vatId', 'vatId'), '');
  select count(*) into matches from public.counterparty c where c.company_id = target_company_id
    and ((candidate_ico is not null and c.ico = candidate_ico) or (candidate_vat_id is not null and c.vat_id = candidate_vat_id));
  if matches = 1 then
    select * into entry from public.counterparty c where c.company_id = target_company_id
      and ((candidate_ico is not null and c.ico = candidate_ico) or (candidate_vat_id is not null and c.vat_id = candidate_vat_id));
    if entry.archived_at is null and (candidate_ico is null or entry.ico is null or candidate_ico = entry.ico)
      and (candidate_vat_id is null or entry.vat_id is null or candidate_vat_id = entry.vat_id) then
      candidate := jsonb_set(candidate, '{counterpartyLink}', jsonb_build_object('id', entry.id));
    end if;
  end if;
  return private.document_counterparty_payload_explicit(target_company_id, target_document_id, candidate);
end;
$$;
revoke all on function private.document_counterparty_payload(uuid, uuid, jsonb), private.document_counterparty_payload_explicit(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

-- Creation belongs after warning acknowledgement inside the approval transaction.
-- The Company lock serializes identity races; a later approval refusal rolls
-- this insert, its audit and the new linked Version back together.
create function private.document_counterparty_for_approval(target_company_id uuid, target_document_id uuid, candidate jsonb, creation_consent jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare party jsonb; candidate_ico text; candidate_vat_id text; created_id uuid;
begin
  if coalesce(candidate ->> 'direction', '') not in ('incoming', 'outgoing') then
    raise exception 'Direction must be set before approval' using errcode = 'P0001', hint = 'direction_required';
  end if;
  candidate := private.document_counterparty_payload(target_company_id, target_document_id, candidate);
  if candidate #>> '{counterpartyLink,id}' is not null then return candidate; end if;
  party := candidate -> case candidate ->> 'direction' when 'incoming' then 'supplier' when 'outgoing' then 'customer' end;
  candidate_ico := nullif(private.counterparty_comparison(party ->> 'ico', 'ico'), '');
  candidate_vat_id := nullif(private.counterparty_comparison(party ->> 'vatId', 'vatId'), '');
  if (creation_consent is not null and (creation_consent -> 'party' is distinct from party
      or creation_consent ->> 'direction' is distinct from candidate ->> 'direction'))
    or (candidate_ico is null and candidate_vat_id is null and creation_consent is null) then
    raise exception 'confirm the exact Counterparty without identifiers' using errcode = 'P0001', hint = 'counterparty_resolution_required';
  end if;
  if nullif(btrim(party ->> 'name'), '') is null or length(btrim(party ->> 'name')) > 255 then
    raise exception 'Counterparty name is required' using errcode = 'P0001', hint = 'document_incomplete';
  end if;
  if (candidate_ico is not null and candidate_ico !~ '^[0-9]{8}$')
    or (candidate_vat_id is not null and candidate_vat_id !~ '^[A-Z]{2}[A-Z0-9]{2,14}$') then
    raise exception 'resolve invalid identifiers' using errcode = 'P0001', hint = 'document_validation_failed';
  end if;
  if exists (select 1 from public.counterparty c where c.company_id = target_company_id
    and ((candidate_ico is not null and c.ico = candidate_ico) or (candidate_vat_id is not null and c.vat_id = candidate_vat_id))) then
    raise exception 'choose or restore the Counterparty explicitly' using errcode = 'P0001', hint = 'counterparty_resolution_required';
  end if;
  insert into public.counterparty(company_id, name, ico, vat_id, street, city, postal_code, country_code, supplier, customer)
  values(target_company_id, party ->> 'name', candidate_ico, candidate_vat_id,
    coalesce(party ->> 'street', ''), coalesce(party ->> 'city', ''), coalesce(party ->> 'postalCode', ''), coalesce(party ->> 'country', ''),
    candidate ->> 'direction' = 'incoming', candidate ->> 'direction' = 'outgoing') returning id into created_id;
  return private.document_counterparty_payload_explicit(target_company_id, target_document_id,
    jsonb_set(candidate, '{counterpartyLink}', jsonb_build_object('id', created_id)));
end;
$$;
revoke all on function private.document_counterparty_for_approval(uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;

-- Exact installed atomic transition, extended only at its post-ack commit point.
CREATE OR REPLACE FUNCTION public.save_and_approve_document(target_document_id uuid, based_on_version integer, request_id uuid, payload jsonb, findings jsonb, submitted_payload jsonb, expected_context jsonb, acknowledgement uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  approved_version integer;
  doc public.document;
  current_payload jsonb;
  current_version integer;
  current_context jsonb;
  warning_findings jsonb;
  confirmation_id uuid;
begin
  select * into doc from public.document where id = target_document_id;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then raise insufficient_privilege; end if;
  perform 1 from public.company where id = doc.company_id for update;
  select * into doc from public.document where id = target_document_id for update;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) or doc.superseded_at is not null then raise insufficient_privilege; end if;
  if request_id is null or jsonb_typeof(payload) is distinct from 'object' or jsonb_typeof(submitted_payload) is distinct from 'object'
    or jsonb_typeof(findings) is distinct from 'array' then
    raise exception 'invalid review request' using errcode = 'P0001', hint = 'stale_version';
  end if;
  approved_version := public.document_approval_result(target_document_id, request_id, submitted_payload, based_on_version);
  if approved_version is not null then return jsonb_build_object('version', approved_version); end if;
  select v.version, v.payload into current_version, current_payload from public.extraction_version v
    where v.document_id = doc.id order by v.version desc limit 1;
  if coalesce(current_version, 0) is distinct from based_on_version then
    raise exception 'the Document has a newer Extraction Version' using errcode = 'P0001', hint = 'stale_version';
  end if;
  if doc.status <> 'needs_review' then
    raise exception 'only a Document in review can be approved' using errcode = 'P0001', hint = 'not_in_review';
  end if;
  payload := private.document_manual_review_payload(current_payload, payload);
  payload := private.document_counterparty_payload(doc.company_id, doc.id, payload);
  findings := coalesce((select jsonb_agg(f) from jsonb_array_elements(findings) f
    where f ->> 'code' <> 'counterparty_directory_difference'), '[]'::jsonb) || private.document_counterparty_findings(payload);
  if private.is_reporting_period_locked(doc.company_id, private.document_current_reporting_period(doc.id))
    or private.is_reporting_period_locked(doc.company_id, private.document_reporting_period_for(doc, payload)) then
    raise exception 'the Reporting Period is locked' using errcode = 'P0001', hint = 'period_locked';
  end if;
  current_context := private.document_review_context(doc.id);
  if current_context is distinct from expected_context then
    raise exception 'review inputs changed during preparation' using errcode = 'P0001', hint = 'review_context_changed';
  end if;
  if exists (select 1 from jsonb_array_elements(findings) f where f ->> 'severity' = 'error') then
    raise exception 'Document validation errors must be resolved' using errcode = 'P0001', hint = case
      when coalesce(payload ->> 'direction', '') not in ('incoming', 'outgoing') then 'direction_required'
      when nullif(payload ->> 'proposedVatRegime', '') is null then 'vat_regime_required'
      when private.missing_required_reporting_vat_id(payload) then 'counterparty_vat_id_required'
      else 'document_validation_failed' end;
  end if;
  select coalesce(jsonb_agg(f order by f::text), '[]'::jsonb) into warning_findings from jsonb_array_elements(findings) f where f ->> 'severity' = 'warning';
  if warning_findings <> '[]'::jsonb
    and not exists (select 1 from public.document_review_confirmation c where c.id = acknowledgement and c.document_id = doc.id
      and c.actor_user_id = auth.uid() and c.payload = save_and_approve_document.payload and c.findings = save_and_approve_document.findings and c.context = current_context) then
    insert into public.document_review_confirmation(document_id, organization_id, company_id, actor_user_id, payload, findings, context)
      values(doc.id, doc.organization_id, doc.company_id, auth.uid(), payload, findings, current_context) returning id into confirmation_id;
    -- The application may acknowledge an unchanged visible warning list only
    -- after reading the actual current Bank Account Check projection. The same
    -- expected_context is checked again if it immediately confirms this receipt.
    return jsonb_build_object('confirmationId', confirmation_id, 'findings', findings,
      'unchanged', (private.document_review_data(current_payload) - 'counterpartyLink') = (private.document_review_data(payload) - 'counterpartyLink')
        and (current_payload #>> '{counterpartyLink,id}') is not distinct from (payload #>> '{counterpartyLink,id}'));
  end if;
  payload := private.document_counterparty_for_approval(doc.company_id, doc.id, payload, submitted_payload -> 'counterpartyCreationConsent');
  -- Confidence is AI metadata; schemaVersion describes draft compatibility.
  if private.document_review_data(current_payload) = private.document_review_data(payload) then
    approved_version := current_version;
  else
    approved_version := public.correct_document(target_document_id, based_on_version, payload, findings);
  end if;
  -- Existing triggers enforce accounting invariants even when callers forge findings.
  perform public.approve_document(target_document_id, approved_version);
  insert into public.document_approval_receipt(document_id, request_id, organization_id, company_id, actor_user_id, submitted_payload, based_on_version, operation_kind, version)
    values (doc.id, request_id, doc.organization_id, doc.company_id, auth.uid(), submitted_payload, based_on_version, 'approval', approved_version);
  return jsonb_build_object('version', approved_version);
end;
$function$;

revoke all on function public.save_and_approve_document(uuid, integer, uuid, jsonb, jsonb, jsonb, jsonb, uuid) from public, anon, service_role;
grant execute on function public.save_and_approve_document(uuid, integer, uuid, jsonb, jsonb, jsonb, jsonb, uuid) to authenticated;

-- Legacy approval retains its public API, while the recorded transition stays
-- private. Both paths resolve identity under Company -> Document serialization
-- and reach the same status triggers, including later claim eligibility guards.
alter function public.approve_document(uuid, integer) rename to approve_document_recorded;
alter function public.approve_document_recorded(uuid, integer) set schema private;
revoke all on function private.approve_document_recorded(uuid, integer) from public, anon, authenticated, service_role;
create function public.approve_document(target_document_id uuid, reviewed_version integer)
returns void language plpgsql security definer set search_path = '' as $$
declare doc public.document; current_version public.extraction_version; prepared jsonb; final_version integer; findings jsonb;
begin
  select * into doc from public.document where id = target_document_id;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then raise insufficient_privilege; end if;
  perform 1 from public.company where id = doc.company_id for update;
  select * into doc from public.document where id = target_document_id for update;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) or doc.superseded_at is not null then raise insufficient_privilege; end if;
  if doc.status <> 'needs_review' then raise exception 'only a Document in review can be approved' using errcode = 'P0001', hint = 'not_in_review'; end if;
  select * into current_version from public.extraction_version where document_id = doc.id order by version desc limit 1;
  if current_version.version is distinct from reviewed_version then raise exception 'the Document has a newer Extraction Version' using errcode = 'P0001', hint = 'stale_version'; end if;
  prepared := private.document_counterparty_payload(doc.company_id, doc.id, current_version.payload);
  -- This API has no new-warning acknowledgement. Fresh material differences
  -- require the combined review command; unchanged recorded warnings stay visible.
  if private.document_counterparty_findings(prepared) is distinct from private.document_counterparty_findings(current_version.payload) then
    raise exception 'review changed directory details before approval' using errcode = 'P0001', hint = 'counterparty_resolution_required';
  end if;
  prepared := private.document_counterparty_for_approval(doc.company_id, doc.id, prepared, null);
  final_version := current_version.version;
  if private.document_review_data(prepared) is distinct from private.document_review_data(current_version.payload) then
    findings := coalesce((select jsonb_agg(f) from jsonb_array_elements(current_version.findings) f
      where f ->> 'code' <> 'counterparty_directory_difference'), '[]'::jsonb) || private.document_counterparty_findings(prepared);
    final_version := public.correct_document(doc.id, current_version.version, prepared, findings);
  end if;
  perform private.approve_document_recorded(doc.id, final_version);
end;
$$;
revoke all on function public.approve_document(uuid, integer) from public, anon, service_role;
grant execute on function public.approve_document(uuid, integer) to authenticated;

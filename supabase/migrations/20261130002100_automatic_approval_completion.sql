-- Only the service-only, generation/reservation-bound completion can insert a system directory identity.
-- Counterparty table DML and private helper EXECUTE remain revoked from service_role.
create or replace function private.prepare_counterparty()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  target public.company;
begin
  -- Serialize every directory write with Company deletion before changing data.
  -- Inspect the locked row: an earlier statement snapshot may still show it active.
  select * into target from public.company where id = new.company_id for update;
  if not found or target.deleted_at is not null
    or (private.can_access_company(target.id, target.organization_id)
      or (auth.role() = 'service_role' and auth.uid() is null)) is not true
  then
    raise insufficient_privilege;
  end if;
  if tg_op = 'INSERT' then
    new.organization_id := target.organization_id;
  end if;
  new.name := btrim(new.name);
  new.ico := nullif(regexp_replace(new.ico, '[[:space:]]', '', 'g'), '');
  new.vat_id := nullif(upper(regexp_replace(new.vat_id, '[[:space:]]', '', 'g')), '');
  new.street := btrim(new.street);
  new.city := btrim(new.city);
  new.postal_code := btrim(new.postal_code);
  new.country_code := upper(btrim(new.country_code));
  return new;
end;
$$;


-- Applicability follows the existing shared ADIS policy; foreign supplier checks are not fabricated.
-- Rules assessment is bound to the accepted raw payload and canonical accounting fields.
create function public.record_ai_extraction_with_approval(
  target_document_id uuid, target_extraction_request_id uuid, target_reservation_id uuid,
  provider text, model text, payload jsonb, findings jsonb,
  expected_company_revision bigint, assessment jsonb
)
returns void language plpgsql security definer set search_path = '' as $$
declare doc public.document; company public.company; recorded public.extraction_version; candidate jsonb; phase text;
begin
  if auth.role() is distinct from 'service_role' or auth.uid() is not null then raise insufficient_privilege; end if;
  select * into doc from public.document where id = target_document_id;
  if not found then raise no_data_found; end if;
  select * into company from public.company where id = doc.company_id for update;
  select * into doc from public.document where id = target_document_id for update;
  if doc.extraction_request_id <> target_extraction_request_id or doc.superseded_at is not null
    or doc.status not in ('uploaded','processing','waiting_for_allowance','waiting_for_platform')
    or exists(select 1 from public.extraction_version v where v.document_id = doc.id and v.extraction_request_id = target_extraction_request_id) then
    -- Preserve the original recorder's bounded reservation cleanup on no-op.
    delete from public.ai_processing_reservation where id = target_reservation_id and document_id = doc.id
      and extraction_request_id = target_extraction_request_id;
    return;
  end if;
  if not exists(select 1 from public.ai_processing_reservation r where r.id = target_reservation_id
    and r.document_id = doc.id and r.extraction_request_id = target_extraction_request_id) then
    raise exception 'AI Processing Allowance reservation is missing';
  end if;
  if not company.automatic_approval_enabled or company.deleted_at is not null
    or company.data_revision is distinct from expected_company_revision
    or assessment -> 'supportedMapping' is distinct from 'true'::jsonb
    or not coalesce(assessment ->> 'registryVerification' in ('checked', 'not_applicable'), false)
    or (assessment ->> 'registryVerification' = 'not_applicable' and coalesce(payload #>> '{supplier,vatId}', '') ~ '^CZ[0-9]{8,10}$')
    or assessment -> 'payload' is distinct from payload
    or findings <> '[]'::jsonb then
    perform public.record_ai_extraction(target_document_id, target_extraction_request_id, target_reservation_id, provider, model, payload, findings);
    return;
  end if;
  begin
    phase := 'identity';
    candidate := private.document_counterparty_for_approval(company.id, doc.id, payload, null);
    phase := 'recording';
    perform public.record_ai_extraction(target_document_id, target_extraction_request_id, target_reservation_id, provider, model, candidate, findings);
    select * into strict recorded from public.extraction_version v where v.document_id = doc.id and v.extraction_request_id = target_extraction_request_id;
    phase := 'approval';
    if (recorded.payload - array['counterpartyLink','partialClaim','claimEligibility','sourceEvidence','sourceRateRows'])
      is distinct from (payload - array['counterpartyLink','partialClaim','claimEligibility','sourceEvidence','sourceRateRows'])
      or recorded.findings <> '[]'::jsonb or recorded.counterparty_id is null
      or not exists(select 1 from public.counterparty c where c.id = recorded.counterparty_id and c.company_id = company.id and c.archived_at is null)
    or (recorded.payload ? 'partialClaim' and recorded.payload #>> '{partialClaim,confirmed}' is distinct from 'true')
    or private.document_eligibility_error(company.id, doc.id, recorded.payload, doc.claimed_reporting_period) is not null
    or private.document_reporting_period_for(doc, recorded.payload) is null
    or private.is_reporting_period_locked(company.id, private.document_reporting_period_for(doc, recorded.payload))
    or exists (
      select 1 from public.document other
      left join public.source_file source on source.id = other.source_file_id
      left join public.source_file current_source on current_source.id = doc.source_file_id
      left join lateral (select v.payload from public.extraction_version v where v.document_id = other.id order by version desc limit 1) latest on true
      where other.company_id = company.id and other.id <> doc.id and other.superseded_at is null
      and ((other.source_file_id <> doc.source_file_id and source.sha256 = current_source.sha256)
        or (nullif(btrim(recorded.payload ->> 'documentNumber'), '') is not null
          and lower(btrim(recorded.payload ->> 'documentNumber')) = lower(btrim(latest.payload ->> 'documentNumber'))
          and recorded.payload ->> 'direction' = latest.payload ->> 'direction'
          and nullif(regexp_replace(upper(recorded.payload #>> case recorded.payload ->> 'direction' when 'incoming' then '{supplier,vatId}'::text[] else '{customer,vatId}'::text[] end), '\s+', '', 'g'), '')
            = regexp_replace(upper(latest.payload #>> case latest.payload ->> 'direction' when 'incoming' then '{supplier,vatId}'::text[] else '{customer,vatId}'::text[] end), '\s+', '', 'g')))
    ) then
      raise exception 'automatic approval needs human review' using errcode = 'P2410';
    end if;
    update public.document set status = 'approved' where id = doc.id;
    perform private.record_audit_event('document.automatically_approved', doc.organization_id, doc.company_id,
      'document', doc.id, jsonb_build_object('version', recorded.version, 'extractionVersionId', recorded.id,
        'extractionRequestId', target_extraction_request_id), null);
    return;
  exception when sqlstate 'P2410' or sqlstate 'P0001' or check_violation or insufficient_privilege or unique_violation then
    -- Never convert an actual failed Version insert into successful Extraction.
    if phase = 'recording' then raise; end if;
  end;
  -- The speculative link/creation/Version/approval were rolled back together.
  -- Record the original successful provider result once, outside that branch.
  perform public.record_ai_extraction(target_document_id, target_extraction_request_id, target_reservation_id, provider, model, payload, findings);
end;
$$;

revoke all on function public.record_ai_extraction_with_approval(uuid, uuid, uuid, text, text, jsonb, jsonb, bigint, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.record_ai_extraction_with_approval(uuid, uuid, uuid, text, text, jsonb, jsonb, bigint, jsonb) to service_role;

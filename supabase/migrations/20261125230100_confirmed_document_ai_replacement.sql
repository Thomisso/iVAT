-- Existing Extraction dispatch, with explicit consent before replacing human
-- work. Company-first locks serialize allowance, approval and worker receipts.
drop function public.reprocess_document(uuid);
create function public.reprocess_document(target_document_id uuid, replacement_confirmed boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare doc public.document; company public.company; batch_id uuid; human_work boolean; request_id uuid := gen_random_uuid(); period text;
begin
  select * into doc from public.document where id = target_document_id;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then raise insufficient_privilege; end if;
  select * into company from public.company where id = doc.company_id for update;
  select * into doc from public.document where id = target_document_id for update;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then raise insufficient_privilege; end if;
  if doc.superseded_at is not null or doc.source_file_id is null or doc.status not in ('failed', 'needs_review', 'approved') then
    raise exception 'Document cannot be reprocessed' using errcode = 'P0001', hint = 'not_reprocessable';
  end if;
  period := private.document_current_reporting_period(doc.id);
  if period is not null and private.is_reporting_period_locked(doc.company_id, period) then
    raise exception 'the Reporting Period is locked' using errcode = 'P0001', hint = 'period_locked';
  end if;
  select coalesce((select author_user_id is not null from public.extraction_version where document_id = doc.id order by version desc limit 1), false)
    or doc.status = 'approved' into human_work;
  if human_work then
    if replacement_confirmed is distinct from true then
      raise exception 'replacement requires confirmation' using errcode = 'P0001', hint = 'confirmation_required';
    end if;
    if not company.ai_processing_enabled or not exists (
      select 1 from public.company_ai_configuration assignment
      join public.ai_configuration configuration on configuration.id = assignment.configuration_id
      join vault.decrypted_secrets secret on secret.id = configuration.credential_secret_id
      where assignment.company_id = doc.company_id and nullif(secret.decrypted_secret, '') is not null
    ) then
      raise exception 'AI is not configured' using errcode = 'P0001', hint = 'ai_configuration_unavailable';
    end if;
    if company.ai_processing_allowance is not null and private.company_ai_processing_used(doc.company_id)
      + (select count(*) from public.ai_processing_reservation where company_id = doc.company_id and created_at >= now() - interval '5 minutes')
      + (select count(*) from public.document pending
        where pending.company_id = doc.company_id and pending.id <> doc.id and pending.superseded_at is null
          and pending.status in ('uploaded', 'processing', 'waiting_for_allowance')
          and not exists (select 1 from public.extraction_version version where version.document_id = pending.id and version.extraction_request_id = pending.extraction_request_id)
          and not exists (select 1 from public.ai_processing_reservation reservation where reservation.document_id = pending.id and reservation.created_at >= now() - interval '5 minutes'))
      >= company.ai_processing_allowance then
      raise exception 'no successful AI allowance remains' using errcode = 'P0001', hint = 'allowance_exhausted';
    end if;
  end if;
  select sf.upload_batch_id into batch_id from public.source_file sf where sf.id = doc.source_file_id;
  update public.upload_batch set processing_finished_at = null where id = batch_id;
  update public.notification set read_at = coalesce(read_at, now())
    where kind = 'upload_batch_finished' and payload ->> 'batchId' = batch_id::text;
  delete from public.ai_processing_reservation where document_id = doc.id;
  update public.document set status = 'uploaded', extraction_request_id = request_id where id = doc.id;
  perform private.record_audit_event('document.ai_requested', doc.organization_id, doc.company_id, 'document', doc.id,
    jsonb_build_object('extraction_request_id', request_id, 'replaced_human_work', human_work, 'approval_withdrawn', doc.status = 'approved'));
  return request_id;
end;
$$;
revoke all on function public.reprocess_document(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.reprocess_document(uuid, boolean) to authenticated;

-- Compensation can invalidate only the dispatched request, never a completed
-- AI Version or a newer human/worker generation. Approval stays withdrawn.
create function public.cancel_document_reprocess_dispatch(target_document_id uuid, target_extraction_request_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare doc public.document;
begin
  select * into doc from public.document where id = target_document_id;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then raise insufficient_privilege; end if;
  perform 1 from public.company where id = doc.company_id for update;
  select * into doc from public.document where id = target_document_id for update;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then raise insufficient_privilege; end if;
  if exists (select 1 from public.extraction_version where document_id = doc.id and extraction_request_id = target_extraction_request_id) then return 'completed'; end if;
  if doc.extraction_request_id <> target_extraction_request_id or doc.status not in ('uploaded', 'processing', 'waiting_for_allowance', 'waiting_for_platform', 'failed') then return 'superseded'; end if;
  delete from public.ai_processing_reservation where document_id = doc.id and extraction_request_id = target_extraction_request_id;
  update public.document set status = 'needs_review', extraction_request_id = gen_random_uuid() where id = doc.id;
  return 'cancelled';
end;
$$;
revoke all on function public.cancel_document_reprocess_dispatch(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.cancel_document_reprocess_dispatch(uuid, uuid) to authenticated;

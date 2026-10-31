-- Stale failures must carry the same request identity as stale successes.
drop function public.record_ai_processing_issue(public.ai_processing_target_kind, uuid, public.ai_processing_issue_classification, public.ai_processing_issue_state, uuid, text);
create function public.record_ai_processing_issue(
  target_kind public.ai_processing_target_kind,
  target_id uuid,
  target_classification public.ai_processing_issue_classification,
  target_state public.ai_processing_issue_state,
  target_configuration_id uuid default null,
  target_provider text default null,
  target_extraction_request_id uuid default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target_organization_id uuid;
  target_company_id uuid;
  changed_rows bigint;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if target_kind = 'source_file' then
    select organization_id, company_id into target_organization_id, target_company_id
    from public.source_file where id = target_id;
    if not found then return; end if;
    perform 1 from public.company where id = target_company_id for update;
    update public.source_file
    set status = case target_state
      when 'waiting_for_platform' then 'waiting_for_platform'::public.source_file_status
      else 'failed'::public.source_file_status
    end
    where id = target_id
      and status in (
        'uploaded',
        'processing',
        case target_state
          when 'waiting_for_platform' then 'waiting_for_platform'::public.source_file_status
          else 'failed'::public.source_file_status
        end
      );
  else
    select organization_id, company_id into target_organization_id, target_company_id
    from public.document where id = target_id;
    if not found then return; end if;
    perform 1 from public.company where id = target_company_id for update;
    update public.document
    set status = case target_state
      when 'waiting_for_platform' then 'waiting_for_platform'::public.document_status
      else 'failed'::public.document_status
    end
    where id = target_id
      and extraction_request_id = target_extraction_request_id
      and superseded_at is null
      and status in (
        'uploaded',
        'waiting_for_allowance',
        'processing',
        case target_state
          when 'waiting_for_platform' then 'waiting_for_platform'::public.document_status
          else 'failed'::public.document_status
        end
      );
  end if;

  get diagnostics changed_rows = row_count;
  if changed_rows = 0 then return; end if;
  insert into public.ai_processing_issue (
    target_kind, target_id, organization_id, company_id, configuration_id,
    provider, classification, state
  ) values (
    target_kind, target_id, target_organization_id, target_company_id,
    target_configuration_id, target_provider, target_classification, target_state
  )
  on conflict on constraint ai_processing_issue_pkey do update
  set configuration_id = excluded.configuration_id,
      provider = excluded.provider,
      classification = excluded.classification,
      state = excluded.state,
      updated_at = now()
  where ai_processing_issue.state = excluded.state;
end;
$$;

revoke all on function public.record_ai_processing_issue(public.ai_processing_target_kind, uuid, public.ai_processing_issue_classification, public.ai_processing_issue_state, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.record_ai_processing_issue(public.ai_processing_target_kind, uuid, public.ai_processing_issue_classification, public.ai_processing_issue_state, uuid, text, uuid) to service_role;

create or replace function public.reprocess_document(target_document_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  doc public.document;
  batch_id uuid;
begin
  select * into doc from public.document where id = target_document_id;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform 1 from public.company where id = doc.company_id for update;
  select * into doc from public.document where id = target_document_id for update;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if doc.superseded_at is not null or doc.source_file_id is null or doc.status not in ('failed', 'needs_review') then
    raise exception 'the Document is still being processed' using errcode = 'P0001', hint = 'not_reprocessable';
  end if;
  select sf.upload_batch_id into batch_id from public.source_file sf where sf.id = doc.source_file_id;
  update public.upload_batch set processing_finished_at = null where id = batch_id;
  update public.notification
  set read_at = coalesce(read_at, now())
  where kind = 'upload_batch_finished' and payload ->> 'batchId' = batch_id::text;
  delete from public.ai_processing_reservation where document_id = doc.id;
  update public.document
  set status = 'uploaded', extraction_request_id = gen_random_uuid()
  where id = doc.id;
end;
$$;

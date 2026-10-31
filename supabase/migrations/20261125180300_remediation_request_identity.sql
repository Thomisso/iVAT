-- Dispatch compensation belongs only to the request it resumed. Human recovery
-- and later retries must survive a lost broker acknowledgement.
drop function public.resume_platform_ai_processing(uuid, uuid);
create function public.resume_platform_ai_processing(
  target_company_id uuid default null,
  target_configuration_id uuid default null
)
returns table (
  target_kind public.ai_processing_target_kind,
  target_id uuid,
  classification public.ai_processing_issue_classification,
  configuration_id uuid,
  provider text,
  first_detected_at timestamptz,
  extraction_request_id uuid
)
language plpgsql security definer set search_path = ''
as $$
declare
  resumed_count bigint;
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if target_company_id is null and target_configuration_id is null then
    raise exception 'recovery target required' using errcode = '42501';
  end if;

  -- Serialize each Company's reservations and human decisions before issue rows.
  perform 1 from public.company company
  where company.id in (
    select issue.company_id from public.ai_processing_issue issue
    where issue.state = 'waiting_for_platform'
      and (target_company_id is null or issue.company_id = target_company_id)
      and (target_configuration_id is null or issue.configuration_id = target_configuration_id)
  ) order by company.id for update;

  return query
    with selected as (
      select issue.target_kind, issue.target_id, issue.classification,
        issue.configuration_id, issue.provider, issue.first_detected_at
      from public.ai_processing_issue issue
      where issue.state = 'waiting_for_platform'
        and (target_company_id is null or issue.company_id = target_company_id)
        and (target_configuration_id is null or issue.configuration_id = target_configuration_id)
      for update
    ), reset_sources as (
      update public.source_file source
      set status = 'uploaded'
      from selected
      where selected.target_kind = 'source_file'
        and source.id = selected.target_id
        and source.status = 'waiting_for_platform'
      returning selected.target_kind, selected.target_id, selected.classification,
        selected.configuration_id, selected.provider, selected.first_detected_at, null::uuid as extraction_request_id
    ), released_reservations as (
      delete from public.ai_processing_reservation reservation using selected
      where selected.target_kind = 'document' and reservation.document_id = selected.target_id
    ), reset_documents as (
      update public.document document
      set status = 'uploaded', extraction_request_id = gen_random_uuid()
      from selected
      where selected.target_kind = 'document'
        and document.id = selected.target_id
        and document.status = 'waiting_for_platform'
      returning selected.target_kind, selected.target_id, selected.classification,
        selected.configuration_id, selected.provider, selected.first_detected_at, document.extraction_request_id
    ), recovered as (
      select * from reset_sources
      union all
      select * from reset_documents
    ), removed as (
      delete from public.ai_processing_issue issue
      using recovered
      where issue.target_kind = recovered.target_kind and issue.target_id = recovered.target_id
    )
    select recovered.target_kind, recovered.target_id, recovered.classification,
      recovered.configuration_id, recovered.provider, recovered.first_detected_at, recovered.extraction_request_id
    from recovered
    order by recovered.first_detected_at, recovered.target_kind, recovered.target_id;

  get diagnostics resumed_count = row_count;
  perform private.record_audit_event(
    'ai_processing.remediation_requested',
    null,
    null,
    case when target_configuration_id is not null then 'ai_configuration' else 'company' end,
    coalesce(target_configuration_id, target_company_id),
    jsonb_build_object(
      'company_id', target_company_id,
      'configuration_id', target_configuration_id,
      'resumed_count', resumed_count
    )
  );
end;
$$;

create or replace function public.restore_platform_ai_processing_wait(target_work jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  work record;
  target_organization_id uuid;
  target_company_id uuid;
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(target_work) <> 'array' then
    raise exception 'invalid recovery work' using errcode = '22023';
  end if;

  for work in
    select *
    from jsonb_to_recordset(target_work) as item(
      target_kind public.ai_processing_target_kind,
      target_id uuid,
      classification public.ai_processing_issue_classification,
      configuration_id uuid,
      provider text,
      first_detected_at timestamptz,
      extraction_request_id uuid
    )
  loop
    target_organization_id := null;
    target_company_id := null;
    if work.target_kind = 'document' then
      perform 1 from public.company company where company.id = (
        select document.company_id from public.document document where document.id = work.target_id
      ) for update;
    end if;
    if work.target_kind = 'source_file' then
      update public.source_file source
      set status = 'waiting_for_platform'
      where source.id = work.target_id and source.status = 'uploaded'
      returning source.organization_id, source.company_id
      into target_organization_id, target_company_id;
    else
      update public.document document
      set status = 'waiting_for_platform'
      where document.id = work.target_id
        and document.status = 'uploaded'
        and document.extraction_request_id = work.extraction_request_id
        and document.superseded_at is null
      returning document.organization_id, document.company_id
      into target_organization_id, target_company_id;
    end if;

    if target_organization_id is not null then
      insert into public.ai_processing_issue (
        target_kind, target_id, organization_id, company_id, configuration_id,
        provider, classification, state, first_detected_at
      ) values (
        work.target_kind, work.target_id, target_organization_id, target_company_id,
        work.configuration_id, work.provider, work.classification, 'waiting_for_platform',
        work.first_detected_at
      )
      on conflict on constraint ai_processing_issue_pkey do update
      set configuration_id = excluded.configuration_id,
          provider = excluded.provider,
          classification = excluded.classification,
          first_detected_at = excluded.first_detected_at,
          updated_at = now()
      where ai_processing_issue.state = 'waiting_for_platform';
    end if;
  end loop;
end;
$$;

revoke all on function public.resume_platform_ai_processing(uuid, uuid) from public, anon, service_role;
grant execute on function public.resume_platform_ai_processing(uuid, uuid) to authenticated;

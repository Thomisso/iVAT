-- A real insertion creates a new cycle; repeated Finalization keeps the active one.
alter table public.period_lock add column id uuid not null default gen_random_uuid() unique;

-- These retained references deliberately do not point at the deletable live lock row.
-- Legacy final artifacts have no provable cycle and remain ineligible for progress.
alter table public.vat_report_artifact add column period_lock_id uuid,
  add constraint draft_artifact_without_lock check (kind = 'final' or period_lock_id is null);
alter table public.vat_report_download_acknowledgement add column period_lock_id uuid;
create index vat_report_artifact_lock_progress_idx
  on public.vat_report_artifact (period_lock_id, vat_report_id, report_generated_at, format, id)
  where kind = 'final';

create or replace function private.create_vat_report_artifact(
  target_company_id uuid,
  target_vat_report_id uuid,
  target_report_generated_at timestamptz,
  target_format text,
  target_kind text,
  target_file_name text,
  target_xml_base64 text,
  target_resolved_details jsonb,
  target_schema_version text,
  target_serializer_version text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  report public.vat_report;
  active_lock public.period_lock;
  lock_exists boolean;
  artifact_id uuid;
  artifact_bytes bytea;
  artifact_sha256 text;
  expected_file_name text;
begin
  -- Serialize with Finalization/unlock and progress using Company -> Report order.
  perform id from public.company where id = target_company_id for update;
  select * into report
  from public.vat_report
  where id = target_vat_report_id and company_id = target_company_id
  for share;

  if not found or not private.can_access_company(report.company_id, report.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if report.generated_at is distinct from target_report_generated_at then
    raise exception 'VAT Report changed during export'
      using errcode = 'P0001', hint = 'stale_report';
  end if;

  select * into active_lock
  from public.period_lock period_lock
  where period_lock.company_id = report.company_id and period_lock.period = report.period;
  lock_exists := found;
  if target_kind = 'draft' and lock_exists then
    raise exception 'VAT Report is finalized'
      using errcode = 'P0001', hint = 'report_finalized';
  end if;
  if target_kind = 'final' and (
    not lock_exists or active_lock.vat_report_id is distinct from report.id
  ) then
    raise exception 'VAT Report is not finalized'
      using errcode = 'P0001', hint = 'report_not_finalized';
  end if;

  expected_file_name := case target_kind
    when 'draft' then 'DRAFT_' || upper(target_format) || '_' || report.period || '.xml'
    when 'final' then upper(target_format) || '_' || report.period || '.xml'
    else null
  end;
  if target_format not in ('dphdp3', 'dphkh1')
    or target_file_name is distinct from expected_file_name
    or jsonb_typeof(target_resolved_details) <> 'object'
    or (target_format = 'dphdp3' and target_schema_version <> '03.01.04')
    or (target_format = 'dphkh1' and target_schema_version <> '03.01.15')
    or target_serializer_version <> '2'
  then
    raise exception 'invalid artifact details'
      using errcode = 'P0001', hint = 'invalid_export_details';
  end if;

  begin
    artifact_bytes := decode(target_xml_base64, 'base64');
  exception when others then
    raise exception 'invalid XML bytes'
      using errcode = 'P0001', hint = 'invalid_export_details';
  end;
  if octet_length(artifact_bytes) = 0 then
    raise exception 'empty XML bytes'
      using errcode = 'P0001', hint = 'invalid_export_details';
  end if;

  insert into public.vat_report_artifact (
    organization_id, company_id, vat_report_id, report_generated_at, period,
    format, kind, file_name, media_type, xml_bytes, resolved_details,
    schema_version, serializer_version, created_by, period_lock_id
  ) values (
    report.organization_id, report.company_id, report.id, report.generated_at, report.period,
    target_format, target_kind, target_file_name, 'application/xml; charset=utf-8',
    artifact_bytes, target_resolved_details, target_schema_version,
    target_serializer_version, auth.uid(), case when target_kind = 'final' then active_lock.id else null end
  ) returning id, sha256 into artifact_id, artifact_sha256;

  perform private.record_audit_event(
    'vat_report_artifact.created', report.organization_id, report.company_id,
    'vat_report_artifact', artifact_id,
    jsonb_build_object(
      'vat_report_id', report.id,
      'period', report.period,
      'format', target_format,
      'kind', target_kind,
      'period_lock_id', case when target_kind = 'final' then active_lock.id else null end,
      'sha256', artifact_sha256,
      'schema_version', target_schema_version,
      'serializer_version', target_serializer_version
    )
  );
  return artifact_id;
end;
$$;

drop function public.acknowledge_vat_report_download(uuid, text, text, timestamptz, uuid);
create function public.acknowledge_vat_report_download(
  target_company_id uuid, target_period text, target_format text,
  target_report_generated_at timestamptz, target_artifact_id uuid, target_period_lock_id uuid default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  company public.company;
  report public.vat_report;
  artifact public.vat_report_artifact;
  active_lock public.period_lock;
begin
  -- Same Company -> Report lock order as generation and Finalization.
  select * into company from public.company where id = target_company_id for update;
  if not found or not private.can_access_company(company.id, company.organization_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into report from public.vat_report
    where company_id = company.id and period = target_period for update;
  if not found or report.generated_at is distinct from target_report_generated_at then
    raise exception 'not the current VAT Report generation' using errcode = 'P0001', hint = 'invalid_download_artifact';
  end if;
  select * into artifact from public.vat_report_artifact where id = target_artifact_id;
  if not found or artifact.company_id <> company.id or artifact.organization_id <> company.organization_id
    or artifact.period <> target_period or artifact.format <> target_format
    or artifact.vat_report_id <> report.id
    or artifact.report_generated_at is distinct from report.generated_at then
    raise exception 'artifact does not match the current export' using errcode = 'P0001', hint = 'invalid_download_artifact';
  end if;
  select * into active_lock from public.period_lock where company_id = company.id and period = report.period;
  if artifact.kind = 'draft' then
    if target_period_lock_id is not null then
      raise exception 'a draft has no lock cycle' using errcode = 'P0001', hint = 'invalid_download_artifact';
    end if;
    if active_lock.id is not null then
      raise exception 'VAT Report is finalized' using errcode = 'P0001', hint = 'report_finalized';
    end if;
  elsif artifact.period_lock_id is null or target_period_lock_id is null
    or artifact.period_lock_id is distinct from target_period_lock_id
    or active_lock.id is distinct from target_period_lock_id
    or active_lock.vat_report_id is distinct from report.id then
    raise exception 'not the current Finalization cycle' using errcode = 'P0001', hint = 'invalid_download_artifact';
  end if;
  insert into public.vat_report_download_acknowledgement (artifact_id, company_id, organization_id, acknowledged_by, period_lock_id)
    values (artifact.id, company.id, company.organization_id, auth.uid(), artifact.period_lock_id) on conflict (artifact_id) do nothing;
  if found then
    perform private.record_audit_event('vat_report_artifact.download_acknowledged', company.organization_id, company.id,
      'vat_report_artifact', artifact.id, jsonb_build_object(
        'vat_report_id', report.id, 'report_generated_at', report.generated_at,
        'period', report.period, 'format', artifact.format, 'kind', artifact.kind, 'period_lock_id', artifact.period_lock_id
      ));
  end if;
end;
$$;

revoke execute on function public.acknowledge_vat_report_download(uuid, text, text, timestamptz, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.acknowledge_vat_report_download(uuid, text, text, timestamptz, uuid, uuid) to authenticated;

-- Both stages read the same immutable facts; only the applicability scope differs.
create function public.vat_report_export_progress(
  target_company_id uuid, target_period text, target_report_generated_at timestamptz,
  target_kind text, target_period_lock_id uuid default null
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  report public.vat_report;
  downloaded text[];
begin
  if target_kind = 'draft' and target_period_lock_id is null then
    return public.vat_report_draft_progress(target_company_id, target_period, target_report_generated_at);
  end if;
  select * into report from public.vat_report where company_id = target_company_id and period = target_period;
  if not found or not private.can_access_company(report.company_id, report.organization_id) then return null; end if;
  if target_kind <> 'final' or report.generated_at is distinct from target_report_generated_at
    or target_period_lock_id is null or not exists (
      select 1 from public.period_lock active_lock where active_lock.id = target_period_lock_id
        and active_lock.company_id = report.company_id and active_lock.period = report.period and active_lock.vat_report_id = report.id
    ) then return jsonb_build_object('downloadedFormats', '[]'::jsonb, 'skippedFormats', '[]'::jsonb); end if;
  select coalesce(array_agg(distinct artifact.format order by artifact.format), array[]::text[]) into downloaded
    from public.vat_report_artifact artifact
    join public.vat_report_download_acknowledgement acknowledgement on acknowledgement.artifact_id = artifact.id
    where artifact.vat_report_id = report.id and artifact.report_generated_at = report.generated_at
      and artifact.kind = 'final' and artifact.period_lock_id = target_period_lock_id
      and acknowledgement.period_lock_id = artifact.period_lock_id;
  return jsonb_build_object('downloadedFormats', to_jsonb(downloaded), 'skippedFormats', '[]'::jsonb);
end;
$$;
revoke execute on function public.vat_report_export_progress(uuid, text, timestamptz, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.vat_report_export_progress(uuid, text, timestamptz, text, uuid) to authenticated;

create or replace function public.vat_report_artifact_history(
  target_company_id uuid,
  target_period text
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  company public.company;
  history jsonb;
begin
  select * into company from public.company where id = target_company_id;
  if not found or not private.can_access_company(company.id, company.organization_id) then
    return '[]'::jsonb;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', artifact.id,
    'companyId', artifact.company_id,
    'vatReportId', artifact.vat_report_id,
    'reportGeneratedAt', artifact.report_generated_at,
      'periodLockId', artifact.period_lock_id,
    'period', artifact.period,
    'format', artifact.format,
    'kind', artifact.kind,
    'fileName', artifact.file_name,
    'mediaType', artifact.media_type,
    'byteSize', artifact.byte_size,
    'sha256', artifact.sha256,
    'resolvedDetails', artifact.resolved_details,
    'schemaVersion', artifact.schema_version,
    'serializerVersion', artifact.serializer_version,
    'authorUserId', artifact.created_by,
    'authorEmail', creator.email,
    'createdAt', artifact.created_at
  ) order by artifact.created_at desc, artifact.id desc), '[]'::jsonb)
  into history
  from public.vat_report_artifact artifact
  join auth.users creator on creator.id = artifact.created_by
  where artifact.company_id = company.id and artifact.period = target_period;
  return history;
end;
$$;


create or replace function public.read_vat_report_artifact(
  target_company_id uuid,
  target_artifact_id uuid
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  company public.company;
  result jsonb;
begin
  select * into company from public.company where id = target_company_id;
  if not found or not private.can_access_company(company.id, company.organization_id) then
    return null;
  end if;
  select jsonb_build_object(
    'artifact', jsonb_build_object(
      'id', artifact.id,
      'companyId', artifact.company_id,
      'vatReportId', artifact.vat_report_id,
      'reportGeneratedAt', artifact.report_generated_at,
      'periodLockId', artifact.period_lock_id,
      'period', artifact.period,
      'format', artifact.format,
      'kind', artifact.kind,
      'fileName', artifact.file_name,
      'mediaType', artifact.media_type,
      'byteSize', artifact.byte_size,
      'sha256', artifact.sha256,
      'resolvedDetails', artifact.resolved_details,
      'schemaVersion', artifact.schema_version,
      'serializerVersion', artifact.serializer_version,
      'authorUserId', artifact.created_by,
      'authorEmail', creator.email,
      'createdAt', artifact.created_at
    ),
    'xmlBase64', encode(artifact.xml_bytes, 'base64')
  ) into result
  from public.vat_report_artifact artifact
  join auth.users creator on creator.id = artifact.created_by
  where artifact.id = target_artifact_id and artifact.company_id = company.id;
  return result;
end;
$$;


-- Preserve cycle provenance in immutable transition history and audit.
alter table public.vat_report_transition add column period_lock_id uuid;

create or replace function public.finalize_vat_report(
  target_company_id uuid,
  target_period text,
  finalization_confirmed boolean
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  company public.company;
  report public.vat_report;
  finalization_lock_id uuid;
begin
  select * into company from public.company where id = target_company_id for update;
  if not found or not private.can_administrate_company(company.id, company.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not coalesce(finalization_confirmed, false) then
    raise exception 'Finalization must be confirmed'
      using errcode = 'P0001', hint = 'confirmation_required';
  end if;

  select * into report from public.vat_report
    where company_id = company.id and period = target_period for update;
  if not found then
    raise exception 'a stored VAT Report is required'
      using errcode = 'P0001', hint = 'report_not_found';
  end if;
  if not exists (
    select 1
    from public.company_setup_step_state setup
    where setup.company_id = company.id
      and setup.step = 'identity'
      and setup.state = 'completed'
  ) then
    raise exception 'Company identity is incomplete'
      using errcode = 'P0001', hint = 'company_setup_incomplete';
  end if;

  -- Every Document-changing command locks its Document before checking the
  -- Period Lock. Taking the same locks here closes the finalization race.
  perform id from public.document where company_id = company.id order by id for update;
  if private.reporting_period_readiness_source(company.id, target_period)
    is distinct from report.result -> 'readinessSource'
    or private.company_identity_snapshot(company.id)
      is distinct from report.result -> 'company' then
    raise exception 'the VAT Report snapshot is stale'
      using errcode = 'P0001', hint = 'stale_report';
  end if;
  if report.blocker_count > 0 then
    raise exception 'the Reporting Period has readiness blockers'
      using errcode = 'P0001', hint = 'readiness_blocked';
  end if;

  insert into public.period_lock (
    company_id, organization_id, period, vat_report_id, locked_by
  ) values (
    company.id, company.organization_id, report.period, report.id, auth.uid()
  ) on conflict (company_id, period) do nothing returning id into finalization_lock_id;

  if found then
    insert into public.vat_report_transition (
      organization_id, company_id, period, vat_report_id, action, actor_user_id, period_lock_id
    ) values (
      company.organization_id, company.id, report.period, report.id,
      'vat_report.finalized', auth.uid(), finalization_lock_id
    );
    perform private.record_audit_event(
      'vat_report.finalized', company.organization_id, company.id,
      'vat_report', report.id,
      jsonb_build_object(
        'period', report.period,
        'period_lock_id', finalization_lock_id,
        'warning_count', report.warning_count,
        'rejected_document_count', report.rejected_document_count
      )
    );
  end if;
end;
$$;

create or replace function public.unlock_reporting_period(
  target_company_id uuid,
  target_period text,
  unlock_reason text,
  unlock_confirmed boolean
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  company public.company;
  unlocked_report_id uuid;
  unlocked_lock_id uuid;
  reason text := trim(unlock_reason);
begin
  select * into company from public.company where id = target_company_id for update;
  if not found or not private.can_administrate_company(company.id, company.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not coalesce(unlock_confirmed, false) then
    raise exception 'Unlock must be confirmed'
      using errcode = 'P0001', hint = 'confirmation_required';
  end if;
  if reason is null or char_length(reason) < 3 then
    raise exception 'Unlock reason is required'
      using errcode = 'P0001', hint = 'unlock_reason_required';
  end if;
  if char_length(reason) > 200 then
    raise exception 'Unlock reason is too long'
      using errcode = 'P0001', hint = 'unlock_reason_too_long';
  end if;

  delete from public.period_lock
    where company_id = company.id and period = target_period
    returning vat_report_id, id into unlocked_report_id, unlocked_lock_id;
  if unlocked_report_id is null then
    raise exception 'the Reporting Period is not locked'
      using errcode = 'P0001', hint = 'not_locked';
  end if;
  perform private.record_audit_event(
    'reporting_period.unlocked', company.organization_id, company.id,
    'vat_report', unlocked_report_id,
    jsonb_build_object('period', target_period, 'period_lock_id', unlocked_lock_id)
  );
  insert into public.vat_report_transition (
    organization_id, company_id, period, vat_report_id, action,
    actor_user_id, unlock_reason, period_lock_id
  ) values (
    company.organization_id, company.id, target_period, unlocked_report_id,
    'reporting_period.unlocked', auth.uid(), reason, unlocked_lock_id
  );
end;
$$;

drop function public.vat_report_transition_history(uuid, text);
create function public.vat_report_transition_history(
  target_company_id uuid,
  target_period text
)
returns table (
  id bigint,
  action text,
  actor_user_id uuid,
  actor_email text,
  occurred_at timestamptz,
  vat_report_id uuid,
  unlock_reason text,
  period_lock_id uuid
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  company public.company;
begin
  select target.* into company
  from public.company target
  where target.id = target_company_id;
  if not found or not private.can_access_company(company.id, company.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  return query
    select
      event.id,
      event.action,
      event.actor_user_id,
      "user".email::text,
      event.occurred_at,
      event.vat_report_id,
      event.unlock_reason,
      event.period_lock_id
    from public.vat_report_transition event
    left join auth.users "user" on "user".id = event.actor_user_id
    where event.company_id = company.id
      and event.action in ('vat_report.finalized', 'reporting_period.unlocked')
      and event.period = target_period
    order by event.id;
end;
$$;

revoke execute on function public.vat_report_transition_history(uuid, text)
  from public, anon, service_role;
grant execute on function public.vat_report_transition_history(uuid, text)
  to authenticated;

-- Extend canonical retained snapshot metadata without changing its access guard.
create or replace function private.company_export_snapshot_without_download_progress(target_company_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  snapshot jsonb;
begin
  snapshot := private.company_export_snapshot_without_vat_outputs(target_company_id);
  snapshot := snapshot || jsonb_build_object(
    'vatReports', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', report.id,
        'companyId', report.company_id,
        'period', report.period,
        'result', report.result,
        'documents', report.documents,
        'generatedBy', report.generated_by,
        'generatedAt', report.generated_at,
        'finalization', jsonb_build_object(
          'blockerCount', report.blocker_count,
          'warningCount', report.warning_count,
          'rejectedDocumentCount', report.rejected_document_count
        )
      ) order by report.period, report.generated_at, report.id)
      from public.vat_report report
      where report.company_id = target_company_id
    ), '[]'::jsonb),
    'vatReportTransitions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', transition.id,
        'period', transition.period,
        'vatReportId', transition.vat_report_id,
        'periodLockId', transition.period_lock_id,
        'action', transition.action,
        'actorUserId', transition.actor_user_id,
        'actorEmail', actor.email,
        'occurredAt', transition.occurred_at,
        'unlockReason', transition.unlock_reason
      ) order by transition.occurred_at, transition.id)
      from public.vat_report_transition transition
      join auth.users actor on actor.id = transition.actor_user_id
      where transition.company_id = target_company_id
    ), '[]'::jsonb),
    'vatReportArtifacts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', artifact.id,
        'companyId', artifact.company_id,
        'vatReportId', artifact.vat_report_id,
        'reportGeneratedAt', artifact.report_generated_at,
        'periodLockId', artifact.period_lock_id,
        'period', artifact.period,
        'format', artifact.format,
        'kind', artifact.kind,
        'fileName', artifact.file_name,
        'mediaType', artifact.media_type,
        'byteSize', artifact.byte_size,
        'sha256', artifact.sha256,
        'resolvedDetails', artifact.resolved_details,
        'schemaVersion', artifact.schema_version,
        'serializerVersion', artifact.serializer_version,
        'authorUserId', artifact.created_by,
        'authorEmail', author.email,
        'createdAt', artifact.created_at,
        'xmlBase64', encode(artifact.xml_bytes, 'base64')
      ) order by artifact.created_at, artifact.id)
      from public.vat_report_artifact artifact
      join auth.users author on author.id = artifact.created_by
      where artifact.company_id = target_company_id
    ), '[]'::jsonb)
  );
  return snapshot;
end;
$$;


create or replace function public.company_export_snapshot(target_company_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare snapshot jsonb;
begin
  snapshot := private.company_export_snapshot_without_download_progress(target_company_id);
  return snapshot || jsonb_build_object(
    'vatReportDownloadAcknowledgements', coalesce((select jsonb_agg(jsonb_build_object(
      'artifactId', acknowledgement.artifact_id, 'periodLockId', acknowledgement.period_lock_id, 'acknowledgedAt', acknowledgement.acknowledged_at,
      'acknowledgedBy', acknowledgement.acknowledged_by
    ) order by acknowledgement.acknowledged_at, acknowledgement.artifact_id)
      from public.vat_report_download_acknowledgement acknowledgement where company_id = target_company_id), '[]'::jsonb),
    'vatReportDraftSkips', coalesce((select jsonb_agg(jsonb_build_object(
      'id', choice.id, 'vatReportId', choice.vat_report_id, 'reportGeneratedAt', choice.report_generated_at,
      'skippedFormats', choice.skipped_formats, 'skippedAt', choice.skipped_at, 'skippedBy', choice.skipped_by
    ) order by choice.skipped_at, choice.id) from public.vat_report_draft_skip choice where company_id = target_company_id), '[]'::jsonb)
  );
end;
$$;
revoke execute on function public.company_export_snapshot(uuid) from public, anon, authenticated, service_role;

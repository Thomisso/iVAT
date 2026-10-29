-- Final EPO XML artifacts and complete VAT output content in Company archives.

create trigger vat_report_data_revision
  after insert or update or delete on public.vat_report
  for each row execute function private.bump_company_data_revision();
create trigger period_lock_data_revision
  after insert or update or delete on public.period_lock
  for each row execute function private.bump_company_data_revision();
create trigger vat_report_transition_data_revision
  after insert on public.vat_report_transition
  for each row execute function private.bump_company_data_revision();
create trigger vat_report_artifact_data_revision
  after insert on public.vat_report_artifact
  for each row execute function private.bump_company_data_revision();

create function private.create_vat_report_artifact(
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
    or target_serializer_version <> '1'
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
    schema_version, serializer_version, created_by
  ) values (
    report.organization_id, report.company_id, report.id, report.generated_at, report.period,
    target_format, target_kind, target_file_name, 'application/xml; charset=utf-8',
    artifact_bytes, target_resolved_details, target_schema_version,
    target_serializer_version, auth.uid()
  ) returning id, sha256 into artifact_id, artifact_sha256;

  perform private.record_audit_event(
    'vat_report_artifact.created', report.organization_id, report.company_id,
    'vat_report_artifact', artifact_id,
    jsonb_build_object(
      'vat_report_id', report.id,
      'period', report.period,
      'format', target_format,
      'kind', target_kind,
      'sha256', artifact_sha256,
      'schema_version', target_schema_version,
      'serializer_version', target_serializer_version
    )
  );
  return artifact_id;
end;
$$;

create or replace function public.create_draft_vat_report_artifact(
  target_company_id uuid,
  target_vat_report_id uuid,
  target_report_generated_at timestamptz,
  target_format text,
  target_file_name text,
  target_xml_base64 text,
  target_resolved_details jsonb,
  target_schema_version text,
  target_serializer_version text
)
returns uuid
language sql security definer set search_path = ''
as $$
  select private.create_vat_report_artifact(
    target_company_id, target_vat_report_id, target_report_generated_at,
    target_format, 'draft', target_file_name, target_xml_base64,
    target_resolved_details, target_schema_version, target_serializer_version
  );
$$;

create function public.create_final_vat_report_artifact(
  target_company_id uuid,
  target_vat_report_id uuid,
  target_report_generated_at timestamptz,
  target_format text,
  target_file_name text,
  target_xml_base64 text,
  target_resolved_details jsonb,
  target_schema_version text,
  target_serializer_version text
)
returns uuid
language sql security definer set search_path = ''
as $$
  select private.create_vat_report_artifact(
    target_company_id, target_vat_report_id, target_report_generated_at,
    target_format, 'final', target_file_name, target_xml_base64,
    target_resolved_details, target_schema_version, target_serializer_version
  );
$$;

revoke execute on function private.create_vat_report_artifact(
  uuid, uuid, timestamptz, text, text, text, text, jsonb, text, text
) from public;
revoke execute on function public.create_final_vat_report_artifact(
  uuid, uuid, timestamptz, text, text, text, jsonb, text, text
) from public, anon, service_role;
grant execute on function public.create_final_vat_report_artifact(
  uuid, uuid, timestamptz, text, text, text, jsonb, text, text
) to authenticated;

-- Wrap the canonical snapshot so all Company archive callers gain VAT output
-- history without duplicating the existing Company/Document snapshot query.
alter function public.company_export_snapshot(uuid)
  rename to company_export_snapshot_without_vat_outputs;
alter function public.company_export_snapshot_without_vat_outputs(uuid)
  set schema private;

create function public.company_export_snapshot(target_company_id uuid)
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

revoke execute on function private.company_export_snapshot_without_vat_outputs(uuid),
  public.company_export_snapshot(uuid) from public, anon, authenticated, service_role;

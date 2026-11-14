-- Company downloads and worker verification share the complete retained snapshot.
-- Extend that same authority rather than loading artifacts through capped API lists.
alter function public.company_export_snapshot(uuid) rename to company_export_snapshot_without_pdf_artifacts;
alter function public.company_export_snapshot_without_pdf_artifacts(uuid) set schema private;

create function public.company_export_snapshot(target_company_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  snapshot jsonb;
begin
  snapshot := private.company_export_snapshot_without_pdf_artifacts(target_company_id);
  if jsonb_typeof(snapshot #> '{company,filingDefaults}') = 'object' then
    snapshot := jsonb_set(snapshot, '{company,filingDefaults,representative}',
      coalesce((select defaults.representative from public.company_filing_defaults defaults
        where defaults.company_id = target_company_id), 'null'::jsonb));
  end if;
  return snapshot || jsonb_build_object('vatReportPdfArtifacts', coalesce((
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
      'authorEmail', null,
      'createdAt', artifact.created_at,
      'pdfBase64', encode(artifact.pdf_bytes, 'base64')
    ) order by artifact.created_at, artifact.id)
    from public.vat_report_pdf_artifact artifact
    where artifact.company_id = target_company_id
  ), '[]'::jsonb));
end;
$$;

revoke all on function public.company_export_snapshot(uuid),
  private.company_export_snapshot_without_pdf_artifacts(uuid)
  from public, anon, authenticated, service_role;

-- A later immutable output must invalidate an archive that does not contain it.
create trigger vat_report_pdf_artifact_data_revision
  after insert or update or delete on public.vat_report_pdf_artifact
  for each row execute function private.bump_company_data_revision();

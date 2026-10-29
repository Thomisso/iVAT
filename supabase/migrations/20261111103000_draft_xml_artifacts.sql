-- Immutable EPO XML bytes created from a particular saved VAT Report snapshot.

create table public.vat_report_artifact (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organization(id),
  company_id uuid not null,
  vat_report_id uuid not null references public.vat_report(id),
  report_generated_at timestamptz not null,
  period text not null check (period ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  format text not null check (format in ('dphdp3', 'dphkh1')),
  kind text not null check (kind in ('draft', 'final')),
  file_name text not null check (file_name = btrim(file_name) and length(file_name) between 1 and 255),
  media_type text not null check (media_type = 'application/xml; charset=utf-8'),
  xml_bytes bytea not null,
  byte_size integer generated always as (octet_length(xml_bytes)) stored,
  sha256 text generated always as (encode(extensions.digest(xml_bytes, 'sha256'), 'hex')) stored,
  resolved_details jsonb not null check (jsonb_typeof(resolved_details) = 'object'),
  schema_version text not null check (length(schema_version) between 1 and 32),
  serializer_version text not null check (length(serializer_version) between 1 and 32),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.company(id, organization_id)
);

create index vat_report_artifact_history_idx
  on public.vat_report_artifact (company_id, period, created_at desc, id desc);

alter table public.vat_report_artifact enable row level security;
revoke all on public.vat_report_artifact from public, anon, authenticated, service_role;
grant select on public.vat_report_artifact to authenticated;
create policy "Company Users read VAT Report artifacts"
  on public.vat_report_artifact for select to authenticated
  using (private.can_access_company(company_id, organization_id));

-- Artifact bytes and provenance are append-only, including for privileged roles.
create function private.prevent_vat_report_artifact_change()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  raise exception 'vat_report_artifact is immutable' using errcode = '42501';
end;
$$;

create trigger vat_report_artifact_immutable
  before update or delete on public.vat_report_artifact
  for each row execute function private.prevent_vat_report_artifact_change();

create trigger vat_report_artifact_no_truncate
  before truncate on public.vat_report_artifact
  for each statement execute function private.prevent_vat_report_artifact_change();

revoke execute on function private.prevent_vat_report_artifact_change() from public;

create function public.create_draft_vat_report_artifact(
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
language plpgsql security definer set search_path = ''
as $$
declare
  report public.vat_report;
  artifact_id uuid;
  artifact_bytes bytea;
  artifact_sha256 text;
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
  if exists (
    select 1 from public.period_lock l
    where l.company_id = report.company_id and l.period = report.period
  ) then
    raise exception 'VAT Report is finalized'
      using errcode = 'P0001', hint = 'report_finalized';
  end if;
  if target_format not in ('dphdp3', 'dphkh1')
    or target_file_name <> ('DRAFT_' || upper(target_format) || '_' || report.period || '.xml')
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
    target_format, 'draft', target_file_name, 'application/xml; charset=utf-8',
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
      'kind', 'draft',
      'sha256', artifact_sha256,
      'schema_version', target_schema_version,
      'serializer_version', target_serializer_version
    )
  );
  return artifact_id;
end;
$$;

create function public.vat_report_artifact_history(
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

create function public.read_vat_report_artifact(
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

revoke execute on function public.create_draft_vat_report_artifact(
  uuid, uuid, timestamptz, text, text, text, jsonb, text, text
), public.vat_report_artifact_history(uuid, text),
  public.read_vat_report_artifact(uuid, uuid)
from public, anon, service_role;
grant execute on function public.create_draft_vat_report_artifact(
  uuid, uuid, timestamptz, text, text, text, jsonb, text, text
), public.vat_report_artifact_history(uuid, text),
  public.read_vat_report_artifact(uuid, uuid)
to authenticated;

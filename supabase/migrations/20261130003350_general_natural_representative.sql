-- Natural-person general representative; existing Company access and defaults audit remain authoritative.
alter table public.company_filing_defaults add column representative jsonb;
alter function public.set_company_filing_defaults(uuid, text, text, text, text, text, text, text, text, text, text, text, boolean, text, text) rename to set_company_filing_defaults_base;
alter function public.set_company_filing_defaults_base(uuid, text, text, text, text, text, text, text, text, text, text, text, boolean, text, text) set schema private;
revoke all on function private.set_company_filing_defaults_base(uuid, text, text, text, text, text, text, text, text, text, text, text, boolean, text, text) from public, anon, authenticated;
create function public.set_company_filing_defaults(
  target_company_id uuid,
  new_tax_office text,
  new_signatory_first_name text,
  new_signatory_last_name text,
  new_signatory_capacity text,
  new_email text,
  new_phone text,
  new_epo_street_name text,
  new_epo_house_number text,
  new_epo_orientation_number text,
  new_epo_city text,
  new_epo_postal_code text,
  epo_address_confirmed boolean,
  new_economic_activity text default '',
  new_territorial_office text default '',
  new_representative jsonb default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  profile jsonb;
  birthday date;
  field_name text;
begin
  -- The existing function locks and authorizes the Company and records only boolean audit facts.
  perform private.set_company_filing_defaults_base(target_company_id, new_tax_office,
    new_signatory_first_name, new_signatory_last_name, new_signatory_capacity, new_email, new_phone,
    new_epo_street_name, new_epo_house_number, new_epo_orientation_number, new_epo_city, new_epo_postal_code,
    epo_address_confirmed, new_economic_activity, new_territorial_office);
  if new_representative is not null and new_representative <> 'null'::jsonb then
    if jsonb_typeof(new_representative) <> 'object'
      or new_representative->>'code' is distinct from '4a'
      or new_representative->>'personType' is distinct from 'F' then
      raise exception 'invalid representative' using errcode = 'P0001', hint = 'invalid_representative';
    end if;
    foreach field_name in array array['firstName', 'lastName', 'birthDate', 'evidenceNumber'] loop
      if new_representative ? field_name and jsonb_typeof(new_representative->field_name) <> 'string' then
        raise exception 'invalid representative' using errcode = 'P0001', hint = 'invalid_representative';
      end if;
    end loop;
    profile := jsonb_build_object('code', '4a', 'personType', 'F',
      'firstName', trim(coalesce(new_representative->>'firstName', '')),
      'lastName', trim(coalesce(new_representative->>'lastName', '')),
      'birthDate', trim(coalesce(new_representative->>'birthDate', '')),
      'evidenceNumber', trim(coalesce(new_representative->>'evidenceNumber', '')));
    if length(profile->>'firstName') not between 1 and 20
      or length(profile->>'lastName') not between 1 and 36
      or length(profile->>'evidenceNumber') > 36
      or (profile->>'birthDate' = '' and profile->>'evidenceNumber' = '') then
      raise exception 'invalid representative' using errcode = 'P0001', hint = 'invalid_representative';
    end if;
    if profile->>'birthDate' <> '' then
      begin
        birthday := (profile->>'birthDate')::date;
        if profile->>'birthDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          or to_char(birthday, 'YYYY-MM-DD') <> profile->>'birthDate' then
          raise exception 'invalid date';
        end if;
      exception when others then
        raise exception 'invalid representative' using errcode = 'P0001', hint = 'invalid_representative';
      end;
    end if;
  end if;
  update public.company_filing_defaults set representative = profile where company_id = target_company_id;
end;
$$;
revoke all on function public.set_company_filing_defaults(uuid, text, text, text, text, text, text, text, text, text, text, text, boolean, text, text, jsonb) from public, anon;
grant execute on function public.set_company_filing_defaults(uuid, text, text, text, text, text, text, text, text, text, text, text, boolean, text, text, jsonb) to authenticated;

-- Preserve older artifacts and compatible direct callers; identify the new serializer exactly.
do $$
declare archive_function record;
begin
  for archive_function in
    select pg_get_functiondef(p.oid) as definition from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname in ('create_vat_report_artifact', 'create_vat_report_artifact_before_deadline')
  loop
    execute replace(archive_function.definition,
      'target_serializer_version <> ''2''', 'target_serializer_version not in (''2'', ''3'')');
  end loop;
end;
$$;

-- Complete PDF downloads preserve their own immutable bytes and context. They
-- never count as XML download acknowledgements or Finalization evidence.
create table public.vat_report_pdf_artifact (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organization(id),
  company_id uuid not null,
  vat_report_id uuid not null references public.vat_report(id),
  report_generated_at timestamptz not null,
  period_lock_id uuid,
  period text not null check (period ~ '^20[0-9]{2}-(0[1-9]|1[0-2]|Q[1-4])$'),
  format text not null check (format in ('dphdp3', 'dphkh1')),
  kind text not null check (kind in ('draft', 'final')),
  file_name text not null,
  media_type text not null default 'application/pdf' check (media_type = 'application/pdf'),
  pdf_bytes bytea not null,
  byte_size integer generated always as (octet_length(pdf_bytes)) stored,
  sha256 text generated always as (encode(extensions.digest(pdf_bytes, 'sha256'), 'hex')) stored,
  resolved_details jsonb not null check (jsonb_typeof(resolved_details) = 'object'),
  schema_version text not null,
  serializer_version text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.company(id, organization_id)
);
create index vat_report_pdf_artifact_history_idx on public.vat_report_pdf_artifact(company_id, period, created_at desc, id desc);
alter table public.vat_report_pdf_artifact enable row level security;
revoke all on public.vat_report_pdf_artifact from public, anon, authenticated, service_role;
grant select on public.vat_report_pdf_artifact to authenticated;
create policy "Company Users read PDF artifacts" on public.vat_report_pdf_artifact for select to authenticated
  using (private.can_access_company(company_id, organization_id));
create trigger vat_report_pdf_artifact_immutable before update or delete on public.vat_report_pdf_artifact
  for each row execute function private.prevent_vat_report_artifact_change();
create trigger vat_report_pdf_artifact_no_truncate before truncate on public.vat_report_pdf_artifact
  for each statement execute function private.prevent_vat_report_artifact_change();

create function public.create_vat_report_pdf_artifact(
  target_company_id uuid, target_vat_report_id uuid, target_report_generated_at timestamptz,
  target_format text, target_pdf_base64 text, target_resolved_details jsonb,
  target_schema_version text, target_serializer_version text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  report public.vat_report;
  active_lock public.period_lock;
  artifact_id uuid;
  artifact_bytes bytea;
begin
  perform id from public.company where id = target_company_id for update;
  select * into report from public.vat_report
    where id = target_vat_report_id and company_id = target_company_id for share;
  if not found or not private.can_access_company(report.company_id, report.organization_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if report.generated_at is distinct from target_report_generated_at then
    raise exception 'stale report' using errcode = 'P0001', hint = 'stale_report';
  end if;
  select * into active_lock from public.period_lock
    where company_id = report.company_id and period = report.period and vat_report_id = report.id;
  if target_format is null or target_format not in ('dphdp3', 'dphkh1')
    or jsonb_typeof(target_resolved_details) is distinct from 'object'
    or target_schema_version is distinct from (case target_format when 'dphdp3' then '03.01.04' else '03.01.15' end)
    or target_serializer_version is distinct from '3' then
    raise exception 'invalid PDF details' using errcode = 'P0001', hint = 'invalid_export_details';
  end if;
  begin
    artifact_bytes := decode(target_pdf_base64, 'base64');
  exception when others then
    raise exception 'invalid PDF bytes' using errcode = 'P0001', hint = 'invalid_export_details';
  end;
  if artifact_bytes is null or octet_length(artifact_bytes) < 5
    or substring(artifact_bytes from 1 for 5) <> convert_to('%PDF-', 'UTF8') then
    raise exception 'invalid PDF bytes' using errcode = 'P0001', hint = 'invalid_export_details';
  end if;
  insert into public.vat_report_pdf_artifact(organization_id, company_id, vat_report_id,
    report_generated_at, period_lock_id, period, format, kind, file_name, pdf_bytes,
    resolved_details, schema_version, serializer_version, created_by)
  values(report.organization_id, report.company_id, report.id, report.generated_at, active_lock.id,
    report.period, target_format, case when active_lock.id is null then 'draft' else 'final' end,
    upper(target_format) || '-' || report.period || '.pdf', artifact_bytes, target_resolved_details,
    target_schema_version, target_serializer_version, auth.uid()) returning id into artifact_id;
  perform private.record_audit_event('vat_report_pdf_artifact.created', report.organization_id,
    report.company_id, 'vat_report_pdf_artifact', artifact_id,
    jsonb_build_object('vat_report_id', report.id, 'period_lock_id', active_lock.id,
      'format', target_format, 'period', report.period, 'schema_version', target_schema_version,
      'serializer_version', target_serializer_version));
  return artifact_id;
end;
$$;
revoke all on function public.create_vat_report_pdf_artifact(uuid, uuid, timestamptz, text, text, jsonb, text, text) from public, anon, authenticated, service_role;
grant execute on function public.create_vat_report_pdf_artifact(uuid, uuid, timestamptz, text, text, jsonb, text, text) to authenticated;

create function public.read_vat_report_pdf_artifact(target_company_id uuid, target_artifact_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('artifact', to_jsonb(artifact) - 'pdf_bytes', 'pdfBase64', encode(artifact.pdf_bytes, 'base64'))
  from public.vat_report_pdf_artifact artifact where artifact.company_id = target_company_id and artifact.id = target_artifact_id;
$$;
revoke all on function public.read_vat_report_pdf_artifact(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.read_vat_report_pdf_artifact(uuid, uuid) to authenticated;

-- Browser receipt/download initiation is a separate, immutable fact from XML archiving.
alter table public.vat_report_artifact add constraint vat_report_artifact_tenant_identity
  unique (id, company_id, organization_id);
alter table public.vat_report add constraint vat_report_tenant_identity
  unique (id, company_id, organization_id);
create index vat_report_artifact_progress_idx
  on public.vat_report_artifact (vat_report_id, report_generated_at, kind, format, id);

create table public.vat_report_download_acknowledgement (
  artifact_id uuid primary key,
  company_id uuid not null,
  organization_id uuid not null,
  acknowledged_at timestamptz not null default clock_timestamp(),
  acknowledged_by uuid not null references auth.users(id),
  foreign key (artifact_id, company_id, organization_id)
    references public.vat_report_artifact(id, company_id, organization_id),
  foreign key (company_id, organization_id) references public.company(id, organization_id)
);
create table public.vat_report_draft_skip (
  id uuid primary key default gen_random_uuid(),
  vat_report_id uuid not null,
  company_id uuid not null,
  organization_id uuid not null,
  report_generated_at timestamptz not null,
  skipped_formats text[] not null check (skipped_formats in (
    array['dphdp3']::text[], array['dphkh1']::text[], array['dphdp3', 'dphkh1']::text[]
  )),
  skipped_at timestamptz not null default clock_timestamp(),
  skipped_by uuid not null references auth.users(id),
  unique (vat_report_id, report_generated_at),
  foreign key (vat_report_id, company_id, organization_id)
    references public.vat_report(id, company_id, organization_id),
  foreign key (company_id, organization_id) references public.company(id, organization_id)
);
revoke all on public.vat_report_download_acknowledgement, public.vat_report_draft_skip
  from public, anon, authenticated, service_role;
grant select on public.vat_report_download_acknowledgement, public.vat_report_draft_skip to authenticated;
alter table public.vat_report_download_acknowledgement enable row level security;
alter table public.vat_report_draft_skip enable row level security;
create policy "Company Users read download acknowledgements"
  on public.vat_report_download_acknowledgement for select to authenticated
  using (private.can_access_company(company_id, organization_id));
create policy "Company Users read draft skip choices"
  on public.vat_report_draft_skip for select to authenticated
  using (private.can_access_company(company_id, organization_id));

create function private.prevent_vat_report_progress_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'VAT Report progress facts are immutable' using errcode = '42501';
end;
$$;
revoke execute on function private.prevent_vat_report_progress_change() from public;
create trigger download_acknowledgement_immutable before update or delete on public.vat_report_download_acknowledgement
  for each row execute function private.prevent_vat_report_progress_change();
create trigger download_acknowledgement_no_truncate before truncate on public.vat_report_download_acknowledgement
  for each statement execute function private.prevent_vat_report_progress_change();
create trigger draft_skip_immutable before update or delete on public.vat_report_draft_skip
  for each row execute function private.prevent_vat_report_progress_change();
create trigger draft_skip_no_truncate before truncate on public.vat_report_draft_skip
  for each statement execute function private.prevent_vat_report_progress_change();
create trigger download_acknowledgement_data_revision after insert on public.vat_report_download_acknowledgement
  for each row execute function private.bump_company_data_revision();
create trigger draft_skip_data_revision after insert on public.vat_report_draft_skip
  for each row execute function private.bump_company_data_revision();

create function public.acknowledge_vat_report_download(
  target_company_id uuid, target_period text, target_format text,
  target_report_generated_at timestamptz, target_artifact_id uuid
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  company public.company;
  report public.vat_report;
  artifact public.vat_report_artifact;
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
    or artifact.kind <> 'draft' or artifact.vat_report_id <> report.id
    or artifact.report_generated_at is distinct from report.generated_at then
    raise exception 'artifact does not match the current export' using errcode = 'P0001', hint = 'invalid_download_artifact';
  end if;
  if exists (select 1 from public.period_lock where company_id = company.id and period = report.period) then
    raise exception 'VAT Report is finalized' using errcode = 'P0001', hint = 'report_finalized';
  end if;
  insert into public.vat_report_download_acknowledgement (artifact_id, company_id, organization_id, acknowledged_by)
    values (artifact.id, company.id, company.organization_id, auth.uid()) on conflict (artifact_id) do nothing;
  if found then
    perform private.record_audit_event('vat_report_artifact.download_acknowledged', company.organization_id, company.id,
      'vat_report_artifact', artifact.id, jsonb_build_object(
        'vat_report_id', report.id, 'report_generated_at', report.generated_at,
        'period', report.period, 'format', artifact.format, 'kind', artifact.kind
      ));
  end if;
end;
$$;

create function public.skip_vat_report_drafts(
  target_company_id uuid, target_period text, target_report_generated_at timestamptz
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  company public.company;
  report public.vat_report;
  formats text[];
  skip_id uuid;
begin
  select * into company from public.company where id = target_company_id for update;
  if not found or not private.can_access_company(company.id, company.organization_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into report from public.vat_report
    where company_id = company.id and period = target_period for update;
  if not found or report.generated_at is distinct from target_report_generated_at then
    raise exception 'VAT Report changed' using errcode = 'P0001', hint = 'stale_report';
  end if;
  if exists (select 1 from public.period_lock where company_id = company.id and period = report.period) then
    raise exception 'VAT Report is finalized' using errcode = 'P0001', hint = 'report_finalized';
  end if;
  select array_agg(candidate.format order by candidate.format) into formats
    from (values ('dphdp3'), ('dphkh1')) candidate(format)
    where not exists (
      select 1 from public.vat_report_download_acknowledgement acknowledgement
      join public.vat_report_artifact artifact on artifact.id = acknowledgement.artifact_id
      where artifact.vat_report_id = report.id and artifact.report_generated_at = report.generated_at
        and artifact.kind = 'draft' and artifact.format = candidate.format
    );
  if formats is null then return; end if;
  insert into public.vat_report_draft_skip (
    vat_report_id, company_id, organization_id, report_generated_at, skipped_formats, skipped_by
  ) values (report.id, company.id, company.organization_id, report.generated_at, formats, auth.uid())
    on conflict (vat_report_id, report_generated_at) do nothing returning id into skip_id;
  if found then
    perform private.record_audit_event('vat_report.drafts_skipped', company.organization_id, company.id,
      'vat_report_draft_skip', skip_id, jsonb_build_object(
        'vat_report_id', report.id, 'report_generated_at', report.generated_at,
        'period', report.period, 'formats', formats
      ));
  end if;
end;
$$;

create function public.vat_report_draft_progress(
  target_company_id uuid, target_period text, target_report_generated_at timestamptz
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  report public.vat_report;
  downloaded text[];
  skipped text[];
begin
  select * into report from public.vat_report where company_id = target_company_id and period = target_period;
  if not found or not private.can_access_company(report.company_id, report.organization_id) then return null; end if;
  if report.generated_at is distinct from target_report_generated_at then
    return jsonb_build_object('downloadedFormats', '[]'::jsonb, 'skippedFormats', '[]'::jsonb);
  end if;
  select coalesce(array_agg(distinct artifact.format order by artifact.format), array[]::text[]) into downloaded
    from public.vat_report_download_acknowledgement acknowledgement
    join public.vat_report_artifact artifact on artifact.id = acknowledgement.artifact_id
    where artifact.vat_report_id = report.id and artifact.report_generated_at = report.generated_at and artifact.kind = 'draft';
  select choice.skipped_formats into skipped from public.vat_report_draft_skip choice
    where choice.vat_report_id = report.id and choice.report_generated_at = report.generated_at;
  return jsonb_build_object('downloadedFormats', to_jsonb(downloaded), 'skippedFormats',
    coalesce((select jsonb_agg(format order by format) from unnest(skipped) format where not format = any(downloaded)), '[]'::jsonb));
end;
$$;
revoke execute on function public.acknowledge_vat_report_download(uuid, text, text, timestamptz, uuid),
  public.skip_vat_report_drafts(uuid, text, timestamptz), public.vat_report_draft_progress(uuid, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.acknowledge_vat_report_download(uuid, text, text, timestamptz, uuid),
  public.skip_vat_report_drafts(uuid, text, timestamptz), public.vat_report_draft_progress(uuid, text, timestamptz)
  to authenticated;

-- Retention/export includes facts from every generation; it never resets their history.
alter function public.company_export_snapshot(uuid) rename to company_export_snapshot_without_download_progress;
alter function public.company_export_snapshot_without_download_progress(uuid) set schema private;
revoke execute on function private.company_export_snapshot_without_download_progress(uuid) from public, anon, authenticated, service_role;
create function public.company_export_snapshot(target_company_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare snapshot jsonb;
begin
  snapshot := private.company_export_snapshot_without_download_progress(target_company_id);
  return snapshot || jsonb_build_object(
    'vatReportDownloadAcknowledgements', coalesce((select jsonb_agg(jsonb_build_object(
      'artifactId', acknowledgement.artifact_id, 'acknowledgedAt', acknowledgement.acknowledged_at,
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

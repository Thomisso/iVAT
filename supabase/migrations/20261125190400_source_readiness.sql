-- Unsplit Sources are explicit readiness items, never fictitious Documents.
-- Import Date selects where unfinished work is visible, not an accounting date.
create function private.source_file_readiness_source(target_company_id uuid, target_period text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'sourceFileId', source.id, 'fileName', source.file_name, 'status', source.status,
    'splitRequestId', source.split_request_id, 'exclusionReason', source.exclusion_reason
  ) order by source.id), '[]'::jsonb)
  from public.source_file source
  where source.company_id = target_company_id
    and private.reporting_period_for_date(source.company_id, (source.uploaded_at at time zone 'Europe/Prague')::date) = target_period
    and not exists (select 1 from public.document document where document.source_file_id = source.id);
$$;
revoke all on function private.source_file_readiness_source(uuid, text) from public, anon, authenticated, service_role;

create function public.source_file_readiness(target_company_id uuid, target_period text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare company public.company;
begin
  select * into company from public.company where id = target_company_id;
  if not found or not private.can_access_company(company.id, company.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return private.source_file_readiness_source(company.id, target_period);
end;
$$;
revoke all on function public.source_file_readiness(uuid, text) from public, anon, service_role;
grant execute on function public.source_file_readiness(uuid, text) to authenticated;

alter function private.reporting_period_readiness_stats(uuid, text) rename to reporting_period_document_readiness_stats;
create function private.reporting_period_readiness_stats(target_company_id uuid, target_period text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select document_stats || jsonb_build_object(
    'blockers', (document_stats ->> 'blockers')::integer + (
      select count(*) from jsonb_array_elements(sources) source where source ->> 'status' <> 'rejected'
    ),
    'rejectedSources', (select count(*) from jsonb_array_elements(sources) source where source ->> 'status' = 'rejected')
  ) from (
    select private.reporting_period_document_readiness_stats(target_company_id, target_period) as document_stats,
      private.source_file_readiness_source(target_company_id, target_period) as sources
  ) stats;
$$;
revoke all on function private.reporting_period_readiness_stats(uuid, text), private.reporting_period_document_readiness_stats(uuid, text) from public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.save_vat_report(target_company_id uuid, target_period text, expected_documents jsonb, computed_result jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  company public.company;
  current_documents jsonb;
  readiness jsonb;
  report_id uuid;
begin
  select * into company from public.company where id = target_company_id for update;
  if not found or not private.can_access_company(company.id, company.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if private.reporting_period_start(target_period) is null
    or private.reporting_period_for_date(
      company.id,
      private.reporting_period_start(target_period)
    ) is distinct from target_period then
    raise exception 'invalid Reporting Period'
      using errcode = 'P0001', hint = 'invalid_reporting_period';
  end if;

  -- The Company lock serializes identity changes. Document locks serialize
  -- review and Extraction Version changes while the canonical snapshot is saved.
  perform id from public.source_file where company_id = company.id order by id for share;
  perform id from public.document where company_id = company.id order by id for share;
  current_documents := public.vat_report_documents(company.id, target_period);
  if current_documents is distinct from expected_documents then
    raise exception 'Documents changed during generation'
      using errcode = 'P0001', hint = 'stale_report';
  end if;
  if private.reporting_period_readiness_source(company.id, target_period)
    is distinct from computed_result -> 'readinessSource' then
    raise exception 'Readiness source changed during generation'
      using errcode = 'P0001', hint = 'stale_report';
  end if;
  if private.source_file_readiness_source(company.id, target_period)
    is distinct from coalesce(computed_result -> 'sourceFilesReadinessSource', '[]'::jsonb) then
    raise exception 'Source work changed during generation' using errcode = 'P0001', hint = 'stale_report';
  end if;
  if private.company_identity_snapshot(company.id)
    is distinct from computed_result -> 'company' then
    raise exception 'Company identity changed during generation'
      using errcode = 'P0001', hint = 'stale_report';
  end if;
  readiness := private.reporting_period_readiness_stats(company.id, target_period);

  insert into public.vat_report (
    organization_id,
    company_id,
    period,
    result,
    documents,
    generated_by,
    blocker_count,
    warning_count,
    rejected_document_count
  ) values (
    company.organization_id,
    company.id,
    target_period,
    computed_result,
    current_documents,
    auth.uid(),
    (readiness ->> 'blockers')::integer,
    (readiness ->> 'warnings')::integer,
    (readiness ->> 'rejectedDocuments')::integer
  )
  on conflict (company_id, period) do update
    set result = excluded.result,
        documents = excluded.documents,
        generated_by = excluded.generated_by,
        generated_at = clock_timestamp(),
        blocker_count = excluded.blocker_count,
        warning_count = excluded.warning_count,
        rejected_document_count = excluded.rejected_document_count
  returning id into report_id;

  perform private.record_audit_event(
    'vat_report.generated',
    company.organization_id,
    company.id,
    'vat_report',
    report_id,
    jsonb_build_object(
      'period', target_period,
      'document_count', jsonb_array_length(current_documents)
    )
  );
  return report_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_vat_report(target_company_id uuid, target_period text, finalization_confirmed boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  perform id from public.source_file where company_id = company.id order by id for share;
  perform id from public.document where company_id = company.id order by id for update;
  if private.source_file_readiness_source(company.id, target_period)
    is distinct from coalesce(report.result -> 'sourceFilesReadinessSource', '[]'::jsonb) then
    raise exception 'Source work changed after generation' using errcode = 'P0001', hint = 'stale_report';
  end if;
  if private.reporting_period_readiness_source(company.id, target_period)
    is distinct from report.result -> 'readinessSource'
    or private.company_identity_snapshot(company.id)
      is distinct from report.result -> 'company' then
    raise exception 'the VAT Report snapshot is stale'
      using errcode = 'P0001', hint = 'stale_report';
  end if;
  -- Stored counts describe generation-time rules. Re-evaluate current rules
  -- under the same Company/Document locks before creating a new Period Lock;
  -- a predecessor draft can otherwise have an unchanged source and zero old
  -- blockers despite a newly required field. Existing locks stay untouched.
  if report.blocker_count > 0 or (
    not private.is_reporting_period_locked(company.id, target_period)
    and (private.reporting_period_readiness_stats(company.id, target_period)
      ->> 'blockers')::integer > 0
  ) then
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
$function$;

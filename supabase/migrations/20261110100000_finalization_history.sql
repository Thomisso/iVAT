-- Finalization is an auditable lock of one current, ready VAT Report snapshot.
-- The saved revision and database-derived readiness summary make the later
-- transition atomic without trusting browser-supplied readiness claims.

alter table public.vat_report
  add column data_revision bigint not null default 0,
  add column blocker_count integer not null default 0 check (blocker_count >= 0),
  add column warning_count integer not null default 0 check (warning_count >= 0),
  add column rejected_document_count integer not null default 0
    check (rejected_document_count >= 0);

create function private.reporting_period_readiness_stats(
  target_company_id uuid,
  target_period text
)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with relevant as (
    select document.status, version.payload, version.findings
    from public.document document
    left join lateral (
      select extraction.payload, extraction.findings
      from public.extraction_version extraction
      where extraction.document_id = document.id
      order by extraction.version desc
      limit 1
    ) version on true
    where document.company_id = target_company_id
      and document.superseded_at is null
      and (
        private.document_reporting_period(
          document.company_id,
          version.payload ->> 'direction',
          version.payload ->> 'taxPointDate',
          document.receipt_date,
          document.claimed_reporting_period
        ) = target_period
        or (
          private.document_reporting_period(
            document.company_id,
            version.payload ->> 'direction',
            version.payload ->> 'taxPointDate',
            document.receipt_date,
            document.claimed_reporting_period
          ) is null
          and document.receipt_date is not null
          and private.reporting_period_for_date(
            document.company_id,
            document.receipt_date
          ) = target_period
        )
      )
  ), counted as (
    select
      status,
      payload,
      coalesce((
        select count(*)
        from jsonb_array_elements(coalesce(findings, '[]'::jsonb)) finding
        where finding ->> 'severity' = 'error'
      ), 0)::integer as error_findings,
      coalesce((
        select count(*)
        from jsonb_array_elements(coalesce(findings, '[]'::jsonb)) finding
        where finding ->> 'severity' = 'warning'
      ), 0)::integer as warning_findings
    from relevant
  ), stats as (
    select
      coalesce(sum(case
        when status in ('uploaded', 'processing', 'failed') then 1
        when status = 'rejected' then 0
        else
          case when status = 'needs_review' then 1 else 0 end
          + case when nullif(payload ->> 'direction', '') is null then 1 else 0 end
          + case when nullif(payload ->> 'taxPointDate', '') is null then 1 else 0 end
          + case
              when jsonb_typeof(payload -> 'rateBreakdown') = 'array'
                and jsonb_array_length(payload -> 'rateBreakdown') > 0 then 0
              else 1
            end
          + case when nullif(payload ->> 'currency', '') is null then 1 else 0 end
          + error_findings
      end), 0)::integer as blockers,
      coalesce(sum(case
        when status = 'rejected' then 1
        when status in ('uploaded', 'processing', 'failed') then 0
        else warning_findings
      end), 0)::integer as warnings,
      count(*) filter (where status = 'rejected')::integer as rejected_documents
    from counted
  )
  select jsonb_build_object(
    'blockers', blockers,
    'warnings', warnings,
    'rejectedDocuments', rejected_documents
  )
  from stats;
$$;

revoke execute on function private.reporting_period_readiness_stats(uuid, text)
  from public;

create function private.reporting_period_readiness_source(
  target_company_id uuid,
  target_period text
)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'documentId', document.id,
    'status', document.status,
    'extractionVersionId', version.id,
    'receiptDate', document.receipt_date,
    'claimedReportingPeriod', document.claimed_reporting_period
  ) order by document.id), '[]'::jsonb)
  from public.document document
  left join lateral (
    select extraction.id, extraction.payload
    from public.extraction_version extraction
    where extraction.document_id = document.id
    order by extraction.version desc
    limit 1
  ) version on true
  where document.company_id = target_company_id
    and document.superseded_at is null
    and (
      private.document_reporting_period(
        document.company_id,
        version.payload ->> 'direction',
        version.payload ->> 'taxPointDate',
        document.receipt_date,
        document.claimed_reporting_period
      ) = target_period
      or (
        private.document_reporting_period(
          document.company_id,
          version.payload ->> 'direction',
          version.payload ->> 'taxPointDate',
          document.receipt_date,
          document.claimed_reporting_period
        ) is null
        and document.receipt_date is not null
        and private.reporting_period_for_date(
          document.company_id,
          document.receipt_date
        ) = target_period
      )
    );
$$;

revoke execute on function private.reporting_period_readiness_source(uuid, text)
  from public;

create or replace function public.save_vat_report(
  target_company_id uuid,
  target_period text,
  expected_documents jsonb,
  computed_result jsonb
)
returns uuid language plpgsql security definer set search_path = ''
as $$
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

  -- Every mutation represented by data_revision must update this locked Company
  -- row. Document locks also serialize review and Extraction Version changes.
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
  readiness := private.reporting_period_readiness_stats(company.id, target_period);

  insert into public.vat_report (
    organization_id,
    company_id,
    period,
    result,
    documents,
    generated_by,
    data_revision,
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
    company.data_revision,
    (readiness ->> 'blockers')::integer,
    (readiness ->> 'warnings')::integer,
    (readiness ->> 'rejectedDocuments')::integer
  )
  on conflict (company_id, period) do update
    set result = excluded.result,
        documents = excluded.documents,
        generated_by = excluded.generated_by,
        generated_at = clock_timestamp(),
        data_revision = excluded.data_revision,
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
$$;

revoke execute on function public.finalize_vat_report(uuid, text),
  public.unlock_reporting_period(uuid, text) from authenticated;
drop function public.finalize_vat_report(uuid, text);
drop function public.unlock_reporting_period(uuid, text);

create function public.finalize_vat_report(
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
  if report.data_revision is distinct from company.data_revision then
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
  ) on conflict (company_id, period) do nothing;

  if found then
    perform private.record_audit_event(
      'vat_report.finalized', company.organization_id, company.id,
      'vat_report', report.id,
      jsonb_build_object(
        'period', report.period,
        'warning_count', report.warning_count,
        'rejected_document_count', report.rejected_document_count
      )
    );
  end if;
end;
$$;

create function public.unlock_reporting_period(
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
    returning vat_report_id into unlocked_report_id;
  if unlocked_report_id is null then
    raise exception 'the Reporting Period is not locked'
      using errcode = 'P0001', hint = 'not_locked';
  end if;
  perform private.record_audit_event(
    'reporting_period.unlocked', company.organization_id, company.id,
    'vat_report', unlocked_report_id,
    jsonb_build_object('period', target_period, 'reason', reason)
  );
end;
$$;

revoke execute on function public.finalize_vat_report(uuid, text, boolean),
  public.unlock_reporting_period(uuid, text, text, boolean)
  from public, anon, service_role;
grant execute on function public.finalize_vat_report(uuid, text, boolean),
  public.unlock_reporting_period(uuid, text, text, boolean)
  to authenticated;

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
  unlock_reason text
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
      event.target_id,
      event.payload ->> 'reason'
    from public.audit_event event
    left join auth.users "user" on "user".id = event.actor_user_id
    where event.company_id = company.id
      and event.action in ('vat_report.finalized', 'reporting_period.unlocked')
      and event.payload ->> 'period' = target_period
    order by event.id;
end;
$$;

revoke execute on function public.vat_report_transition_history(uuid, text)
  from public, anon, service_role;
grant execute on function public.vat_report_transition_history(uuid, text)
  to authenticated;

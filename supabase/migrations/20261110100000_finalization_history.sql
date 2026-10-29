-- Finalization is an auditable lock of one current, ready VAT Report snapshot.
-- The database-derived snapshot and readiness summary make the later
-- transition atomic without trusting browser-supplied readiness claims.

alter table public.vat_report
  add column blocker_count integer not null default 0 check (blocker_count >= 0),
  add column warning_count integer not null default 0 check (warning_count >= 0),
  add column rejected_document_count integer not null default 0
    check (rejected_document_count >= 0);

-- Unlock reasons are business history, but user-entered text must not enter the
-- generic append-only audit payload (ADR-0009). Keep transition history in its
-- own inaccessible, append-only relation and expose it only through the query
-- below.
create table public.vat_report_transition (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  company_id uuid not null,
  period text not null,
  vat_report_id uuid not null,
  action text not null check (action in ('vat_report.finalized', 'reporting_period.unlocked')),
  actor_user_id uuid not null,
  occurred_at timestamptz not null default clock_timestamp(),
  unlock_reason text,
  check (
    (action = 'vat_report.finalized' and unlock_reason is null)
    or (action = 'reporting_period.unlocked' and unlock_reason is not null)
  )
);

alter table public.vat_report_transition enable row level security;
revoke all on public.vat_report_transition from public, anon, authenticated, service_role;
grant select on public.vat_report_transition to authenticated;
create policy "members read their companies' VAT Report transitions"
  on public.vat_report_transition for select to authenticated
  using (private.can_access_company(company_id, organization_id));

create function private.prevent_vat_report_transition_change()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  raise exception 'VAT Report transition history is append-only'
    using errcode = '42501';
end;
$$;

create trigger vat_report_transition_append_only
  before update or delete on public.vat_report_transition
  for each row execute function private.prevent_vat_report_transition_change();
create trigger vat_report_transition_no_truncate
  before truncate on public.vat_report_transition
  for each statement execute function private.prevent_vat_report_transition_change();

revoke execute on function private.prevent_vat_report_transition_change() from public;

create function private.reporting_period_readiness_documents(
  target_company_id uuid,
  target_period text
)
returns table (
  document_id uuid,
  status public.document_status,
  extraction_version_id uuid,
  payload jsonb,
  findings jsonb,
  receipt_date date,
  claimed_reporting_period text
)
language sql stable security definer set search_path = ''
as $$
  select
    document.id,
    document.status,
    version.id,
    version.payload,
    version.findings,
    document.receipt_date,
    document.claimed_reporting_period
  from public.document document
  left join lateral (
    select extraction.id, extraction.payload, extraction.findings
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

revoke execute on function private.reporting_period_readiness_documents(uuid, text)
  from public;

create function private.reporting_period_readiness_stats(
  target_company_id uuid,
  target_period text
)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with counted as (
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
    from private.reporting_period_readiness_documents(
      target_company_id,
      target_period
    )
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
    'documentId', document.document_id,
    'status', document.status,
    'extractionVersionId', document.extraction_version_id,
    'receiptDate', document.receipt_date,
    'claimedReportingPeriod', document.claimed_reporting_period
  ) order by document.document_id), '[]'::jsonb)
  from private.reporting_period_readiness_documents(
    target_company_id,
    target_period
  ) document;
$$;

revoke execute on function private.reporting_period_readiness_source(uuid, text)
  from public;

create function private.company_identity_snapshot(target_company_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'name', company.name,
    'firstName', company.first_name,
    'lastName', company.last_name,
    'ico', company.ico,
    'vatId', company.vat_id,
    'streetName', company.street_name,
    'houseNumber', company.house_number,
    'orientationNumber', company.orientation_number,
    'city', company.city,
    'postalCode', company.postal_code,
    'personType', company.person_type
  )
  from public.company company
  where company.id = target_company_id;
$$;

revoke execute on function private.company_identity_snapshot(uuid) from public;

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

  -- The Company lock serializes identity changes. Document locks serialize
  -- review and Extraction Version changes while the canonical snapshot is saved.
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
  ) on conflict (company_id, period) do nothing;

  if found then
    insert into public.vat_report_transition (
      organization_id, company_id, period, vat_report_id, action, actor_user_id
    ) values (
      company.organization_id, company.id, report.period, report.id,
      'vat_report.finalized', auth.uid()
    );
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
    jsonb_build_object('period', target_period)
  );
  insert into public.vat_report_transition (
    organization_id, company_id, period, vat_report_id, action,
    actor_user_id, unlock_reason
  ) values (
    company.organization_id, company.id, target_period, unlocked_report_id,
    'reporting_period.unlocked', auth.uid(), reason
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
      event.vat_report_id,
      event.unlock_reason
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

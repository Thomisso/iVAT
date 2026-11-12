-- Opt-in is a platform preference, never a Membership or an arbitrary address.
create table private.operational_alert_preference (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  locale text not null default 'cs' check (locale in ('cs', 'en'))
);
revoke all on private.operational_alert_preference from public, anon, authenticated, service_role;
alter table private.operational_alert_preference enable row level security;

create function public.operational_alert_preference()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.can_administrate_platform() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select jsonb_build_object('enabled', enabled, 'locale', locale)
    from private.operational_alert_preference where user_id = auth.uid()), '{"enabled":false,"locale":"cs"}'::jsonb);
end;
$$;
create function public.set_operational_alert_preference(alert_enabled boolean, alert_locale text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.can_administrate_platform() then raise exception 'forbidden' using errcode = '42501'; end if;
  if alert_locale is null or alert_locale not in ('cs', 'en') or alert_enabled is null then
    raise exception 'invalid preference' using errcode = 'P0001', hint = 'invalid_alert_preference';
  end if;
  if alert_enabled and not exists (select 1 from auth.users where id = auth.uid()
    and email_confirmed_at is not null and nullif(email, '') is not null and deleted_at is null
    and (banned_until is null or banned_until <= now())
    and nullif(email_change, '') is null) then
    raise exception 'verified current address required' using errcode = 'P0001', hint = 'verified_email_required';
  end if;
  insert into private.operational_alert_preference(user_id, enabled, locale)
    values (auth.uid(), alert_enabled, alert_locale)
    on conflict (user_id) do update set enabled = excluded.enabled, locale = excluded.locale;
  perform private.record_audit_event('operational_alert.preference_changed', null, null, 'user', auth.uid(),
    jsonb_build_object('enabled', alert_enabled, 'locale', alert_locale));
end;
$$;
revoke all on function public.operational_alert_preference(), public.set_operational_alert_preference(boolean, text) from public, anon, authenticated, service_role;
grant execute on function public.operational_alert_preference(), public.set_operational_alert_preference(boolean, text) to authenticated;

-- Shared authoritative readers. Public wrappers retain the human MFA gate;
-- only the private, unexposed readers are available to the narrow alert RPC.
create function private.list_failed_processing_jobs()
returns table (id uuid, name text, target_id uuid, failed_at timestamptz, error text, retry_count integer)
language plpgsql stable security definer set search_path = '' as $$
begin
if to_regclass('pgboss.job') is null then return; end if;
  return query execute $query$
    select job.id, job.name, private.processing_job_target_id(job.name, job.data),
      coalesce(job.completed_on, job.started_on, job.created_on),
      coalesce(job.output ->> 'message', job.output::text, ''), job.retry_count
    from pgboss.job job
    where job.state::text = 'failed'
      and private.is_active_processing_failure(job.name, job.data, coalesce(job.started_on, job.created_on), job.retry_count)
    order by coalesce(job.completed_on, job.started_on, job.created_on) desc, job.id
  $query$;
end;
$$;
revoke all on function private.list_failed_processing_jobs() from public, anon, authenticated, service_role;

create or replace function public.list_failed_processing_jobs()
returns table (id uuid, name text, target_id uuid, failed_at timestamptz, error text, retry_count integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.can_administrate_platform() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query select * from private.list_failed_processing_jobs();
end;
$$;

create or replace function private.list_platform_ai_processing_allowances()
returns table (
  organization_id uuid,
  organization_name text,
  company_id uuid,
  company_name text,
  configuration_id uuid,
  configuration_label text,
  provider text,
  used bigint,
  allowance bigint,
  waiting_documents bigint
)
language plpgsql stable security definer set search_path = ''
as $$
begin
return query
    select organization.id,
      organization.name,
      company.id,
      company.name,
      configuration.id,
      configuration.label,
      configuration.provider,
      private.company_ai_processing_used(company.id),
      company.ai_processing_allowance,
      (select count(*) from public.document document
        where document.company_id = company.id
          and document.status = 'waiting_for_allowance'
          and document.superseded_at is null)
    from public.company company
    join public.organization organization on organization.id = company.organization_id
    left join public.company_ai_configuration assignment on assignment.company_id = company.id
    left join public.ai_configuration configuration on configuration.id = assignment.configuration_id
    where company.deleted_at is null
    order by configuration.label nulls last, organization.name, company.name, company.id;
end;
$$;
revoke all on function private.list_platform_ai_processing_allowances() from public, anon, authenticated, service_role;

create or replace function public.list_platform_ai_processing_allowances()
returns table (
  organization_id uuid,
  organization_name text,
  company_id uuid,
  company_name text,
  configuration_id uuid,
  configuration_label text,
  provider text,
  used bigint,
  allowance bigint,
  waiting_documents bigint
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.can_administrate_platform() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query select * from private.list_platform_ai_processing_allowances();
end;
$$;

create function private.list_platform_ai_processing_issues()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'target_kind', issue.target_kind,
      'target_id', issue.target_id,
      'state', issue.state,
      'classification', issue.classification,
      'company_id', issue.company_id,
      'company_name', company.name,
      'configuration_id', issue.configuration_id,
      'configuration_label', configuration.label,
      'provider', coalesce(configuration.provider, issue.provider),
      'first_detected_at', issue.first_detected_at
    ) order by issue.first_detected_at, issue.target_kind, issue.target_id), '[]'::jsonb)
    from public.ai_processing_issue issue
    join public.company company on company.id = issue.company_id
    left join public.ai_configuration configuration on configuration.id = issue.configuration_id
    where company.deleted_at is null and (
      (issue.target_kind = 'document' and exists (select 1 from public.document target
        where target.id = issue.target_id and target.superseded_at is null
          and target.status::text = case when issue.state = 'terminal' then 'failed' else 'waiting_for_platform' end))
      or (issue.target_kind = 'source_file' and exists (select 1 from public.source_file target
        where target.id = issue.target_id
          and target.status::text = case when issue.state = 'terminal' then 'failed' else 'waiting_for_platform' end))
    )
  );
end;
$$;
revoke all on function private.list_platform_ai_processing_issues() from public, anon, authenticated, service_role;

create or replace function public.list_platform_ai_processing_issues()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.can_administrate_platform() then raise exception 'forbidden' using errcode = '42501'; end if;
  return private.list_platform_ai_processing_issues();
end;
$$;

create or replace function private.list_platform_operational_context()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  failed_jobs jsonb := '[]'::jsonb;
begin
select coalesce(jsonb_agg(jsonb_build_object(
    'name', grouped.name, 'companyId', grouped.company_id,
    'companyName', grouped.company_name, 'affectedCount', grouped.affected_count,
    'firstFailedAt', grouped.first_failed_at, 'targetIds', grouped.target_ids
  ) order by grouped.first_failed_at), '[]'::jsonb) into failed_jobs
  from (
    select job.name, company.id as company_id, company.name as company_name,
      count(distinct job.target_id)::integer as affected_count,
      min(job.failed_at) as first_failed_at,
      jsonb_agg(distinct job.target_id order by job.target_id) as target_ids
    from private.list_failed_processing_jobs() job
    left join public.source_file source on job.name = 'split-source-file' and source.id = job.target_id
    left join public.company_data_export export on job.name = 'complete-company-export' and export.id = job.target_id
    left join public.document document on job.name = 'extract-document' and document.id = job.target_id
    join public.company company on company.id = coalesce(source.company_id, document.company_id, export.company_id)
    group by job.name, company.id, company.name
  ) grouped;

  return jsonb_build_object(
    'companies', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'companyId', company.id,
        'companyName', company.name,
        'aiProcessingEnabled', company.ai_processing_enabled,
        'uploadedDocumentCount', coalesce(waiting.uploaded_count, 0),
        'oldestUploadedAt', waiting.oldest_uploaded_at,
        'oldestWaitingAt', waiting.oldest_waiting_at
      ) order by company.name, company.id), '[]'::jsonb)
      from public.company company
      left join lateral (
        select
          count(*) filter (where document.status = 'uploaded')::integer as uploaded_count,
          min(document.created_at) filter (where document.status = 'uploaded') as oldest_uploaded_at,
          min(document.created_at) as oldest_waiting_at
        from public.document document
        where document.company_id = company.id
          and document.superseded_at is null
          and document.status in ('uploaded', 'waiting_for_allowance', 'waiting_for_platform')
      ) waiting on true
      where company.deleted_at is null
    ),
    'failedJobs', failed_jobs
  );
end;
$$;
revoke all on function private.list_platform_operational_context() from public, anon, authenticated, service_role;

create or replace function public.list_platform_operational_context()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.can_administrate_platform() then raise exception 'forbidden' using errcode = '42501'; end if;
  return private.list_platform_operational_context();
end;
$$;

-- No names, addresses, provider bodies or credentials enter incident state.
create function private.operational_alert_candidates()
returns table (root_key text, kind text, detail_href text, impact jsonb)
language sql stable security definer set search_path = '' as $$
  with allowances as materialized (select * from private.list_platform_ai_processing_allowances()),
  context as materialized (select private.list_platform_operational_context() as value),
  items as (
    select 'allowance_exhausted'::text as kind, coalesce(configuration_id, company_id) as scope,
      ''::text as discriminator, company_id, 'documents'::text as unit, waiting_documents::bigint as count,
      case when configuration_id is null then '/platform/ai-settings#company-' || company_id
        else '/platform/ai-settings#configuration-' || configuration_id end as href
    from allowances where allowance is not null and used >= allowance and waiting_documents > 0
    union all
    select 'waiting_documents', coalesce(allowances.configuration_id, company."companyId"), '', company."companyId",
      'documents', company."uploadedDocumentCount", case when allowances.configuration_id is null
        then '/platform/ai-settings#company-' || company."companyId"
        else '/platform/ai-settings#configuration-' || allowances.configuration_id end
    from context, jsonb_to_recordset(context.value -> 'companies') as company("companyId" uuid, "aiProcessingEnabled" boolean, "uploadedDocumentCount" bigint)
    left join allowances on allowances.company_id = company."companyId"
    where not company."aiProcessingEnabled" and company."uploadedDocumentCount" > 0
    union all
    select issue.classification, coalesce(issue.configuration_id, issue.company_id), '', issue.company_id,
      case when issue.target_kind = 'source_file' then 'sourceFiles' else 'documents' end, 1,
      case when issue.configuration_id is null then '/platform/ai-settings#company-' || issue.company_id
        else '/platform/ai-settings#configuration-' || issue.configuration_id end
    from jsonb_to_recordset(private.list_platform_ai_processing_issues()) as issue(
      classification text, configuration_id uuid, company_id uuid, target_kind text, state text)
    where issue.state = 'terminal' or issue.classification <> 'provider_unavailable'
    union all
    select case when job.name = 'complete-company-export' then 'failed_company_export' else 'terminal_processing_job' end,
      case when job.name = 'complete-company-export' then job."companyId" else coalesce(allowances.configuration_id, job."companyId") end,
      job.name, job."companyId", case job.name when 'complete-company-export' then 'exportJobs'
        when 'split-source-file' then 'sourceFiles' else 'documents' end, job."affectedCount", '/platform/administration#failed-jobs'
    from context, jsonb_to_recordset(context.value -> 'failedJobs') as job(name text, "companyId" uuid, "affectedCount" bigint)
    left join allowances on allowances.company_id = job."companyId"
    where job."affectedCount" > 0
  )
  select concat_ws(':', items.kind, scope::text, nullif(discriminator, '')), items.kind, min(href),
    jsonb_build_object('companies', count(distinct company_id),
      'documents', coalesce(sum(count) filter (where unit = 'documents'), 0),
      'sourceFiles', coalesce(sum(count) filter (where unit = 'sourceFiles'), 0),
      'exportJobs', coalesce(sum(count) filter (where unit = 'exportJobs'), 0))
  from items group by items.kind, scope, discriminator;
$$;
revoke all on function private.operational_alert_candidates() from public, anon, authenticated, service_role;

create table private.operational_alert_episode (
  id uuid primary key default gen_random_uuid(),
  root_key text not null,
  kind text not null,
  detail_href text not null,
  impact jsonb not null,
  eligible_since timestamptz not null,
  last_observed_at timestamptz not null,
  resolved_at timestamptz
);
create unique index operational_alert_one_active_root on private.operational_alert_episode(root_key) where resolved_at is null;
create table private.operational_alert_outbox (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references private.operational_alert_episode(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'first' check (kind in ('first')),
  state text not null default 'pending' check (state in ('pending', 'sending', 'accepted', 'refused', 'failed', 'unknown', 'cancelled')),
  claim_token uuid,
  dispatch_started_at timestamptz,
  finished_at timestamptz,
  unique (episode_id, user_id, kind)
);
revoke all on private.operational_alert_episode, private.operational_alert_outbox from public, anon, authenticated, service_role;
alter table private.operational_alert_episode enable row level security;
alter table private.operational_alert_outbox enable row level security;

-- Observe intervening resolutions even if no worker tick saw the quiet period.
-- Count changes while any work in the shared root is blocked preserve identity.
create function private.close_resolved_operational_alerts()
returns void language sql security definer set search_path = '' as $$
  update private.operational_alert_episode episode set resolved_at = clock_timestamp()
  where resolved_at is null and not exists (
    select 1 from private.operational_alert_candidates() current where current.root_key = episode.root_key
  );
  update private.operational_alert_outbox delivery set state = 'cancelled', finished_at = clock_timestamp()
  from private.operational_alert_episode episode
  where delivery.episode_id = episode.id and episode.resolved_at is not null and delivery.state = 'pending';
$$;
create function private.observe_operational_alert_resolution()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- No scans before the first observation has established an active episode.
  if exists (select 1 from private.operational_alert_episode where resolved_at is null) then
    perform private.close_resolved_operational_alerts();
  end if;
  return null;
end;
$$;
revoke all on function private.close_resolved_operational_alerts(), private.observe_operational_alert_resolution() from public, anon, authenticated, service_role;
create trigger alert_document_resolution after insert or update or delete on public.document for each statement execute function private.observe_operational_alert_resolution();
create trigger alert_source_resolution after insert or update or delete on public.source_file for each statement execute function private.observe_operational_alert_resolution();
create trigger alert_company_resolution after update or delete on public.company for each statement execute function private.observe_operational_alert_resolution();
create trigger alert_issue_resolution after insert or update or delete on public.ai_processing_issue for each statement execute function private.observe_operational_alert_resolution();
create trigger alert_assignment_resolution after insert or update or delete on public.company_ai_configuration for each statement execute function private.observe_operational_alert_resolution();
create trigger alert_export_resolution after insert or update or delete on public.company_data_export for each statement execute function private.observe_operational_alert_resolution();

create function private.operational_alert_recipient(target_user_id uuid)
returns table (email text, locale text) language sql stable security definer set search_path = '' as $$
  select account.email::text, preference.locale
  from private.operational_alert_preference preference
  join auth.users account on account.id = preference.user_id
  where preference.user_id = target_user_id and preference.enabled
    and private.is_super_admin(account.id) and account.deleted_at is null
    and (account.banned_until is null or account.banned_until <= now())
    and account.email_confirmed_at is not null and nullif(account.email, '') is not null
    and nullif(account.email_change, '') is null;
$$;
revoke all on function private.operational_alert_recipient(uuid) from public, anon, authenticated, service_role;

create function public.reconcile_operational_alerts(observed_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare candidate record;
begin
  if auth.role() <> 'service_role' then raise exception 'forbidden' using errcode = '42501'; end if;
  if observed_at is null then raise exception 'invalid observation' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(321, 1);
  -- pg-boss owns its schema and may be initialized after application migrations.
  if to_regclass('pgboss.job') is not null and not exists (select 1 from pg_trigger
      where tgrelid = to_regclass('pgboss.job') and tgname = 'alert_job_resolution') then
    execute 'create trigger alert_job_resolution after insert or update or delete on pgboss.job for each statement execute function private.observe_operational_alert_resolution()';
  end if;
  perform private.close_resolved_operational_alerts();
  for candidate in select * from private.operational_alert_candidates() order by root_key loop
    insert into private.operational_alert_episode(root_key, kind, detail_href, impact, eligible_since, last_observed_at)
      values(candidate.root_key, candidate.kind, candidate.detail_href, candidate.impact, observed_at, observed_at)
      on conflict (root_key) where resolved_at is null do update
      set impact = excluded.impact, detail_href = excluded.detail_href,
        last_observed_at = greatest(operational_alert_episode.last_observed_at, excluded.last_observed_at);
  end loop;
  -- A crashed claim is uncertain, never eligible for automatic resend.
  update private.operational_alert_outbox set state = 'unknown', finished_at = observed_at
    where state = 'sending' and dispatch_started_at <= observed_at - interval '2 minutes';
  insert into private.operational_alert_outbox(episode_id, user_id)
    select episode.id, preference.user_id from private.operational_alert_episode episode
    cross join private.operational_alert_preference preference
    where episode.resolved_at is null and episode.eligible_since <= observed_at - interval '5 minutes'
      and exists(select 1 from private.operational_alert_recipient(preference.user_id))
    on conflict (episode_id, user_id, kind) do nothing;
  return (select coalesce(jsonb_agg(id order by id), '[]'::jsonb) from private.operational_alert_outbox where state = 'pending');
end;
$$;

-- Claim and authorize one recipient immediately before handing bytes to SMTP.
create function public.claim_operational_alert(target_delivery_id uuid, observed_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare delivery private.operational_alert_outbox; episode private.operational_alert_episode;
  recipient record; candidate record; token uuid := gen_random_uuid();
begin
  if auth.role() <> 'service_role' then raise exception 'forbidden' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(321, 1);
  select * into delivery from private.operational_alert_outbox where id = target_delivery_id for update;
  if not found or delivery.state <> 'pending' then return null; end if;
  select * into episode from private.operational_alert_episode where id = delivery.episode_id;
  select * into recipient from private.operational_alert_recipient(delivery.user_id);
  if not found or episode.resolved_at is not null then
    update private.operational_alert_outbox set state = 'cancelled', finished_at = observed_at where id = delivery.id;
    return null;
  end if;
  select * into candidate from private.operational_alert_candidates() where root_key = episode.root_key;
  if not found then
    perform private.close_resolved_operational_alerts();
    return null;
  end if;
  update private.operational_alert_outbox set state = 'sending', claim_token = token, dispatch_started_at = observed_at where id = delivery.id;
  return jsonb_build_object('id', delivery.id, 'claimToken', token, 'episodeId', episode.id,
    'email', recipient.email, 'locale', recipient.locale, 'kind', candidate.kind,
    'detailHref', candidate.detail_href, 'impact', candidate.impact);
end;
$$;
create function public.finish_operational_alert(target_delivery_id uuid, target_claim_token uuid, transport_outcome text, observed_at timestamptz default now())
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then raise exception 'forbidden' using errcode = '42501'; end if;
  if transport_outcome not in ('accepted', 'refused', 'failed', 'unknown') or transport_outcome is null then
    raise exception 'invalid transport outcome' using errcode = '22023';
  end if;
  update private.operational_alert_outbox set state = transport_outcome, finished_at = observed_at
    where id = target_delivery_id and claim_token = target_claim_token and state in ('sending', 'unknown');
end;
$$;
revoke all on function public.reconcile_operational_alerts(timestamptz), public.claim_operational_alert(uuid, timestamptz), public.finish_operational_alert(uuid, uuid, text, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.reconcile_operational_alerts(timestamptz), public.claim_operational_alert(uuid, timestamptz), public.finish_operational_alert(uuid, uuid, text, timestamptz) to service_role;

-- Protected observable delivery metadata for the subscriber, without addresses.
create function public.operational_alert_deliveries()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.can_administrate_platform() then raise exception 'forbidden' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', delivery.id, 'episodeId', episode.id,
    'kind', episode.kind, 'state', delivery.state, 'eligibleSince', episode.eligible_since,
    'resolvedAt', episode.resolved_at, 'impact', episode.impact) order by episode.eligible_since, delivery.id), '[]'::jsonb)
    from private.operational_alert_outbox delivery join private.operational_alert_episode episode on episode.id = delivery.episode_id
    where delivery.user_id = auth.uid());
end;
$$;
revoke all on function public.operational_alert_deliveries() from public, anon, authenticated, service_role;
grant execute on function public.operational_alert_deliveries() to authenticated;

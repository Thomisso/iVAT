-- Resolve a configuration scope through the indexed assignment relation;
-- singleton scopes have no assignment. Never scan all Companies to find one.
create function private.operational_alert_companies(target_scope uuid)
returns setof public.company language sql stable security definer set search_path = '' as $$
  select company.* from public.company company
  where company.deleted_at is null and company.id in (
    select assignment.company_id from public.company_ai_configuration assignment where assignment.configuration_id = target_scope
    union all select target_scope where not exists (
      select 1 from public.company_ai_configuration assignment where assignment.company_id = target_scope
    )
  );
$$;
revoke all on function private.operational_alert_companies(uuid) from public, anon, authenticated, service_role;

-- Keep current issue eligibility authoritative for both the human inventory
-- and bounded root checks; transient issues still remain visible in-app.
create function private.is_active_ai_processing_issue(target_issue public.ai_processing_issue)
returns boolean language sql stable security definer set search_path = '' as $$
  select (
    ((target_issue).target_kind = 'document' and exists (select 1 from public.document target
      where target.id = (target_issue).target_id and target.superseded_at is null
        and target.status::text = case when (target_issue).state = 'terminal' then 'failed' else 'waiting_for_platform' end))
    or ((target_issue).target_kind = 'source_file' and exists (select 1 from public.source_file target
      where target.id = (target_issue).target_id
        and target.status::text = case when (target_issue).state = 'terminal' then 'failed' else 'waiting_for_platform' end))
  );
$$;
revoke all on function private.is_active_ai_processing_issue(public.ai_processing_issue) from public, anon, authenticated, service_role;

create or replace function private.list_platform_ai_processing_issues()
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
    where company.deleted_at is null and private.is_active_ai_processing_issue(issue)
  );
end;
$$;

-- A synchronous resolution check must not rebuild every tenant's platform
-- inventory for every Document and its nested Company revision update.
-- Root existence has the same eligibility as operational_alert_candidates,
-- but needs neither impact counts, labels nor unrelated Company rows.
create function private.operational_alert_root_is_active(target_root_key text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  kind text := split_part(target_root_key, ':', 1);
  scope_id uuid := split_part(target_root_key, ':', 2)::uuid;
  job_name text := split_part(target_root_key, ':', 3);
  active boolean;
begin
  if kind in ('allowance_exhausted', 'waiting_documents') then
    return exists (
      select 1 from private.operational_alert_companies(scope_id) company
      where case kind
          when 'allowance_exhausted' then company.ai_processing_allowance is not null
            and private.company_ai_processing_used(company.id) >= company.ai_processing_allowance
            and exists (select 1 from public.document document where document.company_id = company.id
              and document.superseded_at is null and document.status = 'waiting_for_allowance')
          else not company.ai_processing_enabled
            and exists (select 1 from public.document document where document.company_id = company.id
              and document.superseded_at is null and document.status = 'uploaded')
        end
    );
  elsif kind in ('terminal_processing_job', 'failed_company_export') then
    if to_regclass('pgboss.job') is null then return false; end if;
    -- Reuse exact-attempt/generation/receipt eligibility, including a Company
    -- revision invalidating a failed export. A JSON body never leaves SQL.
    execute $query$
      select exists (
        select 1 from pgboss.job job
        left join public.source_file source on job.name = 'split-source-file'
          and source.id = private.processing_job_target_id(job.name, job.data)
        left join public.document document on job.name = 'extract-document'
          and document.id = private.processing_job_target_id(job.name, job.data)
        left join public.company_data_export export on job.name = 'complete-company-export'
          and export.id = private.processing_job_target_id(job.name, job.data)
        join public.company company on company.id = coalesce(source.company_id, document.company_id, export.company_id)
        left join public.company_ai_configuration assignment on assignment.company_id = company.id
        where job.state::text = 'failed' and job.name = $1 and company.deleted_at is null
          and case when $2 = 'failed_company_export' then company.id
            else coalesce(assignment.configuration_id, company.id) end = $3
          and private.is_active_processing_failure(job.name, job.data,
            coalesce(job.started_on, job.created_on), job.retry_count)
      )
    $query$ into active using job_name, kind, scope_id;
    return active;
  else
    return exists (
      select 1 from public.ai_processing_issue issue
      join public.company company on company.id = issue.company_id
      where company.deleted_at is null
        and (issue.configuration_id = scope_id or (issue.configuration_id is null and issue.company_id = scope_id))
        and issue.classification::text = kind
        and (issue.state = 'terminal' or issue.classification <> 'provider_unavailable')
        and private.is_active_ai_processing_issue(issue)
    );
  end if;
end;
$$;
revoke all on function private.operational_alert_root_is_active(text) from public, anon, authenticated, service_role;

create function private.close_resolved_operational_alerts(target_scopes uuid[], exports_only boolean default false)
returns void language sql security definer set search_path = '' as $$
  with resolved as (
    update private.operational_alert_episode episode set resolved_at = clock_timestamp()
    where resolved_at is null
      and (target_scopes is null or split_part(root_key, ':', 2)::uuid = any(target_scopes))
      and (not exports_only or kind = 'failed_company_export')
      and not private.operational_alert_root_is_active(root_key)
    returning id
  )
  update private.operational_alert_outbox delivery set state = 'cancelled', finished_at = clock_timestamp()
  where delivery.state = 'pending' and delivery.episode_id in (select id from resolved);
$$;
revoke all on function private.close_resolved_operational_alerts(uuid[], boolean) from public, anon, authenticated, service_role;

create or replace function private.close_resolved_operational_alerts()
returns void language sql security definer set search_path = '' as $$
  select private.close_resolved_operational_alerts(null::uuid[]);
$$;

-- Collect only scope identities, never financial data or recipients. The rows
-- belong to one transaction, are unexposed, and are removed before it commits.
create table private.operational_alert_resolution_observation (
  transaction_id xid8 not null,
  scope_id uuid not null,
  exports_only boolean not null,
  primary key (transaction_id, scope_id)
);
revoke all on private.operational_alert_resolution_observation from public, anon, authenticated, service_role;
alter table private.operational_alert_resolution_observation enable row level security;

create function private.flush_operational_alert_resolution()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  work_scopes uuid[];
  export_scopes uuid[];
begin
  select array_agg(scope_id) filter (where not exports_only),
    array_agg(scope_id) filter (where exports_only)
  into work_scopes, export_scopes
  from private.operational_alert_resolution_observation where transaction_id = pg_current_xact_id();
  if work_scopes is null and export_scopes is null then return null; end if;

  -- All Company/Source/queue mutations are finished before taking the alert
  -- lock. A second committer waits here without either transaction needing any
  -- more Company locks, then gets a fresh READ COMMITTED snapshot for its check.
  -- The same lock excludes reconcile/claim creating or dispatching a stale root.
  perform pg_advisory_xact_lock(321, 1);
  delete from private.operational_alert_resolution_observation where transaction_id = pg_current_xact_id();
  if work_scopes is not null then perform private.close_resolved_operational_alerts(work_scopes); end if;
  if export_scopes is not null then perform private.close_resolved_operational_alerts(export_scopes, true); end if;
  return null;
end;
$$;
revoke all on function private.flush_operational_alert_resolution() from public, anon, authenticated, service_role;
create constraint trigger flush_operational_alert_resolution
  after insert on private.operational_alert_resolution_observation
  deferrable initially deferred for each row execute function private.flush_operational_alert_resolution();

create or replace function private.observe_operational_alert_resolution()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  previous jsonb;
  current jsonb;
  company_ids uuid[];
  scope_ids uuid[];
  exports_only boolean := false;
  job jsonb;
  target_id uuid;
  company_id uuid;
begin
  if tg_op <> 'INSERT' then previous := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then current := to_jsonb(new); end if;
  if tg_table_schema = 'pgboss' then
    for job in select value from jsonb_array_elements(jsonb_build_array(previous, current)) where value <> 'null'::jsonb loop
      target_id := private.processing_job_target_id(job ->> 'name', job -> 'data');
      case job ->> 'name'
        when 'split-source-file' then select source.company_id into company_id from public.source_file source where source.id = target_id;
        when 'extract-document' then select document.company_id into company_id from public.document document where document.id = target_id;
        when 'complete-company-export' then select export.company_id into company_id from public.company_data_export export where export.id = target_id;
        else company_id := null;
      end case;
      company_ids := array_append(company_ids, company_id);
    end loop;
  elsif tg_table_name = 'company' then
    company_ids := array[(previous ->> 'id')::uuid, (current ->> 'id')::uuid];
    -- Revision changes cannot resolve allowance/configuration work, but CAN
    -- invalidate a failed export receipt. Keep that observation synchronous.
    exports_only := tg_op = 'UPDATE' and previous - 'data_revision' = current - 'data_revision';
  else
    company_ids := array[(previous ->> 'company_id')::uuid, (current ->> 'company_id')::uuid];
  end if;
  select array_agg(distinct scope) into scope_ids from (
    select unnest(company_ids) as scope
    union all select assignment.configuration_id from public.company_ai_configuration assignment where assignment.company_id = any(company_ids)
    union all select issue.configuration_id from public.ai_processing_issue issue where issue.company_id = any(company_ids)
    union all select (previous ->> 'configuration_id')::uuid
    union all select (current ->> 'configuration_id')::uuid
  ) scopes where scope is not null;
  -- Scope membership includes OLD assignments/issues as well as NEW ones.
  -- Root existence checks every Company still in that shared root, so partial
  -- remediation preserves the original episode and grace period.
  -- Record even when no episode is currently visible: a concurrent worker may
  -- observe the old committed work before this transaction commits. The commit
  -- check must serialize with that new observation as well.
  insert into private.operational_alert_resolution_observation as observation (transaction_id, scope_id, exports_only)
  select pg_current_xact_id(), scope, exports_only from unnest(scope_ids) scope
  on conflict (transaction_id, scope_id) do update set exports_only = false
    where observation.exports_only and not excluded.exports_only;
  return null;
end;
$$;

-- Row transition identities keep collection bounded during bulk writes. The
-- deferred constraint flush finishes before the public command commits/returns,
-- independently of worker ticks, without locking alert state mid-mutation.
drop trigger alert_document_resolution on public.document;
create trigger alert_document_resolution after insert or update or delete on public.document for each row execute function private.observe_operational_alert_resolution();
drop trigger alert_source_resolution on public.source_file;
create trigger alert_source_resolution after insert or update or delete on public.source_file for each row execute function private.observe_operational_alert_resolution();
drop trigger alert_company_resolution on public.company;
create trigger alert_company_resolution after update or delete on public.company for each row execute function private.observe_operational_alert_resolution();
drop trigger alert_issue_resolution on public.ai_processing_issue;
create trigger alert_issue_resolution after insert or update or delete on public.ai_processing_issue for each row execute function private.observe_operational_alert_resolution();
drop trigger alert_assignment_resolution on public.company_ai_configuration;
create trigger alert_assignment_resolution after insert or update or delete on public.company_ai_configuration for each row execute function private.observe_operational_alert_resolution();
drop trigger alert_export_resolution on public.company_data_export;
create trigger alert_export_resolution after insert or update or delete on public.company_data_export for each row execute function private.observe_operational_alert_resolution();
do $$ begin
  if to_regclass('pgboss.job') is not null then
    execute 'drop trigger if exists alert_job_resolution on pgboss.job';
    execute 'create trigger alert_job_resolution after insert or update or delete on pgboss.job for each row execute function private.observe_operational_alert_resolution()';
  end if;
end $$;

-- Preserve late pg-boss initialization with the same row-scoped observer.
create or replace function public.reconcile_operational_alerts(observed_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare candidate record;
begin
  if auth.role() <> 'service_role' then raise exception 'forbidden' using errcode = '42501'; end if;
  if observed_at is null then raise exception 'invalid observation' using errcode = '22023'; end if;
  -- Install before the alert lock: CREATE TRIGGER needs a queue-table lock,
  -- while a queue mutation may already hold that table and be awaiting its
  -- commit-time alert check. Installation has its own consistent lock order.
  if to_regclass('pgboss.job') is not null and not exists (select 1 from pg_trigger
      where tgrelid = to_regclass('pgboss.job') and tgname = 'alert_job_resolution') then
    perform pg_advisory_xact_lock(321, 2);
    if not exists (select 1 from pg_trigger where tgrelid = to_regclass('pgboss.job') and tgname = 'alert_job_resolution') then
      execute 'create trigger alert_job_resolution after insert or update or delete on pgboss.job for each row execute function private.observe_operational_alert_resolution()';
    end if;
  end if;
  perform pg_advisory_xact_lock(321, 1);
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

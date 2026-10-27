-- AI usage metering (#31): one immutable event per successful provider call.
-- Aggregation stays in PostgreSQL so totals cannot be truncated by PostgREST.

create table public.ai_usage_event (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organization (id),
  company_id uuid not null,
  provider text not null check (length(trim(provider)) > 0),
  model text not null check (length(trim(model)) > 0),
  operation text not null check (operation in ('split', 'extract')),
  requests integer not null default 1 check (requests > 0),
  input_tokens bigint not null check (input_tokens >= 0),
  output_tokens bigint not null check (output_tokens >= 0),
  job_name text not null check (job_name in ('split-source-file', 'extract-document')),
  job_target_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.company (id, organization_id)
);

create index ai_usage_event_organization_created_idx
  on public.ai_usage_event (organization_id, created_at);
create index ai_usage_event_company_created_idx
  on public.ai_usage_event (company_id, created_at);

revoke all on public.ai_usage_event from anon, authenticated;
grant select on public.ai_usage_event to authenticated;
alter table public.ai_usage_event enable row level security;

create policy "organization administrators read AI usage"
  on public.ai_usage_event for select to authenticated
  using (private.is_organization_administrator(organization_id));

create function public.record_ai_usage(
  target_organization_id uuid,
  target_company_id uuid,
  target_provider text,
  target_model text,
  target_operation text,
  target_input_tokens bigint,
  target_output_tokens bigint,
  target_job_name text,
  target_job_id uuid
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.ai_usage_event (
    organization_id, company_id, provider, model, operation,
    input_tokens, output_tokens, job_name, job_target_id
  ) values (
    target_organization_id, target_company_id, target_provider, target_model,
    target_operation, target_input_tokens, target_output_tokens,
    target_job_name, target_job_id
  );
end;
$$;

revoke execute on function public.record_ai_usage(uuid, uuid, text, text, text, bigint, bigint, text, uuid)
  from public, anon, authenticated;
grant execute on function public.record_ai_usage(uuid, uuid, text, text, text, bigint, bigint, text, uuid)
  to service_role;

create function public.list_organization_ai_usage(
  target_organization_id uuid,
  period_from date,
  period_to date,
  target_company_id uuid default null
)
returns table (
  company_id uuid,
  company_name text,
  provider text,
  model text,
  requests bigint,
  input_tokens bigint,
  output_tokens bigint
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_organization_administrator(target_organization_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if period_to <= period_from then
    raise exception 'invalid period' using errcode = 'P0001', hint = 'invalid_period';
  end if;
  return query
    select e.company_id, c.name, e.provider, e.model,
      sum(e.requests)::bigint,
      sum(e.input_tokens)::bigint,
      sum(e.output_tokens)::bigint
    from public.ai_usage_event e
    join public.company c on c.id = e.company_id
    where e.organization_id = target_organization_id
      and e.created_at >= period_from::timestamptz
      and e.created_at < period_to::timestamptz
      and (target_company_id is null or e.company_id = target_company_id)
    group by e.company_id, c.name, e.provider, e.model
    order by c.name, e.provider, e.model;
end;
$$;

revoke execute on function public.list_organization_ai_usage(uuid, date, date, uuid)
  from public, anon;
grant execute on function public.list_organization_ai_usage(uuid, date, date, uuid)
  to authenticated;

create function public.list_platform_ai_usage(period_from date, period_to date)
returns table (
  organization_id uuid,
  organization_name text,
  provider text,
  model text,
  requests bigint,
  input_tokens bigint,
  output_tokens bigint
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if period_to <= period_from then
    raise exception 'invalid period' using errcode = 'P0001', hint = 'invalid_period';
  end if;
  return query
    select e.organization_id, o.name, e.provider, e.model,
      sum(e.requests)::bigint,
      sum(e.input_tokens)::bigint,
      sum(e.output_tokens)::bigint
    from public.ai_usage_event e
    join public.organization o on o.id = e.organization_id
    where e.created_at >= period_from::timestamptz
      and e.created_at < period_to::timestamptz
    group by e.organization_id, o.name, e.provider, e.model
    order by o.name, e.provider, e.model;
end;
$$;

revoke execute on function public.list_platform_ai_usage(date, date) from public, anon;
grant execute on function public.list_platform_ai_usage(date, date) to authenticated;

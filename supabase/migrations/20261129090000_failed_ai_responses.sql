-- The raw body an AI provider returned when Split or Extraction failed on it,
-- so a SuperAdmin can see why from the operational problems (ADR-0014).
-- One row per target: a later failed attempt replaces it, and it is deleted as
-- soon as the target leaves failure-prone processing or is deleted itself.

create table public.ai_failed_response (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  company_id uuid not null,
  source_file_id uuid references public.source_file (id) on delete cascade,
  document_id uuid references public.document (id) on delete cascade,
  request_id uuid not null,
  provider text not null check (length(trim(provider)) > 0),
  model text,
  error text not null,
  response text not null,
  recorded_at timestamptz not null default now(),
  check (num_nonnulls(source_file_id, document_id) = 1),
  foreign key (company_id, organization_id)
    references public.company (id, organization_id) on delete cascade
);

create unique index ai_failed_response_source_file_idx
  on public.ai_failed_response (source_file_id) where source_file_id is not null;
create unique index ai_failed_response_document_idx
  on public.ai_failed_response (document_id) where document_id is not null;
create index ai_failed_response_company_idx on public.ai_failed_response (company_id);

revoke all on public.ai_failed_response from anon, authenticated, service_role;
alter table public.ai_failed_response enable row level security;

-- Bodies are bounded so one oversized provider error cannot bloat the table.
create function public.record_ai_failed_response(
  target_kind public.ai_processing_target_kind,
  target_id uuid,
  target_request_id uuid,
  target_provider text,
  target_error text,
  target_response text,
  target_model text default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target_organization_id uuid;
  target_company_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if target_kind = 'source_file' then
    select organization_id, company_id into target_organization_id, target_company_id
    from public.source_file
    where id = target_id and split_request_id = target_request_id;
    if not found then return; end if;
    insert into public.ai_failed_response (
      organization_id, company_id, source_file_id, request_id, provider, model, error, response
    ) values (
      target_organization_id, target_company_id, target_id, target_request_id, target_provider,
      target_model, left(target_error, 2000), left(target_response, 65536)
    )
    on conflict (source_file_id) where source_file_id is not null do update
    set request_id = excluded.request_id,
        provider = excluded.provider,
        model = excluded.model,
        error = excluded.error,
        response = excluded.response,
        recorded_at = now();
  else
    select organization_id, company_id into target_organization_id, target_company_id
    from public.document
    where id = target_id and extraction_request_id = target_request_id and superseded_at is null;
    if not found then return; end if;
    insert into public.ai_failed_response (
      organization_id, company_id, document_id, request_id, provider, model, error, response
    ) values (
      target_organization_id, target_company_id, target_id, target_request_id, target_provider,
      target_model, left(target_error, 2000), left(target_response, 65536)
    )
    on conflict (document_id) where document_id is not null do update
    set request_id = excluded.request_id,
        provider = excluded.provider,
        model = excluded.model,
        error = excluded.error,
        response = excluded.response,
        recorded_at = now();
  end if;
end;
$$;
revoke all on function public.record_ai_failed_response(public.ai_processing_target_kind, uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_ai_failed_response(public.ai_processing_target_kind, uuid, uuid, text, text, text, text) to service_role;

-- Only the current request generation of a target that has not succeeded.
create function public.list_ai_failed_responses()
returns table (
  target_kind public.ai_processing_target_kind,
  target_id uuid,
  provider text,
  model text,
  error text,
  response text,
  recorded_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select 'source_file'::public.ai_processing_target_kind, source.id, failure.provider, failure.model,
      failure.error, failure.response, failure.recorded_at
    from public.ai_failed_response failure
    join public.source_file source
      on source.id = failure.source_file_id and source.split_request_id = failure.request_id
    union all
    select 'document'::public.ai_processing_target_kind, document.id, failure.provider, failure.model,
      failure.error, failure.response, failure.recorded_at
    from public.ai_failed_response failure
    join public.document document
      on document.id = failure.document_id and document.extraction_request_id = failure.request_id
    where document.superseded_at is null
    order by 7 desc;
end;
$$;
revoke all on function public.list_ai_failed_responses() from public, anon, service_role;
grant execute on function public.list_ai_failed_responses() to authenticated;

-- Once a target is processed (or superseded), its failed response is no longer
-- diagnosis material and holds Document data nobody needs: delete it.
create function private.forget_ai_failed_response()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_table_name = 'document' then
    if new.superseded_at is not null
      or new.status not in ('uploaded', 'waiting_for_allowance', 'waiting_for_platform', 'processing', 'failed') then
      delete from public.ai_failed_response where document_id = new.id;
    end if;
  elsif new.status not in ('uploaded', 'waiting_for_platform', 'processing', 'failed') then
    delete from public.ai_failed_response where source_file_id = new.id;
  end if;
  return null;
end;
$$;
revoke all on function private.forget_ai_failed_response() from public, anon, authenticated, service_role;

create trigger document_forget_ai_failed_response
  after update of status, superseded_at on public.document
  for each row execute function private.forget_ai_failed_response();
create trigger source_file_forget_ai_failed_response
  after update of status on public.source_file
  for each row execute function private.forget_ai_failed_response();

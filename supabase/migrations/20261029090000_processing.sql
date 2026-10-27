-- Processing (ADR-0004): the worker Splits each Source File into Documents and
-- runs Extraction per Document, storing immutable Extraction Versions (ADR-0005).
-- The worker acts as service_role. It changes processing state only through the
-- functions below, so the transitions stay atomic and idempotent: a retried job
-- never creates duplicate Documents or Extraction Versions.
--
-- AI processing is opt-in per Company (ADR-0006). The consent names the provider
-- and region that receive the Documents; the worker processes nothing without it.

-- AI-processing consent --------------------------------------------------------

alter table public.company
  add column ai_processing_enabled boolean not null default false,
  add column ai_provider text,
  add column ai_region text,
  add constraint company_ai_consent_names_provider check (
    (ai_processing_enabled and ai_provider is not null and ai_region is not null)
    or (not ai_processing_enabled and ai_provider is null and ai_region is null)
  );

-- A Company Administrator, or an Administrator of the Company's Organization.
create function private.is_company_administrator(target_company_id uuid, target_organization_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_organization_administrator(target_organization_id)
    or exists (
      select 1 from public.membership m
      where m.user_id = auth.uid() and m.company_id = target_company_id and m.role = 'administrator'
    );
$$;

revoke execute on function private.is_company_administrator from public;
grant execute on function private.is_company_administrator(uuid, uuid) to authenticated;

grant update (ai_processing_enabled, ai_provider, ai_region) on public.company to authenticated;

create policy "company administrators set ai processing consent" on public.company
  for update to authenticated
  using (private.is_company_administrator(id, organization_id))
  with check (private.is_company_administrator(id, organization_id));

create function private.audit_company_ai_processing_changed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.ai_processing_enabled then
    perform private.record_audit_event(
      'company.ai_processing_enabled', new.organization_id, new.id, 'company', new.id,
      jsonb_build_object('provider', new.ai_provider, 'region', new.ai_region)
    );
  else
    perform private.record_audit_event(
      'company.ai_processing_disabled', new.organization_id, new.id, 'company', new.id,
      jsonb_build_object('provider', old.ai_provider, 'region', old.ai_region)
    );
  end if;
  return new;
end;
$$;

create trigger company_ai_processing_changed_audit
  after update of ai_processing_enabled, ai_provider, ai_region on public.company
  for each row
  when (old.ai_processing_enabled is distinct from new.ai_processing_enabled
    or old.ai_provider is distinct from new.ai_provider
    or old.ai_region is distinct from new.ai_region)
  execute function private.audit_company_ai_processing_changed();

-- Source File Split status -----------------------------------------------------

-- uploaded: waiting for Split; processing: Split running; split: Documents recorded;
-- failed: Split failed for technical reasons and can be retried.
create type public.source_file_status as enum ('uploaded', 'processing', 'split', 'failed');

alter table public.source_file
  add column status public.source_file_status not null default 'uploaded',
  add constraint source_file_tenant_key unique (id, company_id, organization_id);

-- Documents --------------------------------------------------------------------

-- uploaded: waiting for Extraction; processing: Extraction running;
-- needs_review: an AI Extraction Version awaits review; failed: technical failure, retryable.
create type public.document_status as enum ('uploaded', 'processing', 'needs_review', 'failed');

create table public.document (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  company_id uuid not null,
  source_file_id uuid not null,
  first_page integer not null check (first_page >= 1),
  last_page integer not null,
  status public.document_status not null default 'uploaded',
  -- The Extraction run currently asked for. A job records its result only for
  -- this request, and only once, so retried and repeated jobs converge.
  extraction_request_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  check (last_page >= first_page),
  foreign key (source_file_id, company_id, organization_id)
    references public.source_file (id, company_id, organization_id),
  unique (source_file_id, first_page),
  unique (id, company_id, organization_id)
);

create index document_company_id_idx on public.document (company_id, status);

create table public.extraction_version (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  company_id uuid not null,
  document_id uuid not null,
  version integer not null check (version >= 1),
  -- Author: an AI provider and model (with the request that produced it), or a User.
  provider text,
  model text,
  extraction_request_id uuid,
  author_user_id uuid,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  check (
    (provider is not null and model is not null and extraction_request_id is not null and author_user_id is null)
    or (provider is null and model is null and extraction_request_id is null and author_user_id is not null)
  ),
  foreign key (document_id, company_id, organization_id)
    references public.document (id, company_id, organization_id),
  unique (document_id, version),
  unique (document_id, extraction_request_id)
);

-- Extraction Versions are immutable, even for privileged roles (ADR-0005).
create function private.prevent_extraction_version_change()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  raise exception 'extraction_version is immutable' using errcode = '42501';
end;
$$;

create trigger extraction_version_immutable
  before update or delete on public.extraction_version
  for each row execute function private.prevent_extraction_version_change();

create trigger extraction_version_no_truncate
  before truncate on public.extraction_version
  for each statement execute function private.prevent_extraction_version_change();

revoke execute on function private.prevent_extraction_version_change, private.audit_company_ai_processing_changed
  from public;

-- Privileges: users read; the worker (service_role) reads and moves statuses,
-- and records results only through the functions below.

revoke all on public.document, public.extraction_version from anon, authenticated, service_role;
grant select on public.document, public.extraction_version to authenticated;
grant select on public.document, public.extraction_version to service_role;
grant update (status) on public.document to service_role;

revoke all on public.source_file from service_role;
grant select, update (status) on public.source_file to service_role;

alter table public.document enable row level security;
alter table public.extraction_version enable row level security;

create policy "company members read documents" on public.document
  for select to authenticated
  using (private.can_access_company(company_id, organization_id));

create policy "company members read extraction versions" on public.extraction_version
  for select to authenticated
  using (private.can_access_company(company_id, organization_id));

-- Worker transitions -----------------------------------------------------------

-- Records the Split of a Source File: one Document per page range, in page order.
-- A Source File is Split once; recording it again changes nothing.
create function public.record_split(target_source_file_id uuid, page_ranges jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  file public.source_file;
  range jsonb;
  previous_last_page integer := 0;
begin
  select * into file from public.source_file where id = target_source_file_id for update;
  if not found then
    raise exception 'source file % does not exist', target_source_file_id;
  end if;
  if file.status = 'split' then
    return;
  end if;
  if jsonb_array_length(page_ranges) = 0 then
    raise exception 'a Split yields at least one Document';
  end if;

  for range in select value from jsonb_array_elements(page_ranges) loop
    if (range ->> 'firstPage')::integer <= previous_last_page
      or (range ->> 'lastPage')::integer < (range ->> 'firstPage')::integer
      or (range ->> 'lastPage')::integer > file.page_count then
      raise exception 'page ranges must be ascending, disjoint and within the % pages', file.page_count;
    end if;
    previous_last_page := (range ->> 'lastPage')::integer;

    insert into public.document (organization_id, company_id, source_file_id, first_page, last_page)
    values (file.organization_id, file.company_id, file.id,
      (range ->> 'firstPage')::integer, (range ->> 'lastPage')::integer);
  end loop;

  update public.source_file set status = 'split' where id = file.id;
end;
$$;

-- Records an AI Extraction Version for the Document's current Extraction request
-- and moves the Document to needs_review. A request is recorded at most once.
create function public.record_ai_extraction(
  target_document_id uuid,
  target_extraction_request_id uuid,
  provider text,
  model text,
  payload jsonb
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  doc public.document;
begin
  select * into doc from public.document where id = target_document_id for update;
  if not found then
    raise exception 'document % does not exist', target_document_id;
  end if;
  if doc.extraction_request_id <> target_extraction_request_id
    or exists (
      select 1 from public.extraction_version v
      where v.document_id = doc.id and v.extraction_request_id = target_extraction_request_id
    ) then
    return;
  end if;

  insert into public.extraction_version
    (organization_id, company_id, document_id, version, provider, model, extraction_request_id, payload)
  values (
    doc.organization_id, doc.company_id, doc.id,
    coalesce((select max(v.version) from public.extraction_version v where v.document_id = doc.id), 0) + 1,
    provider, model, target_extraction_request_id, payload
  );

  update public.document set status = 'needs_review' where id = doc.id;
end;
$$;

revoke execute on function public.record_split, public.record_ai_extraction from public, anon, authenticated;
grant execute on function public.record_split(uuid, jsonb) to service_role;
grant execute on function public.record_ai_extraction(uuid, uuid, text, text, jsonb) to service_role;

-- User transitions -------------------------------------------------------------

-- Asks for the Split of a failed Source File to run again.
create function public.retry_split(target_source_file_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  file public.source_file;
begin
  select * into file from public.source_file where id = target_source_file_id for update;
  if not found or not private.can_access_company(file.company_id, file.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if file.status <> 'failed' then
    raise exception 'only a failed Split can be retried' using errcode = 'P0001', hint = 'not_retryable';
  end if;
  update public.source_file set status = 'uploaded' where id = file.id;
end;
$$;

-- Asks for a new Extraction of a failed or reviewed Document. Earlier
-- Extraction Versions are kept; the run adds a new one.
create function public.reprocess_document(target_document_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  doc public.document;
begin
  select * into doc from public.document where id = target_document_id for update;
  if not found or not private.can_access_company(doc.company_id, doc.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if doc.status not in ('failed', 'needs_review') then
    raise exception 'the Document is still being processed' using errcode = 'P0001', hint = 'not_reprocessable';
  end if;
  update public.document
  set status = 'uploaded', extraction_request_id = gen_random_uuid()
  where id = doc.id;
end;
$$;

revoke execute on function public.retry_split, public.reprocess_document from public, anon;
grant execute on function public.retry_split(uuid), public.reprocess_document(uuid) to authenticated;

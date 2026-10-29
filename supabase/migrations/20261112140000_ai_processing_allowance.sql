-- Lifetime AI Processing Allowance (#105). Successful AI-authored Extraction
-- Versions are the source of truth; short-lived reservations make the final
-- finite units race-safe while a provider call is in flight.

alter type public.document_status add value if not exists 'waiting_for_allowance' after 'uploaded';

alter table public.company
  add column ai_processing_allowance bigint default 50,
  add constraint company_ai_processing_allowance_non_negative
    check (ai_processing_allowance is null or ai_processing_allowance >= 0);

-- Company-facing clients can observe only whether processing is enabled.
-- Configuration, allowance and AI author details cross dedicated role-scoped
-- RPCs instead of the ordinary tenant tables.
revoke select on public.company from authenticated;
grant select (
  id, organization_id, name, first_name, last_name, ico, vat_id, street,
  street_name, house_number, orientation_number, city, postal_code,
  person_type, ai_processing_enabled, created_at, created_by, data_revision,
  deleted_at, deleted_by
) on public.company to authenticated;

revoke select on public.extraction_version from authenticated;
grant select (
  id, organization_id, company_id, document_id, version, author_user_id,
  payload, findings, created_at
) on public.extraction_version to authenticated;

create or replace view public.upload_batch_summary
with (security_invoker = true)
as
select
  batch.id,
  batch.company_id,
  batch.file_count,
  batch.upload_finished_at,
  batch.processing_finished_at,
  batch.created_at,
  count(distinct source.id)::integer as actual_file_count,
  case when batch.upload_finished_at is null
    then greatest(batch.file_count - count(distinct source.id)::integer, 0)
    else 0
  end as transport_count,
  case when batch.upload_finished_at is not null
    then greatest(batch.file_count - count(distinct source.id)::integer, 0)
    else 0
  end as transport_failure_count,
  (
    count(distinct source.id) filter (where source.status = 'uploaded')
    + count(distinct document.id) filter (
      where document.status::text in ('uploaded', 'waiting_for_allowance')
    )
  )::integer as waiting_count,
  count(distinct source.id) filter (where source.status = 'processing')::integer as splitting_count,
  count(distinct source.id) filter (where source.status = 'failed')::integer as source_failure_count,
  count(distinct document.id) filter (where document.status = 'processing')::integer as extracting_count,
  count(distinct document.id) filter (where document.status = 'needs_review')::integer as review_count,
  count(distinct document.id) filter (where document.status in ('approved', 'rejected'))::integer as reviewed_count,
  count(distinct document.id) filter (where document.status = 'failed')::integer as document_failure_count
from public.upload_batch batch
left join public.source_file source on source.upload_batch_id = batch.id
left join public.document document on document.source_file_id = source.id and document.superseded_at is null
group by batch.id;

create or replace function private.maybe_complete_upload_batch(target_batch_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  batch public.upload_batch;
  uploaded_file_count integer;
  transport_failure_count integer;
  source_failure_count integer;
  document_failure_count integer;
  review_count integer;
  reviewed_count integer;
  outcome text;
  notification_payload jsonb;
begin
  select * into batch from public.upload_batch where id = target_batch_id for update;
  if not found or batch.upload_finished_at is null or batch.processing_finished_at is not null then
    return;
  end if;
  if exists (
    select 1 from public.source_file source
    where source.upload_batch_id = batch.id and source.status in ('uploaded', 'processing')
  ) or exists (
    select 1
    from public.document document
    join public.source_file source on source.id = document.source_file_id
    where source.upload_batch_id = batch.id
      and document.superseded_at is null
      and document.status in ('uploaded', 'waiting_for_allowance', 'processing')
  ) then
    return;
  end if;

  select
    count(*)::integer,
    count(*) filter (where source.status = 'failed')::integer
  into uploaded_file_count, source_failure_count
  from public.source_file source
  where source.upload_batch_id = batch.id;

  select
    count(*) filter (where document.status = 'failed')::integer,
    count(*) filter (where document.status = 'needs_review')::integer,
    count(*) filter (where document.status in ('approved', 'rejected'))::integer
  into document_failure_count, review_count, reviewed_count
  from public.document document
  join public.source_file source on source.id = document.source_file_id
  where source.upload_batch_id = batch.id and document.superseded_at is null;

  transport_failure_count := greatest(batch.file_count - uploaded_file_count, 0);
  if transport_failure_count + source_failure_count + document_failure_count = 0 then
    outcome := 'success';
  elsif review_count + reviewed_count > 0 then
    outcome := 'partial';
  else
    outcome := 'failure';
  end if;

  notification_payload := jsonb_build_object(
    'batchId', batch.id,
    'fileCount', uploaded_file_count,
    'outcome', outcome,
    'reviewCount', review_count,
    'transportFailureCount', transport_failure_count,
    'sourceFailureCount', source_failure_count,
    'documentFailureCount', document_failure_count
  );
  update public.upload_batch set processing_finished_at = now() where id = batch.id;
  update public.notification
  set payload = notification_payload, read_at = null, created_at = now()
  where user_id = batch.created_by
    and kind = 'upload_batch_finished'
    and payload ->> 'batchId' = batch.id::text;
  if not found then
    insert into public.notification (organization_id, company_id, user_id, kind, payload)
    values (
      batch.organization_id,
      batch.company_id,
      batch.created_by,
      'upload_batch_finished',
      notification_payload
    );
  end if;
end;
$$;

create table public.ai_processing_reservation (
  id uuid primary key,
  extraction_request_id uuid not null unique,
  document_id uuid not null references public.document (id) on delete cascade,
  organization_id uuid not null references public.organization (id) on delete cascade,
  company_id uuid not null references public.company (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index ai_processing_reservation_company_idx
  on public.ai_processing_reservation (company_id, created_at);

revoke all on public.ai_processing_reservation from anon, authenticated, service_role;
alter table public.ai_processing_reservation enable row level security;

create function public.reserve_ai_processing(
  target_document_id uuid,
  target_extraction_request_id uuid,
  target_reservation_id uuid
)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  doc public.document;
  processing_enabled boolean;
  processing_allowance bigint;
  successful_extractions bigint;
  active_reservations bigint;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- The Company row is the serialization point for all of its final units.
  select * into doc from public.document where id = target_document_id;
  if not found then
    return 'not_processable';
  end if;
  select ai_processing_enabled, ai_processing_allowance into processing_enabled, processing_allowance
  from public.company
  where id = doc.company_id
  for update;
  if not found or not processing_enabled then
    return 'not_processable';
  end if;
  select * into doc
  from public.document
  where id = target_document_id
  for update;
  if not found
    or doc.extraction_request_id <> target_extraction_request_id
    or doc.superseded_at is not null
    or doc.status not in ('uploaded', 'processing', 'waiting_for_allowance') then
    return 'not_processable';
  end if;
  if exists (
    select 1 from public.extraction_version version
    where version.document_id = doc.id
      and version.extraction_request_id = target_extraction_request_id
  ) then
    return 'not_processable';
  end if;

  -- A killed worker cannot strand a unit forever. A duplicate job waits while
  -- the lease is live; a later recheck can replace an abandoned reservation.
  delete from public.ai_processing_reservation reservation
  where reservation.company_id = doc.company_id
    and reservation.created_at < now() - interval '5 minutes';
  if exists (
    select 1 from public.ai_processing_reservation reservation
    where reservation.extraction_request_id = target_extraction_request_id
  ) then
    return 'already_reserved';
  end if;

  if processing_allowance is not null then
    select count(*) into successful_extractions
    from public.extraction_version version
    where version.company_id = doc.company_id
      and version.author_user_id is null;
    select count(*) into active_reservations
    from public.ai_processing_reservation reservation
    where reservation.company_id = doc.company_id;

    if successful_extractions + active_reservations >= processing_allowance then
      update public.document
      set status = 'waiting_for_allowance'
      where id = doc.id
        and extraction_request_id = target_extraction_request_id;
      return 'allowance_exhausted';
    end if;
  end if;

  insert into public.ai_processing_reservation (
    id, extraction_request_id, document_id, organization_id, company_id
  ) values (
    target_reservation_id, target_extraction_request_id, doc.id, doc.organization_id, doc.company_id
  );
  update public.document
  set status = 'processing'
  where id = doc.id
    and extraction_request_id = target_extraction_request_id;
  return 'reserved';
end;
$$;

create function public.release_ai_processing_reservation(target_reservation_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  reservation public.ai_processing_reservation;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.ai_processing_reservation
  where id = target_reservation_id
  returning * into reservation;
  if found then
    update public.document
    set status = 'uploaded'
    where id = reservation.document_id
      and extraction_request_id = reservation.extraction_request_id
      and status = 'processing'
      and not exists (
        select 1 from public.extraction_version version
        where version.document_id = reservation.document_id
          and version.extraction_request_id = reservation.extraction_request_id
      );
  end if;
end;
$$;

drop function public.record_ai_extraction(uuid, uuid, text, text, jsonb, jsonb);

create function public.record_ai_extraction(
  target_document_id uuid,
  target_extraction_request_id uuid,
  target_reservation_id uuid,
  provider text,
  model text,
  payload jsonb,
  findings jsonb
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  doc public.document;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Reservation and completion transfer share the Company row as their
  -- serialization point. Lock it before the Document in both functions, so a
  -- reserve cannot count between the Version insert and reservation delete.
  select * into doc from public.document where id = target_document_id;
  if not found then
    raise exception 'document % does not exist', target_document_id;
  end if;
  perform 1 from public.company where id = doc.company_id for update;
  select * into doc from public.document where id = target_document_id for update;
  if not found then
    raise exception 'document % does not exist', target_document_id;
  end if;
  if jsonb_typeof(findings) <> 'array' then
    raise exception 'findings must be an array';
  end if;
  if doc.extraction_request_id <> target_extraction_request_id
    or exists (
      select 1 from public.extraction_version version
      where version.document_id = doc.id
        and version.extraction_request_id = target_extraction_request_id
    ) then
    delete from public.ai_processing_reservation where id = target_reservation_id;
    return;
  end if;
  if not exists (
    select 1 from public.ai_processing_reservation reservation
    where reservation.id = target_reservation_id
      and reservation.document_id = doc.id
      and reservation.extraction_request_id = target_extraction_request_id
  ) then
    raise exception 'AI Processing Allowance reservation is missing';
  end if;

  insert into public.extraction_version
    (organization_id, company_id, document_id, version, provider, model, extraction_request_id, payload, findings)
  values (
    doc.organization_id, doc.company_id, doc.id,
    coalesce((select max(version.version) from public.extraction_version version where version.document_id = doc.id), 0) + 1,
    provider, model, target_extraction_request_id, payload, findings
  );

  update public.document set status = 'needs_review' where id = doc.id;
  delete from public.ai_processing_reservation where id = target_reservation_id;
end;
$$;

create function public.company_ai_processing_allowance(target_company_id uuid)
returns table (used bigint, allowance bigint, waiting_documents bigint)
language plpgsql stable security definer set search_path = ''
as $$
declare
  target_company public.company;
begin
  select * into target_company
  from public.company
  where id = target_company_id and deleted_at is null;
  if not found
    or not private.is_company_administrator(target_company.id, target_company.organization_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query select
    (select count(*) from public.extraction_version version
      where version.company_id = target_company.id and version.author_user_id is null),
    target_company.ai_processing_allowance,
    (select count(*) from public.document document
      where document.company_id = target_company.id
        and document.status = 'waiting_for_allowance'
        and document.superseded_at is null);
end;
$$;

create function public.list_platform_ai_processing_allowances()
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
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select organization.id,
      organization.name,
      company.id,
      company.name,
      configuration.id,
      configuration.label,
      configuration.provider,
      (select count(*) from public.extraction_version version
        where version.company_id = company.id and version.author_user_id is null),
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

create function public.set_company_ai_processing_allowance(
  target_company_id uuid,
  target_allowance bigint
)
returns table (document_id uuid)
language plpgsql security definer set search_path = ''
as $$
declare
  target_company public.company;
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if target_allowance is not null and target_allowance < 0 then
    raise exception 'invalid allowance' using errcode = 'P0001', hint = 'invalid_allowance';
  end if;
  select * into target_company
  from public.company
  where id = target_company_id and deleted_at is null
  for update;
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.company
  set ai_processing_allowance = target_allowance
  where id = target_company.id;

  perform private.record_audit_event(
    'company.ai_processing_allowance_changed',
    null,
    null,
    'company',
    target_company.id,
    jsonb_build_object('allowance', target_allowance)
  );

  return query
    with resumed as (
      update public.document document
      set status = 'uploaded'
      where document.company_id = target_company.id
        and document.status = 'waiting_for_allowance'
        and document.superseded_at is null
      returning document.id, document.created_at, document.first_page
    )
    select resumed.id
    from resumed
    order by resumed.created_at, resumed.first_page, resumed.id;
end;
$$;

revoke execute on function public.reserve_ai_processing(uuid, uuid, uuid),
  public.release_ai_processing_reservation(uuid),
  public.record_ai_extraction(uuid, uuid, uuid, text, text, jsonb, jsonb),
  public.company_ai_processing_allowance(uuid),
  public.list_platform_ai_processing_allowances(),
  public.set_company_ai_processing_allowance(uuid, bigint)
  from public, anon;

revoke execute on function public.reserve_ai_processing(uuid, uuid, uuid),
  public.release_ai_processing_reservation(uuid),
  public.record_ai_extraction(uuid, uuid, uuid, text, text, jsonb, jsonb)
  from authenticated;

grant execute on function public.reserve_ai_processing(uuid, uuid, uuid),
  public.release_ai_processing_reservation(uuid),
  public.record_ai_extraction(uuid, uuid, uuid, text, text, jsonb, jsonb)
  to service_role;

grant execute on function public.company_ai_processing_allowance(uuid),
  public.list_platform_ai_processing_allowances(),
  public.set_company_ai_processing_allowance(uuid, bigint)
  to authenticated;

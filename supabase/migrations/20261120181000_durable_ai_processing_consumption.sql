-- The AI Processing Allowance is a lifetime total (ADR-0011). Consumption was
-- counted from AI Extraction Versions, so deleting an Upload Batch would have
-- refunded it. A per-Company ledger now records each AI Extraction when its
-- Version is inserted and never decreases.

create table private.company_ai_processing_consumption (
  company_id uuid primary key references public.company (id) on delete cascade,
  used bigint not null default 0 check (used >= 0)
);

revoke all on private.company_ai_processing_consumption from public, anon, authenticated, service_role;

insert into private.company_ai_processing_consumption (company_id, used)
select version.company_id, count(*)
from public.extraction_version version
where version.author_user_id is null
group by version.company_id;

create function private.record_ai_processing_consumption()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.author_user_id is null then
    insert into private.company_ai_processing_consumption as consumption (company_id, used)
    values (new.company_id, 1)
    on conflict (company_id) do update set used = consumption.used + 1;
  end if;
  return new;
end;
$$;

create trigger extraction_version_consumes_ai_processing
  after insert on public.extraction_version
  for each row execute function private.record_ai_processing_consumption();

create function private.company_ai_processing_used(target_company_id uuid)
returns bigint
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select consumption.used
    from private.company_ai_processing_consumption consumption
    where consumption.company_id = target_company_id
  ), 0);
$$;

revoke execute on function private.record_ai_processing_consumption(),
  private.company_ai_processing_used(uuid) from public;

create or replace function public.reserve_ai_processing(
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
  unreserved_predecessors bigint;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

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
    successful_extractions := private.company_ai_processing_used(doc.company_id);
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

    select count(*) into unreserved_predecessors
    from public.document predecessor
    where predecessor.company_id = doc.company_id
      and predecessor.superseded_at is null
      and predecessor.status in ('uploaded', 'processing', 'waiting_for_allowance')
      and (predecessor.created_at, predecessor.first_page, predecessor.id)
        < (doc.created_at, doc.first_page, doc.id)
      and not exists (
        select 1 from public.extraction_version version
        where version.document_id = predecessor.id
          and version.extraction_request_id = predecessor.extraction_request_id
      )
      and not exists (
        select 1 from public.ai_processing_reservation reservation
        where reservation.extraction_request_id = predecessor.extraction_request_id
      );
    if successful_extractions + active_reservations + unreserved_predecessors >= processing_allowance then
      return 'earlier_document_pending';
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

create or replace function public.company_ai_processing_allowance(target_company_id uuid)
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
    private.company_ai_processing_used(target_company.id),
    target_company.ai_processing_allowance,
    (select count(*) from public.document document
      where document.company_id = target_company.id
        and document.status = 'waiting_for_allowance'
        and document.superseded_at is null);
end;
$$;

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

-- Deterministic allowance dispatch and recoverable resume (#106). A job can
-- reserve finite capacity only after every older unreserved Document that
-- could consume that capacity. This keeps selection oldest-first and page-
-- ordered even when the queue starts jobs concurrently or out of order.

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

-- Requeue every waiting Document in oldest-first order. The reservation gate
-- parks work once finite capacity is genuinely consumed, while allowing the
-- next Document through if an older provider call fails without consuming it.
create or replace function public.set_company_ai_processing_allowance(
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
    with selected as (
      select document.id, document.created_at, document.first_page
      from public.document document
      where document.company_id = target_company.id
        and document.status = 'waiting_for_allowance'
        and document.superseded_at is null
    ), resumed as (
      update public.document document
      set status = 'uploaded'
      from selected
      where document.id = selected.id
      returning document.id
    )
    select resumed.id
    from resumed
    join selected on selected.id = resumed.id
    order by selected.created_at, selected.first_page, selected.id;
end;
$$;

-- Queue acknowledgement can fail after a broker accepted a job. Put only the
-- unsafely dispatched suffix back into the visible wait state; a job that did
-- get accepted can still run from that state, and duplicate delivery remains
-- safe through the Extraction request and reservation constraints.
create function public.restore_ai_processing_allowance_wait(
  target_company_id uuid,
  target_document_ids uuid[]
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform 1
  from public.company company
  where company.id = target_company_id and company.deleted_at is null
  for update;
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.document document
  set status = 'waiting_for_allowance'
  where document.company_id = target_company_id
    and document.id = any(target_document_ids)
    and document.status = 'uploaded'
    and document.superseded_at is null;
end;
$$;

revoke execute on function public.restore_ai_processing_allowance_wait(uuid, uuid[])
  from public, anon;
grant execute on function public.restore_ai_processing_allowance_wait(uuid, uuid[])
  to authenticated;

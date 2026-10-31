-- Finally cleanup shares Company -> Document -> reservation ordering with
-- reservation, completion and human recovery. A stale receipt never changes
-- a newer request, manual decision or superseded Document.
create or replace function public.release_ai_processing_reservation(target_reservation_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  reservation public.ai_processing_reservation;
  doc public.document;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Discover ownership without holding a reservation/Document lock first.
  select * into reservation from public.ai_processing_reservation
  where id = target_reservation_id;
  if not found then return; end if;

  perform 1 from public.company where id = reservation.company_id for update;
  if not found then return; end if;
  select * into doc from public.document
  where id = reservation.document_id and company_id = reservation.company_id
  for update;
  if not found then return; end if;

  -- Takeover, retry or another cleanup may have invalidated this receipt while
  -- Company was locked. Re-read and delete only the surviving reservation.
  delete from public.ai_processing_reservation
  where id = target_reservation_id
    and company_id = doc.company_id and document_id = doc.id
  returning * into reservation;
  if not found then return; end if;

  if doc.extraction_request_id = reservation.extraction_request_id
    and doc.superseded_at is null
    and doc.status = 'processing'
    and not exists (
      select 1 from public.extraction_version version
      where version.document_id = doc.id
        and version.extraction_request_id = reservation.extraction_request_id
    ) then
    update public.document set status = 'uploaded' where id = doc.id;
  end if;
end;
$$;
revoke all on function public.release_ai_processing_reservation(uuid) from public, anon, authenticated;
grant execute on function public.release_ai_processing_reservation(uuid) to service_role;

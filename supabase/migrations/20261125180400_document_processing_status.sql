-- Keep the worker's status CAS in the same Company-first lock order as human
-- recovery, reservation and completion (Document revision triggers lock Company).
create function public.move_document_processing_status(
  target_document_id uuid,
  target_extraction_request_id uuid,
  target_status public.document_status,
  expected_statuses public.document_status[]
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare target_company_id uuid; changed_rows bigint;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if target_status not in ('uploaded', 'processing', 'failed', 'waiting_for_allowance', 'waiting_for_platform') then
    raise exception 'invalid worker status' using errcode = '42501';
  end if;
  select company_id into target_company_id from public.document where id = target_document_id;
  if not found then return false; end if;
  perform 1 from public.company where id = target_company_id for update;
  update public.document set status = target_status
  where id = target_document_id and superseded_at is null
    and extraction_request_id = target_extraction_request_id
    and status = any(expected_statuses)
    and status in ('uploaded', 'processing', 'waiting_for_allowance', 'waiting_for_platform');
  get diagnostics changed_rows = row_count;
  return changed_rows > 0;
end;
$$;
revoke all on function public.move_document_processing_status(uuid, uuid, public.document_status, public.document_status[]) from public, anon, authenticated;
grant execute on function public.move_document_processing_status(uuid, uuid, public.document_status, public.document_status[]) to service_role;

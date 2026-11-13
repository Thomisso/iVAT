-- Read one explicitly selected Batch without exposing another creator's local recovery context.
create function public.get_upload_batch_recovery(target_company_id uuid, target_batch_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.upload_batch; items jsonb;
begin
  select * into b from public.upload_batch where id = target_batch_id and company_id = target_company_id;
  if not found or b.created_by <> auth.uid() or b.upload_finished_at is not null
    or not private.can_access_company(b.company_id, b.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if b.selected_files is not null then
    select coalesce(jsonb_agg(
      jsonb_build_object('id', f.entry->>'id', 'sha256', f.entry->>'sha256',
        'fileName', coalesce(t.file_name, s.file_name), 'byteSize', coalesce(t.byte_size, s.byte_size), 'complete', s.id is not null)
      || case when f.entry ? 'groupId' then jsonb_build_object('groupId', f.entry->>'groupId') else '{}'::jsonb end
      || case when t.source_file_id is not null then jsonb_build_object('attemptId', t.attempt_id)
              when s.id is not null then jsonb_build_object('attemptId', null) else '{}'::jsonb end
      order by f.ordinality), '[]'::jsonb) into items
    from jsonb_array_elements(b.selected_files) with ordinality f(entry, ordinality)
    left join public.source_upload_transfer t on t.source_file_id = (f.entry->>'id')::uuid and t.upload_batch_id = b.id and t.created_by = auth.uid()
    left join public.source_file s on s.id = (f.entry->>'id')::uuid and s.upload_batch_id = b.id and s.sha256 = f.entry->>'sha256';
  else
    -- A legacy count-only manifest cannot reconstruct unknown identities or original selection order.
    select coalesce(jsonb_agg(jsonb_build_object('id', t.source_file_id, 'sha256', t.sha256, 'fileName', t.file_name,
      'byteSize', t.byte_size, 'attemptId', t.attempt_id, 'complete', s.id is not null) order by t.source_file_id), '[]'::jsonb) into items
    from public.source_upload_transfer t left join public.source_file s on s.id = t.source_file_id and s.upload_batch_id = b.id
    where t.upload_batch_id = b.id and t.created_by = auth.uid();
  end if;
  return jsonb_build_object('batchId', b.id, 'plannedFileCount', b.file_count, 'legacy', b.selected_files is null, 'items', items);
end;
$$;
revoke all on function public.get_upload_batch_recovery(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_upload_batch_recovery(uuid, uuid) to authenticated;

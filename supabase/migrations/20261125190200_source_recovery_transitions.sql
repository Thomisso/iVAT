-- Source locks follow explicit locked snapshot membership, never an invented
-- accounting period derived from Import Date. Legacy snapshots have no Source
-- membership; their saved result and XML are left unchanged.
create function private.source_file_locked_period(target_source_file_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select lock.period from public.period_lock lock
  join public.vat_report report on report.id = lock.vat_report_id
  join public.source_file source on source.id = target_source_file_id and source.company_id = lock.company_id
  where coalesce(report.result -> 'sourceFilesReadinessSource', '[]'::jsonb)
    @> jsonb_build_array(jsonb_build_object('sourceFileId', target_source_file_id))
  order by lock.period limit 1;
$$;
revoke all on function private.source_file_locked_period(uuid) from public, anon, authenticated, service_role;

create function private.refuse_locked_source_file_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if private.source_file_locked_period(old.id) is not null then
    raise exception 'the Source belongs to a locked report snapshot' using errcode = 'P0001', hint = 'period_locked';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.refuse_locked_source_file_change() from public, anon, authenticated, service_role;
create trigger source_file_period_lock before update or delete on public.source_file
  for each row execute function private.refuse_locked_source_file_change();

create function private.source_file_for_recovery(target_source_file_id uuid)
returns public.source_file language plpgsql security definer set search_path = '' as $$
declare file public.source_file;
begin
  select * into file from public.source_file where id = target_source_file_id;
  if not found or not private.can_access_company(file.company_id, file.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform 1 from public.company where id = file.company_id for update;
  select * into file from public.source_file where id = target_source_file_id for update;
  if not found or not private.can_access_company(file.company_id, file.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if private.source_file_locked_period(file.id) is not null then
    raise exception 'the Source belongs to a locked report snapshot' using errcode = 'P0001', hint = 'period_locked';
  end if;
  return file;
end;
$$;
revoke all on function private.source_file_for_recovery(uuid) from public, anon, authenticated, service_role;

create function public.start_manual_source_review(target_source_file_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare file public.source_file;
begin
  file := private.source_file_for_recovery(target_source_file_id);
  if file.status in ('split', 'rejected') or exists (select 1 from public.document where source_file_id = file.id) then
    raise exception 'the Source is resolved' using errcode = 'P0001', hint = 'source_already_resolved';
  end if;
  if file.status = 'needs_review' then return; end if;
  perform private.restart_source_upload_batch(file);
  update public.source_file set status = 'needs_review', split_request_id = gen_random_uuid() where id = file.id;
  perform private.record_audit_event('source_file.manual_review_started', file.organization_id, file.company_id, 'source_file', file.id, '{}'::jsonb);
end;
$$;

create function public.exclude_source_file(target_source_file_id uuid, exclusion_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare file public.source_file; normalized_reason text;
begin
  file := private.source_file_for_recovery(target_source_file_id);
  if file.status in ('split', 'rejected') or exists (select 1 from public.document where source_file_id = file.id) then
    raise exception 'the Source is resolved' using errcode = 'P0001', hint = 'source_already_resolved';
  end if;
  normalized_reason := regexp_replace(exclusion_reason, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  if normalized_reason is null or length(normalized_reason) not between 1 and 500 then
    raise exception 'a short reason is required' using errcode = 'P0001', hint = 'exclusion_reason_required';
  end if;
  perform private.restart_source_upload_batch(file);
  update public.source_file set status = 'rejected', split_request_id = gen_random_uuid(),
    exclusion_reason = normalized_reason, excluded_at = now(), excluded_by = auth.uid()
  where id = file.id;
  perform private.record_audit_event('source_file.excluded', file.organization_id, file.company_id, 'source_file', file.id,
    jsonb_build_object('reason', normalized_reason));
end;
$$;

create function public.restore_source_file(target_source_file_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare file public.source_file;
begin
  file := private.source_file_for_recovery(target_source_file_id);
  if exists (select 1 from public.document where source_file_id = file.id) then
    raise exception 'use the concrete Documents' using errcode = 'P0001', hint = 'source_already_resolved';
  end if;
  if file.status <> 'rejected' then
    raise exception 'only an excluded Source can be restored' using errcode = 'P0001', hint = 'source_not_rejected';
  end if;
  perform private.restart_source_upload_batch(file);
  update public.source_file set status = 'needs_review', split_request_id = gen_random_uuid(),
    exclusion_reason = null, excluded_at = null, excluded_by = null where id = file.id;
  perform private.record_audit_event('source_file.exclusion_reversed', file.organization_id, file.company_id, 'source_file', file.id,
    jsonb_build_object('reason', file.exclusion_reason));
end;
$$;

create function public.source_file_period_lock(target_source_file_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare file public.source_file;
begin
  select * into file from public.source_file where id = target_source_file_id;
  if not found or not private.can_access_company(file.company_id, file.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return private.source_file_locked_period(file.id);
end;
$$;
revoke all on function public.start_manual_source_review(uuid), public.exclude_source_file(uuid, text), public.restore_source_file(uuid), public.source_file_period_lock(uuid) from public, anon, service_role;
grant execute on function public.start_manual_source_review(uuid), public.exclude_source_file(uuid, text), public.restore_source_file(uuid), public.source_file_period_lock(uuid) to authenticated;

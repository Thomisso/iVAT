-- An immutable manifest item may have several transport attempts. Only new,
-- committed confirmation advances the server clock; caller clocks have no role.
create function private.source_upload_now() returns timestamptz
language sql volatile set search_path = '' as $$ select clock_timestamp() $$;
revoke all on function private.source_upload_now() from public, anon, authenticated, service_role;

alter table public.source_upload_transfer
  add column attempt_id uuid not null default gen_random_uuid(),
  add column lifecycle_status text not null default 'active' check(lifecycle_status in ('active','cancelled','completed')),
  add column legacy_layout boolean not null default true,
  alter column last_progress_at set default private.source_upload_now();
alter table public.source_upload_transfer alter column legacy_layout set default false;
alter table public.source_upload_chunk add column attempt_id uuid;
update public.source_upload_chunk c set attempt_id=t.attempt_id from public.source_upload_transfer t where t.source_file_id=c.source_file_id;
alter table public.source_upload_chunk alter column attempt_id set not null;
alter table public.source_upload_chunk drop constraint source_upload_chunk_pkey;
alter table public.source_upload_chunk add primary key(source_file_id,attempt_id,byte_offset);
-- The background handler retires and enumerates only through its narrow RPCs;
-- inherited table privileges must not allow it to forge confirmed progress.
revoke all on public.source_upload_transfer,public.source_upload_chunk from service_role;

-- No cascading foreign keys: deleted batches and late Storage writes must remain
-- discoverable. Empty sweeps never retire a tombstone.
create table private.source_upload_cleanup (
  attempt_id uuid primary key,
  organization_id uuid not null,
  company_id uuid not null,
  source_file_id uuid not null,
  legacy_layout boolean not null,
  replacement_attempt_id uuid,
  last_swept_at timestamptz not null default '-infinity'
);
alter table private.source_upload_cleanup enable row level security;
revoke all on private.source_upload_cleanup from public,anon,authenticated,service_role;

create function private.source_upload_progress(t public.source_upload_transfer) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('attemptId',t.attempt_id,'confirmedBytes',t.confirmed_bytes,'byteSize',t.byte_size,
    'complete',exists(select 1 from public.source_file s where s.id=t.source_file_id and s.company_id=t.company_id
      and s.upload_batch_id=t.upload_batch_id and s.file_name=t.file_name and s.sha256=t.sha256 and s.byte_size=t.byte_size));
$$;
revoke all on function private.source_upload_progress(public.source_upload_transfer) from public,anon,authenticated,service_role;

-- Every path taking these locks follows Company -> Batch -> Transfer, including
-- source publication and deletion. Recheck live authority after waiting.
create function private.lock_source_upload(target_company_id uuid,target_batch_id uuid,target_source_file_id uuid,
  original_file_name text,original_byte_size bigint,original_sha256 text)
returns public.source_upload_transfer language plpgsql security definer set search_path='' as $$
declare b public.upload_batch; t public.source_upload_transfer; s public.source_file; maximum bigint; maximum_files integer;
begin
  select * into b from public.upload_batch where id=target_batch_id;
  if not found or b.company_id<>target_company_id or b.created_by<>auth.uid()
    or not private.can_access_company(b.company_id,b.organization_id) then raise exception 'not allowed' using errcode='42501'; end if;
  perform 1 from public.company where id=b.company_id for update;
  select * into b from public.upload_batch where id=target_batch_id for update;
  if not found or b.company_id<>target_company_id or b.created_by<>auth.uid()
    or not private.can_access_company(b.company_id,b.organization_id) then raise exception 'not allowed' using errcode='42501'; end if;
  if not exists(select 1 from jsonb_array_elements(b.selected_files) entry where entry->>'id'=target_source_file_id::text and entry->>'sha256'=original_sha256)
    or original_byte_size is null or original_byte_size<1 or coalesce(length(trim(original_file_name)),0)=0 then
    raise exception 'immutable identity mismatch' using errcode='P0001',hint='invalid_choice'; end if;
  select * into s from public.source_file where id=target_source_file_id;
  if found and (s.company_id<>b.company_id or s.upload_batch_id is distinct from b.id or s.file_name<>trim(original_file_name)
    or s.byte_size<>original_byte_size or s.sha256<>original_sha256) then
    raise exception 'immutable identity mismatch' using errcode='P0001',hint='invalid_choice'; end if;
  select * into t from public.source_upload_transfer where source_file_id=target_source_file_id for update;
  if found then
    if t.company_id<>b.company_id or t.upload_batch_id<>b.id or t.created_by<>auth.uid()
      or t.file_name<>trim(original_file_name) or t.byte_size<>original_byte_size or t.sha256<>original_sha256 then
      raise exception 'immutable identity mismatch' using errcode='P0001',hint='invalid_choice'; end if;
    return t;
  end if;
  -- Canonical full-file uploads stay reconcilable without manufacturing a new
  -- empty transfer, even after finish or lower limits.
  if s.id is not null then return null; end if;
  if b.upload_finished_at is not null then raise exception 'not allowed' using errcode='42501'; end if;
  select max_source_file_bytes,max_upload_batch_files into maximum,maximum_files from public.platform_settings where singleton;
  if original_byte_size>maximum then raise exception 'file too large' using errcode='P0001',hint='file_too_large'; end if;
  if b.file_count>maximum_files then raise exception 'too many files' using errcode='P0001',hint='too_many_files'; end if;
  insert into public.source_upload_transfer(source_file_id,organization_id,company_id,upload_batch_id,created_by,file_name,byte_size,sha256)
    values(target_source_file_id,b.organization_id,b.company_id,b.id,auth.uid(),trim(original_file_name),original_byte_size,original_sha256) returning * into t;
  return t;
end;
$$;
revoke all on function private.lock_source_upload(uuid,uuid,uuid,text,bigint,text) from public,anon,authenticated,service_role;

create function private.check_source_upload_attempt(t public.source_upload_transfer,expected_attempt_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  if t.attempt_id is distinct from expected_attempt_id then raise exception 'attempt changed' using errcode='P0001',hint='upload_attempt_changed'; end if;
  if (private.source_upload_progress(t)->>'complete')::boolean then return; end if;
  if t.lifecycle_status='cancelled' then raise exception 'transfer cancelled' using errcode='P0001',hint='upload_cancelled',detail=t.attempt_id::text; end if;
  if private.source_upload_now()>=t.last_progress_at+interval '168 hours' then raise exception 'transfer expired' using errcode='P0001',hint='upload_expired',detail=t.attempt_id::text; end if;
  if t.lifecycle_status<>'active' or not exists(select 1 from public.upload_batch where id=t.upload_batch_id and upload_finished_at is null) then
    raise exception 'not allowed' using errcode='42501'; end if;
  if t.byte_size>(select max_source_file_bytes from public.platform_settings where singleton) then raise exception 'file too large' using errcode='P0001',hint='file_too_large'; end if;
  if (select file_count from public.upload_batch where id=t.upload_batch_id)>(select max_upload_batch_files from public.platform_settings where singleton) then
    raise exception 'too many files' using errcode='P0001',hint='too_many_files'; end if;
end;
$$;
revoke all on function private.check_source_upload_attempt(public.source_upload_transfer,uuid) from public,anon,authenticated,service_role;

-- Replace rather than leave a callable pre-generation confirmation bypass.
drop function public.confirm_source_upload_chunk(uuid,bigint,integer,text);
drop function public.reconcile_source_upload(uuid,uuid,uuid,text,bigint,text);
create function public.reconcile_source_upload(target_company_id uuid,target_batch_id uuid,target_source_file_id uuid,
  original_file_name text,original_byte_size bigint,original_sha256 text,expected_attempt_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.source_upload_transfer;
begin
  t:=private.lock_source_upload(target_company_id,target_batch_id,target_source_file_id,original_file_name,original_byte_size,original_sha256);
  if t.source_file_id is null then
    if expected_attempt_id is not null then raise exception 'attempt changed' using errcode='P0001',hint='upload_attempt_changed'; end if;
    return jsonb_build_object('attemptId',null,'confirmedBytes',original_byte_size,'byteSize',original_byte_size,'complete',true);
  end if;
  perform private.check_source_upload_attempt(t,coalesce(expected_attempt_id,t.attempt_id));
  return private.source_upload_progress(t);
end;
$$;

create function public.confirm_source_upload_chunk(target_source_file_id uuid,expected_attempt_id uuid,chunk_offset bigint,chunk_byte_size integer,chunk_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.source_upload_transfer; c public.source_upload_chunk; object_name text;
begin
  select * into t from public.source_upload_transfer where source_file_id=target_source_file_id;
  if not found then raise exception 'not allowed' using errcode='42501'; end if;
  t:=private.lock_source_upload(t.company_id,t.upload_batch_id,t.source_file_id,t.file_name,t.byte_size,t.sha256);
  perform private.check_source_upload_attempt(t,expected_attempt_id);
  if (private.source_upload_progress(t)->>'complete')::boolean then return private.source_upload_progress(t); end if;
  if chunk_offset is null or chunk_offset<0 or chunk_byte_size is null or chunk_byte_size not between 1 and 1048576
    or chunk_offset+chunk_byte_size>t.byte_size or coalesce(chunk_sha256,'')!~'^[0-9a-f]{64}$' then
    raise exception 'invalid portion' using errcode='P0001',hint='invalid_choice'; end if;
  select * into c from public.source_upload_chunk where source_file_id=t.source_file_id and attempt_id=t.attempt_id and byte_offset=chunk_offset;
  if found then
    if c.byte_size<>chunk_byte_size or c.sha256<>chunk_sha256 then raise exception 'different bytes' using errcode='P0001',hint='invalid_choice'; end if;
  else
    object_name:=t.company_id::text||'/'||t.source_file_id::text||'/'||case when t.legacy_layout then '' else t.attempt_id::text||'/' end||chunk_offset::text||'/'||chunk_sha256;
    if chunk_offset<>t.confirmed_bytes or not exists(select 1 from storage.objects where bucket_id='source-upload-chunks' and name=object_name and (metadata->>'size')::bigint=chunk_byte_size) then
      raise exception 'missing or out of order portion' using errcode='P0001',hint='invalid_choice'; end if;
    insert into public.source_upload_chunk(source_file_id,attempt_id,organization_id,company_id,byte_offset,byte_size,sha256)
      values(t.source_file_id,t.attempt_id,t.organization_id,t.company_id,chunk_offset,chunk_byte_size,chunk_sha256);
    update public.source_upload_transfer set confirmed_bytes=confirmed_bytes+chunk_byte_size,last_progress_at=private.source_upload_now()
      where source_file_id=t.source_file_id returning * into t;
  end if;
  return private.source_upload_progress(t);
end;
$$;

create function public.restart_source_upload(target_company_id uuid,target_batch_id uuid,target_source_file_id uuid,
  original_file_name text,original_byte_size bigint,original_sha256 text,expected_attempt_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.source_upload_transfer; replacement uuid;
begin
  t:=private.lock_source_upload(target_company_id,target_batch_id,target_source_file_id,original_file_name,original_byte_size,original_sha256);
  if t.source_file_id is null then raise exception 'already complete' using errcode='P0001',hint='invalid_choice'; end if;
  if expected_attempt_id is distinct from t.attempt_id then
    select replacement_attempt_id into replacement from private.source_upload_cleanup where attempt_id=expected_attempt_id
      and source_file_id=t.source_file_id and company_id=t.company_id;
    if replacement=t.attempt_id then
      perform private.check_source_upload_attempt(t,t.attempt_id);
      return private.source_upload_progress(t);
    end if;
    raise exception 'attempt changed' using errcode='P0001',hint='upload_attempt_changed';
  end if;
  if (private.source_upload_progress(t)->>'complete')::boolean then raise exception 'already complete' using errcode='P0001',hint='invalid_choice'; end if;
  if t.lifecycle_status='active' and private.source_upload_now()<t.last_progress_at+interval '168 hours' then
    raise exception 'transfer still resumable' using errcode='P0001',hint='invalid_choice'; end if;
  if not exists(select 1 from public.upload_batch where id=t.upload_batch_id and upload_finished_at is null) then raise exception 'not allowed' using errcode='42501'; end if;
  if t.byte_size>(select max_source_file_bytes from public.platform_settings where singleton) then raise exception 'file too large' using errcode='P0001',hint='file_too_large'; end if;
  if (select file_count from public.upload_batch where id=t.upload_batch_id)>(select max_upload_batch_files from public.platform_settings where singleton) then raise exception 'too many files' using errcode='P0001',hint='too_many_files'; end if;
  replacement:=gen_random_uuid();
  insert into private.source_upload_cleanup(attempt_id,organization_id,company_id,source_file_id,legacy_layout,replacement_attempt_id)
    values(t.attempt_id,t.organization_id,t.company_id,t.source_file_id,t.legacy_layout,replacement)
    on conflict(attempt_id) do update set replacement_attempt_id=excluded.replacement_attempt_id;
  delete from public.source_upload_chunk where source_file_id=t.source_file_id;
  update public.source_upload_transfer set attempt_id=replacement,lifecycle_status='active',legacy_layout=false,confirmed_bytes=0,last_progress_at=private.source_upload_now()
    where source_file_id=t.source_file_id returning * into t;
  return private.source_upload_progress(t);
end;
$$;
revoke all on function public.reconcile_source_upload(uuid,uuid,uuid,text,bigint,text,uuid),public.confirm_source_upload_chunk(uuid,uuid,bigint,integer,text),
  public.restart_source_upload(uuid,uuid,uuid,text,bigint,text,uuid) from public,anon,service_role;
grant execute on function public.reconcile_source_upload(uuid,uuid,uuid,text,bigint,text,uuid),public.confirm_source_upload_chunk(uuid,uuid,bigint,integer,text),
  public.restart_source_upload(uuid,uuid,uuid,text,bigint,text,uuid) to authenticated;

create or replace function private.can_access_source_upload_object(object_name text,writing boolean)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare t public.source_upload_transfer; parts text[]:=string_to_array(object_name,'/'); offset_index integer;
begin
  select * into t from public.source_upload_transfer where company_id::text=parts[1] and source_file_id::text=parts[2];
  if not found or t.created_by<>auth.uid() or not private.can_access_company(t.company_id,t.organization_id)
    or t.lifecycle_status<>'active' or private.source_upload_now()>=t.last_progress_at+interval '168 hours'
    or exists(select 1 from public.source_file where id=t.source_file_id)
    or not exists(select 1 from public.upload_batch where id=t.upload_batch_id and upload_finished_at is null) then return false; end if;
  offset_index:=case when t.legacy_layout then 3 else 4 end;
  if cardinality(parts)<>offset_index+1 or (not t.legacy_layout and parts[3]<>t.attempt_id::text)
    or parts[offset_index]!~'^[0-9]{1,12}$' or parts[offset_index+1]!~'^[0-9a-f]{64}$' then return false; end if;
  return not writing or parts[offset_index]::bigint=t.confirmed_bytes or exists(select 1 from public.source_upload_chunk c
    where c.source_file_id=t.source_file_id and c.attempt_id=t.attempt_id and c.byte_offset::text=parts[offset_index] and c.sha256=parts[offset_index+1]);
end;
$$;

-- Ordinary inserts cannot publish an item governed by this transport protocol.
-- The guarded operation inserts as its definer after the same live checks.
create function private.source_upload_ordinary_publication_allowed(target_source_file_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select not exists(select 1 from public.source_upload_transfer where source_file_id=target_source_file_id);
$$;
revoke all on function private.source_upload_ordinary_publication_allowed(uuid) from public,anon,authenticated,service_role;
grant execute on function private.source_upload_ordinary_publication_allowed(uuid) to authenticated;
alter policy "company members record stored source files" on public.source_file with check (
  private.can_access_company(company_id,organization_id) and private.source_file_object_exists(company_id,id)
  and (normalized_format is null or private.source_file_derivative_exists(company_id,id))
  and private.source_upload_ordinary_publication_allowed(id)
);

create function public.publish_source_upload(target_company_id uuid,target_batch_id uuid,target_source_file_id uuid,
  original_file_name text,original_byte_size bigint,original_sha256 text,expected_attempt_id uuid,
  source_format public.source_file_format,source_page_count integer,derivative_format public.source_file_format default null,
  derivative_byte_size bigint default null,derivative_sha256 text default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare t public.source_upload_transfer;
begin
  t:=private.lock_source_upload(target_company_id,target_batch_id,target_source_file_id,original_file_name,original_byte_size,original_sha256);
  if t.source_file_id is null then
    if expected_attempt_id is not null then raise exception 'attempt changed' using errcode='P0001',hint='upload_attempt_changed'; end if;
    return target_source_file_id;
  end if;
  perform private.check_source_upload_attempt(t,expected_attempt_id);
  if (private.source_upload_progress(t)->>'complete')::boolean then return t.source_file_id; end if;
  if t.confirmed_bytes<>t.byte_size then raise exception 'incomplete transfer' using errcode='P0001',hint='upload_incomplete'; end if;
  if not private.source_file_object_exists(t.company_id,t.source_file_id)
    or not exists(select 1 from storage.objects where bucket_id='source-files' and name=t.company_id::text||'/'||t.source_file_id::text and (metadata->>'size')::bigint=t.byte_size)
    or (derivative_format is not null and not private.source_file_derivative_exists(t.company_id,t.source_file_id)) then
    raise exception 'missing immutable original' using errcode='P0001',hint='invalid_choice'; end if;
  insert into public.source_file(id,organization_id,company_id,upload_batch_id,file_name,format,byte_size,sha256,page_count,
    normalized_format,normalized_byte_size,normalized_sha256)
    values(t.source_file_id,t.organization_id,t.company_id,t.upload_batch_id,t.file_name,source_format,t.byte_size,t.sha256,source_page_count,
      derivative_format,derivative_byte_size,derivative_sha256);
  update public.source_upload_transfer set lifecycle_status='completed' where source_file_id=t.source_file_id;
  insert into private.source_upload_cleanup(attempt_id,organization_id,company_id,source_file_id,legacy_layout)
    values(t.attempt_id,t.organization_id,t.company_id,t.source_file_id,t.legacy_layout) on conflict(attempt_id) do nothing;
  return t.source_file_id;
end;
$$;
revoke all on function public.publish_source_upload(uuid,uuid,uuid,text,bigint,text,uuid,public.source_file_format,integer,public.source_file_format,bigint,text) from public,anon,service_role;
grant execute on function public.publish_source_upload(uuid,uuid,uuid,text,bigint,text,uuid,public.source_file_format,integer,public.source_file_format,bigint,text) to authenticated;

create function private.retire_source_upload(t public.source_upload_transfer,retired_status text) returns void
language plpgsql security definer set search_path='' as $$
begin
  insert into private.source_upload_cleanup(attempt_id,organization_id,company_id,source_file_id,legacy_layout)
    values(t.attempt_id,t.organization_id,t.company_id,t.source_file_id,t.legacy_layout) on conflict(attempt_id) do nothing;
  update public.source_upload_transfer set lifecycle_status=retired_status where source_file_id=t.source_file_id and attempt_id=t.attempt_id;
  delete from public.source_upload_chunk where source_file_id=t.source_file_id and attempt_id=t.attempt_id;
end;
$$;
revoke all on function private.retire_source_upload(public.source_upload_transfer,text) from public,anon,authenticated,service_role;
-- Expiration remains distinguishable after the cleanup tick has retired metadata.
alter table public.source_upload_transfer drop constraint source_upload_transfer_lifecycle_status_check;
alter table public.source_upload_transfer add check(lifecycle_status in ('active','cancelled','expired','completed'));

create function public.cancel_source_upload(target_company_id uuid,target_batch_id uuid,target_source_file_id uuid,
  original_file_name text,original_byte_size bigint,original_sha256 text,expected_attempt_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.source_upload_transfer;
begin
  t:=private.lock_source_upload(target_company_id,target_batch_id,target_source_file_id,original_file_name,original_byte_size,original_sha256);
  if t.source_file_id is null then raise exception 'already complete' using errcode='P0001',hint='invalid_choice'; end if;
  if expected_attempt_id is distinct from t.attempt_id then raise exception 'attempt changed' using errcode='P0001',hint='upload_attempt_changed'; end if;
  if (private.source_upload_progress(t)->>'complete')::boolean then return private.source_upload_progress(t); end if;
  perform private.retire_source_upload(t,'cancelled');
  return private.source_upload_progress(t);
end;
$$;
revoke all on function public.cancel_source_upload(uuid,uuid,uuid,text,bigint,text,uuid) from public,anon,service_role;
grant execute on function public.cancel_source_upload(uuid,uuid,uuid,text,bigint,text,uuid) to authenticated;

-- Capture scopes before cascade. Existing authorized deletion retains its own
-- Company/Batch locks, Photo Group reservation wrapper and Period Lock refusal.
create function private.retire_batch_source_uploads() returns trigger
language plpgsql security definer set search_path='' as $$
declare t public.source_upload_transfer;
begin
  for t in select * from public.source_upload_transfer where upload_batch_id=old.id order by source_file_id for update loop
    perform private.retire_source_upload(t,case when (private.source_upload_progress(t)->>'complete')::boolean then 'completed' else 'cancelled' end);
  end loop;
  return old;
end;
$$;
revoke all on function private.retire_batch_source_uploads() from public,anon,authenticated,service_role;
create trigger retire_batch_source_uploads before delete on public.upload_batch for each row execute function private.retire_batch_source_uploads();

alter function public.finish_upload_batch(uuid) rename to finish_upload_batch_without_transfer_cleanup;
alter function public.finish_upload_batch_without_transfer_cleanup(uuid) set schema private;
revoke all on function private.finish_upload_batch_without_transfer_cleanup(uuid) from public,anon,authenticated,service_role;
create function public.finish_upload_batch(target_batch_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare b public.upload_batch; t public.source_upload_transfer;
begin
  select * into b from public.upload_batch where id=target_batch_id;
  if not found or b.created_by<>auth.uid() or not private.can_access_company(b.company_id,b.organization_id) then raise exception 'not allowed' using errcode='42501'; end if;
  perform 1 from public.company where id=b.company_id for update;
  perform 1 from public.upload_batch where id=b.id for update;
  perform private.finish_upload_batch_without_transfer_cleanup(target_batch_id);
  for t in select * from public.source_upload_transfer where upload_batch_id=b.id order by source_file_id for update loop
    perform private.retire_source_upload(t,case when (private.source_upload_progress(t)->>'complete')::boolean then 'completed' else 'cancelled' end);
  end loop;
end;
$$;
revoke all on function public.finish_upload_batch(uuid) from public,anon,service_role;
grant execute on function public.finish_upload_batch(uuid) to authenticated;

create function private.retire_company_source_uploads() returns trigger
language plpgsql security definer set search_path='' as $$
declare b public.upload_batch; t public.source_upload_transfer;
begin
  -- UPDATE already owns Company. Lock Batches before their Transfers.
  for b in select * from public.upload_batch where company_id=new.id order by id for update loop
    for t in select * from public.source_upload_transfer where upload_batch_id=b.id order by source_file_id for update loop
      perform private.retire_source_upload(t,case when (private.source_upload_progress(t)->>'complete')::boolean then 'completed' else 'cancelled' end);
    end loop;
  end loop;
  return new;
end;
$$;
revoke all on function private.retire_company_source_uploads() from public,anon,authenticated,service_role;
create trigger retire_company_source_uploads after update of deleted_at on public.company for each row
  when(old.deleted_at is null and new.deleted_at is not null) execute function private.retire_company_source_uploads();

-- A bounded discovery/retirement pass rechecks every candidate after locks.
create function public.retire_source_uploads() returns void
language plpgsql security definer set search_path='' as $$
declare candidate record; t public.source_upload_transfer; b public.upload_batch; deleted boolean; completed boolean;
begin
  for candidate in select x.source_file_id,x.company_id,x.upload_batch_id from public.source_upload_transfer x
    join public.company c on c.id=x.company_id join public.upload_batch batch on batch.id=x.upload_batch_id
    where x.lifecycle_status='active' and (private.source_upload_now()>=x.last_progress_at+interval '168 hours'
      or c.deleted_at is not null or batch.upload_finished_at is not null or exists(select 1 from public.source_file where id=x.source_file_id))
    order by x.company_id,x.upload_batch_id,x.source_file_id limit 100 loop
    perform 1 from public.company where id=candidate.company_id for update;
    select * into b from public.upload_batch where id=candidate.upload_batch_id for update;
    select * into t from public.source_upload_transfer where source_file_id=candidate.source_file_id for update;
    if t.source_file_id is null or t.lifecycle_status<>'active' then continue; end if;
    completed:=(private.source_upload_progress(t)->>'complete')::boolean;
    select deleted_at is not null into deleted from public.company where id=t.company_id;
    if completed or deleted or b.upload_finished_at is not null or private.source_upload_now()>=t.last_progress_at+interval '168 hours' then
      perform private.retire_source_upload(t,case when completed then 'completed' when deleted or b.upload_finished_at is not null then 'cancelled' else 'expired' end);
    end if;
  end loop;
end;
$$;

-- Names are discovered from actual Storage metadata, including objects never
-- confirmed. Arity isolates migrated four-segment scopes from new generations.
create function public.source_upload_cleanup_candidates() returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('attemptId',t.attempt_id,'names',(
    select coalesce(jsonb_agg(objects.name order by objects.name),'[]'::jsonb) from (
      select o.name from storage.objects o where o.bucket_id='source-upload-chunks'
        and split_part(o.name,'/',1)=t.company_id::text and split_part(o.name,'/',2)=t.source_file_id::text
        and case when t.legacy_layout then cardinality(string_to_array(o.name,'/'))=4
          and split_part(o.name,'/',3)~'^[0-9]{1,12}$' and split_part(o.name,'/',4)~'^[0-9a-f]{64}$'
        else cardinality(string_to_array(o.name,'/'))=5 and split_part(o.name,'/',3)=t.attempt_id::text
          and split_part(o.name,'/',4)~'^[0-9]{1,12}$' and split_part(o.name,'/',5)~'^[0-9a-f]{64}$' end
      order by o.name limit 500
    ) objects
  )) order by t.last_swept_at,t.attempt_id),'[]'::jsonb)
  from (select * from private.source_upload_cleanup order by last_swept_at,attempt_id limit 100) t;
$$;
create function public.finish_source_upload_cleanup_sweep(target_attempt_id uuid) returns void
language sql security definer set search_path='' as $$
  update private.source_upload_cleanup set last_swept_at=private.source_upload_now() where attempt_id=target_attempt_id;
$$;
revoke all on function public.retire_source_uploads(),public.source_upload_cleanup_candidates(),public.finish_source_upload_cleanup_sweep(uuid) from public,anon,authenticated;
grant execute on function public.retire_source_uploads(),public.source_upload_cleanup_candidates(),public.finish_source_upload_cleanup_sweep(uuid) to service_role;

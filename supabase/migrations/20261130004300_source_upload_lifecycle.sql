begin;
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

-- Preserve legacy published paths; only newly validated transfers acquire this reference.
alter table public.source_file add column storage_attempt_id uuid;
lock table public.source_file in share row exclusive mode;
create table private.source_upload_identity (
 source_file_id uuid primary key, organization_id uuid not null, company_id uuid not null,
 upload_batch_id uuid not null, legacy_retired boolean not null default false, transfer_owned boolean not null default false, legacy_cleanup boolean not null default true,
 created_at timestamptz not null default private.source_upload_now(), last_swept_at timestamptz not null default '-infinity'
);
create table private.source_upload_validation (
 id uuid primary key default gen_random_uuid(), attempt_id uuid not null unique,
 organization_id uuid not null, company_id uuid not null, upload_batch_id uuid not null, source_file_id uuid not null,
 created_by uuid not null, legacy boolean not null default false, file_name text, expected_sha256 text, expected_byte_size bigint, last_swept_at timestamptz not null default '-infinity', state text not null default 'pending' check(state in ('pending','validated','published','retired')),
 original_object_id uuid, derivative_object_id uuid, format public.source_file_format, page_count integer,
 sha256 text, byte_size bigint, derivative_sha256 text, derivative_byte_size bigint
);
alter table private.source_upload_identity enable row level security;
alter table private.source_upload_validation enable row level security;
revoke all on private.source_upload_identity,private.source_upload_validation from public,anon,authenticated,service_role;
create function private.reserve_upload_manifest() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from jsonb_array_elements(new.selected_files) f join private.source_upload_identity r on r.source_file_id=(f->>'id')::uuid where r.upload_batch_id<>new.id) then
  raise exception 'immutable source identity already reserved' using errcode='P0001',hint='invalid_choice'; end if;
 insert into private.source_upload_identity(source_file_id,organization_id,company_id,upload_batch_id)
 select (f->>'id')::uuid,new.organization_id,new.company_id,new.id from jsonb_array_elements(new.selected_files) f on conflict do nothing;
 return new;
end; $$;
revoke all on function private.reserve_upload_manifest() from public,anon,authenticated,service_role;
create trigger reserve_upload_manifest after insert on public.upload_batch for each row execute function private.reserve_upload_manifest();
insert into private.source_upload_identity(source_file_id,organization_id,company_id,upload_batch_id,transfer_owned,legacy_cleanup)
 select t.source_file_id,t.organization_id,t.company_id,t.upload_batch_id,true,not exists(select 1 from public.source_file s where s.id=t.source_file_id)
 from public.source_upload_transfer t;
insert into private.source_upload_identity(source_file_id,organization_id,company_id,upload_batch_id,created_at)
 select distinct on ((f->>'id')::uuid) (f->>'id')::uuid,b.organization_id,b.company_id,b.id,b.created_at
 from public.upload_batch b cross join jsonb_array_elements(b.selected_files) f
 order by (f->>'id')::uuid,b.created_at,b.id on conflict do nothing;
create function private.enroll_source_upload() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from private.source_upload_validation v where v.source_file_id=new.source_file_id and v.legacy
 and (v.file_name<>new.file_name or v.expected_byte_size<>new.byte_size or v.expected_sha256<>new.sha256)) then
 raise exception 'immutable full-file identity mismatch' using errcode='P0001',hint='invalid_choice'; end if;
 insert into private.source_upload_identity(source_file_id,organization_id,company_id,upload_batch_id,transfer_owned,legacy_cleanup)
 values(new.source_file_id,new.organization_id,new.company_id,new.upload_batch_id,true,true)
 on conflict(source_file_id) do update set transfer_owned=true,legacy_cleanup=true,legacy_retired=true
 where source_upload_identity.company_id=excluded.company_id and source_upload_identity.upload_batch_id=excluded.upload_batch_id;
 if not found then raise exception 'immutable source identity reserved' using errcode='P0001',hint='invalid_choice'; end if;
 update private.source_upload_validation set state='retired' where source_file_id=new.source_file_id and legacy and state<>'published';
 return new;
end; $$;
revoke all on function private.enroll_source_upload() from public,anon,authenticated,service_role;
create trigger enroll_source_upload after insert on public.source_upload_transfer for each row execute function private.enroll_source_upload();
create function private.retire_validation_objects() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.attempt_id<>new.attempt_id or new.lifecycle_status in ('expired','cancelled') then
  update private.source_upload_validation set state='retired' where attempt_id=old.attempt_id and state<>'published';
 end if;
 return new;
end; $$;
revoke all on function private.retire_validation_objects() from public,anon,authenticated,service_role;
create trigger retire_validation_objects before update on public.source_upload_transfer for each row execute function private.retire_validation_objects();
create function private.upload_attempt_object(company_id uuid,source_id uuid,attempt_id uuid,derivative boolean default false) returns text
language sql immutable set search_path='' as $$ select company_id::text||'/'||source_id::text||'/transfer/'||attempt_id::text||case when derivative then '/normalized.jpeg' else '/original' end $$;
revoke all on function private.upload_attempt_object(uuid,uuid,uuid,boolean) from public,anon,authenticated,service_role;

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
create function private.source_upload_ordinary_publication_allowed(target_source_file_id uuid,target_batch_id uuid,target_company_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select not exists(select 1 from private.source_upload_identity r where r.source_file_id=target_source_file_id and (r.transfer_owned or r.legacy_retired or r.company_id is distinct from target_company_id
 or r.upload_batch_id is distinct from target_batch_id or not exists(select 1 from public.upload_batch b where b.id=r.upload_batch_id and b.upload_finished_at is null)));
$$;
revoke all on function private.source_upload_ordinary_publication_allowed(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.source_upload_ordinary_publication_allowed(uuid,uuid,uuid) to authenticated;
alter policy "company members record stored source files" on public.source_file with check (
  private.can_access_company(company_id,organization_id) and private.source_file_object_exists(company_id,id)
  and (normalized_format is null or private.source_file_derivative_exists(company_id,id))
  and private.source_upload_ordinary_publication_allowed(id,upload_batch_id,company_id)
);

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
  update private.source_upload_identity set legacy_cleanup=true where upload_batch_id=old.id and transfer_owned;
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

create function public.begin_source_upload_validation(target_company_id uuid,target_batch_id uuid,target_source_file_id uuid,
 original_file_name text,original_byte_size bigint,original_sha256 text,expected_attempt_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare t public.source_upload_transfer; claim uuid;
begin
 t:=private.lock_source_upload(target_company_id,target_batch_id,target_source_file_id,original_file_name,original_byte_size,original_sha256);
 perform private.check_source_upload_attempt(t,expected_attempt_id);
 if t.confirmed_bytes<>t.byte_size then raise exception 'incomplete' using errcode='P0001',hint='upload_incomplete'; end if;
 insert into private.source_upload_validation(attempt_id,organization_id,company_id,upload_batch_id,source_file_id,created_by,file_name,expected_sha256,expected_byte_size)
 values(t.attempt_id,t.organization_id,t.company_id,t.upload_batch_id,t.source_file_id,t.created_by,t.file_name,t.sha256,t.byte_size) on conflict(attempt_id) do nothing;
 select id into claim from private.source_upload_validation where attempt_id=t.attempt_id and state<>'retired';
 if claim is null then raise exception 'retired validation' using errcode='P0001',hint='upload_attempt_changed'; end if;
 return claim;
end; $$;
revoke all on function public.begin_source_upload_validation(uuid,uuid,uuid,text,bigint,text,uuid) from public,anon,service_role;
grant execute on function public.begin_source_upload_validation(uuid,uuid,uuid,text,bigint,text,uuid) to authenticated;

create function public.source_upload_validation_input(claim_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v private.source_upload_validation; t public.source_upload_transfer;
begin
 select * into v from private.source_upload_validation where id=claim_id;
 if not found or v.state='retired' then raise exception 'validation unavailable' using errcode='42501'; end if;
 if v.state in ('validated','published') then return jsonb_build_object('validated',true); end if;
 if v.legacy then
 if not exists(select 1 from private.source_upload_identity r join public.upload_batch b on b.id=r.upload_batch_id join public.company c on c.id=r.company_id
 where r.source_file_id=v.source_file_id and not r.transfer_owned and not r.legacy_retired and b.upload_finished_at is null and c.deleted_at is null) then raise exception 'legacy validation retired' using errcode='42501'; end if;
 return jsonb_build_object('validated',false,'legacy',true,'fileName',v.file_name,'byteSize',v.expected_byte_size,'sha256',v.expected_sha256,
 'originalPath',v.company_id::text||'/'||v.source_file_id::text,'derivativePath',v.company_id::text||'/'||v.source_file_id::text||'/normalized.jpeg',
 'limits',(select jsonb_build_object('maxFileBytes',max_source_file_bytes,'maxFilePages',max_source_file_pages,'maxBatchFiles',max_upload_batch_files) from public.platform_settings where singleton));
 end if;
 select * into t from public.source_upload_transfer where source_file_id=v.source_file_id and attempt_id=v.attempt_id;
 if not found or t.lifecycle_status<>'active' or private.source_upload_now()>=t.last_progress_at+interval '168 hours'
 or not exists(select 1 from public.company where id=t.company_id and deleted_at is null)
 or not exists(select 1 from public.upload_batch where id=t.upload_batch_id and upload_finished_at is null) then raise exception 'validation retired' using errcode='42501'; end if;
 return jsonb_build_object('validated',false,'fileName',t.file_name,'byteSize',t.byte_size,'sha256',t.sha256,
 'originalPath',private.upload_attempt_object(t.company_id,t.source_file_id,t.attempt_id),
 'derivativePath',private.upload_attempt_object(t.company_id,t.source_file_id,t.attempt_id,true),
 'limits',(select jsonb_build_object('maxFileBytes',max_source_file_bytes,'maxFilePages',max_source_file_pages,'maxBatchFiles',max_upload_batch_files) from public.platform_settings where singleton),
 'chunks',(select coalesce(jsonb_agg(jsonb_build_object('offset',c.byte_offset,'byteSize',c.byte_size,'sha256',c.sha256,
 'path',t.company_id::text||'/'||t.source_file_id::text||'/'||case when t.legacy_layout then '' else t.attempt_id::text||'/' end||c.byte_offset::text||'/'||c.sha256) order by c.byte_offset),'[]'::jsonb)
 from public.source_upload_chunk c where c.source_file_id=t.source_file_id and c.attempt_id=t.attempt_id));
end; $$;
create function public.record_source_upload_validation(claim_id uuid,actual_sha256 text,actual_byte_size bigint,
 actual_format public.source_file_format,actual_page_count integer,normalized_sha256 text default null,normalized_byte_size bigint default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare v private.source_upload_validation; o storage.objects; d storage.objects;
begin
 select * into v from private.source_upload_validation where id=claim_id for update;
 if not found or v.state='retired' then raise exception 'validation retired' using errcode='42501'; end if;
 if v.state in ('validated','published') then return v.id; end if;
 if v.legacy then
 if actual_sha256<>v.expected_sha256 or actual_byte_size<>v.expected_byte_size or not exists(select 1 from private.source_upload_identity r join public.upload_batch b on b.id=r.upload_batch_id where r.source_file_id=v.source_file_id and not r.transfer_owned and not r.legacy_retired and b.upload_finished_at is null) then raise exception 'legacy validation retired' using errcode='42501'; end if;
 elsif not exists(select 1 from public.source_upload_transfer t where t.source_file_id=v.source_file_id and t.attempt_id=v.attempt_id
 and t.sha256=actual_sha256 and t.byte_size=actual_byte_size and t.lifecycle_status='active' and private.source_upload_now()<t.last_progress_at+interval '168 hours') then raise exception 'invalid validated identity' using errcode='42501'; end if;
 select * into o from storage.objects where bucket_id='source-files' and name=case when v.legacy then v.company_id::text||'/'||v.source_file_id::text else private.upload_attempt_object(v.company_id,v.source_file_id,v.attempt_id) end;
 if not found or (o.metadata->>'size')::bigint<>actual_byte_size then raise exception 'original missing' using errcode='42501'; end if;
 if normalized_sha256 is not null then
 select * into d from storage.objects where bucket_id='source-files' and name=case when v.legacy then v.company_id::text||'/'||v.source_file_id::text||'/normalized.jpeg' else private.upload_attempt_object(v.company_id,v.source_file_id,v.attempt_id,true) end;
 if not found or (d.metadata->>'size')::bigint<>normalized_byte_size then raise exception 'derivative missing' using errcode='42501'; end if;
 end if;
 update private.source_upload_validation set state='validated',sha256=actual_sha256,byte_size=actual_byte_size,format=actual_format,page_count=actual_page_count,
 original_object_id=o.id,derivative_object_id=d.id,derivative_sha256=normalized_sha256,derivative_byte_size=normalized_byte_size where id=v.id;
 return v.id;
end; $$;
revoke all on function public.source_upload_validation_input(uuid),public.record_source_upload_validation(uuid,text,bigint,public.source_file_format,integer,text,bigint) from public,anon,authenticated;
grant execute on function public.source_upload_validation_input(uuid),public.record_source_upload_validation(uuid,text,bigint,public.source_file_format,integer,text,bigint) to service_role;

create function public.publish_source_upload(target_company_id uuid,target_batch_id uuid,target_source_file_id uuid,
 original_file_name text,original_byte_size bigint,original_sha256 text,expected_attempt_id uuid,validation_claim_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare t public.source_upload_transfer; v private.source_upload_validation;
begin
 t:=private.lock_source_upload(target_company_id,target_batch_id,target_source_file_id,original_file_name,original_byte_size,original_sha256);
 perform private.check_source_upload_attempt(t,expected_attempt_id);
 if (private.source_upload_progress(t)->>'complete')::boolean then return t.source_file_id; end if;
 select * into v from private.source_upload_validation where id=validation_claim_id and source_file_id=t.source_file_id and attempt_id=t.attempt_id
 and company_id=t.company_id and upload_batch_id=t.upload_batch_id and created_by=auth.uid() and state='validated' for update;
 if not found or v.sha256<>t.sha256 or v.byte_size<>t.byte_size or not exists(select 1 from storage.objects where id=v.original_object_id and bucket_id='source-files'
 and name=private.upload_attempt_object(t.company_id,t.source_file_id,t.attempt_id)) or (v.derivative_object_id is not null and not exists(select 1 from storage.objects where id=v.derivative_object_id and bucket_id='source-files'
 and name=private.upload_attempt_object(t.company_id,t.source_file_id,t.attempt_id,true))) then raise exception 'validated content required' using errcode='P0001',hint='invalid_choice'; end if;
 insert into public.source_file(id,organization_id,company_id,upload_batch_id,file_name,format,byte_size,sha256,page_count,normalized_format,normalized_byte_size,normalized_sha256,storage_attempt_id)
 values(t.source_file_id,t.organization_id,t.company_id,t.upload_batch_id,t.file_name,v.format,v.byte_size,v.sha256,v.page_count,
 case when v.derivative_object_id is not null then 'jpeg'::public.source_file_format else null end,v.derivative_byte_size,v.derivative_sha256,t.attempt_id);
 update private.source_upload_validation set state='published' where id=v.id;
 update public.source_upload_transfer set lifecycle_status='completed' where source_file_id=t.source_file_id;
 insert into private.source_upload_cleanup(attempt_id,organization_id,company_id,source_file_id,legacy_layout)
 values(t.attempt_id,t.organization_id,t.company_id,t.source_file_id,t.legacy_layout) on conflict do nothing;
 return t.source_file_id;
end; $$;
revoke all on function public.publish_source_upload(uuid,uuid,uuid,text,bigint,text,uuid,uuid) from public,anon,service_role;
grant execute on function public.publish_source_upload(uuid,uuid,uuid,text,bigint,text,uuid,uuid) to authenticated;

create function private.guard_upload_owned_object() returns trigger language plpgsql security definer set search_path='' as $$
declare r private.source_upload_identity; v private.source_upload_validation;
begin
 if tg_op='UPDATE' and old.bucket_id='source-files' and (split_part(old.name,'/',3)='transfer' or exists(select 1 from private.source_upload_identity x where x.source_file_id::text=split_part(old.name,'/',2) and old.name in (x.company_id::text||'/'||x.source_file_id::text,x.company_id::text||'/'||x.source_file_id::text||'/normalized.jpeg'))) and
 (new.bucket_id is distinct from old.bucket_id or new.name is distinct from old.name or new.id is distinct from old.id or new.version is distinct from old.version or new.metadata is distinct from old.metadata) then
 raise exception 'immutable validated object' using errcode='42501'; end if;
 if new.bucket_id<>'source-files' then return new; end if;
 select * into r from private.source_upload_identity where source_file_id::text=split_part(new.name,'/',2);
 if r.source_file_id is not null and r.company_id::text<>split_part(new.name,'/',1) then raise exception 'reserved foreign source identity' using errcode='42501'; end if;
 if split_part(new.name,'/',3)='transfer' then
 select * into v from private.source_upload_validation where company_id::text=split_part(new.name,'/',1) and source_file_id::text=split_part(new.name,'/',2) and attempt_id::text=split_part(new.name,'/',4)
 and new.name in (private.upload_attempt_object(company_id,source_file_id,attempt_id),private.upload_attempt_object(company_id,source_file_id,attempt_id,true));
 -- A provider already in flight may finish a retired exact key. Its permanent
 -- tombstone collects it; a retired receipt can never authorize publication.
 if auth.role() is distinct from 'service_role' or v.id is null then raise exception 'validator-owned object' using errcode='42501'; end if;
 elsif r.source_file_id is not null and (r.transfer_owned or not exists(select 1 from public.upload_batch b join public.company c on c.id=b.company_id where b.id=r.upload_batch_id and b.upload_finished_at is null and c.deleted_at is null)) and new.name in (r.company_id::text||'/'||r.source_file_id::text,r.company_id::text||'/'||r.source_file_id::text||'/normalized.jpeg') then
 raise exception 'reserved transfer identity' using errcode='42501';
 end if;
 return new;
end; $$;
revoke all on function private.guard_upload_owned_object() from public,anon,authenticated,service_role;
create trigger guard_upload_owned_object before insert or update on storage.objects for each row execute function private.guard_upload_owned_object();
create function private.upload_object_published(object_name text) returns boolean language sql stable security definer set search_path='' as $$
 select split_part(object_name,'/',3)<>'transfer' or exists(select 1 from public.source_file s where s.company_id::text=split_part(object_name,'/',1)
 and s.id::text=split_part(object_name,'/',2) and s.storage_attempt_id::text=split_part(object_name,'/',4));
$$;
revoke all on function private.upload_object_published(text) from public,anon,service_role;
grant execute on function private.upload_object_published(text) to authenticated;
create policy "unpublished transfer originals stay private" on storage.objects as restrictive for select to authenticated
 using(bucket_id<>'source-files' or private.upload_object_published(name));

create function public.source_upload_original_cleanup_candidates() returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('ownerId',scope.id,'legacy',scope.legacy,'names',(
 select coalesce(jsonb_agg(o.name order by o.name),'[]'::jsonb) from storage.objects o where o.bucket_id='source-files' and o.name=any(scope.names)
 )) order by scope.swept,scope.id),'[]'::jsonb) from (
 select * from (
 select v.id,false legacy,v.last_swept_at swept,array[private.upload_attempt_object(v.company_id,v.source_file_id,v.attempt_id),private.upload_attempt_object(v.company_id,v.source_file_id,v.attempt_id,true)] names
 from private.source_upload_validation v where v.state='retired' and not v.legacy
 union all
 select r.source_file_id,true,r.last_swept_at,array_remove(array[
 case when not exists(select 1 from public.source_file s where s.id=r.source_file_id and s.storage_attempt_id is null) then r.company_id::text||'/'||r.source_file_id::text end,
 case when not exists(select 1 from public.source_file s where s.id=r.source_file_id and s.storage_attempt_id is null and s.normalized_format is not null) then r.company_id::text||'/'||r.source_file_id::text||'/normalized.jpeg' end],null)
 from private.source_upload_identity r where r.legacy_cleanup and r.legacy_retired
 ) all_scopes order by swept,id limit 100
 ) scope;
$$;
create function public.finish_source_upload_original_sweep(owner_id uuid,legacy boolean) returns void language plpgsql security definer set search_path='' as $$
begin
 if legacy then update private.source_upload_identity set last_swept_at=private.source_upload_now() where source_file_id=owner_id;
 else update private.source_upload_validation set last_swept_at=private.source_upload_now() where id=owner_id; end if;
end; $$;
revoke all on function public.source_upload_original_cleanup_candidates(),public.finish_source_upload_original_sweep(uuid,boolean) from public,anon,authenticated;
grant execute on function public.source_upload_original_cleanup_candidates(),public.finish_source_upload_original_sweep(uuid,boolean) to service_role;
-- New snapshots carry the immutable storage reference; historical snapshots stay untouched.
alter function public.company_export_snapshot(uuid) rename to company_export_snapshot_without_upload_storage;
alter function public.company_export_snapshot_without_upload_storage(uuid) set schema private;
create function public.company_export_snapshot(target_company_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare snapshot jsonb;
begin
 snapshot:=private.company_export_snapshot_without_upload_storage(target_company_id);
 return jsonb_set(snapshot,'{sourceFiles}',coalesce((select jsonb_agg(item.value||case when s.storage_attempt_id is null then '{}'::jsonb else jsonb_build_object('storageAttemptId',s.storage_attempt_id) end order by item.ordinality)
 from jsonb_array_elements(snapshot->'sourceFiles') with ordinality item(value,ordinality) join public.source_file s on s.id=(item.value->>'id')::uuid),'[]'::jsonb));
end; $$;
revoke all on function public.company_export_snapshot(uuid),private.company_export_snapshot_without_upload_storage(uuid) from public,anon,authenticated,service_role;

create or replace function private.complete_photo_group_without_recovery(target_group_id uuid, processed_basis jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare g public.photo_group; settings public.platform_settings; total_bytes bigint; source_count integer; entry jsonb; object_name text; ai_enabled boolean; normalized_bytes bigint; member public.source_file; page_index integer:=0;
begin
  select * into g from public.photo_group where id=target_group_id;
  if not found then raise exception 'group missing'; end if;
  perform 1 from public.company where id=g.company_id for update;
  perform 1 from public.upload_batch where id=g.upload_batch_id for update;
  select * into g from public.photo_group where id=target_group_id for update;
  if g.basis is not null then return g.id; end if;
  select * into settings from public.platform_settings where singleton;
  select count(*),sum(byte_size),sum(coalesce(normalized_byte_size,byte_size)) into source_count,total_bytes,normalized_bytes from public.source_file
    where id=any(g.source_file_ids) and upload_batch_id=g.upload_batch_id and company_id=g.company_id and format::text in ('jpeg','png','heic','heif') and page_count=1 and status in ('uploaded','processing','waiting_for_platform');
  if source_count<>cardinality(g.source_file_ids) then raise exception 'group incomplete' using errcode='P0001',hint='upload_incomplete'; end if;
  if cardinality(g.source_file_ids)>settings.max_source_file_pages then raise exception 'group page limit' using errcode='P0001',hint='too_many_pages'; end if;
  if total_bytes>settings.max_source_file_bytes or normalized_bytes>settings.max_source_file_bytes or (processed_basis->>'byteSize')::bigint>settings.max_source_file_bytes then
    raise exception 'group byte limit' using errcode='P0001',hint='file_too_large';
  end if;
  if processed_basis->>'sha256' !~ '^[0-9a-f]{64}$' or jsonb_array_length(processed_basis->'pages')<>source_count then raise exception 'invalid basis'; end if;
  object_name:=g.company_id::text||'/'||g.source_file_ids[1]::text||'/group/basis.pdf';
  if not exists(select 1 from storage.objects where bucket_id='source-files' and name=object_name and (metadata->>'size')::bigint=(processed_basis->>'byteSize')::bigint) then raise exception 'basis not stored'; end if;
  for entry in select value from jsonb_array_elements(processed_basis->'pages') loop
    page_index:=page_index+1;
    select * into member from public.source_file where id=g.source_file_ids[page_index];
    if (entry->>'page')::integer is distinct from page_index or entry->>'sourceFileId' is distinct from member.id::text
      or entry->>'sourceSha256' is distinct from member.sha256 then raise exception 'basis source order mismatch'; end if;
    if member.format::text in ('heic','heif') then
      if entry->'normalizedDerivative' is distinct from jsonb_build_object('format','jpeg','sha256',member.normalized_sha256,'byteSize',member.normalized_byte_size)
        or not exists(select 1 from storage.objects where bucket_id='source-files'
          and name=case when member.storage_attempt_id is null then g.company_id::text||'/'||member.id::text||'/normalized.jpeg' else private.upload_attempt_object(g.company_id,member.id,member.storage_attempt_id,true) end
          and (metadata->>'size')::bigint=member.normalized_byte_size) then raise exception 'normalization basis mismatch'; end if;
    elsif entry ? 'normalizedDerivative' then raise exception 'unexpected normalization basis';
    end if;
    if entry->>'sha256' !~ '^[0-9a-f]{64}$' or not exists(select 1 from storage.objects where bucket_id='source-files'
      and name=g.company_id::text||'/'||g.source_file_ids[1]::text||'/group/'||(entry->>'page')||'.png'
      and (metadata->>'size')::bigint=(entry->>'byteSize')::bigint) then raise exception 'page basis not stored'; end if;
  end loop;
  update public.photo_group set basis=processed_basis where id=g.id;
  select ai_processing_enabled into ai_enabled from public.company where id=g.company_id;
  insert into public.document(id,organization_id,company_id,source_file_id,first_page,last_page,status)
    values(g.id,g.organization_id,g.company_id,g.source_file_ids[1],1,cardinality(g.source_file_ids),case when ai_enabled then 'uploaded'::public.document_status else 'needs_review'::public.document_status end);
  update public.source_file set status='split' where id=any(g.source_file_ids);
  perform private.record_audit_event('photo_group.prepared',g.organization_id,g.company_id,'photo_group',g.id,
    jsonb_build_object('sourceFileIds',to_jsonb(g.source_file_ids),'createdBy',g.created_by,'createdAt',g.created_at,'basis',processed_basis));
  return g.id;
end;
$$;

create unique index source_upload_legacy_validation_identity on private.source_upload_validation(source_file_id) where legacy;
create function public.begin_source_file_validation(target_company_id uuid,target_batch_id uuid,target_source_file_id uuid,
 original_file_name text,original_byte_size bigint,original_sha256 text) returns uuid language plpgsql security definer set search_path='' as $$
declare b public.upload_batch; v private.source_upload_validation;
begin
 select * into b from public.upload_batch where id=target_batch_id;
 if not found or b.company_id<>target_company_id or b.created_by<>auth.uid() or not private.can_access_company(b.company_id,b.organization_id) then raise exception 'not allowed' using errcode='42501'; end if;
 perform 1 from public.company where id=b.company_id for update;
 select * into b from public.upload_batch where id=target_batch_id for update;
 if b.id is not null and b.selected_files is null and b.created_by=auth.uid() and b.upload_finished_at is null and private.can_access_company(b.company_id,b.organization_id) then
 insert into private.source_upload_identity(source_file_id,organization_id,company_id,upload_batch_id) values(target_source_file_id,b.organization_id,b.company_id,b.id) on conflict do nothing;
 end if;
 if b.id is null or b.created_by<>auth.uid() or b.upload_finished_at is not null or not private.can_access_company(b.company_id,b.organization_id)
 or not exists(select 1 from private.source_upload_identity r where r.source_file_id=target_source_file_id and r.upload_batch_id=b.id and r.company_id=b.company_id and not r.transfer_owned and not r.legacy_retired) then raise exception 'not allowed' using errcode='42501'; end if;
 if (b.selected_files is not null and not exists(select 1 from jsonb_array_elements(b.selected_files) f where f->>'id'=target_source_file_id::text and f->>'sha256'=original_sha256)) or coalesce(length(trim(original_file_name)),0)=0 or original_byte_size is null or original_byte_size<1 then raise exception 'immutable identity mismatch' using errcode='P0001',hint='invalid_choice'; end if;
 insert into private.source_upload_validation(attempt_id,organization_id,company_id,upload_batch_id,source_file_id,created_by,legacy,file_name,expected_sha256,expected_byte_size)
 values(gen_random_uuid(),b.organization_id,b.company_id,b.id,target_source_file_id,auth.uid(),true,trim(original_file_name),original_sha256,original_byte_size) on conflict do nothing;
 select * into v from private.source_upload_validation where source_file_id=target_source_file_id and legacy for update;
 if v.state='retired' or v.file_name<>trim(original_file_name) or v.expected_sha256<>original_sha256 or v.expected_byte_size<>original_byte_size then raise exception 'immutable validation mismatch' using errcode='P0001',hint='invalid_choice'; end if;
 return v.id;
end; $$;
revoke all on function public.begin_source_file_validation(uuid,uuid,uuid,text,bigint,text) from public,anon,service_role;
grant execute on function public.begin_source_file_validation(uuid,uuid,uuid,text,bigint,text) to authenticated;
create function private.source_file_content_valid(s public.source_file) returns boolean language sql stable security definer set search_path='' as $$
 select not exists(select 1 from private.source_upload_identity where source_file_id=s.id) or exists(
 select 1 from private.source_upload_validation v where v.state='validated' and v.source_file_id=s.id and v.company_id=s.company_id and v.upload_batch_id=s.upload_batch_id
 and v.created_by=auth.uid() and v.file_name=s.file_name and v.format=s.format and v.byte_size=s.byte_size and v.sha256=s.sha256 and v.page_count=s.page_count
 and ((v.legacy and s.storage_attempt_id is null) or (not v.legacy and s.storage_attempt_id=v.attempt_id))
 and s.normalized_sha256 is not distinct from v.derivative_sha256 and s.normalized_byte_size is not distinct from v.derivative_byte_size
 and s.normalized_format is not distinct from case when v.derivative_object_id is not null then 'jpeg'::public.source_file_format else null end
 and exists(select 1 from storage.objects o where o.id=v.original_object_id and o.bucket_id='source-files' and o.name=case when v.legacy then v.company_id::text||'/'||v.source_file_id::text else private.upload_attempt_object(v.company_id,v.source_file_id,v.attempt_id) end)
 and (v.derivative_object_id is null or exists(select 1 from storage.objects o where o.id=v.derivative_object_id and o.bucket_id='source-files' and o.name=case when v.legacy then v.company_id::text||'/'||v.source_file_id::text||'/normalized.jpeg' else private.upload_attempt_object(v.company_id,v.source_file_id,v.attempt_id,true) end)));
$$;
revoke all on function private.source_file_content_valid(public.source_file) from public,anon,service_role;
grant execute on function private.source_file_content_valid(public.source_file) to authenticated;
alter policy "company members record stored source files" on public.source_file with check (
 private.can_access_company(company_id,organization_id) and private.source_file_object_exists(company_id,id)
 and (normalized_format is null or private.source_file_derivative_exists(company_id,id))
 and private.source_upload_ordinary_publication_allowed(id,upload_batch_id,company_id) and private.source_file_content_valid(source_file));
create function private.publish_legacy_validation() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.storage_attempt_id is null then update private.source_upload_validation set state='published' where source_file_id=new.id and legacy and state='validated'; end if;
 return new;
end; $$;
revoke all on function private.publish_legacy_validation() from public,anon,authenticated,service_role;
create trigger publish_legacy_validation after insert on public.source_file for each row execute function private.publish_legacy_validation();
create function public.retire_source_file_validation_objects() returns void language plpgsql security definer set search_path='' as $$
declare candidate record; r private.source_upload_identity;
begin
 for candidate in select source_file_id,company_id,upload_batch_id from private.source_upload_identity x where not legacy_retired and (transfer_owned or private.source_upload_now()>=created_at+interval '168 hours'
 or not exists(select 1 from public.upload_batch b join public.company c on c.id=b.company_id where b.id=x.upload_batch_id and b.upload_finished_at is null and c.deleted_at is null)) order by company_id,upload_batch_id,source_file_id limit 100 loop
 perform 1 from public.company where id=candidate.company_id for update;
 perform 1 from public.upload_batch where id=candidate.upload_batch_id for update;
 select * into r from private.source_upload_identity where source_file_id=candidate.source_file_id for update;
 if r.transfer_owned or private.source_upload_now()>=r.created_at+interval '168 hours' or not exists(select 1 from public.upload_batch b join public.company c on c.id=b.company_id where b.id=r.upload_batch_id and b.upload_finished_at is null and c.deleted_at is null) then
 update private.source_upload_identity set legacy_retired=true where source_file_id=r.source_file_id;
 update private.source_upload_validation set state='retired' where source_file_id=r.source_file_id and legacy and state<>'published';
 end if;
 end loop;
end; $$;
revoke all on function public.retire_source_file_validation_objects() from public,anon,authenticated;
grant execute on function public.retire_source_file_validation_objects() to service_role;

-- Definer insertion (manual attachment included) must obey the same reserved
-- identity proof rule; RLS alone cannot guard a SECURITY DEFINER insert.
create function private.guard_reserved_source_publication() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if not private.source_file_content_valid(new) then raise exception 'validated reserved identity required' using errcode='42501'; end if;
 return new;
end; $$;
revoke all on function private.guard_reserved_source_publication() from public,anon,authenticated,service_role;
create trigger zz_guard_reserved_source_publication before insert on public.source_file for each row execute function private.guard_reserved_source_publication();

commit;

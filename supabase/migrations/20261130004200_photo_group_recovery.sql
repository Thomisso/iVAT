-- Recovery changes the processing request, never the confirmed evidence.
alter table public.photo_group
  add column preparation_request_id uuid not null default gen_random_uuid(),
  add column preparation_mode text not null default 'automatic' check(preparation_mode in ('automatic','manual','retry')),
  add column preparation_status text not null default 'pending' check(preparation_status in ('pending','preparing','failed','ready')),
  add column preparation_lease_id uuid,
  add column preparation_lease_until timestamptz,
  add column preparation_failure text check(preparation_failure in ('temporarily_unavailable','evidence_unavailable'));
update public.photo_group set preparation_status='ready' where basis is not null;
update public.photo_group g set preparation_status='failed',preparation_failure='temporarily_unavailable'
  where g.basis is null and exists(select 1 from public.source_file s where s.id=any(g.source_file_ids) and s.status='failed');

-- Retained reservations make deleted member identities recognizable even before
-- a Source row existed. No original bytes or personal data are stored here.
create table private.photo_group_source_reservation (
  source_file_id uuid primary key,
  organization_id uuid not null,
  company_id uuid not null,
  group_id uuid not null,
  upload_batch_id uuid not null,
  foreign key(company_id,organization_id) references public.company(id,organization_id)
);
alter table private.photo_group_source_reservation enable row level security;
revoke all on private.photo_group_source_reservation from public,anon,authenticated,service_role;
insert into private.photo_group_source_reservation(source_file_id,organization_id,company_id,group_id,upload_batch_id)
  select member.id,g.organization_id,g.company_id,g.id,g.upload_batch_id from public.photo_group g cross join unnest(g.source_file_ids) member(id);
create function private.reserve_photo_group_sources() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from private.photo_group_source_reservation where source_file_id=any(new.source_file_ids)) then
    raise exception 'immutable source identity already used' using errcode='P0001',hint='invalid_choice';
  end if;
  insert into private.photo_group_source_reservation(source_file_id,organization_id,company_id,group_id,upload_batch_id)
    select member.id,new.organization_id,new.company_id,new.id,new.upload_batch_id from unnest(new.source_file_ids) member(id);
  return new;
end;
$$;
revoke all on function private.reserve_photo_group_sources() from public,anon,authenticated,service_role;
create trigger reserve_photo_group_sources after insert on public.photo_group for each row execute function private.reserve_photo_group_sources();

create function private.lock_photo_group(target_group_id uuid) returns public.photo_group
language plpgsql security definer set search_path='' as $$
declare g public.photo_group;
begin
  select * into g from public.photo_group where id=target_group_id;
  if not found then return null; end if;
  perform 1 from public.company where id=g.company_id for update;
  perform 1 from public.upload_batch where id=g.upload_batch_id for update;
  select * into g from public.photo_group where id=target_group_id for update;
  return g;
end;
$$;
revoke all on function private.lock_photo_group(uuid) from public,anon,authenticated,service_role;

create function public.recover_photo_group(target_group_id uuid, recovery_mode text) returns uuid
language plpgsql security definer set search_path='' as $$
declare g public.photo_group;
begin
  select * into g from public.photo_group where id=target_group_id;
  if not found or not private.can_access_company(g.company_id,g.organization_id) then raise exception 'not allowed' using errcode='42501'; end if;
  g:=private.lock_photo_group(target_group_id);
  if g.id is null or not private.can_access_company(g.company_id,g.organization_id)
    or not exists(select 1 from public.company where id=g.company_id and deleted_at is null) then raise exception 'not allowed' using errcode='42501'; end if;
  if recovery_mode not in ('manual','retry') or recovery_mode is null then raise exception 'invalid recovery' using errcode='P0001',hint='invalid_choice'; end if;
  perform 1 from public.source_file where id=any(g.source_file_ids) order by id for update;
  if exists(select 1 from unnest(g.source_file_ids) member(id) where private.source_file_locked_period(member.id) is not null)
    or exists(select 1 from public.document d where d.id=g.id and private.is_reporting_period_locked(d.company_id,private.document_current_reporting_period(d.id))) then
    raise exception 'locked source' using errcode='P0001',hint='period_locked';
  end if;
  -- Lost responses return the same completed manual decision, including later corrections.
  if g.basis is not null then
    if recovery_mode='manual' and g.preparation_mode='manual' then return g.id; end if;
    raise exception 'use the Document recovery' using errcode='P0001',hint='source_already_resolved';
  end if;
  if g.preparation_failure='evidence_unavailable' then raise exception 'immutable evidence unavailable' using errcode='P0001',hint='group_evidence_unavailable'; end if;
  if exists(select 1 from public.source_file where id=any(g.source_file_ids) and status in ('split','rejected','needs_review')) then
    raise exception 'source resolved' using errcode='P0001',hint='source_already_resolved';
  end if;
  if g.preparation_mode=recovery_mode and g.preparation_status in ('pending','preparing') then return g.id; end if;
  update public.photo_group set preparation_request_id=gen_random_uuid(), preparation_mode=recovery_mode,
    preparation_status='pending', preparation_failure=null,preparation_lease_id=null,preparation_lease_until=null where id=g.id;
  update public.upload_batch set processing_finished_at=null where id=g.upload_batch_id;
  update public.notification set read_at=coalesce(read_at,now()) where kind='upload_batch_finished' and payload->>'batchId'=g.upload_batch_id::text;
  perform private.record_audit_event(case when recovery_mode='manual' then 'photo_group.manual_review_requested' else 'photo_group.retry_requested' end,
    g.organization_id,g.company_id,'photo_group',g.id,jsonb_build_object('sourceFileIds',g.source_file_ids));
  return g.id;
end;
$$;
revoke all on function public.recover_photo_group(uuid,text) from public,anon,service_role;
grant execute on function public.recover_photo_group(uuid,text) to authenticated;

create function public.claim_photo_group(target_group_id uuid,target_request_id uuid,target_lease_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare g public.photo_group;
begin
  g:=private.lock_photo_group(target_group_id);
  if g.id is null or g.basis is not null or g.preparation_request_id<>target_request_id or g.preparation_status='failed'
    or not exists(select 1 from public.company where id=g.company_id and deleted_at is null)
    or (g.preparation_status='preparing' and g.preparation_lease_until>clock_timestamp()) then return false; end if;
  perform 1 from public.source_file where id=any(g.source_file_ids) order by id for update;
  if (select count(*) from public.source_file where id=any(g.source_file_ids) and upload_batch_id=g.upload_batch_id
      and company_id=g.company_id and status in ('uploaded','processing','waiting_for_platform','failed'))<>cardinality(g.source_file_ids)
    or exists(select 1 from unnest(g.source_file_ids) member(id) where private.source_file_locked_period(member.id) is not null) then return false; end if;
  update public.photo_group set preparation_status='preparing',preparation_lease_id=target_lease_id,preparation_lease_until=clock_timestamp()+interval '5 minutes' where id=g.id;
  update public.source_file set status='processing' where id=any(g.source_file_ids) and status<>'processing';
  return true;
end;
$$;
revoke all on function public.claim_photo_group(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_photo_group(uuid,uuid,uuid) to service_role;

create function public.photo_group_claim_current(target_group_id uuid,target_request_id uuid,target_lease_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.photo_group g join public.company c on c.id=g.company_id
   where g.id=target_group_id and g.preparation_request_id=target_request_id and g.preparation_lease_id=target_lease_id
   and g.preparation_status='preparing' and c.deleted_at is null);
$$;
revoke all on function public.photo_group_claim_current(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.photo_group_claim_current(uuid,uuid,uuid) to service_role;

alter function public.complete_photo_group(uuid,jsonb) rename to complete_photo_group_without_recovery;
alter function public.complete_photo_group_without_recovery(uuid,jsonb) set schema private;
revoke all on function private.complete_photo_group_without_recovery(uuid,jsonb) from public,anon,authenticated,service_role;
create function public.complete_photo_group(target_group_id uuid,processed_basis jsonb,target_request_id uuid,target_lease_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare g public.photo_group;
begin
  g:=private.lock_photo_group(target_group_id);
  if g.id is null then return null; end if;
  if g.preparation_request_id<>target_request_id or g.preparation_lease_id is distinct from target_lease_id
    or not exists(select 1 from public.company where id=g.company_id and deleted_at is null) then return null; end if;
  if g.basis is not null then return g.id; end if;
  if g.preparation_status<>'preparing' then return null; end if;
  perform 1 from public.source_file where id=any(g.source_file_ids) order by id for update;
  if exists(select 1 from unnest(g.source_file_ids) member(id) where private.source_file_locked_period(member.id) is not null) then return null; end if;
  perform private.complete_photo_group_without_recovery(g.id,processed_basis);
  if g.preparation_mode='manual' then update public.document set status='needs_review' where id=g.id; end if;
  update public.photo_group set preparation_status='ready',preparation_failure=null,preparation_lease_until=null where id=g.id;
  return g.id;
end;
$$;
revoke all on function public.complete_photo_group(uuid,jsonb,uuid,uuid) from public,anon,authenticated;
grant execute on function public.complete_photo_group(uuid,jsonb,uuid,uuid) to service_role;

drop function public.fail_photo_group(uuid);
create function public.fail_photo_group(target_group_id uuid,target_request_id uuid,target_lease_id uuid,failure_code text) returns boolean
language plpgsql security definer set search_path='' as $$
declare g public.photo_group;
begin
  g:=private.lock_photo_group(target_group_id);
  if g.id is null or g.basis is not null or g.preparation_request_id<>target_request_id
    or g.preparation_lease_id is distinct from target_lease_id or g.preparation_status<>'preparing' then return false; end if;
  update public.photo_group set preparation_status='failed',preparation_failure=failure_code,preparation_lease_until=null where id=g.id;
  update public.source_file set status='failed' where id=any(g.source_file_ids) and status in ('uploaded','processing','waiting_for_platform');
  return true;
end;
$$;
revoke all on function public.fail_photo_group(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fail_photo_group(uuid,uuid,uuid,text) to service_role;

-- Storage transactions participate in the same lock order as deletion. A worker
-- paused before upload cannot create hidden group objects after batch removal.
create function private.guard_photo_group_object() returns trigger
language plpgsql security definer set search_path='' as $$
declare reservation private.photo_group_source_reservation; g public.photo_group; is_basis boolean;
begin
  if new.bucket_id<>'source-files' or new.name !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}(/|$)' then return new; end if;
  is_basis:=split_part(new.name,'/',3)='group';
  select * into reservation from private.photo_group_source_reservation where source_file_id=split_part(new.name,'/',2)::uuid;
  if not found then
    if is_basis then raise exception 'group missing' using errcode='42501'; end if;
    return new;
  end if;
  if reservation.company_id::text<>split_part(new.name,'/',1) then raise exception 'foreign source identity' using errcode='42501'; end if;
  g:=private.lock_photo_group(reservation.group_id);
  if g.id is null or not exists(select 1 from public.company where id=g.company_id and deleted_at is null) then
    raise exception 'group no longer exists' using errcode='42501';
  end if;
  if is_basis and (auth.role() is distinct from 'service_role' or g.preparation_status not in ('preparing','ready')) then
    raise exception 'worker-owned group basis' using errcode='42501';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_photo_group_object() from public,anon,authenticated,service_role;
create trigger guard_photo_group_object before insert or update on storage.objects for each row execute function private.guard_photo_group_object();

create function public.release_photo_group_claim(target_group_id uuid,target_request_id uuid,target_lease_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare g public.photo_group;
begin
  g:=private.lock_photo_group(target_group_id);
  update public.photo_group set preparation_status='pending',preparation_lease_id=null,preparation_lease_until=null
    where id=g.id and preparation_request_id=target_request_id and preparation_lease_id=target_lease_id and basis is null;
end;
$$;
revoke all on function public.release_photo_group_claim(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.release_photo_group_claim(uuid,uuid,uuid) to service_role;

create function public.fail_incomplete_photo_group(target_group_id uuid,target_request_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare g public.photo_group;
begin
  g:=private.lock_photo_group(target_group_id);
  if g.id is null or g.basis is not null or g.preparation_request_id<>target_request_id
    or g.preparation_status='preparing' or not exists(select 1 from public.upload_batch where id=g.upload_batch_id and upload_finished_at is not null)
    or (select count(*) from public.source_file where id=any(g.source_file_ids) and upload_batch_id=g.upload_batch_id and company_id=g.company_id)=cardinality(g.source_file_ids) then return; end if;
  update public.photo_group set preparation_status='failed',preparation_failure='temporarily_unavailable' where id=g.id;
  update public.source_file set status='failed' where id=any(g.source_file_ids) and status in ('uploaded','processing','waiting_for_platform');
end;
$$;
revoke all on function public.fail_incomplete_photo_group(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fail_incomplete_photo_group(uuid,uuid) to service_role;

-- New archives record the recovery decision; previously saved snapshots stay fixed.
alter function public.company_export_snapshot(uuid) rename to company_export_snapshot_without_group_recovery;
alter function public.company_export_snapshot_without_group_recovery(uuid) set schema private;
create function public.company_export_snapshot(target_company_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare snapshot jsonb;
begin
  snapshot:=private.company_export_snapshot_without_group_recovery(target_company_id);
  return jsonb_set(snapshot,'{photoGroups}',coalesce((select jsonb_agg(item.value||jsonb_build_object('preparation',jsonb_build_object(
    'status',g.preparation_status,'mode',g.preparation_mode,'failure',g.preparation_failure)) order by item.ordinality)
    from jsonb_array_elements(snapshot->'photoGroups') with ordinality item(value,ordinality)
    join public.photo_group g on g.id=(item.value->>'id')::uuid),'[]'::jsonb));
end;
$$;
revoke all on function public.company_export_snapshot(uuid),private.company_export_snapshot_without_group_recovery(uuid) from public,anon,authenticated,service_role;

-- Every member of a prepared group is resolved by its one Document. Historical
-- report snapshots keep their recorded source membership and lock semantics.
create or replace function private.source_file_readiness_source(target_company_id uuid,target_period text)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'sourceFileId',source.id,'fileName',source.file_name,'status',source.status,
    'splitRequestId',source.split_request_id,'exclusionReason',source.exclusion_reason
  ) order by source.id),'[]'::jsonb)
  from public.source_file source
  where source.company_id=target_company_id
    and private.reporting_period_for_date(source.company_id,(source.uploaded_at at time zone 'Europe/Prague')::date)=target_period
    and not exists(select 1 from public.document document where document.source_file_id=source.id)
    and not exists(select 1 from public.photo_group g join public.document d on d.id=g.id
      where source.id=any(g.source_file_ids) and g.company_id=source.company_id and g.basis is not null);
$$;
revoke all on function private.source_file_readiness_source(uuid,text) from public,anon,authenticated,service_role;

-- Wait for canonical object writes before discovering reserved identities whose
-- Source row was never recorded. The underlying command retains all Role,
-- processing, Source/Document lock, audit and durable cleanup requirements.
create or replace function public.delete_upload_batch(target_batch_id uuid) returns text[]
language plpgsql security definer set search_path='' as $$
declare batch public.upload_batch; extra_names text[]; names text[];
begin
  select * into batch from public.upload_batch where id=target_batch_id;
  if not found or not private.can_access_company(batch.company_id,batch.organization_id) then raise exception 'not allowed' using errcode='42501'; end if;
  perform 1 from public.company where id=batch.company_id for update;
  select * into batch from public.upload_batch where id=target_batch_id for update;
  if not found or not private.can_access_company(batch.company_id,batch.organization_id) then raise exception 'not allowed' using errcode='42501'; end if;
  select coalesce(array_agg(o.name),'{}') into extra_names from storage.objects o where o.bucket_id='source-files'
    and exists(select 1 from public.photo_group g cross join unnest(g.source_file_ids) source(id) where g.upload_batch_id=target_batch_id
      and (o.name=batch.company_id::text||'/'||source.id::text or o.name like batch.company_id::text||'/'||source.id::text||'/%'));
  names:=private.delete_upload_batch_without_photo_groups(target_batch_id);
  insert into private.deleted_source_file_object(name,organization_id,company_id)
    select name,batch.organization_id,batch.company_id from unnest(extra_names) name on conflict(name) do nothing;
  return array(select distinct name from unnest(names||extra_names) name order by name);
end;
$$;
revoke all on function public.delete_upload_batch(uuid) from public,anon,service_role;
grant execute on function public.delete_upload_batch(uuid) to authenticated;

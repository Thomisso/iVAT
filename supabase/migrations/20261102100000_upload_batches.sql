-- Platform upload limits, upload batches and their completion notifications.

create table public.platform_settings (
  singleton boolean primary key default true check (singleton),
  max_source_file_bytes bigint not null check (max_source_file_bytes > 0),
  max_source_file_pages integer not null check (max_source_file_pages > 0),
  max_upload_batch_files integer not null check (max_upload_batch_files > 0)
);

insert into public.platform_settings
  (singleton, max_source_file_bytes, max_source_file_pages, max_upload_batch_files)
values (true, 20 * 1024 * 1024, 50, 100);

revoke all on public.platform_settings from anon, authenticated;
grant select on public.platform_settings to authenticated;
grant select, update on public.platform_settings to service_role;

create table public.upload_batch (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  company_id uuid not null,
  created_by uuid not null default auth.uid() references auth.users (id),
  file_count integer not null check (file_count > 0),
  upload_finished_at timestamptz,
  processing_finished_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.company (id, organization_id),
  unique (id, company_id, organization_id)
);

create index upload_batch_company_id_idx on public.upload_batch (company_id, created_at);

create table public.notification (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  company_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind = 'upload_batch_finished'),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.company (id, organization_id)
);

create index notification_user_id_idx on public.notification (user_id, created_at desc);

alter table public.source_file
  add column upload_batch_id uuid,
  add foreign key (upload_batch_id, company_id, organization_id)
    references public.upload_batch (id, company_id, organization_id);

revoke all on public.upload_batch, public.notification from anon, authenticated, service_role;
grant select on public.upload_batch, public.notification to authenticated;
grant insert (upload_batch_id) on public.source_file to authenticated;

alter table public.upload_batch enable row level security;
alter table public.notification enable row level security;

create policy "company members read upload batches" on public.upload_batch
  for select to authenticated
  using (private.can_access_company(company_id, organization_id));

create policy "users read their upload notifications" on public.notification
  for select to authenticated
  using (
    user_id = auth.uid()
    and private.can_access_company(company_id, organization_id)
  );

create function public.begin_upload_batch(target_company_id uuid, selected_file_count integer)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  company public.company;
  maximum integer;
  batch_id uuid;
begin
  select * into company from public.company where id = target_company_id;
  if not found or not private.can_access_company(company.id, company.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select max_upload_batch_files into maximum from public.platform_settings where singleton;
  if selected_file_count < 1 then
    raise exception 'a batch needs at least one Source File' using errcode = 'P0001', hint = 'file_required';
  end if;
  if selected_file_count > maximum then
    raise exception 'batch exceeds the platform limit of % Source Files', maximum
      using errcode = 'P0001', hint = 'too_many_files';
  end if;

  insert into public.upload_batch (organization_id, company_id, created_by, file_count)
  values (company.organization_id, company.id, auth.uid(), selected_file_count)
  returning id into batch_id;
  return batch_id;
end;
$$;

create function private.validate_source_file_batch()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  batch public.upload_batch;
  existing_files integer;
begin
  if new.upload_batch_id is null then
    return new;
  end if;
  select * into batch from public.upload_batch where id = new.upload_batch_id for update;
  if not found
    or batch.organization_id <> new.organization_id
    or batch.company_id <> new.company_id
    or batch.created_by <> auth.uid()
    or batch.upload_finished_at is not null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select count(*) into existing_files from public.source_file where upload_batch_id = batch.id;
  if existing_files >= batch.file_count then
    raise exception 'the upload batch already has every selected Source File'
      using errcode = 'P0001', hint = 'too_many_files';
  end if;
  return new;
end;
$$;

create trigger source_file_batch_valid
  before insert on public.source_file
  for each row execute function private.validate_source_file_batch();

create function private.enforce_source_file_limits()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  settings public.platform_settings;
begin
  select * into settings from public.platform_settings where singleton;
  if new.byte_size > settings.max_source_file_bytes then
    raise exception 'Source File exceeds the platform byte limit'
      using errcode = 'P0001', hint = 'file_too_large';
  end if;
  if new.page_count > settings.max_source_file_pages then
    raise exception 'Source File exceeds the platform page limit'
      using errcode = 'P0001', hint = 'too_many_pages';
  end if;
  return new;
end;
$$;

create trigger source_file_limits
  before insert on public.source_file
  for each row execute function private.enforce_source_file_limits();

create function private.maybe_complete_upload_batch(target_batch_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  batch public.upload_batch;
  uploaded_file_count integer;
begin
  select * into batch from public.upload_batch where id = target_batch_id for update;
  if not found or batch.upload_finished_at is null or batch.processing_finished_at is not null then
    return;
  end if;
  if exists (
    select 1 from public.source_file sf
    where sf.upload_batch_id = batch.id and sf.status in ('uploaded', 'processing')
  ) or exists (
    select 1
    from public.document d
    join public.source_file sf on sf.id = d.source_file_id
    where sf.upload_batch_id = batch.id and d.status in ('uploaded', 'processing')
  ) then
    return;
  end if;

  update public.upload_batch set processing_finished_at = now() where id = batch.id;
  select count(*) into uploaded_file_count from public.source_file where upload_batch_id = batch.id;
  insert into public.notification (organization_id, company_id, user_id, kind, payload)
  values (
    batch.organization_id,
    batch.company_id,
    batch.created_by,
    'upload_batch_finished',
    jsonb_build_object('batchId', batch.id, 'fileCount', uploaded_file_count)
  );
end;
$$;

create function public.finish_upload_batch(target_batch_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  batch public.upload_batch;
begin
  select * into batch from public.upload_batch where id = target_batch_id for update;
  if not found or batch.created_by <> auth.uid()
    or not private.can_access_company(batch.company_id, batch.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.upload_batch
  set upload_finished_at = coalesce(upload_finished_at, now())
  where id = batch.id;
  perform private.maybe_complete_upload_batch(batch.id);
end;
$$;

create function private.source_file_maybe_completes_batch()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.upload_batch_id is not null then
    perform private.maybe_complete_upload_batch(new.upload_batch_id);
  end if;
  return new;
end;
$$;

create trigger source_file_maybe_completes_batch
  after update of status on public.source_file
  for each row when (old.status is distinct from new.status)
  execute function private.source_file_maybe_completes_batch();

create function private.document_maybe_completes_batch()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  batch_id uuid;
begin
  select sf.upload_batch_id into batch_id from public.source_file sf where sf.id = new.source_file_id;
  if batch_id is not null then
    perform private.maybe_complete_upload_batch(batch_id);
  end if;
  return new;
end;
$$;

create trigger document_maybe_completes_batch
  after update of status on public.document
  for each row when (old.status is distinct from new.status)
  execute function private.document_maybe_completes_batch();

revoke execute on function public.begin_upload_batch, public.finish_upload_batch from public, anon;
grant execute on function public.begin_upload_batch(uuid, integer), public.finish_upload_batch(uuid) to authenticated;
revoke execute on function private.validate_source_file_batch, private.maybe_complete_upload_batch,
  private.source_file_maybe_completes_batch, private.document_maybe_completes_batch,
  private.enforce_source_file_limits from public;

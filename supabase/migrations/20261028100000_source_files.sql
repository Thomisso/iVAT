-- Source Files: originals uploaded into a Company, preserved unchanged. The
-- file lives in the private `source-files` storage bucket under
-- `<company_id>/<source_file_id>`; the row records its hash, format and page count.
-- Neither the row nor the object can be changed or deleted by users.

create type public.source_file_format as enum ('pdf', 'png', 'jpeg');

create table public.source_file (
  id uuid primary key,
  organization_id uuid not null,
  company_id uuid not null,
  file_name text not null check (length(trim(file_name)) > 0),
  format public.source_file_format not null,
  byte_size bigint not null check (byte_size > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  page_count integer not null check (page_count > 0),
  uploaded_by uuid default auth.uid(),
  uploaded_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.company (id, organization_id)
);

create index source_file_company_id_idx on public.source_file (company_id, uploaded_at);

insert into storage.buckets (id, name, public, allowed_mime_types)
values ('source-files', 'source-files', false, array['application/pdf', 'image/png', 'image/jpeg']);

-- Access to a stored object follows access to the Company named by its first folder.
create function private.can_access_company_object(object_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.company c
    where c.id::text = (storage.foldername(object_name))[1]
      and private.can_access_company(c.id, c.organization_id)
  );
$$;

-- A Source File row may only be recorded once its file is stored.
create function private.source_file_object_exists(target_company_id uuid, target_source_file_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from storage.objects o
    where o.bucket_id = 'source-files'
      and o.name = target_company_id::text || '/' || target_source_file_id::text
  );
$$;

revoke execute on function private.can_access_company_object, private.source_file_object_exists from public;
grant execute on function private.can_access_company_object(text) to authenticated;
grant execute on function private.source_file_object_exists(uuid, uuid) to authenticated;

revoke all on public.source_file from anon, authenticated;
grant select, insert (id, organization_id, company_id, file_name, format, byte_size, sha256, page_count)
  on public.source_file to authenticated;

alter table public.source_file enable row level security;

create policy "company members read source files" on public.source_file
  for select to authenticated
  using (private.can_access_company(company_id, organization_id));

create policy "company members record stored source files" on public.source_file
  for insert to authenticated
  with check (
    private.can_access_company(company_id, organization_id)
    and private.source_file_object_exists(company_id, id)
  );

-- No update or delete policies: stored originals are immutable.
create policy "company members read source file objects" on storage.objects
  for select to authenticated
  using (bucket_id = 'source-files' and private.can_access_company_object(name));

create policy "company members store source file objects" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'source-files' and private.can_access_company_object(name));

create function private.audit_source_file_uploaded()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.record_audit_event(
    'source_file.uploaded', new.organization_id, new.company_id, 'source_file', new.id,
    jsonb_build_object(
      'file_name', new.file_name,
      'format', new.format,
      'byte_size', new.byte_size,
      'sha256', new.sha256,
      'page_count', new.page_count
    )
  );
  return new;
end;
$$;

create trigger source_file_uploaded_audit
  after insert on public.source_file
  for each row execute function private.audit_source_file_uploaded();

-- Mobile captures keep their HEIC/HEIF original while a JPEG derivative is
-- stored beside it for browser preview and AI processing. The derivative
-- metadata lives on the immutable Source File row, making its origin and hash
-- auditable without treating it as another Source File.

alter type public.source_file_format add value if not exists 'heic';
alter type public.source_file_format add value if not exists 'heif';

alter table public.source_file
  add column normalized_format public.source_file_format,
  add column normalized_byte_size bigint,
  add column normalized_sha256 text,
  add constraint source_file_normalized_derivative_complete check (
    (
      format::text not in ('heic', 'heif')
      and normalized_format is null
      and normalized_byte_size is null
      and normalized_sha256 is null
    )
    or
    (
      format::text in ('heic', 'heif')
      and normalized_format = 'jpeg'
      and normalized_byte_size > 0
      and normalized_sha256 ~ '^[0-9a-f]{64}$'
    )
  );

grant insert (normalized_format, normalized_byte_size, normalized_sha256)
  on public.source_file to authenticated;

update storage.buckets
set allowed_mime_types = array[
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/heic',
  'image/heif',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel'
]
where id = 'source-files';

create function private.source_file_derivative_exists(
  target_company_id uuid,
  target_source_file_id uuid
)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from storage.objects o
    where o.bucket_id = 'source-files'
      and o.name = target_company_id::text || '/' || target_source_file_id::text || '/normalized.jpeg'
  );
$$;

revoke execute on function private.source_file_derivative_exists from public;
grant execute on function private.source_file_derivative_exists(uuid, uuid) to authenticated;

drop policy "company members record stored source files" on public.source_file;
create policy "company members record stored source files" on public.source_file
  for insert to authenticated
  with check (
    private.can_access_company(company_id, organization_id)
    and private.source_file_object_exists(company_id, id)
    and (
      normalized_format is null
      or private.source_file_derivative_exists(company_id, id)
    )
  );

create or replace function private.audit_source_file_uploaded()
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
    ) || case when new.normalized_format is null then '{}'::jsonb else jsonb_build_object(
      'normalized_derivative', jsonb_build_object(
        'format', new.normalized_format,
        'byte_size', new.normalized_byte_size,
        'sha256', new.normalized_sha256
      )
    ) end
  );
  return new;
end;
$$;

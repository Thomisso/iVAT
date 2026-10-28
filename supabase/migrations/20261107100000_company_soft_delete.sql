-- A Company is retained for statutory and audit purposes after deletion. Its
-- memberships and every Company-owned row stay in place, but all member access
-- predicates treat it as gone.
alter table public.company
  add column deleted_at timestamptz,
  add column deleted_by uuid references auth.users(id),
  add constraint company_deletion_complete check (
    (deleted_at is null and deleted_by is null)
    or (deleted_at is not null and deleted_by is not null)
  );

-- A soft delete must reference an archive that the same Administrator finished
-- producing. Export receipts retain the archive identity and digest without
-- storing a second copy of customer data on the platform.
create table public.company_data_export (
  id uuid primary key,
  company_id uuid not null,
  organization_id uuid not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  file_name text not null check (length(trim(file_name)) > 0),
  byte_size bigint not null check (byte_size > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  used_at timestamptz,
  foreign key (company_id, organization_id)
    references public.company(id, organization_id)
);

alter table public.company_data_export enable row level security;
revoke all on public.company_data_export
  from public, anon, authenticated, service_role;

-- RLS on Company and every Company-owned table delegates to this predicate.
-- Requiring an active Company therefore removes the deleted Company and all of
-- its retained data from every member in one place.
create or replace function private.can_access_company(
  target_company_id uuid,
  target_organization_id uuid
)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.company c
    where c.id = target_company_id
      and c.organization_id = target_organization_id
      and c.deleted_at is null
  )
  and private.organization_mfa_satisfied(target_organization_id)
  and (
    exists (
      select 1 from public.membership m
      where m.user_id = auth.uid()
        and m.organization_id = target_organization_id
        and m.company_id is null
        and m.role = 'administrator'
    )
    or exists (
      select 1 from public.membership m
      where m.user_id = auth.uid() and m.company_id = target_company_id
    )
  );
$$;

create or replace function private.is_company_administrator(
  target_company_id uuid,
  target_organization_id uuid
)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.company c
    where c.id = target_company_id
      and c.organization_id = target_organization_id
      and c.deleted_at is null
  )
  and (
    private.is_organization_administrator(target_organization_id)
    or exists (
      select 1 from public.membership m
      where m.user_id = auth.uid()
        and m.organization_id = target_organization_id
        and m.company_id = target_company_id
        and m.role = 'administrator'
    )
  );
$$;

create or replace function private.can_administrate_company(
  target_company_id uuid,
  target_organization_id uuid
)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_company_administrator(
    target_company_id,
    target_organization_id
  );
$$;

-- Records only a completed archive. The caller computes its digest after every
-- original and JSON entry has been written.
create function public.record_company_data_export(
  target_company_id uuid,
  target_export_id uuid,
  target_file_name text,
  target_byte_size bigint,
  target_sha256 text
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target public.company;
begin
  select * into target
  from public.company
  where id = target_company_id
  for share;
  if not found
    or not private.can_administrate_company(target.id, target.organization_id)
  then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  insert into public.company_data_export (
    id, company_id, organization_id, created_by,
    file_name, byte_size, sha256
  ) values (
    target_export_id, target.id, target.organization_id, auth.uid(),
    target_file_name, target_byte_size, target_sha256
  );

  perform private.record_audit_event(
    'company.data_exported',
    target.organization_id,
    target.id,
    'company',
    target.id,
    jsonb_build_object(
      'export_id', target_export_id,
      'file_name', target_file_name,
      'byte_size', target_byte_size,
      'sha256', target_sha256
    )
  );
end;
$$;

-- A matching completed export is consumed by the delete. The function performs
-- no physical deletion: Source Files, Documents, Extraction Versions, VAT
-- Reports and Period Locks remain intact.
create function public.soft_delete_company(
  target_company_id uuid,
  target_export_id uuid
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target public.company;
  completed_export public.company_data_export;
  source_file_count bigint;
  document_count bigint;
begin
  select * into target
  from public.company
  where id = target_company_id
  for update;

  if not found
    or target.deleted_at is not null
    or not private.can_administrate_company(target.id, target.organization_id)
  then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select * into completed_export
  from public.company_data_export e
  where e.id = target_export_id
    and e.company_id = target.id
    and e.created_by = auth.uid()
    and e.used_at is null
  for update;
  if not found then
    raise exception 'a completed Company export is required'
      using errcode = 'P0001', hint = 'export_required';
  end if;

  select count(*) into source_file_count
  from public.source_file where company_id = target.id;
  select count(*) into document_count
  from public.document where company_id = target.id;

  update public.company
  set deleted_at = clock_timestamp(),
      deleted_by = auth.uid(),
      ai_processing_enabled = false,
      ai_provider = null,
      ai_region = null
  where id = target.id;

  update public.company_data_export
  set used_at = clock_timestamp()
  where id = completed_export.id;

  perform private.record_audit_event(
    'company.deleted',
    target.organization_id,
    target.id,
    'company',
    target.id,
    jsonb_build_object(
      'export_id', completed_export.id,
      'source_file_count', source_file_count,
      'document_count', document_count
    )
  );
end;
$$;

revoke execute on function public.record_company_data_export(uuid, uuid, text, bigint, text),
  public.soft_delete_company(uuid, uuid)
  from public, anon, service_role;
grant execute on function public.record_company_data_export(uuid, uuid, text, bigint, text),
  public.soft_delete_company(uuid, uuid) to authenticated;

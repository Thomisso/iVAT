-- A Company export is one complete, authorized database snapshot. A monotonic
-- revision rejects archives that became stale while their originals were being
-- assembled or before soft deletion.

alter table public.company add column data_revision bigint not null default 0;
alter table public.company_data_export add column data_revision bigint not null default 0;

create function private.bump_company_data_revision()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  target_company_id uuid;
begin
  target_company_id := case when tg_op = 'DELETE' then old.company_id else new.company_id end;
  update public.company
  set data_revision = data_revision + 1
  where id = target_company_id;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create function private.bump_company_own_data_revision()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.data_revision = old.data_revision then
    new.data_revision := old.data_revision + 1;
  end if;
  return new;
end;
$$;

create trigger company_own_data_revision
  before update on public.company
  for each row execute function private.bump_company_own_data_revision();
create trigger company_filing_frequency_data_revision
  after insert or update or delete on public.company_filing_frequency
  for each row execute function private.bump_company_data_revision();
create trigger source_file_data_revision
  after insert or update or delete on public.source_file
  for each row execute function private.bump_company_data_revision();
create trigger document_data_revision
  after insert or update or delete on public.document
  for each row execute function private.bump_company_data_revision();
create trigger extraction_version_data_revision
  after insert or update or delete on public.extraction_version
  for each row execute function private.bump_company_data_revision();

revoke execute on function private.bump_company_data_revision(),
  private.bump_company_own_data_revision() from public;

create function public.company_export_snapshot(target_company_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  target public.company;
begin
  select * into target
  from public.company
  where id = target_company_id;
  if not found
    or not private.can_administrate_company(target.id, target.organization_id)
  then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'revision', target.data_revision,
    'company', jsonb_build_object(
      'id', target.id,
      'organizationId', target.organization_id,
      'name', target.name,
      'ico', target.ico,
      'vatId', target.vat_id,
      'street', target.street,
      'city', target.city,
      'postalCode', target.postal_code,
      'personType', target.person_type,
      'aiProcessing', case when target.ai_processing_enabled then jsonb_build_object(
        'provider', target.ai_provider,
        'region', target.ai_region
      ) else 'null'::jsonb end
    ),
    'filingFrequencies', coalesce((
      select jsonb_agg(jsonb_build_object(
        'frequency', frequency.frequency,
        'effectiveFrom', frequency.effective_from
      ) order by frequency.effective_from)
      from public.company_filing_frequency frequency
      where frequency.company_id = target.id
    ), '[]'::jsonb),
    'sourceFiles', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', source.id,
        'companyId', source.company_id,
        'fileName', source.file_name,
        'format', source.format,
        'byteSize', source.byte_size,
        'sha256', source.sha256,
        'pageCount', source.page_count,
        'preselectedDirection', source.preselected_direction,
        'status', source.status,
        'uploadedAt', source.uploaded_at
      ) order by source.uploaded_at desc, source.id)
      from public.source_file source
      where source.company_id = target.id
    ), '[]'::jsonb),
    'documents', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', document.id,
          'companyId', document.company_id,
          'sourceFileId', document.source_file_id,
          'firstPage', document.first_page,
          'lastPage', document.last_page,
          'status', document.status,
          'createdAt', document.created_at,
          'receiptDate', document.receipt_date,
          'claimedReportingPeriod', document.claimed_reporting_period,
          'supersededAt', document.superseded_at,
          'extractionVersions', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', version.id,
              'documentId', version.document_id,
              'version', version.version,
              'author', case when version.author_user_id is null
                then jsonb_build_object('kind', 'ai', 'provider', version.provider, 'model', version.model)
                else jsonb_build_object('kind', 'user', 'userId', version.author_user_id)
              end,
              'payload', version.payload,
              'findings', version.findings,
              'createdAt', version.created_at
            ) order by version.version)
            from public.extraction_version version
            where version.document_id = document.id
          ), '[]'::jsonb)
        ) || case when document.source_sheet is null then '{}'::jsonb else jsonb_build_object(
          'rowSet', jsonb_build_object(
            'sheetName', document.source_sheet,
            'firstRow', document.first_row,
            'lastRow', document.last_row
          ),
          'hasDocumentImage', false
        ) end
        order by document.created_at, document.id
      )
      from public.document document
      where document.company_id = target.id
    ), '[]'::jsonb)
  );
end;
$$;

drop function public.record_company_data_export(uuid, uuid, text, bigint, text);
create function public.record_company_data_export(
  target_company_id uuid,
  target_export_id uuid,
  target_file_name text,
  target_byte_size bigint,
  target_sha256 text,
  expected_data_revision bigint
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target public.company;
begin
  select * into target from public.company where id = target_company_id for update;
  if not found
    or not private.can_administrate_company(target.id, target.organization_id)
  then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if target.data_revision <> expected_data_revision then
    raise exception 'Company data changed during export'
      using errcode = 'P0001', hint = 'stale_export';
  end if;

  insert into public.company_data_export (
    id, company_id, organization_id, created_by,
    file_name, byte_size, sha256, data_revision
  ) values (
    target_export_id, target.id, target.organization_id, auth.uid(),
    target_file_name, target_byte_size, target_sha256, target.data_revision
  );

  perform private.record_audit_event(
    'company.data_exported', target.organization_id, target.id, 'company', target.id,
    jsonb_build_object(
      'export_id', target_export_id,
      'file_name', target_file_name,
      'byte_size', target_byte_size,
      'sha256', target_sha256
    )
  );
end;
$$;

drop function public.soft_delete_company(uuid, uuid);
create function public.soft_delete_company(
  target_company_id uuid,
  target_export_id uuid
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  target public.company;
  completed_export public.company_data_export;
  source_file_count bigint;
  document_count bigint;
  approved_document_count bigint;
  period_lock_count bigint;
begin
  select * into target from public.company where id = target_company_id for update;
  if not found or target.deleted_at is not null
    or not private.can_administrate_company(target.id, target.organization_id)
  then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select * into completed_export
  from public.company_data_export export
  where export.id = target_export_id
    and export.company_id = target.id
    and export.created_by = auth.uid()
    and export.used_at is null
  for update;
  if not found then
    raise exception 'a completed Company export is required'
      using errcode = 'P0001', hint = 'export_required';
  end if;
  if completed_export.data_revision <> target.data_revision then
    raise exception 'Company data changed after export'
      using errcode = 'P0001', hint = 'stale_export';
  end if;

  select count(*) into source_file_count from public.source_file where company_id = target.id;
  select count(*), count(*) filter (where status = 'approved')
    into document_count, approved_document_count
    from public.document where company_id = target.id;
  select count(*) into period_lock_count from public.period_lock where company_id = target.id;

  update public.company
  set deleted_at = clock_timestamp(), deleted_by = auth.uid(),
      ai_processing_enabled = false, ai_provider = null, ai_region = null
  where id = target.id;
  update public.company_data_export set used_at = clock_timestamp() where id = completed_export.id;

  perform private.record_audit_event(
    'company.deleted', target.organization_id, target.id, 'company', target.id,
    jsonb_build_object(
      'export_id', completed_export.id,
      'source_file_count', source_file_count,
      'document_count', document_count
    )
  );

  return jsonb_build_object(
    'sourceFileCount', source_file_count,
    'documentCount', document_count,
    'approvedDocumentCount', approved_document_count,
    'periodLockCount', period_lock_count
  );
end;
$$;

revoke execute on function public.company_export_snapshot(uuid),
  public.record_company_data_export(uuid, uuid, text, bigint, text, bigint),
  public.soft_delete_company(uuid, uuid)
  from public, anon, service_role;
grant execute on function public.company_export_snapshot(uuid),
  public.record_company_data_export(uuid, uuid, text, bigint, text, bigint),
  public.soft_delete_company(uuid, uuid)
  to authenticated;

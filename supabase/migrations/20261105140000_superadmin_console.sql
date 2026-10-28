-- SuperAdmin console (#48): platform tenancy controls, processing recovery and
-- upload limits. Platform operations require an MFA-satisfied SuperAdmin.

alter table public.organization
  add column blocked_at timestamptz,
  add column blocked_by uuid references auth.users (id) on delete set null;

create function public.list_platform_organization_companies()
returns table (
  organization_id uuid,
  organization_name text,
  organization_blocked boolean,
  company_id uuid,
  company_name text,
  company_ico text
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select o.id, o.name, o.blocked_at is not null, c.id, c.name, c.ico
    from public.organization o
    left join public.company c on c.organization_id = o.id
    order by o.name, o.id, c.name, c.id;
end;
$$;

revoke execute on function public.list_platform_organization_companies() from public, anon;
grant execute on function public.list_platform_organization_companies() to authenticated;

create function public.set_platform_organization_blocked(
  target_organization_id uuid,
  organization_blocked boolean
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  changed boolean;
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.organization
  set blocked_at = case when organization_blocked then now() else null end,
      blocked_by = case when organization_blocked then auth.uid() else null end
  where id = target_organization_id
    and (blocked_at is not null) is distinct from organization_blocked;
  changed := found;
  if not changed and not exists (
    select 1 from public.organization where id = target_organization_id
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if changed then
    perform private.record_audit_event(
      'organization.platform_block_changed',
      target_organization_id,
      null,
      'organization',
      target_organization_id,
      jsonb_build_object('blocked', organization_blocked)
    );
  end if;
end;
$$;

revoke execute on function public.set_platform_organization_blocked(uuid, boolean) from public, anon;
grant execute on function public.set_platform_organization_blocked(uuid, boolean) to authenticated;

-- Blocking is enforced below the UI: existing sessions lose tenant access.
create or replace function private.organization_mfa_satisfied(target_organization_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select organization.blocked_at is null
      and (
        not (
          organization.mfa_required
          or private.is_super_admin(auth.uid())
          or private.current_user_has_totp()
        )
        or private.current_user_mfa_satisfied()
      )
    from public.organization
    where id = target_organization_id
  ), false);
$$;

create function public.current_user_can_use_application()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_super_admin(auth.uid())
    -- A newly authenticated or invited user may not have joined an
    -- Organization yet. Blocking applies to memberships, not bare accounts.
    or not exists (
      select 1 from public.membership m where m.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.membership m
      join public.organization o on o.id = m.organization_id
      where m.user_id = auth.uid() and o.blocked_at is null
    );
$$;

revoke execute on function public.current_user_can_use_application() from public, anon;
grant execute on function public.current_user_can_use_application() to authenticated;

create function public.platform_upload_limits()
returns table (
  max_source_file_bytes bigint,
  max_source_file_pages integer,
  max_upload_batch_files integer
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select p.max_source_file_bytes, p.max_source_file_pages, p.max_upload_batch_files
    from public.platform_settings p
    where p.singleton;
end;
$$;

create function public.set_platform_upload_limits(
  target_max_source_file_bytes bigint,
  target_max_source_file_pages integer,
  target_max_upload_batch_files integer
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if target_max_source_file_bytes <= 0
    or target_max_source_file_pages <= 0
    or target_max_upload_batch_files <= 0 then
    raise exception 'upload limits must be positive'
      using errcode = 'P0001', hint = 'invalid_upload_limits';
  end if;
  update public.platform_settings
  set max_source_file_bytes = target_max_source_file_bytes,
      max_source_file_pages = target_max_source_file_pages,
      max_upload_batch_files = target_max_upload_batch_files
  where singleton;
end;
$$;

revoke execute on function public.platform_upload_limits(),
  public.set_platform_upload_limits(bigint, integer, integer) from public, anon;
grant execute on function public.platform_upload_limits(),
  public.set_platform_upload_limits(bigint, integer, integer) to authenticated;

create function public.prepare_processing_job_retry(
  target_failed_job_id uuid,
  target_job_name text,
  target_id uuid
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target_organization_id uuid;
  target_company_id uuid;
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if target_job_name = 'split-source-file' then
    select organization_id, company_id into target_organization_id, target_company_id
    from public.source_file where id = target_id for update;
    if not found then
      raise exception 'job target not found' using errcode = 'P0001', hint = 'not_retryable';
    end if;
    update public.source_file
    set status = 'uploaded'
    where id = target_id and status in ('processing', 'failed');
    if not found then
      raise exception 'job target is not retryable' using errcode = 'P0001', hint = 'not_retryable';
    end if;
  elsif target_job_name = 'extract-document' then
    select organization_id, company_id into target_organization_id, target_company_id
    from public.document where id = target_id and superseded_at is null for update;
    if not found then
      raise exception 'job target not found' using errcode = 'P0001', hint = 'not_retryable';
    end if;
    update public.document
    set status = 'uploaded', extraction_request_id = gen_random_uuid()
    where id = target_id and status in ('processing', 'failed');
    if not found then
      raise exception 'job target is not retryable' using errcode = 'P0001', hint = 'not_retryable';
    end if;
  else
    raise exception 'unknown processing job' using errcode = 'P0001', hint = 'not_retryable';
  end if;
  perform private.record_audit_event(
    'processing.job_retried',
    target_organization_id,
    target_company_id,
    'processing_job',
    target_failed_job_id,
    jsonb_build_object('job_name', target_job_name, 'target_id', target_id)
  );
end;
$$;

revoke execute on function public.prepare_processing_job_retry(uuid, text, uuid) from public, anon;
grant execute on function public.prepare_processing_job_retry(uuid, text, uuid) to authenticated;

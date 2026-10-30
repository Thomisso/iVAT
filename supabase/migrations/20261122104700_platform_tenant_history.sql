-- Platform support can administer a blocked Organization while the operational
-- Company predicates continue to require an unblocked, active Company.
create or replace function private.is_organization_administrator(target_organization_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.organization where id = target_organization_id)
    and (
      private.can_administrate_platform()
      or (
        private.organization_mfa_satisfied(target_organization_id)
        and exists (
          select 1 from public.membership m
          where m.user_id = auth.uid() and m.organization_id = target_organization_id
            and m.company_id is null and m.role = 'administrator'
        )
      )
    );
$$;

-- Membership administration is support work, not ordinary Company processing.
-- Deleted Companies remain immutable even for the platform operator.
create function private.can_administrate_company_memberships(target_company_id uuid, target_organization_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.company c
    where c.id = target_company_id and c.organization_id = target_organization_id
      and c.deleted_at is null
  ) and (
    private.is_company_administrator(target_company_id, target_organization_id)
    or private.can_administrate_platform()
  );
$$;
revoke execute on function private.can_administrate_company_memberships(uuid, uuid) from public;

alter policy "MFA-verified users read memberships in their scope" on public.membership
using (
  private.is_organization_administrator(organization_id)
  or (
    private.organization_mfa_satisfied(organization_id)
    and (
      user_id = auth.uid()
      or (company_id is not null and private.is_company_administrator(company_id, organization_id))
    )
  )
);

create or replace function private.is_organization_member(target_organization_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.organization where id = target_organization_id)
    and (
      private.can_administrate_platform()
      or (
        private.organization_mfa_satisfied(target_organization_id)
        and exists (
          select 1 from public.membership m
          where m.user_id = auth.uid() and m.organization_id = target_organization_id
        )
      )
    );
$$;

-- Inspection is deliberately separate from operational access. No processing,
-- settings mutation, export receipt or restoration is authorized by this read.
create function private.can_inspect_company(target_company_id uuid, target_organization_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.can_administrate_platform() and exists (
    select 1 from public.company c
    where c.id = target_company_id and c.organization_id = target_organization_id
  );
$$;
revoke execute on function private.can_inspect_company(uuid, uuid) from public;

-- Share the complete retained snapshot assembly with read-only platform history.
-- Receipt creation and deletion retain their separate mutation guards.
create or replace function private.company_export_snapshot_without_ai_credential_source(target_company_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  target public.company;
begin
  select * into target from public.company where id = target_company_id;
  if not found or not (private.can_administrate_company(target.id, target.organization_id)
    or private.can_inspect_company(target.id, target.organization_id)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'revision', target.data_revision,
    'company', jsonb_build_object(
      'id', target.id,
      'organizationId', target.organization_id,
      'name', target.name,
      'firstName', target.first_name,
      'lastName', target.last_name,
      'ico', target.ico,
      'vatId', target.vat_id,
      'street', private.registered_street(target.street_name, target.house_number, target.orientation_number),
      'streetName', target.street_name,
      'houseNumber', target.house_number,
      'orientationNumber', target.orientation_number,
      'city', target.city,
      'postalCode', target.postal_code,
      'personType', target.person_type,
      'aiProcessing', case when target.ai_processing_enabled then jsonb_build_object(
        'provider', target.ai_provider, 'region', target.ai_region
      ) else 'null'::jsonb end
    ),
    'setupSteps', coalesce((
      select jsonb_agg(jsonb_build_object(
        'step', setup.step,
        'state', setup.state,
        'changedAt', setup.changed_at
      ) order by setup.step)
      from public.company_setup_step_state setup
      where setup.company_id = target.id
    ), '[]'::jsonb),
    'reportingYears', coalesce((
      select jsonb_agg(jsonb_build_object(
        'year', reporting_year.year,
        'frequency', reporting_year.frequency,
        'firstMonth', reporting_year.first_month
      ) order by reporting_year.year)
      from public.reporting_year
      where reporting_year.company_id = target.id
    ), '[]'::jsonb),
    'sourceFiles', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', source.id, 'companyId', source.company_id,
        'fileName', source.file_name, 'format', source.format,
        'byteSize', source.byte_size, 'sha256', source.sha256,
        'pageCount', source.page_count,
        'preselectedDirection', source.preselected_direction,
        'status', source.status, 'uploadedAt', source.uploaded_at
      ) order by source.uploaded_at desc, source.id)
      from public.source_file source where source.company_id = target.id
    ), '[]'::jsonb),
    'documents', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', document.id, 'companyId', document.company_id,
          'sourceFileId', document.source_file_id,
          'firstPage', document.first_page, 'lastPage', document.last_page,
          'status', document.status, 'createdAt', document.created_at,
          'claimedReportingPeriod', document.claimed_reporting_period,
          'supersededAt', document.superseded_at,
          'extractionVersions', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', version.id, 'documentId', version.document_id,
              'version', version.version,
              'author', case when version.author_user_id is null
                then jsonb_build_object('kind', 'ai', 'provider', version.provider, 'model', version.model)
                else jsonb_build_object('kind', 'user', 'userId', version.author_user_id) end,
              'payload', version.payload, 'findings', version.findings,
              'createdAt', version.created_at
            ) order by version.version)
            from public.extraction_version version where version.document_id = document.id
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
      ) from public.document document where document.company_id = target.id
    ), '[]'::jsonb)
  );
end;
$function$;

create function public.platform_company_history(target_company_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  target public.company;
  organization public.organization;
begin
  select * into target from public.company where id = target_company_id;
  if not found or not private.can_inspect_company(target.id, target.organization_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into organization from public.organization where id = target.organization_id;
  return jsonb_build_object(
    'organizationName', organization.name,
    'blocked', organization.blocked_at is not null,
    'deletedAt', target.deleted_at,
    'snapshot', public.company_export_snapshot(target.id),
    'auditEvents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', event.id, 'occurredAt', event.occurred_at, 'actorUserId', event.actor_user_id,
        'organizationId', event.organization_id, 'companyId', event.company_id,
        'action', event.action, 'targetType', event.target_type,
        'targetId', event.target_id, 'payload', event.payload
      ) order by event.id desc)
      from public.audit_event event where event.company_id = target.id
    ), '[]'::jsonb)
  );
end;
$$;
revoke execute on function public.platform_company_history(uuid) from public, anon, authenticated, service_role;
grant execute on function public.platform_company_history(uuid) to authenticated;

create function private.can_inspect_company_object(object_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.company c
    where c.id::text = split_part(object_name, '/', 1)
      and private.can_inspect_company(c.id, c.organization_id)
  );
$$;
revoke execute on function private.can_inspect_company_object(text) from public;
grant execute on function private.can_inspect_company_object(text) to authenticated;
create policy "SuperAdmins inspect retained original objects" on storage.objects
  for select to authenticated
  using (bucket_id = 'source-files' and private.can_inspect_company_object(name));

create or replace function public.list_platform_organization_companies_complete()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_administrate_platform() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', organization.id, 'name', organization.name,
      'blocked', organization.blocked_at is not null,
      'companies', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', company.id, 'name', company.name, 'ico', company.ico
        ) || case when company.deleted_at is null then '{}'::jsonb else
          jsonb_build_object('deletedAt', company.deleted_at) end order by company.name, company.id)
        from public.company company where company.organization_id = organization.id
      ), '[]'::jsonb)
    ) order by organization.name, organization.id)
    from public.organization organization
  ), '[]'::jsonb);
end;
$$;

-- Reuse membership support authority without broadening operational predicates.
create or replace function public.create_invitation(
  target_organization_id uuid,
  target_company_id uuid,
  target_email text,
  target_role public.membership_role
)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  normalized_email text := lower(trim(target_email));
  token text := gen_random_uuid()::text || gen_random_uuid()::text;
  invitation_id uuid;
begin
  if target_company_id is null then
    if target_role <> 'administrator' or not private.is_organization_administrator(target_organization_id) then
      raise insufficient_privilege;
    end if;
  elsif not exists (
    select 1 from public.company c
    where c.id = target_company_id and c.organization_id = target_organization_id
  ) or not private.can_administrate_company_memberships(target_company_id, target_organization_id) then
    raise insufficient_privilege;
  end if;

  insert into public.invitation (
    organization_id, company_id, email, role, token_hash, invitee_existed
  )
  values (
    target_organization_id,
    target_company_id,
    normalized_email,
    target_role,
    encode(extensions.digest(token, 'sha256'), 'hex'),
    exists (
      select 1
      from public.membership
      where lower(membership.email) = normalized_email
    )
  )
  returning id into invitation_id;

  perform private.record_audit_event(
    'invitation.created', target_organization_id, target_company_id,
    'invitation', invitation_id,
    jsonb_build_object('role', target_role, 'scope', case when target_company_id is null then 'organization' else 'company' end)
  );

  return token;
end;
$$;

create or replace function public.change_membership_role(
  target_membership_id uuid,
  target_role public.membership_role
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target public.membership;
  old_role public.membership_role;
begin
  select * into target from public.membership where id = target_membership_id for update;
  if target.id is null then raise insufficient_privilege; end if;
  if target.company_id is null then
    if target_role <> 'administrator' or not private.is_organization_administrator(target.organization_id) then
      raise insufficient_privilege;
    end if;
  elsif not private.can_administrate_company_memberships(target.company_id, target.organization_id) then
    raise insufficient_privilege;
  end if;

  old_role := target.role;
  update public.membership set role = target_role where id = target.id;
  perform private.record_audit_event(
    'membership.role_changed', target.organization_id, target.company_id,
    'membership', target.id,
    jsonb_build_object('user_id', target.user_id, 'old_role', old_role, 'new_role', target_role)
  );
end;
$$;

create or replace function public.remove_membership(target_membership_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target public.membership;
begin
  select * into target from public.membership where id = target_membership_id for update;
  if target.id is null then raise insufficient_privilege; end if;
  if target.company_id is null then
    if not private.is_organization_administrator(target.organization_id) then raise insufficient_privilege; end if;
  elsif not private.can_administrate_company_memberships(target.company_id, target.organization_id) then
    raise insufficient_privilege;
  end if;

  delete from public.membership where id = target.id;
  perform private.record_audit_event(
    'membership.removed', target.organization_id, target.company_id,
    'membership', target.id,
    jsonb_build_object('user_id', target.user_id, 'role', target.role)
  );
end;
$$;


create or replace function public.list_company_access(target_company_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  target_organization_id uuid;
  effective_access jsonb;
begin
  select c.organization_id into target_organization_id
  from public.company c
  where c.id = target_company_id and c.deleted_at is null;

  if target_organization_id is null
    or not private.can_administrate_company_memberships(target_company_id, target_organization_id) then
    raise insufficient_privilege;
  end if;

  with access_rows as (
    select m.id, m.user_id, m.email, m.role, 'company'::text as access_source
    from public.membership m
    where m.organization_id = target_organization_id
      and m.company_id = target_company_id
    union all
    select m.id, m.user_id, m.email, m.role, 'organization'::text as access_source
    from public.membership m
    where m.organization_id = target_organization_id
      and m.company_id is null
      and m.role = 'administrator'
  ), effective_users as (
  select
    (array_agg(a.id order by a.access_source))[1] as membership_id,
    a.user_id as user_id,
    max(a.email) as email,
    case
      when bool_or(a.role = 'administrator') then 'administrator'::public.membership_role
      else 'user'::public.membership_role
    end as role,
    case
      when bool_or(a.access_source = 'company') and bool_or(a.access_source = 'organization')
        then 'company_and_organization'
      when bool_or(a.access_source = 'organization') then 'organization'
      else 'company'
    end as source,
    case
      when bool_or(a.access_source = 'organization') then null
      else (array_agg(a.id) filter (where a.access_source = 'company'))[1]
    end as manageable_membership_id
  from access_rows a
  group by a.user_id
  )
  select coalesce(
    jsonb_agg(to_jsonb(effective_users) order by effective_users.email),
    '[]'::jsonb
  ) into effective_access
  from effective_users;

  return effective_access;
end;
$$;

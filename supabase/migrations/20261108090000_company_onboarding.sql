-- Interruptible Company identity onboarding (#77). Registered addresses stay
-- structured; setup progress is auditable tenant data rather than UI state.

create type public.company_setup_step as enum (
  'identity', 'filing_frequency', 'filing_defaults', 'ai_processing'
);
create type public.company_setup_state as enum ('completed', 'skipped');

alter table public.company
  add column first_name text,
  add column last_name text,
  add column street_name text,
  add column house_number text,
  add column orientation_number text,
  add constraint company_identity_name_shape check (
    (person_type = 'legal' and length(trim(name)) between 1 and 255
      and first_name is null and last_name is null)
    or
    (person_type = 'natural' and first_name is not null and last_name is not null
      and length(trim(first_name)) between 1 and 30
      and length(trim(last_name)) between 1 and 36
      and name = trim(first_name) || ' ' || trim(last_name))
  ) not valid,
  add constraint company_registered_address_shape check (
    street_name is not null and length(trim(street_name)) > 0
    and house_number is not null
    and house_number ~ '^[0-9]{1,6}$'
    and (orientation_number is null or orientation_number ~ '^[0-9]{1,3}[A-Za-z]?$')
    and length(trim(city)) > 0
    and postal_code ~ '^[0-9]{3} [0-9]{2}$'
  ) not valid,
  add constraint company_ico_shape check (ico ~ '^[0-9]{8}$') not valid,
  add constraint company_vat_id_shape check (vat_id ~ '^CZ[0-9]{8,10}$') not valid;

-- The split onboarding commands below replace the former all-in-one settings
-- RPCs, which could otherwise bypass setup state and the history invariant.
revoke execute on function public.create_company(
  uuid, text, text, text, text, text, text, public.person_type,
  public.filing_frequency, date
) from authenticated;
revoke execute on function public.update_company(
  uuid, text, text, text, text, text, text, public.person_type,
  public.filing_frequency, date
) from authenticated;

create table public.company_setup_step_state (
  company_id uuid not null,
  organization_id uuid not null,
  step public.company_setup_step not null,
  state public.company_setup_state not null,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now(),
  primary key (company_id, step),
  foreign key (company_id, organization_id)
    references public.company(id, organization_id) on delete cascade
);

create index company_setup_step_state_organization_idx
  on public.company_setup_step_state(organization_id, company_id);

revoke all on public.company_setup_step_state from anon, authenticated;
grant select on public.company_setup_step_state to authenticated;
alter table public.company_setup_step_state enable row level security;

create policy "members read accessible Company setup"
  on public.company_setup_step_state for select to authenticated
  using (private.can_access_company(company_id, organization_id));

create function private.registered_street(
  street_name text,
  house_number text,
  orientation_number text
)
returns text language sql immutable set search_path = ''
as $$
  select trim(street_name) || ' ' || trim(house_number)
    || case when nullif(trim(orientation_number), '') is null then ''
      else '/' || trim(orientation_number) end;
$$;

revoke execute on function private.registered_street(text, text, text) from public;

create function public.create_company_identity(
  target_organization_id uuid,
  company_name text,
  company_first_name text,
  company_last_name text,
  company_ico text,
  company_vat_id text,
  company_street_name text,
  company_house_number text,
  company_orientation_number text,
  company_city text,
  company_postal_code text,
  company_person_type public.person_type
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  new_company_id uuid;
  resolved_name text;
begin
  if not private.is_organization_administrator(target_organization_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  resolved_name := case when company_person_type = 'natural'
    then trim(company_first_name) || ' ' || trim(company_last_name)
    else trim(company_name) end;

  insert into public.company (
    organization_id, name, first_name, last_name, ico, vat_id,
    street, street_name, house_number, orientation_number,
    city, postal_code, person_type, created_by
  ) values (
    target_organization_id, resolved_name,
    case when company_person_type = 'natural' then trim(company_first_name) end,
    case when company_person_type = 'natural' then trim(company_last_name) end,
    company_ico, company_vat_id,
    private.registered_street(company_street_name, company_house_number, company_orientation_number),
    trim(company_street_name), trim(company_house_number), nullif(trim(company_orientation_number), ''),
    trim(company_city), company_postal_code, company_person_type, auth.uid()
  ) returning id into new_company_id;

  insert into public.company_setup_step_state (
    company_id, organization_id, step, state, changed_by
  ) values (
    new_company_id, target_organization_id, 'identity', 'completed', auth.uid()
  );
  return new_company_id;
end;
$$;

revoke execute on function public.create_company_identity(
  uuid, text, text, text, text, text, text, text, text, text, text, public.person_type
) from public;
grant execute on function public.create_company_identity(
  uuid, text, text, text, text, text, text, text, text, text, text, public.person_type
) to authenticated;

create function public.update_company_identity(
  target_company_id uuid,
  company_name text,
  company_first_name text,
  company_last_name text,
  company_ico text,
  company_vat_id text,
  company_street_name text,
  company_house_number text,
  company_orientation_number text,
  company_city text,
  company_postal_code text,
  company_person_type public.person_type
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target public.company;
begin
  select * into target from public.company where id = target_company_id for update;
  if not found or not private.can_administrate_company(target.id, target.organization_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.company set
    name = case when company_person_type = 'natural'
      then trim(company_first_name) || ' ' || trim(company_last_name)
      else trim(company_name) end,
    first_name = case when company_person_type = 'natural' then trim(company_first_name) end,
    last_name = case when company_person_type = 'natural' then trim(company_last_name) end,
    ico = company_ico,
    vat_id = company_vat_id,
    street = private.registered_street(company_street_name, company_house_number, company_orientation_number),
    street_name = trim(company_street_name),
    house_number = trim(company_house_number),
    orientation_number = nullif(trim(company_orientation_number), ''),
    city = trim(company_city),
    postal_code = company_postal_code,
    person_type = company_person_type
  where id = target.id;

  insert into public.company_setup_step_state (
    company_id, organization_id, step, state, changed_by
  ) values (target.id, target.organization_id, 'identity', 'completed', auth.uid())
  on conflict (company_id, step) do update set
    state = excluded.state, changed_by = excluded.changed_by, changed_at = now()
    where company_setup_step_state.state is distinct from excluded.state;
end;
$$;

revoke execute on function public.update_company_identity(
  uuid, text, text, text, text, text, text, text, text, text, text, public.person_type
) from public;
grant execute on function public.update_company_identity(
  uuid, text, text, text, text, text, text, text, text, text, text, public.person_type
) to authenticated;

create function public.set_company_filing_frequency(
  target_company_id uuid,
  new_filing_frequency public.filing_frequency,
  filing_frequency_effective_from date
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target public.company;
  previous_frequency public.filing_frequency;
  next_frequency public.filing_frequency;
  next_effective_from date;
begin
  select * into target from public.company where id = target_company_id for update;
  if not found or not private.can_administrate_company(target.id, target.organization_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if extract(day from filing_frequency_effective_from) <> 1 then
    raise exception 'frequency changes start on the first day of a month'
      using errcode = 'P0001', hint = 'invalid_effective_from';
  end if;

  select frequency into previous_frequency
  from public.company_filing_frequency
  where company_id = target.id and effective_from < filing_frequency_effective_from
  order by effective_from desc limit 1;
  select frequency, effective_from into next_frequency, next_effective_from
  from public.company_filing_frequency
  where company_id = target.id and effective_from > filing_frequency_effective_from
  order by effective_from limit 1;

  if (new_filing_frequency = 'quarterly' or previous_frequency = 'quarterly')
    and extract(month from filing_frequency_effective_from) not in (1, 4, 7, 10)
  then
    raise exception 'a transition touching quarterly filing starts on a quarter boundary'
      using errcode = 'P0001', hint = 'invalid_effective_from';
  end if;
  if new_filing_frequency = 'quarterly' and next_frequency is not null
    and extract(month from next_effective_from) not in (1, 4, 7, 10)
  then
    raise exception 'a transition from quarterly filing starts on a quarter boundary'
      using errcode = 'P0001', hint = 'invalid_effective_from';
  end if;

  insert into public.company_filing_frequency (
    company_id, organization_id, frequency, effective_from
  ) values (target.id, target.organization_id, new_filing_frequency, filing_frequency_effective_from)
  on conflict (company_id, effective_from) do update set frequency = excluded.frequency
    where company_filing_frequency.frequency is distinct from excluded.frequency;

  insert into public.company_setup_step_state (
    company_id, organization_id, step, state, changed_by
  ) values (target.id, target.organization_id, 'filing_frequency', 'completed', auth.uid())
  on conflict (company_id, step) do update set
    state = excluded.state, changed_by = excluded.changed_by, changed_at = now()
    where company_setup_step_state.state is distinct from excluded.state;
end;
$$;

revoke execute on function public.set_company_filing_frequency(uuid, public.filing_frequency, date) from public;
grant execute on function public.set_company_filing_frequency(uuid, public.filing_frequency, date) to authenticated;

create function private.audit_company_setup_changed()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  perform private.record_audit_event(
    'company.setup_changed', new.organization_id, new.company_id,
    'company', new.company_id,
    jsonb_build_object('step', new.step, 'state', new.state)
  );
  return new;
end;
$$;

create trigger company_setup_changed_audit
  after insert or update on public.company_setup_step_state
  for each row execute function private.audit_company_setup_changed();

revoke execute on function private.audit_company_setup_changed() from public;

create trigger company_setup_step_state_data_revision
  after insert or update or delete on public.company_setup_step_state
  for each row execute function private.bump_company_data_revision();

-- Company archives contain the same canonical identity and persisted setup state
-- that statutory snapshots use. Replacing this function keeps the archive one
-- stable database snapshot rather than assembling it through paged client reads.
create or replace function public.company_export_snapshot(target_company_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  target public.company;
begin
  select * into target from public.company where id = target_company_id;
  if not found or not private.can_administrate_company(target.id, target.organization_id) then
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
          'receiptDate', document.receipt_date,
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
$$;

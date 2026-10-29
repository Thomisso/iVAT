-- Filing defaults belong to a Company but stay separate from its statutory
-- identity. They may be changed for one export without rewriting that identity.

create table public.company_filing_defaults (
  company_id uuid primary key,
  organization_id uuid not null,
  tax_office text,
  signatory_first_name text,
  signatory_last_name text,
  signatory_capacity text,
  email text,
  phone text,
  epo_street_name text,
  epo_house_number text,
  epo_orientation_number text,
  epo_city text,
  epo_postal_code text,
  epo_address_confirmed_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  foreign key (company_id, organization_id)
    references public.company(id, organization_id) on delete cascade,
  check (tax_office is null or tax_office in (
    '451', '452', '453', '454', '455', '456', '457',
    '458', '459', '460', '461', '462', '463', '464', '13'
  )),
  check (
    (signatory_first_name is null and signatory_last_name is null and signatory_capacity is null)
    or
    (signatory_first_name is not null and signatory_last_name is not null and signatory_capacity is not null
      and length(signatory_first_name) between 1 and 20
      and length(signatory_last_name) between 1 and 36
      and length(signatory_capacity) between 1 and 40)
  ),
  check (email is null or (length(email) <= 255 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')),
  check (phone is null or length(phone) between 1 and 14),
  check (
    (epo_street_name is null and epo_house_number is null
      and epo_orientation_number is null and epo_city is null
      and epo_postal_code is null and epo_address_confirmed_at is null)
    or
    (epo_street_name is not null and epo_house_number is not null
      and epo_city is not null and epo_postal_code is not null
      and length(epo_street_name) between 1 and 38
      and epo_house_number ~ '^[0-9]{1,6}$'
      and (epo_orientation_number is null or epo_orientation_number ~ '^[0-9]{1,3}[A-Za-z]?$')
      and length(epo_city) between 1 and 48
      and epo_postal_code ~ '^[0-9]{3} [0-9]{2}$'
      and epo_address_confirmed_at is not null)
  )
);

revoke all on public.company_filing_defaults from anon, authenticated;
grant select on public.company_filing_defaults to authenticated;
alter table public.company_filing_defaults enable row level security;

create policy "members read accessible Company filing defaults"
  on public.company_filing_defaults for select to authenticated
  using (private.can_access_company(company_id, organization_id));

create function public.set_company_filing_defaults(
  target_company_id uuid,
  new_tax_office text,
  new_signatory_first_name text,
  new_signatory_last_name text,
  new_signatory_capacity text,
  new_email text,
  new_phone text,
  new_epo_street_name text,
  new_epo_house_number text,
  new_epo_orientation_number text,
  new_epo_city text,
  new_epo_postal_code text,
  epo_address_confirmed boolean
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target public.company;
  has_epo_override boolean;
  registered_address_exceeds_epo boolean;
  setup_is_complete boolean;
begin
  select * into target from public.company where id = target_company_id for update;
  if not found or not private.can_administrate_company(target.id, target.organization_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  has_epo_override := nullif(trim(new_epo_street_name), '') is not null
    or nullif(trim(new_epo_house_number), '') is not null
    or nullif(trim(new_epo_orientation_number), '') is not null
    or nullif(trim(new_epo_city), '') is not null
    or nullif(trim(new_epo_postal_code), '') is not null;
  registered_address_exceeds_epo := length(target.street_name) > 38
    or length(coalesce(target.orientation_number, '')) > 4
    or length(target.city) > 48;

  if has_epo_override and not registered_address_exceeds_epo then
    raise exception 'EPO address override is not required'
      using errcode = 'P0001', hint = 'epo_override_not_required';
  end if;
  if has_epo_override and not epo_address_confirmed then
    raise exception 'EPO address override must be confirmed'
      using errcode = 'P0001', hint = 'epo_override_confirmation_required';
  end if;

  insert into public.company_filing_defaults (
    company_id, organization_id, tax_office,
    signatory_first_name, signatory_last_name, signatory_capacity,
    email, phone,
    epo_street_name, epo_house_number, epo_orientation_number,
    epo_city, epo_postal_code, epo_address_confirmed_at,
    updated_by
  ) values (
    target.id, target.organization_id, nullif(trim(new_tax_office), ''),
    nullif(trim(new_signatory_first_name), ''), nullif(trim(new_signatory_last_name), ''),
    nullif(trim(new_signatory_capacity), ''), nullif(trim(new_email), ''),
    nullif(trim(new_phone), ''),
    case when has_epo_override then trim(new_epo_street_name) end,
    case when has_epo_override then trim(new_epo_house_number) end,
    case when has_epo_override then nullif(trim(new_epo_orientation_number), '') end,
    case when has_epo_override then trim(new_epo_city) end,
    case when has_epo_override then trim(new_epo_postal_code) end,
    case when has_epo_override then clock_timestamp() end,
    auth.uid()
  )
  on conflict (company_id) do update set
    tax_office = excluded.tax_office,
    signatory_first_name = excluded.signatory_first_name,
    signatory_last_name = excluded.signatory_last_name,
    signatory_capacity = excluded.signatory_capacity,
    email = excluded.email,
    phone = excluded.phone,
    epo_street_name = excluded.epo_street_name,
    epo_house_number = excluded.epo_house_number,
    epo_orientation_number = excluded.epo_orientation_number,
    epo_city = excluded.epo_city,
    epo_postal_code = excluded.epo_postal_code,
    epo_address_confirmed_at = excluded.epo_address_confirmed_at,
    updated_at = clock_timestamp(),
    updated_by = excluded.updated_by;

  setup_is_complete := nullif(trim(new_tax_office), '') is not null
    and (target.person_type = 'natural' or (
      nullif(trim(new_signatory_first_name), '') is not null
      and nullif(trim(new_signatory_last_name), '') is not null
      and nullif(trim(new_signatory_capacity), '') is not null
    ))
    and (not registered_address_exceeds_epo or has_epo_override);
  insert into public.company_setup_step_state (
    company_id, organization_id, step, state, changed_by
  ) values (
    target.id, target.organization_id, 'filing_defaults',
    case when setup_is_complete then 'completed'::public.company_setup_state
      else 'skipped'::public.company_setup_state end,
    auth.uid()
  )
  on conflict (company_id, step) do update set
    state = excluded.state, changed_by = excluded.changed_by, changed_at = now()
    where company_setup_step_state.state is distinct from excluded.state;

  perform private.record_audit_event(
    'company.filing_defaults_updated', target.organization_id, target.id,
    'company', target.id,
    jsonb_build_object(
      'tax_office_set', nullif(trim(new_tax_office), '') is not null,
      'signatory_set', nullif(trim(new_signatory_first_name), '') is not null
        and nullif(trim(new_signatory_last_name), '') is not null
        and nullif(trim(new_signatory_capacity), '') is not null,
      'email_set', nullif(trim(new_email), '') is not null,
      'phone_set', nullif(trim(new_phone), '') is not null,
      'epo_address_override_set', has_epo_override
    )
  );
end;
$$;

revoke execute on function public.set_company_filing_defaults(
  uuid, text, text, text, text, text, text, text, text, text, text, text, boolean
) from public, anon;
grant execute on function public.set_company_filing_defaults(
  uuid, text, text, text, text, text, text, text, text, text, text, text, boolean
) to authenticated;

create trigger company_filing_defaults_data_revision
  after insert or update or delete on public.company_filing_defaults
  for each row execute function private.bump_company_data_revision();

create function private.sync_company_filing_defaults_after_identity_change()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  defaults public.company_filing_defaults;
  registered_address_changed boolean;
  registered_address_exceeds_epo boolean;
  setup_is_complete boolean;
begin
  registered_address_changed := new.street_name is distinct from old.street_name
    or new.house_number is distinct from old.house_number
    or new.orientation_number is distinct from old.orientation_number
    or new.city is distinct from old.city
    or new.postal_code is distinct from old.postal_code;
  registered_address_exceeds_epo := length(new.street_name) > 38
    or length(coalesce(new.orientation_number, '')) > 4
    or length(new.city) > 48;
  if registered_address_changed then
    update public.company_filing_defaults set
      epo_street_name = null,
      epo_house_number = null,
      epo_orientation_number = null,
      epo_city = null,
      epo_postal_code = null,
      epo_address_confirmed_at = null,
      updated_at = clock_timestamp(),
      updated_by = auth.uid()
    where company_id = new.id and epo_address_confirmed_at is not null;
  end if;

  select * into defaults
  from public.company_filing_defaults
  where company_id = new.id;
  if not found then return new; end if;
  setup_is_complete := defaults.tax_office is not null
    and (new.person_type = 'natural' or (
      defaults.signatory_first_name is not null
      and defaults.signatory_last_name is not null
      and defaults.signatory_capacity is not null
    ))
    and (not registered_address_exceeds_epo or defaults.epo_address_confirmed_at is not null);
  insert into public.company_setup_step_state (
    company_id, organization_id, step, state, changed_by
  ) values (
    new.id, new.organization_id, 'filing_defaults',
    case when setup_is_complete then 'completed'::public.company_setup_state
      else 'skipped'::public.company_setup_state end,
    auth.uid()
  )
  on conflict (company_id, step) do update set
    state = excluded.state, changed_by = excluded.changed_by, changed_at = now()
    where company_setup_step_state.state is distinct from excluded.state;
  return new;
end;
$$;

create trigger company_identity_syncs_filing_defaults
  after update of person_type, street_name, house_number, orientation_number, city, postal_code
  on public.company
  for each row execute function private.sync_company_filing_defaults_after_identity_change();

revoke execute on function private.sync_company_filing_defaults_after_identity_change() from public;

-- Extend the canonical Company archive without copying its large stable query.
alter function public.company_export_snapshot(uuid)
  rename to company_export_snapshot_without_filing_defaults;
alter function public.company_export_snapshot_without_filing_defaults(uuid)
  set schema private;

create function public.company_export_snapshot(target_company_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  snapshot jsonb;
  filing_defaults jsonb;
begin
  snapshot := private.company_export_snapshot_without_filing_defaults(target_company_id);
  select jsonb_build_object(
    'taxOffice', defaults.tax_office,
    'signatoryFirstName', defaults.signatory_first_name,
    'signatoryLastName', defaults.signatory_last_name,
    'signatoryCapacity', defaults.signatory_capacity,
    'email', defaults.email,
    'phone', defaults.phone,
    'epoAddressOverride', case when defaults.epo_address_confirmed_at is null then 'null'::jsonb
      else jsonb_build_object(
        'streetName', defaults.epo_street_name,
        'houseNumber', defaults.epo_house_number,
        'orientationNumber', defaults.epo_orientation_number,
        'city', defaults.epo_city,
        'postalCode', defaults.epo_postal_code,
        'confirmedAt', defaults.epo_address_confirmed_at
      ) end
  ) into filing_defaults
  from public.company_filing_defaults defaults
  where defaults.company_id = target_company_id;
  snapshot := jsonb_set(
    snapshot,
    '{company,filingDefaults}',
    coalesce(filing_defaults, 'null'::jsonb),
    true
  );
  return snapshot;
end;
$$;

revoke execute on function private.company_export_snapshot_without_filing_defaults(uuid),
  public.company_export_snapshot(uuid) from public, anon, authenticated, service_role;

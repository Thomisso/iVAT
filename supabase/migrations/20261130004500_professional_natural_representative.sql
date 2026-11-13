-- Professional natural-person representatives share existing Company authority.
create or replace function public.set_company_filing_defaults(
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
  epo_address_confirmed boolean,
  new_economic_activity text default '',
  new_territorial_office text default '',
  new_representative jsonb default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  profile jsonb;
  birthday date;
  field_name text;
begin
  -- The existing function locks and authorizes the Company and records only boolean audit facts.
  perform private.set_company_filing_defaults_base(target_company_id, new_tax_office,
    new_signatory_first_name, new_signatory_last_name, new_signatory_capacity, new_email, new_phone,
    new_epo_street_name, new_epo_house_number, new_epo_orientation_number, new_epo_city, new_epo_postal_code,
    epo_address_confirmed, new_economic_activity, new_territorial_office);
  if new_representative is not null and new_representative <> 'null'::jsonb then
    if jsonb_typeof(new_representative) <> 'object'
      or coalesce(new_representative->>'code', '') not in ('4a', '4b')
      or new_representative->>'personType' is distinct from 'F' then
      raise exception 'invalid representative' using errcode = 'P0001', hint = 'invalid_representative';
    end if;
    foreach field_name in array array['firstName', 'lastName', 'birthDate', 'evidenceNumber'] loop
      if new_representative ? field_name and jsonb_typeof(new_representative->field_name) <> 'string' then
        raise exception 'invalid representative' using errcode = 'P0001', hint = 'invalid_representative';
      end if;
    end loop;
    profile := jsonb_build_object('code', new_representative->>'code', 'personType', 'F',
      'firstName', trim(coalesce(new_representative->>'firstName', '')),
      'lastName', trim(coalesce(new_representative->>'lastName', '')),
      'birthDate', trim(coalesce(new_representative->>'birthDate', '')),
      'evidenceNumber', trim(coalesce(new_representative->>'evidenceNumber', '')));
    if length(profile->>'firstName') not between 1 and 20
      or length(profile->>'lastName') not between 1 and 36
      or length(profile->>'evidenceNumber') > 36
      or (profile->>'birthDate' = '' and profile->>'evidenceNumber' = '') then
      raise exception 'invalid representative' using errcode = 'P0001', hint = 'invalid_representative';
    end if;
    if profile->>'birthDate' <> '' then
      begin
        birthday := (profile->>'birthDate')::date;
        if profile->>'birthDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          or to_char(birthday, 'YYYY-MM-DD') <> profile->>'birthDate' then
          raise exception 'invalid date';
        end if;
      exception when others then
        raise exception 'invalid representative' using errcode = 'P0001', hint = 'invalid_representative';
      end;
    end if;
  end if;
  update public.company_filing_defaults set representative = profile where company_id = target_company_id;
end;
$$;
revoke all on function public.set_company_filing_defaults(uuid, text, text, text, text, text, text, text, text, text, text, text, boolean, text, text, jsonb) from public, anon;
grant execute on function public.set_company_filing_defaults(uuid, text, text, text, text, text, text, text, text, text, text, text, boolean, text, text, jsonb) to authenticated;

-- Extend only version guards; preserve deadline and report safeguards.
do $$
declare archive_function record;
begin
  for archive_function in
    select pg_get_functiondef(p.oid) as definition from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'private' and p.proname in ('create_vat_report_artifact', 'create_vat_report_artifact_before_deadline'))
       or (n.nspname = 'public' and p.proname = 'create_vat_report_pdf_artifact')
  loop
    execute replace(replace(archive_function.definition,
      'target_serializer_version not in (''2'', ''3'')', 'target_serializer_version not in (''2'', ''3'', ''4'')'),
      'target_serializer_version is distinct from ''3''', 'target_serializer_version is null or target_serializer_version not in (''3'', ''4'')');
  end loop;
end;
$$;

-- Reporting Years replace the effective-dated filing-frequency history
-- (ADR-0013). A Company's Reporting Periods are the months or quarters of its
-- generated years; a date outside every generated year has no Reporting Period.

create table public.reporting_year (
  company_id uuid not null,
  organization_id uuid not null,
  year integer not null check (year between 2000 and 2099),
  frequency public.filing_frequency not null,
  first_month smallint not null default 1 check (first_month between 1 and 12),
  created_at timestamptz not null default now(),
  primary key (company_id, year),
  foreign key (company_id, organization_id)
    references public.company (id, organization_id) on delete cascade,
  -- A quarterly year starts on a quarter so that every period is whole.
  check (frequency = 'monthly' or first_month in (1, 4, 7, 10))
);

create index reporting_year_organization_idx
  on public.reporting_year (organization_id, company_id, year);

revoke all on public.reporting_year from anon, authenticated;
grant select on public.reporting_year to authenticated;
alter table public.reporting_year enable row level security;

create policy "members read accessible Company Reporting Years"
  on public.reporting_year for select to authenticated
  using (private.can_access_company(company_id, organization_id));

-- The migration rule, kept as a function so it is testable: one year per
-- calendar year from the earliest entry through the current year or the latest
-- recorded change, whichever is later. Each year uses the frequency in force on
-- 1 January; the first year uses the frequency of the first effective date,
-- whose month (on a quarter for quarterly) starts it.
create function private.reporting_years_from_frequency_history(
  history jsonb,
  current_year integer
)
returns table (year integer, frequency public.filing_frequency, first_month smallint)
language sql immutable set search_path = ''
as $$
  with entries as (
    select (entry ->> 'effectiveFrom')::date as effective_from,
      (entry ->> 'frequency')::public.filing_frequency as frequency
    from jsonb_array_elements(history) entry
  ), first_entry as (
    select min(effective_from) as first_date, max(effective_from) as last_date from entries
  ), years as (
    select calendar_year::integer as year, first_entry.first_date
    from first_entry,
      generate_series(
        extract(year from first_entry.first_date)::integer,
        greatest(current_year, extract(year from first_entry.last_date)::integer)
      ) calendar_year
    where first_entry.first_date is not null
  ), resolved as (
    select years.year, years.first_date,
      (select entries.frequency from entries
        where entries.effective_from <= greatest(make_date(years.year, 1, 1), years.first_date)
        order by entries.effective_from desc limit 1) as frequency
    from years
  )
  select resolved.year, resolved.frequency,
    case
      when resolved.year > extract(year from resolved.first_date) then 1
      when resolved.frequency = 'quarterly'
        then ((extract(month from resolved.first_date)::integer - 1) / 3) * 3 + 1
      else extract(month from resolved.first_date)::integer
    end::smallint
  from resolved
  order by resolved.year;
$$;

revoke execute on function private.reporting_years_from_frequency_history(jsonb, integer) from public;

insert into public.reporting_year (company_id, organization_id, year, frequency, first_month)
select company.id, company.organization_id, migrated.year, migrated.frequency, migrated.first_month
from public.company company
cross join lateral private.reporting_years_from_frequency_history(
  (select coalesce(jsonb_agg(jsonb_build_object(
      'frequency', history.frequency,
      'effectiveFrom', history.effective_from
    )), '[]'::jsonb)
    from public.company_filing_frequency history
    where history.company_id = company.id),
  extract(year from now() at time zone 'Europe/Prague')::integer
) migrated;

-- Audited from here on, so the migration itself writes no audit events.
create function private.audit_reporting_year_changed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.record_audit_event(
      'reporting_year.generated', new.organization_id, new.company_id,
      'company', new.company_id,
      jsonb_build_object(
        'year', new.year, 'frequency', new.frequency, 'first_month', new.first_month
      )
    );
  elsif old.frequency is distinct from new.frequency
    or old.first_month is distinct from new.first_month then
    perform private.record_audit_event(
      'reporting_year.changed', new.organization_id, new.company_id,
      'company', new.company_id,
      jsonb_strip_nulls(jsonb_build_object(
        'year', new.year,
        'frequency', case when old.frequency is distinct from new.frequency
          then jsonb_build_object('from', old.frequency, 'to', new.frequency) end,
        'first_month', case when old.first_month is distinct from new.first_month
          then jsonb_build_object('from', old.first_month, 'to', new.first_month) end
      ))
    );
  end if;
  return new;
end;
$$;

revoke execute on function private.audit_reporting_year_changed() from public;

create trigger reporting_year_changed_audit
  after insert or update on public.reporting_year
  for each row execute function private.audit_reporting_year_changed();

create trigger reporting_year_data_revision
  after insert or update or delete on public.reporting_year
  for each row execute function private.bump_company_data_revision();

-- A year whose periods carry a VAT Report or Period Lock keeps its shape.
create function private.reporting_year_in_use(target_company_id uuid, target_year integer)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.vat_report report
    where report.company_id = target_company_id
      and report.period >= target_year::text || '-'
      and report.period < (target_year + 1)::text || '-'
  ) or exists (
    select 1 from public.period_lock lock
    where lock.company_id = target_company_id
      and lock.period >= target_year::text || '-'
      and lock.period < (target_year + 1)::text || '-'
  );
$$;

revoke execute on function private.reporting_year_in_use(uuid, integer) from public;

create or replace function private.reporting_period_for_date(
  target_company_id uuid,
  target_date date
)
returns text
language sql stable security definer set search_path = ''
as $$
  select case reporting_year.frequency
    when 'monthly' then to_char(target_date, 'YYYY-MM')
    when 'quarterly' then to_char(target_date, 'YYYY') || '-Q'
      || extract(quarter from target_date)::integer::text
  end
  from public.reporting_year
  where reporting_year.company_id = target_company_id
    and reporting_year.year = extract(year from target_date)::integer
    and extract(month from target_date)::integer >= reporting_year.first_month;
$$;

-- Onboarding and the filing settings write one Reporting Year (the current one).
create function public.set_company_reporting_year(
  target_company_id uuid,
  target_year integer,
  new_frequency public.filing_frequency
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target public.company;
  existing public.reporting_year;
begin
  select * into target from public.company where id = target_company_id for update;
  if not found or not private.can_administrate_company(target.id, target.organization_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if target_year is null or target_year not between 2000 and 2099 then
    raise exception 'invalid Reporting Year'
      using errcode = 'P0001', hint = 'invalid_reporting_year';
  end if;

  select * into existing from public.reporting_year
  where company_id = target.id and year = target_year
  for update;
  if found and existing.frequency is distinct from new_frequency
    and private.reporting_year_in_use(target.id, target_year) then
    raise exception 'a period of this Reporting Year has a VAT Report or Period Lock'
      using errcode = 'P0001', hint = 'reporting_year_in_use';
  end if;

  -- A quarterly year starts on the quarter that holds its first month.
  insert into public.reporting_year (company_id, organization_id, year, frequency)
  values (target.id, target.organization_id, target_year, new_frequency)
  on conflict (company_id, year) do update set
    frequency = excluded.frequency,
    first_month = case when excluded.frequency = 'quarterly'
      then ((reporting_year.first_month - 1) / 3) * 3 + 1
      else reporting_year.first_month end
    where reporting_year.frequency is distinct from excluded.frequency;

  insert into public.company_setup_step_state (
    company_id, organization_id, step, state, changed_by
  ) values (target.id, target.organization_id, 'filing_frequency', 'completed', auth.uid())
  on conflict (company_id, step) do update set
    state = excluded.state, changed_by = excluded.changed_by, changed_at = now()
    where company_setup_step_state.state is distinct from excluded.state;
end;
$$;

revoke execute on function public.set_company_reporting_year(uuid, integer, public.filing_frequency) from public;
grant execute on function public.set_company_reporting_year(uuid, integer, public.filing_frequency) to authenticated;

-- Company archives export Reporting Years instead of the dropped history.
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
$function$;

-- Every reported or locked period must survive the conversion unchanged.
do $$
declare
  lost record;
begin
  select reported.company_id, reported.period into lost
  from (
    select company_id, period from public.vat_report
    union
    select company_id, period from public.period_lock
  ) reported
  where private.reporting_period_for_date(
    reported.company_id, private.reporting_period_start(reported.period)
  ) is distinct from reported.period
  limit 1;
  if found then
    raise exception 'Reporting Year migration would lose period % of Company %',
      lost.period, lost.company_id;
  end if;
end;
$$;

drop function public.set_company_filing_frequency(uuid, public.filing_frequency, date);
drop function public.create_company(
  uuid, text, text, text, text, text, text, public.person_type,
  public.filing_frequency, date
);
drop function public.update_company(
  uuid, text, text, text, text, text, text, public.person_type,
  public.filing_frequency, date
);
drop table public.company_filing_frequency;
drop function private.audit_company_filing_frequency_changed();

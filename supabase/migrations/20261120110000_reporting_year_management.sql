-- Administrators manage a Company's Reporting Years (ADR-0013): generate a
-- range, change a year's frequency, start the earliest year later and delete
-- a year. Every command is Administrator-only and audited (ADR-0008, 0009).

-- Existing years are never overwritten; the caller learns which were skipped.
create or replace function public.generate_company_reporting_years(
  target_company_id uuid,
  from_year integer,
  to_year integer,
  new_frequency public.filing_frequency
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  target public.company;
  generated integer[];
begin
  select * into target from public.company where id = target_company_id for update;
  if not found or not private.can_administrate_company(target.id, target.organization_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if from_year is null or to_year is null or new_frequency is null
    or from_year not between 2000 and 2099 or to_year not between 2000 and 2099
    or from_year > to_year then
    raise exception 'invalid Reporting Year range'
      using errcode = 'P0001', hint = 'invalid_reporting_year';
  end if;

  with inserted as (
    insert into public.reporting_year (company_id, organization_id, year, frequency)
    select target.id, target.organization_id, calendar_year, new_frequency
    from generate_series(from_year, to_year) calendar_year
    on conflict (company_id, year) do nothing
    returning year
  )
  select coalesce(array_agg(year order by year), '{}') into generated from inserted;

  insert into public.company_setup_step_state (
    company_id, organization_id, step, state, changed_by
  ) values (target.id, target.organization_id, 'filing_frequency', 'completed', auth.uid())
  on conflict (company_id, step) do update set
    state = excluded.state, changed_by = excluded.changed_by, changed_at = now()
    where company_setup_step_state.state is distinct from excluded.state;

  return jsonb_build_object(
    'generated', to_jsonb(generated),
    'skipped', coalesce((
      select jsonb_agg(calendar_year order by calendar_year)
      from generate_series(from_year, to_year) calendar_year
      where calendar_year <> all (generated)
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.generate_company_reporting_years(uuid, integer, integer, public.filing_frequency) from public;
grant execute on function public.generate_company_reporting_years(uuid, integer, integer, public.filing_frequency) to authenticated;

-- The Reporting Year a change or deletion targets, locked for the command.
-- Refuses non-Administrators, a year that was never generated and a year
-- whose periods have a VAT Report or Period Lock.
create or replace function private.changeable_reporting_year(target_company_id uuid, target_year integer)
returns public.reporting_year
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
  select * into existing from public.reporting_year
  where company_id = target.id and year = target_year
  for update;
  if not found then
    raise exception 'the Reporting Year was not generated'
      using errcode = 'P0001', hint = 'reporting_year_not_found';
  end if;
  if private.reporting_year_in_use(target.id, target_year) then
    raise exception 'a period of this Reporting Year has a VAT Report or Period Lock'
      using errcode = 'P0001', hint = 'reporting_year_in_use';
  end if;
  return existing;
end;
$$;

revoke execute on function private.changeable_reporting_year(uuid, integer) from public;

create or replace function public.change_company_reporting_year_frequency(
  target_company_id uuid,
  target_year integer,
  new_frequency public.filing_frequency
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.changeable_reporting_year(target_company_id, target_year);
  if new_frequency is null then
    raise exception 'a frequency is required'
      using errcode = 'P0001', hint = 'invalid_filing_frequency';
  end if;
  -- A quarterly year starts on the quarter that holds its first month.
  update public.reporting_year set
    frequency = new_frequency,
    first_month = case when new_frequency = 'quarterly'
      then ((first_month - 1) / 3) * 3 + 1 else first_month end
  where company_id = target_company_id and year = target_year
    and frequency is distinct from new_frequency;
end;
$$;

revoke execute on function public.change_company_reporting_year_frequency(uuid, integer, public.filing_frequency) from public;
grant execute on function public.change_company_reporting_year_frequency(uuid, integer, public.filing_frequency) to authenticated;

-- Audited here rather than by a trigger, so deleting a Company does not log
-- each of its years.
create or replace function public.delete_company_reporting_year(
  target_company_id uuid,
  target_year integer
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  existing public.reporting_year;
begin
  existing := private.changeable_reporting_year(target_company_id, target_year);
  delete from public.reporting_year
  where company_id = existing.company_id and year = existing.year;
  perform private.record_audit_event(
    'reporting_year.deleted', existing.organization_id, existing.company_id,
    'company', existing.company_id,
    jsonb_build_object(
      'year', existing.year, 'frequency', existing.frequency, 'first_month', existing.first_month
    )
  );
end;
$$;

revoke execute on function public.delete_company_reporting_year(uuid, integer) from public;
grant execute on function public.delete_company_reporting_year(uuid, integer) to authenticated;

-- A Company that became a VAT payer mid-year has no periods before its first
-- month. Only the earliest year may start later, and a quarterly year starts
-- on a quarter so that every period is whole.
create or replace function public.set_company_first_reporting_month(
  target_company_id uuid,
  target_year integer,
  new_first_month integer
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  existing public.reporting_year;
begin
  existing := private.changeable_reporting_year(target_company_id, target_year);
  if exists (
    select 1 from public.reporting_year
    where company_id = existing.company_id and year < existing.year
  ) then
    raise exception 'only the earliest Reporting Year may start later'
      using errcode = 'P0001', hint = 'not_first_reporting_year';
  end if;
  if new_first_month is null or new_first_month not between 1 and 12
    or (existing.frequency = 'quarterly' and new_first_month not in (1, 4, 7, 10)) then
    raise exception 'invalid first month'
      using errcode = 'P0001', hint = 'invalid_first_month';
  end if;
  update public.reporting_year set first_month = new_first_month
  where company_id = existing.company_id and year = existing.year
    and first_month is distinct from new_first_month;
end;
$$;

revoke execute on function public.set_company_first_reporting_month(uuid, integer, integer) from public;
grant execute on function public.set_company_first_reporting_month(uuid, integer, integer) to authenticated;
